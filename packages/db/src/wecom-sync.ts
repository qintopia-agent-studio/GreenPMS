import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "./schema.ts";
import { externalBillId } from "./external-payments.ts";
import { WecomApiError, type WecomBill, type WecomPage } from "./wecom-client.ts";

export interface PaymentClient {
  bills(begin: Date, end: Date, cursor?: string): Promise<WecomPage>;
  nickname(id: string): Promise<string | null>;
}
interface Source {
  id: string; import_since: Date; matching_since: Date; synced_until: Date | null;
  baseline_complete: boolean; reconciliation_until: Date | null; last_reconciliation_at: Date | null;
}
const day = 86_400_000;
const overlap = 10 * 60_000;
export function paymentWindows(begin: Date, end: Date, maxWindows = 7): [Date, Date][] {
  const result: [Date, Date][] = [];
  for (let at = begin.getTime(); at < end.getTime() && result.length < maxWindows; at += day) {
    result.push([new Date(at), new Date(Math.min(at + day, end.getTime()))]);
  }
  return result;
}

async function persistBill(trx: Transaction<Database>, source: Source, propertyId: string, bill: WecomBill, notify: boolean): Promise<string | null> {
  const previous = (await sql<{ id: string; state: string; amount_minor: number | null }>`SELECT id,state,amount_minor
    FROM external_payment_bills WHERE source_id=${source.id} AND merchant_id=${bill.merchantId}
      AND kind=${bill.kind} AND reference=${bill.reference} FOR UPDATE`.execute(trx)).rows[0];
  const id = previous?.id ?? externalBillId();
  // A standalone refund placeholder cannot overwrite verified parent details.
  if (!previous || bill.amountMinor !== null) {
    await sql`INSERT INTO external_payment_bills(id,source_id,merchant_id,property_id,kind,reference,
      original_trade_no,transaction_id,external_user_id,collector_id,amount_minor,occurred_at,state)
      VALUES(${id},${source.id},${bill.merchantId},${propertyId},${bill.kind},${bill.reference},${bill.originalTradeNo},
        ${bill.transactionId},${bill.externalUserId},${bill.collectorId},${bill.amountMinor},${bill.occurredAt},${bill.state})
      ON CONFLICT(source_id,merchant_id,kind,reference) DO UPDATE SET
        transaction_id=EXCLUDED.transaction_id,external_user_id=EXCLUDED.external_user_id,
        collector_id=EXCLUDED.collector_id,amount_minor=EXCLUDED.amount_minor,
        occurred_at=EXCLUDED.occurred_at,state=EXCLUDED.state,updated_at=now(),
        needs_review=external_payment_bills.needs_review OR
          (external_payment_bills.amount_minor IS NOT NULL AND external_payment_bills.amount_minor<>EXCLUDED.amount_minor)
          OR external_payment_bills.original_trade_no<>EXCLUDED.original_trade_no`.execute(trx);
  }
  await sql`SELECT qintopia_link_historical_external_payment(${id})`.execute(trx);
  return notify && (!previous || previous.state !== "SUCCESS") && bill.state === "SUCCESS" ? id : null;
}

export async function syncWecomSource(db: Kysely<Database>, sourceId: string, client: PaymentClient,
  now = new Date()): Promise<{ windows: number; skipped: boolean }> {
  return db.connection().execute(async connection => {
    const locked = (await sql<{ acquired: boolean }>`SELECT pg_try_advisory_lock(hashtextextended(${'wecom:' + sourceId},0)) AS acquired`.execute(connection)).rows[0]?.acquired;
    if (!locked) return { windows: 0, skipped: true };
    let completed = 0;
    try {
      const source = (await sql<Source>`SELECT * FROM external_payment_sources WHERE id=${sourceId} AND enabled`.execute(connection)).rows[0];
      if (!source) return { windows: 0, skipped: true };
      const accounts = (await sql<{ merchant_id: string; property_id: string }>`SELECT merchant_id,property_id
        FROM external_payment_accounts WHERE source_id=${sourceId}`.execute(connection)).rows;
      if (!accounts.length) throw new WecomApiError("WECOM_MERCHANT_MAPPING_MISSING", false);
      const mappings = new Map(accounts.map(a => [a.merchant_id, a.property_id]));
      const target = new Date(Math.floor(now.getTime() / 1000) * 1000);
      const checkedContacts = new Set<string>();
      let contactRequests = 0;
      const runWindow = async (begin: Date, end: Date, checkpoint: "recent" | "reconcile" | "repair") => {
        const bills: WecomBill[] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = await client.bills(begin, end, cursor);
          bills.push(...page.bills);
          if (bills.length > 100_000) throw new WecomApiError("WECOM_WINDOW_TOO_LARGE", false);
          cursor = page.nextCursor ?? undefined;
          if (cursor && cursors.has(cursor)) throw new WecomApiError("WECOM_CURSOR_LOOP");
          if (cursor) cursors.add(cursor);
          if (cursors.size > 1000) throw new WecomApiError("WECOM_TOO_MANY_PAGES");
        } while (cursor);
        // Nickname failure must never prevent durable payment ingestion.
        for (const bill of bills) {
          if (!mappings.has(bill.merchantId) || !bill.externalUserId || checkedContacts.has(bill.externalUserId) || contactRequests >= 20) continue;
          const id = bill.externalUserId;
          checkedContacts.add(id);
          const cached = (await sql<{ checked_at: Date }>`SELECT checked_at FROM external_payment_contacts
            WHERE source_id=${sourceId} AND external_user_id=${id}`.execute(connection)).rows[0];
          if (cached && cached.checked_at.getTime() > now.getTime() - day) continue;
          contactRequests++;
          let nickname: string | null = null;
          try { nickname = await client.nickname(id); } catch { /* show an explicit unknown nickname */ }
          await sql`INSERT INTO external_payment_contacts(source_id,external_user_id,nickname,checked_at)
            VALUES(${sourceId},${id},${nickname},${now}) ON CONFLICT(source_id,external_user_id)
            DO UPDATE SET nickname=COALESCE(EXCLUDED.nickname,external_payment_contacts.nickname),checked_at=EXCLUDED.checked_at`.execute(connection);
        }
        await connection.transaction().execute(async trx => {
          const discoveries: string[] = [];
          for (const bill of bills) {
            const propertyId = mappings.get(bill.merchantId);
            if (propertyId) {
              const discovered = await persistBill(trx, source, propertyId, bill, source.baseline_complete);
              if (discovered) discoveries.push(discovered);
            }
          }
          // All bill locks precede event-head locks, including concurrent Confirm.
          for (const id of discoveries) await sql`SELECT qintopia_external_payment_event(b.id,'DISCOVERED')
            FROM external_payment_bills b WHERE b.id=${id} AND b.state='SUCCESS' AND b.amount_minor IS NOT NULL
              AND NOT b.needs_review AND b.occurred_at>=${source.matching_since}
              AND NOT EXISTS(SELECT 1 FROM external_payment_matches m WHERE m.bill_id=b.id)
              AND NOT EXISTS(SELECT 1 FROM external_payment_bills other WHERE other.id<>b.id
                AND other.property_id=b.property_id AND other.kind=b.kind AND other.reference=b.reference)`.execute(trx);
          if (checkpoint === "recent") {
            await sql`UPDATE external_payment_sources SET synced_until=${end},
              baseline_complete=baseline_complete OR ${end.getTime() >= target.getTime()},
              last_success_at=CASE WHEN ${end.getTime() >= target.getTime()} THEN ${now} ELSE last_success_at END,
              last_error_code=NULL WHERE id=${sourceId}`.execute(trx);
          } else if (checkpoint === "reconcile") {
            await sql`UPDATE external_payment_sources SET reconciliation_until=${end},last_reconciliation_at=${now}
              WHERE id=${sourceId}`.execute(trx);
          }
        });
        completed++;
      };
      const begin = source.synced_until
        ? new Date(Math.max(source.import_since.getTime(), source.synced_until.getTime() - overlap)) : source.import_since;
      for (const [start, end] of paymentWindows(begin, target)) await runWindow(start, end, "recent");
      // Prioritize unresolved refunds whose parent payment is already known.
      if (source.baseline_complete) {
        const parent = (await sql<{ occurred_at: Date }>`SELECT p.occurred_at FROM external_payment_bills r
          JOIN external_payment_bills p ON p.source_id=r.source_id AND p.merchant_id=r.merchant_id
            AND p.original_trade_no=r.original_trade_no AND p.kind='COLLECTION'
          WHERE r.source_id=${sourceId} AND r.kind='REFUND' AND r.state IN ('PENDING','UNKNOWN')
            AND p.occurred_at<${begin} ORDER BY r.updated_at LIMIT 1`.execute(connection)).rows[0];
        if (parent) await runWindow(new Date(parent.occurred_at.getTime() - 1000),
          new Date(Math.min(parent.occurred_at.getTime() + 1000, target.getTime())), "repair");
      }
      // One older day per minute, continuing from a durable checkpoint.
      if (source.baseline_complete && (!source.last_reconciliation_at || now.getTime() - source.last_reconciliation_at.getTime() >= 60_000)) {
        const until = new Date(Math.max(source.import_since.getTime(), target.getTime() - overlap));
        const start = source.reconciliation_until && source.reconciliation_until < until
          ? source.reconciliation_until : source.import_since;
        if (start < until) await runWindow(start, new Date(Math.min(start.getTime() + day, until.getTime())), "reconcile");
      }
      return { windows: completed, skipped: false };
    } catch (error) {
      const code = error instanceof WecomApiError ? error.code : "WECOM_SYNC_FAILED";
      await sql`UPDATE external_payment_sources SET last_error_code=${code} WHERE id=${sourceId}`.execute(connection);
      throw error;
    } finally {
      await sql`SELECT pg_advisory_unlock(hashtextextended(${'wecom:' + sourceId},0))`.execute(connection);
    }
  });
}

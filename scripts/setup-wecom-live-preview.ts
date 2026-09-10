/** One-shot local preview. Reads WeCom; creates a new local database, never resets one. */
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { sql } from "kysely";
import { createDatabase, createCommandPreview, confirmCommandPreview } from "@qintopia/db";
import type { AuthPrincipal, CommandEnvelope } from "@qintopia/contracts";
import { demo, seedDemo } from "../packages/db/src/seed.ts";
import { createQuoteForTesting } from "../packages/db/src/pricing-service.ts";
import { WecomClient, WecomApiError, type WecomBill } from "../packages/db/src/wecom-client.ts";
import { syncWecomSource } from "../packages/db/src/wecom-sync.ts";
import { authScope } from "../tests/helpers/auth-principals.ts";

async function main() {
  const databaseUrl = process.env.WECOM_LOCAL_PREVIEW_DATABASE_URL;
  const corpId = process.env.PMS_WECOM_CORP_ID;
  const secret = process.env.PMS_WECOM_APP_SECRET;
  const merchantId = process.env.PMS_WECOM_MCH_ID;
  if (!databaseUrl || !corpId || !secret || !merchantId) throw Error("CONFIGURATION_REQUIRED");
  const parsed = new URL(databaseUrl);
  const databaseName = "qintopia_wecom_live_preview_20260910";
  if (parsed.hostname !== "127.0.0.1" || parsed.port !== "55441" || parsed.pathname !== `/${databaseName}`) {
    throw Error("DEDICATED_LOCAL_PREVIEW_DATABASE_REQUIRED");
  }
  const client = new WecomClient({ corpId, secret });
  const importSince = new Date("2026-08-01T00:00:00+08:00");
  const matchingSince = new Date("2026-09-01T00:00:00+08:00");
  const snapshotAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  const rows: WecomBill[] = [];
  const durations: number[] = [];
  for (let begin = importSince; begin < snapshotAt;) {
    const end = new Date(Math.min(begin.getTime() + 28 * 86_400_000, snapshotAt.getTime()));
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const started = Date.now();
      const page = await client.bills(begin, end, cursor);
      durations.push(Date.now() - started);
      rows.push(...page.bills.filter(bill => bill.merchantId === merchantId));
      cursor = page.nextCursor ?? undefined;
      if (cursor && seen.has(cursor)) throw Error("CURSOR_LOOP");
      if (cursor) seen.add(cursor);
      if (rows.length > 10_000 || seen.size > 20) throw Error("LOCAL_PREVIEW_LIMIT_EXCEEDED");
    } while (cursor);
    console.log(JSON.stringify({ stage: "read_window", from: begin.toISOString(), until: end.toISOString(), rowsRead: rows.length }));
    begin = end;
  }
  if (!rows.length) throw Error("NO_READABLE_BILLS_FOR_MERCHANT");
  // Names come only from the official contact endpoint; never infer a payer from an order.
  const nicknameCache = new Map<string, string | null>();
  const nicknameErrors = new Map<string, number>();
  for (const id of new Set(rows.map(bill => bill.externalUserId).filter((id): id is string => Boolean(id)))) {
    try { nicknameCache.set(id, await client.nickname(id)); }
    catch (error) {
      nicknameCache.set(id, null);
      const code = error instanceof WecomApiError ? error.code : "UNKNOWN";
      nicknameErrors.set(code, (nicknameErrors.get(code) ?? 0) + 1);
    }
    if (nicknameCache.size % 20 === 0) console.log(JSON.stringify({ stage: "contact_lookup", checked: nicknameCache.size }));
  }
  const adminUrl = new URL(parsed); adminUrl.pathname = "/qintopia";
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  let createdNew = false;
  await admin.connect();
  try {
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [databaseName]);
    if (exists.rowCount && process.env.WECOM_LOCAL_PREVIEW_RESUME_EMPTY !== "true") throw Error("PREVIEW_DATABASE_ALREADY_EXISTS_NOT_RESET");
    if (!exists.rowCount) { await admin.query(`CREATE DATABASE "${databaseName}"`); createdNew = true; }
  } finally { await admin.end(); }
  if (createdNew) {
    const migration = new pg.Client({ connectionString: databaseUrl });
    await migration.connect();
    try {
      const directory = resolve("packages/db/src/migrations");
      for (const name of (await readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
        await migration.query(await readFile(resolve(directory, name), "utf8"));
        await migration.query("INSERT INTO schema_migrations(name) VALUES ($1)", [name]);
      }
    } finally { await migration.end(); }
  }
  const db = createDatabase(databaseUrl);
  try {
    if (createdNew) await seedDemo(db, { includeProtocolFixturePolicy: true });
    else {
      const safe = (await sql<{ valid: boolean }>`SELECT
        NOT EXISTS(SELECT 1 FROM orders) AND NOT EXISTS(SELECT 1 FROM external_payment_sources)
        AND EXISTS(SELECT 1 FROM properties WHERE id=${demo.propertyId} AND name='秦托邦 · 本地真实流水体验（模拟订单）')
        AS valid`.execute(db)).rows[0]?.valid;
      if (!safe) throw Error("RESUME_REQUIRES_EMPTY_INITIALIZED_PREVIEW");
    }
    await db.updateTable("properties").set({ name: "秦托邦 · 本地真实流水体验（模拟订单）" }).where("id", "=", demo.propertyId).execute();
    const principal: AuthPrincipal = { subjectId: demo.agentSubjectId, credentialId: "token_demo_write", credentialType: "TOKEN",
      displayName: "Local preview setup", ...authScope() };
    let sequence = 0;
    const run = Date.now();
    const meta = () => ({ idempotencyKey: `live-preview-${run}-${++sequence}`, correlationId: `live-preview-${run}-${sequence}` });
    async function execute(command: CommandEnvelope) {
      const preview = await createCommandPreview(db, principal, command, meta());
      const result = await confirmCommandPreview(db, principal, preview.preview.previewId, { propertyId: demo.propertyId,
        commandType: command.commandType, confirmation: true, expectedEffectHash: preview.preview.effectHash,
        reason: command.commandType === "CREATE_ORDER" ? { code: "CREATE_STANDARD_ORDER", note: "" }
          : { code: "LOCAL_PREVIEW", note: "仅本地模拟，不代表真实订单归属" } }, meta());
      if (!result.businessCommitted) { console.error(JSON.stringify({ stage: "local_command", type: command.commandType, code: result.error?.code })); throw Error("LOCAL_PREVIEW_COMMAND_FAILED"); }
      return result;
    }
    const collectionOrders: string[] = [];
    const parent = rows.filter(bill => bill.kind === "REFUND" && bill.transactionId && bill.amountMinor && bill.state === "SUCCESS")
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
      .map(refund => rows.find(bill => bill.kind === "COLLECTION" && bill.transactionId === refund.transactionId && bill.state === "SUCCESS"))
      .find((bill): bill is WecomBill => Boolean(bill));
    for (const day of [1, 3]) {
      const quote = await createQuoteForTesting(db, { propertyId: demo.propertyId, inventoryUnitId: demo.roomId, stayType: "TRANSIENT",
        arrivalDate: `2028-12-0${day}`, departureDate: `2028-12-0${day + 1}`, pricingPolicyVersionId: demo.transientPolicyId });
      const result = await execute({ commandType: "CREATE_ORDER", input: { propertyId: demo.propertyId, quoteId: quote.quoteId,
        primaryGuest: { fullName: day === 1 ? "本地模拟收款订单" : "本地模拟退款订单", nickname: "模拟订单" }, bookingChannelCode: "WECOM",
        targetCurrentContractAmountMinor: quote.currentContractAmount.minorUnits } });
      collectionOrders.push(result.result!.orderId as string);
    }
    if (parent?.amountMinor) {
      await execute({ commandType: "RECORD_COLLECTION", input: { propertyId: demo.propertyId, orderId: collectionOrders[1],
        amountMinor: parent.amountMinor, method: "WECOM", transactionReference: parent.reference,
        note: "本地退款演示的模拟原收款关联；不代表真实订单归属" } });
    }
    await sql`INSERT INTO external_payment_sources(id,corp_id,enabled,matching_since,import_since)
      VALUES('local-live-preview',${corpId},true,${matchingSince},${importSince})`.execute(db);
    await sql`INSERT INTO external_payment_accounts VALUES('local-live-preview',${merchantId},${demo.propertyId})`.execute(db);
    for (const [id, nickname] of nicknameCache) {
      await sql`INSERT INTO external_payment_contacts(source_id,external_user_id,nickname,checked_at)
        VALUES('local-live-preview',${id},${nickname},${snapshotAt})`.execute(db);
    }
    const snapshotClient = { bills: async (begin: Date, end: Date) => ({ bills: rows.filter(bill => bill.occurredAt >= begin && bill.occurredAt <= end), nextCursor: null }),
      nickname: async (id: string) => nicknameCache.get(id) ?? null };
    for (let round = 0; round < 10; round++) {
      await syncWecomSource(db, "local-live-preview", snapshotClient, snapshotAt);
      const done = (await sql<{ done: boolean }>`SELECT baseline_complete AS done FROM external_payment_sources WHERE id='local-live-preview'`.execute(db)).rows[0]?.done;
      if (done) break;
      if (round === 9) throw Error("SNAPSHOT_BASELINE_INCOMPLETE");
    }
    const counts = (await sql`SELECT kind,state,count(*)::integer AS count,
      count(*) FILTER(WHERE occurred_at>=${matchingSince})::integer AS since_september
      FROM external_payment_bills GROUP BY kind,state ORDER BY kind,state`.execute(db)).rows;
    console.log(JSON.stringify({ result: "ready", snapshotAt: snapshotAt.toISOString(), databaseName,
      collectionOrderId: collectionOrders[0], refundOrderId: collectionOrders[1], refundOriginalLinked: Boolean(parent), counts,
      contactsChecked: nicknameCache.size, nicknamesFound: [...nicknameCache.values()].filter(Boolean).length,
      nicknameErrors: Object.fromEntries(nicknameErrors), billRequestMs: durations,
      data: "Real WeCom snapshot; simulated local orders and matches only; no live worker or outbound notifications" }));
  } finally { await db.destroy(); }
}
main().catch(error => { console.error(error instanceof WecomApiError ? error.code : error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "LOCAL_PREVIEW_FAILED"); process.exitCode = 1; });

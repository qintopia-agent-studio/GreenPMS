import { sql, type Kysely } from "kysely";
import type { Database } from "./schema.ts";
import { DomainError, type PaymentAllocationEvent, type PaymentAllocationEventPage } from "@qintopia/contracts";

export async function readPaymentAllocationEventHead(db: Kysely<Database>, propertyId: string) {
  const row = (await sql<{cursor: string}>`SELECT last_sequence::text AS cursor FROM payment_allocation_heads WHERE property_id=${propertyId}`.execute(db)).rows[0];
  return {schemaVersion: "pms.payments.v2" as const, propertyId, headCursor: row?.cursor ?? "0"};
}

export async function readPaymentAllocationEvents(db: Kysely<Database>, propertyId: string, after = "0", limit = 100): Promise<PaymentAllocationEventPage> {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(after) || BigInt(after)>9223372036854775807n || !Number.isInteger(limit) || limit<1 || limit>100)
    throw new DomainError("VALIDATION_ERROR", "流水事件游标或条数无效");
  const rows = (await sql<{event_id: string; sequence: string; bill_id: string; event_type: PaymentAllocationEvent["eventType"]; kind: "COLLECTION" | "REFUND"; created_at: Date}>`
    SELECT e.event_id,e.sequence::text,e.bill_id,e.event_type,e.created_at,b.kind FROM payment_allocation_events e JOIN external_payment_bills b ON b.id=e.bill_id
    WHERE e.property_id=${propertyId} AND e.sequence>${after}::bigint ORDER BY e.sequence LIMIT ${limit}`.execute(db)).rows;
  return {schemaVersion: "pms.payments.v2" as const, propertyId, events: rows.map(row => ({
    eventId: row.event_id, sequence: row.sequence, billVersion: row.sequence, billId: row.bill_id,
    eventType: row.event_type, occurredAt: row.created_at.toISOString(),
    // Invalidation reference, not an event-time balance snapshot. Read current state after applying version ordering.
    stateReference: {path: "/api/v2/external-payments", propertyId, billId: row.bill_id, kind: row.kind, status: "ALL" as const}
  })), nextCursor: rows.at(-1)?.sequence ?? after};
}

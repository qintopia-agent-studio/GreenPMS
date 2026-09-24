import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { Database } from "./schema.ts";
import { finishDelivery, sendClaim, validateDeliveryConfig, type ClaimedDelivery,
  type DeliveryTransport, type IntegrationDeliveryConfig } from "./integration-worker.ts";

export async function publishPaymentEvents(db: Kysely<Database>, propertyId: string, sourceInstance: string): Promise<number> {
  return (await sql<{ count: number }>`SELECT qintopia_payment_delivery_publish(${propertyId},${sourceInstance}) AS count`.execute(db)).rows[0]!.count;
}

export async function claimPaymentDelivery(db: Kysely<Database>, config: IntegrationDeliveryConfig): Promise<ClaimedDelivery | undefined> {
  validateDeliveryConfig(config);
  return db.transaction().execute(async trx => {
    const source = (await sql<{ source_instance: string; paused: boolean }>`SELECT source_instance,paused
      FROM payment_delivery_source WHERE singleton FOR SHARE`.execute(trx)).rows[0];
    if (!source || source.source_instance !== config.sourceInstance) throw Error("PAYMENT_DELIVERY_SOURCE_MISMATCH");
    if (source.paused) return undefined;
    const deliveryId = randomUUID();
    return (await sql<ClaimedDelivery>`WITH candidate AS (
      SELECT d.event_id,e.body FROM payment_deliveries d JOIN payment_delivery_events e ON e.event_id=d.event_id
      WHERE e.property_id=ANY(${[...config.propertyIds]}::text[])
        AND ((d.state='pending' AND d.next_attempt_at<=clock_timestamp()) OR (d.state='sending' AND d.lease_until<clock_timestamp()))
      ORDER BY d.next_attempt_at,e.sequence FOR UPDATE OF d SKIP LOCKED LIMIT 1
    ) UPDATE payment_deliveries d SET state='sending',attempts=d.attempts+1,generation=d.generation+1,
      first_attempt_at=coalesce(d.first_attempt_at,clock_timestamp()),lease_until=clock_timestamp()+${config.leaseMs}*interval '1 millisecond',
      last_delivery_id=${deliveryId} FROM candidate c WHERE d.event_id=c.event_id
      RETURNING d.event_id,c.body,d.generation::text,d.attempts,d.first_attempt_at,${deliveryId}::text AS delivery_id`.execute(trx)).rows[0];
  });
}

export async function deliverOnePayment(db: Kysely<Database>, config: IntegrationDeliveryConfig, transport?: DeliveryTransport): Promise<boolean> {
  const claim = await claimPaymentDelivery(db, config);
  if (!claim) return false;
  const outcome = await sendClaim(config, claim, transport);
  await finishDelivery(db, claim, outcome, Math.random, "payment");
  return true;
}

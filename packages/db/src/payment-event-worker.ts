import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { Database } from "./schema.ts";
import { finishDelivery, sendClaim, validateDeliveryConfig, type ClaimedDelivery,
  type DeliveryOutcome, type DeliveryTransport, type IntegrationDeliveryConfig } from "./integration-worker.ts";

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

export async function publishPaymentAllocationEvents(db: Kysely<Database>, propertyId: string, sourceInstance: string): Promise<number> {
  return (await sql<{ count: number }>`SELECT qintopia_allocation_delivery_publish(${propertyId},${sourceInstance}) AS count`.execute(db)).rows[0]!.count;
}

export async function claimPaymentAllocationDelivery(db: Kysely<Database>, config: IntegrationDeliveryConfig): Promise<ClaimedDelivery | undefined> {
  validateDeliveryConfig(config);
  return db.transaction().execute(async trx => {
    const source = (await sql<{ source_instance: string; paused: boolean }>`SELECT source_instance,paused
      FROM allocation_delivery_source WHERE singleton FOR SHARE`.execute(trx)).rows[0];
    if (!source || source.source_instance !== config.sourceInstance) throw Error("PAYMENT_DELIVERY_SOURCE_MISMATCH");
    if (source.paused) return undefined;
    const deliveryId = randomUUID();
    return (await sql<ClaimedDelivery>`WITH candidate AS (
      SELECT d.event_id,e.body FROM allocation_deliveries d JOIN allocation_delivery_events e ON e.event_id=d.event_id
      WHERE e.property_id=ANY(${[...config.propertyIds]}::text[])
        AND ((d.state='pending' AND d.next_attempt_at<=clock_timestamp()) OR (d.state='sending' AND d.lease_until<clock_timestamp()))
      ORDER BY d.next_attempt_at,e.sequence FOR UPDATE OF d SKIP LOCKED LIMIT 1
    ) UPDATE allocation_deliveries d SET state='sending',attempts=d.attempts+1,generation=d.generation+1,
      first_attempt_at=coalesce(d.first_attempt_at,clock_timestamp()),lease_until=clock_timestamp()+${config.leaseMs}*interval '1 millisecond',
      last_delivery_id=${deliveryId} FROM candidate c WHERE d.event_id=c.event_id
      RETURNING d.event_id,c.body,d.generation::text,d.attempts,d.first_attempt_at,${deliveryId}::text AS delivery_id`.execute(trx)).rows[0];
  });
}

export async function deliverOnePaymentAllocation(db: Kysely<Database>, config: IntegrationDeliveryConfig, transport?: DeliveryTransport): Promise<boolean> {
  const claim = await claimPaymentAllocationDelivery(db, config);
  if (!claim) return false;
  const outcome = await sendClaim(config, claim, transport);
  await finishPaymentAllocationDelivery(db, claim, outcome);
  return true;
}

export async function finishPaymentAllocationDelivery(db: Kysely<Database>, claim: ClaimedDelivery, outcome: DeliveryOutcome, random = Math.random): Promise<boolean> {
    const subscription = sql.table("allocation_delivery_source");
    const deliveries = sql.table("allocation_deliveries");
    const audit = sql.table("allocation_delivery_audit");
    return db.transaction().execute(async (trx) => {
        // Claim and completion lock subscription before delivery rows: same order as pause.
        await sql `SELECT singleton FROM ${subscription} WHERE singleton FOR UPDATE`.execute(trx);
        const expired = Date.now() - claim.first_attempt_at.getTime() >= 86400000;
        const state = outcome.kind === "accepted" ? "accepted" : outcome.kind === "dead_letter" || (outcome.kind === "retry" && expired) ? "dead_letter" : "pending";
        const code = outcome.kind === "accepted" ? "ACK_ACCEPTED" : expired && outcome.kind === "retry" ? "RETRY_EXHAUSTED" : outcome.code;
        const delay = Math.min(900000, Math.max(outcome.kind === "retry" ? outcome.retryAfterMs ?? 0 : 0, 1000 * 2 ** Math.min(claim.attempts - 1, 20) * (0.5 + random() / 2)));
        const updated = (await sql<{
            event_id: string;
        }> `UPDATE ${deliveries} SET state=${state},lease_until=NULL,next_attempt_at=clock_timestamp()+${delay}*interval '1 millisecond',
      receipt_id=${outcome.kind === "accepted" ? outcome.receipt : null},last_error_code=${outcome.kind === "accepted" ? null : code},
      completed_at=CASE WHEN ${state} IN ('accepted','dead_letter') THEN clock_timestamp() ELSE NULL END
      WHERE event_id=${claim.event_id} AND generation=${claim.generation}::bigint AND state='sending'
        AND lease_until>clock_timestamp() RETURNING event_id`.execute(trx)).rows[0];
        if (!updated)
            return false;
        if (outcome.kind === "pause")
            await sql `UPDATE ${subscription} SET paused=true,reason_code=${code} WHERE singleton`.execute(trx);
        await sql `INSERT INTO ${audit}(event_id,action,result_code,delivery_id,generation) VALUES(${claim.event_id},'ATTEMPT',${code},${claim.delivery_id},${claim.generation}::bigint)`.execute(trx);
        return true;
    });
}

// Frozen from migration 070 in the isolated PostgreSQL 18 fixture. Includes columns,
// keys, checks, indexes, trigger definitions/modes and function bodies/configuration.
const allocationExpectedFingerprint = "a932a9efe97cd2fe40428f6f8ae7ec6977425759a6dc6854ecac6f5cb8d0471f";
export async function allocationDeliverySchemaFingerprint(db: Kysely<Database>): Promise<string> {
    const row = (await sql<{
        hash: string;
    }> `WITH tables AS (
    SELECT c.oid,c.relname,c.relowner,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND (c.relname LIKE 'allocation_deliver%' OR c.relname IN ('payment_allocation_heads','payment_allocation_events')) AND c.relkind='r'
  ), items AS (
    SELECT 'table:'||relname AS key, jsonb_build_array(relrowsecurity,relforcerowsecurity,relowner=(SELECT datdba FROM pg_database WHERE datname=current_database()))::text AS value FROM tables
    UNION ALL SELECT 'column:'||t.relname||':'||a.attname,jsonb_build_array(format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid))::text
      FROM tables t JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped LEFT JOIN pg_attrdef d ON d.adrelid=t.oid AND d.adnum=a.attnum
    UNION ALL SELECT 'constraint:'||t.relname||':'||c.conname,jsonb_build_array(pg_get_constraintdef(c.oid),c.convalidated)::text FROM tables t JOIN pg_constraint c ON c.conrelid=t.oid
    UNION ALL SELECT 'index:'||c.relname,jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready)::text FROM tables t JOIN pg_index i ON i.indrelid=t.oid JOIN pg_class c ON c.oid=i.indexrelid
    UNION ALL SELECT 'trigger:'||c.relname||':'||t.tgname,jsonb_build_array(pg_get_triggerdef(t.oid),t.tgenabled)::text
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND (t.tgname LIKE 'allocation_deliver%' OR t.tgname LIKE 'payment_allocation_%' OR t.tgrelid IN (SELECT oid FROM tables))
    UNION ALL SELECT 'function:'||p.proname, jsonb_build_array(pg_get_functiondef(p.oid),p.proowner=(SELECT datdba FROM pg_database WHERE datname=current_database()))::text
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('qintopia_allocation_emit','qintopia_allocation_capture','qintopia_allocation_delivery_immutable','qintopia_allocation_delivery_publish','qintopia_allocation_delivery_control')
  ) SELECT encode(sha256(convert_to(jsonb_agg(jsonb_build_array(key,value) ORDER BY key)::text,'UTF8')),'hex') AS hash FROM items`.execute(db)).rows[0];
    return row?.hash ?? "";
}
export async function allocationDeliveryReady(db: Kysely<Database>): Promise<boolean> {
  if (await allocationDeliverySchemaFingerprint(db) !== allocationExpectedFingerprint) return false;
  const row = (await sql<{ready: boolean}>`SELECT
    EXISTS(SELECT 1 FROM pg_roles WHERE rolname='qintopia_allocation_delivery_worker' AND NOT rolsuper
      AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls)
    AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='qintopia_allocation_delivery_worker'))
    AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('TRIGGER'),('REFERENCES')) privilege(name)
      WHERE n.nspname='public' AND c.relkind IN ('r','p','v') AND (
        (has_table_privilege('qintopia_allocation_delivery_worker',c.oid,privilege.name) OR
          CASE WHEN privilege.name IN ('SELECT','INSERT','UPDATE','REFERENCES') THEN has_any_column_privilege('qintopia_allocation_delivery_worker',c.oid,privilege.name) ELSE false END)
        IS DISTINCT FROM (
          (privilege.name='SELECT' AND c.relname IN ('allocation_delivery_source','allocation_delivery_events','allocation_deliveries')) OR
          (privilege.name='UPDATE' AND c.relname IN ('allocation_delivery_source','allocation_deliveries')) OR
          (privilege.name='INSERT' AND c.relname='allocation_delivery_audit'))))
    AND NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped AND
        ((c.relname='allocation_delivery_source' AND has_column_privilege('qintopia_allocation_delivery_worker',c.oid,a.attnum,'UPDATE') IS DISTINCT FROM (a.attname IN ('paused','reason_code')))
        OR (c.relname='allocation_deliveries' AND has_column_privilege('qintopia_allocation_delivery_worker',c.oid,a.attnum,'UPDATE') IS DISTINCT FROM (a.attname<>'event_id'))))
    AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN ('qintopia_allocation_emit','qintopia_allocation_capture','qintopia_allocation_delivery_immutable','qintopia_allocation_delivery_publish','qintopia_allocation_delivery_control') AND
        (has_function_privilege('public',p.oid,'EXECUTE') OR has_function_privilege('qintopia_runtime',p.oid,'EXECUTE') OR
          has_function_privilege('qintopia_allocation_delivery_worker',p.oid,'EXECUTE') IS DISTINCT FROM (p.proname='qintopia_allocation_delivery_publish')))
    AS ready`.execute(db)).rows[0];
  return row?.ready === true;
}

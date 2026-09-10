import { createHash, createHmac, randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { Database } from "./schema.ts";
export interface IntegrationDeliveryConfig {
    endpoint: string;
    sourceInstance: string;
    propertyIds: readonly string[];
    keyId: string;
    signingKey: string;
    timeoutMs: number;
    leaseMs: number;
}
export interface ClaimedDelivery {
    event_id: string;
    body: string;
    generation: string;
    attempts: number;
    first_attempt_at: Date;
    delivery_id: string;
}
export interface DeliveryResponse {
    status: number;
    body: string;
    retryAfter: string | null;
}
export type DeliveryTransport = (endpoint: string, body: string, headers: Record<string, string>, timeoutMs: number) => Promise<DeliveryResponse>;
export type DeliveryOutcome = {
    kind: "accepted";
    receipt: string;
} | {
    kind: "pause" | "dead_letter" | "retry";
    code: string;
    retryAfterMs?: number;
};
export function validateDeliveryConfig(config: IntegrationDeliveryConfig) {
    const url = new URL(config.endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/api/v1/ingress/pms/events")
        throw Error("INTEGRATION_ENDPOINT_INVALID");
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(config.keyId) || Buffer.byteLength(config.signingKey) < 32 || !config.propertyIds.length || new Set(config.propertyIds).size !== config.propertyIds.length)
        throw Error("INTEGRATION_CONFIG_INVALID");
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(config.sourceInstance) || config.propertyIds.some(id => !id || id.length > 256))
        throw Error("INTEGRATION_SCOPE_INVALID");
    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 30000 || !Number.isInteger(config.leaseMs) || config.leaseMs < config.timeoutMs + 5000 || config.leaseMs > 120000)
        throw Error("INTEGRATION_TIMEOUT_INVALID");
}
export function eventSignature(body: string, sentAt: string, deliveryId: string, signingKey: string) {
    const hash = createHash("sha256").update(body, "utf8").digest("hex");
    return createHmac("sha256", signingKey).update(`POST\n/api/v1/ingress/pms/events\n${sentAt}\n${deliveryId}\n${hash}`).digest("hex");
}
function retryAfterMs(value: string | null, now: number): number | undefined {
    if (!value)
        return undefined;
    const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
    return Number.isFinite(delay) ? Math.max(0, Math.min(delay, 900000)) : undefined;
}
export function classifyDelivery(response: DeliveryResponse, eventId: string, now = Date.now()): DeliveryOutcome {
    if (response.status === 401 || response.status === 403)
        return { kind: "pause", code: `HTTP_${response.status}` };
    if ([400, 409, 413, 422].includes(response.status))
        return { kind: "dead_letter", code: `HTTP_${response.status}` };
    if (response.status === 200 || response.status === 202) {
        try {
            const ack = JSON.parse(response.body) as Record<string, unknown>;
            if (ack && ack.event_id === eventId && ack.status === (response.status === 202 ? "accepted" : "duplicate") && typeof ack.receipt_id === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(ack.receipt_id))
                return { kind: "accepted", receipt: ack.receipt_id };
        }
        catch { /* Do not log response material. */ }
        return { kind: "retry", code: "ACK_MISMATCH" };
    }
    const delay = retryAfterMs(response.retryAfter, now);
    return { kind: "retry", code: `HTTP_${response.status}`, ...(delay === undefined ? {} : { retryAfterMs: delay }) };
}
/** Fixed HTTPS destination, platform TLS verification, no redirects, bounded body/time. */
export const httpsDeliveryTransport: DeliveryTransport = async (endpoint, body, headers, timeoutMs) => {
    const response = await fetch(endpoint, { method: "POST", body, headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    const reader = response.body?.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    if (reader) {
        try {
            while (true) {
                const item = await reader.read();
                if (item.done)
                    break;
                size += item.value.length;
                if (size > 4096) {
                    await reader.cancel();
                    return { status: response.status, body: "", retryAfter: response.headers.get("retry-after") };
                }
                chunks.push(item.value);
            }
        }
        finally {
            reader.releaseLock();
        }
    }
    return { status: response.status, body: Buffer.concat(chunks).toString("utf8"), retryAfter: response.headers.get("retry-after") };
};
export async function claimDelivery(db: Kysely<Database>, config: IntegrationDeliveryConfig): Promise<ClaimedDelivery | undefined> {
    validateDeliveryConfig(config);
    return db.transaction().execute(async (trx) => {
        const enabled = (await sql<{
            enabled: boolean;
        }> `SELECT NOT paused AS enabled FROM integration_subscription_state WHERE singleton FOR SHARE`.execute(trx)).rows[0]?.enabled;
        if (!enabled)
            return undefined;
        const matching = (await sql<{
            ok: boolean;
        }> `SELECT source_instance=${config.sourceInstance} AS ok FROM integration_source`.execute(trx)).rows[0]?.ok;
        if (!matching)
            throw Error("INTEGRATION_SOURCE_MISMATCH");
        const deliveryId = randomUUID();
        return (await sql<ClaimedDelivery> `WITH candidate AS (
      SELECT d.event_id,e.body FROM integration_deliveries d JOIN integration_published_events e ON e.event_id=d.event_id
      WHERE e.property_id=ANY(${[...config.propertyIds]}::text[])
        AND ((d.state='pending' AND d.next_attempt_at<=clock_timestamp()) OR (d.state='sending' AND d.lease_until<clock_timestamp()))
      ORDER BY d.next_attempt_at,e.publish_seq FOR UPDATE OF d SKIP LOCKED LIMIT 1
    ) UPDATE integration_deliveries d SET state='sending',attempts=d.attempts+1,generation=d.generation+1,
      first_attempt_at=coalesce(d.first_attempt_at,clock_timestamp()),lease_until=clock_timestamp()+${config.leaseMs}*interval '1 millisecond',
      last_delivery_id=${deliveryId} FROM candidate c WHERE d.event_id=c.event_id
      RETURNING d.event_id,c.body,d.generation::text,d.attempts,d.first_attempt_at,${deliveryId}::text AS delivery_id`.execute(trx)).rows[0];
    });
}
export async function finishDelivery(db: Kysely<Database>, claim: ClaimedDelivery, outcome: DeliveryOutcome, random = Math.random): Promise<boolean> {
    return db.transaction().execute(async (trx) => {
        // Claim and completion lock subscription before delivery rows: same order as pause.
        await sql `SELECT singleton FROM integration_subscription_state WHERE singleton FOR UPDATE`.execute(trx);
        const expired = Date.now() - claim.first_attempt_at.getTime() >= 86400000;
        const state = outcome.kind === "accepted" ? "accepted" : outcome.kind === "dead_letter" || (outcome.kind === "retry" && expired) ? "dead_letter" : "pending";
        const code = outcome.kind === "accepted" ? "ACK_ACCEPTED" : expired && outcome.kind === "retry" ? "RETRY_EXHAUSTED" : outcome.code;
        const delay = Math.min(900000, Math.max(outcome.kind === "retry" ? outcome.retryAfterMs ?? 0 : 0, 1000 * 2 ** Math.min(claim.attempts - 1, 20) * (0.5 + random() / 2)));
        const updated = (await sql<{
            event_id: string;
        }> `UPDATE integration_deliveries SET state=${state},lease_until=NULL,next_attempt_at=clock_timestamp()+${delay}*interval '1 millisecond',
      receipt_id=${outcome.kind === "accepted" ? outcome.receipt : null},last_error_code=${outcome.kind === "accepted" ? null : code},
      completed_at=CASE WHEN ${state} IN ('accepted','dead_letter') THEN clock_timestamp() ELSE NULL END
      WHERE event_id=${claim.event_id} AND generation=${claim.generation}::bigint AND state='sending'
        AND lease_until>clock_timestamp() RETURNING event_id`.execute(trx)).rows[0];
        if (!updated)
            return false;
        if (outcome.kind === "pause")
            await sql `UPDATE integration_subscription_state SET paused=true,reason_code=${code} WHERE singleton`.execute(trx);
        await sql `INSERT INTO integration_delivery_audit(event_id,action,result_code,delivery_id,generation) VALUES(${claim.event_id},'ATTEMPT',${code},${claim.delivery_id},${claim.generation}::bigint)`.execute(trx);
        return true;
    });
}
export async function deliverOne(db: Kysely<Database>, config: IntegrationDeliveryConfig, transport: DeliveryTransport = httpsDeliveryTransport) {
    const claim = await claimDelivery(db, config);
    if (!claim)
        return false;
    const sentAt = String(Math.floor(Date.now() / 1000));
    let outcome: DeliveryOutcome;
    try {
        if (Buffer.byteLength(claim.body) > 65536)
            outcome = { kind: "dead_letter", code: "BODY_TOO_LARGE" };
        else
            outcome = classifyDelivery(await transport(config.endpoint, claim.body, { "Content-Type": "application/json", "X-QT-Key-Id": config.keyId, "X-QT-Sent-At": sentAt, "X-QT-Delivery-Id": claim.delivery_id, "X-QT-Signature": eventSignature(claim.body, sentAt, claim.delivery_id, config.signingKey) }, config.timeoutMs), claim.event_id);
    }
    catch {
        outcome = { kind: "retry", code: "TRANSPORT_UNCONFIRMED" };
    }
    await finishDelivery(db, claim, outcome);
    return true;
}
export async function publishPmsEvents(db: Kysely<Database>, property: string) {
    return (await sql<{
        count: number;
    }> `SELECT qintopia_integration_publish(${property},100) AS count`.execute(db)).rows[0]!.count;
}

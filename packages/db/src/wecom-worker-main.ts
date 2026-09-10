import { sql } from "kysely";
import { createDatabase } from "./database.ts";
import { WecomClient } from "./wecom-client.ts";
import { syncWecomSource } from "./wecom-sync.ts";
import { externalPaymentsReady } from "./external-payments-readiness.ts";

async function main() {
  if (process.env.PMS_WECOM_SYNC_ENABLED !== "true") { console.log("WECOM_SYNC_DISABLED"); return; }
  const url = process.env.PMS_WECOM_WORKER_DATABASE_URL;
  const sourceId = process.env.PMS_WECOM_SOURCE_ID;
  const corpId = process.env.PMS_WECOM_CORP_ID;
  const secret = process.env.PMS_WECOM_APP_SECRET;
  if (!url || !sourceId || !corpId || !secret) throw Error("CONFIG");
  const db = createDatabase(url, { max: 2, connectionTimeoutMillis: 10_000, statement_timeout: 15_000 });
  const client = new WecomClient({ corpId, secret });
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    const identity = (await sql<{ valid: boolean }>`SELECT current_user='qintopia_payment_worker'
      AND session_user='qintopia_payment_worker' AS valid`.execute(db)).rows[0]?.valid;
    if (!identity || !await externalPaymentsReady(db)) throw Error("READINESS");
    const source = (await sql<{ valid: boolean }>`SELECT corp_id=${corpId} AND enabled AS valid
      FROM external_payment_sources WHERE id=${sourceId}`.execute(db)).rows[0]?.valid;
    if (!source) throw Error("SOURCE");
    let failures = 0;
    while (!abort.signal.aborted) {
      const started = Date.now();
      try { await syncWecomSource(db, sourceId, client); failures = 0; }
      catch { failures++; console.error("WECOM_SYNC_RETRY_PENDING"); }
      if (!abort.signal.aborted) {
        const { setTimeout } = await import("node:timers/promises");
        await setTimeout(Math.max(1000, Math.min(900_000, 60_000 * 2 ** Math.min(failures, 4)) - (Date.now() - started)), undefined,
          { signal: abort.signal }).catch(() => {});
      }
    }
  } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); await db.destroy(); }
}
main().catch(() => { console.error("WECOM_WORKER_STOPPED"); process.exitCode = 1; });

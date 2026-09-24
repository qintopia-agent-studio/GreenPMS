import { sql } from "kysely";
import { createDatabase } from "./database.ts";
import { validateDeliveryConfig, type IntegrationDeliveryConfig } from "./integration-worker.ts";
import { deliverOnePayment, publishPaymentEvents } from "./payment-event-worker.ts";
import { externalPaymentsReady } from "./external-payments-readiness.ts";
import { paymentDeliveryReady } from "./payment-delivery-readiness.ts";

// Separate opt-in process; no migrations, seeding, credentials or activation in code.
async function main() {
  if (process.env.PMS_PAYMENT_DELIVERY_ENABLED !== "true") {
    console.log(JSON.stringify({ code: "PAYMENT_DELIVERY_DISABLED" }));
    return;
  }
  const databaseUrl = process.env.PMS_PAYMENT_DELIVERY_DATABASE_URL;
  const config: IntegrationDeliveryConfig = {
    endpoint: process.env.PMS_PAYMENT_DELIVERY_ENDPOINT ?? "",
    sourceInstance: process.env.PMS_PAYMENT_SOURCE_INSTANCE ?? "",
    propertyIds: (process.env.PMS_PAYMENT_PROPERTY_IDS ?? "").split(",").map(v => v.trim()).filter(Boolean),
    keyId: process.env.PMS_PAYMENT_KEY_ID ?? "", signingKey: process.env.PMS_PAYMENT_SIGNING_KEY ?? "",
    timeoutMs: 10000, leaseMs: 30000
  };
  if (!databaseUrl) throw Error("CONFIG");
  validateDeliveryConfig(config);
  const db = createDatabase(databaseUrl, {max: 4, connectionTimeoutMillis: 10000, statement_timeout: 15000});
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try {
    const identity = (await sql<{valid: boolean}>`SELECT current_user='qintopia_payment_delivery_worker'
      AND session_user='qintopia_payment_delivery_worker' AS valid`.execute(db)).rows[0]?.valid;
    if (!identity || !await paymentDeliveryReady(db) || !await externalPaymentsReady(db)) throw Error("READINESS");
    let lastStatus = 0;
    while (!stopping) {
      let published = 0;
      for (const property of config.propertyIds) {
        if (stopping) break;
        published += await publishPaymentEvents(db, property, config.sourceInstance);
      }
      const attempted = !stopping && await deliverOnePayment(db, config);
      if (Date.now() - lastStatus >= 60000) {
        const states = (await sql<{state: string; count: string}>`SELECT d.state,count(*)::text AS count
          FROM payment_deliveries d JOIN payment_delivery_events e USING(event_id)
          WHERE e.property_id=ANY(${[...config.propertyIds]}::text[]) GROUP BY d.state`.execute(db)).rows;
        const source = (await sql<{paused: boolean; reason_code: string}>`SELECT paused,reason_code FROM payment_delivery_source`.execute(db)).rows[0];
        console.log(JSON.stringify({code: "PAYMENT_DELIVERY_STATUS", states, ...source}));
        lastStatus = Date.now();
      }
      if (published || attempted) console.log(JSON.stringify({code: "PAYMENT_DELIVERY_TICK", published, attempted}));
      if (!stopping) await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } finally {
    process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop);
    await db.destroy();
  }
}
main().catch(() => { console.error(JSON.stringify({code: "PAYMENT_DELIVERY_STOPPED"})); process.exitCode = 1; });

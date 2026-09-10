import { sql } from "kysely";
import { createDatabase } from "./database.ts";
import { integrationReady } from "./integration-readiness.ts";
import { deliverOne, publishPmsEvents, validateDeliveryConfig, type IntegrationDeliveryConfig } from "./integration-worker.ts";
// Dedicated process. No business writes, migrations, seeding or source activation.
async function main() {
    const publish = process.env.PMS_INTEGRATION_PUBLISH_ENABLED === "true";
    const delivery = process.env.PMS_INTEGRATION_DELIVERY_ENABLED === "true";
    const prune = process.env.PMS_INTEGRATION_PRUNE_ENABLED === "true";
    if (!publish && !delivery && !prune) {
        console.log(JSON.stringify({ code: "INTEGRATION_DISABLED" }));
        return;
    }
    const url = process.env.PMS_INTEGRATION_WORKER_DATABASE_URL;
    const sourceInstance = process.env.PMS_INTEGRATION_SOURCE_INSTANCE;
    const propertyIds = (process.env.PMS_INTEGRATION_PROPERTY_IDS ?? "").split(",").map(v => v.trim()).filter(Boolean);
    if (!url || !sourceInstance || !propertyIds.length)
        throw Error("CONFIG");
    let config: IntegrationDeliveryConfig | undefined;
    if (delivery) {
        config = { endpoint: process.env.PMS_INTEGRATION_ENDPOINT ?? "", sourceInstance, propertyIds, keyId: process.env.PMS_INTEGRATION_KEY_ID ?? "", signingKey: process.env.PMS_INTEGRATION_SIGNING_KEY ?? "", timeoutMs: 10000, leaseMs: 30000 };
        validateDeliveryConfig(config);
    }
    const db = createDatabase(url, {max:4,connectionTimeoutMillis:10000,statement_timeout:15000});
    let stopping = false;
    const stop = () => { stopping = true; };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    try {
        const identity = (await sql<{
            valid: boolean;
        }> `SELECT current_user='qintopia_integration_worker' AND session_user='qintopia_integration_worker' AS valid`.execute(db)).rows[0]?.valid;
        if (!identity || !await integrationReady(db))
            throw Error("READINESS");
        const configured = (await sql<{
            valid: boolean;
        }> `SELECT source_instance=${sourceInstance} AS valid FROM integration_source`.execute(db)).rows[0]?.valid;
        if (!configured)
            throw Error("SOURCE");
        let lastStatus = 0;
        while (!stopping) {
            let published = 0, attempted = 0;
            for (const property of propertyIds) {
                if (stopping)
                    break;
                if (publish)
                    published += await publishPmsEvents(db, property);
                if (prune)
                    await sql `SELECT qintopia_integration_prune(${property},30)`.execute(db);
            }
            // Bound in-flight work to one delivery; leases permit safe additional processes.
            if (!stopping && config && await deliverOne(db, config))
                attempted++;
            if (Date.now() - lastStatus >= 60000) {
                for (const property of propertyIds) {
                    const status = (await sql<Record<string, unknown>> `SELECT * FROM qintopia_integration_status(${property})`.execute(db)).rows[0];
                    console.log(JSON.stringify({ code: "INTEGRATION_STATUS", property_id: property, ...status }));
                }
                lastStatus = Date.now();
            }
            if (published || attempted)
                console.log(JSON.stringify({ code: "INTEGRATION_TICK", published, attempted }));
            if (!stopping)
                await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    finally {
        process.removeListener("SIGTERM", stop);
        process.removeListener("SIGINT", stop);
        await db.destroy();
    }
}
main().catch(() => { console.error(JSON.stringify({ code: "INTEGRATION_WORKER_STOPPED" })); process.exitCode = 1; });

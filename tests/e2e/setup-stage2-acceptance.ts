import { todayInTimeZone } from "@qintopia/domain";
import { sql } from "kysely";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { resetDatabase } from "../helpers/database.ts";

const databaseUrl = process.env.STAGE2_ACCEPTANCE_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_stage2_acceptance";

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const db = await resetDatabase(databaseUrl);
  try {
    const policy = await db.selectFrom("pricing_policy_versions")
      .select("product_anchor_rates_minor")
      .where("id", "=", demo.publicPricingPolicyId)
      .executeTakeFirstOrThrow();
    const rates = typeof policy.product_anchor_rates_minor === "string"
      ? JSON.parse(policy.product_anchor_rates_minor) as Record<string, unknown>
      : policy.product_anchor_rates_minor as Record<string, unknown>;
    // This isolated dataset uses a round policy base so 15% boundaries remain exact whole-yuan inputs.
    await db.transaction().execute(async (trx) => {
      await sql`ALTER TABLE pricing_policy_versions DISABLE TRIGGER pricing_policy_versions_append_only`.execute(trx);
      await trx.updateTable("pricing_policy_versions")
        .set({
          product_anchor_rates_minor: {
            ...rates,
            shared_bath_double_whole_room: {
              "1": 10_000,
              "7": 70_000,
              "14": 140_000,
              "30": 300_000
            }
          }
        })
        .where("id", "=", demo.publicPricingPolicyId)
        .executeTakeFirstOrThrow();
      await sql`ALTER TABLE pricing_policy_versions ENABLE TRIGGER pricing_policy_versions_append_only`.execute(trx);
    });

    const room = await db.selectFrom("inventory_units")
      .select(["id", "code"])
      .where("property_id", "=", demo.propertyId)
      .where("kind", "=", "ROOM")
      .where("code", "=", "104")
      .executeTakeFirstOrThrow();
    const today = todayInTimeZone("Asia/Shanghai");
    const scenarios = [
      { key: "external-85", arrivalOffset: 20, targetMinor: 85_000 },
      { key: "external-84", arrivalOffset: 32, targetMinor: 84_000 },
      { key: "external-116", arrivalOffset: 44, targetMinor: 116_000 },
      { key: "wecom-policy", arrivalOffset: 56, targetMinor: 100_000 },
      { key: "wecom-adjusted", arrivalOffset: 68, targetMinor: 99_000 }
    ];
    const fixtures = [];
    for (const scenario of scenarios) {
      const arrivalDate = addDays(today, scenario.arrivalOffset);
      const departureDate = addDays(arrivalDate, 10);
      const quote = await createQuoteForTesting(db, {
        propertyId: demo.propertyId,
        inventoryUnitId: room.id,
        stayType: "CUSTOM",
        arrivalDate,
        departureDate,
        pricingPolicyVersionId: demo.publicPricingPolicyId
      });
      if (quote.currentContractAmount.minorUnits !== 100_000) {
        throw new Error(`${scenario.key} expected a 100000 policy amount, received ${quote.currentContractAmount.minorUnits}`);
      }
      fixtures.push({
        key: scenario.key,
        unitCode: room.code,
        arrivalDate,
        departureDate,
        policyBaseMinor: quote.currentContractAmount.minorUnits,
        targetMinor: scenario.targetMinor
      });
    }

    process.stdout.write(`${JSON.stringify({ databaseUrl, fixtures }, null, 2)}\n`);
  } finally {
    await db.destroy();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

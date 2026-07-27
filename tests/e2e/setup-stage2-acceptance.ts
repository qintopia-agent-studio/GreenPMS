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
    // This isolated dataset uses round policy bases so 15% boundaries remain exact whole-yuan inputs.
    const roundWholeYuanRates = {
      "1": 10_000,
      "7": 70_000,
      "14": 140_000,
      "30": 300_000
    };
    await db.transaction().execute(async (trx) => {
      await sql`ALTER TABLE pricing_policy_versions DISABLE TRIGGER pricing_policy_versions_append_only`.execute(trx);
      await trx.updateTable("pricing_policy_versions")
        .set({
          product_anchor_rates_minor: {
            ...rates,
            shared_bath_double_whole_room: roundWholeYuanRates,
            shared_bath_standard_room: roundWholeYuanRates
          }
        })
        .where("id", "=", demo.publicPricingPolicyId)
        .executeTakeFirstOrThrow();
      await sql`ALTER TABLE pricing_policy_versions ENABLE TRIGGER pricing_policy_versions_append_only`.execute(trx);
    });

    const today = todayInTimeZone("Asia/Shanghai");
    const scenarios = [
      { key: "external-85", unitCode: "104", targetMinor: 8_500 },
      { key: "external-84", unitCode: "106", targetMinor: 8_400 },
      { key: "external-116", unitCode: "204", targetMinor: 11_600 },
      { key: "wecom-policy", unitCode: "D03", targetMinor: 10_000 },
      { key: "wecom-adjusted", unitCode: "D04", targetMinor: 9_900 }
    ];
    const rooms = await db.selectFrom("inventory_units")
      .select(["id", "code"])
      .where("property_id", "=", demo.propertyId)
      .where("kind", "=", "ROOM")
      .where("code", "in", scenarios.map((scenario) => scenario.unitCode))
      .execute();
    const roomByCode = new Map(rooms.map((room) => [room.code, room]));
    if (roomByCode.size !== scenarios.length) throw new Error("Stage 2 acceptance rooms are incomplete");

    const arrivalDate = addDays(today, 2);
    const departureDate = addDays(arrivalDate, 1);
    const fixtures = [];
    for (const scenario of scenarios) {
      const room = roomByCode.get(scenario.unitCode)!;
      const quote = await createQuoteForTesting(db, {
        propertyId: demo.propertyId,
        inventoryUnitId: room.id,
        stayType: "TRANSIENT",
        arrivalDate,
        departureDate,
        pricingPolicyVersionId: demo.publicPricingPolicyId
      });
      if (quote.currentContractAmount.minorUnits !== 10_000) {
        throw new Error(`${scenario.key} expected a 10000 policy amount, received ${quote.currentContractAmount.minorUnits}`);
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

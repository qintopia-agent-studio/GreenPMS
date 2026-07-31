import { todayInTimeZone } from "@qintopia/domain";
import { demo } from "../../packages/db/src/seed.ts";
import { resetDatabase, resetDatabaseInPlace } from "../helpers/database.ts";

export const e2eDatabaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_e2e";

async function main() {
  const db = process.env.E2E_DATABASE_RESET_MODE === "IN_PLACE"
    ? await resetDatabaseInPlace(e2eDatabaseUrl)
    : await resetDatabase(e2eDatabaseUrl);
  const propertyToday = todayInTimeZone("Asia/Shanghai");
  const yesterday = new Date(`${propertyToday}T00:00:00.000Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  await db.insertInto("entitlement_lots").values({
    id: "lot_e2e_expired_room_nights",
    contract_id: demo.memberContractId,
    unit_kind: "ROOM_NIGHT",
    total_units: 1,
    expires_on: yesterday.toISOString().slice(0, 10),
    version: 1
  }).execute();
  await db.destroy();
  process.stdout.write("Prepared qintopia_e2e with migrations and demo seed\n");
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

import { resetDatabase } from "../helpers/database.ts";
import { prepareStage8Acceptance } from "./setup-stage8-acceptance.ts";

const databaseUrl = process.env.U1_ACCEPTANCE_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_u1_acceptance";

export interface U1AcceptanceFixture {
  databaseUrl: string;
  businessDate: string;
  fulfillment: Awaited<ReturnType<typeof prepareStage8Acceptance>>;
  operator: { username: string; password: string };
}

export async function prepareU1Acceptance(url = databaseUrl): Promise<U1AcceptanceFixture> {
  const db = await resetDatabase(url);
  await db.destroy();
  const fulfillment = await prepareStage8Acceptance(url);
  return {
    databaseUrl: url,
    businessDate: fulfillment.businessDate,
    fulfillment,
    operator: { username: "operator", password: "demo-pass-2026" }
  };
}

async function main() {
  const fixture = await prepareU1Acceptance();
  process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
}

if (process.argv[1]?.endsWith("setup-u1-acceptance.ts")) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

import {
  prepareStage7Acceptance,
  type PrepareStage7AcceptanceOptions,
  type Stage7AcceptanceFixture
} from "./setup-stage7-acceptance.ts";

const defaultDatabaseUrl = process.env.U2_ACCEPTANCE_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_u2_acceptance";

export interface U2AcceptanceFixture extends Stage7AcceptanceFixture {
  databaseUrl: string;
  operator: { username: string; password: string };
}

export async function prepareU2Acceptance(
  databaseUrl = defaultDatabaseUrl,
  options: PrepareStage7AcceptanceOptions = {}
): Promise<U2AcceptanceFixture> {
  const fixture = await prepareStage7Acceptance(databaseUrl, options);
  return {
    ...fixture,
    databaseUrl,
    operator: { username: "operator", password: "demo-pass-2026" }
  };
}

async function main(): Promise<void> {
  const fixture = await prepareU2Acceptance(defaultDatabaseUrl, { dayOffset: 7 });
  process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
}

if (process.argv[1]?.endsWith("setup-u2-acceptance.ts")) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

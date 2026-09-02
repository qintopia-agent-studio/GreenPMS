export const runtimeDatabaseTestPassword = process.env.RUNTIME_DATABASE_TEST_PASSWORD
  ?? "qintopia-runtime-integration";

export function runtimeDatabaseUrlForTesting(ownerDatabaseUrl: string): string {
  const runtimeUrl = new URL(ownerDatabaseUrl);
  runtimeUrl.username = "qintopia_runtime";
  runtimeUrl.password = runtimeDatabaseTestPassword;
  return runtimeUrl.toString();
}

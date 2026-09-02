import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("runtime database credential isolation", () => {
  it("keeps migration execution out of the application image command", async () => {
    const dockerfile = await readFile("Dockerfile", "utf8");
    const command = dockerfile.split("\n").find((line) => line.startsWith("CMD ")) ?? "";
    expect(command).toContain("npm start");
    expect(command).not.toContain("db:migrate");
    expect(command).not.toContain("MIGRATION_DATABASE_URL");
    expect(command).not.toContain("RUNTIME_DATABASE_PASSWORD");
  });

  it("uses a completed one-shot migration service and gives app only runtime credentials", async () => {
    const compose = await readFile("compose.yaml", "utf8");
    const migrateStart = compose.indexOf("\n  migrate:\n");
    const seedStart = compose.indexOf("\n  seed:\n");
    const importStart = compose.indexOf("\n  reference-import:\n");
    const appStart = compose.indexOf("\n  app:\n");
    const volumesStart = compose.indexOf("\nvolumes:\n");
    expect(migrateStart).toBeGreaterThan(0);
    expect(seedStart).toBeGreaterThan(migrateStart);
    expect(importStart).toBeGreaterThan(seedStart);
    expect(appStart).toBeGreaterThan(importStart);
    const migrateService = compose.slice(migrateStart, seedStart);
    const seedService = compose.slice(seedStart, importStart);
    const appService = compose.slice(appStart, volumesStart);
    expect(migrateService).toContain("MIGRATION_DATABASE_URL:");
    expect(migrateService).toContain("RUNTIME_DATABASE_PASSWORD:");
    expect(migrateService).toContain(
      "STAFF_PROFILE_MANIFEST_NAME: ${MIGRATION_STAFF_PROFILE_MANIFEST_NAME:-${STAFF_PROFILE_MANIFEST_NAME:-unconfigured}}"
    );
    expect(migrateService).toContain("npm run db:migrate");
    expect(seedService).toContain("npm run db:seed");
    expect(seedService).not.toContain("db:migrate");
    expect(appService).toContain("DATABASE_URL:");
    expect(appService).toContain("STAFF_PROFILE_MANIFEST_NAME: ${STAFF_PROFILE_MANIFEST_NAME:-unconfigured}");
    expect(appService).toContain("service_completed_successfully");
    expect(appService).not.toContain("MIGRATION_DATABASE_URL:");
    expect(appService).not.toContain("MIGRATION_DATABASE_PASSWORD");
    expect(appService).not.toMatch(/^\s+RUNTIME_DATABASE_PASSWORD:/m);
    expect(appService).not.toContain("SEED_DEMO_DATA:");
    expect(appService).not.toContain("IMPORT_2026_REFERENCE_CATALOG:");
    expect(appService).not.toContain("db:migrate");
  });

  it("documents an explicit demo cold-start manifest transition", async () => {
    const [exampleEnvironment, coldStartVerification] = await Promise.all([
      readFile(".env.example", "utf8"),
      readFile("scripts/verify-compose-cold-start.sh", "utf8")
    ]);
    for (const source of [exampleEnvironment, coldStartVerification]) {
      expect(source).toContain("SEED_DEMO_DATA=true");
      expect(source).toContain("STAFF_PROFILE_MANIFEST_NAME=demo");
      expect(source).toContain("MIGRATION_STAFF_PROFILE_MANIFEST_NAME=unconfigured");
    }
    expect(coldStartVerification).toContain('test "$reconciled_staff_profile_manifest" = "demo"');
  });

  it("passes the reviewed manifest to the production app-only Compose service", async () => {
    const productionCompose = await readFile("compose.server.yaml", "utf8");
    expect(productionCompose).toContain("STAFF_PROFILE_MANIFEST_NAME: ${STAFF_PROFILE_MANIFEST_NAME:-unconfigured}");
    expect(productionCompose).not.toContain("MIGRATION_STAFF_PROFILE_MANIFEST_NAME");
  });
});

import { createDatabase, databaseReady } from "./database.ts";

const db = createDatabase();

try {
  if (!await databaseReady(db)) {
    process.stderr.write("Database readiness validation failed.\n");
    process.exitCode = 1;
  } else {
    process.stdout.write("Database readiness validated.\n");
  }
} finally {
  await db.destroy();
}

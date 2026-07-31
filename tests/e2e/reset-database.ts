import { execFile } from "node:child_process";
import { resolve as resolvePath } from "node:path";

const setupScript = resolvePath(process.cwd(), "tests/e2e/setup-database.ts");

export async function resetE2eDatabase(databaseUrl: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      process.execPath,
      ["--import", "tsx", setupScript],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          E2E_DATABASE_RESET_MODE: "IN_PLACE",
          E2E_DATABASE_URL: databaseUrl
        },
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120_000
      },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }
        const detail = stderr.trim();
        reject(new Error(detail ? `E2E database reset failed: ${detail}` : "E2E database reset failed", { cause: error }));
      }
    );
  });
}

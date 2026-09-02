import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { listenRuntimeApi } from "./runtime-startup.ts";

export async function main(): Promise<void> {
  const { app } = await listenRuntimeApi();
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}

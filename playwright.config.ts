import { defineConfig, devices } from "@playwright/test";

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_e2e";
const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const e2eApiPort = process.env.E2E_API_PORT ?? "4100";
const e2eWebPort = process.env.E2E_WEB_PORT ?? "4173";
const e2eWebBuildOutDir = process.env.E2E_WEB_BUILD_OUT_DIR ?? "dist-e2e";
const e2eApiUrl = `http://127.0.0.1:${e2eApiPort}`;
const e2eWebUrl = `http://127.0.0.1:${e2eWebPort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  // Every browser journey uses the same migrated PostgreSQL database and seed.
  workers: 1,
  timeout: 120_000,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: e2eWebUrl,
    trace: "retain-on-failure",
    ...(chromiumExecutablePath ? { launchOptions: { executablePath: chromiumExecutablePath } } : {})
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } }
  ],
  webServer: [
    {
      command: "npm run start -w @qintopia/api",
      url: `${e2eApiUrl}/health/ready`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        DATABASE_URL: e2eDatabaseUrl,
        PORT: e2eApiPort,
        WEB_ORIGIN: e2eWebUrl,
        LOG_LEVEL: "warn",
        LOGIN_RATE_LIMIT_MAX: "1000"
      }
    },
    {
      command: `npm run preview -w @qintopia/web -- --host 127.0.0.1 --port ${e2eWebPort}`,
      url: e2eWebUrl,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        WEB_PORT: e2eWebPort,
        API_PROXY_TARGET: e2eApiUrl,
        WEB_BUILD_OUT_DIR: e2eWebBuildOutDir
      }
    }
  ]
});

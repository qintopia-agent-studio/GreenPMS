import { createDatabase } from "@qintopia/db";
import { buildServer } from "../../apps/api/src/server.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { resetDatabase } from "../helpers/database.ts";
import { runtimeDatabaseUrlForTesting } from "../helpers/runtime-database.ts";
import type { CommandType } from "@qintopia/contracts";

async function main() {
  const databaseUrl = process.env.STEP96_ACCEPTANCE_DATABASE_URL
    ?? "postgres://qintopia:qintopia@127.0.0.1:55433/qintopia_step96_acceptance";
  const target = new URL(databaseUrl);
  if (!["127.0.0.1", "localhost"].includes(target.hostname)
    || !["/qintopia_step96_acceptance", "/qintopia_step96_e2e"].includes(target.pathname)) {
    throw new Error("9.6 setup only supports its named local acceptance databases");
  }
  process.env.LOG_LEVEL = "silent";
  const preserveExisting = process.argv.includes("--preserve-existing");
  const owner = preserveExisting ? createDatabase(databaseUrl) : await resetDatabase(databaseUrl);
  const app = await buildServer(createDatabase(runtimeDatabaseUrlForTesting(databaseUrl)));
  try {
    await app.ready();
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "demo-pass-2026" } });
    if (login.statusCode !== 200) throw new Error("Acceptance administrator login failed");
    const cookie = login.cookies.find((item) => item.name === "qintopia_session")!.value;
    let sequence = 0;
    async function command(commandType: CommandType, input: Record<string, unknown>) {
      const key = `step96-example-${Date.now()}-${++sequence}`;
      const previewResponse = await app.inject({ method: "POST", url: "/api/v1/command-previews", cookies: { qintopia_session: cookie }, headers: { "idempotency-key": `preview-${key}`, "x-correlation-id": key }, payload: { commandType, input: { propertyId: demo.propertyId, ...input } } });
      if (previewResponse.statusCode !== 200) throw new Error(previewResponse.body);
      const preview = previewResponse.json().preview;
      const response = await app.inject({ method: "POST", url: `/api/v1/command-previews/${preview.previewId}/confirm`, cookies: { qintopia_session: cookie }, headers: { "idempotency-key": `confirm-${key}`, "x-correlation-id": key }, payload: { propertyId: demo.propertyId, commandType, confirmation: true, expectedEffectHash: preview.effectHash, reason: { code: commandType, note: "9.6 合成验收资料" } } });
      if (response.json().businessCommitted !== true) throw new Error(response.body);
      return response.json().result as Record<string, unknown>;
    }
    if (!preserveExisting) {
    const preview = await app.inject({ method: "POST", url: "/api/v1/command-previews", cookies: { qintopia_session: cookie }, headers: { "idempotency-key": "step96-empty-preview", "x-correlation-id": "step96-empty" }, payload: { commandType: "CREATE_MEMBER", input: { propertyId: demo.propertyId, fullName: "误建会员 9.6", nickname: "可删除验收", phone: "19900009601", wechat: "step96-test" } } });
    if (preview.statusCode !== 200) throw new Error(preview.body);
    const response = await app.inject({ method: "POST", url: `/api/v1/command-previews/${preview.json().preview.previewId}/confirm`, cookies: { qintopia_session: cookie }, headers: { "idempotency-key": "step96-empty-confirm", "x-correlation-id": "step96-empty" }, payload: { propertyId: demo.propertyId, commandType: "CREATE_MEMBER", confirmation: true, expectedEffectHash: preview.json().preview.effectHash, reason: { code: "CREATE_MEMBER_PROFILE", note: "9.6 合成验收资料" } } });
    if (response.json().businessCommitted !== true) throw new Error(response.body);
    }
    const existing = await owner.selectFrom("members").select("id").where("phone", "=", "19900009602").executeTakeFirst();
    if (!existing) {
      const member = await command("CREATE_MEMBER", { fullName: "已办卡未核销 9.6", nickname: "误录收款删除验收", phone: "19900009602", wechat: "step96-test" });
      const product = await owner.selectFrom("membership_orders").select(["product_id", "listed_price_minor"]).where("id", "=", demo.membershipOrderId).executeTakeFirstOrThrow();
      const purchase = await command("CREATE_MEMBERSHIP_ORDER", { memberId: member.memberId, membershipProductId: product.product_id, agreedPriceMinor: product.listed_price_minor });
      await command("RECORD_MEMBERSHIP_PAYMENT", { membershipOrderId: purchase.membershipOrderId, amountMinor: 1000, transactionReference: "STEP96-ERRONEOUS-PAYMENT" });
      await command("ACTIVATE_MEMBERSHIP_ORDER", { membershipOrderId: purchase.membershipOrderId });
    }
    await app.inject({ method: "POST", url: "/api/v1/auth/logout", cookies: { qintopia_session: cookie } });
    process.stdout.write(`Prepared ${target.pathname.slice(1)} with synthetic 9.6 acceptance data\n`);
  } finally { await app.close(); await owner.destroy(); }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

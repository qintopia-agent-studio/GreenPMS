import { createDatabase, propertyLocalToday } from "@qintopia/db";
import type { CommandType } from "@qintopia/contracts";
import { sql } from "kysely";
import { buildServer } from "../../apps/api/src/server.ts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { runtimeDatabaseUrlForTesting } from "../helpers/runtime-database.ts";

async function main() {
  const databaseUrl = process.env.CHECKOUT_ACCEPTANCE_DATABASE_URL
    ?? "postgres://qintopia:qintopia@127.0.0.1:55433/qintopia_step96_checkout_acceptance";
  const target = new URL(databaseUrl);
  if (!["127.0.0.1", "localhost"].includes(target.hostname) || target.pathname !== "/qintopia_step96_checkout_acceptance") {
    throw new Error("Checkout reversal fixtures require the named local acceptance database");
  }
  process.env.LOG_LEVEL = "silent";
  const owner = createDatabase(databaseUrl);
  const app = await buildServer(createDatabase(runtimeDatabaseUrlForTesting(databaseUrl)));
  try {
    await app.ready();
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "demo-pass-2026" } });
    if (login.statusCode !== 200) throw new Error("Acceptance administrator login failed");
    const session = login.cookies.find((cookie) => cookie.name === "qintopia_session")!.value;
    const today = await propertyLocalToday(owner, demo.propertyId);
    const dateOffset = (days: number) => {
      const date = new Date(`${today}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + days);
      return date.toISOString().slice(0, 10);
    };
    async function command(commandType: CommandType, input: Record<string, unknown>) {
      const nonce = crypto.randomUUID();
      const previewResponse = await app.inject({ method: "POST", url: "/api/v1/command-previews",
        cookies: { qintopia_session: session }, headers: { "idempotency-key": `preview-${nonce}`, "x-correlation-id": nonce },
        payload: { commandType, input: { propertyId: demo.propertyId, ...input } } });
      if (previewResponse.statusCode !== 200) throw new Error(previewResponse.body);
      const { preview } = previewResponse.json();
      const response = await app.inject({ method: "POST", url: `/api/v1/command-previews/${preview.previewId}/confirm`,
        cookies: { qintopia_session: session }, headers: { "idempotency-key": `confirm-${nonce}`, "x-correlation-id": nonce },
        payload: { propertyId: demo.propertyId, commandType, confirmation: true, expectedEffectHash: preview.effectHash,
          reason: { code: input.backfill ? "BACKFILL_STAY" : commandType, note: input.backfillReason ?? "撤销退房合成验收数据" } } });
      if (!response.json().businessCommitted) throw new Error(response.body);
      return response.json().result as Record<string, unknown>;
    }
    const examples = [
      { label: "普通退房回退验收", unitId: demo.roomId, member: false, early: false, conflict: false },
      { label: "会员提前退房回退验收", unitId: "unit_room_201", member: true, early: true, conflict: false },
      { label: "原房冲突回退验收", unitId: "unit_room_109", member: false, early: true, conflict: true }
    ];
    for (const example of examples) {
      const existing = await owner.selectFrom("orders").select("id")
        .where(sql<boolean>`primary_guest_snapshot ->> 'nickname' = ${example.label}`).executeTakeFirst();
      if (existing) { process.stdout.write(`${example.label}: /orders/${existing.id}\n`); continue; }
      const quote = await createQuoteForTesting(owner, { propertyId: demo.propertyId, inventoryUnitId: example.unitId,
        arrivalDate: dateOffset(-2), departureDate: example.early ? dateOffset(4) : today,
        pricingPolicyVersionId: demo.publicPricingPolicyId });
      const created = await command("CREATE_ORDER", { quoteId: quote.quoteId,
        primaryGuest: { fullName: example.label, nickname: example.label, ...(example.member ? { phone: "19900009611" } : {}) },
        bookingChannelCode: "WECOM", channelOrderReference: null, backfill: true, backfillReason: "补录合成验收住宿" });
      const orderId = created.orderId as string;
      if (example.member) {
        const member = await command("CREATE_MEMBER", { fullName: example.label, nickname: example.label,
          phone: "19900009611", wechat: "checkout-acceptance" });
        await command("CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP", { orderId, memberId: member.memberId,
          membershipProductId: "membership_product_shared_bath_single_v1", collectionFactIds: [],
          agreedPriceMinor: 162000, remainingPaymentTransactionReference: "SYNTHETIC-CHECKOUT-ACCEPTANCE" });
      }
      if (example.early) await command("SHORTEN_STAY", { orderId, newDepartureDate: today });
      if (example.conflict) await command("LOCK_MAINTENANCE", { inventoryUnitId: example.unitId,
        arrivalDate: dateOffset(1), departureDate: dateOffset(2), reason: "撤销退房验收用维修占房" });
      process.stdout.write(`${example.label}: /orders/${orderId}\n`);
    }
    await app.inject({ method: "POST", url: "/api/v1/auth/logout", cookies: { qintopia_session: session } });
  } finally { await app.close(); await owner.destroy(); }
}

void main().catch((error: unknown) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });

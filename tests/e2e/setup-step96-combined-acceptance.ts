import { createDatabase, propertyLocalToday } from "@qintopia/db";
import type { CommandType } from "@qintopia/contracts";
import { sql } from "kysely";
import { buildServer } from "../../apps/api/src/server.ts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { runtimeDatabaseUrlForTesting } from "../helpers/runtime-database.ts";

async function main() {
  const databaseUrl = process.env.STEP96_COMBINED_ACCEPTANCE_DATABASE_URL
    ?? "postgres://qintopia:qintopia@127.0.0.1:55433/qintopia_step96_checkout_acceptance";
  const target = new URL(databaseUrl);
  if (!["127.0.0.1", "localhost"].includes(target.hostname) || target.pathname !== "/qintopia_step96_checkout_acceptance") {
    throw new Error("Combined fixtures require the named local acceptance database");
  }
  process.env.LOG_LEVEL = "silent";
  const owner = createDatabase(databaseUrl);
  const app = await buildServer(createDatabase(runtimeDatabaseUrlForTesting(databaseUrl)));
  try {
    await app.ready();
    const upgradeOnly = process.argv.includes("--upgrade-only");
    const cookies: Record<string, string> = {};
    const authorization: Record<string, string> = {};
    // Business-only fixtures can use the existing local demo token after a user changes their password.
    if (upgradeOnly) authorization.authorization = `Bearer ${demo.administratorWriteToken}`;
    else {
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: {
        username: "admin", password: process.env.STEP96_ACCEPTANCE_ADMIN_PASSWORD ?? "demo-pass-2026"
      } });
      if (login.statusCode !== 200) throw new Error("Acceptance administrator login failed");
      cookies.qintopia_session = login.cookies.find((cookie) => cookie.name === "qintopia_session")!.value;
    }
    const today = await propertyLocalToday(owner, demo.propertyId);
    const shiftDate = (days: number) => {
      const date = new Date(`${today}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + days);
      return date.toISOString().slice(0, 10);
    };
    async function command(commandType: CommandType, input: Record<string, unknown>) {
      const nonce = crypto.randomUUID();
      const prepared = await app.inject({ method: "POST", url: "/api/v1/command-previews", cookies,
        headers: { ...authorization, "idempotency-key": `preview-${nonce}`, "x-correlation-id": nonce },
        payload: { commandType, input: { propertyId: demo.propertyId, ...input } } });
      if (prepared.statusCode !== 200) throw new Error(prepared.body);
      const { preview } = prepared.json();
      const response = await app.inject({ method: "POST", url: `/api/v1/command-previews/${preview.previewId}/confirm`, cookies,
        headers: { ...authorization, "idempotency-key": `confirm-${nonce}`, "x-correlation-id": nonce },
        payload: { propertyId: demo.propertyId, commandType, confirmation: true, expectedEffectHash: preview.effectHash,
          reason: { code: input.backfill ? "BACKFILL_STAY" : commandType === "CREATE_ORDER" ? "CREATE_STANDARD_ORDER" : commandType,
            note: input.backfillReason ?? (commandType === "CREATE_ORDER" ? "" : "9.6 合并人工验收合成样例") } } });
      if (!response.json().businessCommitted) throw new Error(response.body);
      return response.json().result as Record<string, unknown>;
    }
    async function ensureMember(phone: string, label: string) {
      const existing = await owner.selectFrom("members").select("id").where("phone", "=", phone)
        .where("deleted_at", "is", null).executeTakeFirst();
      const id = existing?.id ?? (await command("CREATE_MEMBER", {
        fullName: label, nickname: label, phone, wechat: "step96-combined-acceptance"
      })).memberId as string;
      process.stdout.write(`${label}: /members?memberId=${id} (${phone})\n`);
      return id;
    }
    if (upgradeOnly) {
      const label = "撤销退房后升级会员验收";
      const existing = await owner.selectFrom("orders").select(["id", "status"])
        .where(sql<boolean>`primary_guest_snapshot ->> 'nickname' = ${label}`).executeTakeFirst();
      if (existing) {
        process.stdout.write(`${label}: /orders/${existing.id} (${existing.status}, 保留已有操作)\n`);
      } else {
        await ensureMember("19900009614", label);
        const quote = await createQuoteForTesting(owner, { propertyId: demo.propertyId, inventoryUnitId: "unit_room_302",
          arrivalDate: shiftDate(-2), departureDate: shiftDate(4), pricingPolicyVersionId: demo.publicPricingPolicyId });
        const created = await command("CREATE_ORDER", { quoteId: quote.quoteId,
          primaryGuest: { fullName: label, nickname: label, phone: "19900009614" },
          bookingChannelCode: "WECOM", channelOrderReference: null,
          targetCurrentContractAmountMinor: 60000, manualPriceAdjustmentReason: "合成验收协议价六晚600元",
          backfill: true, backfillReason: "补录合成升级会员验收住宿" });
        const orderId = created.orderId as string;
        await command("RECORD_COLLECTION", { orderId, amountMinor: 60000, method: "WECOM",
          transactionReference: "SYNTHETIC-STEP96-REVERSAL-UPGRADE-600", note: "本地合成验收收款，不涉及真实资金" });
        await command("SHORTEN_STAY", { orderId, newDepartureDate: today });
        process.stdout.write(`${label}: /orders/${orderId} (302, ${shiftDate(-2)} 至 ${shiftDate(4)}, 已提前退房, 原收款600元)\n`);
      }
      return;
    }
    await ensureMember("19900009612", "空会员删除验收");
    const memberId = await ensureMember("19900009613", "先取消预订再删除验收");
    const existingOrder = await owner.selectFrom("orders").select(["id", "arrival_date", "departure_date", "status"])
      .where((eb) => eb.or([eb("member_id", "=", memberId), eb("member_contract_id", "in",
        owner.selectFrom("member_contracts").select("id").where("member_id", "=", memberId))])).executeTakeFirst();
    if (existingOrder) {
      process.stdout.write(`预订样例保留: /orders/${existingOrder.id} (${existingOrder.status})\n`);
    } else {
      let purchase = await owner.selectFrom("membership_orders").select(["id", "status", "contract_id"])
        .where("member_id", "=", memberId).executeTakeFirst();
      if (!purchase) {
        const product = await owner.selectFrom("membership_products").select(["id", "list_price_minor"])
          .where("id", "=", "membership_product_shared_bath_single_v1").executeTakeFirstOrThrow();
        const created = await command("CREATE_MEMBERSHIP_ORDER", { memberId,
          membershipProductId: product.id, agreedPriceMinor: product.list_price_minor });
        purchase = { id: created.membershipOrderId as string, status: "DRAFT", contract_id: null };
      }
      if (purchase.status === "DRAFT") {
        const payment = await owner.selectFrom("membership_payment_facts").select("fact_id")
          .where("membership_order_id", "=", purchase.id).executeTakeFirst();
        if (!payment) await command("RECORD_MEMBERSHIP_PAYMENT", { membershipOrderId: purchase.id,
          amountMinor: 1000, transactionReference: "SYNTHETIC-STEP96-RESERVATION-DELETE" });
        await command("ACTIVATE_MEMBERSHIP_ORDER", { membershipOrderId: purchase.id });
      }
      const active = await owner.selectFrom("membership_orders").select("contract_id").where("id", "=", purchase.id).executeTakeFirstOrThrow();
      const arrivalDate = shiftDate(1);
      const departureDate = shiftDate(3);
      const quote = await createQuoteForTesting(owner, { propertyId: demo.propertyId,
        inventoryUnitId: "unit_room_205", arrivalDate, departureDate,
        pricingPolicyVersionId: demo.publicPricingPolicyId, memberContractId: active.contract_id! });
      const created = await command("CREATE_ORDER", { quoteId: quote.quoteId,
        primaryGuest: { fullName: "先取消预订再删除验收", nickname: "先取消预订再删除验收", phone: "19900009613" } });
      process.stdout.write(`待取消预订: /orders/${created.orderId} (205, ${arrivalDate} 至 ${departureDate})\n`);
    }
    const paidLabel = "付费提前退房回退验收";
    const existingPaid = await owner.selectFrom("orders").select("id")
      .where(sql<boolean>`primary_guest_snapshot ->> 'nickname' = ${paidLabel}`).executeTakeFirst();
    if (existingPaid) {
      process.stdout.write(`${paidLabel}: /orders/${existingPaid.id}\n`);
    } else {
      const quote = await createQuoteForTesting(owner, { propertyId: demo.propertyId, inventoryUnitId: "unit_room_102",
        arrivalDate: shiftDate(-2), departureDate: shiftDate(4), pricingPolicyVersionId: demo.publicPricingPolicyId });
      const created = await command("CREATE_ORDER", { quoteId: quote.quoteId,
        primaryGuest: { fullName: paidLabel, nickname: paidLabel }, bookingChannelCode: "WECOM", channelOrderReference: null,
        targetCurrentContractAmountMinor: 60000, manualPriceAdjustmentReason: "合成验收协议价六晚600元",
        backfill: true, backfillReason: "补录合成验收住宿" });
      const orderId = created.orderId as string;
      await command("RECORD_COLLECTION", { orderId, amountMinor: 60000, method: "CASH", note: "合成验收收款600元，不涉及真实资金" });
      await command("SHORTEN_STAY", { orderId, newDepartureDate: today });
      process.stdout.write(`${paidLabel}: /orders/${orderId} (102, 恢复原房费600元，已收600元)\n`);
    }
    const username = "accept96_staff";
    const existingStaff = await owner.selectFrom("subjects").select("id").where("username", "=", username).executeTakeFirst();
    if (!existingStaff) {
      const created = await app.inject({ method: "POST", url: "/api/v1/account-management", cookies,
        payload: { propertyId: demo.propertyId, requestId: crypto.randomUUID(), action: "CREATE_STAFF",
          username, displayName: "合并验收员工", newPassword: "demo-pass-2026", confirmation: true, reason: "合并人工验收专用员工" } });
      if (created.statusCode !== 200) throw new Error(created.body);
      const staffLogin = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password: "demo-pass-2026" } });
      if (staffLogin.statusCode !== 200) throw new Error("Acceptance staff login failed");
      const staffSession = staffLogin.cookies.find((cookie) => cookie.name === "qintopia_session")!.value;
      await app.inject({ method: "POST", url: "/api/v1/auth/logout", cookies: { qintopia_session: staffSession } });
    }
    process.stdout.write(`员工管理及自助改密: ${username}\n`);
    await app.inject({ method: "POST", url: "/api/v1/auth/logout", cookies });
  } finally { await app.close(); await owner.destroy(); }
}

void main().catch((error: unknown) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });

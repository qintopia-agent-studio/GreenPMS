import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";
import type { Static } from "@sinclair/typebox";
import type { CommandType } from "@qintopia/contracts";
import { createDatabase, type Database } from "@qintopia/db";
import { buildServer } from "../../apps/api/src/server.ts";
import type { MemberResponseSchema } from "../../apps/api/src/schemas.ts";
import { withPropertyClockForTesting } from "../../packages/db/src/members.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { createBusinessApi } from "../helpers/business-api.ts";
import { resetTestDatabase, testDatabaseUrl } from "../helpers/database.ts";
import { runtimeDatabaseUrlForTesting } from "../helpers/runtime-database.ts";

// These journeys exercise the public Token API and its serialized response,
// using the accepted 2A/2B/2C and empty-membership cancellation rules.
let db: Kysely<Database>;
let app: FastifyInstance;
let api: ReturnType<typeof createBusinessApi>;
const productId = "membership_product_shared_bath_single_v1";
const clock = <T>(day: string, run: () => Promise<T>) =>
  withPropertyClockForTesting(new Date(`${day}T04:00:00Z`), run);
type MemberView = Static<typeof MemberResponseSchema>;

async function membershipState() {
  return Promise.all([
    db.selectFrom("members").selectAll().orderBy("id").execute(),
    db.selectFrom("member_property_links").selectAll().orderBy("member_id").orderBy("property_id").execute(),
    db.selectFrom("membership_orders").selectAll().orderBy("id").execute(),
    db.selectFrom("membership_payment_facts").selectAll().orderBy("fact_id").execute(),
    db.selectFrom("member_contracts").selectAll().orderBy("id").execute(),
    db.selectFrom("entitlement_lots").selectAll().orderBy("id").execute(),
    db.selectFrom("entitlement_ledger").selectAll().orderBy("fact_id").execute()
  ]);
}

const memberView = (memberId: string) => api.get<MemberView>(`/api/v1/members/${memberId}?propertyId=${demo.propertyId}`);
const execute = (commandType: CommandType, input: Record<string, unknown>, key: string) =>
  api.execute(commandType, input, key, { snapshot: membershipState });

async function createMember(key: string) {
  const receipt = await execute("CREATE_MEMBER", {
    fullName: "会员接口合成客人", nickname: key, identityCardNumber: `SYNTHETIC-${key.toUpperCase()}`,
    phone: "13900009901", wechat: `synthetic-${key}`
  }, `${key}-member`);
  const memberId = receipt.result!.memberId as string;
  expect(receipt.result).toMatchObject({ memberId, memberCreated: true });
  expect(await memberView(memberId)).toMatchObject({
    member: { id: memberId, nickname: key }, contracts: [], lots: [], ledger: [], membershipOrders: [],
    availableBalance: { ROOM_NIGHT: 0, BED_NIGHT: 0 }
  });
  return memberId;
}

async function createMembershipOrder(memberId: string, key: string) {
  const receipt = await execute("CREATE_MEMBERSHIP_ORDER", {
    memberId, membershipProductId: productId, agreedPriceMinor: 162000
  }, key);
  const membershipOrderId = receipt.result!.membershipOrderId as string;
  expect((await memberView(memberId)).membershipOrders.find(item => item.order.id === membershipOrderId))
    .toMatchObject({ order: { status: "DRAFT", agreed_price_minor: 162000 }, paymentFacts: [], paymentTotalMinor: 0 });
  return membershipOrderId;
}

async function rejectedPreview(commandType: CommandType, input: Record<string, unknown>, key: string, status: number, code: string) {
  const before = await membershipState();
  const response = await app.inject({ method: "POST", url: "/api/v1/command-previews",
    headers: { ...api.headers, "idempotency-key": key, "x-correlation-id": key },
    payload: { commandType, input: { propertyId: demo.propertyId, ...input } } });
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json()).toMatchObject({ code });
  expect(await membershipState()).toEqual(before);
}

beforeEach(async () => {
  db = await resetTestDatabase();
  app = await buildServer(createDatabase(runtimeDatabaseUrlForTesting(testDatabaseUrl)));
  await app.ready();
  api = createBusinessApi(app);
});
afterEach(async () => { await app?.close(); await db?.destroy(); });

describe("daily membership operations through the public API", () => {
  it("creates a member, corrects payments append-only, activates once, and corrects the available balance", async () => {
    await clock("2026-11-06", async () => {
      const memberId = await createMember("daily-member");
      const membershipOrderId = await createMembershipOrder(memberId, "daily-membership-order");
      await rejectedPreview("ACTIVATE_MEMBERSHIP_ORDER", { membershipOrderId }, "empty-activation", 400, "VALIDATION_ERROR");
      const payment = await execute("RECORD_MEMBERSHIP_PAYMENT", {
        membershipOrderId, amountMinor: 100000, transactionReference: "SYNTHETIC-MEMBER-PAYMENT"
      }, "daily-membership-payment");
      const originalPaymentFactId = payment.result!.paymentFactId as string;
      await execute("CORRECT_MEMBERSHIP_PAYMENT", {
        membershipOrderId, originalPaymentFactId, correctedAmountMinor: 150000,
        correctedTransactionReference: "SYNTHETIC-MEMBER-CORRECTED", note: "同事已确认原登记金额有误"
      }, "daily-membership-payment-correction");
      const corrected = (await memberView(memberId)).membershipOrders.find(item => item.order.id === membershipOrderId)!;
      expect(corrected).toMatchObject({ paymentTotalMinor: 150000, paymentDifferenceMinor: -12000 });
      expect(corrected.paymentFacts).toHaveLength(3);
      expect(corrected.paymentFacts).toEqual(expect.arrayContaining([
        expect.objectContaining({ fact_id: originalPaymentFactId, fact_type: "COLLECTION", amount_minor: 100000 }),
        expect.objectContaining({ fact_type: "REVERSAL", net_effect_minor: -100000, reverses_fact_id: originalPaymentFactId }),
        expect.objectContaining({ fact_type: "COLLECTION", amount_minor: 150000, corrects_fact_id: originalPaymentFactId })
      ]));
      await rejectedPreview("CORRECT_MEMBERSHIP_PAYMENT", {
        membershipOrderId, originalPaymentFactId, correctedAmountMinor: 162000,
        correctedTransactionReference: "SYNTHETIC-MEMBER-DOUBLE-CORRECTION"
      }, "already-corrected-payment", 409, "FACT_ALREADY_REVERSED");

      // The confirmed business rule permits activation despite a payment difference.
      const activation = await execute("ACTIVATE_MEMBERSHIP_ORDER", { membershipOrderId }, "daily-membership-activation");
      expect(activation.result).toMatchObject({ membershipOrderId, status: "ACTIVE", entitlementUnits: 30,
        validFrom: "2026-11-06", validUntil: "2027-11-06" });
      const active = await memberView(memberId);
      expect(active.contracts).toHaveLength(1);
      expect(active.lots).toHaveLength(1);
      expect(active.availableBalance).toEqual({ ROOM_NIGHT: 30, BED_NIGHT: 0 });
      const entitlementLotId = activation.result!.entitlementLotId as string;
      const correction = await execute("CORRECT_MEMBER_ENTITLEMENT_BALANCE", {
        entitlementLotId, expectedAvailableBalance: 30, targetAvailableBalance: 27,
        adjustmentReason: "同事已核实历史余额应为 27 间夜"
      }, "daily-member-balance");
      expect(correction.result).toMatchObject({ entitlementLotId, availableBefore: 30, availableAfter: 27, quantityDelta: -3 });
      const updated = await memberView(memberId);
      expect(updated.availableBalance).toEqual({ ROOM_NIGHT: 27, BED_NIGHT: 0 });
      expect(updated.lots[0]!.total_units).toBe(30);
      expect(updated.ledger).toEqual([expect.objectContaining({ entry_type: "ADJUST", quantity_delta: -3 })]);
      await rejectedPreview("CORRECT_MEMBER_ENTITLEMENT_BALANCE", {
        entitlementLotId, expectedAvailableBalance: 30, targetAvailableBalance: 25, adjustmentReason: "旧余额不能覆盖新余额"
      }, "stale-balance", 409, "AGGREGATE_VERSION_CONFLICT");
    });
  });

  it("cancels only empty membership orders and rejects a cancellation made stale by payment", async () => {
    await clock("2026-11-06", async () => {
      const memberId = await createMember("daily-cancel");
      const emptyOrderId = await createMembershipOrder(memberId, "empty-membership");
      await execute("CANCEL_MEMBERSHIP_ORDER", { membershipOrderId: emptyOrderId, reason: "重复建单，经同事确认取消" }, "cancel-empty-membership");
      expect((await memberView(memberId)).membershipOrders.find(item => item.order.id === emptyOrderId))
        .toMatchObject({ order: { status: "VOIDED" }, cancellation: { reason: "重复建单，经同事确认取消" } });

      const paidOrderId = await createMembershipOrder(memberId, "soon-paid-membership");
      const prepared = await api.preview("CANCEL_MEMBERSHIP_ORDER", { membershipOrderId: paidOrderId, reason: "已确认待取消" }, "stale-cancel-preview");
      await execute("RECORD_MEMBERSHIP_PAYMENT", { membershipOrderId: paidOrderId, amountMinor: 100000,
        transactionReference: "SYNTHETIC-CANCEL-PAYMENT" }, "payment-before-cancel");
      const before = await membershipState();
      const receipt = await api.confirm(prepared.preview, "stale-cancel-confirm", undefined, 409);
      expect(receipt).toMatchObject({ commandType: "CANCEL_MEMBERSHIP_ORDER", executionStatus: "NOT_EXECUTED",
        businessCommitted: false, error: { code: "PREVIEW_STALE" } });
      expect(await membershipState()).toEqual(before);
      expect((await memberView(memberId)).membershipOrders.find(item => item.order.id === paidOrderId))
        .toMatchObject({ order: { status: "DRAFT" }, cancellation: null, paymentTotalMinor: 100000 });
      await rejectedPreview("CANCEL_MEMBERSHIP_ORDER", { membershipOrderId: paidOrderId, reason: "不允许取消已收款单" },
        "cancel-paid-membership", 409, "AGGREGATE_VERSION_CONFLICT");
    });
  });

  it("requires Token write permission even after a valid membership preview exists", async () => {
    const memberId = await createMember("daily-read-only");
    const prepared = await api.preview("CREATE_MEMBERSHIP_ORDER", {
      memberId, membershipProductId: productId, agreedPriceMinor: 162000
    }, "read-only-membership-preview");
    const before = await membershipState();
    const response = await app.inject({ method: "POST", url: `/api/v1/command-previews/${prepared.preview.previewId}/confirm`,
      headers: { authorization: `Bearer ${demo.readToken}`, "idempotency-key": "read-only-membership-confirm", "x-correlation-id": "read-only-membership" },
      payload: { propertyId: demo.propertyId, commandType: "CREATE_MEMBERSHIP_ORDER", confirmation: true,
        expectedEffectHash: prepared.preview.effectHash, reason: { code: "CREATE_MEMBERSHIP_ORDER", note: "只读身份不能办理" } } });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json()).toMatchObject({ code: "INSUFFICIENT_ACCESS" });
    expect(await membershipState()).toEqual(before);
  });

  it("converts a completed stay collection into membership without duplicating money or entitlements", async () => {
    const memberId = await createMember("daily-conversion");
    const orderId = await clock("2026-11-01", async () => {
      const quoteResponse = await app.inject({ method: "POST", url: "/api/v1/quotes",
        headers: { ...api.headers, "idempotency-key": "conversion-quote", "x-correlation-id": "conversion" },
        payload: { propertyId: demo.propertyId, inventoryUnitId: "unit_room_d_gen_01", stayType: "TRANSIENT",
          arrivalDate: "2026-11-01", departureDate: "2026-11-03", pricingPolicyVersionId: demo.publicPricingPolicyId } });
      expect(quoteResponse.statusCode, quoteResponse.body).toBe(200);
      expect(quoteResponse.json().receipt.commandType).toBe("CREATE_QUOTE");
      const created = await api.execute("CREATE_ORDER", { quoteId: quoteResponse.json().quote.quoteId,
        primaryGuest: { fullName: "会员接口合成客人", nickname: "daily-conversion", phone: "13900009901", documentNumber: "SYNTHETIC-DAILY-CONVERSION" },
        bookingChannelCode: "WECOM", targetCurrentContractAmountMinor: quoteResponse.json().quote.currentContractAmount.minorUnits
      }, "conversion-stay", { snapshot: async () => db.selectFrom("orders").selectAll().orderBy("id").execute() });
      const createdOrderId = created.result!.orderId as string;
      await api.execute("CHECK_IN", { orderId: createdOrderId }, "conversion-checkin", {
        snapshot: () => api.get(`/api/v1/orders/${createdOrderId}`)
      });
      return createdOrderId;
    });
    await clock("2026-11-03", async () => {
      const orderSnapshot = () => api.get(`/api/v1/orders/${orderId}`);
      await api.execute("CHECK_OUT", { orderId }, "conversion-checkout", { snapshot: orderSnapshot });
      const collection = await api.execute("RECORD_COLLECTION", { orderId, amountMinor: 59000, method: "WECOM",
        transactionReference: "SYNTHETIC-CONVERSION-SOURCE", note: "同事确认住宿款转会员" }, "conversion-collection", { snapshot: orderSnapshot });
      const collectionFactId = collection.result!.factId as string;
      const converted = await api.execute("CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP", { orderId, memberId,
        membershipProductId: productId, collectionFactIds: [collectionFactId], agreedPriceMinor: 162000,
        remainingPaymentTransactionReference: "SYNTHETIC-CONVERSION-REMAINDER"
      }, "daily-convert-membership", { snapshot: async () => ({ membership: await membershipState(), order: await orderSnapshot() }) });
      expect(converted.result).toMatchObject({ status: "ACTIVE", orderId, transferredCollectionFactIds: [collectionFactId],
        transferredAmount: { currency: "CNY", minorUnits: 59000 }, remainingPaymentAmount: { currency: "CNY", minorUnits: 103000 },
        conversionMode: "COMPLETED", convertedUnits: 2, remainingUnits: 28 });
      const member = await memberView(memberId);
      expect(member.membershipOrders).toHaveLength(1);
      expect(member.contracts).toHaveLength(1);
      expect(member.lots).toHaveLength(1);
      expect(member.availableBalance).toEqual({ ROOM_NIGHT: 28, BED_NIGHT: 0 });
      expect(member.membershipOrders[0]).toMatchObject({ order: { status: "ACTIVE" }, paymentTotalMinor: 162000 });
      expect(await orderSnapshot()).toMatchObject({ order: { status: "CHECKED_OUT" }, stay: { status: "COMPLETED" } });
      const lodgingNet = await db.selectFrom("collection_facts")
        .select(sql<number>`coalesce(sum(net_effect_minor), 0)::integer`.as("net"))
        .where("order_id", "=", orderId).executeTakeFirstOrThrow();
      expect(lodgingNet.net).toBe(0);
      expect(await db.selectFrom("amendments").select("id").where("order_id", "=", orderId)
        .where("amendment_type", "=", "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP").execute()).toHaveLength(1);
    });
  });
});

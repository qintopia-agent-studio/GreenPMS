import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthPrincipal, CommandEnvelope, ReceiptDto } from "@qintopia/contracts";
import { confirmCommandPreview, createCommandPreview, getMemberView, propertyLocalToday, type Database } from "@qintopia/db";
import type { Kysely } from "kysely";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { resetDatabase } from "../helpers/database.ts";

const databaseUrl = process.env.MEMBER_STAYS_STEP2C_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_member_stays_step2c";

const principal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Demo Agent",
  propertyAccess: new Map([[demo.propertyId, "WRITE"]])
};

const products = {
  sharedSingle: "membership_product_shared_bath_single_v1",
  privateSingle: "membership_product_private_bath_single_v1",
  sharedQuad: "membership_product_shared_bath_quad_v1"
} as const;

let db: Kysely<Database>;
let sequence = 0;

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function metadata(prefix: string) {
  sequence += 1;
  return { idempotencyKey: `${prefix}-${sequence}`, correlationId: `${prefix}-${sequence}` };
}

async function preview(envelope: CommandEnvelope, prefix: string) {
  return createCommandPreview(db, principal, envelope, metadata(`${prefix}-preview`));
}

async function confirm(envelope: CommandEnvelope, prefix: string): Promise<ReceiptDto> {
  const prepared = await preview(envelope, prefix);
  return confirmCommandPreview(db, principal, prepared.preview.previewId, {
    propertyId: demo.propertyId,
    commandType: envelope.commandType,
    confirmation: true,
    expectedEffectHash: prepared.preview.effectHash,
    reason: envelope.commandType === "CREATE_ORDER"
      ? { code: "CREATE_STANDARD_ORDER", note: "" }
      : { code: "STEP_2C_ACCEPTANCE", note: `确认 ${prefix}` }
  }, metadata(`${prefix}-confirm`));
}

async function createMember(memberId: string) {
  await db.insertInto("members").values({
    id: memberId,
    identity_card_number: `STEP2C-${memberId.toUpperCase()}`,
    full_name: `2C ${memberId}`,
    phone: `139${String(sequence).padStart(8, "0")}`,
    wechat: `wx-${memberId}`
  }).execute();
  await db.insertInto("member_property_links").values({ member_id: memberId, property_id: demo.propertyId }).execute();
}

async function activateProduct(memberId: string, productId: string, prefix: string) {
  const order = await confirm({
    commandType: "CREATE_MEMBERSHIP_ORDER",
    input: { propertyId: demo.propertyId, memberId, membershipProductId: productId, agreedPriceMinor: productId === products.sharedQuad ? 93_600 : productId === products.privateSingle ? 216_000 : 162_000 }
  }, `${prefix}-order`);
  const membershipOrderId = order.result!.membershipOrderId as string;
  await confirm({
    commandType: "RECORD_MEMBERSHIP_PAYMENT",
    input: { propertyId: demo.propertyId, membershipOrderId, amountMinor: 1, transactionReference: `WX-${prefix}` }
  }, `${prefix}-payment`);
  const activation = await confirm({
    commandType: "ACTIVATE_MEMBERSHIP_ORDER",
    input: { propertyId: demo.propertyId, membershipOrderId }
  }, `${prefix}-activation`);
  return {
    membershipOrderId,
    contractId: activation.result!.contractId as string,
    lotId: activation.result!.entitlementLotId as string
  };
}

async function unitId(code: string) {
  return (await db.selectFrom("inventory_units").select("id").where("property_id", "=", demo.propertyId).where("code", "=", code).executeTakeFirstOrThrow()).id;
}

async function memberQuote(memberId: string, inventoryUnitId: string, arrivalDate: string, departureDate: string) {
  return createQuoteForTesting(db, {
    propertyId: demo.propertyId,
    inventoryUnitId,
    arrivalDate,
    departureDate,
    pricingPolicyVersionId: demo.publicPricingPolicyId,
    memberId
  });
}

async function createStay(quoteId: string, prefix: string) {
  return confirm({
    commandType: "CREATE_ORDER",
    input: {
      propertyId: demo.propertyId,
      quoteId,
      primaryGuest: { fullName: `住客 ${prefix}`, nickname: `住客 ${prefix}` }
    }
  }, `${prefix}-stay`);
}

beforeEach(async () => {
  db = await resetDatabase(databaseUrl);
});

afterEach(async () => {
  await db.destroy();
});

describe("step 2C member balances and stays", () => {
  it("seeds only formally classified demo entitlements", async () => {
    const view = await getMemberView(db, demo.propertyId, demo.memberId);
    const membership = view.membershipOrders.find(({ order }) => order.id === demo.membershipOrderId);

    expect(view.lots.map((lot) => lot.id)).toEqual([demo.roomLotId]);
    expect(view.availableBalance).toEqual({ ROOM_NIGHT: 2, BED_NIGHT: 0 });
    expect(view.membershipOrders.map(({ order }) => order.entitlement_lot_id)).toEqual([demo.roomLotId]);
    expect(membership).toMatchObject({
      order: { status: "ACTIVE", agreed_price_minor: 162_000 },
      paymentTotalMinor: 162_000,
      paymentDifferenceMinor: 0
    });
    expect(membership?.paymentFacts).toEqual([
      expect.objectContaining({
        fact_type: "COLLECTION",
        amount_minor: 162_000,
        net_effect_minor: 162_000,
        transaction_reference: "DEMO-WECOM-20260101-001"
      })
    ]);
  });

  it("derives the displayed balance from Lot/Ledger and corrects to a target balance by appending ADJUST", async () => {
    const memberId = "member_step2c_balance";
    await createMember(memberId);
    const membership = await activateProduct(memberId, products.sharedSingle, "balance");
    expect((await getMemberView(db, demo.propertyId, memberId)).availableBalance).toEqual({ ROOM_NIGHT: 30, BED_NIGHT: 0 });

    const envelope: CommandEnvelope = {
      commandType: "CORRECT_MEMBER_ENTITLEMENT_BALANCE",
      input: {
        propertyId: demo.propertyId,
        entitlementLotId: membership.lotId,
        expectedAvailableBalance: 30,
        targetAvailableBalance: 7,
        adjustmentReason: "人工验收把可住宿余额更正为 7 间夜"
      }
    };
    const prepared = await preview(envelope, "target-balance");
    expect(prepared.preview.effect).toMatchObject({ availableBefore: 30, availableAfter: 7, quantityDelta: -23 });
    const receipt = await confirmCommandPreview(db, principal, prepared.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: envelope.commandType,
      confirmation: true,
      expectedEffectHash: prepared.preview.effectHash,
      reason: { code: "STEP_2C_BALANCE", note: "确认目标余额" }
    }, metadata("target-balance-confirm"));
    expect(receipt).toMatchObject({ businessCommitted: true, result: { availableBefore: 30, availableAfter: 7, quantityDelta: -23 } });

    const view = await getMemberView(db, demo.propertyId, memberId);
    expect(view.availableBalance.ROOM_NIGHT).toBe(7);
    expect(view.ledger).toEqual(expect.arrayContaining([
      expect.objectContaining({ lot_id: membership.lotId, entry_type: "ADJUST", quantity_delta: -23, reason: "人工验收把可住宿余额更正为 7 间夜" })
    ]));
    await expect(preview({
      ...envelope,
      input: { ...envelope.input, expectedAvailableBalance: 30, targetAvailableBalance: 5 }
    }, "stale-target-balance")).rejects.toMatchObject({ code: "AGGREGATE_VERSION_CONFLICT" });
  });

  it("enforces all three product mappings and rejects whole-room or mismatched inventory with zero writes", async () => {
    const today = await propertyLocalToday(db, demo.propertyId);
    const arrival = shiftDate(today, 5);
    const departure = shiftDate(today, 7);
    const sharedMember = "member_step2c_shared";
    const privateMember = "member_step2c_private";
    const quadMember = "member_step2c_quad";
    await createMember(sharedMember);
    await createMember(privateMember);
    await createMember(quadMember);
    await activateProduct(sharedMember, products.sharedSingle, "shared");
    await activateProduct(privateMember, products.privateSingle, "private");
    await activateProduct(quadMember, products.sharedQuad, "quad");
    const d01 = await unitId("D01");
    const b01 = await unitId("B01");
    const bed101a = await unitId("101-A");
    const room101 = await unitId("101");

    expect((await memberQuote(sharedMember, d01, arrival, departure)).coverageSet).toHaveLength(2);
    expect((await memberQuote(privateMember, b01, arrival, departure)).coverageSet).toHaveLength(2);
    expect((await memberQuote(quadMember, bed101a, arrival, departure)).coverageSet).toHaveLength(2);
    const quoteCount = await db.selectFrom("quotes").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow();
    const ledgerCount = await db.selectFrom("entitlement_ledger").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow();
    await expect(memberQuote(sharedMember, b01, arrival, departure)).rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    await expect(memberQuote(quadMember, room101, arrival, departure)).rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    expect(Number((await db.selectFrom("quotes").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow()).count)).toBe(Number(quoteCount.count));
    expect(Number((await db.selectFrom("entitlement_ledger").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow()).count)).toBe(Number(ledgerCount.count));
  });

  it("prices partial and zero coverage with daily P1 cash, and fails closed on two usable matching Lots", async () => {
    const today = await propertyLocalToday(db, demo.propertyId);
    const arrival = shiftDate(today, 10);
    const memberId = "member_step2c_partial";
    await createMember(memberId);
    const membership = await activateProduct(memberId, products.sharedSingle, "partial");
    await confirm({
      commandType: "CORRECT_MEMBER_ENTITLEMENT_BALANCE",
      input: { propertyId: demo.propertyId, entitlementLotId: membership.lotId, expectedAvailableBalance: 30, targetAvailableBalance: 2, adjustmentReason: "部分覆盖测试" }
    }, "partial-balance");
    const d01 = await unitId("D01");
    const partial = await memberQuote(memberId, d01, arrival, shiftDate(arrival, 4));
    expect(partial.coverageSet.map((item) => item.serviceDate)).toEqual([arrival, shiftDate(arrival, 1)]);
    expect(partial.cashLines).toHaveLength(2);
    expect(partial.cashRemainder.minorUnits).toBe(26_000);

    await confirm({
      commandType: "CORRECT_MEMBER_ENTITLEMENT_BALANCE",
      input: { propertyId: demo.propertyId, entitlementLotId: membership.lotId, expectedAvailableBalance: 2, targetAvailableBalance: 0, adjustmentReason: "零余额测试" }
    }, "zero-balance");
    const zero = await memberQuote(memberId, d01, arrival, shiftDate(arrival, 3));
    expect(zero.coverageSet).toEqual([]);
    expect(zero.cashLines).toHaveLength(3);
    expect(zero.cashRemainder.minorUnits).toBe(39_000);
    expect(zero.memberId).toBe(memberId);

    await activateProduct(memberId, products.sharedSingle, "ambiguous-a");
    await activateProduct(memberId, products.sharedSingle, "ambiguous-b");
    await expect(memberQuote(memberId, d01, arrival, shiftDate(arrival, 2))).rejects.toMatchObject({
      code: "ENTITLEMENT_CONFLICT",
      message: expect.stringContaining("多份权益")
    });
  });

  it("rejects a booking channel on member stays without writing an order, coverage, or ledger entry", async () => {
    const today = await propertyLocalToday(db, demo.propertyId);
    const memberId = "member_step2c_channel_guard";
    await createMember(memberId);
    await activateProduct(memberId, products.sharedSingle, "channel-guard");
    const quote = await memberQuote(memberId, await unitId("D01"), shiftDate(today, 15), shiftDate(today, 17));
    const countsBefore = await Promise.all([
      db.selectFrom("orders").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      db.selectFrom("coverage_items").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      db.selectFrom("entitlement_ledger").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow()
    ]);

    await expect(preview({
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: quote.quoteId,
        primaryGuest: { fullName: "会员渠道绕过测试", nickname: "渠道绕过" },
        bookingChannelCode: "WECOM"
      }
    }, "member-channel-rejected")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "会员住宿不应填写订单来源渠道或渠道订单号"
    });

    const countsAfter = await Promise.all([
      db.selectFrom("orders").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      db.selectFrom("coverage_items").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      db.selectFrom("entitlement_ledger").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow()
    ]);
    expect(countsAfter.map(({ count }) => Number(count))).toEqual(countsBefore.map(({ count }) => Number(count)));
  });

  it("holds on reservation, consumes on check-in, and releases only HELD coverage before arrival", async () => {
    const today = await propertyLocalToday(db, demo.propertyId);
    const checkedInArrival = today;
    const checkedInDeparture = shiftDate(checkedInArrival, 2);
    const cancelledArrival = shiftDate(today, 20);
    const cancelledDeparture = shiftDate(cancelledArrival, 2);
    const d01 = await unitId("D01");
    const d02 = await unitId("D02");

    const checkedInMember = "member_step2c_checked_in";
    await createMember(checkedInMember);
    const checkedInMembership = await activateProduct(checkedInMember, products.sharedSingle, "checked-in");
    const checkedInQuote = await memberQuote(checkedInMember, d01, checkedInArrival, checkedInDeparture);
    const checkedIn = await createStay(checkedInQuote.quoteId, "checked-in");
    const checkedInOrderId = checkedIn.result!.orderId as string;
    expect(await db.selectFrom("orders").select(["member_id", "booking_channel_code", "channel_order_reference"]).where("id", "=", checkedInOrderId).executeTakeFirstOrThrow()).toEqual({
      member_id: checkedInMember,
      booking_channel_code: null,
      channel_order_reference: null
    });
    expect(await db.selectFrom("coverage_items").select("status").where("order_id", "=", checkedInOrderId).execute()).toEqual([{ status: "HELD" }, { status: "HELD" }]);
    await confirm({ commandType: "CHECK_IN", input: { propertyId: demo.propertyId, orderId: checkedInOrderId } }, "check-in");
    expect(await db.selectFrom("coverage_items").select("status").where("order_id", "=", checkedInOrderId).execute()).toEqual([{ status: "CONSUMED" }, { status: "CONSUMED" }]);
    expect((await getMemberView(db, demo.propertyId, checkedInMember)).lotBalances).toContainEqual({ lotId: checkedInMembership.lotId, unitKind: "ROOM_NIGHT", availableUnits: 28 });

    const cancelledMember = "member_step2c_cancelled";
    await createMember(cancelledMember);
    const cancelledMembership = await activateProduct(cancelledMember, products.sharedSingle, "cancelled");
    const cancelledQuote = await memberQuote(cancelledMember, d02, cancelledArrival, cancelledDeparture);
    const cancelled = await createStay(cancelledQuote.quoteId, "cancelled");
    const cancelledOrderId = cancelled.result!.orderId as string;
    await confirm({ commandType: "CANCEL_ORDER", input: { propertyId: demo.propertyId, orderId: cancelledOrderId } }, "cancel-before-arrival");
    expect(await db.selectFrom("coverage_items").select("status").where("order_id", "=", cancelledOrderId).execute()).toEqual([{ status: "RELEASED" }, { status: "RELEASED" }]);
    expect((await getMemberView(db, demo.propertyId, cancelledMember)).lotBalances).toContainEqual({ lotId: cancelledMembership.lotId, unitKind: "ROOM_NIGHT", availableUnits: 30 });
  });

  it("refreshes a zero-coverage member stay from a newly activated matching membership order", async () => {
    const today = await propertyLocalToday(db, demo.propertyId);
    const arrival = shiftDate(today, 30);
    const departure = shiftDate(arrival, 2);
    const memberId = "member_step2c_refresh";
    await createMember(memberId);
    const depleted = await activateProduct(memberId, products.sharedSingle, "refresh-depleted");
    await confirm({
      commandType: "CORRECT_MEMBER_ENTITLEMENT_BALANCE",
      input: { propertyId: demo.propertyId, entitlementLotId: depleted.lotId, expectedAvailableBalance: 30, targetAvailableBalance: 0, adjustmentReason: "先建立零余额住宿" }
    }, "refresh-deplete");
    const d01 = await unitId("D01");
    const zeroQuote = await memberQuote(memberId, d01, arrival, departure);
    expect(zeroQuote.coverageSet).toEqual([]);
    const stay = await createStay(zeroQuote.quoteId, "refresh-zero");
    const orderId = stay.result!.orderId as string;
    expect((await db.selectFrom("orders").select(["member_id", "member_contract_id"]).where("id", "=", orderId).executeTakeFirstOrThrow()).member_id).toBe(memberId);

    const replenished = await activateProduct(memberId, products.sharedSingle, "refresh-replenished");
    const refreshed = await confirm({ commandType: "REFRESH_MEMBER_COVERAGE", input: { propertyId: demo.propertyId, orderId } }, "refresh-coverage");
    expect(refreshed.businessCommitted).toBe(true);
    const coverage = await db.selectFrom("coverage_items").selectAll().where("order_id", "=", orderId).orderBy("service_date").execute();
    expect(coverage).toHaveLength(2);
    expect(new Set(coverage.map((item) => item.contract_id))).toEqual(new Set([replenished.contractId]));
    expect(new Set(coverage.map((item) => item.lot_id))).toEqual(new Set([replenished.lotId]));
    expect(await db.selectFrom("entitlement_ledger").select("entry_type").where("order_id", "=", orderId).execute()).toEqual([{ entry_type: "HOLD" }, { entry_type: "HOLD" }]);
    expect(await db.selectFrom("pricing_revisions")
      .select("pricing_basis")
      .where("order_id", "=", orderId)
      .orderBy("revision_no")
      .execute()).toEqual([
      { pricing_basis: "MEMBER_ENTITLEMENT" },
      { pricing_basis: "MEMBER_ENTITLEMENT" }
    ]);
  });

  it("serializes two stays competing for the final member night", async () => {
    const today = await propertyLocalToday(db, demo.propertyId);
    const arrival = shiftDate(today, 40);
    const departure = shiftDate(arrival, 1);
    const memberId = "member_step2c_last_night";
    await createMember(memberId);
    const membership = await activateProduct(memberId, products.sharedSingle, "last-night");
    await confirm({
      commandType: "CORRECT_MEMBER_ENTITLEMENT_BALANCE",
      input: { propertyId: demo.propertyId, entitlementLotId: membership.lotId, expectedAvailableBalance: 30, targetAvailableBalance: 1, adjustmentReason: "并发只保留最后一间夜" }
    }, "last-night-balance");
    const [d01, d02] = await Promise.all([unitId("D01"), unitId("D02")]);
    const [quoteA, quoteB] = await Promise.all([
      memberQuote(memberId, d01, arrival, departure),
      memberQuote(memberId, d02, arrival, departure)
    ]);
    const [previewA, previewB] = await Promise.all([
      preview({ commandType: "CREATE_ORDER", input: { propertyId: demo.propertyId, quoteId: quoteA.quoteId, primaryGuest: { fullName: "并发甲", nickname: "甲" } } }, "last-night-a"),
      preview({ commandType: "CREATE_ORDER", input: { propertyId: demo.propertyId, quoteId: quoteB.quoteId, primaryGuest: { fullName: "并发乙", nickname: "乙" } } }, "last-night-b")
    ]);
    const confirmation = (prepared: Awaited<ReturnType<typeof preview>>, label: string) => confirmCommandPreview(db, principal, prepared.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "CREATE_ORDER",
      confirmation: true,
      expectedEffectHash: prepared.preview.effectHash,
      reason: { code: "CREATE_STANDARD_ORDER", note: "" }
    }, metadata(`${label}-confirm`));
    const results = await Promise.all([confirmation(previewA, "last-night-a"), confirmation(previewB, "last-night-b")]);
    expect(results.filter((result) => result.businessCommitted)).toHaveLength(1);
    expect(results.filter((result) => !result.businessCommitted)).toEqual([
      expect.objectContaining({ executionStatus: "NOT_EXECUTED", error: expect.objectContaining({ code: "PREVIEW_STALE" }) })
    ]);
    expect(await db.selectFrom("coverage_items").select("id").execute()).toHaveLength(1);
    expect(await db.selectFrom("entitlement_ledger").select("fact_id").where("lot_id", "=", membership.lotId).where("entry_type", "=", "HOLD").execute()).toHaveLength(1);
    expect((await getMemberView(db, demo.propertyId, memberId)).lotBalances).toContainEqual({ lotId: membership.lotId, unitKind: "ROOM_NIGHT", availableUnits: 0 });
  });
});

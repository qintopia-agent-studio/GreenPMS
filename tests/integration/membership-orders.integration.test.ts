import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthPrincipal, CommandEnvelope } from "@qintopia/contracts";
import {
  confirmCommandPreview,
  createCommandPreview,
  getMemberView,
  propertyLocalToday,
  withPropertyClockForTesting,
  type Database
} from "@qintopia/db";
import { parseLocalDate } from "@qintopia/domain";
import type { Kysely } from "kysely";
import { demo } from "../../packages/db/src/seed.ts";
import { authScope } from "../helpers/auth-principals.ts";
import { resetDatabase } from "../helpers/database.ts";

const databaseUrl = process.env.MEMBERSHIP_ORDERS_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_membership_orders";

const principal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Demo Agent",
  ...authScope()
};

const products = {
  sharedSingle: "membership_product_shared_bath_single_v1",
  privateSingle: "membership_product_private_bath_single_v1",
  sharedQuad: "membership_product_shared_bath_quad_v1"
} as const;

let db: Kysely<Database>;
let sequence = 0;
const memberId = "member_membership_orders_test";

function metadata(prefix: string) {
  sequence += 1;
  return { idempotencyKey: `${prefix}-${sequence}`, correlationId: `${prefix}-${sequence}` };
}

async function preview(envelope: CommandEnvelope, prefix: string) {
  return createCommandPreview(db, principal, envelope, metadata(`${prefix}-preview`));
}

async function confirm(envelope: CommandEnvelope, prefix: string) {
  const prepared = await preview(envelope, prefix);
  return confirmCommandPreview(db, principal, prepared.preview.previewId, {
    propertyId: demo.propertyId,
    commandType: envelope.commandType,
    confirmation: true,
    expectedEffectHash: prepared.preview.effectHash,
    reason: { code: envelope.commandType, note: `确认 ${prefix}` }
  }, metadata(`${prefix}-confirm`));
}

async function createMembershipOrder(productId: string = products.sharedSingle, agreedPriceMinor = 162000, reason?: string) {
  const receipt = await confirm({
    commandType: "CREATE_MEMBERSHIP_ORDER",
    input: {
      propertyId: demo.propertyId,
      memberId,
      membershipProductId: productId,
      agreedPriceMinor,
      ...(reason ? { priceAdjustmentReason: reason } : {})
    }
  }, "create-membership-order");
  return receipt.result!.membershipOrderId as string;
}

async function recordPayment(membershipOrderId: string, amountMinor: number, transactionReference: string) {
  return confirm({
    commandType: "RECORD_MEMBERSHIP_PAYMENT",
    input: { propertyId: demo.propertyId, membershipOrderId, amountMinor, transactionReference }
  }, `record-${transactionReference}`);
}

function addCalendarYear(localDate: string): string {
  const date = parseLocalDate(localDate);
  const nextYear = date.getUTCFullYear() + 1;
  const month = date.getUTCMonth();
  const lastDay = new Date(Date.UTC(nextYear, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(nextYear, month, Math.min(date.getUTCDate(), lastDay))).toISOString().slice(0, 10);
}

beforeEach(async () => {
  db = await resetDatabase(databaseUrl);
  await db.insertInto("members").values({
    id: memberId,
    identity_card_number: "MEMBERSHIP-ORDERS-TEST",
    nickname: "会员订单测试",
    full_name: "会员订单测试",
    phone: "13900009991",
    wechat: "membership-orders-test"
  }).execute();
  await db.insertInto("member_property_links").values({
    member_id: memberId,
    property_id: demo.propertyId
  }).execute();
});

afterEach(async () => {
  await db.destroy();
});

describe("2B membership orders and WeCom collections", () => {
  it("seeds the three fixed products and requires a reason only when the agreed price changes", async () => {
    const catalog = await db.selectFrom("membership_products").selectAll().orderBy("list_price_minor").execute();
    expect(catalog.map((product) => ({
      id: product.id,
      price: product.list_price_minor,
      unit: product.entitlement_unit_kind,
      units: product.entitlement_units,
      inventoryKind: product.allowed_inventory_kind
    }))).toEqual([
      { id: products.sharedQuad, price: 93600, unit: "BED_NIGHT", units: 30, inventoryKind: "BED" },
      { id: products.sharedSingle, price: 162000, unit: "ROOM_NIGHT", units: 30, inventoryKind: "ROOM" },
      { id: products.privateSingle, price: 216000, unit: "ROOM_NIGHT", units: 30, inventoryKind: "ROOM" }
    ]);

    await expect(preview({
      commandType: "CREATE_MEMBERSHIP_ORDER",
      input: { propertyId: demo.propertyId, memberId: demo.memberId, membershipProductId: products.sharedSingle, agreedPriceMinor: 150000 }
    }, "missing-adjustment-reason")).rejects.toThrow("修改会员成交价时必须填写调价原因");

    const orderId = await createMembershipOrder(products.sharedSingle, 150000, "人工确认优惠价");
    const order = await db.selectFrom("membership_orders").selectAll().where("id", "=", orderId).executeTakeFirstOrThrow();
    expect(order).toMatchObject({
      status: "DRAFT",
      listed_price_minor: 162000,
      agreed_price_minor: 150000,
      price_adjustment_minor: -12000,
      price_adjustment_reason: "人工确认优惠价",
      entitlement_units: 30,
      entitlement_unit_kind: "ROOM_NIGHT"
    });
  });

  it("rejects activation without payment and activates a mismatched multi-payment order exactly once", async () => {
    const orderId = await createMembershipOrder();
    await expect(preview({
      commandType: "ACTIVATE_MEMBERSHIP_ORDER",
      input: { propertyId: demo.propertyId, membershipOrderId: orderId }
    }, "activate-without-payment")).rejects.toThrow("至少登记一笔有效企微收款");
    expect(await db.selectFrom("member_contracts").select("id").where("membership_order_id", "=", orderId).execute()).toHaveLength(0);

    await recordPayment(orderId, 60000, "WX-MEMBER-001");
    await recordPayment(orderId, 50000, "WX-MEMBER-002");
    const activationEnvelope: CommandEnvelope = {
      commandType: "ACTIVATE_MEMBERSHIP_ORDER",
      input: { propertyId: demo.propertyId, membershipOrderId: orderId }
    };
    const prepared = await preview(activationEnvelope, "activate-mismatch");
    expect(prepared.preview.effect).toMatchObject({
      paymentTotal: { currency: "CNY", minorUnits: 110000 },
      agreedPrice: { currency: "CNY", minorUnits: 162000 },
      paymentDifference: { currency: "CNY", minorUnits: -52000 },
      entitlementUnits: 30
    });
    const confirmation = {
      propertyId: demo.propertyId,
      commandType: "ACTIVATE_MEMBERSHIP_ORDER" as const,
      confirmation: true,
      expectedEffectHash: prepared.preview.effectHash,
      reason: { code: "ACTIVATE_MEMBERSHIP_ORDER", note: "明确生效差额订单" }
    };
    const activationMetadata = metadata("activate-confirm");
    const first = await confirmCommandPreview(db, principal, prepared.preview.previewId, confirmation, activationMetadata);
    const replay = await confirmCommandPreview(db, principal, prepared.preview.previewId, confirmation, activationMetadata);
    expect(replay.receiptId).toBe(first.receiptId);

    const propertyToday = await propertyLocalToday(db, demo.propertyId);
    const order = await db.selectFrom("membership_orders").selectAll().where("id", "=", orderId).executeTakeFirstOrThrow();
    expect(order).toMatchObject({ status: "ACTIVE", valid_from: propertyToday, valid_until: addCalendarYear(propertyToday) });
    const contracts = await db.selectFrom("member_contracts").selectAll().where("membership_order_id", "=", orderId).execute();
    expect(contracts).toHaveLength(1);
    const lots = await db.selectFrom("entitlement_lots").selectAll().where("contract_id", "=", contracts[0]!.id).execute();
    expect(lots).toEqual([expect.objectContaining({ unit_kind: "ROOM_NIGHT", total_units: 30, expires_on: addCalendarYear(propertyToday) })]);
  });

  it("corrects a collection by appending reversal and replacement facts", async () => {
    const orderId = await createMembershipOrder(products.sharedQuad, 93600);
    const payment = await recordPayment(orderId, 90000, "WX-ORIGINAL-001");
    const originalFactId = payment.result!.paymentFactId as string;
    await confirm({
      commandType: "CORRECT_MEMBERSHIP_PAYMENT",
      input: {
        propertyId: demo.propertyId,
        membershipOrderId: orderId,
        originalPaymentFactId: originalFactId,
        correctedAmountMinor: 93600,
        correctedTransactionReference: "WX-CORRECTED-001",
        note: "修正金额和交易单号"
      }
    }, "correct-payment");

    const facts = await db.selectFrom("membership_payment_facts").selectAll().where("membership_order_id", "=", orderId).orderBy("created_at").execute();
    expect(facts).toHaveLength(3);
    expect(facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ fact_id: originalFactId, fact_type: "COLLECTION", amount_minor: 90000, transaction_reference: "WX-ORIGINAL-001" }),
      expect.objectContaining({ fact_type: "REVERSAL", amount_minor: 90000, net_effect_minor: -90000, reverses_fact_id: originalFactId }),
      expect.objectContaining({ fact_type: "COLLECTION", amount_minor: 93600, net_effect_minor: 93600, transaction_reference: "WX-CORRECTED-001", corrects_fact_id: originalFactId })
    ]));
    const view = await getMemberView(db, demo.propertyId, memberId);
    const summary = view.membershipOrders.find((candidate) => candidate.order.id === orderId)!;
    expect(summary.paymentTotalMinor).toBe(93600);
    expect(summary.paymentDifferenceMinor).toBe(0);
    await expect(preview({
      commandType: "CORRECT_MEMBERSHIP_PAYMENT",
      input: { propertyId: demo.propertyId, membershipOrderId: orderId, originalPaymentFactId: originalFactId, correctedAmountMinor: 93600, correctedTransactionReference: "WX-AGAIN" }
    }, "correct-twice")).rejects.toThrow("已经更正");
  });

  it("makes stale activation fail closed and concurrent activation creates one contract and lot", async () => {
    const orderId = await createMembershipOrder(products.privateSingle, 216000);
    await recordPayment(orderId, 100000, "WX-CONCURRENT-001");
    const envelope: CommandEnvelope = { commandType: "ACTIVATE_MEMBERSHIP_ORDER", input: { propertyId: demo.propertyId, membershipOrderId: orderId } };
    const stale = await preview(envelope, "stale-activation");
    await recordPayment(orderId, 1000, "WX-CONCURRENT-002");
    const staleReceipt = await confirmCommandPreview(db, principal, stale.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "ACTIVATE_MEMBERSHIP_ORDER",
      confirmation: true,
      expectedEffectHash: stale.preview.effectHash,
      reason: { code: "ACTIVATE_MEMBERSHIP_ORDER", note: "陈旧生效应拒绝" }
    }, metadata("stale-activation-confirm"));
    expect(staleReceipt).toMatchObject({ businessCommitted: false, executionStatus: "NOT_EXECUTED", error: { code: "PREVIEW_STALE" } });

    const first = await preview(envelope, "concurrent-activation-a");
    const second = await preview(envelope, "concurrent-activation-b");
    const results = await Promise.all([
      confirmCommandPreview(db, principal, first.preview.previewId, {
        propertyId: demo.propertyId, commandType: "ACTIVATE_MEMBERSHIP_ORDER", confirmation: true,
        expectedEffectHash: first.preview.effectHash, reason: { code: "ACTIVATE_MEMBERSHIP_ORDER", note: "并发生效 A" }
      }, metadata("concurrent-confirm-a")),
      confirmCommandPreview(db, principal, second.preview.previewId, {
        propertyId: demo.propertyId, commandType: "ACTIVATE_MEMBERSHIP_ORDER", confirmation: true,
        expectedEffectHash: second.preview.effectHash, reason: { code: "ACTIVATE_MEMBERSHIP_ORDER", note: "并发生效 B" }
      }, metadata("concurrent-confirm-b"))
    ]);
    expect(results.filter((result) => result.businessCommitted)).toHaveLength(1);
    expect(results.filter((result) => !result.businessCommitted)).toEqual([
      expect.objectContaining({ executionStatus: "NOT_EXECUTED", error: expect.objectContaining({ code: "PREVIEW_STALE" }) })
    ]);
    expect(await db.selectFrom("member_contracts").select("id").where("membership_order_id", "=", orderId).execute()).toHaveLength(1);
    expect(await db.selectFrom("membership_orders").select("entitlement_lot_id").where("id", "=", orderId).executeTakeFirstOrThrow()).toMatchObject({ entitlement_lot_id: expect.stringMatching(/^lot_/) });
  });

  it("records a real overpayment on an underpaid ACTIVE order without changing its membership chain and stales a competing preview", async () => {
    const orderId = await createMembershipOrder();
    await recordPayment(orderId, 60_000, "WX-ACTIVE-PARTIAL-001");
    await confirm({
      commandType: "ACTIVATE_MEMBERSHIP_ORDER",
      input: { propertyId: demo.propertyId, membershipOrderId: orderId }
    }, "activate-underpaid-membership");

    const orderBefore = await db.selectFrom("membership_orders").selectAll().where("id", "=", orderId).executeTakeFirstOrThrow();
    const contractBefore = await db.selectFrom("member_contracts").selectAll().where("id", "=", orderBefore.contract_id!).executeTakeFirstOrThrow();
    const lotBefore = await db.selectFrom("entitlement_lots").selectAll().where("id", "=", orderBefore.entitlement_lot_id!).executeTakeFirstOrThrow();
    const ledgerBefore = await db.selectFrom("entitlement_ledger").selectAll().where("lot_id", "=", lotBefore.id).orderBy("fact_id").execute();
    const businessDate = "2026-09-04";

    await withPropertyClockForTesting(new Date("2026-09-04T23:30:00.000+08:00"), async () => {
      const paymentEnvelope: CommandEnvelope = {
        commandType: "RECORD_MEMBERSHIP_PAYMENT",
        input: {
          propertyId: demo.propertyId,
          membershipOrderId: orderId,
          amountMinor: 120_000,
          transactionReference: "WX-ACTIVE-OVERPAYMENT-001"
        }
      };
      const first = await preview(paymentEnvelope, "active-overpayment-first");
      const competing = await preview(paymentEnvelope, "active-overpayment-competing");
      expect(first.preview.effect).toMatchObject({
        payment: {
          amount: { currency: "CNY", minorUnits: 120_000 },
          businessDate
        },
        totals: {
          agreedPrice: { currency: "CNY", minorUnits: 162_000 },
          previouslyCollected: { currency: "CNY", minorUnits: 60_000 },
          currentCollection: { currency: "CNY", minorUnits: 120_000 },
          differenceAfter: { currency: "CNY", minorUnits: 18_000 }
        },
        status: "ACTIVE"
      });

      const confirmation = {
        propertyId: demo.propertyId,
        commandType: "RECORD_MEMBERSHIP_PAYMENT" as const,
        confirmation: true,
        expectedEffectHash: first.preview.effectHash,
        reason: { code: "RECORD_MEMBERSHIP_PAYMENT", note: "登记欠费会员真实企微分笔收款" }
      };
      const receipt = await confirmCommandPreview(
        db,
        principal,
        first.preview.previewId,
        confirmation,
        metadata("active-overpayment-confirm")
      );
      expect(receipt).toMatchObject({
        businessCommitted: true,
        executionStatus: "EXECUTED",
        result: { membershipOrderId: orderId, status: "ACTIVE" }
      });

      const stale = await confirmCommandPreview(db, principal, competing.preview.previewId, {
        ...confirmation,
        expectedEffectHash: competing.preview.effectHash
      }, metadata("active-overpayment-stale"));
      expect(stale).toMatchObject({
        businessCommitted: false,
        executionStatus: "NOT_EXECUTED",
        error: { code: "PREVIEW_STALE" }
      });
    });

    expect(await db.selectFrom("membership_orders").selectAll().where("id", "=", orderId).executeTakeFirstOrThrow()).toEqual(orderBefore);
    expect(await db.selectFrom("member_contracts").selectAll().where("id", "=", contractBefore.id).executeTakeFirstOrThrow()).toEqual(contractBefore);
    expect(await db.selectFrom("entitlement_lots").selectAll().where("id", "=", lotBefore.id).executeTakeFirstOrThrow()).toEqual(lotBefore);
    expect(await db.selectFrom("entitlement_ledger").selectAll().where("lot_id", "=", lotBefore.id).orderBy("fact_id").execute()).toEqual(ledgerBefore);
    expect(await db.selectFrom("membership_payment_facts").selectAll()
      .where("membership_order_id", "=", orderId)
      .where("transaction_reference", "=", "WX-ACTIVE-OVERPAYMENT-001")
      .execute()).toEqual([expect.objectContaining({
        amount_minor: 120_000,
        net_effect_minor: 120_000,
        business_date: businessDate
      })]);
  });
});

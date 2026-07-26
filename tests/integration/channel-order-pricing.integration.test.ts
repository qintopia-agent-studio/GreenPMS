import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthPrincipal, BookingChannelCode, CommandEnvelope } from "@qintopia/contracts";
import {
  confirmCommandPreview,
  createCommandPreview,
  getOrderView,
  type ConfirmRequest,
  type Database
} from "@qintopia/db";
import { sql, type Kysely } from "kysely";
import { createQuoteForTesting as createQuote } from "../../packages/db/src/pricing-service.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { resetDatabase } from "../helpers/database.ts";

const databaseUrl = process.env.CHANNEL_ORDER_PRICING_INTEGRATION_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_channel_order_pricing";

const principal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Demo Agent",
  propertyAccess: new Map([[demo.propertyId, "WRITE"]])
};

let db: Kysely<Database>;
let sequence = 0;

function metadata(prefix: string) {
  sequence += 1;
  return { idempotencyKey: `${prefix}-${sequence}`, correlationId: `${prefix}-${sequence}` };
}

async function transientQuote(day: number, unitId = demo.roomId) {
  const arrivalDate = `2028-11-${String(day).padStart(2, "0")}`;
  const departureDate = `2028-11-${String(day + 1).padStart(2, "0")}`;
  return createQuote(db, {
    propertyId: demo.propertyId,
    inventoryUnitId: unitId,
    stayType: "TRANSIENT",
    arrivalDate,
    departureDate,
    pricingPolicyVersionId: demo.transientPolicyId
  });
}

function createInput(quoteId: string, options: {
  channel?: BookingChannelCode;
  reference?: string | null;
  target?: number;
  channelReason?: string;
  manualReason?: string;
  guest?: string;
} = {}): CommandEnvelope {
  return {
    commandType: "CREATE_ORDER",
    input: {
      propertyId: demo.propertyId,
      quoteId,
      primaryGuest: { fullName: options.guest ?? "渠道计价住客", nickname: options.guest ?? "渠道住客" },
      bookingChannelCode: options.channel ?? "CTRIP",
      channelOrderReference: options.reference === undefined ? "CTRIP-STAGE2-001" : options.reference,
      ...(options.target === undefined ? {} : { targetCurrentContractAmountMinor: options.target }),
      ...(options.channelReason ? { channelPriceDifferenceReason: options.channelReason } : {}),
      ...(options.manualReason ? { manualPriceAdjustmentReason: options.manualReason } : {})
    }
  };
}

async function preview(input: CommandEnvelope, prefix: string) {
  return createCommandPreview(db, principal, input, metadata(`${prefix}-preview`));
}

async function confirm(prepared: Awaited<ReturnType<typeof preview>>, prefix: string, confirmationMetadata = metadata(`${prefix}-confirm`)) {
  const confirmation: ConfirmRequest = {
    propertyId: demo.propertyId,
    commandType: "CREATE_ORDER",
    confirmation: true,
    expectedEffectHash: prepared.preview.effectHash,
    reason: { code: "CREATE_STANDARD_ORDER", note: "" }
  };
  return {
    receipt: await confirmCommandPreview(db, principal, prepared.preview.previewId, confirmation, confirmationMetadata),
    confirmation,
    confirmationMetadata
  };
}

async function businessCounts() {
  const rows = await Promise.all([
    db.selectFrom("orders").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("stays").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("amendments").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("pricing_revisions").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("inventory_claims").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow()
  ]);
  return rows.map((row) => Number(row.count));
}

describe.sequential("channel order amount and atomic CREATE_ORDER on PostgreSQL", () => {
  beforeEach(async () => {
    db = await resetDatabase(databaseUrl);
  });

  afterEach(async () => {
    if (db) await db.destroy();
  });

  it("rejects a missing external reference or target amount before any business write", async () => {
    const quote = await transientQuote(1);
    const before = await businessCounts();
    await expect(preview(createInput(quote.quoteId, { reference: null, target: 12_000 }), "missing-reference"))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(preview(createInput(quote.quoteId, {}), "missing-target"))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await businessCounts()).toEqual(before);
  });

  it.each([
    [10_200, -1_800],
    [13_800, 1_800]
  ])("creates an external channel order at the exact 15%% boundary (%s) with one initial revision", async (target, difference) => {
    const quote = await transientQuote(target < 12_000 ? 3 : 5);
    const prepared = await preview(createInput(quote.quoteId, { target, guest: `边界 ${target}` }), `boundary-${target}`);
    expect(prepared.preview.effect).toMatchObject({
      pricing: { currentContractAmount: { currency: "CNY", minorUnits: target } },
      pricingDecision: {
        pricingBasis: "CHANNEL_CONTRACT",
        policyBaseAmount: { currency: "CNY", minorUnits: 12_000 },
        differenceFromPolicy: { currency: "CNY", minorUnits: difference },
        differenceExceedsThreshold: false,
        reason: { code: "CREATE_ORDER_CHANNEL_CONTRACT", note: "" }
      }
    });
    const { receipt } = await confirm(prepared, `boundary-${target}`);
    expect(receipt.businessCommitted).toBe(true);
    const orderId = receipt.result!.orderId as string;
    const view = await getOrderView(db, orderId);
    expect(view.pricingRevisions).toHaveLength(1);
    expect(view.amendments).toHaveLength(1);
    expect(view.pricingRevisions[0]).toMatchObject({
      revision_no: 1,
      policy_base_amount_minor: 12_000,
      pricing_basis: "CHANNEL_CONTRACT",
      manual_adjustment_minor: 0,
      current_contract_amount_minor: target,
      difference_from_policy_minor: difference,
      reason: { code: "CREATE_ORDER_CHANNEL_CONTRACT", note: "" }
    });
    expect(await db.selectFrom("command_executions").select("id").where("command_type", "=", "REPRICE_ORDER").execute()).toHaveLength(0);
  });

  it.each([10_100, 13_900])("requires and preserves the channel explanation beyond 15%% (%s)", async (target) => {
    const rejectedQuote = await transientQuote(target < 12_000 ? 7 : 9);
    await expect(preview(createInput(rejectedQuote.quoteId, { target }), `missing-channel-reason-${target}`))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await businessCounts()).toEqual([0, 0, 0, 0, 0]);

    const acceptedQuote = await transientQuote(target < 12_000 ? 11 : 13);
    const prepared = await preview(createInput(acceptedQuote.quoteId, {
      target,
      channelReason: "渠道活动确认价"
    }), `channel-reason-${target}`);
    const { receipt } = await confirm(prepared, `channel-reason-${target}`);
    const view = await getOrderView(db, receipt.result!.orderId as string);
    expect(view.pricingRevisions[0]).toMatchObject({
      pricing_basis: "CHANNEL_CONTRACT",
      manual_adjustment_minor: 0,
      current_contract_amount_minor: target,
      reason: { code: "CREATE_ORDER_CHANNEL_CONTRACT", note: "渠道活动确认价" }
    });
  });

  it("uses WECOM policy price by default and requires a reason for manual deviation", async () => {
    const policyQuote = await transientQuote(15);
    const policyPreview = await preview(createInput(policyQuote.quoteId, {
      channel: "WECOM",
      reference: null,
      guest: "企微政策价"
    }), "wecom-policy");
    const policyReceipt = (await confirm(policyPreview, "wecom-policy")).receipt;
    const policyView = await getOrderView(db, policyReceipt.result!.orderId as string);
    expect(policyView.pricingRevisions[0]).toMatchObject({ pricing_basis: "POLICY", policy_base_amount_minor: 12_000, manual_adjustment_minor: 0, current_contract_amount_minor: 12_000 });

    const rejectedQuote = await transientQuote(17);
    await expect(preview(createInput(rejectedQuote.quoteId, {
      channel: "WECOM",
      reference: null,
      target: 11_500
    }), "wecom-manual-missing-reason")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const acceptedQuote = await transientQuote(19);
    const adjustedPreview = await preview(createInput(acceptedQuote.quoteId, {
      channel: "WECOM",
      reference: null,
      target: 11_500,
      manualReason: "协议客户优惠"
    }), "wecom-manual");
    const adjustedReceipt = (await confirm(adjustedPreview, "wecom-manual")).receipt;
    const adjustedView = await getOrderView(db, adjustedReceipt.result!.orderId as string);
    expect(adjustedView.pricingRevisions[0]).toMatchObject({
      pricing_basis: "MANUAL_ADJUSTMENT",
      policy_base_amount_minor: 12_000,
      manual_adjustment_minor: -500,
      current_contract_amount_minor: 11_500,
      reason: { code: "CREATE_ORDER_MANUAL_PRICE", note: "协议客户优惠" }
    });
  });

  it("rejects a target amount for free and member stays", async () => {
    const freeQuote = await createQuote(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.roomId,
      stayType: "FREE",
      arrivalDate: "2028-12-01",
      departureDate: "2028-12-02",
      pricingPolicyVersionId: demo.freePolicyId
    });
    await expect(preview({
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: freeQuote.quoteId,
        primaryGuest: { fullName: "免费住客", nickname: "免费住客" },
        freeStayReason: "接待",
        freeStayCategoryCode: "RECEPTION",
        targetCurrentContractAmountMinor: 0
      }
    }, "free-target")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const memberQuote = await createQuote(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.roomId,
      stayType: "TRANSIENT",
      arrivalDate: "2028-12-03",
      departureDate: "2028-12-04",
      pricingPolicyVersionId: demo.transientPolicyId,
      memberContractId: demo.memberContractId
    });
    await expect(preview({
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: memberQuote.quoteId,
        primaryGuest: { fullName: "会员住客", nickname: "会员住客" },
        targetCurrentContractAmountMinor: 0
      }
    }, "member-target")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await businessCounts()).toEqual([0, 0, 0, 0, 0]);
  });

  it("keeps FREE and MEMBER_ENTITLEMENT as database-owned pricing categories for every revision", async () => {
    const freeQuote = await createQuote(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.roomId,
      stayType: "FREE",
      arrivalDate: "2028-12-05",
      departureDate: "2028-12-06",
      pricingPolicyVersionId: demo.freePolicyId
    });
    const prepared = await preview({
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: freeQuote.quoteId,
        primaryGuest: { fullName: "免费计价守卫", nickname: "免费守卫" },
        freeStayReason: "数据库计价类别守卫",
        freeStayCategoryCode: "RECEPTION"
      }
    }, "free-basis-guard");
    const orderId = (await confirm(prepared, "free-basis-guard")).receipt.result!.orderId as string;
    await db.insertInto("amendments").values({
      id: "amend_free_wrong_pricing_basis",
      order_id: orderId,
      sequence: 2,
      amendment_type: "REPRICE_ORDER",
      reason_code: "DIRECT_DATABASE_GUARD",
      reason_note: "Probe the all-revision free pricing basis guard",
      prior_version: 1,
      new_version: 2,
      payload: {},
      command_id: null
    }).execute();
    await expect(db.insertInto("pricing_revisions").values({
      id: "revision_free_wrong_pricing_basis",
      order_id: orderId,
      revision_no: 2,
      amendment_id: "amend_free_wrong_pricing_basis",
      policy_version_id: demo.freePolicyId,
      arrival_date: "2028-12-05",
      departure_date: "2028-12-06",
      coverage_set: JSON.stringify([]),
      cash_lines: JSON.stringify([]),
      policy_base_amount_minor: 0,
      pricing_basis: "POLICY",
      manual_adjustment_minor: 0,
      current_contract_amount_minor: 0,
      currency: "CNY"
    }).execute()).rejects.toMatchObject({ constraint: "pricing_revisions_all_free_basis" });
  });

  it("returns the original receipt on duplicate confirm and rolls back every business fact if receipt persistence fails", async () => {
    const duplicateQuote = await transientQuote(21);
    const prepared = await preview(createInput(duplicateQuote.quoteId, { target: 12_000 }), "duplicate");
    const confirmMetadata = metadata("duplicate-confirm");
    const first = await confirm(prepared, "duplicate", confirmMetadata);
    const replay = await confirmCommandPreview(db, principal, prepared.preview.previewId, first.confirmation, first.confirmationMetadata);
    expect(replay.receiptId).toBe(first.receipt.receiptId);
    const orderId = first.receipt.result!.orderId as string;
    expect(await db.selectFrom("pricing_revisions").select("id").where("order_id", "=", orderId).execute()).toHaveLength(1);
    expect(await db.selectFrom("amendments").select("id").where("order_id", "=", orderId).execute()).toHaveLength(1);

    const rollbackQuote = await transientQuote(23);
    const rollbackPreview = await preview(createInput(rollbackQuote.quoteId, { target: 10_200 }), "rollback");
    const before = await businessCounts();
    await sql.raw("CREATE OR REPLACE FUNCTION fail_stage2_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced stage2 receipt failure'; END $$; CREATE TRIGGER force_stage2_receipt_failure BEFORE INSERT ON command_receipts FOR EACH ROW EXECUTE FUNCTION fail_stage2_receipt()").execute(db);
    await expect(confirm(rollbackPreview, "rollback")).rejects.toThrow(/forced stage2 receipt failure/);
    expect(await businessCounts()).toEqual(before);
  });

  it("rejects a stale channel-order confirmation without leaving a policy-price order or pricing revision", async () => {
    const staleQuote = await transientQuote(25);
    const stalePreview = await preview(createInput(staleQuote.quoteId, {
      target: 10_200,
      guest: "陈旧渠道报价"
    }), "stale-channel-order");

    const winnerQuote = await transientQuote(25);
    const winnerPreview = await preview(createInput(winnerQuote.quoteId, {
      target: 12_000,
      guest: "先确认渠道订单"
    }), "winner-channel-order");
    await confirm(winnerPreview, "winner-channel-order");
    const afterWinner = await businessCounts();

    const stale = await confirm(stalePreview, "stale-channel-order");
    expect(stale.receipt).toMatchObject({
      businessCommitted: false,
      executionStatus: "NOT_EXECUTED",
      error: { code: "PREVIEW_STALE" }
    });
    expect(await businessCounts()).toEqual(afterWinner);
    expect(await db.selectFrom("orders").select("id").execute()).toHaveLength(1);
    expect(await db.selectFrom("pricing_revisions").select("id").execute()).toHaveLength(1);
    expect(await db.selectFrom("command_executions").select("id").where("command_type", "=", "REPRICE_ORDER").execute()).toHaveLength(0);
  });
});

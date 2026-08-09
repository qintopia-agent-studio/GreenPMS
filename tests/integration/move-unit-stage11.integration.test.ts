import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthPrincipal, CommandEnvelope, ReceiptDto } from "@qintopia/contracts";
import {
  confirmCommandPreview,
  createCommandPreview,
  getOrderView,
  propertyLocalToday,
  type Database
} from "@qintopia/db";
import { parseLocalDate } from "@qintopia/domain";
import { sql, type Kysely } from "kysely";
import pg from "pg";
import { createQuoteForTesting as createQuote } from "../../packages/db/src/pricing-service.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { resetDatabase } from "../helpers/database.ts";

const databaseUrl = process.env.MOVE_UNIT_STAGE11_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_move_unit_stage11";
const memberSourceUnitId = "unit_room_d_gen_01";
const memberTargetUnitId = "unit_room_d_gen_04";

const principal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Demo Agent",
  propertyAccess: new Map([[demo.propertyId, "WRITE"]])
};

let db: Kysely<Database>;
let sequence = 0;

function shiftDate(value: string, days: number): string {
  const date = parseLocalDate(value);
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

async function confirm(prepared: Awaited<ReturnType<typeof preview>>, prefix: string): Promise<ReceiptDto> {
  return confirmCommandPreview(db, principal, prepared.preview.previewId, {
    propertyId: demo.propertyId,
    commandType: prepared.preview.commandType,
    confirmation: true,
    expectedEffectHash: prepared.preview.effectHash,
    reason: prepared.preview.commandType === "CREATE_ORDER"
      ? { code: "CREATE_STANDARD_ORDER", note: "" }
      : { code: "MOVE_FOR_GUEST_REQUEST", note: "住客确认更换房间" }
  }, metadata(`${prefix}-confirm`));
}

async function execute(envelope: CommandEnvelope, prefix: string) {
  return confirm(await preview(envelope, prefix), prefix);
}

async function createOrder(options: {
  prefix: string;
  arrivalDate: string;
  departureDate: string;
  member?: boolean;
  memberContractId?: string;
  unitId?: string;
  channel?: "WECOM" | "MEITUAN";
}) {
  const memberContractId = options.memberContractId ?? (options.member ? demo.memberContractId : undefined);
  const quote = await createQuote(db, {
    propertyId: demo.propertyId,
    inventoryUnitId: options.unitId ?? (memberContractId ? memberSourceUnitId : demo.roomId),
    stayType: "TRANSIENT",
    arrivalDate: options.arrivalDate,
    departureDate: options.departureDate,
    pricingPolicyVersionId: demo.publicPricingPolicyId,
    ...(memberContractId ? { memberContractId } : {})
  });
  const receipt = await execute({
    commandType: "CREATE_ORDER",
    input: {
      propertyId: demo.propertyId,
      quoteId: quote.quoteId,
      primaryGuest: { fullName: options.prefix, nickname: options.prefix },
      ...(!memberContractId ? (options.channel === "MEITUAN" ? {
        bookingChannelCode: "MEITUAN",
        channelOrderReference: `${options.prefix}-channel-order`,
        targetCurrentContractAmountMinor: quote.currentContractAmount.minorUnits
      } : {
        bookingChannelCode: "WECOM",
        channelOrderReference: null
      }) : {})
    }
  }, `${options.prefix}-create`);
  return receipt.result!.orderId as string;
}

async function createLegacyMemberContract(prefix: string, validFrom: string, validUntil: string) {
  const contractId = `contract_${prefix}`;
  const lotId = `lot_${prefix}`;
  await db.transaction().execute(async (trx) => {
    await trx.insertInto("member_contracts").values({
      id: contractId,
      property_id: demo.propertyId,
      member_id: demo.memberId,
      member_name: "历史会员",
      status: "ACTIVE",
      valid_from: validFrom,
      valid_until: validUntil,
      version: 1,
      membership_order_id: null
    }).execute();
    await trx.insertInto("entitlement_lots").values({
      id: lotId,
      contract_id: contractId,
      unit_kind: "ROOM_NIGHT",
      total_units: 10,
      expires_on: validUntil,
      version: 1
    }).execute();
  });
  return { contractId, lotId };
}

async function markHistoricalOrderInHouse(orderId: string, businessDate: string): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const order = await trx.selectFrom("orders").selectAll().where("id", "=", orderId).forUpdate().executeTakeFirstOrThrow();
    const stay = await trx.selectFrom("stays").select("id").where("order_id", "=", orderId).executeTakeFirstOrThrow();
    await trx.insertInto("amendments").values({
      id: `amend_stage11_held_in_house_${sequence}`,
      order_id: orderId,
      sequence: order.version + 1,
      amendment_type: "CHECK_IN",
      reason_code: "STAGE11_CORRUPTION_SETUP",
      reason_note: "构造在住订单残留冻结权益",
      prior_version: order.version,
      new_version: order.version + 1,
      payload: {
        orderId,
        fromStatus: "RESERVED",
        toStatus: "CHECKED_IN",
        businessDate,
        entitlementTransition: { from: "HELD", to: "CONSUMED", coverageCount: 0 }
      },
      command_id: null
    }).execute();
    await trx.updateTable("orders").set({ status: "CHECKED_IN", version: order.version + 1, updated_at: new Date() })
      .where("id", "=", orderId).executeTakeFirstOrThrow();
    await trx.updateTable("stays").set({ status: "IN_HOUSE" }).where("id", "=", stay.id).executeTakeFirstOrThrow();
  });
}

async function consumeHeldCoverageForTest(orderId: string, factId: string): Promise<void> {
  const coverage = await db.selectFrom("coverage_items").selectAll()
    .where("order_id", "=", orderId).where("status", "=", "HELD")
    .orderBy("service_date").executeTakeFirstOrThrow();
  await db.transaction().execute(async (trx) => {
    await trx.updateTable("coverage_items").set({ status: "CONSUMED", updated_at: new Date() })
      .where("id", "=", coverage.id).executeTakeFirstOrThrow();
    await trx.insertInto("entitlement_ledger").values({
      fact_id: factId,
      lot_id: coverage.lot_id,
      entry_type: "CONSUME",
      quantity_delta: 0,
      service_date: coverage.service_date,
      order_id: orderId,
      coverage_id: coverage.id,
      reason: "STAGE11_CORRUPTION_TEST",
      command_id: null
    }).execute();
  });
}

async function orderClaims(orderId: string) {
  return db.selectFrom("inventory_claims as claim")
    .innerJoin("stay_segments as segment", "segment.id", "claim.source_id")
    .innerJoin("stays as stay", "stay.id", "segment.stay_id")
    .select(["claim.id", "claim.inventory_unit_id", "claim.service_date", "claim.active", "claim.source_id"])
    .where("stay.order_id", "=", orderId)
    .orderBy("claim.service_date")
    .orderBy("claim.created_at")
    .execute();
}

async function businessSnapshot(orderId: string) {
  const result = await sql<{ snapshot: unknown }>`
    SELECT jsonb_build_object(
      'orders', COALESCE((SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
        FROM (SELECT * FROM orders WHERE id = ${orderId}) AS row_value), '[]'::jsonb),
      'stays', COALESCE((SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
        FROM (SELECT * FROM stays WHERE order_id = ${orderId}) AS row_value), '[]'::jsonb),
      'amendments', COALESCE((SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.sequence, row_value.id)
        FROM (SELECT * FROM amendments WHERE order_id = ${orderId}) AS row_value), '[]'::jsonb),
      'segments', COALESCE((SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.sequence, row_value.id)
        FROM (SELECT segment.* FROM stay_segments AS segment
          JOIN stays AS stay ON stay.id = segment.stay_id WHERE stay.order_id = ${orderId}) AS row_value), '[]'::jsonb),
      'revisions', COALESCE((SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.revision_no, row_value.id)
        FROM (SELECT * FROM pricing_revisions WHERE order_id = ${orderId}) AS row_value), '[]'::jsonb),
      'claims', COALESCE((SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.service_date, row_value.id)
        FROM (SELECT claim.* FROM inventory_claims AS claim
          JOIN stay_segments AS segment ON segment.id = claim.source_id
          JOIN stays AS stay ON stay.id = segment.stay_id WHERE stay.order_id = ${orderId}) AS row_value), '[]'::jsonb),
      'coverage', COALESCE((SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.service_date, row_value.id)
        FROM (SELECT * FROM coverage_items WHERE order_id = ${orderId}) AS row_value), '[]'::jsonb),
      'ledger', COALESCE((SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.created_at, row_value.fact_id)
        FROM (SELECT * FROM entitlement_ledger WHERE order_id = ${orderId}) AS row_value), '[]'::jsonb),
      'funds', COALESCE((SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.created_at, row_value.fact_id)
        FROM (SELECT * FROM collection_facts WHERE order_id = ${orderId}) AS row_value), '[]'::jsonb),
      'membershipContracts', COALESCE((SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
        FROM (SELECT contract.* FROM member_contracts AS contract
          JOIN orders AS booking ON booking.member_contract_id = contract.id WHERE booking.id = ${orderId}) AS row_value), '[]'::jsonb),
      'entitlementLots', COALESCE((SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
        FROM (SELECT lot.* FROM entitlement_lots AS lot
          JOIN orders AS booking ON booking.member_contract_id = lot.contract_id WHERE booking.id = ${orderId}) AS row_value), '[]'::jsonb),
      'roomStatusRevision', COALESCE((SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.property_id)
        FROM (SELECT revision.* FROM room_status_revisions AS revision
          JOIN orders AS booking ON booking.property_id = revision.property_id WHERE booking.id = ${orderId}) AS row_value), '[]'::jsonb)
    ) AS snapshot
  `.execute(db);
  return result.rows[0]!.snapshot;
}

async function protocolCounts() {
  const [previews, executions, receipts, audits] = await Promise.all([
    db.selectFrom("command_previews").select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("command_executions").select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("command_receipts").select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("audit_entries").select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow()
  ]);
  return {
    previews: Number(previews.count),
    executions: Number(executions.count),
    receipts: Number(receipts.count),
    audits: Number(audits.count)
  };
}

async function expectTamperedMoveRollback(options: {
  orderId: string;
  prepared: Awaited<ReturnType<typeof preview>>;
  prefix: string;
}) {
  const before = await businessSnapshot(options.orderId);
  const receipt = await confirm(options.prepared, options.prefix);
  expect(receipt).toMatchObject({
    executionStatus: "NOT_EXECUTED",
    businessCommitted: false,
    error: { code: "COMMAND_INTERRUPTED" },
    resourceRefs: [],
    factRefs: []
  });
  expect(await businessSnapshot(options.orderId)).toEqual(before);
}

beforeEach(async () => {
  db = await resetDatabase(databaseUrl);
});

afterEach(async () => {
  if (db) await db.destroy();
});

describe.sequential("Stage 11 MOVE_UNIT PostgreSQL transaction", () => {
  it("projects MOVE_UNIT as disabled outside the Stage 11 business-date matrix", async () => {
    await db.updateTable("properties").set({ timezone: "Etc/GMT+12" }).where("id", "=", demo.propertyId).execute();
    const earlyBusinessDate = await propertyLocalToday(db, demo.propertyId);
    const reservedOrderId = await createOrder({
      prefix: "stage11-overdue-reserved",
      arrivalDate: earlyBusinessDate,
      departureDate: shiftDate(earlyBusinessDate, 2)
    });
    const inHouseOrderId = await createOrder({
      prefix: "stage11-departure-day-in-house",
      arrivalDate: earlyBusinessDate,
      departureDate: shiftDate(earlyBusinessDate, 1),
      unitId: demo.secondRoomId
    });
    await execute({
      commandType: "CHECK_IN",
      input: { propertyId: demo.propertyId, orderId: inHouseOrderId }
    }, "stage11-departure-day-check-in");

    await db.updateTable("properties").set({ timezone: "Etc/GMT-12" }).where("id", "=", demo.propertyId).execute();
    expect((await getOrderView(db, reservedOrderId)).allowedActions.find((action) => action.code === "MOVE_UNIT"))
      .toEqual({
        code: "MOVE_UNIT",
        enabled: false,
        disabledReason: "逾期未到订单暂不能换房，请先处理到店日期"
      });
    expect((await getOrderView(db, inHouseOrderId)).allowedActions.find((action) => action.code === "MOVE_UNIT"))
      .toEqual({
        code: "MOVE_UNIT",
        enabled: false,
        disabledReason: "已到或超过计划退房日，请先办理续住或退房"
      });
  });

  it("previews and confirms a same-room-type MOVE for a legacy contract without a membership order", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const arrivalDate = shiftDate(businessDate, 1);
    const departureDate = shiftDate(businessDate, 4);
    const { contractId } = await createLegacyMemberContract(
      "stage11_legacy_move",
      shiftDate(businessDate, -1),
      shiftDate(businessDate, 30)
    );
    const orderId = await createOrder({
      prefix: "stage11-legacy-move",
      arrivalDate,
      departureDate,
      memberContractId: contractId
    });
    expect(await db.selectFrom("member_contracts").select("membership_order_id")
      .where("id", "=", contractId).executeTakeFirstOrThrow())
      .toEqual({ membership_order_id: null });

    const prepared = await preview({
      commandType: "MOVE_UNIT",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newInventoryUnitId: memberTargetUnitId,
        effectiveDate: shiftDate(businessDate, 2)
      }
    }, "stage11-legacy-move");
    expect(prepared.preview.effect).toMatchObject({
      operation: "MOVE_UNIT",
      toInventoryUnit: { id: memberTargetUnitId, roomTypeCode: "shared_bath_single" }
    });

    const receipt = await confirm(prepared, "stage11-legacy-move");
    expect(receipt).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });
    expect(await db.selectFrom("coverage_items").select(["status", "inventory_unit_id"])
      .where("order_id", "=", orderId).where("status", "=", "HELD")
      .orderBy("service_date").execute())
      .toEqual([
        { status: "HELD", inventory_unit_id: memberSourceUnitId },
        { status: "HELD", inventory_unit_id: memberTargetUnitId },
        { status: "HELD", inventory_unit_id: memberTargetUnitId }
      ]);
  });

  it("reprices a paid MOVE only from the current rescheduled timeline", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const sourceUnit = await db.selectFrom("inventory_units")
      .select(["id", "code", "pricing_product_code"])
      .where("property_id", "=", demo.propertyId)
      .where("code", "=", "307")
      .executeTakeFirstOrThrow();
    const targetUnit = await db.selectFrom("inventory_units")
      .select(["id", "code", "pricing_product_code"])
      .where("property_id", "=", demo.propertyId)
      .where("code", "=", "E03")
      .executeTakeFirstOrThrow();
    expect(sourceUnit.pricing_product_code).not.toBeNull();
    expect(targetUnit.pricing_product_code).not.toBeNull();
    expect(targetUnit.pricing_product_code).not.toBe(sourceUnit.pricing_product_code);

    const originalArrivalDate = shiftDate(businessDate, 40);
    const originalDepartureDate = shiftDate(businessDate, 43);
    const rescheduledArrivalDate = shiftDate(businessDate, 70);
    const moveEffectiveDate = shiftDate(businessDate, 77);
    const rescheduledDepartureDate = shiftDate(businessDate, 84);
    const orderId = await createOrder({
      prefix: "stage11-paid-reschedule-move",
      arrivalDate: originalArrivalDate,
      departureDate: originalDepartureDate,
      unitId: sourceUnit.id,
      channel: "WECOM"
    });

    const rescheduleReceipt = await execute({
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newArrivalDate: rescheduledArrivalDate,
        newDepartureDate: rescheduledDepartureDate
      }
    }, "stage11-paid-reschedule-move-reschedule");
    expect(rescheduleReceipt).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });

    const rescheduledDates = Array.from(
      { length: 14 },
      (_, index) => shiftDate(rescheduledArrivalDate, index)
    );
    const expectedBeforeTimeline = rescheduledDates.map((serviceDate) => ({
      serviceDate,
      inventoryUnitId: sourceUnit.id
    }));
    const expectedAfterTimeline = rescheduledDates.map((serviceDate) => ({
      serviceDate,
      inventoryUnitId: serviceDate < moveEffectiveDate ? sourceUnit.id : targetUnit.id
    }));
    const prepared = await preview({
      commandType: "MOVE_UNIT",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newInventoryUnitId: targetUnit.id,
        effectiveDate: moveEffectiveDate
      }
    }, "stage11-paid-reschedule-move");
    expect(prepared.preview.effect).toMatchObject({
      operation: "MOVE_UNIT",
      before: {
        arrivalDate: rescheduledArrivalDate,
        departureDate: rescheduledDepartureDate,
        nights: 14,
        stayTimeline: expectedBeforeTimeline
      },
      after: {
        arrivalDate: rescheduledArrivalDate,
        departureDate: rescheduledDepartureDate,
        nights: 14,
        stayTimeline: expectedAfterTimeline
      },
      fundsSummary: {
        netRecordedCollection: { currency: "CNY", minorUnits: 0 },
        factCount: 0
      }
    });

    const effect = prepared.preview.effect as {
      after: {
        pricing: {
          cashLines: Array<{
            lineKind: string;
            arrivalDate: string;
            departureDate: string;
            pricingBandAnchorNights: number;
            calculationSegments: Array<{
              inventoryUnitId: string;
              pricingProductCode: string;
              arrivalDate: string;
              departureDate: string;
              nights: number;
              anchorAmountMinor: number;
              numeratorMinor: number;
              denominator: number;
            }>;
            amount: { currency: string; minorUnits: number };
          }>;
          currentContractAmount: { currency: string; minorUnits: number };
        };
      };
      pricingDecision: {
        pricingBasis: string;
        policyBaseAmount: { currency: string; minorUnits: number };
        targetCurrentContractAmount: { currency: string; minorUnits: number };
      };
    };
    expect(effect.after.pricing.cashLines).toHaveLength(1);
    const stayTotal = effect.after.pricing.cashLines[0]!;
    expect(stayTotal).toMatchObject({
      lineKind: "STAY_TOTAL",
      arrivalDate: rescheduledArrivalDate,
      departureDate: rescheduledDepartureDate,
      pricingBandAnchorNights: 14,
      calculationSegments: [
        {
          inventoryUnitId: sourceUnit.id,
          pricingProductCode: sourceUnit.pricing_product_code,
          arrivalDate: rescheduledArrivalDate,
          departureDate: moveEffectiveDate,
          nights: 7,
          denominator: 14
        },
        {
          inventoryUnitId: targetUnit.id,
          pricingProductCode: targetUnit.pricing_product_code,
          arrivalDate: moveEffectiveDate,
          departureDate: rescheduledDepartureDate,
          nights: 7,
          denominator: 14
        }
      ]
    });
    for (const segment of stayTotal.calculationSegments) {
      expect(segment.numeratorMinor).toBe(segment.nights * segment.anchorAmountMinor);
    }
    const totalNumerator = stayTotal.calculationSegments
      .reduce((sum, segment) => sum + BigInt(segment.numeratorMinor), 0n);
    const denominatorMinor = BigInt(stayTotal.pricingBandAnchorNights) * 100n;
    const expectedPolicyAmountMinor = Number(
      ((totalNumerator * 2n + denominatorMinor) / (denominatorMinor * 2n)) * 100n
    );
    expect(stayTotal.amount).toEqual({ currency: "CNY", minorUnits: expectedPolicyAmountMinor });
    expect(effect.after.pricing.currentContractAmount).toEqual(stayTotal.amount);
    expect(effect.pricingDecision).toMatchObject({
      pricingBasis: "POLICY",
      policyBaseAmount: stayTotal.amount,
      targetCurrentContractAmount: stayTotal.amount
    });
    expect(JSON.stringify(effect.after.pricing.cashLines)).not.toContain(originalArrivalDate);
    expect(JSON.stringify(effect.after.pricing.cashLines)).not.toContain(originalDepartureDate);

    const moveReceipt = await confirm(prepared, "stage11-paid-reschedule-move");
    expect(moveReceipt).toMatchObject({
      executionStatus: "EXECUTED",
      businessCommitted: true,
      factRefs: [],
      result: {
        before: { stayTimeline: expectedBeforeTimeline },
        after: { stayTimeline: expectedAfterTimeline }
      }
    });

    const view = await getOrderView(db, orderId);
    expect(view.effectiveArrangement.intervals).toEqual([
      {
        inventoryUnitId: sourceUnit.id,
        arrivalDate: rescheduledArrivalDate,
        departureDate: moveEffectiveDate
      },
      {
        inventoryUnitId: targetUnit.id,
        arrivalDate: moveEffectiveDate,
        departureDate: rescheduledDepartureDate
      }
    ]);
    const activeClaims = (await orderClaims(orderId))
      .filter((claim) => claim.active)
      .map(({ service_date, inventory_unit_id }) => ({ serviceDate: service_date, inventoryUnitId: inventory_unit_id }));
    expect(activeClaims).toEqual(expectedAfterTimeline);

    const order = await db.selectFrom("orders")
      .select("current_revision_id")
      .where("id", "=", orderId)
      .executeTakeFirstOrThrow();
    const finalRevision = await db.selectFrom("pricing_revisions")
      .selectAll()
      .where("id", "=", order.current_revision_id!)
      .executeTakeFirstOrThrow();
    expect(finalRevision).toMatchObject({
      arrival_date: rescheduledArrivalDate,
      departure_date: rescheduledDepartureDate,
      policy_base_amount_minor: expectedPolicyAmountMinor,
      pricing_basis: "POLICY",
      manual_adjustment_minor: 0,
      current_contract_amount_minor: expectedPolicyAmountMinor,
      currency: "CNY",
      cash_lines: effect.after.pricing.cashLines
    });
    expect(finalRevision.coverage_set).toEqual([]);
    expect(JSON.stringify(finalRevision.cash_lines)).not.toContain(originalArrivalDate);
    expect(JSON.stringify(finalRevision.cash_lines)).not.toContain(originalDepartureDate);
    expect(view.amounts.currentContractAmount).toEqual(stayTotal.amount);
    expect(await db.selectFrom("collection_facts").select("fact_id").where("order_id", "=", orderId).execute())
      .toHaveLength(0);
  });

  it("fails closed with zero business writes for reserved CONSUMED and in-house HELD coverage", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const reservedOrderId = await createOrder({
      prefix: "stage11-reserved-consumed",
      arrivalDate: shiftDate(businessDate, 5),
      departureDate: shiftDate(businessDate, 7),
      member: true
    });
    await consumeHeldCoverageForTest(reservedOrderId, "fact_stage11_reserved_consumed");
    const reservedBefore = await businessSnapshot(reservedOrderId);
    await expect(preview({
      commandType: "MOVE_UNIT",
      input: {
        propertyId: demo.propertyId,
        orderId: reservedOrderId,
        newInventoryUnitId: memberTargetUnitId,
        effectiveDate: shiftDate(businessDate, 6)
      }
    }, "stage11-reserved-consumed")).rejects.toMatchObject({
      code: "ENTITLEMENT_CONFLICT",
      message: expect.stringContaining("未入住订单存在已核销会员权益")
    });
    expect(await businessSnapshot(reservedOrderId)).toEqual(reservedBefore);

    await db.destroy();
    db = await resetDatabase(databaseUrl);
    const inHouseBusinessDate = await propertyLocalToday(db, demo.propertyId);
    const inHouseOrderId = await createOrder({
      prefix: "stage11-in-house-held",
      arrivalDate: inHouseBusinessDate,
      departureDate: shiftDate(inHouseBusinessDate, 2),
      member: true
    });
    await markHistoricalOrderInHouse(inHouseOrderId, inHouseBusinessDate);
    const inHouseBefore = await businessSnapshot(inHouseOrderId);
    await expect(preview({
      commandType: "MOVE_UNIT",
      input: {
        propertyId: demo.propertyId,
        orderId: inHouseOrderId,
        newInventoryUnitId: memberTargetUnitId,
        effectiveDate: inHouseBusinessDate
      }
    }, "stage11-in-house-held")).rejects.toMatchObject({
      code: "ENTITLEMENT_CONFLICT",
      message: expect.stringContaining("在住订单仍有未核销的原住宿权益")
    });
    expect(await businessSnapshot(inHouseOrderId)).toEqual(inHouseBefore);
  });

  it("revalidates coverage lifecycle state on confirmation and keeps zero business writes", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const orderId = await createOrder({
      prefix: "stage11-confirm-residual",
      arrivalDate: shiftDate(businessDate, 1),
      departureDate: shiftDate(businessDate, 3),
      member: true
    });
    const prepared = await preview({
      commandType: "MOVE_UNIT",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newInventoryUnitId: memberTargetUnitId,
        effectiveDate: shiftDate(businessDate, 2)
      }
    }, "stage11-confirm-residual");
    await consumeHeldCoverageForTest(orderId, "fact_stage11_confirm_residual");
    const before = await businessSnapshot(orderId);

    const receipt = await confirm(prepared, "stage11-confirm-residual");
    expect(receipt).toMatchObject({
      executionStatus: "NOT_EXECUTED",
      businessCommitted: false,
      error: { code: "PREVIEW_STALE" },
      resourceRefs: [],
      factRefs: []
    });
    expect(await businessSnapshot(orderId)).toEqual(before);
  });

  it("rolls back a MOVE when a direct write introduces reserved CONSUMED coverage after revalidation", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const orderId = await createOrder({
      prefix: "stage11-db-residual",
      arrivalDate: shiftDate(businessDate, 1),
      departureDate: shiftDate(businessDate, 3),
      member: true
    });
    const prepared = await preview({
      commandType: "MOVE_UNIT",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newInventoryUnitId: memberTargetUnitId,
        effectiveDate: shiftDate(businessDate, 2)
      }
    }, "stage11-db-residual");
    await sql.raw(`
      CREATE FUNCTION qintopia_test_stage11_move_residual() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE target_coverage coverage_items%ROWTYPE;
      BEGIN
        IF NEW.amendment_type = 'MOVE_UNIT' THEN
          SELECT * INTO STRICT target_coverage FROM coverage_items
            WHERE order_id = NEW.order_id AND status = 'HELD'
            ORDER BY service_date LIMIT 1;
          UPDATE coverage_items SET status = 'CONSUMED', updated_at = now()
            WHERE id = target_coverage.id;
          INSERT INTO entitlement_ledger (
            fact_id, lot_id, entry_type, quantity_delta, service_date,
            order_id, coverage_id, reason, command_id
          ) VALUES (
            'fact_stage11_db_residual', target_coverage.lot_id, 'CONSUME', 0,
            target_coverage.service_date, NEW.order_id, target_coverage.id,
            'STAGE11_DIRECT_WRITE_TEST', NULL
          );
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER qintopia_test_stage11_move_residual BEFORE INSERT ON amendments
        FOR EACH ROW EXECUTE FUNCTION qintopia_test_stage11_move_residual()
    `).execute(db);
    try {
      await expectTamperedMoveRollback({ orderId, prepared, prefix: "stage11-db-residual" });
    } finally {
      await sql.raw(`
        DROP TRIGGER IF EXISTS qintopia_test_stage11_move_residual ON amendments;
        DROP FUNCTION IF EXISTS qintopia_test_stage11_move_residual()
      `).execute(db);
    }
  });

  it("preserves intersecting Claim IDs and migrates only changed HELD coverage", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const arrivalDate = shiftDate(businessDate, 1);
    const effectiveDate = shiftDate(businessDate, 2);
    const departureDate = shiftDate(businessDate, 5);
    const orderId = await createOrder({ prefix: "stage11-held", arrivalDate, departureDate, member: true });
    const claimsBefore = await orderClaims(orderId);
    const coverageBefore = await db.selectFrom("coverage_items").selectAll().where("order_id", "=", orderId).orderBy("service_date").execute();
    const ledgerBefore = await db.selectFrom("entitlement_ledger").select("fact_id").where("order_id", "=", orderId).execute();

    const receipt = await execute({
      commandType: "MOVE_UNIT",
      input: { propertyId: demo.propertyId, orderId, newInventoryUnitId: memberTargetUnitId, effectiveDate }
    }, "stage11-held-move");
    expect(receipt.error).toBeUndefined();
    expect(receipt).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });

    const claimsAfter = await orderClaims(orderId);
    for (const before of claimsBefore.filter((claim) => claim.service_date < effectiveDate)) {
      expect(claimsAfter.find((claim) => claim.id === before.id)).toMatchObject({ active: true, inventory_unit_id: memberSourceUnitId });
    }
    for (const before of claimsBefore.filter((claim) => claim.service_date >= effectiveDate)) {
      expect(claimsAfter.find((claim) => claim.id === before.id)?.active).toBe(false);
      expect(claimsAfter).toContainEqual(expect.objectContaining({
        service_date: before.service_date,
        inventory_unit_id: memberTargetUnitId,
        active: true
      }));
    }
    const coverageAfter = await db.selectFrom("coverage_items").selectAll().where("order_id", "=", orderId).orderBy("service_date").orderBy("created_at").execute();
    for (const before of coverageBefore.filter((item) => item.service_date < effectiveDate)) {
      expect(coverageAfter.find((item) => item.id === before.id)).toMatchObject({ status: "HELD", inventory_unit_id: memberSourceUnitId });
    }
    for (const before of coverageBefore.filter((item) => item.service_date >= effectiveDate)) {
      expect(coverageAfter.find((item) => item.id === before.id)?.status).toBe("RELEASED");
      expect(coverageAfter).toContainEqual(expect.objectContaining({
        service_date: before.service_date,
        inventory_unit_id: memberTargetUnitId,
        status: "HELD"
      }));
    }
    const changedCoverageNights = coverageBefore.filter((item) => item.service_date >= effectiveDate).length;
    const ledgerAfter = await db.selectFrom("entitlement_ledger").selectAll().where("order_id", "=", orderId).execute();
    expect(changedCoverageNights).toBeGreaterThan(0);
    expect(ledgerAfter).toHaveLength(ledgerBefore.length + changedCoverageNights * 2);
    expect(receipt.factRefs).toHaveLength(changedCoverageNights * 2);
    expect(receipt.result?.entitlementSummary).toMatchObject({
      preservedCoverageDates: coverageBefore.filter((item) => item.service_date < effectiveDate).map((item) => item.service_date),
      migratedHeldCoverageDates: coverageBefore.filter((item) => item.service_date >= effectiveDate).map((item) => item.service_date),
      consumedCoverageDates: [],
      ledgerWriteCount: changedCoverageNights * 2
    });
    expect(receipt.result).toMatchObject({ businessDate });
    expect(await db.selectFrom("collection_facts").select("fact_id").where("order_id", "=", orderId).execute()).toHaveLength(0);
  });

  it("keeps CONSUMED coverage and its historical unit immutable while moving current Claims", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const orderId = await createOrder({
      prefix: "stage11-consumed",
      arrivalDate: businessDate,
      departureDate: shiftDate(businessDate, 3),
      member: true
    });
    await execute({ commandType: "CHECK_IN", input: { propertyId: demo.propertyId, orderId } }, "stage11-consumed-checkin");
    const consumedBefore = await db.selectFrom("coverage_items").selectAll().where("order_id", "=", orderId).where("status", "=", "CONSUMED").orderBy("service_date").execute();
    const ledgerBefore = await db.selectFrom("entitlement_ledger").selectAll().where("order_id", "=", orderId).execute();

    const receipt = await execute({
      commandType: "MOVE_UNIT",
      input: { propertyId: demo.propertyId, orderId, newInventoryUnitId: memberTargetUnitId, effectiveDate: businessDate }
    }, "stage11-consumed-move");
    expect(receipt.error).toBeUndefined();
    expect(receipt).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });

    const consumedAfter = await db.selectFrom("coverage_items").selectAll().where("order_id", "=", orderId).where("status", "=", "CONSUMED").orderBy("service_date").execute();
    expect(consumedAfter).toEqual(consumedBefore);
    expect(await db.selectFrom("entitlement_ledger").selectAll().where("order_id", "=", orderId).execute()).toEqual(ledgerBefore);
    expect(receipt.factRefs).toEqual([]);
    expect(receipt.result?.entitlementSummary).toMatchObject({
      consumedCoverageDates: consumedBefore.map((item) => item.service_date),
      ledgerWriteCount: 0
    });
    await expect(db.updateTable("coverage_items")
      .set({ inventory_unit_id: memberTargetUnitId })
      .where("id", "=", consumedBefore[0]!.id)
      .execute()).rejects.toThrow(/coverage identity is immutable|consumed member coverage is immutable/);
    await expect(db.deleteFrom("coverage_items")
      .where("id", "=", consumedBefore[0]!.id)
      .execute()).rejects.toThrow(/coverage|fact mutation/i);
    const view = await getOrderView(db, orderId);
    expect(view.order.status).toBe("CHECKED_IN");
    expect(view.stay.status).toBe("IN_HOUSE");
    expect((await orderClaims(orderId)).filter((claim) => claim.active))
      .toEqual(expect.arrayContaining(consumedBefore.map((item) => expect.objectContaining({
        service_date: item.service_date,
        inventory_unit_id: memberTargetUnitId
      }))));
  });

  it("extends across a business date after moving and preserves historical CONSUMED coverage identity", async () => {
    await db.updateTable("properties").set({ timezone: "Etc/GMT+12" }).where("id", "=", demo.propertyId).execute();
    const checkInDate = await propertyLocalToday(db, demo.propertyId);
    const originalDepartureDate = shiftDate(checkInDate, 2);
    const orderId = await createOrder({
      prefix: "stage11-consumed-move-extend",
      arrivalDate: checkInDate,
      departureDate: originalDepartureDate,
      member: true
    });
    const moved = await execute({
      commandType: "CHECK_IN",
      input: { propertyId: demo.propertyId, orderId }
    }, "stage11-consumed-move-extend-checkin");
    const consumedBeforeMove = await db.selectFrom("coverage_items")
      .selectAll().where("order_id", "=", orderId).where("status", "=", "CONSUMED")
      .orderBy("service_date").orderBy("id").execute();
    expect(consumedBeforeMove).toHaveLength(2);

    await execute({
      commandType: "MOVE_UNIT",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newInventoryUnitId: memberTargetUnitId,
        effectiveDate: checkInDate
      }
    }, "stage11-consumed-move-extend-move");
    expect(moved.error).toBeUndefined();
    expect(moved).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });
    expect(await db.selectFrom("coverage_items")
      .selectAll().where("order_id", "=", orderId).where("status", "=", "CONSUMED")
      .orderBy("service_date").orderBy("id").execute()).toEqual(consumedBeforeMove);

    await db.updateTable("properties").set({ timezone: "Etc/GMT-12" }).where("id", "=", demo.propertyId).execute();
    expect(await propertyLocalToday(db, demo.propertyId)).toBe(shiftDate(checkInDate, 1));
    const newDepartureDate = shiftDate(originalDepartureDate, 1);
    const extension = await execute({
      commandType: "EXTEND_STAY",
      input: { propertyId: demo.propertyId, orderId, newDepartureDate }
    }, "stage11-consumed-move-extend-extension");
    expect(extension).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });

    const consumedAfterExtension = await db.selectFrom("coverage_items")
      .selectAll().where("order_id", "=", orderId).where("status", "=", "CONSUMED")
      .orderBy("service_date").orderBy("id").execute();
    expect(consumedAfterExtension.filter((item) => consumedBeforeMove.some((before) => before.id === item.id)))
      .toEqual(consumedBeforeMove);
    const addedCoverage = consumedAfterExtension.find((item) => item.service_date === originalDepartureDate);
    if (addedCoverage) {
      expect(addedCoverage).toMatchObject({ inventory_unit_id: memberTargetUnitId, status: "CONSUMED" });
      expect(extension.result?.entitlementChange).toMatchObject({
        addedCoverageDates: [originalDepartureDate],
        consumedCoverageDates: [originalDepartureDate]
      });
      expect(extension.result?.fundsSummary).toMatchObject({
        netRecordedCollection: { currency: "CNY", minorUnits: 0 },
        collectionDifference: { currency: "CNY", minorUnits: 0 }
      });
    } else {
      expect(consumedAfterExtension).toEqual(consumedBeforeMove);
      const order = await db.selectFrom("orders").select("current_revision_id").where("id", "=", orderId).executeTakeFirstOrThrow();
      const revision = await db.selectFrom("pricing_revisions")
        .select(["cash_lines", "current_contract_amount_minor"])
        .where("id", "=", order.current_revision_id!).executeTakeFirstOrThrow();
      expect(revision.cash_lines).toContainEqual(expect.objectContaining({
        lineKind: "NIGHT",
        serviceDate: originalDepartureDate,
        inventoryUnitId: memberTargetUnitId,
        amount: { currency: "CNY", minorUnits: expect.any(Number) }
      }));
      expect(revision.current_contract_amount_minor).toBeGreaterThan(0);
      expect(extension.result?.entitlementChange).toMatchObject({
        addedCoverageDates: [],
        consumedCoverageDates: []
      });
      expect(extension.result?.fundsSummary).toMatchObject({
        netRecordedCollection: { currency: "CNY", minorUnits: 0 },
        collectionDifference: { currency: "CNY", minorUnits: revision.current_contract_amount_minor }
      });
    }
  });

  it("moves after an in-house shortening without binding the current revision to out-of-interval CONSUMED history", async () => {
    await db.updateTable("properties").set({ timezone: "Etc/GMT+12" }).where("id", "=", demo.propertyId).execute();
    const arrivalDate = await propertyLocalToday(db, demo.propertyId);
    await execute({
      commandType: "ADJUST_MEMBER_ENTITLEMENT",
      input: {
        propertyId: demo.propertyId,
        entitlementLotId: demo.roomLotId,
        quantityDelta: 3,
        adjustmentReason: "Stage 11 shortening then move coverage"
      }
    }, "stage11-shorten-move-adjust");
    const orderId = await createOrder({
      prefix: "stage11-shorten-move",
      arrivalDate,
      departureDate: shiftDate(arrivalDate, 4),
      member: true
    });
    await execute({ commandType: "CHECK_IN", input: { propertyId: demo.propertyId, orderId } }, "stage11-shorten-move-checkin");
    const consumedBefore = await db.selectFrom("coverage_items").selectAll()
      .where("order_id", "=", orderId).where("status", "=", "CONSUMED").orderBy("service_date").execute();
    expect(consumedBefore).toHaveLength(4);

    await db.updateTable("properties").set({ timezone: "Etc/GMT-12" }).where("id", "=", demo.propertyId).execute();
    const businessDate = shiftDate(arrivalDate, 1);
    const shortenedDepartureDate = shiftDate(businessDate, 1);
    await execute({
      commandType: "SHORTEN_STAY",
      input: { propertyId: demo.propertyId, orderId, newDepartureDate: shortenedDepartureDate }
    }, "stage11-shorten-move-shorten");

    const moved = await execute({
      commandType: "MOVE_UNIT",
      input: { propertyId: demo.propertyId, orderId, newInventoryUnitId: memberTargetUnitId, effectiveDate: businessDate }
    }, "stage11-shorten-move-move");
    expect(moved.error).toBeUndefined();
    expect(moved).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });
    expect(await db.selectFrom("coverage_items").selectAll()
      .where("order_id", "=", orderId).where("status", "=", "CONSUMED").orderBy("service_date").execute())
      .toEqual(consumedBefore);
    const currentRevision = await db.selectFrom("orders as booking")
      .innerJoin("pricing_revisions as revision", "revision.id", "booking.current_revision_id")
      .select(["revision.coverage_set"])
      .where("booking.id", "=", orderId).executeTakeFirstOrThrow();
    expect((currentRevision.coverage_set as Array<{ serviceDate: string }>).map((item) => item.serviceDate))
      .toEqual([arrivalDate, businessDate]);
    expect(moved.result?.entitlementSummary).toMatchObject({
      consumedCoverageDates: consumedBefore.map((item) => item.service_date),
      ledgerWriteCount: 0
    });
  });

  it("rejects entitlement ledger writes after a MOVE_UNIT command is APPLIED", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const orderId = await createOrder({
      prefix: "stage11-closed-ledger",
      arrivalDate: shiftDate(businessDate, 1),
      departureDate: shiftDate(businessDate, 3),
      member: true
    });
    const moved = await execute({
      commandType: "MOVE_UNIT",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newInventoryUnitId: memberTargetUnitId,
        effectiveDate: shiftDate(businessDate, 2)
      }
    }, "stage11-closed-ledger-move");
    const coverage = await db.selectFrom("coverage_items").selectAll()
      .where("order_id", "=", orderId).where("status", "=", "HELD").orderBy("service_date").executeTakeFirstOrThrow();
    await expect(db.insertInto("entitlement_ledger").values({
      fact_id: "fact_stage11_post_applied_hold",
      lot_id: coverage.lot_id,
      entry_type: "HOLD",
      quantity_delta: -1,
      service_date: coverage.service_date,
      order_id: orderId,
      coverage_id: coverage.id,
      reason: "ORDER_COVERAGE_HOLD",
      command_id: moved.commandId
    }).execute()).rejects.toMatchObject({ constraint: "stage11_move_ledger_closed" });
  });

  it("serializes competing confirmations and leaves the losing Preview with zero extra business writes", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const arrivalDate = shiftDate(businessDate, 1);
    const effectiveDate = shiftDate(businessDate, 2);
    const orderId = await createOrder({ prefix: "stage11-concurrent", arrivalDate, departureDate: shiftDate(businessDate, 4) });
    const input: CommandEnvelope = {
      commandType: "MOVE_UNIT",
      input: { propertyId: demo.propertyId, orderId, newInventoryUnitId: demo.secondRoomId, effectiveDate }
    };
    const [first, second] = await Promise.all([preview(input, "stage11-concurrent-a"), preview(input, "stage11-concurrent-b")]);
    const results = await Promise.all([confirm(first, "stage11-concurrent-a"), confirm(second, "stage11-concurrent-b")]);
    expect(results.filter((result) => result.businessCommitted)).toHaveLength(1);
    expect(results.find((result) => !result.businessCommitted)?.error).toMatchObject({ code: "PREVIEW_STALE" });
    expect((await getOrderView(db, orderId)).amendments.filter((item) => item.amendment_type === "MOVE_UNIT")).toHaveLength(1);
    expect((await orderClaims(orderId)).filter((claim) => claim.active && claim.service_date >= effectiveDate))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ inventory_unit_id: demo.secondRoomId })
      ]));
  });

  it("rejects an occupied move target with an exact Chinese reason and zero Preview writes", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const arrivalDate = shiftDate(businessDate, 1);
    const departureDate = shiftDate(businessDate, 4);
    const orderId = await createOrder({ prefix: "stage11-preview-conflict-source", arrivalDate, departureDate });
    const blockingOrderId = await createOrder({
      prefix: "stage11-preview-conflict-target",
      arrivalDate,
      departureDate,
      unitId: demo.secondRoomId
    });
    const before = {
      source: await businessSnapshot(orderId),
      target: await businessSnapshot(blockingOrderId),
      protocol: await protocolCounts()
    };

    await expect(preview({
      commandType: "MOVE_UNIT",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newInventoryUnitId: demo.secondRoomId,
        effectiveDate: shiftDate(arrivalDate, 1)
      }
    }, "stage11-preview-conflict")).rejects.toMatchObject({
      code: "INVENTORY_CONFLICT",
      statusCode: 409,
      message: "目标房源在所选换房日期内已有占用，请选择其他房源。"
    });
    expect({
      source: await businessSnapshot(orderId),
      target: await businessSnapshot(blockingOrderId),
      protocol: await protocolCounts()
    }).toEqual(before);
  });

  it("rejects a MOVE command whose property differs from its order", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const orderId = await createOrder({
      prefix: "stage11-command-property",
      arrivalDate: shiftDate(businessDate, 1),
      departureDate: shiftDate(businessDate, 3)
    });
    const prepared = await preview({
      commandType: "MOVE_UNIT",
      input: { propertyId: demo.propertyId, orderId, newInventoryUnitId: demo.secondRoomId, effectiveDate: shiftDate(businessDate, 2) }
    }, "stage11-command-property");
    await db.insertInto("properties").values({
      id: "prop_stage11_command_other",
      code: "STAGE11-OTHER",
      name: "Stage 11 other property",
      timezone: "Asia/Shanghai",
      currency: "CNY"
    }).execute();
    await sql.raw(`
      CREATE FUNCTION qintopia_test_stage11_command_property() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.command_type = 'MOVE_UNIT' THEN NEW.property_id := 'prop_stage11_command_other'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER qintopia_test_stage11_command_property BEFORE INSERT ON command_executions
        FOR EACH ROW EXECUTE FUNCTION qintopia_test_stage11_command_property()
    `).execute(db);
    try {
      await expectTamperedMoveRollback({ orderId, prepared, prefix: "stage11-command-property" });
    } finally {
      await sql.raw(`
        DROP TRIGGER IF EXISTS qintopia_test_stage11_command_property ON command_executions;
        DROP FUNCTION IF EXISTS qintopia_test_stage11_command_property()
      `).execute(db);
    }
  });

  it("rejects a MOVE command that appends any second amendment", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const orderId = await createOrder({
      prefix: "stage11-extra-amendment",
      arrivalDate: shiftDate(businessDate, 1),
      departureDate: shiftDate(businessDate, 3)
    });
    const prepared = await preview({
      commandType: "MOVE_UNIT",
      input: { propertyId: demo.propertyId, orderId, newInventoryUnitId: demo.secondRoomId, effectiveDate: shiftDate(businessDate, 2) }
    }, "stage11-extra-amendment");
    await sql.raw(`
      CREATE FUNCTION qintopia_test_stage11_extra_amendment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.amendment_type = 'MOVE_UNIT' THEN
          INSERT INTO amendments (
            id, order_id, sequence, amendment_type, reason_code, reason_note,
            prior_version, new_version, payload, command_id
          ) VALUES (
            'amend_stage11_extra', NEW.order_id, NEW.sequence + 100, 'REPRICE_ORDER',
            'FORGED', 'forged command sibling', NEW.new_version, NEW.new_version + 1, '{}'::jsonb, NEW.command_id
          );
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER qintopia_test_stage11_extra_amendment AFTER INSERT ON amendments
        FOR EACH ROW EXECUTE FUNCTION qintopia_test_stage11_extra_amendment()
    `).execute(db);
    try {
      await expectTamperedMoveRollback({ orderId, prepared, prefix: "stage11-extra-amendment" });
    } finally {
      await sql.raw(`
        DROP TRIGGER IF EXISTS qintopia_test_stage11_extra_amendment ON amendments;
        DROP FUNCTION IF EXISTS qintopia_test_stage11_extra_amendment()
      `).execute(db);
    }
  });

  it("rejects MOVE facts that are not the latest segment chain", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const orderId = await createOrder({
      prefix: "stage11-latest-chain",
      arrivalDate: shiftDate(businessDate, 1),
      departureDate: shiftDate(businessDate, 3)
    });
    const prepared = await preview({
      commandType: "MOVE_UNIT",
      input: { propertyId: demo.propertyId, orderId, newInventoryUnitId: demo.secondRoomId, effectiveDate: shiftDate(businessDate, 2) }
    }, "stage11-latest-chain");
    await sql.raw(`
      CREATE FUNCTION qintopia_test_stage11_later_segment() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE old_amendment_id text;
      BEGIN
        IF NEW.segment_type = 'MOVE' THEN
          SELECT amendment_id INTO STRICT old_amendment_id FROM stay_segments
            WHERE stay_id = NEW.stay_id AND sequence < NEW.sequence ORDER BY sequence LIMIT 1;
          INSERT INTO stay_segments (
            id, stay_id, sequence, inventory_unit_id, arrival_date, departure_date,
            segment_type, supersedes_segment_id, amendment_id
          ) VALUES (
            'segment_stage11_later', NEW.stay_id, NEW.sequence + 1, NEW.inventory_unit_id,
            NEW.arrival_date, NEW.departure_date, 'MOVE', NEW.id, old_amendment_id
          );
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER qintopia_test_stage11_later_segment AFTER INSERT ON stay_segments
        FOR EACH ROW EXECUTE FUNCTION qintopia_test_stage11_later_segment()
    `).execute(db);
    try {
      await expectTamperedMoveRollback({ orderId, prepared, prefix: "stage11-latest-chain" });
    } finally {
      await sql.raw(`
        DROP TRIGGER IF EXISTS qintopia_test_stage11_later_segment ON stay_segments;
        DROP FUNCTION IF EXISTS qintopia_test_stage11_later_segment()
      `).execute(db);
    }
  });

  it("rejects an inactive MOVE target and forged occupant/capacity snapshots", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const orderId = await createOrder({
      prefix: "stage11-target-snapshot",
      arrivalDate: shiftDate(businessDate, 1),
      departureDate: shiftDate(businessDate, 3)
    });
    const prepared = await preview({
      commandType: "MOVE_UNIT",
      input: { propertyId: demo.propertyId, orderId, newInventoryUnitId: demo.secondRoomId, effectiveDate: shiftDate(businessDate, 2) }
    }, "stage11-target-snapshot");
    await sql.raw(`
      CREATE FUNCTION qintopia_test_stage11_target_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.amendment_type = 'MOVE_UNIT' THEN
          NEW.payload := jsonb_set(jsonb_set(NEW.payload, '{occupantCount}', '999'::jsonb, false),
            '{occupancyCapacity}', '999'::jsonb, false);
        END IF;
        RETURN NEW;
      END $$;
      CREATE FUNCTION qintopia_test_stage11_deactivate_target() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.command_type = 'MOVE_UNIT' AND NEW.state = 'APPLIED' THEN
          UPDATE inventory_units SET active = false WHERE id = '${demo.secondRoomId}';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER qintopia_test_stage11_target_snapshot BEFORE INSERT ON amendments
        FOR EACH ROW EXECUTE FUNCTION qintopia_test_stage11_target_snapshot();
      CREATE TRIGGER qintopia_test_stage11_deactivate_target BEFORE UPDATE OF state ON command_executions
        FOR EACH ROW EXECUTE FUNCTION qintopia_test_stage11_deactivate_target()
    `).execute(db);
    try {
      await expectTamperedMoveRollback({ orderId, prepared, prefix: "stage11-target-snapshot" });
    } finally {
      await sql.raw(`
        DROP TRIGGER IF EXISTS qintopia_test_stage11_target_snapshot ON amendments;
        DROP TRIGGER IF EXISTS qintopia_test_stage11_deactivate_target ON command_executions;
        DROP FUNCTION IF EXISTS qintopia_test_stage11_target_snapshot();
        DROP FUNCTION IF EXISTS qintopia_test_stage11_deactivate_target()
      `).execute(db);
      await db.updateTable("inventory_units").set({ active: true }).where("id", "=", demo.secondRoomId).execute();
    }
  });

  it("rejects a member MOVE when the active membership product no longer covers the target", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const orderId = await createOrder({
      prefix: "stage11-member-product",
      arrivalDate: businessDate,
      departureDate: shiftDate(businessDate, 2),
      member: true
    });
    await execute({ commandType: "CHECK_IN", input: { propertyId: demo.propertyId, orderId } }, "stage11-member-product-checkin");
    const prepared = await preview({
      commandType: "MOVE_UNIT",
      input: { propertyId: demo.propertyId, orderId, newInventoryUnitId: memberTargetUnitId, effectiveDate: businessDate }
    }, "stage11-member-product");
    await sql`ALTER TABLE membership_orders DISABLE TRIGGER membership_orders_protect_identity`.execute(db);
    await sql.raw(`
      CREATE FUNCTION qintopia_test_stage11_member_product() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.amendment_type = 'MOVE_UNIT' THEN
          UPDATE membership_orders SET allowed_room_type_code = 'private_bath_single'
            WHERE contract_id = (SELECT member_contract_id FROM orders WHERE id = NEW.order_id);
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER qintopia_test_stage11_member_product BEFORE INSERT ON amendments
        FOR EACH ROW EXECUTE FUNCTION qintopia_test_stage11_member_product()
    `).execute(db);
    try {
      await expectTamperedMoveRollback({ orderId, prepared, prefix: "stage11-member-product" });
    } finally {
      await sql.raw(`
        DROP TRIGGER IF EXISTS qintopia_test_stage11_member_product ON amendments;
        DROP FUNCTION IF EXISTS qintopia_test_stage11_member_product()
      `).execute(db);
      await db.updateTable("membership_orders").set({ allowed_room_type_code: "shared_bath_single" })
        .where("contract_id", "=", demo.memberContractId).execute();
      await sql`ALTER TABLE membership_orders ENABLE TRIGGER membership_orders_protect_identity`.execute(db);
    }
  });

  it("binds MOVE funds arithmetic and entitlement migration dates to the persisted facts", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const orderId = await createOrder({
      prefix: "stage11-summary-binding",
      arrivalDate: shiftDate(businessDate, 1),
      departureDate: shiftDate(businessDate, 4),
      member: true
    });
    const prepared = await preview({
      commandType: "MOVE_UNIT",
      input: { propertyId: demo.propertyId, orderId, newInventoryUnitId: memberTargetUnitId, effectiveDate: shiftDate(businessDate, 2) }
    }, "stage11-summary-binding");
    await sql.raw(`
      CREATE FUNCTION qintopia_test_stage11_summary_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.amendment_type = 'MOVE_UNIT' THEN
          NEW.payload := jsonb_set(
            jsonb_set(NEW.payload, '{fundsSummary,collectionDifference,minorUnits}', '1'::jsonb, false),
            '{entitlementSummary,migratedHeldCoverageDates}', '[]'::jsonb, false
          );
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER qintopia_test_stage11_summary_binding BEFORE INSERT ON amendments
        FOR EACH ROW EXECUTE FUNCTION qintopia_test_stage11_summary_binding()
    `).execute(db);
    try {
      await expectTamperedMoveRollback({ orderId, prepared, prefix: "stage11-summary-binding" });
    } finally {
      await sql.raw(`
        DROP TRIGGER IF EXISTS qintopia_test_stage11_summary_binding ON amendments;
        DROP FUNCTION IF EXISTS qintopia_test_stage11_summary_binding()
      `).execute(db);
    }
  });

  it("rejects forged RELEASE/HOLD reasons even when MOVE ledger counts balance", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const orderId = await createOrder({
      prefix: "stage11-ledger-pair",
      arrivalDate: shiftDate(businessDate, 1),
      departureDate: shiftDate(businessDate, 4),
      member: true
    });
    const prepared = await preview({
      commandType: "MOVE_UNIT",
      input: { propertyId: demo.propertyId, orderId, newInventoryUnitId: memberTargetUnitId, effectiveDate: shiftDate(businessDate, 2) }
    }, "stage11-ledger-pair");
    await sql.raw(`
      CREATE FUNCTION qintopia_test_stage11_ledger_pair() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.command_id IS NOT NULL
          AND (SELECT command_type FROM command_executions WHERE id = NEW.command_id) = 'MOVE_UNIT' THEN
          NEW.reason := 'FORGED_MOVE_REASON';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER qintopia_test_stage11_ledger_pair BEFORE INSERT ON entitlement_ledger
        FOR EACH ROW EXECUTE FUNCTION qintopia_test_stage11_ledger_pair()
    `).execute(db);
    try {
      await expectTamperedMoveRollback({ orderId, prepared, prefix: "stage11-ledger-pair" });
    } finally {
      await sql.raw(`
        DROP TRIGGER IF EXISTS qintopia_test_stage11_ledger_pair ON entitlement_ledger;
        DROP FUNCTION IF EXISTS qintopia_test_stage11_ledger_pair()
      `).execute(db);
    }
  });

  it("serializes command writers with the Stage 11 protocol epoch lock", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const orderId = await createOrder({
      prefix: "stage11-protocol-epoch",
      arrivalDate: shiftDate(businessDate, 1),
      departureDate: shiftDate(businessDate, 3)
    });
    const blocker = new pg.Client({ connectionString: databaseUrl });
    await blocker.connect();
    await blocker.query("SELECT pg_advisory_lock(hashtextextended('qintopia:protocol-epoch', 0))");
    const pendingPreview = preview({
      commandType: "MOVE_UNIT",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newInventoryUnitId: demo.secondRoomId,
        effectiveDate: shiftDate(businessDate, 2)
      }
    }, "stage11-protocol-epoch");
    try {
      const outcome = await Promise.race([
        pendingPreview.then(() => "settled" as const),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 150))
      ]);
      expect(outcome).toBe("blocked");
    } finally {
      await blocker.query("SELECT pg_advisory_unlock(hashtextextended('qintopia:protocol-epoch', 0))");
      await blocker.end();
    }
    await expect(pendingPreview).resolves.toMatchObject({ preview: { commandType: "MOVE_UNIT" } });
  });

  it("locks the target inventory metadata before rebuilding a MOVE effect", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const orderId = await createOrder({
      prefix: "stage11-target-lock",
      arrivalDate: shiftDate(businessDate, 1),
      departureDate: shiftDate(businessDate, 3)
    });
    const prepared = await preview({
      commandType: "MOVE_UNIT",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newInventoryUnitId: demo.secondRoomId,
        effectiveDate: shiftDate(businessDate, 2)
      }
    }, "stage11-target-lock");
    const blocker = new pg.Client({ connectionString: databaseUrl });
    await blocker.connect();
    await blocker.query("BEGIN");
    await blocker.query("UPDATE inventory_units SET active = false WHERE id = $1", [demo.secondRoomId]);
    const pendingConfirmation = confirm(prepared, "stage11-target-lock");
    try {
      const outcome = await Promise.race([
        pendingConfirmation.then(() => "settled" as const),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 150))
      ]);
      expect(outcome).toBe("blocked");
    } finally {
      await blocker.query("ROLLBACK");
      await blocker.end();
    }
    await expect(pendingConfirmation).resolves.toMatchObject({
      executionStatus: "EXECUTED",
      businessCommitted: true
    });
  });

  it("rejects any MOVE payload field that differs from the confirmed Preview", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const orderId = await createOrder({
      prefix: "stage11-effect-evidence",
      arrivalDate: shiftDate(businessDate, 1),
      departureDate: shiftDate(businessDate, 3)
    });
    const prepared = await preview({
      commandType: "MOVE_UNIT",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newInventoryUnitId: demo.secondRoomId,
        effectiveDate: shiftDate(businessDate, 2)
      }
    }, "stage11-effect-evidence");
    await sql.raw(`
      CREATE FUNCTION qintopia_test_stage11_extra_effect_field() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.amendment_type = 'MOVE_UNIT' THEN
          NEW.payload := NEW.payload || '{"forgedUnboundField":"must-not-commit"}'::jsonb;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER qintopia_test_stage11_extra_effect_field BEFORE INSERT ON amendments
        FOR EACH ROW EXECUTE FUNCTION qintopia_test_stage11_extra_effect_field()
    `).execute(db);
    try {
      await expectTamperedMoveRollback({ orderId, prepared, prefix: "stage11-effect-evidence" });
    } finally {
      await sql.raw(`
        DROP TRIGGER IF EXISTS qintopia_test_stage11_extra_effect_field ON amendments;
        DROP FUNCTION IF EXISTS qintopia_test_stage11_extra_effect_field()
      `).execute(db);
    }
  });

  it("keeps stored Preview expiry and protocol evidence immutable", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const orderId = await createOrder({
      prefix: "stage11-preview-immutable",
      arrivalDate: shiftDate(businessDate, 1),
      departureDate: shiftDate(businessDate, 3)
    });
    const prepared = await preview({
      commandType: "MOVE_UNIT",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newInventoryUnitId: demo.secondRoomId,
        effectiveDate: shiftDate(businessDate, 2)
      }
    }, "stage11-preview-immutable");

    await expect(db.updateTable("command_previews")
      .set({ expires_at: new Date(Date.now() - 1_000) })
      .where("id", "=", prepared.preview.previewId)
      .execute()).rejects.toMatchObject({ constraint: "stage11_preview_evidence_immutable" });
  });

  it("rejects a MOVE receipt whose effect hash does not bind the persisted amendment payload", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const orderId = await createOrder({
      prefix: "stage11-receipt-effect-hash",
      arrivalDate: shiftDate(businessDate, 1),
      departureDate: shiftDate(businessDate, 3)
    });
    const prepared = await preview({
      commandType: "MOVE_UNIT",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newInventoryUnitId: demo.secondRoomId,
        effectiveDate: shiftDate(businessDate, 2)
      }
    }, "stage11-receipt-effect-hash");
    await sql.raw(`
      CREATE FUNCTION qintopia_test_stage11_receipt_effect_hash() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (SELECT command_type FROM command_executions WHERE id = NEW.command_id) = 'MOVE_UNIT' THEN
          NEW.result := jsonb_set(NEW.result, '{effectHash}', to_jsonb(repeat('f', 64)), false);
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER qintopia_test_stage11_receipt_effect_hash BEFORE INSERT ON command_receipts
        FOR EACH ROW EXECUTE FUNCTION qintopia_test_stage11_receipt_effect_hash()
    `).execute(db);
    try {
      await expectTamperedMoveRollback({ orderId, prepared, prefix: "stage11-receipt-effect-hash" });
    } finally {
      await sql.raw(`
        DROP TRIGGER IF EXISTS qintopia_test_stage11_receipt_effect_hash ON command_receipts;
        DROP FUNCTION IF EXISTS qintopia_test_stage11_receipt_effect_hash()
      `).execute(db);
    }
  });

  it("rejects a non-member MOVE with a missing entitlement summary", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const orderId = await createOrder({
      prefix: "stage11-nonmember-summary",
      arrivalDate: shiftDate(businessDate, 1),
      departureDate: shiftDate(businessDate, 3)
    });
    const prepared = await preview({
      commandType: "MOVE_UNIT",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newInventoryUnitId: demo.secondRoomId,
        effectiveDate: shiftDate(businessDate, 2)
      }
    }, "stage11-nonmember-summary");
    await sql.raw(`
      CREATE FUNCTION qintopia_test_stage11_drop_entitlement_summary() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.amendment_type = 'MOVE_UNIT' THEN
          NEW.payload := NEW.payload - 'entitlementSummary';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER qintopia_test_stage11_drop_entitlement_summary BEFORE INSERT ON amendments
        FOR EACH ROW EXECUTE FUNCTION qintopia_test_stage11_drop_entitlement_summary()
    `).execute(db);
    try {
      await expectTamperedMoveRollback({ orderId, prepared, prefix: "stage11-nonmember-summary" });
    } finally {
      await sql.raw(`
        DROP TRIGGER IF EXISTS qintopia_test_stage11_drop_entitlement_summary ON amendments;
        DROP FUNCTION IF EXISTS qintopia_test_stage11_drop_entitlement_summary()
      `).execute(db);
    }
  });

  it("rejects a date-change amendment that is not the aggregate's latest sequence", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const orderId = await createOrder({
      prefix: "stage11-date-change-chain",
      arrivalDate: shiftDate(businessDate, 2),
      departureDate: shiftDate(businessDate, 4)
    });
    const prepared = await preview({
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newArrivalDate: shiftDate(businessDate, 3),
        newDepartureDate: shiftDate(businessDate, 5)
      }
    }, "stage11-date-change-chain");
    const before = await businessSnapshot(orderId);
    await sql.raw(`
      CREATE FUNCTION qintopia_test_stage11_date_change_branch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.amendment_type = 'RESCHEDULE_STAY' THEN
          INSERT INTO amendments (
            id, order_id, sequence, amendment_type, reason_code, reason_note,
            prior_version, new_version, payload, command_id
          ) VALUES (
            'amend_stage11_date_change_branch', NEW.order_id, NEW.sequence + 1,
            'REPRICE_ORDER', 'FORGED', 'forged aggregate branch',
            NEW.new_version, NEW.new_version + 1, '{}'::jsonb, NULL
          );
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER qintopia_test_stage11_date_change_branch AFTER INSERT ON amendments
        FOR EACH ROW EXECUTE FUNCTION qintopia_test_stage11_date_change_branch()
    `).execute(db);
    try {
      const receipt = await confirm(prepared, "stage11-date-change-chain");
      expect(receipt).toMatchObject({
        executionStatus: "NOT_EXECUTED",
        businessCommitted: false,
        error: { code: "COMMAND_INTERRUPTED" }
      });
      expect(await businessSnapshot(orderId)).toEqual(before);
    } finally {
      await sql.raw(`
        DROP TRIGGER IF EXISTS qintopia_test_stage11_date_change_branch ON amendments;
        DROP FUNCTION IF EXISTS qintopia_test_stage11_date_change_branch()
      `).execute(db);
    }
  });

  it("binds a legal external-channel RESCHEDULE receipt to its persisted amendment and Preview hash", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const arrivalDate = shiftDate(businessDate, 3);
    const departureDate = shiftDate(businessDate, 5);
    const orderId = await createOrder({
      prefix: "stage11-channel-reschedule-evidence",
      arrivalDate,
      departureDate,
      channel: "MEITUAN"
    });
    const prepared = await preview({
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newArrivalDate: arrivalDate,
        newDepartureDate: shiftDate(departureDate, 1),
        targetCurrentContractAmountMinor: 69_600,
        channelPriceDifferenceReason: "美团确认延住后的本单渠道应结金额"
      }
    }, "stage11-channel-reschedule-evidence");
    const receipt = await confirm(prepared, "stage11-channel-reschedule-evidence");
    expect(receipt).toMatchObject({
      executionStatus: "EXECUTED",
      businessCommitted: true,
      result: { effectHash: prepared.preview.effectHash }
    });
    const amendment = await db.selectFrom("amendments")
      .select(["payload", "command_id"])
      .where("id", "=", receipt.result!.amendmentId as string)
      .executeTakeFirstOrThrow();
    expect(amendment.command_id).toBe(receipt.commandId);
    expect(amendment.payload).toEqual(prepared.preview.effect);
  });

  it("rolls back every MOVE business fact when the pricing revision insert fails", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const orderId = await createOrder({
      prefix: "stage11-rollback",
      arrivalDate: shiftDate(businessDate, 1),
      departureDate: shiftDate(businessDate, 4)
    });
    const prepared = await preview({
      commandType: "MOVE_UNIT",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newInventoryUnitId: demo.secondRoomId,
        effectiveDate: shiftDate(businessDate, 2)
      }
    }, "stage11-rollback");
    const before = await businessSnapshot(orderId);
    await sql`
      CREATE FUNCTION qintopia_stage11_test_fail_revision() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM amendments WHERE id = NEW.amendment_id AND amendment_type = 'MOVE_UNIT') THEN
          RAISE EXCEPTION 'stage11 injected revision failure';
        END IF;
        RETURN NEW;
      END;
      $$;
    `.execute(db);
    await sql`CREATE TRIGGER stage11_test_fail_revision BEFORE INSERT ON pricing_revisions FOR EACH ROW EXECUTE FUNCTION qintopia_stage11_test_fail_revision()`.execute(db);
    try {
      const receipt = await confirm(prepared, "stage11-rollback");
      expect(receipt).toMatchObject({
        executionStatus: "NOT_EXECUTED",
        businessCommitted: false,
        error: { code: "COMMAND_INTERRUPTED" },
        resourceRefs: [],
        factRefs: []
      });
      expect(await businessSnapshot(orderId)).toEqual(before);
    } finally {
      await sql`DROP TRIGGER IF EXISTS stage11_test_fail_revision ON pricing_revisions`.execute(db);
      await sql`DROP FUNCTION IF EXISTS qintopia_stage11_test_fail_revision()`.execute(db);
    }
  });
});

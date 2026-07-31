import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthPrincipal, CommandEnvelope, ReceiptDto, StayType } from "@qintopia/contracts";
import {
  confirmCommandPreview,
  createCommandPreview,
  getOrderView,
  type Database
} from "@qintopia/db";
import type { Kysely } from "kysely";
import { enumerateServiceDates, paidStayTypeForNights } from "@qintopia/domain";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { resetTestDatabase } from "../helpers/database.ts";

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
  return {
    idempotencyKey: `${prefix}-${sequence}`,
    correlationId: `${prefix}-${sequence}`
  };
}

async function previewAndConfirm(envelope: CommandEnvelope, prefix: string): Promise<ReceiptDto> {
  const preview = await createCommandPreview(db, principal, envelope, metadata(`${prefix}-preview`));
  return confirmCommandPreview(db, principal, preview.preview.previewId, {
    propertyId: envelope.input.propertyId as string,
    commandType: envelope.commandType,
    confirmation: true,
    expectedEffectHash: preview.preview.effectHash,
    reason: envelope.commandType === "CREATE_ORDER"
      ? { code: "CREATE_STANDARD_ORDER", note: "" }
      : { code: "REAL_PRICING_ACCEPTANCE", note: `Confirmed database pricing fact: ${prefix}` }
  }, metadata(`${prefix}-confirm`));
}

async function createOrder(options: {
  prefix: string;
  unitId: string;
  arrivalDate: string;
  departureDate: string;
  stayType?: StayType;
  freeStayReason?: string;
}) {
  const stayType = options.stayType ?? paidStayTypeForNights(enumerateServiceDates(options.arrivalDate, options.departureDate).length);
  const quote = await createQuoteForTesting(db, {
    propertyId: demo.propertyId,
    inventoryUnitId: options.unitId,
    stayType,
    arrivalDate: options.arrivalDate,
    departureDate: options.departureDate,
    pricingPolicyVersionId: stayType === "FREE" ? demo.freePolicyId : demo.publicPricingPolicyId
  });
  const receipt = await previewAndConfirm({
    commandType: "CREATE_ORDER",
    input: {
      propertyId: demo.propertyId,
      quoteId: quote.quoteId,
      primaryGuest: { fullName: `Pricing Guest ${options.prefix}`, nickname: `Pricing ${options.prefix}` },
      ...(stayType !== "FREE" ? {
        bookingChannelCode: "YOUMUDAO",
        channelOrderReference: `REAL-PRICE-${options.prefix}`,
        targetCurrentContractAmountMinor: quote.currentContractAmount.minorUnits
      } : {}),
      ...(stayType === "FREE" ? { freeStayReason: options.freeStayReason ?? "Confirmed complimentary stay", freeStayCategoryCode: "VOLUNTEER" } : {})
    }
  }, `${options.prefix}-create`);
  return { quote, orderId: receipt.result!.orderId as string };
}

beforeEach(async () => {
  db = await resetTestDatabase();
});

afterEach(async () => {
  await db.destroy();
});

describe.sequential("QinTopia 2026 pricing policy on PostgreSQL", () => {
  it("seeds the 44-room, 91-bed, 77-base-unit catalog and enforces the policy effective date", async () => {
    const [rooms, beds, baseUnits, combinations, physicalBeds] = await Promise.all([
      db.selectFrom("inventory_units").select(({ fn }) => fn.countAll<number>().as("count")).where("kind", "=", "ROOM").executeTakeFirstOrThrow(),
      db.selectFrom("inventory_units").select(({ fn }) => fn.countAll<number>().as("count")).where("kind", "=", "BED").executeTakeFirstOrThrow(),
      db.selectFrom("inventory_units").select(({ fn }) => fn.countAll<number>().as("count")).where("inventory_basis", "=", "INDEPENDENT").executeTakeFirstOrThrow(),
      db.selectFrom("inventory_units").select(({ fn }) => fn.countAll<number>().as("count")).where("inventory_basis", "=", "WHOLE_ROOM_COMBINATION").executeTakeFirstOrThrow(),
      db.selectFrom("inventory_units").select(({ fn }) => fn.sum<number>("physical_bed_count").as("count")).where("kind", "=", "ROOM").executeTakeFirstOrThrow()
    ]);
    expect(Number(rooms.count)).toBe(44);
    expect(Number(beds.count)).toBe(46);
    expect(Number(baseUnits.count)).toBe(77);
    expect(Number(combinations.count)).toBe(13);
    expect(Number(physicalBeds.count)).toBe(91);

    await expect(createQuoteForTesting(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.bedAId,
      stayType: "TRANSIENT",
      arrivalDate: "2026-02-24",
      departureDate: "2026-02-25",
      pricingPolicyVersionId: demo.publicPricingPolicyId
    })).rejects.toMatchObject({ code: "PRICING_POLICY_UNCONFIGURED" });

    const effective = await createQuoteForTesting(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.bedAId,
      stayType: "TRANSIENT",
      arrivalDate: "2026-02-25",
      departureDate: "2026-02-26",
      pricingPolicyVersionId: demo.publicPricingPolicyId
    });
    expect(effective.currentContractAmount.minorUnits).toBe(5_800);
  });

  it("automatically uses the 7-night band for room 104 across a calendar month", async () => {
    const quote = await createQuoteForTesting(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: "unit_room_104",
      stayType: "CUSTOM",
      arrivalDate: "2026-07-26",
      departureDate: "2026-08-05",
      pricingPolicyVersionId: demo.publicPricingPolicyId
    });

    expect(quote.currentContractAmount.minorUnits).toBe(108_600);
    expect(quote.cashLines).toEqual([
      expect.objectContaining({ lineKind: "STAY_TOTAL", pricingBandAnchorNights: 7 })
    ]);

    await expect(createQuoteForTesting(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: "unit_room_104",
      stayType: "TRANSIENT",
      arrivalDate: "2026-07-26",
      departureDate: "2026-08-05",
      pricingPolicyVersionId: demo.publicPricingPolicyId
    })).rejects.toMatchObject({
      code: "PRICING_POLICY_UNCONFIGURED",
      message: "住宿类型与 10 晚住宿不一致，请重新报价"
    });
  });

  it("returns a concrete business conflict while preserving the original order", async () => {
    await createOrder({
      prefix: "stage-one-conflict",
      unitId: "unit_room_104",
      arrivalDate: "2026-08-10",
      departureDate: "2026-08-12"
    });

    await expect(createQuoteForTesting(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: "unit_room_104",
      stayType: "TRANSIENT",
      arrivalDate: "2026-08-11",
      departureDate: "2026-08-13",
      pricingPolicyVersionId: demo.publicPricingPolicyId
    })).rejects.toMatchObject({
      code: "INVENTORY_CONFLICT",
      message: "104 在 2026-08-11 至 2026-08-12 已有住宿，不能重复安排",
      details: {
        inventoryUnitCode: "104",
        overlapStartDate: "2026-08-11",
        overlapEndDate: "2026-08-12",
        claimIds: [expect.stringMatching(/^claim_/)]
      }
    });

    const orders = await db.selectFrom("orders").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow();
    expect(Number(orders.count)).toBe(1);
  });

  it("uses one cumulative band across a product move and drops a prior manual target on the next revision", async () => {
    const room201Id = "unit_room_201";
    const created = await createOrder({
      prefix: "cross-product",
      unitId: demo.bedAId,
      arrivalDate: "2026-09-01",
      departureDate: "2026-09-15"
    });
    expect(created.quote.currentContractAmount.minorUnits).toBe(48_000);

    const lockedPolicy = await db.selectFrom("pricing_policy_versions").selectAll()
      .where("id", "=", demo.publicPricingPolicyId).executeTakeFirstOrThrow();
    const laterAnchors = structuredClone(lockedPolicy.product_anchor_rates_minor) as Record<string, Record<string, number>>;
    laterAnchors.shared_bath_quad_bed = { "1": 99_900, "7": 699_300, "14": 1_398_600, "30": 2_997_000 };
    laterAnchors.shared_bath_single_room = { "1": 88_800, "7": 621_600, "14": 1_243_200, "30": 2_664_000 };
    await db.insertInto("pricing_policy_versions").values({
      id: "policy_qintopia_public_2026_later_v2",
      property_id: demo.propertyId,
      code: lockedPolicy.code,
      version: 2,
      stay_type: null,
      calculation_kind: "DURATION_BAND_TOTAL",
      nightly_rate_minor: null,
      product_anchor_rates_minor: laterAnchors,
      effective_from: "2026-03-01",
      effective_until: null,
      rounding_rule: "FINAL_TOTAL_WHOLE_YUAN_HALF_UP",
      currency: "CNY",
      status: "PUBLISHED"
    }).execute();

    await previewAndConfirm({
      commandType: "REPRICE_ORDER",
      input: {
        propertyId: demo.propertyId,
        orderId: created.orderId,
        targetCurrentContractAmountMinor: 70_000
      }
    }, "cross-product-manual-target");
    let view = await getOrderView(db, created.orderId);
    expect(view.amounts.currentContractAmount.minorUnits).toBe(70_000);

    await previewAndConfirm({
      commandType: "MOVE_UNIT",
      input: {
        propertyId: demo.propertyId,
        orderId: created.orderId,
        newInventoryUnitId: room201Id,
        effectiveDate: "2026-09-08",
        targetCurrentContractAmountMinor: 65_000
      }
    }, "cross-product-move");
    view = await getOrderView(db, created.orderId);
    expect(view.amounts.currentContractAmount.minorUnits).toBe(65_000);
    expect(view.pricingRevisions.at(-1)?.policy_version_id).toBe(demo.publicPricingPolicyId);
    expect(view.pricingRevisions.at(-1)?.policy_base_amount_minor).toBe(65_000);
    expect(view.pricingRevisions.at(-1)?.manual_adjustment_minor).toBe(0);
    expect(view.pricingRevisions.at(-1)?.cash_lines).toEqual([
      expect.objectContaining({
        lineKind: "STAY_TOTAL",
        pricingBandAnchorNights: 14,
        calculationSegments: [
          expect.objectContaining({ inventoryUnitId: demo.bedAId, nights: 7, anchorAmountMinor: 48_000 }),
          expect.objectContaining({ inventoryUnitId: room201Id, nights: 7, anchorAmountMinor: 82_000 })
        ]
      })
    ]);
  });

  it("keeps FREE changes zero, entitlement-free, and append-only through cancellation", async () => {
    const created = await createOrder({
      prefix: "free-history",
      unitId: "unit_room_201",
      arrivalDate: "2026-08-30",
      departureDate: "2026-09-02",
      stayType: "FREE",
      freeStayReason: "Volunteer accommodation"
    });
    await previewAndConfirm({
      commandType: "RESCHEDULE_STAY",
      input: { propertyId: demo.propertyId, orderId: created.orderId, newArrivalDate: "2026-08-30", newDepartureDate: "2026-09-04" }
    }, "free-extend");
    await previewAndConfirm({
      commandType: "RESCHEDULE_STAY",
      input: { propertyId: demo.propertyId, orderId: created.orderId, newArrivalDate: "2026-08-30", newDepartureDate: "2026-09-03" }
    }, "free-shorten");
    await previewAndConfirm({
      commandType: "MOVE_UNIT",
      input: { propertyId: demo.propertyId, orderId: created.orderId, newInventoryUnitId: "unit_room_205", effectiveDate: "2026-09-01" }
    }, "free-move");
    await previewAndConfirm({
      commandType: "CANCEL_ORDER",
      input: { propertyId: demo.propertyId, orderId: created.orderId }
    }, "free-cancel");

    const view = await getOrderView(db, created.orderId);
    expect(view.order.status).toBe("CANCELLED");
    expect(view.order.free_stay_reason).toBe("Volunteer accommodation");
    expect(view.pricingRevisions).toHaveLength(5);
    expect(view.pricingRevisions.every((revision) => (
      revision.current_contract_amount_minor === 0
      && revision.manual_adjustment_minor === 0
      && (revision.coverage_set as unknown[]).length === 0
    ))).toBe(true);
    expect(view.coverageSet).toEqual([]);
    expect(view.amounts.currentContractAmount.minorUnits).toBe(0);
  });
});

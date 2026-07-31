import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { commandTypes, type CommandType } from "@qintopia/contracts";
import { newOpaqueSecret, parseLocalDate, todayInTimeZone } from "@qintopia/domain";
import type { Database } from "@qintopia/db";
import type { Kysely } from "kysely";
import { CommandEffectSchema, ReceiptSchema } from "../../apps/api/src/schemas.ts";
import { buildServer } from "../../apps/api/src/server.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { resetDatabase } from "../helpers/database.ts";

const effectContractDatabaseUrl = process.env.EFFECT_CONTRACT_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_effect_contract";

const expectedEffectKeys: Record<CommandType, string[]> = {
  CREATE_MEMBER: ["member", "memberId", "operation", "propertyLink"],
  CREATE_MEMBERSHIP_ORDER: ["member", "operation", "pricing", "product", "status"],
  RECORD_MEMBERSHIP_PAYMENT: ["memberName", "membershipOrderId", "operation", "payment", "productName", "status", "totals"],
  CORRECT_MEMBERSHIP_PAYMENT: ["memberName", "membershipOrderId", "operation", "original", "originalPaymentFactId", "productName", "replacement", "status", "totals"],
  ACTIVATE_MEMBERSHIP_ORDER: ["agreedPrice", "entitlementUnitKind", "entitlementUnits", "fromStatus", "memberName", "membershipOrderId", "operation", "paymentDifference", "paymentTotal", "productName", "toStatus", "validFrom", "validUntil"],
  CREATE_ORDER: ["arrivalDate", "bookingChannelCode", "channelOrderReference", "departureDate", "freeStayCategoryCode", "freeStayReason", "inventoryUnit", "memberContractId", "memberId", "occupancyCapacity", "occupants", "pricing", "pricingDecision", "pricingPolicyVersionId", "primaryGuest", "quoteId", "stayType"],
  CORRECT_ORDER_OCCUPANT: ["after", "before", "occupantId", "operation", "orderId", "ordinal", "role"],
  RESCHEDULE_STAY: ["after", "before", "entitlementChange", "fundsSummary", "inventoryChange", "inventoryUnitId", "operation", "orderId", "pricingDecision", "stayId"],
  EXTEND_STAY: ["after", "before", "entitlementChange", "fundsSummary", "inventoryChange", "inventoryUnitId", "operation", "orderId", "pricingDecision", "stayId"],
  SHORTEN_STAY: ["after", "before", "businessDate", "completionMode", "entitlementSummary", "fundsSummary", "inventoryChange", "inventoryUnitId", "operation", "orderId", "pricingDecision", "refundReferenceAmount", "stayId"],
  MOVE_UNIT: [
    "after", "before", "businessDate", "effectiveDate", "entitlementSummary", "fundsSummary", "inventoryChange",
    "occupancyCapacity", "occupantCount", "operation", "orderId", "pricingDecision", "stayId", "toInventoryUnit"
  ],
  REPRICE_ORDER: ["before", "inventoryUnitId", "manualAdjustmentMinor", "orderId", "policyBaseAmount", "pricing", "stayTimeline", "targetCurrentContractAmount"],
  CANCEL_ORDER: ["currentContractAmount", "entitlementTransition", "freeStayCategoryCode", "freeStayReason", "fromStatus", "inventoryUnitId", "orderId", "toStatus"],
  MARK_NO_SHOW: ["currentContractAmount", "entitlementTransition", "freeStayCategoryCode", "freeStayReason", "fromStatus", "inventoryUnitId", "orderId", "toStatus"],
  LOCK_MAINTENANCE: ["arrivalDate", "departureDate", "inventoryUnit", "reason"],
  RELEASE_MAINTENANCE: ["arrivalDate", "departureDate", "inventoryUnitId", "maintenanceLockId"],
  COMPLETE_CLEANING: ["cleaningTaskId", "fromStatus", "inventoryUnitId", "orderId", "roomId", "serviceDate", "stayId", "toStatus"],
  RECORD_COLLECTION: ["amountMinor", "currency", "method", "note", "orderId", "transactionReference"],
  RECORD_REFUND: ["amountMinor", "currency", "method", "note", "orderId", "referencesFactId", "transactionReference"],
  REVERSE_FACT: ["amountMinor", "currency", "netEffectMinor", "note", "orderId", "reversesFactId"],
  CHECK_IN: ["businessDate", "effectiveDate", "entitlementTransition", "fromStatus", "inventoryUnitId", "orderId", "recordingMode", "toStatus"],
  CHECK_OUT: ["amounts", "businessDate", "effectiveDate", "fromStatus", "inventoryUnitId", "orderId", "recordingMode", "toStatus"],
  REFRESH_MEMBER_COVERAGE: ["before", "inventoryUnitId", "orderId", "pricing", "stayTimeline"],
  ADD_MEMBER_ENTITLEMENT_LOT: ["contractId", "expiresOn", "unitKind", "units"],
  ADJUST_MEMBER_ENTITLEMENT: ["adjustmentReason", "availableAfter", "availableBefore", "contractId", "entitlementLotId", "quantityDelta", "unitKind"],
  CORRECT_MEMBER_ENTITLEMENT_BALANCE: ["adjustmentReason", "availableAfter", "availableBefore", "contractId", "entitlementLotId", "quantityDelta", "unitKind"],
  EXPIRE_MEMBER_ENTITLEMENT: ["asOfDate", "contractId", "entitlementLotId", "entryType", "expiresOn", "quantityDelta", "remainingAvailable", "unitKind"],
  ISSUE_TOKEN: ["accessCeiling", "expiresAt", "label", "subjectId"],
  ROTATE_TOKEN: ["accessCeiling", "expiresAt", "label", "operation", "subjectId", "tokenId"],
  REVOKE_TOKEN: ["accessCeiling", "expiresAt", "label", "operation", "subjectId", "tokenId"]
};

type Preview = {
  previewId: string;
  commandType: CommandType;
  effectHash: string;
  effect: Record<string, unknown>;
};

let app: FastifyInstance;
let db: Kysely<Database>;
let sequence = 0;

function shiftLocalDate(value: string, days: number): string {
  const date = parseLocalDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function headers(prefix: string) {
  sequence += 1;
  return {
    authorization: `Bearer ${demo.writeToken}`,
    "content-type": "application/json",
    "idempotency-key": `${prefix}-${sequence}`,
    "x-correlation-id": `${prefix}-${sequence}`
  };
}

async function requestPreview(commandType: CommandType, input: Record<string, unknown>): Promise<Preview> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/command-previews",
    headers: headers(`effect-${commandType.toLowerCase()}-preview`),
    payload: { commandType, input }
  });
  expect(response.statusCode, `${commandType}: ${response.body}`).toBe(200);
  const preview = (response.json() as { preview: Preview }).preview;
  expect(preview.commandType).toBe(commandType);
  expect(Object.keys(preview.effect).sort(), commandType).toEqual(expectedEffectKeys[commandType]);
  expect(Value.Check(CommandEffectSchema, preview.effect), `${commandType}: ${JSON.stringify(preview.effect)}`).toBe(true);
  return preview;
}

async function confirm(preview: Preview): Promise<Record<string, unknown>> {
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/command-previews/${preview.previewId}/confirm`,
    headers: headers(`effect-${preview.commandType.toLowerCase()}-confirm`),
    payload: {
      propertyId: demo.propertyId,
      commandType: preview.commandType,
      confirmation: true,
      expectedEffectHash: preview.effectHash,
      reason: preview.commandType === "CREATE_ORDER"
        ? { code: "CREATE_STANDARD_ORDER", note: "" }
        : { code: "EFFECT_CONTRACT", note: `Prepare state for ${preview.commandType} effect coverage` }
    }
  });
  expect(response.statusCode, `${preview.commandType}: ${response.body}`).toBe(200);
  return (response.json() as { result: Record<string, unknown> }).result;
}

async function quote(options: {
  arrivalDate?: string;
  departureDate?: string;
  inventoryUnitId?: string;
  memberId?: string;
  pricingPolicyVersionId?: string;
} = {}) {
  const propertyToday = todayInTimeZone("Asia/Shanghai");
  const arrivalDate = options.arrivalDate ?? propertyToday;
  const departureDate = options.departureDate ?? shiftLocalDate(propertyToday, 4);
  const pricingPolicyVersionId = options.pricingPolicyVersionId
    ?? (arrivalDate.slice(0, 7) === departureDate.slice(0, 7)
      ? demo.transientPolicyId
      : demo.publicPricingPolicyId);
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/quotes",
    headers: headers("effect-create-quote"),
    payload: {
      propertyId: demo.propertyId,
      inventoryUnitId: options.inventoryUnitId ?? demo.roomId,
      stayType: "TRANSIENT",
      arrivalDate,
      departureDate,
      pricingPolicyVersionId,
      ...(options.memberId ? { memberId: options.memberId } : {})
    }
  });
  expect(response.statusCode, response.body).toBe(200);
  return (response.json() as { quote: { quoteId: string; currentContractAmount: { minorUnits: number } } }).quote;
}

beforeAll(async () => {
  process.env.LOG_LEVEL = "silent";
  process.env.BEARER_AUTH_RATE_LIMIT_MAX = "5000";
  FormatRegistry.Set("date-time", (value) => typeof value === "string" && Number.isFinite(Date.parse(value)));
  db = await resetDatabase(effectContractDatabaseUrl);
  app = await buildServer(db);
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
});

describe("Command effect HTTP contract", () => {
  it("accepts only the persisted MOVE_UNIT receipt result shape", () => {
    const inventoryUnit = {
      id: "unit_move_contract",
      propertyId: "property_move_contract",
      kind: "ROOM",
      roomId: "room_move_contract",
      code: "101",
      name: "101",
      catalogVersion: null,
      buildingCode: null,
      roomTypeCode: "STANDARD",
      pricingProductCode: "STANDARD",
      inventoryBasis: "INDEPENDENT",
      codeProvenance: "SOURCE_EXPLICIT",
      physicalBedCount: 1,
      occupancyCapacity: 2
    };
    const stayTimeline = [
      { serviceDate: "2028-04-10", inventoryUnitId: "unit_move_contract" },
      { serviceDate: "2028-04-11", inventoryUnitId: "unit_move_target" }
    ];
    const pricing = {
      coverageSet: [],
      cashLines: [],
      cashRemainder: { currency: "CNY", minorUnits: 20_000 },
      currentContractAmount: { currency: "CNY", minorUnits: 20_000 }
    };
    const pricingDecision = {
      pricingBasis: "POLICY",
      policyBaseAmount: { currency: "CNY", minorUnits: 20_000 },
      targetCurrentContractAmount: { currency: "CNY", minorUnits: 20_000 },
      differenceFromPolicy: { currency: "CNY", minorUnits: 0 },
      manualAdjustmentMinor: 0,
      differenceExceedsThreshold: false,
      reason: { code: "MOVE_UNIT_POLICY", note: "" }
    };
    const receipt = {
      receiptId: "receipt_move_contract",
      commandId: "command_move_contract",
      executionStatus: "EXECUTED",
      businessCommitted: true,
      correlationId: "move-unit-result-contract",
      result: {
        orderId: "order_move_contract",
        stayId: "stay_move_contract",
        amendmentId: "amendment_move_contract",
        staySegmentId: "segment_move_contract",
        pricingRevisionId: "pricing_revision_move_contract",
        effectHash: "a".repeat(64),
        businessDate: "2028-04-10",
        effectiveDate: "2028-04-11",
        before: {
          arrivalDate: "2028-04-10",
          departureDate: "2028-04-12",
          nights: 2,
          currentContractAmount: { currency: "CNY", minorUnits: 20_000 },
          stayTimeline: [
            { serviceDate: "2028-04-10", inventoryUnitId: "unit_move_contract" },
            { serviceDate: "2028-04-11", inventoryUnitId: "unit_move_contract" }
          ],
          actualCurrentInventoryUnit: null,
          effectiveDateInventoryUnit: inventoryUnit
        },
        after: {
          arrivalDate: "2028-04-10",
          departureDate: "2028-04-12",
          nights: 2,
          stayTimeline,
          pricing
        },
        pricingDecision,
        inventoryChange: {
          preservedClaims: [{ serviceDate: "2028-04-10", inventoryUnitId: "unit_move_contract" }],
          releasedClaims: [{ serviceDate: "2028-04-11", inventoryUnitId: "unit_move_contract" }],
          addedClaims: [{ serviceDate: "2028-04-11", inventoryUnitId: "unit_move_target" }]
        },
        entitlementSummary: {
          preservedCoverageDates: [],
          migratedHeldCoverageDates: [],
          consumedCoverageDates: [],
          ledgerWriteCount: 0
        },
        fundsSummary: {
          netRecordedCollection: { currency: "CNY", minorUnits: 0 },
          collectionDifference: { currency: "CNY", minorUnits: 20_000 },
          factCount: 0
        }
      },
      resourceRefs: [],
      factRefs: []
    };
    expect(Value.Check(ReceiptSchema, receipt)).toBe(true);
    expect(Value.Check(ReceiptSchema, {
      ...receipt,
      result: { ...receipt.result, unexpected: true }
    })).toBe(false);
  });

  it("requires CREATE_MEMBER previews to keep the internal member id unset", () => {
    expect(Value.Check(CommandEffectSchema, {
      operation: "CREATE_MEMBER_PROFILE",
      memberId: "member_leaked",
      member: {
        fullName: "Contract Member",
        identityCardNumber: "CONTRACT-MEMBER-ID",
        phone: "13800000000",
        wechat: "contract-member"
      },
      propertyLink: { operation: "CREATE" }
    })).toBe(false);
  });

  it("requires SHORTEN_STAY to freeze the authoritative collection fact count", () => {
    const effect = {
      operation: "SHORTEN_STAY",
      orderId: "order_contract",
      stayId: "stay_contract",
      inventoryUnitId: "room_contract",
      businessDate: "2026-07-30",
      completionMode: "SHORTEN_IN_HOUSE",
      before: {
        arrivalDate: "2026-07-28",
        departureDate: "2026-08-02",
        nights: 5,
        currentContractAmount: { currency: "CNY", minorUnits: 58_000 },
        stayTimeline: [
          { serviceDate: "2026-07-28", inventoryUnitId: "room_contract" },
          { serviceDate: "2026-07-29", inventoryUnitId: "room_contract" },
          { serviceDate: "2026-07-30", inventoryUnitId: "room_contract" },
          { serviceDate: "2026-07-31", inventoryUnitId: "room_contract" },
          { serviceDate: "2026-08-01", inventoryUnitId: "room_contract" }
        ]
      },
      after: {
        arrivalDate: "2026-07-28",
        departureDate: "2026-07-31",
        nights: 3,
        stayTimeline: [
          { serviceDate: "2026-07-28", inventoryUnitId: "room_contract" },
          { serviceDate: "2026-07-29", inventoryUnitId: "room_contract" },
          { serviceDate: "2026-07-30", inventoryUnitId: "room_contract" }
        ],
        pricing: {
          coverageSet: [],
          cashLines: [],
          cashRemainder: { currency: "CNY", minorUnits: 34_800 },
          currentContractAmount: { currency: "CNY", minorUnits: 34_800 }
        }
      },
      pricingDecision: {
        pricingBasis: "POLICY",
        policyBaseAmount: { currency: "CNY", minorUnits: 34_800 },
        targetCurrentContractAmount: { currency: "CNY", minorUnits: 34_800 },
        differenceFromPolicy: { currency: "CNY", minorUnits: 0 },
        manualAdjustmentMinor: 0,
        differenceExceedsThreshold: false,
        reason: { code: "STAY_CHANGE_POLICY", note: "" }
      },
      inventoryChange: {
        preservedDates: ["2026-07-28", "2026-07-29", "2026-07-30"],
        releasedDates: ["2026-07-31", "2026-08-01"],
        addedDates: []
      },
      entitlementSummary: {
        currentConsumedCoverageDates: [],
        retainedHistoricalConsumedCoverageDates: [],
        ledgerWriteCount: 0
      },
      fundsSummary: {
        netRecordedCollection: { currency: "CNY", minorUnits: 58_000 },
        collectionDifference: { currency: "CNY", minorUnits: -23_200 },
        factCount: 2
      },
      refundReferenceAmount: { currency: "CNY", minorUnits: 23_200 }
    };

    expect(Value.Check(CommandEffectSchema, effect)).toBe(true);
    expect(Value.Check(CommandEffectSchema, {
      ...effect,
      before: {
        arrivalDate: effect.before.arrivalDate,
        departureDate: effect.before.departureDate,
        nights: effect.before.nights,
        currentContractAmount: effect.before.currentContractAmount
      }
    })).toBe(false);
    expect(Value.Check(CommandEffectSchema, { ...effect, businessDate: undefined })).toBe(false);
    expect(Value.Check(CommandEffectSchema, {
      ...effect,
      fundsSummary: {
        netRecordedCollection: effect.fundsSummary.netRecordedCollection,
        collectionDifference: effect.fundsSummary.collectionDifference
      }
    })).toBe(false);
    expect(Value.Check(CommandEffectSchema, {
      ...effect,
      fundsSummary: { ...effect.fundsSummary, factCount: -1 }
    })).toBe(false);
  });

  it("serializes and validates the real Preview effect for every command type", async () => {
    const propertyToday = todayInTimeZone("Asia/Shanghai");
    const covered = new Set<CommandType>();
    const capture = async (commandType: CommandType, input: Record<string, unknown>) => {
      const preview = await requestPreview(commandType, input);
      covered.add(commandType);
      return preview;
    };

    await capture("CREATE_MEMBER", {
      propertyId: demo.propertyId,
      fullName: "Effect Contract Member",
      identityCardNumber: "TEST-EFFECT-MEMBER-ID-001",
      phone: "13800000001",
      wechat: "effect-contract-member"
    });

    const membershipOrder = await capture("CREATE_MEMBERSHIP_ORDER", {
      propertyId: demo.propertyId,
      memberId: demo.memberId,
      membershipProductId: "membership_product_shared_bath_single_v1",
      agreedPriceMinor: 162000
    });
    const membershipOrderResult = await confirm(membershipOrder);
    const membershipPayment = await capture("RECORD_MEMBERSHIP_PAYMENT", {
      propertyId: demo.propertyId,
      membershipOrderId: membershipOrderResult.membershipOrderId,
      amountMinor: 100000,
      transactionReference: "WX-EFFECT-MEMBER-001"
    });
    const membershipPaymentResult = await confirm(membershipPayment);
    const correctedMembershipPayment = await capture("CORRECT_MEMBERSHIP_PAYMENT", {
      propertyId: demo.propertyId,
      membershipOrderId: membershipOrderResult.membershipOrderId,
      originalPaymentFactId: membershipPaymentResult.paymentFactId,
      correctedAmountMinor: 162000,
      correctedTransactionReference: "WX-EFFECT-MEMBER-002"
    });
    await confirm(correctedMembershipPayment);
    await capture("ACTIVATE_MEMBERSHIP_ORDER", {
      propertyId: demo.propertyId,
      membershipOrderId: membershipOrderResult.membershipOrderId
    });

    const maintenance = await capture("LOCK_MAINTENANCE", {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.secondRoomId,
      arrivalDate: "2028-03-01",
      departureDate: "2028-03-03",
      reason: "Effect contract maintenance window"
    });
    const maintenanceResult = await confirm(maintenance);
    await capture("RELEASE_MAINTENANCE", {
      propertyId: demo.propertyId,
      maintenanceLockId: maintenanceResult.maintenanceLockId
    });

    await capture("ADD_MEMBER_ENTITLEMENT_LOT", {
      propertyId: demo.propertyId,
      memberContractId: demo.memberContractId,
      unitKind: "ROOM_NIGHT",
      units: 1,
      expiresOn: "2029-12-31"
    });
    await capture("ADJUST_MEMBER_ENTITLEMENT", {
      propertyId: demo.propertyId,
      entitlementLotId: demo.roomLotId,
      quantityDelta: 1,
      adjustmentReason: "Effect contract adjustment"
    });
    await capture("CORRECT_MEMBER_ENTITLEMENT_BALANCE", {
      propertyId: demo.propertyId,
      entitlementLotId: demo.roomLotId,
      expectedAvailableBalance: 2,
      targetAvailableBalance: 3,
      adjustmentReason: "Effect contract target-balance correction"
    });

    const expiredOn = shiftLocalDate(propertyToday, -1);
    const expiryContractId = "member_contract_effect_expiry";
    const expiredLotId = "entitlement_lot_effect_expiry";
    await db.insertInto("member_contracts").values({
      id: expiryContractId,
      property_id: demo.propertyId,
      member_id: demo.memberId,
      member_name: "Effect Contract Expiry Member",
      status: "ACTIVE",
      valid_from: shiftLocalDate(propertyToday, -2),
      valid_until: propertyToday,
      version: 1
    }).execute();
    await db.insertInto("entitlement_lots").values({
      id: expiredLotId,
      contract_id: expiryContractId,
      unit_kind: "ROOM_NIGHT",
      total_units: 1,
      expires_on: expiredOn,
      version: 1
    }).execute();
    await capture("EXPIRE_MEMBER_ENTITLEMENT", {
      propertyId: demo.propertyId,
      entitlementLotId: expiredLotId,
      asOfDate: propertyToday
    });

    await capture("ISSUE_TOKEN", {
      propertyId: demo.propertyId,
      subjectId: demo.agentSubjectId,
      label: "Effect contract issued Token",
      accessCeiling: "READ",
      expiresAt: "2029-01-01T00:00:00.000Z",
      tokenSecret: newOpaqueSecret("qtp")
    });
    await capture("ROTATE_TOKEN", {
      propertyId: demo.propertyId,
      tokenId: "token_demo_read",
      tokenSecret: newOpaqueSecret("qtp")
    });
    await capture("REVOKE_TOKEN", {
      propertyId: demo.propertyId,
      tokenId: "token_demo_read"
    });

    const priced = await quote({ arrivalDate: "2028-04-10", departureDate: "2028-04-14" });
    const createOrder = await capture("CREATE_ORDER", {
      propertyId: demo.propertyId,
      quoteId: priced.quoteId,
      primaryGuest: {
        fullName: "Effect Contract Guest",
        nickname: "Effect Guest",
        phone: "+86-138-0000-0000",
        documentNumber: "EFFECT-CONTRACT-001"
      },
      bookingChannelCode: "CTRIP",
      channelOrderReference: "TEST-EFFECT-ORDER-001",
      targetCurrentContractAmountMinor: priced.currentContractAmount.minorUnits
    });
    expect(createOrder.effect.primaryGuest).toEqual({
      fullName: "Effect Contract Guest",
      nickname: "Effect Guest",
      phone: "+86-138-0000-0000",
      documentNumber: "EFFECT-CONTRACT-001"
    });
    expect(createOrder.effect).toMatchObject({
      occupancyCapacity: 4,
      occupants: [{
        id: expect.stringMatching(/^occupant_/),
        ordinal: 1,
        role: "PRIMARY",
        fullName: "Effect Contract Guest",
        nickname: "Effect Guest"
      }],
      pricingDecision: {
        pricingBasis: "CHANNEL_CONTRACT",
        policyBaseAmount: priced.currentContractAmount,
        differenceFromPolicy: { currency: "CNY", minorUnits: 0 },
        manualAdjustmentMinor: 0,
        differenceExceedsThreshold: false,
        reason: { code: "CREATE_ORDER_CHANNEL_CONTRACT", note: "" }
      }
    });
    const createOrderResult = await confirm(createOrder);
    expect(createOrderResult.primaryGuest).toEqual(createOrder.effect.primaryGuest);
    expect(createOrderResult).toMatchObject({
      pricingPolicyVersionId: demo.transientPolicyId,
      pricingDecision: createOrder.effect.pricingDecision
    });
    expect(createOrderResult.occupants).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: (createOrder.effect.occupants as Array<{ id: string }>)[0]!.id,
        ordinal: 1,
        role: "PRIMARY",
        fullName: "Effect Contract Guest",
        nickname: "Effect Guest"
      })
    ]));
    const orderId = createOrderResult.orderId as string;
    await capture("CORRECT_ORDER_OCCUPANT", {
      propertyId: demo.propertyId,
      orderId,
      occupantId: (createOrderResult.occupants as Array<{ id: string }>)[0]!.id,
      expectedPriorSnapshot: {
        fullName: "Effect Contract Guest",
        nickname: "Effect Guest",
        phone: "+86-138-0000-0000",
        documentNumber: "EFFECT-CONTRACT-001"
      },
      correctedSnapshot: {
        fullName: "Effect Contract Guest Corrected",
        nickname: "Effect Guest 2",
        phone: "+86-138-0000-0001",
        documentNumber: "EFFECT-CONTRACT-002"
      }
    });

    const reschedule = await capture("RESCHEDULE_STAY", {
      propertyId: demo.propertyId,
      orderId,
      newArrivalDate: "2028-04-09",
      newDepartureDate: "2028-04-14",
      targetCurrentContractAmountMinor: 60_000
    });
    expect((reschedule.effect.before as { stayTimeline: unknown }).stayTimeline).toEqual([
      { serviceDate: "2028-04-10", inventoryUnitId: demo.roomId },
      { serviceDate: "2028-04-11", inventoryUnitId: demo.roomId },
      { serviceDate: "2028-04-12", inventoryUnitId: demo.roomId },
      { serviceDate: "2028-04-13", inventoryUnitId: demo.roomId }
    ]);
    expect(Value.Check(CommandEffectSchema, {
      ...reschedule.effect,
      before: { ...(reschedule.effect.before as Record<string, unknown>), stayTimeline: undefined }
    })).toBe(false);
    const rescheduleResult = await confirm(reschedule);
    expect((rescheduleResult.before as { stayTimeline: unknown }).stayTimeline).toEqual(
      (reschedule.effect.before as { stayTimeline: unknown }).stayTimeline
    );
    // SHORTEN_STAY remains readable as historical protocol but is no longer
    // previewable in 4.2: reserved changes use RESCHEDULE_STAY and checked-in
    // shortening is intentionally deferred to 4.3.
    covered.add("SHORTEN_STAY");
    await capture("MOVE_UNIT", {
      propertyId: demo.propertyId,
      orderId,
      newInventoryUnitId: demo.secondRoomId,
      effectiveDate: "2028-04-12",
      targetCurrentContractAmountMinor: priced.currentContractAmount.minorUnits,
      channelPriceDifferenceReason: "Effect contract channel amount reconfirmed"
    });
    await capture("REPRICE_ORDER", {
      propertyId: demo.propertyId,
      orderId,
      targetCurrentContractAmountMinor: 47_900
    });
    await capture("CANCEL_ORDER", { propertyId: demo.propertyId, orderId });
    await capture("MARK_NO_SHOW", { propertyId: demo.propertyId, orderId });

    const memberPriced = await quote({
      arrivalDate: "2028-05-10",
      departureDate: "2028-05-12",
      inventoryUnitId: "unit_room_d_gen_01",
      memberId: demo.memberId
    });
    const memberOrder = await capture("CREATE_ORDER", {
      propertyId: demo.propertyId,
      quoteId: memberPriced.quoteId,
      primaryGuest: { fullName: "Effect Contract Member Guest", nickname: "Effect Member" }
    });
    expect(memberOrder.effect).toMatchObject({ bookingChannelCode: null, channelOrderReference: null });
    const memberOrderResult = await confirm(memberOrder);
    expect(memberOrderResult).toMatchObject({ bookingChannelCode: null, channelOrderReference: null });
    const memberOrderId = memberOrderResult.orderId as string;
    await capture("REFRESH_MEMBER_COVERAGE", { propertyId: demo.propertyId, orderId: memberOrderId });

    const collection = await capture("RECORD_COLLECTION", {
      propertyId: demo.propertyId,
      orderId,
      amountMinor: 10_000,
      method: "CARD",
      transactionReference: "TEST-EFFECT-TXN-COLLECTION",
      note: "Effect contract collection"
    });
    const collectionFactId = (await confirm(collection)).factId as string;
    await capture("RECORD_REFUND", {
      propertyId: demo.propertyId,
      orderId,
      amountMinor: 1_000,
      referencesFactId: collectionFactId,
      method: "CARD",
      transactionReference: "TEST-EFFECT-TXN-REFUND",
      note: "Effect contract refund"
    });
    await capture("REVERSE_FACT", {
      propertyId: demo.propertyId,
      orderId,
      reversesFactId: collectionFactId,
      note: "Effect contract reversal"
    });

    const checkInPriced = await quote({
      arrivalDate: propertyToday,
      departureDate: shiftLocalDate(propertyToday, 1),
      pricingPolicyVersionId: propertyToday.slice(0, 7) === shiftLocalDate(propertyToday, 2).slice(0, 7)
        ? demo.transientPolicyId
        : demo.publicPricingPolicyId
    });
    const checkInOrder = await capture("CREATE_ORDER", {
      propertyId: demo.propertyId,
      quoteId: checkInPriced.quoteId,
      primaryGuest: { fullName: "Effect Contract Check-in Guest", nickname: "Effect Check-in" },
      bookingChannelCode: "WECOM",
      channelOrderReference: null,
      targetCurrentContractAmountMinor: checkInPriced.currentContractAmount.minorUnits
    });
    const checkInOrderId = (await confirm(checkInOrder)).orderId as string;
    const checkIn = await capture("CHECK_IN", { propertyId: demo.propertyId, orderId: checkInOrderId });
    expect(checkIn.effect).toMatchObject({ businessDate: propertyToday, effectiveDate: propertyToday, recordingMode: "ON_SCHEDULE" });
    await confirm(checkIn);
    const extension = await capture("EXTEND_STAY", {
      propertyId: demo.propertyId,
      orderId: checkInOrderId,
      newDepartureDate: shiftLocalDate(propertyToday, 2)
    });
    expect((extension.effect.before as { stayTimeline: unknown }).stayTimeline).toHaveLength(1);
    expect(Value.Check(CommandEffectSchema, {
      ...extension.effect,
      before: { ...(extension.effect.before as Record<string, unknown>), stayTimeline: undefined }
    })).toBe(false);
    const extensionResult = await confirm(extension);
    expect((extensionResult.before as { stayTimeline: unknown }).stayTimeline).toEqual(
      (extension.effect.before as { stayTimeline: unknown }).stayTimeline
    );
    const checkoutPriced = await quote({
      arrivalDate: shiftLocalDate(propertyToday, -1),
      departureDate: propertyToday,
      inventoryUnitId: demo.secondRoomId
    });
    const checkoutOrder = await capture("CREATE_ORDER", {
      propertyId: demo.propertyId,
      quoteId: checkoutPriced.quoteId,
      primaryGuest: { fullName: "Effect Contract Checkout Guest", nickname: "Effect Checkout" },
      bookingChannelCode: "WECOM",
      channelOrderReference: null,
      targetCurrentContractAmountMinor: checkoutPriced.currentContractAmount.minorUnits
    });
    const checkoutOrderId = (await confirm(checkoutOrder)).orderId as string;
    await db.updateTable("orders").set({ status: "CHECKED_IN" }).where("id", "=", checkoutOrderId).execute();
    await db.updateTable("stays").set({ status: "IN_HOUSE" }).where("order_id", "=", checkoutOrderId).execute();
    const checkOut = await capture("CHECK_OUT", { propertyId: demo.propertyId, orderId: checkoutOrderId });
    expect(checkOut.effect).toMatchObject({ businessDate: propertyToday, effectiveDate: propertyToday, recordingMode: "ON_SCHEDULE" });
    const checkOutResult = await confirm(checkOut);
    expect(checkOutResult).not.toHaveProperty("cleaningTaskId");
    const disabledCleaning = await app.inject({
      method: "POST",
      url: "/api/v1/command-previews",
      headers: headers("effect-complete-cleaning-disabled"),
      payload: {
        commandType: "COMPLETE_CLEANING",
        input: { propertyId: demo.propertyId, cleaningTaskId: "cleaning_historical" }
      }
    });
    expect(disabledCleaning.statusCode, disabledCleaning.body).toBe(409);
    expect(disabledCleaning.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Cleaning workflow is disabled in this release"
    });
    const historicalCleaningEffect = {
      cleaningTaskId: "cleaning_historical",
      orderId,
      stayId: "stay_historical",
      inventoryUnitId: demo.roomId,
      roomId: demo.roomId,
      serviceDate: "2026-07-26",
      fromStatus: "PENDING",
      toStatus: "COMPLETED"
    };
    expect(Value.Check(CommandEffectSchema, historicalCleaningEffect)).toBe(true);
    expect(Object.keys(historicalCleaningEffect).sort()).toEqual(expectedEffectKeys.COMPLETE_CLEANING);
    covered.add("COMPLETE_CLEANING");

    expect([...covered].sort()).toEqual([...commandTypes].sort());
  }, 120_000);
});

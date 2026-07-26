import { describe, expect, it } from "vitest";
import {
  QuoteRequestGuard,
  RoomStatusCommandAttemptGuard,
  RoomStatusQueryAttemptGuard,
  GUEST_FULL_NAME_MAX_LENGTH,
  applyMemberSelectionToGuestForms,
  bookingChannelRequiredForStay,
  canAddGuest,
  createOrderGuestInputs,
  paidStayTypeForDates,
  eligibleMemberProfiles,
  effectiveQuoteMemberId,
  guestFormComplete,
  guestFormInput,
  membershipCoverageSummary,
  quotePricingSummary,
  staffQuoteError,
  quoteRecoveryStorageKey,
  readQuoteCommandRecovery,
  roomStatusOrderContextMode,
  roomStatusBlockDraftWithinSelection,
  saveQuoteCommandRecovery
} from "./InventoryPage";
import { ApiError } from "../api";

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

const subjectId = "subject_operator";
const propertyId = "property_qintopia";
const scope = quoteRecoveryStorageKey(subjectId, propertyId);
const pending = {
  version: 1,
  subjectId,
  propertyId,
  input: {
    propertyId,
    inventoryUnitId: "unit_room_101",
    stayType: "FREE",
    arrivalDate: "2026-10-10",
    departureDate: "2026-10-12",
    pricingPolicyVersionId: "policy_free_v1"
  },
  inputSignature: JSON.stringify({
    propertyId,
    inventoryUnitId: "unit_room_101",
    stayType: "FREE",
    arrivalDate: "2026-10-10",
    departureDate: "2026-10-12",
    pricingPolicyVersionId: "policy_free_v1"
  }),
  metadata: {
    idempotencyKey: "web-create-quote-original-key",
    correlationId: "web-create-quote-original-correlation"
  },
  state: "SENDING"
} as const;

describe("CREATE_QUOTE request lifecycle", () => {
  it("matches the API's 200-character full-name limit for primary and additional guests", () => {
    expect(GUEST_FULL_NAME_MAX_LENGTH).toBe(200);
  });

  it("normalizes complete occupant drafts without inventing optional personal data", () => {
    expect(guestFormComplete({ fullName: " 同行人甲 ", nickname: " 小满 ", phone: " ", documentNumber: " DOC-2 " })).toBe(true);
    expect(guestFormInput({ fullName: " 同行人甲 ", nickname: " 小满 ", phone: " ", documentNumber: " DOC-2 " })).toEqual({
      fullName: "同行人甲",
      nickname: "小满",
      documentNumber: "DOC-2"
    });
    expect(guestFormComplete({ fullName: "同行人甲", nickname: " ", phone: "", documentNumber: "" })).toBe(false);
  });

  it("only permits companions below the authoritative occupancy capacity", () => {
    expect(canAddGuest(1, 0)).toBe(false);
    expect(canAddGuest(2, 0)).toBe(true);
    expect(canAddGuest(2, 1)).toBe(false);
    expect(canAddGuest(4, 2)).toBe(true);
    expect(canAddGuest(4, 3)).toBe(false);
  });

  it("prefills only the member primary guest and preserves companions through member reselection and quote refresh", () => {
    const member = {
      full_name: "会员主档姓名",
      phone: "13900000001",
      identity_card_number: "MEMBER-ID-001"
    };
    const companions = [{
      fullName: "同行人姓名",
      nickname: "小满",
      phone: "13900000002",
      documentNumber: "COMPANION-ID-002"
    }];

    const selected = applyMemberSelectionToGuestForms(companions, member);
    const refreshed = applyMemberSelectionToGuestForms(selected.additionalGuests, member);
    expect(refreshed.primaryGuest).toEqual({
      fullName: "会员主档姓名",
      nickname: "会员主档姓名",
      phone: "13900000001",
      documentNumber: "MEMBER-ID-001"
    });
    expect(refreshed.additionalGuests).toBe(companions);
    expect(createOrderGuestInputs(refreshed.primaryGuest, refreshed.additionalGuests)).toEqual({
      primaryGuest: refreshed.primaryGuest,
      additionalGuests: companions
    });
    expect(member).toEqual({
      full_name: "会员主档姓名",
      phone: "13900000001",
      identity_card_number: "MEMBER-ID-001"
    });
  });

  it("requires a booking channel only for non-member stays", () => {
    expect(bookingChannelRequiredForStay(false)).toBe(true);
    expect(bookingChannelRequiredForStay(true)).toBe(false);
    expect(bookingChannelRequiredForStay(false, "FREE")).toBe(false);
    expect(bookingChannelRequiredForStay(false, "TRANSIENT")).toBe(true);
    expect(bookingChannelRequiredForStay(true, "TRANSIENT")).toBe(false);
  });

  it("only keeps a selected member while it remains visible in the current property", () => {
    const members = [
      { id: "member_current", full_name: "当前门店会员", identity_card_number: "CURRENT-001", phone: "13900000001", wechat: "current" },
      { id: "member_other", full_name: "其他门店会员", identity_card_number: "OTHER-001", phone: "13900000002", wechat: "other" }
    ];
    const contracts = [
      { property_id: propertyId, member_id: "member_current" },
      { property_id: "property_other", member_id: "member_other" }
    ];

    expect(eligibleMemberProfiles(members as never[], contracts as never[], propertyId, "当前").map((member) => member.id)).toEqual(["member_current"]);
    expect(effectiveQuoteMemberId([members[0] as never], "member_current")).toBe("member_current");
    expect(effectiveQuoteMemberId([], "member_current")).toBe("");
  });

  it("summarizes full, partial, and zero member coverage without hiding zero", () => {
    const quote = {
      quoteId: "quote_member",
      propertyId,
      inventoryUnitId: "unit_room_d01",
      stayType: "TRANSIENT" as const,
      arrivalDate: "2026-08-01",
      departureDate: "2026-08-05",
      pricingPolicyVersionId: "policy_public",
      coverageSet: [{ serviceDate: "2026-08-01", inventoryUnitId: "unit_room_d01", unitKind: "ROOM_NIGHT" as const, entitlementLotId: "lot_member" }],
      cashLines: [],
      cashRemainder: { currency: "CNY", minorUnits: 39_000 },
      currentContractAmount: { currency: "CNY", minorUnits: 39_000 },
      expiresAt: "2026-08-01T01:00:00.000Z"
    };
    expect(membershipCoverageSummary(quote)).toEqual({ totalNights: 4, coveredNights: 1, uncoveredNights: 3, uncoveredAmount: { currency: "CNY", minorUnits: 39_000 } });
    expect(membershipCoverageSummary({ ...quote, coverageSet: [] })).toMatchObject({ totalNights: 4, coveredNights: 0, uncoveredNights: 4 });
    expect(membershipCoverageSummary({ ...quote, coverageSet: Array.from({ length: 4 }, (_, index) => ({ serviceDate: `2026-08-0${index + 1}`, inventoryUnitId: "unit_room_d01", unitKind: "ROOM_NIGHT" as const, entitlementLotId: "lot_member" })), cashRemainder: { currency: "CNY", minorUnits: 0 } })).toMatchObject({ totalNights: 4, coveredNights: 4, uncoveredNights: 0, uncoveredAmount: { currency: "CNY", minorUnits: 0 } });
  });

  it("derives the paid stay type from the complete date interval", () => {
    expect(paidStayTypeForDates("2026-07-26", "2026-08-01")).toBe("TRANSIENT");
    expect(paidStayTypeForDates("2026-07-26", "2026-08-02")).toBe("CUSTOM");
    expect(paidStayTypeForDates("2026-07-26", "2026-08-05")).toBe("CUSTOM");
  });

  it("summarizes a duration-band quote without exposing protocol fields", () => {
    expect(quotePricingSummary({
      quoteId: "quote_internal",
      propertyId,
      inventoryUnitId: "unit_room_104",
      stayType: "CUSTOM",
      arrivalDate: "2026-07-26",
      departureDate: "2026-08-05",
      pricingPolicyVersionId: "policy_internal",
      coverageSet: [],
      cashLines: [{
        lineKind: "STAY_TOTAL",
        arrivalDate: "2026-07-26",
        departureDate: "2026-08-05",
        inventoryUnitId: "unit_room_104",
        description: "internal description",
        pricingBandAnchorNights: 7,
        calculationSegments: [{
          inventoryUnitId: "unit_room_104",
          pricingProductCode: "shared_bath_double_whole_room",
          arrivalDate: "2026-07-26",
          departureDate: "2026-08-05",
          nights: 10,
          anchorAmountMinor: 76_000,
          numeratorMinor: 760_000,
          denominator: 7
        }],
        amount: { currency: "CNY", minorUnits: 108_600 }
      }],
      cashRemainder: { currency: "CNY", minorUnits: 108_600 },
      currentContractAmount: { currency: "CNY", minorUnits: 108_600 },
      expiresAt: "2026-07-26T01:00:00.000Z"
    })).toEqual({ nights: 10, pricingBasis: "按 7 夜价格档", amount: { currency: "CNY", minorUnits: 108_600 } });
  });

  it("turns deterministic API failures into staff language without treating them as network-unknown", () => {
    const error = new ApiError(422, {
      code: "PRICING_POLICY_UNCONFIGURED",
      message: "legacy protocol wording",
      retryable: false
    });
    expect(staffQuoteError(error, "104", "2026-02-24", "2026-02-25").message).toBe(
      "104 在 2026-02-24 至 2026-02-25 暂无已生效价格，请调整日期。"
    );
  });

  it("leaves the original SENDING recovery record untouched after unmount", () => {
    const storage = new MemoryStorage();
    expect(saveQuoteCommandRecovery(storage, pending)).toBe(true);

    const guard = new QuoteRequestGuard(scope);
    guard.mount();
    const lease = guard.begin(scope);
    guard.unmount();

    if (guard.isActive(lease)) storage.removeItem(quoteRecoveryStorageKey(subjectId, propertyId));

    expect(readQuoteCommandRecovery(storage, subjectId, propertyId)).toEqual({ kind: "VALID", pending });
  });

  it("isolates delayed callbacks across property switches, including a switch back", () => {
    const otherScope = quoteRecoveryStorageKey(subjectId, "property_other");
    const guard = new QuoteRequestGuard(scope);
    guard.mount();
    const originalLease = guard.begin(scope);

    guard.enterScope(otherScope);
    expect(guard.isActive(originalLease)).toBe(false);
    const otherPropertyLease = guard.begin(otherScope);
    expect(guard.isActive(otherPropertyLease)).toBe(true);

    guard.enterScope(scope);
    expect(guard.isActive(originalLease)).toBe(false);
    expect(guard.isActive(otherPropertyLease)).toBe(false);
  });

  it("loads a persisted SENDING command with its original idempotency key for recovery", () => {
    const storage = new MemoryStorage();
    expect(saveQuoteCommandRecovery(storage, pending)).toBe(true);

    const restored = readQuoteCommandRecovery(storage, subjectId, propertyId);
    expect(restored.kind).toBe("VALID");
    if (restored.kind !== "VALID") throw new Error("expected a valid quote recovery record");
    expect(restored.pending.state).toBe("SENDING");
    expect(restored.pending.metadata.idempotencyKey).toBe(pending.metadata.idempotencyKey);

    const remountedGuard = new QuoteRequestGuard(scope);
    remountedGuard.mount();
    expect(remountedGuard.isActive(remountedGuard.begin(scope))).toBe(true);
  });
});

describe("Room-status order context layout", () => {
  it("uses measured workspace width instead of viewport assumptions", () => {
    expect(roomStatusOrderContextMode(0, false)).toBe("INLINE");
    expect(roomStatusOrderContextMode(1239, false)).toBe("DRAWER");
    expect(roomStatusOrderContextMode(1240, false)).toBe("INLINE");
    expect(roomStatusOrderContextMode(1600, true)).toBe("DRAWER");
  });
});

describe("Room-status command attempt lifecycle", () => {
  it("tracks late recovery outcomes after 403 without letting a stale attempt restart polling state", () => {
    const guard = new RoomStatusCommandAttemptGuard();
    const attemptId = guard.begin();
    let phase = "PREVIEW";
    const persisted: string[] = [];

    guard.invalidate();
    for (const progress of ["UNKNOWN", "RESOLVED"] as const) {
      persisted.push(progress);
      guard.runIfActive(attemptId, () => { phase = "CONFIRMING"; });
    }

    expect(persisted).toEqual(["UNKNOWN", "RESOLVED"]);
    expect(phase).toBe("PREVIEW");

    const nextAttemptId = guard.begin();
    expect(nextAttemptId).toBeGreaterThan(attemptId);
    expect(guard.runIfActive(attemptId, () => { phase = "STALE"; })).toBe(false);
    expect(guard.runIfActive(nextAttemptId, () => { phase = "DRAFT"; })).toBe(true);
    expect(phase).toBe("DRAFT");
  });
});

describe("Room-status query attempt lifecycle", () => {
  it("keeps a slow query active so a polling tick can skip overlapping refreshes", () => {
    const guard = new RoomStatusQueryAttemptGuard();
    const slowAttemptId = guard.begin();

    expect(guard.isInFlight()).toBe(true);
    expect(guard.isActive(slowAttemptId)).toBe(true);

    const pollingTickStartedAnotherRequest = guard.isInFlight() ? false : Boolean(guard.begin());
    expect(pollingTickStartedAnotherRequest).toBe(false);
    expect(guard.isActive(slowAttemptId)).toBe(true);

    expect(guard.finish(slowAttemptId)).toBe(true);
    expect(guard.isInFlight()).toBe(false);
  });

  it("does not let a superseded range response finish the current query", () => {
    const guard = new RoomStatusQueryAttemptGuard();
    const oldRangeAttemptId = guard.begin();
    expect(guard.invalidate(oldRangeAttemptId)).toBe(true);

    const currentRangeAttemptId = guard.begin();
    expect(guard.finish(oldRangeAttemptId)).toBe(false);
    expect(guard.isActive(currentRangeAttemptId)).toBe(true);
    expect(guard.finish(currentRangeAttemptId)).toBe(true);
    expect(guard.isInFlight()).toBe(false);
  });
});

describe("Room-status Block draft authorization", () => {
  it("only permits a non-empty interval contained by the server-validated selection", () => {
    expect(roomStatusBlockDraftWithinSelection("2026-07-21", "2026-07-23", "2026-07-20", "2026-07-24")).toBe(true);
    expect(roomStatusBlockDraftWithinSelection("2026-07-19", "2026-07-23", "2026-07-20", "2026-07-24")).toBe(false);
    expect(roomStatusBlockDraftWithinSelection("2026-07-21", "2026-07-25", "2026-07-20", "2026-07-24")).toBe(false);
    expect(roomStatusBlockDraftWithinSelection("2026-07-21", "2026-07-21", "2026-07-20", "2026-07-24")).toBe(false);
    expect(roomStatusBlockDraftWithinSelection("", "2026-07-23", "2026-07-20", "2026-07-24")).toBe(false);
  });
});

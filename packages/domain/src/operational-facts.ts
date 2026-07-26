import {
  bookingChannelCodes,
  DomainError,
  type BookingChannelCode,
  type CreateOrderPricingDecisionDto
} from "@qintopia/contracts";

const bookingChannelCodeSet = new Set<string>(bookingChannelCodes);

export function parseBookingChannelCode(value: unknown): BookingChannelCode {
  if (typeof value !== "string" || !bookingChannelCodeSet.has(value)) {
    throw new DomainError("VALIDATION_ERROR", `bookingChannelCode must be one of ${bookingChannelCodes.join(", ")}`);
  }
  return value as BookingChannelCode;
}

export function normalizeChannelOrderReference(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new DomainError("VALIDATION_ERROR", "channelOrderReference must be a string or null");
  }
  return value.trim() || null;
}

export function validateBookingChannel(
  bookingChannelCodeValue: unknown,
  channelOrderReferenceValue: unknown
): { bookingChannelCode: BookingChannelCode; channelOrderReference: string | null } {
  const bookingChannelCode = parseBookingChannelCode(bookingChannelCodeValue);
  const channelOrderReference = normalizeChannelOrderReference(channelOrderReferenceValue);
  if (bookingChannelCode === "WECOM" && channelOrderReference !== null) {
    throw new DomainError("VALIDATION_ERROR", "channelOrderReference must be null for WECOM orders");
  }
  if (bookingChannelCode !== "WECOM" && channelOrderReference === null) {
    throw new DomainError("VALIDATION_ERROR", `channelOrderReference is required for ${bookingChannelCode} orders`);
  }
  return { bookingChannelCode, channelOrderReference };
}

const postgresIntegerMaximum = 2_147_483_647;
const postgresWholeYuanMaximumMinor = 2_147_483_600;

function nonNegativePostgresAmount(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > postgresIntegerMaximum) {
    throw new DomainError("VALIDATION_ERROR", `${field} must be a non-negative PostgreSQL integer amount`);
  }
  return value as number;
}

function nonNegativeWholeYuanPostgresAmount(value: unknown, field: string): number {
  const amount = nonNegativePostgresAmount(value, field);
  if (amount > postgresWholeYuanMaximumMinor || amount % 100 !== 0) {
    throw new DomainError("VALIDATION_ERROR", `${field} must be a non-negative whole-yuan PostgreSQL integer amount`);
  }
  return amount;
}

export function channelPriceDifferenceExceedsThreshold(policyBaseAmountMinor: number, targetAmountMinor: number): boolean {
  const policyBase = nonNegativePostgresAmount(policyBaseAmountMinor, "policyBaseAmountMinor");
  const target = nonNegativePostgresAmount(targetAmountMinor, "targetCurrentContractAmountMinor");
  const difference = BigInt(target) - BigInt(policyBase);
  const absoluteDifference = difference < 0n ? -difference : difference;
  return absoluteDifference * 100n > BigInt(policyBase) * 15n;
}

function optionalPricingReason(value: unknown, field: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new DomainError("VALIDATION_ERROR", `${field} must be a string`);
  const normalized = value.trim();
  if (normalized.length > 1000) throw new DomainError("VALIDATION_ERROR", `${field} must not exceed 1000 characters`);
  return normalized;
}

export function createOrderPricingDecision(input: {
  bookingChannelCode: BookingChannelCode | null;
  stayType: string;
  memberStay: boolean;
  policyBaseAmountMinor: unknown;
  targetCurrentContractAmountMinor?: unknown;
  channelPriceDifferenceReason?: unknown;
  manualPriceAdjustmentReason?: unknown;
}): CreateOrderPricingDecisionDto {
  const policyBaseAmountMinor = nonNegativePostgresAmount(input.policyBaseAmountMinor, "policyBaseAmountMinor");
  const freeStay = input.stayType === "FREE";
  const channelPriceDifferenceReason = optionalPricingReason(input.channelPriceDifferenceReason, "channelPriceDifferenceReason");
  const manualPriceAdjustmentReason = optionalPricingReason(input.manualPriceAdjustmentReason, "manualPriceAdjustmentReason");

  if (freeStay || input.memberStay) {
    if (input.targetCurrentContractAmountMinor !== undefined && input.targetCurrentContractAmountMinor !== null) {
      throw new DomainError("VALIDATION_ERROR", "targetCurrentContractAmountMinor must not be submitted for FREE or member stays");
    }
    if (channelPriceDifferenceReason || manualPriceAdjustmentReason) {
      throw new DomainError("VALIDATION_ERROR", "pricing reasons must not be submitted for FREE or member stays");
    }
    return {
      pricingBasis: freeStay ? "FREE" : "MEMBER_ENTITLEMENT",
      policyBaseAmountMinor,
      currentContractAmountMinor: policyBaseAmountMinor,
      differenceFromPolicyMinor: 0,
      manualAdjustmentMinor: 0,
      differenceExceedsThreshold: false,
      reason: { code: freeStay ? "CREATE_ORDER_FREE" : "CREATE_ORDER_MEMBER", note: "" }
    };
  }

  if (!input.bookingChannelCode) throw new DomainError("VALIDATION_ERROR", "bookingChannelCode is required for paid orders");
  if (input.bookingChannelCode !== "WECOM"
    && (input.targetCurrentContractAmountMinor === undefined || input.targetCurrentContractAmountMinor === null)) {
    throw new DomainError("VALIDATION_ERROR", "targetCurrentContractAmountMinor is required for paid orders");
  }
  const currentContractAmountMinor = input.targetCurrentContractAmountMinor === undefined
    || input.targetCurrentContractAmountMinor === null
    ? policyBaseAmountMinor
    : nonNegativeWholeYuanPostgresAmount(input.targetCurrentContractAmountMinor, "targetCurrentContractAmountMinor");
  const differenceFromPolicyMinor = currentContractAmountMinor - policyBaseAmountMinor;
  const differenceExceedsThreshold = channelPriceDifferenceExceedsThreshold(
    policyBaseAmountMinor,
    currentContractAmountMinor
  );

  if (input.bookingChannelCode === "WECOM") {
    if (channelPriceDifferenceReason) {
      throw new DomainError("VALIDATION_ERROR", "channelPriceDifferenceReason is not allowed for WECOM orders");
    }
    if (differenceFromPolicyMinor !== 0 && !manualPriceAdjustmentReason) {
      throw new DomainError("VALIDATION_ERROR", "manualPriceAdjustmentReason is required when a WECOM order differs from policy price");
    }
    if (differenceFromPolicyMinor === 0 && manualPriceAdjustmentReason) {
      throw new DomainError("VALIDATION_ERROR", "manualPriceAdjustmentReason is only allowed when a WECOM order differs from policy price");
    }
    return {
      pricingBasis: differenceFromPolicyMinor === 0 ? "POLICY" : "MANUAL_ADJUSTMENT",
      policyBaseAmountMinor,
      currentContractAmountMinor,
      differenceFromPolicyMinor,
      manualAdjustmentMinor: differenceFromPolicyMinor,
      differenceExceedsThreshold,
      reason: {
        code: differenceFromPolicyMinor === 0 ? "CREATE_ORDER_POLICY_PRICE" : "CREATE_ORDER_MANUAL_PRICE",
        note: manualPriceAdjustmentReason
      }
    };
  }

  if (manualPriceAdjustmentReason) {
    throw new DomainError("VALIDATION_ERROR", "manualPriceAdjustmentReason is not allowed for external channel contract prices");
  }
  if (differenceExceedsThreshold && !channelPriceDifferenceReason) {
    throw new DomainError("VALIDATION_ERROR", "channelPriceDifferenceReason is required when the channel price difference exceeds 15%");
  }
  return {
    pricingBasis: "CHANNEL_CONTRACT",
    policyBaseAmountMinor,
    currentContractAmountMinor,
    differenceFromPolicyMinor,
    manualAdjustmentMinor: 0,
    differenceExceedsThreshold,
    reason: { code: "CREATE_ORDER_CHANNEL_CONTRACT", note: channelPriceDifferenceReason }
  };
}

export function requireTransactionReference(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError("VALIDATION_ERROR", "transactionReference is required");
  }
  return value.trim();
}

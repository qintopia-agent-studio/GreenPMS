import { bookingChannelCodes, DomainError, type BookingChannelCode } from "@qintopia/contracts";

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
  if (bookingChannelCode === "WECOM") {
    if (channelOrderReference !== null) {
      throw new DomainError("VALIDATION_ERROR", "channelOrderReference must be null for WECOM orders");
    }
  } else if (channelOrderReference === null) {
    throw new DomainError("VALIDATION_ERROR", `channelOrderReference is required for ${bookingChannelCode} orders`);
  }
  return { bookingChannelCode, channelOrderReference };
}

export function requireTransactionReference(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError("VALIDATION_ERROR", "transactionReference is required");
  }
  return value.trim();
}

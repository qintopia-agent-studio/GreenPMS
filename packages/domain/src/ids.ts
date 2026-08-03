import { createHash, randomBytes, randomUUID } from "node:crypto";

export type IdPrefix = "prop" | "unit" | "policy" | "quote" | "order" | "occupant" | "stay" | "segment" | "amend" | "revision" | "claim" | "maint" | "block" | "cleaning" | "member" | "membership_order" | "membership_payment" | "membership_payment_reversal" | "contract" | "memberref" | "lot" | "coverage" | "fact" | "transfer" | "subject" | "token" | "session" | "preview" | "command" | "receipt" | "audit";

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID()}`;
}

export function newOpaqueSecret(prefix: "qtp" | "qts" = "qtp"): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableHash(value: unknown): string {
  return sha256(stableJson(value));
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

import { Value } from "@sinclair/typebox/value";
import { errorCodes } from "@qintopia/contracts";
import { ErrorDetailsSchema } from "./schemas.ts";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function publicError(value: unknown): unknown {
  if (!record(value) || typeof value.code !== "string" || !(errorCodes as readonly string[]).includes(value.code)
    || typeof value.message !== "string" || typeof value.retryable !== "boolean" || typeof value.correlationId !== "string"
    || value.details === undefined || Value.Check(ErrorDetailsSchema, value.details)) return value;
  const { details: _privateDiagnostics, ...result } = value;
  return result;
}

/** Optional diagnostics cannot turn a business rejection into a server failure.
 * Project only error envelopes and command receipts; stored recovery evidence is untouched. */
export function publicCommandErrorPayload(payload: unknown): unknown {
  if (!record(payload)) return payload;
  const result = publicError(payload) as Record<string, unknown>;
  const error = publicError(result.error);
  const receipt = record(result.receipt) ? publicCommandErrorPayload(result.receipt) : result.receipt;
  if (error === result.error && receipt === result.receipt) return result;
  return { ...result, ...(error !== undefined ? { error } : {}), ...(receipt !== undefined ? { receipt } : {}) };
}

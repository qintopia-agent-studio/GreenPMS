import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { Value } from "@sinclair/typebox/value";
import type { CommandType } from "@qintopia/contracts";
import { newOpaqueSecret, sha256 } from "@qintopia/domain";
import { createDatabase, type Database } from "@qintopia/db";
import { ErrorResponse, ReceiptSchema } from "../../apps/api/src/schemas.ts";
import { buildServer } from "../../apps/api/src/server.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { resetDatabase } from "../helpers/database.ts";

const securityContractDatabaseUrl = process.env.SECURITY_CONTRACT_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_security_contract";
const secondPropertyId = "prop_security_scope";
const secondUnitId = "unit_security_scope_room";
const secondPolicyId = "policy_security_scope_transient";
const secondScopeSecret = "qtp_security_second_scope_2026";
const foreignSubjectSecret = "qtp_security_foreign_subject_2026";
const disabledForeignSubjectId = "subject_security_disabled_foreign";
const revokedForeignTokenId = "token_security_revoked_foreign";

type PreviewBody = {
  preview: {
    previewId: string;
    commandType: CommandType;
    effectHash: string;
    effect: Record<string, unknown>;
    expiresAt: string;
  };
  receipt: Record<string, unknown>;
};

type ReceiptBody = {
  receiptId: string;
  commandId: string;
  executionStatus: "EXECUTED" | "NOT_EXECUTED" | "UNKNOWN";
  businessCommitted: boolean;
  correlationId: string;
  result?: Record<string, unknown>;
  error?: { code: string; retryable: boolean; details?: Record<string, unknown> };
  factRefs?: string[];
};

let app: FastifyInstance;
let db: Kysely<Database>;
let sequence = 0;
const originalEnvironment = new Map<string, string | undefined>();

function setTestEnvironment(name: string, value: string): void {
  originalEnvironment.set(name, process.env[name]);
  process.env[name] = value;
}

function authHeaders(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

function writeHeaders(token: string, prefix: string) {
  sequence += 1;
  return {
    ...authHeaders(token),
    "idempotency-key": `${prefix}-${sequence}`,
    "x-correlation-id": `${prefix}-${sequence}`
  };
}

async function previewCommand(token: string, commandType: CommandType, input: Record<string, unknown>, prefix: string) {
  const headers = writeHeaders(token, `${prefix}-preview`);
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/command-previews",
    headers,
    payload: { commandType, input }
  });
  return { response, body: response.json() as PreviewBody, headers };
}

async function confirmPreview(token: string, preview: PreviewBody["preview"], prefix: string, propertyId: string = demo.propertyId) {
  const headers = writeHeaders(token, `${prefix}-confirm`);
  const payload = {
    propertyId,
    commandType: preview.commandType,
    confirmation: true,
    expectedEffectHash: preview.effectHash,
    reason: preview.commandType === "CREATE_ORDER"
      ? { code: "CREATE_STANDARD_ORDER", note: "" }
      : { code: "SECURITY_CONTRACT", note: `Security contract confirmation for ${prefix}` }
  };
  const url = `/api/v1/command-previews/${preview.previewId}/confirm`;
  const response = await app.inject({ method: "POST", url, headers, payload });
  return { response, body: response.json() as ReceiptBody, headers, payload, url };
}

async function executeCommand(token: string, commandType: CommandType, input: Record<string, unknown>, prefix: string) {
  const preview = await previewCommand(token, commandType, input, prefix);
  expect(preview.response.statusCode, preview.response.body).toBe(200);
  const confirmation = await confirmPreview(token, preview.body.preview, prefix, input.propertyId as string);
  expect(confirmation.response.statusCode, confirmation.response.body).toBe(200);
  return { preview, confirmation };
}

async function commandArtifactCounts() {
  const [executions, previews, receipts, audits] = await Promise.all([
    db.selectFrom("command_executions").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("command_previews").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("command_receipts").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("audit_entries").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow()
  ]);
  return [executions, previews, receipts, audits].map((row) => Number(row.count));
}

beforeAll(async () => {
  setTestEnvironment("LOG_LEVEL", "silent");
  setTestEnvironment("LOGIN_RATE_LIMIT_MAX", "2");
  setTestEnvironment("BEARER_AUTH_RATE_LIMIT_MAX", "5000");
  setTestEnvironment("WEB_ORIGIN", "http://127.0.0.1:4312");
  db = await resetDatabase(securityContractDatabaseUrl);
  await db.insertInto("properties").values({
    id: secondPropertyId,
    code: "SEC-SCOPE",
    name: "Security Scope Property",
    timezone: "Asia/Shanghai",
    currency: "CNY"
  }).execute();
  await db.insertInto("inventory_units").values({
    id: secondUnitId,
    property_id: secondPropertyId,
    kind: "ROOM",
    parent_room_id: null,
    code: "SEC-201",
    name: "Security Scope Room",
    active: true
  }).execute();
  await db.insertInto("pricing_policy_versions").values({
    id: secondPolicyId,
    property_id: secondPropertyId,
    code: "SEC-SCOPE-TRANSIENT",
    version: 1,
    stay_type: "TRANSIENT",
    calculation_kind: "FLAT_NIGHTLY",
    nightly_rate_minor: 10_000,
    currency: "CNY",
    status: "PUBLISHED"
  }).execute();
  await db.insertInto("subject_property_grants").values({
    subject_id: demo.agentSubjectId,
    property_id: secondPropertyId,
    access_level: "WRITE"
  }).execute();
  await db.insertInto("subjects").values({
    id: disabledForeignSubjectId,
    username: "security-disabled-foreign",
    display_name: "Disabled Foreign Subject",
    password_salt: "security-disabled",
    password_hash: "disabled",
    status: "DISABLED",
    auth_version: 1
  }).execute();
  await db.insertInto("subject_property_grants").values({
    subject_id: disabledForeignSubjectId,
    property_id: demo.propertyId,
    access_level: "WRITE"
  }).execute();
  await db.insertInto("api_tokens").values([
    {
      id: "token_security_second_scope",
      subject_id: demo.agentSubjectId,
      label: "Security second scope",
      secret_hash: sha256(secondScopeSecret),
      access_ceiling: "WRITE",
      property_scope: secondPropertyId,
      expires_at: "2030-01-01T00:00:00.000Z",
      revoked_at: null,
      rotated_from_id: null,
      replaced_by_id: null
    },
    {
      id: "token_security_foreign_subject",
      subject_id: demo.operatorSubjectId,
      label: "Security foreign subject",
      secret_hash: sha256(foreignSubjectSecret),
      access_ceiling: "WRITE",
      property_scope: demo.propertyId,
      expires_at: "2030-01-01T00:00:00.000Z",
      revoked_at: null,
      rotated_from_id: null,
      replaced_by_id: null
    },
    {
      id: revokedForeignTokenId,
      subject_id: demo.operatorSubjectId,
      label: "Security revoked foreign Token",
      secret_hash: sha256("qtp_security_revoked_foreign_2026"),
      access_ceiling: "WRITE",
      property_scope: demo.propertyId,
      expires_at: "2030-01-01T00:00:00.000Z",
      revoked_at: new Date("2027-01-01T00:00:00.000Z"),
      rotated_from_id: null,
      replaced_by_id: null
    }
  ]).execute();
  app = await buildServer(db);
  await app.ready();
}, 120_000);

afterAll(async () => {
  try {
    if (app) await app.close();
    else if (db) await db.destroy();
  } finally {
    for (const [name, value] of originalEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

describe("HTTP security contract", () => {
  it("allows only the configured Origin for session writes and rejects mismatches with zero artifacts", async () => {
    const sessionCookie = newOpaqueSecret("qts");
    await db.insertInto("web_sessions").values({
      id: "session_security_origin",
      subject_id: demo.operatorSubjectId,
      secret_hash: sha256(sessionCookie),
      expires_at: "2028-01-01T00:00:00.000Z",
      revoked_at: null
    }).execute();
    const input = {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.roomId,
      stayType: "FREE",
      arrivalDate: "2028-12-10",
      departureDate: "2028-12-12",
      pricingPolicyVersionId: demo.freePolicyId
    };
    const before = await commandArtifactCounts();
    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/quotes",
      cookies: { qintopia_session: sessionCookie },
      headers: {
        origin: "http://127.0.0.1:9999",
        "idempotency-key": "session-origin-rejected",
        "x-correlation-id": "session-origin-rejected"
      },
      payload: input
    });
    expect(rejected.statusCode, rejected.body).toBe(403);
    expect(rejected.json()).toMatchObject({ code: "RESOURCE_SCOPE_DENIED", retryable: false });
    expect(await commandArtifactCounts()).toEqual(before);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/quotes",
      cookies: { qintopia_session: sessionCookie },
      headers: {
        origin: "http://127.0.0.1:4312",
        "idempotency-key": "session-origin-accepted",
        "x-correlation-id": "session-origin-accepted"
      },
      payload: input
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toMatchObject({ receipt: { executionStatus: "EXECUTED", businessCommitted: true } });
  });

  it("authenticates before resolving a member contract", async () => {
    const missing = await app.inject({
      method: "GET",
      url: `/api/v1/members/member_missing_probe?propertyId=${demo.propertyId}`
    });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({ code: "AUTHENTICATION_REQUIRED", retryable: false });
  });

  it("rejects an expired Bearer Token before creating command or business artifacts", async () => {
    const expiredSecret = newOpaqueSecret("qtp");
    await db.insertInto("api_tokens").values({
      id: "token_security_expired_http",
      subject_id: demo.agentSubjectId,
      label: "Expired HTTP security contract Token",
      secret_hash: sha256(expiredSecret),
      access_ceiling: "WRITE",
      property_scope: demo.propertyId,
      expires_at: "2020-01-01T00:00:00.000Z",
      revoked_at: null,
      rotated_from_id: null,
      replaced_by_id: null
    }).execute();
    const beforeArtifacts = await commandArtifactCounts();
    const beforeBusiness = await Promise.all([
      db.selectFrom("maintenance_locks").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      db.selectFrom("inventory_claims").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow()
    ]);

    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/command-previews",
      headers: writeHeaders(expiredSecret, "expired-token-write"),
      payload: {
        commandType: "LOCK_MAINTENANCE",
        input: {
          propertyId: demo.propertyId,
          inventoryUnitId: demo.secondRoomId,
          arrivalDate: "2027-04-01",
          departureDate: "2027-04-02",
          reason: "Expired Token must not authorize a write"
        }
      }
    });

    expect(rejected.statusCode).toBe(401);
    expect(rejected.json()).toMatchObject({ code: "TOKEN_EXPIRED", retryable: false });
    expect(await commandArtifactCounts()).toEqual(beforeArtifacts);
    const afterBusiness = await Promise.all([
      db.selectFrom("maintenance_locks").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      db.selectFrom("inventory_claims").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow()
    ]);
    expect(afterBusiness.map((row) => Number(row.count))).toEqual(beforeBusiness.map((row) => Number(row.count)));
  });

  it("rejects Bearer logout instead of implying that the Token was revoked", async () => {
    const logoutResponse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { authorization: `Bearer ${demo.readToken}` }
    });
    expect(logoutResponse.statusCode).toBe(403);
    expect(logoutResponse.json()).toMatchObject({
      code: "INSUFFICIENT_ACCESS",
      message: "Bearer tokens must be revoked through the REVOKE_TOKEN command"
    });
    expect((await app.inject({
      method: "GET",
      url: "/api/v1/meta",
      headers: authHeaders(demo.readToken)
    })).statusCode).toBe(200);
  });

  it("returns only top-level PREVIEW_STALE for an expired Preview and persists independent rejected Receipts", async () => {
    const before = await Promise.all([
      db.selectFrom("maintenance_locks").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      db.selectFrom("inventory_claims").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow()
    ]);
    const prepared = await previewCommand(demo.writeToken, "LOCK_MAINTENANCE", {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.secondRoomId,
      arrivalDate: "2029-11-01",
      departureDate: "2029-11-02",
      reason: "HTTP expired Preview contract"
    }, "http-expired-preview");
    expect(prepared.response.statusCode, prepared.response.body).toBe(200);
    await db.updateTable("command_previews")
      .set({ expires_at: new Date(Date.now() - 1_000) })
      .where("id", "=", prepared.body.preview.previewId)
      .execute();

    const first = await confirmPreview(demo.writeToken, prepared.body.preview, "http-expired-first");
    const second = await confirmPreview(demo.writeToken, prepared.body.preview, "http-expired-second");
    expect(first.response.statusCode, first.response.body).toBe(409);
    expect(second.response.statusCode, second.response.body).toBe(409);
    for (const result of [first.body, second.body]) {
      expect(result).toMatchObject({
        executionStatus: "NOT_EXECUTED",
        businessCommitted: false,
        error: { code: "PREVIEW_STALE", details: { causeCode: "PREVIEW_EXPIRED" } }
      });
      expect(result.error?.code).not.toBe("PREVIEW_EXPIRED");
      const durable = await app.inject({
        method: "GET",
        url: `/api/v1/receipts/${result.receiptId}`,
        headers: { authorization: `Bearer ${demo.writeToken}` }
      });
      expect(durable.statusCode, durable.body).toBe(200);
      expect(durable.json()).toEqual(result);
    }
    expect(second.body.receiptId).not.toBe(first.body.receiptId);
    expect(second.body.commandId).not.toBe(first.body.commandId);

    const storedPreview = await db.selectFrom("command_previews")
      .select(["status", "used_at"])
      .where("id", "=", prepared.body.preview.previewId)
      .executeTakeFirstOrThrow();
    const after = await Promise.all([
      db.selectFrom("maintenance_locks").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      db.selectFrom("inventory_claims").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow()
    ]);
    expect(storedPreview).toEqual({ status: "EXPIRED", used_at: null });
    expect(after.map((row) => Number(row.count))).toEqual(before.map((row) => Number(row.count)));
  });

  it("allows READ queries but rejects writes through the same domain API", async () => {
    const availability = await app.inject({
      method: "GET",
      url: `/api/v1/properties/${demo.propertyId}/availability?arrivalDate=2027-05-01&departureDate=2027-05-02`,
      headers: { authorization: `Bearer ${demo.readToken}` }
    });
    expect(availability.statusCode).toBe(200);

    const denied = await previewCommand(demo.readToken, "LOCK_MAINTENANCE", {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.secondRoomId,
      arrivalDate: "2027-05-01",
      departureDate: "2027-05-02",
      reason: "READ Token must not write"
    }, "read-denied");
    expect(denied.response.statusCode).toBe(403);
    expect(denied.body).toMatchObject({ code: "INSUFFICIENT_ACCESS", retryable: false });
  });

  it("runs query, quote, Preview/Confirm, idempotent replay, and interruption recovery", async () => {
    const quote = await app.inject({
      method: "POST",
      url: "/api/v1/quotes",
      headers: writeHeaders(demo.writeToken, "recovery-order-quote"),
      payload: {
        propertyId: demo.propertyId,
        inventoryUnitId: demo.roomId,
        stayType: "TRANSIENT",
        arrivalDate: "2027-05-10",
        departureDate: "2027-05-12",
        pricingPolicyVersionId: demo.transientPolicyId
      }
    });
    expect(quote.statusCode).toBe(200);

    const flow = await executeCommand(demo.writeToken, "CREATE_ORDER", {
      propertyId: demo.propertyId,
      quoteId: quote.json().quote.quoteId,
      primaryGuest: { fullName: "Security Recovery Guest", nickname: "Security Recovery" },
      bookingChannelCode: "WECOM",
      channelOrderReference: null,
      targetCurrentContractAmountMinor: quote.json().quote.currentContractAmount.minorUnits
    }, "recovery-order");
    const firstReceipt = flow.confirmation.body;
    const replay = await app.inject({
      method: "POST",
      url: flow.confirmation.url,
      headers: flow.confirmation.headers,
      payload: flow.confirmation.payload
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      receiptId: firstReceipt.receiptId,
      commandId: firstReceipt.commandId,
      executionStatus: "EXECUTED",
      businessCommitted: true
    });

    const recovered = await app.inject({
      method: "GET",
      url: `/api/v1/command-results?propertyId=${demo.propertyId}&commandType=CREATE_ORDER&idempotencyKey=${flow.confirmation.headers["idempotency-key"]}`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({ receiptId: firstReceipt.receiptId, commandId: firstReceipt.commandId });
  });

  it("accepts a client-provisioned Token secret without persisting or returning it", async () => {
    const secret = newOpaqueSecret("qtp");
    const flow = await executeCommand(demo.writeToken, "ISSUE_TOKEN", {
      propertyId: demo.propertyId,
      subjectId: demo.agentSubjectId,
      label: "One response Token",
      accessCeiling: "WRITE",
      expiresAt: "2029-01-01T00:00:00.000Z",
      tokenSecret: secret
    }, "client-secret");
    expect(flow.confirmation.body.result).not.toHaveProperty("tokenSecret");
    expect((await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${secret}` }
    })).statusCode).toBe(200);

    const replay = await app.inject({
      method: "POST",
      url: flow.confirmation.url,
      headers: flow.confirmation.headers,
      payload: flow.confirmation.payload
    });
    const receipt = await app.inject({
      method: "GET",
      url: `/api/v1/receipts/${flow.confirmation.body.receiptId}`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    const commandResult = await app.inject({
      method: "GET",
      url: `/api/v1/command-results?propertyId=${demo.propertyId}&commandType=ISSUE_TOKEN&idempotencyKey=${flow.confirmation.headers["idempotency-key"]}`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect([replay.statusCode, receipt.statusCode, commandResult.statusCode]).toEqual([200, 200, 200]);
    expect(JSON.stringify([replay.json(), receipt.json(), commandResult.json()])).not.toContain(secret);
    expect(replay.json().result).not.toHaveProperty("tokenSecret");

    const readOnlyRecoveryRequests = [
      `/api/v1/receipts/${flow.confirmation.body.receiptId}`,
      `/api/v1/commands/${flow.confirmation.body.commandId}`,
      `/api/v1/command-results?propertyId=${demo.propertyId}&commandType=ISSUE_TOKEN&idempotencyKey=${flow.confirmation.headers["idempotency-key"]}`
    ];
    for (const url of readOnlyRecoveryRequests) {
      const denied = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${demo.readToken}` }
      });
      expect(denied.statusCode, url).toBe(403);
      expect(denied.json()).toMatchObject({ code: "INSUFFICIENT_ACCESS", retryable: false });
    }
  });

  it("supports client-provisioned secret rotation without persisting a recoverable secret", async () => {
    const oldSecret = newOpaqueSecret("qtp");
    const issued = await executeCommand(demo.writeToken, "ISSUE_TOKEN", {
      propertyId: demo.propertyId,
      subjectId: demo.agentSubjectId,
      label: "Client rotation source",
      accessCeiling: "WRITE",
      expiresAt: "2029-01-01T00:00:00.000Z",
      tokenSecret: oldSecret
    }, "client-rotation-issue");
    const oldTokenId = issued.confirmation.body.result?.tokenId as string;
    const clientSecret = newOpaqueSecret("qtp");
    const rotated = await executeCommand(oldSecret, "ROTATE_TOKEN", {
      propertyId: demo.propertyId,
      tokenId: oldTokenId,
      tokenSecret: clientSecret
    }, "client-rotation");
    expect(rotated.confirmation.body.result).not.toHaveProperty("tokenSecret");

    const oldAuthentication = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${oldSecret}` }
    });
    expect(oldAuthentication.statusCode).toBe(401);
    expect(oldAuthentication.json().code).toBe("TOKEN_REVOKED");
    expect((await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${clientSecret}` }
    })).statusCode).toBe(200);

    const recovered = await app.inject({
      method: "GET",
      url: `/api/v1/command-results?propertyId=${demo.propertyId}&commandType=ROTATE_TOKEN&idempotencyKey=${rotated.confirmation.headers["idempotency-key"]}`,
      headers: { authorization: `Bearer ${clientSecret}` }
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({ receiptId: rotated.confirmation.body.receiptId, executionStatus: "EXECUTED" });
    expect(recovered.json().result).not.toHaveProperty("tokenSecret");
    expect(JSON.stringify(recovered.json())).not.toContain(clientSecret);
  });

  it("prevents a WRITE Token from creating or rotating beyond its own expiry at Preview and Confirm", async () => {
    const shortSecret = newOpaqueSecret("qtp");
    const shortTokenId = "token_security_short_expiry";
    await db.insertInto("api_tokens").values({
      id: shortTokenId,
      subject_id: demo.agentSubjectId,
      label: "Short expiry security caller",
      secret_hash: sha256(shortSecret),
      access_ceiling: "WRITE",
      property_scope: demo.propertyId,
      expires_at: "2028-01-01T00:00:00.000Z",
      revoked_at: null,
      rotated_from_id: null,
      replaced_by_id: null
    }).execute();

    const deniedPreviewSecret = newOpaqueSecret("qtp");
    const deniedPreview = await previewCommand(shortSecret, "ISSUE_TOKEN", {
      propertyId: demo.propertyId,
      subjectId: demo.agentSubjectId,
      label: "Expiry escalation at Preview",
      accessCeiling: "WRITE",
      expiresAt: "2029-01-01T00:00:00.000Z",
      tokenSecret: deniedPreviewSecret
    }, "expiry-ceiling-preview");
    expect(deniedPreview.response.statusCode).toBe(403);
    expect(deniedPreview.body).toMatchObject({ code: "INSUFFICIENT_ACCESS", retryable: false });
    expect(await db.selectFrom("api_tokens").select("id").where("secret_hash", "=", sha256(deniedPreviewSecret)).executeTakeFirst()).toBeUndefined();

    const confirmSecret = newOpaqueSecret("qtp");
    const pending = await previewCommand(demo.writeToken, "ISSUE_TOKEN", {
      propertyId: demo.propertyId,
      subjectId: demo.agentSubjectId,
      label: "Expiry escalation at Confirm",
      accessCeiling: "WRITE",
      expiresAt: "2029-01-01T00:00:00.000Z",
      tokenSecret: confirmSecret
    }, "expiry-ceiling-pending");
    expect(pending.response.statusCode).toBe(200);
    const deniedConfirm = await confirmPreview(shortSecret, pending.body.preview, "expiry-ceiling-confirm");
    expect(deniedConfirm.response.statusCode).toBe(409);
    expect(deniedConfirm.body).toMatchObject({
      executionStatus: "NOT_EXECUTED",
      businessCommitted: false,
      error: { code: "INSUFFICIENT_ACCESS", retryable: false }
    });
    expect(await db.selectFrom("api_tokens").select("id").where("secret_hash", "=", sha256(confirmSecret)).executeTakeFirst()).toBeUndefined();

    const sessionCookie = newOpaqueSecret("qts");
    await db.insertInto("web_sessions").values({
      id: "session_security_expiry_ceiling",
      subject_id: demo.operatorSubjectId,
      secret_hash: sha256(sessionCookie),
      expires_at: "2028-01-01T00:00:00.000Z",
      revoked_at: null
    }).execute();
    const sessionSecret = newOpaqueSecret("qtp");
    const sessionPreview = await app.inject({
      method: "POST",
      url: "/api/v1/command-previews",
      cookies: { qintopia_session: sessionCookie },
      headers: {
        "idempotency-key": `session-expiry-preview-${sequence}`,
        "x-correlation-id": `session-expiry-${sequence}`
      },
      payload: {
        commandType: "ISSUE_TOKEN",
        input: {
          propertyId: demo.propertyId,
          subjectId: demo.operatorSubjectId,
          label: "Session managed long expiry",
          accessCeiling: "WRITE",
          expiresAt: "2035-01-01T00:00:00.000Z",
          tokenSecret: sessionSecret
        }
      }
    });
    expect(sessionPreview.statusCode, sessionPreview.body).toBe(200);
    const sessionPreviewBody = sessionPreview.json() as PreviewBody;
    const sessionConfirm = await app.inject({
      method: "POST",
      url: `/api/v1/command-previews/${sessionPreviewBody.preview.previewId}/confirm`,
      cookies: { qintopia_session: sessionCookie },
      headers: {
        "idempotency-key": `session-expiry-confirm-${sequence}`,
        "x-correlation-id": `session-expiry-${sequence}`
      },
      payload: {
        propertyId: demo.propertyId,
        commandType: "ISSUE_TOKEN",
        confirmation: true,
        expectedEffectHash: sessionPreviewBody.preview.effectHash,
        reason: { code: "SECURITY_CONTRACT", note: "Session credentials have no relative Token expiry ceiling" }
      }
    });
    expect(sessionConfirm.statusCode, sessionConfirm.body).toBe(200);
    expect(sessionConfirm.json().result).not.toHaveProperty("tokenSecret");
  });

  it("hides foreign Previews and cross-property Receipts", async () => {
    const foreign = await previewCommand(foreignSubjectSecret, "LOCK_MAINTENANCE", {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.secondRoomId,
      arrivalDate: "2027-06-01",
      departureDate: "2027-06-02",
      reason: "Foreign subject Preview"
    }, "foreign-preview");
    expect(foreign.response.statusCode).toBe(200);
    const foreignConfirm = await confirmPreview(demo.writeToken, foreign.body.preview, "foreign-confirm");
    expect(foreignConfirm.response.statusCode).toBe(404);
    expect(foreignConfirm.body).toMatchObject({ code: "PREVIEW_NOT_FOUND", retryable: false });

    const secondScope = await executeCommand(secondScopeSecret, "LOCK_MAINTENANCE", {
      propertyId: secondPropertyId,
      inventoryUnitId: secondUnitId,
      arrivalDate: "2027-06-03",
      departureDate: "2027-06-04",
      reason: "Cross-property Receipt"
    }, "second-scope");
    const hiddenReceipt = await app.inject({
      method: "GET",
      url: `/api/v1/receipts/${secondScope.confirmation.body.receiptId}`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(hiddenReceipt.statusCode).toBe(404);
    expect(hiddenReceipt.json().code).toBe("NOT_FOUND");
    const hiddenResult = await app.inject({
      method: "GET",
      url: `/api/v1/command-results?propertyId=${secondPropertyId}&commandType=LOCK_MAINTENANCE&idempotencyKey=${secondScope.confirmation.headers["idempotency-key"]}`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(hiddenResult.statusCode).toBe(403);
    expect(hiddenResult.json()).toMatchObject({ code: "RESOURCE_SCOPE_DENIED", retryable: false });
  });

  it("hides cross-property collection facts while preserving same-property cross-order errors", async () => {
    const createOrder = async (options: {
      token: string;
      propertyId: string;
      inventoryUnitId: string;
      pricingPolicyVersionId: string;
      prefix: string;
    }) => {
      const quote = await app.inject({
        method: "POST",
        url: "/api/v1/quotes",
        headers: writeHeaders(options.token, `${options.prefix}-quote`),
        payload: {
          propertyId: options.propertyId,
          inventoryUnitId: options.inventoryUnitId,
          stayType: "TRANSIENT",
          arrivalDate: "2027-09-10",
          departureDate: "2027-09-12",
          pricingPolicyVersionId: options.pricingPolicyVersionId
        }
      });
      expect(quote.statusCode, quote.body).toBe(200);
      const created = await executeCommand(options.token, "CREATE_ORDER", {
        propertyId: options.propertyId,
        quoteId: quote.json().quote.quoteId,
        primaryGuest: { fullName: `Cross-property probe ${options.propertyId}`, nickname: `Cross ${options.propertyId}` },
        bookingChannelCode: "YOUMUDAO",
        channelOrderReference: `TEST-SECURITY-ORDER-${options.prefix}`,
        targetCurrentContractAmountMinor: quote.json().quote.currentContractAmount.minorUnits
      }, options.prefix);
      return created.confirmation.body.result?.orderId as string;
    };

    const propertyAOrderId = await createOrder({
      token: demo.writeToken,
      propertyId: demo.propertyId,
      inventoryUnitId: demo.roomId,
      pricingPolicyVersionId: demo.transientPolicyId,
      prefix: "cross-fact-property-a-order"
    });
    const propertyBOrderId = await createOrder({
      token: secondScopeSecret,
      propertyId: secondPropertyId,
      inventoryUnitId: secondUnitId,
      pricingPolicyVersionId: secondPolicyId,
      prefix: "cross-fact-property-b-order"
    });
    const propertyAOtherOrderId = await createOrder({
      token: demo.writeToken,
      propertyId: demo.propertyId,
      inventoryUnitId: demo.secondRoomId,
      pricingPolicyVersionId: demo.transientPolicyId,
      prefix: "cross-fact-property-a-other-order"
    });
    const propertyBCollection = await executeCommand(secondScopeSecret, "RECORD_COLLECTION", {
      propertyId: secondPropertyId,
      orderId: propertyBOrderId,
      amountMinor: 5_000,
      method: "CASH",
      transactionReference: "TEST-SECURITY-TXN-PROPERTY-B",
      note: "Foreign-property collection reference probe"
    }, "cross-fact-property-b-collection");
    const propertyBFactId = propertyBCollection.confirmation.body.factRefs?.[0];
    expect(propertyBFactId).toMatch(/^fact_/);
    const propertyAOtherCollection = await executeCommand(demo.writeToken, "RECORD_COLLECTION", {
      propertyId: demo.propertyId,
      orderId: propertyAOtherOrderId,
      amountMinor: 4_000,
      method: "CASH",
      transactionReference: "TEST-SECURITY-TXN-PROPERTY-A-OTHER",
      note: "Same-property cross-order reference probe"
    }, "cross-fact-property-a-other-collection");
    const propertyAOtherFactId = propertyAOtherCollection.confirmation.body.factRefs?.[0];
    expect(propertyAOtherFactId).toMatch(/^fact_/);

    const artifactsBefore = await commandArtifactCounts();
    const withoutCorrelation = (body: Record<string, unknown>) => {
      const { correlationId: _correlationId, ...stable } = body;
      return stable;
    };
    for (const probe of [
      {
        commandType: "RECORD_REFUND" as const,
        foreignInput: { amountMinor: 100, method: "CASH", transactionReference: "TEST-SECURITY-TXN-FOREIGN-REFUND", referencesFactId: propertyBFactId },
        missingInput: { amountMinor: 100, method: "CASH", transactionReference: "TEST-SECURITY-TXN-MISSING-REFUND", referencesFactId: "fact_security_missing_refund_probe" },
        samePropertyInput: { amountMinor: 100, method: "CASH", transactionReference: "TEST-SECURITY-TXN-CROSS-ORDER-REFUND", referencesFactId: propertyAOtherFactId },
        message: "Referenced collection fact not found"
      },
      {
        commandType: "REVERSE_FACT" as const,
        foreignInput: { reversesFactId: propertyBFactId, note: "Foreign-property reversal probe" },
        missingInput: { reversesFactId: "fact_security_missing_reversal_probe", note: "Missing reversal probe" },
        samePropertyInput: { reversesFactId: propertyAOtherFactId, note: "Same-property reversal probe" },
        message: "Fact not found"
      }
    ]) {
      const baseInput = { propertyId: demo.propertyId, orderId: propertyAOrderId };
      const crossProperty = await previewCommand(demo.writeToken, probe.commandType, {
        ...baseInput,
        ...probe.foreignInput
      }, `cross-property-${probe.commandType.toLowerCase()}-probe`);
      const missing = await previewCommand(demo.writeToken, probe.commandType, {
        ...baseInput,
        ...probe.missingInput
      }, `missing-${probe.commandType.toLowerCase()}-probe`);
      const sameProperty = await previewCommand(demo.writeToken, probe.commandType, {
        ...baseInput,
        ...probe.samePropertyInput
      }, `same-property-${probe.commandType.toLowerCase()}-probe`);

      expect(crossProperty.response.statusCode).toBe(404);
      expect(missing.response.statusCode).toBe(404);
      expect(withoutCorrelation(crossProperty.response.json())).toEqual(withoutCorrelation(missing.response.json()));
      expect(crossProperty.response.json()).toMatchObject({ code: "NOT_FOUND", message: probe.message, retryable: false });
      expect(sameProperty.response.statusCode).toBe(409);
      expect(sameProperty.response.json()).toMatchObject({ code: "CROSS_ORDER_FACT_REFERENCE", retryable: false });
    }
    expect(await commandArtifactCounts()).toEqual(artifactsBefore);
    expect(await db.selectFrom("collection_facts").select(["fact_id", "order_id", "amount_minor"])
      .where("fact_id", "in", [propertyBFactId!, propertyAOtherFactId!]).orderBy("fact_id").execute())
      .toEqual([
        { fact_id: propertyAOtherFactId, order_id: propertyAOtherOrderId, amount_minor: 4_000 },
        { fact_id: propertyBFactId, order_id: propertyBOrderId, amount_minor: 5_000 }
      ].sort((left, right) => left.fact_id!.localeCompare(right.fact_id!)));
  });

  it("rejects a forged Confirm property before locking or creating command artifacts", async () => {
    const pending = await previewCommand(demo.writeToken, "LOCK_MAINTENANCE", {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.secondRoomId,
      arrivalDate: "2027-06-10",
      departureDate: "2027-06-11",
      reason: "Property scope oracle probe"
    }, "forged-confirm-property");
    expect(pending.response.statusCode, pending.response.body).toBe(200);
    const before = await commandArtifactCounts();
    const denied = await confirmPreview(
      demo.writeToken,
      pending.body.preview,
      "forged-confirm-property",
      "prop_security_not_in_credential_scope"
    );
    expect(denied.response.statusCode, denied.response.body).toBe(403);
    expect(denied.body).toMatchObject({ code: "RESOURCE_SCOPE_DENIED", retryable: false });
    expect(await commandArtifactCounts()).toEqual(before);
  });

  it("rejects foreign Token lifecycle targets without revealing existence or creating artifacts", async () => {
    const before = await commandArtifactCounts();
    for (const subjectId of [demo.operatorSubjectId, disabledForeignSubjectId, "subject_security_missing_foreign"]) {
      const response = await previewCommand(demo.writeToken, "ISSUE_TOKEN", {
        propertyId: demo.propertyId,
        subjectId,
        label: "Foreign subject enumeration probe",
        accessCeiling: "WRITE",
        expiresAt: "2029-01-01T00:00:00.000Z",
        tokenSecret: newOpaqueSecret("qtp")
      }, "foreign-subject-probe");
      expect(response.response.statusCode).toBe(403);
      expect(response.body).toMatchObject({ code: "RESOURCE_SCOPE_DENIED", retryable: false });
    }

    const tokenIds = ["token_security_foreign_subject", revokedForeignTokenId, "token_security_missing_foreign"];
    for (const commandType of ["ROTATE_TOKEN", "REVOKE_TOKEN"] as const) {
      for (const tokenId of tokenIds) {
        const response = await previewCommand(demo.writeToken, commandType, {
          propertyId: demo.propertyId,
          tokenId,
          ...(commandType === "ROTATE_TOKEN" ? { tokenSecret: newOpaqueSecret("qtp") } : {})
        }, `foreign-token-${commandType.toLowerCase()}`);
        expect(response.response.statusCode).toBe(404);
        expect(response.body).toMatchObject({ code: "NOT_FOUND", retryable: false });
      }
    }
    expect(await commandArtifactCounts()).toEqual(before);
  });

  it("revalidates grant downgrade and Token revocation before Confirm or replay", async () => {
    const windowSecret = newOpaqueSecret("qtp");
    const issued = await executeCommand(demo.writeToken, "ISSUE_TOKEN", {
      propertyId: demo.propertyId,
      subjectId: demo.agentSubjectId,
      label: "Authorization window Token",
      accessCeiling: "WRITE",
      expiresAt: "2029-01-01T00:00:00.000Z",
      tokenSecret: windowSecret
    }, "authorization-window-issue");
    const windowTokenId = issued.confirmation.body.result?.tokenId as string;
    const successful = await executeCommand(windowSecret, "LOCK_MAINTENANCE", {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.secondRoomId,
      arrivalDate: "2027-07-01",
      departureDate: "2027-07-02",
      reason: "Authorization replay control"
    }, "authorization-success");
    const pendingDowngrade = await previewCommand(windowSecret, "LOCK_MAINTENANCE", {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.secondRoomId,
      arrivalDate: "2027-07-03",
      departureDate: "2027-07-04",
      reason: "Downgrade before Confirm"
    }, "downgrade-pending");
    expect(pendingDowngrade.response.statusCode).toBe(200);

    await db.updateTable("subject_property_grants").set({ access_level: "READ" })
      .where("subject_id", "=", demo.agentSubjectId).where("property_id", "=", demo.propertyId).execute();
    const beforeDowngradedConfirm = await commandArtifactCounts();
    const downgradedConfirm = await confirmPreview(windowSecret, pendingDowngrade.body.preview, "downgrade-confirm");
    expect(downgradedConfirm.response.statusCode).toBe(403);
    expect(downgradedConfirm.body).toMatchObject({ code: "INSUFFICIENT_ACCESS", retryable: false });
    expect(await commandArtifactCounts()).toEqual(beforeDowngradedConfirm);
    const downgradedReplay = await app.inject({
      method: "POST",
      url: successful.confirmation.url,
      headers: successful.confirmation.headers,
      payload: successful.confirmation.payload
    });
    expect(downgradedReplay.statusCode).toBe(403);
    expect(downgradedReplay.json().code).toBe("INSUFFICIENT_ACCESS");
    await db.updateTable("subject_property_grants").set({ access_level: "WRITE" })
      .where("subject_id", "=", demo.agentSubjectId).where("property_id", "=", demo.propertyId).execute();

    const pendingRevocation = await previewCommand(windowSecret, "LOCK_MAINTENANCE", {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.secondRoomId,
      arrivalDate: "2027-07-05",
      departureDate: "2027-07-06",
      reason: "Revocation before Confirm"
    }, "revocation-pending");
    expect(pendingRevocation.response.statusCode).toBe(200);
    await executeCommand(demo.writeToken, "REVOKE_TOKEN", {
      propertyId: demo.propertyId,
      tokenId: windowTokenId
    }, "authorization-window-revoke");
    const revokedConfirm = await confirmPreview(windowSecret, pendingRevocation.body.preview, "revoked-confirm");
    expect(revokedConfirm.response.statusCode).toBe(401);
    expect(revokedConfirm.body).toMatchObject({ code: "TOKEN_REVOKED", retryable: false });
    expect(await db.selectFrom("maintenance_locks").select("id")
      .where("arrival_date", "in", ["2027-07-03", "2027-07-05"]).execute()).toHaveLength(0);
  });

  it("rejects invalid expiry and reports each missing write header precisely", async () => {
    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/command-previews",
      headers: writeHeaders(demo.writeToken, "invalid-expiry"),
      payload: {
        commandType: "ISSUE_TOKEN",
        input: {
          propertyId: demo.propertyId,
          subjectId: demo.agentSubjectId,
          label: "Invalid expiry",
          accessCeiling: "READ",
          expiresAt: "not-a-date",
          tokenSecret: newOpaqueSecret("qtp")
        }
      }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe("VALIDATION_ERROR");
    const past = await previewCommand(demo.writeToken, "ISSUE_TOKEN", {
      propertyId: demo.propertyId,
      subjectId: demo.agentSubjectId,
      label: "Past expiry",
      accessCeiling: "READ",
      expiresAt: "2020-01-01T00:00:00.000Z",
      tokenSecret: newOpaqueSecret("qtp")
    }, "past-expiry");
    expect(past.response.statusCode).toBe(400);
    expect(past.body).toMatchObject({ code: "VALIDATION_ERROR", retryable: false });
    const rotationWithoutClientSecret = await app.inject({
      method: "POST",
      url: "/api/v1/command-previews",
      headers: writeHeaders(demo.writeToken, "rotation-without-client-secret"),
      payload: {
        commandType: "ROTATE_TOKEN",
        input: { propertyId: demo.propertyId, tokenId: "token_demo_write" }
      }
    });
    expect(rotationWithoutClientSecret.statusCode).toBe(400);
    expect(rotationWithoutClientSecret.json().code).toBe("VALIDATION_ERROR");

    const payload = {
      commandType: "LOCK_MAINTENANCE",
      input: {
        propertyId: demo.propertyId,
        inventoryUnitId: demo.secondRoomId,
        arrivalDate: "2027-08-01",
        departureDate: "2027-08-02",
        reason: "Missing header contract"
      }
    };
    const missingIdempotency = await app.inject({
      method: "POST",
      url: "/api/v1/command-previews",
      headers: { ...authHeaders(demo.writeToken), "x-correlation-id": "missing-idempotency" },
      payload
    });
    expect(missingIdempotency.statusCode).toBe(400);
    expect(missingIdempotency.json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    const missingCorrelation = await app.inject({
      method: "POST",
      url: "/api/v1/command-previews",
      headers: { ...authHeaders(demo.writeToken), "idempotency-key": "missing-correlation" },
      payload
    });
    expect(missingCorrelation.statusCode).toBe(400);
    expect(missingCorrelation.json().code).toBe("CORRELATION_ID_REQUIRED");
  });

  it("accepts every finite error-details shape in Error and persisted Receipt contracts", () => {
    const details = [
      { expirationFactId: "fact_expiration" },
      { reversalFactId: "fact_reversal" },
      { activeRefunded: 1200 },
      { commandId: "command_unknown" },
      { activeQuoteCount: "200", limit: 200 },
      { availableBalance: "2147483648", minimum: "0", maximum: "2147483647" },
      { orderId: "order_coverage_conflict", serviceDate: "2027-08-02", coverageId: "coverage_conflict" },
      { orderId: "order_invalid_timeline", serviceDate: "2027-08-03", activeClaimIds: ["claim_one", "claim_two"] }
    ];
    for (const [index, detail] of details.entries()) {
      const error = {
        code: "ENTITLEMENT_CONFLICT",
        message: "Finite error details",
        correlationId: `details-${index}`,
        retryable: false,
        details: detail
      };
      expect(Value.Check(ErrorResponse, error), JSON.stringify(detail)).toBe(true);
      expect(Value.Check(ReceiptSchema, {
        receiptId: `receipt_details_${index}`,
        commandId: `command_details_${index}`,
        executionStatus: "NOT_EXECUTED",
        businessCommitted: false,
        correlationId: `details-${index}`,
        error,
        resourceRefs: [],
        factRefs: []
      }), JSON.stringify(detail)).toBe(true);
    }
  });

  it("returns the stable retryable ErrorDto when a route rate limit is exceeded", async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username: `invalid-security-${attempt}`, password: "invalid-password" }
      });
      expect(response.statusCode).toBe(401);
    }
    const limited = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "x-correlation-id": "rate-limit-contract" },
      payload: { username: "invalid-security-limited", password: "invalid-password" }
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({
      code: "RATE_LIMITED",
      correlationId: "rate-limit-contract",
      retryable: true
    });
  });

  it("rate limits repeated Bearer authentication attempts without affecting the public contract endpoint", async () => {
    const originalLimit = process.env.BEARER_AUTH_RATE_LIMIT_MAX;
    process.env.BEARER_AUTH_RATE_LIMIT_MAX = "2";
    const limitedApp = await buildServer(createDatabase(securityContractDatabaseUrl));
    await limitedApp.ready();
    try {
      const publicContract = await limitedApp.inject({
        method: "GET",
        url: "/api/v1/openapi.json",
        headers: { authorization: "Bearer ignored-on-public-contract" }
      });
      expect(publicContract.statusCode).toBe(200);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const invalid = await limitedApp.inject({
          method: "GET",
          url: "/api/v1/me",
          headers: { authorization: `Bearer invalid-rate-probe-${attempt}` }
        });
        expect(invalid.statusCode).toBe(401);
      }
      const limited = await limitedApp.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: { authorization: "Bearer invalid-rate-probe-final", "x-correlation-id": "bearer-rate-limit-contract" }
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBeDefined();
      expect(limited.json()).toMatchObject({
        code: "RATE_LIMITED",
        correlationId: "bearer-rate-limit-contract",
        retryable: true
      });
    } finally {
      await limitedApp.close();
      if (originalLimit === undefined) delete process.env.BEARER_AUTH_RATE_LIMIT_MAX;
      else process.env.BEARER_AUTH_RATE_LIMIT_MAX = originalLimit;
    }
  });

  it("serializes stayTimeline effects for every pricing-affecting stay change", async () => {
    const quote = await app.inject({
      method: "POST",
      url: "/api/v1/quotes",
      headers: writeHeaders(demo.writeToken, "timeline-order-quote"),
      payload: {
        propertyId: demo.propertyId,
        inventoryUnitId: demo.roomId,
        stayType: "TRANSIENT",
        arrivalDate: "2028-02-10",
        departureDate: "2028-02-14",
        pricingPolicyVersionId: demo.transientPolicyId
      }
    });
    expect(quote.statusCode).toBe(200);
    const created = await executeCommand(demo.writeToken, "CREATE_ORDER", {
      propertyId: demo.propertyId,
      quoteId: quote.json().quote.quoteId,
      primaryGuest: { fullName: "Timeline Contract Guest", nickname: "Timeline Guest" },
      bookingChannelCode: "CTRIP",
      channelOrderReference: "TEST-SECURITY-ORDER-TIMELINE",
      targetCurrentContractAmountMinor: quote.json().quote.currentContractAmount.minorUnits
    }, "timeline-order");
    const orderId = created.confirmation.body.result?.orderId as string;
    const previews = await Promise.all([
      previewCommand(demo.writeToken, "SHORTEN_STAY", {
        propertyId: demo.propertyId,
        orderId,
        newDepartureDate: "2028-02-13"
      }, "timeline-shorten"),
      previewCommand(demo.writeToken, "EXTEND_STAY", {
        propertyId: demo.propertyId,
        orderId,
        newDepartureDate: "2028-02-15"
      }, "timeline-extend"),
      previewCommand(demo.writeToken, "MOVE_UNIT", {
        propertyId: demo.propertyId,
        orderId,
        newInventoryUnitId: demo.secondRoomId,
        effectiveDate: "2028-02-12"
      }, "timeline-move"),
      previewCommand(demo.writeToken, "REPRICE_ORDER", {
        propertyId: demo.propertyId,
        orderId,
        targetCurrentContractAmountMinor: 48_100
      }, "timeline-reprice")
    ]);
    for (const candidate of previews) {
      expect(candidate.response.statusCode, candidate.response.body).toBe(200);
      const effect = candidate.body.preview.effect;
      const timeline = effect.stayTimeline
        ?? (effect.after as { stayTimeline?: unknown } | undefined)?.stayTimeline;
      expect(timeline, candidate.body.preview.commandType).toEqual(expect.arrayContaining([
        expect.objectContaining({ serviceDate: "2028-02-10", inventoryUnitId: expect.any(String) })
      ]));
    }
  });

  it("logs but does not expose internal error messages or details", async () => {
    const quote = await app.inject({
      method: "POST",
      url: "/api/v1/quotes",
      headers: writeHeaders(demo.writeToken, "internal-error-order-quote"),
      payload: {
        propertyId: demo.propertyId,
        inventoryUnitId: demo.roomId,
        stayType: "TRANSIENT",
        arrivalDate: "2028-03-10",
        departureDate: "2028-03-12",
        pricingPolicyVersionId: demo.transientPolicyId
      }
    });
    expect(quote.statusCode).toBe(200);
    const created = await executeCommand(demo.writeToken, "CREATE_ORDER", {
      propertyId: demo.propertyId,
      quoteId: quote.json().quote.quoteId,
      primaryGuest: { fullName: "Internal Error Contract Guest", nickname: "Internal Error" },
      bookingChannelCode: "MEITUAN",
      channelOrderReference: "TEST-SECURITY-ORDER-INTERNAL-ERROR",
      targetCurrentContractAmountMinor: quote.json().quote.currentContractAmount.minorUnits
    }, "internal-error-order");
    const orderId = created.confirmation.body.result?.orderId as string;
    await db.updateTable("inventory_claims").set({ active: false, released_at: new Date() })
      .where("source_type", "=", "ORDER_SEGMENT")
      .where("service_date", "=", "2028-03-10")
      .where("active", "=", true)
      .execute();

    const internal = await previewCommand(demo.writeToken, "SHORTEN_STAY", {
      propertyId: demo.propertyId,
      orderId,
      newDepartureDate: "2028-03-11"
    }, "internal-error-probe");
    expect(internal.response.statusCode).toBe(500);
    expect(internal.response.json()).toEqual({
      code: "INTERNAL_ERROR",
      message: "Internal server error",
      correlationId: internal.headers["x-correlation-id"],
      retryable: false
    });
    expect(internal.response.body).not.toContain(orderId);
    expect(internal.response.body).not.toContain("activeClaimIds");
  });
});

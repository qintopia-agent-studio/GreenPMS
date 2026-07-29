import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";
import type { CommandType } from "@qintopia/contracts";
import { parseLocalDate, sha256, todayInTimeZone } from "@qintopia/domain";
import type { Database } from "@qintopia/db";
import { buildServer } from "../../apps/api/src/server.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { resetDatabase } from "../helpers/database.ts";

const agentJourneyDatabaseUrl = process.env.AGENT_JOURNEY_CONTRACT_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_agent_journey_contract";
const foreignSubjectId = "subject_agent_journey_foreign";
const foreignTokenId = "token_agent_journey_foreign";
const foreignToken = "qtp_agent_journey_foreign_2026";
const outOfScopeSubjectId = "subject_agent_journey_out_of_scope";
const outOfScopeTokenId = "token_agent_journey_out_of_scope";
const outOfScopeToken = "qtp_agent_journey_out_of_scope_2026";
const memberRoomId = "unit_room_d_gen_01";

type PreviewDto = {
  previewId: string;
  commandType: CommandType;
  effectHash: string;
  effect: Record<string, unknown>;
  expiresAt: string;
};

type ReceiptDto = {
  receiptId: string;
  commandId: string;
  executionStatus: "EXECUTED" | "NOT_EXECUTED" | "UNKNOWN";
  businessCommitted: boolean;
  correlationId: string;
  result?: Record<string, unknown>;
  error?: { code: string; retryable: boolean };
  resourceRefs: string[];
  factRefs: string[];
  committedAt?: string;
};

type PreviewResponse = {
  preview: PreviewDto;
  receipt: ReceiptDto;
};

type CommandRun = {
  preview: PreviewDto;
  receipt: ReceiptDto;
  confirmIdempotencyKey: string;
  correlationId: string;
};

let app: FastifyInstance;
let db: Kysely<Database>;
let lifecycleQueryOrderId: string | undefined;
let reportActiveOwnerConfirmObserved: (() => void) | undefined;
const originalLogLevel = process.env.LOG_LEVEL;

function shiftLocalDate(value: string, days: number): string {
  const date = parseLocalDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function authHeaders(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function waitForUnknownRecovery(commandType: CommandType, idempotencyKey: string) {
  const lockKey = `qintopia:command:${demo.agentSubjectId}:${demo.propertyId}:${commandType}:${idempotencyKey}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const acquired = await db.connection().execute(async (connection) => {
      const result = await sql<{ acquired: boolean }>`
        select pg_try_advisory_lock(hashtextextended(${lockKey}, 0::bigint)) as acquired
      `.execute(connection);
      if (result.rows[0]?.acquired) {
        await sql`select pg_advisory_unlock(hashtextextended(${lockKey}, 0::bigint))`.execute(connection);
        return true;
      }
      return false;
    });
    if (!acquired) {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/command-results?propertyId=${demo.propertyId}&commandType=${commandType}&idempotencyKey=${idempotencyKey}`,
        headers: { authorization: `Bearer ${demo.writeToken}` }
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ executionStatus: "UNKNOWN", businessCommitted: false });
      return response;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the active HTTP command execution lock");
}

async function runCommand(
  token: string,
  commandType: CommandType,
  input: Record<string, unknown>,
  prefix: string
): Promise<CommandRun> {
  const correlationId = `agent-journey-${prefix}`;
  const previewIdempotencyKey = `${prefix}-preview`;
  const previewRequest = {
    method: "POST" as const,
    url: "/api/v1/command-previews",
    headers: {
      ...authHeaders(token),
      "idempotency-key": previewIdempotencyKey,
      "x-correlation-id": correlationId
    },
    payload: { commandType, input }
  };
  const previewResponse = await app.inject(previewRequest);
  expect(previewResponse.statusCode, previewResponse.body).toBe(200);
  const previewBody = previewResponse.json() as PreviewResponse;
  expect(previewBody.preview).toMatchObject({ commandType, effectHash: expect.any(String) });
  expect(previewBody.receipt).toMatchObject({
    executionStatus: "EXECUTED",
    businessCommitted: true,
    correlationId,
    result: { preview: { previewId: previewBody.preview.previewId } }
  });

  const previewReplay = await app.inject(previewRequest);
  expect(previewReplay.statusCode, previewReplay.body).toBe(200);
  expect(previewReplay.json()).toEqual(previewBody);

  const confirmIdempotencyKey = `${prefix}-confirm`;
  const reason = commandType === "CREATE_ORDER"
    ? { code: "CREATE_STANDARD_ORDER", note: "" }
    : {
        code: "AGENT_HTTP_ACCEPTANCE",
        note: `Confirm ${commandType} for the scoped agent HTTP journey`
      };
  const confirmRequest = {
    method: "POST" as const,
    url: `/api/v1/command-previews/${previewBody.preview.previewId}/confirm`,
    headers: {
      ...authHeaders(token),
      "idempotency-key": confirmIdempotencyKey,
      "x-correlation-id": correlationId
    },
    payload: {
      propertyId: input.propertyId,
      commandType,
      confirmation: true,
      expectedEffectHash: previewBody.preview.effectHash,
      reason
    }
  };
  const confirmResponse = await app.inject(confirmRequest);
  expect(confirmResponse.statusCode, confirmResponse.body).toBe(200);
  const receipt = confirmResponse.json() as ReceiptDto;
  expect(receipt).toMatchObject({
    receiptId: expect.any(String),
    commandId: expect.any(String),
    executionStatus: "EXECUTED",
    businessCommitted: true,
    correlationId,
    resourceRefs: expect.any(Array),
    factRefs: expect.any(Array)
  });

  const confirmReplay = await app.inject(confirmRequest);
  expect(confirmReplay.statusCode, confirmReplay.body).toBe(200);
  expect(confirmReplay.json()).toEqual(receipt);

  const recovery = await app.inject({
    method: "GET",
    url: `/api/v1/command-results?propertyId=${demo.propertyId}&commandType=${commandType}&idempotencyKey=${confirmIdempotencyKey}`,
    headers: { authorization: `Bearer ${token}` }
  });
  expect(recovery.statusCode, recovery.body).toBe(200);
  expect(recovery.json()).toEqual(receipt);

  const audit = await app.inject({
    method: "GET",
    url: `/api/v1/audit?propertyId=${demo.propertyId}&correlationId=${correlationId}&limit=20`,
    headers: { authorization: `Bearer ${token}` }
  });
  expect(audit.statusCode, audit.body).toBe(200);
  expect(audit.json().entries).toEqual(expect.arrayContaining([
    expect.objectContaining({
      subject_id: demo.agentSubjectId,
      credential_id: "token_demo_write",
      action: commandType,
      decision: "ALLOWED",
      correlation_id: correlationId,
      reason
    })
  ]));

  return { preview: previewBody.preview, receipt, confirmIdempotencyKey, correlationId };
}

beforeAll(async () => {
  process.env.LOG_LEVEL = "silent";
  db = await resetDatabase(agentJourneyDatabaseUrl);
  await db.insertInto("subjects").values({
    id: foreignSubjectId,
    username: "agent-journey-foreign",
    display_name: "Foreign Journey Subject",
    password_salt: "agent-journey-foreign",
    password_hash: "not-used-by-this-token-test",
    status: "ACTIVE",
    auth_version: 1
  }).execute();
  await db.insertInto("subject_property_grants").values({
    subject_id: foreignSubjectId,
    property_id: demo.propertyId,
    access_level: "READ"
  }).execute();
  await db.insertInto("api_tokens").values({
    id: foreignTokenId,
    subject_id: foreignSubjectId,
    label: "Foreign same-property read Token",
    secret_hash: sha256(foreignToken),
    access_ceiling: "READ",
    property_scope: demo.propertyId,
    expires_at: "2030-01-01T00:00:00.000Z",
    revoked_at: null,
    rotated_from_id: null,
    replaced_by_id: null
  }).execute();
  await db.insertInto("subjects").values({
    id: outOfScopeSubjectId,
    username: "agent-journey-out-of-scope",
    display_name: "Out Of Scope Journey Subject",
    password_salt: "agent-journey-out-of-scope",
    password_hash: "not-used-by-this-token-test",
    status: "ACTIVE",
    auth_version: 1
  }).execute();
  await db.insertInto("api_tokens").values({
    id: outOfScopeTokenId,
    subject_id: outOfScopeSubjectId,
    label: "Out-of-scope read Token",
    secret_hash: sha256(outOfScopeToken),
    access_ceiling: "READ",
    property_scope: demo.propertyId,
    expires_at: "2030-01-01T00:00:00.000Z",
    revoked_at: null,
    rotated_from_id: null,
    replaced_by_id: null
  }).execute();
  app = await buildServer(db);
  app.addHook("onRequest", async (request) => {
    if (
      request.method === "POST"
      && request.url.endsWith("/confirm")
      && request.headers["x-correlation-id"] === "agent-http-active-recovery"
    ) {
      reportActiveOwnerConfirmObserved?.();
    }
  });
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
  if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalLogLevel;
});

describe("scoped agent HTTP core journey", () => {
  it("executes the member stay journey and preserves authorization, idempotency, audit, and recovery contracts", async () => {
    const arrivalDate = todayInTimeZone("Asia/Shanghai");
    const secondServiceDate = shiftLocalDate(arrivalDate, 1);
    const finalServiceDate = shiftLocalDate(arrivalDate, 2);
    const originalDepartureDate = shiftLocalDate(arrivalDate, 3);
    const shortenedDepartureDate = finalServiceDate;
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json()).toEqual({
      subjectId: demo.agentSubjectId,
      displayName: "Demo Agent",
      credentialType: "TOKEN",
      propertyAccess: { [demo.propertyId]: "WRITE" }
    });

    const availability = await app.inject({
      method: "GET",
      url: `/api/v1/properties/${demo.propertyId}/availability?arrivalDate=${arrivalDate}&departureDate=${originalDepartureDate}&unitKind=ROOM`,
      headers: { authorization: `Bearer ${demo.readToken}` }
    });
    expect(availability.statusCode, availability.body).toBe(200);
    expect(availability.json().units).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: demo.roomId, available: true })
    ]));

    const readWriteAttempt = await app.inject({
      method: "POST",
      url: "/api/v1/command-previews",
      headers: {
        ...authHeaders(demo.readToken),
        "idempotency-key": "agent-journey-read-denied-preview",
        "x-correlation-id": "agent-journey-read-denied"
      },
      payload: {
        commandType: "LOCK_MAINTENANCE",
        input: {
          propertyId: demo.propertyId,
          inventoryUnitId: demo.secondRoomId,
          arrivalDate,
          departureDate: secondServiceDate,
          reason: "READ Token boundary acceptance"
        }
      }
    });
    expect(readWriteAttempt.statusCode, readWriteAttempt.body).toBe(403);
    expect(readWriteAttempt.json()).toMatchObject({
      code: "INSUFFICIENT_ACCESS",
      correlationId: "agent-journey-read-denied",
      retryable: false
    });

    const quoteRequest = {
      method: "POST",
      url: "/api/v1/quotes",
      headers: {
        ...authHeaders(demo.readToken),
        "idempotency-key": "agent-journey-create-quote",
        "x-correlation-id": "agent-journey-create-quote"
      },
      payload: {
        propertyId: demo.propertyId,
        inventoryUnitId: memberRoomId,
        stayType: "TRANSIENT",
        arrivalDate,
        departureDate: originalDepartureDate,
        pricingPolicyVersionId: demo.publicPricingPolicyId,
        memberId: demo.memberId
      }
    } as const;
    const quoteResponse = await app.inject(quoteRequest);
    expect(quoteResponse.statusCode, quoteResponse.body).toBe(200);
    const quoteCommand = quoteResponse.json() as { quote: Record<string, unknown>; receipt: ReceiptDto };
    const quote = quoteCommand.quote;
    expect(quoteCommand.receipt).toMatchObject({
      executionStatus: "EXECUTED",
      businessCommitted: true,
      correlationId: "agent-journey-create-quote",
      result: { quote: { quoteId: quote.quoteId } },
      resourceRefs: [quote.quoteId],
      factRefs: []
    });
    expect(quote).toMatchObject({
      propertyId: demo.propertyId,
      inventoryUnitId: memberRoomId,
      memberId: demo.memberId,
      memberContractId: demo.memberContractId,
      pricingPolicyVersionId: demo.publicPricingPolicyId,
      coverageSet: [
        { serviceDate: arrivalDate, inventoryUnitId: memberRoomId, unitKind: "ROOM_NIGHT", entitlementLotId: demo.roomLotId },
        { serviceDate: secondServiceDate, inventoryUnitId: memberRoomId, unitKind: "ROOM_NIGHT", entitlementLotId: demo.roomLotId }
      ],
      cashRemainder: { currency: "CNY", minorUnits: 13_000 },
      currentContractAmount: { currency: "CNY", minorUnits: 13_000 }
    });
    expect(quote.cashLines).toEqual([
      expect.objectContaining({ serviceDate: finalServiceDate, amount: { currency: "CNY", minorUnits: 13_000 } })
    ]);
    const quoteReplay = await app.inject(quoteRequest);
    expect(quoteReplay.statusCode, quoteReplay.body).toBe(200);
    expect(quoteReplay.json()).toEqual(quoteCommand);
    const quoteRecovery = await app.inject({
      method: "GET",
      url: `/api/v1/command-results?propertyId=${demo.propertyId}&commandType=CREATE_QUOTE&idempotencyKey=agent-journey-create-quote`,
      headers: { authorization: `Bearer ${demo.readToken}` }
    });
    expect(quoteRecovery.statusCode, quoteRecovery.body).toBe(200);
    expect(quoteRecovery.json()).toEqual(quoteCommand.receipt);

    const created = await runCommand(demo.writeToken, "CREATE_ORDER", {
      propertyId: demo.propertyId,
      quoteId: quote.quoteId,
      primaryGuest: {
        fullName: "Scoped Agent Journey Guest",
        nickname: "Scoped Guest",
        phone: "13800000000",
        documentNumber: "AGENT-HTTP-2028"
      }
    }, "create-order");
    expect(created.preview.effect).toMatchObject({
      primaryGuest: { fullName: "Scoped Agent Journey Guest", nickname: "Scoped Guest" },
      occupants: [{
        id: expect.stringMatching(/^occupant_/),
        ordinal: 1,
        role: "PRIMARY",
        fullName: "Scoped Agent Journey Guest",
        nickname: "Scoped Guest",
        phone: "13800000000",
        documentNumber: "AGENT-HTTP-2028"
      }],
      occupancyCapacity: 1,
      bookingChannelCode: null,
      channelOrderReference: null,
      pricingPolicyVersionId: demo.publicPricingPolicyId,
      pricingDecision: {
        pricingBasis: "MEMBER_ENTITLEMENT",
        policyBaseAmount: quote.currentContractAmount,
        targetCurrentContractAmount: quote.currentContractAmount,
        differenceFromPolicy: { currency: "CNY", minorUnits: 0 },
        manualAdjustmentMinor: 0,
        differenceExceedsThreshold: false,
        reason: { code: "CREATE_ORDER_MEMBER", note: "" }
      }
    });
    const occupantId = (created.preview.effect.occupants as Array<{ id: string }>)[0]!.id;
    expect(created.receipt.result).toMatchObject({
      primaryGuest: { fullName: "Scoped Agent Journey Guest", nickname: "Scoped Guest" },
      occupants: [{
        id: occupantId,
        orderId: expect.stringMatching(/^order_/),
        ordinal: 1,
        role: "PRIMARY",
        fullName: "Scoped Agent Journey Guest",
        nickname: "Scoped Guest",
        phone: "13800000000",
        documentNumber: "AGENT-HTTP-2028"
      }],
      bookingChannelCode: null,
      channelOrderReference: null,
      pricingPolicyVersionId: demo.publicPricingPolicyId,
      pricingDecision: created.preview.effect.pricingDecision
    });
    const orderId = created.receipt.result?.orderId as string;
    expect(orderId).toMatch(/^order_/);
    lifecycleQueryOrderId = orderId;
    expect(created.receipt.resourceRefs).toEqual(expect.arrayContaining([orderId, occupantId]));

    const createdOrderResponse = await app.inject({
      method: "GET",
      url: `/api/v1/orders/${orderId}`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(createdOrderResponse.statusCode, createdOrderResponse.body).toBe(200);
    const createdOrder = createdOrderResponse.json();
    expect(createdOrder.occupants).toEqual([{
      id: occupantId,
      orderId,
      ordinal: 1,
      role: "PRIMARY",
      fullName: "Scoped Agent Journey Guest",
      nickname: "Scoped Guest",
      phone: "13800000000",
      documentNumber: "AGENT-HTTP-2028",
      createdAt: expect.any(String)
    }]);
    expect(createdOrder.originalArrangement).toEqual({
      arrivalDate,
      departureDate: originalDepartureDate,
      intervals: [{ inventoryUnitId: memberRoomId, arrivalDate, departureDate: originalDepartureDate }]
    });
    expect(createdOrder.effectiveArrangement).toMatchObject({
      presentation: "CURRENT",
      businessDate: arrivalDate,
      arrivalDate,
      departureDate: originalDepartureDate,
      intervals: [{ inventoryUnitId: memberRoomId, arrivalDate, departureDate: originalDepartureDate }]
    });
    expect(createdOrder.fulfillment).toEqual({ state: "NOT_CHECKED_IN", checkIn: null, checkOut: null });
    expect(createdOrder.arrangementHistory).toEqual([
      expect.objectContaining({
        type: "INITIAL_BOOKING",
        before: null,
        after: createdOrder.originalArrangement,
        pricingSummary: expect.any(Object),
        fundsSummary: expect.any(Object)
      })
    ]);
    const hiddenOrder = await app.inject({
      method: "GET",
      url: `/api/v1/orders/${orderId}`,
      headers: { authorization: `Bearer ${outOfScopeToken}` }
    });
    expect([403, 404]).toContain(hiddenOrder.statusCode);
    expect(hiddenOrder.body).not.toContain("Scoped Agent Journey Guest");
    expect(hiddenOrder.body).not.toContain("13800000000");
    expect(hiddenOrder.body).not.toContain("AGENT-HTTP-2028");
    const heldCoverage = createdOrder.coverageSet.filter((item: { status: string }) => item.status === "HELD");
    expect(heldCoverage).toHaveLength(2);
    expect(created.receipt.resourceRefs).toEqual(expect.arrayContaining(heldCoverage.map((item: { id: string }) => item.id)));

    const memberAfterCreate = await app.inject({
      method: "GET",
      url: `/api/v1/members/${demo.memberId}?propertyId=${demo.propertyId}`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(memberAfterCreate.statusCode, memberAfterCreate.body).toBe(200);
    const holdFacts = memberAfterCreate.json().ledger.filter((entry: { order_id: string | null; entry_type: string }) => (
      entry.order_id === orderId && entry.entry_type === "HOLD"
    ));
    expect(holdFacts).toHaveLength(2);
    expect(created.receipt.factRefs).toEqual(expect.arrayContaining(holdFacts.map((entry: { fact_id: string }) => entry.fact_id)));

    const firstCollection = await runCommand(demo.writeToken, "RECORD_COLLECTION", {
      propertyId: demo.propertyId,
      orderId,
      amountMinor: 6_000,
      method: "CASH",
      transactionReference: "TEST-AGENT-TXN-COLLECTION-ONE",
      note: "First independent installment"
    }, "collection-one");
    expect(firstCollection.preview.effect).toMatchObject({ transactionReference: "TEST-AGENT-TXN-COLLECTION-ONE" });
    expect(firstCollection.receipt.result).toMatchObject({ transactionReference: "TEST-AGENT-TXN-COLLECTION-ONE" });
    expect(firstCollection.receipt.factRefs).toHaveLength(1);
    const firstCollectionFactId = firstCollection.receipt.factRefs[0]!;

    const secondCollection = await runCommand(demo.writeToken, "RECORD_COLLECTION", {
      propertyId: demo.propertyId,
      orderId,
      amountMinor: 6_000,
      method: "BANK_TRANSFER",
      transactionReference: "TEST-AGENT-TXN-COLLECTION-TWO",
      note: "Second independent installment"
    }, "collection-two");
    expect(secondCollection.preview.effect).toMatchObject({ transactionReference: "TEST-AGENT-TXN-COLLECTION-TWO" });
    expect(secondCollection.receipt.result).toMatchObject({ transactionReference: "TEST-AGENT-TXN-COLLECTION-TWO" });
    expect(secondCollection.receipt.factRefs).toHaveLength(1);
    expect(secondCollection.receipt.factRefs[0]).not.toBe(firstCollectionFactId);

    const shortened = await runCommand(demo.writeToken, "RESCHEDULE_STAY", {
      propertyId: demo.propertyId,
      orderId,
      newArrivalDate: arrivalDate,
      newDepartureDate: shortenedDepartureDate
    }, "shorten-stay");
    expect(shortened.receipt.result).toMatchObject({ orderId, pricingRevisionId: expect.any(String) });

    const refund = await runCommand(demo.writeToken, "RECORD_REFUND", {
      propertyId: demo.propertyId,
      orderId,
      amountMinor: 3_000,
      referencesFactId: firstCollectionFactId,
      method: "CASH",
      transactionReference: "TEST-AGENT-TXN-REFUND-ONE",
      note: "Partial refund referencing the first installment"
    }, "refund-first-collection");
    expect(refund.preview.effect).toMatchObject({ transactionReference: "TEST-AGENT-TXN-REFUND-ONE" });
    expect(refund.receipt.result).toMatchObject({ transactionReference: "TEST-AGENT-TXN-REFUND-ONE" });
    expect(refund.receipt.factRefs).toHaveLength(1);
    const refundFactId = refund.receipt.factRefs[0]!;
    const refundFactResponse = await app.inject({
      method: "GET",
      url: `/api/v1/facts/${refundFactId}`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(refundFactResponse.statusCode, refundFactResponse.body).toBe(200);
    expect(refundFactResponse.json()).toMatchObject({
      fact_id: refundFactId,
      order_id: orderId,
      fact_type: "REFUND",
      amount_minor: 3_000,
      net_effect_minor: -3_000,
      references_fact_id: firstCollectionFactId,
      transaction_reference: "TEST-AGENT-TXN-REFUND-ONE"
    });

    const checkedIn = await runCommand(demo.writeToken, "CHECK_IN", {
      propertyId: demo.propertyId,
      orderId
    }, "check-in");
    expect(checkedIn.preview.effect).toMatchObject({ businessDate: arrivalDate });
    const earlyCheckout = await app.inject({
      method: "POST",
      url: "/api/v1/command-previews",
      headers: {
        ...authHeaders(demo.writeToken),
        "idempotency-key": "agent-journey-early-checkout-preview",
        "x-correlation-id": "agent-journey-early-checkout"
      },
      payload: { commandType: "CHECK_OUT", input: { propertyId: demo.propertyId, orderId } }
    });
    expect(earlyCheckout.statusCode, earlyCheckout.body).toBe(409);
    expect(earlyCheckout.json()).toMatchObject({
      code: "INVALID_ORDER_STATE",
      message: "未到计划退房日，不能办理普通退房；当前版本暂不支持提前退房",
      details: { businessDate: arrivalDate, departureDate: shortenedDepartureDate }
    });

    const finalOrderResponse = await app.inject({
      method: "GET",
      url: `/api/v1/orders/${orderId}`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(finalOrderResponse.statusCode, finalOrderResponse.body).toBe(200);
    const finalOrder = finalOrderResponse.json();
    expect(finalOrder.order).toMatchObject({
      id: orderId,
      status: "CHECKED_IN",
      departure_date: shortenedDepartureDate,
      pricing_policy_version_id: demo.publicPricingPolicyId,
      member_contract_id: demo.memberContractId
    });
    expect(finalOrder.stay.status).toBe("IN_HOUSE");
    expect(finalOrder.allowedActions).toEqual(expect.arrayContaining([{
      code: "CHECK_OUT",
      enabled: false,
      disabledReason: "DEPARTURE_DATE_NOT_REACHED"
    }]));
    expect(finalOrder.amendments.find((amendment: { amendment_type: string }) => amendment.amendment_type === "CHECK_IN")?.payload)
      .toMatchObject({ businessDate: arrivalDate });
    expect(finalOrder.fulfillment).toMatchObject({
      state: "IN_HOUSE",
      checkIn: {
        type: "CHECK_IN",
        plannedBusinessDate: arrivalDate,
        recordedBusinessDate: arrivalDate,
        recordingMode: "ON_SCHEDULE"
      },
      checkOut: null
    });
    expect(finalOrder.originalArrangement).toEqual(createdOrder.originalArrangement);
    expect(finalOrder.effectiveArrangement).toMatchObject({
      presentation: "CURRENT",
      businessDate: arrivalDate,
      arrivalDate,
      departureDate: shortenedDepartureDate,
      intervals: [{ inventoryUnitId: memberRoomId, arrivalDate, departureDate: shortenedDepartureDate }]
    });
    expect(finalOrder.arrangementHistory.map((item: { type: string }) => item.type)).toEqual([
      "INITIAL_BOOKING", "RESCHEDULE"
    ]);
    expect(finalOrder.pricingRevisions).toHaveLength(2);
    expect(finalOrder.pricingRevisions.every((revision: { policy_version_id: string }) => (
      revision.policy_version_id === demo.publicPricingPolicyId
    ))).toBe(true);
    expect(finalOrder.collectionFacts).toHaveLength(3);
    expect(finalOrder.amounts).toEqual({
      currentContractAmount: { currency: "CNY", minorUnits: 0 },
      netRecordedCollection: { currency: "CNY", minorUnits: 9_000 },
      collectionDifference: { currency: "CNY", minorUnits: -9_000 }
    });
    expect(finalOrder.coverageSet).toHaveLength(2);
    expect(finalOrder.coverageSet.every((item: { status: string }) => item.status === "CONSUMED")).toBe(true);
    expect(finalOrder.cleaningTasks).toEqual([]);

    const memberAfterCheckIn = await app.inject({
      method: "GET",
      url: `/api/v1/members/${demo.memberId}?propertyId=${demo.propertyId}`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(memberAfterCheckIn.statusCode, memberAfterCheckIn.body).toBe(200);
    const consumeFacts = memberAfterCheckIn.json().ledger.filter((entry: { order_id: string | null; entry_type: string }) => (
      entry.order_id === orderId && entry.entry_type === "CONSUME"
    ));
    expect(consumeFacts).toHaveLength(2);
    expect(checkedIn.receipt.resourceRefs).toEqual(expect.arrayContaining(finalOrder.coverageSet.map((item: { id: string }) => item.id)));
    expect(checkedIn.receipt.factRefs).toEqual(expect.arrayContaining(consumeFacts.map((entry: { fact_id: string }) => entry.fact_id)));

    for (const url of [
      `/api/v1/receipts/${created.receipt.receiptId}`,
      `/api/v1/commands/${created.receipt.commandId}`
    ]) {
      const hidden = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${foreignToken}` }
      });
      expect(hidden.statusCode, hidden.body).toBe(404);
      expect(hidden.json()).toMatchObject({ code: "NOT_FOUND", retryable: false });
    }

    const foreignRecovery = await app.inject({
      method: "GET",
      url: `/api/v1/command-results?propertyId=${demo.propertyId}&commandType=CREATE_ORDER&idempotencyKey=${created.confirmIdempotencyKey}`,
      headers: { authorization: `Bearer ${foreignToken}` }
    });
    expect(foreignRecovery.statusCode, foreignRecovery.body).toBe(200);
    expect(foreignRecovery.json()).toEqual({ executionStatus: "NOT_EXECUTED", businessCommitted: false });
  });

  it("reports UNKNOWN only while an HTTP command owner is active and then returns its durable Receipt", async () => {
    const correlationId = "agent-http-active-recovery";
    const serviceDate = "2028-05-01";
    const previewResponse = await app.inject({
      method: "POST",
      url: "/api/v1/command-previews",
      headers: {
        ...authHeaders(demo.writeToken),
        "idempotency-key": "agent-http-active-recovery-preview",
        "x-correlation-id": correlationId
      },
      payload: {
        commandType: "LOCK_MAINTENANCE",
        input: {
          propertyId: demo.propertyId,
          inventoryUnitId: demo.secondRoomId,
          arrivalDate: serviceDate,
          departureDate: "2028-05-02",
          reason: "HTTP in-flight recovery acceptance"
        }
      }
    });
    expect(previewResponse.statusCode, previewResponse.body).toBe(200);
    const preview = (previewResponse.json() as PreviewResponse).preview;
    const confirmIdempotencyKey = "agent-http-active-recovery-confirm";

    let releaseBlocker!: () => void;
    let reportLocked!: () => void;
    const blockerGate = new Promise<void>((resolve) => { releaseBlocker = resolve; });
    const locked = new Promise<void>((resolve) => { reportLocked = resolve; });
    await db.insertInto("inventory_room_days")
      .values({ room_id: demo.secondRoomId, service_date: serviceDate, whole_claim_id: null, version: 0 })
      .onConflict((oc) => oc.columns(["room_id", "service_date"]).doNothing())
      .execute();
    const blocker = db.transaction().execute(async (trx) => {
      await trx.selectFrom("inventory_room_days")
        .select("room_id")
        .where("room_id", "=", demo.secondRoomId)
        .where("service_date", "=", serviceDate)
        .forUpdate()
        .executeTakeFirstOrThrow();
      reportLocked();
      await blockerGate;
    });
    await locked;

    let reportConfirmObserved!: () => void;
    const confirmObserved = new Promise<void>((resolve) => { reportConfirmObserved = resolve; });
    reportActiveOwnerConfirmObserved = reportConfirmObserved;
    const confirmationPromise = app.inject({
      method: "POST",
      url: `/api/v1/command-previews/${preview.previewId}/confirm`,
      headers: {
        ...authHeaders(demo.writeToken),
        "idempotency-key": confirmIdempotencyKey,
        "x-correlation-id": correlationId
      },
      payload: {
        propertyId: demo.propertyId,
        commandType: "LOCK_MAINTENANCE",
        confirmation: true,
        expectedEffectHash: preview.effectHash,
        reason: { code: "HTTP_RECOVERY", note: "Keep the owner active while recovery is queried" }
      }
    }).then((response) => response);

    try {
      await Promise.race([
        confirmObserved,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Confirm request did not enter Fastify")), 2_000))
      ]);
      const inFlight = await waitForUnknownRecovery("LOCK_MAINTENANCE", confirmIdempotencyKey);
      expect(inFlight.json()).toEqual({ executionStatus: "UNKNOWN", businessCommitted: false });
    } finally {
      reportActiveOwnerConfirmObserved = undefined;
      releaseBlocker();
    }

    await blocker;
    const confirmation = await confirmationPromise;
    expect(confirmation.statusCode, confirmation.body).toBe(200);
    const receipt = confirmation.json() as ReceiptDto;
    expect(receipt).toMatchObject({ commandId: expect.any(String), executionStatus: "EXECUTED", businessCommitted: true });
    const recovered = await app.inject({
      method: "GET",
      url: `/api/v1/command-results?propertyId=${demo.propertyId}&commandType=LOCK_MAINTENANCE&idempotencyKey=${confirmIdempotencyKey}`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(recovered.json()).toEqual(receipt);
  });

  it("fails the order HTTP query closed without leaking raw lifecycle facts", async () => {
    if (!lifecycleQueryOrderId) throw new Error("The lifecycle journey order was not created");
    const order = await db.selectFrom("orders")
      .select("version")
      .where("id", "=", lifecycleQueryOrderId)
      .executeTakeFirstOrThrow();
    await db.updateTable("orders")
      .set({ version: order.version + 1 })
      .where("id", "=", lifecycleQueryOrderId)
      .execute();

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/orders/${lifecycleQueryOrderId}`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(response.statusCode, response.body).toBe(500);
    expect(response.json()).toMatchObject({
      code: "INTERNAL_ERROR",
      retryable: false
    });
    for (const rawField of ["segments", "amendments", "payload", "originalArrangement", "effectiveArrangement"]) {
      expect(response.body).not.toContain(`\"${rawField}\"`);
    }
  });
});

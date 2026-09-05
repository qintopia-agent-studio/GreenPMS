import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { buildServer } from "../../apps/api/src/server.ts";
import { type Database } from "@qintopia/db";
import { demo } from "../../packages/db/src/seed.ts";
import { resetDatabase } from "../helpers/database.ts";

const databaseUrl = process.env.TEMPORARY_OTHER_ROOM_CONTRACT_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_temporary_other_room_contract";

type JsonSchema = Record<string, unknown>;

let db: Kysely<Database>;
let app: FastifyInstance;

function properties(schema: JsonSchema): Record<string, JsonSchema> {
  return schema.properties as Record<string, JsonSchema>;
}

function literalValue(schema: JsonSchema | undefined): unknown {
  if (!schema) return undefined;
  return schema.const ?? (Array.isArray(schema.enum) ? schema.enum[0] : undefined);
}

function createOrderInput(document: JsonSchema): JsonSchema {
  const envelope = document.paths as Record<string, JsonSchema>;
  const commandSchema = (((envelope["/api/v1/command-previews"]!.post as JsonSchema).requestBody as JsonSchema)
    .content as Record<string, JsonSchema>)["application/json"]!.schema as JsonSchema;
  const variants = commandSchema.anyOf as JsonSchema[];
  return variants.find((variant) => literalValue(properties(variant).commandType) === "CREATE_ORDER")!;
}

beforeAll(async () => {
  db = await resetDatabase(databaseUrl);
  app = await buildServer(db);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await db?.destroy();
});

describe("temporary other-room member stay public contract", () => {
  it("publishes strict Quote, CREATE_ORDER, and Confirm fields without accepting client-supplied entitlement facts", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    expect(response.statusCode).toBe(200);
    const document = response.json() as JsonSchema;
    const paths = document.paths as Record<string, JsonSchema>;
    const quoteOperation = paths["/api/v1/quotes"]!.post as JsonSchema;
    const quoteRequest = ((quoteOperation.requestBody as JsonSchema).content as Record<string, JsonSchema>)["application/json"]!.schema as JsonSchema;
    const quoteResponse = ((quoteOperation.responses as Record<string, JsonSchema>)["200"]!.content as Record<string, JsonSchema>)["application/json"]!.schema as JsonSchema;
    const quote = properties(quoteResponse).quote!;
    const orderInput = properties(createOrderInput(document)).input!;
    const confirmOperation = paths["/api/v1/command-previews/{previewId}/confirm"]!.post as JsonSchema;
    const confirmSchema = ((confirmOperation.requestBody as JsonSchema).content as Record<string, JsonSchema>)["application/json"]!.schema as JsonSchema;
    const createOrderConfirm = (confirmSchema.anyOf as JsonSchema[])
      .find((variant) => literalValue(properties(variant).commandType) === "CREATE_ORDER")!;
    const reasons = properties(createOrderConfirm).reason!.anyOf as JsonSchema[];

    expect(quoteRequest.additionalProperties).toBe(false);
    expect(literalValue(properties(quoteRequest).temporaryOtherRoom)).toBe(true);
    expect(properties(quoteRequest)).not.toHaveProperty("membershipOrderId");
    expect(properties(quoteRequest)).not.toHaveProperty("memberContractId");
    expect(properties(quoteRequest)).not.toHaveProperty("entitlementLotId");

    expect(properties(quote).temporaryOtherRoomArrangement).toMatchObject({
      additionalProperties: false,
      required: [
        "kind", "membershipOrderId", "memberContractId", "entitlementLotId", "originalRoomTypeCode",
        "originalInventoryKind", "entitlementUnitKind", "actualInventoryUnitId", "actualRoomTypeCode",
        "actualInventoryKind", "arrivalDate", "departureDate"
      ]
    });
    expect(properties(orderInput).temporaryOtherRoomReason).toMatchObject({ minLength: 1, maxLength: 200 });
    const temporaryReason = reasons.find((reason) => literalValue(properties(reason).code) === "TEMPORARY_OTHER_ROOM");
    expect(temporaryReason).toMatchObject({
      additionalProperties: false,
      required: ["code", "note"],
      properties: {
        code: expect.any(Object),
        note: { minLength: 1, maxLength: 200 }
      }
    });
    expect(literalValue(properties(temporaryReason!).code)).toBe("TEMPORARY_OTHER_ROOM");
  });

  it("serializes the structured temporary-arrangement eligibility as a stable 409", async () => {
    const target = await db.selectFrom("inventory_units")
      .select(["id", "room_type_code"])
      .where("property_id", "=", demo.propertyId)
      .where("kind", "=", "ROOM")
      .where("active", "=", true)
      .where("room_type_code", "!=", "shared_bath_single")
      .orderBy("id")
      .executeTakeFirstOrThrow();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/quotes",
      headers: {
        authorization: `Bearer ${demo.writeToken}`,
        "content-type": "application/json",
        "idempotency-key": "temporary-other-room-eligibility",
        "x-correlation-id": "temporary-other-room-eligibility"
      },
      payload: {
        propertyId: demo.propertyId,
        inventoryUnitId: target.id,
        stayType: "TRANSIENT",
        arrivalDate: "2028-08-10",
        departureDate: "2028-08-12",
        pricingPolicyVersionId: demo.publicPricingPolicyId,
        memberId: demo.memberId
      }
    });

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({
      code: "ENTITLEMENT_CONFLICT",
      retryable: false,
      correlationId: "temporary-other-room-eligibility",
      details: {
        temporaryOtherRoomAvailable: true,
        originalRoomTypeCode: "shared_bath_single",
        actualRoomTypeCode: target.room_type_code,
        originalRoomTypeAvailable: expect.any(Boolean)
      }
    });
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { Database } from "@qintopia/db";
import {
  ROOM_STATUS_MAX_QUERY_NIGHTS,
  ROOM_STATUS_OPERATIONAL_TASK_LIMIT,
  roomStatusActionCodes,
  roomStatusAttentionCodes,
  roomStatusBlockingFactKinds,
  roomStatusOperationalAttentionCodes,
  roomStatusOperationalTaskKinds,
  roomStatusSourceKinds,
  roomStatusStatuses
} from "@qintopia/contracts";
import { buildServer } from "../../apps/api/src/server.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { resetDatabase } from "../helpers/database.ts";

const databaseUrl = process.env.ROOM_STATUS_CONTRACT_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_room_status_contract";

type JsonSchema = Record<string, unknown>;

let app: FastifyInstance;
let db: Kysely<Database>;
let sequence = 0;

function headers(prefix: string) {
  sequence += 1;
  return {
    authorization: `Bearer ${demo.writeToken}`,
    "content-type": "application/json",
    "idempotency-key": `${prefix}-${sequence}`,
    "x-correlation-id": `${prefix}-${sequence}`
  };
}

function arbitraryRecordLocations(schema: unknown, path = "schema"): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const record = schema as JsonSchema;
  const result: string[] = [];
  const additional = record.additionalProperties;
  if (additional === true || (additional !== null && typeof additional === "object" && !Array.isArray(additional) && Object.keys(additional).length === 0)) {
    result.push(`${path}.additionalProperties`);
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === "additionalProperties" && additional !== true) continue;
    if (Array.isArray(value)) value.forEach((entry, index) => result.push(...arbitraryRecordLocations(entry, `${path}.${key}[${index}]`)));
    else if (value && typeof value === "object") result.push(...arbitraryRecordLocations(value, `${path}.${key}`));
  }
  return result;
}

function shiftLocalDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function lockMaintenance(options: {
  inventoryUnitId: string;
  arrivalDate: string;
  departureDate: string;
  reason: string;
  prefix: string;
}) {
  const previewHeaders = headers(`${options.prefix}-preview`);
  const previewResponse = await app.inject({
    method: "POST",
    url: "/api/v1/command-previews",
    headers: previewHeaders,
    payload: {
      commandType: "LOCK_MAINTENANCE",
      input: {
        propertyId: demo.propertyId,
        inventoryUnitId: options.inventoryUnitId,
        arrivalDate: options.arrivalDate,
        departureDate: options.departureDate,
        reason: options.reason
      }
    }
  });
  expect(previewResponse.statusCode, previewResponse.body).toBe(200);
  const preview = previewResponse.json().preview;
  expect(preview).toMatchObject({
    commandType: "LOCK_MAINTENANCE",
    effect: {
      arrivalDate: options.arrivalDate,
      departureDate: options.departureDate,
      reason: options.reason
    }
  });

  const confirmHeaders = headers(`${options.prefix}-confirm`);
  const request = {
    method: "POST" as const,
    url: `/api/v1/command-previews/${preview.previewId}/confirm`,
    headers: confirmHeaders,
    payload: {
      propertyId: demo.propertyId,
      commandType: "LOCK_MAINTENANCE",
      confirmation: true,
      expectedEffectHash: preview.effectHash,
      reason: { code: "CONTRACT", note: "Confirm maintenance through shared command protocol" }
    }
  };
  const confirmed = await app.inject(request);
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  const replay = await app.inject(request);
  expect(replay.statusCode).toBe(200);
  expect(replay.json()).toEqual(confirmed.json());
  return confirmed.json();
}

beforeAll(async () => {
  process.env.LOG_LEVEL = "silent";
  process.env.BEARER_AUTH_RATE_LIMIT_MAX = "5000";
  db = await resetDatabase(databaseUrl);
  app = await buildServer(db);
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
  if (db) await db.destroy();
});

describe("RoomStatus Query and Command API contract", () => {
  it("publishes a finite additive OpenAPI schema and all stable vocabularies", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    expect(response.statusCode).toBe(200);
    const document = response.json();
    const path = document.paths["/api/v1/properties/{id}/room-status"];
    expect(path).toBeDefined();
    const responseSchema = path.get.responses["200"].content["application/json"].schema;
    expect(responseSchema).toMatchObject({
      additionalProperties: false,
      required: ["propertyId", "businessDate", "range", "dates", "asOf", "freshUntil", "revision", "accessLevel", "projectionState", "filterOptions", "page", "operationalTasks", "availabilitySummary", "rooms"]
    });
    expect(path.get.parameters
      .filter((parameter: { in: string }) => parameter.in === "query")
      .map((parameter: { name: string }) => parameter.name)
      .sort()).toEqual([
      "arrivalDate", "departureDate", "minCapacity", "page", "pageSize", "roomType", "salesMode", "search", "status", "unitKind"
    ]);
    expect(arbitraryRecordLocations(responseSchema)).toEqual([]);
    expect(JSON.stringify(responseSchema)).toContain("displayInventoryUnitId");
    expect(JSON.stringify(responseSchema)).toContain("actualInventoryUnitId");
    expect(JSON.stringify(responseSchema)).toContain("primaryOccupantLabel");
    expect(JSON.stringify(responseSchema)).toContain("sourceStartDate");
    expect(JSON.stringify(responseSchema)).toContain("sourceEndDate");
    expect(JSON.stringify(responseSchema)).toContain("sourceCategory");
    expect(JSON.stringify(responseSchema)).toContain("freeStayCategoryCode");
    expect(JSON.stringify(responseSchema)).toContain("freeStayReason");
    expect(JSON.stringify(responseSchema)).toContain("claimIds");
    expect(JSON.stringify(responseSchema)).toContain("blockingFactKind");
    expect(JSON.stringify(responseSchema)).toContain("filterOptions");
    expect(JSON.stringify(responseSchema)).toContain("availableRooms");
    expect(JSON.stringify(responseSchema)).toContain("availableBeds");
    const responseProperties = responseSchema.properties as Record<string, JsonSchema>;
    expect(responseProperties.dates!.maxItems).toBe(ROOM_STATUS_MAX_QUERY_NIGHTS);
    expect(responseProperties.operationalTasks!.maxItems).toBe(ROOM_STATUS_OPERATIONAL_TASK_LIMIT);
    const operationalTaskItems = (responseProperties.operationalTasks!.items as JsonSchema);
    const operationalTaskProperties = operationalTaskItems.properties as Record<string, JsonSchema>;
    expect((operationalTaskItems.required as string[])).toContain("attention");
    expect((operationalTaskItems.required as string[])).toContain("operationalAttention");
    expect(JSON.stringify(operationalTaskProperties.attention)).toContain('"ARREARS"');
    expect(JSON.stringify(operationalTaskProperties.operationalAttention)).toContain('"OVERDUE_IN_HOUSE"');
    expect(JSON.stringify(operationalTaskProperties.reason)).not.toContain("maxLength");
    const taskConflictProperties = ((operationalTaskProperties.conflicts!.items as JsonSchema).properties as Record<string, JsonSchema>);
    expect(JSON.stringify(taskConflictProperties.reason)).not.toContain("maxLength");
    const roomProperties = ((responseProperties.rooms!.items as JsonSchema).properties as Record<string, JsonSchema>);
    const intervalProperties = (((roomProperties.intervals!.items as JsonSchema).properties) as Record<string, JsonSchema>);
    const intervalItems = roomProperties.intervals!.items as JsonSchema;
    expect((intervalItems.required as string[])).toContain("attention");
    expect((intervalItems.required as string[])).toContain("operationalAttention");
    expect(JSON.stringify(intervalProperties.attention)).toContain('"ARREARS"');
    expect(JSON.stringify(intervalProperties.operationalAttention)).toContain('"OVERDUE_RESERVED"');
    expect(JSON.stringify(intervalProperties.sourceCategory)).toContain('"CTRIP"');
    expect(JSON.stringify(intervalProperties.sourceCategory)).toContain('"FREE_STAY"');
    expect(JSON.stringify(intervalProperties.sourceCategory)).toContain('"MEMBER"');
    expect((responseProperties.rooms!.items as JsonSchema).required).toEqual(expect.arrayContaining([
      "physicalBedCount",
      "bedSlotStates"
    ]));
    const bedSlotProperties = (((roomProperties.bedSlotStates!.items as JsonSchema).properties) as Record<string, JsonSchema>);
    expect(Object.keys(bedSlotProperties)).toEqual(["serviceDate", "inventoryUnitId", "inventoryUnitCode", "status"]);
    expect(JSON.stringify(intervalProperties.reason)).not.toContain("maxLength");
    for (const value of roomStatusStatuses) expect(JSON.stringify(responseSchema)).toContain(`\"${value}\"`);
    for (const value of roomStatusAttentionCodes) expect(JSON.stringify(responseSchema)).toContain(`\"${value}\"`);
    for (const value of roomStatusOperationalAttentionCodes) expect(JSON.stringify(responseSchema)).toContain(`\"${value}\"`);
    for (const value of roomStatusSourceKinds) expect(JSON.stringify(responseSchema)).toContain(`\"${value}\"`);
    for (const value of roomStatusBlockingFactKinds) expect(JSON.stringify(responseSchema)).toContain(`\"${value}\"`);
    for (const value of roomStatusActionCodes) expect(JSON.stringify(responseSchema)).toContain(`\"${value}\"`);
    for (const value of roomStatusOperationalTaskKinds) expect(JSON.stringify(responseSchema)).toContain(`\"${value}\"`);

    const commandSchema = document.paths["/api/v1/command-previews"].post.requestBody.content["application/json"].schema;
    const variants = new Map<string, JsonSchema>(commandSchema.anyOf.map((variant: JsonSchema): [string, JsonSchema] => {
      const properties = variant.properties as Record<string, JsonSchema>;
      return [(((properties.commandType!.enum as string[])[0])!), variant];
    }));
    expect(variants.has("PLACE_INTERNAL_USE")).toBe(false);
    expect(variants.has("RELEASE_INTERNAL_USE")).toBe(false);
    expect(roomStatusStatuses).not.toContain("INTERNAL_USE");
    expect(roomStatusSourceKinds).not.toContain("INTERNAL_USE");
    expect(roomStatusActionCodes).not.toContain("PLACE_INTERNAL_USE");
    expect(roomStatusActionCodes).not.toContain("RELEASE_INTERNAL_USE");
    expect(JSON.stringify(responseSchema)).not.toContain('"INTERNAL_USE"');
    expect(JSON.stringify(responseSchema)).not.toContain('"PLACE_INTERNAL_USE"');
    expect(JSON.stringify(responseSchema)).not.toContain('"RELEASE_INTERNAL_USE"');
    const maintenanceInput = (variants.get("LOCK_MAINTENANCE")!.properties as Record<string, JsonSchema>).input!;
    expect(Object.keys((maintenanceInput.properties as object)).sort())
      .toEqual(["arrivalDate", "departureDate", "inventoryUnitId", "propertyId", "reason"]);
    expect(Object.keys(((variants.get("RELEASE_MAINTENANCE")!.properties as Record<string, JsonSchema>).input!.properties as object)).sort())
      .toEqual(["maintenanceLockId", "propertyId"]);
    expect(Object.keys(((variants.get("COMPLETE_CLEANING")!.properties as Record<string, JsonSchema>).input!.properties as object)).sort())
      .toEqual(["cleaningTaskId", "propertyId"]);
  });

  it("keeps the room-status response contract valid for legacy display text longer than 200 characters", async () => {
    const inventoryUnitId = "unit_room_status_long_display_text";
    const code = `LONG-${"C".repeat(220)}`;
    const name = `Legacy room ${"N".repeat(240)}`;
    await db.insertInto("inventory_units").values({
      id: inventoryUnitId,
      property_id: demo.propertyId,
      kind: "ROOM",
      parent_room_id: null,
      code,
      name,
      active: true,
      catalog_version: null,
      building_code: null,
      room_type_code: null,
      pricing_product_code: null,
      inventory_basis: "INDEPENDENT",
      code_provenance: "PMS_GENERATED",
      physical_bed_count: 1
    }).execute();

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/properties/${demo.propertyId}/room-status?arrivalDate=2028-10-01&departureDate=2028-10-02&pageSize=200`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(response.statusCode, response.body).toBe(200);
    const room = response.json().rooms.find((item: { id: string }) => item.id === inventoryUnitId);
    expect(room).toMatchObject({ code, name });
    expect(room.allowedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "CREATE_ORDER",
        targetReference: expect.objectContaining({ type: "INVENTORY_UNIT", id: inventoryUnitId, label: code })
      })
    ]));

    const compressed = await app.inject({
      method: "GET",
      url: `/api/v1/properties/${demo.propertyId}/room-status?arrivalDate=2028-10-01&departureDate=2028-10-02&pageSize=200`,
      headers: {
        authorization: `Bearer ${demo.writeToken}`,
        "accept-encoding": "gzip"
      }
    });
    expect(compressed.statusCode).toBe(200);
    expect(compressed.headers["content-encoding"]).toBe("gzip");
    expect(compressed.rawPayload.byteLength).toBeLessThan(Buffer.byteLength(response.body, "utf8"));
  });

  it("returns authoritative READ/WRITE actions, freshness, stable source references, and subject-safe Receipt links", async () => {
    const baselineResponse = await app.inject({
      method: "GET",
      url: `/api/v1/properties/${demo.propertyId}/room-status?arrivalDate=2028-10-01&departureDate=2028-10-02`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(baselineResponse.statusCode, baselineResponse.body).toBe(200);
    const businessDate = baselineResponse.json().businessDate as string;
    const businessDateEnd = shiftLocalDate(businessDate, 1);
    const placed = await lockMaintenance({
      inventoryUnitId: demo.bedAId,
      arrivalDate: "2028-11-01",
      departureDate: "2028-11-03",
      reason: "Contract future maintenance",
      prefix: "room-status-maintenance-future"
    });
    const todayPlaced = await lockMaintenance({
      inventoryUnitId: demo.bedAId,
      arrivalDate: businessDate,
      departureDate: businessDateEnd,
      reason: "Contract business-date maintenance",
      prefix: "room-status-maintenance-today"
    });
    expect(await db.selectFrom("maintenance_locks").select("id").execute()).toHaveLength(2);

    const agentResponse = await app.inject({
      method: "GET",
      url: `/api/v1/properties/${demo.propertyId}/room-status?arrivalDate=2028-11-01&departureDate=2028-11-04`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(agentResponse.statusCode, agentResponse.body).toBe(200);
    const agentBoard = agentResponse.json();
    expect(agentBoard).toMatchObject({
      propertyId: demo.propertyId,
      accessLevel: "WRITE",
      projectionState: "READY",
      range: { arrivalDate: "2028-11-01", departureDate: "2028-11-04" }
    });
    expect(Date.parse(agentBoard.freshUntil) - Date.parse(agentBoard.asOf)).toBe(5_000);
    const room = agentBoard.rooms.find((item: { id: string }) => item.id === demo.roomId);
    const bed = room.children.find((item: { id: string }) => item.id === demo.bedAId);
    expect(room.days[0]).toMatchObject({ status: "MAINTENANCE", available: false });
    expect(bed.intervals[0]).toMatchObject({
      actualInventoryUnitId: demo.bedAId,
      displayInventoryUnitId: demo.bedAId,
      sourceKind: "MAINTENANCE",
      primaryOccupantLabel: null,
      startDate: "2028-11-01",
      endDate: "2028-11-03",
      sourceStartDate: "2028-11-01",
      sourceEndDate: "2028-11-03",
      blocking: true,
      conflicts: [expect.objectContaining({
        blockingFactKind: "CLAIM",
        claimId: expect.any(String),
        claimIds: [expect.any(String), expect.any(String)],
        startDate: "2028-11-01",
        endDate: "2028-11-03",
        sourceReference: expect.objectContaining({ type: "BLOCK", id: placed.result.maintenanceLockId })
      })]
    });
    expect(bed.intervals[0].allowedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "RELEASE_MAINTENANCE", enabled: true, requiresFullInterval: true })
    ]));
    expect(bed.intervals[0].references).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "CLAIM" }),
      expect.objectContaining({ type: "BLOCK", id: placed.result.maintenanceLockId }),
      expect.objectContaining({ type: "RECEIPT", id: placed.receiptId })
    ]));
    expect(bed.intervals[0].history).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "API_TOKEN", receiptId: placed.receiptId })
    ]));
    expect(agentBoard.operationalTasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskKind: "EXCEPTION",
        sourceKind: "MAINTENANCE",
        actualInventoryUnitId: demo.bedAId,
        businessDate,
        startDate: businessDate,
        endDate: businessDateEnd,
        sourceStartDate: businessDate,
        sourceEndDate: businessDateEnd,
        conflicts: [expect.objectContaining({
          blockingFactKind: "CLAIM",
          claimId: expect.any(String),
          claimIds: [expect.any(String)],
          startDate: businessDate,
          endDate: businessDateEnd,
          sourceReference: expect.objectContaining({ type: "BLOCK", id: todayPlaced.result.maintenanceLockId })
        })],
        references: expect.arrayContaining([expect.objectContaining({ type: "BLOCK", id: todayPlaced.result.maintenanceLockId })])
      })
    ]));
    expect(agentBoard.operationalTasks.some((task: { references: Array<{ type: string; id: string }> }) => task.references.some((item) => item.type === "BLOCK" && item.id === placed.result.maintenanceLockId))).toBe(false);

    const receiptCountBeforePartialQuery = await db.selectFrom("command_receipts").select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow();
    const partialResponse = await app.inject({
      method: "GET",
      url: `/api/v1/properties/${demo.propertyId}/room-status?arrivalDate=2028-11-02&departureDate=2028-11-03`,
      headers: { authorization: `Bearer ${demo.writeToken}` }
    });
    expect(partialResponse.statusCode, partialResponse.body).toBe(200);
    const partialRoom = partialResponse.json().rooms.find((item: { id: string }) => item.id === demo.roomId);
    const partialBed = partialRoom.children.find((item: { id: string }) => item.id === demo.bedAId);
    const partialInterval = partialBed.intervals.find((item: { references: Array<{ type: string; id: string }> }) => item.references.some((reference) => reference.type === "BLOCK" && reference.id === placed.result.maintenanceLockId));
    expect(partialInterval).toMatchObject({
      startDate: "2028-11-02",
      endDate: "2028-11-03",
      sourceStartDate: "2028-11-01",
      sourceEndDate: "2028-11-03",
      allowedActions: expect.arrayContaining([
        expect.objectContaining({
          code: "RELEASE_MAINTENANCE",
          enabled: true,
          disabledReason: null,
          requiresFullInterval: true,
          targetReference: expect.objectContaining({ type: "BLOCK", id: placed.result.maintenanceLockId })
        })
      ])
    });
    expect(await db.selectFrom("command_receipts").select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow())
      .toEqual(receiptCountBeforePartialQuery);
    expect(await db.selectFrom("maintenance_locks").select("status").where("id", "=", placed.result.maintenanceLockId).executeTakeFirstOrThrow())
      .toEqual({ status: "ACTIVE" });

    const readResponse = await app.inject({
      method: "GET",
      url: `/api/v1/properties/${demo.propertyId}/room-status?arrivalDate=2028-11-01&departureDate=2028-11-04`,
      headers: { authorization: `Bearer ${demo.readToken}` }
    });
    expect(readResponse.statusCode).toBe(200);
    const readBoard = readResponse.json();
    expect(readBoard.accessLevel).toBe("READ");
    const actions = [...readBoard.rooms.flatMap((parent: { allowedActions: Array<{ code: string }>; intervals: Array<{ allowedActions: Array<{ code: string }> }>; children: typeof readBoard.rooms }) => [parent, ...parent.children])
      .flatMap((unit: { allowedActions: Array<{ code: string }>; intervals: Array<{ allowedActions: Array<{ code: string }> }> }) => [
        ...unit.allowedActions,
        ...unit.intervals.flatMap((interval) => interval.allowedActions)
      ]), ...readBoard.operationalTasks.flatMap((task: { allowedActions: Array<{ code: string }> }) => task.allowedActions)];
    expect(actions.every((item: { code: string }) => item.code === "OPEN_ORDER")).toBe(true);

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "operator", password: "demo-pass-2026" }
    });
    expect(login.statusCode).toBe(200);
    const session = login.cookies.find((cookie) => cookie.name === "qintopia_session")!;
    const operatorResponse = await app.inject({
      method: "GET",
      url: `/api/v1/properties/${demo.propertyId}/room-status?arrivalDate=2028-11-01&departureDate=2028-11-04`,
      cookies: { qintopia_session: session.value }
    });
    expect(operatorResponse.statusCode).toBe(200);
    expect(JSON.stringify(operatorResponse.json())).not.toContain(placed.receiptId);
    expect(JSON.stringify(operatorResponse.json())).not.toContain(todayPlaced.receiptId);
  });

  it("accepts strict authoritative room-status filters and returns stable full-property facets", async () => {
    const room = await db.selectFrom("inventory_units")
      .select(["code", "room_type_code", "physical_bed_count"])
      .where("id", "=", demo.roomId)
      .executeTakeFirstOrThrow();
    const query = new URLSearchParams({
      arrivalDate: "2035-01-01",
      departureDate: "2035-01-03",
      page: "0",
      pageSize: "50",
      search: room.code,
      salesMode: "BED_SPLIT",
      status: "AVAILABLE",
      minCapacity: String(room.physical_bed_count ?? 1),
      unitKind: "ROOM"
    });
    if (room.room_type_code) query.set("roomType", room.room_type_code);
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/properties/${demo.propertyId}/room-status?${query.toString()}`,
      headers: { authorization: `Bearer ${demo.readToken}` }
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      page: { index: 0, size: 50, totalRooms: 1, totalPages: 1 },
      filterOptions: {
        roomTypeCodes: expect.any(Array),
        salesModes: expect.arrayContaining(["WHOLE_ROOM", "BED_SPLIT"]),
        statuses: expect.arrayContaining(["AVAILABLE"]),
        capacities: expect.any(Array),
        unitKinds: ["ROOM", "BED"]
      },
      rooms: [expect.objectContaining({ id: demo.roomId, children: [] })]
    });

    for (const invalidQuery of ["salesMode=INVALID", "status=INVALID", "minCapacity=0", "unitKind=INVALID"]) {
      const invalid = await app.inject({
        method: "GET",
        url: `/api/v1/properties/${demo.propertyId}/room-status?arrivalDate=2035-01-01&departureDate=2035-01-03&${invalidQuery}`,
        headers: { authorization: `Bearer ${demo.readToken}` }
      });
      expect(invalid.statusCode, `${invalidQuery}: ${invalid.body}`).toBe(400);
    }
  });

  it("rejects a room-status interval over 30 nights and keeps the old availability endpoint unchanged", async () => {
    const tooLong = await app.inject({
      method: "GET",
      url: `/api/v1/properties/${demo.propertyId}/room-status?arrivalDate=2028-01-01&departureDate=2028-04-02`,
      headers: { authorization: `Bearer ${demo.readToken}` }
    });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json()).toMatchObject({ code: "VALIDATION_ERROR" });

    const availability = await app.inject({
      method: "GET",
      url: `/api/v1/properties/${demo.propertyId}/availability?arrivalDate=2028-12-01&departureDate=2028-12-02`,
      headers: { authorization: `Bearer ${demo.readToken}` }
    });
    expect(availability.statusCode).toBe(200);
    expect(availability.json()).toMatchObject({ propertyId: demo.propertyId });
    expect(availability.json().units[0].nights[0]).toMatchObject({ blockingClaimIds: [] });
    expect(Object.keys(availability.json().units[0].nights[0]).sort())
      .toEqual(["available", "blockingClaimIds", "serviceDate"]);
    expect(availability.json()).not.toHaveProperty("revision");
  });
});

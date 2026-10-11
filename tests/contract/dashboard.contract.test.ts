import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { Database } from "@qintopia/db";
import { buildServer } from "../../apps/api/src/server.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { resetDatabase } from "../helpers/database.ts";
let db: Kysely<Database>, app: FastifyInstance;
const path = `/api/v1/properties/${demo.propertyId}/dashboard`;
const headers = { authorization: `Bearer ${demo.readToken}` };
beforeAll(async () => { process.env.LOG_LEVEL = "silent"; db = await resetDatabase("postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_dashboard_contract"); app = await buildServer(db); await app.ready(); });
afterAll(async () => { await app?.close(); await db?.destroy(); });
describe("dashboard read-only contract", () => {
  it("requires authentication for summary and details", async () => { for (const url of [path, `${path}/details?metric=MONEY`]) expect((await app.inject({ method: "GET", url })).statusCode).toBe(401); });
  it("allows READ-only token and exposes typed, uncached, non-sensitive summaries", async () => {
    const response = await app.inject({ method: "GET", url: path, headers }); expect(response.statusCode, response.body).toBe(200); expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json(); expect(body.history).toMatchObject({ paidUnitNights: 0, freeUnitNights: 0, occupancyRate: null }); expect(body.future).toHaveLength(14); expect(body.money[0].netMinor).toBe("0");
    expect(response.body).not.toMatch(/phone|secret_hash|identity_document|138000/);
    const detail = await app.inject({ method: "GET", url: `${path}/details?metric=PAID`, headers }); expect(detail.statusCode, detail.body).toBe(200); expect(detail.json()).toMatchObject({ items: [], total: 0, pageSize: 50 });
  });
  it.each(["from=2026-09-01", "from=2026-02-30&to=2026-03-01", "from=2020-01-01&to=2026-09-01", "futureDays=15", "source=UNKNOWN_CHANNEL"])("rejects invalid query %s", async query => expect((await app.inject({ method: "GET", url: `${path}?${query}`, headers })).statusCode).toBe(400));
  it("does not expose cross-property aggregates", async () => { for (const suffix of ["", "/details?metric=MONEY"]) expect((await app.inject({ method: "GET", url: `/api/v1/properties/other_property/dashboard${suffix}`, headers })).statusCode).toBe(403); });
  it("publishes GET-only finite OpenAPI schemas", async () => {
    const document = (await app.inject({ method: "GET", url: "/api/v1/openapi.json" })).json();
    const endpoint = document.paths["/api/v1/properties/{id}/dashboard"]; expect(Object.keys(endpoint)).toEqual(["get"]); const schema = endpoint.get.responses[200].content["application/json"].schema; expect(schema.required).toContain("definitionVersion"); expect(JSON.stringify(schema)).toContain("netMinor");
  });
  it("rechecks token revocation on subsequent requests", async () => {
    await db.updateTable("api_tokens").set({ revoked_at: new Date() }).where("id", "=", "token_demo_read").execute();
    expect((await app.inject({ method: "GET", url: path, headers })).statusCode).toBe(401);
  });
});

import { afterEach, beforeEach, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { Kysely, PostgresDialect, type LogEvent } from "kysely";
import pg from "pg";
import { createDatabase, listMemberPage, createCommandPreview, confirmCommandPreview, type Database } from "@qintopia/db";
import { buildServer } from "../../apps/api/src/server.ts";
import { resetDatabase } from "../helpers/database.ts";
import { runtimeDatabaseUrlForTesting } from "../helpers/runtime-database.ts";
import { authScope } from "../helpers/auth-principals.ts";
import { demo } from "../../packages/db/src/seed.ts";

const databaseUrl = "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_journey_member_directory_test";
let db: Kysely<Database>;
beforeEach(async () => { db = await resetDatabase(databaseUrl); });
afterEach(async () => { await db?.destroy(); });

it("bounds member pages, preserves literal search and scopes identity/contract lookup to the authorized property", async () => {
  const fixtureMembers = Array.from({ length: 1200 }, (_, index) => ({
    id: `member_directory_${String(index).padStart(4, "0")}`,
    identity_card_number: null,
    full_name: `分页会员 ${index}`,
    nickname: index === 51 ? "分页_精确%昵称" : `分页 ${index}`,
    phone: `177${String(index).padStart(8, "0")}`,
    wechat: `directory_${index}`
  }));
  await db.insertInto("members").values(fixtureMembers).execute();
  await db.insertInto("member_property_links").values(fixtureMembers.map((member) => ({ member_id: member.id, property_id: demo.propertyId }))).execute();
  await db.insertInto("properties").values({ id: "property_directory_other", code: "DIRECTORY-OTHER", name: "Other property", timezone: "Asia/Shanghai", currency: "CNY" }).execute();
  await db.insertInto("members").values({ id: "member_directory_other", identity_card_number: null, full_name: "仅他店", nickname: "他店", phone: "18866660000", wechat: "other" }).execute();
  await db.insertInto("member_property_links").values({ member_id: "member_directory_other", property_id: "property_directory_other" }).execute();
  const first = await listMemberPage(db, demo.propertyId, "分页");
  expect(first.members).toHaveLength(50);
  const second = await listMemberPage(db, demo.propertyId, "分页", { beforeId: first.nextCursor! });
  expect(second.members).toHaveLength(50);
  expect(new Set([...first.members, ...second.members].map(({ member }) => member.id)).size).toBe(100);
  expect((await listMemberPage(db, demo.propertyId, "_精确%")).members.map(({ member }) => member.id)).toEqual([fixtureMembers[51]!.id]);
  expect((await listMemberPage(db, demo.propertyId, undefined, { phone: ` ${fixtureMembers[51]!.phone} ` })).members.map(({ member }) => member.id)).toEqual([fixtureMembers[51]!.id]);
  expect((await listMemberPage(db, demo.propertyId, undefined, { memberId: fixtureMembers[51]!.id, hasContract: true })).members).toEqual([]);
  expect((await listMemberPage(db, demo.propertyId, undefined, { memberId: "member_demo_profile", hasContract: true })).members).toHaveLength(1);
  expect((await listMemberPage(db, demo.propertyId, undefined, { phone: "18866660000" })).members).toEqual([]);
  expect((await listMemberPage(db, demo.propertyId, undefined, { memberId: "member_directory_other" })).members).toEqual([]);
  // Profile corrections cannot reorder a cursor or hide the selected profile.
  const before = fixtureMembers[51]!;
  const prior = { fullName: before.full_name, nickname: before.nickname, identityCardNumber: null, phone: before.phone, wechat: before.wechat };
  const principal = { subjectId: demo.administratorSubjectId, credentialId: "token_demo_admin_write", credentialType: "TOKEN" as const, displayName: "Administrator", ...authScope({ profile: "administrator" }) };
  const preview = await createCommandPreview(db, principal, { commandType: "CORRECT_MEMBER_PROFILE", input: {
    propertyId: demo.propertyId, memberId: before.id, expectedPriorProfile: prior,
    correctedProfile: { ...prior, fullName: "更正后", nickname: "更正后" }, evidenceNote: "分页中更正会员资料"
  } }, { idempotencyKey: "directory-correct-preview", correlationId: "directory-correct-preview" });
  const receipt = await confirmCommandPreview(db, principal, preview.preview.previewId, {
    propertyId: demo.propertyId, commandType: "CORRECT_MEMBER_PROFILE", confirmation: true, expectedEffectHash: preview.preview.effectHash, reason: { code: "MEMBER_CORRECTION", note: "分页中更正会员资料" }
  }, { idempotencyKey: "directory-correct-confirm", correlationId: "directory-correct-confirm" });
  expect(receipt.businessCommitted).toBe(true);
  expect((await listMemberPage(db, demo.propertyId, undefined, { memberId: before.id })).members[0]!.member.full_name).toBe("更正后");
  expect((await listMemberPage(db, demo.propertyId, undefined, { beforeId: first.nextCursor! })).members.map(({ member }) => member.id)).toContain(before.id);
  const runtimeDb = createDatabase(runtimeDatabaseUrlForTesting(databaseUrl));
  const app = await buildServer(runtimeDb);
  try {
    const headers = { authorization: `Bearer ${demo.readToken}` };
    const page = await app.inject({ method: "GET", url: `/api/v1/members?propertyId=${demo.propertyId}&pageSize=1&hasContract=true`, headers });
    expect(page.statusCode).toBe(200);
    expect(page.json().members).toHaveLength(1);
    const meta = await app.inject({ method: "GET", url: "/api/v1/meta", headers });
    expect(meta.statusCode).toBe(200);
    expect(meta.json()).toMatchObject({ members: [], memberContracts: [] });
    expect((await app.inject({ method: "GET", url: "/api/v1/members?propertyId=property_directory_other", headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/api/v1/members?propertyId=${demo.propertyId}&pageSize=101`, headers })).statusCode).toBe(400);
  } finally { await app.close(); await runtimeDb.destroy(); }

  const logs: LogEvent[] = [];
  const measured = new Kysely<Database>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: databaseUrl }) }), log: (event) => { logs.push(event); } });
  const samples: number[] = [];
  try {
    await listMemberPage(measured, demo.propertyId, "分页");
    for (let index = 0; index < 10; index += 1) {
      const start = performance.now();
      expect((await listMemberPage(measured, demo.propertyId, "分页")).members.length).toBe(50);
      samples.push(performance.now() - start);
    }
    const selection = logs.find((event) => event.query.sql.startsWith('select'))!;
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const explain = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${selection.query.sql}`, [...selection.query.parameters]);
      const report = { scenario: "1200 members, 50 results per page", p95Ms: [...samples].sort((a,b) => a-b)[9], samplesMs: samples, sql: selection.query.sql, plan: explain.rows[0]["QUERY PLAN"] };
      console.info("member-directory-performance", JSON.stringify({ p95Ms: report.p95Ms, rows: 50, fixtureMembers: 1200 }));
      if (process.env.JOURNEY_MEMBER_PERFORMANCE_REPORT) await writeFile(process.env.JOURNEY_MEMBER_PERFORMANCE_REPORT, JSON.stringify(report, null, 2));
      expect(report.p95Ms).toBeLessThan(500);
    } finally { await client.end(); }
  } finally { await measured.destroy(); }
}, 30_000);

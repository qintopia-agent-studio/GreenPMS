import { writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { enabledAdministratorCommandGrants } from "@qintopia/domain";
import type { Database } from "../../../packages/db/src/schema.ts";
import "../../../packages/db/src/database.ts";
import { getRoomStatusBoard } from "../../../packages/db/src/room-status.ts";
import { propertyLocalToday } from "../../../packages/db/src/members.ts";

const queries: Array<{ sql: string; durationMs: number }> = [];
const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: "postgres://qintopia_runtime:qintopia-runtime-integration@127.0.0.1:55433/qintopia_journey_audit_e2e", max: 2 }) }),
  log(event) { if (event.level === "query") queries.push({ sql: event.query.sql, durationMs: event.queryDurationMillis }); }
});
const samples: Array<Record<string, unknown>> = [];
try {
  const businessDate = await propertyLocalToday(db, "prop_qintopia_demo");
  const future = await db.selectFrom("orders").select("arrival_date").where("status", "=", "RESERVED").orderBy("arrival_date").executeTakeFirstOrThrow();
  for (const arrivalDate of [businessDate, future.arrival_date]) {
    const end = new Date(`${arrivalDate}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 30);
    for (const pageSize of [50, 1, 50]) {
      queries.length = 0;
      const start = performance.now();
      const board = await getRoomStatusBoard(db, {
        propertyId: "prop_qintopia_demo", arrivalDate, departureDate: end.toISOString().slice(0, 10),
        accessLevel: "WRITE", commandGrants: new Set(enabledAdministratorCommandGrants),
        requestingSubjectId: "subject_demo_administrator", page: 0, pageSize
      });
      const serialized = JSON.stringify(board);
      samples.push({ arrivalDate, pageSize, durationMs: Math.round(performance.now() - start),
        totalRooms: board.page.totalRooms, returnedRooms: board.rooms.length,
        jsonBytes: Buffer.byteLength(serialized), gzipBytes: gzipSync(serialized).length,
        queryCount: queries.length, queries: [...queries]
      });
    }
  }
} finally {
  await db.destroy();
  await writeFile(new URL("./evidence/query-results.json", import.meta.url), `${JSON.stringify(samples, null, 2)}\n`);
  console.log(JSON.stringify(samples.map(({ queries: _queries, ...sample }) => sample), null, 2));
}

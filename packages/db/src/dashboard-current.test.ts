import { describe, expect, it, vi } from "vitest";
import { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery, type DatabaseConnection, type QueryResult, type Transaction } from "kysely";
import type { Database } from "./schema";
import { loadDashboardCurrent } from "./dashboard-current";
import type { loadDashboardStays } from "./dashboard-stays";

vi.mock("./dashboard-today.ts", () => ({ loadDashboardToday: async () => ({ todayOrders: 0, todayCollections: [], todayCollectionReviewCount: 0, details: [] }) }));

const today = "2026-10-23";
const arrival = { id: "arrival", status: "RESERVED", stay_status: "PLANNED", stay_type: "TRANSIENT", arrival_date: today, departure_date: "2026-10-26", guests: "2" };
const primary = { id: "primary", order_id: arrival.id, ordinal: 1, role: "PRIMARY", full_name: "原姓名", nickname: "原昵称", phone: "PRIVATE-PHONE", document_number: "PRIVATE-DOCUMENT", created_by_command_id: null, created_at: new Date("2026-10-01") };
const room = { id: "room", kind: "ROOM", code: "F01", parent_room_id: null, building_code: "F", active: true, room_type_code: null, created_at: new Date("2026-01-01") };
type Lodging = Awaited<ReturnType<typeof loadDashboardStays>>;
function lodging(order = arrival, patch: Partial<Lodging> = {}): Lodging {
  return {
    arrangements: new Map([[order.id, [{ inventoryUnitId: room.id, arrivalDate: order.arrival_date, departureDate: order.departure_date }]]]),
    units: [room], statistics: { classifyUnit: () => true }, ...patch
  } as Lodging;
}

// Compile the production SQL against a read-only driver; no database connection or reset is used.
function fixture(orders: typeof arrival[], people: unknown[], corrections: unknown[] = [], catalog?: unknown) {
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      if (!/^\s*select\b/i.test(query.sql)) throw new Error("Fixture only permits reads");
      let rows: unknown[];
      if (query.sql.includes('from "active_order_occupants"')) rows = people;
      else if (query.sql.includes('from "order_occupant_corrections"')) rows = corrections;
      else if (query.sql.includes('from "room_catalog_state"')) rows = catalog ? [{ snapshot: catalog }] : [];
      else if (query.sql.includes("SELECT o.id,o.status")) rows = orders;
      else if (query.sql.includes("FROM orders o JOIN pricing_revisions") || query.sql.includes("FROM retained_funds")) rows = [];
      else throw new Error(`Unexpected query: ${query.sql}`);
      return { rows: rows as R[] };
    },
    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> { throw new Error("Streaming is not used"); }
  };
  const db = new Kysely<Database>({ dialect: {
    createAdapter: () => new PostgresAdapter(), createQueryCompiler: () => new PostgresQueryCompiler(), createIntrospector: value => new PostgresIntrospector(value),
    createDriver: () => ({ init: async () => {}, acquireConnection: async () => connection, releaseConnection: async () => {}, destroy: async () => {},
      beginTransaction: async () => { throw new Error("Fixture only permits reads"); }, commitTransaction: async () => {}, rollbackTransaction: async () => {} })
  } });
  return db;
}
async function load(orders: typeof arrival[], people: unknown[], arrangements: Lodging, corrections: unknown[] = [], catalog?: unknown) {
  const db = fixture(orders, people, corrections, catalog);
  try { return await loadDashboardCurrent(db as unknown as Transaction<Database>, "property", today, "CNY", "Asia/Shanghai", arrangements); }
  finally { await db.destroy(); }
}

describe("今日到离店的接待明细", () => {
  it("同单多人使用有效登记及最新姓名纠正，仍按一笔待到订单计数", async () => {
    const companion = { ...primary, id: "companion", ordinal: 2, role: "ADDITIONAL", nickname: "同行人", full_name: "同行人" };
    const correction = { occupant_id: primary.id, sequence: 2, corrected_nickname: "小青", corrected_full_name: "青女士", corrected_phone: "PRIVATE-NEW-PHONE", corrected_document_number: "PRIVATE-NEW-DOCUMENT" };
    const result = await load([arrival], [primary, companion], lodging(), [correction, { ...correction, sequence: 1, corrected_nickname: "旧更正" }]);
    expect(result.current).toMatchObject({ arrivals: 1, departures: 0, paidGuests: 0 });
    expect(result.details.find(item => item.metric === "ARRIVAL")).toMatchObject({ orderId: arrival.id, units: 1, reception: {
      occupants: [{ name: "小青（青女士）", isPrimary: true }, { name: "同行人", isPrimary: false }],
      roomCode: "F01", buildingCode: "F", arrivalDate: today, departureDate: "2026-10-26", status: "RESERVED"
    } });
    expect(JSON.stringify(result.details)).not.toContain("PRIVATE-");
  });

  it("待离使用换房后的末段床位及父房楼栋，仍展示订单完整住期", async () => {
    const departure = { ...arrival, id: "departure", status: "CHECKED_IN", stay_status: "IN_HOUSE", arrival_date: "2026-10-01", departure_date: today };
    const bed = { ...room, id: "bed", kind: "BED" as const, code: "F05-2", parent_room_id: "new-room", building_code: null };
    const result = await load([departure], [{ ...primary, order_id: departure.id }], lodging(departure, {
      units: [room as Lodging["units"][number], { ...room, id: "new-room", code: "F05" } as Lodging["units"][number], bed],
      arrangements: new Map([[departure.id, [
        { inventoryUnitId: room.id, arrivalDate: "2026-10-01", departureDate: "2026-10-15" },
        { inventoryUnitId: bed.id, arrivalDate: "2026-10-15", departureDate: today }
      ]]])
    }));
    expect(result.current).toMatchObject({ arrivals: 0, departures: 1, paidGuests: 2, overdue: 0 });
    expect(result.details.find(item => item.metric === "DEPARTURE")?.reception).toMatchObject({ roomCode: "F05-2", buildingCode: "F", arrivalDate: "2026-10-01", departureDate: today, status: "CHECKED_IN" });
  });

  it("缺少住客或展示资料时明确返回空名单和 null，不补造住客及房号", async () => {
    const result = await load([{ ...arrival, guests: "0" }], [], lodging(arrival, { units: [] }));
    expect(result.current.arrivals).toBe(1);
    expect(result.details.find(item => item.metric === "ARRIVAL")?.reception).toEqual({ occupants: [], roomCode: null, buildingCode: null, arrivalDate: today, departureDate: arrival.departure_date, status: "RESERVED" });
  });

  it("有效房床显示改名后的运营编号，停用单元保留原编号", async () => {
    for (const unit of [room, { ...room, kind: "BED", code: "F01-2", parent_room_id: "parent" }, { ...room, active: false }]) {
      const result = await load([arrival], [primary], lodging(arrival, { units: [unit as Lodging["units"][number]] }), [], { unitCodes: { [unit.id]: "新房床号" } });
      expect(result.details.find(item => item.metric === "ARRIVAL")?.reception?.roomCode).toBe(unit.active ? "新房床号" : unit.code);
      expect(result.current.arrivals).toBe(1);
    }
  });

  it("未命名有效住客保留登记序号，不以会员付款人代替", async () => {
    const result = await load([arrival], [{ ...primary, nickname: null, full_name: null }], lodging());
    expect(result.details.find(item => item.metric === "ARRIVAL")?.reception?.occupants).toEqual([{ name: "第 1 位住客", isPrimary: true }]);
  });

  it("住宿范围仍待核对或已排除时保持原有计数边界", async () => {
    for (const classification of [null, false]) {
      const result = await load([arrival], [primary], lodging(arrival, { statistics: { classifyUnit: () => classification, includesUnit: () => classification === true, assetId: () => room.id } }));
      expect(result.current).toMatchObject({ arrivals: 0, departures: 0, guestReviewOrders: classification === null ? 1 : 0 });
      expect(result.details.some(item => item.metric === "ARRIVAL")).toBe(false);
    }
  });
});

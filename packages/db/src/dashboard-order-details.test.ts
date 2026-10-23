import { describe, expect, it } from "vitest";
import { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery, type DatabaseConnection, type QueryResult, type Transaction } from "kysely";
import type { DashboardDetail } from "@qintopia/contracts";
import type { Database } from "./schema";
import { newDashboardDetail } from "./dashboard-current";
import { enrichDashboardOrderDetails } from "./dashboard-order-details";

const today = "2026-10-23";
const order = { id: "order", status: "RESERVED", stay_status: "PLANNED", stay_id: "stay", stay_type: "TRANSIENT", arrival_date: "2026-12-01", departure_date: "2026-12-03", current_revision_id: "revision", version: 1 };
const primary = { id: "person", order_id: order.id, ordinal: 1, role: "PRIMARY", full_name: "原姓名", nickname: "原昵称", phone: "PRIVATE-PHONE", document_number: "PRIVATE-DOCUMENT", created_at: new Date("2026-10-01") };
const room = { id: "room", kind: "ROOM" as const, code: "F01", parent_room_id: null, building_code: "F", active: true, room_type_code: null, created_at: new Date("2026-01-01") };
type Lodging = Parameters<typeof enrichDashboardOrderDetails>[4];
const known: Lodging = { arrangements: new Map([[order.id, [{ inventoryUnitId: room.id, arrivalDate: order.arrival_date, departureDate: order.departure_date }]]]), units: [room] };
function detail(metric: DashboardDetail["metric"], id = `${metric}:${order.id}`): DashboardDetail {
  return { ...newDashboardDetail(id, today), metric, orderId: order.id, amountMinor: metric === "TODAY_ORDERS" ? null : "36800", currency: metric === "TODAY_ORDERS" ? null : "CNY", registeredAt: "2026-10-23T01:00:00.000Z" };
}
interface FixtureRows { orders?: unknown[]; occupants?: unknown[]; corrections?: unknown[]; catalog?: unknown[]; retained?: unknown[]; segments?: unknown[]; amendments?: unknown[]; revisions?: unknown[]; facts?: unknown[]; claims?: unknown[]; epochs?: unknown[] }
async function enrich(items: DashboardDetail[], rows: FixtureRows = {}, lodging = known) {
  const queries: CompiledQuery[] = [];
  const tables: Array<[string, unknown[]]> = [
    ['from "orders" as "o"', rows.orders ?? [order]], ['from "active_order_occupants"', rows.occupants ?? [primary]],
    ['from "order_occupant_corrections"', rows.corrections ?? []], ['from "room_catalog_state"', rows.catalog ?? []], ['from "retained_funds"', rows.retained ?? []],
    ['from "stay_segments" as "segment"', rows.segments ?? []], ['from "amendments" as "a"', rows.amendments ?? []], ['from "pricing_revisions"', rows.revisions ?? []],
    ['from "collection_facts"', rows.facts ?? []], ['from "inventory_claims" as "claim"', rows.claims ?? []], ['from "schema_migrations"', rows.epochs ?? []]
  ];
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      if (!/^\s*select\b/i.test(query.sql)) throw new Error("Fixture only permits reads");
      queries.push(query);
      const table = tables.find(([match]) => query.sql.includes(match));
      if (!table) throw new Error(`Unexpected query: ${query.sql}`);
      return { rows: table[1] as R[] };
    },
    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> { throw new Error("Streaming is not used"); }
  };
  const db = new Kysely<Database>({ dialect: {
    createAdapter: () => new PostgresAdapter(), createQueryCompiler: () => new PostgresQueryCompiler(), createIntrospector: value => new PostgresIntrospector(value),
    createDriver: () => ({ init: async () => {}, acquireConnection: async () => connection, releaseConnection: async () => {}, destroy: async () => {}, beginTransaction: async () => { throw new Error("Fixture only permits reads"); }, commitTransaction: async () => {}, rollbackTransaction: async () => {} })
  } });
  try { return { items: await enrichDashboardOrderDetails(db as unknown as Transaction<Database>, "property", today, items, lodging), queries }; }
  finally { await db.destroy(); }
}
function initialRows(cancelled = false): FixtureRows {
  const amendment = { id: "amendment", order_id: order.id, sequence: 1, amendment_type: "CREATE_ORDER", payload: { inventoryUnitId: room.id, arrivalDate: order.arrival_date, departureDate: order.departure_date }, reason_code: "CREATE_ORDER", reason_note: "创建", prior_version: 0, new_version: 1, actor_subject_id: "actor", actor_display_name: "操作员", created_at: new Date("2026-10-23T01:00:00.000Z") };
  const revision = { id: "revision", order_id: order.id, revision_no: 1, amendment_id: amendment.id, arrival_date: order.arrival_date, departure_date: order.departure_date, policy_base_amount_minor: 10000, current_contract_amount_minor: 10000, currency: "CNY" };
  return {
    orders: [{ ...order, ...(cancelled ? { status: "CANCELLED", stay_status: "CANCELLED", version: 2, current_revision_id: "cancel-revision" } : {}) }],
    segments: [{ id: "segment", stay_id: order.stay_id, sequence: 1, inventory_unit_id: room.id, arrival_date: order.arrival_date, departure_date: order.departure_date, segment_type: "INITIAL", supersedes_segment_id: null, amendment_id: amendment.id }],
    amendments: [amendment, ...(cancelled ? [{ ...amendment, id: "cancel", sequence: 2, prior_version: 1, new_version: 2, amendment_type: "CANCEL_ORDER", payload: { fromStatus: "RESERVED", toStatus: "CANCELLED" }, created_at: new Date("2026-10-23T02:00:00.000Z") }] : [])],
    revisions: [revision, ...(cancelled ? [{ ...revision, id: "cancel-revision", amendment_id: "cancel", revision_no: 2, policy_base_amount_minor: 0, current_contract_amount_minor: 0 }] : [])],
    claims: cancelled ? [] : ["2026-12-01", "2026-12-02"].map(service_date => ({ order_id: order.id, service_date, inventory_unit_id: room.id }))
  };
}

describe("经营跟进明细的只读补充资料", () => {
  it("留存使用每笔登记的归属客户，与来源订单住客及同来源另一笔留存分别展示", async () => {
    const inputs = [detail("RETAINED", "retained:lot-a"), { ...detail("RETAINED", "retained:lot-b"), amountMinor: "12000" }];
    const result = await enrich(inputs, { retained: [{ id: "lot-a", source_order_id: order.id, owner_name: "代订客户甲" }, { id: "lot-b", source_order_id: order.id, owner_name: "代订客户乙" }] });
    expect(result.items.map(item => item.retainedOwnerName)).toEqual(["代订客户甲", "代订客户乙"]);
    expect(result.items[0]?.orderSummary?.occupants[0]?.name).toBe("原昵称（原姓名）");
    expect(result.items.map(({ orderSummary: _, retainedOwnerName: __, ...item }) => item)).toEqual(inputs);
    expect(inputs.every(item => !item.orderSummary && !item.retainedOwnerName)).toBe(true);
    const ownerQuery = result.queries.find(query => query.sql.includes('from "retained_funds"'))!;
    expect(ownerQuery.parameters).toEqual(["property", "lot-a", "lot-b"]);
    expect(ownerQuery.sql).not.toContain("owner_contact");
  });

  it("批量使用有效多人登记、最新姓名纠正和不同有效房床，保留欠款原金额", async () => {
    const bed = { ...room, id: "bed", kind: "BED" as const, code: "F01-2", parent_room_id: room.id, building_code: null };
    const inputs = [detail("TODAY_ORDERS"), detail("DEBT")];
    const result = await enrich(inputs, { occupants: [primary, { ...primary, id: "companion", ordinal: 2, role: "ADDITIONAL", full_name: null, nickname: null }],
      corrections: [{ occupant_id: primary.id, sequence: 2, corrected_nickname: "小青", corrected_full_name: "青女士", corrected_phone: "PRIVATE-CORRECTED" }, { occupant_id: primary.id, sequence: 1, corrected_nickname: "旧昵称", corrected_full_name: "旧姓名" }],
      catalog: [{ snapshot: { unitCodes: { room: "F09", bed: "F09-2" } } }] },
    { units: [room, bed], arrangements: new Map([[order.id, [room.id, bed.id, room.id].map(inventoryUnitId => ({ inventoryUnitId, arrivalDate: order.arrival_date, departureDate: order.departure_date }))]]) });
    expect(result.items[0]?.orderSummary).toEqual({ occupants: [{ name: "小青（青女士）", isPrimary: true }, { name: "第 2 位住客", isPrimary: false }], rooms: [{ roomCode: "F09", buildingCode: "F" }, { roomCode: "F09-2", buildingCode: "F" }], arrivalDate: order.arrival_date, departureDate: order.departure_date, status: "RESERVED" });
    expect(result.items.map(({ orderSummary: _, ...item }) => item)).toEqual(inputs);
    expect(JSON.stringify(result.items)).not.toContain("PRIVATE-");
    expect(result.queries).toHaveLength(4);
  });

  it.each([false, true])("窗口外今日新增仍保留未来住期或已取消状态，复用生命周期投影核对房间（取消=%s）", async cancelled => {
    const input = detail("TODAY_ORDERS");
    const result = await enrich([input], { ...initialRows(cancelled), catalog: [{ snapshot: { unitCodes: { room: "F09" } } }] }, { units: [room], arrangements: new Map() });
    expect(result.items[0]?.orderSummary).toMatchObject({ status: cancelled ? "CANCELLED" : "RESERVED", arrivalDate: "2026-12-01", departureDate: "2026-12-03", rooms: [{ roomCode: cancelled ? "F01" : "F09", buildingCode: "F" }] });
    expect(result.items[0]?.registeredAt).toBe(input.registeredAt);
  });

  it("生命周期证据不足、无住客或缺归属客户时保留事实并明确留空", async () => {
    const inputs = [detail("RETAINED", "retained:missing")];
    const result = await enrich(inputs, { orders: [{ ...order, status: "CHECK_IN_REVOKED", stay_status: "CHECK_IN_REVOKED" }], occupants: [] }, { units: [room], arrangements: new Map() });
    expect(result.items[0]).toMatchObject({ amountMinor: "36800", retainedOwnerName: null, orderSummary: { occupants: [], rooms: [], status: "CHECK_IN_REVOKED" } });
    expect(result.items).toHaveLength(inputs.length);
  });

  it("空分页和非跟进指标不读额外资料", async () => {
    for (const items of [[], [detail("MONEY")], [detail("ARRIVAL")]]) {
      const result = await enrich(items);
      expect(result.items).toBe(items);
      expect(result.queries).toHaveLength(0);
    }
  });
});

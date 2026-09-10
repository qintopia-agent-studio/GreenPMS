import { createHmac, timingSafeEqual } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { Value } from "@sinclair/typebox/value";
import { DomainError } from "@qintopia/contracts";
import { PmsOrderProjectionSchema, PmsMemberProjectionSchema, PmsInventoryProjectionSchema, type PmsOrderProjection, type PmsMemberProjection, type PmsInventoryProjection } from "../../contracts/src/pms-integration.ts";
import { pmsProjectionHash } from "../../domain/src/pms-projection-hash.ts";
import { getOrderViewSnapshot } from "./orders.ts";
import type { Database } from "./schema.ts";
import type { DbExecutor } from "./inventory.ts";
const corrupt = () => new DomainError("INTERNAL_ERROR", "INTEGRATION_PROJECTION_UNAVAILABLE", 503, true);
const missing = () => new DomainError("NOT_FOUND", "Integration resource not found", 404);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function limitValue(limit = 100) { if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new DomainError("VALIDATION_ERROR", "Invalid limit"); return limit; }
async function snapshot<T>(db: Kysely<Database>, read: (trx: DbExecutor) => Promise<T>): Promise<T> {
    try {
        return await db.transaction().setIsolationLevel("repeatable read").execute(read);
    }
    catch (error) {
        if (error instanceof DomainError && [400, 403, 404, 410].includes(error.statusCode))
            throw error;
        // Existing lifecycle errors can contain guest or financial context. Never propagate it.
        throw corrupt();
    }
}
async function source(db: DbExecutor) {
    const row = (await sql<{
        source_instance: string;
    }> `SELECT source_instance FROM integration_source`.execute(db)).rows[0];
    if (!row)
        throw corrupt();
    return row.source_instance;
}
async function meta(db: DbExecutor, property: string) { return { schema_version: "pms.projections.v1" as const, source_instance: await source(db), property_id: property, observed_at: new Date().toISOString(), projection_hash: "" }; }
async function revision(db: DbExecutor, kind: string, id: string) {
    const row = (await sql<{
        revision: string;
        last_fact_ref: string;
        invalidated: boolean;
        invalidated_recorded_at: Date | null;
    }> `SELECT revision::text,last_fact_ref,invalidated,invalidated_recorded_at FROM integration_entity_revisions WHERE aggregate_type=${kind} AND aggregate_id=${id}`.execute(db)).rows[0];
    if (!row)
        throw corrupt();
    return row;
}
export async function readPmsMember(db: Kysely<Database>, property: string, id: string) {
    return snapshot(db, async (trx) => {
        const row = await trx.selectFrom("members as m").innerJoin("member_property_links as l", "l.member_id", "m.id").select(["m.id", "m.deleted_at"]).where("m.id", "=", id).where("l.property_id", "=", property).executeTakeFirst();
        if (!row)
            throw missing();
        const rev = await revision(trx, "member", id);
        if (rev.invalidated !== (row.deleted_at !== null))
            throw corrupt();
        const base = { ...await meta(trx, property), member_id: id, member_revision: rev.revision };
        let result: PmsMemberProjection;
        if (row.deleted_at !== null) {
            if (!rev.invalidated_recorded_at)
                throw corrupt();
            result = { ...base, resource_state: "tombstone", invalidation_kind: "BUSINESS_DELETED", invalidated_recorded_at: rev.invalidated_recorded_at.toISOString(), source_fact_ref: rev.last_fact_ref };
        }
        else {
            const refs = await trx.selectFrom("member_external_references").select(["id as reference_id", "provider", "source_container_id", "source_table_id", "external_record_id"]).where("member_id", "=", id).where("property_id", "=", property).execute();
            refs.sort((a, b) => { for (const key of ["provider", "source_container_id", "source_table_id", "external_record_id", "reference_id"] as const) {
                const c = compare(a[key], b[key]);
                if (c)
                    return c;
            } return 0; });
            result = { ...base, resource_state: "active", external_references: refs };
        }
        result.projection_hash = pmsProjectionHash(result);
        if (!Value.Check(PmsMemberProjectionSchema, result))
            throw corrupt();
        return result;
    });
}
export async function readPmsInventory(db: Kysely<Database>, property: string, id: string) {
    return snapshot(db, async (trx) => {
        const unit = await trx.selectFrom("inventory_units").select(["id", "active", "kind", "parent_room_id", "building_code"]).where("id", "=", id).where("property_id", "=", property).executeTakeFirst();
        if (!unit)
            throw missing();
        const rev = await revision(trx, "inventory_unit", id);
        if (rev.invalidated === unit.active)
            throw corrupt();
        const base = { ...await meta(trx, property), inventory_unit_id: id, inventory_revision: rev.revision };
        const result: PmsInventoryProjection = unit.active ? { ...base, resource_state: "active", kind: unit.kind, parent_room_id: unit.parent_room_id, building_code: unit.building_code }
            : { ...base, resource_state: "tombstone", invalidation_kind: "INACTIVE", invalidated_recorded_at: rev.invalidated_recorded_at?.toISOString() ?? null, source_fact_ref: rev.last_fact_ref };
        result.projection_hash = pmsProjectionHash(result);
        if (!Value.Check(PmsInventoryProjectionSchema, result))
            throw corrupt();
        return result;
    });
}
async function orderProjection(db: DbExecutor, property: string, id: string): Promise<PmsOrderProjection> {
    const found = await db.selectFrom("orders").select("id").where("id", "=", id).where("property_id", "=", property).executeTakeFirst();
    if (!found)
        throw missing();
    const view = await getOrderViewSnapshot(db, id, "READ");
    const timezone = (await db.selectFrom("properties").select("timezone").where("id", "=", property).executeTakeFirstOrThrow()).timezone;
    // Lifecycle validation establishes the complete arrangement chain. Preserve interval
    // provenance across overlays; a full replacement establishes all intervals anew.
    let provenance = new Map<string, string>();
    const key = (i: {
        inventoryUnitId: string;
        arrivalDate: string;
        departureDate: string;
    }) => JSON.stringify([i.inventoryUnitId, i.arrivalDate, i.departureDate]);
    if (view.segments.length !== view.arrangementHistory.length)
        throw corrupt();
    for (const [index, history] of view.arrangementHistory.entries()) {
        const segment = view.segments[index]!;
        const replace = ["INITIAL", "RESCHEDULE_STAY", "REVOKE_CHECK_OUT", "CORRECT_HISTORICAL_STAY_ARRANGEMENT"].includes(segment.segment_type);
        provenance = new Map(history.after.intervals.map(i => [key(i), replace ? segment.id : provenance.get(key(i)) ?? segment.id]));
    }
    const unitIds = [...new Set(view.effectiveArrangement.intervals.map(i => i.inventoryUnitId))];
    const units = await db.selectFrom("inventory_units").select(["id", "kind", "parent_room_id", "building_code", "active"]).where("property_id", "=", property).where("id", "in", unitIds).execute();
    const unitsById = new Map(units.map(u => [u.id, u]));
    const intervals = view.effectiveArrangement.intervals.map(i => {
        const unit = unitsById.get(i.inventoryUnitId), segment = provenance.get(key(i));
        if (!unit || !segment || (unit.kind === "BED" && !unit.parent_room_id))
            throw corrupt();
        return { segment_id: segment, inventory_unit_id: unit.id, arrival_date: i.arrivalDate, departure_date: i.departureDate, inventory_kind: unit.kind, room_id: unit.kind === "ROOM" ? unit.id : unit.parent_room_id!, bed_id: unit.kind === "BED" ? unit.id : null, building_code: unit.building_code, inventory_active: unit.active };
    }).sort((a, b) => compare(a.arrival_date, b.arrival_date) || compare(a.departure_date, b.departure_date) || compare(a.inventory_unit_id, b.inventory_unit_id) || compare(a.segment_id, b.segment_id));
    const related: PmsOrderProjection["related_revisions"] = [];
    for (const unitId of [...new Set([...unitIds, ...units.flatMap(u => u.parent_room_id ? [u.parent_room_id] : [])])]) {
        related.push({ aggregate_type: "inventory_unit", aggregate_id: unitId, aggregate_revision: (await revision(db, "inventory_unit", unitId)).revision });
    }
    if (view.order.member_id)
        related.push({ aggregate_type: "member", aggregate_id: view.order.member_id, aggregate_revision: (await revision(db, "member", view.order.member_id)).revision });
    related.sort((a, b) => compare(a.aggregate_type, b.aggregate_type) || compare(a.aggregate_id, b.aggregate_id));
    const occupants = (await db.selectFrom("order_occupants as o").leftJoin("order_occupant_removals as r", "r.occupant_id", "o.id").select(["o.id", "o.role", "r.id as removal_id"]).where("o.order_id", "=", id).execute()).map(o => ({ occupant_id: o.id, role: o.role, registration_state: o.removal_id ? "removed" as const : "active" as const })).sort((a, b) => (a.role === b.role ? 0 : a.role === "PRIMARY" ? -1 : 1) || compare(a.occupant_id, b.occupant_id));
    const arrival = view.effectiveArrangement.arrivalDate, departure = view.effectiveArrangement.departureDate, day = view.effectiveArrangement.businessDate;
    const state = view.fulfillment.state;
    const temporal: PmsOrderProjection["read_context"]["temporal_state"] = state === "NOT_CHECKED_IN" ? (day < arrival ? "NOT_STARTED" : day === arrival ? "RESERVED_TODAY" : "OVERDUE_RESERVED")
        : state === "IN_HOUSE" ? (day < departure ? "IN_HOUSE_TODAY" : day === departure ? "DUE_OUT" : "OVERDUE_IN_HOUSE") : "TERMINAL";
    const today = intervals.filter(i => i.arrival_date <= day && i.departure_date > day);
    const isToday = temporal === "RESERVED_TODAY" || temporal === "IN_HOUSE_TODAY";
    if (isToday && today.length !== 1)
        throw corrupt();
    const current = today[0];
    const result: PmsOrderProjection = { ...await meta(db, property), order_id: id, order_revision: String(view.order.version), stay_id: view.stay.id,
        stay_status: state === "NOT_CHECKED_IN" ? "PLANNED" : state === "CHECKED_OUT" ? "COMPLETED" : state, fulfillment_state: state, checked_in_at: null,
        effective_arrangement: { presentation: view.effectiveArrangement.presentation, arrival_date: arrival, departure_date: departure, intervals }, occupants,
        member_ref: view.order.member_id ? { member_id: view.order.member_id } : null, related_revisions: related,
        read_context: { property_timezone: timezone, business_date: day, temporal_state: temporal, current_interval: isToday && current ? { segment_id: current.segment_id, inventory_unit_id: current.inventory_unit_id, arrival_date: current.arrival_date, departure_date: current.departure_date } : null } };
    result.projection_hash = pmsProjectionHash(result);
    if (!Value.Check(PmsOrderProjectionSchema, result))
        throw corrupt();
    return result;
}
export async function readPmsOrder(db: Kysely<Database>, property: string, id: string) { return snapshot(db, trx => orderProjection(trx, property, id)); }
export async function scanPmsOrders(db: Kysely<Database>, property: string, afterId?: string, limit = 100) {
    limitValue(limit);
    return snapshot(db, async (trx) => {
        const source_instance = await source(trx);
        let query = trx.selectFrom("orders").select("id").where("property_id", "=", property).orderBy("id").limit(limit + 1);
        if (afterId)
            query = query.where("id", ">", afterId);
        const rows = await query.execute(), selected = rows.slice(0, limit);
        const orders = [];
        for (const row of selected)
            orders.push(await orderProjection(trx, property, row.id));
        return { schema_version: "pms.projections.v1" as const, source_instance, property_id: property, orders, next_after_id: selected.at(-1)?.id ?? afterId ?? null, has_more: rows.length > limit };
    });
}
export async function readPmsEventFeed(db: Kysely<Database>, property: string, cursor?: string, limit = 100): Promise<string> {
    limitValue(limit);
    return snapshot(db, async (trx) => {
        const source_instance = await source(trx);
        const state = (await sql<{
            head: string;
            floor: string;
            cursor_epoch: string;
        }> `SELECT head::text,floor::text,cursor_epoch FROM integration_publish_state WHERE property_id=${property}`.execute(trx)).rows[0];
        if (!state)
            throw corrupt();
        const sign = (value: string) => createHmac("sha256", state.cursor_epoch).update(value).digest("base64url");
        const encode = (seq: string) => { const payload = Buffer.from(JSON.stringify(["pms.events.v1", source_instance, property, seq])).toString("base64url"); return `${payload}.${sign(payload)}`; };
        let consumed = state.floor;
        if (cursor) {
            try {
                if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor))
                    throw Error();
                const [payload, signature] = cursor.split(".") as [
                    string,
                    string
                ];
                const values: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
                if (Array.isArray(values) && values.length === 4 && values[2] !== property)
                    throw new DomainError("INSUFFICIENT_ACCESS", "Cursor property mismatch", 403);
                const expected = sign(payload);
                if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected)))
                    throw Error();
                if (!Array.isArray(values) || values.length !== 4 || values[0] !== "pms.events.v1" || values[1] !== source_instance || values[2] !== property || typeof values[3] !== "string" || !/^(0|[1-9][0-9]*)$/.test(values[3]))
                    throw Error();
                consumed = values[3];
                if (BigInt(consumed) > BigInt(state.head))
                    throw Error();
            }
            catch (error) {
                if (error instanceof DomainError)
                    throw error;
                throw new DomainError("VALIDATION_ERROR", "Invalid integration cursor");
            }
            if (BigInt(consumed) < BigInt(state.floor))
                throw new DomainError("CURSOR_EXPIRED", "Rebuild the source baseline", 410, false, { rebuild_required: true });
        }
        const rows = (await sql<{
            body: string;
            publish_seq: string;
        }> `SELECT body,publish_seq::text FROM integration_published_events WHERE property_id=${property} AND publish_seq>${consumed}::bigint AND publish_seq<=${state.head}::bigint ORDER BY publish_seq LIMIT ${limit + 1}`.execute(trx)).rows;
        const selected = rows.slice(0, limit);
        const next = selected.at(-1)?.publish_seq ?? consumed;
        // Embed the stored event JSON verbatim. Do not parse/stringify signed envelopes.
        const wrapper = { schema_version: "pms.events.v1", source_instance, property_id: property, next_cursor: encode(next), has_more: rows.length > limit, head_cursor: encode(state.head), retention_floor_cursor: encode(state.floor) };
        return `${JSON.stringify(wrapper).slice(0, -1)},"events":[${selected.map(row => row.body).join(",")}]}`;
    });
}

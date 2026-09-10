// Implementation of the single shared contract: Agent OS unified-person-welcome-v1-contract.md §11.
import { Type, type Static, type TSchema } from "@sinclair/typebox";
const object = <T extends Record<string, TSchema>>(fields: T) => Type.Object(fields, { additionalProperties: false });
const text = Type.String({ minLength: 1, maxLength: 256 });
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const enumeration = <T extends string>(values: T[]) => Type.Union(values.map(value => Type.Literal(value)));
const revision = Type.String({ pattern: "^[1-9][0-9]*$" });
const date = Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" });
const instant = Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$" });
const meta = {
    schema_version: Type.Literal("pms.projections.v1"), source_instance: text, property_id: text,
    projection_hash: Type.String({ pattern: "^[0-9a-f]{64}$" }), observed_at: instant
};
const interval = { segment_id: text, inventory_unit_id: text, arrival_date: date, departure_date: date };
export const PmsOrderProjectionSchema = object({
    ...meta, order_id: text, order_revision: revision, stay_id: text,
    stay_status: enumeration(["PLANNED", "IN_HOUSE", "COMPLETED", "CANCELLED", "NO_SHOW", "CHECK_IN_REVOKED"]),
    fulfillment_state: enumeration(["NOT_CHECKED_IN", "IN_HOUSE", "CHECKED_OUT", "CANCELLED", "NO_SHOW", "CHECK_IN_REVOKED"]),
    checked_in_at: nullable(instant),
    effective_arrangement: object({
        presentation: enumeration(["CURRENT", "LAST", "BEFORE_CANCELLATION", "NO_SHOW_ORDER", "BEFORE_CHECK_IN_REVOCATION"]),
        arrival_date: date, departure_date: date,
        intervals: Type.Array(object({ ...interval, inventory_kind: enumeration(["ROOM", "BED"]), room_id: text,
            bed_id: nullable(text), building_code: nullable(text), inventory_active: Type.Boolean() }))
    }),
    occupants: Type.Array(object({ occupant_id: text, role: enumeration(["PRIMARY", "ADDITIONAL"]), registration_state: enumeration(["active", "removed"]) })),
    member_ref: nullable(object({ member_id: text })),
    related_revisions: Type.Array(object({ aggregate_type: enumeration(["member", "inventory_unit"]), aggregate_id: text, aggregate_revision: revision })),
    read_context: object({ property_timezone: text, business_date: date,
        temporal_state: enumeration(["NOT_STARTED", "RESERVED_TODAY", "OVERDUE_RESERVED", "IN_HOUSE_TODAY", "DUE_OUT", "OVERDUE_IN_HOUSE", "TERMINAL"]),
        current_interval: nullable(object(interval)) })
});
const member = { ...meta, member_id: text, member_revision: revision };
export const PmsMemberProjectionSchema = Type.Union([
    object({ ...member, resource_state: Type.Literal("active"), external_references: Type.Array(object({ reference_id: text, provider: Type.Literal("FEISHU_BASE"), source_container_id: text, source_table_id: text, external_record_id: text })) }),
    object({ ...member, resource_state: Type.Literal("tombstone"), invalidation_kind: Type.Literal("BUSINESS_DELETED"), invalidated_recorded_at: instant, source_fact_ref: text })
]);
const inventory = { ...meta, inventory_unit_id: text, inventory_revision: revision };
export const PmsInventoryProjectionSchema = Type.Union([
    object({ ...inventory, resource_state: Type.Literal("active"), kind: enumeration(["ROOM", "BED"]), parent_room_id: nullable(text), building_code: nullable(text) }),
    object({ ...inventory, resource_state: Type.Literal("tombstone"), invalidation_kind: Type.Literal("INACTIVE"), invalidated_recorded_at: nullable(instant), source_fact_ref: text })
]);
export const PmsOrdersScanSchema = object({ schema_version: Type.Literal("pms.projections.v1"), source_instance: text, property_id: text, orders: Type.Array(PmsOrderProjectionSchema), next_after_id: nullable(text), has_more: Type.Boolean() });
export type PmsOrderProjection = Static<typeof PmsOrderProjectionSchema>;
export type PmsMemberProjection = Static<typeof PmsMemberProjectionSchema>;
export type PmsInventoryProjection = Static<typeof PmsInventoryProjectionSchema>;
export const PmsEventSchema = object({
    schema_version: Type.Literal("pms.events.v1"), event_id: text, source_instance: text, property_id: text,
    event_type: enumeration(["pms.order.created", "pms.order.context_changed", "pms.stay.checked_in", "pms.stay.arrangement_changed", "pms.stay.checked_out", "pms.stay.cancelled", "pms.stay.no_show", "pms.stay.check_in_revoked", "pms.stay.check_out_revoked", "pms.order.occupants_changed", "pms.member.context_changed", "pms.inventory_unit.context_changed", "pms.entity.invalidated"]),
    aggregate_type: enumeration(["order", "member", "inventory_unit"]), aggregate_id: text, aggregate_revision: revision,
    recorded_at: instant, effective_at: nullable(instant), source_fact_ref: text, publish_seq: revision,
    refs: object({ order_id: Type.Optional(text), stay_id: Type.Optional(text), member_id: Type.Optional(text), inventory_unit_id: Type.Optional(text), occupant_id: Type.Optional(text) }),
    origin: enumeration(["live", "historical_correction", "baseline"])
});
const cursorToken = Type.String({ minLength: 1, maxLength: 2048 });
export const PmsEventFeedSchema = object({ schema_version: Type.Literal("pms.events.v1"), source_instance: text, property_id: text, events: Type.Array(PmsEventSchema), next_cursor: cursorToken, has_more: Type.Boolean(), head_cursor: cursorToken, retention_floor_cursor: cursorToken });

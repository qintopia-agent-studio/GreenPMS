import type { DbExecutor } from "./inventory.ts";
import type { RoomCatalogSnapshot } from "@qintopia/contracts";

/** Operational labels can change; historical inventory records stay untouched. */
export async function projectCatalogUnitNames<T extends { id: string; property_id: string; room_type_code: string | null; code: string; name: string; active: boolean }>(db: DbExecutor, units: T[]): Promise<T[]> {
  const propertyIds = [...new Set(units.map((unit) => unit.property_id))];
  if (!propertyIds.length) return units;
  const states = await db.selectFrom("room_catalog_state").select(["property_id", "snapshot"]).where("property_id", "in", propertyIds).execute();
  const catalogs = new Map(states.map((state) => [state.property_id, state.snapshot as unknown as RoomCatalogSnapshot]));
  return units.map((unit) => {
    const catalog = catalogs.get(unit.property_id);
    const name = unit.active && unit.room_type_code ? catalog?.types.find((type) => type.code === unit.room_type_code)?.name : undefined;
    const code = unit.active ? catalog?.unitCodes?.[unit.id] ?? unit.code : unit.code;
    return name ? { ...unit, code, name: `${code} ${name}` } : unit;
  });
}

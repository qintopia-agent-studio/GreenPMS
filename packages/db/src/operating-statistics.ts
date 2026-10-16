import type { DbExecutor } from "./inventory.ts";

export interface OperatingStatisticsUnit { id: string; kind: "ROOM" | "BED"; parent_room_id: string | null }
export interface OperatingStatisticsSetting { asset_id: string; included: boolean }
export interface OperatingStatisticsInterval { inventoryUnitId: string; arrivalDate: string; departureDate: string }

/** One property, every room version and child bed. Unknown units remain unknown. */
export function operatingStatisticsScope(
  units: readonly OperatingStatisticsUnit[],
  links: readonly { unit_id: string; asset_id: string }[],
  settings: readonly OperatingStatisticsSetting[]
) {
  const byId = new Map(units.map(unit => [unit.id, unit]));
  const assets = new Map(links.map(link => [link.unit_id, link.asset_id]));
  const configured = new Map(settings.map(setting => [setting.asset_id, setting.included]));
  function assetId(unitId: string): string | undefined {
    const unit = byId.get(unitId);
    const room = unit?.kind === "ROOM" ? unit : unit?.parent_room_id ? byId.get(unit.parent_room_id) : undefined;
    return room?.kind === "ROOM" ? assets.get(room.id) ?? room.id : undefined;
  }
  function classifyUnit(unitId: string): boolean | null {
    const asset = assetId(unitId);
    return asset === undefined ? null : configured.get(asset) ?? true;
  }
  return { assetId, classifyUnit, includesUnit: (unitId: string) => classifyUnit(unitId) === true };
}
export type OperatingStatisticsScope = ReturnType<typeof operatingStatisticsScope>;

export async function loadOperatingStatisticsScope(db: DbExecutor, propertyId: string, inventory?: readonly OperatingStatisticsUnit[]): Promise<OperatingStatisticsScope> {
  const [units, links, settings] = await Promise.all([
    inventory ?? db.selectFrom("inventory_units").select(["id", "kind", "parent_room_id"]).where("property_id", "=", propertyId).execute(),
    db.selectFrom("room_catalog_links as link").innerJoin("inventory_units as unit", "unit.id", "link.unit_id")
      .select(["link.unit_id", "link.asset_id"]).where("unit.property_id", "=", propertyId).execute(),
    db.selectFrom("room_operating_statistics").select(["asset_id", "included"]).where("property_id", "=", propertyId).execute()
  ]);
  return operatingStatisticsScope(units, links, settings);
}

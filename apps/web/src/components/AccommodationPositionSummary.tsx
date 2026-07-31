import type { InventoryUnitDto, OrderViewDto } from "../types";
import { formatDate } from "../ui";

export interface AccommodationPositionItem {
  label: string;
  inventoryUnitId: string;
  effectiveDate: string;
}

export function accommodationPositionItems(
  view: Pick<OrderViewDto, "effectiveArrangement" | "fulfillment">
): AccommodationPositionItem[] {
  const intervals = view.effectiveArrangement.intervals;
  if (view.fulfillment.state === "NOT_CHECKED_IN") {
    return intervals.map((interval, index) => ({
      label: index === 0 ? "计划住宿位置" : "计划换至",
      inventoryUnitId: interval.inventoryUnitId,
      effectiveDate: interval.arrivalDate
    }));
  }
  if (view.fulfillment.state !== "IN_HOUSE") return [];
  const businessDate = view.effectiveArrangement.businessDate;
  const current = intervals.find((interval) => interval.arrivalDate <= businessDate && businessDate < interval.departureDate)
    ?? intervals.at(-1);
  if (!current) return [];
  return [{
    label: "当前住宿位置",
    inventoryUnitId: current.inventoryUnitId,
    effectiveDate: businessDate
  }, ...intervals
    .filter((interval) => interval.arrivalDate > businessDate)
    .map((interval) => ({
      label: "计划换至",
      inventoryUnitId: interval.inventoryUnitId,
      effectiveDate: interval.arrivalDate
    }))];
}

export function AccommodationPositionSummary({
  view,
  inventoryUnits
}: {
  view: Pick<OrderViewDto, "effectiveArrangement" | "fulfillment">;
  inventoryUnits: readonly Pick<InventoryUnitDto, "id" | "code" | "name">[];
}) {
  const items = accommodationPositionItems(view);
  if (!items.length) return null;
  const units = new Map(inventoryUnits.map((unit) => [unit.id, unit]));
  return <dl className="accommodation-position-summary" data-testid="accommodation-position-summary">
    {items.map((item) => {
      const unit = units.get(item.inventoryUnitId);
      return <div key={`${item.label}:${item.effectiveDate}:${item.inventoryUnitId}`}>
        <dt>{item.label}</dt>
        <dd>
          <strong>{unit ? `${unit.code} · ${unit.name}` : "房源名称暂不可用"}</strong>
          <small>{item.label === "当前住宿位置" ? `营业日 ${formatDate(item.effectiveDate)}` : `${formatDate(item.effectiveDate)} 起`}</small>
        </dd>
      </div>;
    })}
  </dl>;
}

import { AlertTriangle } from "lucide-react";
import type { OrderViewDto } from "../types";
import { formatDate } from "../ui";

export interface OverdueInHouseNotice {
  title: "逾期在住，需确认实际状态";
  plannedDepartureDate: string;
  businessDate: string;
}

export function overdueInHouseNotice(
  view: Pick<OrderViewDto, "order" | "stay" | "effectiveArrangement">
): OverdueInHouseNotice | undefined {
  if (view.order.status !== "CHECKED_IN"
    || view.stay.status !== "IN_HOUSE"
    || view.effectiveArrangement.departureDate >= view.effectiveArrangement.businessDate) {
    return undefined;
  }
  return {
    title: "逾期在住，需确认实际状态",
    plannedDepartureDate: view.effectiveArrangement.departureDate,
    businessDate: view.effectiveArrangement.businessDate
  };
}

export function OverdueInHouseAlert({ notice }: { notice: OverdueInHouseNotice }) {
  return <section className="overdue-in-house-alert" role="alert" data-testid="overdue-in-house-alert">
    <AlertTriangle aria-hidden="true" size={20} />
    <div>
      <strong>{notice.title}</strong>
      <span>计划离店日 {formatDate(notice.plannedDepartureDate)} 已早于当前营业日 {formatDate(notice.businessDate)}。</span>
      <span>客人仍在住，请先调整退房日期；客人已离店，请办理迟录退房。</span>
    </div>
  </section>;
}

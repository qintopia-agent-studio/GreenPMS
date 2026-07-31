import { DomainError } from "@qintopia/contracts";
import { enumerateServiceDates, parseLocalDate } from "@qintopia/domain";
import type { StayTimelineItem } from "./orders.ts";

export interface StayTimelinePairDiff {
  preserved: StayTimelineItem[];
  released: StayTimelineItem[];
  added: StayTimelineItem[];
}

function nextServiceDate(serviceDate: string): string {
  const date = parseLocalDate(serviceDate);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function shiftServiceDate(serviceDate: string, days: number): string {
  const date = parseLocalDate(serviceDate);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dayDelta(before: string, after: string): number {
  return Math.round((parseLocalDate(after).getTime() - parseLocalDate(before).getTime()) / 86_400_000);
}

function assertCompleteTimeline(
  timeline: readonly StayTimelineItem[],
  arrivalDate: string,
  departureDate: string
): void {
  const expectedDates = enumerateServiceDates(arrivalDate, departureDate);
  if (timeline.length !== expectedDates.length || timeline.some((item, index) => (
    !item.inventoryUnitId || item.serviceDate !== expectedDates[index]
  ))) {
    throw new DomainError("INTERNAL_ERROR", "当前住宿安排时间线损坏，不能调整预订日期", 500);
  }
}

export function planStayDateChangeTimeline(options: {
  currentTimeline: readonly StayTimelineItem[];
  oldArrivalDate: string;
  oldDepartureDate: string;
  newArrivalDate: string;
  newDepartureDate: string;
}): StayTimelineItem[] {
  assertCompleteTimeline(options.currentTimeline, options.oldArrivalDate, options.oldDepartureDate);
  const newDates = enumerateServiceDates(options.newArrivalDate, options.newDepartureDate);
  const arrivalDelta = dayDelta(options.oldArrivalDate, options.newArrivalDate);
  const departureDelta = dayDelta(options.oldDepartureDate, options.newDepartureDate);

  if (arrivalDelta === departureDelta) {
    const shifted = options.currentTimeline.map((item) => ({
      serviceDate: shiftServiceDate(item.serviceDate, arrivalDelta),
      inventoryUnitId: item.inventoryUnitId
    }));
    assertCompleteTimeline(shifted, options.newArrivalDate, options.newDepartureDate);
    return shifted;
  }

  const currentByDate = new Map(options.currentTimeline.map((item) => [item.serviceDate, item.inventoryUnitId]));
  const firstUnitId = options.currentTimeline[0]!.inventoryUnitId;
  const lastUnitId = options.currentTimeline.at(-1)!.inventoryUnitId;
  return newDates.map((serviceDate) => ({
    serviceDate,
    inventoryUnitId: serviceDate < options.oldArrivalDate
      ? firstUnitId
      : serviceDate >= options.oldDepartureDate
        ? lastUnitId
        : currentByDate.get(serviceDate)!
  }));
}

function pairKey(item: StayTimelineItem): string {
  return `${item.serviceDate}\u0000${item.inventoryUnitId}`;
}

export function timelinePairDiff(
  before: readonly StayTimelineItem[],
  after: readonly StayTimelineItem[]
): StayTimelinePairDiff {
  const beforeKeys = new Set(before.map(pairKey));
  const afterKeys = new Set(after.map(pairKey));
  return {
    preserved: before.filter((item) => afterKeys.has(pairKey(item))),
    released: before.filter((item) => !afterKeys.has(pairKey(item))),
    added: after.filter((item) => !beforeKeys.has(pairKey(item)))
  };
}

export function timelineRuns(timeline: readonly StayTimelineItem[]): Array<{
  inventoryUnitId: string;
  arrivalDate: string;
  departureDate: string;
}> {
  const runs: Array<{ inventoryUnitId: string; arrivalDate: string; departureDate: string }> = [];
  for (const item of timeline) {
    const current = runs.at(-1);
    if (current && current.inventoryUnitId === item.inventoryUnitId && current.departureDate === item.serviceDate) {
      current.departureDate = nextServiceDate(item.serviceDate);
    } else {
      runs.push({
        inventoryUnitId: item.inventoryUnitId,
        arrivalDate: item.serviceDate,
        departureDate: nextServiceDate(item.serviceDate)
      });
    }
  }
  return runs;
}

import { describe, expect, it } from "vitest";
import type { OrderRowDto } from "../types";
import {
  buildTodayBuckets,
  todayArrivalActionAllowed,
  todayQueueStatusLabel
} from "./TodayPage";

function order(id: string, status: string, arrivalDate: string, departureDate: string): OrderRowDto {
  return {
    id,
    property_id: "property_qintopia",
    status,
    stay_status: status === "CHECKED_IN" ? "IN_HOUSE" : status === "RESERVED" ? "PLANNED" : "COMPLETED",
    stay_type: "TRANSIENT",
    arrival_date: arrivalDate,
    departure_date: departureDate,
    primary_guest_snapshot: { nickname: id },
    booking_channel_code: "WECOM",
    channel_order_reference: null,
    free_stay_reason: null,
    free_stay_category_code: null,
    pricing_policy_version_id: "policy_1",
    member_id: null,
    member_contract_id: null,
    current_revision_id: "revision_1",
    current_contract_amount_minor: 10_000,
    currency: "CNY",
    version: 1,
    created_at: "2026-07-30T08:00:00.000Z",
    updated_at: "2026-07-30T08:00:00.000Z"
  };
}

describe("today fulfillment buckets", () => {
  it("keeps normal arrivals, in-house and departures on their existing queues", () => {
    const arrival = order("arrival", "RESERVED", "2026-09-01", "2026-09-03");
    const inHouse = order("resident", "CHECKED_IN", "2026-08-20", "2026-09-03");
    const departure = order("departure", "CHECKED_IN", "2026-08-28", "2026-09-01");
    expect(buildTodayBuckets([arrival, inHouse, departure], "2026-09-01")).toEqual({
      ARRIVALS: [arrival], IN_HOUSE: [inHouse, departure], DEPARTURES: [departure]
    });
  });

  it("does not turn cancelled, no-show or revoked orders into a local queue", () => {
    const terminal = ["CANCELLED", "NO_SHOW", "CHECK_IN_REVOKED"].map((status) =>
      order(status, status, "2026-09-01", "2026-09-03"));
    expect(buildTodayBuckets(terminal, "2026-09-01")).toEqual({ ARRIVALS: [], IN_HOUSE: [], DEPARTURES: [] });
  });

  it("keeps an inconsistent Stay out of ordinary fulfillment actions", () => {
    const inconsistent = { ...order("inconsistent", "CHECKED_IN", "2026-08-20", "2026-09-01"), stay_status: "COMPLETED" as const };
    expect(buildTodayBuckets([inconsistent], "2026-09-01")).toEqual({ ARRIVALS: [], IN_HOUSE: [], DEPARTURES: [] });
    expect(todayArrivalActionAllowed(inconsistent, "2026-08-20", "2026-08-20")).toBe(false);
  });

  it("labels an in-house order due today as waiting for checkout", () => {
    const dueOut = order("due-out", "CHECKED_IN", "2026-08-28", "2026-09-01");
    expect(buildTodayBuckets([dueOut], "2026-09-01").DEPARTURES).toEqual([dueOut]);
    expect(todayQueueStatusLabel("DEPARTURES", dueOut, "2026-09-01")).toBe("待退房");
    expect(todayQueueStatusLabel("IN_HOUSE", dueOut, "2026-09-01")).toBe("在住");

    const overdue = order("overdue", "CHECKED_IN", "2026-08-20", "2026-08-31");
    expect(todayQueueStatusLabel("DEPARTURES", overdue, "2026-09-01")).toBe("未退");

    const future = order("future-departure", "CHECKED_IN", "2026-08-28", "2026-09-03");
    expect(todayQueueStatusLabel("DEPARTURES", future, "2026-09-01")).toBe("在住");
  });

  it("only exposes check-in on the current business date", () => {
    const arrival = order("arrival", "RESERVED", "2026-09-08", "2026-09-10");
    expect(todayArrivalActionAllowed(arrival, "2026-09-08", "2026-09-08")).toBe(true);
    expect(todayArrivalActionAllowed(arrival, "2026-09-09", "2026-09-08")).toBe(false);
  });
});

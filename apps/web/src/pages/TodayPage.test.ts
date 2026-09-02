import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { OrderRowDto } from "../types";
import {
  buildTodayBuckets,
  TodayExceptionAction,
  TodayExceptionReason,
  todayExceptionPresentation,
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
  it("includes an overdue RESERVED stay throughout its still-active accommodation range", () => {
    const overdue = order("overdue-arrival", "RESERVED", "2026-07-30", "2026-08-03");
    const buckets = buildTodayBuckets([overdue], "2026-08-01");
    expect(buckets.EXCEPTIONS).toEqual([overdue]);
    expect(buckets.ARRIVALS).toEqual([]);
  });

  it("does not misclassify a future arrival or a revoked check-in as an overdue exception", () => {
    const future = order("future", "RESERVED", "2026-08-02", "2026-08-04");
    const revoked = order("revoked", "CHECK_IN_REVOKED", "2026-07-30", "2026-07-31");
    expect(buildTodayBuckets([future, revoked], "2026-08-01").EXCEPTIONS).toEqual([]);
  });

  it("keeps no-show and cancelled records visible without locally authorizing a write", () => {
    const noShow = order("no-show", "NO_SHOW", "2026-07-31", "2026-08-02");
    const cancelled = order("cancelled", "CANCELLED", "2026-08-01", "2026-08-02");
    expect(buildTodayBuckets([noShow, cancelled], "2026-08-01").EXCEPTIONS).toEqual([noShow, cancelled]);
  });

  it("explains an overdue in-house exception and links to order review without issuing a command", () => {
    const overdue = order("order-104-a", "CHECKED_IN", "2026-08-11", "2026-08-19");
    const businessDate = "2026-08-27";
    expect(buildTodayBuckets([overdue], businessDate).EXCEPTIONS).toEqual([overdue]);
    expect(todayExceptionPresentation(overdue, businessDate)).toEqual({
      title: "逾期在住，需确认实际状态",
      detail: "计划离店日 2026-08-19 已早于营业日 2026-08-27",
      actionLabel: "核对逾期在住"
    });

    const reasonHtml = renderToStaticMarkup(createElement(TodayExceptionReason, {
      order: overdue,
      businessDate
    }));
    const actionHtml = renderToStaticMarkup(createElement(MemoryRouter, {},
      createElement(TodayExceptionAction, { order: overdue, businessDate })
    ));
    expect(reasonHtml).toContain('class="queue-exception-reason"');
    expect(reasonHtml).toContain("计划离店日 2026-08-19 已早于营业日 2026-08-27");
    expect(reasonHtml).not.toContain("queue-exception-summary");
    expect(actionHtml).toContain('class="button button-secondary"');
    expect(actionHtml).toContain('href="/orders/order-104-a"');
    expect(actionHtml).toContain("核对逾期在住");
    expect(actionHtml).toContain('aria-label="核对逾期在住：order-104-a"');
    expect(actionHtml).not.toContain("CHECK_OUT");
  });

  it("uses the authoritative current business date instead of the editable browsing date", () => {
    const notYetOverdue = order("not-yet-overdue", "CHECKED_IN", "2026-08-25", "2026-08-29");
    expect(buildTodayBuckets([notYetOverdue], "2026-09-01", "2026-08-27").EXCEPTIONS).toEqual([]);

    const actuallyOverdue = order("actually-overdue", "CHECKED_IN", "2026-08-11", "2026-08-19");
    expect(buildTodayBuckets([actuallyOverdue], "2026-08-15", "2026-08-27").EXCEPTIONS).toEqual([actuallyOverdue]);
  });

  it("fails closed when an overdue checked-in order is not paired with an in-house Stay", () => {
    const inconsistent = {
      ...order("inconsistent-stay", "CHECKED_IN", "2026-08-11", "2026-08-19"),
      stay_status: "COMPLETED" as const
    };
    expect(buildTodayBuckets([inconsistent], "2026-08-27", "2026-08-27").EXCEPTIONS).toEqual([]);
    expect(todayExceptionPresentation(inconsistent, "2026-08-27")).toBeUndefined();
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
});

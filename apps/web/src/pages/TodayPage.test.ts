import { describe, expect, it } from "vitest";
import type { OrderRowDto } from "../types";
import { buildTodayBuckets } from "./TodayPage";

function order(id: string, status: string, arrivalDate: string, departureDate: string): OrderRowDto {
  return {
    id,
    property_id: "property_qintopia",
    status,
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
});

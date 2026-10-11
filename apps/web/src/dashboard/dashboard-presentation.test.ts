import { describe, expect, it } from "vitest";
import { dashboardAvailability, dashboardDetailLabel, dashboardRoomTypeLabel } from "./dashboard-presentation";

describe("经营概览展示", () => {
  it("房型编码和住宿组成明细使用与房态相同的中文名称", () => {
    expect(dashboardRoomTypeLabel("shared_bath_double")).toBe("两人间（公卫）");
    expect(dashboardRoomTypeLabel("shared_bath_quad")).toBe("四人间（公卫）");
    expect(dashboardRoomTypeLabel("private_bath_king")).toBe("大床房（独卫）");
    expect(dashboardRoomTypeLabel("未分配")).toBe("房型未分配");
    expect(dashboardDetailLabel({ metric: "PAID", label: "1 / shared_bath_double" })).toBe("1 / 两人间（公卫）");
    expect(dashboardDetailLabel({ metric: "FREE", label: "2 / shared_bath_quad" })).toBe("2 / 四人间（公卫）");
    expect(dashboardDetailLabel({ metric: "REVIEW", label: "住宿时间线待核对" })).toBe("住宿时间线待核对");
  });
  it("区分真实零库存、已知库存与未知库存，不把部分已知数量显示成总可售", () => {
    expect(dashboardAvailability({ availableRooms: 0, availableBeds: 0 })).toEqual({ unknown: false, total: "0", breakdown: "0间 / 0床" });
    expect(dashboardAvailability({ availableRooms: 2, availableBeds: 3 })).toEqual({ unknown: false, total: "5", breakdown: "2间 / 3床" });
    expect(dashboardAvailability({ availableRooms: null, availableBeds: null })).toEqual({ unknown: true, total: "待核对", breakdown: "整房待核对 / 床位待核对" });
    expect(dashboardAvailability({ availableRooms: 2, availableBeds: null })).toEqual({ unknown: true, total: "待核对", breakdown: "2间 / 床位待核对" });
  });
});

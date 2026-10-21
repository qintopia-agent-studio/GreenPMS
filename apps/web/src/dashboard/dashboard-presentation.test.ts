import { describe, expect, it } from "vitest";
import { dashboardAvailability, dashboardDetailEvidence, dashboardDetailLabel, dashboardDurationBands, dashboardRoomTypeLabel } from "./dashboard-presentation";

describe("经营概览展示", () => {
  it.each([[0, 0], [6, 0], [7, 1], [13, 1], [14, 2], [20, 2], [21, 3], [30, 3], [31, 4], [60, 4], [61, 5], [366, 5]])("实际 %i 晚只归入第 %i 档", (nights, index) => {
    const bands = dashboardDurationBands([{ nights, current: 2, all: 3 }]);
    expect(bands).toHaveLength(6);
    expect(bands[index]).toMatchObject({ current: 2, all: 3 });
    expect(bands.reduce((sum, row) => sum + row.current, 0)).toBe(2);
    expect(bands.reduce((sum, row) => sum + row.all, 0)).toBe(3);
  });
  it("合并同档数量且不混淆当前人数与期间全部住宿次数，不修改原始夜数", () => {
    const duration = [{ nights: 3, current: 1, all: 2 }, { nights: 4, current: 3, all: 4 }, { nights: 6, current: 5, all: 6 }, { nights: 40, current: 0, all: 1 }];
    const before = structuredClone(duration);
    const bands = dashboardDurationBands(duration);
    expect(bands[0]).toMatchObject({ label: "不足 1 周", range: "≤6 晚", current: 9, all: 12 });
    expect(bands[4]).toMatchObject({ label: "1–2 个月", range: "31–60 晚", current: 0, all: 1 });
    expect(duration).toEqual(before);
  });
  it("空资料保留统一的六档定义而不制造人数", () => {
    const bands = dashboardDurationBands([]);
    expect(bands.map(row => row.label)).toEqual(["不足 1 周", "1–2 周", "2–3 周", "3 周至 1 个月", "1–2 个月", "超过 2 个月"]);
    expect(bands.every(row => row.current === 0 && row.all === 0)).toBe(true);
  });
  it("房型编码和住宿组成明细使用与房态相同的中文名称", () => {
    expect(dashboardRoomTypeLabel("shared_bath_double")).toBe("两人间（公卫）");
    expect(dashboardRoomTypeLabel("shared_bath_quad")).toBe("四人间（公卫）");
    expect(dashboardRoomTypeLabel("private_bath_king")).toBe("大床房（独卫）");
    expect(dashboardRoomTypeLabel("未分配")).toBe("房型未分配");
    expect(dashboardRoomTypeLabel("custom_room", { custom_room: "山景双人间" })).toBe("山景双人间");
    expect(dashboardRoomTypeLabel("custom_room")).toBe("房型名称待核对");
    expect(dashboardDetailLabel({ metric: "PAID", label: "1 / shared_bath_double" })).toBe("1 / 两人间（公卫）");
    expect(dashboardDetailLabel({ metric: "FREE", label: "2 / shared_bath_quad" })).toBe("2 / 四人间（公卫）");
    expect(dashboardDetailLabel({ metric: "REVIEW", label: "住宿时间线待核对" })).toBe("住宿时间线待核对");
  });
  it("明细追踪字段使用统一的来源、认领、凭据和关联标签", () => {
    expect(dashboardDetailEvidence({ sourceType: "MEMBERSHIP", claimStatus: "CONFIRMED", sourceFactId: "member_fact_1", referencesFactId: "stay_fact_1", reversesFactId: null, correctsFactId: null, syncStatus: "WORKER_SYNCED", evidenceStatus: "COMPLETE" })).toEqual([
      "来源：会员事实", "认领：已认领", "同步：企微已同步", "凭据：凭据完整", "事实：member_fact_1", "引用：stay_fact_1"
    ]);
    expect(dashboardDetailEvidence({})).toEqual([]);
  });
  it("区分真实零库存、已知库存与未知库存，不把部分已知数量显示成总可售", () => {
    expect(dashboardAvailability({ availableRooms: 0, availableBeds: 0 })).toEqual({ unknown: false, total: "0", breakdown: "0间 / 0床" });
    expect(dashboardAvailability({ availableRooms: 2, availableBeds: 3 })).toEqual({ unknown: false, total: "5", breakdown: "2间 / 3床" });
    expect(dashboardAvailability({ availableRooms: null, availableBeds: null })).toEqual({ unknown: true, total: "待核对", breakdown: "整房待核对 / 床位待核对" });
    expect(dashboardAvailability({ availableRooms: 2, availableBeds: null })).toEqual({ unknown: true, total: "待核对", breakdown: "2间 / 床位待核对" });
  });
});

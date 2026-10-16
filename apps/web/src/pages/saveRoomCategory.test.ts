import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedRoom, RoomCatalogView } from "@qintopia/contracts";
import { api, ApiError } from "../api";
import type { CommandDialogProgress } from "../ui";
import type { CommandRequest } from "../types";
import { saveRoomCategory } from "./saveRoomCategory";

const data = { propertyId: "property", version: 3 } as RoomCatalogView;
const room = { assetId: "asset", code: "101", includedInOperatingStatistics: true } as ManagedRoom;
function response() {
  return { preview: { previewId: "preview", effectHash: "a".repeat(64), effect: {
    operation: "MANAGE_ROOM_CATALOG", propertyId: "property", action: "SET_OPERATING_STATISTICS",
    beforeVersion: 3, after: { version: 4 }, title: "分类", description: ["修改分类"],
    operatingStatisticsChange: { assetIds: ["asset"], included: false }
  } } } as unknown as Awaited<ReturnType<typeof api.preview>>;
}
function recovery() {
  return { track: vi.fn(async (_request: CommandRequest, progress: CommandDialogProgress) => {
    if (progress.state === "PREVIEWING") await progress.executePreview?.();
    return true;
  }), clearResolved: vi.fn(async () => true) };
}
beforeEach(() => { vi.spyOn(api, "preview").mockResolvedValue(response()); vi.spyOn(api, "confirm"); });
afterEach(() => vi.restoreAllMocks());

describe("单房分类直接保存的提交与恢复边界", () => {
  it("不确认服务端返回的另一个房间", async () => {
    const other = response(); other.preview.effect.operatingStatisticsChange = { assetIds: ["other"], included: false };
    vi.mocked(api.preview).mockResolvedValue(other);
    await expect(saveRoomCategory(data, room, false, recovery(), () => true)).rejects.toThrow("信息不一致");
    expect(api.confirm).not.toHaveBeenCalled();
  });
  it("页面已离开时不提交", async () => {
    await expect(saveRoomCategory(data, room, false, recovery(), () => false)).rejects.toThrow();
    expect(api.confirm).not.toHaveBeenCalled();
  });
  it("恢复记录无法保存时不发送写请求", async () => {
    const state = recovery(); state.track.mockImplementation(async (_request, progress) => {
      if (progress.state === "PREVIEWING") await progress.executePreview?.();
      return progress.state !== "CONFIRMING";
    });
    await expect(saveRoomCategory(data, room, false, state, () => true)).rejects.toThrow("暂时无法保存");
    expect(api.confirm).not.toHaveBeenCalled();
  });
  it("核对读取失败不发送写请求", async () => {
    vi.mocked(api.preview).mockRejectedValue(new Error("network"));
    await expect(saveRoomCategory(data, room, false, recovery(), () => true)).rejects.toThrow();
    expect(api.confirm).not.toHaveBeenCalled();
  });
  it("确认响应丢失后保留同一个幂等键，不重发或清理恢复记录", async () => {
    const state = recovery(); vi.mocked(api.confirm).mockRejectedValue(new Error("network"));
    await expect(saveRoomCategory(data, room, false, state, () => true)).rejects.toThrow();
    expect(api.confirm).toHaveBeenCalledTimes(1);
    const key = vi.mocked(api.confirm).mock.calls[0]![5];
    expect(state.track).toHaveBeenLastCalledWith(expect.anything(), { state: "UNKNOWN", confirmationKey: key });
    expect(state.clearResolved).not.toHaveBeenCalled();
  });
  it("权限拒绝按明确未执行处理", async () => {
    const state = recovery(); vi.mocked(api.confirm).mockRejectedValue(new ApiError(403, { code: "FORBIDDEN", message: "权限不足" }));
    await expect(saveRoomCategory(data, room, false, state, () => true)).rejects.toThrow("权限不足");
    expect(state.track).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ state: "FAILED_NOT_EXECUTED" }));
  });
  it("无法核验的回执不冒充保存成功", async () => {
    const state = recovery(); vi.mocked(api.confirm).mockResolvedValue({ executionStatus: "UNKNOWN", businessCommitted: false } as Awaited<ReturnType<typeof api.confirm>>);
    await expect(saveRoomCategory(data, room, false, state, () => true)).rejects.toThrow("保存结果尚未确认");
    expect(state.track).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ state: "UNKNOWN" }));
    expect(state.clearResolved).not.toHaveBeenCalled();
  });
});

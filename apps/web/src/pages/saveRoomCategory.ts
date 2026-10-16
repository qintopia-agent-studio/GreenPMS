import type { ManagedRoom, RoomCatalogView } from "@qintopia/contracts";
import { api, ApiError } from "../api";
import type { CommandRequest } from "../types";
import { receiptHasCommandEvidence, u1PreviewHasBusinessEvidence, type usePersistentCommandRecovery } from "../ui";

type Recovery = Pick<ReturnType<typeof usePersistentCommandRecovery>, "track" | "clearResolved">;

/** A dropdown choice authorizes one change; keep the existing write/recovery protocol. */
export async function saveRoomCategory(data: RoomCatalogView, room: ManagedRoom, included: boolean,
  recovery: Recovery, isActive: () => boolean) {
  const input = { propertyId: data.propertyId, expectedVersion: data.version,
    action: "SET_OPERATING_STATISTICS" as const, assetIds: [room.assetId], included };
  const reason = { code: "ROOM_CATALOG_CHANGE", note: `${room.code}：${room.includedInOperatingStatistics ? "经营单元" : "非经营单元"}改为${included ? "经营单元" : "非经营单元"}` };
  const request: CommandRequest = { commandType: "MANAGE_ROOM_CATALOG", input, title: "修改房间分类", description: "查询本次分类修改结果。", initialReason: reason };
  const metadata = api.commandMetadata("room-category");
  let response: Awaited<ReturnType<typeof api.preview>> | undefined;
  const accepted = await recovery.track(request, { state: "PREVIEWING", previewMetadata: metadata,
    executePreview: async () => { response = await api.preview({ commandType: "MANAGE_ROOM_CATALOG", input }, metadata); } });
  if (!accepted || !response || !isActive()) throw new Error("本次分类修改尚未提交，请刷新后重试。");
  const preview = response.preview;
  const change = preview.effect.operatingStatisticsChange as { assetIds?: string[]; included?: boolean } | undefined;
  if (!u1PreviewHasBusinessEvidence("MANAGE_ROOM_CATALOG", preview.effect, input)
    || change?.included !== included || change.assetIds?.length !== 1 || change.assetIds[0] !== room.assetId) {
    throw new Error("房间分类信息不一致，本次没有保存，请刷新后重试。");
  }
  const key = api.recoveryKey("MANAGE_ROOM_CATALOG");
  if (!await recovery.track(request, { state: "CONFIRMING", previewId: preview.previewId,
    confirmationKey: key, effectHash: preview.effectHash, isAttemptActive: isActive })) {
    throw new Error("暂时无法保存，请先处理页面提示的未完成操作。");
  }
  if (!isActive()) {
    await recovery.track(request, { state: "FAILED_NOT_EXECUTED", confirmationKey: key });
    throw new Error("已离开当前页面，本次分类修改没有提交。");
  }
  let receipt;
  try {
    receipt = await api.confirm(preview.previewId, data.propertyId, "MANAGE_ROOM_CATALOG", preview.effectHash, reason, key);
  } catch (error) {
    const unknown = !(error instanceof ApiError) || error.status >= 500 || error.code === "COMMAND_STATUS_UNKNOWN";
    await recovery.track(request, { state: unknown ? "UNKNOWN" : "FAILED_NOT_EXECUTED", confirmationKey: key });
    throw error;
  }
  if (receipt.executionStatus === "UNKNOWN"
    || !receiptHasCommandEvidence("MANAGE_ROOM_CATALOG", receipt, input, preview.effect, preview.effectHash)) {
    await recovery.track(request, { state: "UNKNOWN", confirmationKey: key });
    throw new Error("保存结果尚未确认，请查询原操作结果，不要重复修改。");
  }
  if (!await recovery.track(request, { state: "RESOLVED", confirmationKey: key, receipt })) {
    throw new Error("保存结果尚未完成核对，请处理页面上的原操作记录。");
  }
  await recovery.clearResolved();
  if (!receipt.businessCommitted) throw new Error(receipt.error?.message ?? "分类未保存，请刷新后重试。");
  return receipt;
}

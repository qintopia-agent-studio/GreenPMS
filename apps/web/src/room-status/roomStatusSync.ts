import type { RoomStatusBoardDto, RoomStatusSyncDto } from "@qintopia/contracts";
import { ApiError } from "../api";
import { isIsoLocalDate } from "./roomStatusState";
import { assertRoomStatusBoard } from "./roomStatusValidation";

export const ROOM_STATUS_SYNC_INTERVAL_MS = 15_000;

export class RoomStatusProjectionError extends Error {
  constructor(cause: unknown) {
    super("房态数据未通过一致性检查。请重试或联系管理员；可以返回今天或其他日期。", { cause });
    this.name = "RoomStatusProjectionError";
  }
}
export class RoomStatusQueryTimeoutError extends Error {
  constructor() {
    super("房态查询超时，请检查网络后重试。已填写的内容仍然保留。");
    this.name = "RoomStatusQueryTimeoutError";
  }
}

/** Retry temporary transport failures, never a deterministically invalid projection. */
export function roomStatusReadRetryable(error: unknown): boolean {
  return error instanceof RoomStatusQueryTimeoutError
    || error instanceof TypeError
    || error instanceof ApiError && (error.status === 408 || error.status === 429 || error.status >= 500);
}

export function validateRoomStatusResponse(
  value: unknown,
  expected: Parameters<typeof assertRoomStatusBoard>[1]
): asserts value is RoomStatusBoardDto {
  try { assertRoomStatusBoard(value, expected); }
  catch (error) { throw new RoomStatusProjectionError(error); }
}

export function validateRoomStatusSync(value: unknown, propertyId: string): asserts value is RoomStatusSyncDto {
  const record = value as Partial<RoomStatusSyncDto> | null;
  if (!record || record.propertyId !== propertyId
    || typeof record.revision !== "string" || !/^\d+$/.test(record.revision)
    || typeof record.businessDate !== "string" || !isIsoLocalDate(record.businessDate)
    || typeof record.asOf !== "string" || !Number.isFinite(Date.parse(record.asOf))
    || record.accessLevel !== "READ" && record.accessLevel !== "WRITE"
    || typeof record.authorizationKey !== "string" || !/^[a-f0-9]{64}$/.test(record.authorizationKey)) {
    throw new RoomStatusProjectionError(new Error("Invalid room-status synchronization response"));
  }
}

export function roomStatusSyncNeedsBoard(sync: RoomStatusSyncDto, board: RoomStatusBoardDto | undefined): boolean {
  return !board || sync.propertyId !== board.propertyId || sync.revision !== board.revision
    || sync.businessDate !== board.businessDate || sync.accessLevel !== board.accessLevel
    || sync.authorizationKey !== board.authorizationKey;
}

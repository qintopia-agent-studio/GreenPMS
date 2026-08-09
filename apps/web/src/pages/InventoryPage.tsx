import { useEffect, useId, useMemo, useReducer, useRef, useState, type FormEvent } from "react";
import { FilePlus2, PanelRightOpen, RefreshCw, Trash2, UserPlus, X } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import type {
  CreateOrderAdditionalGuestInputDto,
  CreateOrderPrimaryGuestInputDto,
  RoomStatusActionDto,
  RoomStatusBoardDto,
  RoomStatusBoardQueryDto,
  RoomStatusConflictDto,
  RoomStatusDayDto,
  RoomStatusIntervalDto,
  RoomStatusUnitDto
} from "@qintopia/contracts";
import { currentReleaseFeatures } from "@qintopia/contracts";
import { api, ApiError, type ClientCommandMetadata } from "../api";
import { addLocalDateDays, localDateInTimeZone } from "../dates";
import { useWorkspace } from "../session";
import type {
  BookingChannelCode,
  CommandRequest,
  MemberContractDto,
  MemberDto,
  MemberViewDto,
  OrderViewDto,
  PricingPolicyVersionDto,
  QuoteDto,
  ReceiptDto,
  StayType
} from "../types";
import { correctionDraftMatchesOccupant, OrderOccupantCorrectionDialog } from "../components/OrderOccupantCorrectionDialog";
import { MoveUnitDrawer } from "../components/MoveUnitDrawer";
import {
  OrderLifecycleActionDrawer,
  type OrderLifecycleAction
} from "../components/OrderLifecycleActionDrawer";
import { StayDateChangeDrawer, type StayDateChangeAction, type StayDateChangeMode } from "../components/StayDateChangeDrawer";
import {
  browserCommandRecoveryStorage,
  CommandDialog,
  type CommandDialogCloseContext,
  CommandResultNotice,
  type CommandDialogProgress,
  type CommandRecoveryStorage,
  CommandRecoveryBar,
  DamagedCommandRecoveryNotice,
  EmptyState,
  formatDateTime,
  formatMoney,
  InlineError,
  isTerminalCommandRecovery,
  LoadingBlock,
  Modal,
  propertyRecoveryCoordinationScope,
  quoteRecoveryStorageKey,
  readPersistedCommandRecovery,
  RECOVERY_STORAGE_SYNC_EVENT,
  recoveryCommandRequest,
  recoveryStorageEventMatchesScope,
  recoveryStorageSyncEventMatchesScope,
  usePersistentCommandRecovery,
  withRecoveryStorageLock
} from "../ui";
import {
  assertRoomStatusBoard,
  createRoomStatusOrderReturnState,
  createRoomStatusViewState,
  DEFAULT_ROOM_STATUS_FILTERS,
  dateWindowStartForFocus,
  filterRoomStatusRooms,
  hasActiveRoomStatusFilters,
  hasRoomStatusOrderReturnEnvelope,
  isIsoLocalDate,
  parseRoomStatusRestoration,
  parseRoomStatusOrderReturnTarget,
  reconcileRoomStatusRestoration,
  resolveRoomStatusOrderReturnTarget,
  roomStatusFactFingerprint,
  roomStatusOrderIdentityForDate,
  roomStatusOrderIdentityForInterval,
  roomStatusOrderOptionsForDate,
  roomStatusUniqueOrderStayId,
  roomStatusUnitLabel,
  RoomStatusContext,
  RoomStatusGrid,
  RoomStatusMobileTasks,
  RoomStatusOrderContext,
  RoomStatusQuickPopover,
  RoomStatusToolbar,
  ROOM_STATUS_TIMELINE_DAYS,
  roomStatusViewReducer,
  selectionFromCells,
  serializeRoomStatusRestoration,
  useRoomStatusMobileViewport,
  type RoomStatusMobileGroups,
  type RoomStatusMobileFocusRequest,
  type RoomStatusMobileTab,
  type RoomStatusOrderIdentity,
  type RoomStatusRange,
  type RoomStatusRestorationSnapshot,
  type RoomStatusSelection,
  type RoomStatusViewState
} from "../room-status";

const bookingChannelLabels: Record<BookingChannelCode, string> = {
  YOUMUDAO: "游牧岛",
  CTRIP: "携程",
  MEITUAN: "美团",
  WECOM: "企业微信"
};

const MAX_STAY_SELECTION_NIGHTS = 366;

export function roomStatusOrderContextMode(workspaceWidth: number, isMobile: boolean): "INLINE" | "DRAWER" {
  void workspaceWidth;
  void isMobile;
  return "DRAWER";
}

export function inventoryRecoveryIsBusinessFacing(presentation: CommandRequest["presentation"]): boolean {
  return presentation === "MEMBER_STAY" || presentation === "FULFILLMENT" || presentation === "STAY_DATES" || presentation === "MOVE_UNIT";
}

export function roomStatusGridSelectedStayId(
  quickPopoverOpen: boolean,
  quickPopoverStayId: string | null,
  selectedOrder?: Pick<RoomStatusOrderIdentity, "stayId">,
  stableSelectedStayId?: string
): string | null {
  return quickPopoverOpen
    ? quickPopoverStayId ?? stableSelectedStayId ?? null
    : selectedOrder?.stayId ?? stableSelectedStayId ?? null;
}

export function roomStatusAnchorMatches(
  anchor: Pick<HTMLElement, "dataset">,
  unitId: string,
  serviceDate: string
): boolean {
  return anchor.dataset.unitId === unitId && anchor.dataset.serviceDate === serviceDate;
}

export function roomStatusQuickTargetMatches(
  target: { unitId: string; serviceDate: string } | undefined,
  unitId: string,
  serviceDate: string
): boolean {
  return target?.unitId === unitId && target.serviceDate === serviceDate;
}

const roomStatusFilterKeys = [
  "search",
  "roomTypeCode",
  "salesMode",
  "status",
  "kind",
  "minimumCapacity"
] as const satisfies readonly (keyof RoomStatusViewState["filters"])[];

export function roomStatusFiltersRevealingTarget(
  filters: RoomStatusViewState["filters"],
  targetVisible: (candidate: RoomStatusViewState["filters"]) => boolean
): RoomStatusViewState["filters"] {
  if (targetVisible(filters)) return filters;
  const activeKeys = roomStatusFilterKeys.filter((key) => filters[key] !== DEFAULT_ROOM_STATUS_FILTERS[key]);
  for (let clearedCount = 1; clearedCount <= activeKeys.length; clearedCount += 1) {
    for (let mask = 1; mask < 2 ** activeKeys.length; mask += 1) {
      if (mask.toString(2).replaceAll("0", "").length !== clearedCount) continue;
      const candidate = { ...filters };
      activeKeys.forEach((key, index) => {
        if (mask & (1 << index)) {
          (candidate as Record<keyof RoomStatusViewState["filters"], unknown>)[key] = DEFAULT_ROOM_STATUS_FILTERS[key];
        }
      });
      if (targetVisible(candidate)) return candidate;
    }
  }
  return { ...DEFAULT_ROOM_STATUS_FILTERS };
}

export function bookingChannelRequiredForStay(useMemberEntitlement: boolean, stayType?: string): boolean {
  return !useMemberEntitlement && stayType !== "FREE";
}

export function parseYuanAmountToMinor(value: string): number | undefined {
  const normalized = value.trim();
  const match = /^(\d+)(?:\.00)?$/.exec(normalized);
  if (!match) return undefined;
  const minor = BigInt(match[1]!) * 100n;
  return minor <= 2_147_483_600n ? Number(minor) : undefined;
}

export function formatMinorForYuanInput(minorUnits: number): string {
  return String(minorUnits / 100);
}

export function createOrderPricingDraft(input: {
  bookingChannelCode: BookingChannelCode | "";
  channelOrderReference: string;
  targetAmountYuan: string;
  policyBaseAmountMinor: number;
  channelPriceDifferenceReason: string;
  manualPriceAdjustmentReason: string;
}) {
  const targetCurrentContractAmountMinor = parseYuanAmountToMinor(input.targetAmountYuan);
  const externalChannel = input.bookingChannelCode !== "" && input.bookingChannelCode !== "WECOM";
  const differenceFromPolicyMinor = targetCurrentContractAmountMinor === undefined
    ? undefined
    : targetCurrentContractAmountMinor - input.policyBaseAmountMinor;
  const channelReasonRequired = externalChannel
    && differenceFromPolicyMinor !== undefined
    && (() => {
      const difference = BigInt(differenceFromPolicyMinor);
      const absoluteDifference = difference < 0n ? -difference : difference;
      return absoluteDifference * 100n > BigInt(input.policyBaseAmountMinor) * 15n;
    })();
  const manualReasonRequired = input.bookingChannelCode === "WECOM"
    && differenceFromPolicyMinor !== undefined
    && differenceFromPolicyMinor !== 0;
  return {
    targetCurrentContractAmountMinor,
    differenceFromPolicyMinor,
    channelReasonRequired,
    manualReasonRequired,
    complete: Boolean(input.bookingChannelCode)
      && targetCurrentContractAmountMinor !== undefined
      && (!externalChannel || Boolean(input.channelOrderReference.trim()))
      && (!channelReasonRequired || Boolean(input.channelPriceDifferenceReason.trim()))
      && (!manualReasonRequired || Boolean(input.manualPriceAdjustmentReason.trim()))
  };
}

export const freeStayCategoryLabels: Record<string, string> = {
  VOLUNTEER: "义工",
  RECEPTION: "接待"
};

interface QuoteCommandInput {
  propertyId: string;
  inventoryUnitId: string;
  stayType?: StayType;
  arrivalDate: string;
  departureDate: string;
  pricingPolicyVersionId: string;
  memberId?: string;
}

export function eligibleMemberProfiles(
  members: MemberDto[],
  contracts: Pick<MemberContractDto, "property_id" | "member_id">[],
  propertyId: string,
  query: string
): MemberDto[] {
  const propertyMemberIds = new Set(contracts
    .filter((contract) => contract.property_id === propertyId && contract.member_id)
    .map((contract) => contract.member_id));
  const normalizedQuery = query.trim().toUpperCase();
  return members.filter((member) => propertyMemberIds.has(member.id) && (
    !normalizedQuery
    || member.full_name.toUpperCase().includes(normalizedQuery)
    || member.identity_card_number.toUpperCase().includes(normalizedQuery)
    || member.phone.toUpperCase().includes(normalizedQuery)
    || member.wechat.toUpperCase().includes(normalizedQuery)
  ));
}

export function effectiveQuoteMemberId(members: MemberDto[], requestedMemberId: string): string {
  return members.some((member) => member.id === requestedMemberId) ? requestedMemberId : "";
}

export interface PendingQuoteCommand {
  version: 1;
  subjectId: string;
  propertyId: string;
  ownerTabId?: string;
  input: QuoteCommandInput;
  inputSignature: string;
  metadata: ClientCommandMetadata;
  state: "SENDING" | "UNKNOWN";
}

export type QuoteRecoveryReadResult =
  | { kind: "ABSENT" }
  | { kind: "VALID"; pending: PendingQuoteCommand }
  | { kind: "CORRUPT"; error: Error }
  | { kind: "READ_ERROR"; error: Error };

export function roomStatusDesktopContextKind(
  quoteRecoveryContextOpen: boolean,
  hasSelectedOrder: boolean
): "QUOTE_RECOVERY" | "ORDER" | "SELECTION" {
  if (quoteRecoveryContextOpen) return "QUOTE_RECOVERY";
  return hasSelectedOrder ? "ORDER" : "SELECTION";
}

export function quoteRecoveryContextIdentity(
  recoveryScope: string,
  recovery: QuoteRecoveryReadResult
): string | undefined {
  if (recovery.kind === "ABSENT") return undefined;
  if (recovery.kind === "VALID") {
    return `${recoveryScope}:${recovery.pending.metadata.idempotencyKey}`;
  }
  return `${recoveryScope}:${recovery.kind}`;
}

export function shouldAutoOpenQuoteRecoveryContext({
  recoveryIdentity,
  dismissedIdentity,
  recoveryOwnerId,
  currentOwnerId,
  isMobile,
  hasSelectedOrder
}: {
  recoveryIdentity: string | undefined;
  dismissedIdentity: string | undefined;
  recoveryOwnerId?: string | undefined;
  currentOwnerId?: string | undefined;
  isMobile: boolean;
  hasSelectedOrder: boolean;
}): boolean {
  return Boolean(recoveryIdentity
    && recoveryIdentity !== dismissedIdentity
    && (!recoveryOwnerId || recoveryOwnerId !== currentOwnerId)
    && !isMobile
    && !hasSelectedOrder);
}

export function shouldRenderDetachedQuoteRecoveryWorkbench(
  hasRenderedBoard: boolean,
  recoveryContextOpen: boolean,
  recovery: QuoteRecoveryReadResult
): boolean {
  return !hasRenderedBoard && recoveryContextOpen && recovery.kind !== "ABSENT";
}

export function QuoteRecoveryPageEntry({ recovery, onOpen }: {
  recovery: QuoteRecoveryReadResult;
  onOpen: () => void;
}) {
  if (recovery.kind === "ABSENT") return null;
  const valid = recovery.kind === "VALID";
  return (
    <section className="recovery-bar" role="status" aria-live="polite" data-testid="inventory-quote-recovery-entry">
      <div>
        <strong>{valid && recovery.pending.state === "UNKNOWN" ? "报价结果需要核对" : "有一笔报价需要处理"}</strong>
        <p>{valid
          ? "新的报价和订单操作已暂停，请先处理原报价。"
          : "报价恢复记录需要核对，处理完成前不会开始新的写入。"}</p>
      </div>
      <button className="button button-secondary" type="button" onClick={onOpen}>打开处理入口</button>
    </section>
  );
}

let browserQuoteRecoveryDocumentOwnerId: string | undefined;

export function browserQuoteRecoveryOwnerId(): string {
  // sessionStorage may be cloned when a browser tab is duplicated. A document
  // identity must never survive that operation or both tabs can claim ownership.
  // Keep the owner stable only for the current document so same-tab navigation
  // and component remounts can still recover their own in-flight Quote safely.
  browserQuoteRecoveryDocumentOwnerId ??= crypto.randomUUID();
  return browserQuoteRecoveryDocumentOwnerId;
}

export interface QuoteRequestLease {
  scope: string;
  generation: number;
}

export class QuoteRequestGuard {
  private mounted = false;
  private scope: string;
  private generation = 0;

  constructor(initialScope: string) {
    this.scope = initialScope;
  }

  mount() {
    this.mounted = true;
  }

  unmount() {
    this.mounted = false;
    this.generation += 1;
  }

  enterScope(scope: string) {
    if (scope === this.scope) return;
    this.scope = scope;
    this.generation += 1;
  }

  begin(scope: string): QuoteRequestLease {
    this.enterScope(scope);
    this.generation += 1;
    return { scope, generation: this.generation };
  }

  isActive(lease: QuoteRequestLease): boolean {
    return this.mounted && lease.scope === this.scope && lease.generation === this.generation;
  }
}

export class RoomStatusCommandAttemptGuard {
  private generation = 0;
  private activeAttemptId: number | null = null;

  begin(): number {
    const attemptId = ++this.generation;
    this.activeAttemptId = attemptId;
    return attemptId;
  }

  invalidate(): void {
    this.activeAttemptId = null;
  }

  runIfActive(attemptId: number, action: () => void): boolean {
    if (this.activeAttemptId !== attemptId) return false;
    action();
    return true;
  }
}

export interface SelectedMemberViewRequestLease {
  scope: string;
  generation: number;
}

export class SelectedMemberViewRequestGuard {
  private generation = 0;
  private activeScope: string | undefined;

  begin(scope: string): SelectedMemberViewRequestLease {
    this.generation += 1;
    this.activeScope = scope;
    return { scope, generation: this.generation };
  }

  invalidate(): void {
    this.generation += 1;
    this.activeScope = undefined;
  }

  runIfActive(lease: SelectedMemberViewRequestLease, action: () => void): boolean {
    if (this.activeScope !== lease.scope || this.generation !== lease.generation) return false;
    action();
    return true;
  }
}

export class RoomStatusQueryAttemptGuard {
  private generation = 0;
  private activeAttemptId: number | null = null;

  begin(): number {
    const attemptId = ++this.generation;
    this.activeAttemptId = attemptId;
    return attemptId;
  }

  isInFlight(): boolean {
    return this.activeAttemptId !== null;
  }

  isActive(attemptId: number): boolean {
    return this.activeAttemptId === attemptId;
  }

  finish(attemptId: number): boolean {
    if (!this.isActive(attemptId)) return false;
    this.activeAttemptId = null;
    return true;
  }

  invalidate(attemptId: number): boolean {
    return this.finish(attemptId);
  }
}

function validQuoteInput(value: unknown): value is QuoteCommandInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "propertyId",
    "inventoryUnitId",
    "stayType",
    "arrivalDate",
    "departureDate",
    "pricingPolicyVersionId",
    "memberId"
  ]);
  return Object.keys(input).every((key) => allowedKeys.has(key))
    && typeof input.propertyId === "string" && input.propertyId === input.propertyId.trim() && Boolean(input.propertyId)
    && typeof input.inventoryUnitId === "string" && input.inventoryUnitId === input.inventoryUnitId.trim() && Boolean(input.inventoryUnitId)
    && (input.stayType === undefined || input.stayType === "FREE" || input.stayType === "TRANSIENT" || input.stayType === "CUSTOM")
    && typeof input.arrivalDate === "string" && isIsoLocalDate(input.arrivalDate)
    && typeof input.departureDate === "string" && isIsoLocalDate(input.departureDate)
    && input.arrivalDate < input.departureDate
    && rangeNights({ arrivalDate: input.arrivalDate, departureDate: input.departureDate }) <= MAX_STAY_SELECTION_NIGHTS
    && typeof input.pricingPolicyVersionId === "string"
    && input.pricingPolicyVersionId === input.pricingPolicyVersionId.trim()
    && Boolean(input.pricingPolicyVersionId)
    && !Object.hasOwn(input, "memberContractId")
    && (input.memberId === undefined
      || (typeof input.memberId === "string" && input.memberId === input.memberId.trim() && Boolean(input.memberId)));
}

export function readQuoteCommandRecovery(storage: CommandRecoveryStorage, subjectId: string, propertyId: string): QuoteRecoveryReadResult {
  let serialized: string | null;
  try {
    serialized = storage.getItem(quoteRecoveryStorageKey(subjectId, propertyId));
  } catch {
    return { kind: "READ_ERROR", error: new Error("无法读取本地报价恢复记录；已暂停新报价和订单写入") };
  }
  if (serialized === null) return { kind: "ABSENT" };
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return { kind: "CORRUPT", error: new Error("本地报价恢复记录已损坏；无法确认原报价命令是否执行") };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "CORRUPT", error: new Error("本地报价恢复记录结构无效") };
  }
  const record = value as Record<string, unknown>;
  const metadata = record.metadata;
  const metadataRecord = metadata as Record<string, unknown> | undefined;
  if (record.version !== 1
    || record.subjectId !== subjectId
    || record.propertyId !== propertyId
    || (record.ownerTabId !== undefined && (typeof record.ownerTabId !== "string" || !record.ownerTabId))
    || !validQuoteInput(record.input)
    || record.input.propertyId !== propertyId
    || typeof record.inputSignature !== "string"
    || record.inputSignature !== quoteInputSignature(record.input)
    || !metadataRecord
    || typeof metadataRecord !== "object"
    || Array.isArray(metadata)
    || typeof metadataRecord.idempotencyKey !== "string"
    || !metadataRecord.idempotencyKey
    || metadataRecord.idempotencyKey !== metadataRecord.idempotencyKey.trim()
    || metadataRecord.idempotencyKey.length > 160
    || typeof metadataRecord.correlationId !== "string"
    || !metadataRecord.correlationId
    || metadataRecord.correlationId !== metadataRecord.correlationId.trim()
    || metadataRecord.correlationId.length > 160
    || (record.state !== "SENDING" && record.state !== "UNKNOWN")) {
    return { kind: "CORRUPT", error: new Error("本地报价恢复记录版本或字段无效；已暂停新报价和订单写入") };
  }
  return { kind: "VALID", pending: record as unknown as PendingQuoteCommand };
}

export function saveQuoteCommandRecovery(storage: CommandRecoveryStorage, pending: PendingQuoteCommand): boolean {
  try {
    storage.setItem(quoteRecoveryStorageKey(pending.subjectId, pending.propertyId), JSON.stringify(pending));
    return true;
  } catch {
    return false;
  }
}

function clearQuoteCommandRecovery(storage: CommandRecoveryStorage, subjectId: string, propertyId: string): boolean {
  try {
    storage.removeItem(quoteRecoveryStorageKey(subjectId, propertyId));
    return true;
  } catch {
    return false;
  }
}

export function clearCorruptQuoteCommandRecovery(
  storage: CommandRecoveryStorage,
  subjectId: string,
  propertyId: string
): boolean {
  const current = readQuoteCommandRecovery(storage, subjectId, propertyId);
  return current.kind === "CORRUPT"
    && clearQuoteCommandRecovery(storage, subjectId, propertyId);
}

function browserQuoteRecovery(subjectId: string, propertyId: string): { storage?: CommandRecoveryStorage; read: QuoteRecoveryReadResult } {
  const access = browserCommandRecoveryStorage();
  if (access.kind !== "AVAILABLE") {
    return { read: { kind: "READ_ERROR", error: new Error("无法访问浏览器恢复存储；已暂停新报价和订单写入") } };
  }
  return { storage: access.storage, read: readQuoteCommandRecovery(access.storage, subjectId, propertyId) };
}

function quoteInputSignature(input: QuoteCommandInput): string {
  return JSON.stringify(input);
}

export function paidStayTypeForDates(arrivalDate: string, departureDate: string): "TRANSIENT" | "CUSTOM" {
  const nights = rangeNights({ arrivalDate, departureDate });
  return nights < 7 ? "TRANSIENT" : "CUSTOM";
}

export function quotePricingSummary(quote: QuoteDto): {
  nights: number;
  pricingBasis: string;
  amount: QuoteDto["currentContractAmount"];
} {
  const nights = rangeNights(quote);
  const stayTotal = quote.cashLines.find((line) => line.lineKind === "STAY_TOTAL");
  const anchor = stayTotal?.lineKind === "STAY_TOTAL" ? stayTotal.pricingBandAnchorNights : 1;
  return {
    nights,
    pricingBasis: quote.stayType === "FREE" ? "免费入住" : anchor === 1 ? "按临住价格" : `按 ${anchor} 夜价格档`,
    amount: quote.currentContractAmount
  };
}

export function membershipCoverageSummary(quote: QuoteDto) {
  const totalNights = rangeNights(quote);
  const coveredNights = quote.coverageSet.length;
  return {
    totalNights,
    coveredNights,
    uncoveredNights: totalNights - coveredNights,
    uncoveredAmount: quote.cashRemainder
  };
}

export function staffQuoteError(error: ApiError, unitCode: string, arrivalDate: string, departureDate: string): Error {
  if (error.code === "PRICING_POLICY_UNCONFIGURED" || error.code === "POLICY_VERSION_NOT_FOUND") {
    return new Error(`${unitCode} 在 ${arrivalDate} 至 ${departureDate} 暂无已生效价格，请调整日期。`);
  }
  if (error.code === "INVENTORY_CONFLICT") return new Error(error.message);
  if (error.code === "VALIDATION_ERROR") return new Error(`入住和退房日期无效，请确认退房日期晚于入住日期。`);
  return new Error(error.message);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function validQuoteMoney(value: unknown): boolean {
  const money = recordValue(value);
  return Boolean(money
    && typeof money.currency === "string"
    && /^[A-Z]{3}$/.test(money.currency)
    && Number.isSafeInteger(money.minorUnits));
}

function quoteFromReceipt(receipt: ReceiptDto, pending: PendingQuoteCommand): QuoteDto {
  if (receipt.executionStatus !== "EXECUTED"
    || receipt.businessCommitted !== true
    || !receipt.receiptId
    || !receipt.commandId
    || !receipt.correlationId
    || receipt.error !== undefined
    || !receipt.committedAt
    || Number.isNaN(Date.parse(receipt.committedAt))) {
    throw new Error("原报价结果缺少可核对的执行凭证；已继续暂停新报价。");
  }
  const quote = receipt.result?.quote;
  if (!quote || typeof quote !== "object" || Array.isArray(quote)) {
    throw new Error("原报价结果缺少报价明细；已继续暂停新报价。");
  }
  const record = quote as Record<string, unknown>;
  const expectedStayType = pending.input.stayType ?? paidStayTypeForDates(
    pending.input.arrivalDate,
    pending.input.departureDate
  );
  const memberMatches = pending.input.memberId === undefined
    ? record.memberId === undefined
    : record.memberId === pending.input.memberId;
  if (typeof record.quoteId !== "string" || !record.quoteId
    || record.propertyId !== pending.input.propertyId
    || record.inventoryUnitId !== pending.input.inventoryUnitId
    || record.arrivalDate !== pending.input.arrivalDate
    || record.departureDate !== pending.input.departureDate
    || record.pricingPolicyVersionId !== pending.input.pricingPolicyVersionId
    || record.stayType !== expectedStayType
    || !memberMatches
    || !Array.isArray(record.coverageSet)
    || !Array.isArray(record.cashLines)
    || !validQuoteMoney(record.cashRemainder)
    || !validQuoteMoney(record.currentContractAmount)
    || typeof record.expiresAt !== "string"
    || Number.isNaN(Date.parse(record.expiresAt))
    || typeof record.inputHash !== "string"
    || !/^[a-f0-9]{64}$/.test(record.inputHash)
    || !Array.isArray(receipt.resourceRefs)
    || !receipt.resourceRefs.includes(record.quoteId)
    || !Array.isArray(receipt.factRefs)) {
    throw new Error("原报价结果与当时选择的房源、日期或价格政策不一致；已继续暂停新报价。");
  }
  return record as unknown as QuoteDto;
}

function quoteNotExecutedReceiptIsCoherent(receipt: ReceiptDto): boolean {
  return receipt.executionStatus === "NOT_EXECUTED"
    && receipt.businessCommitted === false
    && Boolean(receipt.receiptId && receipt.commandId && receipt.correlationId)
    && receipt.result === undefined
    && receipt.error?.code === "COMMAND_INTERRUPTED"
    && receipt.error.retryable === false
    && Array.isArray(receipt.resourceRefs)
    && receipt.resourceRefs.length === 0
    && Array.isArray(receipt.factRefs)
    && receipt.factRefs.length === 0
    && typeof receipt.committedAt === "string"
    && !Number.isNaN(Date.parse(receipt.committedAt));
}

interface InventoryActionUnit {
  id: string;
  kind: "ROOM" | "BED";
  code: string;
  name: string;
  buildingCode: string | null;
  occupancyCapacity: number;
  available: boolean;
}

function unitName(unit: InventoryActionUnit | undefined) {
  return unit ? roomStatusUnitLabel(unit) : "未选择库存单元";
}

export interface GuestFormValue {
  fullName: string;
  nickname: string;
  phone: string;
  documentNumber: string;
}

export const GUEST_FULL_NAME_MAX_LENGTH = 200;

interface AdditionalGuestDraft extends GuestFormValue {
  key: number;
}

export function guestFormComplete(guest: GuestFormValue): boolean {
  return Boolean(guest.fullName.trim() && guest.nickname.trim());
}

export function guestFormInput(guest: GuestFormValue): CreateOrderAdditionalGuestInputDto {
  const input: CreateOrderAdditionalGuestInputDto = {
    fullName: guest.fullName.trim(),
    nickname: guest.nickname.trim()
  };
  if (guest.phone.trim()) input.phone = guest.phone.trim();
  if (guest.documentNumber.trim()) input.documentNumber = guest.documentNumber.trim();
  return input;
}

export function applyMemberSelectionToGuestForms<T extends GuestFormValue>(
  additionalGuests: T[],
  member: Pick<MemberDto, "full_name" | "phone" | "identity_card_number">
): { primaryGuest: GuestFormValue; additionalGuests: T[] } {
  return {
    primaryGuest: {
      fullName: member.full_name,
      nickname: member.full_name,
      phone: member.phone,
      documentNumber: member.identity_card_number
    },
    additionalGuests
  };
}

export function createOrderGuestInputs(
  primaryGuest: GuestFormValue,
  additionalGuests: readonly GuestFormValue[]
): { primaryGuest: CreateOrderPrimaryGuestInputDto; additionalGuests: CreateOrderAdditionalGuestInputDto[] } {
  return {
    primaryGuest: guestFormInput(primaryGuest),
    additionalGuests: additionalGuests.map(guestFormInput)
  };
}

export function canAddGuest(occupancyCapacity: number, additionalGuestCount: number): boolean {
  return 1 + additionalGuestCount < occupancyCapacity;
}

export function roomStatusBlockDraftWithinSelection(
  from: string,
  to: string,
  selectionArrivalDate: string,
  selectionDepartureDate: string
): boolean {
  return isIsoLocalDate(from)
    && isIsoLocalDate(to)
    && selectionArrivalDate <= from
    && from < to
    && to <= selectionDepartureDate;
}

function MaintenanceDialog({ unit, arrivalDate, departureDate, writeBlocked, draft, onClose, onSubmit }: {
  unit: InventoryActionUnit;
  arrivalDate: string;
  departureDate: string;
  writeBlocked: boolean;
  draft?: CommandRequest;
  onClose: () => void;
  onSubmit: (request: CommandRequest) => boolean;
}) {
  const { propertyId } = useWorkspace();
  const formId = useId();
  const [from, setFrom] = useState(() => typeof draft?.input.arrivalDate === "string" ? draft.input.arrivalDate : arrivalDate);
  const [to, setTo] = useState(() => typeof draft?.input.departureDate === "string" ? draft.input.departureDate : departureDate);
  const [reason, setReason] = useState(() => typeof draft?.input.reason === "string" ? draft.input.reason : "");
  const [validationError, setValidationError] = useState<Error>();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!roomStatusBlockDraftWithinSelection(from, to, arrivalDate, departureDate)) {
      setValidationError(new Error(`维修日期必须位于已验证选区 [${arrivalDate}, ${departureDate}) 内，且至少包含一晚。`));
      return;
    }
    setValidationError(undefined);
    onSubmit({
      commandType: "LOCK_MAINTENANCE",
      title: `维修锁房 · ${unit.code}`,
      description: "系统将重新核对房源、日期和维修原因，确认后设置维修锁房。",
      input: { propertyId, inventoryUnitId: unit.id, arrivalDate: from, departureDate: to, reason },
      initialReason: { code: "LOCK_MAINTENANCE", note: reason.trim() }
    });
  }

  return (
    <Modal
      title={`维修锁房 · ${unitName(unit)}`}
      onClose={onClose}
      size="drawer"
      className="room-status-write-drawer"
      footer={<><button type="button" className="button button-secondary" onClick={onClose}>取消</button><button type="submit" form={formId} className="button button-primary" disabled={writeBlocked}>继续核对</button></>}
    >
      <form id={formId} className="modal-form" onSubmit={submit}>
        <InlineError
          error={writeBlocked ? new Error("当前房态已陈旧、正在刷新、权限已收窄或命令恢复尚未收口。日期和原因草稿仍保留，重新取得可写房态后再继续。") : undefined}
          title="草稿已保留，写入已暂停"
        />
        <InlineError error={validationError} title="维修日期未通过房态校验" />
        <div className="form-grid form-grid-two">
          <label>开始日期<input type="date" value={from} min={arrivalDate} max={addLocalDateDays(departureDate, -1)} onChange={(event) => { setFrom(event.target.value); setValidationError(undefined); }} required /></label>
          <label>结束日期<input type="date" value={to} min={isIsoLocalDate(from) ? addLocalDateDays(from, 1) : arrivalDate} max={departureDate} onChange={(event) => { setTo(event.target.value); setValidationError(undefined); }} required /></label>
          <label className="span-two">维修原因<textarea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={1000} /></label>
        </div>
      </form>
    </Modal>
  );
}

function QuoteWorkbench({
  unit,
  arrivalDate,
  departureDate,
  policies,
  initialStayType,
  commandsBlocked,
  selectionDraftValid,
  resetToken,
  onClose,
  onRecoveryOutcome,
  onRecoveryStateChange,
  onCommand
}: {
  unit: InventoryActionUnit | undefined;
  arrivalDate: string;
  departureDate: string;
  policies: PricingPolicyVersionDto[];
  initialStayType?: StayType;
  commandsBlocked: boolean;
  selectionDraftValid: boolean;
  resetToken: number;
  onClose: () => void;
  onRecoveryOutcome: (outcome: Error | undefined) => void;
  onRecoveryStateChange: () => void;
  onCommand: (request: CommandRequest) => void;
}) {
  const { meta, principal, propertyId } = useWorkspace();
  const quoteRecoveryScope = quoteRecoveryStorageKey(principal.subjectId, propertyId);
  const recoveryCoordinationScope = propertyRecoveryCoordinationScope(principal.subjectId, propertyId);
  const stayType: StayType = initialStayType === "FREE" ? "FREE" : paidStayTypeForDates(arrivalDate, departureDate);
  const selectedPolicy = policies.find((policy) => stayType === "FREE"
    ? policy.calculation_kind === "FREE" && policy.stay_type === "FREE"
    : policy.calculation_kind === "DURATION_BAND_TOTAL" && policy.stay_type === null);
  const policyId = selectedPolicy?.id ?? "";
  const [useMemberEntitlement, setUseMemberEntitlement] = useState(false);
  const [memberId, setMemberId] = useState("");
  const [memberSearch, setMemberSearch] = useState("");
  const [quote, setQuote] = useState<QuoteDto>();
  const [quoteSignature, setQuoteSignature] = useState("");
  const [orphanQuoteReviewConfirmed, setOrphanQuoteReviewConfirmed] = useState(false);
  const [quoteRecoverySnapshot, setQuoteRecoverySnapshot] = useState<{ scope: string; read: QuoteRecoveryReadResult }>(() => ({
    scope: quoteRecoveryScope,
    read: browserQuoteRecovery(principal.subjectId, propertyId).read
  }));
  const [guestName, setGuestName] = useState("");
  const [guestNickname, setGuestNickname] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  const [guestDocument, setGuestDocument] = useState("");
  const [additionalGuests, setAdditionalGuests] = useState<AdditionalGuestDraft[]>([]);
  const [bookingChannelCode, setBookingChannelCode] = useState<BookingChannelCode | "">("");
  const [channelOrderReference, setChannelOrderReference] = useState("");
  const [targetContractAmountYuan, setTargetContractAmountYuan] = useState("");
  const [channelPriceDifferenceReason, setChannelPriceDifferenceReason] = useState("");
  const [manualPriceAdjustmentReason, setManualPriceAdjustmentReason] = useState("");
  const [freeStayReason, setFreeStayReason] = useState("");
  const [freeStayCategoryCode, setFreeStayCategoryCode] = useState<"VOLUNTEER" | "RECEPTION" | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [quoteRecoveryOwnerId] = useState(browserQuoteRecoveryOwnerId);
  const latestQuoteSignature = useRef("");
  const settledQuoteSignature = useRef("");
  const nextAdditionalGuestKey = useRef(0);
  const quoteRequestGuardRef = useRef<QuoteRequestGuard | null>(null);
  if (!quoteRequestGuardRef.current) quoteRequestGuardRef.current = new QuoteRequestGuard(quoteRecoveryScope);
  const quoteRequestGuard = quoteRequestGuardRef.current;
  quoteRequestGuard.enterScope(quoteRecoveryScope);
  const quoteRecoveryReady = quoteRecoverySnapshot.scope === quoteRecoveryScope;
  const quoteRecoveryRead = quoteRecoveryReady
    ? quoteRecoverySnapshot.read
    : { kind: "READ_ERROR", error: new Error("正在核对本地报价恢复记录") } as const;
  const pendingQuote = quoteRecoveryRead.kind === "VALID" ? quoteRecoveryRead.pending : undefined;
  const quoteRecoveryError = quoteRecoveryRead.kind === "CORRUPT" || quoteRecoveryRead.kind === "READ_ERROR" ? quoteRecoveryRead.error : undefined;
  const quoteCommandsBlocked = commandsBlocked || !quoteRecoveryReady || quoteRecoveryRead.kind !== "ABSENT";

  function updateQuoteRecoverySnapshot(read: QuoteRecoveryReadResult): void {
    setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read });
    onRecoveryStateChange();
  }

  async function transitionQuoteRecovery(
    expectedIdempotencyKey: string,
    nextState: "CLEAR" | "UNKNOWN"
  ): Promise<{ read: QuoteRecoveryReadResult; matched: boolean; changed: boolean }> {
    try {
      return await withRecoveryStorageLock(recoveryCoordinationScope, () => {
        const current = browserQuoteRecovery(principal.subjectId, propertyId);
        if (!current.storage
          || current.read.kind !== "VALID"
          || current.read.pending.metadata.idempotencyKey !== expectedIdempotencyKey) {
          return { read: current.read, matched: false, changed: false };
        }
        if (nextState === "CLEAR") {
          if (!clearQuoteCommandRecovery(current.storage, principal.subjectId, propertyId)) {
            return {
              read: { kind: "READ_ERROR", error: new Error("无法清除已核对的本地报价恢复记录；新报价和订单写入继续暂停") } as const,
              matched: true,
              changed: false
            };
          }
          return { read: { kind: "ABSENT" } as const, matched: true, changed: true };
        }
        const unknown = { ...current.read.pending, state: "UNKNOWN" as const };
        if (!saveQuoteCommandRecovery(current.storage, unknown)) {
          return {
            read: { kind: "READ_ERROR", error: new Error("无法更新本地报价恢复记录；新报价和订单写入继续暂停") } as const,
            matched: true,
            changed: false
          };
        }
        return { read: { kind: "VALID", pending: unknown } as const, matched: true, changed: true };
      });
    } catch {
      return {
        read: { kind: "READ_ERROR", error: new Error("无法取得跨标签报价协调锁；新报价和订单写入继续暂停") },
        matched: false,
        changed: false
      };
    }
  }

  useEffect(() => {
    quoteRequestGuard.mount();
    return () => quoteRequestGuard.unmount();
  }, [quoteRequestGuard]);

  useEffect(() => {
    setBusy(false);
    updateQuoteRecoverySnapshot(browserQuoteRecovery(principal.subjectId, propertyId).read);
  }, [principal.subjectId, propertyId, quoteRecoveryScope]);

  useEffect(() => {
    const access = browserCommandRecoveryStorage();
    if (access.kind !== "AVAILABLE") return;
    const handleStorage = (event: StorageEvent) => {
      if (!recoveryStorageEventMatchesScope(event, quoteRecoveryScope, access.authoritativeStorage)) return;
      updateQuoteRecoverySnapshot(browserQuoteRecovery(principal.subjectId, propertyId).read);
    };
    const handleSync = (event: Event) => {
      if (!recoveryStorageSyncEventMatchesScope(event as CustomEvent<unknown>, quoteRecoveryScope)) return;
      updateQuoteRecoverySnapshot(browserQuoteRecovery(principal.subjectId, propertyId).read);
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener(RECOVERY_STORAGE_SYNC_EVENT, handleSync);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(RECOVERY_STORAGE_SYNC_EVENT, handleSync);
    };
  }, [principal.subjectId, propertyId, quoteRecoveryScope]);

  useEffect(() => {
    if (resetToken === 0) return;
    settledQuoteSignature.current = "";
    setQuote(undefined);
    setQuoteSignature("");
    setGuestName("");
    setGuestNickname("");
    setGuestPhone("");
    setGuestDocument("");
    setAdditionalGuests([]);
    setBookingChannelCode("");
    setChannelOrderReference("");
    setTargetContractAmountYuan("");
    setChannelPriceDifferenceReason("");
    setManualPriceAdjustmentReason("");
    setFreeStayReason("");
    setFreeStayCategoryCode("");
    setUseMemberEntitlement(false);
    setMemberId("");
    setMemberSearch("");
    setError(undefined);
  }, [resetToken]);

  useEffect(() => {
    if (stayType === "FREE") {
      setUseMemberEntitlement(false);
      setMemberId("");
      setMemberSearch("");
    }
  }, [stayType]);

  useEffect(() => {
    setUseMemberEntitlement(false);
    setMemberId("");
    setMemberSearch("");
    setGuestName("");
    setGuestNickname("");
    setGuestPhone("");
    setGuestDocument("");
    setAdditionalGuests([]);
    setBookingChannelCode("");
    setChannelOrderReference("");
    setTargetContractAmountYuan("");
    setChannelPriceDifferenceReason("");
    setManualPriceAdjustmentReason("");
    setFreeStayReason("");
    setFreeStayCategoryCode("");
    setError(undefined);
  }, [unit?.id, arrivalDate, departureDate, stayType, policyId]);

  useEffect(() => {
    setError(undefined);
  }, [memberId, useMemberEntitlement]);

  useEffect(() => {
    if (!useMemberEntitlement) return;
    setBookingChannelCode("");
    setChannelOrderReference("");
    setTargetContractAmountYuan("");
    setChannelPriceDifferenceReason("");
    setManualPriceAdjustmentReason("");
  }, [useMemberEntitlement]);

  const memberProfiles = eligibleMemberProfiles(meta.members, meta.memberContracts, propertyId, memberSearch);
  const quoteMemberId = effectiveQuoteMemberId(memberProfiles, memberId);

  useEffect(() => {
    if (memberId && !quoteMemberId) setMemberId("");
  }, [memberId, quoteMemberId]);

  const quoteNightCount = isIsoLocalDate(arrivalDate) && isIsoLocalDate(departureDate)
    ? rangeNights({ arrivalDate, departureDate })
    : 0;
  const quoteDatesValid = quoteNightCount >= 1 && quoteNightCount <= MAX_STAY_SELECTION_NIGHTS;
  const currentQuoteInput: QuoteCommandInput | undefined = unit && policyId && selectionDraftValid && quoteDatesValid && (!useMemberEntitlement || quoteMemberId) ? {
    propertyId,
    inventoryUnitId: unit.id,
    ...(stayType === "FREE" ? { stayType } : {}),
    arrivalDate,
    departureDate,
    pricingPolicyVersionId: policyId,
    ...(useMemberEntitlement && quoteMemberId ? { memberId: quoteMemberId } : {})
  } : undefined;
  const currentQuoteSignature = currentQuoteInput ? quoteInputSignature(currentQuoteInput) : "";
  const quoteIsCurrent = Boolean(quote && quoteSignature === currentQuoteSignature);
  latestQuoteSignature.current = currentQuoteSignature;

  async function createQuote(signal?: AbortSignal) {
    if (!currentQuoteInput || quoteCommandsBlocked) return;
    onRecoveryOutcome(undefined);
    const input = currentQuoteInput;
    const inputSignature = quoteInputSignature(input);
    const metadata = api.commandMetadata("create-quote");
    const pending: PendingQuoteCommand = {
      version: 1,
      subjectId: principal.subjectId,
      propertyId,
      ownerTabId: quoteRecoveryOwnerId,
      input,
      inputSignature,
      metadata,
      state: "SENDING"
    };
    const requestLease = quoteRequestGuard.begin(quoteRecoveryScope);
    setBusy(true);
    setError(undefined);
    let claim:
      | { kind: "CLAIMED" }
      | { kind: "STALE" }
      | { kind: "BLOCKED"; read: QuoteRecoveryReadResult; error?: Error };
    try {
      claim = await withRecoveryStorageLock(recoveryCoordinationScope, () => {
        if (!quoteRequestGuard.isActive(requestLease) || signal?.aborted) return { kind: "STALE" as const };
        const beforeSend = browserQuoteRecovery(principal.subjectId, propertyId);
        if (!beforeSend.storage || beforeSend.read.kind !== "ABSENT") {
          return {
            kind: "BLOCKED" as const,
            read: beforeSend.read,
            ...(beforeSend.read.kind === "ABSENT" ? { error: new Error("无法访问本地报价恢复存储，报价命令尚未发送") } : {})
          };
        }
        const commandRead = readPersistedCommandRecovery(
          beforeSend.storage,
          principal.subjectId,
          `property:${propertyId}`
        );
        if (commandRead.kind !== "ABSENT") {
          return {
            kind: "BLOCKED" as const,
            read: beforeSend.read,
            error: new Error("本物业另有未收口的操作；请先核对原操作结果，报价命令尚未发送")
          };
        }
        if (!saveQuoteCommandRecovery(beforeSend.storage, pending)) {
          const error = new Error("无法保存本地报价恢复记录，报价命令尚未发送");
          return { kind: "BLOCKED" as const, read: { kind: "READ_ERROR" as const, error }, error };
        }
        return { kind: "CLAIMED" as const };
      });
    } catch {
      if (quoteRequestGuard.isActive(requestLease)) {
        const error = new Error("无法取得跨标签报价协调锁，报价命令尚未发送");
        updateQuoteRecoverySnapshot({ kind: "READ_ERROR", error });
        setError(error);
        setBusy(false);
      }
      return;
    }
    if (!quoteRequestGuard.isActive(requestLease)) return;
    if (claim.kind === "STALE") {
      setBusy(false);
      return;
    }
    if (claim.kind === "BLOCKED") {
      updateQuoteRecoverySnapshot(claim.read);
      setError(claim.error);
      setBusy(false);
      return;
    }
    updateQuoteRecoverySnapshot({ kind: "VALID", pending });
    try {
      const response = await api.quote(input, metadata, signal);
      if (!quoteRequestGuard.isActive(requestLease)) return;
      const completed = await transitionQuoteRecovery(metadata.idempotencyKey, "CLEAR");
      if (!quoteRequestGuard.isActive(requestLease)) return;
      updateQuoteRecoverySnapshot(completed.read);
      if (!completed.matched || !completed.changed) {
        setError(new Error("报价已返回，但另一笔报价恢复记录正在处理中；当前结果未应用。"));
        return;
      }
      if (latestQuoteSignature.current === inputSignature) {
        settledQuoteSignature.current = inputSignature;
        setQuoteSignature(inputSignature);
        setQuote(response.quote);
      } else {
        setError(undefined);
      }
    } catch (nextError) {
      if (!quoteRequestGuard.isActive(requestLease)) return;
      const definitive = nextError instanceof ApiError
        && nextError.status < 500
        && nextError.code !== "COMMAND_STATUS_UNKNOWN";
      if (definitive) {
        const completed = await transitionQuoteRecovery(metadata.idempotencyKey, "CLEAR");
        if (!quoteRequestGuard.isActive(requestLease)) return;
        updateQuoteRecoverySnapshot(completed.read);
        if (!completed.matched || !completed.changed) {
          setError(new Error("报价处理结果已返回，但本地恢复记录已经变化；当前结果未应用。"));
          return;
        }
        settledQuoteSignature.current = inputSignature;
        setError(staffQuoteError(nextError, unit?.code ?? "所选房源", arrivalDate, departureDate));
        return;
      }
      setError(nextError);
      const unknown = await transitionQuoteRecovery(metadata.idempotencyKey, "UNKNOWN");
      if (!quoteRequestGuard.isActive(requestLease)) return;
      updateQuoteRecoverySnapshot(unknown.read);
      if (!unknown.matched || !unknown.changed) {
        setError(new Error("报价状态暂未确认，但本地恢复记录已经变化；请从当前恢复入口继续核对。"));
      }
    } finally {
      if (quoteRequestGuard.isActive(requestLease)) setBusy(false);
    }
  }

  async function recoverQuote() {
    if (!pendingQuote) return;
    onRecoveryOutcome(undefined);
    const requestLease = quoteRequestGuard.begin(quoteRecoveryScope);
    setBusy(true);
    setError(undefined);
    try {
      const receipt = await api.resolveCommandResult(
        pendingQuote.input.propertyId,
        "CREATE_QUOTE",
        pendingQuote.metadata.idempotencyKey
      );
      if (!quoteRequestGuard.isActive(requestLease)) return;
      if (receipt.executionStatus === "UNKNOWN") {
        const unknown = await transitionQuoteRecovery(pendingQuote.metadata.idempotencyKey, "UNKNOWN");
        if (!quoteRequestGuard.isActive(requestLease)) return;
        updateQuoteRecoverySnapshot(unknown.read);
        setError(new Error("原报价仍在处理，请稍后再次核对；系统不会重复报价。"));
        return;
      }
      if (!receipt.businessCommitted) {
        if (!quoteNotExecutedReceiptIsCoherent(receipt)) {
          setError(new Error("原报价的未执行结果无法核对；已继续暂停新报价。"));
          return;
        }
        const completed = await transitionQuoteRecovery(pendingQuote.metadata.idempotencyKey, "CLEAR");
        if (!quoteRequestGuard.isActive(requestLease)) return;
        updateQuoteRecoverySnapshot(completed.read);
        if (!completed.matched || !completed.changed) {
          setError(new Error("原报价结果已返回，但本地恢复记录已经变化；请重新核对。"));
          return;
        }
        onRecoveryOutcome(new Error("服务端确认该报价命令未执行，可以重新报价。"));
        return;
      }
      const recoveredQuote = quoteFromReceipt(receipt, pendingQuote);
      const recoveredQuoteExpired = Date.parse(recoveredQuote.expiresAt) <= Date.now();
      const completed = await transitionQuoteRecovery(pendingQuote.metadata.idempotencyKey, "CLEAR");
      if (!quoteRequestGuard.isActive(requestLease)) return;
      updateQuoteRecoverySnapshot(completed.read);
      if (!completed.matched || !completed.changed) {
        setError(new Error("原报价结果已返回，但本地恢复记录已经变化；当前结果未应用。"));
        return;
      }
      if (recoveredQuoteExpired) {
        onRecoveryOutcome(new Error("原报价结果已确认，但报价已经过期；请重新报价。"));
        return;
      }
      if (latestQuoteSignature.current !== pendingQuote.inputSignature) {
        onRecoveryOutcome(new Error("报价已恢复，但当前筛选条件已变化；旧结果未应用，请重新报价。"));
        return;
      }
      settledQuoteSignature.current = pendingQuote.inputSignature;
      setQuoteSignature(pendingQuote.inputSignature);
      setQuote(recoveredQuote);
    } catch (nextError) {
      if (!quoteRequestGuard.isActive(requestLease)) return;
      setError(nextError);
      const current = browserQuoteRecovery(principal.subjectId, propertyId);
      updateQuoteRecoverySnapshot(current.read);
    } finally {
      if (quoteRequestGuard.isActive(requestLease)) setBusy(false);
    }
  }

  async function discardCorruptQuoteAfterReview() {
    try {
      const read = await withRecoveryStorageLock(recoveryCoordinationScope, () => {
        const current = browserQuoteRecovery(principal.subjectId, propertyId);
        if (!current.storage || current.read.kind !== "CORRUPT") return current.read;
        if (!clearCorruptQuoteCommandRecovery(current.storage, principal.subjectId, propertyId)) {
          return { kind: "READ_ERROR", error: new Error("无法清除损坏的本地报价恢复记录；写入口继续暂停，请联系管理员处理浏览器存储权限") } as const;
        }
        return { kind: "ABSENT" } as const;
      });
      updateQuoteRecoverySnapshot(read);
      if (read.kind === "ABSENT") setError(undefined);
    } catch {
      updateQuoteRecoverySnapshot({ kind: "READ_ERROR", error: new Error("无法取得跨标签报价协调锁；写入口继续暂停") });
    }
  }

  useEffect(() => {
    setOrphanQuoteReviewConfirmed(false);
  }, [pendingQuote?.metadata.idempotencyKey, pendingQuote?.ownerTabId, pendingQuote?.state]);

  useEffect(() => {
    if (!pendingQuote || pendingQuote.state !== "SENDING" || pendingQuote.ownerTabId !== quoteRecoveryOwnerId || busy) return;
    const timeout = window.setTimeout(() => void recoverQuote(), 500);
    return () => window.clearTimeout(timeout);
  }, [pendingQuote?.metadata.idempotencyKey, pendingQuote?.ownerTabId, pendingQuote?.state, quoteRecoveryOwnerId, busy]);

  useEffect(() => {
    if (!currentQuoteInput || quoteCommandsBlocked || settledQuoteSignature.current === currentQuoteSignature) return;
    const timeout = window.setTimeout(() => void createQuote(), 300);
    return () => window.clearTimeout(timeout);
  }, [currentQuoteSignature, quoteCommandsBlocked]);

  const primaryGuestForm: GuestFormValue = {
    fullName: guestName,
    nickname: guestNickname,
    phone: guestPhone,
    documentNumber: guestDocument
  };
  const guestsComplete = guestFormComplete(primaryGuestForm) && additionalGuests.every(guestFormComplete);
  const guestCount = 1 + additionalGuests.length;
  const paidPricingDraft = quote && !useMemberEntitlement && quote.stayType !== "FREE"
    ? createOrderPricingDraft({
        bookingChannelCode,
        channelOrderReference,
        targetAmountYuan: targetContractAmountYuan,
        policyBaseAmountMinor: quote.currentContractAmount.minorUnits,
        channelPriceDifferenceReason,
        manualPriceAdjustmentReason
      })
    : undefined;

  function addAdditionalGuest() {
    if (!unit || !canAddGuest(unit.occupancyCapacity, additionalGuests.length)) return;
    nextAdditionalGuestKey.current += 1;
    setAdditionalGuests((current) => [...current, {
      key: nextAdditionalGuestKey.current,
      fullName: "",
      nickname: "",
      phone: "",
      documentNumber: ""
    }]);
  }

  function updateAdditionalGuest(key: number, field: keyof GuestFormValue, value: string) {
    setAdditionalGuests((current) => current.map((guest) => guest.key === key ? { ...guest, [field]: value } : guest));
  }

  function removeAdditionalGuest(key: number) {
    setAdditionalGuests((current) => current.filter((guest) => guest.key !== key));
  }

  function createOrder() {
    const channelRequired = bookingChannelRequiredForStay(useMemberEntitlement, quote?.stayType);
    if (quoteCommandsBlocked || !quote || !quoteIsCurrent || !guestsComplete || guestCount > (unit?.occupancyCapacity ?? 0) || (channelRequired && !paidPricingDraft?.complete) || (quote.stayType === "FREE" && (!freeStayReason.trim() || !freeStayCategoryCode))) return;
    const guestInputs = createOrderGuestInputs(primaryGuestForm, additionalGuests);
    onCommand({
      commandType: "CREATE_ORDER",
      title: "创建订单",
      description: "确认住宿人名单、锁定计价政策版本、库存及会员覆盖差异。",
      initialReason: { code: "CREATE_STANDARD_ORDER", note: "" },
      ...(useMemberEntitlement ? { presentation: "MEMBER_STAY" as const } : {}),
      input: {
        propertyId,
        quoteId: quote.quoteId,
        primaryGuest: guestInputs.primaryGuest,
        additionalGuests: guestInputs.additionalGuests,
        ...(!useMemberEntitlement && quote.stayType !== "FREE" && bookingChannelCode ? {
          bookingChannelCode,
          channelOrderReference: bookingChannelCode === "WECOM" ? null : channelOrderReference.trim(),
          targetCurrentContractAmountMinor: paidPricingDraft!.targetCurrentContractAmountMinor,
          ...(paidPricingDraft!.channelReasonRequired ? { channelPriceDifferenceReason: channelPriceDifferenceReason.trim() } : {}),
          ...(paidPricingDraft!.manualReasonRequired ? { manualPriceAdjustmentReason: manualPriceAdjustmentReason.trim() } : {})
        } : {}),
        ...(quote.stayType === "FREE" ? { freeStayReason: freeStayReason.trim(), freeStayCategoryCode } : {})
      }
    });
  }

  return (
    <aside className="quote-workbench" aria-labelledby="quote-heading">
      <header className="panel-heading">
        <div><p className="eyebrow">办理住宿</p><h2 id="quote-heading">住宿金额</h2></div>
        <button className="icon-button" type="button" onClick={onClose} disabled={busy || Boolean(pendingQuote)} title="关闭办理区域" aria-label="关闭办理区域"><X aria-hidden="true" size={18} /></button>
      </header>
      <InlineError error={error} title="报价失败" />
      {quoteRecoveryRead.kind === "CORRUPT" ? (
        <DamagedCommandRecoveryNotice
          error={quoteRecoveryError}
          onDiscard={discardCorruptQuoteAfterReview}
          testId="quote-damaged-command-recovery"
        />
      ) : <InlineError error={quoteRecoveryError} title="本地报价恢复记录不可用" />}
      {pendingQuote?.state === "SENDING" ? (
        <div className="recovery-bar" data-testid="quote-recovery">
          <div>
            <strong>{pendingQuote.ownerTabId === quoteRecoveryOwnerId ? "报价正在提交" : "另一标签正在提交报价"}</strong>
            <p>{pendingQuote.ownerTabId === quoteRecoveryOwnerId
              ? "新的报价和订单写入已暂停；原提交返回或转为待查询状态后再继续。"
              : "新的报价和订单写入已暂停。请先回到原报价标签等待；如果原标签已经关闭，可核对原报价是否完成。"}</p>
          </div>
          {pendingQuote.ownerTabId !== quoteRecoveryOwnerId ? <div className="recovery-damaged-actions">
            <label>
              <input
                type="checkbox"
                checked={orphanQuoteReviewConfirmed}
                onChange={(event) => setOrphanQuoteReviewConfirmed(event.target.checked)}
              />
              <span>我已关闭原报价标签，需要核对原报价结果</span>
            </label>
            <button
              className="button button-secondary"
              type="button"
              disabled={!orphanQuoteReviewConfirmed || busy}
              onClick={() => void recoverQuote()}
            >核对原报价结果</button>
          </div> : null}
        </div>
      ) : pendingQuote?.state === "UNKNOWN" ? (
        <div className="recovery-bar" data-testid="quote-recovery">
          <div><strong>报价结果尚未确认</strong><p>系统不会重复报价；网络恢复后可重新查询本次结果。</p></div>
          <button className="button button-secondary" type="button" onClick={() => void recoverQuote()} disabled={busy}>
            <RefreshCw aria-hidden="true" size={17} />核对原报价结果
          </button>
        </div>
      ) : null}
      {!unit ? <EmptyState title="选择可售库存" detail="在房态表中选择整房或床位后开始报价。" /> : (
        <>
          <div className="selected-unit"><strong>{unitName(unit)}</strong><span>{arrivalDate} 至 {departureDate}</span></div>
          {stayType !== "FREE" ? <div className="member-benefit-controls">
            <label className="checkbox-label"><input
              type="checkbox"
              checked={useMemberEntitlement}
              onChange={(event) => {
                const enabled = event.target.checked;
                setUseMemberEntitlement(enabled);
                if (enabled) {
                  setBookingChannelCode("");
                  setChannelOrderReference("");
                } else {
                  setMemberId("");
                  setMemberSearch("");
                }
              }}
              disabled={busy || quoteRecoveryRead.kind !== "ABSENT"}
              data-testid="use-member-entitlement"
            />本次住宿使用会员权益</label>
            {useMemberEntitlement ? <div className="form-grid quote-form" data-testid="member-benefit-picker">
              <label>搜索会员
                <input value={memberSearch} onChange={(event) => setMemberSearch(event.target.value)} placeholder="姓名、身份证号、手机号或微信号" disabled={busy || quoteRecoveryRead.kind !== "ABSENT"} data-testid="member-search" />
              </label>
              <label>会员档案
                <select
                  value={quoteMemberId}
                  onChange={(event) => {
                    const selectedMemberId = event.target.value;
                    setMemberId(selectedMemberId);
                    const selectedMember = memberProfiles.find((member) => member.id === selectedMemberId);
                    if (!selectedMember) return;
                    const nextGuests = applyMemberSelectionToGuestForms(additionalGuests, selectedMember);
                    setGuestNickname(nextGuests.primaryGuest.nickname);
                    setGuestName(nextGuests.primaryGuest.fullName);
                    setGuestPhone(nextGuests.primaryGuest.phone);
                    setGuestDocument(nextGuests.primaryGuest.documentNumber);
                    setAdditionalGuests(nextGuests.additionalGuests);
                  }}
                  disabled={busy || quoteRecoveryRead.kind !== "ABSENT"}
                  data-testid="member-profile-select"
                >
                  <option value="">请选择会员</option>
                  {memberProfiles.map((member) => <option key={member.id} value={member.id}>{member.full_name} · {member.identity_card_number} · {member.phone}</option>)}
                </select>
              </label>
            </div> : null}
          </div> : null}
          <div
            className={`room-status-pricing-progress${busy ? "" : " is-idle"}`}
            {...(busy ? { role: "status" as const } : { "aria-hidden": true })}
          >正在计算住宿金额</div>
          {quote ? (
            <div
              className={`quote-result${quoteIsCurrent ? "" : " is-layout-placeholder"}`}
              {...(quoteIsCurrent ? { "data-testid": "quote-result" } : { "aria-hidden": true })}
            >
              {(() => {
                const summary = quotePricingSummary(quote);
                const memberSummary = membershipCoverageSummary(quote);
                return (
              <div className="quote-amounts">
                {useMemberEntitlement ? <>
                  <div><span>总住宿晚数</span><strong>{memberSummary.totalNights} 晚</strong></div>
                  <div><span>覆盖晚数</span><strong>{memberSummary.coveredNights} 晚</strong></div>
                  <div><span>未覆盖晚数</span><strong>{memberSummary.uncoveredNights} 晚</strong></div>
                  <div><span>未覆盖金额</span><strong>{formatMoney(memberSummary.uncoveredAmount)}</strong></div>
                </> : <>
                  <div><span>住宿晚数</span><strong>{summary.nights} 晚</strong></div>
                  <div><span>计价依据</span><strong>{summary.pricingBasis}</strong></div>
                  <div><span>{quote.stayType === "FREE" ? "住宿金额" : "政策基础金额"}</span><strong>{formatMoney(summary.amount)}</strong></div>
                </>}
              </div>
                );
              })()}
              <section className="guest-section" aria-labelledby="guest-heading">
                <div className="guest-section-heading">
                  <h3 id="guest-heading">住宿人</h3>
                  <span>{guestCount} / {unit.occupancyCapacity} 人</span>
                </div>
                <fieldset className="guest-entry" data-testid="primary-guest-entry">
                  <legend>主要入住人 <span>主要联系人</span></legend>
                  <div className="form-grid">
                    <label>昵称<input value={guestNickname} onChange={(event) => setGuestNickname(event.target.value)} required maxLength={200} data-testid="primary-guest-nickname" /></label>
                    <label>姓名<input value={guestName} onChange={(event) => setGuestName(event.target.value)} required maxLength={GUEST_FULL_NAME_MAX_LENGTH} data-testid="primary-guest-name" /></label>
                    <label>联系电话<input value={guestPhone} onChange={(event) => setGuestPhone(event.target.value)} inputMode="tel" maxLength={80} data-testid="primary-guest-phone" /></label>
                    <label>证件号码<input value={guestDocument} onChange={(event) => setGuestDocument(event.target.value)} maxLength={120} data-testid="primary-guest-document" /></label>
                  </div>
                </fieldset>
                {additionalGuests.map((guest, index) => (
                  <fieldset className="guest-entry" key={guest.key} data-testid="additional-guest-entry">
                    <legend>
                      同行人 {index + 1}
                      <button className="icon-button" type="button" onClick={() => removeAdditionalGuest(guest.key)} aria-label={`删除同行人 ${index + 1}`} title="删除同行人">
                        <Trash2 aria-hidden="true" size={16} />
                      </button>
                    </legend>
                    <div className="form-grid">
                      <label>昵称<input value={guest.nickname} onChange={(event) => updateAdditionalGuest(guest.key, "nickname", event.target.value)} required maxLength={200} data-testid={`additional-guest-${index}-nickname`} /></label>
                      <label>姓名<input value={guest.fullName} onChange={(event) => updateAdditionalGuest(guest.key, "fullName", event.target.value)} required maxLength={GUEST_FULL_NAME_MAX_LENGTH} data-testid={`additional-guest-${index}-name`} /></label>
                      <label>联系电话<input value={guest.phone} onChange={(event) => updateAdditionalGuest(guest.key, "phone", event.target.value)} inputMode="tel" maxLength={80} data-testid={`additional-guest-${index}-phone`} /></label>
                      <label>证件号码<input value={guest.documentNumber} onChange={(event) => updateAdditionalGuest(guest.key, "documentNumber", event.target.value)} maxLength={120} data-testid={`additional-guest-${index}-document`} /></label>
                    </div>
                  </fieldset>
                ))}
                <button className="button button-secondary guest-add-button" type="button" onClick={addAdditionalGuest} disabled={!canAddGuest(unit.occupancyCapacity, additionalGuests.length)} data-testid="add-additional-guest">
                  <UserPlus aria-hidden="true" size={17} />添加同行人
                </button>
                <div className="form-grid guest-order-fields">
                  {!useMemberEntitlement && quote.stayType !== "FREE" ? <label>订单来源渠道
                    <select
                      value={bookingChannelCode}
                      onChange={(event) => {
                        const code = event.target.value as BookingChannelCode | "";
                        setBookingChannelCode(code);
                        setChannelOrderReference("");
                        setTargetContractAmountYuan(code === "WECOM" ? formatMinorForYuanInput(quote.currentContractAmount.minorUnits) : "");
                        setChannelPriceDifferenceReason("");
                        setManualPriceAdjustmentReason("");
                      }}
                      data-testid="booking-channel-code"
                    >
                      <option value="">请选择渠道</option>
                      {Object.entries(bookingChannelLabels).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
                    </select>
                  </label> : null}
                  {!useMemberEntitlement && quote.stayType !== "FREE" && bookingChannelCode && bookingChannelCode !== "WECOM" ? <label>渠道订单号（必填）<input value={channelOrderReference} onChange={(event) => setChannelOrderReference(event.target.value)} maxLength={200} required data-testid="channel-order-reference" /></label> : null}
                  {!useMemberEntitlement && quote.stayType !== "FREE" && bookingChannelCode ? <>
                    <label>{bookingChannelCode === "WECOM" ? "本单金额" : "本单渠道应结金额（必填）"}
                      <input
                        value={targetContractAmountYuan}
                        onChange={(event) => setTargetContractAmountYuan(event.target.value)}
                        inputMode="numeric"
                        placeholder="0"
                        pattern="[0-9]+(?:\\.00)?"
                        required
                        data-testid="target-contract-amount"
                      />
                    </label>
                    {paidPricingDraft?.differenceFromPolicyMinor !== undefined ? <div className="span-two inline-summary" data-testid="create-order-price-difference">
                      <span>政策基础金额 {formatMoney(quote.currentContractAmount)}</span>
                      <strong>与政策基础金额差额 {formatMoney({ currency: quote.currentContractAmount.currency, minorUnits: paidPricingDraft.differenceFromPolicyMinor })}</strong>
                    </div> : null}
                    {paidPricingDraft?.channelReasonRequired ? <label className="span-two">渠道价格差异说明
                      <textarea value={channelPriceDifferenceReason} onChange={(event) => setChannelPriceDifferenceReason(event.target.value)} required maxLength={1000} rows={2} data-testid="channel-price-difference-reason" />
                    </label> : null}
                    {paidPricingDraft?.manualReasonRequired ? <label className="span-two">人工调价原因
                      <textarea value={manualPriceAdjustmentReason} onChange={(event) => setManualPriceAdjustmentReason(event.target.value)} required maxLength={1000} rows={2} data-testid="manual-price-adjustment-reason" />
                    </label> : null}
                  </> : null}
                  {quote.stayType === "FREE" ? <>
                    <label>免费入住类型
                      <select value={freeStayCategoryCode} onChange={(event) => setFreeStayCategoryCode(event.target.value as "VOLUNTEER" | "RECEPTION")} data-testid="free-stay-category-code">
                        <option value="">请选择类型</option>
                        {Object.entries(freeStayCategoryLabels).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
                      </select>
                    </label>
                    <label className="span-two">免费入住原因<textarea rows={3} value={freeStayReason} onChange={(event) => setFreeStayReason(event.target.value)} required maxLength={1000} data-testid="free-stay-reason" /></label>
                  </> : null}
                </div>
                <button className="button button-primary full-width" type="button" onClick={createOrder} disabled={quoteCommandsBlocked || !quoteIsCurrent || !guestsComplete || guestCount > unit.occupancyCapacity || (bookingChannelRequiredForStay(useMemberEntitlement, quote.stayType) && !paidPricingDraft?.complete) || (quote.stayType === "FREE" && (!freeStayReason.trim() || !freeStayCategoryCode))} data-testid="create-order">
                  <FilePlus2 aria-hidden="true" size={17} />核对并创建订单
                </button>
              </section>
            </div>
          ) : null}
        </>
      )}
    </aside>
  );
}

const ROOM_STATUS_PAGE_SIZE = 50;
const ROOM_STATUS_POLL_MS = 4_000;
const ROOM_STATUS_QUERY_TIMEOUT_MS = 15_000;
const ROOM_STATUS_RESTORATION_PREFIX = "qintopia.room-status-view.v1";
const selectionActionCodes = new Set(["CREATE_ORDER", "CREATE_FREE_STAY", "LOCK_MAINTENANCE"]);

interface RoomStatusInteractionSnapshot {
  anchor: HTMLElement;
  selection: RoomStatusSelection | null;
  focusedCell: RoomStatusViewState["focusedCell"];
  windowX: number;
  windowY: number;
  grid: HTMLElement | null;
  gridLeft: number;
  gridTop: number;
}

interface RoomStatusQuoteTarget {
  unitId: string;
  arrivalDate: string;
  departureDate: string;
  initialStayType: StayType;
}

type PendingMobileTaskFocus = Omit<RoomStatusMobileFocusRequest, "token">;

type RoomStatusCommandPhase = "IDLE" | "DRAFT" | "PREVIEW" | "CONFIRMING" | "SETTLED";

export function roomStatusProjectionRefreshAllowed(phase: RoomStatusCommandPhase): boolean {
  return phase === "IDLE" || phase === "SETTLED";
}

export function roomStatusTimelineRangeFromStart(startDate: string): RoomStatusRange {
  return {
    arrivalDate: startDate,
    departureDate: addLocalDateDays(startDate, ROOM_STATUS_TIMELINE_DAYS)
  };
}

function restoredOrDefaultRoomStatusRange(restored: RoomStatusRestorationSnapshot | undefined, timeZone: string): RoomStatusRange {
  return restored?.range.arrivalDate && isIsoLocalDate(restored.range.arrivalDate)
    ? roomStatusTimelineRangeFromStart(restored.range.arrivalDate)
    : defaultRoomStatusRange(timeZone);
}

function roomStatusQuery(
  range: RoomStatusRange,
  page: number,
  filters: RoomStatusViewState["filters"]
): RoomStatusBoardQueryDto {
  const search = filters.search.trim();
  return {
    arrivalDate: range.arrivalDate,
    departureDate: range.departureDate,
    page,
    pageSize: ROOM_STATUS_PAGE_SIZE,
    ...(search ? { search } : {}),
    ...(filters.roomTypeCode !== "ALL" ? { roomType: filters.roomTypeCode } : {}),
    ...(filters.salesMode !== "ALL" ? { salesMode: filters.salesMode } : {}),
    ...(filters.status !== "ALL" ? { status: filters.status } : {}),
    ...(filters.minimumCapacity !== null ? { minCapacity: filters.minimumCapacity } : {}),
    ...(filters.kind !== "ALL" ? { unitKind: filters.kind } : {})
  };
}

function roomStatusQueryKey(query: RoomStatusBoardQueryDto): string {
  return JSON.stringify([
    query.arrivalDate,
    query.departureDate,
    query.page ?? 0,
    query.pageSize ?? ROOM_STATUS_PAGE_SIZE,
    query.search ?? null,
    query.roomType ?? null,
    query.salesMode ?? null,
    query.status ?? null,
    query.minCapacity ?? null,
    query.unitKind ?? null
  ]);
}

function roomStatusRestorationKey(subjectId: string, propertyId: string): string {
  return `${ROOM_STATUS_RESTORATION_PREFIX}:${encodeURIComponent(subjectId)}:${encodeURIComponent(propertyId)}`;
}

function defaultRoomStatusRange(timeZone: string): RoomStatusRange {
  const today = localDateInTimeZone(timeZone);
  return roomStatusTimelineRangeFromStart(today);
}

function rangeNights(range: RoomStatusRange): number {
  if (!isIsoLocalDate(range.arrivalDate) || !isIsoLocalDate(range.departureDate)) return 0;
  return Math.round((Date.parse(`${range.departureDate}T00:00:00Z`) - Date.parse(`${range.arrivalDate}T00:00:00Z`)) / 86_400_000);
}

function readRoomStatusRestoration(subjectId: string, propertyId: string): RoomStatusRestorationSnapshot | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const serialized = window.sessionStorage.getItem(roomStatusRestorationKey(subjectId, propertyId));
    return serialized ? parseRoomStatusRestoration(serialized, propertyId) : undefined;
  } catch {
    return undefined;
  }
}

function writeRoomStatusRestoration(subjectId: string, snapshot: RoomStatusRestorationSnapshot): boolean {
  try {
    window.sessionStorage.setItem(roomStatusRestorationKey(subjectId, snapshot.propertyId), serializeRoomStatusRestoration(snapshot));
    return true;
  } catch {
    return false;
  }
}

function flattenRoomStatusUnits(board: RoomStatusBoardDto): RoomStatusUnitDto[] {
  return board.rooms.flatMap((room) => [room, ...room.children]);
}

function findRoomStatusUnit(board: RoomStatusBoardDto | undefined, unitId: string | undefined): RoomStatusUnitDto | null {
  if (!board || !unitId) return null;
  return flattenRoomStatusUnits(board).find((unit) => unit.id === unitId) ?? null;
}

function withoutRoomStatusWriteActions(unit: RoomStatusUnitDto): RoomStatusUnitDto {
  const readActions = (actions: readonly RoomStatusActionDto[]) => actions.filter((action) => action.code === "OPEN_ORDER");
  return {
    ...unit,
    intervals: unit.intervals.map((interval) => ({
      ...interval,
      allowedActions: readActions(interval.allowedActions)
    })),
    allowedActions: readActions(unit.allowedActions),
    children: unit.children.map(withoutRoomStatusWriteActions)
  };
}

function displayRoomStatusBoard(board: RoomStatusBoardDto, commandsBlocked: boolean): RoomStatusBoardDto {
  if (!commandsBlocked) return board;
  return {
    ...board,
    operationalTasks: board.operationalTasks.map((task) => ({
      ...task,
      allowedActions: task.allowedActions.filter((action) => action.code === "OPEN_ORDER")
    })),
    rooms: board.rooms.map(withoutRoomStatusWriteActions)
  };
}

function uniqueConflicts(conflicts: readonly RoomStatusConflictDto[]): RoomStatusConflictDto[] {
  return [...new Map(conflicts.map((conflict) => [conflict.id, conflict])).values()];
}

function selectionDays(unit: RoomStatusUnitDto | null, selection: RoomStatusSelection | null): RoomStatusDayDto[] {
  if (!unit || !selection || unit.id !== selection.unitId) return [];
  return unit.days.filter((day) => day.serviceDate >= selection.arrivalDate && day.serviceDate < selection.departureDate);
}

function selectionActions(unit: RoomStatusUnitDto | null, selection: RoomStatusSelection | null): RoomStatusActionDto[] {
  const days = selectionDays(unit, selection);
  const nights = selection ? rangeNights(selection) : 0;
  if (!selection || nights < 1 || nights > MAX_STAY_SELECTION_NIGHTS) return [];
  if (days.some((day) => !day.available || day.conflicts.length > 0)) return [];
  return unit?.allowedActions.filter((candidate) => candidate.enabled && selectionActionCodes.has(candidate.code)) ?? [];
}

function dayActions(unit: RoomStatusUnitDto | null, day: RoomStatusDayDto | null): RoomStatusActionDto[] {
  if (!unit || !day) return [];
  const create = day.available && day.conflicts.length === 0
    ? unit.allowedActions.filter((candidate) => candidate.enabled && selectionActionCodes.has(candidate.code))
    : [];
  const sourceActions = unit.intervals
    .filter((interval) => day.intervalIds.includes(interval.id))
    .flatMap((interval) => interval.allowedActions);
  return [...new Map([...create, ...sourceActions].map((candidate) => [
    `${candidate.code}:${candidate.targetReference?.type ?? "none"}:${candidate.targetReference?.id ?? "none"}`,
    candidate
  ])).values()];
}

function intervalActions(interval: RoomStatusIntervalDto | null, selection: RoomStatusSelection | null): RoomStatusActionDto[] {
  if (!interval) return [];
  const fullIntervalSelected = Boolean(selection
    && selection.unitId === interval.displayInventoryUnitId
    && selection.arrivalDate === interval.sourceStartDate
    && selection.departureDate === interval.sourceEndDate);
  return interval.allowedActions.map((action) => action.requiresFullInterval
    && action.code !== "RELEASE_MAINTENANCE"
    && !fullIntervalSelected
    ? {
        ...action,
        enabled: false,
        disabledReason: action.disabledReason ?? `当前选区必须精确匹配来源完整区间 [${interval.sourceStartDate}, ${interval.sourceEndDate})`
      }
    : action);
}

function actionUnit(unit: RoomStatusUnitDto, available: boolean): InventoryActionUnit {
  return {
    id: unit.id,
    kind: unit.kind,
    code: unit.code,
    name: unit.name,
    buildingCode: unit.buildingCode,
    occupancyCapacity: unit.occupancyCapacity,
    available
  };
}

export function selectedOrderCommandScopeIsCurrent(
  selectedScope: string | undefined,
  principalScope: string,
  identity?: Pick<RoomStatusOrderIdentity, "orderId" | "stayId">
): boolean {
  if (!selectedScope) return false;
  return selectedScope === principalScope
    || selectedScope === roomStatusOrderCommandScope(principalScope, identity);
}

export function roomStatusOrderCommandScope(
  principalScope: string,
  identity?: Pick<RoomStatusOrderIdentity, "orderId" | "stayId">
): string {
  return identity
    ? JSON.stringify([principalScope, identity.orderId, identity.stayId])
    : principalScope;
}

export function selectedOrderMemberLookup(
  view: Pick<OrderViewDto, "order" | "stay">,
  propertyId: string,
  stayId: string
): { memberId: string; scope: string } | undefined {
  const memberId = view.order.member_id;
  if (!memberId || view.order.property_id !== propertyId || view.stay.id !== stayId) return undefined;
  return {
    memberId,
    scope: `${propertyId}:${view.order.id}:${view.stay.id}:${memberId}`
  };
}

export function selectedStayDateRequestIsCompatible(
  openedAction: StayDateChangeAction,
  mode: StayDateChangeMode,
  requestCommandType: CommandRequest["commandType"]
): boolean {
  return mode === "ADJUST_DEPARTURE"
    ? requestCommandType === "EXTEND_STAY" || requestCommandType === "SHORTEN_STAY"
    : requestCommandType === openedAction;
}

export function roomStatusCommandWriteGate(input: {
  projectionWritable: boolean;
  activeProjectionValid: boolean;
  recoveryBlocked: boolean;
  recoveryReady: boolean;
  recoveryError: unknown;
  contextInvalidated: boolean;
  targetScopeCurrent: boolean;
}): { startBlocked: boolean; activeBlocked: boolean } {
  return {
    startBlocked: input.recoveryBlocked || !input.projectionWritable,
    activeBlocked: !input.activeProjectionValid
      || !input.recoveryReady
      || Boolean(input.recoveryError)
      || input.contextInvalidated
      || !input.targetScopeCurrent
  };
}

function buildMobileGroups(board: RoomStatusBoardDto): RoomStatusMobileGroups {
  const tasks = board.operationalTasks.filter((task) => task.businessDate === board.businessDate);
  return {
    arrivals: tasks.filter((task) => task.taskKind === "ARRIVAL"),
    inHouse: tasks.filter((task) => task.taskKind === "IN_HOUSE"),
    departures: tasks.filter((task) => task.taskKind === "DEPARTURE"),
    exceptions: tasks.filter((task) => task.taskKind === "EXCEPTION")
  };
}

export function InventoryPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useRoomStatusMobileViewport();
  const { meta, principal, propertyId } = useWorkspace();
  const property = meta.properties.find((item) => item.id === propertyId);
  const propertyTimezone = property?.timezone ?? "UTC";
  const orderPrincipalScope = `${propertyId}:${principal.subjectId}:${principal.credentialType}:${principal.propertyAccess[propertyId] ?? "NONE"}`;
  const initialRestoration = useRef(readRoomStatusRestoration(principal.subjectId, propertyId));
  const orderReturnEnvelopePresent = useRef(hasRoomStatusOrderReturnEnvelope(location.state));
  const pendingOrderReturnTarget = useRef(parseRoomStatusOrderReturnTarget(location.state));
  const [range, setRange] = useState<RoomStatusRange>(() => restoredOrDefaultRoomStatusRange(initialRestoration.current, propertyTimezone));
  const [viewState, dispatchView] = useReducer(
    roomStatusViewReducer,
    initialRestoration.current?.state ?? createRoomStatusViewState()
  );
  const pageQuoteRecoveryScope = quoteRecoveryStorageKey(principal.subjectId, propertyId);
  const [, setPageQuoteRecoveryRevision] = useState(0);
  useEffect(() => {
    const access = browserCommandRecoveryStorage();
    if (access.kind !== "AVAILABLE") return;
    const handleStorage = (event: StorageEvent) => {
      if (!recoveryStorageEventMatchesScope(event, pageQuoteRecoveryScope, access.authoritativeStorage)) return;
      setPageQuoteRecoveryRevision((revision) => revision + 1);
    };
    const handleSync = (event: Event) => {
      if (!recoveryStorageSyncEventMatchesScope(event as CustomEvent<unknown>, pageQuoteRecoveryScope)) return;
      setPageQuoteRecoveryRevision((revision) => revision + 1);
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener(RECOVERY_STORAGE_SYNC_EVENT, handleSync);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(RECOVERY_STORAGE_SYNC_EVENT, handleSync);
    };
  }, [pageQuoteRecoveryScope]);
  const pageQuoteRecovery = browserQuoteRecovery(principal.subjectId, propertyId).read;
  const currentQuoteRecoveryIdentity = quoteRecoveryContextIdentity(pageQuoteRecoveryScope, pageQuoteRecovery);
  const currentQuoteRecoveryOwnerId = pageQuoteRecovery.kind === "VALID" ? pageQuoteRecovery.pending.ownerTabId : undefined;
  const currentBrowserQuoteRecoveryOwnerId = browserQuoteRecoveryOwnerId();
  const commandRecovery = usePersistentCommandRecovery({
    subjectId: principal.subjectId,
    scopeId: `property:${propertyId}`
  });
  const [board, setBoard] = useState<RoomStatusBoardDto>();
  const boardRef = useRef<RoomStatusBoardDto | undefined>(undefined);
  const [boardQueryKey, setBoardQueryKey] = useState<string>();
  const boardQueryKeyRef = useRef<string | undefined>(undefined);
  const queryAttemptGuardRef = useRef<RoomStatusQueryAttemptGuard | null>(null);
  if (!queryAttemptGuardRef.current) queryAttemptGuardRef.current = new RoomStatusQueryAttemptGuard();
  const queryAttemptGuard = queryAttemptGuardRef.current;
  const permissionDeniedRef = useRef(false);
  const pendingRestoration = useRef<RoomStatusRestorationSnapshot | undefined>(initialRestoration.current);
  const orderRestorationAttempted = useRef(false);
  const orderReturnResolutionStarted = useRef(false);
  const restorationPagesVisited = useRef(new Set<number>());
  const previousPropertyId = useRef(propertyId);
  const previousSubjectId = useRef(principal.subjectId);
  const [initializedPropertyId, setInitializedPropertyId] = useState(propertyId);
  const [queryPhase, setQueryPhase] = useState<"LOADING" | "RANGE_LOADING" | "READY" | "REFRESHING" | "ERROR" | "PERMISSION_DENIED">("LOADING");
  const [queryError, setQueryError] = useState<unknown>();
  const [rangeError, setRangeError] = useState<unknown>();
  const [restorationError, setRestorationError] = useState<unknown>();
  const [restoreGridFocus, setRestoreGridFocus] = useState(Boolean(initialRestoration.current));
  const [returnNotice, setReturnNotice] = useState<string>();
  const [actionError, setActionError] = useState<unknown>();
  const [quoteRecoveryOutcome, setQuoteRecoveryOutcome] = useState<Error>();
  const [clock, setClock] = useState(() => Date.now());
  const [refreshToken, setRefreshToken] = useState(0);
  const [quoteResetToken, setQuoteResetToken] = useState(0);
  const [selectionDraftValid, setSelectionDraftValid] = useState(true);
  const [command, setCommand] = useState<CommandRequest>();
  const [commandDraft, setCommandDraft] = useState<CommandRequest>();
  const [commandAttemptId, setCommandAttemptId] = useState(0);
  const [recoveryDialogOpen, setRecoveryDialogOpen] = useState(false);
  const [quoteRecoveryContextOpen, setQuoteRecoveryContextOpen] = useState(false);
  const [dismissedQuoteRecoveryIdentity, setDismissedQuoteRecoveryIdentity] = useState<string>();
  const [recoveryError, setRecoveryError] = useState<unknown>();
  const [commandNotice, setCommandNotice] = useState<string>();
  const [selectedUnitId, setSelectedUnitId] = useState<string>();
  const [selectedDayDate, setSelectedDayDate] = useState<string>();
  const [selectedIntervalId, setSelectedIntervalId] = useState<string>();
  const [selectedGridStayId, setSelectedGridStayId] = useState<string>();
  const [selectedOrderIdentity, setSelectedOrderIdentity] = useState<RoomStatusOrderIdentity>();
  const [selectedOrderView, setSelectedOrderView] = useState<OrderViewDto>();
  const [selectedMemberView, setSelectedMemberView] = useState<MemberViewDto>();
  const [selectedOrderLoadedScope, setSelectedOrderLoadedScope] = useState<string>();
  const [selectedOrderLoading, setSelectedOrderLoading] = useState(false);
  const [selectedOrderError, setSelectedOrderError] = useState<unknown>();
  const [selectedCorrectionOccupantId, setSelectedCorrectionOccupantId] = useState<string>();
  const [selectedCorrectionRevision, setSelectedCorrectionRevision] = useState<string>();
  const [selectedStayDateAction, setSelectedStayDateAction] = useState<StayDateChangeAction>();
  const [selectedStayDateMode, setSelectedStayDateMode] = useState<StayDateChangeMode>("DATE_CHANGE");
  const [selectedStayDateRevision, setSelectedStayDateRevision] = useState<string>();
  const [selectedMoveUnitOpen, setSelectedMoveUnitOpen] = useState(false);
  const [selectedMoveUnitRevision, setSelectedMoveUnitRevision] = useState<string>();
  const [selectedLifecycleAction, setSelectedLifecycleAction] = useState<OrderLifecycleAction>();
  const [selectedLifecycleRevision, setSelectedLifecycleRevision] = useState<string>();
  const [orderContextOpen, setOrderContextOpen] = useState(false);
  const [desktopContextCollapsed, setDesktopContextCollapsed] = useState(true);
  useEffect(() => {
    if (queryPhase === "PERMISSION_DENIED") {
      if (quoteRecoveryContextOpen) setQuoteRecoveryContextOpen(false);
      if (!isMobile) setDesktopContextCollapsed(true);
      return;
    }
    if (!currentQuoteRecoveryIdentity) {
      if (quoteRecoveryContextOpen) setQuoteRecoveryContextOpen(false);
      if (dismissedQuoteRecoveryIdentity) setDismissedQuoteRecoveryIdentity(undefined);
      if (!isMobile && quoteRecoveryContextOpen) setDesktopContextCollapsed(true);
      return;
    }
    if (shouldAutoOpenQuoteRecoveryContext({
      recoveryIdentity: currentQuoteRecoveryIdentity,
      dismissedIdentity: dismissedQuoteRecoveryIdentity,
      recoveryOwnerId: currentQuoteRecoveryOwnerId,
      currentOwnerId: currentBrowserQuoteRecoveryOwnerId,
      isMobile,
      hasSelectedOrder: Boolean(selectedOrderIdentity)
    })) {
      setQuoteRecoveryContextOpen(true);
      setDesktopContextCollapsed(false);
    }
  }, [currentBrowserQuoteRecoveryOwnerId, currentQuoteRecoveryIdentity, currentQuoteRecoveryOwnerId, dismissedQuoteRecoveryIdentity, isMobile, queryPhase, quoteRecoveryContextOpen, selectedOrderIdentity]);
  const [quickPopoverTarget, setQuickPopoverTarget] = useState<{
    unitId: string;
    serviceDate: string;
    anchor: HTMLElement;
    intervalId?: string;
    selection?: RoomStatusSelection;
  }>();
  const [orderRefreshToken, setOrderRefreshToken] = useState(0);
  const [selectedOrderCommandScope, setSelectedOrderCommandScope] = useState<string>();
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const [maintenanceTarget, setMaintenanceTarget] = useState<InventoryActionUnit>();
  const [quoteTarget, setQuoteTarget] = useState<RoomStatusQuoteTarget>();
  const [mobileTab, setMobileTab] = useState<RoomStatusMobileTab>("ARRIVALS");
  const [mobileCreateOpen, setMobileCreateOpen] = useState(false);
  const [mobileFocusRequest, setMobileFocusRequest] = useState<RoomStatusMobileFocusRequest>();
  const [commandContextInvalidated, setCommandContextInvalidated] = useState(false);
  const [focusRequestToken, setFocusRequestToken] = useState(0);
  const [filterFocusRequestToken, setFilterFocusRequestToken] = useState(0);
  const quoteSectionRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const boardColumnRef = useRef<HTMLDivElement>(null);
  const roomStatusInteractionSnapshotRef = useRef<RoomStatusInteractionSnapshot | undefined>(undefined);
  const commandPhaseRef = useRef<RoomStatusCommandPhase>("IDLE");
  const commandAttemptGuardRef = useRef<RoomStatusCommandAttemptGuard | null>(null);
  if (!commandAttemptGuardRef.current) commandAttemptGuardRef.current = new RoomStatusCommandAttemptGuard();
  const commandAttemptGuard = commandAttemptGuardRef.current;
  const selectedMemberRequestGuardRef = useRef<SelectedMemberViewRequestGuard | null>(null);
  if (!selectedMemberRequestGuardRef.current) selectedMemberRequestGuardRef.current = new SelectedMemberViewRequestGuard();
  const selectedMemberRequestGuard = selectedMemberRequestGuardRef.current;
  const commandRevisionRef = useRef<string | undefined>(undefined);
  const commandQueryKeyRef = useRef<string | undefined>(undefined);
  const refreshedReceiptIdRef = useRef<string | undefined>(undefined);
  const focusAfterNextBoard = useRef(false);
  const returnedOrderCellFocus = useRef<{ unitId: string; serviceDate: string } | undefined>(undefined);
  const pendingMobileTaskFocus = useRef<PendingMobileTaskFocus | undefined>(undefined);
  const mobileFocusSequence = useRef(0);
  const latestRestoration = useRef<{
    subjectId: string;
    snapshot: RoomStatusRestorationSnapshot;
  } | undefined>(undefined);
  const currentSelectedOrderCommandScope = roomStatusOrderCommandScope(orderPrincipalScope, selectedOrderIdentity);

  useEffect(() => {
    boardRef.current = board;
  }, [board]);

  useEffect(() => {
    const element = workspaceRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWorkspaceWidth(entry?.contentRect.width ?? 0));
    observer.observe(element);
    setWorkspaceWidth(element.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, [boardQueryKey]);

  useEffect(() => {
    if (!selectedOrderIdentity) {
      setSelectedOrderView(undefined);
      setSelectedOrderLoadedScope(undefined);
      setSelectedOrderError(undefined);
      setSelectedOrderLoading(false);
      return;
    }
    let current = true;
    const controller = new AbortController();
    setSelectedOrderLoading(true);
    setSelectedOrderError(undefined);
    api.order(selectedOrderIdentity.orderId, controller.signal)
      .then((response) => {
        if (!current) return;
        if (response.order.property_id !== propertyId || response.stay.id !== selectedOrderIdentity.stayId) {
          throw new Error("订单上下文与当前房态的稳定引用不一致，已停止显示");
        }
        setSelectedOrderView(response);
        setSelectedOrderLoadedScope(orderPrincipalScope);
      })
      .catch((nextError) => {
        if (!current) return;
        if (nextError instanceof DOMException && nextError.name === "AbortError") return;
        setSelectedOrderView(undefined);
        setSelectedOrderError(nextError);
      })
      .finally(() => current && setSelectedOrderLoading(false));
    return () => {
      current = false;
      controller.abort();
    };
  }, [board?.businessDate, board?.revision, orderPrincipalScope, orderRefreshToken, propertyId, selectedOrderIdentity]);

  useEffect(() => {
    const memberLookup = selectedOrderIdentity
      && selectedOrderView
      && selectedOrderLoadedScope === orderPrincipalScope
      ? selectedOrderMemberLookup(selectedOrderView, propertyId, selectedOrderIdentity.stayId)
      : undefined;
    if (!memberLookup) {
      selectedMemberRequestGuard.invalidate();
      setSelectedMemberView(undefined);
      return;
    }

    const lease = selectedMemberRequestGuard.begin(memberLookup.scope);
    setSelectedMemberView(undefined);
    api.member(memberLookup.memberId, propertyId)
      .then((response) => {
        selectedMemberRequestGuard.runIfActive(lease, () => {
          if (response.member.id !== memberLookup.memberId) {
            setSelectedMemberView(undefined);
            return;
          }
          setSelectedMemberView(response);
        });
      })
      .catch(() => {
        selectedMemberRequestGuard.runIfActive(lease, () => setSelectedMemberView(undefined));
      });
    return () => selectedMemberRequestGuard.invalidate();
  }, [orderPrincipalScope, propertyId, selectedMemberRequestGuard, selectedOrderIdentity, selectedOrderLoadedScope, selectedOrderView]);

  useEffect(() => {
    setSelectedStayDateAction(undefined);
    setSelectedStayDateMode("DATE_CHANGE");
    setSelectedStayDateRevision(undefined);
    setSelectedMoveUnitOpen(false);
    setSelectedMoveUnitRevision(undefined);
    setSelectedLifecycleAction(undefined);
    setSelectedLifecycleRevision(undefined);
    setCommandDraft((current) => current?.presentation === "STAY_DATES"
      || current?.presentation === "MOVE_UNIT"
      || current?.presentation === "ORDER_LIFECYCLE" ? undefined : current);
  }, [selectedOrderIdentity?.orderId, selectedOrderIdentity?.stayId]);

  useEffect(() => {
    if (!command || selectedOrderCommandScopeIsCurrent(selectedOrderCommandScope, orderPrincipalScope, selectedOrderIdentity)) return;
    commandAttemptGuard.invalidate();
    commandPhaseRef.current = "IDLE";
    commandRevisionRef.current = undefined;
    commandQueryKeyRef.current = undefined;
    setCommand(undefined);
    setCommandDraft(undefined);
    setSelectedOrderCommandScope(undefined);
    setSelectedCorrectionOccupantId(undefined);
    setRecoveryDialogOpen(false);
    setActionError(new Error("当前命令绑定的门店、账号、订单或住宿已经变化，原操作已关闭；请重新选择后办理。"));
  }, [command, currentSelectedOrderCommandScope, selectedOrderCommandScope]);

  useEffect(() => {
    if (!selectedCorrectionOccupantId || !selectedCorrectionRevision || !board) return;
    if (board.revision === selectedCorrectionRevision) return;
    setSelectedCorrectionOccupantId(undefined);
    setSelectedCorrectionRevision(undefined);
    setActionError(new Error("订单资料已被其他操作刷新。为避免覆盖新值，原更正表单已关闭；请重新打开后核对。"));
  }, [board?.revision, selectedCorrectionOccupantId, selectedCorrectionRevision]);

  useEffect(() => {
    if (!selectedStayDateAction || !selectedStayDateRevision || !board) return;
    if (board.revision === selectedStayDateRevision) return;
    setSelectedStayDateAction(undefined);
    setSelectedStayDateMode("DATE_CHANGE");
    setSelectedStayDateRevision(undefined);
    setCommandDraft(undefined);
    setActionError(new Error("订单日期或房态已经变化。为避免使用旧数据，原日期表单已关闭；请重新打开后核对。"));
  }, [board?.revision, selectedStayDateAction, selectedStayDateRevision]);

  useEffect(() => {
    if (!selectedMoveUnitOpen || !selectedMoveUnitRevision || !board) return;
    if (board.revision === selectedMoveUnitRevision) return;
    setSelectedMoveUnitOpen(false);
    setSelectedMoveUnitRevision(undefined);
    setCommandDraft(undefined);
    setActionError(new Error("订单或房态已经变化。为避免使用旧数据，原换房表单已关闭；请重新打开后核对。"));
  }, [board?.revision, selectedMoveUnitOpen, selectedMoveUnitRevision]);

  useEffect(() => {
    if (!selectedLifecycleAction || !selectedLifecycleRevision || !board) return;
    if (board.revision === selectedLifecycleRevision) return;
    setSelectedLifecycleAction(undefined);
    setSelectedLifecycleRevision(undefined);
    setCommandDraft(undefined);
    setActionError(new Error("订单或房态已经变化。为避免处理错误订单，原操作表单已关闭；请重新选择后核对。"));
  }, [board?.revision, selectedLifecycleAction, selectedLifecycleRevision]);

  const boardMatchesCurrentProperty = Boolean(board && board.propertyId === propertyId);
  const currentBoardQueryKey = roomStatusQueryKey(roomStatusQuery(range, viewState.roomPageIndex, viewState.filters));
  const boardMatchesCurrentQuery = Boolean(board
    && board.propertyId === propertyId
    && boardQueryKey === currentBoardQueryKey);

  useEffect(() => {
    if (!board || !boardMatchesCurrentQuery) return;
    const delay = Math.max(0, Date.parse(board.freshUntil) - Date.now() + 1);
    const timer = window.setTimeout(() => setClock(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [board?.freshUntil]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      setClock(Date.now());
      if (!permissionDeniedRef.current
        && roomStatusProjectionRefreshAllowed(commandPhaseRef.current)
        && !queryAttemptGuard.isInFlight()) {
        setRefreshToken((value) => value + 1);
      }
    }, ROOM_STATUS_POLL_MS);
    const refreshVisible = () => {
      if (document.visibilityState !== "visible") return;
      setClock(Date.now());
      if (!permissionDeniedRef.current && !queryAttemptGuard.isInFlight()) {
        setRefreshToken((value) => value + 1);
      }
    };
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [propertyId]);

  useEffect(() => {
    if (previousPropertyId.current === propertyId && previousSubjectId.current === principal.subjectId) return;
    previousPropertyId.current = propertyId;
    previousSubjectId.current = principal.subjectId;
    permissionDeniedRef.current = false;
    const restored = readRoomStatusRestoration(principal.subjectId, propertyId);
    initialRestoration.current = restored;
    pendingRestoration.current = restored;
    setRestoreGridFocus(Boolean(restored));
    orderRestorationAttempted.current = false;
    restorationPagesVisited.current.clear();
    setRange(restoredOrDefaultRoomStatusRange(restored, propertyTimezone));
    dispatchView({ type: "RESTORE", state: restored?.state ?? createRoomStatusViewState() });
    setBoard(undefined);
    boardRef.current = undefined;
    setBoardQueryKey(undefined);
    boardQueryKeyRef.current = undefined;
    setQuickPopoverTarget(undefined);
    roomStatusInteractionSnapshotRef.current = undefined;
    setSelectedUnitId(undefined);
    setSelectedDayDate(undefined);
    setSelectedIntervalId(undefined);
    setSelectedGridStayId(undefined);
    setSelectedOrderIdentity(undefined);
    setSelectedOrderView(undefined);
    setSelectedOrderLoadedScope(undefined);
    setSelectedCorrectionOccupantId(undefined);
    setSelectedOrderCommandScope(undefined);
    setOrderContextOpen(false);
    setDesktopContextCollapsed(false);
    setQuoteTarget(undefined);
    setMaintenanceTarget(undefined);
    setMobileCreateOpen(false);
    setMobileFocusRequest(undefined);
    pendingMobileTaskFocus.current = undefined;
    commandPhaseRef.current = "IDLE";
    commandAttemptGuard.invalidate();
    commandRevisionRef.current = undefined;
    commandQueryKeyRef.current = undefined;
    focusAfterNextBoard.current = false;
    returnedOrderCellFocus.current = undefined;
    setCommandContextInvalidated(false);
    setCommand(undefined);
    setQueryError(undefined);
    setReturnNotice(undefined);
    setCommandNotice(undefined);
    setActionError(undefined);
    setQuoteRecoveryOutcome(undefined);
    setInitializedPropertyId(propertyId);
  }, [principal.subjectId, propertyId, propertyTimezone]);

  useEffect(() => {
    if (initializedPropertyId !== propertyId) return;
    const query = roomStatusQuery(range, viewState.roomPageIndex, viewState.filters);
    const requestQueryKey = roomStatusQueryKey(query);
    const requestId = queryAttemptGuard.begin();
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      controller.abort(new Error("房态查询超时，未把未知状态解释为可售"));
    }, ROOM_STATUS_QUERY_TIMEOUT_MS);
    const existing = boardRef.current;
    const sameQuery = existing?.propertyId === propertyId
      && boardQueryKeyRef.current === requestQueryKey;
    const projectionRefreshPaused = !roomStatusProjectionRefreshAllowed(commandPhaseRef.current) && Boolean(existing);
    if (!sameQuery) {
      setQueryPhase(existing ? "RANGE_LOADING" : "LOADING");
      setQueryError(undefined);
    } else if (!projectionRefreshPaused) {
      setQueryPhase("REFRESHING");
    }
    api.roomStatus(propertyId, query, controller.signal)
      .then((response) => {
        if (!queryAttemptGuard.isActive(requestId)) return;
        permissionDeniedRef.current = false;
        assertRoomStatusBoard(response, { propertyId, range, pageIndex: viewState.roomPageIndex });
        if (commandPhaseRef.current === "CONFIRMING" && existing) {
          setQueryError(undefined);
          setQueryPhase("READY");
          setClock(Date.now());
          return;
        }
        if (commandRevisionRef.current
          && commandPhaseRef.current !== "IDLE"
          && response.revision !== commandRevisionRef.current) {
          setCommandContextInvalidated(true);
        }
        const restored = pendingRestoration.current;
        if (restored && response.page.totalPages > 0 && response.page.index >= response.page.totalPages) {
          const pageIndex = response.page.totalPages - 1;
          pendingRestoration.current = {
            ...restored,
            state: { ...restored.state, roomPageIndex: pageIndex }
          };
          setBoard(undefined);
          boardRef.current = undefined;
          setBoardQueryKey(undefined);
          boardQueryKeyRef.current = undefined;
          setQueryPhase("LOADING");
          dispatchView({ type: "SET_ROOM_PAGE", index: pageIndex, totalPages: response.page.totalPages });
          return;
        }
        const restoredSelection = restored?.state.selection;
        if (restoredSelection && !findRoomStatusUnit(response, restoredSelection.unitId) && response.page.totalPages > 1) {
          restorationPagesVisited.current.add(response.page.index);
          const nextPage = Array.from({ length: response.page.totalPages }, (_, index) => index)
            .find((index) => !restorationPagesVisited.current.has(index));
          if (nextPage !== undefined) {
            pendingRestoration.current = {
              ...restored,
              state: { ...restored.state, roomPageIndex: nextPage }
            };
            setBoard(undefined);
            boardRef.current = undefined;
            setBoardQueryKey(undefined);
            boardQueryKeyRef.current = undefined;
            setQueryPhase("LOADING");
            dispatchView({ type: "SET_ROOM_PAGE", index: nextPage, totalPages: response.page.totalPages });
            return;
          }
        }
        restorationPagesVisited.current.clear();
        setBoard(response);
        boardRef.current = response;
        setBoardQueryKey(requestQueryKey);
        boardQueryKeyRef.current = requestQueryKey;
        setQueryError(undefined);
        setQueryPhase("READY");
        setClock(Date.now());
        setOrderRefreshToken((value) => value + 1);
        if (focusAfterNextBoard.current) {
          focusAfterNextBoard.current = false;
          setFocusRequestToken((value) => value + 1);
        }
        if (restored) {
          pendingRestoration.current = undefined;
          restorationPagesVisited.current.clear();
          const resolution = reconcileRoomStatusRestoration(response.rooms, response.dates, {
            ...restored.state,
            roomPageIndex: response.page.index
          }, restored.factFingerprint);
          dispatchView({ type: "RESTORE", state: resolution.state });
          if (resolution.outcome === "FACT_CHANGED") {
            setReturnNotice(restored.revision === response.revision
              ? "已重新校验返回位置。原选区的可售、状态、来源、冲突或允许动作已经变化；已保留选区供核对并将焦点移至选区起点。旧 Preview 不会继续使用。"
              : "房态数据已变化，且原选区的可售、状态、来源、冲突或允许动作已经变化；已保留选区供核对并将焦点移至选区起点。旧核对结果不会继续使用。");
          } else if (resolution.outcome === "FALLBACK") {
            setReturnNotice("当前筛选或日期范围已变化，已切换为当前可用的房态内容。");
          } else if (resolution.outcome === "EMPTY") {
            setReturnNotice("上次查看的位置已失效，已回到当前可用的房态内容。");
          } else {
            setReturnNotice(undefined);
          }
        }
      })
      .catch((error) => {
        if (!queryAttemptGuard.isActive(requestId)) return;
        setQueryError(error);
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          permissionDeniedRef.current = true;
          latestRestoration.current = undefined;
          setBoard(undefined);
          boardRef.current = undefined;
          setBoardQueryKey(undefined);
          boardQueryKeyRef.current = undefined;
          pendingRestoration.current = undefined;
          try {
            window.sessionStorage.removeItem(roomStatusRestorationKey(principal.subjectId, propertyId));
          } catch {
            // Permission denial still clears all in-memory business state.
          }
          dispatchView({ type: "RESTORE", state: createRoomStatusViewState() });
          setSelectedUnitId(undefined);
          setSelectedDayDate(undefined);
          setSelectedIntervalId(undefined);
          setSelectedOrderIdentity(undefined);
          setSelectedOrderView(undefined);
          setSelectedOrderLoadedScope(undefined);
          setSelectedCorrectionOccupantId(undefined);
          setSelectedOrderCommandScope(undefined);
          setOrderContextOpen(false);
          setDesktopContextCollapsed(false);
          setQuoteTarget(undefined);
          setMaintenanceTarget(undefined);
          setMobileCreateOpen(false);
          commandPhaseRef.current = "IDLE";
          commandAttemptGuard.invalidate();
          commandRevisionRef.current = undefined;
          commandQueryKeyRef.current = undefined;
          focusAfterNextBoard.current = false;
          setCommandContextInvalidated(false);
          setCommand(undefined);
          setRecoveryDialogOpen(false);
          setActionError(undefined);
          setReturnNotice(undefined);
          setRestorationError(undefined);
          setQueryPhase("PERMISSION_DENIED");
        } else {
          setQueryPhase("ERROR");
        }
      })
      .finally(() => {
        window.clearTimeout(timeout);
        queryAttemptGuard.finish(requestId);
      });
    return () => {
      window.clearTimeout(timeout);
      queryAttemptGuard.invalidate(requestId);
      controller.abort();
    };
  }, [
    initializedPropertyId,
    orderPrincipalScope,
    propertyId,
    range.arrivalDate,
    range.departureDate,
    refreshToken,
    viewState.roomPageIndex,
    viewState.filters.search,
    viewState.filters.roomTypeCode,
    viewState.filters.salesMode,
    viewState.filters.status,
    viewState.filters.kind,
    viewState.filters.minimumCapacity
  ]);

  useEffect(() => {
    if (!board || !boardMatchesCurrentQuery) return;
    const snapshot: RoomStatusRestorationSnapshot = {
      version: 1,
      propertyId,
      revision: board.revision,
      range,
      savedAt: new Date().toISOString(),
      state: viewState,
      factFingerprint: roomStatusFactFingerprint(board.rooms, viewState)
    };
    latestRestoration.current = { subjectId: principal.subjectId, snapshot };
    const timer = window.setTimeout(() => {
      const saved = writeRoomStatusRestoration(principal.subjectId, snapshot);
      setRestorationError(saved ? undefined : new Error("浏览器无法保存房态返回位置；本次业务事实未受影响"));
    }, 150);
    return () => window.clearTimeout(timer);
  }, [board, boardMatchesCurrentQuery, principal.subjectId, propertyId, range, viewState]);

  useEffect(() => () => {
    const latest = latestRestoration.current;
    if (latest
      && latest.subjectId === principal.subjectId
      && latest.snapshot.propertyId === propertyId) {
      writeRoomStatusRestoration(latest.subjectId, latest.snapshot);
    }
  }, [principal.subjectId, propertyId]);

  const boardForCurrentProperty = boardMatchesCurrentProperty ? board : undefined;
  const boardExpired = Boolean(boardForCurrentProperty && clock > Date.parse(boardForCurrentProperty.freshUntil));
  const boardRefreshFailed = Boolean(boardForCurrentProperty && queryError);
  const rangeLoading = queryPhase === "RANGE_LOADING"
    || Boolean(boardForCurrentProperty && !boardMatchesCurrentQuery);
  const queryBusy = queryPhase === "LOADING"
    || queryPhase === "RANGE_LOADING"
    || queryPhase === "REFRESHING"
    || Boolean(board && !boardMatchesCurrentQuery);
  const activeProjectionValid = Boolean(board
    && boardMatchesCurrentQuery
    && !queryError
    && !focusAfterNextBoard.current
    && board.projectionState === "READY"
    && board.accessLevel === "WRITE"
    && (queryPhase === "READY" || queryPhase === "REFRESHING"));
  const projectionWritable = activeProjectionValid && !boardExpired;
  const commandTargetScopeCurrent = selectedOrderCommandScopeIsCurrent(
    selectedOrderCommandScope,
    orderPrincipalScope,
    selectedOrderIdentity
  );
  const commandWriteGate = roomStatusCommandWriteGate({
    projectionWritable,
    activeProjectionValid,
    recoveryBlocked: commandRecovery.blocked,
    recoveryReady: commandRecovery.ready,
    recoveryError: commandRecovery.error,
    contextInvalidated: commandContextInvalidated,
    targetScopeCurrent: commandTargetScopeCurrent
  });
  const commandsBlocked = commandWriteGate.startBlocked;
  const activeCommandWriteBlocked = commandWriteGate.activeBlocked;
  useEffect(() => {
    if (!command || commandPhaseRef.current === "IDLE" || !commandQueryKeyRef.current) return;
    if (commandQueryKeyRef.current !== currentBoardQueryKey) setCommandContextInvalidated(true);
  }, [command, currentBoardQueryKey]);
  const renderedBoard = useMemo(
    () => boardForCurrentProperty
      ? displayRoomStatusBoard(boardForCurrentProperty, commandsBlocked && !command)
      : undefined,
    [boardForCurrentProperty, command, commandsBlocked]
  );
  const filteredViewHasNoRooms = Boolean(renderedBoard
    && hasActiveRoomStatusFilters(viewState.filters)
    && filterRoomStatusRooms(renderedBoard.rooms, viewState.filters).length === 0);
  const selectedUnit = findRoomStatusUnit(renderedBoard, selectedUnitId ?? viewState.selection?.unitId);
  const selectedDay = selectedUnit?.days.find((day) => day.serviceDate === selectedDayDate) ?? null;
  const selectedInterval = selectedUnit?.intervals.find((interval) => interval.id === selectedIntervalId) ?? null;
  const quickPopoverUnit = findRoomStatusUnit(renderedBoard, quickPopoverTarget?.unitId);
  const quickPopoverDay = quickPopoverUnit?.days.find((day) => day.serviceDate === quickPopoverTarget?.serviceDate) ?? null;
  const quickPopoverInterval = quickPopoverUnit?.intervals.find((interval) => (
    quickPopoverTarget?.intervalId
      ? interval.id === quickPopoverTarget.intervalId
      : interval.actualInventoryUnitId === quickPopoverUnit.id
        && interval.startDate <= quickPopoverTarget!.serviceDate
        && quickPopoverTarget!.serviceDate < interval.endDate
  )) ?? null;
  const quickPopoverStatus = quickPopoverInterval?.status ?? quickPopoverDay?.status ?? "UNKNOWN";
  const quickPopoverSelection = quickPopoverTarget?.selection ?? null;
  const quickPopoverActions = (quickPopoverSelection
    ? selectionActions(quickPopoverUnit, quickPopoverSelection)
    : quickPopoverInterval
      ? intervalActions(quickPopoverInterval, null)
      : dayActions(quickPopoverUnit, quickPopoverDay))
    .filter((action) => currentReleaseFeatures.cleaningWorkflow || action.code !== "COMPLETE_CLEANING");
  const quickPopoverOrders = quickPopoverUnit && quickPopoverTarget && !quickPopoverSelection
    ? roomStatusOrderOptionsForDate(quickPopoverUnit, quickPopoverTarget.serviceDate)
    : { kind: "READY" as const, orders: [] };
  const quickPopoverPreviewStayId = (quickPopoverInterval
    ? roomStatusOrderIdentityForInterval(quickPopoverInterval)?.stayId
    : undefined) ?? roomStatusUniqueOrderStayId(quickPopoverOrders);
  const selectedSelectionDays = selectionDays(selectedUnit, viewState.selection);
  const relatedIntervals = useMemo(() => {
    if (!selectedUnit) return [];
    const intervalIds = new Set(selectedInterval
      ? [selectedInterval.id]
      : viewState.selection
        ? selectedSelectionDays.flatMap((day) => day.intervalIds)
        : selectedDay?.intervalIds ?? []);
    return selectedUnit.intervals.filter((interval) => intervalIds.has(interval.id));
  }, [selectedDay?.intervalIds, selectedInterval, selectedSelectionDays, selectedUnit, viewState.selection]);
  const contextConflicts = uniqueConflicts(selectedInterval?.conflicts
    ?? (viewState.selection ? relatedIntervals.flatMap((interval) => interval.conflicts) : selectedDay?.conflicts ?? []));
  const candidateContextActions = selectedInterval
      ? intervalActions(selectedInterval, viewState.selection)
      : viewState.selection
        ? selectionActions(selectedUnit, viewState.selection)
        : dayActions(selectedUnit, selectedDay).filter((action) => action.enabled);
  const contextActions = projectionWritable || Boolean(command)
    ? candidateContextActions
    : candidateContextActions.filter((action) => action.code === "OPEN_ORDER");
  const useInlineOrderContext = roomStatusOrderContextMode(workspaceWidth, isMobile) === "INLINE";
  const authorizedSelectedOrderView = selectedOrderLoadedScope === orderPrincipalScope ? selectedOrderView : undefined;
  const selectedCorrectionOccupant = authorizedSelectedOrderView?.occupants.find((occupant) => occupant.id === selectedCorrectionOccupantId);

  useEffect(() => {
    if (!quickPopoverTarget) return;
    if (quickPopoverTarget.anchor.isConnected && quickPopoverUnit && (quickPopoverDay || quickPopoverInterval)) return;
    if (quickPopoverUnit && (quickPopoverDay || quickPopoverInterval)) {
      const detachedAnchor = quickPopoverTarget.anchor;
      const targetUnitId = quickPopoverTarget.unitId;
      const targetServiceDate = quickPopoverTarget.serviceDate;
      const replacementAnchor = [...(boardColumnRef.current?.querySelectorAll<HTMLElement>("[data-room-status-cell='true']") ?? [])]
        .find((anchor) => roomStatusAnchorMatches(anchor, targetUnitId, targetServiceDate));
      if (replacementAnchor) {
        const snapshot = roomStatusInteractionSnapshotRef.current;
        if (snapshot?.anchor === detachedAnchor) {
          roomStatusInteractionSnapshotRef.current = {
            ...snapshot,
            anchor: replacementAnchor,
            grid: replacementAnchor.closest<HTMLElement>(".room-status-grid-scroll")
          };
        }
        setQuickPopoverTarget((current) => (
          roomStatusQuickTargetMatches(current, targetUnitId, targetServiceDate)
            && current?.anchor === detachedAnchor
            ? { ...current, anchor: replacementAnchor }
            : current
        ));
        return;
      }
    }
    setQuickPopoverTarget(undefined);
    roomStatusInteractionSnapshotRef.current = undefined;
    dispatchView({ type: "SET_SELECTION", selection: null });
    if (renderedBoard) setReturnNotice("原房态格已不在当前页面，快捷操作已关闭。请重新选择房态格。");
  }, [quickPopoverDay, quickPopoverInterval, quickPopoverTarget, quickPopoverUnit, renderedBoard]);

  useEffect(() => {
    if (orderRestorationAttempted.current || !initialRestoration.current || !renderedBoard) return;
    orderRestorationAttempted.current = true;
    if (orderReturnEnvelopePresent.current) return;
    const restoredSelection = viewState.selection;
    if (!restoredSelection) return;
    const restoredUnit = findRoomStatusUnit(renderedBoard, restoredSelection.unitId);
    const identity = restoredUnit ? roomStatusOrderIdentityForDate(restoredUnit, restoredSelection.arrivalDate) : null;
    if (!identity) return;
    setSelectedUnitId(restoredUnit?.id);
    setSelectedDayDate(restoredSelection.arrivalDate);
    setSelectedIntervalId(identity.intervalId);
    setSelectedOrderIdentity(identity);
    setOrderContextOpen(true);
    setDesktopContextCollapsed(false);
    setFocusRequestToken((value) => value + 1);
  }, [renderedBoard, viewState.selection]);

  useEffect(() => {
    const target = returnedOrderCellFocus.current;
    if (!target || !orderContextOpen || selectedOrderIdentity?.unitId !== target.unitId) return;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        const cell = [...document.querySelectorAll<HTMLElement>("[data-room-status-cell='true']")]
          .find((candidate) => candidate.dataset.unitId === target.unitId
            && candidate.dataset.serviceDate === target.serviceDate);
        if (!cell) return;
        dispatchView({ type: "SET_FOCUS", focus: target });
        cell.scrollIntoView({ behavior: "auto", block: "nearest", inline: "nearest" });
        cell.focus({ preventScroll: true });
        if (cell.ownerDocument.activeElement === cell) returnedOrderCellFocus.current = undefined;
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [
    boardQueryKey,
    orderContextOpen,
    renderedBoard?.page.index,
    renderedBoard?.revision,
    selectedOrderIdentity?.unitId,
    viewState.dateWindowSize,
    viewState.dateWindowStart
  ]);

  useEffect(() => {
    const target = pendingOrderReturnTarget.current;
    if (!renderedBoard || !boardMatchesCurrentQuery || orderReturnResolutionStarted.current) return;
    if (!target) {
      if (!orderReturnEnvelopePresent.current) return;
      returnedOrderCellFocus.current = undefined;
      orderReturnEnvelopePresent.current = false;
      navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
      dispatchView({ type: "SET_SELECTION", selection: null });
      setReturnNotice("订单返回信息已损坏，未恢复旧的订单上下文。请按最新房态重新选择。");
      return;
    }
    if (target.propertyId !== propertyId) {
      returnedOrderCellFocus.current = undefined;
      pendingOrderReturnTarget.current = null;
      orderReturnEnvelopePresent.current = false;
      navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
      dispatchView({ type: "SET_SELECTION", selection: null });
      setReturnNotice("订单所属物业与当前房态不一致，未恢复订单上下文。请切换到正确物业后重新选择。");
      return;
    }
    orderReturnResolutionStarted.current = true;
    let current = true;
    let activeController: AbortController | undefined;
    const clearReturnedContext = () => {
      returnedOrderCellFocus.current = undefined;
      setSelectedUnitId(undefined);
      setSelectedDayDate(undefined);
      setSelectedIntervalId(undefined);
      setSelectedOrderIdentity(undefined);
      setSelectedOrderView(undefined);
      setSelectedOrderLoadedScope(undefined);
      setSelectedCorrectionOccupantId(undefined);
      setOrderContextOpen(false);
      dispatchView({ type: "SET_SELECTION", selection: null });
    };
    const consumeReturnState = () => {
      orderReturnEnvelopePresent.current = false;
      navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
    };
    const applyReturnedIdentity = (identity: RoomStatusOrderIdentity, pageIndex: number, totalPages: number) => {
      pendingOrderReturnTarget.current = null;
      orderReturnResolutionStarted.current = false;
      consumeReturnState();
      const parentRoomId = meta.inventoryUnits.find((candidate) => candidate.id === identity.unitId)?.parent_room_id;
      if (parentRoomId && !viewState.expandedRoomIds.includes(parentRoomId)) {
        dispatchView({ type: "TOGGLE_ROOM", roomId: parentRoomId });
      }
      const pageChanges = pageIndex !== renderedBoard.page.index;
      if (pageChanges) {
        dispatchView({ type: "SET_ROOM_PAGE", index: pageIndex, totalPages });
      }
      dispatchView({ type: "SET_FOCUS", focus: { unitId: identity.unitId, serviceDate: target.triggerDate } });
      dispatchView({
        type: "SET_DATE_WINDOW",
        start: dateWindowStartForFocus(
          renderedBoard.dates,
          viewState.dateWindowStart,
          viewState.dateWindowSize,
          target.triggerDate
        ),
        totalDates: renderedBoard.dates.length
      });
      returnedOrderCellFocus.current = { unitId: identity.unitId, serviceDate: target.triggerDate };
      selectOrderContextIdentity(identity, target.triggerDate);
      if (pageChanges) focusAfterNextBoard.current = true;
      else setFocusRequestToken((value) => value + 1);
      setReturnNotice("订单处理完成，已按最新房态恢复原住宿选择。");
    };
    const loadReturnPage = async (pageIndex: number) => {
      const controller = new AbortController();
      activeController = controller;
      const timeout = window.setTimeout(() => {
        controller.abort(new Error("恢复订单位置的房态查询超时"));
      }, ROOM_STATUS_QUERY_TIMEOUT_MS);
      try {
        return await api.roomStatus(propertyId, roomStatusQuery(range, pageIndex, viewState.filters), controller.signal);
      } finally {
        window.clearTimeout(timeout);
        if (activeController === controller) activeController = undefined;
      }
    };
    const resolveReturnedStay = async () => {
      if (renderedBoard.projectionState !== "READY") {
        throw new Error("最新房态投影不完整，不能安全恢复订单位置");
      }
      const boards = [renderedBoard];
      for (let pageIndex = 0; pageIndex < renderedBoard.page.totalPages; pageIndex += 1) {
        if (pageIndex === renderedBoard.page.index) continue;
        const response = await loadReturnPage(pageIndex);
        if (!current) return;
        assertRoomStatusBoard(response, { propertyId, range, pageIndex });
        if (response.revision !== renderedBoard.revision
          || response.businessDate !== renderedBoard.businessDate
          || response.accessLevel !== renderedBoard.accessLevel
          || response.projectionState !== renderedBoard.projectionState
          || response.page.size !== renderedBoard.page.size
          || response.page.totalRooms !== renderedBoard.page.totalRooms
          || response.page.totalPages !== renderedBoard.page.totalPages) {
          throw new Error("恢复订单位置期间房态分页事实已变化");
        }
        boards.push(response);
      }
      if (!current) return;
      const resolution = resolveRoomStatusOrderReturnTarget(
        boards.flatMap((candidate) => candidate.rooms.flatMap((room) => [room, ...room.children])),
        target
      );
      if (resolution.kind === "MATCH") {
        const targetBoard = boards.find((candidate) => candidate.rooms.some((room) => (
          room.id === resolution.identity.unitId
          || room.children.some((child) => child.id === resolution.identity.unitId)
        )));
        if (!targetBoard) throw new Error("恢复订单位置时未找到匹配房源分页");
        applyReturnedIdentity(resolution.identity, targetBoard.page.index, targetBoard.page.totalPages);
        return;
      }
      if (resolution.kind === "NOT_FOUND" && hasActiveRoomStatusFilters(viewState.filters)) {
        orderReturnResolutionStarted.current = false;
        dispatchView({ type: "CLEAR_FILTERS" });
        dispatchView({ type: "SET_ROOM_PAGE", index: 0, totalPages: renderedBoard.page.totalPages });
        setReturnNotice("原住宿不在当前筛选结果中，已清除筛选并继续恢复订单位置。");
        return;
      }
      pendingOrderReturnTarget.current = null;
      orderReturnResolutionStarted.current = false;
      consumeReturnState();
      clearReturnedContext();
      setReturnNotice(resolution.kind === "AMBIGUOUS"
        ? "订单处理完成，但最新房态存在多个相互冲突的住宿位置。已安全关闭订单上下文，请刷新后重新核对。"
        : "订单处理完成，但最新房态中找不到原住宿位置。已安全关闭订单上下文，请按最新房态重新选择。");
    };
    void resolveReturnedStay().catch((error: unknown) => {
      if (!current) return;
      pendingOrderReturnTarget.current = null;
      orderReturnResolutionStarted.current = false;
      consumeReturnState();
      clearReturnedContext();
      setActionError(error);
      setReturnNotice("订单处理完成，但暂时无法核对最新住宿位置。订单上下文已安全关闭，请按最新房态重新选择。");
    });
    return () => {
      current = false;
      activeController?.abort();
      orderReturnResolutionStarted.current = false;
    };
  }, [
    boardMatchesCurrentQuery,
    location.pathname,
    location.search,
    meta.inventoryUnits,
    navigate,
    propertyId,
    range.arrivalDate,
    range.departureDate,
    renderedBoard?.page.index,
    renderedBoard?.page.totalPages,
    renderedBoard?.revision,
    viewState.filters.kind,
    viewState.filters.minimumCapacity,
    viewState.filters.roomTypeCode,
    viewState.filters.salesMode,
    viewState.filters.search,
    viewState.filters.status,
    viewState.dateWindowSize,
    viewState.dateWindowStart,
    viewState.expandedRoomIds
  ]);

  useEffect(() => {
    if (command || !selectedOrderIdentity || !renderedBoard || !boardMatchesCurrentQuery) return;
    const identityOutsideCurrentRange = selectedOrderIdentity.departureDate <= renderedBoard.range.arrivalDate
      || selectedOrderIdentity.arrivalDate >= renderedBoard.range.departureDate;
    if (identityOutsideCurrentRange) return;
    const triggerDate = selectedDayDate
      && selectedOrderIdentity.arrivalDate <= selectedDayDate
      && selectedDayDate < selectedOrderIdentity.departureDate
      ? selectedDayDate
      : selectedOrderIdentity.arrivalDate;
    const target = {
      orderId: selectedOrderIdentity.orderId,
      stayId: selectedOrderIdentity.stayId,
      triggerDate
    };
    const currentResolution = resolveRoomStatusOrderReturnTarget(
      renderedBoard.rooms.flatMap((room) => [room, ...room.children]),
      target
    );
    if (currentResolution.kind === "MATCH") return;
    let current = true;
    const failClosed = (notice: string) => {
      setSelectedUnitId(undefined);
      setSelectedDayDate(undefined);
      setSelectedIntervalId(undefined);
      setSelectedGridStayId(undefined);
      setSelectedOrderIdentity(undefined);
      setSelectedOrderView(undefined);
      setSelectedOrderLoadedScope(undefined);
      setSelectedCorrectionOccupantId(undefined);
      setOrderContextOpen(false);
      roomStatusInteractionSnapshotRef.current = undefined;
      dispatchView({ type: "SET_SELECTION", selection: null });
      setReturnNotice(notice);
    };
    if (currentResolution.kind === "AMBIGUOUS") {
      failClosed("最新房态存在多个相互冲突的住宿位置，订单上下文已安全关闭。请刷新后重新核对。");
      return;
    }
    const sameFilters = (
      left: RoomStatusViewState["filters"],
      right: RoomStatusViewState["filters"]
    ) => roomStatusFilterKeys.every((key) => left[key] === right[key]);
    const assertSamePageSet = (candidate: RoomStatusBoardDto, baseline: RoomStatusBoardDto) => {
      if (candidate.revision !== baseline.revision
        || candidate.businessDate !== baseline.businessDate
        || candidate.accessLevel !== baseline.accessLevel
        || candidate.projectionState !== baseline.projectionState
        || candidate.page.size !== baseline.page.size
        || candidate.page.totalRooms !== baseline.page.totalRooms
        || candidate.page.totalPages !== baseline.page.totalPages) {
        throw new Error("定位换房结果期间房态分页事实已变化");
      }
    };
    const loadPage = async (pageIndex: number, filters: RoomStatusViewState["filters"]) => {
      const response = await api.roomStatus(propertyId, roomStatusQuery(range, pageIndex, filters));
      if (!current) return undefined;
      assertRoomStatusBoard(response, { propertyId, range, pageIndex });
      return response;
    };
    const loadPageSet = async (
      filters: RoomStatusViewState["filters"],
      seed?: RoomStatusBoardDto
    ) => {
      const baseline = seed ?? await loadPage(0, filters);
      if (!baseline || !current) return [];
      const boards = [baseline];
      for (let pageIndex = 0; pageIndex < baseline.page.totalPages; pageIndex += 1) {
        if (pageIndex === baseline.page.index) continue;
        const response = await loadPage(pageIndex, filters);
        if (!response || !current) return [];
        assertSamePageSet(response, baseline);
        boards.push(response);
      }
      return boards;
    };
    const resolveOnBoards = (boards: readonly RoomStatusBoardDto[]) => {
      const resolution = resolveRoomStatusOrderReturnTarget(
        boards.flatMap((candidate) => candidate.rooms.flatMap((room) => [room, ...room.children])),
        target
      );
      if (resolution.kind !== "MATCH") return { resolution } as const;
      const targetBoard = boards.find((candidate) => candidate.rooms.some((room) => (
        room.id === resolution.identity.unitId
        || room.children.some((child) => child.id === resolution.identity.unitId)
      )));
      return targetBoard
        ? { resolution, targetBoard } as const
        : { resolution: { kind: "NOT_FOUND" as const } } as const;
    };
    const applyMovedStay = (
      identity: RoomStatusOrderIdentity,
      targetBoard: RoomStatusBoardDto,
      filters: RoomStatusViewState["filters"]
    ) => {
      const filtersChanged = !sameFilters(filters, viewState.filters);
      const pageChanged = targetBoard.page.index !== renderedBoard.page.index;
      const parentRoomId = meta.inventoryUnits.find((candidate) => candidate.id === identity.unitId)?.parent_room_id;
      if (filtersChanged) dispatchView({ type: "SET_FILTERS", filters });
      if (parentRoomId && !viewState.expandedRoomIds.includes(parentRoomId)) {
        dispatchView({ type: "TOGGLE_ROOM", roomId: parentRoomId });
      }
      if (pageChanged || filtersChanged) {
        dispatchView({ type: "SET_ROOM_PAGE", index: targetBoard.page.index, totalPages: targetBoard.page.totalPages });
      }
      dispatchView({
        type: "SET_SELECTION",
        selection: {
          unitId: identity.unitId,
          anchorDate: triggerDate,
          focusDate: triggerDate,
          arrivalDate: identity.intervalStartDate,
          departureDate: identity.intervalEndDate
        }
      });
      dispatchView({ type: "SET_FOCUS", focus: { unitId: identity.unitId, serviceDate: triggerDate } });
      setSelectedUnitId(identity.unitId);
      setSelectedDayDate(triggerDate);
      setSelectedIntervalId(identity.intervalId);
      setSelectedGridStayId(identity.stayId);
      setSelectedOrderIdentity(identity);
      returnedOrderCellFocus.current = { unitId: identity.unitId, serviceDate: triggerDate };
      roomStatusInteractionSnapshotRef.current = undefined;
      if (pageChanged || filtersChanged) focusAfterNextBoard.current = true;
      else setFocusRequestToken((value) => value + 1);
      setReturnNotice(filtersChanged
        ? "住宿已移动到筛选外的房源；已仅清除遮挡目标的筛选条件，并保留订单上下文定位到最新安排。"
        : "房态数据已变化，住宿已移动到其他房源页；已保留订单上下文并定位到最新安排。");
    };
    const findMovedStay = async () => {
      const filteredBoards = await loadPageSet(viewState.filters, renderedBoard);
      if (!current) return;
      const filtered = resolveOnBoards(filteredBoards);
      if (filtered.resolution.kind === "MATCH" && filtered.targetBoard) {
        applyMovedStay(filtered.resolution.identity, filtered.targetBoard, viewState.filters);
        return;
      }
      if (filtered.resolution.kind === "AMBIGUOUS") {
        failClosed("最新房态存在多个相互冲突的住宿位置，订单上下文已安全关闭。请刷新后重新核对。");
        return;
      }
      if (!hasActiveRoomStatusFilters(viewState.filters)) {
        failClosed("原先选中的住宿已不在最新房态投影中，订单上下文已安全关闭。请按最新房态重新选择。");
        return;
      }
      const unfilteredBoards = await loadPageSet(DEFAULT_ROOM_STATUS_FILTERS);
      if (!current) return;
      const unfiltered = resolveOnBoards(unfilteredBoards);
      if (unfiltered.resolution.kind !== "MATCH" || !unfiltered.targetBoard) {
        failClosed(unfiltered.resolution.kind === "AMBIGUOUS"
          ? "最新房态存在多个相互冲突的住宿位置，订单上下文已安全关闭。请刷新后重新核对。"
          : "原先选中的住宿已不在最新房态投影中，订单上下文已安全关闭。请按最新房态重新选择。");
        return;
      }
      const targetRoom = unfiltered.targetBoard.rooms.find((room) => (
        room.id === unfiltered.resolution.identity.unitId
        || room.children.some((child) => child.id === unfiltered.resolution.identity.unitId)
      ));
      if (!targetRoom) throw new Error("定位换房结果时无法确认目标房源");
      const relaxedFilters = roomStatusFiltersRevealingTarget(viewState.filters, (candidate) => (
        filterRoomStatusRooms([targetRoom], candidate).some(({ room, children }) => (
          room.id === unfiltered.resolution.identity.unitId
          || children.some((child) => child.id === unfiltered.resolution.identity.unitId)
        ))
      ));
      const finalBoards = sameFilters(relaxedFilters, DEFAULT_ROOM_STATUS_FILTERS)
        ? unfilteredBoards
        : await loadPageSet(relaxedFilters);
      if (!current) return;
      const final = resolveOnBoards(finalBoards);
      if (final.resolution.kind !== "MATCH" || !final.targetBoard) {
        throw new Error("清除遮挡筛选后房态事实发生变化，未改写当前订单上下文");
      }
      applyMovedStay(final.resolution.identity, final.targetBoard, relaxedFilters);
    };
    void findMovedStay().catch((error: unknown) => {
      if (!current) return;
      setActionError(error);
      setReturnNotice("房态数据已变化，但暂时无法核对该住宿是否移动到其他房源页；订单上下文保持打开，请刷新后重试。");
    });
    return () => { current = false; };
  }, [
    boardMatchesCurrentQuery,
    command,
    meta.inventoryUnits,
    propertyId,
    range.arrivalDate,
    range.departureDate,
    renderedBoard,
    selectedDayDate,
    selectedOrderIdentity,
    viewState.expandedRoomIds,
    viewState.filters.kind,
    viewState.filters.minimumCapacity,
    viewState.filters.roomTypeCode,
    viewState.filters.salesMode,
    viewState.filters.search,
    viewState.filters.status
  ]);
  const policies = meta.pricingPolicyVersions.filter((policy) => policy.property_id === propertyId && policy.status === "PUBLISHED");
  const filterOptions = renderedBoard?.filterOptions ?? {
    roomTypeCodes: [],
    salesModes: [],
    statuses: [],
    capacities: []
  };
  const todayDate = localDateInTimeZone(propertyTimezone);
  const mobileGroups = useMemo(() => renderedBoard ? buildMobileGroups(renderedBoard) : { arrivals: [], inHouse: [], departures: [], exceptions: [] }, [renderedBoard]);
  const activeMobileTasks = mobileTab === "ARRIVALS"
    ? mobileGroups.arrivals
    : mobileTab === "IN_HOUSE"
      ? mobileGroups.inHouse
      : mobileTab === "DEPARTURES"
      ? mobileGroups.departures
      : mobileGroups.exceptions;
  const recoveryQuoteTarget: RoomStatusQuoteTarget | undefined = pageQuoteRecovery.kind === "VALID" ? {
    unitId: pageQuoteRecovery.pending.input.inventoryUnitId,
    arrivalDate: pageQuoteRecovery.pending.input.arrivalDate,
    departureDate: pageQuoteRecovery.pending.input.departureDate,
    initialStayType: pageQuoteRecovery.pending.input.stayType
      ?? paidStayTypeForDates(
        pageQuoteRecovery.pending.input.arrivalDate,
        pageQuoteRecovery.pending.input.departureDate
      )
  } : undefined;
  const activeQuoteTarget = recoveryQuoteTarget ?? quoteTarget;
  const quoteUnit = findRoomStatusUnit(renderedBoard, activeQuoteTarget?.unitId);
  const showQuoteWorkbench = Boolean(activeQuoteTarget) || pageQuoteRecovery.kind !== "ABSENT";
  const quoteActionUnit = activeQuoteTarget && quoteUnit ? actionUnit(quoteUnit, projectionWritable) : undefined;
  const quoteRecoveryDrawerOpen = quoteRecoveryContextOpen && pageQuoteRecovery.kind !== "ABSENT";
  const desktopContextKind = roomStatusDesktopContextKind(quoteRecoveryDrawerOpen, Boolean(selectedOrderIdentity));

  function clearTransientRoomStatusContext() {
    returnedOrderCellFocus.current = undefined;
    setQuickPopoverTarget(undefined);
    setSelectedUnitId(undefined);
    setSelectedDayDate(undefined);
    setSelectedIntervalId(undefined);
    setSelectedGridStayId(undefined);
    setSelectedOrderIdentity(undefined);
    setSelectedOrderView(undefined);
    setSelectedCorrectionOccupantId(undefined);
    setOrderContextOpen(false);
    setDesktopContextCollapsed(true);
    setQuoteRecoveryContextOpen(false);
    setQuoteTarget(undefined);
    setSelectionDraftValid(true);
    setMaintenanceTarget(undefined);
    setMobileCreateOpen(false);
    setActionError(undefined);
    setQuoteRecoveryOutcome(undefined);
  }

  function applyFilters(filters: typeof viewState.filters) {
    dispatchView({ type: "SET_FILTERS", filters });
    dispatchView({ type: "SET_ROOM_PAGE", index: 0, totalPages: board?.page.totalPages ?? 1 });
    clearTransientRoomStatusContext();
  }

  function clearFilters() {
    dispatchView({ type: "CLEAR_FILTERS" });
    dispatchView({ type: "SET_ROOM_PAGE", index: 0, totalPages: board?.page.totalPages ?? 1 });
    clearTransientRoomStatusContext();
    setFilterFocusRequestToken((value) => value + 1);
  }

  function applyRange(next: RoomStatusRange) {
    if (!isIsoLocalDate(next.arrivalDate) || !isIsoLocalDate(next.departureDate)) {
      setRangeError(new Error("请输入有效的开始日期和结束日期。"));
      return;
    }
    const nights = rangeNights(next);
    if (nights < 1) {
      setRangeError(new Error("结束日期必须晚于开始日期。"));
      return;
    }
    if (nights > ROOM_STATUS_TIMELINE_DAYS) {
      setRangeError(new Error(`房态首页每次显示 ${ROOM_STATUS_TIMELINE_DAYS} 夜。要建立更长住宿，请在右侧日期选区里填写完整入住和退房日期。`));
      return;
    }
    setRangeError(undefined);
    setRange(next);
    dispatchView({ type: "SET_ROOM_PAGE", index: 0, totalPages: 1 });
    dispatchView({ type: "SET_DATE_WINDOW", start: 0, totalDates: nights });
    clearTransientRoomStatusContext();
  }

  function shiftRange(direction: -1 | 1) {
    const nights = ROOM_STATUS_TIMELINE_DAYS;
    applyRange({
      arrivalDate: addLocalDateDays(range.arrivalDate, direction * nights),
      departureDate: addLocalDateDays(range.departureDate, direction * nights)
    });
  }

  function changeRoomPage(index: number, totalPages: number) {
    dispatchView({ type: "SET_ROOM_PAGE", index, totalPages });
    dispatchView({ type: "SET_SELECTION", selection: null });
    dispatchView({ type: "SET_FOCUS", focus: null });
    clearTransientRoomStatusContext();
  }

  function changeDateWindow(start: number, totalDates: number) {
    dispatchView({ type: "SET_DATE_WINDOW", start, totalDates });
    dispatchView({ type: "SET_SELECTION", selection: null });
    dispatchView({ type: "SET_FOCUS", focus: null });
    clearTransientRoomStatusContext();
  }

  function persistViewNow() {
    if (!board || !boardMatchesCurrentQuery) return;
    writeRoomStatusRestoration(principal.subjectId, {
      version: 1,
      propertyId,
      revision: board.revision,
      range,
      savedAt: new Date().toISOString(),
      state: viewState,
      factFingerprint: roomStatusFactFingerprint(board.rooms, viewState)
    });
  }

  function captureRoomStatusInteraction(
    anchor: HTMLElement,
    selection: RoomStatusSelection | null = viewState.selection
  ) {
    const cell = anchor.closest<HTMLElement>("[data-room-status-cell='true']");
    const unitId = cell?.dataset.unitId;
    const serviceDate = cell?.dataset.serviceDate;
    const grid = anchor.closest<HTMLElement>(".room-status-grid-scroll");
    roomStatusInteractionSnapshotRef.current = {
      anchor,
      selection: selection ? { ...selection } : null,
      focusedCell: unitId && serviceDate
        ? { unitId, serviceDate }
        : viewState.focusedCell ? { ...viewState.focusedCell } : null,
      windowX: window.scrollX,
      windowY: window.scrollY,
      grid,
      gridLeft: grid?.scrollLeft ?? 0,
      gridTop: grid?.scrollTop ?? 0
    };
  }

  function restoreRoomStatusInteraction() {
    const snapshot = roomStatusInteractionSnapshotRef.current;
    roomStatusInteractionSnapshotRef.current = undefined;
    if (!snapshot) {
      setFocusRequestToken((value) => value + 1);
      return;
    }
    dispatchView({ type: "SET_SELECTION", selection: snapshot.selection });
    dispatchView({ type: "SET_FOCUS", focus: snapshot.focusedCell });
    requestAnimationFrame(() => {
      snapshot.grid?.scrollTo({ left: snapshot.gridLeft, top: snapshot.gridTop, behavior: "auto" });
      window.scrollTo({ left: snapshot.windowX, top: snapshot.windowY, behavior: "auto" });
      if (snapshot.anchor.isConnected) snapshot.anchor.focus({ preventScroll: true });
      requestAnimationFrame(() => {
        snapshot.grid?.scrollTo({ left: snapshot.gridLeft, top: snapshot.gridTop, behavior: "auto" });
        window.scrollTo({ left: snapshot.windowX, top: snapshot.windowY, behavior: "auto" });
      });
    });
  }

  function invalidateSelectedOrderForRoomStatusInspection() {
    returnedOrderCellFocus.current = undefined;
    setSelectedOrderIdentity(undefined);
    setSelectedOrderView(undefined);
    selectedMemberRequestGuard.invalidate();
    setSelectedMemberView(undefined);
    setSelectedOrderLoadedScope(undefined);
    setSelectedOrderError(undefined);
    setSelectedOrderLoading(false);
    setSelectedCorrectionOccupantId(undefined);
    setSelectedCorrectionRevision(undefined);
    setSelectedStayDateAction(undefined);
    setSelectedStayDateMode("DATE_CHANGE");
    setSelectedStayDateRevision(undefined);
    setSelectedOrderCommandScope(undefined);
    setCommandDraft(undefined);
    setOrderContextOpen(false);
    setDesktopContextCollapsed(true);
  }

  function inspectUnit(unit: RoomStatusUnitDto) {
    setQuickPopoverTarget(undefined);
    setQuoteRecoveryOutcome(undefined);
    invalidateSelectedOrderForRoomStatusInspection();
    setSelectedUnitId(unit.id);
    setSelectedDayDate(undefined);
    setSelectedIntervalId(undefined);
    setSelectedGridStayId(undefined);
    setDesktopContextCollapsed(false);
  }

  function selectOrderContextIdentity(
    identity: RoomStatusOrderIdentity,
    serviceDate?: string,
    openContext = true
  ) {
    setQuickPopoverTarget(undefined);
    const sameOrder = selectedOrderIdentity?.orderId === identity.orderId
      && selectedOrderIdentity.stayId === identity.stayId;
    setActionError(undefined);
    setSelectedUnitId(identity.unitId);
    setSelectedDayDate(serviceDate);
    setSelectedIntervalId(identity.intervalId);
    setSelectedGridStayId(identity.stayId);
    setSelectedOrderIdentity(identity);
    if (!sameOrder) setSelectedOrderView(undefined);
    setSelectedCorrectionOccupantId(undefined);
    setQuoteTarget(undefined);
    setOrderContextOpen(openContext);
    setDesktopContextCollapsed(!openContext);
    const parentRoomId = meta.inventoryUnits.find((unit) => unit.id === identity.unitId)?.parent_room_id;
    if (parentRoomId && !viewState.expandedRoomIds.includes(parentRoomId)) {
      dispatchView({ type: "TOGGLE_ROOM", roomId: parentRoomId });
    }
    const requestedTriggerDate = serviceDate && identity.arrivalDate <= serviceDate && serviceDate < identity.departureDate
      ? serviceDate
      : identity.arrivalDate;
    const visibleArrivalDate = identity.arrivalDate < range.arrivalDate ? range.arrivalDate : identity.arrivalDate;
    const visibleDepartureDate = identity.departureDate > range.departureDate ? range.departureDate : identity.departureDate;
    if (visibleArrivalDate >= visibleDepartureDate) {
      dispatchView({ type: "SET_SELECTION", selection: null });
      return;
    }
    const triggerDate = requestedTriggerDate < visibleArrivalDate
      ? visibleArrivalDate
      : requestedTriggerDate >= visibleDepartureDate
        ? addLocalDateDays(visibleDepartureDate, -1)
        : requestedTriggerDate;
    dispatchView({
      type: "SET_SELECTION",
      selection: {
        unitId: identity.unitId,
        anchorDate: triggerDate,
        focusDate: triggerDate,
        arrivalDate: visibleArrivalDate,
        departureDate: visibleDepartureDate
      }
    });
  }

  function inspectDay(unit: RoomStatusUnitDto, day: RoomStatusDayDto | null, anchor: HTMLElement) {
    setQuoteRecoveryOutcome(undefined);
    setActionError(undefined);
    setReturnNotice(undefined);
    const serviceDate = day?.serviceDate ?? anchor.dataset.serviceDate;
    if (!serviceDate) {
      setActionError(new Error("当前房态格缺少营业日期，未打开快捷操作。请刷新后重试。"));
      return;
    }
    const triggerSelection = selectionFromCells(unit.id, serviceDate, serviceDate);
    const identity = roomStatusOrderIdentityForDate(unit, serviceDate);
    captureRoomStatusInteraction(anchor, triggerSelection);
    dispatchView({ type: "SET_SELECTION", selection: triggerSelection });
    invalidateSelectedOrderForRoomStatusInspection();
    setSelectedUnitId(unit.id);
    setSelectedDayDate(serviceDate);
    setSelectedIntervalId(undefined);
    setSelectedGridStayId(identity?.stayId);
    setQuoteTarget(undefined);
    setQuickPopoverTarget({ unitId: unit.id, serviceDate, anchor });
  }

  function inspectInterval(unit: RoomStatusUnitDto, interval: RoomStatusIntervalDto, anchor: HTMLElement, serviceDate: string) {
    setQuoteRecoveryOutcome(undefined);
    setActionError(undefined);
    setReturnNotice(undefined);
    const triggerSelection = selectionFromCells(unit.id, serviceDate, serviceDate);
    captureRoomStatusInteraction(anchor, triggerSelection);
    dispatchView({ type: "SET_SELECTION", selection: triggerSelection });
    invalidateSelectedOrderForRoomStatusInspection();
    setSelectedUnitId(unit.id);
    setSelectedDayDate(serviceDate);
    setSelectedIntervalId(interval.id);
    setSelectedGridStayId(roomStatusOrderIdentityForInterval(interval)?.stayId);
    setQuoteTarget(undefined);
    setQuickPopoverTarget({ unitId: unit.id, serviceDate, anchor, intervalId: interval.id });
  }

  function inspectSelection(unit: RoomStatusUnitDto, selection: RoomStatusSelection, anchor: HTMLElement) {
    const serviceDate = anchor.dataset.serviceDate;
    if (selection.unitId !== unit.id
      || anchor.dataset.unitId !== unit.id
      || !serviceDate
      || serviceDate < selection.arrivalDate
      || serviceDate >= selection.departureDate) {
      setActionError(new Error("当前日期选区与触发房态格不一致，未打开快捷操作。请重新选择。"));
      return;
    }
    setQuoteRecoveryOutcome(undefined);
    setActionError(undefined);
    setReturnNotice(undefined);
    captureRoomStatusInteraction(anchor, selection);
    dispatchView({ type: "SET_SELECTION", selection });
    invalidateSelectedOrderForRoomStatusInspection();
    setSelectedUnitId(unit.id);
    setSelectedDayDate(undefined);
    setSelectedIntervalId(undefined);
    setSelectedGridStayId(undefined);
    setQuoteTarget(undefined);
    setQuickPopoverTarget({ unitId: unit.id, serviceDate, anchor, selection });
  }

  function previewSelection(selection: RoomStatusSelection | null) {
    setQuickPopoverTarget(undefined);
    setQuoteRecoveryOutcome(undefined);
    setActionError(undefined);
    invalidateSelectedOrderForRoomStatusInspection();
    setQuoteTarget(undefined);
    setSelectionDraftValid(true);
    setSelectedGridStayId(undefined);
    dispatchView({ type: "SET_SELECTION", selection });
    if (selection) {
      setSelectedUnitId(selection.unitId);
      setSelectedDayDate(undefined);
      setSelectedIntervalId(undefined);
    }
  }

  function selectRange(selection: RoomStatusSelection | null) {
    setQuickPopoverTarget(undefined);
    setQuoteRecoveryOutcome(undefined);
    invalidateSelectedOrderForRoomStatusInspection();
    setSelectedGridStayId(undefined);
    dispatchView({ type: "SET_SELECTION", selection });
    setSelectionDraftValid(true);
    if (selection) {
      setDesktopContextCollapsed(false);
      setSelectedUnitId(selection.unitId);
      setQuoteTarget((current) => ({
        unitId: selection.unitId,
        arrivalDate: selection.arrivalDate,
        departureDate: selection.departureDate,
        initialStayType: current?.initialStayType === "FREE" ? "FREE" : "TRANSIENT"
      }));
    } else {
      setQuoteTarget(undefined);
    }
    setSelectedDayDate(undefined);
    setSelectedIntervalId(undefined);
  }

  function openReference(reference: { href: string | null }) {
    if (!reference.href) return;
    persistViewNow();
    if (reference.href.startsWith("/orders/")) {
      const state = selectedOrderIdentity && reference.href === `/orders/${selectedOrderIdentity.orderId}`
        ? createRoomStatusOrderReturnState(
            propertyId,
            selectedOrderIdentity,
            selectedDayDate ?? viewState.selection?.anchorDate
          )
        : { fromRoomStatus: true };
      navigate(reference.href, { state });
    }
    else window.open(reference.href, "_blank", "noopener,noreferrer");
  }

  function openSelectedOrder(actionCode?: string) {
    if (!selectedOrderIdentity) return;
    persistViewNow();
    const query = actionCode ? `?action=${encodeURIComponent(actionCode)}` : "";
    navigate(`/orders/${encodeURIComponent(selectedOrderIdentity.orderId)}${query}`, {
      state: createRoomStatusOrderReturnState(
        propertyId,
        selectedOrderIdentity,
        selectedDayDate ?? viewState.selection?.anchorDate
      )
    });
  }

  function startSelectedOrderFulfillment(commandType: "CHECK_IN" | "CHECK_OUT") {
    setActionError(undefined);
    const view = authorizedSelectedOrderView;
    const identity = selectedOrderIdentity;
    const action = view?.allowedActions.find((candidate) => candidate.code === commandType);
    if (!view || !identity || view.order.id !== identity.orderId || view.stay.id !== identity.stayId) {
      setActionError(new Error("当前订单上下文与房态住宿引用不一致，未发送办理命令。请重新选择住宿后再试。"));
      return;
    }
    if (commandsBlocked || view.accessLevel !== "WRITE") {
      setActionError(new Error("当前房态或订单权限不允许写入，未发送办理命令。请刷新后重新核对。"));
      return;
    }
    if (!action?.enabled) {
      setActionError(new Error("服务端当前未允许这项办理操作，未发送命令。请刷新订单状态后重新核对。"));
      return;
    }
    const started = startCommand({
      commandType,
      title: commandType === "CHECK_IN" ? "办理入住" : "办理退房",
      description: commandType === "CHECK_IN"
        ? "核对后将住宿状态更新为在住；会员住宿会同时核销本次仍冻结的权益。"
        : "核对后将住宿状态更新为已退房并释放后续住宿库存；退房不会重复核销会员权益。",
      presentation: "FULFILLMENT",
      input: { propertyId: view.order.property_id, orderId: view.order.id }
    }, roomStatusOrderCommandScope(orderPrincipalScope, identity));
    if (!started) setSelectedOrderCommandScope(undefined);
  }

  function startSelectedOrderDateAction(commandType: StayDateChangeAction, mode: StayDateChangeMode = "DATE_CHANGE") {
    setActionError(undefined);
    const view = authorizedSelectedOrderView;
    const identity = selectedOrderIdentity;
    const action = view?.allowedActions.find((candidate) => candidate.code === commandType);
    if (!view || !identity || view.order.id !== identity.orderId || view.stay.id !== identity.stayId) {
      setActionError(new Error("当前订单上下文与房态住宿引用不一致，未打开日期调整。请重新选择住宿后再试。"));
      return;
    }
    if (commandsBlocked || view.accessLevel !== "WRITE") {
      setActionError(new Error("当前房态或订单权限不允许写入，未打开日期调整。请刷新后重新核对。"));
      return;
    }
    if (!action?.enabled) {
      setActionError(new Error("服务端当前未允许这项日期调整，未发送命令。请刷新订单状态后重新核对。"));
      return;
    }
    setCommandDraft(undefined);
    setSelectedStayDateMode(mode);
    setSelectedStayDateAction(commandType);
    setSelectedStayDateRevision(boardRef.current?.revision);
    setSelectedOrderCommandScope(roomStatusOrderCommandScope(orderPrincipalScope, identity));
  }

  function startSelectedOrderMoveUnit() {
    setActionError(undefined);
    const view = authorizedSelectedOrderView;
    const identity = selectedOrderIdentity;
    const action = view?.allowedActions.find((candidate) => candidate.code === "MOVE_UNIT");
    if (!view || !identity || view.order.id !== identity.orderId || view.stay.id !== identity.stayId) {
      setActionError(new Error("当前订单上下文与房态住宿引用不一致，未打开换房。请重新选择住宿后再试。"));
      return;
    }
    if (commandsBlocked || view.accessLevel !== "WRITE" || !action?.enabled) {
      setActionError(new Error("服务端当前未允许办理换房，未打开表单。请刷新订单状态后重新核对。"));
      return;
    }
    setCommandDraft(undefined);
    setSelectedMoveUnitOpen(true);
    setSelectedMoveUnitRevision(boardRef.current?.revision);
    setSelectedOrderCommandScope(roomStatusOrderCommandScope(orderPrincipalScope, identity));
  }

  function startSelectedOrderLifecycleAction(commandType: OrderLifecycleAction) {
    setActionError(undefined);
    const view = authorizedSelectedOrderView;
    const identity = selectedOrderIdentity;
    const action = view?.allowedActions.find((candidate) => candidate.code === commandType);
    if (!view || !identity || view.order.id !== identity.orderId || view.stay.id !== identity.stayId) {
      setActionError(new Error("当前订单上下文与房态住宿引用不一致，未打开操作表单。请重新选择住宿后再试。"));
      return;
    }
    if (commandsBlocked || view.accessLevel !== "WRITE" || !action?.enabled) {
      setActionError(new Error("服务端当前未允许这项订单操作，未打开表单。请刷新订单状态后重新核对。"));
      return;
    }
    setCommandDraft(undefined);
    setSelectedLifecycleAction(commandType);
    setSelectedLifecycleRevision(boardRef.current?.revision);
    setSelectedOrderCommandScope(roomStatusOrderCommandScope(orderPrincipalScope, identity));
  }

  function closeSelectedOrderContext() {
    returnedOrderCellFocus.current = undefined;
    setSelectedCorrectionOccupantId(undefined);
    setOrderContextOpen(false);
    setDesktopContextCollapsed(true);
    restoreRoomStatusInteraction();
  }

  function closeDesktopContext() {
    if (quoteRecoveryContextOpen) {
      setDismissedQuoteRecoveryIdentity(currentQuoteRecoveryIdentity);
      setQuoteRecoveryContextOpen(false);
      setDesktopContextCollapsed(true);
      restoreRoomStatusInteraction();
      return;
    }
    if (pageQuoteRecovery.kind !== "ABSENT") return;
    returnedOrderCellFocus.current = undefined;
    setDesktopContextCollapsed(true);
    if (selectedOrderIdentity) setOrderContextOpen(false);
    restoreRoomStatusInteraction();
  }

  function reopenDesktopContext() {
    if (pageQuoteRecovery.kind !== "ABSENT") {
      openQuoteRecoveryContext();
      return;
    }
    setDesktopContextCollapsed(false);
    if (selectedOrderIdentity) {
      dispatchView({ type: "SET_SELECTION", selection: null });
      setOrderContextOpen(true);
    }
  }

  function openQuoteRecoveryContext() {
    setQuickPopoverTarget(undefined);
    setMobileCreateOpen(false);
    setOrderContextOpen(false);
    setDismissedQuoteRecoveryIdentity(undefined);
    setQuoteRecoveryContextOpen(true);
    setDesktopContextCollapsed(false);
    requestAnimationFrame(() => quoteSectionRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
  }

  function closeQuoteWorkbench() {
    if (pageQuoteRecovery.kind !== "ABSENT") {
      setDismissedQuoteRecoveryIdentity(currentQuoteRecoveryIdentity);
      setQuoteRecoveryContextOpen(false);
      setDesktopContextCollapsed(true);
      restoreRoomStatusInteraction();
      return;
    }
    setQuoteTarget(undefined);
  }

  async function locateOrderRange(target: { inventoryUnitId: string; arrivalDate: string; departureDate: string }) {
    if (!renderedBoard) return;
    const visibleArrivalDate = target.arrivalDate < range.arrivalDate ? range.arrivalDate : target.arrivalDate;
    const visibleDepartureDate = target.departureDate > range.departureDate ? range.departureDate : target.departureDate;
    if (visibleArrivalDate >= visibleDepartureDate) {
      setActionError(new Error(`该次变更位于当前日期范围之外（${target.arrivalDate} 至 ${target.departureDate}）。请先调整房态日期范围后再定位。`));
      return;
    }
    let targetPage = findRoomStatusUnit(renderedBoard, target.inventoryUnitId)
      ? renderedBoard.page.index
      : undefined;
    try {
      if (targetPage === undefined) {
        for (let pageIndex = 0; pageIndex < renderedBoard.page.totalPages; pageIndex += 1) {
          if (pageIndex === renderedBoard.page.index) continue;
          const response = await api.roomStatus(propertyId, roomStatusQuery(range, pageIndex, viewState.filters));
          assertRoomStatusBoard(response, { propertyId, range, pageIndex });
          if (findRoomStatusUnit(response, target.inventoryUnitId)) {
            targetPage = pageIndex;
            break;
          }
        }
      }
      if (targetPage === undefined) {
        setActionError(new Error("该次变更对应的房源不在当前筛选结果中，未制造不可见选区。请清除筛选后重试定位。"));
        return;
      }
      if (targetPage !== renderedBoard.page.index) {
        dispatchView({ type: "SET_ROOM_PAGE", index: targetPage, totalPages: renderedBoard.page.totalPages });
      }
      const segmentUnit = meta.inventoryUnits.find((unit) => unit.id === target.inventoryUnitId);
      if (segmentUnit?.parent_room_id && !viewState.expandedRoomIds.includes(segmentUnit.parent_room_id)) {
        dispatchView({ type: "TOGGLE_ROOM", roomId: segmentUnit.parent_room_id });
      }
      dispatchView({
        type: "SET_SELECTION",
        selection: {
          unitId: target.inventoryUnitId,
          anchorDate: visibleArrivalDate,
          focusDate: visibleArrivalDate,
          arrivalDate: visibleArrivalDate,
          departureDate: visibleDepartureDate
        }
      });
      dispatchView({ type: "SET_FOCUS", focus: { unitId: target.inventoryUnitId, serviceDate: visibleArrivalDate } });
      dispatchView({
        type: "SET_DATE_WINDOW",
        start: dateWindowStartForFocus(renderedBoard.dates, viewState.dateWindowStart, viewState.dateWindowSize, visibleArrivalDate),
        totalDates: renderedBoard.dates.length
      });
      setSelectedUnitId(target.inventoryUnitId);
      setSelectedDayDate(visibleArrivalDate);
      if (!useInlineOrderContext) {
        setOrderContextOpen(false);
        setDesktopContextCollapsed(true);
      }
      setFocusRequestToken((value) => value + 1);
    } catch (error) {
      setActionError(error);
    }
  }

  function startCommand(request: CommandRequest, targetScope = orderPrincipalScope): boolean {
    if (commandsBlocked) {
      setActionError(new Error("当前房态已陈旧、正在刷新、权限已收窄或命令恢复尚未收口；命令未发送，表单草稿保持不变。"));
      return false;
    }
    const attemptId = commandAttemptGuard.begin();
    setCommandAttemptId(attemptId);
    commandPhaseRef.current = "DRAFT";
    commandRevisionRef.current = boardRef.current?.revision;
    commandQueryKeyRef.current = boardQueryKeyRef.current;
    setCommandContextInvalidated(false);
    setRecoveryDialogOpen(false);
    setActionError(undefined);
    setCommandDraft(undefined);
    setSelectedOrderCommandScope(targetScope);
    setCommand(request);
    return true;
  }

  function handleAction(
    action: RoomStatusActionDto,
    unitOverride?: RoomStatusUnitDto | null,
    selectionOverride?: RoomStatusSelection | null,
    unitReferenceLabel?: string
  ): boolean {
    setActionError(undefined);
    if (action.code === "OPEN_ORDER") {
      if (!action.targetReference) return false;
      openReference(action.targetReference);
      return true;
    }
    const actionSelectedUnit = unitOverride === undefined ? selectedUnit : unitOverride;
    if (commandsBlocked) {
      setActionError(new Error("当前房态不再满足安全写入条件。未发送命令，请刷新后重新核对选区。"));
      return false;
    }
    const selection = selectionOverride ?? viewState.selection;
    if (action.code === "CREATE_ORDER" || action.code === "CREATE_FREE_STAY" || action.code === "LOCK_MAINTENANCE") {
      if (!actionSelectedUnit || !selection || selection.unitId !== actionSelectedUnit.id) {
        setActionError(new Error("请选择一个完整的房源与半开日期区间"));
        return false;
      }
      const unit = actionUnit(actionSelectedUnit, true);
      if (action.code === "CREATE_ORDER" || action.code === "CREATE_FREE_STAY") {
        setQuoteRecoveryOutcome(undefined);
        setQuoteTarget({
          unitId: unit.id,
          arrivalDate: selection.arrivalDate,
          departureDate: selection.departureDate,
          initialStayType: action.code === "CREATE_FREE_STAY" ? "FREE" : "TRANSIENT"
        });
        requestAnimationFrame(() => quoteSectionRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
      } else {
        setQuoteTarget(undefined);
        setMaintenanceTarget(unit);
      }
      return true;
    }
    const targetId = action.targetReference?.id;
    const unitLabel = actionSelectedUnit?.code ?? unitReferenceLabel;
    if (!targetId || !unitLabel) {
      setActionError(new Error("服务端动作缺少稳定目标引用，未发送命令"));
      return false;
    }
    if (action.code === "RELEASE_MAINTENANCE") {
      return startCommand({
        commandType: "RELEASE_MAINTENANCE",
        title: `释放维修锁 · ${unitLabel}`,
        description: "系统将重新核对完整维修锁房，确认后释放对应日期的房源库存。",
        input: { propertyId, maintenanceLockId: targetId }
      });
    } else if (currentReleaseFeatures.cleaningWorkflow && action.code === "COMPLETE_CLEANING") {
      return startCommand({
        commandType: "COMPLETE_CLEANING",
        title: `完成清洁 · ${unitLabel}`,
        description: "核对后将当前清洁任务更新为已完成；住宿历史和既有库存事实保持不变。",
        presentation: "FULFILLMENT",
        input: { propertyId, cleaningTaskId: targetId }
      });
    }
    return false;
  }

  function openRecoveryDialog() {
    if (!commandRecovery.pending) return;
    const recoveryOrderId = commandRecovery.pending.targetRefs
      .find((reference) => reference.startsWith("orderId="))
      ?.slice("orderId=".length);
    const recoveryMatchesSelectedOrder = Boolean(
      recoveryOrderId
      && selectedOrderIdentity?.orderId === recoveryOrderId
    );
    if ((commandRecovery.pending.presentation === "FULFILLMENT" || commandRecovery.pending.presentation === "STAY_DATES" || commandRecovery.pending.presentation === "MOVE_UNIT") && !recoveryMatchesSelectedOrder) {
      setSelectedOrderIdentity(undefined);
      setSelectedOrderView(undefined);
      setSelectedOrderLoadedScope(undefined);
      setSelectedOrderError(undefined);
      setSelectedOrderLoading(false);
      setOrderContextOpen(false);
    }
    const attemptId = commandAttemptGuard.begin();
    setCommandAttemptId(attemptId);
    commandPhaseRef.current = "CONFIRMING";
    commandRevisionRef.current = boardRef.current?.revision;
    commandQueryKeyRef.current = boardQueryKeyRef.current;
    setCommandContextInvalidated(false);
    setRecoveryDialogOpen(true);
    setSelectedOrderCommandScope(recoveryMatchesSelectedOrder
      ? roomStatusOrderCommandScope(orderPrincipalScope, selectedOrderIdentity)
      : orderPrincipalScope);
    setCommand(recoveryCommandRequest(commandRecovery.pending));
  }

  async function closeCommandDialog(context?: CommandDialogCloseContext) {
    let refreshAfterClose = context?.receipt.businessCommitted === true;
    const pendingAtClose = commandRecovery.pending;
    const terminalAtClose = Boolean(context || (pendingAtClose && isTerminalCommandRecovery(pendingAtClose.state)));
    if (terminalAtClose) {
      refreshAfterClose ||= pendingAtClose?.state === "EXECUTED";
      if (refreshAfterClose && (pendingAtClose?.commandType === "CREATE_ORDER" || command?.commandType === "CREATE_ORDER")) {
        setQuoteResetToken((value) => value + 1);
        setQuoteTarget(undefined);
      }
      if (await commandRecovery.clearResolved()) setRecoveryError(undefined);
      else setRecoveryError(new Error("无法清除已收口的本地恢复记录；为避免重复库存写入，命令继续保持暂停"));
    }
    commandAttemptGuard.invalidate();
    commandPhaseRef.current = "IDLE";
    commandRevisionRef.current = undefined;
    commandQueryKeyRef.current = undefined;
    setCommand(undefined);
    setSelectedOrderCommandScope(undefined);
    setRecoveryDialogOpen(false);
    if (refreshAfterClose) {
      if (pendingMobileTaskFocus.current) {
        setMobileFocusRequest({
          ...pendingMobileTaskFocus.current,
          token: ++mobileFocusSequence.current
        });
      } else if (viewState.selection) {
        dispatchView({
          type: "SET_FOCUS",
          focus: { unitId: viewState.selection.unitId, serviceDate: viewState.selection.arrivalDate }
        });
      }
      focusAfterNextBoard.current = true;
      setRefreshToken((value) => value + 1);
    } else if (commandContextInvalidated) {
      setFocusRequestToken((value) => value + 1);
    }
    if (!pendingAtClose || terminalAtClose) pendingMobileTaskFocus.current = undefined;
    setCommandContextInvalidated(false);
  }

  function trackCommandProgress(request: CommandRequest, progress: CommandDialogProgress, attemptId: number): boolean | Promise<boolean> {
    commandAttemptGuard.runIfActive(attemptId, () => {
      if (progress.state === "PREVIEWING" || progress.state === "PREVIEWED") commandPhaseRef.current = "PREVIEW";
      else if (progress.state === "CONFIRMING" || progress.state === "UNKNOWN") commandPhaseRef.current = "CONFIRMING";
      else if (progress.state === "RESOLVED") commandPhaseRef.current = "SETTLED";
      else if (progress.state === "PREVIEW_FAILED" || progress.state === "PREVIEW_UNKNOWN" || progress.state === "FAILED_NOT_EXECUTED") commandPhaseRef.current = "DRAFT";
    });
    return commandRecovery.track(request, progress);
  }

  function returnCommandToEdit(request: CommandRequest) {
    setCommandDraft(request);
    if (request.commandType === "CANCEL_ORDER" || request.commandType === "MARK_NO_SHOW" || request.commandType === "REVOKE_CHECK_IN") {
      if (authorizedSelectedOrderView) {
        setSelectedLifecycleAction(request.commandType);
        setSelectedLifecycleRevision(boardRef.current?.revision);
      }
      return;
    }
    if (request.commandType === "RESCHEDULE_STAY" || request.commandType === "EXTEND_STAY" || request.commandType === "SHORTEN_STAY") {
      if (authorizedSelectedOrderView) {
        setSelectedStayDateAction(request.commandType);
        setSelectedStayDateMode(
          authorizedSelectedOrderView.order.status === "CHECKED_IN"
            ? "ADJUST_DEPARTURE"
            : "DATE_CHANGE"
        );
        setSelectedStayDateRevision(boardRef.current?.revision);
      }
      return;
    }
    if (request.commandType === "MOVE_UNIT") {
      if (authorizedSelectedOrderView) {
        setSelectedMoveUnitOpen(true);
        setSelectedMoveUnitRevision(boardRef.current?.revision);
      }
      return;
    }
    if (request.commandType === "CORRECT_ORDER_OCCUPANT") {
      const occupantId = request.input.occupantId;
      if (typeof occupantId === "string" && authorizedSelectedOrderView?.occupants.some((occupant) => occupant.id === occupantId)) {
        setSelectedCorrectionOccupantId(occupantId);
        setSelectedCorrectionRevision(boardRef.current?.revision);
      }
    }
  }

  async function refreshCommittedRoomStatus(receipt: ReceiptDto) {
    if (!receipt.businessCommitted || refreshedReceiptIdRef.current === receipt.receiptId) return;
    commandPhaseRef.current = "SETTLED";
    const query = roomStatusQuery(range, viewState.roomPageIndex, viewState.filters);
    const response = await api.roomStatus(propertyId, query);
    assertRoomStatusBoard(response, { propertyId, range, pageIndex: viewState.roomPageIndex });
    setBoard(response);
    boardRef.current = response;
    const queryKey = roomStatusQueryKey(query);
    setBoardQueryKey(queryKey);
    boardQueryKeyRef.current = queryKey;
    setQueryError(undefined);
    setQueryPhase("READY");
    setClock(Date.now());
    if (selectedOrderIdentity) {
      const orderResponse = await api.order(selectedOrderIdentity.orderId);
      if (orderResponse.order.property_id !== propertyId || orderResponse.stay.id !== selectedOrderIdentity.stayId) {
        throw new Error("刷新后的订单上下文与当前房态引用不一致");
      }
      setSelectedOrderView(orderResponse);
      setSelectedOrderLoadedScope(orderPrincipalScope);
      const effective = orderResponse.effectiveArrangement;
      const triggerDate = selectedDayDate
        && effective.arrivalDate <= selectedDayDate
        && selectedDayDate < effective.departureDate
        ? selectedDayDate
        : effective.arrivalDate;
      const refreshedIdentity = resolveRoomStatusOrderReturnTarget(
        response.rooms.flatMap((room) => [room, ...room.children]),
        { orderId: selectedOrderIdentity.orderId, stayId: selectedOrderIdentity.stayId, triggerDate }
      );
      if (refreshedIdentity.kind === "AMBIGUOUS") {
        throw new Error("刷新后的房态存在多个相互冲突的住宿位置，无法安全恢复选择");
      }
      setSelectedDayDate(triggerDate);
      if (refreshedIdentity.kind === "MATCH") {
        selectOrderContextIdentity(refreshedIdentity.identity, triggerDate, orderContextOpen);
        returnedOrderCellFocus.current = { unitId: refreshedIdentity.identity.unitId, serviceDate: triggerDate };
        setFocusRequestToken((value) => value + 1);
      }
    }
    refreshedReceiptIdRef.current = receipt.receiptId;
  }

  const roomStatusToolbar = renderedBoard ? (
    <RoomStatusToolbar
      filters={viewState.filters}
      filterOptions={filterOptions}
      loading={queryBusy}
      focusSearchRequestToken={filterFocusRequestToken}
      onFiltersChange={applyFilters}
      onClearFilters={clearFilters}
      onRefresh={() => setRefreshToken((value) => value + 1)}
    />
  ) : null;

  const selectedOrderContext = selectedOrderIdentity ? (
    authorizedSelectedOrderView ? (
      <RoomStatusOrderContext
        view={authorizedSelectedOrderView}
        units={meta.inventoryUnits}
        {...(selectedMemberView ? { memberView: selectedMemberView } : {})}
        loading={false}
        writeBlocked={selectedOrderLoading || commandsBlocked || authorizedSelectedOrderView.accessLevel !== "WRITE"}
        primaryActionPlacement={isMobile || !useInlineOrderContext ? "DRAWER_FOOTER" : "CONTENT"}
        onClose={closeSelectedOrderContext}
        onOpenOrder={openSelectedOrder}
        onOpenMember={({ memberId, contractId }) => navigate(`/members?memberId=${encodeURIComponent(memberId)}&contractId=${encodeURIComponent(contractId)}`)}
        onFulfillmentAction={startSelectedOrderFulfillment}
        onLifecycleAction={startSelectedOrderLifecycleAction}
        onDateAction={startSelectedOrderDateAction}
        onMoveUnit={startSelectedOrderMoveUnit}
        onCorrectOccupant={(occupant) => {
          setCommandDraft(undefined);
          setSelectedCorrectionOccupantId(occupant.id);
          setSelectedCorrectionRevision(board?.revision);
        }}
        onLocateRange={(target) => { void locateOrderRange(target); }}
      />
    ) : (
      <aside className="room-status-context room-status-order-context" aria-label="订单上下文">
        <header className="room-status-context-header"><div><span>选中对象上下文</span><h2>订单上下文</h2></div><button type="button" className="room-status-icon-button" onClick={closeSelectedOrderContext} aria-label="关闭订单上下文" title="关闭订单上下文"><X aria-hidden="true" size={17} /></button></header>
        {selectedOrderLoading || !selectedOrderError ? <LoadingBlock label="正在载入权威订单上下文" /> : <InlineError error={selectedOrderError} title="订单上下文不可用" />}
      </aside>
    )
  ) : null;

  const desktopSelectionContext = renderedBoard ? (
    <>
      <RoomStatusContext
        board={renderedBoard}
        selectedUnit={selectedUnit}
        selectedDay={selectedDay}
        selectedInterval={selectedInterval}
        relatedIntervals={relatedIntervals}
        selection={viewState.selection}
        conflicts={contextConflicts}
        allowedActions={contextActions}
        onSelectedUnitChange={inspectUnit}
        onSelectionChange={selectRange}
        onDraftValidityChange={setSelectionDraftValid}
        onOpenReference={openReference}
        onOpenReceipt={(receiptId) => window.open(`/api/v1/receipts/${encodeURIComponent(receiptId)}`, "_blank", "noopener,noreferrer")}
        onAction={handleAction}
        {...(useInlineOrderContext ? { onClose: closeDesktopContext } : {})}
      />
      {showQuoteWorkbench ? (
        <div className="room-status-quote-section" ref={quoteSectionRef}>
          <QuoteWorkbench
            unit={quoteActionUnit}
            arrivalDate={activeQuoteTarget?.arrivalDate ?? range.arrivalDate}
            departureDate={activeQuoteTarget?.departureDate ?? range.departureDate}
            policies={policies}
            {...(activeQuoteTarget ? { initialStayType: activeQuoteTarget.initialStayType } : {})}
            commandsBlocked={commandsBlocked}
            selectionDraftValid={selectionDraftValid}
            resetToken={quoteResetToken}
            onClose={closeQuoteWorkbench}
            onRecoveryOutcome={setQuoteRecoveryOutcome}
            onRecoveryStateChange={() => {
              if (recoveryQuoteTarget) setQuoteTarget(recoveryQuoteTarget);
              setPageQuoteRecoveryRevision((revision) => revision + 1);
            }}
            onCommand={startCommand}
          />
        </div>
      ) : null}
    </>
  ) : null;

  return (
    <div className="inventory-page room-status-page">
      {queryPhase !== "PERMISSION_DENIED" ? <InlineError error={recoveryError} title="恢复记录未收口" /> : null}
      {queryPhase !== "PERMISSION_DENIED" && commandRecovery.canDiscardCorrupt
        ? <DamagedCommandRecoveryNotice error={commandRecovery.error} onDiscard={commandRecovery.discardCorruptAfterReview} testId="inventory-damaged-command-recovery" />
        : queryPhase !== "PERMISSION_DENIED"
          ? <InlineError error={commandRecovery.error} title="本地命令恢复记录不可用" />
          : null}
      <CommandResultNotice message={commandNotice} onDismiss={() => setCommandNotice(undefined)} />
      <InlineError error={restorationError} title="房态位置未保存" />
      <InlineError error={actionError} title="动作未开始" />
      <InlineError error={quoteRecoveryOutcome} title="报价恢复结果" />
      {queryPhase !== "PERMISSION_DENIED"
        ? <QuoteRecoveryPageEntry recovery={pageQuoteRecovery} onOpen={openQuoteRecoveryContext} />
        : null}
      {queryPhase !== "PERMISSION_DENIED" && commandRecovery.pending ? <CommandRecoveryBar recovery={commandRecovery.pending} onOpen={openRecoveryDialog} testId="inventory-command-recovery" businessFacing={inventoryRecoveryIsBusinessFacing(commandRecovery.pending.presentation)} /> : null}
      {returnNotice ? <div className="room-status-return-notice" role="status">{returnNotice}</div> : null}
      {boardRefreshFailed ? <div className="room-status-stale-notice" role="alert">房态刷新未完成，当前继续显示上次成功结果。新的创建和锁房操作已暂时关闭；刷新成功后会自动恢复。</div> : null}
      {queryError && !boardForCurrentProperty ? <InlineError error={queryError} title="无法查询房态" /> : null}

      {!renderedBoard ? (
        queryPhase === "LOADING" || (board !== undefined && !boardMatchesCurrentProperty)
          ? <LoadingBlock label="正在查询房间、床位与来源事实" />
          : queryPhase === "PERMISSION_DENIED"
            ? <section className="room-status-query-failure" role="alert"><strong>无权查看当前物业房态</strong><p>当前主体没有这项读取权限，页面未保留旧房态，也不会开放任何写入动作。</p></section>
          : <section className="room-status-query-failure" role="status"><strong>状态未知，未显示为可售</strong><p>重新查询成功前，页面不会开放房态写入。</p><button type="button" className="button button-secondary" onClick={() => setRefreshToken((value) => value + 1)}>重试查询</button></section>
      ) : (
        <>
          {!isMobile ? roomStatusToolbar : null}

          {rangeLoading ? (
            <div className="room-status-range-loading" role="status" aria-live="polite" data-testid="room-status-range-loading">
              <strong>正在载入新的日期范围或房间分页</strong>
              <span>工具栏保留上次获权的数据时点；下方仍是 [{renderedBoard.range.arrivalDate}, {renderedBoard.range.departureDate}) 的旧事实，已暂停全部交互和写入。</span>
            </div>
          ) : null}

          <div
            ref={workspaceRef}
            className={`room-status-workspace${!isMobile && (desktopContextCollapsed || !useInlineOrderContext) ? " is-context-overlay" : ""}`}
            aria-busy={rangeLoading}
            inert={rangeLoading && !filteredViewHasNoRooms}
          >
            <div className="room-status-board-column" ref={boardColumnRef}>
              <RoomStatusGrid
                board={renderedBoard}
                range={range}
                filters={viewState.filters}
                expandedRoomIds={viewState.expandedRoomIds}
                focusedCell={viewState.focusedCell}
                selection={viewState.selection}
                selectedStayId={roomStatusGridSelectedStayId(
                  Boolean(quickPopoverTarget),
                  quickPopoverPreviewStayId,
                  selectedOrderIdentity,
                  selectedGridStayId
                )}
                dateWindowStart={viewState.dateWindowStart}
                todayDate={todayDate}
                rangeError={rangeError instanceof Error ? rangeError.message : undefined}
                initialScrollAnchor={viewState.scrollAnchor}
                restoreFocus={restoreGridFocus}
                focusRequestToken={focusRequestToken}
                onRangeChange={applyRange}
                onPreviousRange={() => shiftRange(-1)}
                onNextRange={() => shiftRange(1)}
                onToday={() => applyRange(roomStatusTimelineRangeFromStart(todayDate))}
                onToggleRoom={(roomId) => dispatchView({ type: "TOGGLE_ROOM", roomId })}
                onFocusedCellChange={(focus) => dispatchView({ type: "SET_FOCUS", focus })}
                onSelectionPreviewChange={previewSelection}
                onInspectSelection={inspectSelection}
                onPageChange={(index) => changeRoomPage(index, renderedBoard.page.totalPages)}
                onDateWindowChange={(start) => changeDateWindow(start, renderedBoard.dates.length)}
                onInspectUnit={inspectUnit}
                onInspectDay={inspectDay}
                onInspectInterval={inspectInterval}
                onClearFilters={clearFilters}
                onScrollAnchorChange={(anchor) => dispatchView({ type: "SET_SCROLL_ANCHOR", anchor })}
              />
              <RoomStatusMobileTasks
                board={renderedBoard}
                range={range}
                groups={mobileGroups}
                activeTab={mobileTab}
                canCreate={!commandsBlocked && renderedBoard.accessLevel === "WRITE"}
                focusRequest={mobileFocusRequest}
                onTabChange={setMobileTab}
                onPageChange={(index) => changeRoomPage(index, renderedBoard.page.totalPages)}
                onRangeChange={applyRange}
                onToday={() => applyRange(roomStatusTimelineRangeFromStart(todayDate))}
                onCreate={() => setMobileCreateOpen(true)}
                onOpenReference={openReference}
                onOpenReceipt={(receiptId) => window.open(`/api/v1/receipts/${encodeURIComponent(receiptId)}`, "_blank", "noopener,noreferrer")}
                onOpenOrderContext={selectOrderContextIdentity}
                onAction={(action, task, unit) => {
                  if (action.code === "OPEN_ORDER") {
                    const identity = roomStatusOrderIdentityForInterval(task);
                    if (!identity) {
                      setActionError(new Error("当前移动任务缺少唯一、稳定的订单引用，未打开订单。请刷新后重新核对。"));
                      return;
                    }
                    selectOrderContextIdentity(identity, task.businessDate);
                    return;
                  }
                  pendingMobileTaskFocus.current = {
                    tab: mobileTab,
                    completedTaskId: task.id,
                    taskIndex: Math.max(0, activeMobileTasks.findIndex((candidate) => candidate.id === task.id)),
                    sourceRevision: renderedBoard.revision
                  };
                  handleAction(action, unit, {
                    unitId: unit?.id ?? task.actualInventoryUnitId,
                    anchorDate: task.sourceStartDate,
                    focusDate: addLocalDateDays(task.sourceEndDate, -1),
                    arrivalDate: task.sourceStartDate,
                    departureDate: task.sourceEndDate
                  }, task.actualInventoryUnitId);
                }}
              />
            </div>
            {!isMobile && !desktopContextCollapsed && useInlineOrderContext && (!selectedOrderIdentity || orderContextOpen) ? <div className="room-status-side-column">
              {selectedOrderIdentity ? selectedOrderContext : desktopSelectionContext}
            </div> : null}
          </div>

          {quickPopoverTarget && quickPopoverUnit ? (
            <RoomStatusQuickPopover
              anchor={quickPopoverTarget.anchor}
              unit={quickPopoverUnit}
              serviceDate={quickPopoverTarget.serviceDate}
              status={quickPopoverStatus}
              actions={quickPopoverActions}
              orderOptions={quickPopoverOrders}
              {...(quickPopoverSelection ? { selection: quickPopoverSelection } : {})}
              onClose={(reason) => {
                setQuickPopoverTarget(undefined);
                if (reason === "DISMISS") {
                  roomStatusInteractionSnapshotRef.current = undefined;
                  if (selectedOrderIdentity && orderContextOpen) {
                    dispatchView({ type: "SET_SELECTION", selection: null });
                  }
                }
              }}
              onCreate={() => {
                const selection = quickPopoverSelection
                  ?? selectionFromCells(quickPopoverUnit.id, quickPopoverTarget.serviceDate, quickPopoverTarget.serviceDate);
                setSelectedUnitId(quickPopoverUnit.id);
                setSelectedDayDate(quickPopoverSelection ? undefined : quickPopoverTarget.serviceDate);
                setSelectedIntervalId(undefined);
                selectRange(selection);
              }}
              onLockMaintenance={(action) => {
                const selection = quickPopoverSelection
                  ?? selectionFromCells(quickPopoverUnit.id, quickPopoverTarget.serviceDate, quickPopoverTarget.serviceDate);
                setSelectedUnitId(quickPopoverUnit.id);
                setSelectedDayDate(quickPopoverSelection ? undefined : quickPopoverTarget.serviceDate);
                setSelectedIntervalId(undefined);
                selectRange(selection);
                handleAction(action, quickPopoverUnit, selection);
                setQuoteTarget(undefined);
              }}
              onViewStatus={() => {
                setSelectedOrderIdentity(undefined);
                setSelectedOrderView(undefined);
                setSelectedCorrectionOccupantId(undefined);
                setOrderContextOpen(false);
                setSelectedUnitId(quickPopoverUnit.id);
                setSelectedDayDate(quickPopoverSelection ? undefined : quickPopoverTarget.serviceDate);
                setSelectedIntervalId(quickPopoverTarget.intervalId);
                setQuoteTarget(undefined);
                dispatchView({
                  type: "SET_SELECTION",
                  selection: quickPopoverSelection
                    ?? selectionFromCells(quickPopoverUnit.id, quickPopoverTarget.serviceDate, quickPopoverTarget.serviceDate)
                });
                setDesktopContextCollapsed(false);
              }}
              onOpenOrder={(option) => selectOrderContextIdentity(option.identity, quickPopoverTarget.serviceDate)}
            />
          ) : null}

          {!command && !isMobile && !desktopContextCollapsed && !useInlineOrderContext && (selectedUnit || selectedOrderIdentity || viewState.selection || showQuoteWorkbench) && (!selectedOrderIdentity || orderContextOpen || quoteRecoveryDrawerOpen) ? (
            <Modal
              title={desktopContextKind === "QUOTE_RECOVERY" ? "报价恢复" : desktopContextKind === "ORDER" ? "订单上下文" : "选中对象上下文"}
              size="drawer"
              modal={desktopContextKind === "QUOTE_RECOVERY" || (desktopContextKind === "SELECTION" && showQuoteWorkbench)}
              className={desktopContextKind === "QUOTE_RECOVERY" || (desktopContextKind === "SELECTION" && showQuoteWorkbench) ? "room-status-write-drawer" : "room-status-view-drawer"}
              onClose={closeDesktopContext}
              footer={<>
                <button type="button" className="button button-secondary" onClick={closeDesktopContext}>关闭</button>
                {desktopContextKind === "ORDER" ? <button type="button" className="button button-primary" onClick={() => openSelectedOrder()}>查看完整订单</button> : null}
              </>}
            >
              {desktopContextKind === "ORDER" ? selectedOrderContext : desktopSelectionContext}
            </Modal>
          ) : null}

          {isMobile && selectedOrderIdentity && orderContextOpen ? (
            <Modal
              title="订单上下文"
              size="mobile-fullscreen"
              modal
              onClose={closeSelectedOrderContext}
              footer={<><button type="button" className="button button-secondary" onClick={closeSelectedOrderContext}>关闭</button><button type="button" className="button button-primary" onClick={() => openSelectedOrder()}>查看完整订单</button></>}
            >
              {selectedOrderContext}
            </Modal>
          ) : null}

          {!isMobile && desktopContextCollapsed && !quickPopoverTarget && (selectedUnit || selectedOrderIdentity || viewState.selection || showQuoteWorkbench) ? (
            <button type="button" className="button button-primary room-status-context-reopen" onClick={reopenDesktopContext}>
              <PanelRightOpen aria-hidden="true" size={17} />打开{pageQuoteRecovery.kind !== "ABSENT" ? "报价恢复" : selectedOrderIdentity ? "订单上下文" : "选中对象上下文"}
            </button>
          ) : null}

          {isMobile && mobileCreateOpen ? (
            <Modal title="新建住宿或锁房" size="mobile-fullscreen" onClose={() => setMobileCreateOpen(false)} footer={null}>
              <RoomStatusContext
                board={renderedBoard}
                selectedUnit={selectedUnit}
                selectedDay={selectedDay}
                selectedInterval={selectedInterval}
                relatedIntervals={relatedIntervals}
                selection={viewState.selection}
                conflicts={contextConflicts}
                allowedActions={contextActions}
                onSelectedUnitChange={(unit) => {
                  inspectUnit(unit);
                }}
                onSelectionChange={selectRange}
                onDraftValidityChange={setSelectionDraftValid}
                onOpenReference={openReference}
                onOpenReceipt={(receiptId) => window.open(`/api/v1/receipts/${encodeURIComponent(receiptId)}`, "_blank", "noopener,noreferrer")}
                onAction={(action) => {
                  if (handleAction(action)) setMobileCreateOpen(false);
                }}
              />
            </Modal>
          ) : null}

          {isMobile && showQuoteWorkbench ? (
            <div className="room-status-quote-section" ref={quoteSectionRef}>
              <QuoteWorkbench
                unit={quoteActionUnit}
                arrivalDate={activeQuoteTarget?.arrivalDate ?? range.arrivalDate}
                departureDate={activeQuoteTarget?.departureDate ?? range.departureDate}
                policies={policies}
                {...(activeQuoteTarget ? { initialStayType: activeQuoteTarget.initialStayType } : {})}
                commandsBlocked={commandsBlocked}
                selectionDraftValid={selectionDraftValid}
                resetToken={quoteResetToken}
                onClose={closeQuoteWorkbench}
                onRecoveryOutcome={setQuoteRecoveryOutcome}
                onRecoveryStateChange={() => {
                  if (recoveryQuoteTarget) setQuoteTarget(recoveryQuoteTarget);
                  setPageQuoteRecoveryRevision((revision) => revision + 1);
                }}
                onCommand={startCommand}
              />
            </div>
          ) : null}
        </>
      )}

      {queryPhase !== "PERMISSION_DENIED" && shouldRenderDetachedQuoteRecoveryWorkbench(Boolean(renderedBoard), quoteRecoveryContextOpen, pageQuoteRecovery) ? (
        <Modal
          title="报价恢复"
          size={isMobile ? "mobile-fullscreen" : "drawer"}
          modal
          className="room-status-write-drawer"
          onClose={closeDesktopContext}
          footer={<button type="button" className="button button-secondary" onClick={closeDesktopContext}>关闭</button>}
        >
          <div className="room-status-quote-section" ref={quoteSectionRef}>
            <QuoteWorkbench
              unit={undefined}
              arrivalDate={activeQuoteTarget?.arrivalDate ?? range.arrivalDate}
              departureDate={activeQuoteTarget?.departureDate ?? range.departureDate}
              policies={policies}
              {...(activeQuoteTarget ? { initialStayType: activeQuoteTarget.initialStayType } : {})}
              commandsBlocked
              selectionDraftValid={selectionDraftValid}
              resetToken={quoteResetToken}
              onClose={closeQuoteWorkbench}
              onRecoveryOutcome={setQuoteRecoveryOutcome}
              onRecoveryStateChange={() => {
                if (recoveryQuoteTarget) setQuoteTarget(recoveryQuoteTarget);
                setPageQuoteRecoveryRevision((revision) => revision + 1);
              }}
              onCommand={startCommand}
            />
          </div>
        </Modal>
      ) : null}

      {maintenanceTarget && viewState.selection && !command ? <MaintenanceDialog unit={maintenanceTarget} arrivalDate={viewState.selection.arrivalDate} departureDate={viewState.selection.departureDate} writeBlocked={commandsBlocked} {...(commandDraft?.commandType === "LOCK_MAINTENANCE" ? { draft: commandDraft } : {})} onClose={() => { setMaintenanceTarget(undefined); setCommandDraft(undefined); restoreRoomStatusInteraction(); }} onSubmit={startCommand} /> : null}
      {authorizedSelectedOrderView && selectedCorrectionOccupant ? <OrderOccupantCorrectionDialog
        view={authorizedSelectedOrderView}
        occupant={selectedCorrectionOccupant}
        {...(correctionDraftMatchesOccupant(commandDraft, authorizedSelectedOrderView.order.id, selectedCorrectionOccupant.id)
          ? { draft: commandDraft }
          : {})}
        onClose={() => {
          setSelectedCorrectionOccupantId(undefined);
          setSelectedCorrectionRevision(undefined);
          setCommandDraft(undefined);
        }}
        onSubmit={(request) => {
          if (commandsBlocked) return;
          setSelectedCorrectionOccupantId(undefined);
          setSelectedCorrectionRevision(undefined);
          setRecoveryDialogOpen(false);
          startCommand(request, currentSelectedOrderCommandScope);
        }}
      /> : null}
      {authorizedSelectedOrderView && selectedStayDateAction ? <StayDateChangeDrawer
        action={selectedStayDateAction}
        mode={selectedStayDateMode}
        view={authorizedSelectedOrderView}
        inventoryUnitLabel={[...new Set(authorizedSelectedOrderView.effectiveArrangement.intervals.map((interval) => {
          const unit = meta.inventoryUnits.find((candidate) => candidate.id === interval.inventoryUnitId);
          return unit ? `${unit.code} · ${unit.name}` : "房源";
        }))].join(" → ")}
        inventoryUnits={meta.inventoryUnits}
        writeBlocked={commandsBlocked || selectedStayDateRevision !== board?.revision}
        runPreview={commandRecovery.runPreview}
        {...(commandDraft?.commandType === selectedStayDateAction ? { draft: commandDraft } : {})}
        onClose={() => {
          setSelectedStayDateAction(undefined);
          setSelectedStayDateMode("DATE_CHANGE");
          setSelectedStayDateRevision(undefined);
          setSelectedOrderCommandScope(undefined);
          setCommandDraft(undefined);
          restoreRoomStatusInteraction();
        }}
        onSubmit={(request) => {
          const identity = selectedOrderIdentity;
          if (!identity || commandsBlocked || !selectedStayDateRequestIsCompatible(
            selectedStayDateAction,
            selectedStayDateMode,
            request.commandType
          )) return;
          setSelectedStayDateAction(undefined);
          setSelectedStayDateMode("DATE_CHANGE");
          setSelectedStayDateRevision(undefined);
          setCommandDraft(undefined);
          setRecoveryDialogOpen(false);
          startCommand(request, roomStatusOrderCommandScope(orderPrincipalScope, identity));
        }}
      /> : null}
      {authorizedSelectedOrderView && selectedMoveUnitOpen ? <MoveUnitDrawer
        view={authorizedSelectedOrderView}
        units={meta.inventoryUnits}
        writeBlocked={commandsBlocked || selectedMoveUnitRevision !== board?.revision}
        runPreview={commandRecovery.runPreview}
        {...(commandDraft?.commandType === "MOVE_UNIT" ? { draft: commandDraft } : {})}
        onClose={() => {
          setSelectedMoveUnitOpen(false);
          setSelectedMoveUnitRevision(undefined);
          setSelectedOrderCommandScope(undefined);
          setCommandDraft(undefined);
          restoreRoomStatusInteraction();
        }}
        onSubmit={(request) => {
          const identity = selectedOrderIdentity;
          if (!identity || commandsBlocked || request.commandType !== "MOVE_UNIT") return;
          setSelectedMoveUnitOpen(false);
          setSelectedMoveUnitRevision(undefined);
          setCommandDraft(undefined);
          setRecoveryDialogOpen(false);
          startCommand(request, roomStatusOrderCommandScope(orderPrincipalScope, identity));
        }}
      /> : null}
      {authorizedSelectedOrderView && selectedLifecycleAction ? <OrderLifecycleActionDrawer
        action={selectedLifecycleAction}
        view={authorizedSelectedOrderView}
        inventoryUnitLabels={Object.fromEntries(meta.inventoryUnits.map((unit) => [unit.id, `${unit.code} · ${unit.name}`]))}
        writeBlocked={commandsBlocked || selectedLifecycleRevision !== board?.revision}
        {...(commandDraft?.commandType === selectedLifecycleAction ? { draft: commandDraft } : {})}
        onClose={() => {
          setSelectedLifecycleAction(undefined);
          setSelectedLifecycleRevision(undefined);
          setSelectedOrderCommandScope(undefined);
          setCommandDraft(undefined);
          restoreRoomStatusInteraction();
        }}
        onSubmit={(request) => {
          const identity = selectedOrderIdentity;
          const currentView = authorizedSelectedOrderView;
          const action = currentView?.allowedActions.find((candidate) => candidate.code === selectedLifecycleAction);
          if (!identity || commandsBlocked || selectedLifecycleRevision !== board?.revision
            || request.commandType !== selectedLifecycleAction
            || currentView.order.id !== identity.orderId || currentView.stay.id !== identity.stayId
            || !action?.enabled) return;
          setSelectedLifecycleAction(undefined);
          setSelectedLifecycleRevision(undefined);
          setCommandDraft(undefined);
          setRecoveryDialogOpen(false);
          startCommand(request, roomStatusOrderCommandScope(orderPrincipalScope, identity));
        }}
      /> : null}
      {command && commandTargetScopeCurrent ? <CommandDialog
        key={recoveryDialogOpen ? `recovery-${commandRecovery.pending?.confirmationKey ?? "missing"}-${commandAttemptId}` : `new-room-status-command-${commandAttemptId}`}
        request={command}
        onClose={closeCommandDialog}
        writeBlocked={!recoveryDialogOpen && activeCommandWriteBlocked}
        writeBlockedReason="当前命令绑定的门店、账号、订单、住宿、查询范围或业务版本已经变化，或者操作恢复状态异常。请关闭后重新核对。"
        onCommitted={refreshCommittedRoomStatus}
        onBusinessSuccess={() => {
          setCommandNotice(undefined);
          setCommandDraft(undefined);
          setSelectedStayDateAction(undefined);
          setSelectedStayDateMode("DATE_CHANGE");
          setSelectedStayDateRevision(undefined);
          setSelectedMoveUnitOpen(false);
          setSelectedMoveUnitRevision(undefined);
          setSelectedLifecycleAction(undefined);
          setSelectedLifecycleRevision(undefined);
          if (command.commandType === "CREATE_ORDER") {
            setQuoteTarget(undefined);
            setDesktopContextCollapsed(true);
            setMobileCreateOpen(false);
          }
          if (command.commandType === "LOCK_MAINTENANCE") {
            setMaintenanceTarget(undefined);
            setDesktopContextCollapsed(true);
            setMobileCreateOpen(false);
            roomStatusInteractionSnapshotRef.current = undefined;
          }
        }}
        onBusinessNotExecuted={(message) => setCommandNotice(message)}
        onReturnToEdit={returnCommandToEdit}
        {...(recoveryDialogOpen && commandRecovery.pending ? {
          initialConfirmationKey: commandRecovery.pending.confirmationKey
        } : {})}
        onProgress={(progress) => trackCommandProgress(command, progress, commandAttemptId)}
      /> : null}
    </div>
  );
}

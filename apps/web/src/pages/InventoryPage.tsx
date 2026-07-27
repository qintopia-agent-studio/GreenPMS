import { useEffect, useMemo, useReducer, useRef, useState, type FormEvent } from "react";
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
  OrderViewDto,
  PricingPolicyVersionDto,
  QuoteDto,
  ReceiptDto,
  StayType
} from "../types";
import { correctionDraftMatchesOccupant, OrderOccupantCorrectionDialog } from "../components/OrderOccupantCorrectionDialog";
import {
  CommandDialog,
  type CommandDialogCloseContext,
  CommandResultNotice,
  type CommandDialogProgress,
  type CommandRecoveryStorage,
  CommandRecoveryBar,
  EmptyState,
  formatDateTime,
  formatMoney,
  InlineError,
  isTerminalCommandRecovery,
  LoadingBlock,
  Modal,
  recoveryCommandRequest,
  usePersistentCommandRecovery
} from "../ui";
import {
  assertRoomStatusBoard,
  createRoomStatusOrderReturnState,
  createRoomStatusViewState,
  dateWindowStartForFocus,
  filterRoomStatusRooms,
  hasActiveRoomStatusFilters,
  hasRoomStatusOrderReturnEnvelope,
  isIsoLocalDate,
  parseRoomStatusRestoration,
  parseRoomStatusOrderReturnTarget,
  reconcileRoomStatusRestoration,
  resolveRoomStatusOrderReturnTarget,
  roomStatusAutoVisibleDays,
  roomStatusFactFingerprint,
  roomStatusOrderIdentityForDate,
  roomStatusOrderIdentityForInterval,
  roomStatusUnitLabel,
  RoomStatusContext,
  RoomStatusGrid,
  RoomStatusMobileTasks,
  RoomStatusOrderContext,
  RoomStatusToolbar,
  roomStatusViewReducer,
  selectionFromCells,
  serializeRoomStatusRestoration,
  useRoomStatusMobileViewport,
  type RoomStatusMobileGroups,
  type RoomStatusMobileFocusRequest,
  type RoomStatusMobileTab,
  type RoomStatusOrderIdentity,
  type RoomStatusDateWindowMode,
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

export function roomStatusOrderContextMode(workspaceWidth: number, isMobile: boolean): "INLINE" | "DRAWER" {
  return !isMobile && (workspaceWidth === 0 || workspaceWidth >= 1240) ? "INLINE" : "DRAWER";
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

interface PendingQuoteCommand {
  version: 1;
  subjectId: string;
  propertyId: string;
  input: QuoteCommandInput;
  inputSignature: string;
  metadata: ClientCommandMetadata;
  state: "SENDING" | "UNKNOWN";
}

type QuoteRecoveryReadResult =
  | { kind: "ABSENT" }
  | { kind: "VALID"; pending: PendingQuoteCommand }
  | { kind: "CORRUPT"; error: Error }
  | { kind: "READ_ERROR"; error: Error };

const QUOTE_RECOVERY_STORAGE_PREFIX = "qintopia.quote-command-recovery.v1";

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

export function quoteRecoveryStorageKey(subjectId: string, propertyId: string): string {
  return `${QUOTE_RECOVERY_STORAGE_PREFIX}:${encodeURIComponent(subjectId)}:${encodeURIComponent(propertyId)}`;
}

function validQuoteInput(value: unknown): value is QuoteCommandInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return typeof input.propertyId === "string"
    && typeof input.inventoryUnitId === "string"
    && (input.stayType === undefined || typeof input.stayType === "string")
    && typeof input.arrivalDate === "string"
    && typeof input.departureDate === "string"
    && typeof input.pricingPolicyVersionId === "string"
    && !Object.hasOwn(input, "memberContractId")
    && (input.memberId === undefined || typeof input.memberId === "string");
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
  if (record.version !== 1
    || record.subjectId !== subjectId
    || record.propertyId !== propertyId
    || !validQuoteInput(record.input)
    || record.input.propertyId !== propertyId
    || typeof record.inputSignature !== "string"
    || record.inputSignature !== quoteInputSignature(record.input)
    || !metadata
    || typeof metadata !== "object"
    || Array.isArray(metadata)
    || typeof (metadata as Record<string, unknown>).idempotencyKey !== "string"
    || !(metadata as Record<string, unknown>).idempotencyKey
    || typeof (metadata as Record<string, unknown>).correlationId !== "string"
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

function browserQuoteRecovery(subjectId: string, propertyId: string, storageFactory: () => Storage = () => window.sessionStorage): { storage?: CommandRecoveryStorage; read: QuoteRecoveryReadResult } {
  try {
    const storage = storageFactory();
    return { storage, read: readQuoteCommandRecovery(storage, subjectId, propertyId) };
  } catch {
    return { read: { kind: "READ_ERROR", error: new Error("无法访问浏览器 sessionStorage；已暂停新报价和订单写入") } };
  }
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

function quoteFromReceipt(receipt: ReceiptDto): QuoteDto {
  const quote = receipt.result?.quote;
  if (!quote || typeof quote !== "object" || Array.isArray(quote)) {
    throw new Error("Recovered CREATE_QUOTE Receipt does not contain a valid Quote");
  }
  const record = quote as Record<string, unknown>;
  if (typeof record.quoteId !== "string") {
    throw new Error("Recovered CREATE_QUOTE Receipt does not contain a valid Quote");
  }
  return record as unknown as QuoteDto;
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
    <Modal title={`维修锁房 · ${unitName(unit)}`} onClose={onClose} footer={null}>
      <form className="modal-form" onSubmit={submit}>
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
        <div className="form-actions"><button type="button" className="button button-secondary" onClick={onClose}>取消</button><button type="submit" className="button button-primary" disabled={writeBlocked}>继续核对</button></div>
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
  resetToken,
  onClose,
  onRecoveryOutcome,
  onCommand
}: {
  unit: InventoryActionUnit | undefined;
  arrivalDate: string;
  departureDate: string;
  policies: PricingPolicyVersionDto[];
  initialStayType?: StayType;
  commandsBlocked: boolean;
  resetToken: number;
  onClose: () => void;
  onRecoveryOutcome: (outcome: Error | undefined) => void;
  onCommand: (request: CommandRequest) => void;
}) {
  const { meta, principal, propertyId } = useWorkspace();
  const quoteRecoveryScope = quoteRecoveryStorageKey(principal.subjectId, propertyId);
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

  useEffect(() => {
    quoteRequestGuard.mount();
    return () => quoteRequestGuard.unmount();
  }, [quoteRequestGuard]);

  useEffect(() => {
    setBusy(false);
    setQuoteRecoverySnapshot({
      scope: quoteRecoveryScope,
      read: browserQuoteRecovery(principal.subjectId, propertyId).read
    });
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

  const currentQuoteInput: QuoteCommandInput | undefined = unit && policyId && (!useMemberEntitlement || quoteMemberId) ? {
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
      input,
      inputSignature,
      metadata,
      state: "SENDING"
    };
    const beforeSend = browserQuoteRecovery(principal.subjectId, propertyId);
    if (!beforeSend.storage || beforeSend.read.kind !== "ABSENT") {
      setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read: beforeSend.read });
      setError(beforeSend.read.kind === "ABSENT" ? new Error("无法访问本地报价恢复存储，报价命令尚未发送") : undefined);
      return;
    }
    if (!saveQuoteCommandRecovery(beforeSend.storage, pending)) {
      const read = { kind: "READ_ERROR", error: new Error("无法保存本地报价恢复记录，报价命令尚未发送") } as const;
      setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read });
      setError(read.error);
      return;
    }
    setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read: { kind: "VALID", pending } });
    const requestLease = quoteRequestGuard.begin(quoteRecoveryScope);
    setBusy(true);
    setError(undefined);
    try {
      const response = await api.quote(input, metadata, signal);
      if (!quoteRequestGuard.isActive(requestLease)) return;
      const completed = browserQuoteRecovery(principal.subjectId, propertyId);
      if (completed.storage && completed.read.kind === "VALID" && completed.read.pending.metadata.idempotencyKey === metadata.idempotencyKey) {
        if (clearQuoteCommandRecovery(completed.storage, principal.subjectId, propertyId)) {
          setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read: { kind: "ABSENT" } });
        } else {
          setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read: { kind: "READ_ERROR", error: new Error("报价已返回，但无法清除本地恢复记录；新报价和订单写入继续暂停") } });
        }
      } else if (completed.read.kind !== "ABSENT") {
        setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read: completed.read });
      } else {
        setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read: { kind: "ABSENT" } });
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
      const current = browserQuoteRecovery(principal.subjectId, propertyId);
      if (nextError instanceof ApiError) {
        if (current.storage && current.read.kind === "VALID" && current.read.pending.metadata.idempotencyKey === metadata.idempotencyKey) {
          clearQuoteCommandRecovery(current.storage, principal.subjectId, propertyId);
        }
        setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read: { kind: "ABSENT" } });
        settledQuoteSignature.current = inputSignature;
        setError(staffQuoteError(nextError, unit?.code ?? "所选房源", arrivalDate, departureDate));
        return;
      }
      setError(nextError);
      if (current.storage && current.read.kind === "VALID" && current.read.pending.metadata.idempotencyKey === metadata.idempotencyKey) {
        const unknown = { ...current.read.pending, state: "UNKNOWN" as const };
        if (saveQuoteCommandRecovery(current.storage, unknown)) {
          setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read: { kind: "VALID", pending: unknown } });
        } else {
          setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read: { kind: "READ_ERROR", error: new Error("报价响应未知且无法更新本地恢复记录；写入口继续暂停") } });
        }
      } else if (current.read.kind !== "ABSENT") {
        setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read: current.read });
      } else {
        setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read: { kind: "ABSENT" } });
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
      const receipt = await api.commandResult(
        pendingQuote.input.propertyId,
        "CREATE_QUOTE",
        pendingQuote.metadata.idempotencyKey
      );
      if (!quoteRequestGuard.isActive(requestLease)) return;
      if (receipt.executionStatus === "UNKNOWN") {
        const current = browserQuoteRecovery(principal.subjectId, propertyId);
        if (current.storage && current.read.kind === "VALID" && current.read.pending.metadata.idempotencyKey === pendingQuote.metadata.idempotencyKey) {
          const unknown = { ...current.read.pending, state: "UNKNOWN" as const };
          if (saveQuoteCommandRecovery(current.storage, unknown)) setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read: { kind: "VALID", pending: unknown } });
          else setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read: { kind: "READ_ERROR", error: new Error("无法更新本地报价恢复记录；写入口继续暂停") } });
        }
        setError(new Error("报价命令仍在执行或状态未知，请保留原幂等键后再次查询。"));
        return;
      }
      const completed = browserQuoteRecovery(principal.subjectId, propertyId);
      if (!completed.storage || completed.read.kind !== "VALID" || completed.read.pending.metadata.idempotencyKey !== pendingQuote.metadata.idempotencyKey) {
        setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read: completed.read });
        setError(new Error("命令结果已返回，但本地报价恢复记录无法安全收口"));
        return;
      }
      if (!clearQuoteCommandRecovery(completed.storage, principal.subjectId, propertyId)) {
        setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read: { kind: "READ_ERROR", error: new Error("无法清除已收口的本地报价恢复记录；写入口继续暂停") } });
        return;
      }
      setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read: { kind: "ABSENT" } });
      if (!receipt.businessCommitted) {
        onRecoveryOutcome(new Error("服务端确认该报价命令未执行，可以重新报价。"));
        return;
      }
      const recoveredQuote = quoteFromReceipt(receipt);
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
      setQuoteRecoverySnapshot({ scope: quoteRecoveryScope, read: current.read });
    } finally {
      if (quoteRequestGuard.isActive(requestLease)) setBusy(false);
    }
  }

  useEffect(() => {
    if (!pendingQuote || pendingQuote.state !== "SENDING" || busy) return;
    const timeout = window.setTimeout(() => void recoverQuote(), 500);
    return () => window.clearTimeout(timeout);
  }, [pendingQuote?.metadata.idempotencyKey, pendingQuote?.state, busy]);

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
      <InlineError error={quoteRecoveryError} title="本地报价恢复记录不可用" />
      {pendingQuote?.state === "UNKNOWN" ? (
        <div className="recovery-bar" data-testid="quote-recovery">
          <div><strong>报价结果尚未确认</strong><p>系统不会重复报价；网络恢复后可重新查询本次结果。</p></div>
          <button className="button button-secondary" type="button" onClick={() => void recoverQuote()} disabled={busy}>
            <RefreshCw aria-hidden="true" size={17} />重新查询报价结果
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
                  <legend>主要入住人 <span>主要 / 联系人</span></legend>
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
                      <strong>差异 {formatMoney({ currency: quote.currentContractAmount.currency, minorUnits: paidPricingDraft.differenceFromPolicyMinor })}</strong>
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

interface RoomStatusQuoteTarget {
  unitId: string;
  arrivalDate: string;
  departureDate: string;
  initialStayType: StayType;
}

type PendingMobileTaskFocus = Omit<RoomStatusMobileFocusRequest, "token">;

type RoomStatusCommandPhase = "IDLE" | "DRAFT" | "PREVIEW" | "CONFIRMING" | "SETTLED";

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
  return { arrivalDate: today, departureDate: addLocalDateDays(today, 21) };
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

function withoutRoomStatusWriteActions(unit: RoomStatusUnitDto, stale: boolean): RoomStatusUnitDto {
  const status = stale ? "STALE" as const : undefined;
  const readActions = (actions: readonly RoomStatusActionDto[]) => actions.filter((action) => action.code === "OPEN_ORDER");
  return {
    ...unit,
    days: unit.days.map((day) => ({
      ...day,
      ...(status ? { status, available: false } : {})
    })),
    intervals: unit.intervals.map((interval) => ({
      ...interval,
      ...(status ? { status, available: false } : {}),
      allowedActions: readActions(interval.allowedActions)
    })),
    allowedActions: readActions(unit.allowedActions),
    children: unit.children.map((child) => withoutRoomStatusWriteActions(child, stale))
  };
}

function displayRoomStatusBoard(board: RoomStatusBoardDto, commandsBlocked: boolean, stale: boolean): RoomStatusBoardDto {
  if (!commandsBlocked && !stale) return board;
  return {
    ...board,
    projectionState: stale ? "PARTIAL" : board.projectionState,
    operationalTasks: board.operationalTasks.map((task) => ({
      ...task,
      ...(stale ? { status: "STALE" as const, available: false } : {}),
      allowedActions: task.allowedActions.filter((action) => action.code === "OPEN_ORDER")
    })),
    rooms: board.rooms.map((room) => withoutRoomStatusWriteActions(room, stale))
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
  if (!selection || days.length !== rangeNights(selection) || days.some((day) => !day.available || day.conflicts.length > 0)) return [];
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
  const orderPrincipalScope = `${principal.subjectId}:${principal.credentialType}:${principal.propertyAccess[propertyId] ?? "NONE"}`;
  const initialRestoration = useRef(readRoomStatusRestoration(principal.subjectId, propertyId));
  const orderReturnEnvelopePresent = useRef(hasRoomStatusOrderReturnEnvelope(location.state));
  const pendingOrderReturnTarget = useRef(parseRoomStatusOrderReturnTarget(location.state));
  const [range, setRange] = useState<RoomStatusRange>(() => initialRestoration.current?.range ?? defaultRoomStatusRange(propertyTimezone));
  const [viewState, dispatchView] = useReducer(
    roomStatusViewReducer,
    initialRestoration.current?.state ?? createRoomStatusViewState()
  );
  const commandRecovery = usePersistentCommandRecovery({ subjectId: principal.subjectId, scopeId: `property:${propertyId}` });
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
  const restorationPageAdjusted = useRef(false);
  const restorationPagesVisited = useRef(new Set<number>());
  const previousPropertyId = useRef(propertyId);
  const previousSubjectId = useRef(principal.subjectId);
  const [initializedPropertyId, setInitializedPropertyId] = useState(propertyId);
  const [queryPhase, setQueryPhase] = useState<"LOADING" | "RANGE_LOADING" | "READY" | "REFRESHING" | "ERROR" | "PERMISSION_DENIED">("LOADING");
  const [queryError, setQueryError] = useState<unknown>();
  const [rangeError, setRangeError] = useState<unknown>();
  const [restorationError, setRestorationError] = useState<unknown>();
  const [returnNotice, setReturnNotice] = useState<string>();
  const [actionError, setActionError] = useState<unknown>();
  const [quoteRecoveryOutcome, setQuoteRecoveryOutcome] = useState<Error>();
  const [clock, setClock] = useState(() => Date.now());
  const [refreshToken, setRefreshToken] = useState(0);
  const [quoteResetToken, setQuoteResetToken] = useState(0);
  const [command, setCommand] = useState<CommandRequest>();
  const [commandDraft, setCommandDraft] = useState<CommandRequest>();
  const [commandAttemptId, setCommandAttemptId] = useState(0);
  const [recoveryDialogOpen, setRecoveryDialogOpen] = useState(false);
  const [recoveryError, setRecoveryError] = useState<unknown>();
  const [commandNotice, setCommandNotice] = useState<string>();
  const [selectedUnitId, setSelectedUnitId] = useState<string>();
  const [selectedDayDate, setSelectedDayDate] = useState<string>();
  const [selectedIntervalId, setSelectedIntervalId] = useState<string>();
  const [selectedOrderIdentity, setSelectedOrderIdentity] = useState<RoomStatusOrderIdentity>();
  const [selectedOrderView, setSelectedOrderView] = useState<OrderViewDto>();
  const [selectedOrderLoadedScope, setSelectedOrderLoadedScope] = useState<string>();
  const [selectedOrderLoading, setSelectedOrderLoading] = useState(false);
  const [selectedOrderError, setSelectedOrderError] = useState<unknown>();
  const [selectedCorrectionOccupantId, setSelectedCorrectionOccupantId] = useState<string>();
  const [selectedCorrectionRevision, setSelectedCorrectionRevision] = useState<string>();
  const [orderContextOpen, setOrderContextOpen] = useState(false);
  const [desktopContextCollapsed, setDesktopContextCollapsed] = useState(false);
  const [orderRefreshToken, setOrderRefreshToken] = useState(0);
  const [selectedOrderCommandScope, setSelectedOrderCommandScope] = useState<string>();
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const [boardColumnWidth, setBoardColumnWidth] = useState(0);
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
  const commandPhaseRef = useRef<RoomStatusCommandPhase>("IDLE");
  const commandAttemptGuardRef = useRef<RoomStatusCommandAttemptGuard | null>(null);
  if (!commandAttemptGuardRef.current) commandAttemptGuardRef.current = new RoomStatusCommandAttemptGuard();
  const commandAttemptGuard = commandAttemptGuardRef.current;
  const commandRevisionRef = useRef<string | undefined>(undefined);
  const refreshedReceiptIdRef = useRef<string | undefined>(undefined);
  const focusAfterNextBoard = useRef(false);
  const pendingMobileTaskFocus = useRef<PendingMobileTaskFocus | undefined>(undefined);
  const mobileFocusSequence = useRef(0);
  const latestRestoration = useRef<{
    subjectId: string;
    snapshot: RoomStatusRestorationSnapshot;
  } | undefined>(undefined);

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
    const element = boardColumnRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setBoardColumnWidth(entry?.contentRect.width ?? 0));
    observer.observe(element);
    setBoardColumnWidth(element.getBoundingClientRect().width);
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
    setSelectedOrderLoading(true);
    setSelectedOrderError(undefined);
    api.order(selectedOrderIdentity.orderId)
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
        setSelectedOrderView(undefined);
        setSelectedOrderError(nextError);
      })
      .finally(() => current && setSelectedOrderLoading(false));
    return () => { current = false; };
  }, [board?.revision, orderPrincipalScope, orderRefreshToken, propertyId, refreshToken, selectedOrderIdentity]);

  useEffect(() => {
    if (command?.commandType !== "CORRECT_ORDER_OCCUPANT" || selectedOrderCommandScope === orderPrincipalScope) return;
    commandAttemptGuard.invalidate();
    commandPhaseRef.current = "IDLE";
    commandRevisionRef.current = undefined;
    setCommand(undefined);
    setCommandDraft(undefined);
    setSelectedOrderCommandScope(undefined);
    setSelectedCorrectionOccupantId(undefined);
    setRecoveryDialogOpen(false);
  }, [command, orderPrincipalScope, selectedOrderCommandScope]);

  useEffect(() => {
    if (!selectedCorrectionOccupantId || !selectedCorrectionRevision || !board) return;
    if (board.revision === selectedCorrectionRevision) return;
    setSelectedCorrectionOccupantId(undefined);
    setSelectedCorrectionRevision(undefined);
    setActionError(new Error("订单资料已被其他操作刷新。为避免覆盖新值，原更正表单已关闭；请重新打开后核对。"));
  }, [board?.revision, selectedCorrectionOccupantId, selectedCorrectionRevision]);

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
        && commandPhaseRef.current !== "CONFIRMING"
        && !queryAttemptGuard.isInFlight()) {
        setRefreshToken((value) => value + 1);
      }
    }, ROOM_STATUS_POLL_MS);
    const refreshVisible = () => {
      if (document.visibilityState !== "visible") return;
      setClock(Date.now());
      if (!permissionDeniedRef.current
        && commandPhaseRef.current !== "CONFIRMING"
        && !queryAttemptGuard.isInFlight()) {
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
    orderRestorationAttempted.current = false;
    restorationPagesVisited.current.clear();
    setRange(restored?.range ?? defaultRoomStatusRange(propertyTimezone));
    dispatchView({ type: "RESTORE", state: restored?.state ?? createRoomStatusViewState() });
    setBoard(undefined);
    boardRef.current = undefined;
    setBoardQueryKey(undefined);
    boardQueryKeyRef.current = undefined;
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
    setMobileFocusRequest(undefined);
    pendingMobileTaskFocus.current = undefined;
    commandPhaseRef.current = "IDLE";
    commandAttemptGuard.invalidate();
    commandRevisionRef.current = undefined;
    focusAfterNextBoard.current = false;
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
    const projectionRefreshPaused = commandPhaseRef.current === "CONFIRMING" && Boolean(existing);
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
          restorationPageAdjusted.current = true;
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
            restorationPageAdjusted.current = true;
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
        if (focusAfterNextBoard.current) {
          focusAfterNextBoard.current = false;
          setFocusRequestToken((value) => value + 1);
        }
        if (restored) {
          pendingRestoration.current = undefined;
          restorationPagesVisited.current.clear();
          const pageAdjusted = restorationPageAdjusted.current;
          restorationPageAdjusted.current = false;
          const resolution = reconcileRoomStatusRestoration(response.rooms, response.dates, {
            ...restored.state,
            roomPageIndex: response.page.index
          }, restored.factFingerprint);
          dispatchView({ type: "RESTORE", state: resolution.state });
          if (resolution.outcome === "FACT_CHANGED") {
            setReturnNotice(restored.revision === response.revision
              ? "已重新校验返回位置。原选区的可售、状态、来源、冲突或允许动作已经变化；已保留选区供核对并将焦点移至选区起点。旧 Preview 不会继续使用。"
              : "房态 revision 已变化，且原选区的可售、状态、来源、冲突或允许动作已经变化；已保留选区供核对并将焦点移至选区起点。旧 Preview 不会继续使用。");
          } else if (resolution.outcome === "FALLBACK") {
            setReturnNotice(`原焦点或选区在当前筛选、展开、分页或日期窗口中已不可见。${pageAdjusted ? "原分页已失效；" : ""}${resolution.filtersCleared ? "原筛选已无结果并已清除；" : ""}已清除旧选区并将焦点移至当前视图首个可见房间和日期。旧 Preview 不会继续使用。`);
          } else if (resolution.outcome === "EMPTY") {
            setReturnNotice("原房态返回位置已失效，且当前页没有可聚焦的库存日期格。已清除旧焦点和选区；旧 Preview 不会继续使用。");
          } else if (restored.revision === response.revision) {
            const adjusted = pageAdjusted || resolution.dateWindowAdjusted || resolution.scrollAnchorAdjusted;
            setReturnNotice(adjusted
              ? "已恢复上次房态范围、筛选、展开、选区和焦点；不可用的分页、日期窗口或滚动锚点已校正到当前可见内容。"
              : "已恢复上次房态范围、筛选、展开、滚动、选区和焦点。它们均已验证为当前可见且可聚焦。"
            );
          } else {
            setReturnNotice("房态 revision 已变化。已刷新并确认原选区与焦点在当前筛选、展开、分页和日期窗口中仍可见；任何旧 Preview 均已作废。");
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
  const boardStale = Boolean(boardForCurrentProperty && (boardExpired || queryError));
  const rangeLoading = queryPhase === "RANGE_LOADING"
    || Boolean(boardForCurrentProperty && !boardMatchesCurrentQuery);
  const queryBusy = queryPhase === "LOADING"
    || queryPhase === "RANGE_LOADING"
    || queryPhase === "REFRESHING"
    || Boolean(board && !boardMatchesCurrentQuery);
  const projectionWritable = Boolean(board
    && boardMatchesCurrentQuery
    && !boardStale
    && !focusAfterNextBoard.current
    && board.projectionState === "READY"
    && board.accessLevel === "WRITE"
    && (queryPhase === "READY" || queryPhase === "REFRESHING"));
  const commandsBlocked = commandRecovery.blocked || !projectionWritable;
  const renderedBoard = useMemo(
    () => boardForCurrentProperty
      ? displayRoomStatusBoard(boardForCurrentProperty, commandsBlocked && !command, boardStale)
      : undefined,
    [boardForCurrentProperty, boardStale, command, commandsBlocked]
  );
  const filteredViewHasNoRooms = Boolean(renderedBoard
    && hasActiveRoomStatusFilters(viewState.filters)
    && filterRoomStatusRooms(renderedBoard.rooms, viewState.filters).length === 0);
  const selectedUnit = findRoomStatusUnit(renderedBoard, selectedUnitId ?? viewState.selection?.unitId);
  const selectedDay = selectedUnit?.days.find((day) => day.serviceDate === selectedDayDate) ?? null;
  const selectedInterval = selectedUnit?.intervals.find((interval) => interval.id === selectedIntervalId) ?? null;
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
    if (!renderedBoard || viewState.dateWindowMode !== "AUTO") return;
    const autoSize = roomStatusAutoVisibleDays(boardColumnWidth);
    if (autoSize === viewState.dateWindowSize) return;
    dispatchView({
      type: "SET_DATE_WINDOW_MODE",
      mode: "AUTO",
      autoSize,
      totalDates: renderedBoard.dates.length
    });
  }, [boardColumnWidth, renderedBoard, viewState.dateWindowMode, viewState.dateWindowSize]);

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
    const target = pendingOrderReturnTarget.current;
    if (!renderedBoard || !boardMatchesCurrentQuery || orderReturnResolutionStarted.current) return;
    if (!target) {
      if (!orderReturnEnvelopePresent.current) return;
      orderReturnEnvelopePresent.current = false;
      navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
      dispatchView({ type: "SET_SELECTION", selection: null });
      setReturnNotice("订单返回信息已损坏，未恢复旧的订单上下文。请按最新房态重新选择。");
      return;
    }
    if (target.propertyId !== propertyId) {
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
    if (!selectedOrderIdentity || !renderedBoard) return;
    const identityOutsideCurrentRange = selectedOrderIdentity.departureDate <= renderedBoard.range.arrivalDate
      || selectedOrderIdentity.arrivalDate >= renderedBoard.range.departureDate;
    if (identityOutsideCurrentRange) return;
    const stayStillProjected = renderedBoard.rooms
      .flatMap((room) => [room, ...room.children])
      .some((unit) => unit.intervals.some((interval) => interval.references.some(
        (reference) => reference.type === "STAY" && reference.id === selectedOrderIdentity.stayId
      )));
    if (stayStillProjected) return;
    let current = true;
    const findMovedStay = async () => {
      for (let pageIndex = 0; pageIndex < renderedBoard.page.totalPages; pageIndex += 1) {
        if (pageIndex === renderedBoard.page.index) continue;
        const response = await api.roomStatus(propertyId, roomStatusQuery(range, pageIndex, viewState.filters));
        if (!current) return;
        assertRoomStatusBoard(response, { propertyId, range, pageIndex });
        for (const unit of response.rooms.flatMap((room) => [room, ...room.children])) {
          const interval = unit.intervals.find((candidate) => candidate.references.some(
            (reference) => reference.type === "STAY" && reference.id === selectedOrderIdentity.stayId
          ));
          const identity = interval ? roomStatusOrderIdentityForInterval(interval) : null;
          if (!identity || identity.orderId !== selectedOrderIdentity.orderId) continue;
          const triggerDate = selectedDayDate && identity.arrivalDate <= selectedDayDate && selectedDayDate < identity.departureDate
            ? selectedDayDate
            : identity.arrivalDate;
          const parentRoomId = meta.inventoryUnits.find((candidate) => candidate.id === unit.id)?.parent_room_id;
          if (parentRoomId && !viewState.expandedRoomIds.includes(parentRoomId)) {
            dispatchView({ type: "TOGGLE_ROOM", roomId: parentRoomId });
          }
          dispatchView({ type: "SET_ROOM_PAGE", index: pageIndex, totalPages: response.page.totalPages });
          dispatchView({
            type: "SET_SELECTION",
            selection: {
              unitId: identity.unitId,
              anchorDate: triggerDate,
              focusDate: triggerDate,
              arrivalDate: identity.arrivalDate,
              departureDate: identity.departureDate
            }
          });
          setSelectedUnitId(identity.unitId);
          setSelectedDayDate(triggerDate);
          setSelectedIntervalId(identity.intervalId);
          setSelectedOrderIdentity(identity);
          setReturnNotice("房态 revision 已变化，住宿已移动到其他房源页；已保留订单上下文并定位到最新分段。");
          return;
        }
      }
      if (!current) return;
      setSelectedOrderIdentity(undefined);
      setSelectedOrderView(undefined);
      setSelectedCorrectionOccupantId(undefined);
      setOrderContextOpen(false);
      setReturnNotice("原先选中的住宿已不在最新房态投影中，订单上下文已安全关闭。请按最新房态重新选择。");
    };
    void findMovedStay().catch((error: unknown) => {
      if (!current) return;
      setActionError(error);
      setReturnNotice("房态 revision 已变化，但暂时无法核对该住宿是否移动到其他房源页；订单上下文保持打开，请刷新后重试。");
    });
    return () => { current = false; };
  }, [
    meta.inventoryUnits,
    propertyId,
    range.arrivalDate,
    range.departureDate,
    renderedBoard,
    selectedDayDate,
    selectedOrderIdentity,
    viewState.expandedRoomIds,
    viewState.filters
  ]);
  const policies = meta.pricingPolicyVersions.filter((policy) => policy.property_id === propertyId && policy.status === "PUBLISHED");
  const filterOptions = renderedBoard?.filterOptions ?? {
    roomTypeCodes: [],
    salesModes: [],
    statuses: [],
    capacities: []
  };
  const filteredRoomCount = renderedBoard?.page.totalRooms ?? 0;
  const todayDate = localDateInTimeZone(propertyTimezone);
  const mobileGroups = useMemo(() => renderedBoard ? buildMobileGroups(renderedBoard) : { arrivals: [], inHouse: [], departures: [], exceptions: [] }, [renderedBoard]);
  const activeMobileTasks = mobileTab === "ARRIVALS"
    ? mobileGroups.arrivals
    : mobileTab === "IN_HOUSE"
      ? mobileGroups.inHouse
      : mobileTab === "DEPARTURES"
        ? mobileGroups.departures
        : mobileGroups.exceptions;
  const quoteUnit = findRoomStatusUnit(renderedBoard, quoteTarget?.unitId);
  const pageQuoteRecovery = browserQuoteRecovery(principal.subjectId, propertyId).read;
  const showQuoteWorkbench = Boolean(quoteTarget) || pageQuoteRecovery.kind !== "ABSENT";
  const quoteActionUnit = quoteTarget && quoteUnit ? actionUnit(quoteUnit, projectionWritable) : undefined;

  function clearTransientRoomStatusContext() {
    setSelectedUnitId(undefined);
    setSelectedDayDate(undefined);
    setSelectedIntervalId(undefined);
    setSelectedOrderIdentity(undefined);
    setSelectedOrderView(undefined);
    setSelectedCorrectionOccupantId(undefined);
    setOrderContextOpen(false);
    setQuoteTarget(undefined);
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
    if (nights > 90) {
      setRangeError(new Error("房态日期范围最多为 90 夜。"));
      return;
    }
    setRangeError(undefined);
    setRange(next);
    dispatchView({ type: "SET_ROOM_PAGE", index: 0, totalPages: 1 });
    dispatchView({ type: "SET_DATE_WINDOW", start: 0, totalDates: nights });
    dispatchView({ type: "SET_SELECTION", selection: null });
    dispatchView({ type: "SET_FOCUS", focus: null });
    clearTransientRoomStatusContext();
  }

  function shiftRange(direction: -1 | 1) {
    const nights = Math.max(1, rangeNights(range));
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

  function changeDateWindowMode(mode: RoomStatusDateWindowMode) {
    const autoSize = roomStatusAutoVisibleDays(boardColumnWidth);
    const requestedSize = mode === "AUTO" ? autoSize : Number(mode);
    const totalDates = renderedBoard?.dates.length ?? rangeNights(range);
    if (requestedSize > totalDates) {
      applyRange({
        arrivalDate: range.arrivalDate,
        departureDate: addLocalDateDays(range.arrivalDate, requestedSize)
      });
      dispatchView({
        type: "SET_DATE_WINDOW_MODE",
        mode,
        autoSize,
        totalDates: requestedSize
      });
      return;
    }
    dispatchView({
      type: "SET_DATE_WINDOW_MODE",
      mode,
      autoSize,
      totalDates
    });
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

  function inspectUnit(unit: RoomStatusUnitDto) {
    setQuoteRecoveryOutcome(undefined);
    setSelectedOrderIdentity(undefined);
    setSelectedCorrectionOccupantId(undefined);
    setOrderContextOpen(false);
    setSelectedUnitId(unit.id);
    setSelectedDayDate(undefined);
    setSelectedIntervalId(undefined);
  }

  function selectOrderContextIdentity(identity: RoomStatusOrderIdentity, serviceDate?: string) {
    const sameOrder = selectedOrderIdentity?.orderId === identity.orderId
      && selectedOrderIdentity.stayId === identity.stayId;
    setActionError(undefined);
    setSelectedUnitId(identity.unitId);
    setSelectedDayDate(serviceDate);
    setSelectedIntervalId(identity.intervalId);
    setSelectedOrderIdentity(identity);
    if (!sameOrder) setSelectedOrderView(undefined);
    setSelectedCorrectionOccupantId(undefined);
    setQuoteTarget(undefined);
    setOrderContextOpen(true);
    setDesktopContextCollapsed(false);
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

  function inspectDay(unit: RoomStatusUnitDto, day: RoomStatusDayDto | null) {
    setQuoteRecoveryOutcome(undefined);
    setActionError(undefined);
    setSelectedUnitId(unit.id);
    const orderIdentity = day ? roomStatusOrderIdentityForDate(unit, day.serviceDate) : null;
    if (orderIdentity) {
      selectOrderContextIdentity(orderIdentity, day?.serviceDate);
    } else if (day && !day.available) {
      setSelectedOrderIdentity(undefined);
      setSelectedOrderView(undefined);
      setSelectedCorrectionOccupantId(undefined);
      setOrderContextOpen(false);
      setQuoteTarget(undefined);
      dispatchView({ type: "SET_SELECTION", selection: selectionFromCells(unit.id, day.serviceDate, day.serviceDate) });
      setActionError(new Error(unit.kind === "ROOM" && unit.salesMode === "BED_SPLIT"
        ? "该房间格汇总床位占用，不能代表一张订单。请展开房间并选择具体床位。"
        : "当前占用缺少唯一、稳定的订单引用，未打开订单或新建住宿流程。请刷新后重新核对。"));
    } else if (day) {
      selectRange(selectionFromCells(unit.id, day.serviceDate, day.serviceDate));
    }
    if (!orderIdentity) {
      setSelectedDayDate(day?.serviceDate);
      setSelectedIntervalId(undefined);
    }
  }

  function inspectInterval(unit: RoomStatusUnitDto, interval: RoomStatusIntervalDto) {
    setQuoteRecoveryOutcome(undefined);
    setSelectedOrderIdentity(undefined);
    setSelectedCorrectionOccupantId(undefined);
    setOrderContextOpen(false);
    setSelectedUnitId(unit.id);
    selectRange({
      unitId: unit.id,
      anchorDate: interval.startDate,
      focusDate: addLocalDateDays(interval.endDate, -1),
      arrivalDate: interval.startDate,
      departureDate: interval.endDate
    });
    setSelectedDayDate(undefined);
    setSelectedIntervalId(interval.id);
  }

  function selectRange(selection: RoomStatusSelection | null) {
    setQuoteRecoveryOutcome(undefined);
    setSelectedOrderIdentity(undefined);
    setSelectedOrderView(undefined);
    setSelectedCorrectionOccupantId(undefined);
    setOrderContextOpen(false);
    dispatchView({ type: "SET_SELECTION", selection });
    if (selection) {
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

  function closeSelectedOrderContext() {
    setSelectedCorrectionOccupantId(undefined);
    setOrderContextOpen(false);
    setDesktopContextCollapsed(true);
    setFocusRequestToken((value) => value + 1);
  }

  function closeDesktopContext() {
    setDesktopContextCollapsed(true);
    if (selectedOrderIdentity) setOrderContextOpen(false);
    setFocusRequestToken((value) => value + 1);
  }

  function reopenDesktopContext() {
    setDesktopContextCollapsed(false);
    if (selectedOrderIdentity) setOrderContextOpen(true);
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

  function startCommand(request: CommandRequest): boolean {
    if (commandsBlocked) {
      setActionError(new Error("当前房态已陈旧、正在刷新、权限已收窄或命令恢复尚未收口；命令未发送，表单草稿保持不变。"));
      return false;
    }
    const attemptId = commandAttemptGuard.begin();
    setCommandAttemptId(attemptId);
    commandPhaseRef.current = "DRAFT";
    commandRevisionRef.current = boardRef.current?.revision;
    setCommandContextInvalidated(false);
    setRecoveryDialogOpen(false);
    setActionError(undefined);
    setCommandDraft(undefined);
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
    const attemptId = commandAttemptGuard.begin();
    setCommandAttemptId(attemptId);
    commandPhaseRef.current = "CONFIRMING";
    commandRevisionRef.current = boardRef.current?.revision;
    setCommandContextInvalidated(false);
    setRecoveryDialogOpen(true);
    setCommand(recoveryCommandRequest(commandRecovery.pending));
  }

  function closeCommandDialog(context?: CommandDialogCloseContext) {
    let refreshAfterClose = context?.receipt.businessCommitted === true;
    const pendingAtClose = commandRecovery.pending;
    const terminalAtClose = Boolean(context || (pendingAtClose && isTerminalCommandRecovery(pendingAtClose.state)));
    if (terminalAtClose) {
      refreshAfterClose ||= pendingAtClose?.state === "EXECUTED";
      if (refreshAfterClose && (pendingAtClose?.commandType === "CREATE_ORDER" || command?.commandType === "CREATE_ORDER")) {
        setQuoteResetToken((value) => value + 1);
        setQuoteTarget(undefined);
      }
      if (commandRecovery.clearResolved()) setRecoveryError(undefined);
      else setRecoveryError(new Error("无法清除已收口的本地恢复记录；为避免重复库存写入，命令继续保持暂停"));
    }
    commandAttemptGuard.invalidate();
    commandPhaseRef.current = "IDLE";
    commandRevisionRef.current = undefined;
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

  function trackCommandProgress(request: CommandRequest, progress: CommandDialogProgress, attemptId: number): boolean {
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
    }
    refreshedReceiptIdRef.current = receipt.receiptId;
  }

  const roomStatusToolbar = renderedBoard ? (
    <RoomStatusToolbar
      board={renderedBoard}
      propertyLabel={`${property?.code ?? propertyId} · ${property?.name ?? propertyId}`}
      principalLabel={principal.displayName}
      range={range}
      filters={viewState.filters}
      filterOptions={filterOptions}
      filteredRoomCount={filteredRoomCount}
      loading={queryBusy}
      rangeLoading={rangeLoading}
      rangeError={rangeError instanceof Error ? rangeError.message : undefined}
      focusSearchRequestToken={filterFocusRequestToken}
      onRangeChange={applyRange}
      onPreviousRange={() => shiftRange(-1)}
      onNextRange={() => shiftRange(1)}
      onToday={() => {
        const nights = Math.max(1, rangeNights(range));
        applyRange({ arrivalDate: todayDate, departureDate: addLocalDateDays(todayDate, nights) });
      }}
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
        loading={selectedOrderLoading}
        writeBlocked={commandsBlocked || authorizedSelectedOrderView.accessLevel !== "WRITE"}
        onClose={closeSelectedOrderContext}
        onOpenOrder={openSelectedOrder}
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
        onOpenReference={openReference}
        onOpenReceipt={(receiptId) => window.open(`/api/v1/receipts/${encodeURIComponent(receiptId)}`, "_blank", "noopener,noreferrer")}
        onAction={handleAction}
        {...(useInlineOrderContext ? { onClose: closeDesktopContext } : {})}
      />
      {showQuoteWorkbench ? (
        <div className="room-status-quote-section" ref={quoteSectionRef}>
          <QuoteWorkbench
            unit={quoteActionUnit}
            arrivalDate={quoteTarget?.arrivalDate ?? range.arrivalDate}
            departureDate={quoteTarget?.departureDate ?? range.departureDate}
            policies={policies}
            {...(quoteTarget ? { initialStayType: quoteTarget.initialStayType } : {})}
            commandsBlocked={commandsBlocked}
            resetToken={quoteResetToken}
            onClose={() => setQuoteTarget(undefined)}
            onRecoveryOutcome={setQuoteRecoveryOutcome}
            onCommand={startCommand}
          />
        </div>
      ) : null}
    </>
  ) : null;

  return (
    <div className="inventory-page room-status-page">
      <header className="page-heading page-heading-actions">
        <div><p className="eyebrow">房态总览</p><h1>房态与可售</h1><p>房间、床位与订单的统一运营视图</p></div>
        <button className="button button-secondary" type="button" onClick={() => setRefreshToken((value) => value + 1)} disabled={queryBusy}>
          <RefreshCw className={queryBusy ? "spin" : ""} aria-hidden="true" size={17} />刷新
        </button>
      </header>

      {queryPhase !== "PERMISSION_DENIED" ? <InlineError error={recoveryError} title="恢复记录未收口" /> : null}
      {queryPhase !== "PERMISSION_DENIED" ? <InlineError error={commandRecovery.error} title="本地命令恢复记录不可用" /> : null}
      <CommandResultNotice message={commandNotice} onDismiss={() => setCommandNotice(undefined)} />
      <InlineError error={restorationError} title="房态位置未保存" />
      <InlineError error={actionError} title="动作未开始" />
      <InlineError error={quoteRecoveryOutcome} title="报价恢复结果" />
      {queryPhase !== "PERMISSION_DENIED" && commandRecovery.pending ? <CommandRecoveryBar recovery={commandRecovery.pending} onOpen={openRecoveryDialog} testId="inventory-command-recovery" businessFacing={commandRecovery.pending.presentation === "MEMBER_STAY" || commandRecovery.pending.presentation === "FULFILLMENT"} /> : null}
      {returnNotice ? <div className="room-status-return-notice" role="status">{returnNotice}</div> : null}
      {boardStale ? <div className="room-status-stale-notice" role="alert">当前房态已陈旧或刷新失败。页面保留最后一次来源事实，但所有依赖新鲜度的写动作已暂停。</div> : null}
      {queryError ? <InlineError error={queryError} title={board ? "房态刷新失败" : "无法查询房态"} /> : null}

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
                filters={viewState.filters}
                expandedRoomIds={viewState.expandedRoomIds}
                focusedCell={viewState.focusedCell}
                selection={viewState.selection}
                selectedStayId={selectedOrderIdentity?.stayId ?? null}
                dateWindowStart={viewState.dateWindowStart}
                dateWindowSize={viewState.dateWindowSize}
                dateWindowMode={viewState.dateWindowMode}
                todayDate={todayDate}
                initialScrollAnchor={viewState.scrollAnchor}
                restoreFocus={Boolean(returnNotice)}
                focusRequestToken={focusRequestToken}
                onToggleRoom={(roomId) => dispatchView({ type: "TOGGLE_ROOM", roomId })}
                onFocusedCellChange={(focus) => dispatchView({ type: "SET_FOCUS", focus })}
                onSelectionChange={selectRange}
                onPageChange={(index) => changeRoomPage(index, renderedBoard.page.totalPages)}
                onDateWindowChange={(start) => changeDateWindow(start, renderedBoard.dates.length)}
                onDateWindowModeChange={changeDateWindowMode}
                onInspectUnit={inspectUnit}
                onInspectDay={inspectDay}
                onInspectInterval={inspectInterval}
                onClearFilters={clearFilters}
                onScrollAnchorChange={(anchor) => dispatchView({ type: "SET_SCROLL_ANCHOR", anchor })}
              />
              <RoomStatusMobileTasks
                board={renderedBoard}
                groups={mobileGroups}
                activeTab={mobileTab}
                canCreate={!commandsBlocked && renderedBoard.accessLevel === "WRITE"}
                focusRequest={mobileFocusRequest}
                onTabChange={setMobileTab}
                onPageChange={(index) => changeRoomPage(index, renderedBoard.page.totalPages)}
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

          {!isMobile && !desktopContextCollapsed && !useInlineOrderContext && (!selectedOrderIdentity || orderContextOpen) ? (
            <Modal
              title={selectedOrderIdentity ? "订单上下文" : "选中对象上下文"}
              size="drawer"
              modal={false}
              onClose={closeDesktopContext}
              footer={null}
            >
              {selectedOrderIdentity ? selectedOrderContext : desktopSelectionContext}
            </Modal>
          ) : null}

          {isMobile && selectedOrderIdentity && orderContextOpen ? (
            <Modal title="订单上下文" size="mobile-fullscreen" modal onClose={closeSelectedOrderContext} footer={null}>
              {selectedOrderContext}
            </Modal>
          ) : null}

          {!isMobile && desktopContextCollapsed ? (
            <button type="button" className="button button-primary room-status-context-reopen" onClick={reopenDesktopContext}>
              <PanelRightOpen aria-hidden="true" size={17} />打开{selectedOrderIdentity ? "订单上下文" : "选中对象上下文"}
            </button>
          ) : null}

          {isMobile ? roomStatusToolbar : null}

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
                arrivalDate={quoteTarget?.arrivalDate ?? range.arrivalDate}
                departureDate={quoteTarget?.departureDate ?? range.departureDate}
                policies={policies}
                {...(quoteTarget ? { initialStayType: quoteTarget.initialStayType } : {})}
                commandsBlocked={commandsBlocked}
                resetToken={quoteResetToken}
                onClose={() => setQuoteTarget(undefined)}
                onRecoveryOutcome={setQuoteRecoveryOutcome}
                onCommand={startCommand}
              />
            </div>
          ) : null}
        </>
      )}

      {maintenanceTarget && viewState.selection && !command ? <MaintenanceDialog unit={maintenanceTarget} arrivalDate={viewState.selection.arrivalDate} departureDate={viewState.selection.departureDate} writeBlocked={commandsBlocked} {...(commandDraft?.commandType === "LOCK_MAINTENANCE" ? { draft: commandDraft } : {})} onClose={() => { setMaintenanceTarget(undefined); setCommandDraft(undefined); }} onSubmit={startCommand} /> : null}
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
          setSelectedOrderCommandScope(orderPrincipalScope);
          startCommand(request);
        }}
      /> : null}
      {command && (command.commandType !== "CORRECT_ORDER_OCCUPANT" || selectedOrderCommandScope === orderPrincipalScope) ? <CommandDialog
        key={recoveryDialogOpen ? `recovery-${commandRecovery.pending?.confirmationKey ?? "missing"}-${commandAttemptId}` : `new-room-status-command-${commandAttemptId}`}
        request={command}
        onClose={closeCommandDialog}
        writeBlocked={!recoveryDialogOpen && (commandsBlocked || commandContextInvalidated)}
        writeBlockedReason="房态权限、查询范围、数据新鲜度或操作恢复状态已经变化。请关闭后刷新，再重新核对本次操作。"
        onCommitted={refreshCommittedRoomStatus}
        onBusinessSuccess={(message) => {
          setCommandNotice(message);
          setCommandDraft(undefined);
          if (command.commandType === "LOCK_MAINTENANCE") setMaintenanceTarget(undefined);
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

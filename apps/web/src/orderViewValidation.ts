import type {
  OrderArrangementDto,
  OrderArrangementHistoryItemDto,
  OrderEffectiveArrangementDto,
  OrderFulfillmentProjectionDto
} from "@qintopia/contracts";
import { orderActionCodes } from "@qintopia/contracts";
import type { OrderViewDto } from "./types";

type JsonRecord = Record<string, unknown>;

const localDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const arrangementChangeTypes = new Set(["INITIAL_BOOKING", "RESCHEDULE", "EXTENSION", "SHORTENING", "MOVE", "EARLY_CHECK_OUT"]);
const effectivePresentations = new Set(["CURRENT", "LAST", "BEFORE_CANCELLATION", "NO_SHOW_ORDER", "BEFORE_CHECK_IN_REVOCATION"]);
const fulfillmentStates = new Set(["NOT_CHECKED_IN", "IN_HOUSE", "CHECKED_OUT", "CANCELLED", "NO_SHOW", "CHECK_IN_REVOKED"]);
const recordingModes = new Set(["ON_SCHEDULE", "LATE_RECORDED", "LEGACY_UNCLASSIFIED"]);
const pricingBases = new Set(["POLICY", "CHANNEL_CONTRACT", "MANUAL_ADJUSTMENT", "MEMBER_ENTITLEMENT", "FREE"]);
const actionCodes = new Set<string>(orderActionCodes);
const historicalProtocolByAmendmentType = new Map<string, string>([
  ["RESCHEDULE_STAY", "LEGACY_STAGE_9_10"],
  ["EXTEND_STAY", "LEGACY_STAGE_9_10"],
  ["SHORTEN_STAY", "LEGACY_STAGE_10"],
  ["MOVE_UNIT", "PRE_STAGE_11"]
]);
const orderProjectionExpectations = {
  RESERVED: { stayStatus: "PLANNED", fulfillmentState: "NOT_CHECKED_IN", presentation: "CURRENT" },
  CHECKED_IN: { stayStatus: "IN_HOUSE", fulfillmentState: "IN_HOUSE", presentation: "CURRENT" },
  CHECKED_OUT: { stayStatus: "COMPLETED", fulfillmentState: "CHECKED_OUT", presentation: "LAST" },
  CANCELLED: { stayStatus: "CANCELLED", fulfillmentState: "CANCELLED", presentation: "BEFORE_CANCELLATION" },
  NO_SHOW: { stayStatus: "NO_SHOW", fulfillmentState: "NO_SHOW", presentation: "NO_SHOW_ORDER" },
  CHECK_IN_REVOKED: { stayStatus: "CHECK_IN_REVOKED", fulfillmentState: "CHECK_IN_REVOKED", presentation: "BEFORE_CHECK_IN_REVOCATION" }
} as const;

export class OrderViewValidationError extends Error {
  constructor(path: string, message: string) {
    super(`订单详情数据 ${path}${message}`);
    this.name = "OrderViewValidationError";
  }
}

function fail(path: string, message: string): never {
  throw new OrderViewValidationError(path, message);
}

function record(value: unknown, path: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "必须是对象");
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, path: string, keys: readonly string[]) {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) fail(`${path}.${unexpected}`, "不是允许的字段");
  const missing = keys.find((key) => !(key in value));
  if (missing) fail(`${path}.${missing}`, "缺失");
}

function exactKeysWithOptional(value: JsonRecord, path: string, required: readonly string[], optional: readonly string[] = []) {
  const allowed = new Set([...required, ...optional]);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) fail(`${path}.${unexpected}`, "不是允许的字段");
  const missing = required.find((key) => !(key in value));
  if (missing) fail(`${path}.${missing}`, "缺失");
}

function historicalAmendmentMetadata(amendment: JsonRecord, path: string, amendmentType: string) {
  const hasProtocolVersion = Object.hasOwn(amendment, "protocolVersion");
  const hasRecoveryMode = Object.hasOwn(amendment, "recoveryMode");
  if (hasProtocolVersion !== hasRecoveryMode) {
    fail(path, "历史协议版本与只读恢复标记必须成对提供");
  }
  if (!hasProtocolVersion) return;
  if (amendment.recoveryMode !== "HISTORICAL_READ_ONLY") {
    fail(`${path}.recoveryMode`, "不是支持的历史读取模式");
  }
  const protocolVersion = stringValue(amendment.protocolVersion, `${path}.protocolVersion`);
  const expectedProtocolVersion = historicalProtocolByAmendmentType.get(amendmentType);
  if (!expectedProtocolVersion || protocolVersion !== expectedProtocolVersion) {
    fail(`${path}.protocolVersion`, "与住宿变更类型不一致");
  }
}

function stringValue(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) fail(path, "必须是非空文字");
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return stringValue(value, path, true);
}

function safeInteger(value: unknown, path: string, minimum?: number): number {
  if (!Number.isSafeInteger(value) || (minimum !== undefined && Number(value) < minimum)) {
    fail(path, minimum === undefined ? "必须是安全整数" : `必须是大于或等于 ${minimum} 的安全整数`);
  }
  return value as number;
}

function arrayValue(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "必须是数组");
  return value;
}

function localDate(value: unknown, path: string): string {
  const result = stringValue(value, path);
  if (!localDatePattern.test(result) || Number.isNaN(Date.parse(`${result}T00:00:00Z`))) fail(path, "必须是有效营业日期");
  const parsed = new Date(`${result}T00:00:00Z`).toISOString().slice(0, 10);
  if (parsed !== result) fail(path, "必须是有效营业日期");
  return result;
}

function dateTime(value: unknown, path: string): string {
  const result = stringValue(value, path);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result)) {
    fail(path, "必须是规范的 UTC 记录时间");
  }
  const parsed = new Date(result);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== result) {
    fail(path, "必须是规范的 UTC 记录时间");
  }
  return result;
}

function nullableActor(value: unknown, path: string): { subjectId: string; displayName: string } | null {
  if (value === null) return null;
  const actor = record(value, path);
  exactKeys(actor, path, ["subjectId", "displayName"]);
  return {
    subjectId: stringValue(actor.subjectId, `${path}.subjectId`),
    displayName: stringValue(actor.displayName, `${path}.displayName`)
  };
}

function reason(value: unknown, path: string): { code: string; note: string } {
  const result = record(value, path);
  exactKeys(result, path, ["code", "note"]);
  return {
    code: stringValue(result.code, `${path}.code`),
    note: stringValue(result.note, `${path}.note`, true)
  };
}

function occupantSnapshot(value: unknown, path: string): void {
  const snapshot = record(value, path);
  exactKeys(snapshot, path, ["fullName", "nickname", "phone", "documentNumber"]);
  nullableString(snapshot.fullName, `${path}.fullName`);
  nullableString(snapshot.nickname, `${path}.nickname`);
  nullableString(snapshot.phone, `${path}.phone`);
  nullableString(snapshot.documentNumber, `${path}.documentNumber`);
}

function money(value: unknown, path: string): { currency: string; minorUnits: number } {
  const result = record(value, path);
  exactKeys(result, path, ["currency", "minorUnits"]);
  if (!Number.isSafeInteger(result.minorUnits)) fail(`${path}.minorUnits`, "必须是安全整数");
  const currency = stringValue(result.currency, `${path}.currency`);
  if (!/^[A-Z]{3}$/.test(currency)) fail(`${path}.currency`, "必须是三位大写货币代码");
  return {
    currency,
    minorUnits: result.minorUnits as number
  };
}

function arrangement(value: unknown, path: string): OrderArrangementDto {
  const result = record(value, path);
  exactKeys(result, path, ["arrivalDate", "departureDate", "intervals"]);
  const arrivalDate = localDate(result.arrivalDate, `${path}.arrivalDate`);
  const departureDate = localDate(result.departureDate, `${path}.departureDate`);
  if (departureDate <= arrivalDate) fail(path, "日期区间无效");
  if (!Array.isArray(result.intervals) || result.intervals.length === 0) fail(`${path}.intervals`, "必须包含住宿区间");
  const intervals = result.intervals.map((item, index) => {
    const intervalPath = `${path}.intervals[${index}]`;
    const interval = record(item, intervalPath);
    exactKeys(interval, intervalPath, ["inventoryUnitId", "arrivalDate", "departureDate"]);
    const intervalArrival = localDate(interval.arrivalDate, `${intervalPath}.arrivalDate`);
    const intervalDeparture = localDate(interval.departureDate, `${intervalPath}.departureDate`);
    if (intervalDeparture <= intervalArrival) fail(intervalPath, "日期区间无效");
    return {
      inventoryUnitId: stringValue(interval.inventoryUnitId, `${intervalPath}.inventoryUnitId`),
      arrivalDate: intervalArrival,
      departureDate: intervalDeparture
    };
  });
  if (intervals[0]?.arrivalDate !== arrivalDate || intervals.at(-1)?.departureDate !== departureDate) {
    fail(`${path}.intervals`, "没有完整覆盖住宿周期");
  }
  intervals.forEach((interval, index) => {
    if (index > 0 && intervals[index - 1]?.departureDate !== interval.arrivalDate) {
      fail(`${path}.intervals[${index}]`, "与前一区间不连续");
    }
  });
  return { arrivalDate, departureDate, intervals };
}

function sameArrangement(left: OrderArrangementDto, right: OrderArrangementDto): boolean {
  return left.arrivalDate === right.arrivalDate
    && left.departureDate === right.departureDate
    && left.intervals.length === right.intervals.length
    && left.intervals.every((interval, index) => {
      const other = right.intervals[index];
      return interval.inventoryUnitId === other?.inventoryUnitId
        && interval.arrivalDate === other.arrivalDate
        && interval.departureDate === other.departureDate;
    });
}

function inventoryUnitAt(value: OrderArrangementDto, serviceDate: string): string | undefined {
  return value.intervals.find((interval) => interval.arrivalDate <= serviceDate && serviceDate < interval.departureDate)
    ?.inventoryUnitId;
}

function timelineBoundaries(
  left: OrderArrangementDto,
  right: OrderArrangementDto,
  arrivalDate: string,
  departureDate: string
): string[] {
  return [...new Set([
    arrivalDate,
    departureDate,
    ...left.intervals.flatMap((interval) => [interval.arrivalDate, interval.departureDate]),
    ...right.intervals.flatMap((interval) => [interval.arrivalDate, interval.departureDate])
  ].filter((date) => arrivalDate <= date && date <= departureDate))].sort();
}

function sameInventoryTimeline(
  left: OrderArrangementDto,
  right: OrderArrangementDto,
  arrivalDate: string,
  departureDate: string
): boolean {
  const boundaries = timelineBoundaries(left, right, arrivalDate, departureDate);
  return boundaries.slice(0, -1).every((date) => {
    return inventoryUnitAt(left, date) === inventoryUnitAt(right, date);
  });
}

function isSingleSuffixMove(before: OrderArrangementDto, after: OrderArrangementDto): boolean {
  const boundaries = timelineBoundaries(before, after, before.arrivalDate, before.departureDate).slice(0, -1);
  const effectiveDate = boundaries.find((date) => inventoryUnitAt(before, date) !== inventoryUnitAt(after, date));
  if (!effectiveDate) return false;
  const movedUnitId = inventoryUnitAt(after, effectiveDate);
  return Boolean(movedUnitId) && boundaries
    .filter((date) => date >= effectiveDate)
    .every((date) => inventoryUnitAt(after, date) === movedUnitId);
}

function dateEpoch(value: string): number {
  return Date.parse(`${value}T00:00:00.000Z`);
}

function shiftLocalDate(value: string, days: number): string {
  return new Date(dateEpoch(value) + days * 86_400_000).toISOString().slice(0, 10);
}

function arrangementNights(value: OrderArrangementDto): number {
  return Math.round((dateEpoch(value.departureDate) - dateEpoch(value.arrivalDate)) / 86_400_000);
}

function followsSchemeBReschedule(before: OrderArrangementDto, after: OrderArrangementDto): boolean {
  const beforeNights = arrangementNights(before);
  const afterNights = arrangementNights(after);
  const firstUnit = before.intervals[0]?.inventoryUnitId;
  const lastUnit = before.intervals.at(-1)?.inventoryUnitId;
  if (!firstUnit || !lastUnit) return false;
  for (let offset = 0; offset < afterNights; offset += 1) {
    const newDate = shiftLocalDate(after.arrivalDate, offset);
    let expectedUnit: string | undefined;
    if (beforeNights === afterNights) {
      expectedUnit = inventoryUnitAt(before, shiftLocalDate(before.arrivalDate, offset));
    } else if (after.departureDate <= before.arrivalDate) {
      expectedUnit = firstUnit;
    } else if (after.arrivalDate >= before.departureDate) {
      expectedUnit = lastUnit;
    } else if (newDate < before.arrivalDate) {
      expectedUnit = firstUnit;
    } else if (newDate >= before.departureDate) {
      expectedUnit = lastUnit;
    } else {
      expectedUnit = inventoryUnitAt(before, newDate);
    }
    if (!expectedUnit || inventoryUnitAt(after, newDate) !== expectedUnit) return false;
  }
  return true;
}

function isSingleSuffixExtension(before: OrderArrangementDto, after: OrderArrangementDto): boolean {
  const boundaries = timelineBoundaries(before, after, before.arrivalDate, after.departureDate).slice(0, -1);
  const effectiveDate = boundaries.find((date) => inventoryUnitAt(before, date) !== inventoryUnitAt(after, date));
  if (!effectiveDate) return false;
  const extendedUnitId = inventoryUnitAt(after, effectiveDate);
  if (!extendedUnitId) return false;
  if (effectiveDate === before.departureDate) {
    return before.intervals.at(-1)?.inventoryUnitId === extendedUnitId;
  }
  return boundaries
    .filter((date) => date >= effectiveDate)
    .every((date) => inventoryUnitAt(after, date) === extendedUnitId);
}

function validateArrangementChange(item: OrderArrangementHistoryItemDto, path: string) {
  if (item.type === "INITIAL_BOOKING") {
    if (item.before !== null) fail(path, "初始预订不能包含变更前安排");
    return;
  }
  if (!item.before) fail(`${path}.before`, "非初始变更必须包含变更前安排");
  const before = item.before;
  const after = item.after;
  if (item.type === "RESCHEDULE") {
    if ((before.arrivalDate === after.arrivalDate && before.departureDate === after.departureDate)
      || !followsSchemeBReschedule(before, after)) {
      fail(path, "改期后的房源安排不符合已确认的换房节点平移与首尾裁剪规则");
    }
    return;
  }
  if (item.type === "EXTENSION") {
    if (before.arrivalDate !== after.arrivalDate
      || after.departureDate <= before.departureDate
      || !isSingleSuffixExtension(before, after)) {
      fail(path, "续住必须保留原安排并延长退房日");
    }
    return;
  }
  if (item.type === "SHORTENING" || item.type === "EARLY_CHECK_OUT") {
    if (before.arrivalDate !== after.arrivalDate
      || after.departureDate >= before.departureDate
      || !sameInventoryTimeline(before, after, before.arrivalDate, after.departureDate)) {
      fail(path, "缩短住宿必须保留前段安排并提前退房日");
    }
    return;
  }
  if (before.arrivalDate !== after.arrivalDate
    || before.departureDate !== after.departureDate
    || !isSingleSuffixMove(before, after)) {
    fail(path, "换房必须只改变住宿周期内的房源安排");
  }
}

function effectiveArrangement(value: unknown, path: string): OrderEffectiveArrangementDto {
  const result = record(value, path);
  exactKeys(result, path, ["arrivalDate", "departureDate", "intervals", "presentation", "businessDate"]);
  const base = arrangement({
    arrivalDate: result.arrivalDate,
    departureDate: result.departureDate,
    intervals: result.intervals
  }, path);
  if (!effectivePresentations.has(String(result.presentation))) fail(`${path}.presentation`, "不是支持的业务展示状态");
  return {
    ...base,
    presentation: result.presentation as OrderEffectiveArrangementDto["presentation"],
    businessDate: localDate(result.businessDate, `${path}.businessDate`)
  };
}

function fulfillmentRecord(value: unknown, path: string, expectedType: "CHECK_IN" | "CHECK_OUT" | "REVOKE_CHECK_IN") {
  if (value === null) return null;
  const result = record(value, path);
  exactKeys(result, path, ["type", "plannedBusinessDate", "recordedBusinessDate", "recordingMode", "recordedAt", "actor", "reason"]);
  if (result.type !== expectedType) fail(`${path}.type`, "与履约记录位置不一致");
  if (!recordingModes.has(String(result.recordingMode))) fail(`${path}.recordingMode`, "不是支持的办理方式");
  const plannedBusinessDate = localDate(result.plannedBusinessDate, `${path}.plannedBusinessDate`);
  const recordedBusinessDate = result.recordedBusinessDate === null
    ? null
    : localDate(result.recordedBusinessDate, `${path}.recordedBusinessDate`);
  const recordingMode = result.recordingMode as "ON_SCHEDULE" | "LATE_RECORDED" | "LEGACY_UNCLASSIFIED";
  if (recordingMode === "ON_SCHEDULE" && recordedBusinessDate !== plannedBusinessDate) {
    fail(path, "按计划办理日期与计划日期不一致");
  }
  if (recordingMode === "LATE_RECORDED"
    && ((expectedType !== "CHECK_IN" && expectedType !== "CHECK_OUT")
      || recordedBusinessDate === null || recordedBusinessDate <= plannedBusinessDate)) {
    fail(path, expectedType === "CHECK_IN" ? "迟录入住日期没有晚于计划入住日" : "迟录退房日期没有晚于计划退房日");
  }
  return {
    type: expectedType,
    plannedBusinessDate,
    recordedBusinessDate,
    recordingMode,
    recordedAt: dateTime(result.recordedAt, `${path}.recordedAt`),
    actor: nullableActor(result.actor, `${path}.actor`),
    reason: reason(result.reason, `${path}.reason`)
  };
}

function fulfillment(value: unknown, path: string): OrderFulfillmentProjectionDto {
  const result = record(value, path);
  exactKeys(result, path, ["state", "checkIn", "checkOut", "checkInRevocation"]);
  if (!fulfillmentStates.has(String(result.state))) fail(`${path}.state`, "不是支持的履约状态");
  const checkIn = fulfillmentRecord(result.checkIn, `${path}.checkIn`, "CHECK_IN");
  const checkOut = fulfillmentRecord(result.checkOut, `${path}.checkOut`, "CHECK_OUT");
  const checkInRevocation = fulfillmentRecord(result.checkInRevocation, `${path}.checkInRevocation`, "REVOKE_CHECK_IN");
  const valid = result.state === "NOT_CHECKED_IN" || result.state === "CANCELLED" || result.state === "NO_SHOW"
    ? !checkIn && !checkOut && !checkInRevocation
    : result.state === "IN_HOUSE"
      ? Boolean(checkIn) && !checkOut && !checkInRevocation
      : result.state === "CHECKED_OUT"
        ? Boolean(checkIn) && Boolean(checkOut) && !checkInRevocation
        : result.state === "CHECK_IN_REVOKED" && Boolean(checkIn) && !checkOut && Boolean(checkInRevocation);
  if (!valid) fail(path, "履约状态与入住、退房或撤销记录不一致");
  if (checkIn && checkOut && Date.parse(checkOut.recordedAt) < Date.parse(checkIn.recordedAt)) {
    fail(path, "退房记录时间早于入住记录时间");
  }
  if (checkIn && checkInRevocation && Date.parse(checkInRevocation.recordedAt) < Date.parse(checkIn.recordedAt)) {
    fail(path, "撤销入住记录时间早于入住记录时间");
  }
  return { state: result.state as OrderFulfillmentProjectionDto["state"], checkIn, checkOut, checkInRevocation };
}

function historyItem(value: unknown, path: string): OrderArrangementHistoryItemDto {
  const result = record(value, path);
  exactKeys(result, path, ["type", "before", "after", "reason", "actor", "recordedAt", "pricingSummary", "fundsSummary"]);
  if (!arrangementChangeTypes.has(String(result.type))) fail(`${path}.type`, "不是支持的住宿安排变更");
  const pricing = record(result.pricingSummary, `${path}.pricingSummary`);
  exactKeys(pricing, `${path}.pricingSummary`, ["policyBaseAmount", "currentContractAmount", "differenceFromPolicy"]);
  const funds = record(result.fundsSummary, `${path}.fundsSummary`);
  exactKeys(funds, `${path}.fundsSummary`, ["netRecordedCollection", "collectionDifference", "refundReferenceAmount", "factCount"]);
  if (!Number.isSafeInteger(funds.factCount) || Number(funds.factCount) < 0) fail(`${path}.fundsSummary.factCount`, "必须是非负整数");
  const policyBaseAmount = money(pricing.policyBaseAmount, `${path}.pricingSummary.policyBaseAmount`);
  const currentContractAmount = money(pricing.currentContractAmount, `${path}.pricingSummary.currentContractAmount`);
  const differenceFromPolicy = money(pricing.differenceFromPolicy, `${path}.pricingSummary.differenceFromPolicy`);
  const netRecordedCollection = money(funds.netRecordedCollection, `${path}.fundsSummary.netRecordedCollection`);
  const collectionDifference = money(funds.collectionDifference, `${path}.fundsSummary.collectionDifference`);
  const refundReferenceAmount = money(funds.refundReferenceAmount, `${path}.fundsSummary.refundReferenceAmount`);
  const amounts = [policyBaseAmount, currentContractAmount, differenceFromPolicy, netRecordedCollection, collectionDifference, refundReferenceAmount];
  if (amounts.some((amount) => amount.currency !== currentContractAmount.currency)) {
    fail(path, "金额摘要币种不一致");
  }
  const expectedDifferenceFromPolicy = currentContractAmount.minorUnits - policyBaseAmount.minorUnits;
  if (!Number.isSafeInteger(expectedDifferenceFromPolicy)
    || differenceFromPolicy.minorUnits !== expectedDifferenceFromPolicy) {
    fail(`${path}.pricingSummary.differenceFromPolicy`, "与政策基础金额差额不一致");
  }
  const expectedCollectionDifference = currentContractAmount.minorUnits - netRecordedCollection.minorUnits;
  if (!Number.isSafeInteger(expectedCollectionDifference)
    || collectionDifference.minorUnits !== expectedCollectionDifference) {
    fail(`${path}.fundsSummary.collectionDifference`, "资金差额不一致");
  }
  if (refundReferenceAmount.minorUnits < 0
    || refundReferenceAmount.minorUnits !== Math.max(0, netRecordedCollection.minorUnits - currentContractAmount.minorUnits)) {
    fail(`${path}.fundsSummary.refundReferenceAmount`, "退款参考金额不一致");
  }
  return {
    type: result.type as OrderArrangementHistoryItemDto["type"],
    before: result.before === null ? null : arrangement(result.before, `${path}.before`),
    after: arrangement(result.after, `${path}.after`),
    reason: reason(result.reason, `${path}.reason`),
    actor: nullableActor(result.actor, `${path}.actor`),
    recordedAt: dateTime(result.recordedAt, `${path}.recordedAt`),
    pricingSummary: {
      policyBaseAmount,
      currentContractAmount,
      differenceFromPolicy
    },
    fundsSummary: {
      netRecordedCollection,
      collectionDifference,
      refundReferenceAmount,
      factCount: funds.factCount as number
    }
  };
}

export function assertOrderView(value: unknown): asserts value is OrderViewDto {
  const result = record(value, "根节点");
  exactKeys(result, "根节点", [
    "accessLevel", "allowedActions", "order", "occupants", "occupantCorrections", "stay", "currentSegment",
    "segments", "originalArrangement", "effectiveArrangement", "fulfillment", "arrangementHistory", "amendments",
    "pricingRevisions", "coverageSet", "collectionFacts", "cleaningTasks", "amounts"
  ]);
  const order = record(result.order, "order");
  exactKeys(order, "order", [
    "id", "property_id", "status", "stay_type", "arrival_date", "departure_date", "primary_guest_snapshot",
    "booking_channel_code", "channel_order_reference", "free_stay_reason", "free_stay_category_code",
    "pricing_policy_version_id", "member_id", "member_contract_id", "current_revision_id",
    "current_contract_amount_minor", "currency", "version", "created_at", "updated_at"
  ]);
  const stay = record(result.stay, "stay");
  exactKeys(stay, "stay", ["id", "status"]);
  const accessLevel = stringValue(result.accessLevel, "accessLevel");
  if (accessLevel !== "READ" && accessLevel !== "WRITE") fail("accessLevel", "不是支持的权限");
  const seenActionCodes = new Set<string>();
  const enabledDateActions: string[] = [];
  let moveUnitEnabled = false;
  const enabledLifecycleActions: string[] = [];
  arrayValue(result.allowedActions, "allowedActions").forEach((item, index) => {
    const action = record(item, `allowedActions[${index}]`);
    exactKeys(action, `allowedActions[${index}]`, ["code", "enabled", "disabledReason"]);
    const code = stringValue(action.code, `allowedActions[${index}].code`);
    if (!actionCodes.has(code)) fail(`allowedActions[${index}].code`, "不是支持的订单操作");
    if (seenActionCodes.has(code)) fail(`allowedActions[${index}].code`, "重复");
    seenActionCodes.add(code);
    if (typeof action.enabled !== "boolean") fail(`allowedActions[${index}].enabled`, "必须是布尔值");
    nullableString(action.disabledReason, `allowedActions[${index}].disabledReason`);
    if (accessLevel === "READ" && action.enabled) fail(`allowedActions[${index}]`, "只读权限不能包含可执行写操作");
    if (action.enabled && (code === "RESCHEDULE_STAY" || code === "EXTEND_STAY" || code === "SHORTEN_STAY")) enabledDateActions.push(code);
    if (action.enabled && code === "MOVE_UNIT") moveUnitEnabled = true;
    if (action.enabled && (code === "CANCEL_ORDER" || code === "MARK_NO_SHOW" || code === "REVOKE_CHECK_IN")) enabledLifecycleActions.push(code);
  });
  const orderId = stringValue(order.id, "order.id");
  stringValue(order.property_id, "order.property_id");
  const orderStatus = stringValue(order.status, "order.status");
  if (!Object.hasOwn(orderProjectionExpectations, orderStatus)) fail("order.status", "不是支持的订单状态");
  const allowedDateActions = orderStatus === "RESERVED"
    ? new Set(["RESCHEDULE_STAY"])
    : orderStatus === "CHECKED_IN"
      ? new Set(["EXTEND_STAY", "SHORTEN_STAY"])
      : new Set<string>();
  if (enabledDateActions.some((code) => !allowedDateActions.has(code))) {
    fail("allowedActions", "日期操作与订单状态不一致");
  }
  const allowedLifecycleActions = orderStatus === "RESERVED"
    ? new Set(["CANCEL_ORDER", "MARK_NO_SHOW"])
    : orderStatus === "CHECKED_IN"
      ? new Set(["REVOKE_CHECK_IN"])
      : new Set<string>();
  if (enabledLifecycleActions.some((code) => !allowedLifecycleActions.has(code))) {
    fail("allowedActions", "取消、未到或撤销入住操作与订单状态不一致");
  }
  const expectation = orderProjectionExpectations[orderStatus as keyof typeof orderProjectionExpectations];
  const orderArrivalDate = localDate(order.arrival_date, "order.arrival_date");
  const orderDepartureDate = localDate(order.departure_date, "order.departure_date");
  if (orderDepartureDate <= orderArrivalDate) fail("order", "日期区间无效");
  const stayStatus = stringValue(stay.status, "stay.status");
  stringValue(stay.id, "stay.id");
  const stayType = stringValue(order.stay_type, "order.stay_type");
  if (!["TRANSIENT", "WEEKLY", "MONTHLY", "CUSTOM", "FIXED_TERM", "ROLLING", "FREE", "MEMBER"].includes(stayType)) fail("order.stay_type", "不是支持的住宿类型");
  const primaryGuest = record(order.primary_guest_snapshot, "order.primary_guest_snapshot");
  exactKeysWithOptional(primaryGuest, "order.primary_guest_snapshot", ["fullName"], ["nickname", "phone", "documentNumber"]);
  stringValue(primaryGuest.fullName, "order.primary_guest_snapshot.fullName");
  for (const field of ["nickname", "phone", "documentNumber"] as const) {
    if (field in primaryGuest) nullableString(primaryGuest[field], `order.primary_guest_snapshot.${field}`);
  }
  const memberId = nullableString(order.member_id, "order.member_id");
  const memberContractId = nullableString(order.member_contract_id, "order.member_contract_id");
  nullableString(order.booking_channel_code, "order.booking_channel_code");
  nullableString(order.channel_order_reference, "order.channel_order_reference");
  nullableString(order.free_stay_reason, "order.free_stay_reason");
  nullableString(order.free_stay_category_code, "order.free_stay_category_code");
  nullableString(order.current_revision_id, "order.current_revision_id");
  if (order.current_contract_amount_minor !== null) {
    safeInteger(order.current_contract_amount_minor, "order.current_contract_amount_minor", 0);
  }
  nullableString(order.currency, "order.currency");
  stringValue(order.pricing_policy_version_id, "order.pricing_policy_version_id");
  safeInteger(order.version, "order.version", 1);
  dateTime(order.created_at, "order.created_at");
  dateTime(order.updated_at, "order.updated_at");
  if (stayStatus !== expectation.stayStatus) fail("stay.status", "与订单状态不一致");
  const original = arrangement(result.originalArrangement, "originalArrangement");
  const effective = effectiveArrangement(result.effectiveArrangement, "effectiveArrangement");
  if (effective.arrivalDate !== orderArrivalDate || effective.departureDate !== orderDepartureDate) {
    fail("effectiveArrangement", "日期与订单当前日期不一致");
  }
  if (effective.presentation !== expectation.presentation) {
    fail("effectiveArrangement.presentation", "与订单状态不一致");
  }
  if (moveUnitEnabled && !(
    (orderStatus === "RESERVED" && effective.businessDate <= orderArrivalDate)
    || (orderStatus === "CHECKED_IN" && effective.businessDate < orderDepartureDate)
  )) {
    fail("allowedActions", "换房操作与订单状态或营业日期不一致");
  }
  const fulfillmentProjection = fulfillment(result.fulfillment, "fulfillment");
  if (fulfillmentProjection.state !== expectation.fulfillmentState) {
    fail("fulfillment.state", "与订单状态不一致");
  }
  if (fulfillmentProjection.checkIn?.plannedBusinessDate !== undefined
    && fulfillmentProjection.checkIn.plannedBusinessDate !== effective.arrivalDate) {
    fail("fulfillment.checkIn.plannedBusinessDate", "与当前安排入住日不一致");
  }
  if (fulfillmentProjection.checkOut?.plannedBusinessDate !== undefined
    && fulfillmentProjection.checkOut.plannedBusinessDate !== effective.departureDate) {
    fail("fulfillment.checkOut.plannedBusinessDate", "与当前安排退房日不一致");
  }
  if (fulfillmentProjection.checkInRevocation?.plannedBusinessDate !== undefined
    && fulfillmentProjection.checkInRevocation.plannedBusinessDate !== effective.arrivalDate) {
    fail("fulfillment.checkInRevocation.plannedBusinessDate", "与当前安排入住日不一致");
  }
  if (!Array.isArray(result.arrangementHistory) || result.arrangementHistory.length === 0) {
    fail("arrangementHistory", "必须包含初始预订记录");
  }
  const history = result.arrangementHistory.map((item, index) => historyItem(item, `arrangementHistory[${index}]`));
  if (history[0]?.type !== "INITIAL_BOOKING" || history[0].before !== null || !sameArrangement(history[0].after, original)) {
    fail("arrangementHistory[0]", "必须与原始预订安排一致");
  }
  history.forEach((item, index) => {
    validateArrangementChange(item, `arrangementHistory[${index}]`);
    if (index === 0) return;
    if (item.pricingSummary.currentContractAmount.currency
      !== history[index - 1]!.pricingSummary.currentContractAmount.currency) {
      fail(`arrangementHistory[${index}].pricingSummary.currentContractAmount.currency`, "与上一条住宿安排变更币种不一致");
    }
    if (Date.parse(item.recordedAt) < Date.parse(history[index - 1]!.recordedAt)) {
      fail(`arrangementHistory[${index}].recordedAt`, "早于上一条住宿安排变更");
    }
    if (!item.before || !sameArrangement(item.before, history[index - 1]!.after)) {
      fail(`arrangementHistory[${index}].before`, "没有衔接上一版住宿安排");
    }
  });
  if (!sameArrangement(history.at(-1)!.after, effective)) {
    fail("effectiveArrangement", "与最后一版住宿安排不一致");
  }

  const amountsValue = record(result.amounts, "amounts");
  exactKeys(amountsValue, "amounts", ["currentContractAmount", "netRecordedCollection", "collectionDifference", "refundReferenceAmount"]);
  const currentContractAmount = money(amountsValue.currentContractAmount, "amounts.currentContractAmount");
  const netRecordedCollection = money(amountsValue.netRecordedCollection, "amounts.netRecordedCollection");
  const collectionDifference = money(amountsValue.collectionDifference, "amounts.collectionDifference");
  const refundReferenceAmount = money(amountsValue.refundReferenceAmount, "amounts.refundReferenceAmount");
  if (currentContractAmount.currency !== netRecordedCollection.currency
    || currentContractAmount.currency !== collectionDifference.currency
    || currentContractAmount.currency !== refundReferenceAmount.currency
    || collectionDifference.minorUnits !== currentContractAmount.minorUnits - netRecordedCollection.minorUnits
    || refundReferenceAmount.minorUnits < 0
    || refundReferenceAmount.minorUnits !== Math.max(0, netRecordedCollection.minorUnits - currentContractAmount.minorUnits)) {
    fail("amounts", "币种或资金差额不一致");
  }
  const latestHistoryAmount = history.at(-1)!.pricingSummary.currentContractAmount;
  if (latestHistoryAmount.currency !== currentContractAmount.currency) {
    fail("amounts.currentContractAmount.currency", "与最新住宿安排计价摘要币种不一致");
  }

  const occupants = arrayValue(result.occupants, "occupants");
  const occupantIds = new Set<string>();
  occupants.forEach((item, index) => {
    const occupant = record(item, `occupants[${index}]`);
    exactKeys(occupant, `occupants[${index}]`, ["id", "orderId", "ordinal", "role", "fullName", "nickname", "phone", "documentNumber", "createdAt"]);
    const id = stringValue(occupant.id, `occupants[${index}].id`);
    if (occupantIds.has(id)) fail(`occupants[${index}].id`, "重复");
    occupantIds.add(id);
    if (stringValue(occupant.orderId, `occupants[${index}].orderId`) !== order.id) fail(`occupants[${index}].orderId`, "与订单不一致");
    safeInteger(occupant.ordinal, `occupants[${index}].ordinal`, 1);
    if (occupant.role !== "PRIMARY" && occupant.role !== "ADDITIONAL") fail(`occupants[${index}].role`, "不是支持的住宿人角色");
    nullableString(occupant.fullName, `occupants[${index}].fullName`);
    nullableString(occupant.nickname, `occupants[${index}].nickname`);
    nullableString(occupant.phone, `occupants[${index}].phone`);
    nullableString(occupant.documentNumber, `occupants[${index}].documentNumber`);
    dateTime(occupant.createdAt, `occupants[${index}].createdAt`);
  });

  arrayValue(result.occupantCorrections, "occupantCorrections").forEach((item, index) => {
    const correction = record(item, `occupantCorrections[${index}]`);
    exactKeys(correction, `occupantCorrections[${index}]`, [
      "id", "orderId", "occupantId", "sequence", "priorSnapshot", "correctedSnapshot", "reason", "actor", "amendmentId", "commandId", "createdAt"
    ]);
    stringValue(correction.id, `occupantCorrections[${index}].id`);
    if (stringValue(correction.orderId, `occupantCorrections[${index}].orderId`) !== order.id) fail(`occupantCorrections[${index}].orderId`, "与订单不一致");
    if (!occupantIds.has(stringValue(correction.occupantId, `occupantCorrections[${index}].occupantId`))) fail(`occupantCorrections[${index}].occupantId`, "没有对应住宿人");
    safeInteger(correction.sequence, `occupantCorrections[${index}].sequence`, 1);
    if (!nullableActor(correction.actor, `occupantCorrections[${index}].actor`)) fail(`occupantCorrections[${index}].actor`, "必须包含工作人员");
    occupantSnapshot(correction.priorSnapshot, `occupantCorrections[${index}].priorSnapshot`);
    occupantSnapshot(correction.correctedSnapshot, `occupantCorrections[${index}].correctedSnapshot`);
    reason(correction.reason, `occupantCorrections[${index}].reason`);
    stringValue(correction.amendmentId, `occupantCorrections[${index}].amendmentId`);
    stringValue(correction.commandId, `occupantCorrections[${index}].commandId`);
    dateTime(correction.createdAt, `occupantCorrections[${index}].createdAt`);
  });

  const stayId = stringValue(stay.id, "stay.id");
  const currentSegment = record(result.currentSegment, "currentSegment");
  exactKeys(currentSegment, "currentSegment", ["id", "sequence", "inventoryUnitId", "arrivalDate", "departureDate"]);
  stringValue(currentSegment.id, "currentSegment.id");
  safeInteger(currentSegment.sequence, "currentSegment.sequence", 1);
  stringValue(currentSegment.inventoryUnitId, "currentSegment.inventoryUnitId");
  const currentSegmentArrival = localDate(currentSegment.arrivalDate, "currentSegment.arrivalDate");
  const currentSegmentDeparture = localDate(currentSegment.departureDate, "currentSegment.departureDate");
  if (currentSegmentDeparture <= currentSegmentArrival) fail("currentSegment", "日期区间无效");

  arrayValue(result.segments, "segments").forEach((item, index) => {
    const path = `segments[${index}]`;
    const segment = record(item, path);
    exactKeys(segment, path, [
      "id", "stay_id", "sequence", "inventory_unit_id", "arrival_date", "departure_date", "segment_type",
      "supersedes_segment_id", "amendment_id", "created_at"
    ]);
    stringValue(segment.id, `${path}.id`);
    if (stringValue(segment.stay_id, `${path}.stay_id`) !== stayId) fail(`${path}.stay_id`, "与住宿不一致");
    safeInteger(segment.sequence, `${path}.sequence`, 1);
    stringValue(segment.inventory_unit_id, `${path}.inventory_unit_id`);
    const segmentArrival = localDate(segment.arrival_date, `${path}.arrival_date`);
    const segmentDeparture = localDate(segment.departure_date, `${path}.departure_date`);
    if (segmentDeparture <= segmentArrival) fail(path, "日期区间无效");
    stringValue(segment.segment_type, `${path}.segment_type`);
    nullableString(segment.supersedes_segment_id, `${path}.supersedes_segment_id`);
    stringValue(segment.amendment_id, `${path}.amendment_id`);
    dateTime(segment.created_at, `${path}.created_at`);
  });

  const amendments = arrayValue(result.amendments, "amendments");
  amendments.forEach((item, index) => {
    const path = `amendments[${index}]`;
    const amendment = record(item, path);
    exactKeysWithOptional(amendment, path, [
      "id", "order_id", "sequence", "amendment_type", "reason_code", "reason_note", "prior_version", "new_version",
      "payload", "command_id", "actor", "created_at"
    ], ["protocolVersion", "recoveryMode"]);
    stringValue(amendment.id, `${path}.id`);
    if (stringValue(amendment.order_id, `${path}.order_id`) !== orderId) fail(`${path}.order_id`, "与订单不一致");
    safeInteger(amendment.sequence, `${path}.sequence`, 1);
    const amendmentType = stringValue(amendment.amendment_type, `${path}.amendment_type`);
    stringValue(amendment.reason_code, `${path}.reason_code`);
    stringValue(amendment.reason_note, `${path}.reason_note`, true);
    safeInteger(amendment.prior_version, `${path}.prior_version`, 0);
    safeInteger(amendment.new_version, `${path}.new_version`, 1);
    record(amendment.payload, `${path}.payload`);
    nullableString(amendment.command_id, `${path}.command_id`);
    nullableActor(amendment.actor, `${path}.actor`);
    dateTime(amendment.created_at, `${path}.created_at`);
    historicalAmendmentMetadata(amendment, path, amendmentType);
  });
  const standaloneRepriceRevisionIds = new Set<string>();
  const standaloneMemberRepriceRevisionIds = new Set<string>();
  const lifecycleZeroRevisionIds = new Set<string>();
  const pricingRevisions = arrayValue(result.pricingRevisions, "pricingRevisions");
  if (pricingRevisions.length === 0) fail("pricingRevisions", "必须包含计价记录");
  pricingRevisions.forEach((item, index) => {
    const path = `pricingRevisions[${index}]`;
    const revision = record(item, path);
    exactKeys(revision, path, [
      "id", "order_id", "revision_no", "amendment_id", "policy_version_id", "arrival_date", "departure_date",
      "coverage_set", "cash_lines", "policy_base_amount_minor", "pricing_basis", "manual_adjustment_minor",
      "current_contract_amount_minor", "difference_from_policy_minor", "reason", "currency", "created_at"
    ]);
    const revisionId = stringValue(revision.id, `${path}.id`);
    if (stringValue(revision.order_id, `${path}.order_id`) !== orderId) fail(`${path}.order_id`, "与订单不一致");
    const revisionAmendmentId = stringValue(revision.amendment_id, `${path}.amendment_id`);
    stringValue(revision.policy_version_id, `${path}.policy_version_id`);
    arrayValue(revision.coverage_set, `${path}.coverage_set`);
    arrayValue(revision.cash_lines, `${path}.cash_lines`);
    const revisionNo = safeInteger(revision.revision_no, `${path}.revision_no`, 1);
    const arrivalDate = localDate(revision.arrival_date, `${path}.arrival_date`);
    const departureDate = localDate(revision.departure_date, `${path}.departure_date`);
    if (departureDate <= arrivalDate) fail(path, "日期区间无效");
    const policyBaseAmount = safeInteger(revision.policy_base_amount_minor, `${path}.policy_base_amount_minor`);
    const currentRevisionAmount = safeInteger(revision.current_contract_amount_minor, `${path}.current_contract_amount_minor`);
    if (policyBaseAmount < 0) fail(`${path}.policy_base_amount_minor`, "必须是非负金额");
    if (currentRevisionAmount < 0) fail(`${path}.current_contract_amount_minor`, "必须是非负金额");
    const manualAdjustment = safeInteger(revision.manual_adjustment_minor, `${path}.manual_adjustment_minor`);
    const differenceFromPolicy = safeInteger(revision.difference_from_policy_minor, `${path}.difference_from_policy_minor`);
    if (differenceFromPolicy !== currentRevisionAmount - policyBaseAmount) {
      fail(`${path}.difference_from_policy_minor`, "与政策基础金额差额不一致");
    }
    const pricingBasis = stringValue(revision.pricing_basis, `${path}.pricing_basis`);
    if (!pricingBases.has(pricingBasis)) fail(`${path}.pricing_basis`, "不是支持的计价方式");
    const pricingReason = reason(revision.reason, `${path}.reason`);
    const revisionCreatedAt = dateTime(revision.created_at, `${path}.created_at`);
    let standaloneReprice = false;
    const standaloneRepriceCandidate = index > 0
      && revisionNo === index + 1
      && Boolean(pricingReason.note.trim());
    if (standaloneRepriceCandidate) {
      const matchingAmendments = amendments.flatMap((item, amendmentIndex) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const amendment = item as JsonRecord;
        return amendment.id === revisionAmendmentId ? [{ amendment, amendmentIndex }] : [];
      });
      const match = matchingAmendments.length === 1 ? matchingAmendments[0] : undefined;
      if (match) {
        const amendmentPath = `amendments[${match.amendmentIndex}]`;
        const amendmentFactsMatch = match.amendment.order_id === orderId
          && match.amendment.amendment_type === "REPRICE_ORDER"
          && match.amendment.reason_code === pricingReason.code
          && match.amendment.reason_note === pricingReason.note;
        if (amendmentFactsMatch) {
          const amendmentCreatedAt = dateTime(match.amendment.created_at, `${amendmentPath}.created_at`);
          standaloneReprice = Date.parse(amendmentCreatedAt) <= Date.parse(revisionCreatedAt);
        }
      }
    }
    if (standaloneReprice) standaloneRepriceRevisionIds.add(revisionId);
    const lifecycleAmendmentType = orderStatus === "CANCELLED"
      ? "CANCEL_ORDER"
      : orderStatus === "NO_SHOW"
        ? "MARK_NO_SHOW"
        : orderStatus === "CHECK_IN_REVOKED"
          ? "REVOKE_CHECK_IN"
          : undefined;
    const allowedZeroAmendmentTypes = new Set([
      ...(lifecycleAmendmentType ? [lifecycleAmendmentType] : []),
      "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"
    ]);
    if (index > 0 && currentRevisionAmount === 0) {
      const matchingLifecycleAmendments = amendments.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const candidate = item as JsonRecord;
        return candidate.id === revisionAmendmentId ? [candidate] : [];
      });
      const lifecycleAmendment = matchingLifecycleAmendments.length === 1 ? matchingLifecycleAmendments[0] : undefined;
      const amendmentType = String(lifecycleAmendment?.amendment_type ?? "");
      const reasonMatches = amendmentType === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"
        ? pricingReason.code === "STAY_COLLECTION_TO_MEMBERSHIP"
        : lifecycleAmendment?.reason_code === pricingReason.code
          && lifecycleAmendment?.reason_note === pricingReason.note;
      if (lifecycleAmendment
        && lifecycleAmendment.order_id === orderId
        && allowedZeroAmendmentTypes.has(String(lifecycleAmendment.amendment_type))
        && reasonMatches
        && Date.parse(dateTime(lifecycleAmendment.created_at, "amendments[lifecycle].created_at")) <= Date.parse(revisionCreatedAt)) {
        lifecycleZeroRevisionIds.add(revisionId);
      }
    }
    const standaloneMemberReprice = standaloneReprice
      && Boolean(memberId?.trim())
      && Boolean(memberContractId?.trim())
      && pricingBasis === "MEMBER_ENTITLEMENT"
      && manualAdjustment === differenceFromPolicy;
    if (standaloneMemberReprice) standaloneMemberRepriceRevisionIds.add(revisionId);
    if ((pricingBasis === "MANUAL_ADJUSTMENT" && manualAdjustment !== differenceFromPolicy)
      || (pricingBasis === "MEMBER_ENTITLEMENT" && manualAdjustment !== 0 && !standaloneMemberReprice)
      || (pricingBasis !== "MANUAL_ADJUSTMENT" && pricingBasis !== "MEMBER_ENTITLEMENT" && manualAdjustment !== 0)) {
      fail(`${path}.manual_adjustment_minor`, "人工调价差额不一致");
    }
    const currency = stringValue(revision.currency, `pricingRevisions[${index}].currency`);
    if (currency !== currentContractAmount.currency) fail(`pricingRevisions[${index}].currency`, "与订单金额币种不一致");
  });
  const latestRevision = record(pricingRevisions.at(-1), "pricingRevisions[latest]");
  if (latestRevision.id !== order.current_revision_id
    || latestRevision.current_contract_amount_minor !== currentContractAmount.minorUnits) {
    fail("pricingRevisions[latest]", "与订单当前计价指针或金额不一致");
  }
  if (latestRevision.arrival_date !== effective.arrivalDate
    || latestRevision.departure_date !== effective.departureDate) {
    fail("pricingRevisions[latest]", "与当前住宿安排日期不一致");
  }
  if (latestHistoryAmount.minorUnits !== currentContractAmount.minorUnits) {
    const latestRevisionId = stringValue(latestRevision.id, "pricingRevisions[latest].id");
    const latestRevisionBasis = stringValue(latestRevision.pricing_basis, "pricingRevisions[latest].pricing_basis");
    const latestRevisionPolicyBase = safeInteger(latestRevision.policy_base_amount_minor, "pricingRevisions[latest].policy_base_amount_minor");
    const latestRevisionDifference = safeInteger(latestRevision.difference_from_policy_minor, "pricingRevisions[latest].difference_from_policy_minor");
    const latestRevisionManualAdjustment = safeInteger(latestRevision.manual_adjustment_minor, "pricingRevisions[latest].manual_adjustment_minor");
    const latestRevisionArrival = localDate(latestRevision.arrival_date, "pricingRevisions[latest].arrival_date");
    const latestRevisionDeparture = localDate(latestRevision.departure_date, "pricingRevisions[latest].departure_date");
    const latestRevisionCreatedAt = dateTime(latestRevision.created_at, "pricingRevisions[latest].created_at");
    const validStandaloneBasis = latestRevisionBasis === "MEMBER_ENTITLEMENT"
      ? standaloneMemberRepriceRevisionIds.has(latestRevisionId)
      : memberId === null && memberContractId === null
        && standaloneRepriceRevisionIds.has(latestRevisionId)
        && (latestRevisionBasis === "MANUAL_ADJUSTMENT"
          || (latestRevisionBasis === "POLICY"
            && latestRevisionPolicyBase === currentContractAmount.minorUnits
            && latestRevisionDifference === 0
            && latestRevisionManualAdjustment === 0));
    const validLifecycleZeroRevision = currentContractAmount.minorUnits === 0
      && lifecycleZeroRevisionIds.has(latestRevisionId);
    if ((!validStandaloneBasis && !validLifecycleZeroRevision)
      || latestRevisionArrival !== effective.arrivalDate
      || latestRevisionDeparture !== effective.departureDate
      || Date.parse(latestRevisionCreatedAt) < Date.parse(history.at(-1)!.recordedAt)) {
      fail("amounts.currentContractAmount", "与最新住宿安排计价摘要不一致，且没有合法的后续独立调价记录");
    }
  }

  let collectionTotal = 0;
  arrayValue(result.collectionFacts, "collectionFacts").forEach((item, index) => {
    const fact = record(item, `collectionFacts[${index}]`);
    exactKeysWithOptional(fact, `collectionFacts[${index}]`, [
      "fact_id", "order_id", "fact_type", "amount_minor", "net_effect_minor", "currency", "references_fact_id",
      "reverses_fact_id", "method", "note", "transaction_reference", "cash_collector", "pricing_revision_id", "command_id", "created_at"
    ], ["transfer"]);
    stringValue(fact.fact_id, `collectionFacts[${index}].fact_id`);
    if (stringValue(fact.order_id, `collectionFacts[${index}].order_id`) !== orderId) fail(`collectionFacts[${index}].order_id`, "与订单不一致");
    const netEffect = safeInteger(fact.net_effect_minor, `collectionFacts[${index}].net_effect_minor`);
    safeInteger(fact.amount_minor, `collectionFacts[${index}].amount_minor`);
    stringValue(fact.fact_type, `collectionFacts[${index}].fact_type`);
    stringValue(fact.method, `collectionFacts[${index}].method`);
    stringValue(fact.note, `collectionFacts[${index}].note`, true);
    nullableString(fact.references_fact_id, `collectionFacts[${index}].references_fact_id`);
    nullableString(fact.reverses_fact_id, `collectionFacts[${index}].reverses_fact_id`);
    nullableString(fact.transaction_reference, `collectionFacts[${index}].transaction_reference`);
    nullableString(fact.cash_collector, `collectionFacts[${index}].cash_collector`);
    nullableString(fact.pricing_revision_id, `collectionFacts[${index}].pricing_revision_id`);
    stringValue(fact.command_id, `collectionFacts[${index}].command_id`);
    if (fact.transfer !== null && fact.transfer !== undefined) {
      const transfer = record(fact.transfer, `collectionFacts[${index}].transfer`);
      exactKeys(transfer, `collectionFacts[${index}].transfer`, ["id", "membershipOrderId", "memberId", "membershipPaymentFactId", "sourceReversalFactId"]);
      stringValue(transfer.id, `collectionFacts[${index}].transfer.id`);
      stringValue(transfer.membershipOrderId, `collectionFacts[${index}].transfer.membershipOrderId`);
      stringValue(transfer.memberId, `collectionFacts[${index}].transfer.memberId`);
      stringValue(transfer.membershipPaymentFactId, `collectionFacts[${index}].transfer.membershipPaymentFactId`);
      stringValue(transfer.sourceReversalFactId, `collectionFacts[${index}].transfer.sourceReversalFactId`);
    }
    if (stringValue(fact.currency, `collectionFacts[${index}].currency`) !== currentContractAmount.currency) fail(`collectionFacts[${index}].currency`, "与订单金额币种不一致");
    dateTime(fact.created_at, `collectionFacts[${index}].created_at`);
    collectionTotal += netEffect;
    if (!Number.isSafeInteger(collectionTotal)) fail("collectionFacts", "净收款合计超出支持范围");
  });
  if (collectionTotal !== netRecordedCollection.minorUnits) fail("collectionFacts", "净影响合计与已记录净收款不一致");

  arrayValue(result.coverageSet, "coverageSet").forEach((item, index) => {
    const path = `coverageSet[${index}]`;
    const row = record(item, path);
    exactKeys(row, path, ["id", "order_id", "contract_id", "lot_id", "inventory_unit_id", "service_date", "unit_kind", "status", "held_by_revision_id", "created_at", "updated_at"]);
    stringValue(row.id, `${path}.id`);
    if (stringValue(row.order_id, `${path}.order_id`) !== orderId) fail(`${path}.order_id`, "与订单不一致");
    stringValue(row.contract_id, `${path}.contract_id`);
    stringValue(row.lot_id, `${path}.lot_id`);
    stringValue(row.inventory_unit_id, `${path}.inventory_unit_id`);
    localDate(row.service_date, `${path}.service_date`);
    if (row.unit_kind !== "ROOM_NIGHT" && row.unit_kind !== "BED_NIGHT") fail(`${path}.unit_kind`, "不是支持的会员权益类型");
    if (row.status !== "HELD" && row.status !== "CONSUMED" && row.status !== "RELEASED") fail(`${path}.status`, "不是支持的权益状态");
    stringValue(row.held_by_revision_id, `${path}.held_by_revision_id`);
    dateTime(row.created_at, `${path}.created_at`);
    dateTime(row.updated_at, `${path}.updated_at`);
  });

  arrayValue(result.cleaningTasks, "cleaningTasks").forEach((item, index) => {
    const path = `cleaningTasks[${index}]`;
    const row = record(item, path);
    exactKeys(row, path, ["id", "inventoryUnitId", "serviceDate", "status", "createdAt", "completedAt", "createdBy", "completedBy"]);
    stringValue(row.id, `${path}.id`);
    stringValue(row.inventoryUnitId, `${path}.inventoryUnitId`);
    localDate(row.serviceDate, `${path}.serviceDate`);
    if (row.status !== "PENDING" && row.status !== "COMPLETED") fail(`${path}.status`, "不是支持的清洁状态");
    dateTime(row.createdAt, `${path}.createdAt`);
    if (row.completedAt !== null) dateTime(row.completedAt, `${path}.completedAt`);
    nullableActor(row.createdBy, `${path}.createdBy`);
    nullableActor(row.completedBy, `${path}.completedBy`);
  });
}

export function parseOrderView(value: unknown): OrderViewDto {
  assertOrderView(value);
  return value;
}

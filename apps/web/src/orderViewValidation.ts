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
const effectivePresentations = new Set(["CURRENT", "LAST", "BEFORE_CANCELLATION", "NO_SHOW_ORDER"]);
const fulfillmentStates = new Set(["NOT_CHECKED_IN", "IN_HOUSE", "CHECKED_OUT", "CANCELLED", "NO_SHOW"]);
const recordingModes = new Set(["ON_SCHEDULE", "LATE_RECORDED", "LEGACY_UNCLASSIFIED"]);
const actionCodes = new Set<string>(orderActionCodes);
const orderProjectionExpectations = {
  RESERVED: { stayStatus: "PLANNED", fulfillmentState: "NOT_CHECKED_IN", presentation: "CURRENT" },
  CHECKED_IN: { stayStatus: "IN_HOUSE", fulfillmentState: "IN_HOUSE", presentation: "CURRENT" },
  CHECKED_OUT: { stayStatus: "COMPLETED", fulfillmentState: "CHECKED_OUT", presentation: "LAST" },
  CANCELLED: { stayStatus: "CANCELLED", fulfillmentState: "CANCELLED", presentation: "BEFORE_CANCELLATION" },
  NO_SHOW: { stayStatus: "NO_SHOW", fulfillmentState: "NO_SHOW", presentation: "NO_SHOW_ORDER" }
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

function isContiguousInventorySubsequence(before: OrderArrangementDto, after: OrderArrangementDto): boolean {
  const beforeUnits = before.intervals.map((interval) => interval.inventoryUnitId);
  const afterUnits = after.intervals.map((interval) => interval.inventoryUnitId);
  return beforeUnits.some((_, start) => afterUnits.every((unit, index) => unit === beforeUnits[start + index]));
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
    const overlapArrival = before.arrivalDate > after.arrivalDate ? before.arrivalDate : after.arrivalDate;
    const overlapDeparture = before.departureDate < after.departureDate ? before.departureDate : after.departureDate;
    const retainedTimelineUnchanged = overlapArrival < overlapDeparture
      ? sameInventoryTimeline(before, after, overlapArrival, overlapDeparture)
      : isContiguousInventorySubsequence(before, after);
    if ((before.arrivalDate === after.arrivalDate && before.departureDate === after.departureDate)
      || !retainedTimelineUnchanged) {
      fail(path, "改期必须只改变住宿日期");
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

function fulfillmentRecord(value: unknown, path: string, expectedType: "CHECK_IN" | "CHECK_OUT") {
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
    && (expectedType !== "CHECK_OUT" || recordedBusinessDate === null || recordedBusinessDate <= plannedBusinessDate)) {
    fail(path, "迟录退房日期没有晚于计划退房日");
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
  exactKeys(result, path, ["state", "checkIn", "checkOut"]);
  if (!fulfillmentStates.has(String(result.state))) fail(`${path}.state`, "不是支持的履约状态");
  const checkIn = fulfillmentRecord(result.checkIn, `${path}.checkIn`, "CHECK_IN");
  const checkOut = fulfillmentRecord(result.checkOut, `${path}.checkOut`, "CHECK_OUT");
  const valid = result.state === "NOT_CHECKED_IN" || result.state === "CANCELLED" || result.state === "NO_SHOW"
    ? !checkIn && !checkOut
    : result.state === "IN_HOUSE"
      ? Boolean(checkIn) && !checkOut
      : result.state === "CHECKED_OUT" && Boolean(checkIn) && Boolean(checkOut);
  if (!valid) fail(path, "履约状态与入住、退房记录不一致");
  if (checkIn && checkOut && Date.parse(checkOut.recordedAt) < Date.parse(checkIn.recordedAt)) {
    fail(path, "退房记录时间早于入住记录时间");
  }
  return { state: result.state as OrderFulfillmentProjectionDto["state"], checkIn, checkOut };
}

function historyItem(value: unknown, path: string): OrderArrangementHistoryItemDto {
  const result = record(value, path);
  exactKeys(result, path, ["type", "before", "after", "reason", "actor", "recordedAt", "pricingSummary", "fundsSummary"]);
  if (!arrangementChangeTypes.has(String(result.type))) fail(`${path}.type`, "不是支持的住宿安排变更");
  const pricing = record(result.pricingSummary, `${path}.pricingSummary`);
  exactKeys(pricing, `${path}.pricingSummary`, ["policyBaseAmount", "currentContractAmount", "differenceFromPolicy"]);
  const funds = record(result.fundsSummary, `${path}.fundsSummary`);
  exactKeys(funds, `${path}.fundsSummary`, ["netRecordedCollection", "collectionDifference", "factCount"]);
  if (!Number.isSafeInteger(funds.factCount) || Number(funds.factCount) < 0) fail(`${path}.fundsSummary.factCount`, "必须是非负整数");
  const policyBaseAmount = money(pricing.policyBaseAmount, `${path}.pricingSummary.policyBaseAmount`);
  const currentContractAmount = money(pricing.currentContractAmount, `${path}.pricingSummary.currentContractAmount`);
  const differenceFromPolicy = money(pricing.differenceFromPolicy, `${path}.pricingSummary.differenceFromPolicy`);
  const netRecordedCollection = money(funds.netRecordedCollection, `${path}.fundsSummary.netRecordedCollection`);
  const collectionDifference = money(funds.collectionDifference, `${path}.fundsSummary.collectionDifference`);
  const amounts = [policyBaseAmount, currentContractAmount, differenceFromPolicy, netRecordedCollection, collectionDifference];
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
    fail(`${path}.fundsSummary.collectionDifference`, "待收或多收差额不一致");
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
      factCount: funds.factCount as number
    }
  };
}

export function assertOrderView(value: unknown): asserts value is OrderViewDto {
  const result = record(value, "根节点");
  const order = record(result.order, "order");
  const stay = record(result.stay, "stay");
  const accessLevel = stringValue(result.accessLevel, "accessLevel");
  if (accessLevel !== "READ" && accessLevel !== "WRITE") fail("accessLevel", "不是支持的权限");
  const seenActionCodes = new Set<string>();
  const enabledDateActions: string[] = [];
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
  });
  stringValue(order.id, "order.id");
  stringValue(order.property_id, "order.property_id");
  const orderStatus = stringValue(order.status, "order.status");
  if (!Object.hasOwn(orderProjectionExpectations, orderStatus)) fail("order.status", "不是支持的订单状态");
  const expectedDateAction = orderStatus === "RESERVED"
    ? "RESCHEDULE_STAY"
    : orderStatus === "CHECKED_IN"
      ? "EXTEND_STAY"
      : undefined;
  if (enabledDateActions.some((code) => code !== expectedDateAction)) {
    fail("allowedActions", "日期操作与订单状态不一致");
  }
  const expectation = orderProjectionExpectations[orderStatus as keyof typeof orderProjectionExpectations];
  const orderArrivalDate = localDate(order.arrival_date, "order.arrival_date");
  const orderDepartureDate = localDate(order.departure_date, "order.departure_date");
  if (orderDepartureDate <= orderArrivalDate) fail("order", "日期区间无效");
  const stayStatus = stringValue(stay.status, "stay.status");
  stringValue(stay.id, "stay.id");
  stringValue(order.stay_type, "order.stay_type");
  nullableString(order.member_id, "order.member_id");
  nullableString(order.member_contract_id, "order.member_contract_id");
  nullableString(order.booking_channel_code, "order.booking_channel_code");
  nullableString(order.channel_order_reference, "order.channel_order_reference");
  nullableString(order.free_stay_reason, "order.free_stay_reason");
  nullableString(order.free_stay_category_code, "order.free_stay_category_code");
  nullableString(order.current_revision_id, "order.current_revision_id");
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
  exactKeys(amountsValue, "amounts", ["currentContractAmount", "netRecordedCollection", "collectionDifference"]);
  const currentContractAmount = money(amountsValue.currentContractAmount, "amounts.currentContractAmount");
  const netRecordedCollection = money(amountsValue.netRecordedCollection, "amounts.netRecordedCollection");
  const collectionDifference = money(amountsValue.collectionDifference, "amounts.collectionDifference");
  if (currentContractAmount.currency !== netRecordedCollection.currency
    || currentContractAmount.currency !== collectionDifference.currency
    || collectionDifference.minorUnits !== currentContractAmount.minorUnits - netRecordedCollection.minorUnits) {
    fail("amounts", "币种或待收、多收差额不一致");
  }
  const latestHistoryAmount = history.at(-1)!.pricingSummary.currentContractAmount;
  if (latestHistoryAmount.currency !== currentContractAmount.currency
    || latestHistoryAmount.minorUnits !== currentContractAmount.minorUnits) {
    fail("amounts.currentContractAmount", "与最新住宿安排计价摘要不一致");
  }

  const occupants = arrayValue(result.occupants, "occupants");
  const occupantIds = new Set<string>();
  occupants.forEach((item, index) => {
    const occupant = record(item, `occupants[${index}]`);
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
    stringValue(correction.id, `occupantCorrections[${index}].id`);
    if (stringValue(correction.orderId, `occupantCorrections[${index}].orderId`) !== order.id) fail(`occupantCorrections[${index}].orderId`, "与订单不一致");
    if (!occupantIds.has(stringValue(correction.occupantId, `occupantCorrections[${index}].occupantId`))) fail(`occupantCorrections[${index}].occupantId`, "没有对应住宿人");
    safeInteger(correction.sequence, `occupantCorrections[${index}].sequence`, 1);
    if (!nullableActor(correction.actor, `occupantCorrections[${index}].actor`)) fail(`occupantCorrections[${index}].actor`, "必须包含工作人员");
    occupantSnapshot(correction.priorSnapshot, `occupantCorrections[${index}].priorSnapshot`);
    occupantSnapshot(correction.correctedSnapshot, `occupantCorrections[${index}].correctedSnapshot`);
    reason(correction.reason, `occupantCorrections[${index}].reason`);
    dateTime(correction.createdAt, `occupantCorrections[${index}].createdAt`);
  });

  const pricingRevisions = arrayValue(result.pricingRevisions, "pricingRevisions");
  if (pricingRevisions.length === 0) fail("pricingRevisions", "必须包含计价记录");
  pricingRevisions.forEach((item, index) => {
    const revision = record(item, `pricingRevisions[${index}]`);
    stringValue(revision.id, `pricingRevisions[${index}].id`);
    safeInteger(revision.revision_no, `pricingRevisions[${index}].revision_no`, 1);
    localDate(revision.arrival_date, `pricingRevisions[${index}].arrival_date`);
    localDate(revision.departure_date, `pricingRevisions[${index}].departure_date`);
    safeInteger(revision.policy_base_amount_minor, `pricingRevisions[${index}].policy_base_amount_minor`);
    safeInteger(revision.current_contract_amount_minor, `pricingRevisions[${index}].current_contract_amount_minor`);
    safeInteger(revision.manual_adjustment_minor, `pricingRevisions[${index}].manual_adjustment_minor`);
    safeInteger(revision.difference_from_policy_minor, `pricingRevisions[${index}].difference_from_policy_minor`);
    stringValue(revision.pricing_basis, `pricingRevisions[${index}].pricing_basis`);
    reason(revision.reason, `pricingRevisions[${index}].reason`);
    const currency = stringValue(revision.currency, `pricingRevisions[${index}].currency`);
    if (currency !== currentContractAmount.currency) fail(`pricingRevisions[${index}].currency`, "与订单金额币种不一致");
  });
  const latestRevision = record(pricingRevisions.at(-1), "pricingRevisions[latest]");
  if (latestRevision.id !== order.current_revision_id
    || latestRevision.current_contract_amount_minor !== currentContractAmount.minorUnits) {
    fail("pricingRevisions[latest]", "与订单当前计价指针或金额不一致");
  }

  let collectionTotal = 0;
  arrayValue(result.collectionFacts, "collectionFacts").forEach((item, index) => {
    const fact = record(item, `collectionFacts[${index}]`);
    stringValue(fact.fact_id, `collectionFacts[${index}].fact_id`);
    const netEffect = safeInteger(fact.net_effect_minor, `collectionFacts[${index}].net_effect_minor`);
    safeInteger(fact.amount_minor, `collectionFacts[${index}].amount_minor`);
    stringValue(fact.fact_type, `collectionFacts[${index}].fact_type`);
    stringValue(fact.method, `collectionFacts[${index}].method`);
    stringValue(fact.note, `collectionFacts[${index}].note`, true);
    nullableString(fact.transaction_reference, `collectionFacts[${index}].transaction_reference`);
    if (stringValue(fact.currency, `collectionFacts[${index}].currency`) !== currentContractAmount.currency) fail(`collectionFacts[${index}].currency`, "与订单金额币种不一致");
    dateTime(fact.created_at, `collectionFacts[${index}].created_at`);
    collectionTotal += netEffect;
    if (!Number.isSafeInteger(collectionTotal)) fail("collectionFacts", "净收款合计超出支持范围");
  });
  if (collectionTotal !== netRecordedCollection.minorUnits) fail("collectionFacts", "净影响合计与已登记净收款不一致");

  for (const [field, requiredFields] of [
    ["coverageSet", ["id", "inventory_unit_id", "service_date", "unit_kind", "status"]],
    ["cleaningTasks", ["id", "inventoryUnitId", "serviceDate", "status", "createdAt"]]
  ] as const) {
    arrayValue(result[field], field).forEach((item, index) => {
      const row = record(item, `${field}[${index}]`);
      for (const required of requiredFields) stringValue(row[required], `${field}[${index}].${required}`);
    });
  }
}

export function parseOrderView(value: unknown): OrderViewDto {
  assertOrderView(value);
  return value;
}

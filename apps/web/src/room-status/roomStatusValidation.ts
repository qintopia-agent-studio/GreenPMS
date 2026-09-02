import {
  roomStatusActionCodes,
  roomStatusAttentionCodes,
  roomStatusBlockingFactKinds,
  roomStatusOperationalAttentionCodes,
  roomStatusOperationalTaskKinds,
  roomStatusSourceCategories,
  roomStatusSourceKinds,
  roomStatusStatuses,
  freeStayCategoryCodes,
  type RoomStatusActionCode,
  type RoomStatusActionDto,
  type RoomStatusAttention,
  type RoomStatusAvailabilitySummaryDto,
  type RoomStatusBoardDto,
  type RoomStatusConflictDto,
  type RoomStatusHistoryDto,
  type RoomStatusIntervalDto,
  type RoomStatusOperationalTaskDto,
  type RoomStatusOperationalAttention,
  type RoomStatusReferenceDto,
  type RoomStatusSourceKind,
  type RoomStatusStatus,
  type RoomStatusUnitDto
} from "@qintopia/contracts";
import { addLocalDateDays, isIsoLocalDate } from "./roomStatusState";

type UnknownRecord = Record<string, unknown>;

export interface ExpectedRoomStatusQuery {
  propertyId: string;
  range: { arrivalDate: string; departureDate: string };
  pageIndex: number;
  allowedActions?: ReadonlySet<string>;
}

const statuses = new Set<string>(roomStatusStatuses);
const attentions = new Set<string>(roomStatusAttentionCodes);
const operationalAttentions = new Set<string>(roomStatusOperationalAttentionCodes);
const sourceCategories = new Set<string>(roomStatusSourceCategories);
const sourceKinds = new Set<string>(roomStatusSourceKinds);
const freeStayCategories = new Set<string>(freeStayCategoryCodes);
const orderSourceCategories = new Set<string>(["DIRECT", "YOUMUDAO", "CTRIP", "MEITUAN", "MEMBER"]);
const actionCodes = new Set<string>(roomStatusActionCodes);
const blockingFactKinds = new Set<string>(roomStatusBlockingFactKinds);
const taskKinds = new Set<string>(roomStatusOperationalTaskKinds);
const referenceTypes = new Set(["CLAIM", "ORDER", "STAY", "OPERATIONS", "BLOCK", "INVENTORY_UNIT", "RECEIPT"]);
const historySources = new Set(["WEB_SESSION", "API_TOKEN", "SYSTEM", "UNKNOWN"]);
const writeActionCodes = new Set<string>(roomStatusActionCodes.filter((code) => code !== "OPEN_ORDER"));
const createActionCodes = new Set<RoomStatusActionCode>(["CREATE_ORDER", "CREATE_FREE_STAY", "BACKFILL_ORDER", "LOCK_MAINTENANCE"]);
const fullIntervalActionCodes = new Set<RoomStatusActionCode>(["RELEASE_MAINTENANCE"]);
const actionTargetTypes: Record<RoomStatusActionCode, RoomStatusReferenceDto["type"]> = {
  CREATE_ORDER: "INVENTORY_UNIT",
  CREATE_FREE_STAY: "INVENTORY_UNIT",
  BACKFILL_ORDER: "INVENTORY_UNIT",
  LOCK_MAINTENANCE: "INVENTORY_UNIT",
  OPEN_ORDER: "ORDER",
  RELEASE_MAINTENANCE: "BLOCK",
  COMPLETE_CLEANING: "OPERATIONS"
};

function roomStatusActionGrant(actionCode: RoomStatusActionCode): string | null {
  if (actionCode === "OPEN_ORDER") return null;
  if (actionCode === "CREATE_FREE_STAY" || actionCode === "BACKFILL_ORDER") return "CREATE_ORDER";
  return actionCode;
}
const sourceActionCodes: Record<RoomStatusSourceKind, ReadonlySet<RoomStatusActionCode>> = {
  ORDER: new Set(["OPEN_ORDER"]),
  FREE_STAY: new Set(["OPEN_ORDER"]),
  MAINTENANCE: new Set(["RELEASE_MAINTENANCE"]),
  CLEANING: new Set(["COMPLETE_CLEANING"]),
  UNIT_UNSELLABLE: new Set()
};
const sourceReferenceTypes: Record<RoomStatusSourceKind, RoomStatusReferenceDto["type"]> = {
  ORDER: "ORDER",
  FREE_STAY: "ORDER",
  MAINTENANCE: "BLOCK",
  CLEANING: "OPERATIONS",
  UNIT_UNSELLABLE: "INVENTORY_UNIT"
};

function lodgingSource(sourceKind: RoomStatusSourceKind): boolean {
  return sourceKind === "ORDER" || sourceKind === "FREE_STAY";
}

function authoritativeDayStatus(
  intervals: readonly RoomStatusIntervalDto[],
  unitActive: boolean
): RoomStatusStatus {
  if (!unitActive) return "UNAVAILABLE";
  const projected = intervals.filter((interval) => interval.blocking
    || interval.sourceKind === "CLEANING"
    || interval.status === "SETTLED"
    || interval.status === "ARREARS"
    || interval.status === "UNKNOWN");
  if (projected.some((interval) => interval.status === "UNKNOWN")) return "UNKNOWN";
  const priority: readonly RoomStatusStatus[] = [
    "UNAVAILABLE",
    "IN_HOUSE",
    "RESERVED",
    "ARREARS",
    "SETTLED",
    "MAINTENANCE",
    "CLEANING"
  ];
  return priority.find((status) => projected.some((interval) => interval.status === status)) ?? "AVAILABLE";
}

function fail(path: string, detail: string): never {
  throw new Error(`房态 DTO ${path} ${detail}`);
}

function record(value: unknown, path: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "必须是对象");
  return value as UnknownRecord;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "必须是数组");
  return value;
}

function string(value: unknown, path: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !value) fail(path, "必须是非空字符串");
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "必须是布尔值");
  return value;
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) fail(path, `必须是大于等于 ${minimum} 的安全整数`);
  return value;
}

function onlyKeys(item: UnknownRecord, allowedKeys: readonly string[], path: string): void {
  const unexpected = Object.keys(item).filter((key) => !allowedKeys.includes(key));
  if (unexpected.length) fail(path, `包含不允许的字段 ${unexpected.join(", ")}`);
}

function localDate(value: unknown, path: string): string {
  const result = string(value, path);
  if (!isIsoLocalDate(result!)) fail(path, "必须是有效本地日期");
  return result!;
}

function dateTime(value: unknown, path: string): number {
  const result = string(value, path)!;
  const timestamp = Date.parse(result);
  if (!Number.isFinite(timestamp) || !result.includes("T")) fail(path, "必须是有效 ISO 日期时间");
  return timestamp;
}

function attention(value: unknown, path: string): RoomStatusAttention | null {
  if (value === null) return null;
  const result = string(value, path)!;
  if (!attentions.has(result)) fail(path, "不是允许的关注标记");
  return result as RoomStatusAttention;
}

function operationalAttention(value: unknown, path: string): RoomStatusOperationalAttention | null {
  if (value === null) return null;
  const result = string(value, path)!;
  if (!operationalAttentions.has(result)) fail(path, "不是允许的运营关注标记");
  return result as RoomStatusOperationalAttention;
}

function assertReference(value: unknown, path: string): asserts value is RoomStatusReferenceDto {
  const item = record(value, path);
  const type = string(item.type, `${path}.type`)!;
  if (!referenceTypes.has(type)) fail(`${path}.type`, "不是允许的稳定引用类型");
  const id = string(item.id, `${path}.id`)!;
  string(item.label, `${path}.label`);
  if (item.href !== null) {
    const href = string(item.href, `${path}.href`)!;
    const trustedHref = type === "ORDER"
      ? `/orders/${encodeURIComponent(id)}`
      : type === "RECEIPT"
        ? `/api/v1/receipts/${encodeURIComponent(id)}`
        : null;
    if (href !== trustedHref) fail(`${path}.href`, "必须是与稳定引用一致的可信内部路径");
  }
}

function assertAction(
  value: unknown,
  path: string,
  accessLevel: "READ" | "WRITE",
  expectedAllowedActions?: ReadonlySet<string>
): asserts value is RoomStatusActionDto {
  const item = record(value, path);
  const code = string(item.code, `${path}.code`)!;
  if (!actionCodes.has(code)) fail(`${path}.code`, "不是允许的动作 code");
  if (accessLevel === "READ" && writeActionCodes.has(code)) fail(`${path}.code`, "不能向 READ 主体暴露写动作");
  const actionCode = code as RoomStatusActionCode;
  const commandGrant = roomStatusActionGrant(actionCode);
  if (commandGrant && expectedAllowedActions && !expectedAllowedActions.has(commandGrant)) {
    fail(`${path}.code`, "超出当前主体命令授权");
  }
  const enabled = boolean(item.enabled, `${path}.enabled`);
  const disabledReason = item.disabledReason === null ? null : string(item.disabledReason, `${path}.disabledReason`);
  if ((enabled && disabledReason !== null) || (!enabled && disabledReason === null)) {
    fail(`${path}.disabledReason`, enabled ? "启用动作不能携带禁用原因" : "禁用动作必须说明原因");
  }
  const requiresFullInterval = boolean(item.requiresFullInterval, `${path}.requiresFullInterval`);
  if (requiresFullInterval !== fullIntervalActionCodes.has(actionCode)) fail(`${path}.requiresFullInterval`, "与动作的完整区间要求不一致");
  if (item.targetReference === null) fail(`${path}.targetReference`, "动作必须包含稳定目标引用");
  assertReference(item.targetReference, `${path}.targetReference`);
  if ((item.targetReference as RoomStatusReferenceDto).type !== actionTargetTypes[actionCode]) {
    fail(`${path}.targetReference.type`, "与动作 code 的目标类型不一致");
  }
}

function referenceKey(reference: RoomStatusReferenceDto): string {
  return `${reference.type}:${reference.id}`;
}

function actionKey(action: RoomStatusActionDto): string {
  return [
    action.code,
    referenceKey(action.targetReference!),
    action.enabled ? "enabled" : "disabled",
    action.requiresFullInterval ? "full" : "partial",
    action.disabledReason ?? "none"
  ].join(":");
}

function sameStringSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length
    && new Set(actual).size === actual.length
    && actual.every((value) => expected.includes(value));
}

function conflictFactKey(conflict: RoomStatusConflictDto): string {
  return [
    conflict.blockingFactKind,
    conflict.requestedInventoryUnitId,
    conflict.actualInventoryUnitId,
    conflict.roomId,
    conflict.sourceKind,
    referenceKey(conflict.sourceReference),
    conflict.reason
  ].join(":");
}

function assertIntervalActionContext(
  action: RoomStatusActionDto,
  path: string,
  sourceKind: RoomStatusSourceKind,
  references: readonly RoomStatusReferenceDto[]
): void {
  if (createActionCodes.has(action.code) || !sourceActionCodes[sourceKind].has(action.code)) {
    fail(`${path}.code`, "与区间 typed source 不一致");
  }
  if (!references.some((reference) => referenceKey(reference) === referenceKey(action.targetReference!))) {
    fail(`${path}.targetReference`, "不属于该区间公开的稳定来源引用");
  }
}

function assertIntervalConflict(
  conflict: RoomStatusConflictDto,
  path: string,
  interval: Pick<RoomStatusIntervalDto,
    "displayInventoryUnitId" | "actualInventoryUnitId" | "roomId" | "startDate" | "endDate" | "sourceKind" | "claimIds" | "references">,
  constrainDatesToInterval = true
): void {
  if (conflict.requestedInventoryUnitId !== interval.displayInventoryUnitId
    || conflict.actualInventoryUnitId !== interval.actualInventoryUnitId
    || conflict.roomId !== interval.roomId
    || (constrainDatesToInterval && (conflict.startDate !== interval.startDate || conflict.endDate !== interval.endDate))
    || conflict.sourceKind !== interval.sourceKind
    || !sameStringSet(conflict.claimIds, interval.claimIds)
    || !interval.references.some((reference) => referenceKey(reference) === referenceKey(conflict.sourceReference))) {
    fail(path, "与所属 blocking interval 的稳定事实不一致");
  }
}

function assertHistory(value: unknown, path: string): asserts value is RoomStatusHistoryDto {
  const item = record(value, path);
  string(item.action, `${path}.action`);
  if (item.actorId !== null) string(item.actorId, `${path}.actorId`);
  if (!historySources.has(string(item.source, `${path}.source`)!)) fail(`${path}.source`, "不是允许的审计来源");
  dateTime(item.occurredAt, `${path}.occurredAt`);
  if (item.commandId !== null) string(item.commandId, `${path}.commandId`);
  if (item.receiptId !== null) string(item.receiptId, `${path}.receiptId`);
  if (item.correlationId !== null) string(item.correlationId, `${path}.correlationId`);
}

function assertConflict(value: unknown, path: string): asserts value is RoomStatusConflictDto {
  const item = record(value, path);
  string(item.id, `${path}.id`);
  const blockingFactKind = string(item.blockingFactKind, `${path}.blockingFactKind`)!;
  if (!blockingFactKinds.has(blockingFactKind)) fail(`${path}.blockingFactKind`, "不是允许的阻断事实类型");
  const claimId = item.claimId === null ? null : string(item.claimId, `${path}.claimId`)!;
  const claimIds = array(item.claimIds, `${path}.claimIds`).map((id, index) => string(id, `${path}.claimIds[${index}]`)!);
  if (new Set(claimIds).size !== claimIds.length) fail(`${path}.claimIds`, "不能包含重复 Claim ID");
  if (blockingFactKind === "CLAIM" && (claimId === null || claimIds.length === 0 || claimIds[0] !== claimId)) {
    fail(`${path}.claimIds`, "Claim 阻断必须包含 Claim ID，且兼容 claimId 必须等于首项");
  }
  if (blockingFactKind !== "CLAIM" && (claimId !== null || claimIds.length > 0)) {
    fail(`${path}.claimIds`, "非 Claim 阻断事实不能伪造 Claim ID");
  }
  string(item.requestedInventoryUnitId, `${path}.requestedInventoryUnitId`);
  string(item.actualInventoryUnitId, `${path}.actualInventoryUnitId`);
  string(item.roomId, `${path}.roomId`);
  const startDate = localDate(item.startDate, `${path}.startDate`);
  const endDate = localDate(item.endDate, `${path}.endDate`);
  if (endDate <= startDate) fail(path, "必须使用非空半开冲突区间");
  const sourceKind = string(item.sourceKind, `${path}.sourceKind`)!;
  if (!sourceKinds.has(sourceKind)) fail(`${path}.sourceKind`, "不是允许的 typed source");
  assertReference(item.sourceReference, `${path}.sourceReference`);
  const sourceReference = item.sourceReference as RoomStatusReferenceDto;
  if ((blockingFactKind === "DUE_OUT" || blockingFactKind === "OVERDUE_IN_HOUSE")
    && (!(sourceKind === "ORDER" || sourceKind === "FREE_STAY") || sourceReference.type !== "ORDER")) {
    fail(path, "待退房或逾期在住阻断必须引用 ORDER 来源事实");
  }
  if (blockingFactKind === "LODGING_ORDER"
    && (!(sourceKind === "ORDER" || sourceKind === "FREE_STAY") || sourceReference.type !== "ORDER")) {
    fail(path, "住宿订单阻断必须引用 ORDER 来源事实");
  }
  if (blockingFactKind === "UNIT_UNSELLABLE"
    && (sourceKind !== "UNIT_UNSELLABLE" || sourceReference.type !== "INVENTORY_UNIT")) {
    fail(path, "库存不可售阻断必须引用 INVENTORY_UNIT 来源事实");
  }
  string(item.reason, `${path}.reason`);
  if (item.blocking !== true) fail(`${path}.blocking`, "必须为 true");
}

function assertInterval(
  value: unknown,
  path: string,
  accessLevel: "READ" | "WRITE",
  expectedRange: ExpectedRoomStatusQuery["range"],
  constrainToRange = true,
  constrainConflictDatesToInterval = true,
  businessDate?: string,
  expectedAllowedActions?: ReadonlySet<string>
): asserts value is RoomStatusIntervalDto {
  const item = record(value, path);
  string(item.id, `${path}.id`);
  string(item.displayInventoryUnitId, `${path}.displayInventoryUnitId`);
  string(item.actualInventoryUnitId, `${path}.actualInventoryUnitId`);
  string(item.roomId, `${path}.roomId`);
  const startDate = localDate(item.startDate, `${path}.startDate`);
  const endDate = localDate(item.endDate, `${path}.endDate`);
  if (endDate <= startDate || (constrainToRange && (startDate < expectedRange.arrivalDate || endDate > expectedRange.departureDate))) fail(path, "超出查询范围或半开区间为空");
  const sourceStartDate = localDate(item.sourceStartDate, `${path}.sourceStartDate`);
  const sourceEndDate = localDate(item.sourceEndDate, `${path}.sourceEndDate`);
  if (sourceEndDate <= sourceStartDate || startDate < sourceStartDate || endDate > sourceEndDate) {
    fail(path, "可见区间必须包含在非空的来源完整半开区间内");
  }
  const status = string(item.status, `${path}.status`)!;
  if (!statuses.has(status)) fail(`${path}.status`, "不是允许的房态");
  const projectedAttention = attention(item.attention, `${path}.attention`);
  const projectedOperationalAttention = operationalAttention(
    item.operationalAttention,
    `${path}.operationalAttention`
  );
  const available = boolean(item.available, `${path}.available`);
  const blocking = boolean(item.blocking, `${path}.blocking`);
  const sourceKindValue = string(item.sourceKind, `${path}.sourceKind`)!;
  if (!sourceKinds.has(sourceKindValue)) fail(`${path}.sourceKind`, "不是允许的 typed source");
  const sourceKind = sourceKindValue as RoomStatusSourceKind;
  const sourceCategoryValue = string(item.sourceCategory, `${path}.sourceCategory`, true);
  if (sourceCategoryValue !== null && !sourceCategories.has(sourceCategoryValue)) {
    fail(`${path}.sourceCategory`, "不是允许的住宿来源类别");
  }
  const freeStayCategoryCode = string(item.freeStayCategoryCode, `${path}.freeStayCategoryCode`, true);
  if (freeStayCategoryCode !== null && !freeStayCategories.has(freeStayCategoryCode)) {
    fail(`${path}.freeStayCategoryCode`, "不是允许的免费入住类别");
  }
  const freeStayReason = string(item.freeStayReason, `${path}.freeStayReason`, true);
  const legacyFreeStayWithoutSourceMetadata = sourceKind === "FREE_STAY"
    && sourceCategoryValue === null
    && freeStayCategoryCode === null
    && freeStayReason === null
    && (status === "SETTLED" || status === "ARREARS")
    && (!businessDate || sourceEndDate <= businessDate);
  const failedClosedLodgingWithoutSourceMetadata = lodgingSource(sourceKind)
    && status === "UNKNOWN"
    && sourceCategoryValue === null
    && freeStayCategoryCode === null
    && freeStayReason === null;
  if (status === "UNKNOWN" && lodgingSource(sourceKind)
    && !failedClosedLodgingWithoutSourceMetadata) {
    fail(`${path}.sourceCategory`, "UNKNOWN 住宿必须隐藏全部来源角标字段");
  }
  if (!lodgingSource(sourceKind)) {
    if (sourceCategoryValue !== null || freeStayCategoryCode !== null || freeStayReason !== null) {
      fail(`${path}.sourceCategory`, "非住宿来源不能携带住宿来源角标字段");
    }
  } else if (sourceCategoryValue === null) {
    if (!legacyFreeStayWithoutSourceMetadata && !failedClosedLodgingWithoutSourceMetadata) {
      fail(`${path}.sourceCategory`, sourceKind === "FREE_STAY" ? "免费入住必须携带完整来源类别和原因" : "住宿来源必须显式携带来源类别");
    }
  } else if (sourceKind === "FREE_STAY") {
    if (sourceCategoryValue !== "FREE_STAY") fail(`${path}.sourceCategory`, "免费入住来源类别必须为 FREE_STAY");
    if (freeStayCategoryCode === null || freeStayReason === null) {
      fail(`${path}.freeStayCategoryCode`, "免费入住必须携带类别和原因以供人工核对");
    }
  } else {
    if (!orderSourceCategories.has(sourceCategoryValue ?? "")) {
      fail(`${path}.sourceCategory`, "普通订单来源只能为直订、渠道或会员权益；不可识别来源必须以 UNKNOWN 状态和空来源类别表示");
    }
    if (freeStayCategoryCode !== null || freeStayReason !== null) {
      fail(`${path}.freeStayCategoryCode`, "非免费订单不能携带免费入住类别或原因");
    }
  }
  if (constrainToRange
    && businessDate
    && lodgingSource(sourceKind)
    && (status === "RESERVED" || status === "IN_HOUSE")
    && endDate > businessDate
    && !blocking) {
    fail(`${path}.blocking`, "当前或未来住宿必须保持库存阻断");
  }
  if (status === "ARREARS" && projectedAttention !== "ARREARS") {
    fail(`${path}.attention`, "历史欠款状态必须显式携带欠款注意事实");
  }
  if (projectedAttention === "ARREARS"
    && (sourceKind !== "ORDER" || (status !== "RESERVED" && status !== "ARREARS"))) {
    fail(`${path}.attention`, "欠款注意事实只能附着于当前预订或历史欠款订单");
  }
  if (constrainToRange && businessDate && projectedAttention === "ARREARS"
    && ((status === "RESERVED" && startDate < businessDate)
      || (status === "ARREARS" && sourceEndDate > businessDate))) {
    fail(`${path}.attention`, "欠款注意事实与营业日分区不一致");
  }
  if (businessDate
    && (status === "SETTLED" || status === "ARREARS")
    && sourceEndDate > businessDate) {
    fail(`${path}.status`, "已完成住宿状态只能表示营业日前结束的住宿");
  }
  const orderArrivalDate = item.orderArrivalDate === undefined
    ? null
    : localDate(item.orderArrivalDate, `${path}.orderArrivalDate`);
  const orderDepartureDate = item.orderDepartureDate === undefined
    ? null
    : localDate(item.orderDepartureDate, `${path}.orderDepartureDate`);
  if ((orderArrivalDate === null) !== (orderDepartureDate === null)) {
    fail(`${path}.orderDepartureDate`, "原订单入住日和退房日必须同时提供或同时省略");
  }
  if (orderArrivalDate !== null && orderDepartureDate !== null) {
    if (sourceKind !== "ORDER" && sourceKind !== "FREE_STAY") {
      fail(`${path}.orderArrivalDate`, "只能由住宿订单来源提供");
    }
    if (orderDepartureDate <= orderArrivalDate) {
      fail(`${path}.orderDepartureDate`, "原订单日期必须形成非空半开区间");
    }
    if (orderArrivalDate > sourceStartDate) {
      fail(`${path}.orderArrivalDate`, "不能晚于来源完整区间的开始日期");
    }
  }
  if (projectedOperationalAttention === "OVERDUE_RESERVED") {
    if (!lodgingSource(sourceKind) || status !== "RESERVED" || orderArrivalDate === null) {
      fail(`${path}.operationalAttention`, "逾期预订只能附着于带原始到店日的已预订住宿");
    }
    if (businessDate && orderArrivalDate !== null && !(orderArrivalDate < businessDate)) {
      fail(`${path}.operationalAttention`, "逾期预订的原始到店日必须早于营业日");
    }
  }
  if (projectedOperationalAttention === "OVERDUE_IN_HOUSE") {
    if (!lodgingSource(sourceKind) || status !== "IN_HOUSE") {
      fail(`${path}.operationalAttention`, "逾期未退只能附着于在住住宿");
    }
    if (businessDate && !(sourceEndDate < businessDate)) {
      fail(`${path}.operationalAttention`, "逾期未退的可见来源区间必须在营业日前结束");
    }
  }
  if (projectedOperationalAttention === "DUE_OUT") {
    if (!lodgingSource(sourceKind) || status !== "IN_HOUSE" || orderDepartureDate === null) {
      fail(`${path}.operationalAttention`, "待退房只能附着于带原订单退房日在住住宿");
    }
    if (businessDate && orderDepartureDate !== businessDate) {
      fail(`${path}.operationalAttention`, "待退房的原订单退房日必须等于营业日");
    }
  }
  if (businessDate
    && lodgingSource(sourceKind)
    && status === "RESERVED"
    && orderArrivalDate !== null
    && orderArrivalDate < businessDate
    && projectedOperationalAttention !== "OVERDUE_RESERVED") {
    fail(`${path}.operationalAttention`, "逾期预订必须显式携带逾期运营关注事实");
  }
  string(item.label, `${path}.label`);
  if (item.primaryOccupantLabel !== null) string(item.primaryOccupantLabel, `${path}.primaryOccupantLabel`);
  const occupantCount = integer(item.occupantCount, `${path}.occupantCount`);
  const occupants = array(item.occupants, `${path}.occupants`);
  if (occupants.length !== occupantCount) fail(`${path}.occupants`, "必须与住宿人数逐一对应");
  const occupantIds = new Set<string>();
  occupants.forEach((occupantValue, index) => {
    const occupantPath = `${path}.occupants[${index}]`;
    const occupant = record(occupantValue, occupantPath);
    onlyKeys(occupant, ["occupantId", "nickname"], occupantPath);
    const occupantId = string(occupant.occupantId, `${occupantPath}.occupantId`)!;
    if (occupantIds.has(occupantId)) fail(`${occupantPath}.occupantId`, "同一区间不能重复住宿人");
    occupantIds.add(occupantId);
    if (occupant.nickname !== null) string(occupant.nickname, `${occupantPath}.nickname`);
  });
  const lodging = sourceKind === "ORDER" || sourceKind === "FREE_STAY";
  const displayableLodging = lodging && status !== "UNKNOWN";
  if (status === "UNKNOWN" && occupantCount !== 0) {
    fail(`${path}.occupantCount`, "UNKNOWN 区间必须隐藏住宿人");
  }
  if (status === "UNKNOWN" && item.primaryOccupantLabel !== null) {
    fail(`${path}.primaryOccupantLabel`, "UNKNOWN 区间不能公开主住宿人标签");
  }
  if (displayableLodging && occupantCount < 1) fail(`${path}.occupantCount`, "可展示住宿来源必须包含至少一位住宿人");
  if (!lodging && occupantCount !== 0) fail(`${path}.occupantCount`, "非住宿来源不能包含住宿人");
  if (displayableLodging && occupants[0] && (occupants[0] as UnknownRecord).nickname !== item.primaryOccupantLabel) {
    fail(`${path}.primaryOccupantLabel`, "必须与第一位住宿人昵称一致");
  }
  if (item.reason !== null) string(item.reason, `${path}.reason`);
  const claimIds = array(item.claimIds, `${path}.claimIds`).map((id, index) => string(id, `${path}.claimIds[${index}]`)!);
  if (new Set(claimIds).size !== claimIds.length) fail(`${path}.claimIds`, "不能包含重复 Claim ID");
  const references = array(item.references, `${path}.references`);
  references.forEach((reference, index) => assertReference(reference, `${path}.references[${index}]`));
  const typedReferences = references as RoomStatusReferenceDto[];
  const referenceKeys = typedReferences.map(referenceKey);
  if (new Set(referenceKeys).size !== referenceKeys.length) fail(`${path}.references`, "不能包含重复稳定引用");
  if (status !== "UNKNOWN" && !typedReferences.some((reference) => reference.type === sourceReferenceTypes[sourceKind])) {
    fail(`${path}.references`, "缺少 typed source 对应的稳定引用");
  }
  if (status !== "UNKNOWN" && (sourceKind === "ORDER" || sourceKind === "FREE_STAY")
    && !typedReferences.some((reference) => reference.type === "STAY")) {
    fail(`${path}.references`, "住宿来源缺少稳定 Stay 引用");
  }
  const conflicts = array(item.conflicts, `${path}.conflicts`);
  conflicts.forEach((conflict, index) => assertConflict(conflict, `${path}.conflicts[${index}]`));
  const typedConflicts = conflicts as RoomStatusConflictDto[];
  if (typedConflicts.some((conflict) => conflict.blockingFactKind === "OVERDUE_IN_HOUSE")) {
    fail(`${path}.conflicts`, "不能用逾期在住事实自动延长当前或未来房态");
  }
  const dueOutConflicts = typedConflicts.filter((conflict) => conflict.blockingFactKind === "DUE_OUT");
  if (projectedOperationalAttention === "DUE_OUT") {
    if (!(blocking && !available && claimIds.length === 0 && dueOutConflicts.length === 1)) {
      fail(`${path}.conflicts`, "待退房必须由一个非 Claim 的专用安全事实保持阻断");
    }
  } else if (dueOutConflicts.length > 0) {
    fail(`${path}.conflicts`, "专用待退房阻断必须同时携带待退房运营关注事实");
  }
  const intervalShape = {
    displayInventoryUnitId: item.displayInventoryUnitId as string,
    actualInventoryUnitId: item.actualInventoryUnitId as string,
    roomId: item.roomId as string,
    startDate,
    endDate,
    sourceKind,
    claimIds,
    references: typedReferences
  };
  typedConflicts.forEach((conflict, index) => assertIntervalConflict(
    conflict,
    `${path}.conflicts[${index}]`,
    intervalShape,
    constrainConflictDatesToInterval
  ));
  if (!blocking && typedConflicts.length > 0) fail(`${path}.conflicts`, "非阻断区间不能公开 blocking conflict");
  if (blocking && typedConflicts.length !== 1) {
    fail(`${path}.conflicts`, "阻断区间必须公开一个精确冲突事实");
  }
  array(item.history, `${path}.history`).forEach((history, index) => assertHistory(history, `${path}.history[${index}]`));
  const actions = array(item.allowedActions, `${path}.allowedActions`);
  actions.forEach((action, index) => assertAction(action, `${path}.allowedActions[${index}]`, accessLevel, expectedAllowedActions));
  const typedActions = actions as RoomStatusActionDto[];
  if (new Set(typedActions.map(actionKey)).size !== typedActions.length) fail(`${path}.allowedActions`, "不能包含重复动作");
  typedActions.forEach((action, index) => assertIntervalActionContext(
    action,
    `${path}.allowedActions[${index}]`,
    sourceKind,
    typedReferences
  ));
  if (available !== !blocking || (typedConflicts.length > 0 && available)) fail(`${path}.available`, "必须与阻断区间和冲突事实一致");
  if ((status === "UNKNOWN" || status === "STALE" || status === "UNAVAILABLE")
    && (available || typedActions.length > 0)) {
    fail(path, "未知、陈旧或不可售区间必须 fail closed");
  }
}

function assertOperationalTask(
  value: unknown,
  path: string,
  accessLevel: "READ" | "WRITE",
  expected: ExpectedRoomStatusQuery,
  businessDate: string
): asserts value is RoomStatusOperationalTaskDto {
  const item = record(value, path);
  const taskKind = string(item.taskKind, `${path}.taskKind`)!;
  if (!taskKinds.has(taskKind)) fail(`${path}.taskKind`, "不是允许的运营任务类型");
  if (localDate(item.businessDate, `${path}.businessDate`) !== businessDate) fail(`${path}.businessDate`, "与房态营业日期不一致");
  assertInterval(value, path, accessLevel, expected.range, false, false, businessDate, expected.allowedActions);
  if (item.displayInventoryUnitId !== item.actualInventoryUnitId) fail(path, "运营任务必须引用实际库存单元");
  if (item.startDate !== item.sourceStartDate || item.endDate !== item.sourceEndDate) fail(path, "运营任务必须公开来源完整区间");
  const sourceKind = item.sourceKind as RoomStatusSourceKind;
  const lodging = sourceKind === "ORDER" || sourceKind === "FREE_STAY";
  const conflicts = item.conflicts as RoomStatusConflictDto[];
  if (taskKind === "EXCEPTION"
    && lodging
    && item.status === "IN_HOUSE"
    && typeof item.endDate === "string"
    && item.endDate < businessDate
    && item.operationalAttention !== "OVERDUE_IN_HOUSE") {
    fail(`${path}.operationalAttention`, "逾期未退任务必须显式携带未退运营关注事实");
  }
  if (item.blocking === true && conflicts.some((conflict) => (
    conflict.startDate !== businessDate || conflict.endDate !== addLocalDateDays(businessDate, 1)
  ))) {
    fail(`${path}.conflicts`, "运营任务冲突必须精确表示当前营业日重叠区间");
  }
  if (taskKind === "EXCEPTION") {
    const startDate = item.startDate as string;
    const endDate = item.endDate as string;
    if (lodging && item.status === "RESERVED") {
      if (!(startDate < businessDate && typeof item.reason === "string" && item.reason.length > 0)) {
        fail(path, "逾期未到异常必须早于营业日期并说明原因");
      }
      const stillCoversBusinessDate = businessDate < endDate;
      if (stillCoversBusinessDate && !(item.blocking === true && item.available === false
        && conflicts.length === 1 && conflicts[0]?.blockingFactKind === "CLAIM")) {
        fail(path, "仍覆盖营业日期的逾期未到异常必须由真实 Claim 保持阻断");
      }
      if (!stillCoversBusinessDate && !(item.blocking === false && item.available === true && conflicts.length === 0)) {
        fail(path, "已结束的历史未到异常必须非阻断且不公开冲突");
      }
      return;
    }
    if (lodging && item.status === "IN_HOUSE") {
      const claimIds = item.claimIds as string[];
      const references = item.references as RoomStatusReferenceDto[];
      const actions = item.allowedActions as RoomStatusActionDto[];
      if (!(endDate < businessDate
        && item.blocking === false
        && item.available === true
        && conflicts.length === 0
        && claimIds.length === 0
        && !references.some((reference) => reference.type === "CLAIM")
        && actions.length === 1
        && actions[0]?.code === "OPEN_ORDER"
        && actions[0].enabled
        && typeof item.reason === "string"
        && item.reason.length > 0)) {
        fail(path, "逾期未退异常必须早于营业日期、非阻断、无当前 Claim，并提供可打开订单的原因");
      }
      return;
    }
    if (lodging && item.status !== "UNKNOWN") fail(path, "订单或免费住宿异常状态不受支持");
    if (!(startDate <= businessDate && businessDate < endDate)) fail(path, "异常任务必须覆盖营业日期");
    return;
  }
  if (!lodging) fail(path, "到店、在住和离店任务只能来自订单或免费住宿");
  if ((taskKind === "ARRIVAL" || taskKind === "IN_HOUSE") && conflicts[0]?.blockingFactKind !== "CLAIM") {
    fail(`${path}.conflicts`, "正常到店和在住任务必须引用当前营业日的真实 Claim");
  }
  if (taskKind === "ARRIVAL" && (item.startDate !== businessDate || item.status !== "RESERVED" || item.blocking !== true)) {
    fail(path, "到店任务必须从营业日期开始、处于已预订状态并保持库存阻断");
  }
  if (taskKind === "DEPARTURE" && (item.endDate !== businessDate || item.status !== "IN_HOUSE"
    || item.operationalAttention !== "DUE_OUT"
    || item.blocking !== true || item.available !== false || conflicts[0]?.blockingFactKind !== "DUE_OUT")) {
    fail(path, "离店任务必须在营业日期结束、保持在住来源状态并引用当前未退房订单阻断事实");
  }
  if (taskKind === "IN_HOUSE" && !(item.status === "IN_HOUSE"
    && typeof item.startDate === "string" && typeof item.endDate === "string"
    && item.startDate <= businessDate && businessDate < item.endDate && item.blocking === true)) fail(path, "在住任务未覆盖营业日期或未保持库存阻断");
}

function assertUnit(
  value: unknown,
  path: string,
  accessLevel: "READ" | "WRITE",
  projectionState: RoomStatusBoardDto["projectionState"],
  expected: ExpectedRoomStatusQuery,
  dates: readonly string[],
  expectedParentRoomId: string | null,
  businessDate: string
): asserts value is RoomStatusUnitDto {
  const item = record(value, path);
  const id = string(item.id, `${path}.id`)!;
  if (item.propertyId !== expected.propertyId) fail(`${path}.propertyId`, "与当前物业不一致");
  const roomId = string(item.roomId, `${path}.roomId`)!;
  const parentRoomId = item.parentRoomId === null ? null : string(item.parentRoomId, `${path}.parentRoomId`);
  if (parentRoomId !== expectedParentRoomId) fail(`${path}.parentRoomId`, "与父子层级不一致");
  const kind = string(item.kind, `${path}.kind`)!;
  if ((expectedParentRoomId === null && kind !== "ROOM") || (expectedParentRoomId !== null && kind !== "BED")) fail(`${path}.kind`, "与父子层级不一致");
  if (kind === "ROOM" && roomId !== id) fail(`${path}.roomId`, "房间父行必须以自身 ID 作为 roomId");
  if (kind === "BED" && roomId !== expectedParentRoomId) fail(`${path}.roomId`, "床位必须引用父房间");
  string(item.code, `${path}.code`);
  string(item.name, `${path}.name`);
  const active = boolean(item.active, `${path}.active`);
  if (!new Set(["WHOLE_ROOM", "BED_SPLIT", "UNAVAILABLE"]).has(string(item.salesMode, `${path}.salesMode`)!)) fail(`${path}.salesMode`, "不是允许的销售模式");
  for (const key of ["buildingCode", "roomTypeCode", "pricingProductCode"] as const) {
    if (item[key] !== null) string(item[key], `${path}.${key}`);
  }
  const physicalBedCount = item.physicalBedCount === null
    ? null
    : integer(item.physicalBedCount, `${path}.physicalBedCount`, 1);
  if (kind === "BED" && physicalBedCount !== null) {
    fail(`${path}.physicalBedCount`, "床位单元不能伪造房间实体床数");
  }
  integer(item.capacity, `${path}.capacity`, 1);
  const occupancyCapacity = integer(item.occupancyCapacity, `${path}.occupancyCapacity`, 1);
  if (kind === "BED" && occupancyCapacity !== 1) fail(`${path}.occupancyCapacity`, "床位住宿容量必须为 1");
  const childUnitIds = array(item.childUnitIds, `${path}.childUnitIds`).map((childId, index) => string(childId, `${path}.childUnitIds[${index}]`)!);
  const intervals = array(item.intervals, `${path}.intervals`);
  intervals.forEach((interval, index) => {
    const intervalPath = `${path}.intervals[${index}]`;
    assertInterval(interval, intervalPath, accessLevel, expected.range, true, true, businessDate, expected.allowedActions);
    const projected = interval as RoomStatusIntervalDto;
    const inheritedFromChild = kind === "ROOM" && childUnitIds.includes(projected.actualInventoryUnitId);
    const inheritedFromRoom = kind === "BED" && projected.actualInventoryUnitId === expectedParentRoomId;
    if (projected.displayInventoryUnitId !== id || projected.roomId !== roomId
      || (projected.actualInventoryUnitId !== id && !inheritedFromChild && !inheritedFromRoom)) {
      fail(intervalPath, "与所属库存行或父子互斥关系不一致");
    }
    const lodging = projected.sourceKind === "ORDER" || projected.sourceKind === "FREE_STAY";
    const projectedCapacity = projected.actualInventoryUnitId === id
      ? occupancyCapacity
      : inheritedFromChild
        ? 1
        : null;
    if (lodging && projected.status !== "UNKNOWN" && projectedCapacity !== null
      && projected.occupantCount > projectedCapacity) {
      fail(`${intervalPath}.occupantCount`, `不能超过实际库存单元住宿容量 ${projectedCapacity}`);
    }
  });
  const typedIntervals = intervals as RoomStatusIntervalDto[];
  const intervalIdList = typedIntervals.map((interval) => interval.id);
  if (new Set(intervalIdList).size !== intervalIdList.length) fail(`${path}.intervals`, "不能包含重复区间 ID");
  const bedOccupancies = array(item.bedOccupancies, `${path}.bedOccupancies`);
  if ((kind !== "ROOM" || item.salesMode !== "BED_SPLIT") && bedOccupancies.length > 0) {
    fail(`${path}.bedOccupancies`, "只能由拆床销售的房间父行提供");
  }
  const occupancyDates = new Set<string>();
  bedOccupancies.forEach((occupancyValue, index) => {
    const occupancyPath = `${path}.bedOccupancies[${index}]`;
    const occupancy = record(occupancyValue, occupancyPath);
    const serviceDate = localDate(occupancy.serviceDate, `${occupancyPath}.serviceDate`);
    if (!dates.includes(serviceDate) || occupancyDates.has(serviceDate)) {
      fail(`${occupancyPath}.serviceDate`, "必须是查询范围内唯一的营业日期");
    }
    occupancyDates.add(serviceDate);
    const occupiedBedCount = integer(occupancy.occupiedBedCount, `${occupancyPath}.occupiedBedCount`, 1);
    const totalBedCount = integer(occupancy.totalBedCount, `${occupancyPath}.totalBedCount`, 1);
    if (totalBedCount !== item.capacity || occupiedBedCount > totalBedCount) {
      fail(occupancyPath, "分子或分母与权威实体床容量不一致");
    }
    const occupants = array(occupancy.occupants, `${occupancyPath}.occupants`);
    if (occupants.length !== occupiedBedCount) fail(`${occupancyPath}.occupants`, "必须逐一对应已占实体床");
    const occupantUnitIds = new Set<string>();
    occupants.forEach((occupantValue, occupantIndex) => {
      const occupantPath = `${occupancyPath}.occupants[${occupantIndex}]`;
      const occupant = record(occupantValue, occupantPath);
      onlyKeys(occupant, ["occupantId", "inventoryUnitId", "inventoryUnitCode", "primaryOccupantLabel", "sourceReference"], occupantPath);
      const occupantId = string(occupant.occupantId, `${occupantPath}.occupantId`)!;
      const inventoryUnitId = string(occupant.inventoryUnitId, `${occupantPath}.inventoryUnitId`)!;
      if (inventoryUnitId === id || occupantUnitIds.has(inventoryUnitId)) {
        fail(`${occupantPath}.inventoryUnitId`, "必须引用唯一真实子床，不能把整房订单扩成床位");
      }
      occupantUnitIds.add(inventoryUnitId);
      string(occupant.inventoryUnitCode, `${occupantPath}.inventoryUnitCode`);
      if (occupant.primaryOccupantLabel !== null) string(occupant.primaryOccupantLabel, `${occupantPath}.primaryOccupantLabel`);
      assertReference(occupant.sourceReference, `${occupantPath}.sourceReference`);
      const sourceReference = occupant.sourceReference as RoomStatusReferenceDto;
      if (sourceReference.type !== "ORDER") fail(`${occupantPath}.sourceReference.type`, "住客占用必须追溯到 Order");
      // 今天及未来必须是有权的阻断住宿来源；历史日期允许已退房的非阻断住宿记录作为来源，
      // 这样历史床位占用才能与当前在住以同一方式展示。
      const backingIntervals = typedIntervals.filter((interval) => interval.actualInventoryUnitId === inventoryUnitId
        && interval.startDate <= serviceDate
        && serviceDate < interval.endDate
        && (interval.blocking || serviceDate < businessDate)
        && (interval.status === "RESERVED" || interval.status === "IN_HOUSE" || interval.status === "SETTLED" || interval.status === "ARREARS")
        && (interval.sourceKind === "ORDER" || interval.sourceKind === "FREE_STAY")
        && interval.references.some((reference) => referenceKey(reference) === referenceKey(sourceReference)));
      if (backingIntervals.length !== 1) fail(occupantPath, "必须精确对应一个当天有效的床位住宿来源");
      if (!backingIntervals[0]!.occupants.some((candidate) => candidate.occupantId === occupantId)) {
        fail(`${occupantPath}.occupantId`, "必须对应来源区间中的真实住宿人");
      }
      if (backingIntervals[0]!.primaryOccupantLabel !== occupant.primaryOccupantLabel) {
        fail(`${occupantPath}.primaryOccupantLabel`, "必须与来源 interval 的居住人快照一致");
      }
    });
  });
  const bedSlotStates = array(item.bedSlotStates, `${path}.bedSlotStates`);
  if ((kind !== "ROOM" || item.salesMode !== "BED_SPLIT") && bedSlotStates.length > 0) {
    fail(`${path}.bedSlotStates`, "只能由拆床销售的房间父行提供");
  }
  const slotsByDate = new Map<string, Array<{
    index: number;
    inventoryUnitId: string;
    inventoryUnitCode: string;
    status: string;
  }>>();
  bedSlotStates.forEach((slotValue, index) => {
    const slotPath = `${path}.bedSlotStates[${index}]`;
    const slot = record(slotValue, slotPath);
    onlyKeys(slot, ["serviceDate", "inventoryUnitId", "inventoryUnitCode", "status"], slotPath);
    const serviceDate = localDate(slot.serviceDate, `${slotPath}.serviceDate`);
    if (!dates.includes(serviceDate)) fail(`${slotPath}.serviceDate`, "必须位于查询日期范围内");
    const inventoryUnitId = string(slot.inventoryUnitId, `${slotPath}.inventoryUnitId`)!;
    const inventoryUnitCode = string(slot.inventoryUnitCode, `${slotPath}.inventoryUnitCode`)!;
    if (kind === "ROOM" && item.salesMode === "BED_SPLIT" && !childUnitIds.includes(inventoryUnitId)) {
      fail(`${slotPath}.inventoryUnitId`, "床位槽必须来自权威子床集合");
    }
    const slotStatus = string(slot.status, `${slotPath}.status`)!;
    if (!statuses.has(slotStatus)) fail(`${slotPath}.status`, "不是允许的房态");
    if ((slotStatus === "SETTLED" || slotStatus === "ARREARS") && serviceDate >= businessDate) {
      fail(`${slotPath}.status`, "已完成床位状态只能表示营业日前的住宿");
    }
    if (slotStatus === "UNKNOWN" && projectionState === "READY") {
      fail(`${slotPath}.status`, "UNKNOWN 床位槽必须使投影失败关闭为 PARTIAL");
    }
    const daySlots = slotsByDate.get(serviceDate) ?? [];
    if (daySlots.some((candidate) => candidate.inventoryUnitId === inventoryUnitId)) {
      fail(`${slotPath}.inventoryUnitId`, "同一日期不能重复床位槽");
    }
    daySlots.push({ index, inventoryUnitId, inventoryUnitCode, status: slotStatus });
    slotsByDate.set(serviceDate, daySlots);
  });
  if (kind === "ROOM" && item.salesMode === "BED_SPLIT") {
    const firstSlots = slotsByDate.get(dates[0]!) ?? [];
    if (dates.some((serviceDate) => !slotsByDate.has(serviceDate))) {
      fail(`${path}.bedSlotStates`, "必须覆盖查询范围内的每个日期");
    }
    for (const serviceDate of dates) {
      const daySlots = slotsByDate.get(serviceDate)!;
      if (daySlots.length !== firstSlots.length
        || daySlots.some((slot, index) => slot.inventoryUnitId !== firstSlots[index]?.inventoryUnitId
          || slot.inventoryUnitCode !== firstSlots[index]?.inventoryUnitCode)) {
        fail(`${path}.bedSlotStates`, "每日必须保持相同的完整床位槽顺序");
      }
    }
    if (projectionState === "READY" && physicalBedCount !== null && firstSlots.length !== physicalBedCount) {
      fail(`${path}.bedSlotStates`, "READY 投影的床位槽数量必须等于权威实体床数");
    }
    if (projectionState === "READY" && childUnitIds.some((childId) => !firstSlots.some((slot) => slot.inventoryUnitId === childId))) {
      fail(`${path}.bedSlotStates`, "READY 投影必须包含全部可展开子床");
    }
  }
  const days = array(item.days, `${path}.days`);
  if (days.length !== dates.length) fail(`${path}.days`, "未覆盖完整查询日期");
  days.forEach((dayValue, index) => {
    const dayPath = `${path}.days[${index}]`;
    const day = record(dayValue, dayPath);
    if (day.serviceDate !== dates[index]) fail(`${dayPath}.serviceDate`, "与查询日期轴不一致");
    const serviceDate = dates[index]!;
    const dayStatus = string(day.status, `${dayPath}.status`)!;
    if (!statuses.has(dayStatus)) fail(`${dayPath}.status`, "不是允许的房态");
    const dayAvailable = boolean(day.available, `${dayPath}.available`);
    const coveringIntervals = typedIntervals.filter((interval) => interval.startDate <= serviceDate && serviceDate < interval.endDate);
    const expectedIntervalIds = coveringIntervals.map((interval) => interval.id);
    const actualIntervalIds = array(day.intervalIds, `${dayPath}.intervalIds`)
      .map((intervalId, intervalIndex) => string(intervalId, `${dayPath}.intervalIds[${intervalIndex}]`)!);
    if (!sameStringSet(actualIntervalIds, expectedIntervalIds)) fail(`${dayPath}.intervalIds`, "必须精确引用覆盖该营业日的全部区间");
    const dayConflicts = array(day.conflicts, `${dayPath}.conflicts`);
    dayConflicts.forEach((conflict, conflictIndex) => {
      const conflictPath = `${dayPath}.conflicts[${conflictIndex}]`;
      assertConflict(conflict, conflictPath);
      const projected = conflict as RoomStatusConflictDto;
      if (projected.startDate !== serviceDate || projected.endDate !== addLocalDateDays(serviceDate, 1)) {
        fail(conflictPath, "必须精确表示该营业日的重叠半开区间");
      }
      if (projected.blockingFactKind === "CLAIM"
        && (projected.claimIds.length !== 1
          || projected.claimId === null
          || !coveringIntervals.some((interval) => interval.claimIds.includes(projected.claimId!)))) {
        fail(`${conflictPath}.claimIds`, "必须精确引用该营业日所属的单一 Claim");
      }
      if (projected.blockingFactKind !== "CLAIM" && (projected.claimId !== null || projected.claimIds.length > 0)) {
        fail(`${conflictPath}.claimIds`, "非 Claim 营业日阻断不能伪造 Claim ID");
      }
    });
    const typedDayConflicts = dayConflicts as RoomStatusConflictDto[];
    const actualConflictFacts = typedDayConflicts.map(conflictFactKey);
    const expectedConflictFacts = [...new Set(coveringIntervals.flatMap((interval) => interval.conflicts.map(conflictFactKey)))];
    const actualConflictIdentities = typedDayConflicts.map((conflict) => `${conflictFactKey(conflict)}:${conflict.claimId ?? "none"}`);
    if (new Set(actualConflictIdentities).size !== actualConflictIdentities.length
      || !sameStringSet([...new Set(actualConflictFacts)], expectedConflictFacts)) {
      fail(`${dayPath}.conflicts`, "必须精确对应覆盖该营业日的 blocking intervals");
    }
    const expectedAvailable = active
      && serviceDate >= businessDate
      && !coveringIntervals.some((interval) => interval.blocking || interval.status === "UNKNOWN");
    if (dayAvailable !== expectedAvailable) fail(`${dayPath}.available`, "必须与覆盖该日的 blocking/UNKNOWN 区间一致");
    if ((dayStatus === "UNKNOWN" || dayStatus === "STALE" || dayStatus === "UNAVAILABLE")
      && dayAvailable) {
      fail(dayPath, "未知、陈旧或不可售日期必须 fail closed");
    }
    if (dayStatus !== authoritativeDayStatus(coveringIntervals, active)) {
      fail(`${dayPath}.status`, "必须与覆盖该日的权威区间状态一致");
    }
  });
  const unitConflicts = array(item.conflicts, `${path}.conflicts`);
  unitConflicts.forEach((conflict, index) => assertConflict(conflict, `${path}.conflicts[${index}]`));
  const actualUnitConflictFacts = (unitConflicts as RoomStatusConflictDto[]).map((conflict) => `${conflict.id}:${conflictFactKey(conflict)}`);
  const expectedUnitConflictFacts = typedIntervals.flatMap((interval) => interval.conflicts.map((conflict) => `${conflict.id}:${conflictFactKey(conflict)}`));
  if (!sameStringSet(actualUnitConflictFacts, expectedUnitConflictFacts)) fail(`${path}.conflicts`, "必须精确汇总所属区间冲突");
  const unitActions = array(item.allowedActions, `${path}.allowedActions`);
  unitActions.forEach((action, index) => assertAction(action, `${path}.allowedActions[${index}]`, accessLevel, expected.allowedActions));
  const typedUnitActions = unitActions as RoomStatusActionDto[];
  if (new Set(typedUnitActions.map(actionKey)).size !== typedUnitActions.length) fail(`${path}.allowedActions`, "不能包含重复动作");
  const intervalActionKeys = new Set(typedIntervals.flatMap((interval) => interval.allowedActions.map(actionKey)));
  const hasAvailableDay = (days as Array<{ available: boolean }>).some((day) => day.available);
  const hasPastBlankDay = (days as Array<{
    serviceDate: string;
    status: string;
    intervalIds: unknown[];
    conflicts: unknown[];
  }>).some((day) => day.serviceDate < businessDate
    && day.status === "AVAILABLE"
    && day.intervalIds.length === 0
    && day.conflicts.length === 0);
  typedUnitActions.forEach((action, index) => {
    if (createActionCodes.has(action.code)) {
      if (!active
        || action.targetReference?.id !== id
        || (action.code === "BACKFILL_ORDER" ? !hasPastBlankDay : !hasAvailableDay)) {
        fail(`${path}.allowedActions[${index}]`, "创建或补录动作必须指向对应日期可办理的库存单元");
      }
    } else if (!intervalActionKeys.has(actionKey(action))) {
      fail(`${path}.allowedActions[${index}]`, "来源动作必须来自当前单元公开的区间事实");
    }
  });
  const children = array(item.children, `${path}.children`);
  if (kind === "BED" && children.length) fail(`${path}.children`, "床位不能再包含子单元");
  if (kind === "ROOM") {
    children.forEach((child, index) => assertUnit(child, `${path}.children[${index}]`, accessLevel, projectionState, expected, dates, id, businessDate));
    const typedChildren = children as RoomStatusUnitDto[];
    const childrenById = new Map(typedChildren.map((child) => [child.id, child] as const));
    const childIds = typedChildren.map((child) => child.id);
    const childPositions = childIds.map((childId) => childUnitIds.indexOf(childId));
    if (new Set(childUnitIds).size !== childUnitIds.length
      || new Set(childIds).size !== childIds.length
      || childPositions.some((position) => position < 0)
      || childPositions.some((position, index) => index > 0 && position <= childPositions[index - 1]!)) {
      fail(`${path}.childUnitIds`, "必须保持完整稳定床位关系，展示子行只能是其有序子集");
    }
    if (item.salesMode !== "BED_SPLIT" && children.length) fail(`${path}.children`, "非拆床房间不能返回可展开床位");
    for (const [serviceDate, slots] of slotsByDate) {
      for (const slot of slots) {
        const child = childrenById.get(slot.inventoryUnitId);
        if (child && slot.inventoryUnitCode !== child.code) {
          fail(`${path}.bedSlotStates[${slot.index}].inventoryUnitCode`, "必须与返回的权威子床代码一致");
        }
        // A PARTIAL projection may omit facts, but it cannot contradict facts that it returns.
        const facts = typedIntervals.filter((interval) => interval.startDate <= serviceDate
          && serviceDate < interval.endDate
          && (interval.actualInventoryUnitId === slot.inventoryUnitId || interval.actualInventoryUnitId === id));
        if (facts.length > 1 || facts.some((interval) => interval.status === "UNKNOWN")) {
          if (projectionState === "READY") {
            fail(`${path}.bedSlotStates[${slot.index}].status`, "READY 投影的床位槽不能合并多个或 UNKNOWN 权威 interval 事实");
          }
          if (slot.status !== "UNKNOWN") {
            fail(`${path}.bedSlotStates[${slot.index}].status`, "PARTIAL 投影的歧义床位事实必须保持 UNKNOWN");
          }
        } else if (facts.length === 1 && slot.status !== facts[0]!.status) {
          fail(`${path}.bedSlotStates[${slot.index}].status`, "必须与当天唯一权威 interval 状态一致");
        } else if (facts.length === 0 && projectionState === "READY") {
          const expectedSlotStatus = child?.active === false ? "UNAVAILABLE" : "AVAILABLE";
          if (slot.status !== expectedSlotStatus) {
            fail(`${path}.bedSlotStates[${slot.index}].status`, "没有权威 interval 事实时必须表示为空闲子床");
          }
        }
      }
    }

    if (projectionState === "READY" && item.salesMode === "BED_SPLIT") {
      const firstSlots = slotsByDate.get(dates[0]!) ?? [];
      if (!sameStringSet(firstSlots.map((slot) => slot.inventoryUnitId), childUnitIds)) {
        fail(`${path}.bedSlotStates`, "READY 投影的每日床位槽必须精确对应权威子床集合");
      }
      const occupanciesByDate = new Map((bedOccupancies as RoomStatusUnitDto["bedOccupancies"])
        .map((occupancy) => [occupancy.serviceDate, occupancy] as const));
      typedIntervals.forEach((interval, intervalIndex) => {
        const childLodging = childUnitIds.includes(interval.actualInventoryUnitId)
          && interval.blocking
          && (interval.status === "RESERVED" || interval.status === "IN_HOUSE")
          && (interval.sourceKind === "ORDER" || interval.sourceKind === "FREE_STAY");
        if (!childLodging) return;
        const orderReferences = interval.references.filter((reference) => reference.type === "ORDER");
        if (orderReferences.length !== 1) {
          fail(`${path}.intervals[${intervalIndex}].references`, "READY 子床住宿区间必须精确引用一个 Order");
        }
        const orderReferenceKey = referenceKey(orderReferences[0]!);
        dates.filter((serviceDate) => interval.startDate <= serviceDate && serviceDate < interval.endDate)
          .forEach((serviceDate) => {
            const matchingOccupants = occupanciesByDate.get(serviceDate)?.occupants.filter((occupant) => (
              occupant.inventoryUnitId === interval.actualInventoryUnitId
              && referenceKey(occupant.sourceReference) === orderReferenceKey
            )) ?? [];
            if (matchingOccupants.length !== 1) {
              fail(`${path}.bedOccupancies`, `READY 投影缺少 ${serviceDate} 子床住宿区间对应的唯一住客聚合`);
            }
          });
      });
    }
  } else if (childUnitIds.length) fail(`${path}.childUnitIds`, "床位不能包含子单元 ID");
}

function assertAvailabilitySummary(
  value: unknown,
  path: string,
  dates: readonly string[]
): asserts value is RoomStatusAvailabilitySummaryDto[] {
  const items = array(value, path);
  if (items.length !== dates.length) fail(path, "未覆盖完整查询日期");
  items.forEach((value, index) => {
    const item = record(value, `${path}[${index}]`);
    if (localDate(item.serviceDate, `${path}[${index}].serviceDate`) !== dates[index]) {
      fail(`${path}[${index}].serviceDate`, "与查询日期轴不一致");
    }
    integer(item.availableRooms, `${path}[${index}].availableRooms`);
    integer(item.availableBeds, `${path}[${index}].availableBeds`);
    integer(item.paidOccupiedUnits, `${path}[${index}].paidOccupiedUnits`);
    integer(item.totalSellableUnits, `${path}[${index}].totalSellableUnits`);
    integer(item.occupantCount, `${path}[${index}].occupantCount`);
  });
}

export function assertRoomStatusBoard(value: unknown, expected: ExpectedRoomStatusQuery): asserts value is RoomStatusBoardDto {
  const board = record(value, "root");
  if (board.propertyId !== expected.propertyId) fail("propertyId", "与当前物业不一致");
  const businessDate = localDate(board.businessDate, "businessDate");
  const range = record(board.range, "range");
  if (range.arrivalDate !== expected.range.arrivalDate || range.departureDate !== expected.range.departureDate) fail("range", "与当前查询不一致");
  const expectedDates: string[] = [];
  for (let date = expected.range.arrivalDate; date < expected.range.departureDate; date = addLocalDateDays(date, 1)) expectedDates.push(date);
  if (expectedDates.length < 1 || expectedDates.length > 30) fail("range", "超出 1 至 30 夜范围");
  const dates = array(board.dates, "dates").map((date, index) => localDate(date, `dates[${index}]`));
  if (dates.join("|") !== expectedDates.join("|")) fail("dates", "必须连续覆盖完整半开日期范围");
  const asOf = dateTime(board.asOf, "asOf");
  const freshUntil = dateTime(board.freshUntil, "freshUntil");
  if (freshUntil - asOf !== 5_000) fail("freshUntil", "必须精确遵守 5 秒 freshness 合同");
  string(board.revision, "revision");
  const accessLevel = string(board.accessLevel, "accessLevel");
  if (accessLevel !== "READ" && accessLevel !== "WRITE") fail("accessLevel", "必须是 READ 或 WRITE");
  if (board.projectionState !== "READY" && board.projectionState !== "PARTIAL") fail("projectionState", "必须是 READY 或 PARTIAL");
  const projectionState = board.projectionState;
  const filterOptions = record(board.filterOptions, "filterOptions");
  const assertUniqueStrings = (value: unknown, path: string, allowed?: ReadonlySet<string>) => {
    const items = array(value, path).map((item, index) => string(item, `${path}[${index}]`)!);
    if (new Set(items).size !== items.length || (allowed && items.some((item) => !allowed.has(item)))) {
      fail(path, "包含重复或不允许的筛选值");
    }
  };
  assertUniqueStrings(filterOptions.roomTypeCodes, "filterOptions.roomTypeCodes");
  assertUniqueStrings(filterOptions.salesModes, "filterOptions.salesModes", new Set(["WHOLE_ROOM", "BED_SPLIT", "UNAVAILABLE"]));
  assertUniqueStrings(filterOptions.statuses, "filterOptions.statuses", statuses);
  assertUniqueStrings(filterOptions.unitKinds, "filterOptions.unitKinds", new Set(["ROOM", "BED"]));
  const capacities = array(filterOptions.capacities, "filterOptions.capacities")
    .map((capacity, index) => integer(capacity, `filterOptions.capacities[${index}]`, 1));
  if (new Set(capacities).size !== capacities.length) fail("filterOptions.capacities", "不能包含重复人数");
  const page = record(board.page, "page");
  const pageIndex = integer(page.index, "page.index");
  const pageSize = integer(page.size, "page.size", 1);
  const totalRooms = integer(page.totalRooms, "page.totalRooms");
  const totalPages = integer(page.totalPages, "page.totalPages");
  if (pageIndex !== expected.pageIndex || pageSize > 200) fail("page", "与请求分页不一致");
  const expectedTotalPages = totalRooms === 0 ? 0 : Math.ceil(totalRooms / pageSize);
  if (totalPages !== expectedTotalPages) fail("page.totalPages", "与房间总数不一致");
  const operationalTasks = array(board.operationalTasks, "operationalTasks");
  operationalTasks.forEach((task, index) => assertOperationalTask(task, `operationalTasks[${index}]`, accessLevel, expected, businessDate));
  const taskIds = operationalTasks.map((task) => (task as RoomStatusOperationalTaskDto).id);
  if (new Set(taskIds).size !== taskIds.length) fail("operationalTasks", "包含重复任务 ID");
  assertAvailabilitySummary(board.availabilitySummary, "availabilitySummary", dates);
  const rooms = array(board.rooms, "rooms");
  const expectedRoomCount = Math.max(0, Math.min(pageSize, totalRooms - pageIndex * pageSize));
  if (rooms.length !== expectedRoomCount) fail("rooms", "与分页元数据不一致");
  rooms.forEach((room, index) => assertUnit(room, `rooms[${index}]`, accessLevel, projectionState, expected, dates, null, businessDate));
  const roomIds = rooms.map((room) => (room as RoomStatusUnitDto).id);
  if (new Set(roomIds).size !== roomIds.length) fail("rooms", "包含重复房间 ID");
}

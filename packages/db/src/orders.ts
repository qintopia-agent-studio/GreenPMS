import { sql, type Kysely, type Transaction } from "kysely";
import {
  currentReleaseFeatures,
  DomainError,
  orderActionCodes,
  type AccessLevel,
  type CoverageItemDto,
  type OrderArrangementDto,
  type OrderArrangementFundsSummaryDto,
  type OrderArrangementHistoryItemDto,
  type OrderArrangementIntervalDto,
  type OrderEffectiveArrangementDto,
  type OrderFulfillmentProjectionDto,
  type OrderFulfillmentRecordDto,
  type OrderAllowedActionDto,
  type OrderActionCode,
  type CommandCapability
} from "@qintopia/contracts";
import { amountSummary, enumerateServiceDates, newId, parseLocalDate, type CoverageCandidate } from "@qintopia/domain";
import {
  historicalProtocolEpochMigration,
  legacyEffectProtocol,
  type HistoricalProtocolVersion
} from "./historical-command-protocol.ts";
import type { DbExecutor } from "./inventory.ts";
import { propertyLocalClock, propertyLocalToday } from "./members.ts";
import type { Database } from "./schema.ts";

export interface OrderContext {
  order: Awaited<ReturnType<typeof selectOrder>>;
  stay: { id: string; status: string };
  currentSegment: {
    id: string;
    sequence: number;
    inventoryUnitId: string;
    arrivalDate: string;
    departureDate: string;
  };
  revision: {
    id: string;
    revisionNo: number;
    currentContractAmountMinor: number;
    currency: string;
  };
  segmentIds: string[];
}

export interface StayTimelineItem {
  serviceDate: string;
  inventoryUnitId: string;
}

export interface OrderMembershipConversion {
  amendmentId: string;
  membershipOrderId: string;
  memberId: string;
  contractId: string;
  entitlementLotId: string;
  commandId: string;
  allowedInventoryKind: "ROOM" | "BED";
  allowedRoomTypeCode: string;
  entitlementUnitKind: "ROOM_NIGHT" | "BED_NIGHT";
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function amendmentPayloadForRead(amendmentType: string, payload: unknown): unknown {
  const value = recordValue(payload);
  if (amendmentType !== "CREATE_ORDER" || !value || !Object.hasOwn(value, "confirmedEffect")) return payload;
  const { confirmedEffect: _confirmedEffect, ...publicPayload } = value;
  return publicPayload;
}

type HistoricalAmendmentProtocol = HistoricalProtocolVersion;
const externalChannelCodes = new Set(["YOUMUDAO", "CTRIP", "MEITUAN"]);

function externalChannelFundsDisabledReason(bookingChannelCode: string | null): string | null {
  return bookingChannelCode && externalChannelCodes.has(bookingChannelCode)
    ? "外部渠道订单不在 PMS 登记单笔收款或退款；请核对渠道订单号和本单渠道应结金额，由财务按渠道总账核对"
    : null;
}

function legacyAmendmentProtocol(amendmentType: string, payloadValue: unknown): HistoricalAmendmentProtocol | undefined {
  return legacyEffectProtocol(amendmentType, payloadValue);
}

export function pricingReasonFromAmendment(amendment: {
  amendment_type: string;
  reason_code: string;
  reason_note: string;
  payload: unknown;
  protocolVersion?: HistoricalAmendmentProtocol;
} | undefined): { code: string; note: string } {
  if (!amendment) return { code: "HISTORICAL", note: "" };
  if (["CREATE_ORDER", "RESCHEDULE_STAY", "EXTEND_STAY", "SHORTEN_STAY", "MOVE_UNIT", "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"].includes(amendment.amendment_type)) {
    const payload = recordValue(amendment.payload);
    const decision = recordValue(payload?.pricingDecision);
    const reason = recordValue(decision?.reason);
    if (typeof reason?.code === "string" && typeof reason.note === "string") {
      return { code: reason.code, note: reason.note };
    }
    // Pre-Stage 11 MOVE_UNIT facts used the amendment reason and had no
    // structured after/pricingDecision body. Keep those records readable,
    // while a damaged Stage 11 payload still fails closed.
    if (amendment.amendment_type === "MOVE_UNIT"
      && amendment.protocolVersion === "PRE_STAGE_11"
      && payload?.after === undefined) {
      return { code: amendment.reason_code, note: amendment.reason_note };
    }
    if (amendment.amendment_type !== "CREATE_ORDER") {
      throw new DomainError("INTERNAL_ERROR", "订单住宿日期变更的计价原因损坏", 500);
    }
  }
  return { code: amendment.reason_code, note: amendment.reason_note };
}

async function selectOrder(db: DbExecutor, orderId: string) {
  const row = await db.selectFrom("orders").selectAll().where("id", "=", orderId).executeTakeFirst();
  if (!row) throw new DomainError("NOT_FOUND", "Order not found", 404);
  return row;
}

export async function loadOrderContext(db: DbExecutor, orderId: string): Promise<OrderContext> {
  const order = await selectOrder(db, orderId);
  const stay = await db.selectFrom("stays").select(["id", "status"]).where("order_id", "=", orderId).executeTakeFirstOrThrow();
  const currentSegment = await db.selectFrom("stay_segments")
    .select(["id", "sequence", "inventory_unit_id", "arrival_date", "departure_date"])
    .where("stay_id", "=", stay.id).orderBy("sequence", "desc").executeTakeFirstOrThrow();
  if (!order.current_revision_id) throw new DomainError("INTERNAL_ERROR", "Order has no current pricing revision", 500);
  const revision = await db.selectFrom("pricing_revisions")
    .select(["id", "revision_no", "current_contract_amount_minor", "currency"])
    .where("id", "=", order.current_revision_id).executeTakeFirstOrThrow();
  const segments = await db.selectFrom("stay_segments").select("id").where("stay_id", "=", stay.id).orderBy("sequence").execute();
  return {
    order,
    stay,
    currentSegment: {
      id: currentSegment.id,
      sequence: currentSegment.sequence,
      inventoryUnitId: currentSegment.inventory_unit_id,
      arrivalDate: currentSegment.arrival_date,
      departureDate: currentSegment.departure_date
    },
    revision: {
      id: revision.id,
      revisionNo: revision.revision_no,
      currentContractAmountMinor: revision.current_contract_amount_minor,
      currency: revision.currency
    },
    segmentIds: segments.map((segment) => segment.id)
  };
}

export async function loadActiveStayTimeline(db: DbExecutor, context: OrderContext): Promise<StayTimelineItem[]> {
  const expectedDates = enumerateServiceDates(context.order.arrival_date, context.order.departure_date);
  const expectedDateSet = new Set(expectedDates);
  const claims = await db.selectFrom("inventory_claims")
    .select(["service_date", "inventory_unit_id", "id"])
    .where("source_type", "=", "ORDER_SEGMENT")
    .where("source_id", "in", context.segmentIds)
    .where("active", "=", true)
    .orderBy("service_date")
    .orderBy("id")
    .execute();
  const outsideInterval = claims.filter((claim) => !expectedDateSet.has(claim.service_date));
  if (outsideInterval.length > 0) {
    throw new DomainError("INTERNAL_ERROR", "Stay inventory timeline has active Claims outside the order interval", 500, false, {
      orderId: context.order.id,
      arrivalDate: context.order.arrival_date,
      departureDate: context.order.departure_date,
      activeClaimIds: outsideInterval.map((claim) => claim.id),
      serviceDates: outsideInterval.map((claim) => claim.service_date)
    });
  }
  const byDate = new Map<string, typeof claims>();
  for (const claim of claims) {
    const existing = byDate.get(claim.service_date) ?? [];
    existing.push(claim);
    byDate.set(claim.service_date, existing);
  }
  return expectedDates.map((serviceDate) => {
    const matches = byDate.get(serviceDate) ?? [];
    if (matches.length !== 1) {
      throw new DomainError("INTERNAL_ERROR", `Stay inventory timeline is invalid on ${serviceDate}`, 500, false, {
        orderId: context.order.id,
        serviceDate,
        activeClaimIds: matches.map((claim) => claim.id)
      });
    }
    return { serviceDate, inventoryUnitId: matches[0]!.inventory_unit_id };
  });
}

export async function loadOrderMembershipConversion(
  db: DbExecutor,
  context: OrderContext
): Promise<OrderMembershipConversion | null> {
  const amendments = await db.selectFrom("amendments")
    .select(["id", "command_id"])
    .where("order_id", "=", context.order.id)
    .where("amendment_type", "=", "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP")
    .orderBy("sequence")
    .execute();
  if (amendments.length === 0) return null;

  const amendment = amendments[0]!;
  if (amendments.length !== 1 || !amendment.command_id
    || !context.order.member_id || !context.order.member_contract_id) {
    throw new DomainError("INTERNAL_ERROR", "订单升级会员关联已损坏", 500, false, {
      orderId: context.order.id,
      conversionAmendmentIds: amendments.map((item) => item.id)
    });
  }

  const [linked, commandMembershipOrders] = await Promise.all([
    db.selectFrom("member_contracts as contract")
      .innerJoin("membership_orders as membership_order", "membership_order.id", "contract.membership_order_id")
      .innerJoin("entitlement_lots as lot", "lot.id", "membership_order.entitlement_lot_id")
      .innerJoin("command_executions as execution", "execution.id", "membership_order.created_by_command_id")
      .select([
        "contract.id as contract_id",
        "contract.property_id as contract_property_id",
        "contract.member_id as contract_member_id",
        "contract.membership_order_id as contract_membership_order_id",
        "membership_order.id as membership_order_id",
        "membership_order.property_id as membership_order_property_id",
        "membership_order.member_id as membership_order_member_id",
        "membership_order.contract_id as membership_order_contract_id",
        "membership_order.entitlement_lot_id as membership_order_entitlement_lot_id",
        "membership_order.created_by_command_id",
        "membership_order.activated_by_command_id",
        "membership_order.status as membership_order_status",
        "membership_order.allowed_inventory_kind",
        "membership_order.allowed_room_type_code",
        "membership_order.entitlement_unit_kind",
        "membership_order.entitlement_units",
        "lot.id as lot_id",
        "lot.contract_id as lot_contract_id",
        "lot.unit_kind as lot_unit_kind",
        "lot.total_units as lot_total_units",
        "execution.id as execution_id",
        "execution.property_id as execution_property_id",
        "execution.command_type as execution_command_type",
        "execution.state as execution_state"
      ])
      .where("contract.id", "=", context.order.member_contract_id)
      .executeTakeFirst(),
    db.selectFrom("membership_orders")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("created_by_command_id", "=", amendment.command_id)
      .where("activated_by_command_id", "=", amendment.command_id)
      .executeTakeFirstOrThrow()
  ]);

  if (!linked
    || Number(commandMembershipOrders.count) !== 1
    || linked.contract_id !== context.order.member_contract_id
    || linked.contract_property_id !== context.order.property_id
    || linked.contract_member_id !== context.order.member_id
    || linked.contract_membership_order_id !== linked.membership_order_id
    || linked.membership_order_property_id !== context.order.property_id
    || linked.membership_order_member_id !== context.order.member_id
    || linked.membership_order_contract_id !== linked.contract_id
    || linked.membership_order_entitlement_lot_id !== linked.lot_id
    || linked.membership_order_status !== "ACTIVE"
    || linked.created_by_command_id !== amendment.command_id
    || linked.activated_by_command_id !== amendment.command_id
    || linked.lot_contract_id !== linked.contract_id
    || linked.lot_unit_kind !== linked.entitlement_unit_kind
    || linked.lot_total_units !== linked.entitlement_units
    || linked.execution_id !== amendment.command_id
    || linked.execution_property_id !== context.order.property_id
    || linked.execution_command_type !== "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"
    || linked.execution_state !== "APPLIED") {
    throw new DomainError("INTERNAL_ERROR", "订单升级会员合同与权益关联已损坏", 500, false, {
      orderId: context.order.id,
      amendmentId: amendment.id,
      commandId: amendment.command_id
    });
  }

  return {
    amendmentId: amendment.id,
    membershipOrderId: linked.membership_order_id,
    memberId: linked.membership_order_member_id,
    contractId: linked.contract_id,
    entitlementLotId: linked.lot_id,
    commandId: amendment.command_id,
    allowedInventoryKind: linked.allowed_inventory_kind,
    allowedRoomTypeCode: linked.allowed_room_type_code,
    entitlementUnitKind: linked.entitlement_unit_kind
  };
}

export async function lockOrder(trx: Transaction<Database>, orderId: string): Promise<void> {
  const row = await trx.selectFrom("orders").select("id").where("id", "=", orderId).forUpdate().executeTakeFirst();
  if (!row) throw new DomainError("NOT_FOUND", "Order not found", 404);
}

export async function orderAmountSummary(db: DbExecutor, context: OrderContext) {
  const facts = await db.selectFrom("collection_facts").select("net_effect_minor").where("order_id", "=", context.order.id).execute();
  return amountSummary(context.revision.currency, context.revision.currentContractAmountMinor, facts.map((fact) => fact.net_effect_minor));
}

export function orderAllowedActions(
  accessLevel: AccessLevel,
  status: string,
  hasRefundableCollection: boolean,
  fulfillmentDates?: { businessDate: string; arrivalDate: string; departureDate: string; localTime?: string },
  hasFutureMove = false,
  bookingChannelCode: string | null = null,
  hasTransferableCollection = false,
  hasStayMembershipTransfer = false,
  completeStayFacts?: {
    stayStatus: string;
    hasCheckIn: boolean;
    hasCheckOut: boolean;
    hasCheckInRevocation: boolean;
  },
  commandGrants: ReadonlySet<CommandCapability | string> = new Set()
): OrderAllowedActionDto[] {
  if (accessLevel === "READ") return [];
  const enabledByStatus: Partial<Record<OrderActionCode, readonly string[]>> = {
    CORRECT_ORDER_OCCUPANT: ["RESERVED", "CHECKED_IN", "CHECKED_OUT", "CANCELLED", "NO_SHOW"],
    CHECK_IN: ["RESERVED"],
    CHECK_OUT: ["CHECKED_IN"],
    COMPLETE_STAY: ["RESERVED"],
    RESCHEDULE_STAY: ["RESERVED"],
    SHORTEN_STAY: ["CHECKED_IN"],
    EXTEND_STAY: ["CHECKED_IN"],
    MOVE_UNIT: ["RESERVED", "CHECKED_IN"],
    REPRICE_ORDER: ["RESERVED", "CHECKED_IN"],
    CANCEL_ORDER: ["RESERVED"],
    MARK_NO_SHOW: ["RESERVED"],
    REVOKE_CHECK_IN: ["CHECKED_IN"],
    RECORD_COLLECTION: ["RESERVED", "CHECKED_IN", "CHECKED_OUT"],
    RECORD_REFUND: ["RESERVED", "CHECKED_IN", "CHECKED_OUT", "CANCELLED", "NO_SHOW"],
    REVERSE_FACT: ["RESERVED", "CHECKED_IN", "CHECKED_OUT", "CANCELLED", "NO_SHOW"],
    CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP: ["CHECKED_IN", "CHECKED_OUT"]
  };
  return orderActionCodes
    .filter((code) => commandGrants.has(code))
    .map((code) => {
    const statusAllows = enabledByStatus[code]?.includes(status) ?? false;
    let fulfillmentDisabledReason: string | null = null;
    const externalFundsDisabledReason = code === "RECORD_COLLECTION" || code === "RECORD_REFUND"
      ? externalChannelFundsDisabledReason(bookingChannelCode)
      : null;
    const stayConversionChannelDisabledReason = code === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"
      ? bookingChannelCode && externalChannelCodes.has(bookingChannelCode)
        ? "外部渠道订单不从本订单升级会员；请核对渠道订单号和本单渠道应结金额，由财务按渠道总账核对"
        : bookingChannelCode !== "WECOM"
          ? "只有企业微信来源的普通住宿订单可以升级会员"
          : null
      : null;
    if (fulfillmentDates && statusAllows) {
      if (code === "CHECK_IN") {
        if (fulfillmentDates.businessDate < fulfillmentDates.arrivalDate) {
          fulfillmentDisabledReason = "ARRIVAL_DATE_NOT_REACHED";
        } else if (fulfillmentDates.businessDate >= fulfillmentDates.departureDate) {
          fulfillmentDisabledReason = "已到或超过计划退房日，不能补办入住";
        }
      } else if (code === "CHECK_OUT") {
        if (fulfillmentDates.businessDate < fulfillmentDates.departureDate) {
          fulfillmentDisabledReason = "DEPARTURE_DATE_NOT_REACHED";
        }
      } else if (code === "COMPLETE_STAY") {
        if (fulfillmentDates.businessDate < fulfillmentDates.departureDate) {
          fulfillmentDisabledReason = "未到计划退房日，请使用普通入住流程";
        }
      } else if (code === "SHORTEN_STAY") {
        if (fulfillmentDates.arrivalDate >= fulfillmentDates.businessDate) {
          fulfillmentDisabledReason = "入住当天暂不办理缩短或提前退房；未实际使用房间时请使用后续的撤销入住流程";
        } else if (fulfillmentDates.businessDate >= fulfillmentDates.departureDate) {
          fulfillmentDisabledReason = fulfillmentDates.businessDate === fulfillmentDates.departureDate
            ? "已到计划退房日，请使用普通退房"
            : "已超过计划退房日，请使用迟录退房";
        }
      } else if (code === "MOVE_UNIT") {
        if (status === "RESERVED" && fulfillmentDates.businessDate > fulfillmentDates.arrivalDate) {
          fulfillmentDisabledReason = "逾期未到订单暂不能换房，请先处理到店日期";
        } else if (status === "CHECKED_IN" && fulfillmentDates.businessDate >= fulfillmentDates.departureDate) {
          fulfillmentDisabledReason = "已到或超过计划退房日，请先办理续住或退房";
        }
      } else if (code === "MARK_NO_SHOW") {
        if (fulfillmentDates.businessDate < fulfillmentDates.arrivalDate
          || (fulfillmentDates.businessDate === fulfillmentDates.arrivalDate
            && (fulfillmentDates.localTime ?? "00:00") < "20:00")) {
          fulfillmentDisabledReason = "计划到店日 20:00 后才能标记未到";
        }
      } else if (code === "REVOKE_CHECK_IN" && fulfillmentDates.businessDate !== fulfillmentDates.arrivalDate) {
        fulfillmentDisabledReason = "只有计划入住当天可以撤销误办入住";
      }
    }
    const convertedOrderActionDisabled = hasStayMembershipTransfer
      && (code === "RECORD_COLLECTION"
        || code === "RECORD_REFUND"
        || code === "REVERSE_FACT"
        || code === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"
        || code === "REPRICE_ORDER"
        || code === "REVOKE_CHECK_IN");
    const completeStayFactsDisabled = code === "COMPLETE_STAY"
      && statusAllows
      && completeStayFacts !== undefined
      && (completeStayFacts.stayStatus !== "PLANNED"
        || completeStayFacts.hasCheckIn
        || completeStayFacts.hasCheckOut
        || completeStayFacts.hasCheckInRevocation);
    const enabled = statusAllows
      && fulfillmentDisabledReason === null
      && externalFundsDisabledReason === null
      && stayConversionChannelDisabledReason === null
      && !convertedOrderActionDisabled
      && !completeStayFactsDisabled
      && (code !== "RECORD_REFUND" || hasRefundableCollection)
      && (code !== "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP" || hasTransferableCollection);
    return {
      code,
      enabled,
      disabledReason: enabled
        ? null
        : fulfillmentDisabledReason ?? externalFundsDisabledReason ?? stayConversionChannelDisabledReason ?? (completeStayFactsDisabled
          ? "只有已预订且未办理入住的订单可以完成住宿"
          : convertedOrderActionDisabled
          ? code === "RECORD_COLLECTION" || code === "RECORD_REFUND" || code === "REVERSE_FACT" || code === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"
            ? "已完成升级会员，本订单不再追加住宿收退款；后续会员收款请在会员订单中处理"
            : "已升级会员的住宿订单不能使用普通住宿操作"
          : code === "RECORD_REFUND" && statusAllows
          ? "NO_REFUNDABLE_COLLECTION"
          : code === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"
          ? statusAllows ? "NO_TRANSFERABLE_COLLECTION" : "请在入住或退房完成后办理升级会员"
          : "ORDER_STATE_NOT_ALLOWED")
    };
    });
}

interface FulfillmentAmendmentRow {
  sequence: number;
  amendment_type: string;
  payload: unknown;
  reason_code: string;
  reason_note: string;
  actor_subject_id: string | null;
  actor_display_name: string | null;
  created_at: Date | string;
}

function fulfillmentPayload(amendment: FulfillmentAmendmentRow): Record<string, unknown> {
  if (!amendment.payload || typeof amendment.payload !== "object" || Array.isArray(amendment.payload)) {
    throw new DomainError("INTERNAL_ERROR", "履约记录的办理营业日期损坏", 500, false, {
      amendmentSequence: amendment.sequence,
      amendmentType: amendment.amendment_type
    });
  }
  return amendment.payload as Record<string, unknown>;
}

function validFulfillmentDate(value: unknown, amendment: FulfillmentAmendmentRow): string {
  if (typeof value !== "string") {
    throw new DomainError("INTERNAL_ERROR", "履约记录的办理营业日期损坏", 500, false, {
      amendmentSequence: amendment.sequence,
      amendmentType: amendment.amendment_type
    });
  }
  try {
    parseLocalDate(value);
  } catch {
    throw new DomainError("INTERNAL_ERROR", "履约记录的办理营业日期损坏", 500, false, {
      amendmentSequence: amendment.sequence,
      amendmentType: amendment.amendment_type
    });
  }
  return value;
}

function historicalRecordedBusinessDate(amendment: FulfillmentAmendmentRow, payload: Record<string, unknown>): string | null {
  if (!("businessDate" in payload) || payload.businessDate === undefined) return null;
  return validFulfillmentDate(payload.businessDate, amendment);
}

function recordedAt(amendment: FulfillmentAmendmentRow): string {
  const value = amendment.created_at instanceof Date ? amendment.created_at : new Date(amendment.created_at);
  if (Number.isNaN(value.getTime())) {
    throw new DomainError("INTERNAL_ERROR", "履约记录的记录时间损坏", 500, false, {
      amendmentSequence: amendment.sequence,
      amendmentType: amendment.amendment_type
    });
  }
  return value.toISOString();
}

function fulfillmentRecord(
  amendment: FulfillmentAmendmentRow | undefined,
  type: "CHECK_IN" | "CHECK_OUT" | "REVOKE_CHECK_IN",
  plannedBusinessDate: string
): OrderFulfillmentRecordDto | null {
  if (!amendment) return null;
  const payload = fulfillmentPayload(amendment);
  const hasImmutableTiming = "effectiveDate" in payload || "recordingMode" in payload;
  let effectiveDate = plannedBusinessDate;
  let recordedDate: string | null;
  let recordingMode: OrderFulfillmentRecordDto["recordingMode"];
  if (hasImmutableTiming) {
    if (!("effectiveDate" in payload) || !("recordingMode" in payload) || !("businessDate" in payload)) {
      throw new DomainError("INTERNAL_ERROR", "履约记录的办理营业日期损坏", 500, false, {
        amendmentSequence: amendment.sequence,
        amendmentType: amendment.amendment_type
      });
    }
    effectiveDate = validFulfillmentDate(payload.effectiveDate, amendment);
    recordedDate = validFulfillmentDate(payload.businessDate, amendment);
    if (payload.recordingMode !== "ON_SCHEDULE" && payload.recordingMode !== "LATE_RECORDED") {
      throw new DomainError("INTERNAL_ERROR", "履约记录的办理营业日期损坏", 500);
    }
    const timingMatches = type === "CHECK_IN"
      ? (payload.recordingMode === "ON_SCHEDULE" && recordedDate === effectiveDate)
        || (payload.recordingMode === "LATE_RECORDED" && recordedDate > effectiveDate)
      : type === "REVOKE_CHECK_IN"
        ? payload.recordingMode === "ON_SCHEDULE" && recordedDate === effectiveDate
      : payload.recordingMode === "ON_SCHEDULE"
        ? recordedDate === effectiveDate
        : recordedDate > effectiveDate;
    if (!timingMatches) throw new DomainError("INTERNAL_ERROR", "履约记录的办理营业日期损坏", 500);
    recordingMode = payload.recordingMode;
  } else {
    recordedDate = historicalRecordedBusinessDate(amendment, payload);
    recordingMode = recordedDate === plannedBusinessDate
      ? "ON_SCHEDULE"
      : type === "CHECK_OUT" && recordedDate !== null && recordedDate > plannedBusinessDate
        ? "LATE_RECORDED"
        : "LEGACY_UNCLASSIFIED";
  }
  const hasActorId = Boolean(amendment.actor_subject_id);
  const hasActorName = Boolean(amendment.actor_display_name);
  if (hasActorId !== hasActorName) throw new DomainError("INTERNAL_ERROR", "履约记录的操作人信息损坏", 500);
  return {
    type,
    plannedBusinessDate: effectiveDate,
    recordedBusinessDate: recordedDate,
    recordingMode,
    recordedAt: recordedAt(amendment),
    actor: amendment.actor_subject_id && amendment.actor_display_name
      ? { subjectId: amendment.actor_subject_id, displayName: amendment.actor_display_name }
      : null,
    reason: { code: amendment.reason_code, note: amendment.reason_note }
  };
}

export function projectOrderFulfillment(
  amendments: readonly FulfillmentAmendmentRow[],
  dates: { arrivalDate: string; departureDate: string }
): Omit<OrderFulfillmentProjectionDto, "state"> {
  parseLocalDate(dates.arrivalDate);
  parseLocalDate(dates.departureDate);
  const checkIns = amendments.filter((amendment) => amendment.amendment_type === "CHECK_IN");
  const checkOuts = amendments.filter((amendment) => amendment.amendment_type === "CHECK_OUT");
  const checkInRevocations = amendments.filter((amendment) => amendment.amendment_type === "REVOKE_CHECK_IN");
  if (checkIns.length > 1 || checkOuts.length > 1 || checkInRevocations.length > 1) {
    throw new DomainError("INTERNAL_ERROR", "订单履约记录存在重复状态事实", 500);
  }
  return {
    checkIn: fulfillmentRecord(checkIns[0], "CHECK_IN", dates.arrivalDate),
    checkOut: fulfillmentRecord(checkOuts[0], "CHECK_OUT", dates.departureDate),
    checkInRevocation: fulfillmentRecord(checkInRevocations[0], "REVOKE_CHECK_IN", dates.arrivalDate)
  };
}

interface LifecycleOrderRow {
  id: string;
  status: string;
  stay_type: string;
  arrival_date: string;
  departure_date: string;
  current_revision_id: string | null;
  version: number;
}

interface LifecycleStayRow {
  id: string;
  status: string;
}

interface LifecycleSegmentRow {
  id: string;
  stay_id: string;
  sequence: number;
  inventory_unit_id: string;
  arrival_date: string;
  departure_date: string;
  segment_type: string;
  supersedes_segment_id: string | null;
  amendment_id: string;
}

interface LifecycleAmendmentRow extends FulfillmentAmendmentRow {
  id: string;
  order_id: string;
  prior_version: number;
  new_version: number;
  protocolVersion?: HistoricalAmendmentProtocol;
}

interface LifecycleRevisionRow {
  id: string;
  order_id: string;
  revision_no: number;
  amendment_id: string;
  arrival_date: string;
  departure_date: string;
  policy_base_amount_minor: number;
  current_contract_amount_minor: number;
  currency: string;
}

interface LifecycleCollectionFactRow {
  order_id: string;
  net_effect_minor: number;
  currency: string;
  created_at: Date | string;
}

const orderLifecycleAmendmentTypes = new Set<string>([
  "CREATE_ORDER",
  "CORRECT_ORDER_OCCUPANT",
  "RESCHEDULE_STAY",
  "EXTEND_STAY",
  "SHORTEN_STAY",
  "MOVE_UNIT",
  "REPRICE_ORDER",
  "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
  "REFRESH_MEMBER_COVERAGE",
  "CANCEL_ORDER",
  "MARK_NO_SHOW",
  "REVOKE_CHECK_IN",
  "CHECK_IN",
  "CHECK_OUT"
] as const);

const pricingRevisionAmendmentTypes = new Set<string>([
  "CREATE_ORDER",
  "RESCHEDULE_STAY",
  "EXTEND_STAY",
  "SHORTEN_STAY",
  "MOVE_UNIT",
  "REPRICE_ORDER",
  "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
  "REFRESH_MEMBER_COVERAGE",
  "CANCEL_ORDER",
  "MARK_NO_SHOW",
  "REVOKE_CHECK_IN"
] as const);

const requiredPricingRevisionAmendmentTypes = new Set<string>([
  "CREATE_ORDER",
  "RESCHEDULE_STAY",
  "EXTEND_STAY",
  "SHORTEN_STAY",
  "MOVE_UNIT",
  "REPRICE_ORDER",
  "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
  "REFRESH_MEMBER_COVERAGE",
  "CANCEL_ORDER",
  "MARK_NO_SHOW",
  "REVOKE_CHECK_IN"
] as const);

const staySegmentAmendmentTypes = new Set<string>([
  "CREATE_ORDER",
  "RESCHEDULE_STAY",
  "EXTEND_STAY",
  "SHORTEN_STAY",
  "MOVE_UNIT"
] as const);

type LifecycleOrderStatus = "RESERVED" | "CHECKED_IN" | "CHECKED_OUT" | "CANCELLED" | "NO_SHOW" | "CHECK_IN_REVOKED";

export interface OrderLifecycleProjection {
  originalArrangement: OrderArrangementDto;
  effectiveArrangement: OrderEffectiveArrangementDto;
  fulfillment: OrderFulfillmentProjectionDto;
  arrangementHistory: OrderArrangementHistoryItemDto[];
}

function lifecycleFailure(message: string, details?: Record<string, unknown>): never {
  throw new DomainError("INTERNAL_ERROR", message, 500, false, details);
}

function lifecycleDate(value: unknown, field: string): string {
  if (typeof value !== "string") lifecycleFailure(`订单住宿生命周期的${field}损坏`);
  try {
    parseLocalDate(value);
  } catch {
    lifecycleFailure(`订单住宿生命周期的${field}损坏`);
  }
  return value;
}

function nextLifecycleDate(value: string): string {
  const date = parseLocalDate(value);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function lifecycleDateTime(value: Date | string, field: string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) lifecycleFailure(`订单住宿生命周期的${field}损坏`);
  return parsed.toISOString();
}

function arrangement(intervals: readonly OrderArrangementIntervalDto[]): OrderArrangementDto {
  if (intervals.length === 0) lifecycleFailure("订单住宿安排不能为空");
  const normalized: OrderArrangementIntervalDto[] = [];
  for (const interval of intervals) {
    const arrivalDate = lifecycleDate(interval.arrivalDate, "入住日期");
    const departureDate = lifecycleDate(interval.departureDate, "退房日期");
    if (departureDate <= arrivalDate) lifecycleFailure("订单住宿安排日期区间无效");
    if (!interval.inventoryUnitId) lifecycleFailure("订单住宿安排的房源缺失");
    const previous = normalized.at(-1);
    if (previous) {
      if (arrivalDate !== previous.departureDate) {
        lifecycleFailure(arrivalDate < previous.departureDate ? "订单住宿安排存在日期重叠" : "订单住宿安排存在日期空洞");
      }
      if (previous.inventoryUnitId === interval.inventoryUnitId) {
        previous.departureDate = departureDate;
        continue;
      }
    }
    normalized.push({ inventoryUnitId: interval.inventoryUnitId, arrivalDate, departureDate });
  }
  return {
    arrivalDate: normalized[0]!.arrivalDate,
    departureDate: normalized.at(-1)!.departureDate,
    intervals: normalized
  };
}

function overlayArrangement(
  before: OrderArrangementDto,
  replacement: OrderArrangementIntervalDto,
  changeType: "EXTEND_STAY" | "SHORTEN_STAY" | "MOVE"
): OrderArrangementDto {
  const replacementArrival = lifecycleDate(replacement.arrivalDate, "变更入住日期");
  const replacementDeparture = lifecycleDate(replacement.departureDate, "变更退房日期");
  if (replacementDeparture <= replacementArrival) lifecycleFailure("订单住宿变更日期区间无效");
  if (replacementArrival < before.arrivalDate || replacementArrival >= before.departureDate) {
    lifecycleFailure("订单住宿变更未从当前安排内开始");
  }
  if (changeType === "MOVE" && replacementDeparture !== before.departureDate) {
    lifecycleFailure("换房后的退房日期与变更前安排不一致");
  }
  if (changeType === "EXTEND_STAY" && replacementDeparture <= before.departureDate) {
    lifecycleFailure("续住没有延长当前住宿安排");
  }
  if (changeType === "SHORTEN_STAY" && replacementDeparture >= before.departureDate) {
    lifecycleFailure("缩短住宿没有缩短当前住宿安排");
  }
  const containing = before.intervals.find((interval) => (
    interval.arrivalDate <= replacementArrival && replacementArrival < interval.departureDate
  ));
  if (!containing) lifecycleFailure("订单住宿变更起点不属于变更前安排");
  const prefix = before.intervals.flatMap((interval): OrderArrangementIntervalDto[] => {
    if (interval.departureDate <= replacementArrival) return [{ ...interval }];
    if (interval.arrivalDate < replacementArrival) {
      return [{ ...interval, departureDate: replacementArrival }];
    }
    return [];
  });
  return arrangement([...prefix, {
    inventoryUnitId: replacement.inventoryUnitId,
    arrivalDate: replacementArrival,
    departureDate: replacementDeparture
  }]);
}

function arrangementTimeline(value: OrderArrangementDto): StayTimelineItem[] {
  return value.intervals.flatMap((interval) => enumerateServiceDates(interval.arrivalDate, interval.departureDate)
    .map((serviceDate) => ({ serviceDate, inventoryUnitId: interval.inventoryUnitId })));
}

function arrangementFromTimeline(timeline: readonly StayTimelineItem[]): OrderArrangementDto {
  if (timeline.length === 0) lifecycleFailure("订单住宿变更的 typed 时间线为空");
  const intervals: OrderArrangementIntervalDto[] = [];
  for (const [index, item] of timeline.entries()) {
    const serviceDate = lifecycleDate(item.serviceDate, "变更服务日期");
    const departureDate = nextLifecycleDate(serviceDate);
    const previous = timeline[index - 1];
    if (previous && nextLifecycleDate(previous.serviceDate) !== serviceDate) {
      lifecycleFailure("订单住宿变更的 typed 时间线不连续");
    }
    const current = intervals.at(-1);
    if (current?.inventoryUnitId === item.inventoryUnitId && current.departureDate === serviceDate) {
      current.departureDate = departureDate;
    } else {
      intervals.push({ inventoryUnitId: item.inventoryUnitId, arrivalDate: serviceDate, departureDate });
    }
  }
  return arrangement(intervals);
}

function payloadTimeline(amendment: LifecycleAmendmentRow): StayTimelineItem[] {
  const payload = recordValue(amendment.payload);
  if (!payload) lifecycleFailure("订单住宿变更的 typed payload 损坏", { amendmentId: amendment.id });
  let value: unknown;
  if (amendment.amendment_type === "MOVE_UNIT") {
    if (payload.after === undefined) {
      if (amendment.protocolVersion !== "PRE_STAGE_11") {
        lifecycleFailure("订单换房变更缺少当前协议时间线", { amendmentId: amendment.id });
      }
      value = payload.stayTimeline;
    }
    else {
      const after = recordValue(payload.after);
      value = after?.stayTimeline;
    }
  } else {
    const after = recordValue(payload.after);
    value = after?.stayTimeline;
  }
  if (!Array.isArray(value)) lifecycleFailure("订单住宿变更缺少 typed 时间线", { amendmentId: amendment.id });
  return value.map((item, index) => {
    const row = recordValue(item);
    if (!row || typeof row.inventoryUnitId !== "string") {
      lifecycleFailure("订单住宿变更的 typed 时间线损坏", { amendmentId: amendment.id, timelineIndex: index });
    }
    return {
      serviceDate: lifecycleDate(row.serviceDate, "变更服务日期"),
      inventoryUnitId: row.inventoryUnitId
    };
  });
}

function timelineMatches(left: readonly StayTimelineItem[], right: readonly StayTimelineItem[]): boolean {
  return left.length === right.length && left.every((item, index) => (
    item.serviceDate === right[index]?.serviceDate && item.inventoryUnitId === right[index]?.inventoryUnitId
  ));
}

function frozenShortenFundsSummary(
  amendment: LifecycleAmendmentRow,
  revision: LifecycleRevisionRow
): OrderArrangementFundsSummaryDto {
  const payload = recordValue(amendment.payload);
  const fundsSummary = recordValue(payload?.fundsSummary);
  const netRecordedCollection = recordValue(fundsSummary?.netRecordedCollection);
  const collectionDifference = recordValue(fundsSummary?.collectionDifference);
  const refundReferenceAmount = recordValue(payload?.refundReferenceAmount);
  const exactKeys = (value: Record<string, unknown> | undefined, expected: readonly string[]) => (
    value !== undefined
      && Object.keys(value).length === expected.length
      && expected.every((key) => Object.hasOwn(value, key))
  );
  const validMoney = (value: Record<string, unknown> | undefined) => (
    exactKeys(value, ["currency", "minorUnits"])
      && value?.currency === revision.currency
      && Number.isSafeInteger(value.minorUnits)
  );
  if (!exactKeys(fundsSummary, ["netRecordedCollection", "collectionDifference", "factCount"])
    || !validMoney(netRecordedCollection)
    || !validMoney(collectionDifference)
    || !validMoney(refundReferenceAmount)
    || !Number.isSafeInteger(fundsSummary?.factCount)
    || Number(fundsSummary?.factCount) < 0) {
    lifecycleFailure("缩短住宿记录的冻结资金摘要损坏", { amendmentId: amendment.id });
  }
  const frozenFundsSummary = fundsSummary!;
  const netMinor = netRecordedCollection!.minorUnits as number;
  const differenceMinor = collectionDifference!.minorUnits as number;
  const refundMinor = refundReferenceAmount!.minorUnits as number;
  if (differenceMinor !== revision.current_contract_amount_minor - netMinor
    || refundMinor < 0
    || refundMinor > 2_147_483_647
    || refundMinor !== Math.max(0, netMinor - revision.current_contract_amount_minor)) {
    lifecycleFailure("缩短住宿记录的冻结资金摘要与计价版本不一致", { amendmentId: amendment.id });
  }
  return {
    netRecordedCollection: { currency: revision.currency, minorUnits: netMinor },
    collectionDifference: { currency: revision.currency, minorUnits: differenceMinor },
    refundReferenceAmount: { currency: revision.currency, minorUnits: refundMinor },
    factCount: frozenFundsSummary.factCount as number
  };
}

function lifecycleActor(amendment: LifecycleAmendmentRow): { subjectId: string; displayName: string } | null {
  const hasId = Boolean(amendment.actor_subject_id);
  const hasName = Boolean(amendment.actor_display_name);
  if (hasId !== hasName) lifecycleFailure("订单住宿变更的操作人信息损坏", { amendmentId: amendment.id });
  return amendment.actor_subject_id && amendment.actor_display_name
    ? { subjectId: amendment.actor_subject_id, displayName: amendment.actor_display_name }
    : null;
}

function arrangementChangeType(amendment: LifecycleAmendmentRow): OrderArrangementHistoryItemDto["type"] {
  const amendmentType = amendment.amendment_type;
  if (amendmentType === "CREATE_ORDER") return "INITIAL_BOOKING";
  if (amendmentType === "RESCHEDULE_STAY") return "RESCHEDULE";
  if (amendmentType === "EXTEND_STAY") return "EXTENSION";
  if (amendmentType === "SHORTEN_STAY") {
    const payload = recordValue(amendment.payload);
    if (payload?.completionMode === "SHORTEN_IN_HOUSE") return "SHORTENING";
    if (payload?.completionMode === "EARLY_CHECK_OUT") return "EARLY_CHECK_OUT";
    return lifecycleFailure("缩短住宿记录的完成方式损坏", { amendmentId: amendment.id });
  }
  if (amendmentType === "MOVE_UNIT") return "MOVE";
  return lifecycleFailure("订单住宿安排包含无法识别的变更类型", { amendmentType });
}

function fulfillmentState(orderStatus: string): OrderFulfillmentProjectionDto["state"] {
  if (orderStatus === "RESERVED") return "NOT_CHECKED_IN";
  if (orderStatus === "CHECKED_IN") return "IN_HOUSE";
  if (orderStatus === "CHECKED_OUT") return "CHECKED_OUT";
  if (orderStatus === "CANCELLED") return "CANCELLED";
  if (orderStatus === "NO_SHOW") return "NO_SHOW";
  if (orderStatus === "CHECK_IN_REVOKED") return "CHECK_IN_REVOKED";
  return lifecycleFailure("订单住宿生命周期包含无法识别的订单状态", { orderStatus });
}

function effectivePresentation(orderStatus: string): OrderEffectiveArrangementDto["presentation"] {
  if (orderStatus === "RESERVED" || orderStatus === "CHECKED_IN") return "CURRENT";
  if (orderStatus === "CHECKED_OUT") return "LAST";
  if (orderStatus === "CANCELLED") return "BEFORE_CANCELLATION";
  if (orderStatus === "NO_SHOW") return "NO_SHOW_ORDER";
  if (orderStatus === "CHECK_IN_REVOKED") return "BEFORE_CHECK_IN_REVOCATION";
  return lifecycleFailure("订单住宿生命周期包含无法识别的订单状态", { orderStatus });
}

function validateLifecycleStatus(
  orderStatus: string,
  stayStatus: string,
  amendments: readonly LifecycleAmendmentRow[],
  fulfillment: Omit<OrderFulfillmentProjectionDto, "state">
): OrderFulfillmentProjectionDto["state"] {
  const expectedStayStatus: Record<LifecycleOrderStatus, string> = {
    RESERVED: "PLANNED",
    CHECKED_IN: "IN_HOUSE",
    CHECKED_OUT: "COMPLETED",
    CANCELLED: "CANCELLED",
    NO_SHOW: "NO_SHOW",
    CHECK_IN_REVOKED: "CHECK_IN_REVOKED"
  };
  if (!Object.hasOwn(expectedStayStatus, orderStatus)) {
    lifecycleFailure("订单住宿生命周期包含无法识别的订单状态", { orderStatus });
  }
  const finalStatus = orderStatus as LifecycleOrderStatus;
  if (expectedStayStatus[finalStatus] !== stayStatus) {
    lifecycleFailure("订单状态与住宿状态不一致", { orderStatus, stayStatus });
  }

  let projectedStatus: LifecycleOrderStatus | null = null;
  for (const [index, amendment] of amendments.entries()) {
    const amendmentType = amendment.amendment_type;
    if (!orderLifecycleAmendmentTypes.has(amendmentType)) {
      lifecycleFailure("订单住宿生命周期包含非订单变更类型", {
        amendmentId: amendment.id,
        amendmentType
      });
    }
    if (index === 0) {
      if (amendmentType !== "CREATE_ORDER") {
        lifecycleFailure("订单住宿生命周期必须从创建订单开始", { amendmentId: amendment.id, amendmentType });
      }
      projectedStatus = "RESERVED";
      continue;
    }
    if (amendmentType === "CREATE_ORDER") {
      lifecycleFailure("订单住宿生命周期重复创建订单", { amendmentId: amendment.id });
    }

    let transition: { from: LifecycleOrderStatus; to: LifecycleOrderStatus } | null = null;
    if (amendmentType === "CHECK_IN") transition = { from: "RESERVED", to: "CHECKED_IN" };
    else if (amendmentType === "CHECK_OUT") transition = { from: "CHECKED_IN", to: "CHECKED_OUT" };
    else if (amendmentType === "CANCEL_ORDER") transition = { from: "RESERVED", to: "CANCELLED" };
    else if (amendmentType === "MARK_NO_SHOW") transition = { from: "RESERVED", to: "NO_SHOW" };
    else if (amendmentType === "REVOKE_CHECK_IN") transition = { from: "CHECKED_IN", to: "CHECK_IN_REVOKED" };

    if (transition) {
      const payload = recordValue(amendment.payload);
      if (projectedStatus !== transition.from
        || payload?.fromStatus !== transition.from
        || payload?.toStatus !== transition.to) {
        lifecycleFailure("订单 typed 状态变更顺序或前后状态损坏", {
          amendmentId: amendment.id,
          amendmentType,
          projectedStatus,
          expectedFromStatus: transition.from,
          expectedToStatus: transition.to
        });
      }
      projectedStatus = transition.to;
      continue;
    }

    const terminalPricingOnlyAllowed = amendmentType === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"
      && projectedStatus === "CHECKED_OUT";
    if (amendmentType !== "CORRECT_ORDER_OCCUPANT"
      && !terminalPricingOnlyAllowed
      && projectedStatus !== "RESERVED"
      && projectedStatus !== "CHECKED_IN") {
      lifecycleFailure("终态订单包含不允许的住宿或计价变更", {
        amendmentId: amendment.id,
        amendmentType,
        projectedStatus
      });
    }
  }

  if (projectedStatus !== finalStatus) {
    lifecycleFailure("订单最终状态与 typed 状态变更链不一致", {
      orderStatus: finalStatus,
      projectedStatus
    });
  }
  const validFulfillment = finalStatus === "RESERVED" || finalStatus === "CANCELLED" || finalStatus === "NO_SHOW"
    ? !fulfillment.checkIn && !fulfillment.checkOut && !fulfillment.checkInRevocation
    : finalStatus === "CHECKED_IN"
      ? Boolean(fulfillment.checkIn) && !fulfillment.checkOut && !fulfillment.checkInRevocation
      : finalStatus === "CHECK_IN_REVOKED"
        ? Boolean(fulfillment.checkIn) && !fulfillment.checkOut && Boolean(fulfillment.checkInRevocation)
        : Boolean(fulfillment.checkIn) && Boolean(fulfillment.checkOut) && !fulfillment.checkInRevocation;
  if (!validFulfillment) lifecycleFailure("订单状态与 typed 履约事实不一致", { orderStatus: finalStatus });
  return fulfillmentState(finalStatus);
}

export function projectOrderLifecycle(input: {
  order: LifecycleOrderRow;
  stay: LifecycleStayRow;
  businessDate: string;
  segments: readonly LifecycleSegmentRow[];
  amendments: readonly LifecycleAmendmentRow[];
  revisions: readonly LifecycleRevisionRow[];
  facts: readonly LifecycleCollectionFactRow[];
  activeTimeline: readonly StayTimelineItem[];
}): OrderLifecycleProjection {
  lifecycleDate(input.businessDate, "营业日期");
  if (input.amendments.length !== input.order.version) lifecycleFailure("订单版本与不可变变更记录数量不一致");
  const amendmentIds = new Set<string>();
  let priorAmendmentCreatedAt: string | undefined;
  input.amendments.forEach((amendment, index) => {
    if (amendmentIds.has(amendment.id)) lifecycleFailure("订单变更记录 ID 重复", { amendmentId: amendment.id });
    amendmentIds.add(amendment.id);
    const expectedSequence = index + 1;
    if (amendment.order_id !== input.order.id
      || amendment.sequence !== expectedSequence
      || amendment.prior_version !== expectedSequence - 1
      || amendment.new_version !== expectedSequence
      || !orderLifecycleAmendmentTypes.has(amendment.amendment_type)) {
      lifecycleFailure("订单不可变变更记录链损坏", { amendmentId: amendment.id, expectedSequence });
    }
    lifecycleActor(amendment);
    const createdAt = lifecycleDateTime(amendment.created_at, "变更记录时间");
    if (priorAmendmentCreatedAt && createdAt < priorAmendmentCreatedAt) {
      lifecycleFailure("订单变更记录时间没有按 sequence 非递减", { amendmentId: amendment.id, expectedSequence });
    }
    priorAmendmentCreatedAt = createdAt;
  });
  if (input.segments.length === 0) lifecycleFailure("订单缺少原始预订安排");
  const amendmentById = new Map(input.amendments.map((amendment) => [amendment.id, amendment]));
  if (input.revisions.length === 0 || !input.order.current_revision_id) {
    lifecycleFailure("订单缺少当前计价版本");
  }
  const revisionIds = new Set<string>();
  const revisionAmendmentIds = new Set<string>();
  let priorRevisionAmendmentSequence = 0;
  let revisionCurrency: string | undefined;
  input.revisions.forEach((revision, index) => {
    const expectedRevisionNo = index + 1;
    const amendment = amendmentById.get(revision.amendment_id);
    if (revisionIds.has(revision.id)
      || revisionAmendmentIds.has(revision.amendment_id)
      || revision.order_id !== input.order.id
      || revision.revision_no !== expectedRevisionNo
      || !amendment
      || !pricingRevisionAmendmentTypes.has(amendment.amendment_type)
      || amendment.sequence <= priorRevisionAmendmentSequence) {
      lifecycleFailure("订单计价版本链损坏", {
        revisionId: revision.id,
        expectedRevisionNo,
        amendmentId: revision.amendment_id
      });
    }
    if (!Number.isSafeInteger(revision.policy_base_amount_minor)
      || !Number.isSafeInteger(revision.current_contract_amount_minor)
      || ((amendment.amendment_type === "CANCEL_ORDER"
        || amendment.amendment_type === "MARK_NO_SHOW"
        || amendment.amendment_type === "REVOKE_CHECK_IN")
        && (revision.policy_base_amount_minor !== 0 || revision.current_contract_amount_minor !== 0))
      || !revision.currency
      || (revisionCurrency !== undefined && revision.currency !== revisionCurrency)) {
      lifecycleFailure("订单计价版本金额或币种链损坏", { revisionId: revision.id });
    }
    revisionCurrency = revision.currency;
    revisionIds.add(revision.id);
    revisionAmendmentIds.add(revision.amendment_id);
    priorRevisionAmendmentSequence = amendment.sequence;
  });
  if (input.revisions.at(-1)!.id !== input.order.current_revision_id) {
    lifecycleFailure("订单当前计价版本指针与最新计价版本不一致", {
      currentRevisionId: input.order.current_revision_id,
      latestRevisionId: input.revisions.at(-1)!.id
    });
  }
  for (const amendment of input.amendments) {
    const matches = input.revisions.filter((revision) => revision.amendment_id === amendment.id);
    const requiresRevision = requiredPricingRevisionAmendmentTypes.has(amendment.amendment_type);
    if (requiresRevision && matches.length !== 1) {
      lifecycleFailure("订单计价变更没有唯一计价版本", {
        amendmentId: amendment.id,
        amendmentType: amendment.amendment_type
      });
    }
    if (!requiresRevision && matches.length !== 0) {
      lifecycleFailure("非计价变更不能包含计价版本", {
        amendmentId: amendment.id,
        amendmentType: amendment.amendment_type
      });
    }
  }
  const segmentAmendmentCounts = new Map<string, number>();
  for (const segment of input.segments) {
    const amendment = amendmentById.get(segment.amendment_id);
    if (!amendment || !staySegmentAmendmentTypes.has(amendment.amendment_type)) {
      lifecycleFailure("订单住宿安排引用了非住宿变更记录", {
        segmentId: segment.id,
        amendmentId: segment.amendment_id
      });
    }
    segmentAmendmentCounts.set(segment.amendment_id, (segmentAmendmentCounts.get(segment.amendment_id) ?? 0) + 1);
  }
  for (const amendment of input.amendments) {
    if (!staySegmentAmendmentTypes.has(amendment.amendment_type)) continue;
    if (segmentAmendmentCounts.get(amendment.id) !== 1) {
      lifecycleFailure("订单住宿变更没有唯一住宿安排版本", {
        amendmentId: amendment.id,
        amendmentType: amendment.amendment_type
      });
    }
  }
  const segmentIds = new Set<string>();
  let current: OrderArrangementDto | undefined;
  let original: OrderArrangementDto | undefined;
  let priorSegmentAmendmentSequence = 0;
  const history: OrderArrangementHistoryItemDto[] = [];
  const arrangementsByAmendmentSequence: Array<{ sequence: number; arrangement: OrderArrangementDto }> = [];

  for (const [index, segment] of input.segments.entries()) {
    const expectedSequence = index + 1;
    if (segmentIds.has(segment.id)) lifecycleFailure("订单住宿安排版本 ID 重复", { segmentId: segment.id });
    segmentIds.add(segment.id);
    if (segment.stay_id !== input.stay.id || segment.sequence !== expectedSequence) {
      lifecycleFailure("订单住宿安排版本链损坏", { segmentId: segment.id, expectedSequence });
    }
    const amendment = amendmentById.get(segment.amendment_id);
    if (!amendment || amendment.sequence <= priorSegmentAmendmentSequence) {
      lifecycleFailure("订单住宿安排没有按变更记录顺序形成", { segmentId: segment.id });
    }
    priorSegmentAmendmentSequence = amendment.sequence;
    let next: OrderArrangementDto;
    let before: OrderArrangementDto | null;
    if (index === 0) {
      if (segment.segment_type !== "INITIAL" || segment.supersedes_segment_id !== null || amendment.amendment_type !== "CREATE_ORDER") {
        lifecycleFailure("订单原始预订安排版本损坏", { segmentId: segment.id });
      }
      const payload = recordValue(amendment.payload);
      if (!payload
        || payload.inventoryUnitId !== segment.inventory_unit_id
        || payload.arrivalDate !== segment.arrival_date
        || payload.departureDate !== segment.departure_date) {
        lifecycleFailure("订单原始预订安排与 CREATE_ORDER 事实不一致", { segmentId: segment.id });
      }
      next = arrangement([{
        inventoryUnitId: segment.inventory_unit_id,
        arrivalDate: segment.arrival_date,
        departureDate: segment.departure_date
      }]);
      original = next;
      before = null;
    } else {
      const priorSegment = input.segments[index - 1]!;
      const expectedAmendment = segment.segment_type === "MOVE"
        ? "MOVE_UNIT"
        : segment.segment_type === "RESCHEDULE_STAY" || segment.segment_type === "EXTEND_STAY" || segment.segment_type === "SHORTEN_STAY"
          ? segment.segment_type
          : null;
      const overlayType = segment.segment_type === "MOVE" ? "MOVE" : segment.segment_type;
      if (!current || segment.supersedes_segment_id !== priorSegment.id || amendment.amendment_type !== expectedAmendment) {
        lifecycleFailure("订单住宿安排 supersession 链或变更类型损坏", { segmentId: segment.id });
      }
      before = current;
      next = segment.segment_type === "RESCHEDULE_STAY"
        ? arrangementFromTimeline(payloadTimeline(amendment))
        : overlayArrangement(current, {
          inventoryUnitId: segment.inventory_unit_id,
          arrivalDate: segment.arrival_date,
          departureDate: segment.departure_date
        }, overlayType as "EXTEND_STAY" | "SHORTEN_STAY" | "MOVE");
      const trailingInterval = next.intervals.at(-1)!;
      if (segment.segment_type === "RESCHEDULE_STAY"
        && (segment.inventory_unit_id !== trailingInterval.inventoryUnitId
          || segment.arrival_date !== trailingInterval.arrivalDate
          || segment.departure_date !== trailingInterval.departureDate)) {
        lifecycleFailure("改期住宿安排版本没有表达最终连续房源区间", { segmentId: segment.id });
      }
      if (!timelineMatches(payloadTimeline(amendment), arrangementTimeline(next))) {
        lifecycleFailure("订单住宿安排与 typed 变更时间线不一致", { amendmentId: amendment.id });
      }
    }
    const revisionMatches = input.revisions.filter((revision) => revision.amendment_id === amendment.id);
    if (revisionMatches.length !== 1) lifecycleFailure("订单住宿变更没有唯一计价摘要", { amendmentId: amendment.id });
    const revision = revisionMatches[0]!;
    if (revision.order_id !== input.order.id
      || revision.arrival_date !== next.arrivalDate
      || revision.departure_date !== next.departureDate
      || !Number.isSafeInteger(revision.policy_base_amount_minor)
      || !Number.isSafeInteger(revision.current_contract_amount_minor)
      || !revision.currency) {
      lifecycleFailure("订单住宿变更的计价摘要损坏", { amendmentId: amendment.id });
    }
    const recordedAt = lifecycleDateTime(amendment.created_at, "变更记录时间");
    const factsAtChange = input.facts.filter((fact) => {
      if (fact.order_id !== input.order.id || !Number.isSafeInteger(fact.net_effect_minor)) {
        lifecycleFailure("订单住宿变更的资金摘要损坏", { amendmentId: amendment.id });
      }
      return lifecycleDateTime(fact.created_at, "资金记录时间") <= recordedAt;
    });
    if (factsAtChange.some((fact) => fact.currency !== revision.currency)) {
      lifecycleFailure("订单住宿变更的资金币种与计价币种不一致", { amendmentId: amendment.id });
    }
    const fundsSummary: OrderArrangementFundsSummaryDto = amendment.amendment_type === "SHORTEN_STAY"
      ? frozenShortenFundsSummary(amendment, revision)
      : (() => {
        const netRecordedCollectionMinor = factsAtChange.reduce((sum, fact) => sum + fact.net_effect_minor, 0);
        if (!Number.isSafeInteger(netRecordedCollectionMinor)) lifecycleFailure("订单住宿变更的资金合计超出支持范围");
        return {
          netRecordedCollection: { currency: revision.currency, minorUnits: netRecordedCollectionMinor },
          collectionDifference: {
            currency: revision.currency,
            minorUnits: revision.current_contract_amount_minor - netRecordedCollectionMinor
          },
          refundReferenceAmount: {
            currency: revision.currency,
            minorUnits: Math.max(0, netRecordedCollectionMinor - revision.current_contract_amount_minor)
          },
          factCount: factsAtChange.length
        };
      })();
    history.push({
      type: arrangementChangeType(amendment),
      before,
      after: next,
      reason: { code: amendment.reason_code, note: amendment.reason_note },
      actor: lifecycleActor(amendment),
      recordedAt,
      pricingSummary: {
        policyBaseAmount: { currency: revision.currency, minorUnits: revision.policy_base_amount_minor },
        currentContractAmount: { currency: revision.currency, minorUnits: revision.current_contract_amount_minor },
        differenceFromPolicy: {
          currency: revision.currency,
          minorUnits: revision.current_contract_amount_minor - revision.policy_base_amount_minor
        }
      },
      fundsSummary
    });
    arrangementsByAmendmentSequence.push({ sequence: amendment.sequence, arrangement: next });
    current = next;
  }

  for (const revision of input.revisions) {
    const amendment = amendmentById.get(revision.amendment_id)!;
    const effectiveArrangement = arrangementsByAmendmentSequence
      .filter((entry) => entry.sequence <= amendment.sequence)
      .at(-1)?.arrangement;
    if (!effectiveArrangement
      || revision.arrival_date !== effectiveArrangement.arrivalDate
      || revision.departure_date !== effectiveArrangement.departureDate) {
      lifecycleFailure("订单计价版本与当时有效住宿安排不一致", {
        revisionId: revision.id,
        amendmentId: revision.amendment_id
      });
    }
  }

  if (!original || !current) lifecycleFailure("订单住宿生命周期投影为空");
  if (current.arrivalDate !== input.order.arrival_date || current.departureDate !== input.order.departure_date) {
    lifecycleFailure("订单当前日期与住宿安排版本链不一致");
  }
  const projectedTimeline = arrangementTimeline(current);
  const terminal = input.order.status === "CHECKED_OUT"
    || input.order.status === "CANCELLED"
    || input.order.status === "NO_SHOW"
    || input.order.status === "CHECK_IN_REVOKED";
  if (terminal ? input.activeTimeline.length !== 0 : !timelineMatches(projectedTimeline, input.activeTimeline)) {
    lifecycleFailure("订单有效 Claim 与住宿安排版本链不一致", { orderStatus: input.order.status });
  }
  const fulfillmentEvents = projectOrderFulfillment(input.amendments, {
    arrivalDate: current.arrivalDate,
    departureDate: current.departureDate
  });
  const state = validateLifecycleStatus(input.order.status, input.stay.status, input.amendments, fulfillmentEvents);
  return {
    originalArrangement: original,
    effectiveArrangement: {
      ...current,
      presentation: effectivePresentation(input.order.status),
      businessDate: input.businessDate
    },
    fulfillment: { state, ...fulfillmentEvents },
    arrangementHistory: history
  };
}

function hasRefundableCollection(facts: Array<{
  fact_id: string;
  fact_type: string;
  amount_minor: number;
  references_fact_id: string | null;
  reverses_fact_id: string | null;
}>): boolean {
  const reversed = new Set(facts.filter((fact) => fact.fact_type === "REVERSAL" && fact.reverses_fact_id)
    .map((fact) => fact.reverses_fact_id!));
  const activeRefunded = new Map<string, number>();
  for (const fact of facts) {
    if (fact.fact_type !== "REFUND" || !fact.references_fact_id || reversed.has(fact.fact_id)) continue;
    activeRefunded.set(fact.references_fact_id, (activeRefunded.get(fact.references_fact_id) ?? 0) + fact.amount_minor);
  }
  return facts.some((fact) => fact.fact_type === "COLLECTION"
    && !reversed.has(fact.fact_id)
    && (activeRefunded.get(fact.fact_id) ?? 0) < fact.amount_minor);
}

function hasTransferableCollection(facts: Array<{
  fact_id: string;
  fact_type: string;
  amount_minor: number;
  net_effect_minor: number;
  currency: string;
  references_fact_id: string | null;
  reverses_fact_id: string | null;
  method: string;
  transaction_reference: string | null;
}>, transfers: Array<{ source_collection_fact_id: string }>, orderCurrency: string): boolean {
  if (transfers.length > 0) return false;
  if (facts.length === 0) return true;
  if (facts.some((fact) => fact.fact_type !== "COLLECTION" && fact.fact_type !== "REFUND")) return false;
  const sourceCollections = facts.filter((fact) => fact.fact_type === "COLLECTION");
  const sourceCollectionIds = new Set(sourceCollections.map((fact) => fact.fact_id));
  if (sourceCollections.some((fact) => fact.amount_minor <= 0
    || fact.net_effect_minor !== fact.amount_minor
    || fact.currency !== orderCurrency
    || fact.method !== "WECOM"
    || !fact.transaction_reference
    || fact.references_fact_id !== null
    || fact.reverses_fact_id !== null)) return false;
  const refundedBySource = new Map<string, number>();
  for (const fact of facts) {
    if (fact.fact_type !== "REFUND") continue;
    if (fact.amount_minor <= 0
      || fact.net_effect_minor !== -fact.amount_minor
      || fact.currency !== orderCurrency
      || fact.method !== "WECOM"
      || fact.transaction_reference !== null
      || !fact.references_fact_id
      || fact.reverses_fact_id !== null
      || !sourceCollectionIds.has(fact.references_fact_id)) return false;
    refundedBySource.set(fact.references_fact_id, (refundedBySource.get(fact.references_fact_id) ?? 0) + fact.amount_minor);
  }
  const netResidual = sourceCollections.reduce((sum, fact) => sum + fact.amount_minor - (refundedBySource.get(fact.fact_id) ?? 0), 0);
  return Number.isSafeInteger(netResidual)
    && netResidual >= 0
    && sourceCollections.every((fact) => (refundedBySource.get(fact.fact_id) ?? 0) <= fact.amount_minor);
}

export async function getOrderViewSnapshot(
  db: DbExecutor,
  orderId: string,
  accessLevel: AccessLevel = "WRITE",
  commandGrants: ReadonlySet<CommandCapability | string> = new Set()
) {
  const context = await loadOrderContext(db, orderId);
  const [localClock, protocolEpochRows, occupantRows, correctionRows, segments, amendments, revisions, coverage, facts, transfers, cleaningTasks, membershipConversion] = await Promise.all([
    propertyLocalClock(db, context.order.property_id),
    db.selectFrom("schema_migrations").select(["name", "applied_at"])
      .where("name", "in", [
        "028_stage11_move_unit_guards.sql",
        "044_inhouse_membership_fulfillment_guards.sql"
      ]).execute(),
    db.selectFrom("order_occupants").selectAll().where("order_id", "=", orderId).orderBy("ordinal").execute(),
    db.selectFrom("order_occupant_corrections")
      .innerJoin("subjects", "subjects.id", "order_occupant_corrections.actor_subject_id")
      .selectAll("order_occupant_corrections")
      .select("subjects.display_name as actor_display_name")
      .where("order_occupant_corrections.order_id", "=", orderId)
      .orderBy("order_occupant_corrections.created_at")
      .orderBy("order_occupant_corrections.id")
      .execute(),
    db.selectFrom("stay_segments").selectAll().where("stay_id", "=", context.stay.id).orderBy("sequence").execute(),
    db.selectFrom("amendments")
      .leftJoin("command_executions", "command_executions.id", "amendments.command_id")
      .leftJoin("subjects", "subjects.id", "command_executions.subject_id")
      .selectAll("amendments")
      .select([
        "command_executions.subject_id as actor_subject_id",
        "subjects.display_name as actor_display_name"
      ])
      .where("amendments.order_id", "=", orderId)
      .orderBy("amendments.sequence")
      .execute(),
    db.selectFrom("pricing_revisions").selectAll().where("order_id", "=", orderId).orderBy("revision_no").execute(),
    db.selectFrom("coverage_items").selectAll().where("order_id", "=", orderId).orderBy("service_date").execute(),
    db.selectFrom("collection_facts").selectAll().where("order_id", "=", orderId).orderBy("created_at").orderBy("fact_id").execute(),
    db.selectFrom("stay_collection_membership_transfers")
      .innerJoin("membership_orders", "membership_orders.id", "stay_collection_membership_transfers.membership_order_id")
      .selectAll("stay_collection_membership_transfers")
      .select("membership_orders.member_id as membership_member_id")
      .where("stay_collection_membership_transfers.order_id", "=", orderId)
      .orderBy("stay_collection_membership_transfers.created_at")
      .orderBy("stay_collection_membership_transfers.id")
      .execute(),
    currentReleaseFeatures.cleaningWorkflow ? db.selectFrom("cleaning_tasks as task")
      .leftJoin("command_executions as created_command", "created_command.id", "task.created_by_command_id")
      .leftJoin("subjects as created_subject", "created_subject.id", "created_command.subject_id")
      .leftJoin("command_executions as completed_command", "completed_command.id", "task.completed_by_command_id")
      .leftJoin("subjects as completed_subject", "completed_subject.id", "completed_command.subject_id")
      .select([
        "task.id",
        "task.inventory_unit_id",
        "task.service_date",
        "task.status",
        "task.created_at",
        "task.completed_at",
        "created_command.subject_id as created_subject_id",
        "created_subject.display_name as created_subject_name",
        "completed_command.subject_id as completed_subject_id",
        "completed_subject.display_name as completed_subject_name"
      ])
      .where("task.order_id", "=", orderId)
      .orderBy("task.service_date")
      .orderBy("task.created_at")
      .execute() : Promise.resolve([]),
    loadOrderMembershipConversion(db, context)
  ]);
  const businessDate = localClock.date;
  const protocolEpochByMigration = new Map(protocolEpochRows.map((row) => [
    row.name,
    row.applied_at instanceof Date ? row.applied_at : new Date(row.applied_at)
  ]));
  const projectedAmendments: Array<(typeof amendments)[number] & {
    protocolVersion?: HistoricalAmendmentProtocol;
    recoveryMode?: "HISTORICAL_READ_ONLY";
  }> = amendments.map((amendment) => {
    const protocolVersion = legacyAmendmentProtocol(amendment.amendment_type, amendment.payload);
    if (!protocolVersion) return amendment;
    const migrationName = historicalProtocolEpochMigration(protocolVersion);
    const protocolEpoch = protocolEpochByMigration.get(migrationName);
    if (!protocolEpoch) {
      throw new DomainError("INTERNAL_ERROR", `Historical protocol epoch ${migrationName} is unavailable`, 500);
    }
    const createdAt = amendment.created_at instanceof Date ? amendment.created_at : new Date(amendment.created_at);
    if (createdAt.getTime() >= protocolEpoch.getTime()) {
      throw new DomainError("INTERNAL_ERROR", "订单变更在历史协议分界后仍使用旧数据形状", 500, false, {
        amendmentId: amendment.id,
        amendmentType: amendment.amendment_type,
        protocolVersion
      });
    }
    return { ...amendment, protocolVersion, recoveryMode: "HISTORICAL_READ_ONLY" as const };
  });
  const latestByOccupant = new Map<string, (typeof correctionRows)[number]>();
  const amendmentById = new Map(projectedAmendments.map((amendment) => [amendment.id, amendment]));
  for (const correction of correctionRows) {
    const current = latestByOccupant.get(correction.occupant_id);
    if (!current || correction.sequence > current.sequence) latestByOccupant.set(correction.occupant_id, correction);
  }
  const snapshot = (correction: (typeof correctionRows)[number], prefix: "prior" | "corrected") => ({
    fullName: correction[`${prefix}_full_name`],
    nickname: correction[`${prefix}_nickname`],
    phone: correction[`${prefix}_phone`],
    documentNumber: correction[`${prefix}_document_number`]
  });
  const transferByCollectionFactId = new Map(transfers.map((transfer) => [transfer.source_collection_fact_id, transfer]));
  const factsWithTransfer = facts.map((fact) => {
    const transfer = transferByCollectionFactId.get(fact.fact_id);
    return {
      ...fact,
      transfer: transfer ? {
        id: transfer.id,
        membershipOrderId: transfer.membership_order_id,
        memberId: transfer.membership_member_id,
        membershipPaymentFactId: transfer.membership_payment_fact_id,
        sourceReversalFactId: transfer.source_reversal_fact_id
      } : null
    };
  });
  const terminal = context.order.status === "CHECKED_OUT"
    || context.order.status === "CANCELLED"
    || context.order.status === "NO_SHOW"
    || context.order.status === "CHECK_IN_REVOKED";
  const activeTimeline = terminal
    ? await db.selectFrom("inventory_claims")
      .select(["service_date", "inventory_unit_id", "id"])
      .where("source_type", "=", "ORDER_SEGMENT")
      .where("source_id", "in", context.segmentIds)
      .where("active", "=", true)
      .orderBy("service_date")
      .orderBy("id")
      .execute()
      .then((claims) => claims.map((claim) => ({
        serviceDate: claim.service_date,
        inventoryUnitId: claim.inventory_unit_id
      })))
    : await loadActiveStayTimeline(db, context);
  const lifecycle = projectOrderLifecycle({
    order: context.order,
    stay: context.stay,
    businessDate,
    segments,
    amendments: projectedAmendments,
    revisions,
    facts,
    activeTimeline
  });
 return {
   accessLevel,
   allowedActions: orderAllowedActions(accessLevel, context.order.status, hasRefundableCollection(facts), {
     businessDate,
     arrivalDate: context.order.arrival_date,
     departureDate: context.order.departure_date,
     localTime: localClock.time
   }, lifecycle.effectiveArrangement.intervals.slice(1).some((interval) => interval.arrivalDate >= businessDate), context.order.booking_channel_code, hasTransferableCollection(facts, transfers, context.revision.currency), membershipConversion !== null, {
     stayStatus: context.stay.status,
     hasCheckIn: lifecycle.fulfillment.checkIn !== null,
     hasCheckOut: lifecycle.fulfillment.checkOut !== null,
     hasCheckInRevocation: lifecycle.fulfillment.checkInRevocation !== null
   }, commandGrants),
    order: {
      ...context.order,
      current_contract_amount_minor: context.revision.currentContractAmountMinor,
      currency: context.revision.currency
    },
    occupants: occupantRows.map((occupant) => {
      const correction = latestByOccupant.get(occupant.id);
      return {
        id: occupant.id,
        orderId: occupant.order_id,
        ordinal: occupant.ordinal,
        role: occupant.role,
        fullName: correction?.corrected_full_name ?? occupant.full_name,
        nickname: correction?.corrected_nickname ?? occupant.nickname,
        phone: correction ? correction.corrected_phone : occupant.phone,
        documentNumber: correction ? correction.corrected_document_number : occupant.document_number,
        createdAt: occupant.created_at instanceof Date ? occupant.created_at.toISOString() : new Date(occupant.created_at).toISOString()
      };
    }),
    occupantCorrections: correctionRows.map((correction) => ({
      id: correction.id,
      orderId: correction.order_id,
      occupantId: correction.occupant_id,
      sequence: correction.sequence,
      priorSnapshot: snapshot(correction, "prior"),
      correctedSnapshot: snapshot(correction, "corrected"),
      reason: { code: correction.reason_code, note: correction.reason_note },
      actor: { subjectId: correction.actor_subject_id, displayName: correction.actor_display_name },
      amendmentId: correction.amendment_id,
      commandId: correction.created_by_command_id,
      createdAt: correction.created_at instanceof Date ? correction.created_at.toISOString() : new Date(correction.created_at).toISOString()
    })),
    stay: context.stay,
    currentSegment: context.currentSegment,
    segments,
    originalArrangement: lifecycle.originalArrangement,
    effectiveArrangement: lifecycle.effectiveArrangement,
    fulfillment: lifecycle.fulfillment,
    arrangementHistory: lifecycle.arrangementHistory,
    amendments: projectedAmendments.map((amendment) => ({
      id: amendment.id,
      order_id: amendment.order_id,
      sequence: amendment.sequence,
      amendment_type: amendment.amendment_type,
      reason_code: amendment.reason_code,
      reason_note: amendment.reason_note,
      prior_version: amendment.prior_version,
      new_version: amendment.new_version,
      payload: amendmentPayloadForRead(amendment.amendment_type, amendment.payload),
      ...(amendment.protocolVersion
        ? { protocolVersion: amendment.protocolVersion, recoveryMode: "HISTORICAL_READ_ONLY" as const }
        : {}),
      command_id: amendment.command_id,
      actor: amendment.actor_subject_id && amendment.actor_display_name
        ? { subjectId: amendment.actor_subject_id, displayName: amendment.actor_display_name }
        : null,
      created_at: amendment.created_at
    })),
    pricingRevisions: revisions.map((revision) => ({
      ...revision,
      difference_from_policy_minor: revision.current_contract_amount_minor - revision.policy_base_amount_minor,
      reason: pricingReasonFromAmendment(amendmentById.get(revision.amendment_id))
    })),
    membershipConversion: membershipConversion ? {
      membershipOrderId: membershipConversion.membershipOrderId,
      memberId: membershipConversion.memberId,
      contractId: membershipConversion.contractId,
      entitlementLotId: membershipConversion.entitlementLotId,
      commandId: membershipConversion.commandId
    } : null,
    coverageSet: coverage,
    collectionFacts: factsWithTransfer,
    cleaningTasks: cleaningTasks.map((task) => ({
      id: task.id,
      inventoryUnitId: task.inventory_unit_id,
      serviceDate: task.service_date,
      status: task.status,
      createdAt: task.created_at instanceof Date ? task.created_at.toISOString() : new Date(task.created_at).toISOString(),
      completedAt: task.completed_at
        ? task.completed_at instanceof Date ? task.completed_at.toISOString() : new Date(task.completed_at).toISOString()
        : null,
      createdBy: task.created_subject_id && task.created_subject_name
        ? { subjectId: task.created_subject_id, displayName: task.created_subject_name }
        : null,
      completedBy: task.completed_subject_id && task.completed_subject_name
        ? { subjectId: task.completed_subject_id, displayName: task.completed_subject_name }
        : null
    })),
    amounts: await orderAmountSummary(db, context)
  };
}

export async function getOrderView(
  db: Kysely<Database>,
  orderId: string,
  accessLevel: AccessLevel = "WRITE",
  commandGrants: ReadonlySet<CommandCapability | string> = new Set()
) {
  return db.transaction().setIsolationLevel("repeatable read")
    .execute((trx) => getOrderViewSnapshot(trx, orderId, accessLevel, commandGrants));
}

export async function activeCoverageCandidates(db: DbExecutor, orderId: string, dates?: string[]): Promise<CoverageCandidate[]> {
  let query = db.selectFrom("coverage_items")
    .select(["service_date", "lot_id", "status", "inventory_unit_id", "unit_kind"])
    .where("order_id", "=", orderId)
    .where("status", "in", ["HELD", "CONSUMED"]);
  if (dates && dates.length > 0) query = query.where("service_date", "in", dates);
  const items = await query.orderBy("service_date").execute();
  return items.map((item) => ({
    serviceDate: item.service_date,
    entitlementLotId: item.lot_id,
    status: item.status as "HELD" | "CONSUMED",
    ...(item.status === "CONSUMED" ? {
      inventoryUnitId: item.inventory_unit_id,
      unitKind: item.unit_kind as "ROOM_NIGHT" | "BED_NIGHT"
    } : {})
  }));
}

export async function appendAmendment(trx: Transaction<Database>, options: {
  orderId: string;
  sequence: number;
  amendmentType: string;
  reasonCode: string;
  reasonNote: string;
  priorVersion: number;
  payload: Record<string, unknown>;
  commandId?: string;
}): Promise<string> {
  const id = newId("amend");
  await trx.insertInto("amendments").values({
    id,
    order_id: options.orderId,
    sequence: options.sequence,
    amendment_type: options.amendmentType,
    reason_code: options.reasonCode,
    reason_note: options.reasonNote,
    prior_version: options.priorVersion,
    new_version: options.priorVersion + 1,
    payload: options.payload,
    command_id: options.commandId ?? null,
    created_at: sql<Date>`greatest(
      transaction_timestamp(),
      coalesce(
        (select max(created_at) from amendments where order_id = ${options.orderId}),
        '-infinity'::timestamptz
      )
    )`
  }).execute();
  return id;
}

export async function holdCoverage(trx: Transaction<Database>, options: {
  orderId: string;
  contractId: string;
  memberId?: string;
  inventoryUnitId: string;
  revisionId: string;
  coverageSet: CoverageItemDto[];
  commandId: string;
}): Promise<{ coverageIds: string[]; factIds: string[] }> {
  const coverageIds: string[] = [];
  const factIds: string[] = [];
  for (const item of options.coverageSet) {
    const lotOwner = await trx.selectFrom("entitlement_lots")
      .innerJoin("member_contracts", "member_contracts.id", "entitlement_lots.contract_id")
      .select(["entitlement_lots.contract_id", "member_contracts.member_id"])
      .where("entitlement_lots.id", "=", item.entitlementLotId)
      .executeTakeFirst();
    if (!lotOwner || (options.memberId ? lotOwner.member_id !== options.memberId : lotOwner.contract_id !== options.contractId)) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "会员权益不属于本次住宿选择的会员", 409);
    }
    const coverageContractId = lotOwner.contract_id;
    const existing = await trx.selectFrom("coverage_items")
      .select(["id", "status", "contract_id", "lot_id", "unit_kind", "inventory_unit_id"])
      .where("order_id", "=", options.orderId)
      .where("service_date", "=", item.serviceDate)
      .where("status", "!=", "RELEASED")
      .executeTakeFirst();
    if (existing) {
      if (existing.contract_id !== coverageContractId
        || existing.lot_id !== item.entitlementLotId
        || existing.unit_kind !== item.unitKind
        || existing.inventory_unit_id !== item.inventoryUnitId) {
        throw new DomainError("ENTITLEMENT_CONFLICT", "Active coverage differs from the requested coverage", 409, false, {
          orderId: options.orderId,
          serviceDate: item.serviceDate,
          coverageId: existing.id
        });
      }
      coverageIds.push(existing.id);
      continue;
    }
    const coverageId = newId("coverage");
    await trx.insertInto("coverage_items").values({
      id: coverageId,
      order_id: options.orderId,
      contract_id: coverageContractId,
      lot_id: item.entitlementLotId,
      inventory_unit_id: item.inventoryUnitId,
      service_date: item.serviceDate,
      unit_kind: item.unitKind,
      status: "HELD",
      held_by_revision_id: options.revisionId
    }).execute();
    const factId = newId("fact");
    await trx.insertInto("entitlement_ledger").values({
      fact_id: factId,
      lot_id: item.entitlementLotId,
      entry_type: "HOLD",
      quantity_delta: -1,
      service_date: item.serviceDate,
      order_id: options.orderId,
      coverage_id: coverageId,
      reason: "ORDER_COVERAGE_HOLD",
      command_id: options.commandId
    }).execute();
    factIds.push(factId);
    coverageIds.push(coverageId);
  }
  return { coverageIds, factIds };
}

function coverageMatches(item: {
  contract_id: string;
  lot_id: string;
  inventory_unit_id: string;
  unit_kind: string;
}, desired: CoverageItemDto, contractId: string): boolean {
  return item.contract_id === contractId
    && item.lot_id === desired.entitlementLotId
    && item.inventory_unit_id === desired.inventoryUnitId
    && item.unit_kind === desired.unitKind;
}

export async function reconcileCoverage(trx: Transaction<Database>, options: {
  orderId: string;
  contractId: string;
  memberId?: string;
  revisionId: string;
  coverageSet: CoverageItemDto[];
  commandId: string;
}): Promise<{ coverageIds: string[]; factIds: string[] }> {
  const desiredByDate = new Map<string, { item: CoverageItemDto; contractId: string }>();
  for (const item of options.coverageSet) {
    if (desiredByDate.has(item.serviceDate)) {
      throw new DomainError("INTERNAL_ERROR", `Pricing produced duplicate coverage on ${item.serviceDate}`, 500);
    }
    const lotOwner = await trx.selectFrom("entitlement_lots")
      .innerJoin("member_contracts", "member_contracts.id", "entitlement_lots.contract_id")
      .select(["entitlement_lots.contract_id", "member_contracts.member_id"])
      .where("entitlement_lots.id", "=", item.entitlementLotId)
      .executeTakeFirst();
    if (!lotOwner || (options.memberId ? lotOwner.member_id !== options.memberId : lotOwner.contract_id !== options.contractId)) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "会员权益不属于本次住宿选择的会员", 409);
    }
    desiredByDate.set(item.serviceDate, { item, contractId: lotOwner.contract_id });
  }

  const active = await trx.selectFrom("coverage_items")
    .selectAll()
    .where("order_id", "=", options.orderId)
    .where("status", "!=", "RELEASED")
    .orderBy("service_date")
    .forUpdate()
    .execute();
  const existingLotIds = [...new Set(active.map((item) => item.lot_id))];
  const expirationRows = existingLotIds.length > 0
    ? await trx.selectFrom("entitlement_ledger")
      .select("lot_id")
      .distinct()
      .where("lot_id", "in", existingLotIds)
      .where("entry_type", "=", "EXPIRE")
      .execute()
    : [];
  const expiredLotIds = new Set(expirationRows.map((row) => row.lot_id));
  const changedLotIds = new Set<string>();
  const coverageIds: string[] = [];
  const factIds: string[] = [];

  for (const item of active) {
    const desired = desiredByDate.get(item.service_date);
    if (item.status === "CONSUMED") {
      if (desired && !coverageMatches(item, desired.item, desired.contractId)) {
        throw new DomainError("ENTITLEMENT_CONFLICT", "A pricing revision cannot rewrite consumed coverage", 409, false, {
          orderId: options.orderId,
          serviceDate: item.service_date,
          coverageId: item.id
        });
      }
      if (desired) desiredByDate.delete(item.service_date);
      coverageIds.push(item.id);
      continue;
    }
    if (desired && coverageMatches(item, desired.item, desired.contractId)) {
      desiredByDate.delete(item.service_date);
      coverageIds.push(item.id);
      continue;
    }

    await trx.updateTable("coverage_items")
      .set({ status: "RELEASED", updated_at: new Date() })
      .where("id", "=", item.id)
      .execute();
    coverageIds.push(item.id);
    const releaseFactId = newId("fact");
    await trx.insertInto("entitlement_ledger").values({
      fact_id: releaseFactId, lot_id: item.lot_id, entry_type: "RELEASE", quantity_delta: 1,
      service_date: item.service_date, order_id: options.orderId, coverage_id: item.id,
      reason: "ORDER_COVERAGE_RELEASE", command_id: options.commandId
    }).execute();
    factIds.push(releaseFactId);
    if (expiredLotIds.has(item.lot_id) && desired?.item.entitlementLotId !== item.lot_id) {
      const expirationFactId = newId("fact");
      await trx.insertInto("entitlement_ledger").values({
        fact_id: expirationFactId, lot_id: item.lot_id, entry_type: "EXPIRE", quantity_delta: -1,
        service_date: item.service_date, order_id: options.orderId, coverage_id: item.id,
        reason: "RELEASE_AFTER_EXPIRY", command_id: options.commandId
      }).execute();
      factIds.push(expirationFactId);
    }
    changedLotIds.add(item.lot_id);
  }

  for (const desired of desiredByDate.values()) {
    const { item, contractId } = desired;
    const coverageId = newId("coverage");
    await trx.insertInto("coverage_items").values({
      id: coverageId,
      order_id: options.orderId,
      contract_id: contractId,
      lot_id: item.entitlementLotId,
      inventory_unit_id: item.inventoryUnitId,
      service_date: item.serviceDate,
      unit_kind: item.unitKind,
      status: "HELD",
      held_by_revision_id: options.revisionId
    }).execute();
    const holdFactId = newId("fact");
    await trx.insertInto("entitlement_ledger").values({
      fact_id: holdFactId,
      lot_id: item.entitlementLotId,
      entry_type: "HOLD",
      quantity_delta: -1,
      service_date: item.serviceDate,
      order_id: options.orderId,
      coverage_id: coverageId,
      reason: "ORDER_COVERAGE_HOLD",
      command_id: options.commandId
    }).execute();
    factIds.push(holdFactId);
    changedLotIds.add(item.entitlementLotId);
    coverageIds.push(coverageId);
  }

  if (changedLotIds.size > 0) {
    const changedLots = await trx.selectFrom("entitlement_lots").select(["id", "contract_id"])
      .where("id", "in", [...changedLotIds]).execute();
    for (const contractId of new Set(changedLots.map((row) => row.contract_id))) {
      await incrementContractAndLotVersions(trx, contractId, changedLots.filter((row) => row.contract_id === contractId).map((row) => row.id));
    }
  }
  return { coverageIds, factIds };
}

export async function releaseCoverage(trx: Transaction<Database>, orderId: string, commandId: string, options: {
  fromDate?: string;
  incompatibleUnitKind?: string;
  reholdCoverageSet?: CoverageItemDto[];
} = {}): Promise<{ coverageIds: string[]; factIds: string[] }> {
  let query = trx.selectFrom("coverage_items").selectAll().where("order_id", "=", orderId).where("status", "=", "HELD");
  if (options.fromDate) query = query.where("service_date", ">=", options.fromDate);
  if (options.incompatibleUnitKind) query = query.where("unit_kind", "!=", options.incompatibleUnitKind);
  const items = await query.forUpdate().execute();
  const lotIds = [...new Set(items.map((item) => item.lot_id))];
  const expirationRows = lotIds.length > 0 ? await trx.selectFrom("entitlement_ledger")
    .select("lot_id").distinct().where("lot_id", "in", lotIds).where("entry_type", "=", "EXPIRE").execute() : [];
  const expiredLotIds = new Set(expirationRows.map((row) => row.lot_id));
  const reholdKeys = new Set((options.reholdCoverageSet ?? []).map((item) => `${item.serviceDate}:${item.entitlementLotId}`));
  const factIds: string[] = [];
  for (const item of items) {
    await trx.updateTable("coverage_items").set({ status: "RELEASED", updated_at: new Date() }).where("id", "=", item.id).execute();
    const releaseFactId = newId("fact");
    await trx.insertInto("entitlement_ledger").values({
      fact_id: releaseFactId, lot_id: item.lot_id, entry_type: "RELEASE", quantity_delta: 1,
      service_date: item.service_date, order_id: orderId, coverage_id: item.id,
      reason: "ORDER_COVERAGE_RELEASE", command_id: commandId
    }).execute();
    factIds.push(releaseFactId);
    if (expiredLotIds.has(item.lot_id) && !reholdKeys.has(`${item.service_date}:${item.lot_id}`)) {
      const expirationFactId = newId("fact");
      await trx.insertInto("entitlement_ledger").values({
        fact_id: expirationFactId, lot_id: item.lot_id, entry_type: "EXPIRE", quantity_delta: -1,
        service_date: item.service_date, order_id: orderId, coverage_id: item.id,
        reason: "RELEASE_AFTER_EXPIRY", command_id: commandId
      }).execute();
      factIds.push(expirationFactId);
    }
  }
  for (const contractId of new Set(items.map((item) => item.contract_id))) {
    await incrementContractAndLotVersions(trx, contractId, [...new Set(items.filter((item) => item.contract_id === contractId).map((item) => item.lot_id))]);
  }
  return { coverageIds: items.map((item) => item.id), factIds };
}

export async function consumeCoverage(trx: Transaction<Database>, orderId: string, commandId: string, options: {
  serviceDates?: string[];
  reason?: "CHECK_IN_ENTITLEMENT_CONSUMED" | "EXTEND_STAY_ENTITLEMENT_CONSUMED";
} = {}): Promise<{ coverageIds: string[]; factIds: string[] }> {
  let requestedServiceDates: string[] | undefined;
  let query = trx.selectFrom("coverage_items")
    .selectAll()
    .where("order_id", "=", orderId)
    .where("status", "=", "HELD");
  if (options.serviceDates) {
    requestedServiceDates = [...new Set(options.serviceDates)].sort();
    if (requestedServiceDates.length === 0) return { coverageIds: [], factIds: [] };
    query = query.where("service_date", "in", requestedServiceDates);
  }
  const items = await query.orderBy("service_date").forUpdate().execute();
  if (requestedServiceDates
    && (items.length !== requestedServiceDates.length
      || items.some((item, index) => item.service_date !== requestedServiceDates![index]))) {
    throw new DomainError("INTERNAL_ERROR", "续住新增权益与待核销日期不一致", 500, false, {
      orderId,
      requestedServiceDates,
      heldServiceDates: items.map((item) => item.service_date)
    });
  }
  const factIds: string[] = [];
  for (const item of items) {
    await trx.updateTable("coverage_items").set({ status: "CONSUMED", updated_at: new Date() }).where("id", "=", item.id).execute();
    const factId = newId("fact");
    await trx.insertInto("entitlement_ledger").values({
      fact_id: factId, lot_id: item.lot_id, entry_type: "CONSUME", quantity_delta: 0,
      service_date: item.service_date, order_id: orderId, coverage_id: item.id,
      reason: options.reason ?? "CHECK_IN_ENTITLEMENT_CONSUMED", command_id: commandId
    }).execute();
    factIds.push(factId);
  }
  for (const contractId of new Set(items.map((item) => item.contract_id))) {
    await incrementContractAndLotVersions(trx, contractId, [...new Set(items.filter((item) => item.contract_id === contractId).map((item) => item.lot_id))]);
  }
  return { coverageIds: items.map((item) => item.id), factIds };
}

export async function restoreConsumedCoverage(
  trx: Transaction<Database>,
  orderId: string,
  commandId: string
): Promise<{ coverageIds: string[]; factIds: string[] }> {
  const items = await trx.selectFrom("coverage_items")
    .selectAll()
    .where("order_id", "=", orderId)
    .where("status", "=", "CONSUMED")
    .orderBy("service_date")
    .forUpdate()
    .execute();
  if (items.length === 0) return { coverageIds: [], factIds: [] };

  const coverageIds = items.map((item) => item.id);
  const existingFacts = await trx.selectFrom("entitlement_ledger")
    .select(["coverage_id", "entry_type"])
    .where("coverage_id", "in", coverageIds)
    .where("entry_type", "in", ["CONSUME", "RESTORE"])
    .execute();
  const consumedIds = new Set(existingFacts.filter((fact) => fact.entry_type === "CONSUME").map((fact) => fact.coverage_id));
  const restoredIds = new Set(existingFacts.filter((fact) => fact.entry_type === "RESTORE").map((fact) => fact.coverage_id));
  if (items.some((item) => !consumedIds.has(item.id) || restoredIds.has(item.id))) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "会员权益核销历史不能安全补偿", 409, false, {
      orderId,
      coverageIds
    });
  }

  const factIds: string[] = [];
  for (const item of items) {
    const factId = newId("fact");
    await trx.insertInto("entitlement_ledger").values({
      fact_id: factId,
      lot_id: item.lot_id,
      entry_type: "RESTORE",
      quantity_delta: 1,
      service_date: item.service_date,
      order_id: orderId,
      coverage_id: item.id,
      reason: "REVOKE_CHECK_IN_ENTITLEMENT_RESTORED",
      command_id: commandId
    }).execute();
    factIds.push(factId);
  }
  for (const contractId of new Set(items.map((item) => item.contract_id))) {
    await incrementContractAndLotVersions(
      trx,
      contractId,
      [...new Set(items.filter((item) => item.contract_id === contractId).map((item) => item.lot_id))]
    );
  }
  return { coverageIds, factIds };
}

export async function restoreFutureConsumedCoverage(
  trx: Transaction<Database>,
  orderId: string,
  commandId: string,
  serviceDates: string[]
): Promise<{ coverageIds: string[]; factIds: string[] }> {
  const requestedDates = [...new Set(serviceDates)].sort();
  if (requestedDates.length === 0) return { coverageIds: [], factIds: [] };

  const items = await trx.selectFrom("coverage_items")
    .selectAll()
    .where("order_id", "=", orderId)
    .where("service_date", "in", requestedDates)
    .where("status", "=", "CONSUMED")
    .orderBy("service_date")
    .forUpdate()
    .execute();
  if (items.length !== requestedDates.length
    || items.some((item, index) => item.service_date !== requestedDates[index])) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "缩短住宿的未来已核销权益与核对结果不一致", 409, false, {
      orderId,
      requestedDates,
      consumedDates: items.map((item) => item.service_date)
    });
  }

  const coverageIds = items.map((item) => item.id);
  const existingFacts = await trx.selectFrom("entitlement_ledger")
    .select(["coverage_id", "entry_type"])
    .where("coverage_id", "in", coverageIds)
    .where("entry_type", "in", ["CONSUME", "CONVERSION_CONSUME", "RESTORE"])
    .execute();
  const consumptionCountByCoverage = new Map<string, number>();
  const restoredIds = new Set<string>();
  for (const fact of existingFacts) {
    if (!fact.coverage_id) continue;
    if (fact.entry_type === "RESTORE") {
      restoredIds.add(fact.coverage_id);
    } else {
      consumptionCountByCoverage.set(
        fact.coverage_id,
        (consumptionCountByCoverage.get(fact.coverage_id) ?? 0) + 1
      );
    }
  }
  if (items.some((item) => consumptionCountByCoverage.get(item.id) !== 1 || restoredIds.has(item.id))) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "缩短住宿的会员权益核销历史不能安全返还", 409, false, {
      orderId,
      coverageIds
    });
  }

  const factIds: string[] = [];
  for (const item of items) {
    const factId = newId("fact");
    await trx.insertInto("entitlement_ledger").values({
      fact_id: factId,
      lot_id: item.lot_id,
      entry_type: "RESTORE",
      quantity_delta: 1,
      service_date: item.service_date,
      order_id: orderId,
      coverage_id: item.id,
      reason: "SHORTEN_STAY_FUTURE_ENTITLEMENT_RESTORED",
      command_id: commandId
    }).execute();
    await trx.updateTable("coverage_items")
      .set({ status: "RELEASED", updated_at: new Date() })
      .where("id", "=", item.id)
      .where("status", "=", "CONSUMED")
      .executeTakeFirstOrThrow();
    factIds.push(factId);
  }
  for (const contractId of new Set(items.map((item) => item.contract_id))) {
    await incrementContractAndLotVersions(
      trx,
      contractId,
      [...new Set(items.filter((item) => item.contract_id === contractId).map((item) => item.lot_id))]
    );
  }
  return { coverageIds, factIds };
}

export async function incrementContractAndLotVersions(trx: Transaction<Database>, contractId: string, lotIds: string[]): Promise<void> {
  await trx.updateTable("member_contracts").set({ version: sql`version + 1` }).where("id", "=", contractId).execute();
  if (lotIds.length > 0) await trx.updateTable("entitlement_lots").set({ version: sql`version + 1` }).where("id", "in", lotIds).execute();
}

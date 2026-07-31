import { parseLocalDate } from "@qintopia/domain";

export type HistoricalProtocolVersion = "LEGACY_STAGE_9_10" | "LEGACY_STAGE_10" | "PRE_STAGE_11";

const MAX_IDENTIFIER_LENGTH = 255;
const MAX_TEXT_LENGTH = 1_000;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const RFC3339_DATE_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;
const pricingBases = new Set(["POLICY", "CHANNEL_CONTRACT", "MANUAL_ADJUSTMENT", "MEMBER_ENTITLEMENT", "FREE"]);
const entitlementKinds = new Set(["ROOM_NIGHT", "BED_NIGHT"]);
const inventoryKinds = new Set(["ROOM", "BED"]);
const inventoryBases = new Set(["INDEPENDENT", "WHOLE_ROOM_COMBINATION"]);
const codeProvenance = new Set(["SOURCE_EXPLICIT", "USER_CONFIRMED_RENAMED", "PMS_GENERATED"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_IDENTIFIER_LENGTH;
}

function text(value: unknown, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= MAX_TEXT_LENGTH && (allowEmpty || value.trim().length > 0);
}

function safeInteger(value: unknown, min = -2_147_483_648, max = 2_147_483_647): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

function localDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    parseLocalDate(value);
    return true;
  } catch {
    return false;
  }
}

function dateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = RFC3339_DATE_TIME.exec(value);
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return false;
  if (!localDate(match[1])) return false;
  return Number.isFinite(Date.parse(value));
}

function money(value: unknown, options: { nonNegative?: boolean } = {}): boolean {
  const item = record(value);
  return !!item
    && exactKeys(item, ["currency", "minorUnits"])
    && typeof item.currency === "string"
    && CURRENCY_CODE.test(item.currency)
    && safeInteger(item.minorUnits, options.nonNegative ? 0 : -2_147_483_648);
}

function expectedDates(arrivalDate: string, departureDate: string): string[] | undefined {
  try {
    const arrival = parseLocalDate(arrivalDate).getTime();
    const departure = parseLocalDate(departureDate).getTime();
    if (departure <= arrival || departure - arrival > 366 * 86_400_000) return undefined;
    return Array.from({ length: (departure - arrival) / 86_400_000 }, (_, index) =>
      new Date(arrival + index * 86_400_000).toISOString().slice(0, 10));
  } catch {
    return undefined;
  }
}

function timeline(value: unknown, expected?: string[]): boolean {
  return Array.isArray(value) && value.length > 0 && value.every((entry, index) => {
    const item = record(entry);
    return !!item
      && exactKeys(item, ["serviceDate", "inventoryUnitId"])
      && localDate(item.serviceDate)
      && identifier(item.inventoryUnitId)
      && (expected === undefined || item.serviceDate === expected[index]);
  }) && (expected === undefined || value.length === expected.length);
}

function dateArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every(localDate)
    && new Set(value).size === value.length;
}

function coverageSet(value: unknown, timelineDates?: Set<string>): boolean {
  return Array.isArray(value) && value.every((entry) => {
    const item = record(entry);
    return !!item
      && exactKeys(item, ["serviceDate", "inventoryUnitId", "unitKind", "entitlementLotId"])
      && localDate(item.serviceDate)
      && (!timelineDates || timelineDates.has(item.serviceDate))
      && identifier(item.inventoryUnitId)
      && typeof item.unitKind === "string" && entitlementKinds.has(item.unitKind)
      && identifier(item.entitlementLotId);
  }) && new Set(value.map((entry) => (entry as Record<string, unknown>).serviceDate)).size === value.length;
}

function nightlyCashLine(value: Record<string, unknown>, timelineDates?: Set<string>): boolean {
  return exactKeys(value, ["serviceDate", "inventoryUnitId", "description", "amount"], ["lineKind"])
    && (!Object.hasOwn(value, "lineKind") || value.lineKind === "NIGHT")
    && localDate(value.serviceDate)
    && (!timelineDates || timelineDates.has(value.serviceDate))
    && identifier(value.inventoryUnitId)
    && text(value.description)
    && money(value.amount, { nonNegative: true });
}

function stayTotalCashLine(value: Record<string, unknown>, timelineByDate?: Map<string, string>): boolean {
  if (!exactKeys(value, [
    "lineKind", "arrivalDate", "departureDate", "inventoryUnitId", "description", "pricingBandAnchorNights", "calculationSegments", "amount"
  ]) || value.lineKind !== "STAY_TOTAL" || !localDate(value.arrivalDate) || !localDate(value.departureDate)
    || !identifier(value.inventoryUnitId) || !text(value.description)
    || ![1, 7, 14, 30].includes(value.pricingBandAnchorNights as number)
    || !money(value.amount, { nonNegative: true }) || !Array.isArray(value.calculationSegments) || value.calculationSegments.length === 0) return false;
  const allDates = expectedDates(value.arrivalDate, value.departureDate);
  if (!allDates
    || (timelineByDate && (allDates.length !== timelineByDate.size
      || allDates.some((date) => !timelineByDate.has(date))
      || timelineByDate.get(allDates[0]!) !== value.inventoryUnitId))) return false;
  let nextSegmentArrival = value.arrivalDate;
  let totalNumerator = 0n;
  for (const entry of value.calculationSegments) {
    const segment = record(entry);
    if (!segment || !exactKeys(segment, [
      "inventoryUnitId", "pricingProductCode", "arrivalDate", "departureDate", "nights", "anchorAmountMinor", "numeratorMinor", "denominator"
    ]) || !identifier(segment.inventoryUnitId) || !identifier(segment.pricingProductCode)
      || !localDate(segment.arrivalDate) || !localDate(segment.departureDate)
      || segment.arrivalDate !== nextSegmentArrival
      || !safeInteger(segment.nights, 1, 366) || !safeInteger(segment.anchorAmountMinor, 1)
      || !safeInteger(segment.numeratorMinor, 1) || segment.denominator !== value.pricingBandAnchorNights) return false;
    const dates = expectedDates(segment.arrivalDate, segment.departureDate);
    if (!dates || dates.length !== segment.nights
      || (timelineByDate && dates.some((date) => timelineByDate.get(date) !== segment.inventoryUnitId))) return false;
    const exactNumerator = BigInt(segment.nights) * BigInt(segment.anchorAmountMinor);
    if (BigInt(segment.numeratorMinor) !== exactNumerator) return false;
    totalNumerator += exactNumerator;
    nextSegmentArrival = segment.departureDate;
  }
  if (nextSegmentArrival !== value.departureDate) return false;
  const denominatorMinor = BigInt(value.pricingBandAnchorNights as number) * 100n;
  const roundedMinor = ((totalNumerator * 2n + denominatorMinor) / (denominatorMinor * 2n)) * 100n;
  return BigInt((record(value.amount)?.minorUnits as number)) === roundedMinor;
}

function cashLines(value: unknown, timelineByDate?: Map<string, string>): boolean {
  const timelineDates = timelineByDate ? new Set(timelineByDate.keys()) : undefined;
  return Array.isArray(value) && value.every((entry) => {
    const item = record(entry);
    return !!item && (item.lineKind === "STAY_TOTAL"
      ? stayTotalCashLine(item, timelineByDate)
      : nightlyCashLine(item, timelineDates));
  });
}

function pricing(value: unknown, timelineValue?: unknown): boolean {
  const item = record(value);
  const timelineByDate = Array.isArray(timelineValue)
    ? new Map(timelineValue.flatMap((entry) => {
        const item = record(entry);
        return typeof item?.serviceDate === "string" && typeof item.inventoryUnitId === "string"
          ? [[item.serviceDate, item.inventoryUnitId] as const]
          : [];
      }))
    : undefined;
  const timelineDates = timelineByDate ? new Set(timelineByDate.keys()) : undefined;
  return !!item
    && exactKeys(item, ["coverageSet", "cashLines", "cashRemainder", "currentContractAmount"])
    && coverageSet(item.coverageSet, timelineDates)
    && cashLines(item.cashLines, timelineByDate)
    && money(item.cashRemainder, { nonNegative: true })
    && money(item.currentContractAmount, { nonNegative: true });
}

function pricingDecision(value: unknown): boolean {
  const item = record(value);
  const reason = record(item?.reason);
  if (!item || !exactKeys(item, [
    "pricingBasis", "policyBaseAmount", "targetCurrentContractAmount", "differenceFromPolicy",
    "manualAdjustmentMinor", "differenceExceedsThreshold", "reason"
  ]) || typeof item.pricingBasis !== "string" || !pricingBases.has(item.pricingBasis)
    || !money(item.policyBaseAmount, { nonNegative: true })
    || !money(item.targetCurrentContractAmount, { nonNegative: true })
    || !money(item.differenceFromPolicy) || !safeInteger(item.manualAdjustmentMinor)
    || typeof item.differenceExceedsThreshold !== "boolean" || !reason
    || !exactKeys(reason, ["code", "note"]) || !identifier(reason.code) || !text(reason.note, true)) return false;
  const policy = record(item.policyBaseAmount)!;
  const target = record(item.targetCurrentContractAmount)!;
  const difference = record(item.differenceFromPolicy)!;
  if (policy.currency !== target.currency || target.currency !== difference.currency
    || target.minorUnits !== (policy.minorUnits as number) + (difference.minorUnits as number)) return false;
  const absoluteDifference = Math.abs(difference.minorUnits as number);
  return item.differenceExceedsThreshold === (absoluteDifference * 100 > (policy.minorUnits as number) * 15);
}

function stayBefore(value: unknown): boolean {
  const item = record(value);
  const dates = item && localDate(item.arrivalDate) && localDate(item.departureDate)
    ? expectedDates(item.arrivalDate, item.departureDate) : undefined;
  return !!item && !!dates && exactKeys(item, ["arrivalDate", "departureDate", "nights", "currentContractAmount"])
    && item.nights === dates.length && money(item.currentContractAmount, { nonNegative: true });
}

function stayAfter(value: unknown): boolean {
  const item = record(value);
  const dates = item && localDate(item.arrivalDate) && localDate(item.departureDate)
    ? expectedDates(item.arrivalDate, item.departureDate) : undefined;
  return !!item && !!dates && exactKeys(item, ["arrivalDate", "departureDate", "nights", "stayTimeline", "pricing"])
    && item.nights === dates.length && timeline(item.stayTimeline, dates) && pricing(item.pricing, item.stayTimeline);
}

function dateDiff(value: unknown): boolean {
  const item = record(value);
  return !!item && exactKeys(item, ["preservedDates", "releasedDates", "addedDates"])
    && dateArray(item.preservedDates) && dateArray(item.releasedDates) && dateArray(item.addedDates)
    && new Set([...item.preservedDates, ...item.releasedDates, ...item.addedDates]).size
      === item.preservedDates.length + item.releasedDates.length + item.addedDates.length;
}

function exactDateSet(value: unknown, expected: string[]): boolean {
  return dateArray(value)
    && value.length === expected.length
    && expected.every((date) => value.includes(date));
}

function entitlementDiff(value: unknown): boolean {
  const item = record(value);
  return !!item && exactKeys(item, ["preservedCoverageDates", "releasedCoverageDates", "addedCoverageDates", "consumedCoverageDates"])
    && dateArray(item.preservedCoverageDates) && dateArray(item.releasedCoverageDates)
    && dateArray(item.addedCoverageDates) && dateArray(item.consumedCoverageDates);
}

function stayFunds(value: unknown): boolean {
  const item = record(value);
  return !!item && exactKeys(item, ["netRecordedCollection", "collectionDifference"])
    && money(item.netRecordedCollection) && money(item.collectionDifference);
}

function shortenEntitlement(value: unknown): boolean {
  const item = record(value);
  return !!item && exactKeys(item, ["currentConsumedCoverageDates", "retainedHistoricalConsumedCoverageDates", "ledgerWriteCount"])
    && dateArray(item.currentConsumedCoverageDates) && dateArray(item.retainedHistoricalConsumedCoverageDates)
    && item.ledgerWriteCount === 0;
}

function shortenFunds(value: unknown): boolean {
  const item = record(value);
  return !!item && exactKeys(item, ["netRecordedCollection", "collectionDifference", "factCount"])
    && money(item.netRecordedCollection) && money(item.collectionDifference) && safeInteger(item.factCount, 0);
}

function nullableIdentifier(value: unknown): boolean {
  return value === null || identifier(value);
}

function nullableText(value: unknown): boolean {
  return value === null || text(value);
}

function inventoryUnit(value: unknown): boolean {
  const item = record(value);
  return !!item && exactKeys(item, [
    "id", "propertyId", "kind", "roomId", "code", "name", "catalogVersion", "buildingCode",
    "roomTypeCode", "pricingProductCode", "inventoryBasis", "codeProvenance", "physicalBedCount"
  ], ["occupancyCapacity"])
    && identifier(item.id) && identifier(item.propertyId) && typeof item.kind === "string" && inventoryKinds.has(item.kind)
    && identifier(item.roomId) && identifier(item.code) && text(item.name)
    && nullableIdentifier(item.catalogVersion) && nullableIdentifier(item.buildingCode)
    && nullableIdentifier(item.roomTypeCode) && nullableIdentifier(item.pricingProductCode)
    && (item.inventoryBasis === null || (typeof item.inventoryBasis === "string" && inventoryBases.has(item.inventoryBasis)))
    && (item.codeProvenance === null || (typeof item.codeProvenance === "string" && codeProvenance.has(item.codeProvenance)))
    && (item.physicalBedCount === null || safeInteger(item.physicalBedCount, 1, 1_000))
    && (!Object.hasOwn(item, "occupancyCapacity") || safeInteger(item.occupancyCapacity, 1, 1_000));
}

function legacyStayEffect(commandType: string, effect: Record<string, unknown>): boolean {
  return exactKeys(effect, [
    "operation", "orderId", "stayId", "inventoryUnitId", "before", "after", "pricingDecision",
    "inventoryChange", "entitlementChange", "fundsSummary"
  ]) && effect.operation === commandType && identifier(effect.orderId) && identifier(effect.stayId)
    && identifier(effect.inventoryUnitId) && stayBefore(effect.before) && stayAfter(effect.after)
    && pricingDecision(effect.pricingDecision) && dateDiff(effect.inventoryChange)
    && entitlementDiff(effect.entitlementChange) && stayFunds(effect.fundsSummary);
}

function legacyShortenRelationships(value: Record<string, unknown>, businessDate?: string): boolean {
  const before = record(value.before);
  const after = record(value.after);
  const inventoryChange = record(value.inventoryChange);
  if (!before || !after || !inventoryChange
    || typeof before.arrivalDate !== "string" || typeof before.departureDate !== "string"
    || typeof after.arrivalDate !== "string" || typeof after.departureDate !== "string") return false;
  const beforeDates = expectedDates(before.arrivalDate, before.departureDate);
  const afterDates = expectedDates(after.arrivalDate, after.departureDate);
  if (!beforeDates || !afterDates || before.arrivalDate !== after.arrivalDate
    || after.departureDate >= before.departureDate) return false;

  const beforeSet = new Set(beforeDates);
  const afterSet = new Set(afterDates);
  const preservedDates = beforeDates.filter((date) => afterSet.has(date));
  const releasedDates = beforeDates.filter((date) => !afterSet.has(date));
  const addedDates = afterDates.filter((date) => !beforeSet.has(date));
  if (!exactDateSet(inventoryChange.preservedDates, preservedDates)
    || !exactDateSet(inventoryChange.releasedDates, releasedDates)
    || !exactDateSet(inventoryChange.addedDates, addedDates)) return false;

  if (businessDate === undefined) return true;
  return value.completionMode === "EARLY_CHECK_OUT"
    ? after.departureDate === businessDate
    : value.completionMode === "SHORTEN_IN_HOUSE" && after.departureDate > businessDate;
}

function legacyShortenDetails(value: Record<string, unknown>): boolean {
  return (value.completionMode === "SHORTEN_IN_HOUSE" || value.completionMode === "EARLY_CHECK_OUT")
    && stayBefore(value.before) && stayAfter(value.after) && pricingDecision(value.pricingDecision)
    && dateDiff(value.inventoryChange) && legacyShortenRelationships(value)
    && shortenEntitlement(value.entitlementSummary) && shortenFunds(value.fundsSummary)
    && money(value.refundReferenceAmount, { nonNegative: true });
}

function legacyShortenEffect(effect: Record<string, unknown>): boolean {
  return exactKeys(effect, [
    "operation", "orderId", "stayId", "inventoryUnitId", "businessDate", "completionMode", "before", "after",
    "pricingDecision", "inventoryChange", "entitlementSummary", "fundsSummary", "refundReferenceAmount"
  ]) && effect.operation === "SHORTEN_STAY" && identifier(effect.orderId) && identifier(effect.stayId)
    && identifier(effect.inventoryUnitId) && localDate(effect.businessDate)
    && legacyShortenDetails(effect) && legacyShortenRelationships(effect, effect.businessDate);
}

function legacyShortenFulfillmentTiming(result: Record<string, unknown>): boolean {
  if (result.completionMode === "SHORTEN_IN_HOUSE") return result.fulfillmentTiming === null;
  const timing = record(result.fulfillmentTiming);
  return result.completionMode === "EARLY_CHECK_OUT" && !!timing
    && exactKeys(timing, ["effectiveDate", "recordedBusinessDate", "recordingMode"])
    && localDate(timing.effectiveDate) && timing.effectiveDate === result.departureDate
    && localDate(timing.recordedBusinessDate) && timing.recordedBusinessDate === result.departureDate
    && timing.recordingMode === "ON_SCHEDULE";
}

function legacyMoveEffect(effect: Record<string, unknown>): boolean {
  return exactKeys(effect, ["orderId", "fromInventoryUnit", "toInventoryUnit", "effectiveDate", "stayTimeline", "pricing"], [
    "occupantCount", "occupancyCapacity"
  ]) && identifier(effect.orderId) && inventoryUnit(effect.fromInventoryUnit) && inventoryUnit(effect.toInventoryUnit)
    && localDate(effect.effectiveDate) && timeline(effect.stayTimeline) && pricing(effect.pricing, effect.stayTimeline)
    && (!Object.hasOwn(effect, "occupantCount") || safeInteger(effect.occupantCount, 1, 1_000))
    && (!Object.hasOwn(effect, "occupancyCapacity") || safeInteger(effect.occupancyCapacity, 1, 1_000));
}

export function legacyEffectProtocol(commandType: string, value: unknown): HistoricalProtocolVersion | undefined {
  const effect = record(value);
  if (!effect) return undefined;
  if ((commandType === "RESCHEDULE_STAY" || commandType === "EXTEND_STAY") && legacyStayEffect(commandType, effect)) return "LEGACY_STAGE_9_10";
  if (commandType === "SHORTEN_STAY" && legacyShortenEffect(effect)) return "LEGACY_STAGE_10";
  if (commandType === "MOVE_UNIT" && legacyMoveEffect(effect)) return "PRE_STAGE_11";
  return undefined;
}

function receiptIdentifiers(result: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => identifier(result[key]));
}

export function legacyReceiptProtocol(commandType: string, value: unknown): HistoricalProtocolVersion | undefined {
  const result = record(value);
  if (!result) return undefined;
  if (commandType.startsWith("PREVIEW:")) {
    if (!exactKeys(result, ["preview"])) return undefined;
    const preview = record(result.preview);
    const baseType = commandType.slice("PREVIEW:".length);
    if (!preview || !exactKeys(preview, ["previewId", "commandType", "effectHash", "effect", "expiresAt"])
      || preview.commandType !== baseType || !identifier(preview.previewId)
      || typeof preview.effectHash !== "string" || !SHA256_HEX.test(preview.effectHash) || !dateTime(preview.expiresAt)) return undefined;
    return legacyEffectProtocol(baseType, preview.effect);
  }
  if (commandType === "RESCHEDULE_STAY" || commandType === "EXTEND_STAY") {
    if (!exactKeys(result, [
      "orderId", "stayId", "amendmentId", "staySegmentId", "pricingRevisionId", "arrivalDate", "departureDate",
      "before", "after", "pricingDecision", "inventoryChange", "entitlementChange", "fundsSummary"
    ]) || !receiptIdentifiers(result, ["orderId", "stayId", "amendmentId", "staySegmentId", "pricingRevisionId"])
      || !localDate(result.arrivalDate) || !localDate(result.departureDate)) return undefined;
    const after = record(result.after);
    if (!after || result.arrivalDate !== after.arrivalDate || result.departureDate !== after.departureDate) return undefined;
    const effect: Record<string, unknown> = { operation: commandType, inventoryUnitId: "legacy-receipt", ...result };
    for (const key of ["amendmentId", "staySegmentId", "pricingRevisionId", "arrivalDate", "departureDate"]) delete effect[key];
    return legacyStayEffect(commandType, effect) ? "LEGACY_STAGE_9_10" : undefined;
  }
  if (commandType === "SHORTEN_STAY") {
    if (!exactKeys(result, [
      "orderId", "stayId", "arrangementAmendmentId", "checkoutAmendmentId", "staySegmentId", "pricingRevisionId",
      "completionMode", "arrivalDate", "departureDate", "before", "after", "pricingDecision", "inventoryChange",
      "entitlementSummary", "fundsSummary", "refundReferenceAmount", "fulfillmentTiming"
    ]) || !receiptIdentifiers(result, ["orderId", "stayId", "arrangementAmendmentId", "staySegmentId", "pricingRevisionId"])
      || !nullableIdentifier(result.checkoutAmendmentId) || !legacyShortenFulfillmentTiming(result)
      || !localDate(result.arrivalDate) || !localDate(result.departureDate)) return undefined;
    const after = record(result.after);
    if (!after || result.arrivalDate !== after.arrivalDate || result.departureDate !== after.departureDate) return undefined;
    if (result.completionMode === "SHORTEN_IN_HOUSE"
      ? result.checkoutAmendmentId !== null
      : !identifier(result.checkoutAmendmentId)) return undefined;
    return legacyShortenDetails(result) ? "LEGACY_STAGE_10" : undefined;
  }
  if (commandType === "MOVE_UNIT" && exactKeys(result, ["orderId", "amendmentId", "staySegmentId", "pricingRevisionId"])
    && receiptIdentifiers(result, ["orderId", "amendmentId", "staySegmentId", "pricingRevisionId"])) return "PRE_STAGE_11";
  return undefined;
}

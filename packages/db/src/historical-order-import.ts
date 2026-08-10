import { open } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import { enumerateServiceDates, parseLocalDate, stableHash } from "@qintopia/domain";
import { databaseReady } from "./database.ts";
import { createInventoryClaims, inventoryFingerprint, loadInventoryUnit, lockRoomDays } from "./inventory.ts";
import {
  consumeHistoricalImportApproval,
  type HistoricalImportApprovalAuthorization,
  type HistoricalImportApprovalConsumptionReceipt
} from "./historical-import-approval.ts";
import type { Database } from "./schema.ts";

const SHA256 = /^[0-9a-f]{64}$/;
const ISO_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const CHANNELS = new Set(["YOUMUDAO", "CTRIP", "MEITUAN", "WECOM"]);
const PRICING_BASES = new Set(["POLICY", "CHANNEL_CONTRACT", "MEMBER_ENTITLEMENT", "FREE"]);
const SOURCE_FILE_ROLES = new Set([
  "ORDER_EXPORT",
  "COST_EXPORT",
  "CHECKOUT_EXPORT",
  "FEISHU_MATCH_BASELINE",
  "USER_CONFIRMATION_REVIEW",
  "BUSINESS_CONFIRMATION_REVIEW",
  "REVIEW_WORKBOOK"
]);
const RAW_EXPORT_ROLES = new Set(["ORDER_EXPORT", "COST_EXPORT", "CHECKOUT_EXPORT"]);
const validatedManifestObjects = new WeakSet<object>();

type ObjectRecord = Record<string, unknown>;

export type HistoricalImportDisposition = "HISTORICAL_ARCHIVE" | "NON_ACCOMMODATION_ARCHIVE" | "OPERATIONAL";
export interface HistoricalOrderImportRecord {
  canonicalPayloadHash: string;
  channel: { raw: string | null; normalized: string | null; externalOrderNo: string | null; externalOrderNoStatus: "RECORDED" | "HISTORICAL_NOT_RECORDED" | "NOT_APPLICABLE" };
  disposition: HistoricalImportDisposition;
  flags: string[];
  guest: { name: string | null; nameProvenance: string; nickname: string | null; nicknameProvenance: string; phone: string | null; phoneProvenance: string };
  manualConfirmation: ObjectRecord;
  membership: ObjectRecord | null;
  observedLifecycle: "ARCHIVED" | "RESERVED" | "IN_HOUSE";
  pricing: { origin: "MIGRATED_ACTUAL"; basis: "POLICY" | "CHANNEL_CONTRACT" | "MEMBER_ENTITLEMENT" | "FREE"; currency: "CNY"; currentContractAmountFen: number; evidence: ObjectRecord };
  provenance: ObjectRecord;
  recordKind: "ACCOMMODATION" | "NON_ACCOMMODATION_CHECKOUT";
  segments: Array<{ sequence: number; sourceOrderRow: number; sourceRoom: string | null; inventoryUnitCode: string; roomType: string | null; arrivalDate: string; departureDate: string; amountFen: number; sourceStatus: string | null }>;
  source: { system: "ORDER_LAILE"; orderId: string; auditRow: number; sourceValuesHash: string };
  sourceStay: { arrivalDate: string; departureDate: string; rawRoom?: string | null; standardInventoryUnits?: string | null; rawRoomType?: string | null };
  stayType: "STANDARD" | "FREE" | "FREE_RECEPTION" | "MEMBER_ENTITLEMENT";
}

export interface HistoricalOrderImportManifest {
  approvedOperationalTuplesSha256: string;
  currency: "CNY";
  cutoverAt: string;
  expected: {
    candidateCount: number;
    historicalAccommodationAmountFen: number;
    historicalAccommodationArchives: number;
    nonAccommodationArchives: number;
    operationalAccommodationAmountFen: number;
    operationalOrders: number;
    operationalSegmentCount: number;
    totalAccommodationAmountFen: number;
  };
  generatorVersion: "historical-order-manifest-v1";
  idempotencyKey: string;
  importStartDate: "2026-03-13";
  manifestHash: string;
  manifestVersion: 1;
  propertyCode: string;
  records: HistoricalOrderImportRecord[];
  source: { sourceFiles: Array<{ role: string; fileName: string; sha256: string; rowCount: number | null; exportedAt: string | null }>; workbook: { fileName: string; sha256: string } };
  sourceSystem: "ORDER_LAILE";
}

export interface HistoricalImportDryRunReport {
  mode: "DRY_RUN";
  manifestHash: string;
  propertyId: string;
  replayedSources: number;
  newSources: number;
  expected: HistoricalOrderImportManifest["expected"];
  reconciliation: HistoricalImportReconciliation;
}

export interface HistoricalImportApplyReport extends Omit<HistoricalImportDryRunReport, "mode"> {
  mode: "APPLIED" | "REPLAYED";
  runId: string;
  approval: HistoricalImportApprovalConsumptionReceipt;
}

export interface HistoricalImportReconciliation extends ReturnType<typeof expectedReconciliation> {
  sourceCount: number;
  targetCount: number;
  historicalArchiveTargets: number;
  nonAccommodationArchiveTargets: number;
  operationalTargets: number;
  sourceOperationalSegmentEvidence: number;
  operationalClaimPoints: number;
  historicalCollectionFacts: number;
  activeOverdueHolds: number;
  legacyMemberContracts: number;
  entitlementLots: number;
  entitlementCoveragePoints: number;
  entitlementHoldFacts: number;
  entitlementConsumeFacts: number;
  amountMinor: number;
}

function fail(message: string): never { throw new Error(`Historical import manifest validation failed: ${message}`); }
function object(value: unknown, field: string): ObjectRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object`);
  return value as ObjectRecord;
}
function array(value: unknown, field: string): unknown[] { if (!Array.isArray(value)) fail(`${field} must be an array`); return value; }
function string(value: unknown, field: string): string { if (typeof value !== "string" || !value.trim()) fail(`${field} must be a nonblank string`); return value; }
function nullableString(value: unknown, field: string): string | null { if (value === null) return null; return string(value, field); }
function boundedNullableString(value: unknown, field: string, maximumLength: number): string | null {
  const result = nullableString(value, field);
  if (result !== null && result.length > maximumLength) fail(`${field} must be no longer than ${maximumLength} characters`);
  return result;
}
function optionalBoundedString(value: unknown, field: string, maximumLength: number): string | null {
  return value === undefined || value === null ? null : boundedNullableString(value, field, maximumLength);
}
function integer(value: unknown, field: string, minimum = 0): number { if (!Number.isSafeInteger(value) || (value as number) < minimum) fail(`${field} must be an integer >= ${minimum}`); return value as number; }
function sha(value: unknown, field: string): string { const result = string(value, field); if (!SHA256.test(result)) fail(`${field} must be a lower-case SHA-256`); return result; }
function date(value: unknown, field: string): string { const result = string(value, field); try { parseLocalDate(result); } catch { fail(`${field} must be YYYY-MM-DD`); } return result; }
function timestamp(value: unknown, field: string): string {
  const result = string(value, field);
  const match = result.match(ISO_TIMESTAMP);
  if (!match || Number.isNaN(new Date(result).getTime())) fail(`${field} must be an ISO timestamp with offset`);
  try { parseLocalDate(match[1]!); } catch { fail(`${field} must be an ISO timestamp with offset`); }
  return result;
}
function exact<T extends string | number>(value: unknown, expected: T, field: string): T { if (value !== expected) fail(`${field} must equal ${expected}`); return expected; }
function oneOf<T extends string>(value: unknown, allowed: ReadonlySet<T>, field: string): T { const result = string(value, field) as T; if (!allowed.has(result)) fail(`${field} has an unsupported value`); return result; }

function deepFreezeJson<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail("manifest must contain only plain JSON objects");
  }
  for (const child of Object.values(value as Record<string, unknown>)) deepFreezeJson(child);
  return Object.freeze(value);
}

/** Hashes the manifest without its self-referential manifestHash field. */
export function manifestStableHash(value: unknown): string {
  const copy = { ...object(value, "manifest") };
  delete copy.manifestHash;
  return stableHash(copy);
}

function parseRecord(value: unknown, index: number): HistoricalOrderImportRecord {
  const record = object(value, `records[${index}]`);
  const canonicalPayloadHash = sha(record.canonicalPayloadHash, `records[${index}].canonicalPayloadHash`);
  const copy = { ...record };
  delete copy.canonicalPayloadHash;
  if (stableHash(copy) !== canonicalPayloadHash) fail(`records[${index}] canonical payload hash does not match`);
  const channelObject = object(record.channel, `records[${index}].channel`);
  const normalized = channelObject.normalized === null ? null : oneOf(channelObject.normalized, CHANNELS, `records[${index}].channel.normalized`);
  const externalOrderNo = nullableString(channelObject.externalOrderNo, `records[${index}].channel.externalOrderNo`);
  const externalOrderNoStatus = oneOf(channelObject.externalOrderNoStatus, new Set(["RECORDED", "HISTORICAL_NOT_RECORDED", "NOT_APPLICABLE"] as const), `records[${index}].channel.externalOrderNoStatus`);
  if ((externalOrderNo === null) !== (externalOrderNoStatus !== "RECORDED")) fail(`records[${index}].channel reference status is inconsistent`);
  if (normalized === null && (externalOrderNo !== null || externalOrderNoStatus !== "NOT_APPLICABLE")) {
    fail(`records[${index}].channel without a channel must use a null reference and NOT_APPLICABLE`);
  }
  if (normalized === "WECOM" && (externalOrderNo !== null || externalOrderNoStatus !== "NOT_APPLICABLE")) {
    fail(`records[${index}].channel WECOM reference must be null and NOT_APPLICABLE`);
  }
  if (normalized !== null && normalized !== "WECOM"
    && ((externalOrderNo === null && externalOrderNoStatus !== "HISTORICAL_NOT_RECORDED")
      || (externalOrderNo !== null && externalOrderNoStatus !== "RECORDED"))) {
    fail(`records[${index}].external channel must use RECORDED or HISTORICAL_NOT_RECORDED consistently`);
  }
  const disposition = oneOf(record.disposition, new Set(["HISTORICAL_ARCHIVE", "NON_ACCOMMODATION_ARCHIVE", "OPERATIONAL"] as const), `records[${index}].disposition`);
  const observedLifecycle = oneOf(record.observedLifecycle, new Set(["ARCHIVED", "RESERVED", "IN_HOUSE"] as const), `records[${index}].observedLifecycle`);
  if ((disposition === "OPERATIONAL") !== (observedLifecycle !== "ARCHIVED")) fail(`records[${index}] disposition and lifecycle are inconsistent`);
  const source = object(record.source, `records[${index}].source`);
  const sourceStay = object(record.sourceStay, `records[${index}].sourceStay`);
  const arrivalDate = date(sourceStay.arrivalDate, `records[${index}].sourceStay.arrivalDate`);
  const departureDate = date(sourceStay.departureDate, `records[${index}].sourceStay.departureDate`);
  if (disposition === "OPERATIONAL") {
    try { enumerateServiceDates(arrivalDate, departureDate); } catch { fail(`records[${index}].sourceStay must be a valid interval`); }
  }
  const stayType = oneOf(record.stayType, new Set(["STANDARD", "FREE", "FREE_RECEPTION", "MEMBER_ENTITLEMENT"] as const), `records[${index}].stayType`);
  const pricing = object(record.pricing, `records[${index}].pricing`);
  exact(pricing.origin, "MIGRATED_ACTUAL", `records[${index}].pricing.origin`);
  const basis = oneOf(pricing.basis, PRICING_BASES, `records[${index}].pricing.basis`) as HistoricalOrderImportRecord["pricing"]["basis"];
  exact(pricing.currency, "CNY", `records[${index}].pricing.currency`);
  const currentContractAmountFen = integer(pricing.currentContractAmountFen, `records[${index}].pricing.currentContractAmountFen`);
  const evidence = object(pricing.evidence, `records[${index}].pricing.evidence`);
  if (evidence.historicalActualAmountFen !== currentContractAmountFen) fail(`records[${index}].pricing historical actual amount differs from contract amount`);
  if ((stayType === "FREE" || stayType === "FREE_RECEPTION") !== (basis === "FREE")) fail(`records[${index}] free stay and pricing basis are inconsistent`);
  if ((stayType === "MEMBER_ENTITLEMENT") !== (basis === "MEMBER_ENTITLEMENT")) fail(`records[${index}] member stay and pricing basis are inconsistent`);
  const segments = array(record.segments, `records[${index}].segments`).map((segmentValue, segmentIndex) => {
    const segment = object(segmentValue, `records[${index}].segments[${segmentIndex}]`);
    const segmentArrival = date(segment.arrivalDate, `records[${index}].segments[${segmentIndex}].arrivalDate`);
    const segmentDeparture = date(segment.departureDate, `records[${index}].segments[${segmentIndex}].departureDate`);
    try { enumerateServiceDates(segmentArrival, segmentDeparture); } catch { fail(`records[${index}].segments[${segmentIndex}] must be a valid interval`); }
    return { sequence: integer(segment.sequence, `records[${index}].segments[${segmentIndex}].sequence`, 1), sourceOrderRow: integer(segment.sourceOrderRow, `records[${index}].segments[${segmentIndex}].sourceOrderRow`, 1), sourceRoom: nullableString(segment.sourceRoom, `records[${index}].segments[${segmentIndex}].sourceRoom`), inventoryUnitCode: string(segment.inventoryUnitCode, `records[${index}].segments[${segmentIndex}].inventoryUnitCode`), roomType: nullableString(segment.roomType, `records[${index}].segments[${segmentIndex}].roomType`), arrivalDate: segmentArrival, departureDate: segmentDeparture, amountFen: integer(segment.amountFen, `records[${index}].segments[${segmentIndex}].amountFen`), sourceStatus: nullableString(segment.sourceStatus, `records[${index}].segments[${segmentIndex}].sourceStatus`) };
  });
  if (disposition === "OPERATIONAL" && segments.length === 0) fail(`records[${index}] operational record requires at least one segment`);
  if (disposition !== "OPERATIONAL" && segments.length !== 0) fail(`records[${index}] archive record cannot have operational segments`);
  const sequence = segments.map((segment) => segment.sequence);
  if (new Set(sequence).size !== sequence.length) fail(`records[${index}] segment sequence must be unique`);
  const guest = object(record.guest, `records[${index}].guest`);
  const guestName = boundedNullableString(guest.name, `records[${index}].guest name`, 200);
  const guestNickname = boundedNullableString(guest.nickname, `records[${index}].guest nickname`, 200);
  const guestPhone = boundedNullableString(guest.phone, `records[${index}].guest phone`, 80);
  if (disposition === "OPERATIONAL" && guestName === null) fail(`records[${index}] operational guest name is required`);
  const provenance = object(record.provenance, `records[${index}].provenance`);
  if (provenance.rawSnapshot !== undefined) {
    const rawSnapshot = object(provenance.rawSnapshot, `records[${index}].provenance.rawSnapshot`);
    optionalBoundedString(rawSnapshot.sourceOrderStatus, `records[${index}].provenance.rawSnapshot.sourceOrderStatus`, 200);
    optionalBoundedString(rawSnapshot.sourceCheckoutStatus, `records[${index}].provenance.rawSnapshot.sourceCheckoutStatus`, 200);
  }
  const flags = array(record.flags, `records[${index}].flags`).map((flag, flagIndex) => string(flag, `records[${index}].flags[${flagIndex}]`));
  const membership = record.membership === null ? null : object(record.membership, `records[${index}].membership`);
  if ((stayType === "MEMBER_ENTITLEMENT") !== (membership !== null)) fail(`records[${index}] member entitlement requires the legacy contract payload`);
  return {
    canonicalPayloadHash, channel: { raw: nullableString(channelObject.raw, `records[${index}].channel.raw`), normalized, externalOrderNo, externalOrderNoStatus }, disposition, flags,
    guest: { name: guestName, nameProvenance: string(guest.nameProvenance, `records[${index}].guest.nameProvenance`), nickname: guestNickname, nicknameProvenance: string(guest.nicknameProvenance, `records[${index}].guest.nicknameProvenance`), phone: guestPhone, phoneProvenance: string(guest.phoneProvenance, `records[${index}].guest.phoneProvenance`) },
    manualConfirmation: object(record.manualConfirmation, `records[${index}].manualConfirmation`), membership, observedLifecycle,
    pricing: { origin: "MIGRATED_ACTUAL", basis, currency: "CNY", currentContractAmountFen, evidence }, provenance, recordKind: exact(record.recordKind, disposition === "NON_ACCOMMODATION_ARCHIVE" ? "NON_ACCOMMODATION_CHECKOUT" : "ACCOMMODATION", `records[${index}].recordKind`), segments,
    source: { system: exact(source.system, "ORDER_LAILE", `records[${index}].source.system`), orderId: string(source.orderId, `records[${index}].source.orderId`), auditRow: integer(source.auditRow, `records[${index}].source.auditRow`, 1), sourceValuesHash: sha(source.sourceValuesHash, `records[${index}].source.sourceValuesHash`) },
    sourceStay: { arrivalDate, departureDate, rawRoom: sourceStay.rawRoom === undefined ? null : nullableString(sourceStay.rawRoom, `records[${index}].sourceStay.rawRoom`), standardInventoryUnits: sourceStay.standardInventoryUnits === undefined ? null : nullableString(sourceStay.standardInventoryUnits, `records[${index}].sourceStay.standardInventoryUnits`), rawRoomType: sourceStay.rawRoomType === undefined ? null : nullableString(sourceStay.rawRoomType, `records[${index}].sourceStay.rawRoomType`) }, stayType
  };
}

function expectedReconciliation(records: readonly HistoricalOrderImportRecord[]) {
  const operational = records.filter((record) => record.disposition === "OPERATIONAL");
  const historical = records.filter((record) => record.disposition === "HISTORICAL_ARCHIVE");
  const nonAccommodation = records.filter((record) => record.disposition === "NON_ACCOMMODATION_ARCHIVE");
  const totalAccommodationAmountFen = records.reduce((sum, record) => sum + (record.recordKind === "ACCOMMODATION" ? record.pricing.currentContractAmountFen : 0), 0);
  const operationalAccommodationAmountFen = operational.reduce((sum, record) => sum + record.pricing.currentContractAmountFen, 0);
  return { candidateCount: records.length, historicalAccommodationAmountFen: totalAccommodationAmountFen - operationalAccommodationAmountFen, historicalAccommodationArchives: historical.length, nonAccommodationArchives: nonAccommodation.length, operationalAccommodationAmountFen, operationalOrders: operational.length, operationalSegmentCount: operational.flatMap((record) => record.segments).length, totalAccommodationAmountFen };
}

export function historicalOperationalTupleHash(records: readonly HistoricalOrderImportRecord[]): string {
  return stableHash(records
    .filter((record) => record.disposition === "OPERATIONAL")
    .map((record) => ({
      sourceOrderId: record.source.orderId,
      observedLifecycle: record.observedLifecycle,
      sourceStay: {
        arrivalDate: record.sourceStay.arrivalDate,
        departureDate: record.sourceStay.departureDate
      },
      stayType: record.stayType,
      guest: {
        name: record.guest.name,
        nameProvenance: record.guest.nameProvenance,
        nickname: record.guest.nickname,
        nicknameProvenance: record.guest.nicknameProvenance,
        phone: record.guest.phone,
        phoneProvenance: record.guest.phoneProvenance
      },
      manualConfirmation: record.manualConfirmation,
      segments: [...record.segments]
        .sort((left, right) => left.sequence - right.sequence
          || (left.inventoryUnitCode < right.inventoryUnitCode ? -1 : left.inventoryUnitCode > right.inventoryUnitCode ? 1 : 0))
        .map((segment) => ({
          sequence: segment.sequence,
          sourceRoom: segment.sourceRoom,
          inventoryUnitCode: segment.inventoryUnitCode,
          roomType: segment.roomType,
          arrivalDate: segment.arrivalDate,
          departureDate: segment.departureDate,
          amountFen: segment.amountFen,
          sourceStatus: segment.sourceStatus
        })),
      channel: {
        raw: record.channel.raw,
        normalized: record.channel.normalized,
        externalOrderNo: record.channel.externalOrderNo,
        externalOrderNoStatus: record.channel.externalOrderNoStatus
      },
      pricing: {
        basis: record.pricing.basis,
        currentContractAmountFen: record.pricing.currentContractAmountFen
      },
      flags: [...record.flags].sort()
    }))
    .sort((left, right) => left.sourceOrderId < right.sourceOrderId ? -1 : left.sourceOrderId > right.sourceOrderId ? 1 : 0));
}

const frozenImportBaseline: HistoricalOrderImportManifest["expected"] = {
  candidateCount: 535,
  historicalAccommodationAmountFen: 22_105_406,
  historicalAccommodationArchives: 490,
  nonAccommodationArchives: 1,
  operationalAccommodationAmountFen: 6_035_032,
  operationalOrders: 44,
  operationalSegmentCount: 50,
  totalAccommodationAmountFen: 28_140_438
};

function persistedMappedChannel(record: HistoricalOrderImportRecord): string | null {
  return record.disposition === "OPERATIONAL"
    && (record.pricing.basis === "MEMBER_ENTITLEMENT" || record.pricing.basis === "FREE")
    ? null
    : record.channel.normalized;
}

function archivedSourceStatus(record: HistoricalOrderImportRecord): string | null {
  const rawSnapshot = record.provenance.rawSnapshot;
  if (!rawSnapshot || typeof rawSnapshot !== "object" || Array.isArray(rawSnapshot)) return null;
  const evidence = rawSnapshot as ObjectRecord;
  return optionalBoundedString(
    evidence.sourceOrderStatus ?? evidence.sourceCheckoutStatus,
    `records source ${record.source.orderId} archived source status`,
    200
  );
}

function assertFrozenImportBaseline(manifest: HistoricalOrderImportManifest): void {
  for (const [key, expected] of Object.entries(frozenImportBaseline)) {
    if (manifest.expected[key as keyof typeof frozenImportBaseline] !== expected) {
      throw new Error(`Historical import frozen baseline mismatch for ${key}`);
    }
  }
  const channelCounts = new Map<string, number>();
  for (const record of manifest.records) {
    const channel = persistedMappedChannel(record) ?? "NULL";
    channelCounts.set(channel, (channelCounts.get(channel) ?? 0) + 1);
  }
  const expectedChannels = new Map([
    ["WECOM", 503], ["CTRIP", 15], ["MEITUAN", 11], ["YOUMUDAO", 4], ["NULL", 2]
  ]);
  if ([...expectedChannels].some(([channel, count]) => channelCounts.get(channel) !== count)
    || [...channelCounts.keys()].some((channel) => !expectedChannels.has(channel))) {
    throw new Error("Historical import frozen channel mapping no longer matches the approved baseline");
  }
  const operational = manifest.records.filter((record) => record.disposition === "OPERATIONAL");
  if (operational.filter((record) => record.observedLifecycle === "IN_HOUSE").length !== 36
    || operational.filter((record) => record.observedLifecycle === "RESERVED").length !== 8
    || operational.filter((record) => record.guest.nicknameProvenance === "FULL_NAME_DISPLAY_FALLBACK").length !== 38
    || manifest.records.filter((record) => record.channel.externalOrderNoStatus === "HISTORICAL_NOT_RECORDED").length !== 24
    || operational.filter((record) => record.channel.externalOrderNoStatus === "HISTORICAL_NOT_RECORDED").length !== 1) {
    throw new Error("Historical import frozen lifecycle, guest provenance, or channel-reference baseline changed");
  }
}

export function parseHistoricalOrderImportManifest(raw: string | unknown): HistoricalOrderImportManifest {
  let value: unknown = raw;
  if (typeof raw === "string") { try { value = JSON.parse(raw); } catch { fail("manifest must be valid JSON"); } }
  const manifest = object(value, "manifest");
  const manifestHash = sha(manifest.manifestHash, "manifest.manifestHash");
  if (manifestStableHash(manifest) !== manifestHash) fail("manifest hash does not match");
  exact(manifest.manifestVersion, 1, "manifest.manifestVersion"); exact(manifest.generatorVersion, "historical-order-manifest-v1", "manifest.generatorVersion"); exact(manifest.sourceSystem, "ORDER_LAILE", "manifest.sourceSystem"); exact(manifest.importStartDate, "2026-03-13", "manifest.importStartDate"); exact(manifest.currency, "CNY", "manifest.currency");
  const cutoverAt = timestamp(manifest.cutoverAt, "manifest.cutoverAt");
  if (!cutoverAt.endsWith("+08:00")) fail("manifest.cutoverAt must use the Asia/Shanghai +08:00 offset");
  const records = array(manifest.records, "manifest.records").map(parseRecord);
  const approvedOperationalTuplesSha256 = sha(manifest.approvedOperationalTuplesSha256, "manifest.approvedOperationalTuplesSha256");
  if (historicalOperationalTupleHash(records) !== approvedOperationalTuplesSha256) {
    fail("manifest approved operational tuple hash does not match its operational records");
  }
  const sourceKeys = new Set<string>(); for (const record of records) { const key = `${record.source.system}:${record.source.orderId}`; if (sourceKeys.has(key)) fail("duplicate source key"); sourceKeys.add(key); }
  const expectedObject = object(manifest.expected, "manifest.expected"); const actual = expectedReconciliation(records);
  for (const [key, observed] of Object.entries(actual)) { if (integer(expectedObject[key], `manifest.expected.${key}`) !== observed) fail(`reconciliation mismatch for ${key}`); }
  const source = object(manifest.source, "manifest.source"); const sourceFiles = array(source.sourceFiles, "manifest.source.sourceFiles").map((entry, index) => { const file = object(entry, `manifest.source.sourceFiles[${index}]`); return { role: oneOf(file.role, SOURCE_FILE_ROLES, `manifest.source.sourceFiles[${index}].role`), fileName: string(file.fileName, `manifest.source.sourceFiles[${index}].fileName`), sha256: sha(file.sha256, `manifest.source.sourceFiles[${index}].sha256`), rowCount: file.rowCount === null ? null : integer(file.rowCount, `manifest.source.sourceFiles[${index}].rowCount`), exportedAt: file.exportedAt === null ? null : timestamp(file.exportedAt, `manifest.source.sourceFiles[${index}].exportedAt`) }; });
  if (new Set(sourceFiles.map((file) => file.role)).size !== sourceFiles.length) fail("source file roles must be unique");
  if (sourceFiles.length !== SOURCE_FILE_ROLES.size || [...SOURCE_FILE_ROLES].some((role) => !sourceFiles.some((file) => file.role === role))) fail("source file roles must contain the complete approved role set");
  for (const file of sourceFiles.filter((entry) => RAW_EXPORT_ROLES.has(entry.role))) {
    if (file.rowCount === null || file.rowCount <= 0) fail(`${file.role}.rowCount must be a positive integer`);
    if (file.exportedAt === null) fail(`${file.role}.exportedAt must be present`);
    if (!file.exportedAt.endsWith("+08:00")) fail(`${file.role}.exportedAt must use the Asia/Shanghai +08:00 offset`);
    if (file.exportedAt.slice(0, 10) !== cutoverAt.slice(0, 10)) fail(`${file.role} must be exported on the manifest cutover date`);
    if (new Date(file.exportedAt).getTime() > new Date(cutoverAt).getTime()) fail(`${file.role} cannot be exported later than manifest cutoverAt`);
  }
  const workbook = object(source.workbook, "manifest.source.workbook");
  const parsed = { approvedOperationalTuplesSha256, currency: "CNY" as const, cutoverAt, expected: actual, generatorVersion: "historical-order-manifest-v1" as const, idempotencyKey: string(manifest.idempotencyKey, "manifest.idempotencyKey"), importStartDate: "2026-03-13" as const, manifestHash, manifestVersion: 1 as const, propertyCode: string(manifest.propertyCode, "manifest.propertyCode"), records, source: { sourceFiles, workbook: { fileName: string(workbook.fileName, "manifest.source.workbook.fileName"), sha256: sha(workbook.sha256, "manifest.source.workbook.sha256") } }, sourceSystem: "ORDER_LAILE" as const };
  const immutableManifest = deepFreezeJson(structuredClone(parsed));
  validatedManifestObjects.add(immutableManifest);
  return immutableManifest;
}

export async function loadHistoricalOrderImportManifest(path: string): Promise<HistoricalOrderImportManifest> {
  let file;
  try {
    file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error("not a regular file");
    if (metadata.size > 64 * 1024 * 1024) throw new Error("file is too large");
    if ((metadata.mode & 0o077) !== 0) throw new Error("permissions are broader than 0600");
    return parseHistoricalOrderImportManifest(await file.readFile("utf8"));
  } catch {
    throw new Error("Historical import manifest must be a readable regular file accessible only by its owner");
  } finally {
    await file?.close();
  }
}

function validatedManifest(input: HistoricalOrderImportManifest | string | unknown): HistoricalOrderImportManifest {
  if (typeof input === "object" && input !== null && validatedManifestObjects.has(input)) return input as HistoricalOrderImportManifest;
  return parseHistoricalOrderImportManifest(input);
}

async function resolveProperty(db: Kysely<Database> | Transaction<Database>, manifest: HistoricalOrderImportManifest) {
  const property = await db.selectFrom("properties").select(["id", "code", "timezone", "currency"]).where("code", "=", manifest.propertyCode).executeTakeFirst();
  if (!property) throw new Error(`Historical import property ${manifest.propertyCode} does not exist`);
  if (property.currency !== manifest.currency || property.timezone !== "Asia/Shanghai") throw new Error("Historical import property identity does not match the manifest");
  return property;
}

export async function dryRunHistoricalOrderImport(db: Kysely<Database>, input: HistoricalOrderImportManifest | string | unknown): Promise<HistoricalImportDryRunReport> {
  const manifest = validatedManifest(input);
  assertFrozenImportBaseline(manifest);
  return db.transaction().execute(async (trx) => {
    await sql`SET TRANSACTION READ ONLY`.execute(trx);
    if (!await databaseReady(trx)) throw new Error("Historical import database is not ready for migration 037");
    const property = await resolveProperty(trx, manifest);
    const existing = await (trx as unknown as { selectFrom(table: string): any }).selectFrom("migration_order_sources").select(["source_order_id", "payload_hash"]).where("property_id", "=", property.id).where("source_system", "=", manifest.sourceSystem).execute();
    const oldById = new Map((existing as Array<{ source_order_id: string; payload_hash: string }>).map((row) => [row.source_order_id, row.payload_hash]));
    let replayedSources = 0;
    for (const record of manifest.records) { const oldHash = oldById.get(record.source.orderId); if (oldHash) { if (oldHash !== record.canonicalPayloadHash) throw new Error(`Historical import source ${record.source.orderId} has a changed canonical payload`); replayedSources += 1; } }
    if (oldById.size > 0 && (oldById.size !== manifest.records.length || replayedSources !== manifest.records.length)) {
      throw new Error("Historical import dry-run cannot mix replayed sources with a partial or unrelated batch");
    }
    if (replayedSources === manifest.records.length) {
      const run = await (trx as unknown as { selectFrom(table: string): any }).selectFrom("migration_import_runs as run")
        .innerJoin("migration_order_sources as source", "source.run_id", "run.id")
        .select("run.id")
        .where("source.property_id", "=", property.id)
        .where("source.source_system", "=", manifest.sourceSystem)
        .where("run.state", "=", "APPLIED")
        .limit(1)
        .executeTakeFirst() as { id: string } | undefined;
      if (!run) throw new Error("Historical import source replay does not belong to an applied manifest run");
      const reconciliation = await reconcileCommittedImport(trx, run.id, manifest, false);
      return { mode: "DRY_RUN" as const, manifestHash: manifest.manifestHash, propertyId: property.id, replayedSources, newSources: 0, expected: manifest.expected, reconciliation };
    }
    const unitIdsByCode = await resolveOperationalUnits(trx, property.id, manifest);
    await policyAnchors(trx, property.id);
    const reconciliation = await preflightNewHistoricalImport(trx, property.id, manifest, unitIdsByCode);
    return { mode: "DRY_RUN" as const, manifestHash: manifest.manifestHash, propertyId: property.id, replayedSources: 0, newSources: manifest.records.length, expected: manifest.expected, reconciliation };
  });
}

function importId(kind: string): string { return `migration_${kind}_${randomUUID()}`; }
function dbAny(db: Kysely<Database> | Transaction<Database>): any { return db; }

function coreStayType(record: HistoricalOrderImportRecord, arrivalDate = record.sourceStay.arrivalDate, departureDate = record.sourceStay.departureDate): "TRANSIENT" | "CUSTOM" | "FREE" {
  if (record.stayType === "FREE" || record.stayType === "FREE_RECEPTION") return "FREE";
  return enumerateServiceDates(arrivalDate, departureDate).length < 7 ? "TRANSIENT" : "CUSTOM";
}

function normalizedDisposition(record: HistoricalOrderImportRecord): "HISTORICAL_ACCOMMODATION" | "NON_ACCOMMODATION" | "OPERATIONAL" {
  return record.disposition === "HISTORICAL_ARCHIVE" ? "HISTORICAL_ACCOMMODATION"
    : record.disposition === "NON_ACCOMMODATION_ARCHIVE" ? "NON_ACCOMMODATION" : "OPERATIONAL";
}

function guestSnapshot(record: HistoricalOrderImportRecord) {
  return {
    fullName: record.guest.name,
    // This value is a display fallback, never a claimed/confirmed nickname; provenance carries that distinction.
    nickname: record.guest.nickname,
    phone: record.guest.phone,
    documentNumber: null,
    nameProvenance: record.guest.nameProvenance,
    nicknameProvenance: record.guest.nicknameProvenance,
    phoneProvenance: record.guest.phoneProvenance
  };
}

function sourceDates(record: HistoricalOrderImportRecord): string[] { return enumerateServiceDates(record.sourceStay.arrivalDate, record.sourceStay.departureDate); }

function persistedSourceDates(record: HistoricalOrderImportRecord): { arrivalDate: string | null; departureDate: string | null } {
  if (record.disposition === "OPERATIONAL") return { arrivalDate: record.sourceStay.arrivalDate, departureDate: record.sourceStay.departureDate };
  try {
    enumerateServiceDates(record.sourceStay.arrivalDate, record.sourceStay.departureDate);
    return { arrivalDate: record.sourceStay.arrivalDate, departureDate: record.sourceStay.departureDate };
  } catch {
    // The untouched canonical payload retains a zero-night historical row; normalized date columns remain honest and valid.
    return { arrivalDate: null, departureDate: null };
  }
}

function requireTimeline(record: HistoricalOrderImportRecord, unitIdsByCode: ReadonlyMap<string, string>) {
  const byDate = new Map<string, Set<string>>();
  for (const segment of record.segments) {
    const unitId = unitIdsByCode.get(segment.inventoryUnitCode);
    if (!unitId) throw new Error(`Historical import has no active unit for source ${record.source.orderId}`);
    for (const serviceDate of enumerateServiceDates(segment.arrivalDate, segment.departureDate)) {
      const units = byDate.get(serviceDate) ?? new Set<string>();
      if (units.has(unitId)) throw new Error(`Historical import source ${record.source.orderId} repeats an operational unit on ${serviceDate}`);
      units.add(unitId);
      byDate.set(serviceDate, units);
    }
  }
  const dates = sourceDates(record);
  const timeline = dates.flatMap((serviceDate) => {
    const inventoryUnitIds = byDate.get(serviceDate);
    if (!inventoryUnitIds?.size) return [];
    return [...inventoryUnitIds].sort().map((inventoryUnitId) => ({ serviceDate, inventoryUnitId }));
  });
  if (timeline.length === 0 || [...byDate.keys()].some((serviceDate) => !dates.includes(serviceDate))) {
    throw new Error(`Historical import source ${record.source.orderId} has an invalid operational timeline`);
  }
  return timeline;
}

function sourceGuestSnapshot(record: HistoricalOrderImportRecord) { return guestSnapshot(record); }

interface OperationalSnapshot extends ObjectRecord {
  sourceId: string;
  sourceOrderId: string;
  cutoverObservedAt: string;
  observedStatus: "CHECKED_IN" | "RESERVED";
  observedStayStatus: "IN_HOUSE" | "PLANNED";
  arrivalDate: string;
  departureDate: string;
  stayType: "TRANSIENT" | "CUSTOM" | "FREE";
  pricingOrigin: "MIGRATED_ACTUAL";
  historicalActualAmountMinor: number;
  currency: "CNY";
  stayTimeline: Array<{ serviceDate: string; inventoryUnitId: string }>;
  inventoryUnitId: string;
  overdueHoldStartsOn?: string;
}

function snapshotFor(record: HistoricalOrderImportRecord, sourceId: string, cutoverAt: string, unitIdsByCode: ReadonlyMap<string, string>): OperationalSnapshot {
  const fullTimeline = requireTimeline(record, unitIdsByCode);
  const sourceDatesDescending = sourceDates(record).reverse();
  const pointsByDate = new Map<string, Array<{ serviceDate: string; inventoryUnitId: string }>>();
  for (const point of fullTimeline) pointsByDate.set(point.serviceDate, [...(pointsByDate.get(point.serviceDate) ?? []), point]);
  const componentDates: string[] = [];
  for (const serviceDate of sourceDatesDescending) {
    if (!pointsByDate.has(serviceDate)) break;
    componentDates.push(serviceDate);
  }
  if (componentDates.length === 0) throw new Error(`Historical import source ${record.source.orderId} has no current operational component`);
  componentDates.reverse();
  const arrivalDate = componentDates[0]!;
  const departureDate = record.sourceStay.departureDate;
  const cutoverBusinessDate = cutoverAt.slice(0, 10);
  const isOverdue = record.flags.includes("LIVE_DEPARTURE_DATE_UNCONFIRMED");
  if (record.observedLifecycle === "IN_HOUSE") {
    if (isOverdue) {
      if (departureDate > cutoverBusinessDate) {
        throw new Error(`Historical import source ${record.source.orderId} is marked overdue but still covers the cutover date`);
      }
    } else if (!(arrivalDate <= cutoverBusinessDate && cutoverBusinessDate < departureDate)) {
      throw new Error(`Historical import in-house source ${record.source.orderId} does not cover the cutover date`);
    }
  } else {
    if (isOverdue) throw new Error(`Historical import reserved source ${record.source.orderId} cannot carry an overdue hold`);
    if (arrivalDate < cutoverBusinessDate) {
      throw new Error(`Historical import reserved source ${record.source.orderId} starts before the cutover date`);
    }
  }
  const stayTimeline = componentDates.flatMap((serviceDate) => pointsByDate.get(serviceDate)!).sort((left, right) => left.serviceDate.localeCompare(right.serviceDate) || left.inventoryUnitId.localeCompare(right.inventoryUnitId));
  const snapshot: OperationalSnapshot = {
    sourceId,
    sourceOrderId: record.source.orderId,
    cutoverObservedAt: cutoverAt,
    observedStatus: record.observedLifecycle === "IN_HOUSE" ? "CHECKED_IN" : "RESERVED",
    observedStayStatus: record.observedLifecycle === "IN_HOUSE" ? "IN_HOUSE" : "PLANNED",
    arrivalDate,
    departureDate,
    stayType: coreStayType(record, arrivalDate, departureDate),
    pricingOrigin: "MIGRATED_ACTUAL",
    historicalActualAmountMinor: record.pricing.currentContractAmountFen,
    currency: "CNY",
    stayTimeline,
    inventoryUnitId: stayTimeline.at(-1)!.inventoryUnitId
  };
  if (isOverdue) snapshot.overdueHoldStartsOn = departureDate;
  return snapshot;
}

function integerField(value: ObjectRecord, field: string): number | undefined {
  const candidate = value[field];
  return Number.isSafeInteger(candidate) ? candidate as number : undefined;
}

function validateFrozenSpecialRecords(
  manifest: HistoricalOrderImportManifest,
  snapshotsBySourceOrderId: ReadonlyMap<string, OperationalSnapshot>
): void {
  const memberRecords = manifest.records.filter((record) => record.pricing.basis === "MEMBER_ENTITLEMENT");
  const member = memberRecords[0];
  const memberSnapshot = member ? snapshotsBySourceOrderId.get(member.source.orderId) : undefined;
  const membership = member?.membership;
  const entitlement = membership && typeof membership.entitlement === "object" && membership.entitlement !== null && !Array.isArray(membership.entitlement)
    ? membership.entitlement as ObjectRecord
    : undefined;
  const consumption = membership && typeof membership.consumption === "object" && membership.consumption !== null && !Array.isArray(membership.consumption)
    ? membership.consumption as ObjectRecord
    : undefined;
  if (memberRecords.length !== 1
    || !member?.flags.includes("LEGACY_MEMBER_ENTITLEMENT_RECONSTRUCTION")
    || member.sourceStay.arrivalDate !== "2026-08-06"
    || member.sourceStay.departureDate !== "2026-08-25"
    || member.segments.length !== 1
    || member.segments[0]?.inventoryUnitCode !== "D01"
    || memberSnapshot?.stayTimeline.length !== 19
    || entitlement?.unit !== "ROOM_NIGHT"
    || integerField(entitlement, "quantity") !== 19
    || entitlement.serviceStartDate !== "2026-08-06"
    || entitlement.serviceEndDate !== "2026-08-24"
    || consumption?.unit !== "ROOM_NIGHT"
    || integerField(consumption, "quantity") !== 19) {
    throw new Error("Historical import legacy entitlement baseline no longer matches the approved 19-night reconstruction");
  }

  const overdueRecords = manifest.records.filter((record) => record.flags.includes("LIVE_DEPARTURE_DATE_UNCONFIRMED"));
  const overdue = overdueRecords[0];
  const overdueSnapshot = overdue ? snapshotsBySourceOrderId.get(overdue.source.orderId) : undefined;
  const cutoverBusinessDate = manifest.cutoverAt.slice(0, 10);
  if (overdueRecords.length !== 1
    || !overdue
    || overdue.observedLifecycle !== "IN_HOUSE"
    || overdue.sourceStay.arrivalDate !== "2026-08-08"
    || overdue.sourceStay.departureDate !== "2026-08-09"
    || overdue.segments.length !== 1
    || overdue.segments[0]?.inventoryUnitCode !== "306"
    || overdueSnapshot?.observedStatus !== "CHECKED_IN"
    || overdueSnapshot.overdueHoldStartsOn !== "2026-08-09"
    || overdue.sourceStay.departureDate > cutoverBusinessDate) {
    throw new Error("Historical import overdue in-house baseline no longer matches the approved 306 hold");
  }
}

function nextLocalDate(value: string): string {
  const dateValue = parseLocalDate(value);
  dateValue.setUTCDate(dateValue.getUTCDate() + 1);
  return dateValue.toISOString().slice(0, 10);
}

function contiguousDateRanges(values: readonly string[]): Array<{ arrivalDate: string; departureDate: string }> {
  const dates = [...new Set(values)].sort();
  const ranges: Array<{ arrivalDate: string; departureDate: string }> = [];
  for (const serviceDate of dates) {
    const current = ranges.at(-1);
    if (current && current.departureDate === serviceDate) {
      current.departureDate = nextLocalDate(serviceDate);
    } else {
      ranges.push({ arrivalDate: serviceDate, departureDate: nextLocalDate(serviceDate) });
    }
  }
  return ranges;
}

function anticipatedReconciliation(
  manifest: HistoricalOrderImportManifest,
  operationalClaimPoints: number
): HistoricalImportReconciliation {
  return {
    ...expectedReconciliation(manifest.records),
    sourceCount: manifest.expected.candidateCount,
    targetCount: manifest.expected.candidateCount,
    historicalArchiveTargets: manifest.expected.historicalAccommodationArchives,
    nonAccommodationArchiveTargets: manifest.expected.nonAccommodationArchives,
    operationalTargets: manifest.expected.operationalOrders,
    sourceOperationalSegmentEvidence: manifest.expected.operationalSegmentCount,
    operationalClaimPoints,
    historicalCollectionFacts: 0,
    activeOverdueHolds: 1,
    legacyMemberContracts: 1,
    entitlementLots: 1,
    entitlementCoveragePoints: 19,
    entitlementHoldFacts: 19,
    entitlementConsumeFacts: 19,
    amountMinor: manifest.expected.totalAccommodationAmountFen
  };
}

async function preflightNewHistoricalImport(
  trx: Transaction<Database>,
  propertyId: string,
  manifest: HistoricalOrderImportManifest,
  unitIdsByCode: ReadonlyMap<string, string>
): Promise<HistoricalImportReconciliation> {
  const operational = manifest.records.filter((record) => record.disposition === "OPERATIONAL");
  const snapshotsBySourceOrderId = new Map(operational.map((record) => [
    record.source.orderId,
    snapshotFor(record, `dry-run:${record.source.orderId}`, manifest.cutoverAt, unitIdsByCode)
  ]));
  validateFrozenSpecialRecords(manifest, snapshotsBySourceOrderId);

  const unitIds = [...new Set([...snapshotsBySourceOrderId.values()].flatMap((snapshot) => (
    snapshot.stayTimeline.map((point) => point.inventoryUnitId)
  )))].sort();
  const units = new Map<string, Awaited<ReturnType<typeof loadInventoryUnit>>>();
  for (const unitId of unitIds) units.set(unitId, await loadInventoryUnit(trx, propertyId, unitId));

  const occupancyByRoomDate = new Map<string, Array<{ inventoryUnitId: string; kind: "ROOM" | "BED"; sourceOrderId: string }>>();
  const datesByUnit = new Map<string, string[]>();
  for (const [sourceOrderId, snapshot] of snapshotsBySourceOrderId) {
    for (const point of snapshot.stayTimeline) {
      const unit = units.get(point.inventoryUnitId)!;
      const key = `${unit.roomId}:${point.serviceDate}`;
      const occupancies = occupancyByRoomDate.get(key) ?? [];
      const conflict = occupancies.find((existing) => (
        unit.kind === "ROOM" || existing.kind === "ROOM" || existing.inventoryUnitId === unit.id
      ));
      if (conflict) {
        throw new Error(`Historical import inventory conflict between sources ${conflict.sourceOrderId} and ${sourceOrderId} on ${point.serviceDate}`);
      }
      occupancies.push({ inventoryUnitId: unit.id, kind: unit.kind, sourceOrderId });
      occupancyByRoomDate.set(key, occupancies);
      datesByUnit.set(unit.id, [...(datesByUnit.get(unit.id) ?? []), point.serviceDate]);
    }
  }

  for (const [holdSourceOrderId, holdSnapshot] of snapshotsBySourceOrderId) {
    if (!holdSnapshot.overdueHoldStartsOn) continue;
    const holdUnit = units.get(holdSnapshot.inventoryUnitId)!;
    for (const [otherSourceOrderId, otherSnapshot] of snapshotsBySourceOrderId) {
      for (const point of otherSnapshot.stayTimeline) {
        if (point.serviceDate < holdSnapshot.overdueHoldStartsOn) continue;
        const occupiedUnit = units.get(point.inventoryUnitId)!;
        if (occupiedUnit.roomId === holdUnit.roomId
          && (holdUnit.kind === "ROOM" || occupiedUnit.kind === "ROOM" || occupiedUnit.id === holdUnit.id)) {
          throw new Error(`Historical import overdue hold for source ${holdSourceOrderId} conflicts with source ${otherSourceOrderId} on ${point.serviceDate}`);
        }
      }
    }

    const existingConflictResult = await sql<{ has_conflict: boolean }>`
      SELECT EXISTS (
        SELECT 1
        FROM inventory_claims AS claim
        WHERE claim.active IS TRUE
          AND claim.property_id = ${propertyId}
          AND claim.room_id = ${holdUnit.roomId}
          AND claim.service_date >= ${holdSnapshot.overdueHoldStartsOn}::date
          AND (
            ${holdUnit.id} = ${holdUnit.roomId}
            OR claim.inventory_unit_id = claim.room_id
            OR claim.inventory_unit_id = ${holdUnit.id}
          )
      ) OR EXISTS (
        SELECT 1
        FROM migration_overdue_inventory_holds AS hold
        WHERE hold.property_id = ${propertyId}
          AND hold.room_id = ${holdUnit.roomId}
          AND NOT EXISTS (
            SELECT 1
            FROM migration_overdue_inventory_hold_releases AS release
            WHERE release.hold_id = hold.id
          )
          AND (
            ${holdUnit.id} = ${holdUnit.roomId}
            OR hold.inventory_unit_id = hold.room_id
            OR hold.inventory_unit_id = ${holdUnit.id}
          )
      ) AS has_conflict
    `.execute(trx);
    if (existingConflictResult.rows[0]?.has_conflict) {
      throw new Error(`Historical import overdue hold inventory conflict for unit ${holdUnit.code} on or after ${holdSnapshot.overdueHoldStartsOn}`);
    }
  }

  for (const [unitId, dates] of [...datesByUnit].sort(([left], [right]) => left.localeCompare(right))) {
    for (const range of contiguousDateRanges(dates)) {
      const blockers = await inventoryFingerprint(trx, propertyId, unitId, range.arrivalDate, range.departureDate);
      if (blockers.length > 0) {
        throw new Error(`Historical import inventory conflict for unit ${units.get(unitId)!.code} in ${range.arrivalDate}..${range.departureDate}`);
      }
    }
  }
  const operationalClaimPoints = [...snapshotsBySourceOrderId.values()].reduce((sum, snapshot) => sum + snapshot.stayTimeline.length, 0);
  return anticipatedReconciliation(manifest, operationalClaimPoints);
}

function sourcePayload(record: HistoricalOrderImportRecord, operationalSnapshot: Record<string, unknown> | null): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...record };
  if (operationalSnapshot) payload.operationalSnapshot = operationalSnapshot;
  return payload;
}

async function policyAnchors(trx: Transaction<Database>, propertyId: string) {
  const rows = await trx.selectFrom("pricing_policy_versions").select(["id", "code", "stay_type"])
    .where("property_id", "=", propertyId).where("status", "=", "PUBLISHED").execute();
  const paid = rows.find((row) => row.stay_type === null);
  const free = rows.find((row) => row.code === "FREE" && row.stay_type === "FREE");
  if (!paid || !free) throw new Error("Historical import requires the published paid and FREE pricing anchors");
  return { paid: paid.id, free: free.id };
}

async function assertSourcesReplayable(trx: Transaction<Database>, propertyId: string, manifest: HistoricalOrderImportManifest) {
  const existing = await dbAny(trx).selectFrom("migration_order_sources").select(["source_order_id", "payload_hash"])
    .where("property_id", "=", propertyId).where("source_system", "=", manifest.sourceSystem).execute() as Array<{ source_order_id: string; payload_hash: string }>;
  const oldById = new Map(existing.map((row) => [row.source_order_id, row.payload_hash]));
  for (const record of manifest.records) {
    const oldHash = oldById.get(record.source.orderId);
    if (oldHash && oldHash !== record.canonicalPayloadHash) throw new Error(`Historical import source ${record.source.orderId} has a changed canonical payload`);
  }
  return oldById;
}

async function lockHistoricalImportScope(trx: Transaction<Database>, propertyId: string, sourceSystem: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`qintopia:historical-import:${propertyId}:${sourceSystem}`}, 0::bigint))`.execute(trx);
}

async function resolveOperationalUnits(trx: Transaction<Database>, propertyId: string, manifest: HistoricalOrderImportManifest) {
  const codes = [...new Set(manifest.records.filter((record) => record.disposition === "OPERATIONAL").flatMap((record) => record.segments.map((segment) => segment.inventoryUnitCode)))];
  const rows = codes.length === 0 ? [] : await trx.selectFrom("inventory_units").select(["id", "code"])
    .where("property_id", "=", propertyId).where("active", "=", true).where("code", "in", codes).execute();
  if (rows.length !== codes.length) throw new Error("Historical import manifest references unavailable inventory units");
  return new Map(rows.map((row) => [row.code, row.id]));
}

async function createMigratedClaims(trx: Transaction<Database>, propertyId: string, segmentId: string, timeline: Array<{ serviceDate: string; inventoryUnitId: string }>) {
  const datesByUnit = new Map<string, string[]>();
  for (const point of timeline) datesByUnit.set(point.inventoryUnitId, [...(datesByUnit.get(point.inventoryUnitId) ?? []), point.serviceDate]);
  const units = new Map<string, Awaited<ReturnType<typeof loadInventoryUnit>>>();
  for (const unitId of [...datesByUnit.keys()].sort()) units.set(unitId, await loadInventoryUnit(trx, propertyId, unitId));
  await lockRoomDays(trx, timeline.map((point) => ({ roomId: units.get(point.inventoryUnitId)!.roomId, serviceDate: point.serviceDate })));
  for (const [unitId, dates] of [...datesByUnit.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const unit = units.get(unitId)!;
    await createInventoryClaims(trx, { propertyId, unit, dates, sourceType: "ORDER_SEGMENT", sourceId: segmentId });
  }
}

async function reconcileCommittedImport(
  trx: Transaction<Database>,
  runId: string,
  manifest: HistoricalOrderImportManifest,
  expectInitialActiveState = true
): Promise<HistoricalImportReconciliation> {
  const result = await sql<{
    source_count: string;
    target_count: string;
    historical_archive_targets: string;
    non_accommodation_archive_targets: string;
    operational_targets: string;
    source_operational_segment_evidence: string;
    operational_claim_points: string;
    historical_collection_facts: string;
    active_overdue_holds: string;
    legacy_member_contracts: string;
    entitlement_lots: string;
    entitlement_coverage_points: string;
    entitlement_hold_facts: string;
    entitlement_consume_facts: string;
    amount_minor: string;
  }>`
    WITH run_sources AS (
      SELECT * FROM migration_order_sources WHERE run_id = ${runId}
    ), run_targets AS (
      SELECT target.*
      FROM migration_order_targets AS target
      JOIN run_sources AS source ON source.id = target.source_id
    ), run_orders AS (
      SELECT target.order_id AS id
      FROM run_targets AS target
      WHERE target.order_id IS NOT NULL
    )
    SELECT
      (SELECT count(*) FROM run_sources)::text AS source_count,
      (SELECT count(*) FROM run_targets)::text AS target_count,
      (SELECT count(*) FROM historical_order_archives AS archive JOIN run_targets AS target ON target.archive_id = archive.id WHERE archive.record_kind = 'MIGRATED_ARCHIVE')::text AS historical_archive_targets,
      (SELECT count(*) FROM historical_order_archives AS archive JOIN run_targets AS target ON target.archive_id = archive.id WHERE archive.record_kind = 'NON_ACCOMMODATION_ARCHIVE')::text AS non_accommodation_archive_targets,
      (SELECT count(*) FROM run_orders)::text AS operational_targets,
      (SELECT COALESCE(sum(jsonb_array_length(source.canonical_payload -> 'segments')), 0) FROM run_sources AS source WHERE source.disposition = 'OPERATIONAL')::text AS source_operational_segment_evidence,
      (SELECT count(*) FROM run_orders AS imported_order JOIN stays AS stay ON stay.order_id = imported_order.id JOIN stay_segments AS segment ON segment.stay_id = stay.id AND segment.segment_type = 'MIGRATED_INITIAL' JOIN inventory_claims AS claim ON claim.source_type = 'ORDER_SEGMENT' AND claim.source_id = segment.id)::text AS operational_claim_points,
      (SELECT count(*) FROM run_orders AS imported_order JOIN collection_facts AS fact ON fact.order_id = imported_order.id WHERE fact.command_id IS NULL)::text AS historical_collection_facts,
      (SELECT count(*) FROM migration_overdue_inventory_holds AS hold JOIN run_sources AS source ON source.id = hold.source_id LEFT JOIN migration_overdue_inventory_hold_releases AS release ON release.hold_id = hold.id WHERE release.id IS NULL)::text AS active_overdue_holds,
      (SELECT count(*) FROM member_contracts AS contract JOIN run_sources AS source ON source.id = contract.migration_source_id)::text AS legacy_member_contracts,
      (SELECT count(*) FROM entitlement_lots AS lot JOIN run_sources AS source ON source.id = lot.migration_source_id)::text AS entitlement_lots,
      (SELECT count(*) FROM coverage_items AS coverage JOIN run_orders AS imported_order ON imported_order.id = coverage.order_id)::text AS entitlement_coverage_points,
      (SELECT count(*) FROM entitlement_ledger AS ledger JOIN coverage_items AS coverage ON coverage.id = ledger.coverage_id JOIN run_orders AS imported_order ON imported_order.id = coverage.order_id WHERE ledger.entry_type = 'HOLD')::text AS entitlement_hold_facts,
      (SELECT count(*) FROM entitlement_ledger AS ledger JOIN coverage_items AS coverage ON coverage.id = ledger.coverage_id JOIN run_orders AS imported_order ON imported_order.id = coverage.order_id WHERE ledger.entry_type = 'CONSUME')::text AS entitlement_consume_facts,
      (SELECT COALESCE(sum(source.historical_actual_amount_minor), 0) FROM run_sources AS source)::text AS amount_minor
  `.execute(trx);
  const row = result.rows[0];
  if (!row) throw new Error("Historical import reconciliation query returned no result");
  const observed: HistoricalImportReconciliation = {
    ...expectedReconciliation(manifest.records),
    sourceCount: Number(row.source_count),
    targetCount: Number(row.target_count),
    historicalArchiveTargets: Number(row.historical_archive_targets),
    nonAccommodationArchiveTargets: Number(row.non_accommodation_archive_targets),
    operationalTargets: Number(row.operational_targets),
    sourceOperationalSegmentEvidence: Number(row.source_operational_segment_evidence),
    operationalClaimPoints: Number(row.operational_claim_points),
    historicalCollectionFacts: Number(row.historical_collection_facts),
    activeOverdueHolds: Number(row.active_overdue_holds),
    legacyMemberContracts: Number(row.legacy_member_contracts),
    entitlementLots: Number(row.entitlement_lots),
    entitlementCoveragePoints: Number(row.entitlement_coverage_points),
    entitlementHoldFacts: Number(row.entitlement_hold_facts),
    entitlementConsumeFacts: Number(row.entitlement_consume_facts),
    amountMinor: Number(row.amount_minor)
  };
  const expectedClaimPoints = manifest.records
    .filter((record) => record.disposition === "OPERATIONAL")
    .reduce((sum, record) => sum + snapshotFor(record, `reconcile:${record.source.orderId}`, manifest.cutoverAt, new Map(
      record.segments.map((segment) => [segment.inventoryUnitCode, segment.inventoryUnitCode])
    )).stayTimeline.length, 0);
  if (observed.sourceCount !== manifest.expected.candidateCount
    || observed.targetCount !== manifest.expected.candidateCount
    || observed.historicalArchiveTargets !== manifest.expected.historicalAccommodationArchives
    || observed.nonAccommodationArchiveTargets !== manifest.expected.nonAccommodationArchives
    || observed.operationalTargets !== manifest.expected.operationalOrders
    || observed.sourceOperationalSegmentEvidence !== manifest.expected.operationalSegmentCount
    || observed.operationalClaimPoints !== expectedClaimPoints
    || observed.historicalCollectionFacts !== 0
    || observed.legacyMemberContracts !== 1
    || observed.entitlementLots !== 1
    || observed.entitlementCoveragePoints !== 19
    || observed.entitlementHoldFacts !== 19
    || observed.entitlementConsumeFacts !== 19
    || observed.amountMinor !== manifest.expected.totalAccommodationAmountFen
    || (expectInitialActiveState && observed.activeOverdueHolds !== 1)) {
    throw new Error("Historical import reconciliation failed before commit");
  }
  return observed;
}

export async function applyHistoricalOrderImport(
  db: Kysely<Database>,
  input: HistoricalOrderImportManifest | string | unknown,
  authorization: HistoricalImportApprovalAuthorization
): Promise<HistoricalImportApplyReport> {
  const manifest = validatedManifest(input);
  assertFrozenImportBaseline(manifest);
  return db.transaction().setIsolationLevel("serializable").execute(async (trx) => {
    if (!await databaseReady(trx)) throw new Error("Historical import database is not ready for migration 037");
    const property = await resolveProperty(trx, manifest);
    await lockHistoricalImportScope(trx, property.id, manifest.sourceSystem);
    const approval = await consumeHistoricalImportApproval(trx, authorization, {
      manifestHash: manifest.manifestHash,
      propertyId: property.id,
      sourceSystem: manifest.sourceSystem,
      cutoverAt: manifest.cutoverAt
    });
    const anyTrx = dbAny(trx);
    const existingRun = await anyTrx.selectFrom("migration_import_runs").select(["id", "manifest_hash", "state"])
      .where("property_id", "=", property.id).where("source_system", "=", manifest.sourceSystem).where("idempotency_key", "=", manifest.idempotencyKey).executeTakeFirst() as { id: string; manifest_hash: string; state: string } | undefined;
    if (existingRun) {
      if (existingRun.manifest_hash !== manifest.manifestHash || existingRun.state !== "APPLIED") throw new Error("Historical import idempotency key conflicts with a different or incomplete manifest");
      const reconciliation = await reconcileCommittedImport(trx, existingRun.id, manifest, false);
      return { mode: "REPLAYED" as const, runId: existingRun.id, approval, manifestHash: manifest.manifestHash, propertyId: property.id, replayedSources: manifest.records.length, newSources: 0, expected: manifest.expected, reconciliation };
    }
    const existingSources = await assertSourcesReplayable(trx, property.id, manifest);
    if (existingSources.size > 0) {
      if (existingSources.size !== manifest.records.length) throw new Error("Historical import cannot mix replayed sources with a partial new batch");
      const run = await anyTrx.selectFrom("migration_import_runs as run").innerJoin("migration_order_sources as source", "source.run_id", "run.id").select("run.id")
        .where("source.property_id", "=", property.id).where("source.source_system", "=", manifest.sourceSystem).where("run.state", "=", "APPLIED").limit(1).executeTakeFirst();
      if (!run) throw new Error("Historical import source replay does not belong to an applied manifest run");
      const reconciliation = await reconcileCommittedImport(trx, run.id, manifest, false);
      return { mode: "REPLAYED" as const, runId: run.id, approval, manifestHash: manifest.manifestHash, propertyId: property.id, replayedSources: manifest.records.length, newSources: 0, expected: manifest.expected, reconciliation };
    }
    const unitIdsByCode = await resolveOperationalUnits(trx, property.id, manifest);
    await preflightNewHistoricalImport(trx, property.id, manifest, unitIdsByCode);
    const anchors = await policyAnchors(trx, property.id);
    const runId = importId("run");
    await anyTrx.insertInto("migration_import_runs").values({ id: runId, property_id: property.id, source_system: manifest.sourceSystem, idempotency_key: manifest.idempotencyKey, request_hash: stableHash({ manifestHash: manifest.manifestHash, idempotencyKey: manifest.idempotencyKey, approvalHash: approval.approvalHash }), manifest_hash: manifest.manifestHash, correlation_id: `historical-import:${manifest.manifestHash.slice(0, 16)}`, cutover_observed_at: manifest.cutoverAt, cutover_business_date: manifest.cutoverAt.slice(0, 10), state: "EXECUTING", input_summary: { manifestHash: manifest.manifestHash, expected: manifest.expected, generatorVersion: manifest.generatorVersion, approval }, reconciliation_summary: null, completed_at: null }).execute();
    for (const file of manifest.source.sourceFiles) await anyTrx.insertInto("migration_import_files").values({ id: importId("file"), run_id: runId, source_role: file.role, file_name: file.fileName, sha256: file.sha256, exported_at: file.exportedAt, row_count: file.rowCount }).execute();
    for (const record of manifest.records) {
      const sourceId = importId("source");
      const snapshot = record.disposition === "OPERATIONAL" ? snapshotFor(record, sourceId, manifest.cutoverAt, unitIdsByCode) : null;
      const canonicalPayload = sourcePayload(record, snapshot);
      const guest = sourceGuestSnapshot(record);
      const normalizedDates = persistedSourceDates(record);
      const mappedChannel = record.disposition === "OPERATIONAL"
        && (record.pricing.basis === "MEMBER_ENTITLEMENT" || record.pricing.basis === "FREE")
        ? null
        : record.channel.normalized;
      const channelOrderReference = mappedChannel === null ? null : record.channel.externalOrderNo;
      const channelReferenceMissingReason = mappedChannel === null ? null : record.channel.externalOrderNoStatus === "HISTORICAL_NOT_RECORDED" ? "HISTORICAL_NOT_RECORDED" : null;
      await anyTrx.insertInto("migration_order_sources").values({
        id: sourceId, run_id: runId, property_id: property.id, source_system: manifest.sourceSystem, source_order_id: record.source.orderId, source_row: record.source.auditRow,
        disposition: normalizedDisposition(record), raw_channel: record.channel.raw, mapped_channel_code: mappedChannel,
        channel_order_reference: channelOrderReference, channel_reference_missing_reason: channelReferenceMissingReason,
        arrival_date: snapshot ? snapshot.arrivalDate : normalizedDates.arrivalDate, departure_date: snapshot ? snapshot.departureDate : normalizedDates.departureDate,
        observed_order_status: snapshot ? snapshot.observedStatus : null, observed_stay_status: snapshot ? snapshot.observedStayStatus : null,
        stay_type: record.disposition === "OPERATIONAL" ? snapshot!.stayType : record.stayType, pricing_basis: record.pricing.basis,
        guest_snapshot: guest, historical_actual_amount_minor: record.pricing.currentContractAmountFen, currency: "CNY", operational_snapshot_payload: snapshot,
        canonical_payload: canonicalPayload, payload_hash: record.canonicalPayloadHash, manual_confirmation: record.manualConfirmation
      }).execute();
      if (record.disposition !== "OPERATIONAL") {
        const evidence = record.pricing.evidence;
        const archiveId = importId("archive");
        const sourceStatus = archivedSourceStatus(record);
        // Project all immutable source-owned fields in SQL so the archive cannot drift from its source row.
        await sql`
          INSERT INTO historical_order_archives (
            id, source_id, property_id, record_kind, source_order_id,
            guest_full_name, guest_nickname, guest_phone,
            mapped_channel_code, channel_order_reference, channel_reference_missing_reason,
            arrival_date, departure_date, stay_type, source_status,
            historical_actual_amount_minor, lodging_subtotal_minor, checkout_amount_minor,
            amount_difference_reason, currency, canonical_payload, allowed_actions
          )
          SELECT
            ${archiveId}, source.id, source.property_id,
            ${record.disposition === "NON_ACCOMMODATION_ARCHIVE" ? "NON_ACCOMMODATION_ARCHIVE" : "MIGRATED_ARCHIVE"}, source.source_order_id,
            source.guest_snapshot ->> 'fullName', source.guest_snapshot ->> 'nickname', source.guest_snapshot ->> 'phone',
            source.mapped_channel_code, source.channel_order_reference, source.channel_reference_missing_reason,
            source.arrival_date, source.departure_date, source.stay_type, ${sourceStatus},
            source.historical_actual_amount_minor, ${evidence.auditHistoricalAmountFen ?? null}, ${evidence.checkoutAccommodationAmountFen ?? null},
            ${evidence.amountReconciliation ?? null}, source.currency, source.canonical_payload, '[]'::jsonb
          FROM migration_order_sources AS source
          WHERE source.id = ${sourceId}
        `.execute(trx);
        await anyTrx.insertInto("migration_order_targets").values({ id: importId("target"), source_id: sourceId, archive_id: archiveId, order_id: null }).execute();
        continue;
      }
      const orderId = importId("order"); const stayId = importId("stay"); const amendmentId = importId("amendment"); const segmentId = importId("segment"); const revisionId = importId("revision");
      const memberContractId = record.pricing.basis === "MEMBER_ENTITLEMENT" ? importId("contract") : null;
      if (memberContractId) await anyTrx.insertInto("member_contracts").values({ id: memberContractId, property_id: property.id, member_id: null, member_name: guest.fullName, status: "ACTIVE", valid_from: record.sourceStay.arrivalDate, valid_until: sourceDates(record).at(-1)!, version: 1, membership_order_id: null, migration_source_id: sourceId }).execute();
      const snapshotPayload = snapshot!;
      await anyTrx.insertInto("orders").values({ id: orderId, property_id: property.id, status: snapshotPayload.observedStatus, stay_type: snapshotPayload.stayType, arrival_date: snapshotPayload.arrivalDate, departure_date: snapshotPayload.departureDate, primary_guest_snapshot: guest, booking_channel_code: record.pricing.basis === "MEMBER_ENTITLEMENT" || record.pricing.basis === "FREE" ? null : record.channel.normalized, channel_order_reference: record.pricing.basis === "MEMBER_ENTITLEMENT" || record.pricing.basis === "FREE" ? null : record.channel.externalOrderNo, free_stay_reason: snapshotPayload.stayType === "FREE" ? (typeof record.manualConfirmation.reason === "string" && record.manualConfirmation.reason.trim() ? record.manualConfirmation.reason : "MIGRATED_FREE_STAY") : null, free_stay_category_code: snapshotPayload.stayType === "FREE" ? (record.stayType === "FREE_RECEPTION" ? "RECEPTION" : "VOLUNTEER") : null, pricing_policy_version_id: snapshotPayload.stayType === "FREE" ? anchors.free : anchors.paid, member_id: null, member_contract_id: memberContractId, current_revision_id: null, version: 1, migration_source_id: sourceId }).execute();
      await anyTrx.insertInto("order_occupants").values({ id: importId("occupant"), order_id: orderId, ordinal: 1, role: "PRIMARY", full_name: guest.fullName, nickname: guest.nickname, phone: guest.phone, document_number: null, created_by_command_id: null }).execute();
      await anyTrx.insertInto("stays").values({ id: stayId, order_id: orderId, status: snapshotPayload.observedStayStatus }).execute();
      await anyTrx.insertInto("amendments").values({ id: amendmentId, order_id: orderId, sequence: 1, amendment_type: "MIGRATED_OPERATIONAL_SNAPSHOT", reason_code: "HISTORICAL_IMPORT", reason_note: "历史订单运营快照导入", prior_version: 0, new_version: 1, payload: snapshotPayload, command_id: null }).execute();
      await anyTrx.insertInto("stay_segments").values({ id: segmentId, stay_id: stayId, sequence: 1, inventory_unit_id: snapshotPayload.inventoryUnitId, arrival_date: snapshotPayload.arrivalDate, departure_date: snapshotPayload.departureDate, segment_type: "MIGRATED_INITIAL", supersedes_segment_id: null, amendment_id: amendmentId }).execute();
      await anyTrx.insertInto("pricing_revisions").values({ id: revisionId, order_id: orderId, revision_no: 1, amendment_id: amendmentId, policy_version_id: snapshotPayload.stayType === "FREE" ? anchors.free : anchors.paid, arrival_date: snapshotPayload.arrivalDate, departure_date: snapshotPayload.departureDate, coverage_set: JSON.stringify([]), cash_lines: JSON.stringify([{ lineKind: "MIGRATED_ACTUAL", historicalActualAmountMinor: record.pricing.currentContractAmountFen, currency: "CNY" }]), policy_base_amount_minor: null, pricing_basis: record.pricing.basis, manual_adjustment_minor: 0, current_contract_amount_minor: record.pricing.currentContractAmountFen, currency: "CNY", pricing_origin: "MIGRATED_ACTUAL" }).execute();
      await anyTrx.updateTable("orders").set({ current_revision_id: revisionId }).where("id", "=", orderId).execute();
      await createMigratedClaims(trx, property.id, segmentId, snapshotPayload.stayTimeline as Array<{ serviceDate: string; inventoryUnitId: string }>);
      if (memberContractId) {
        const lotId = importId("lot");
        await anyTrx.insertInto("entitlement_lots").values({ id: lotId, contract_id: memberContractId, unit_kind: "ROOM_NIGHT", total_units: (snapshotPayload.stayTimeline as Array<unknown>).length, expires_on: sourceDates(record).at(-1)!, version: 1, migration_source_id: sourceId }).execute();
        for (const point of snapshotPayload.stayTimeline as Array<{ serviceDate: string; inventoryUnitId: string }>) {
          const coverageId = importId("coverage");
          await anyTrx.insertInto("coverage_items").values({ id: coverageId, order_id: orderId, contract_id: memberContractId, lot_id: lotId, inventory_unit_id: point.inventoryUnitId, service_date: point.serviceDate, unit_kind: "ROOM_NIGHT", status: "HELD", held_by_revision_id: revisionId }).execute();
          await anyTrx.insertInto("entitlement_ledger").values({ fact_id: importId("fact"), lot_id: lotId, entry_type: "HOLD", quantity_delta: -1, service_date: point.serviceDate, order_id: orderId, coverage_id: coverageId, reason: "MIGRATED_LEGACY_ENTITLEMENT_HOLD", command_id: null }).execute();
          await anyTrx.updateTable("coverage_items").set({ status: "CONSUMED" }).where("id", "=", coverageId).execute();
          await anyTrx.insertInto("entitlement_ledger").values({ fact_id: importId("fact"), lot_id: lotId, entry_type: "CONSUME", quantity_delta: 0, service_date: point.serviceDate, order_id: orderId, coverage_id: coverageId, reason: "MIGRATED_LEGACY_ENTITLEMENT_CONSUME", command_id: null }).execute();
        }
      }
      if (record.flags.includes("LIVE_DEPARTURE_DATE_UNCONFIRMED")) {
        const unit = await loadInventoryUnit(trx, property.id, snapshotPayload.inventoryUnitId as string);
        await anyTrx.insertInto("migration_overdue_inventory_holds").values({ id: importId("hold"), source_id: sourceId, order_id: orderId, property_id: property.id, room_id: unit.roomId, inventory_unit_id: unit.id, starts_on: record.sourceStay.departureDate, cutover_observed_at: manifest.cutoverAt }).execute();
      }
      await anyTrx.insertInto("migration_order_targets").values({ id: importId("target"), source_id: sourceId, archive_id: null, order_id: orderId }).execute();
    }
    const reconciliation = await reconcileCommittedImport(trx, runId, manifest);
    await anyTrx.updateTable("migration_import_runs").set({ state: "APPLIED", reconciliation_summary: reconciliation, completed_at: new Date() }).where("id", "=", runId).where("state", "=", "EXECUTING").execute();
    return { mode: "APPLIED" as const, runId, approval, manifestHash: manifest.manifestHash, propertyId: property.id, replayedSources: 0, newSources: manifest.records.length, expected: manifest.expected, reconciliation };
  });
}

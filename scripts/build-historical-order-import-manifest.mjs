#!/usr/bin/env node
/**
 * Builds the controlled, PII-bearing input for the historical-order importer.
 * This file deliberately lives in Git; the generated manifest and review do not.
 * It uses the Codex bundled Python/openpyxl runtime so formula values are read
 * through a spreadsheet parser instead of guessed from XLSX XML.
 */
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fchmodSync, fsyncSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_PYTHON = "/Users/feather/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3";
const TOOL_VERSION = "historical-order-manifest-v1";
const IMPORT_START = "2026-03-13";
const EXPECTED = Object.freeze({
  candidateCount: 535,
  historicalAccommodationArchives: 490,
  operationalOrders: 44,
  nonAccommodationArchives: 1,
  operationalSegmentCount: 50,
  totalAccommodationAmountFen: 28_140_438,
  historicalAccommodationAmountFen: 22_105_406,
  operationalAccommodationAmountFen: 6_035_032
});

function usage() {
  console.error("Usage: node scripts/build-historical-order-import-manifest.mjs --workbook path --orders path --costs path --checkouts path --cutover-at ISO_TIMESTAMP --approved-operational-tuples-sha256 SHA256 --output-dir path");
  console.error("Inspect only: node scripts/build-historical-order-import-manifest.mjs --workbook path --orders path --costs path --checkouts path --cutover-at ISO_TIMESTAMP --inspect-operational-tuples");
  process.exitCode = 2;
}

const SHANGHAI_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\+08:00$/;
const SHA256 = /^[a-f0-9]{64}$/;

function strictShanghaiTimestamp(value, label, { minutePrecision = false } = {}) {
  const text = String(value ?? "").trim();
  const match = text.match(SHANGHAI_TIMESTAMP);
  if (!match) throw new Error(`${label} timestamp is invalid; expected an ISO timestamp with +08:00`);
  const [, datePart, hourText, minuteText, secondText, fraction = ""] = match;
  const midnight = Date.parse(`${datePart}T00:00:00Z`);
  if (Number.isNaN(midnight) || new Date(midnight).toISOString().slice(0, 10) !== datePart
    || Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59) {
    throw new Error(`${label} timestamp is invalid`);
  }
  if (minutePrecision && (secondText !== "00" || /[1-9]/.test(fraction))) {
    throw new Error(`${label} timestamp must use exact minute precision`);
  }
  const epoch = new Date(text).getTime();
  if (Number.isNaN(epoch)) throw new Error(`${label} timestamp is invalid`);
  return { text, epoch, datePart, minuteLabel: `${datePart} ${hourText}:${minuteText}` };
}

export function parseArgs(args) {
  const options = {};
  const pathOptions = new Map([
    ["--workbook", "workbook"],
    ["--orders", "orders"],
    ["--costs", "costs"],
    ["--checkouts", "checkouts"],
    ["--output-dir", "outputDir"]
  ]);
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    const optionName = pathOptions.get(value);
    if (optionName) {
      if (!args[i + 1] || options[optionName]) return null;
      options[optionName] = resolve(args[i + 1]);
      i += 1;
    } else if (value === "--cutover-at") {
      if (!args[i + 1] || options.cutoverAt) return null;
      options.cutoverAt = args[i + 1];
      i += 1;
    } else if (value === "--approved-operational-tuples-sha256") {
      if (!args[i + 1] || options.approvedOperationalTuplesSha256) return null;
      options.approvedOperationalTuplesSha256 = args[i + 1];
      i += 1;
    } else if (value === "--inspect-operational-tuples") {
      if (options.inspectOperationalTuples) return null;
      options.inspectOperationalTuples = true;
    } else {
      return null;
    }
  }
  const required = ["workbook", "orders", "costs", "checkouts", "cutoverAt"];
  if (required.some((key) => !options[key])) return null;
  try {
    strictShanghaiTimestamp(options.cutoverAt, "Cutover");
  } catch {
    return null;
  }
  if (options.inspectOperationalTuples) {
    if (options.approvedOperationalTuplesSha256 || options.outputDir) return null;
  } else if (!SHA256.test(options.approvedOperationalTuplesSha256) || !options.outputDir) {
    return null;
  }
  return options;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashStable(value) {
  return sha256(stable(value));
}

function clean(value) {
  if (value === undefined || value === null || value === "") return null;
  return typeof value === "string" ? value.trim() || null : value;
}

function sourceDate(value) {
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match) throw new Error(`Expected a source date, received ${JSON.stringify(value)}`);
  const result = match[1];
  const instant = Date.parse(`${result}T00:00:00Z`);
  if (Number.isNaN(instant) || new Date(instant).toISOString().slice(0, 10) !== result) {
    throw new Error(`Expected a valid source date, received ${JSON.stringify(value)}`);
  }
  return result;
}

function amountFen(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Expected a currency amount, received ${JSON.stringify(value)}`);
  return Math.round((number + Number.EPSILON) * 100);
}

function normalizedUnit(raw) {
  const source = clean(raw);
  if (!source) throw new Error("An operational segment has no source room");
  const aliases = { i01: "C01", i02: "C02", i03: "C03", i04: "C04" };
  const withoutSuffix = source.replace(/小$/, "");
  if (aliases[withoutSuffix]) return aliases[withoutSuffix];
  const dormBed = withoutSuffix.match(/^(\d{3})([A-D])$/);
  return dormBed ? `${dormBed[1]}-${dormBed[2]}` : withoutSuffix;
}

export function normalizedChannel(raw) {
  const source = clean(raw);
  const confirmed = {
    "自来客": "WECOM",
    "小红书": "WECOM",
    "小红书小程序": "WECOM",
    "微信": "WECOM",
    "企业微信": "WECOM",
    "Agoda": "YOUMUDAO",
    "Aogda": "YOUMUDAO",
    "游牧岛": "YOUMUDAO",
    "携程": "CTRIP",
    "美团酒店": "MEITUAN",
    "美团民宿": "MEITUAN"
  }[source ?? ""];
  if (confirmed) return confirmed;
  throw new Error(`Unsupported source channel ${JSON.stringify(source)}`);
}

function pricingBasis(channel, stayType) {
  if (stayType === "MEMBER_ENTITLEMENT") return "MEMBER_ENTITLEMENT";
  if (stayType === "FREE" || stayType === "FREE_RECEPTION") return "FREE";
  return channel === "WECOM" ? "POLICY" : "CHANNEL_CONTRACT";
}

function recordDisposition(row) {
  if (row["V1生命周期建议"] === "NON_ACCOMMODATION_ARCHIVE") return "NON_ACCOMMODATION_ARCHIVE";
  if (row["V1生命周期建议"] === "IN_HOUSE" || row["V1生命周期建议"] === "RESERVED") return "OPERATIONAL";
  return "HISTORICAL_ARCHIVE";
}

function lifecycle(row) {
  const override = clean(row["V3人工确认实际状态"]);
  if (override) return override;
  if (row["V1生命周期建议"] === "IN_HOUSE" || row["V1生命周期建议"] === "RESERVED") return row["V1生命周期建议"];
  return "ARCHIVED";
}

function stayType(row) {
  const override = clean(row["V3人工确认业务类型"]);
  if (override === "MEMBER_ENTITLEMENT" || override === "FREE_RECEPTION") return override;
  return row["入住类型"] === "免费房" ? "FREE" : "STANDARD";
}

export function isAutoAdopted(row) {
  const value = clean(row["建议自动采用"]);
  if (value === null || value === "否") return false;
  if (value === "建议采用" || value === "是") return true;
  throw new Error(`Unsupported reviewed auto-adoption value ${JSON.stringify(value)}`);
}

function guestSnapshot(row, operational) {
  const automatic = isAutoAdopted(row);
  const name = clean(row["人工确认姓名"]) ?? (automatic ? clean(row["候选姓名"]) : null) ?? clean(row["源姓名"]);
  const confirmedNickname = clean(row["人工确认花名"]) ?? (automatic ? clean(row["候选花名"]) : null);
  const nickname = confirmedNickname ?? (operational && name ? name : null);
  const phone = clean(row["人工确认手机号"]) ?? (automatic ? clean(row["候选手机号"]) : null) ?? clean(row["源手机号"]);
  return {
    name,
    nickname,
    phone,
    nameProvenance: clean(row["人工确认姓名"]) ? "MANUAL_CONFIRMATION" : automatic && clean(row["候选姓名"]) ? "FEISHU_UNIQUE_MATCH" : "SOURCE_ORDER",
    nicknameProvenance: clean(row["人工确认花名"]) ? "MANUAL_CONFIRMATION" : automatic && clean(row["候选花名"]) ? "FEISHU_UNIQUE_MATCH" : nickname ? "FULL_NAME_DISPLAY_FALLBACK" : "HISTORICAL_NOT_RECORDED",
    phoneProvenance: clean(row["人工确认手机号"]) ? "MANUAL_CONFIRMATION" : automatic && clean(row["候选手机号"]) ? "FEISHU_UNIQUE_MATCH" : phone ? "SOURCE_ORDER" : "HISTORICAL_NOT_RECORDED"
  };
}

function serviceNightCount(arrivalDate, departureDate) {
  const arrival = Date.parse(`${arrivalDate}T00:00:00Z`);
  const departure = Date.parse(`${departureDate}T00:00:00Z`);
  const count = (departure - arrival) / 86_400_000;
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error("A reviewed entitlement segment must have a positive whole-night interval");
  return count;
}

function previousLocalDate(value) {
  const instant = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(instant)) throw new Error("A reviewed entitlement segment has an invalid departure date");
  return new Date(instant - 86_400_000).toISOString().slice(0, 10);
}

export function buildOperationalSegments(sourceSegments) {
  const segments = [];
  let excludedPlaceholderCount = 0;
  for (const segment of sourceSegments) {
    const sourceRoom = clean(segment["房间号"]);
    const segmentAmountFen = amountFen(segment["住宿金额"]);
    if (sourceRoom === "未排房" && segmentAmountFen === 0) {
      excludedPlaceholderCount += 1;
      continue;
    }
    segments.push({
      sequence: Number(segment["段序号"]),
      sourceOrderRow: segment._row,
      sourceRoom,
      inventoryUnitCode: normalizedUnit(sourceRoom),
      roomType: clean(segment["房型"]),
      arrivalDate: sourceDate(segment["入住日期"]),
      departureDate: sourceDate(segment["离店日期"]),
      amountFen: segmentAmountFen,
      sourceStatus: clean(segment["入住状态"])
    });
  }
  return { segments, excludedPlaceholderCount };
}

export function deriveReviewedSpecialFields({
  cutoverAt,
  disposition,
  observedLifecycle,
  stayType: reviewedStayType,
  sourceStay,
  segments,
  guest,
  manualConfirmation,
  excludedPlaceholderCount
}) {
  const flags = [];
  let membership = null;
  const manualBusinessType = clean(manualConfirmation.businessType);

  if (excludedPlaceholderCount > 0) {
    flags.push("ZERO_VALUE_PLACEHOLDER_SEGMENT_EXCLUDED");
    if (excludedPlaceholderCount !== 1
      || disposition !== "OPERATIONAL"
      || observedLifecycle !== "RESERVED"
      || segments.length !== 1
      || segments[0].inventoryUnitCode !== "A03"
      || segments[0].amountFen !== 102_000) {
      throw new Error("The reviewed zero-value unassigned-room exclusion no longer matches the approved operational segment");
    }
  }

  if (manualBusinessType === "MEMBER_ENTITLEMENT") {
    if (reviewedStayType !== "MEMBER_ENTITLEMENT"
      || disposition !== "OPERATIONAL"
      || observedLifecycle !== "IN_HOUSE"
      || segments.length !== 1
      || !guest.name) {
      throw new Error("The reviewed legacy member-entitlement record is incomplete");
    }
    const entitlementSegment = segments[0];
    const quantity = serviceNightCount(entitlementSegment.arrivalDate, entitlementSegment.departureDate);
    if (quantity !== 19) throw new Error("The reviewed legacy member entitlement must cover exactly 19 room nights");
    flags.push("LEGACY_MEMBER_ENTITLEMENT_RECONSTRUCTION");
    membership = {
      memberKeyStrategy: "LEGACY_NAME_ONLY",
      memberName: guest.name,
      memberId: null,
      channel: null,
      externalOrderNo: null,
      entitlement: {
        unit: "ROOM_NIGHT",
        quantity,
        serviceStartDate: entitlementSegment.arrivalDate,
        serviceEndDate: previousLocalDate(entitlementSegment.departureDate),
        reason: "PREVIOUS_STAY_BALANCE_APPLIED"
      },
      consumption: { unit: "ROOM_NIGHT", quantity }
    };
  }

  if (manualBusinessType === "FREE_RECEPTION") {
    flags.push("FREE_RECEPTION_CONFIRMED");
    if (reviewedStayType !== "FREE_RECEPTION"
      || disposition !== "OPERATIONAL"
      || observedLifecycle !== "RESERVED"
      || segments.length !== 1
      || segments[0].inventoryUnitCode !== "A03") {
      throw new Error("The reviewed free-reception record no longer matches the approved reservation");
    }
  }

  const cutoverBusinessDate = sourceDate(cutoverAt);
  const expiredInHouse = disposition === "OPERATIONAL"
    && observedLifecycle === "IN_HOUSE"
    && sourceStay.departureDate <= cutoverBusinessDate;
  if (expiredInHouse) {
    if (!clean(manualConfirmation.latestCorrection) || !clean(manualConfirmation.correctionSource)) {
      throw new Error("An expired reviewed in-house record requires an explicit V4 correction and correction source");
    }
    if (segments.length !== 1 || segments[0].inventoryUnitCode !== "306") {
      throw new Error("The reviewed overdue in-house correction no longer matches the approved room hold");
    }
    flags.push("LIVE_DEPARTURE_DATE_UNCONFIRMED", "KEEP_INVENTORY_UNAVAILABLE");
  }

  return { flags, membership };
}

export function assertReviewedSpecialCaseCardinality(records) {
  const expectedFlags = [
    "LEGACY_MEMBER_ENTITLEMENT_RECONSTRUCTION",
    "FREE_RECEPTION_CONFIRMED",
    "LIVE_DEPARTURE_DATE_UNCONFIRMED",
    "ZERO_VALUE_PLACEHOLDER_SEGMENT_EXCLUDED"
  ];
  for (const flag of expectedFlags) {
    const count = records.filter((record) => record.flags.includes(flag)).length;
    if (count !== 1) throw new Error(`Reviewed special-case cardinality mismatch for ${flag}: expected 1, got ${count}`);
  }
}

function operationalTuple(record) {
  return {
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
  };
}

export function operationalTupleHash(records) {
  const operational = records
    .filter((record) => record.disposition === "OPERATIONAL")
    .map(operationalTuple)
    .sort((left, right) => left.sourceOrderId < right.sourceOrderId ? -1 : left.sourceOrderId > right.sourceOrderId ? 1 : 0);
  return hashStable(operational);
}

export function inspectOperationalTuples(records) {
  const operationalCount = records.filter((record) => record.disposition === "OPERATIONAL").length;
  if (operationalCount !== EXPECTED.operationalOrders) {
    throw new Error(`Expected ${EXPECTED.operationalOrders} operational tuples, got ${operationalCount}`);
  }
  const operationalSourceIds = records
    .filter((record) => record.disposition === "OPERATIONAL")
    .map((record) => record.source.orderId);
  if (new Set(operationalSourceIds).size !== operationalSourceIds.length) {
    throw new Error("Operational tuple source order ids must be unique");
  }
  return {
    mode: "INSPECTION_ONLY",
    approved: false,
    operationalOrderCount: operationalCount,
    operationalTuplesSha256: operationalTupleHash(records)
  };
}

export function assertApprovedOperationalTupleHash(records, approvedHash) {
  if (!SHA256.test(String(approvedHash ?? ""))) {
    throw new Error("A previously approved operational tuple SHA-256 is required");
  }
  const inspection = inspectOperationalTuples(records);
  if (inspection.operationalTuplesSha256 !== approvedHash) {
    throw new Error("Approved operational tuple hash mismatch; stop and obtain a new human review");
  }
  return inspection.operationalTuplesSha256;
}

const PYTHON_LOADER = String.raw`
import json, sys
from datetime import date, datetime
from openpyxl import load_workbook

def serial(value):
    if isinstance(value, (datetime, date)):
        return value.isoformat(sep=" ") if isinstance(value, datetime) else value.isoformat()
    return value

def read_sheet(ws):
    ws.reset_dimensions()
    source = ws.iter_rows(values_only=True)
    headers = [str(value).strip() if value is not None else "" for value in next(source)]
    records = []
    for row_number, values in enumerate(source, start=2):
        if not any(value is not None for value in values):
            continue
        records.append({"_row": row_number, **{headers[i]: serial(values[i] if i < len(values) else None) for i in range(len(headers))}})
    return records

workbook = load_workbook(sys.argv[1], read_only=True, data_only=True)
audit_headers = [str(value).strip() if value is not None else "" for value in next(workbook["订单审核"].iter_rows(values_only=True))]
print(json.dumps({
    "auditHeaders": audit_headers,
    "audit": read_sheet(workbook["订单审核"]),
    "orders": read_sheet(workbook["订单主表"]),
    "costs": read_sheet(workbook["住宿明细"]),
    "checkouts": read_sheet(workbook["结账明细"]),
    "sources": read_sheet(workbook["来源校验"])
}, ensure_ascii=False, separators=(",", ":")))
`;

export function loadWorkbook(workbook) {
  const candidates = [process.env.CODEX_BUNDLED_PYTHON, DEFAULT_PYTHON, "python3"].filter(Boolean);
  let lastError;
  for (const python of candidates) {
    try {
      return JSON.parse(execFileSync(python, ["-c", PYTHON_LOADER, workbook], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"]
      }));
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Could not run bundled spreadsheet runtime: ${lastError?.message ?? "unknown error"}`);
}

const PYTHON_EXPORT_INSPECTOR = String.raw`
import json, re, sys
from datetime import date, datetime
from openpyxl import load_workbook

def serial(value):
    if isinstance(value, datetime):
        return value.isoformat(sep=" ")
    if isinstance(value, date):
        return value.isoformat()
    return value

results = []
for item in json.loads(sys.argv[1]):
    workbook = load_workbook(item["path"], read_only=True, data_only=True)
    if len(workbook.worksheets) != 1:
        raise RuntimeError(f'{item["role"]} must contain exactly one worksheet')
    sheet = workbook.worksheets[0]
    sheet.reset_dimensions()
    source = sheet.iter_rows(values_only=True)
    first_rows = []
    for _ in range(4):
        first_rows.append(next(source, ()))
    metadata = str(first_rows[2][0] if len(first_rows[2]) else "")
    match = re.search(r"导出时间[：:]\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})", metadata)
    if not match:
        raise RuntimeError(f'{item["role"]} has no parseable export timestamp in row 3')
    header = first_rows[3]
    if not any(value not in (None, "") for value in header):
        raise RuntimeError(f'{item["role"]} has no header row 4')
    headers = [str(value).strip() if value is not None else "" for value in header]
    rows = []
    for row_number, values in enumerate(source, start=5):
        if not any(value not in (None, "") for value in values):
            continue
        rows.append({"_row": row_number, **{
            headers[index]: serial(values[index] if index < len(values) else None)
            for index in range(len(headers))
        }})
    results.append({
        "role": item["role"],
        "rowCount": len(rows),
        "exportedAt": f"{match.group(1)}T{match.group(2)}+08:00",
        "sheetName": sheet.title,
        "headers": headers,
        "rows": rows
    })
print(json.dumps(results, ensure_ascii=False, separators=(",", ":")))
`;

function runPython(script, args, errorLabel) {
  const candidates = [process.env.CODEX_BUNDLED_PYTHON, DEFAULT_PYTHON, "python3"].filter(Boolean);
  let lastError;
  for (const python of candidates) {
    try {
      return JSON.parse(execFileSync(python, ["-c", script, ...args], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"]
      }));
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`${errorLabel}: ${lastError?.message ?? "unknown error"}`);
}

function loadSourceExports(options) {
  const inputs = [
    { role: "ORDER_EXPORT", path: options.orders },
    { role: "COST_EXPORT", path: options.costs },
    { role: "CHECKOUT_EXPORT", path: options.checkouts }
  ];
  const inspected = runPython(PYTHON_EXPORT_INSPECTOR, [JSON.stringify(inputs)], "Could not inspect source exports");
  return inspected.map((entry, index) => ({
    ...entry,
    fileName: basename(inputs[index].path),
    sha256: sha256(readFileSync(inputs[index].path))
  }));
}

const auxiliaryRoleByName = {
    "QinTopia-order-import-review-from-2026-03-13-v0.xlsx": "FEISHU_MATCH_BASELINE",
    "QinTopia-order-import-review-from-2026-03-13-v2-simple.xlsx": "USER_CONFIRMATION_REVIEW",
    "QinTopia-order-import-review-from-2026-03-13-v3-business-confirmed.xlsx": "BUSINESS_CONFIRMATION_REVIEW"
};

export const SOURCE_CONTENT_FIELDS = Object.freeze({
  ORDER_EXPORT: Object.freeze([
    "订单号", "渠道订单号", "渠道", "联系人", "手机号", "入住类型", "是否包栋", "房型", "房间号",
    "入住日期", "离店日期", "入住状态", "住宿金额", "结账状态", "住宿小计", "订单备注", "创建人", "创建时间", "销售员"
  ]),
  COST_EXPORT: Object.freeze([
    "营业日", "订单号", "渠道订单号", "预订人", "房型", "房号", "入住类型", "房费类型", "客户姓名", "手机号",
    "渠道", "入住时间", "离店时间", "门市价", "折扣率", "间夜量", "房费"
  ]),
  CHECKOUT_EXPORT: Object.freeze([
    "结账时间", "订单号", "渠道订单号", "结账消费总计", "客户姓名", "手机号", "渠道", "住宿消费",
    "餐饮消费", "商超消费", "娱乐消费", "场地消费", "自定义消费", "会员消费", "结账支付详情", "剩余未结消费"
  ])
});

function normalizedSourceValue(value) {
  return value === undefined || value === null || value === "" ? null : value;
}

function contentProjection(rows, fields, label) {
  return rows.map((row, rowIndex) => {
    for (const field of fields) {
      if (!Object.prototype.hasOwnProperty.call(row, field)) throw new Error(`${label} is missing field ${field} at row ${rowIndex + 1}`);
    }
    return fields.map((field) => normalizedSourceValue(row[field]));
  });
}

function sourceRowCanBeExcludedBeforeImport(role, row) {
  if (role === "COST_EXPORT") {
    return sourceBusinessDate(row["营业日"], "COST_EXPORT 营业日") < IMPORT_START;
  }
  if (role === "CHECKOUT_EXPORT") {
    return sourceBusinessDate(row["结账时间"], "CHECKOUT_EXPORT 结账时间") < IMPORT_START;
  }
  if (role === "ORDER_EXPORT") {
    const createdValue = evidenceValue(row["创建时间"]);
    const departureValue = evidenceValue(row["离店日期"]);
    const createdDate = createdValue === null
      ? null
      : sourceBusinessDate(createdValue, "ORDER_EXPORT 创建时间");
    const departureDate = departureValue === null
      ? null
      : sourceBusinessDate(departureValue, "ORDER_EXPORT 离店日期");
    // A main-order row can be omitted only when its stay is proven to have
    // ended before the import boundary. Missing departure evidence stays in scope.
    return departureDate !== null
      && departureDate < IMPORT_START
      && (createdDate === null || createdDate < IMPORT_START);
  }
  throw new Error(`No import-scope rule for ${role}`);
}

export function reconcileSourceContent(reviewData, liveExports) {
  const reviewRowsByRole = {
    ORDER_EXPORT: reviewData.orders,
    COST_EXPORT: reviewData.costs,
    CHECKOUT_EXPORT: reviewData.checkouts
  };
  for (const [role, fields] of Object.entries(SOURCE_CONTENT_FIELDS)) {
    const live = liveExports.find((entry) => entry.role === role);
    const reviewRows = reviewRowsByRole[role];
    if (!live || !Array.isArray(live.rows) || !Array.isArray(reviewRows)) throw new Error(`Source content is unavailable for ${role}`);
    if (!Array.isArray(live.headers)) throw new Error(`Source headers are unavailable for ${role}`);
    const nonblankHeaders = live.headers.filter((header) => header !== "");
    const unexpectedHeaders = nonblankHeaders.filter((header) => !fields.includes(header));
    const missingHeaders = fields.filter((field) => !nonblankHeaders.includes(field));
    if (new Set(nonblankHeaders).size !== nonblankHeaders.length || unexpectedHeaders.length > 0 || missingHeaders.length > 0) {
      throw new Error(`Source schema drift for ${role}; rebuild and re-audit the canonical review workbook`);
    }
    if (reviewRows.length > live.rows.length) {
      throw new Error(`Source content row count drift for ${role}; review copy exceeds the live export`);
    }
    const liveProjection = contentProjection(live.rows, fields, `${role} live export`);
    const reviewProjection = contentProjection(reviewRows, fields, `${role} review copy`);
    if (live.rows.length === reviewRows.length) {
      if (hashStable(liveProjection) !== hashStable(reviewProjection)) {
        throw new Error(`Source content drift for ${role}; rebuild the canonical review workbook`);
      }
      continue;
    }

    const unmatchedLiveCounts = new Map();
    for (const projected of liveProjection) {
      const key = stable(projected);
      unmatchedLiveCounts.set(key, (unmatchedLiveCounts.get(key) ?? 0) + 1);
    }
    for (const projected of reviewProjection) {
      const key = stable(projected);
      const remaining = unmatchedLiveCounts.get(key) ?? 0;
      if (remaining === 0) {
        throw new Error(`Source content drift for ${role}; review copy is not an exact raw-export subset`);
      }
      unmatchedLiveCounts.set(key, remaining - 1);
    }
    for (let index = 0; index < live.rows.length; index += 1) {
      const key = stable(liveProjection[index]);
      const remaining = unmatchedLiveCounts.get(key) ?? 0;
      if (remaining === 0) continue;
      if (!sourceRowCanBeExcludedBeforeImport(role, live.rows[index])) {
        throw new Error(`Source content row count drift for ${role}; an excluded row is not proven before ${IMPORT_START}`);
      }
      unmatchedLiveCounts.set(key, remaining - 1);
    }
  }
}

function evidenceValue(value) {
  const result = clean(value);
  return result === "-" || result === "--" ? null : result;
}

function textValue(value) {
  const result = evidenceValue(value);
  return result === null ? null : String(result);
}

function sourceBusinessDate(value, label) {
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{4})[-/](\d{2})[-/](\d{2})/);
  if (!match) throw new Error(`${label} lineage has an invalid source date`);
  const result = `${match[1]}-${match[2]}-${match[3]}`;
  const instant = Date.parse(`${result}T00:00:00Z`);
  if (Number.isNaN(instant) || new Date(instant).toISOString().slice(0, 10) !== result) {
    throw new Error(`${label} lineage has an invalid source date`);
  }
  return result;
}

function firstEvidence(rows, field) {
  for (const row of rows) {
    const value = evidenceValue(row[field]);
    if (value !== null) return value;
  }
  return null;
}

function firstEvidenceFrom(sources) {
  for (const [rows, field] of sources) {
    const value = firstEvidence(rows, field);
    if (value !== null) return value;
  }
  return null;
}

function singleEvidenceAcross(sources, label, orderId, { required = false } = {}) {
  const values = [];
  for (const [rows, field] of sources) {
    for (const row of rows) {
      const value = textValue(row[field]);
      if (value !== null && !values.includes(value)) values.push(value);
    }
  }
  if (values.length > 1) throw new Error(`${label} lineage conflicts across raw sources for source order ${orderId}`);
  if (required && values.length === 0) throw new Error(`${label} lineage is missing for source order ${orderId}`);
  return values[0] ?? null;
}

function distinctValues(rows, field, { sorted = false } = {}) {
  const values = [];
  for (const row of rows) {
    const value = textValue(row[field]);
    if (value !== null && !values.includes(value)) values.push(value);
  }
  return sorted ? values.sort() : values;
}

function summarizedValues(rows, field, separator, options) {
  const values = distinctValues(rows, field, options);
  return values.length === 0 ? null : values.join(separator);
}

function groupRows(rows, field, label) {
  const groups = new Map();
  for (const row of rows) {
    const orderId = textValue(row[field]);
    if (!orderId) throw new Error(`${label} lineage has a blank source order id at row ${row._row ?? "unknown"}`);
    const group = groups.get(orderId) ?? [];
    group.push(row);
    groups.set(orderId, group);
  }
  return groups;
}

function reconstructMainOrderGroups(rows) {
  const normalizedRows = [];
  let currentOrderId = null;
  for (const row of rows) {
    const rawOrderId = textValue(row["订单号"]);
    if (rawOrderId !== null) currentOrderId = rawOrderId;
    if (currentOrderId === null) throw new Error(`订单号 fill-down lineage is missing at row ${row._row ?? "unknown"}`);
    if (textValue(row["归属订单号"]) !== currentOrderId) {
      throw new Error(`归属订单号 fill-down lineage mismatch at row ${row._row ?? "unknown"}`);
    }
    normalizedRows.push({ row, orderId: currentOrderId });
  }
  const groups = new Map();
  for (const entry of normalizedRows) {
    const group = groups.get(entry.orderId) ?? [];
    group.push(entry.row);
    groups.set(entry.orderId, group);
  }
  for (const [orderId, group] of groups) {
    const expectedCount = group.length;
    group.forEach((row, index) => {
      if (Number(row["段序号"]) !== index + 1) throw new Error(`段序号 lineage mismatch for source order ${orderId}`);
      if (Number(row["订单段数"]) !== expectedCount) throw new Error(`订单段数 lineage mismatch for source order ${orderId}`);
    });
    const rawChannel = firstEvidence(group, "渠道");
    const mappedChannel = normalizedChannel(rawChannel);
    for (const row of group) {
      if (textValue(row["规范渠道"]) !== mappedChannel) throw new Error(`订单主表规范渠道 lineage mismatch for source order ${orderId}`);
    }
  }
  return groups;
}

function assertTextLineage(row, field, expected) {
  if (textValue(row[field]) !== textValue(expected)) {
    throw new Error(`${field} lineage mismatch at audit row ${row._row ?? "unknown"}`);
  }
}

function assertDateLineage(row, field, expected) {
  const actual = evidenceValue(row[field]);
  if (actual === null && expected === null) return;
  if (actual === null || expected === null
    || sourceBusinessDate(actual, `${field} audit`) !== sourceBusinessDate(expected, `${field} source`)) {
    throw new Error(`${field} lineage mismatch at audit row ${row._row ?? "unknown"}`);
  }
}

function assertAmountLineage(row, field, expectedFen) {
  const actualFen = amountFen(row[field]);
  if (actualFen === null || actualFen !== expectedFen) throw new Error(`${field} lineage mismatch at audit row ${row._row ?? "unknown"}`);
}

function assertNullableAmountLineage(row, field, expectedFen) {
  const actualFen = amountFen(row[field]);
  if (actualFen !== expectedFen) throw new Error(`${field} lineage mismatch at audit row ${row._row ?? "unknown"}`);
}

function sumAmountFen(rows, field) {
  return rows.reduce((sum, row) => sum + (amountFen(row[field]) ?? 0), 0);
}

function minSourceValue(rows, field, label) {
  const values = rows.map((row) => evidenceValue(row[field])).filter((value) => value !== null);
  if (values.length === 0) throw new Error(`${label} lineage has no source value`);
  return values.map((value) => sourceBusinessDate(value, label)).sort()[0];
}

function maxSourceValue(rows, field, label) {
  const values = rows.map((row) => evidenceValue(row[field])).filter((value) => value !== null);
  if (values.length === 0) throw new Error(`${label} lineage has no source value`);
  return values.map((value) => sourceBusinessDate(value, label)).sort().at(-1);
}

function validateReviewedChannelTruth(row, rawChannel, rawReference) {
  const mappedChannel = normalizedChannel(rawChannel);
  assertTextLineage(row, "V1规范渠道", mappedChannel);
  const reference = textValue(rawReference);
  if (mappedChannel === "WECOM") {
    if (textValue(row["V1渠道订单号"]) !== null) {
      throw new Error(`V1渠道订单号 truth table mismatch at audit row ${row._row ?? "unknown"}`);
    }
    const expectedHandling = reference === null
      ? "WECOM 不强制渠道订单号"
      : "WECOM 不强制渠道订单号；源值仅作来源证据";
    if (textValue(row["V1渠道订单号处理"]) !== expectedHandling) {
      throw new Error(`V1渠道订单号处理 truth table mismatch at audit row ${row._row ?? "unknown"}`);
    }
    return mappedChannel;
  }
  if (textValue(row["V1渠道订单号"]) !== reference) {
    throw new Error(`V1渠道订单号 truth table mismatch at audit row ${row._row ?? "unknown"}`);
  }
  const expectedHandling = reference === null ? "null + 历史未记录；禁止补造" : "采用源表值";
  if (textValue(row["V1渠道订单号处理"]) !== expectedHandling) {
    throw new Error(`V1渠道订单号处理 truth table mismatch at audit row ${row._row ?? "unknown"}`);
  }
  return mappedChannel;
}

function eligibleSourceIds({ mainGroups, costGroups, checkoutGroups }) {
  const result = new Set();
  for (const [orderId, rows] of mainGroups) {
    const createdOnOrAfterStart = rows.some((row) => {
      const value = evidenceValue(row["创建时间"]);
      return value !== null && sourceBusinessDate(value, "订单主表创建时间") >= IMPORT_START;
    });
    const touchesImportWindow = rows.some((row) => {
      const value = evidenceValue(row["离店日期"]);
      return value !== null && sourceBusinessDate(value, "订单主表离店日期") >= IMPORT_START;
    });
    if (createdOnOrAfterStart || touchesImportWindow) result.add(orderId);
  }
  for (const [orderId, rows] of costGroups) {
    if (rows.some((row) => sourceBusinessDate(row["营业日"], "住宿明细营业日") >= IMPORT_START)) result.add(orderId);
  }
  for (const [orderId, rows] of checkoutGroups) {
    if (rows.some((row) => sourceBusinessDate(row["结账时间"], "结账明细结账时间") >= IMPORT_START)) result.add(orderId);
  }
  return result;
}

export function reconcileAuditSourceLineage(data, cutoverAt) {
  if (!Array.isArray(data.auditHeaders) || !Array.isArray(data.audit)
    || !Array.isArray(data.orders) || !Array.isArray(data.costs) || !Array.isArray(data.checkouts)) {
    throw new Error("Audit-to-source lineage inputs are incomplete");
  }
  const cutover = strictShanghaiTimestamp(cutoverAt, "Cutover", { minutePrecision: true });
  const requiredAuditHeaders = [
    "源订单号", "入住日", "离店日", "源房号", "源房型", "入住类型", "源姓名", "源手机号", "源渠道", "源渠道订单号",
    "结账住宿金额", "结账消费总计", "剩余未结消费", "主表匹配", "主表创建时间", "主表联系人", "主表手机号", "主表渠道订单号",
    "主表状态原文", "主表结账状态", "主表入住类型", "主表房间号", "主表入住日", "主表离店日", "主表住宿小计", "主表住宿段数",
    "V1住宿实价建议", "V1规范渠道", "V1渠道订单号", "V1渠道订单号处理"
  ];
  for (const header of requiredAuditHeaders) {
    if (data.auditHeaders.filter((candidate) => candidate === header).length !== 1) {
      throw new Error(`订单审核 must contain exactly one ${header} lineage header`);
    }
  }
  const cutoverHeaders = data.auditHeaders.filter((header) => String(header).startsWith("区间判定截至"));
  if (cutoverHeaders.length !== 1) throw new Error("订单审核 must contain exactly one cutover header");
  const expectedCutoverHeader = `区间判定截至${cutover.minuteLabel}`;
  if (cutoverHeaders[0] !== expectedCutoverHeader) throw new Error(`订单审核 cutover header must equal ${expectedCutoverHeader}`);

  const mainGroups = reconstructMainOrderGroups(data.orders);
  const costGroups = groupRows(data.costs, "订单号", "住宿明细");
  const checkoutGroups = groupRows(data.checkouts, "订单号", "结账明细");
  for (const [orderId, rows] of costGroups) {
    for (const row of rows) normalizedChannel(row["渠道"]);
    if (!orderId) throw new Error("住宿明细 lineage has an invalid source order id");
  }
  for (const [orderId, rows] of checkoutGroups) {
    for (const row of rows) normalizedChannel(row["渠道"]);
    if (!orderId) throw new Error("结账明细 lineage has an invalid source order id");
  }

  const eligibleIds = eligibleSourceIds({ mainGroups, costGroups, checkoutGroups });
  const auditById = new Map();
  for (const row of data.audit) {
    const orderId = textValue(row["源订单号"]);
    if (!orderId) throw new Error(`订单审核 lineage has a blank source order id at row ${row._row ?? "unknown"}`);
    if (auditById.has(orderId)) throw new Error(`订单审核 lineage has duplicate source order ${orderId}`);
    if (!mainGroups.has(orderId) && !costGroups.has(orderId) && !checkoutGroups.has(orderId)) {
      throw new Error(`Audit source order ${orderId} does not exist in any raw source`);
    }
    if (!eligibleIds.has(orderId)) throw new Error(`Audit source order ${orderId} is outside the import scope starting ${IMPORT_START}`);
    auditById.set(orderId, row);
  }
  for (const orderId of eligibleIds) {
    if (!auditById.has(orderId)) throw new Error(`Eligible raw source order ${orderId} is missing from 订单审核`);
  }

  for (const [orderId, row] of auditById) {
    const mainRows = mainGroups.get(orderId) ?? [];
    const costRows = costGroups.get(orderId) ?? [];
    const checkoutRows = checkoutGroups.get(orderId) ?? [];
    assertTextLineage(row, "主表匹配", mainRows.length > 0 ? "是" : "否");
    assertTextLineage(row, "主表创建时间", firstEvidence(mainRows, "创建时间"));
    assertTextLineage(row, "主表联系人", firstEvidence(mainRows, "联系人"));
    assertTextLineage(row, "主表手机号", firstEvidence(mainRows, "手机号"));
    assertTextLineage(row, "主表渠道订单号", firstEvidence(mainRows, "渠道订单号"));
    assertTextLineage(row, "主表状态原文", summarizedValues(mainRows, "入住状态", " / "));
    assertTextLineage(row, "主表结账状态", summarizedValues(mainRows, "结账状态", " / "));
    assertTextLineage(row, "主表入住类型", summarizedValues(mainRows, "入住类型", " / "));
    assertTextLineage(row, "主表房间号", summarizedValues(mainRows, "房间号", " / "));
    assertDateLineage(row, "主表入住日", mainRows.length > 0 ? minSourceValue(mainRows, "入住日期", "订单主表入住日期") : null);
    assertDateLineage(row, "主表离店日", mainRows.length > 0 ? maxSourceValue(mainRows, "离店日期", "订单主表离店日期") : null);
    assertNullableAmountLineage(row, "主表住宿小计", mainRows.length > 0 ? sumAmountFen(mainRows, "住宿小计") : null);
    if (evidenceValue(row["主表住宿段数"]) === null || Number(row["主表住宿段数"]) !== mainRows.length) {
      throw new Error(`主表住宿段数 lineage mismatch at audit row ${row._row ?? "unknown"}`);
    }

    const dateRows = costRows.length > 0 ? costRows : mainRows;
    const arrivalField = costRows.length > 0 ? "入住时间" : "入住日期";
    const departureField = costRows.length > 0 ? "离店时间" : "离店日期";
    assertDateLineage(row, "入住日", minSourceValue(dateRows, arrivalField, "审核入住日"));
    assertDateLineage(row, "离店日", maxSourceValue(dateRows, departureField, "审核离店日"));
    assertTextLineage(row, "源房号", costRows.length > 0
      ? summarizedValues(costRows, "房号", "、", { sorted: true })
      : summarizedValues(mainRows, "房间号", " / "));
    assertTextLineage(row, "源房型", costRows.length > 0
      ? summarizedValues(costRows, "房型", "、", { sorted: true })
      : summarizedValues(mainRows, "房型", " / "));
    assertTextLineage(row, "入住类型", costRows.length > 0
      ? summarizedValues(costRows, "入住类型", "、", { sorted: true })
      : summarizedValues(mainRows, "入住类型", " / "));

    const sourceName = firstEvidenceFrom([[costRows, "客户姓名"], [checkoutRows, "客户姓名"], [mainRows, "联系人"]]);
    const sourcePhone = firstEvidenceFrom([[costRows, "手机号"], [checkoutRows, "手机号"], [mainRows, "手机号"]]);
    const rawChannelSources = [[costRows, "渠道"], [checkoutRows, "渠道"], [mainRows, "渠道"]];
    const rawReferenceSources = [[costRows, "渠道订单号"], [checkoutRows, "渠道订单号"], [mainRows, "渠道订单号"]];
    const rawChannel = singleEvidenceAcross(rawChannelSources, "源渠道", orderId, { required: true });
    const rawReference = singleEvidenceAcross(rawReferenceSources, "源渠道订单号", orderId);
    assertTextLineage(row, "源姓名", sourceName);
    assertTextLineage(row, "源手机号", sourcePhone);
    assertTextLineage(row, "源渠道", rawChannel);
    assertTextLineage(row, "源渠道订单号", rawReference);
    validateReviewedChannelTruth(row, rawChannel, rawReference);

    const mainSubtotalFen = sumAmountFen(mainRows, "住宿小计");
    assertAmountLineage(row, "V1住宿实价建议", mainSubtotalFen);
    const noCheckoutEvidenceValue = costRows.length > 0 ? 0 : null;
    assertNullableAmountLineage(row, "结账住宿金额", checkoutRows.length > 0 ? sumAmountFen(checkoutRows, "住宿消费") : noCheckoutEvidenceValue);
    assertNullableAmountLineage(row, "结账消费总计", checkoutRows.length > 0 ? sumAmountFen(checkoutRows, "结账消费总计") : noCheckoutEvidenceValue);
    assertNullableAmountLineage(row, "剩余未结消费", checkoutRows.length > 0 ? sumAmountFen(checkoutRows, "剩余未结消费") : noCheckoutEvidenceValue);
  }
}

function optionalTimestamp(value) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value).trim().replace(" ", "T");
  const timestamp = /(?:Z|[+-]\d{2}:\d{2})$/.test(normalized) ? normalized : `${normalized}+08:00`;
  return strictShanghaiTimestamp(timestamp, "Source evidence").text;
}

export function reconcileSourceFiles({ evidence, workbookFileName, workbookHash, cutoverAt, liveExports }) {
  const cutover = strictShanghaiTimestamp(cutoverAt, "Cutover");
  const cutoverTime = cutover.epoch;
  const evidenceByName = new Map(evidence.map((entry) => [String(entry["来源文件"] ?? "").trim(), entry]));
  const files = [];
  for (const live of liveExports) {
    const sourceEvidence = evidenceByName.get(live.fileName);
    if (!sourceEvidence) throw new Error(`Review workbook has no source evidence for ${live.role} (${live.fileName})`);
    const expectedHash = String(sourceEvidence["SHA-256"] ?? "").trim();
    if (expectedHash !== live.sha256) throw new Error(`Source hash drift for ${live.role}`);
    const expectedRows = sourceEvidence["数据行数"];
    if (!Number.isInteger(Number(expectedRows)) || Number(expectedRows) <= 0) throw new Error(`Review workbook has no audited row count for ${live.role}`);
    if (Number(expectedRows) !== live.rowCount) throw new Error(`Source row count drift for ${live.role}`);
    const expectedExportedAt = optionalTimestamp(sourceEvidence["导出时间"]);
    if (!expectedExportedAt) throw new Error(`Review workbook has no audited export timestamp for ${live.role}`);
    if (expectedExportedAt !== live.exportedAt) throw new Error(`Source export timestamp drift for ${live.role}`);
    if (!Number.isInteger(live.rowCount) || live.rowCount <= 0) throw new Error(`Source row count must be positive for ${live.role}`);
    const exported = strictShanghaiTimestamp(live.exportedAt, `Source ${live.role}`);
    const exportedTime = exported.epoch;
    if (exportedTime > cutoverTime) throw new Error(`Source ${live.role} was exported later than cutover`);
    if (exported.datePart !== cutover.datePart) throw new Error(`Source ${live.role} was not exported on the cutover local date`);
    files.push({
      role: live.role,
      fileName: live.fileName,
      sha256: live.sha256,
      rowCount: live.rowCount,
      exportedAt: live.exportedAt
    });
    evidenceByName.delete(live.fileName);
  }
  for (const [fileName, entry] of evidenceByName) {
    const role = auxiliaryRoleByName[fileName];
    if (!role) throw new Error(`No source-file role for ${fileName}`);
    const fileHash = String(entry["SHA-256"] ?? "");
    if (!/^[a-f0-9]{64}$/.test(fileHash)) throw new Error(`Invalid source-file hash for ${fileName}`);
    files.push({ role, fileName, sha256: fileHash, rowCount: null, exportedAt: null, purpose: entry["用途"] });
  }
  files.push({
    role: "REVIEW_WORKBOOK",
    fileName: workbookFileName,
    sha256: workbookHash,
    rowCount: EXPECTED.candidateCount,
    exportedAt: cutoverAt,
    purpose: "V4 corrected canonical human review"
  });
  if (new Set(files.map((file) => file.role)).size !== files.length) throw new Error("Source-file roles must be unique");
  return files.sort((left, right) => left.role.localeCompare(right.role));
}

function buildManifest(workbook, cutoverAt, liveExports, approvedOperationalTuplesSha256, inspectOnly = false) {
  const workbookHash = sha256(readFileSync(workbook));
  const data = loadWorkbook(workbook);
  reconcileSourceContent(data, liveExports);
  reconcileAuditSourceLineage(data, cutoverAt);
  if (data.audit.length !== EXPECTED.candidateCount) throw new Error(`Expected ${EXPECTED.candidateCount} audit rows, got ${data.audit.length}`);
  const orderSegments = new Map();
  for (const segment of data.orders) {
    const orderId = String(segment["归属订单号"] ?? "");
    if (!orderId) continue;
    const list = orderSegments.get(orderId) ?? [];
    list.push(segment);
    orderSegments.set(orderId, list);
  }

  const records = data.audit.map((row) => {
    const orderId = String(row["源订单号"] ?? "").trim();
    if (!/^\d+$/.test(orderId)) throw new Error(`Invalid source order id at audit row ${row._row}`);
    const disposition = recordDisposition(row);
    const operational = disposition === "OPERATIONAL";
    const type = stayType(row);
    const observedLifecycle = lifecycle(row);
    const rawChannel = clean(row["源渠道"]);
    let mappedChannel = normalizedChannel(rawChannel);
    const manualBusinessType = clean(row["V3人工确认业务类型"]);
    if (manualBusinessType === "MEMBER_ENTITLEMENT") mappedChannel = null;
    const external = mappedChannel && mappedChannel !== "WECOM";
    const rawReference = clean(row["源渠道订单号"]);
    const externalOrderNo = external ? rawReference : null;
    const externalOrderNoStatus = external
      ? externalOrderNo ? "RECORDED" : "HISTORICAL_NOT_RECORDED"
      : "NOT_APPLICABLE";
    const sourceAmounts = {
      historicalActualAmountFen: amountFen(row["V1住宿实价建议"]),
      auditHistoricalAmountFen: amountFen(row["历史住宿实价"]),
      checkoutAccommodationAmountFen: amountFen(row["结账住宿金额"]),
      checkoutTotalAmountFen: amountFen(row["结账消费总计"]),
      unsettledConsumptionAmountFen: amountFen(row["剩余未结消费"]),
      amountReconciliation: clean(row["金额核对"])
    };
    const sourceStay = {
      arrivalDate: sourceDate(row["入住日"]),
      departureDate: sourceDate(row["离店日"]),
      rawRoom: clean(row["源房号"]),
      standardInventoryUnits: clean(row["标准库存单元"]),
      rawRoomType: clean(row["源房型"])
    };
    const segmentResult = operational
      ? buildOperationalSegments(orderSegments.get(orderId) ?? [])
      : { segments: [], excludedPlaceholderCount: 0 };
    const { segments } = segmentResult;
    if (operational && segments.length === 0) throw new Error(`Operational order ${orderId} has no effective segments`);
    const flags = [];
    const manualConfirmation = {
      businessType: manualBusinessType,
      observedLifecycle: clean(row["V3人工确认实际状态"]),
      room: clean(row["V3人工确认实际房间"]),
      reason: clean(row["V3人工确认原因"]),
      latestCorrection: clean(row["V4最新更正"]),
      correctionSource: clean(row["V4更正来源"])
    };
    const guest = guestSnapshot(row, operational);
    const specialFields = deriveReviewedSpecialFields({
      cutoverAt,
      disposition,
      observedLifecycle,
      stayType: type,
      sourceStay,
      segments,
      guest,
      manualConfirmation,
      excludedPlaceholderCount: segmentResult.excludedPlaceholderCount
    });
    flags.push(...specialFields.flags);
    const membership = specialFields.membership;
    const rawSnapshot = {
      sourceName: clean(row["源姓名"]), sourcePhone: clean(row["源手机号"]), rawChannel,
      rawChannelOrderNo: rawReference, sourceStay, sourceStatus: row["V1生命周期建议"],
      sourceAmounts, sourceOrderCreatedAt: clean(row["主表创建时间"]), sourceOrderStatus: clean(row["主表状态原文"]),
      sourceCheckoutStatus: clean(row["主表结账状态"])
    };
    const record = {
      source: { system: "ORDER_LAILE", orderId, auditRow: row._row, sourceValuesHash: hashStable(rawSnapshot) },
      recordKind: disposition === "NON_ACCOMMODATION_ARCHIVE" ? "NON_ACCOMMODATION_CHECKOUT" : "ACCOMMODATION",
      disposition,
      observedLifecycle,
      sourceStay,
      segments,
      guest,
      channel: { raw: rawChannel, normalized: mappedChannel, externalOrderNo, externalOrderNoStatus },
      stayType: type,
      pricing: { origin: "MIGRATED_ACTUAL", basis: pricingBasis(mappedChannel, type), currency: "CNY", currentContractAmountFen: sourceAmounts.historicalActualAmountFen, evidence: sourceAmounts },
      membership,
      manualConfirmation,
      flags,
      provenance: { rawSnapshot, reviewWorkbookHash: workbookHash, reviewConclusion: clean(row["审核结论"]), pendingReview: clean(row["V1待复核"]) }
    };
    return { ...record, canonicalPayloadHash: hashStable(record) };
  }).sort((left, right) => left.source.orderId.localeCompare(right.source.orderId));

  const sourceIds = new Set(records.map((record) => record.source.orderId));
  if (sourceIds.size !== records.length) throw new Error("Duplicate source order id in V4 workbook");
  assertReviewedSpecialCaseCardinality(records);
  const operationalRecords = records.filter((record) => record.disposition === "OPERATIONAL");
  const archivedRecords = records.filter((record) => record.disposition === "HISTORICAL_ARCHIVE");
  const nonAccommodationRecords = records.filter((record) => record.disposition === "NON_ACCOMMODATION_ARCHIVE");
  const allSegments = operationalRecords.flatMap((record) => record.segments);
  const totalFen = records.reduce((sum, record) => sum + (record.pricing.currentContractAmountFen ?? 0), 0);
  const operationalFen = operationalRecords.reduce((sum, record) => sum + (record.pricing.currentContractAmountFen ?? 0), 0);
  const observed = {
    candidateCount: records.length,
    historicalAccommodationArchives: archivedRecords.length,
    operationalOrders: operationalRecords.length,
    nonAccommodationArchives: nonAccommodationRecords.length,
    operationalSegmentCount: allSegments.length,
    totalAccommodationAmountFen: totalFen,
    historicalAccommodationAmountFen: totalFen - operationalFen,
    operationalAccommodationAmountFen: operationalFen
  };
  for (const [key, expected] of Object.entries(EXPECTED)) {
    if (observed[key] !== expected) throw new Error(`V4 reconciliation mismatch for ${key}: expected ${expected}, got ${observed[key]}`);
  }
  const persistedChannelCounts = records.reduce((counts, record) => {
    const channel = record.disposition === "OPERATIONAL"
      && (record.pricing.basis === "FREE" || record.pricing.basis === "MEMBER_ENTITLEMENT")
      ? "NULL"
      : record.channel.normalized ?? "NULL";
    counts[channel] = (counts[channel] ?? 0) + 1;
    return counts;
  }, {});
  const expectedChannelCounts = { WECOM: 503, CTRIP: 15, MEITUAN: 11, YOUMUDAO: 4, NULL: 2 };
  if (stable(persistedChannelCounts) !== stable(expectedChannelCounts)) {
    throw new Error(`V4 channel reconciliation mismatch: ${stable(persistedChannelCounts)}`);
  }
  const inspection = inspectOperationalTuples(records);
  if (inspectOnly) return { inspection };
  const sourceFiles = reconcileSourceFiles({
    evidence: data.sources,
    workbookFileName: basename(workbook),
    workbookHash,
    cutoverAt,
    liveExports
  });
  const sealedOperationalTuplesSha256 = assertApprovedOperationalTupleHash(records, approvedOperationalTuplesSha256);
  const manifest = {
    manifestVersion: 1,
    generatorVersion: TOOL_VERSION,
    propertyCode: "QTP-XA",
    sourceSystem: "ORDER_LAILE",
    currency: "CNY",
    importStartDate: IMPORT_START,
    cutoverAt,
    approvedOperationalTuplesSha256: sealedOperationalTuplesSha256,
    idempotencyKey: `historical-order-import:QTP-XA:ORDER_LAILE:${IMPORT_START}:v4:${workbookHash}`,
    source: {
      workbook: { fileName: basename(workbook), sha256: workbookHash },
      sourceFiles
    },
    expected: observed,
    records
  };
  return { manifest, manifestHash: hashStable(manifest) };
}

export function reviewMarkdown(manifest, manifestHash) {
  const operations = manifest.records.filter((record) => record.disposition === "OPERATIONAL");
  const byLifecycle = operations.reduce((counts, record) => ({ ...counts, [record.observedLifecycle]: (counts[record.observedLifecycle] ?? 0) + 1 }), {});
  const missingExternalReferences = manifest.records.filter((record) => record.channel.externalOrderNoStatus === "HISTORICAL_NOT_RECORDED");
  return [
    "# 历史订单正式导入核对单",
    "",
    "这是一份候选导入文件的简化核对单，不代表已经写入正式系统。",
    "",
    "## 本次候选结果",
    "",
    `- 候选记录：${manifest.expected.candidateCount} 条。历史住宿归档 ${manifest.expected.historicalAccommodationArchives} 条，非住宿归档 ${manifest.expected.nonAccommodationArchives} 条。`,
    `- 当前运营订单：${manifest.expected.operationalOrders} 条，其中在住 ${byLifecycle.IN_HOUSE ?? 0} 条、预订 ${byLifecycle.RESERVED ?? 0} 条。`,
    `- 来源住宿段：${manifest.expected.operationalSegmentCount} 个。历史实际住宿金额：${(manifest.expected.totalAccommodationAmountFen / 100).toFixed(2)} 元。`,
    "- 渠道：企业微信 503、携程 15、美团 11、游牧岛 4、空 2。",
    `- 历史未记录渠道订单号：${missingExternalReferences.length} 条，保留为空，不补造号码。`,
    `- Manifest SHA-256：\`${manifestHash}\``,
    `- 44 单运营事实人工批准 SHA-256：\`${manifest.approvedOperationalTuplesSha256}\``,
    `- 复核工作簿 SHA-256：\`${manifest.source.workbook.sha256}\``,
    "",
    "## 正式导入前",
    "",
    "- [ ] 冻结旧系统写入，并重新导出三张源表。",
    "- [ ] 用最新导出重新生成 manifest；只要数量、金额、在住状态、房间或日期有变化，就停止并重新复核。",
    "- [ ] 完成正式数据库备份，并实际验证该备份可以恢复。",
    "- [ ] 在备份恢复出来的候选数据库运行 dry-run，确认零库存冲突、零业务写入。",
    "- [ ] 重点确认：逾期在住修正单继续锁定 306；会员权益单仍在住 D01 且恰好使用 19 晚权益；零元未排房占位单只保留 A03 / 1020 元；双房订单同时占用 108-A 和 108-B；间断订单没有补出不存在的 5 天住宿。",
    "",
    "## 正式导入后",
    "",
    "- [ ] 立即再次运行 dry-run / replay，必须显示新增 0 条、manifest hash 不变。",
    "- [ ] 打开房态核对 306、D01、A03、108-A、108-B。",
    "- [ ] 对逾期在住修正单使用“确认历史在住”，填写实际离店日、切换后续住金额和确认依据，再办理后续操作。",
    "- [ ] 历史缺失的渠道订单号可以继续为空；不要为了补齐而编造。",
    ""
  ].join("\n");
}

function createPrivateFileExclusive(path, content, createdPaths) {
  let descriptor;
  try {
    descriptor = openSync(path, "wx", 0o600);
    createdPaths.push(path);
    writeFileSync(descriptor, content, { encoding: "utf8" });
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function writePrivateOutputPair({ manifestPath, manifestContent, reviewPath, reviewContent }) {
  const createdPaths = [];
  try {
    createPrivateFileExclusive(manifestPath, manifestContent, createdPaths);
    createPrivateFileExclusive(reviewPath, reviewContent, createdPaths);
  } catch (error) {
    let cleanupFailure = null;
    for (const path of createdPaths.reverse()) {
      try {
        unlinkSync(path);
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT" && cleanupFailure === null) cleanupFailure = cleanupError;
      }
    }
    if (cleanupFailure !== null) throw new AggregateError([error, cleanupFailure], "Private output failed and cleanup was incomplete");
    throw error;
  }
}

export function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (!options) {
    usage();
    return;
  }
  const requiredPaths = [["workbook", options.workbook], ["orders", options.orders], ["costs", options.costs], ["checkouts", options.checkouts]];
  if (!options.inspectOperationalTuples) requiredPaths.push(["output directory", options.outputDir]);
  for (const [role, path] of requiredPaths) {
    if (!existsSync(path)) throw new Error(`${role} does not exist: ${path}`);
  }
  const liveExports = loadSourceExports(options);
  const result = buildManifest(
    options.workbook,
    options.cutoverAt,
    liveExports,
    options.approvedOperationalTuplesSha256,
    options.inspectOperationalTuples === true
  );
  if (options.inspectOperationalTuples) {
    console.log(JSON.stringify(result.inspection));
    return;
  }
  const { manifest, manifestHash } = result;
  const outputName = `historical-order-import-manifest-${IMPORT_START}-v1.json`;
  const reviewName = `historical-order-import-cutover-review-${IMPORT_START}-v1.md`;
  const manifestPath = resolve(options.outputDir, outputName);
  const reviewPath = resolve(options.outputDir, reviewName);
  writePrivateOutputPair({
    manifestPath,
    manifestContent: `${stable({ ...manifest, manifestHash })}\n`,
    reviewPath,
    reviewContent: reviewMarkdown(manifest, manifestHash)
  });
  console.log(JSON.stringify({ manifestPath, reviewPath, manifestHash, expected: manifest.expected }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

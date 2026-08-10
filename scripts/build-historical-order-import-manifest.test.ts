import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { historicalOperationalTupleHash } from "../packages/db/src/historical-order-import.ts";
import {
  assertApprovedOperationalTupleHash,
  assertReviewedSpecialCaseCardinality,
  buildOperationalSegments,
  deriveReviewedSpecialFields,
  isAutoAdopted,
  inspectOperationalTuples,
  normalizedChannel,
  operationalTupleHash,
  parseArgs,
  reconcileAuditSourceLineage,
  reconcileSourceContent,
  reviewMarkdown,
  SOURCE_CONTENT_FIELDS,
  reconcileSourceFiles,
  writePrivateOutputPair
} from "./build-historical-order-import-manifest.mjs";

const hash = (character: string) => character.repeat(64);

const evidence = [
  { "来源文件": "orders.xlsx", "SHA-256": hash("a"), "用途": "orders", "数据行数": 675, "导出时间": "2026-08-10T09:00:00+08:00" },
  { "来源文件": "costs.xlsx", "SHA-256": hash("b"), "用途": "costs", "数据行数": 6852, "导出时间": "2026-08-10T09:01:00+08:00" },
  { "来源文件": "checkouts.xlsx", "SHA-256": hash("c"), "用途": "checkouts", "数据行数": 253, "导出时间": "2026-08-10T09:02:00+08:00" },
  { "来源文件": "QinTopia-order-import-review-from-2026-03-13-v0.xlsx", "SHA-256": hash("d"), "用途": "feishu" },
  { "来源文件": "QinTopia-order-import-review-from-2026-03-13-v2-simple.xlsx", "SHA-256": hash("e"), "用途": "user review" },
  { "来源文件": "QinTopia-order-import-review-from-2026-03-13-v3-business-confirmed.xlsx", "SHA-256": hash("f"), "用途": "business review" }
];

function liveExports() {
  return [
    { role: "ORDER_EXPORT", fileName: "orders.xlsx", sha256: hash("a"), rowCount: 675, exportedAt: "2026-08-10T09:00:00+08:00" },
    { role: "COST_EXPORT", fileName: "costs.xlsx", sha256: hash("b"), rowCount: 6852, exportedAt: "2026-08-10T09:01:00+08:00" },
    { role: "CHECKOUT_EXPORT", fileName: "checkouts.xlsx", sha256: hash("c"), rowCount: 253, exportedAt: "2026-08-10T09:02:00+08:00" }
  ];
}

function validArgs(cutoverAt = "2026-08-10T10:00:00+08:00") {
  return [
    "--workbook", "/tmp/review.xlsx",
    "--orders", "/tmp/orders.xlsx",
    "--costs", "/tmp/costs.xlsx",
    "--checkouts", "/tmp/checkouts.xlsx",
    "--cutover-at", cutoverAt,
    "--approved-operational-tuples-sha256", hash("a"),
    "--output-dir", "/tmp/output"
  ];
}

function lineageFixture() {
  const cutoverHeader = "区间判定截至2026-08-10 10:00";
  const audit = {
    _row: 2,
    "源订单号": "100",
    "入住日": "2026-08-09",
    "离店日": "2026-08-12",
    "源房号": "A02、B01",
    "源房型": "Double、Single",
    "入住类型": "正常入住",
    "源姓名": "Synthetic Guest",
    "源手机号": null,
    "源渠道": "微信",
    "源渠道订单号": "wecom-source-evidence",
    "结账住宿金额": 300,
    "结账消费总计": 350,
    "剩余未结消费": 50,
    "主表匹配": "是",
    "主表创建时间": "2026-08-01 09:00:00",
    "主表联系人": "Synthetic Guest",
    "主表手机号": null,
    "主表渠道订单号": "wecom-source-evidence",
    "主表状态原文": "已入住 / 已预订",
    "主表结账状态": "未结账 / 临时挂账",
    "主表入住类型": "正常入住",
    "主表房间号": "B01 / A02",
    "主表入住日": "2026-08-10 14:00:00",
    "主表离店日": "2026-08-12 12:00:00",
    "主表住宿小计": 300,
    "主表住宿段数": 2,
    "V1住宿实价建议": 300,
    "V1规范渠道": "WECOM",
    "V1渠道订单号": null,
    "V1渠道订单号处理": "WECOM 不强制渠道订单号；源值仅作来源证据",
    [cutoverHeader]: "IN_HOUSE"
  };
  const orders = [
    {
      _row: 2,
      "归属订单号": "100",
      "段序号": 1,
      "订单段数": 2,
      "规范渠道": "WECOM",
      "订单号": "100",
      "渠道订单号": "wecom-source-evidence",
      "渠道": "微信",
      "联系人": "Synthetic Guest",
      "手机号": null,
      "入住类型": "正常入住",
      "房型": "Single",
      "房间号": "B01",
      "入住日期": "2026-08-10 14:00:00",
      "离店日期": "2026-08-11 12:00:00",
      "入住状态": "已入住",
      "住宿金额": 100,
      "结账状态": "未结账",
      "住宿小计": 300,
      "创建时间": "2026-08-01 09:00:00"
    },
    {
      _row: 3,
      "归属订单号": "100",
      "段序号": 2,
      "订单段数": 2,
      "规范渠道": "WECOM",
      "订单号": null,
      "渠道订单号": null,
      "渠道": null,
      "联系人": null,
      "手机号": null,
      "入住类型": "正常入住",
      "房型": "Double",
      "房间号": "A02",
      "入住日期": "2026-08-11 14:00:00",
      "离店日期": "2026-08-12 12:00:00",
      "入住状态": "已预订",
      "住宿金额": 200,
      "结账状态": "临时挂账",
      "住宿小计": null,
      "创建时间": null
    }
  ];
  const costs = [
    {
      _row: 2,
      "营业日": "2026/08/09",
      "订单号": "100",
      "渠道订单号": "wecom-source-evidence",
      "房型": "Single",
      "房号": "B01",
      "入住类型": "正常入住",
      "客户姓名": "Synthetic Guest",
      "手机号": "-",
      "渠道": "微信",
      "入住时间": "2026-08-09 14:00:00",
      "离店时间": "2026-08-11 12:00:00"
    },
    {
      _row: 3,
      "营业日": "2026/08/10",
      "订单号": "100",
      "渠道订单号": "wecom-source-evidence",
      "房型": "Double",
      "房号": "A02",
      "入住类型": "正常入住",
      "客户姓名": "Synthetic Guest",
      "手机号": "-",
      "渠道": "微信",
      "入住时间": "2026-08-10 14:00:00",
      "离店时间": "2026-08-12 12:00:00"
    }
  ];
  const checkouts = [
    { _row: 2, "结账时间": "2026-08-10 08:00:00", "订单号": "100", "渠道订单号": "wecom-source-evidence", "客户姓名": "Synthetic Guest", "手机号": "-", "渠道": "微信", "住宿消费": 100, "结账消费总计": 100, "剩余未结消费": 0 },
    { _row: 3, "结账时间": "2026-08-10 09:00:00", "订单号": "100", "渠道订单号": "wecom-source-evidence", "客户姓名": "Synthetic Guest", "手机号": "-", "渠道": "微信", "住宿消费": 200, "结账消费总计": 250, "剩余未结消费": 50 }
  ];
  return {
    cutoverAt: "2026-08-10T10:00:00+08:00",
    data: { auditHeaders: Object.keys(audit), audit: [audit], orders, costs, checkouts }
  };
}

function sourceSegment(overrides: Record<string, unknown> = {}) {
  return {
    _row: 2,
    "归属订单号": "synthetic-order",
    "段序号": 1,
    "房间号": "A03",
    "房型": "synthetic-room-type",
    "入住日期": "2026-08-10",
    "离店日期": "2026-08-11",
    "住宿金额": 1020,
    "入住状态": "synthetic-status",
    ...overrides
  };
}

function reviewedSpecialInput(overrides: Record<string, unknown> = {}) {
  return {
    cutoverAt: "2026-08-10T10:00:00+08:00",
    disposition: "OPERATIONAL",
    observedLifecycle: "RESERVED",
    stayType: "STANDARD",
    sourceStay: { arrivalDate: "2026-08-10", departureDate: "2026-08-11" },
    segments: [{ inventoryUnitCode: "A03", arrivalDate: "2026-08-10", departureDate: "2026-08-11", amountFen: 102_000 }],
    guest: { name: "Sample Guest", nickname: "Sample Guest" },
    manualConfirmation: { businessType: null, latestCorrection: null, correctionSource: null },
    excludedPlaceholderCount: 0,
    ...overrides
  };
}

describe("historical-order manifest source freeze", () => {
  it("requires all source files and an explicit cutover timestamp", () => {
    expect(parseArgs(validArgs())).toMatchObject({
      cutoverAt: "2026-08-10T10:00:00+08:00",
      approvedOperationalTuplesSha256: hash("a")
    });

    expect(parseArgs(validArgs().filter((value, index, args) => value !== "--checkouts" && args[index - 1] !== "--checkouts"))).toBeNull();
    expect(parseArgs(validArgs().filter((value, index, args) => value !== "--approved-operational-tuples-sha256" && args[index - 1] !== "--approved-operational-tuples-sha256"))).toBeNull();

    const inspectionArgs = validArgs()
      .filter((value, index, args) => !["--approved-operational-tuples-sha256", "--output-dir"].includes(value)
        && !["--approved-operational-tuples-sha256", "--output-dir"].includes(args[index - 1] ?? ""))
      .concat("--inspect-operational-tuples");
    expect(parseArgs(inspectionArgs)).toMatchObject({ inspectOperationalTuples: true });
    expect(parseArgs([...inspectionArgs, "--approved-operational-tuples-sha256", hash("a")])).toBeNull();
  });

  it("rejects normalized-invalid cutover timestamps", () => {
    expect(parseArgs(validArgs("2026-08-10T24:00:00+08:00"))).toBeNull();
    expect(parseArgs(validArgs("2026-08-10T23:60:00+08:00"))).toBeNull();
    expect(parseArgs(validArgs("2026-08-10T23:59:60+08:00"))).toBeNull();
    expect(parseArgs(validArgs("2026-02-30T10:00:00+08:00"))).toBeNull();
  });

  it("records live hashes, row counts and export timestamps only after evidence reconciliation", () => {
    const files = reconcileSourceFiles({
      cutoverAt: "2026-08-10T10:00:00+08:00",
      evidence,
      liveExports: liveExports(),
      workbookFileName: "review.xlsx",
      workbookHash: hash("9")
    });

    expect(files).toHaveLength(7);
    expect(files.find((file) => file.role === "ORDER_EXPORT")).toMatchObject({
      sha256: hash("a"),
      rowCount: 675,
      exportedAt: "2026-08-10T09:00:00+08:00"
    });
  });

  it("fails closed on hash, row-count, export-time or cutover-date drift", () => {
    const base = {
      cutoverAt: "2026-08-10T10:00:00+08:00",
      evidence,
      liveExports: liveExports(),
      workbookFileName: "review.xlsx",
      workbookHash: hash("9")
    };

    const changedHash = liveExports();
    changedHash[0]!.sha256 = hash("0");
    expect(() => reconcileSourceFiles({ ...base, liveExports: changedHash })).toThrow(/hash.*drift/i);

    const changedRows = liveExports();
    changedRows[1]!.rowCount += 1;
    expect(() => reconcileSourceFiles({ ...base, liveExports: changedRows })).toThrow(/row count.*drift/i);

    const late = liveExports();
    late[2]!.exportedAt = "2026-08-10T10:00:01+08:00";
    const lateEvidence = evidence.map((entry) => entry["来源文件"] === "checkouts.xlsx" ? { ...entry, "导出时间": late[2]!.exportedAt } : entry);
    expect(() => reconcileSourceFiles({ ...base, evidence: lateEvidence, liveExports: late })).toThrow(/later than cutover/i);

    const stale = liveExports();
    stale[1]!.exportedAt = "2026-08-09T23:59:59+08:00";
    const staleEvidence = evidence.map((entry) => entry["来源文件"] === "costs.xlsx" ? { ...entry, "导出时间": stale[1]!.exportedAt } : entry);
    expect(() => reconcileSourceFiles({ ...base, evidence: staleEvidence, liveExports: stale })).toThrow(/cutover local date/i);

    const invalid = liveExports();
    invalid[0]!.exportedAt = "2026-08-10T24:00:00+08:00";
    const invalidEvidence = evidence.map((entry) => entry["来源文件"] === "orders.xlsx" ? { ...entry, "导出时间": invalid[0]!.exportedAt } : entry);
    expect(() => reconcileSourceFiles({ ...base, evidence: invalidEvidence, liveExports: invalid })).toThrow(/timestamp.*invalid/i);
  });

  it("compares every raw source field with the review workbook copy", () => {
    const reviewData: Record<string, Array<Record<string, unknown>>> = { orders: [], costs: [], checkouts: [] };
    const roles = [
      ["ORDER_EXPORT", "orders"],
      ["COST_EXPORT", "costs"],
      ["CHECKOUT_EXPORT", "checkouts"]
    ] as const;
    const exports = roles.map(([role, reviewKey], roleIndex) => {
      const row = Object.fromEntries(SOURCE_CONTENT_FIELDS[role].map((field, fieldIndex) => [field, `${roleIndex}:${fieldIndex}`]));
      reviewData[reviewKey] = [structuredClone(row)];
      return { role, headers: [...SOURCE_CONTENT_FIELDS[role]], rows: [row] };
    });
    expect(() => reconcileSourceContent(reviewData, exports)).not.toThrow();

    for (const [role, reviewKey] of roles) {
      for (const field of SOURCE_CONTENT_FIELDS[role]) {
        const drifted = structuredClone(exports);
        drifted.find((entry) => entry.role === role)!.rows[0]![field] = `changed:${field}`;
        expect(() => reconcileSourceContent(reviewData, drifted), `${role}.${field}`).toThrow(new RegExp(`content drift.*${role}`, "i"));
      }

      const missingFieldReview = structuredClone(reviewData);
      delete missingFieldReview[reviewKey]![0]![SOURCE_CONTENT_FIELDS[role][0]!];
      expect(() => reconcileSourceContent(missingFieldReview, exports)).toThrow(new RegExp(`missing field.*${SOURCE_CONTENT_FIELDS[role][0]}`, "i"));
    }

    const schemaDrift = structuredClone(exports);
    schemaDrift[0]!.headers.push("新增原始字段");
    schemaDrift[0]!.rows[0]!["新增原始字段"] = "new value";
    expect(() => reconcileSourceContent(reviewData, schemaDrift)).toThrow(/source schema drift.*ORDER_EXPORT/i);
  });

  it("accepts only the exact source subset on or after the import boundary", () => {
    const row = (role: keyof typeof SOURCE_CONTENT_FIELDS, marker: string) =>
      Object.fromEntries(SOURCE_CONTENT_FIELDS[role].map((field) => [field, `${marker}:${field}`]));
    const oldOrder = { ...row("ORDER_EXPORT", "old-order"), "创建时间": "2026-03-01 09:00:00", "离店日期": "2026-03-12 12:00:00" };
    const scopedOrder = { ...row("ORDER_EXPORT", "scoped-order"), "创建时间": "2026-03-01 09:00:00", "离店日期": "2026-03-13 12:00:00" };
    const oldCost = { ...row("COST_EXPORT", "old-cost"), "营业日": "2026/03/12" };
    const scopedCost = { ...row("COST_EXPORT", "scoped-cost"), "营业日": "2026/03/13" };
    const oldCheckout = { ...row("CHECKOUT_EXPORT", "old-checkout"), "结账时间": "2026-03-12 23:59:59" };
    const scopedCheckout = { ...row("CHECKOUT_EXPORT", "scoped-checkout"), "结账时间": "2026-03-13 00:00:00" };
    const reviewData = { orders: [scopedOrder], costs: [scopedCost], checkouts: [scopedCheckout] };
    const exports = [
      { role: "ORDER_EXPORT", headers: [...SOURCE_CONTENT_FIELDS.ORDER_EXPORT], rows: [oldOrder, scopedOrder] },
      { role: "COST_EXPORT", headers: [...SOURCE_CONTENT_FIELDS.COST_EXPORT], rows: [oldCost, scopedCost] },
      { role: "CHECKOUT_EXPORT", headers: [...SOURCE_CONTENT_FIELDS.CHECKOUT_EXPORT], rows: [oldCheckout, scopedCheckout] }
    ];

    expect(() => reconcileSourceContent(reviewData, exports)).not.toThrow();

    const omittedBoundaryRow = structuredClone(reviewData);
    omittedBoundaryRow.costs = [];
    expect(() => reconcileSourceContent(omittedBoundaryRow, exports)).toThrow(/not proven before 2026-03-13/i);

    const retainedPreBoundaryRow = structuredClone(reviewData);
    retainedPreBoundaryRow.checkouts = [oldCheckout];
    expect(() => reconcileSourceContent(retainedPreBoundaryRow, exports)).toThrow(/not proven before 2026-03-13/i);

    const secondScopedCost = { ...row("COST_EXPORT", "second-scoped-cost"), "营业日": "2026/03/14" };
    const reorderedReview = structuredClone(reviewData);
    reorderedReview.costs = [secondScopedCost, scopedCost];
    const reorderedExports = structuredClone(exports);
    reorderedExports.find((entry) => entry.role === "COST_EXPORT")!.rows.push(secondScopedCost);
    expect(() => reconcileSourceContent(reorderedReview, reorderedExports)).not.toThrow();
  });

  it("fails closed when an omitted source row has no provable pre-boundary date", () => {
    const row = (role: keyof typeof SOURCE_CONTENT_FIELDS) =>
      Object.fromEntries(SOURCE_CONTENT_FIELDS[role].map((field) => [field, `value:${field}`]));
    const order = { ...row("ORDER_EXPORT"), "创建时间": "2026-03-01 09:00:00", "离店日期": null };
    const cost = { ...row("COST_EXPORT"), "营业日": null };
    const checkout = { ...row("CHECKOUT_EXPORT"), "结账时间": "not-a-date" };
    const emptyReview = { orders: [], costs: [], checkouts: [] };
    const baseExports = [
      { role: "ORDER_EXPORT", headers: [...SOURCE_CONTENT_FIELDS.ORDER_EXPORT], rows: [order] },
      { role: "COST_EXPORT", headers: [...SOURCE_CONTENT_FIELDS.COST_EXPORT], rows: [] },
      { role: "CHECKOUT_EXPORT", headers: [...SOURCE_CONTENT_FIELDS.CHECKOUT_EXPORT], rows: [] }
    ];

    expect(() => reconcileSourceContent(emptyReview, baseExports)).toThrow(/ORDER_EXPORT.*not proven before/i);
    const invalidCost = structuredClone(baseExports);
    invalidCost[0]!.rows = [];
    invalidCost[1]!.rows = [cost];
    expect(() => reconcileSourceContent(emptyReview, invalidCost)).toThrow(/COST_EXPORT.*invalid source date/i);
    const invalidCheckout = structuredClone(baseExports);
    invalidCheckout[0]!.rows = [];
    invalidCheckout[2]!.rows = [checkout];
    expect(() => reconcileSourceContent(emptyReview, invalidCheckout)).toThrow(/CHECKOUT_EXPORT.*invalid source date/i);
  });

  it("rebuilds audit lineage from raw copies and detects stale reviewed status", () => {
    const fixture = lineageFixture();
    expect(() => reconcileAuditSourceLineage(fixture.data, fixture.cutoverAt)).not.toThrow();

    const staleAudit = structuredClone(fixture.data);
    staleAudit.orders[1]!["入住状态"] = "已取消";
    expect(() => reconcileAuditSourceLineage(staleAudit, fixture.cutoverAt)).toThrow(/主表状态原文.*lineage/i);

    const brokenFillDown = structuredClone(fixture.data);
    brokenFillDown.orders[1]!["段序号"] = 3;
    expect(() => reconcileAuditSourceLineage(brokenFillDown, fixture.cutoverAt)).toThrow(/段序号.*lineage/i);
  });

  it("fails when any audited raw aggregate drifts", () => {
    const fixture = lineageFixture();
    const cases: Array<[string, (data: ReturnType<typeof lineageFixture>["data"]) => void]> = [
      ["主表结账状态", (data) => { data.orders[1]!["结账状态"] = "已结账"; }],
      ["主表房间号", (data) => { data.orders[1]!["房间号"] = "A03"; }],
      ["主表入住类型", (data) => { data.orders[1]!["入住类型"] = "免费房"; }],
      ["主表入住日", (data) => { data.orders[0]!["入住日期"] = "2026-08-08 14:00:00"; }],
      ["主表住宿小计", (data) => { data.orders[0]!["住宿小计"] = 301; }],
      ["入住日", (data) => { data.costs[0]!["入住时间"] = "2026-08-08 14:00:00"; }],
      ["源房型", (data) => { data.costs[0]!["房型"] = "Changed"; }],
      ["结账住宿金额", (data) => { data.checkouts[0]!["住宿消费"] = 101; }]
    ];
    for (const [field, mutate] of cases) {
      const drifted = structuredClone(fixture.data);
      mutate(drifted);
      expect(
        () => reconcileAuditSourceLineage(drifted, fixture.cutoverAt),
        field
      ).toThrow(new RegExp(`${field}.*lineage`, "i"));
    }
  });

  it("requires one exact minute-precision cutover header", () => {
    const fixture = lineageFixture();
    const wrong = structuredClone(fixture.data);
    wrong.auditHeaders = wrong.auditHeaders.map((header) => header.startsWith("区间判定截至") ? "区间判定截至2026-08-10 09:59" : header);
    expect(() => reconcileAuditSourceLineage(wrong, fixture.cutoverAt)).toThrow(/cutover header/i);

    const duplicate = structuredClone(fixture.data);
    duplicate.auditHeaders.push("区间判定截至2026-08-10 09:59");
    expect(() => reconcileAuditSourceLineage(duplicate, fixture.cutoverAt)).toThrow(/exactly one.*cutover header/i);

    expect(() => reconcileAuditSourceLineage(fixture.data, "2026-08-10T10:00:01+08:00")).toThrow(/minute precision/i);
  });

  it("excludes source orders ended before 2026-03-13 and rejects them from audit scope", () => {
    const fixture = lineageFixture();
    const outside = structuredClone(fixture.data);
    outside.costs = [];
    outside.checkouts = [];
    outside.orders[0]!["入住日期"] = "2026-03-01 14:00:00";
    outside.orders[0]!["离店日期"] = "2026-03-02 12:00:00";
    outside.orders[0]!["创建时间"] = "2026-03-01 09:00:00";
    outside.orders[1]!["入住日期"] = "2026-03-02 14:00:00";
    outside.orders[1]!["离店日期"] = "2026-03-03 12:00:00";
    const audit = outside.audit[0]!;
    audit["入住日"] = "2026-03-01";
    audit["离店日"] = "2026-03-03";
    audit["源房号"] = "B01 / A02";
    audit["源房型"] = "Single / Double";
    audit["结账住宿金额"] = 0;
    audit["结账消费总计"] = 0;
    audit["剩余未结消费"] = 0;
    audit["主表创建时间"] = "2026-03-01 09:00:00";
    audit["主表入住日"] = "2026-03-01 14:00:00";
    audit["主表离店日"] = "2026-03-03 12:00:00";
    expect(() => reconcileAuditSourceLineage(outside, fixture.cutoverAt)).toThrow(/outside the import scope/i);

    outside.audit = [];
    expect(() => reconcileAuditSourceLineage(outside, fixture.cutoverAt)).not.toThrow();
  });

  it("uses a closed raw-channel and channel-reference truth table", () => {
    expect(normalizedChannel("自来客")).toBe("WECOM");
    expect(normalizedChannel("小红书")).toBe("WECOM");
    expect(normalizedChannel("小红书小程序")).toBe("WECOM");
    expect(normalizedChannel("微信")).toBe("WECOM");
    expect(normalizedChannel("企业微信")).toBe("WECOM");
    expect(normalizedChannel("Agoda")).toBe("YOUMUDAO");
    expect(normalizedChannel("Aogda")).toBe("YOUMUDAO");
    expect(normalizedChannel("游牧岛")).toBe("YOUMUDAO");
    expect(normalizedChannel("携程")).toBe("CTRIP");
    expect(normalizedChannel("美团酒店")).toBe("MEITUAN");
    expect(normalizedChannel("美团民宿")).toBe("MEITUAN");
    expect(() => normalizedChannel("未知渠道", "WECOM")).toThrow(/unsupported source channel/i);

    const fixture = lineageFixture();
    fixture.data.audit[0]!["V1渠道订单号"] = "wecom-source-evidence";
    expect(() => reconcileAuditSourceLineage(fixture.data, fixture.cutoverAt)).toThrow(/V1渠道订单号.*truth table/i);

    const conflicting = lineageFixture();
    conflicting.data.checkouts[0]!["渠道"] = "携程";
    expect(() => reconcileAuditSourceLineage(conflicting.data, conflicting.cutoverAt)).toThrow(/源渠道.*conflicts across raw sources/i);
  });
});

describe("historical-order operational approval seal", () => {
  function operationalRecords() {
    return Array.from({ length: 44 }, (_, index) => ({
      disposition: "OPERATIONAL",
      source: { orderId: String(10_000 + index) },
      observedLifecycle: index < 36 ? "IN_HOUSE" : "RESERVED",
      sourceStay: { arrivalDate: "2026-08-10", departureDate: "2026-08-12" },
      stayType: "STANDARD",
      segments: [{
        sequence: 1,
        sourceRoom: `room-${index}`,
        inventoryUnitCode: `UNIT-${index}`,
        roomType: "synthetic-room-type",
        arrivalDate: "2026-08-10",
        departureDate: "2026-08-12",
        amountFen: 10_000 + index,
        sourceStatus: index < 36 ? "synthetic-in-house" : "synthetic-reserved"
      }],
      guest: {
        name: `Synthetic Private Guest ${index}`,
        nameProvenance: index % 2 === 0 ? "MANUAL_CONFIRMATION" : "FEISHU_UNIQUE_MATCH",
        nickname: `Synthetic Nickname ${index}`,
        nicknameProvenance: "MANUAL_CONFIRMATION",
        phone: `1380000${String(index).padStart(4, "0")}`,
        phoneProvenance: index % 2 === 0 ? "MANUAL_CONFIRMATION" : "FEISHU_UNIQUE_MATCH"
      },
      manualConfirmation: {
        businessType: null,
        observedLifecycle: index < 36 ? "IN_HOUSE" : "RESERVED",
        room: `UNIT-${index}`,
        reason: `Synthetic review ${index}`,
        latestCorrection: null,
        correctionSource: null
      },
      channel: { raw: "微信", normalized: "WECOM", externalOrderNo: null, externalOrderNoStatus: "NOT_APPLICABLE" },
      pricing: { basis: "POLICY", currentContractAmountFen: 10_000 + index },
      flags: []
    }));
  }

  it("binds all 44 operational business tuples to an owner-approved SHA-256", () => {
    const records = operationalRecords();
    const approved = "dd29bcf5a3b2efaf277fc0d17921e54386f236d41a44d2cf23de35ce922e3063";
    expect(operationalTupleHash(records)).toBe(approved);
    expect(historicalOperationalTupleHash(records as never)).toBe(approved);
    expect(() => assertApprovedOperationalTupleHash(records, approved)).not.toThrow();

    const inspection = inspectOperationalTuples(records);
    expect(inspection).toEqual({
      mode: "INSPECTION_ONLY",
      approved: false,
      operationalOrderCount: 44,
      operationalTuplesSha256: approved
    });
    expect(JSON.stringify(inspection)).not.toContain("Synthetic Private Guest 0");

    const swapped = structuredClone(records);
    [swapped[0]!.pricing.currentContractAmountFen, swapped[1]!.pricing.currentContractAmountFen] = [
      swapped[1]!.pricing.currentContractAmountFen,
      swapped[0]!.pricing.currentContractAmountFen
    ];
    expect(() => assertApprovedOperationalTupleHash(swapped, approved)).toThrow(/approved operational tuple hash mismatch/i);

    const swappedGuest = structuredClone(records);
    [swappedGuest[0]!.guest, swappedGuest[1]!.guest] = [swappedGuest[1]!.guest, swappedGuest[0]!.guest];
    expect(historicalOperationalTupleHash(swappedGuest as never)).not.toBe(approved);
    expect(() => assertApprovedOperationalTupleHash(swappedGuest, approved)).toThrow(/approved operational tuple hash mismatch/i);

    const changedConfirmation = structuredClone(records);
    changedConfirmation[0]!.manualConfirmation.reason = "Different owner-reviewed reason";
    expect(historicalOperationalTupleHash(changedConfirmation as never)).not.toBe(approved);
    expect(() => assertApprovedOperationalTupleHash(changedConfirmation, approved)).toThrow(/approved operational tuple hash mismatch/i);
  });

  it("rejects a missing approval and any tuple set other than 44 orders", () => {
    const records = operationalRecords();
    expect(() => assertApprovedOperationalTupleHash(records, "")).toThrow(/approved operational tuple SHA-256/i);
    expect(() => assertApprovedOperationalTupleHash(records.slice(0, 43), hash("a"))).toThrow(/expected 44 operational tuples/i);
    records[1]!.source.orderId = records[0]!.source.orderId;
    expect(() => assertApprovedOperationalTupleHash(records, hash("a"))).toThrow(/source order ids must be unique/i);
  });
});

describe("historical-order private output", () => {
  it("creates both outputs exclusively with owner-only permissions", () => {
    const directory = mkdtempSync(join(tmpdir(), "qtp-historical-output-"));
    try {
      const manifestPath = join(directory, "manifest.json");
      const reviewPath = join(directory, "review.md");
      writePrivateOutputPair({ manifestPath, manifestContent: "manifest\n", reviewPath, reviewContent: "review\n" });
      expect(readFileSync(manifestPath, "utf8")).toBe("manifest\n");
      expect(readFileSync(reviewPath, "utf8")).toBe("review\n");
      expect(statSync(manifestPath).mode & 0o777).toBe(0o600);
      expect(statSync(reviewPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses existing 0644 outputs and removes only files created by this invocation", () => {
    const directory = mkdtempSync(join(tmpdir(), "qtp-historical-output-"));
    try {
      const manifestPath = join(directory, "manifest.json");
      const reviewPath = join(directory, "review.md");
      writeFileSync(manifestPath, "existing manifest", { mode: 0o644 });
      expect(() => writePrivateOutputPair({ manifestPath, manifestContent: "new", reviewPath, reviewContent: "new" })).toThrow();
      expect(readFileSync(manifestPath, "utf8")).toBe("existing manifest");
      expect(statSync(manifestPath).mode & 0o777).toBe(0o644);
      expect(existsSync(reviewPath)).toBe(false);

      rmSync(manifestPath);
      writeFileSync(reviewPath, "existing review", { mode: 0o644 });
      expect(() => writePrivateOutputPair({ manifestPath, manifestContent: "new", reviewPath, reviewContent: "new" })).toThrow();
      expect(existsSync(manifestPath)).toBe(false);
      expect(readFileSync(reviewPath, "utf8")).toBe("existing review");
      expect(statSync(reviewPath).mode & 0o777).toBe(0o644);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("historical-order manifest reviewed business rules", () => {
  it("accepts only the exact reviewed auto-adoption enum", () => {
    expect(isAutoAdopted({ "建议自动采用": "建议采用" })).toBe(true);
    expect(isAutoAdopted({ "建议自动采用": "是" })).toBe(true);
    expect(isAutoAdopted({ "建议自动采用": "否" })).toBe(false);
    expect(isAutoAdopted({ "建议自动采用": null })).toBe(false);
    expect(() => isAutoAdopted({ "建议自动采用": "不建议采用" })).toThrow(/unsupported reviewed auto-adoption value/i);
  });

  it("excludes any zero-value unassigned-room segment without consulting an order id", () => {
    const result = buildOperationalSegments([
      sourceSegment({ "归属订单号": "synthetic-a", "房间号": "未排房", "住宿金额": 0 }),
      sourceSegment({ "归属订单号": "synthetic-a", "段序号": 2 })
    ]);

    expect(result).toMatchObject({
      excludedPlaceholderCount: 1,
      segments: [{ sequence: 2, inventoryUnitCode: "A03", amountFen: 102_000 }]
    });

    const nonzero = buildOperationalSegments([
      sourceSegment({ "归属订单号": "synthetic-b", "房间号": "未排房", "住宿金额": 1 })
    ]);
    expect(nonzero.excludedPlaceholderCount).toBe(0);
    expect(nonzero.segments).toHaveLength(1);
  });

  it("derives the legacy member payload from reviewed business type, guest and segment", () => {
    const result = deriveReviewedSpecialFields(reviewedSpecialInput({
      observedLifecycle: "IN_HOUSE",
      stayType: "MEMBER_ENTITLEMENT",
      sourceStay: { arrivalDate: "2026-08-06", departureDate: "2026-08-25" },
      segments: [{ inventoryUnitCode: "D01", arrivalDate: "2026-08-06", departureDate: "2026-08-25", amountFen: 0 }],
      guest: { name: "Reviewed Guest", nickname: "Reviewed Guest" },
      manualConfirmation: { businessType: "MEMBER_ENTITLEMENT", latestCorrection: null, correctionSource: null }
    }));

    expect(result.flags).toEqual(["LEGACY_MEMBER_ENTITLEMENT_RECONSTRUCTION"]);
    expect(result.membership).toMatchObject({
      memberName: "Reviewed Guest",
      entitlement: {
        quantity: 19,
        serviceStartDate: "2026-08-06",
        serviceEndDate: "2026-08-24"
      },
      consumption: { quantity: 19 }
    });
  });

  it("identifies free reception only from the reviewed business type", () => {
    const result = deriveReviewedSpecialFields(reviewedSpecialInput({
      stayType: "FREE_RECEPTION",
      manualConfirmation: { businessType: "FREE_RECEPTION", latestCorrection: null, correctionSource: null }
    }));

    expect(result).toEqual({ flags: ["FREE_RECEPTION_CONFIRMED"], membership: null });
  });

  it("requires explicit V4 evidence for an expired in-house record and derives the overdue flags", () => {
    const expired = reviewedSpecialInput({
      observedLifecycle: "IN_HOUSE",
      sourceStay: { arrivalDate: "2026-08-08", departureDate: "2026-08-09" },
      segments: [{ inventoryUnitCode: "306", arrivalDate: "2026-08-08", departureDate: "2026-08-09", amountFen: 13_000 }]
    });

    expect(() => deriveReviewedSpecialFields(expired)).toThrow(/requires an explicit V4 correction/i);
    expect(deriveReviewedSpecialFields({
      ...expired,
      manualConfirmation: { businessType: null, latestCorrection: "reviewed as still in house", correctionSource: "operator confirmation" }
    }).flags).toEqual(["LIVE_DEPARTURE_DATE_UNCONFIRMED", "KEEP_INVENTORY_UNAVAILABLE"]);

    expect(deriveReviewedSpecialFields(reviewedSpecialInput({
      observedLifecycle: "IN_HOUSE",
      sourceStay: { arrivalDate: "2026-08-10", departureDate: "2026-08-11" },
      segments: [{ inventoryUnitCode: "306", arrivalDate: "2026-08-10", departureDate: "2026-08-11", amountFen: 13_000 }],
      manualConfirmation: { businessType: null, latestCorrection: "reviewed correction", correctionSource: "operator confirmation" }
    })).flags).toEqual([]);
  });

  it("fails closed unless each approved reviewed special case is unique", () => {
    const records = [
      { flags: ["LEGACY_MEMBER_ENTITLEMENT_RECONSTRUCTION"] },
      { flags: ["FREE_RECEPTION_CONFIRMED"] },
      { flags: ["LIVE_DEPARTURE_DATE_UNCONFIRMED"] },
      { flags: ["ZERO_VALUE_PLACEHOLDER_SEGMENT_EXCLUDED"] }
    ];
    expect(() => assertReviewedSpecialCaseCardinality(records)).not.toThrow();
    expect(() => assertReviewedSpecialCaseCardinality([
      ...records,
      { flags: ["LIVE_DEPARTURE_DATE_UNCONFIRMED"] }
    ])).toThrow(/LIVE_DEPARTURE_DATE_UNCONFIRMED.*expected 1, got 2/i);
  });

  it("keeps the generated review wording scoped to room and business labels", () => {
    const markdown = reviewMarkdown({
      approvedOperationalTuplesSha256: hash("7"),
      expected: {
        candidateCount: 1,
        historicalAccommodationArchives: 0,
        nonAccommodationArchives: 0,
        operationalOrders: 1,
        operationalSegmentCount: 1,
        totalAccommodationAmountFen: 13_000
      },
      records: [{
        disposition: "OPERATIONAL",
        observedLifecycle: "IN_HOUSE",
        guest: { name: "Synthetic Review Guest" },
        channel: { externalOrderNoStatus: "NOT_APPLICABLE" }
      }],
      source: { workbook: { sha256: hash("9") } }
    }, hash("8"));

    expect(markdown).toContain("逾期在住修正单继续锁定 306");
    expect(markdown).toContain("会员权益单仍在住 D01");
    expect(markdown).toContain(hash("7"));
    expect(markdown).not.toContain("Synthetic Review Guest");
  });
});

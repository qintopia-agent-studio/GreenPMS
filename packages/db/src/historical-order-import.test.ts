import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stableHash } from "@qintopia/domain";
import {
  historicalOperationalTupleHash,
  manifestStableHash,
  loadHistoricalOrderImportManifest,
  parseHistoricalOrderImportManifest
} from "./historical-order-import.ts";

const emptyHash = "a".repeat(64);
const CUTOVER_AT = "2026-08-09T13:31:00+08:00";
const CONTROLLED_STALE_COST_EXPORT = {
  role: "COST_EXPORT",
  fileName: "Accommodation Cost Details.xlsx",
  sha256: "eca5cd18eed450aaa457ac2e2bb1cd085650a59417da684a066c0f695045c789",
  rowCount: 7162,
  exportedAt: "2026-08-08T21:30:14+08:00"
};
const CURRENT_CUTOVER_CONFIRMATION = "用户于2026-08-10确认今天数据无变化，沿用昨日提供数据";

function completeSourceFiles() {
  return [
    { role: "ORDER_EXPORT", fileName: "orders.xlsx", sha256: emptyHash, rowCount: 1, exportedAt: "2026-08-09T12:00:00+08:00" },
    { role: "COST_EXPORT", fileName: "costs.xlsx", sha256: emptyHash, rowCount: 1, exportedAt: "2026-08-09T12:00:00+08:00" },
    { role: "CHECKOUT_EXPORT", fileName: "checkouts.xlsx", sha256: emptyHash, rowCount: 1, exportedAt: "2026-08-09T12:00:00+08:00" },
    { role: "FEISHU_MATCH_BASELINE", fileName: "feishu.xlsx", sha256: emptyHash, rowCount: null, exportedAt: null },
    { role: "USER_CONFIRMATION_REVIEW", fileName: "user-review.xlsx", sha256: emptyHash, rowCount: null, exportedAt: null },
    { role: "BUSINESS_CONFIRMATION_REVIEW", fileName: "business-review.xlsx", sha256: emptyHash, rowCount: null, exportedAt: null },
    { role: "REVIEW_WORKBOOK", fileName: "review.xlsx", sha256: emptyHash, rowCount: 1, exportedAt: "2026-08-09T13:30:00+08:00" }
  ];
}

function sourceBoundNoChangeConfirmation(file: Record<string, unknown>, cutoverAt: string): Record<string, unknown> {
  return {
    type: "USER_CONFIRMED_NO_CHANGE_THROUGH_CUTOVER",
    sourceRole: file.role,
    sourceFileName: file.fileName,
    sourceSha256: file.sha256,
    sourceExportedAt: file.exportedAt,
    confirmedOn: "2026-08-10",
    cutoverAt,
    evidenceText: CURRENT_CUTOVER_CONFIRMATION
  };
}

function applyControlledStaleCostSource(file: Record<string, unknown>): void {
  Object.assign(file, CONTROLLED_STALE_COST_EXPORT);
}

function manifestFixture(): Record<string, unknown> {
  const record = {
    canonicalPayloadHash: "",
    channel: { raw: "自来客", normalized: "WECOM", externalOrderNo: null, externalOrderNoStatus: "NOT_APPLICABLE" },
    disposition: "HISTORICAL_ARCHIVE",
    flags: [],
    guest: { name: null, nameProvenance: "HISTORICAL_NOT_RECORDED", nickname: null, nicknameProvenance: "HISTORICAL_NOT_RECORDED", phone: null, phoneProvenance: "HISTORICAL_NOT_RECORDED" },
    manualConfirmation: {},
    membership: null,
    observedLifecycle: "ARCHIVED",
    pricing: { basis: "POLICY", currency: "CNY", currentContractAmountFen: 0, evidence: { historicalActualAmountFen: 0 }, origin: "MIGRATED_ACTUAL" },
    provenance: { rawSnapshot: {} },
    recordKind: "ACCOMMODATION",
    segments: [],
    source: { auditRow: 1, orderId: "source-1", sourceValuesHash: emptyHash, system: "ORDER_LAILE" },
    sourceStay: { arrivalDate: "2026-03-13", departureDate: "2026-03-14" },
    stayType: "STANDARD"
  };
  record.canonicalPayloadHash = stableHash(Object.fromEntries(Object.entries(record).filter(([key]) => key !== "canonicalPayloadHash")));
  const manifest = {
    approvedOperationalTuplesSha256: historicalOperationalTupleHash([]),
    currency: "CNY",
    cutoverAt: CUTOVER_AT,
    expected: {
      candidateCount: 1,
      historicalAccommodationAmountFen: 0,
      historicalAccommodationArchives: 1,
      nonAccommodationArchives: 0,
      operationalAccommodationAmountFen: 0,
      operationalOrders: 0,
      operationalSegmentCount: 0,
      totalAccommodationAmountFen: 0
    },
    generatorVersion: "historical-order-manifest-v1",
    idempotencyKey: "historical-order-import:fixture",
    importStartDate: "2026-03-13",
    manifestHash: "",
    manifestVersion: 1,
    propertyCode: "QTP-XA",
    records: [record],
    source: { sourceFiles: completeSourceFiles(), workbook: { fileName: "fixture.xlsx", sha256: emptyHash } },
    sourceSystem: "ORDER_LAILE"
  };
  manifest.manifestHash = manifestStableHash(manifest);
  return manifest;
}

function rehashRecordAndManifest(manifest: Record<string, unknown>): void {
  const record = (manifest.records as Array<Record<string, unknown>>)[0]!;
  record.canonicalPayloadHash = stableHash(Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== "canonicalPayloadHash")
  ));
  manifest.approvedOperationalTuplesSha256 = historicalOperationalTupleHash(manifest.records as never);
  manifest.manifestHash = manifestStableHash(manifest);
}

describe("historical order import manifest", () => {
  it("uses a stable key-sorted hash and accepts a validated fixture", () => {
    const fixture = manifestFixture();
    expect(manifestStableHash(fixture)).toBe((fixture as { manifestHash: string }).manifestHash);
    expect(parseHistoricalOrderImportManifest(JSON.stringify(fixture)).records).toHaveLength(1);
  });

  it("returns a deeply immutable validated manifest so cached validation cannot be bypassed", () => {
    const parsed = parseHistoricalOrderImportManifest(manifestFixture());
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.records)).toBe(true);
    expect(Object.isFrozen(parsed.records[0])).toBe(true);
    expect(Object.isFrozen(parsed.records[0]!.pricing)).toBe(true);
    expect(Object.isFrozen(parsed.records[0]!.pricing.evidence)).toBe(true);
    expect(() => {
      parsed.records[0]!.pricing.currentContractAmountFen = 1;
    }).toThrow(TypeError);
    expect(parsed.records[0]!.pricing.currentContractAmountFen).toBe(0);
  });

  it("rejects a changed canonical record payload and a changed manifest hash", () => {
    const fixture = manifestFixture();
    ((fixture.records as Array<Record<string, unknown>>)[0]!.pricing as Record<string, unknown>).currentContractAmountFen = 1;
    fixture.manifestHash = manifestStableHash(fixture);
    expect(() => parseHistoricalOrderImportManifest(JSON.stringify(fixture))).toThrow(/canonical payload hash/i);

    const changedManifest = manifestFixture();
    changedManifest.propertyCode = "QTP-OTHER";
    expect(() => parseHistoricalOrderImportManifest(JSON.stringify(changedManifest))).toThrow(/manifest hash/i);
  });

  it("recomputes the approved operational tuple hash instead of trusting the manifest field", () => {
    const fixture = manifestFixture();
    fixture.approvedOperationalTuplesSha256 = "b".repeat(64);
    fixture.manifestHash = manifestStableHash(fixture);
    expect(() => parseHistoricalOrderImportManifest(fixture)).toThrow(/approved operational tuple hash/i);
  });

  it("rejects duplicate source keys, malformed amount/date values, and invalid operational shapes", () => {
    const duplicate = manifestFixture();
    (duplicate.records as unknown[]).push(structuredClone((duplicate.records as unknown[])[0]));
    (duplicate.expected as Record<string, unknown>).candidateCount = 2;
    duplicate.manifestHash = manifestStableHash(duplicate);
    expect(() => parseHistoricalOrderImportManifest(JSON.stringify(duplicate))).toThrow(/duplicate source/i);

    const malformed = manifestFixture();
    const malformedRecord = (malformed.records as Array<Record<string, unknown>>)[0]!;
    (malformedRecord.pricing as Record<string, unknown>).currentContractAmountFen = 1.5;
    malformedRecord.canonicalPayloadHash = stableHash(Object.fromEntries(Object.entries(malformedRecord).filter(([key]) => key !== "canonicalPayloadHash")));
    malformed.manifestHash = manifestStableHash(malformed);
    expect(() => parseHistoricalOrderImportManifest(JSON.stringify(malformed))).toThrow(/integer/i);

    const invalidOperational = manifestFixture();
    const record = (invalidOperational.records as Array<Record<string, unknown>>)[0]!;
    record.disposition = "OPERATIONAL";
    record.observedLifecycle = "IN_HOUSE";
    record.segments = [];
    record.canonicalPayloadHash = stableHash(Object.fromEntries(Object.entries(record).filter(([key]) => key !== "canonicalPayloadHash")));
    invalidOperational.manifestHash = manifestStableHash(invalidOperational);
    expect(() => parseHistoricalOrderImportManifest(JSON.stringify(invalidOperational))).toThrow(/operational.*segment/i);
  });

  it("requires the complete source-role set and source-bound confirmation for an earlier raw export", () => {
    const missingRole = manifestFixture();
    const files = ((missingRole.source as Record<string, unknown>).sourceFiles as Array<Record<string, unknown>>);
    files.splice(files.findIndex((file) => file.role === "COST_EXPORT"), 1);
    missingRole.manifestHash = manifestStableHash(missingRole);
    expect(() => parseHistoricalOrderImportManifest(missingRole)).toThrow(/source file roles/i);

    const missingTimestamp = manifestFixture();
    const rawFiles = ((missingTimestamp.source as Record<string, unknown>).sourceFiles as Array<Record<string, unknown>>);
    rawFiles.find((file) => file.role === "ORDER_EXPORT")!.exportedAt = null;
    missingTimestamp.manifestHash = manifestStableHash(missingTimestamp);
    expect(() => parseHistoricalOrderImportManifest(missingTimestamp)).toThrow(/exportedAt/i);

    const stale = manifestFixture();
    const staleFiles = ((stale.source as Record<string, unknown>).sourceFiles as Array<Record<string, unknown>>);
    const costFile = staleFiles.find((file) => file.role === "COST_EXPORT")!;
    applyControlledStaleCostSource(costFile);
    stale.manifestHash = manifestStableHash(stale);
    expect(() => parseHistoricalOrderImportManifest(stale)).toThrow(/source-bound no-change confirmation/i);
  });

  it("accepts only the frozen COST_EXPORT confirmation after every structured binding matches", () => {
    const stale = manifestFixture();
    const staleFiles = ((stale.source as Record<string, unknown>).sourceFiles as Array<Record<string, unknown>>);
    const costFile = staleFiles.find((file) => file.role === "COST_EXPORT")!;
    applyControlledStaleCostSource(costFile);
    costFile.unchangedConfirmation = sourceBoundNoChangeConfirmation(costFile, stale.cutoverAt as string);
    stale.manifestHash = manifestStableHash(stale);

    const parsed = parseHistoricalOrderImportManifest(stale);
    expect(parsed.source.sourceFiles.find((file) => file.role === "COST_EXPORT")?.unchangedConfirmation).toMatchObject({
      sourceRole: "COST_EXPORT",
      sourceFileName: "Accommodation Cost Details.xlsx",
      sourceExportedAt: "2026-08-08T21:30:14+08:00",
      confirmedOn: "2026-08-10",
      cutoverAt: CUTOVER_AT,
      evidenceText: CURRENT_CUTOVER_CONFIRMATION
    });
  });

  it("rejects generalized confirmations and every stale-source binding mismatch", () => {
    const generalized = manifestFixture();
    const generalizedFiles = ((generalized.source as Record<string, unknown>).sourceFiles as Array<Record<string, unknown>>);
    generalizedFiles.find((file) => file.role === "ORDER_EXPORT")!.unchangedConfirmation = "用户确认数据无变化";
    generalized.manifestHash = manifestStableHash(generalized);
    expect(() => parseHistoricalOrderImportManifest(generalized)).toThrow(/unchangedConfirmation.*object/i);

    const mutations: Array<[string, unknown]> = [
      ["type", "GENERAL_NO_CHANGE"],
      ["sourceRole", "ORDER_EXPORT"],
      ["sourceFileName", "other-costs.xlsx"],
      ["sourceSha256", "b".repeat(64)],
      ["sourceExportedAt", "2026-08-08T21:30:15+08:00"],
      ["confirmedOn", "2026-08-08"],
      ["cutoverAt", "2026-08-09T13:29:00+08:00"],
      ["evidenceText", "数据无变化"]
    ];
    for (const [field, value] of mutations) {
      const candidate = manifestFixture();
      const files = ((candidate.source as Record<string, unknown>).sourceFiles as Array<Record<string, unknown>>);
      const costFile = files.find((file) => file.role === "COST_EXPORT")!;
      applyControlledStaleCostSource(costFile);
      const confirmation = sourceBoundNoChangeConfirmation(costFile, candidate.cutoverAt as string);
      confirmation[field] = value;
      costFile.unchangedConfirmation = confirmation;
      candidate.manifestHash = manifestStableHash(candidate);
      expect(() => parseHistoricalOrderImportManifest(candidate), field).toThrow(/unchangedConfirmation/i);
    }

    const extraField = manifestFixture();
    const extraFiles = ((extraField.source as Record<string, unknown>).sourceFiles as Array<Record<string, unknown>>);
    const extraCost = extraFiles.find((file) => file.role === "COST_EXPORT")!;
    applyControlledStaleCostSource(extraCost);
    extraCost.unchangedConfirmation = { ...sourceBoundNoChangeConfirmation(extraCost, extraField.cutoverAt as string), note: "general" };
    extraField.manifestHash = manifestStableHash(extraField);
    expect(() => parseHistoricalOrderImportManifest(extraField)).toThrow(/exact source-bound confirmation fields/i);
  });

  it("rejects another earlier raw source and a future raw export even with structured confirmations", () => {
    const staleCheckout = manifestFixture();
    const staleFiles = ((staleCheckout.source as Record<string, unknown>).sourceFiles as Array<Record<string, unknown>>);
    const checkoutFile = staleFiles.find((file) => file.role === "CHECKOUT_EXPORT")!;
    checkoutFile.exportedAt = "2026-08-08T21:30:14+08:00";
    checkoutFile.unchangedConfirmation = sourceBoundNoChangeConfirmation(checkoutFile, staleCheckout.cutoverAt as string);
    staleCheckout.manifestHash = manifestStableHash(staleCheckout);
    expect(() => parseHistoricalOrderImportManifest(staleCheckout)).toThrow(/exact approved stale raw export/i);

    const future = manifestFixture();
    const files = ((future.source as Record<string, unknown>).sourceFiles as Array<Record<string, unknown>>);
    const costFile = files.find((file) => file.role === "COST_EXPORT")!;
    applyControlledStaleCostSource(costFile);
    costFile.exportedAt = "2026-08-09T13:31:01+08:00";
    costFile.unchangedConfirmation = sourceBoundNoChangeConfirmation(costFile, future.cutoverAt as string);
    future.manifestHash = manifestStableHash(future);
    expect(() => parseHistoricalOrderImportManifest(future)).toThrow(/cannot be exported later/i);
  });

  it("rejects timestamps that JavaScript would normalize past their written business date", () => {
    const invalidCutover = manifestFixture();
    invalidCutover.cutoverAt = "2026-08-09T24:00:00+08:00";
    invalidCutover.manifestHash = manifestStableHash(invalidCutover);
    expect(() => parseHistoricalOrderImportManifest(invalidCutover)).toThrow(/timestamp/i);

    const invalidExport = manifestFixture();
    const files = ((invalidExport.source as Record<string, unknown>).sourceFiles as Array<Record<string, unknown>>);
    files.find((file) => file.role === "ORDER_EXPORT")!.exportedAt = "2026-08-09T12:60:00+08:00";
    invalidExport.manifestHash = manifestStableHash(invalidExport);
    expect(() => parseHistoricalOrderImportManifest(invalidExport)).toThrow(/timestamp/i);
  });

  it("enforces the exact channel-reference truth table", () => {
    const wecomMissing = manifestFixture();
    const wecomChannel = ((wecomMissing.records as Array<Record<string, unknown>>)[0]!.channel as Record<string, unknown>);
    wecomChannel.externalOrderNoStatus = "HISTORICAL_NOT_RECORDED";
    rehashRecordAndManifest(wecomMissing);
    expect(() => parseHistoricalOrderImportManifest(wecomMissing)).toThrow(/WECOM.*NOT_APPLICABLE/i);

    const externalNotApplicable = manifestFixture();
    const externalChannel = ((externalNotApplicable.records as Array<Record<string, unknown>>)[0]!.channel as Record<string, unknown>);
    externalChannel.raw = "携程";
    externalChannel.normalized = "CTRIP";
    rehashRecordAndManifest(externalNotApplicable);
    expect(() => parseHistoricalOrderImportManifest(externalNotApplicable)).toThrow(/external channel.*HISTORICAL_NOT_RECORDED/i);

    const noChannelMissing = manifestFixture();
    const noChannel = ((noChannelMissing.records as Array<Record<string, unknown>>)[0]!.channel as Record<string, unknown>);
    noChannel.raw = null;
    noChannel.normalized = null;
    noChannel.externalOrderNoStatus = "HISTORICAL_NOT_RECORDED";
    rehashRecordAndManifest(noChannelMissing);
    expect(() => parseHistoricalOrderImportManifest(noChannelMissing)).toThrow(/without a channel.*NOT_APPLICABLE/i);
  });

  it("rejects operational guest data that cannot be persisted by the core order schema", () => {
    const missingName = manifestFixture();
    const missingNameRecord = (missingName.records as Array<Record<string, unknown>>)[0]!;
    missingNameRecord.disposition = "OPERATIONAL";
    missingNameRecord.observedLifecycle = "IN_HOUSE";
    missingNameRecord.segments = [{
      sequence: 1,
      sourceOrderRow: 1,
      sourceRoom: "A01",
      inventoryUnitCode: "A01",
      roomType: "标准间",
      arrivalDate: "2026-08-09",
      departureDate: "2026-08-10",
      amountFen: 0,
      sourceStatus: "在住"
    }];
    rehashRecordAndManifest(missingName);
    expect(() => parseHistoricalOrderImportManifest(missingName)).toThrow(/operational guest name/i);

    const longPhone = structuredClone(missingName);
    const longPhoneRecord = (longPhone.records as Array<Record<string, unknown>>)[0]!;
    const guest = longPhoneRecord.guest as Record<string, unknown>;
    guest.name = "历史住客";
    guest.phone = "1".repeat(81);
    rehashRecordAndManifest(longPhone);
    expect(() => parseHistoricalOrderImportManifest(longPhone)).toThrow(/guest phone.*80/i);
  });

  it("loads a manifest only from an owner-private regular file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qintopia-historical-manifest-"));
    const path = join(directory, "manifest.json");
    try {
      await writeFile(path, JSON.stringify(manifestFixture()), { mode: 0o600 });
      await chmod(path, 0o644);
      await expect(loadHistoricalOrderImportManifest(path)).rejects.toThrow(/accessible only by its owner/i);

      await chmod(path, 0o600);
      await expect(loadHistoricalOrderImportManifest(path)).resolves.toMatchObject({ manifestVersion: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

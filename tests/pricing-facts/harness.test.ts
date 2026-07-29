import { compilePricingFactSchema, assertPricingFactCoverage, executePricingFactCases, PricingFactsError, validatePricingFactDocuments, type PricingFactCase, type PricingFactScenarioTag } from "./harness.ts";
import schema from "../../docs/pricing-facts/pricing-case.schema.json";

const plans = ["TRANSIENT", "WEEKLY", "MONTHLY", "CUSTOM", "FIXED_TERM", "ROLLING", "FREE"] as const;
const distributedTags: PricingFactScenarioTag[][] = [
  ["BASELINE", "BOUNDARY"],
  ["RESCHEDULE", "BOUNDARY"],
  ["EXTEND"],
  ["MOVE"],
  ["CROSS_MONTH"],
  ["PARTIAL_MEMBER_COVERAGE"],
  ["MANUAL_ADJUSTMENT"]
];

function pricingCase(index: number): PricingFactCase {
  const amendmentByTag = {
    RESCHEDULE: "RESCHEDULE_STAY",
    EXTEND: "EXTEND_STAY",
    MOVE: "MOVE_UNIT"
  } as const;
  const changeTag = distributedTags[index]!.find((tag): tag is keyof typeof amendmentByTag => Object.hasOwn(amendmentByTag, tag));
  const arrivalDate = "2026-01-01";
  const hasPartialCoverage = distributedTags[index]!.includes("PARTIAL_MEMBER_COVERAGE");
  const departureDate = distributedTags[index]!.includes("CROSS_MONTH") || hasPartialCoverage ? "2026-02-02" : "2026-01-02";
  const coverageSet: PricingFactCase["coverageSet"] = hasPartialCoverage
    ? [{ serviceDate: arrivalDate, inventoryUnitReference: `synthetic-unit-${index}`, unitKind: index % 2 === 0 ? "ROOM_NIGHT" : "BED_NIGHT" }]
    : [];
  const cashLines = hasPartialCoverage ? [{ syntheticCashLine: index }] : [];
  const revisions: PricingFactCase["expected"]["pricingRevisions"] = [{
    revisionNo: 1,
    amendmentType: "CREATE_ORDER",
    pricingPolicyVersionReference: "synthetic-policy-v1",
    arrivalDate,
    departureDate,
    coverageSet,
    cashLines,
    manualAdjustmentMinor: 0,
    cashRemainderMinor: index,
    currentContractAmountMinor: index,
    roundingEvidence: { syntheticHarnessRule: "NONE" }
  }];
  if (changeTag) revisions.push({ ...revisions[0]!, revisionNo: 2, amendmentType: amendmentByTag[changeTag] });
  if (distributedTags[index]!.includes("MANUAL_ADJUSTMENT")) {
    revisions.push({ ...revisions.at(-1)!, revisionNo: revisions.length + 1, amendmentType: "REPRICE_ORDER", manualAdjustmentMinor: index || 1 });
  }
  const amendments: PricingFactCase["amendments"] = revisions.slice(1).map((revision) => ({
    sequence: revision.revisionNo,
    amendmentType: revision.amendmentType as Exclude<typeof revision.amendmentType, "CREATE_ORDER">,
    requestedAt: "2026-01-01T10:00:00.000Z",
    input: { syntheticHarnessInput: revision.revisionNo }
  }));
  return {
    caseId: `synthetic-harness-${index}`,
    anonymizedOrderRef: `SYNTHETIC-${index}`,
    businessExplanation: "Synthetic data used only to test the fail-closed harness",
    businessPlan: plans[index]!,
    scenarioTags: distributedTags[index]!,
    propertyTimeZone: "Asia/Shanghai",
    currency: "CNY",
    inventoryUnitKind: index % 2 === 0 ? "ROOM" : "BED",
    arrivalDate,
    departureDate,
    departureCharged: false,
    priceInputs: { syntheticHarnessInput: index },
    coverageSet,
    amendments,
    rounding: { syntheticHarnessRule: "NONE" },
    ...(distributedTags[index]!.includes("BOUNDARY") ? {
      boundaryEvidence: {
        boundaryName: "Synthetic harness boundary",
        comparisonCaseId: `synthetic-harness-${index === 0 ? 1 : 0}`,
        observedBehaviorChange: "Synthetic evidence used only to exercise structural validation"
      }
    } : {}),
    expected: { pricingRevisions: revisions, cashLines, cashRemainderMinor: index, currentContractAmountMinor: index }
  };
}

function completeCases(): PricingFactCase[] {
  return plans.map((_, index) => pricingCase(index));
}

describe("real pricing fact completion gate", () => {
  const validate = compilePricingFactSchema(schema);

  it("fails closed when no real pricing documents are supplied", () => {
    expect(() => validatePricingFactDocuments([], validate)).toThrow(expect.objectContaining({ code: "PRICING_FACTS_MISSING" }));
  });

  it("reports JSON Schema errors before any policy execution", () => {
    expect(() => validatePricingFactDocuments([{ fileName: "invalid.json", value: { caseId: "invalid" } }], validate)).toThrow(
      expect.objectContaining({ code: "PRICING_FACT_SCHEMA_INVALID" })
    );
  });

  it("requires unique case IDs", () => {
    const duplicate = pricingCase(0);
    expect(() => validatePricingFactDocuments([
      { fileName: "one.json", value: duplicate },
      { fileName: "two.json", value: duplicate }
    ], validate)).toThrow(expect.objectContaining({ code: "PRICING_FACT_SCHEMA_INVALID" }));
  });

  it("requires every plan, scenario tag, and two boundary cases", () => {
    expect(() => assertPricingFactCoverage([pricingCase(0)])).toThrow(expect.objectContaining({
      code: "PRICING_FACTS_COVERAGE_INCOMPLETE"
    }));
    expect(() => assertPricingFactCoverage(completeCases())).not.toThrow();
  });

  it("does not accept scenario labels without structural evidence", () => {
    const missingCrossMonth = completeCases();
    const crossMonth = missingCrossMonth.find((entry) => entry.scenarioTags.includes("CROSS_MONTH"))!;
    crossMonth.expected.pricingRevisions = crossMonth.expected.pricingRevisions.map((revision) => ({ ...revision, departureDate: "2026-01-02" }));
    expect(() => assertPricingFactCoverage(missingCrossMonth)).toThrow(expect.objectContaining({ code: "PRICING_FACTS_COVERAGE_INCOMPLETE" }));

    const missingPartialCoverage = completeCases();
    const partial = missingPartialCoverage.find((entry) => entry.scenarioTags.includes("PARTIAL_MEMBER_COVERAGE"))!;
    partial.coverageSet = [];
    partial.expected.pricingRevisions = partial.expected.pricingRevisions.map((revision) => ({ ...revision, coverageSet: [] }));
    expect(() => assertPricingFactCoverage(missingPartialCoverage)).toThrow(expect.objectContaining({ code: "PRICING_FACTS_COVERAGE_INCOMPLETE" }));

    const missingBoundaryEvidence = completeCases();
    delete missingBoundaryEvidence.find((entry) => entry.scenarioTags.includes("BOUNDARY"))!.boundaryEvidence;
    expect(() => assertPricingFactCoverage(missingBoundaryEvidence)).toThrow(expect.objectContaining({ code: "PRICING_FACTS_COVERAGE_INCOMPLETE" }));

    const cosmeticBoundaryEvidence = completeCases();
    const boundary = cosmeticBoundaryEvidence.find((entry) => entry.scenarioTags.includes("BOUNDARY"))!;
    const comparison = cosmeticBoundaryEvidence.find((entry) => entry.caseId === boundary.boundaryEvidence!.comparisonCaseId)!;
    comparison.businessPlan = boundary.businessPlan;
    comparison.inventoryUnitKind = boundary.inventoryUnitKind;
    comparison.arrivalDate = boundary.arrivalDate;
    comparison.departureDate = boundary.departureDate;
    comparison.departureCharged = boundary.departureCharged;
    comparison.priceInputs = boundary.priceInputs;
    comparison.coverageSet = boundary.coverageSet;
    comparison.amendments = boundary.amendments;
    comparison.expected = boundary.expected;
    comparison.rounding = boundary.rounding;
    expect(() => assertPricingFactCoverage(cosmeticBoundaryEvidence)).toThrow(expect.objectContaining({ code: "PRICING_FACTS_COVERAGE_INCOMPLETE" }));

    const missingAmendmentInput = completeCases();
    missingAmendmentInput.find((entry) => entry.scenarioTags.includes("RESCHEDULE"))!.amendments = [];
    expect(() => assertPricingFactCoverage(missingAmendmentInput)).toThrow(expect.objectContaining({ code: "PRICING_FACTS_COVERAGE_INCOMPLETE" }));
  });

  it("rejects a complete fact set until every finite plan has an approved executor", async () => {
    await expect(executePricingFactCases(completeCases(), {})).rejects.toMatchObject({ code: "PRICING_FACT_EXECUTOR_MISSING" });
  });

  it("executes every case and compares the full result exactly", async () => {
    const cases = completeCases();
    const executor = (entry: PricingFactCase) => ({
      pricingRevisions: entry.expected.pricingRevisions,
      coverageSet: entry.coverageSet,
      cashLines: entry.expected.cashLines,
      cashRemainderMinor: entry.expected.cashRemainderMinor,
      currentContractAmountMinor: entry.expected.currentContractAmountMinor
    });
    await expect(executePricingFactCases(cases, Object.fromEntries(plans.map((plan) => [plan, executor])))).resolves.toBeUndefined();

    const mismatchExecutor = (entry: PricingFactCase) => ({ pricingRevisions: entry.expected.pricingRevisions, coverageSet: [], cashLines: [], cashRemainderMinor: 999, currentContractAmountMinor: 999 });
    await expect(executePricingFactCases(cases, Object.fromEntries(plans.map((plan) => [plan, mismatchExecutor])))).rejects.toMatchObject({
      code: "PRICING_FACT_MISMATCH"
    } satisfies Partial<PricingFactsError>);
  });
});

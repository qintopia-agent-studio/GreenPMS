import { createRequire } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";

interface SchemaValidationError {
  instancePath: string;
  message?: string;
}

export interface SchemaValidator<T> {
  (value: unknown): value is T;
  errors?: SchemaValidationError[] | null;
}

interface JsonSchemaValidator {
  compile<T>(schema: object): SchemaValidator<T>;
}

type JsonSchemaValidatorConstructor = new (options: { allErrors: boolean; strict: boolean }) => JsonSchemaValidator;
type AddFormats = (validator: JsonSchemaValidator) => void;

const require = createRequire(import.meta.url);
const ajvImport = require("ajv/dist/2020.js") as JsonSchemaValidatorConstructor | { default: JsonSchemaValidatorConstructor };
const formatsImport = require("ajv-formats") as AddFormats | { default: AddFormats };
const Ajv2020 = typeof ajvImport === "function" ? ajvImport : ajvImport.default;
const addFormats = typeof formatsImport === "function" ? formatsImport : formatsImport.default;

export const pricingFactBusinessPlans = ["TRANSIENT", "WEEKLY", "MONTHLY", "CUSTOM", "FIXED_TERM", "ROLLING", "FREE"] as const;
export type PricingFactBusinessPlan = (typeof pricingFactBusinessPlans)[number];

export const pricingFactScenarioTags = [
  "BASELINE",
  "RESCHEDULE",
  "EXTEND",
  "MOVE",
  "CROSS_MONTH",
  "PARTIAL_MEMBER_COVERAGE",
  "MANUAL_ADJUSTMENT",
  "BOUNDARY"
] as const;
export type PricingFactScenarioTag = (typeof pricingFactScenarioTags)[number];

export const requiredPricingFactScenarioTags = [
  "BASELINE",
  "RESCHEDULE",
  "EXTEND",
  "CROSS_MONTH",
  "PARTIAL_MEMBER_COVERAGE",
  "MANUAL_ADJUSTMENT",
  "BOUNDARY"
] as const satisfies readonly PricingFactScenarioTag[];

export type PricingFactsErrorCode =
  | "PRICING_FACTS_MISSING"
  | "PRICING_FACT_SCHEMA_INVALID"
  | "PRICING_FACTS_COVERAGE_INCOMPLETE"
  | "PRICING_FACT_EXECUTOR_MISSING"
  | "PRICING_FACT_MISMATCH";

export class PricingFactsError extends Error {
  constructor(
    public readonly code: PricingFactsErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "PricingFactsError";
  }
}

export interface PricingFactCoverageItem {
  serviceDate: string;
  inventoryUnitReference: string;
  unitKind: "ROOM_NIGHT" | "BED_NIGHT";
}

export interface PricingFactRevision {
  revisionNo: number;
  amendmentType: "CREATE_ORDER" | "RESCHEDULE_STAY" | "EXTEND_STAY" | "MOVE_UNIT" | "REPRICE_ORDER";
  pricingPolicyVersionReference: string;
  arrivalDate: string;
  departureDate: string;
  coverageSet: PricingFactCoverageItem[];
  cashLines: Record<string, unknown>[];
  manualAdjustmentMinor: number;
  cashRemainderMinor: number;
  currentContractAmountMinor: number;
  roundingEvidence: Record<string, unknown>;
}

export interface PricingFactAmendment {
  sequence: number;
  amendmentType: "RESCHEDULE_STAY" | "EXTEND_STAY" | "MOVE_UNIT" | "REPRICE_ORDER";
  requestedAt: string;
  input: Record<string, unknown>;
}

export interface PricingFactCase {
  caseId: string;
  anonymizedOrderRef: string;
  businessExplanation: string;
  businessPlan: PricingFactBusinessPlan;
  scenarioTags: PricingFactScenarioTag[];
  propertyTimeZone: string;
  currency: string;
  inventoryUnitKind: "ROOM" | "BED";
  arrivalDate: string;
  departureDate: string;
  departureCharged: boolean;
  priceInputs: Record<string, unknown>;
  coverageSet: PricingFactCoverageItem[];
  amendments: PricingFactAmendment[];
  rounding: Record<string, unknown>;
  boundaryEvidence?: {
    boundaryName: string;
    comparisonCaseId: string;
    observedBehaviorChange: string;
  };
  expected: {
    pricingRevisions: PricingFactRevision[];
    cashLines: Record<string, unknown>[];
    cashRemainderMinor: number;
    currentContractAmountMinor: number;
  };
}

export interface PricingFactExecutionResult {
  pricingRevisions: PricingFactRevision[];
  coverageSet: PricingFactCoverageItem[];
  cashLines: Record<string, unknown>[];
  cashRemainderMinor: number;
  currentContractAmountMinor: number;
}

export type PricingFactExecutor = (pricingCase: PricingFactCase) => PricingFactExecutionResult | Promise<PricingFactExecutionResult>;
export type PricingFactExecutorRegistry = Partial<Record<PricingFactBusinessPlan, PricingFactExecutor>>;

export interface PricingFactDocument {
  fileName: string;
  value: unknown;
}

function schemaErrors(errors: SchemaValidationError[] | null | undefined): string[] {
  return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`);
}

export function compilePricingFactSchema(schema: object): SchemaValidator<PricingFactCase> {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile<PricingFactCase>(schema);
}

export function validatePricingFactDocuments(documents: PricingFactDocument[], validate: SchemaValidator<PricingFactCase>): PricingFactCase[] {
  if (documents.length === 0) {
    throw new PricingFactsError("PRICING_FACTS_MISSING", "No real pricing fact JSON files were supplied", {
      expectedDirectory: "docs/pricing-facts/cases"
    });
  }

  const cases: PricingFactCase[] = [];
  for (const document of documents) {
    if (!validate(document.value)) {
      throw new PricingFactsError("PRICING_FACT_SCHEMA_INVALID", `Pricing fact ${document.fileName} does not match pricing-case.schema.json`, {
        fileName: document.fileName,
        errors: schemaErrors(validate.errors)
      });
    }
    if (document.value.departureDate <= document.value.arrivalDate) {
      throw new PricingFactsError("PRICING_FACT_SCHEMA_INVALID", `Pricing fact ${document.fileName} has an empty or reversed service interval`, {
        fileName: document.fileName,
        arrivalDate: document.value.arrivalDate,
        departureDate: document.value.departureDate
      });
    }
    cases.push(document.value);
  }

  const duplicateIds = [...new Set(cases.map((pricingCase) => pricingCase.caseId).filter((caseId, index, ids) => ids.indexOf(caseId) !== index))];
  if (duplicateIds.length > 0) {
    throw new PricingFactsError("PRICING_FACT_SCHEMA_INVALID", "Pricing fact caseId values must be unique", { duplicateCaseIds: duplicateIds });
  }
  return cases;
}

function serviceDates(pricingCase: PricingFactCase): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${pricingCase.arrivalDate}T00:00:00.000Z`);
  const finalDate = new Date(`${pricingCase.departureDate}T00:00:00.000Z`);
  while (cursor.getTime() < finalDate.getTime() || (pricingCase.departureCharged && cursor.getTime() === finalDate.getTime())) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function boundaryInput(pricingCase: PricingFactCase): Record<string, unknown> {
  return {
    businessPlan: pricingCase.businessPlan,
    inventoryUnitKind: pricingCase.inventoryUnitKind,
    arrivalDate: pricingCase.arrivalDate,
    departureDate: pricingCase.departureDate,
    departureCharged: pricingCase.departureCharged,
    priceInputs: pricingCase.priceInputs,
    coverageSet: pricingCase.coverageSet,
    amendments: pricingCase.amendments
  };
}

export function assertPricingFactCoverage(cases: PricingFactCase[]): void {
  const coveredPlans = new Set(cases.map((pricingCase) => pricingCase.businessPlan));
  const coveredTags = new Set(cases.flatMap((pricingCase) => pricingCase.scenarioTags));
  const missingBusinessPlans = pricingFactBusinessPlans.filter((plan) => !coveredPlans.has(plan));
  const missingScenarioTags = requiredPricingFactScenarioTags.filter((tag) => !coveredTags.has(tag));
  const boundaryCaseIds = cases.filter((pricingCase) => pricingCase.scenarioTags.includes("BOUNDARY")).map((pricingCase) => pricingCase.caseId);
  const knownCaseIds = new Set(cases.map((pricingCase) => pricingCase.caseId));

  for (const pricingCase of cases) {
    const revisions = pricingCase.expected.pricingRevisions;
    const amendmentTypes = new Set(revisions.map((revision) => revision.amendmentType));
    const expectedRevisionNumbers = revisions.map((_, index) => index + 1);
    const policyVersions = new Set(revisions.map((revision) => revision.pricingPolicyVersionReference));
    const amendmentRevisionPairsMatch = pricingCase.amendments.length === revisions.length - 1
      && pricingCase.amendments.every((amendment, index) => (
        amendment.sequence === index + 2
        && revisions[index + 1]?.amendmentType === amendment.amendmentType
      ));
    const latest = revisions.at(-1);
    const expectedServiceDates = serviceDates(pricingCase);
    const expectedServiceDateSet = new Set(expectedServiceDates);
    const coverageDates = pricingCase.coverageSet.map((coverage) => coverage.serviceDate);
    const coverageDatesAreValid = new Set(coverageDates).size === coverageDates.length
      && coverageDates.every((serviceDate) => expectedServiceDateSet.has(serviceDate));
    const requiredAmendments = [
      ["RESCHEDULE", "RESCHEDULE_STAY"],
      ["EXTEND", "EXTEND_STAY"],
      ["MOVE", "MOVE_UNIT"]
    ] as const;
    const missingAmendments = requiredAmendments
      .filter(([tag, amendmentType]) => pricingCase.scenarioTags.includes(tag) && !amendmentTypes.has(amendmentType))
      .map(([, amendmentType]) => amendmentType);
    const hasCrossMonthEvidence = pricingCase.expected.pricingRevisions.some((revision) => (
      revision.arrivalDate.slice(0, 7) !== revision.departureDate.slice(0, 7)
    ));
    const hasPartialCoverageEvidence = pricingCase.coverageSet.length > 0
      && pricingCase.coverageSet.length < expectedServiceDates.length
      && pricingCase.expected.cashLines.length > 0;
    const boundaryComparison = pricingCase.boundaryEvidence
      ? cases.find((candidate) => candidate.caseId === pricingCase.boundaryEvidence?.comparisonCaseId)
      : undefined;
    const hasBoundaryEvidence = pricingCase.boundaryEvidence !== undefined
      && pricingCase.boundaryEvidence.comparisonCaseId !== pricingCase.caseId
      && knownCaseIds.has(pricingCase.boundaryEvidence.comparisonCaseId)
      && boundaryComparison !== undefined
      && !isDeepStrictEqual(boundaryInput(pricingCase), boundaryInput(boundaryComparison))
      && (!isDeepStrictEqual(pricingCase.expected, boundaryComparison.expected)
        || !isDeepStrictEqual(pricingCase.rounding, boundaryComparison.rounding));
    const invalid = revisions.length === 0
      || revisions[0]?.amendmentType !== "CREATE_ORDER"
      || !isDeepStrictEqual(revisions.map((revision) => revision.revisionNo), expectedRevisionNumbers)
      || policyVersions.size !== 1
      || !amendmentRevisionPairsMatch
      || !coverageDatesAreValid
      || missingAmendments.length > 0
      || (pricingCase.scenarioTags.includes("CROSS_MONTH") && !hasCrossMonthEvidence)
      || (pricingCase.scenarioTags.includes("PARTIAL_MEMBER_COVERAGE") && !hasPartialCoverageEvidence)
      || (pricingCase.scenarioTags.includes("BOUNDARY") && !hasBoundaryEvidence)
      || (pricingCase.scenarioTags.includes("MANUAL_ADJUSTMENT") && !revisions.some((revision) => revision.manualAdjustmentMinor !== 0))
      || !latest
      || latest.arrivalDate !== pricingCase.arrivalDate
      || latest.departureDate !== pricingCase.departureDate
      || !isDeepStrictEqual(latest.coverageSet, pricingCase.coverageSet)
      || !isDeepStrictEqual(latest.cashLines, pricingCase.expected.cashLines)
      || latest.cashRemainderMinor !== pricingCase.expected.cashRemainderMinor
      || latest.currentContractAmountMinor !== pricingCase.expected.currentContractAmountMinor;
    if (invalid) {
      throw new PricingFactsError("PRICING_FACTS_COVERAGE_INCOMPLETE", `Pricing fact ${pricingCase.caseId} has an incomplete or inconsistent revision history`, {
        caseId: pricingCase.caseId,
        missingAmendments,
        hasCrossMonthEvidence,
        hasPartialCoverageEvidence,
        hasBoundaryEvidence,
        coverageDatesAreValid,
        revisionNumbers: revisions.map((revision) => revision.revisionNo),
        policyVersionReferences: [...policyVersions],
        amendmentRevisionPairsMatch
      });
    }
  }

  if (missingBusinessPlans.length > 0 || missingScenarioTags.length > 0 || boundaryCaseIds.length < 2) {
    throw new PricingFactsError("PRICING_FACTS_COVERAGE_INCOMPLETE", "Real pricing facts do not cover every required business plan and scenario", {
      missingBusinessPlans,
      missingScenarioTags,
      boundaryCaseIds,
      minimumBoundaryCases: 2
    });
  }
}

export async function executePricingFactCases(cases: PricingFactCase[], executors: PricingFactExecutorRegistry): Promise<void> {
  for (const pricingCase of cases) {
    const executor = executors[pricingCase.businessPlan];
    if (!executor) {
      throw new PricingFactsError("PRICING_FACT_EXECUTOR_MISSING", `No approved finite executor is registered for ${pricingCase.businessPlan}`, {
        caseId: pricingCase.caseId,
        businessPlan: pricingCase.businessPlan
      });
    }
    const actual = await executor(pricingCase);
    const expected: PricingFactExecutionResult = {
      pricingRevisions: pricingCase.expected.pricingRevisions,
      coverageSet: pricingCase.coverageSet,
      cashLines: pricingCase.expected.cashLines,
      cashRemainderMinor: pricingCase.expected.cashRemainderMinor,
      currentContractAmountMinor: pricingCase.expected.currentContractAmountMinor
    };
    if (!isDeepStrictEqual(actual, expected)) {
      throw new PricingFactsError("PRICING_FACT_MISMATCH", `Pricing fact ${pricingCase.caseId} did not reproduce its recorded result`, {
        caseId: pricingCase.caseId,
        expected,
        actual
      });
    }
  }
}

export async function loadPricingFactCases(options: { casesDirectory: string; schemaPath: string }): Promise<PricingFactCase[]> {
  let entries;
  try {
    entries = await readdir(options.casesDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new PricingFactsError("PRICING_FACTS_MISSING", "The real pricing fact directory does not exist", {
        expectedDirectory: options.casesDirectory
      });
    }
    throw error;
  }
  const fileNames = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name).sort();
  const documents: PricingFactDocument[] = [];
  for (const fileName of fileNames) {
    const filePath = path.join(options.casesDirectory, fileName);
    let value: unknown;
    try {
      value = JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      throw new PricingFactsError("PRICING_FACT_SCHEMA_INVALID", `Pricing fact ${fileName} is not valid JSON`, {
        fileName,
        cause: error instanceof Error ? error.message : String(error)
      });
    }
    documents.push({ fileName, value });
  }
  const schema = JSON.parse(await readFile(options.schemaPath, "utf8")) as object;
  return validatePricingFactDocuments(documents, compilePricingFactSchema(schema));
}

export async function runPricingFactsGate(options: {
  casesDirectory: string;
  schemaPath: string;
  executors: PricingFactExecutorRegistry;
}): Promise<{ caseCount: number }> {
  const cases = await loadPricingFactCases(options);
  assertPricingFactCoverage(cases);
  await executePricingFactCases(cases, options.executors);
  return { caseCount: cases.length };
}

import type { AuthPrincipal, CommandEnvelope, CommandType, ReceiptDto } from "@qintopia/contracts";
import { todayInTimeZone } from "@qintopia/domain";
import type { Kysely } from "kysely";
import { confirmCommandPreview, createCommandPreview } from "../../packages/db/src/commands/service.ts";
import { createDatabase } from "../../packages/db/src/database.ts";
import { withPropertyClockForTesting } from "../../packages/db/src/members.ts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import type { Database } from "../../packages/db/src/schema.ts";
import { authScope } from "../helpers/auth-principals.ts";
import { resetE2eDatabase } from "./reset-database.ts";

const demo = {
  propertyId: "prop_qintopia_demo",
  pricingPolicyId: "policy_qintopia_public_2026_rev561_v1",
  agentSubjectId: "subject_demo_agent"
} as const;

const defaultDatabaseUrl = process.env.STAGE13_ACCEPTANCE_DATABASE_URL
  ?? process.env.E2E_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_e2e";

const principal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Stage 13 Acceptance Setup",
  ...authScope()
};

export interface Stage13StayConversionFixture {
  orderId: string;
  stayId: string;
  unitCode: string;
  nickname: string;
  memberId: string;
  collectionFactId: string;
  sourceTransactionReference: string;
  arrivalDate: string;
  departureDate: string;
  originalContractMinor: number;
  recordedCollectionMinor: number;
  membershipProductId: string;
  agreedPriceMinor: number;
  remainingPaymentMinor: number;
}

export interface Stage13AcceptanceFixture {
  businessDate: string;
  operator: { username: string; password: string };
  conversion: Stage13StayConversionFixture;
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function withOrdinaryOrderCreationClock<T>(
  businessDate: string,
  arrivalDate: string,
  operation: () => Promise<T>
): Promise<T> {
  return arrivalDate < businessDate
    ? withPropertyClockForTesting(new Date(`${arrivalDate}T12:00:00+08:00`), operation)
    : operation();
}

async function execute(
  db: Kysely<Database>,
  commandType: CommandType,
  input: Record<string, unknown>,
  key: string
): Promise<ReceiptDto> {
  const prepared = await createCommandPreview(db, principal, { commandType, input } as CommandEnvelope, {
    idempotencyKey: `${key}-preview`,
    correlationId: key
  });
  const receipt = await confirmCommandPreview(db, principal, prepared.preview.previewId, {
    propertyId: demo.propertyId,
    commandType,
    confirmation: true,
    expectedEffectHash: prepared.preview.effectHash,
    reason: commandType === "CREATE_ORDER"
      ? { code: "CREATE_STANDARD_ORDER", note: "" }
      : { code: "STAGE13_ACCEPTANCE", note: "准备 4.7 住宿收款转会员人工验收数据" }
  }, { idempotencyKey: `${key}-confirm`, correlationId: key });
  if (!receipt.businessCommitted) {
    throw new Error(`${key} failed: ${receipt.error?.code ?? receipt.executionStatus} ${receipt.error?.message ?? ""}`.trim());
  }
  return receipt;
}

async function unitByCode(db: Kysely<Database>, code: string) {
  return db.selectFrom("inventory_units")
    .select(["id", "code"])
    .where("property_id", "=", demo.propertyId)
    .where("code", "=", code)
    .executeTakeFirstOrThrow();
}

async function createMember(db: Kysely<Database>, options: {
  key: string;
  fullName: string;
  identityCardNumber: string;
}): Promise<string> {
  const receipt = await execute(db, "CREATE_MEMBER", {
    propertyId: demo.propertyId,
    fullName: options.fullName,
    nickname: options.fullName,
    identityCardNumber: options.identityCardNumber,
    phone: "13800001313",
    wechat: `stage13-${options.key}`
  }, `${options.key}-member`);
  const memberId = receipt.result?.memberId;
  if (typeof memberId !== "string") throw new Error(`${options.key} did not create a member`);
  return memberId;
}

async function createCheckedOutStay(db: Kysely<Database>, businessDate: string, options: {
  key: string;
  unitCode: string;
  nickname: string;
  documentNumber: string;
  arrivalDate: string;
  departureDate: string;
  collectionMinor: number;
  transactionReference: string;
}): Promise<Omit<Stage13StayConversionFixture, "memberId" | "mismatchMemberId" | "membershipProductId" | "agreedPriceMinor" | "remainingPaymentMinor">> {
  const unit = await unitByCode(db, options.unitCode);
  const { quote, created } = await withOrdinaryOrderCreationClock(businessDate, options.arrivalDate, async () => {
    const quote = await createQuoteForTesting(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: unit.id,
      arrivalDate: options.arrivalDate,
      departureDate: options.departureDate,
      pricingPolicyVersionId: demo.pricingPolicyId,
      stayType: "CUSTOM"
    });
    const created = await execute(db, "CREATE_ORDER", {
      propertyId: demo.propertyId,
      quoteId: quote.quoteId,
      primaryGuest: {
        fullName: `${options.nickname}完整姓名`,
        nickname: options.nickname,
        phone: "13800001313",
        documentNumber: options.documentNumber
      },
      bookingChannelCode: "WECOM",
      channelOrderReference: null,
      targetCurrentContractAmountMinor: quote.currentContractAmount.minorUnits
    }, `${options.key}-create`);
    return { quote, created };
  });
  const orderId = created.result?.orderId;
  const stayId = created.result?.stayId;
  if (typeof orderId !== "string" || typeof stayId !== "string") {
    throw new Error(`${options.key} did not create an order`);
  }
  await withPropertyClockForTesting(new Date(`${options.arrivalDate}T12:00:00+08:00`), () => execute(db, "CHECK_IN", {
    propertyId: demo.propertyId,
    orderId
  }, `${options.key}-check-in`));
  await withPropertyClockForTesting(new Date(`${options.departureDate}T12:00:00+08:00`), () => execute(db, "CHECK_OUT", {
    propertyId: demo.propertyId,
    orderId
  }, `${options.key}-check-out`));
  const collection = await execute(db, "RECORD_COLLECTION", {
    propertyId: demo.propertyId,
    orderId,
    amountMinor: options.collectionMinor,
    method: "WECOM",
    transactionReference: options.transactionReference,
    note: "4.7 验收：住宿收款待升级会员"
  }, `${options.key}-collection`);
  const collectionFactId = collection.result?.factId;
  if (typeof collectionFactId !== "string") throw new Error(`${options.key} did not record a collection`);
  return {
    orderId,
    stayId,
    unitCode: unit.code,
    nickname: options.nickname,
    collectionFactId,
    sourceTransactionReference: options.transactionReference,
    arrivalDate: options.arrivalDate,
    departureDate: options.departureDate,
    originalContractMinor: quote.currentContractAmount.minorUnits,
    recordedCollectionMinor: options.collectionMinor
  };
}

export async function prepareStage13Acceptance(
  databaseUrl = defaultDatabaseUrl,
  options: { reset?: boolean; suffix?: string } = {}
): Promise<Stage13AcceptanceFixture> {
  if (options.reset !== false) await resetE2eDatabase(databaseUrl);
  const db = createDatabase(databaseUrl);
  try {
    const businessDate = todayInTimeZone("Asia/Shanghai");
    const suffix = options.suffix ?? `manual-${businessDate.replaceAll("-", "")}`;
    const arrivalDate = addDays(businessDate, -7);
    const departureDate = businessDate;
    const identityCardNumber = `STAGE13-ID-${suffix}`;
    const memberId = await createMember(db, {
      key: `${suffix}-matched`,
      fullName: `住宿转会员匹配会员-${suffix}`,
      identityCardNumber
    });
    const stay = await createCheckedOutStay(db, businessDate, {
      key: `${suffix}-conversion`,
      unitCode: "D01",
      nickname: `住宿转会员-stage13-0`,
      documentNumber: identityCardNumber,
      arrivalDate,
      departureDate,
      collectionMinor: 59_000,
      transactionReference: `WX-STAGE13-${suffix}-SOURCE`
    });
    return {
      businessDate,
      operator: { username: "operator", password: "demo-pass-2026" },
      conversion: {
        ...stay,
        memberId,
        membershipProductId: "membership_product_shared_bath_single_v1",
        agreedPriceMinor: 162_000,
        remainingPaymentMinor: 103_000
      }
    };
  } finally {
    await db.destroy();
  }
}

if (process.argv[1]?.endsWith("setup-stage13-acceptance.ts")) {
  void prepareStage13Acceptance().then((fixture) => {
    process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

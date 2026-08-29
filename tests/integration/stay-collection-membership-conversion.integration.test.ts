import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthPrincipal, CommandEnvelope, ReceiptDto } from "@qintopia/contracts";
import {
  confirmCommandPreview,
  createCommandPreview,
  getOrderView,
  propertyLocalToday,
  withPropertyClockForTesting,
  type Database
} from "@qintopia/db";
import { sql, type Kysely, type Transaction } from "kysely";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { resetDatabase } from "../helpers/database.ts";

const databaseUrl = process.env.STAY_COLLECTION_MEMBERSHIP_CONVERSION_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_stay_collection_membership_conversion";

const principal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Demo Agent",
  propertyAccess: new Map([[demo.propertyId, "WRITE"]])
};

const products = {
  sharedSingle: "membership_product_shared_bath_single_v1",
  privateSingle: "membership_product_private_bath_single_v1"
} as const;

const stayDates = {
  arrival: "2026-09-01",
  departure: "2026-09-08"
} as const;

let db: Kysely<Database>;
let sequence = 0;

function metadata(prefix: string) {
  sequence += 1;
  return { idempotencyKey: `${prefix}-${sequence}`, correlationId: `${prefix}-${sequence}` };
}

function serviceDates(arrivalDate: string, departureDate: string): string[] {
  const dates: string[] = [];
  const current = new Date(`${arrivalDate}T00:00:00.000Z`);
  const end = new Date(`${departureDate}T00:00:00.000Z`);
  while (current < end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function preview(envelope: CommandEnvelope, prefix: string) {
  return createCommandPreview(db, principal, envelope, metadata(`${prefix}-preview`));
}

async function confirmPrepared(envelope: CommandEnvelope, prepared: Awaited<ReturnType<typeof preview>>, prefix: string): Promise<ReceiptDto> {
  return confirmCommandPreview(db, principal, prepared.preview.previewId, {
    propertyId: envelope.input.propertyId as string,
    commandType: envelope.commandType,
    confirmation: true,
    expectedEffectHash: prepared.preview.effectHash,
    reason: envelope.commandType === "CREATE_ORDER"
      ? { code: "CREATE_STANDARD_ORDER", note: "" }
      : { code: "STAGE47_ACCEPTANCE", note: `Stage 47 ${envelope.commandType} acceptance` }
  }, metadata(`${prefix}-confirm`));
}

async function execute(envelope: CommandEnvelope, prefix: string): Promise<ReceiptDto> {
  const prepared = await preview(envelope, prefix);
  const receipt = await confirmPrepared(envelope, prepared, prefix);
  if (!receipt.businessCommitted) {
    throw new Error(`${envelope.commandType} failed: ${JSON.stringify(receipt.error)}`);
  }
  return receipt;
}

async function createMember(identityCardNumber: string, prefix: string): Promise<string> {
  const receipt = await execute({
    commandType: "CREATE_MEMBER",
    input: {
      propertyId: demo.propertyId,
      fullName: `Stage 47 Member ${prefix}`,
      nickname: `Stage47 ${prefix}`,
      identityCardNumber,
      phone: fixturePhone(prefix),
      wechat: `stage47-${prefix}`
    }
  }, `${prefix}-member`);
  return receipt.result!.memberId as string;
}

function fixturePhone(seed: string): string {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `139${String(hash % 100_000_000).padStart(8, "0")}`;
}

async function createDraftMembershipOrder(memberId: string, prefix: string): Promise<string> {
  const receipt = await execute({
    commandType: "CREATE_MEMBERSHIP_ORDER",
    input: {
      propertyId: demo.propertyId,
      memberId,
      membershipProductId: products.sharedSingle,
      agreedPriceMinor: 162_000
    }
  }, `${prefix}-membership-order`);
  return receipt.result!.membershipOrderId as string;
}

async function recordMembershipPayment(membershipOrderId: string, prefix: string): Promise<string> {
  const receipt = await execute({
    commandType: "RECORD_MEMBERSHIP_PAYMENT",
    input: {
      propertyId: demo.propertyId,
      membershipOrderId,
      amountMinor: 100,
      transactionReference: `WX-STAGE47-${prefix.toUpperCase()}`
    }
  }, `${prefix}-membership-payment`);
  return receipt.result!.paymentFactId as string;
}

async function insertRawConversionExecution(
  commandId: string,
  state: "EXECUTING" | "REJECTED"
): Promise<void> {
  await db.insertInto("command_executions").values({
    id: commandId,
    subject_id: principal.subjectId,
    credential_id: principal.credentialId,
    property_id: demo.propertyId,
    command_type: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
    idempotency_key: commandId,
    request_hash: "f".repeat(64),
    correlation_id: commandId,
    state,
    completed_at: state === "REJECTED" ? new Date() : null
  }).execute();
}

async function insertRawDraftMembershipOrder(options: {
  membershipOrderId: string;
  memberId: string;
  commandId: string;
}, executor: Kysely<Database> | Transaction<Database> = db): Promise<void> {
  await executor.insertInto("membership_orders").values({
    id: options.membershipOrderId,
    property_id: demo.propertyId,
    member_id: options.memberId,
    product_id: products.sharedSingle,
    product_code: "SHARED_BATH_SINGLE_30",
    product_version: 1,
    product_name: "公卫单人间会员",
    listed_price_minor: 162_000,
    agreed_price_minor: 162_000,
    price_adjustment_minor: 0,
    price_adjustment_reason: null,
    currency: "CNY",
    entitlement_unit_kind: "ROOM_NIGHT",
    entitlement_units: 30,
    allowed_room_type_code: "shared_bath_single",
    allowed_inventory_kind: "ROOM",
    status: "DRAFT",
    activated_at: null,
    valid_from: null,
    valid_until: null,
    contract_id: null,
    entitlement_lot_id: null,
    version: 1,
    created_by_command_id: options.commandId,
    activated_by_command_id: null
  }).execute();
}

async function conversionCommandArtifactCounts(commandId: string) {
  const count = sql<number>`count(*)::integer`.as("count");
  const [amendments, lodgingCollections, membershipCollections, transfers, entitlements, membershipOrders] = await Promise.all([
    db.selectFrom("amendments").select(count).where("command_id", "=", commandId).executeTakeFirstOrThrow(),
    db.selectFrom("collection_facts").select(count).where("command_id", "=", commandId).executeTakeFirstOrThrow(),
    db.selectFrom("membership_payment_facts").select(count).where("command_id", "=", commandId).executeTakeFirstOrThrow(),
    db.selectFrom("stay_collection_membership_transfers").select(count).where("command_id", "=", commandId).executeTakeFirstOrThrow(),
    db.selectFrom("entitlement_ledger").select(count).where("command_id", "=", commandId).executeTakeFirstOrThrow(),
    db.selectFrom("membership_orders")
      .select(count)
      .where((expression) => expression.or([
        expression("created_by_command_id", "=", commandId),
        expression("activated_by_command_id", "=", commandId)
      ]))
      .executeTakeFirstOrThrow()
  ]);
  return {
    amendments: amendments.count,
    lodgingCollections: lodgingCollections.count,
    membershipCollections: membershipCollections.count,
    transfers: transfers.count,
    entitlements: entitlements.count,
    membershipOrders: membershipOrders.count
  };
}

async function createCheckedOutStay(options: {
  prefix: string;
  documentNumber: string;
  guestPhone?: string;
  unitId?: string;
  bookingChannelCode?: "WECOM" | "MEITUAN";
  skipCheckOut?: boolean;
  skipCollection?: boolean;
  collectionAmountMinor?: number;
  transactionReference?: string;
  arrivalDate?: string;
  departureDate?: string;
}) {
  const unitId = options.unitId ?? "unit_room_d_gen_01";
  const arrivalDate = options.arrivalDate ?? stayDates.arrival;
  const departureDate = options.departureDate ?? stayDates.departure;
  const quote = await createQuoteForTesting(db, {
    propertyId: demo.propertyId,
    inventoryUnitId: unitId,
    stayType: "CUSTOM",
    arrivalDate,
    departureDate,
    pricingPolicyVersionId: demo.publicPricingPolicyId
  });
  const createOrder = () => execute({
    commandType: "CREATE_ORDER",
    input: {
      propertyId: demo.propertyId,
      quoteId: quote.quoteId,
      primaryGuest: {
        fullName: `Stage 47 Guest ${options.prefix}`,
        nickname: `Stage47 ${options.prefix}`,
        phone: options.guestPhone ?? fixturePhone(options.prefix),
        documentNumber: options.documentNumber
      },
      bookingChannelCode: options.bookingChannelCode ?? "WECOM",
      channelOrderReference: options.bookingChannelCode && options.bookingChannelCode !== "WECOM"
        ? `STAGE47-${options.prefix.toUpperCase()}-CHANNEL`
        : null,
      targetCurrentContractAmountMinor: quote.currentContractAmount.minorUnits
    }
  }, `${options.prefix}-order`);
  const currentBusinessDate = await propertyLocalToday(db, demo.propertyId);
  const order = arrivalDate < currentBusinessDate
    ? await withPropertyClockForTesting(new Date(`${arrivalDate}T12:00:00.000Z`), createOrder)
    : await createOrder();
  const orderId = order.result!.orderId as string;
  const stayId = order.result!.stayId as string;
  await withPropertyClockForTesting(new Date(`${arrivalDate}T12:00:00.000Z`), () => execute({
    commandType: "CHECK_IN",
    input: { propertyId: demo.propertyId, orderId }
  }, `${options.prefix}-checkin`));
  if (!options.skipCheckOut) {
    await withPropertyClockForTesting(new Date(`${departureDate}T12:00:00.000Z`), () => execute({
      commandType: "CHECK_OUT",
      input: { propertyId: demo.propertyId, orderId }
    }, `${options.prefix}-checkout`));
  }

  const collectionAmountMinor = options.collectionAmountMinor ?? 59_000;
  if (options.skipCollection) {
    return {
      orderId,
      stayId,
      collectionFactId: "",
      transactionReference: options.transactionReference ?? `WX-STAGE47-${options.prefix}-SOURCE`
    };
  }
  const collection = await execute({
    commandType: "RECORD_COLLECTION",
    input: {
      propertyId: demo.propertyId,
      orderId,
      amountMinor: collectionAmountMinor,
      method: "WECOM",
      transactionReference: options.transactionReference ?? `WX-STAGE47-${options.prefix}-SOURCE`,
      note: "住宿收款待转会员"
    }
  }, `${options.prefix}-collection`);

  return {
    orderId,
    stayId,
    collectionFactId: collection.result!.factId as string,
    transactionReference: options.transactionReference ?? `WX-STAGE47-${options.prefix}-SOURCE`
  };
}

function conversionEnvelope(options: {
  orderId: string;
  memberId: string;
  collectionFactId: string;
  collectionFactIds?: string[];
  membershipProductId?: string;
  agreedPriceMinor?: number;
  priceAdjustmentReason?: string;
  remainingPaymentTransactionReference?: string;
}): CommandEnvelope {
  return {
    commandType: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
    input: {
      propertyId: demo.propertyId,
      orderId: options.orderId,
      memberId: options.memberId,
      membershipProductId: options.membershipProductId ?? products.sharedSingle,
      collectionFactIds: options.collectionFactIds ?? [options.collectionFactId],
      agreedPriceMinor: options.agreedPriceMinor ?? 162_000,
      ...(options.priceAdjustmentReason ? { priceAdjustmentReason: options.priceAdjustmentReason } : {}),
      ...(options.remainingPaymentTransactionReference
        ? { remainingPaymentTransactionReference: options.remainingPaymentTransactionReference }
        : {})
    }
  };
}

async function createCompletedConversionFixture(options: {
  prefix: string;
  documentNumber: string;
  collectionAmountMinor: number;
  agreedPriceMinor: number;
  remainingPaymentTransactionReference?: string;
}) {
  const memberId = await createMember(options.documentNumber, options.prefix);
  const stay = await createCheckedOutStay({
    prefix: options.prefix,
    documentNumber: options.documentNumber,
    collectionAmountMinor: options.collectionAmountMinor,
    transactionReference: `WX-STAGE47-${options.prefix.toUpperCase()}-SOURCE`
  });
  const envelope = conversionEnvelope({
    orderId: stay.orderId,
    memberId,
    collectionFactId: stay.collectionFactId,
    agreedPriceMinor: options.agreedPriceMinor,
    ...(options.remainingPaymentTransactionReference
      ? { remainingPaymentTransactionReference: options.remainingPaymentTransactionReference }
      : {})
  });
  const prepared = await preview(envelope, `${options.prefix}-conversion`);
  const receipt = await confirmPrepared(envelope, prepared, `${options.prefix}-conversion`);
  expect(receipt.businessCommitted).toBe(true);
  return {
    commandId: receipt.commandId,
    membershipOrderId: receipt.result!.membershipOrderId as string,
    prepared,
    receipt,
    stay
  };
}

async function expectRemainingPaymentBindingRejects(options: {
  commandId: string;
  membershipOrderId: string;
  mutate: (
    trx: Transaction<Database>,
    directFact: {
      fact_id: string;
      amount_minor: number;
      currency: string;
      transaction_reference: string | null;
    } | undefined
  ) => Promise<void>;
}) {
  const directFact = await db.selectFrom("membership_payment_facts")
    .select(["fact_id", "amount_minor", "currency", "transaction_reference"])
    .where("membership_order_id", "=", options.membershipOrderId)
    .where("source_type", "=", "DIRECT_WECOM")
    .executeTakeFirst();
  const corruptWrite = db.transaction().execute(async (trx) => {
    await sql`
      ALTER TABLE membership_payment_facts
      DISABLE TRIGGER membership_payment_facts_append_only
    `.execute(trx);
    await sql`
      ALTER TABLE membership_payment_facts
      DISABLE TRIGGER membership_payment_stage13_reject_after_transfer
    `.execute(trx);
    await options.mutate(trx, directFact);
    await sql`SELECT qintopia_assert_stage13_stay_conversion_command(${options.commandId})`.execute(trx);
    throw new Error("conversion remaining-payment guard accepted a corrupt graph");
  });
  await expect(corruptWrite).rejects.toMatchObject({
    constraint: "stage13_conversion_remaining_payment_binding"
  });
}

async function conversionArtifactCounts(orderId?: string) {
  const membershipOrdersQuery = db.selectFrom("membership_orders").select(sql<number>`count(*)::integer`.as("count"));
  const transfersQuery = db.selectFrom("stay_collection_membership_transfers").select(sql<number>`count(*)::integer`.as("count"));
  const ledgerQuery = db.selectFrom("entitlement_ledger")
    .select(sql<number>`count(*)::integer`.as("count"))
    .where("entry_type", "=", "CONVERSION_CONSUME");
  const revisionsQuery = db.selectFrom("pricing_revisions")
    .select(sql<number>`count(*)::integer`.as("count"));
  const amendmentsQuery = db.selectFrom("amendments")
    .select(sql<number>`count(*)::integer`.as("count"))
    .where("amendment_type", "=", "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP");
  const [membershipOrders, transfers, conversionLedger, revisions, amendments] = await Promise.all([
    membershipOrdersQuery.executeTakeFirstOrThrow(),
    orderId ? transfersQuery.where("order_id", "=", orderId).executeTakeFirstOrThrow() : transfersQuery.executeTakeFirstOrThrow(),
    orderId ? ledgerQuery.where("order_id", "=", orderId).executeTakeFirstOrThrow() : ledgerQuery.executeTakeFirstOrThrow(),
    orderId ? revisionsQuery.where("order_id", "=", orderId).executeTakeFirstOrThrow() : revisionsQuery.executeTakeFirstOrThrow(),
    orderId ? amendmentsQuery.where("order_id", "=", orderId).executeTakeFirstOrThrow() : amendmentsQuery.executeTakeFirstOrThrow()
  ]);
  return {
    membershipOrders: membershipOrders.count,
    transfers: transfers.count,
    conversionLedger: conversionLedger.count,
    pricingRevisions: revisions.count,
    conversionAmendments: amendments.count
  };
}

async function createInHouseConversion(options: {
  prefix: string;
  businessDate?: string;
  collectionAmountMinor?: number;
  skipCollection?: boolean;
  unitId?: string;
  agreedPriceMinor?: number;
  priceAdjustmentReason?: string;
  arrivalDate?: string;
  departureDate?: string;
}) {
  const businessDate = options.businessDate ?? "2026-09-02";
  const collectionAmountMinor = options.collectionAmountMinor ?? 59_000;
  const agreedPriceMinor = options.agreedPriceMinor ?? 162_000;
  const memberId = await createMember(`STAGE86-${options.prefix.toUpperCase()}-ID`, options.prefix);
  const stay = await createCheckedOutStay({
    prefix: options.prefix,
    documentNumber: `STAGE86-${options.prefix.toUpperCase()}-ID`,
    skipCheckOut: true,
    ...(options.skipCollection ? { skipCollection: true } : {}),
    ...(options.unitId ? { unitId: options.unitId } : {}),
    ...(options.arrivalDate ? { arrivalDate: options.arrivalDate } : {}),
    ...(options.departureDate ? { departureDate: options.departureDate } : {}),
    collectionAmountMinor,
    transactionReference: `WX-STAGE86-${options.prefix.toUpperCase()}-SOURCE`
  });
  const envelope = conversionEnvelope({
    orderId: stay.orderId,
    memberId,
    collectionFactId: stay.collectionFactId,
    ...(options.skipCollection ? { collectionFactIds: [] } : {}),
    agreedPriceMinor,
    ...(options.priceAdjustmentReason ? { priceAdjustmentReason: options.priceAdjustmentReason } : {}),
    ...(agreedPriceMinor > (options.skipCollection ? 0 : collectionAmountMinor)
      ? { remainingPaymentTransactionReference: `WX-STAGE86-${options.prefix.toUpperCase()}-REMAINING` }
      : {})
  });
  const prepared = await withPropertyClockForTesting(new Date(`${businessDate}T12:00:00.000Z`), () =>
    preview(envelope, `${options.prefix}-conversion`)
  );
  const receipt = await withPropertyClockForTesting(new Date(`${businessDate}T12:00:00.000Z`), () =>
    confirmPrepared(envelope, prepared, `${options.prefix}-conversion`)
  );
  expect(receipt.businessCommitted).toBe(true);
  return {
    memberId,
    stay,
    envelope,
    prepared,
    receipt,
    membershipOrderId: receipt.result!.membershipOrderId as string,
    contractId: receipt.result!.contractId as string,
    entitlementLotId: receipt.result!.entitlementLotId as string
  };
}

async function conversionEntitlementBalance(entitlementLotId: string): Promise<number> {
  const balance = await db.selectFrom("entitlement_lots")
    .leftJoin("entitlement_ledger", "entitlement_ledger.lot_id", "entitlement_lots.id")
    .select(sql<number>`coalesce(entitlement_lots.total_units + sum(entitlement_ledger.quantity_delta), entitlement_lots.total_units)::integer`.as("balance"))
    .where("entitlement_lots.id", "=", entitlementLotId)
    .groupBy(["entitlement_lots.id", "entitlement_lots.total_units"])
    .executeTakeFirstOrThrow();
  return balance.balance;
}

async function assertConversionCommandStillValid(commandId: string): Promise<void> {
  await sql`SELECT qintopia_assert_stage13_stay_conversion_command(${commandId})`.execute(db);
}

async function assertCorruptConversionRevisionRejected(commandId: string): Promise<void> {
  const conversionRevision = await db.selectFrom("pricing_revisions as revision")
    .innerJoin("amendments as amendment", "amendment.id", "revision.amendment_id")
    .select("revision.id")
    .where("amendment.command_id", "=", commandId)
    .where("amendment.amendment_type", "=", "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP")
    .executeTakeFirstOrThrow();
  const corruptWrite = db.transaction().execute(async (trx) => {
    await sql`ALTER TABLE pricing_revisions DISABLE TRIGGER pricing_revisions_append_only`.execute(trx);
    await trx.updateTable("pricing_revisions")
      .set({ current_contract_amount_minor: 1 })
      .where("id", "=", conversionRevision.id)
      .execute();
    await sql`SELECT qintopia_assert_stage13_stay_conversion_command(${commandId})`.execute(trx);
    throw new Error("conversion assertion accepted a corrupt conversion revision");
  });
  await expect(corruptWrite).rejects.toMatchObject({
    code: "23514",
    constraint: "stage13_conversion_order_state"
  });
}

async function conversionRollbackSnapshot(orderId: string, memberId?: string) {
  const [order, collections, transfers, membershipLedger, amendments, coverage] = await Promise.all([
    db.selectFrom("orders").selectAll().where("id", "=", orderId).executeTakeFirstOrThrow(),
    db.selectFrom("collection_facts").selectAll().where("order_id", "=", orderId).orderBy("fact_id").execute(),
    db.selectFrom("stay_collection_membership_transfers").selectAll().where("order_id", "=", orderId).orderBy("id").execute(),
    db.selectFrom("entitlement_ledger").selectAll().where("order_id", "=", orderId).orderBy("fact_id").execute(),
    db.selectFrom("amendments").selectAll().where("order_id", "=", orderId).orderBy("sequence").execute(),
    db.selectFrom("coverage_items").selectAll().where("order_id", "=", orderId).orderBy("id").execute()
  ]);
  const membershipOrders = memberId
    ? await db.selectFrom("membership_orders")
      .selectAll()
      .where("member_id", "=", memberId)
      .orderBy("id")
      .execute()
    : await db.selectFrom("membership_orders")
      .innerJoin("member_contracts", "member_contracts.membership_order_id", "membership_orders.id")
      .innerJoin("orders", "orders.member_contract_id", "member_contracts.id")
      .selectAll("membership_orders")
      .where("orders.id", "=", orderId)
      .orderBy("membership_orders.id")
      .execute();
  const membershipOrderIds = membershipOrders.map((membershipOrder) => membershipOrder.id);
  const [membershipPayments, contracts, lots] = await Promise.all([
    membershipOrderIds.length > 0
      ? db.selectFrom("membership_payment_facts").selectAll().where("membership_order_id", "in", membershipOrderIds).orderBy("fact_id").execute()
      : Promise.resolve([]),
    memberId
      ? db.selectFrom("member_contracts").selectAll().where("member_id", "=", memberId).orderBy("id").execute()
      : db.selectFrom("member_contracts")
        .innerJoin("orders", "orders.member_contract_id", "member_contracts.id")
        .selectAll("member_contracts")
        .where("orders.id", "=", orderId)
        .orderBy("member_contracts.id")
        .execute(),
    membershipOrderIds.length > 0
      ? db.selectFrom("entitlement_lots")
        .innerJoin("membership_orders", "membership_orders.entitlement_lot_id", "entitlement_lots.id")
        .selectAll("entitlement_lots")
        .where("membership_orders.id", "in", membershipOrderIds)
        .orderBy("entitlement_lots.id")
        .execute()
      : Promise.resolve([])
  ]);
  return JSON.parse(JSON.stringify({
    order,
    collections,
    transfers,
    membershipLedger,
    amendments,
    coverage,
    membershipOrders,
    membershipPayments,
    contracts,
    lots
  }));
}

async function linkMemberToAdditionalProperty(memberId: string): Promise<string> {
  const propertyId = "prop_stage86_additional_member_link";
  await db.insertInto("properties").values({
    id: propertyId,
    code: "STAGE86-OTHER",
    name: "Stage 86 Additional Property",
    timezone: "Asia/Shanghai",
    currency: "CNY"
  }).execute();
  await db.insertInto("member_property_links").values({
    member_id: memberId,
    property_id: propertyId
  }).execute();
  return propertyId;
}

beforeEach(async () => {
  sequence = 0;
  db = await resetDatabase(databaseUrl);
});

afterEach(async () => {
  if (db) await db.destroy();
});

describe("4.7 stay collection conversion to membership", () => {
  it("converts a completed ordinary WeCom stay collection into one active membership order", async () => {
    const memberId = await createMember("STAGE47-GOLD-ID", "gold");
    const stay = await createCheckedOutStay({
      prefix: "gold",
      documentNumber: "STAGE47-GOLD-ID",
      guestPhone: "139 0317 8592",
      collectionAmountMinor: 59_000,
      transactionReference: "WX-STAGE47-GOLD-SOURCE"
    });
    const envelope = conversionEnvelope({
      orderId: stay.orderId,
      memberId,
      collectionFactId: stay.collectionFactId,
      remainingPaymentTransactionReference: "WX-STAGE47-GOLD-REMAINING"
    });
    const prepared = await preview(envelope, "gold-conversion");
    expect(prepared.preview.effect).toMatchObject({
      operation: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
      orderId: stay.orderId,
      primaryOccupant: { phone: "13903178592" },
      member: { phone: "13903178592" },
      transfer: {
        total: { currency: "CNY", minorUnits: 59_000 },
        collections: [{ factId: stay.collectionFactId, transactionReference: "WX-STAGE47-GOLD-SOURCE" }]
      },
      membershipPricing: {
        listedPrice: { currency: "CNY", minorUnits: 162_000 },
        agreedPrice: { currency: "CNY", minorUnits: 162_000 }
      },
      remainingPayment: {
        amount: { currency: "CNY", minorUnits: 103_000 },
        transactionReference: "WX-STAGE47-GOLD-REMAINING"
      },
      entitlement: {
        consumedUnits: 7,
        remainingUnits: 23,
        serviceDates: serviceDates(stayDates.arrival, stayDates.departure)
      },
      pricing: {
        currentContractAmount: { currency: "CNY", minorUnits: 0 }
      }
    });

    const receipt = await confirmPrepared(envelope, prepared, "gold-conversion");
    expect(receipt.businessCommitted).toBe(true);
    const result = receipt.result!;
    expect(result).toMatchObject({
      status: "ACTIVE",
      orderId: stay.orderId,
      transferredCollectionFactIds: [stay.collectionFactId],
      transferredAmount: { currency: "CNY", minorUnits: 59_000 },
      membershipAgreedPrice: { currency: "CNY", minorUnits: 162_000 },
      remainingPaymentAmount: { currency: "CNY", minorUnits: 103_000 },
      entitlementUnitKind: "ROOM_NIGHT",
      conversionMode: "COMPLETED",
      convertedUnits: 7,
      remainingUnits: 23
    });

    const orderState = await db.selectFrom("orders")
      .innerJoin("stays", "stays.order_id", "orders.id")
      .innerJoin("pricing_revisions", "pricing_revisions.id", "orders.current_revision_id")
      .select([
        "orders.status as orderStatus",
        "stays.status as stayStatus",
        "pricing_revisions.current_contract_amount_minor as currentContractAmountMinor"
      ])
      .where("orders.id", "=", stay.orderId)
      .executeTakeFirstOrThrow();
    expect(orderState).toEqual({
      orderStatus: "CHECKED_OUT",
      stayStatus: "COMPLETED",
      currentContractAmountMinor: 0
    });

    const lodgingNet = await db.selectFrom("collection_facts")
      .select(sql<number>`coalesce(sum(net_effect_minor), 0)::integer`.as("net"))
      .where("order_id", "=", stay.orderId)
      .executeTakeFirstOrThrow();
    expect(lodgingNet.net).toBe(0);
    const lodgingFacts = await db.selectFrom("collection_facts")
      .select(["fact_id", "fact_type", "amount_minor", "net_effect_minor", "method", "transaction_reference", "reverses_fact_id"])
      .where("order_id", "=", stay.orderId)
      .orderBy("fact_type")
      .execute();
    expect(lodgingFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fact_id: stay.collectionFactId,
        fact_type: "COLLECTION",
        amount_minor: 59_000,
        net_effect_minor: 59_000,
        method: "WECOM",
        transaction_reference: "WX-STAGE47-GOLD-SOURCE"
      }),
      expect.objectContaining({
        fact_type: "REVERSAL",
        amount_minor: 59_000,
        net_effect_minor: -59_000,
        method: "REVERSAL",
        transaction_reference: null,
        reverses_fact_id: stay.collectionFactId
      })
    ]));

    const membershipOrderId = result.membershipOrderId as string;
    const membershipOrder = await db.selectFrom("membership_orders")
      .select(["status", "agreed_price_minor", "entitlement_units", "contract_id", "entitlement_lot_id"])
      .where("id", "=", membershipOrderId)
      .executeTakeFirstOrThrow();
    expect(membershipOrder).toMatchObject({
      status: "ACTIVE",
      agreed_price_minor: 162_000,
      entitlement_units: 30
    });
    expect(membershipOrder.contract_id).toBeTruthy();
    expect(membershipOrder.entitlement_lot_id).toBeTruthy();

    const transfer = await db.selectFrom("stay_collection_membership_transfers")
      .selectAll()
      .where("order_id", "=", stay.orderId)
      .executeTakeFirstOrThrow();
    expect(transfer).toMatchObject({
      source_collection_fact_id: stay.collectionFactId,
      membership_order_id: membershipOrderId
    });

    const payments = await db.selectFrom("membership_payment_facts")
      .select(["fact_type", "amount_minor", "net_effect_minor", "transaction_reference", "source_type", "source_order_id", "source_collection_fact_id"])
      .where("membership_order_id", "=", membershipOrderId)
      .execute();
    expect(payments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fact_type: "COLLECTION",
        amount_minor: 59_000,
        net_effect_minor: 59_000,
        transaction_reference: null,
        source_type: "STAY_COLLECTION_TRANSFER",
        source_order_id: stay.orderId,
        source_collection_fact_id: stay.collectionFactId
      }),
      expect.objectContaining({
        fact_type: "COLLECTION",
        amount_minor: 103_000,
        net_effect_minor: 103_000,
        transaction_reference: "WX-STAGE47-GOLD-REMAINING",
        source_type: "DIRECT_WECOM",
        source_order_id: null,
        source_collection_fact_id: null
      })
    ]));

    const conversionLedger = await db.selectFrom("entitlement_ledger")
      .select(["entry_type", "quantity_delta", "service_date", "order_id"])
      .where("order_id", "=", stay.orderId)
      .where("entry_type", "=", "CONVERSION_CONSUME")
      .orderBy("service_date")
      .execute();
    expect(conversionLedger).toHaveLength(7);
    expect(conversionLedger.map((item) => item.service_date)).toEqual(serviceDates(stayDates.arrival, stayDates.departure));
    expect(conversionLedger.every((item) => item.quantity_delta === -1)).toBe(true);

    await expect(preview({
      commandType: "RECORD_COLLECTION",
      input: {
        propertyId: demo.propertyId,
        orderId: stay.orderId,
        amountMinor: 1_000,
        method: "WECOM",
        transactionReference: "WX-STAGE47-AFTER-CONVERSION"
      }
    }, "after-conversion-collection")).rejects.toMatchObject({
      code: "AGGREGATE_VERSION_CONFLICT",
      message: expect.stringContaining("已完成升级会员")
    });
    await expect(preview({
      commandType: "RECORD_REFUND",
      input: {
        propertyId: demo.propertyId,
        orderId: stay.orderId,
        referencesFactId: stay.collectionFactId,
        amountMinor: 1_000,
        method: "WECOM",
        note: "升级会员后不能再从住宿订单退款"
      }
    }, "after-conversion-refund")).rejects.toMatchObject({
      code: "AGGREGATE_VERSION_CONFLICT",
      message: expect.stringContaining("已完成升级会员")
    });
  });

  it("converts an in-house stay, keeping the order checked in while zeroing lodging funds", async () => {
    const memberId = await createMember("STAGE47-INHOUSE-ID", "inhouse");
    const stay = await createCheckedOutStay({
      prefix: "inhouse",
      documentNumber: "STAGE47-INHOUSE-ID",
      skipCheckOut: true,
      collectionAmountMinor: 59_000,
      transactionReference: "WX-STAGE47-INHOUSE-SOURCE"
    });
    const envelope = conversionEnvelope({
      orderId: stay.orderId,
      memberId,
      collectionFactId: stay.collectionFactId,
      remainingPaymentTransactionReference: "WX-STAGE47-INHOUSE-REMAINING"
    });
    const receipt = await withPropertyClockForTesting(new Date("2026-09-02T12:00:00.000Z"), async () => {
      const prepared = await preview(envelope, "inhouse-conversion");
      return confirmPrepared(envelope, prepared, "inhouse-conversion");
    });
    expect(receipt.businessCommitted).toBe(true);
    expect(receipt.result).toMatchObject({
      status: "ACTIVE",
      transferredCollectionFactIds: [stay.collectionFactId],
      transferredAmount: { currency: "CNY", minorUnits: 59_000 },
      remainingPaymentAmount: { currency: "CNY", minorUnits: 103_000 },
      conversionMode: "IN_HOUSE",
      convertedUnits: 7,
      remainingUnits: 23
    });

    // 在住升级后订单保持在住，住宿金额归零，权益按整段住宿夜核销。
    const orderState = await db.selectFrom("orders")
      .innerJoin("stays", "stays.order_id", "orders.id")
      .innerJoin("pricing_revisions", "pricing_revisions.id", "orders.current_revision_id")
      .select([
        "orders.status as orderStatus",
        "stays.status as stayStatus",
        "pricing_revisions.current_contract_amount_minor as currentContractAmountMinor"
      ])
      .where("orders.id", "=", stay.orderId)
      .executeTakeFirstOrThrow();
    expect(orderState).toEqual({
      orderStatus: "CHECKED_IN",
      stayStatus: "IN_HOUSE",
      currentContractAmountMinor: 0
    });
    const conversionLedger = await db.selectFrom("entitlement_ledger")
      .select(["service_date"])
      .where("order_id", "=", stay.orderId)
      .where("entry_type", "=", "CONVERSION_CONSUME")
      .orderBy("service_date")
      .execute();
    expect(conversionLedger.map((item) => item.service_date)).toEqual(serviceDates(stayDates.arrival, stayDates.departure));

    // 升级会员后的在住订单到计划退房日仍能正常退房。
    await withPropertyClockForTesting(new Date(`${stayDates.departure}T12:00:00.000Z`), () => execute({
      commandType: "CHECK_OUT",
      input: { propertyId: demo.propertyId, orderId: stay.orderId }
    }, "inhouse-checkout-after-conversion"));
    const checkedOut = await db.selectFrom("orders")
      .select("status")
      .where("id", "=", stay.orderId)
      .executeTakeFirstOrThrow();
    expect(checkedOut.status).toBe("CHECKED_OUT");
    await assertConversionCommandStillValid(receipt.commandId);
  });

  it("converts a stay with zero recorded collections by charging the full membership price directly", async () => {
    const memberId = await createMember("STAGE47-NOCOL-ID", "nocol");
    const stay = await createCheckedOutStay({
      prefix: "nocol",
      documentNumber: "STAGE47-NOCOL-ID",
      skipCollection: true
    });

    // 零收款升级时会员费全额作为差额收款，必须填写新的企微交易单号。
    await expect(preview(conversionEnvelope({
      orderId: stay.orderId,
      memberId,
      collectionFactId: "",
      collectionFactIds: []
    }), "nocol-conversion-no-ref")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const envelope = conversionEnvelope({
      orderId: stay.orderId,
      memberId,
      collectionFactId: "",
      collectionFactIds: [],
      remainingPaymentTransactionReference: "WX-STAGE47-NOCOL-FULL"
    });
    const prepared = await preview(envelope, "nocol-conversion");
    expect(prepared.preview.effect).toMatchObject({
      transfer: { total: { currency: "CNY", minorUnits: 0 }, collections: [] },
      remainingPayment: {
        amount: { currency: "CNY", minorUnits: 162_000 },
        transactionReference: "WX-STAGE47-NOCOL-FULL"
      }
    });
    const receipt = await confirmPrepared(envelope, prepared, "nocol-conversion");
    expect(receipt.businessCommitted).toBe(true);
    expect(receipt.result).toMatchObject({
      status: "ACTIVE",
      transferredCollectionFactIds: [],
      lodgingReversalFactIds: [],
      transferIds: [],
      transferredAmount: { currency: "CNY", minorUnits: 0 },
      remainingPaymentAmount: { currency: "CNY", minorUnits: 162_000 }
    });

    const transfers = await db.selectFrom("stay_collection_membership_transfers")
      .selectAll()
      .where("order_id", "=", stay.orderId)
      .execute();
    expect(transfers).toEqual([]);
    const lodgingFacts = await db.selectFrom("collection_facts")
      .selectAll()
      .where("order_id", "=", stay.orderId)
      .execute();
    expect(lodgingFacts).toEqual([]);
    const payments = await db.selectFrom("membership_payment_facts")
      .select(["fact_type", "amount_minor", "source_type", "transaction_reference"])
      .where("membership_order_id", "=", receipt.result!.membershipOrderId as string)
      .execute();
    expect(payments).toEqual([expect.objectContaining({
      fact_type: "COLLECTION",
      amount_minor: 162_000,
      source_type: "DIRECT_WECOM",
      transaction_reference: "WX-STAGE47-NOCOL-FULL"
    })]);

    // 订单还有未转入的已记录净收款时，不允许提交空收款列表。
    const mixedMemberId = await createMember("STAGE47-NOCOLMIX-ID", "nocolmix");
    const mixedStay = await createCheckedOutStay({
      prefix: "nocolmix",
      documentNumber: "STAGE47-NOCOLMIX-ID",
      collectionAmountMinor: 59_000,
      transactionReference: "WX-STAGE47-NOCOLMIX-SOURCE"
    });
    await expect(preview(conversionEnvelope({
      orderId: mixedStay.orderId,
      memberId: mixedMemberId,
      collectionFactId: "",
      collectionFactIds: [],
      remainingPaymentTransactionReference: "WX-STAGE47-NOCOLMIX-FULL"
    }), "nocolmix-conversion")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("allows exactly zero direct WeCom facts when the transferred lodging funds cover the agreed membership price", async () => {
    const fixture = await createCompletedConversionFixture({
      prefix: "zero-remaining",
      documentNumber: "STAGE47-ZERO-REMAINING-ID",
      collectionAmountMinor: 162_000,
      agreedPriceMinor: 162_000
    });

    expect(fixture.prepared.preview.effect).toMatchObject({ remainingPayment: null });
    expect(await db.selectFrom("membership_payment_facts")
      .select("fact_id")
      .where("membership_order_id", "=", fixture.membershipOrderId)
      .where("source_type", "=", "DIRECT_WECOM")
      .execute()).toHaveLength(0);
  });

  it("binds the conversion direct WeCom fact one-to-one to the reviewed remaining payment", async () => {
    const splitFixture = await createCompletedConversionFixture({
      prefix: "remaining-split",
      documentNumber: "STAGE47-REMAINING-SPLIT-ID",
      collectionAmountMinor: 59_000,
      agreedPriceMinor: 162_000,
      remainingPaymentTransactionReference: "WX-STAGE47-REMAINING-SPLIT"
    });
    await expectRemainingPaymentBindingRejects({
      commandId: splitFixture.commandId,
      membershipOrderId: splitFixture.membershipOrderId,
      mutate: async (trx, directFact) => {
        expect(directFact).toBeDefined();
        await trx.updateTable("membership_payment_facts")
          .set({ amount_minor: 50_000, net_effect_minor: 50_000 })
          .where("fact_id", "=", directFact!.fact_id)
          .execute();
        await trx.insertInto("membership_payment_facts").values({
          fact_id: "membership_payment_stage47_remaining_split_second",
          membership_order_id: splitFixture.membershipOrderId,
          fact_type: "COLLECTION",
          amount_minor: 53_000,
          net_effect_minor: 53_000,
          currency: "CNY",
          transaction_reference: "WX-STAGE47-REMAINING-SPLIT-SECOND",
          corrects_fact_id: null,
          reverses_fact_id: null,
          source_type: "DIRECT_WECOM",
          source_order_id: null,
          source_collection_fact_id: null,
          note: "损坏形状：把唯一差额收款拆成两笔",
          command_id: splitFixture.commandId
        }).execute();
      }
    });

    const mismatchCases = [
      {
        name: "amount",
        prefix: "remaining-amount",
        documentNumber: "STAGE47-REMAINING-AMOUNT-ID",
        transactionReference: "WX-STAGE47-REMAINING-AMOUNT",
        update: { amount_minor: 103_001, net_effect_minor: 103_001 }
      },
      {
        name: "currency",
        prefix: "remaining-currency",
        documentNumber: "STAGE47-REMAINING-CURRENCY-ID",
        transactionReference: "WX-STAGE47-REMAINING-CURRENCY",
        update: { currency: "USD" }
      },
      {
        name: "transaction-reference",
        prefix: "remaining-reference",
        documentNumber: "STAGE47-REMAINING-REFERENCE-ID",
        transactionReference: "WX-STAGE47-REMAINING-REFERENCE",
        update: { transaction_reference: "WX-STAGE47-REMAINING-REFERENCE-DAMAGED" }
      }
    ] as const;
    for (const mismatch of mismatchCases) {
      const fixture = await createCompletedConversionFixture({
        prefix: mismatch.prefix,
        documentNumber: mismatch.documentNumber,
        collectionAmountMinor: 59_000,
        agreedPriceMinor: 162_000,
        remainingPaymentTransactionReference: mismatch.transactionReference
      });
      await expectRemainingPaymentBindingRejects({
        commandId: fixture.commandId,
        membershipOrderId: fixture.membershipOrderId,
        mutate: async (trx, directFact) => {
          expect(directFact, mismatch.name).toBeDefined();
          await trx.updateTable("membership_payment_facts")
            .set(mismatch.update)
            .where("fact_id", "=", directFact!.fact_id)
            .execute();
        }
      });
    }

    const zeroFixture = await createCompletedConversionFixture({
      prefix: "zero-with-direct",
      documentNumber: "STAGE47-ZERO-WITH-DIRECT-ID",
      collectionAmountMinor: 162_000,
      agreedPriceMinor: 162_000
    });
    await expectRemainingPaymentBindingRejects({
      commandId: zeroFixture.commandId,
      membershipOrderId: zeroFixture.membershipOrderId,
      mutate: async (trx, directFact) => {
        expect(directFact).toBeUndefined();
        await trx.insertInto("membership_payment_facts").values({
          fact_id: "membership_payment_stage47_zero_with_direct",
          membership_order_id: zeroFixture.membershipOrderId,
          fact_type: "COLLECTION",
          amount_minor: 100,
          net_effect_minor: 100,
          currency: "CNY",
          transaction_reference: "WX-STAGE47-ZERO-WITH-DIRECT",
          corrects_fact_id: null,
          reverses_fact_id: null,
          source_type: "DIRECT_WECOM",
          source_order_id: null,
          source_collection_fact_id: null,
          note: "损坏形状：无差额仍登记直接企微收款",
          command_id: zeroFixture.commandId
        }).execute();
      }
    });
  });

  it("rejects direct database conversion reversals that are not exactly bridged to transferred collections", async () => {
    const memberId = await createMember("STAGE47-REVERSAL-BRIDGE-ID", "reversal-bridge");
    const stay = await createCheckedOutStay({
      prefix: "reversal-bridge",
      documentNumber: "STAGE47-REVERSAL-BRIDGE-ID",
      collectionAmountMinor: 59_000,
      transactionReference: "WX-STAGE47-REVERSAL-BRIDGE-SOURCE"
    });
    const unrelatedStay = await createCheckedOutStay({
      prefix: "reversal-bridge-unrelated",
      documentNumber: "STAGE47-REVERSAL-BRIDGE-UNRELATED-ID",
      unitId: "unit_room_e_gen_01",
      collectionAmountMinor: 100,
      transactionReference: "WX-STAGE47-REVERSAL-BRIDGE-UNRELATED"
    });
    const envelope = conversionEnvelope({
      orderId: stay.orderId,
      memberId,
      collectionFactId: stay.collectionFactId,
      remainingPaymentTransactionReference: "WX-STAGE47-REVERSAL-BRIDGE-REMAINING"
    });
    const prepared = await preview(envelope, "reversal-bridge-conversion");
    const receipt = await confirmPrepared(envelope, prepared, "reversal-bridge-conversion");
    expect(receipt.businessCommitted).toBe(true);

    const unrelatedOrder = await db.selectFrom("orders")
      .select("current_revision_id")
      .where("id", "=", unrelatedStay.orderId)
      .executeTakeFirstOrThrow();
    const factsBefore = await db.selectFrom("collection_facts")
      .select(sql<number>`count(*)::integer`.as("count"))
      .where("order_id", "=", unrelatedStay.orderId)
      .executeTakeFirstOrThrow();
    const corruptFactId = "fact_stage47_unbridged_collection_reversal";

    const corruptWrite = db.transaction().execute(async (trx) => {
      await sql`
        ALTER TABLE collection_facts
        DISABLE TRIGGER collection_facts_stage13_reject_after_transfer
      `.execute(trx);
      await trx.insertInto("collection_facts").values({
        fact_id: corruptFactId,
        order_id: unrelatedStay.orderId,
        fact_type: "REVERSAL",
        amount_minor: 100,
        net_effect_minor: -100,
        currency: "CNY",
        references_fact_id: null,
        reverses_fact_id: unrelatedStay.collectionFactId,
        method: "REVERSAL",
        note: "损坏形状：夹带未转入住宿收款的额外冲销",
        transaction_reference: null,
        pricing_revision_id: unrelatedOrder.current_revision_id,
        command_id: receipt.commandId
      }).execute();
    });
    await expect(corruptWrite).rejects.toMatchObject({
      constraint: "stage13_conversion_reversal_bridge_exact"
    });
    expect(await db.selectFrom("collection_facts")
      .select("fact_id")
      .where("fact_id", "=", corruptFactId)
      .execute()).toHaveLength(0);
    expect(await db.selectFrom("collection_facts")
      .select(sql<number>`count(*)::integer`.as("count"))
      .where("order_id", "=", unrelatedStay.orderId)
      .executeTakeFirstOrThrow()).toEqual(factsBefore);
  });

  it("keeps an applied conversion command exclusive to its conversion graph", async () => {
    const memberId = await createMember("STAGE47-APPLIED-EXCLUSIVE-ID", "applied-exclusive");
    const stay = await createCheckedOutStay({
      prefix: "applied-exclusive",
      documentNumber: "STAGE47-APPLIED-EXCLUSIVE-ID",
      transactionReference: "WX-STAGE47-APPLIED-EXCLUSIVE-SOURCE"
    });
    const envelope = conversionEnvelope({
      orderId: stay.orderId,
      memberId,
      collectionFactId: stay.collectionFactId,
      remainingPaymentTransactionReference: "WX-STAGE47-APPLIED-EXCLUSIVE-REMAINING"
    });
    const prepared = await preview(envelope, "applied-exclusive-conversion");
    const receipt = await confirmPrepared(envelope, prepared, "applied-exclusive-conversion");
    expect(receipt.businessCommitted).toBe(true);

    const unrelatedStay = await createCheckedOutStay({
      prefix: "applied-exclusive-unrelated",
      documentNumber: "STAGE47-APPLIED-EXCLUSIVE-UNRELATED-ID",
      unitId: "unit_room_e_gen_01",
      skipCollection: true
    });
    const unrelatedOrder = await db.selectFrom("orders")
      .select("current_revision_id")
      .where("id", "=", unrelatedStay.orderId)
      .executeTakeFirstOrThrow();
    const factsBefore = await conversionCommandArtifactCounts(receipt.commandId);

    const unrelatedEntitlementFactId = "fact_stage47_applied_conversion_unrelated_adjust";
    await expect(db.insertInto("entitlement_ledger").values({
      fact_id: unrelatedEntitlementFactId,
      lot_id: demo.roomLotId,
      entry_type: "ADJUST",
      quantity_delta: 1,
      service_date: null,
      order_id: null,
      coverage_id: null,
      reason: "不得复用已完成转会员命令调整无关权益",
      command_id: receipt.commandId
    }).execute()).rejects.toMatchObject({
      constraint: "stage13_conversion_entitlement"
    });
    expect(await db.selectFrom("entitlement_ledger")
      .select("fact_id")
      .where("fact_id", "=", unrelatedEntitlementFactId)
      .executeTakeFirst()).toBeUndefined();
    expect(await conversionCommandArtifactCounts(receipt.commandId)).toEqual(factsBefore);

    const unrelatedMembershipPaymentFactId = "fact_stage47_applied_conversion_unrelated_membership_payment";
    await expect(db.insertInto("membership_payment_facts").values({
      fact_id: unrelatedMembershipPaymentFactId,
      membership_order_id: demo.membershipOrderId,
      fact_type: "COLLECTION",
      amount_minor: 100,
      net_effect_minor: 100,
      currency: "CNY",
      transaction_reference: "WX-STAGE47-APPLIED-CONVERSION-UNRELATED",
      corrects_fact_id: null,
      reverses_fact_id: null,
      source_type: "DIRECT_WECOM",
      source_order_id: null,
      source_collection_fact_id: null,
      note: "不得复用已完成转会员命令登记无关会员收款",
      command_id: receipt.commandId
    }).execute()).rejects.toMatchObject({
      constraint: "stage13_conversion_command_fact_exclusivity"
    });
    expect(await db.selectFrom("membership_payment_facts")
      .select("fact_id")
      .where("fact_id", "=", unrelatedMembershipPaymentFactId)
      .executeTakeFirst()).toBeUndefined();
    expect(await conversionCommandArtifactCounts(receipt.commandId)).toEqual(factsBefore);

    const unrelatedLodgingCollectionFactId = "fact_stage47_applied_conversion_unrelated_lodging_collection";
    await expect(db.insertInto("collection_facts").values({
      fact_id: unrelatedLodgingCollectionFactId,
      order_id: unrelatedStay.orderId,
      fact_type: "COLLECTION",
      amount_minor: 100,
      net_effect_minor: 100,
      currency: "CNY",
      references_fact_id: null,
      reverses_fact_id: null,
      method: "CASH",
      note: "不得复用已完成转会员命令登记无关住宿收款",
      transaction_reference: null,
      pricing_revision_id: unrelatedOrder.current_revision_id,
      command_id: receipt.commandId
    }).execute()).rejects.toMatchObject({
      constraint: "stage13_conversion_initial_lodging_fund_shape"
    });
    expect(await db.selectFrom("collection_facts")
      .select("fact_id")
      .where("fact_id", "=", unrelatedLodgingCollectionFactId)
      .executeTakeFirst()).toBeUndefined();
    expect(await conversionCommandArtifactCounts(receipt.commandId)).toEqual(factsBefore);
  });

  it("keeps EXECUTING and REJECTED conversion commands artifact-free across every child fact table", async () => {
    const memberId = await createMember("STAGE47-NON-APPLIED-PARTIAL-ID", "non-applied-partial");
    const stay = await createCheckedOutStay({
      prefix: "non-applied-partial",
      documentNumber: "STAGE47-NON-APPLIED-PARTIAL-ID",
      transactionReference: "WX-STAGE47-NON-APPLIED-PARTIAL-SOURCE"
    });
    const membershipOrderId = await createDraftMembershipOrder(memberId, "non-applied-partial");
    const membershipPaymentFactId = await recordMembershipPayment(membershipOrderId, "non-applied-partial");
    const order = await db.selectFrom("orders")
      .select(["current_revision_id", "version"])
      .where("id", "=", stay.orderId)
      .executeTakeFirstOrThrow();

    for (const state of ["EXECUTING", "REJECTED"] as const) {
      const stateSuffix = state.toLowerCase();
      const directFacts: Array<{
        kind: string;
        expectedConstraint?: string;
        write: (trx: Transaction<Database>, commandId: string, rowId: string) => Promise<void>;
      }> = [
        {
          kind: "amendment",
          write: async (trx, commandId, rowId) => {
            await trx.insertInto("amendments").values({
              id: rowId,
              order_id: stay.orderId,
              sequence: order.version + 1,
              amendment_type: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
              reason_code: "STAGE13_DIRECT_WRITE_PROBE",
              reason_note: "未完成转换命令不得挂载住宿变更",
              prior_version: order.version,
              new_version: order.version + 1,
              payload: {},
              command_id: commandId
            }).execute();
          }
        },
        {
          kind: "lodging-collection",
          expectedConstraint: "stage13_conversion_initial_lodging_fund_shape",
          write: async (trx, commandId, rowId) => {
            await trx.insertInto("collection_facts").values({
              fact_id: rowId,
              order_id: stay.orderId,
              fact_type: "COLLECTION",
              amount_minor: 100,
              net_effect_minor: 100,
              currency: "CNY",
              references_fact_id: null,
              reverses_fact_id: null,
              method: "WECOM",
              note: "未完成转换命令不得挂载住宿资金",
              transaction_reference: `WX-STAGE47-${state}-${rowId}`,
              pricing_revision_id: order.current_revision_id,
              command_id: commandId
            }).execute();
          }
        },
        {
          kind: "membership-collection",
          write: async (trx, commandId, rowId) => {
            await trx.insertInto("membership_payment_facts").values({
              fact_id: rowId,
              membership_order_id: membershipOrderId,
              fact_type: "COLLECTION",
              amount_minor: 100,
              net_effect_minor: 100,
              currency: "CNY",
              transaction_reference: `WX-STAGE47-${state}-${rowId}`,
              corrects_fact_id: null,
              reverses_fact_id: null,
              source_type: "DIRECT_WECOM",
              source_order_id: null,
              source_collection_fact_id: null,
              note: "未完成转换命令不得挂载会员资金",
              command_id: commandId
            }).execute();
          }
        },
        {
          kind: "transfer",
          write: async (trx, commandId, rowId) => {
            await sql`
              ALTER TABLE stay_collection_membership_transfers
              DISABLE TRIGGER stay_collection_membership_transfers_validate_insert
            `.execute(trx);
            await trx.insertInto("stay_collection_membership_transfers").values({
              id: rowId,
              property_id: demo.propertyId,
              order_id: stay.orderId,
              source_collection_fact_id: stay.collectionFactId,
              source_reversal_fact_id: stay.collectionFactId,
              membership_order_id: membershipOrderId,
              membership_payment_fact_id: membershipPaymentFactId,
              command_id: commandId
            }).execute();
          }
        },
        {
          kind: "entitlement",
          write: async (trx, commandId, rowId) => {
            await sql`
              ALTER TABLE entitlement_ledger
              DISABLE TRIGGER entitlement_ledger_validate_conversion_consume
            `.execute(trx);
            await trx.insertInto("entitlement_ledger").values({
              fact_id: rowId,
              lot_id: demo.roomLotId,
              entry_type: "CONVERSION_CONSUME",
              quantity_delta: -1,
              service_date: stayDates.arrival,
              order_id: stay.orderId,
              coverage_id: null,
              reason: "STAGE13_DIRECT_WRITE_PROBE",
              command_id: commandId
            }).execute();
          }
        },
        {
          kind: "entitlement-adjust",
          write: async (trx, commandId, rowId) => {
            await trx.insertInto("entitlement_ledger").values({
              fact_id: rowId,
              lot_id: demo.roomLotId,
              entry_type: "ADJUST",
              quantity_delta: 0,
              service_date: null,
              order_id: stay.orderId,
              coverage_id: null,
              reason: "STAGE13_DIRECT_ADJUST_PROBE",
              command_id: commandId
            }).execute();
          }
        },
        {
          kind: "entitlement-expire",
          write: async (trx, commandId, rowId) => {
            await trx.insertInto("entitlement_ledger").values({
              fact_id: rowId,
              lot_id: demo.roomLotId,
              entry_type: "EXPIRE",
              quantity_delta: 0,
              service_date: stayDates.arrival,
              order_id: stay.orderId,
              coverage_id: null,
              reason: "STAGE13_DIRECT_EXPIRE_PROBE",
              command_id: commandId
            }).execute();
          }
        },
        {
          kind: "membership-order",
          write: async (trx, commandId, rowId) => {
            await insertRawDraftMembershipOrder({
              membershipOrderId: rowId,
              memberId,
              commandId
            }, trx);
          }
        }
      ];

      for (const directFact of directFacts) {
        const commandId = `command_stage47_non_applied_${stateSuffix}_${directFact.kind}`;
        const rowId = `stage47_non_applied_${stateSuffix}_${directFact.kind}`;
        await insertRawConversionExecution(commandId, state);
        expect(await conversionCommandArtifactCounts(commandId)).toEqual({
          amendments: 0,
          lodgingCollections: 0,
          membershipCollections: 0,
          transfers: 0,
          entitlements: 0,
          membershipOrders: 0
        });

        const write = db.transaction().execute((trx) => directFact.write(trx, commandId, rowId));
        await expect(write).rejects.toMatchObject({
          constraint: directFact.expectedConstraint ?? "stage13_conversion_execution_state"
        });
        expect(await conversionCommandArtifactCounts(commandId)).toEqual({
          amendments: 0,
          lodgingCollections: 0,
          membershipCollections: 0,
          transfers: 0,
          entitlements: 0,
          membershipOrders: 0
        });
        expect(await db.selectFrom("command_executions")
          .select("state")
          .where("id", "=", commandId)
          .executeTakeFirstOrThrow()).toEqual({ state });
      }
    }
  });

  it("rejects applied conversion state regression and closed-membership-funds command bypasses", async () => {
    const memberId = await createMember("STAGE47-STATE-REGRESSION-ID", "state-regression");
    const stay = await createCheckedOutStay({
      prefix: "state-regression",
      documentNumber: "STAGE47-STATE-REGRESSION-ID",
      transactionReference: "WX-STAGE47-STATE-REGRESSION-SOURCE"
    });
    const envelope = conversionEnvelope({
      orderId: stay.orderId,
      memberId,
      collectionFactId: stay.collectionFactId,
      remainingPaymentTransactionReference: "WX-STAGE47-STATE-REGRESSION-REMAINING"
    });
    const prepared = await preview(envelope, "state-regression-conversion");
    const receipt = await confirmPrepared(envelope, prepared, "state-regression-conversion");
    expect(receipt.businessCommitted).toBe(true);
    const membershipOrderId = receipt.result!.membershipOrderId as string;

    for (const state of ["EXECUTING", "REJECTED"] as const) {
      await expect(db.updateTable("command_executions")
        .set({ state, completed_at: state === "REJECTED" ? new Date() : null })
        .where("id", "=", receipt.commandId)
        .execute()).rejects.toMatchObject({
          code: "55000",
          message: "command execution state may only advance from EXECUTING to a completed state"
        });
      expect(await db.selectFrom("command_executions")
        .select("state")
        .where("id", "=", receipt.commandId)
        .executeTakeFirstOrThrow()).toEqual({ state: "APPLIED" });

      const suffix = state.toLowerCase();
      const bypassCommandId = `command_stage47_closed_funds_${suffix}`;
      const bypassFactId = `membership_payment_stage47_closed_funds_${suffix}`;
      await insertRawConversionExecution(bypassCommandId, state);
      await expect(db.insertInto("membership_payment_facts").values({
        fact_id: bypassFactId,
        membership_order_id: membershipOrderId,
        fact_type: "COLLECTION",
        amount_minor: 100,
        net_effect_minor: 100,
        currency: "CNY",
        transaction_reference: `WX-STAGE47-CLOSED-FUNDS-${state}`,
        corrects_fact_id: null,
        reverses_fact_id: null,
        source_type: "DIRECT_WECOM",
        source_order_id: null,
        source_collection_fact_id: null,
        note: "不得借其他未完成转会员命令追加资金",
        command_id: bypassCommandId
      }).execute()).rejects.toMatchObject({
        constraint: "stage13_conversion_membership_funds_closed"
      });
      expect(await db.selectFrom("membership_payment_facts")
        .select("fact_id")
        .where("fact_id", "=", bypassFactId)
        .execute()).toHaveLength(0);
    }
  });

  it("rejects ambiguous or unsafe conversion inputs before writing anything", async () => {
    const mismatchMemberId = await createMember("STAGE47-MEMBER-ID", "identity-mismatch");
    const mismatchStay = await createCheckedOutStay({
      prefix: "identity-mismatch",
      guestPhone: "13999990001",
      documentNumber: "STAGE47-GUEST-ID",
      transactionReference: "WX-STAGE47-IDENTITY-SOURCE"
    });
    await expect(preview(conversionEnvelope({
      orderId: mismatchStay.orderId,
      memberId: mismatchMemberId,
      collectionFactId: mismatchStay.collectionFactId,
      remainingPaymentTransactionReference: "WX-STAGE47-IDENTITY-REMAINING"
    }), "identity-mismatch-conversion")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("手机号必须与主要住宿人一致")
    });
    expect(await db.selectFrom("stay_collection_membership_transfers").select("id").execute()).toHaveLength(0);

    await db.destroy();
    db = await resetDatabase(databaseUrl);
    const productMemberId = await createMember("STAGE47-PRODUCT-ID", "product-mismatch");
    const productStay = await createCheckedOutStay({
      prefix: "product-mismatch",
      documentNumber: "STAGE47-PRODUCT-ID",
      transactionReference: "WX-STAGE47-PRODUCT-SOURCE"
    });
    await expect(preview(conversionEnvelope({
      orderId: productStay.orderId,
      memberId: productMemberId,
      collectionFactId: productStay.collectionFactId,
      membershipProductId: products.privateSingle,
      agreedPriceMinor: 216_000,
      remainingPaymentTransactionReference: "WX-STAGE47-PRODUCT-REMAINING"
    }), "product-mismatch-conversion")).rejects.toMatchObject({
      code: "ENTITLEMENT_CONFLICT",
      message: expect.stringContaining("不适用于本次住宿房型")
    });
    expect(await db.selectFrom("stay_collection_membership_transfers").select("id").execute()).toHaveLength(0);

    await db.destroy();
    db = await resetDatabase(databaseUrl);
    const priceMemberId = await createMember("STAGE47-PRICE-ID", "price-guard");
    const priceStay = await createCheckedOutStay({
      prefix: "price-guard",
      documentNumber: "STAGE47-PRICE-ID",
      transactionReference: "WX-STAGE47-PRICE-SOURCE"
    });
    await expect(preview(conversionEnvelope({
      orderId: priceStay.orderId,
      memberId: priceMemberId,
      collectionFactId: priceStay.collectionFactId,
      agreedPriceMinor: 58_000,
      priceAdjustmentReason: "测试成交价低于用于升级的住宿收款"
    }), "price-too-low-conversion")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("会员成交价不能低于本次用于升级")
    });
    await expect(preview(conversionEnvelope({
      orderId: priceStay.orderId,
      memberId: priceMemberId,
      collectionFactId: priceStay.collectionFactId
    }), "missing-remaining-transaction")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("必须填写差额企业微信交易单号")
    });
    await expect(preview(conversionEnvelope({
      orderId: priceStay.orderId,
      memberId: priceMemberId,
      collectionFactId: priceStay.collectionFactId,
      remainingPaymentTransactionReference: "WX-STAGE47-PRICE-SOURCE"
    }), "reused-remaining-transaction")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("不能沿用原住宿收款交易单号")
    });
    expect(await db.selectFrom("stay_collection_membership_transfers").select("id").execute()).toHaveLength(0);

    await db.destroy();
    db = await resetDatabase(databaseUrl);
    const partialMemberId = await createMember("STAGE47-PARTIAL-ID", "partial-net");
    const partialStay = await createCheckedOutStay({
      prefix: "partial-net",
      documentNumber: "STAGE47-PARTIAL-ID",
      collectionAmountMinor: 1_000,
      transactionReference: "WX-STAGE47-PARTIAL-A"
    });
    const secondCollection = await execute({
      commandType: "RECORD_COLLECTION",
      input: {
        propertyId: demo.propertyId,
        orderId: partialStay.orderId,
        amountMinor: 59_000,
        method: "WECOM",
        transactionReference: "WX-STAGE47-PARTIAL-B",
        note: "第二笔有效住宿收款"
      }
    }, "partial-net-second-collection");
    await expect(preview(conversionEnvelope({
      orderId: partialStay.orderId,
      memberId: partialMemberId,
      collectionFactId: secondCollection.result!.factId as string,
      remainingPaymentTransactionReference: "WX-STAGE47-PARTIAL-REMAINING"
    }), "partial-net-conversion")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("升级会员必须一次转入全部当前可留存的企微住宿净收款")
    });
    expect(await db.selectFrom("stay_collection_membership_transfers").select("id").execute()).toHaveLength(0);

    await db.destroy();
    db = await resetDatabase(databaseUrl);
    const staleReferenceMemberId = await createMember("STAGE47-STALE-REF-ID", "stale-ref");
    const staleReferenceStay = await createCheckedOutStay({
      prefix: "stale-ref",
      documentNumber: "STAGE47-STALE-REF-ID",
      collectionAmountMinor: 1_000,
      transactionReference: "WX-STAGE47-STALE-OLD"
    });
    await execute({
      commandType: "REVERSE_FACT",
      input: {
        propertyId: demo.propertyId,
        orderId: staleReferenceStay.orderId,
        reversesFactId: staleReferenceStay.collectionFactId,
        note: "旧住宿收款录错后冲销"
      }
    }, "stale-ref-reverse-old");
    const activeCollection = await execute({
      commandType: "RECORD_COLLECTION",
      input: {
        propertyId: demo.propertyId,
        orderId: staleReferenceStay.orderId,
        amountMinor: 59_000,
        method: "WECOM",
        transactionReference: "WX-STAGE47-STALE-ACTIVE",
        note: "当前有效住宿收款"
      }
    }, "stale-ref-active-collection");
    await expect(preview(conversionEnvelope({
      orderId: staleReferenceStay.orderId,
      memberId: staleReferenceMemberId,
      collectionFactId: activeCollection.result!.factId as string,
      remainingPaymentTransactionReference: "WX-STAGE47-STALE-OLD"
    }), "stale-ref-conversion")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("住宿资金记录包含非企微、冲销或无法核对的收退款事实")
    });
    expect(await db.selectFrom("stay_collection_membership_transfers").select("id").execute()).toHaveLength(0);
  });

  it("transfers only the remaining WeCom amount when a lodging collection was partially refunded", async () => {
    const memberId = await createMember("STAGE47-REFUNDED-ID", "refunded");
    const stay = await createCheckedOutStay({
      prefix: "refunded",
      documentNumber: "STAGE47-REFUNDED-ID",
      transactionReference: "WX-STAGE47-REFUNDED-SOURCE"
    });
    await execute({
      commandType: "RECORD_REFUND",
      input: {
        propertyId: demo.propertyId,
        orderId: stay.orderId,
        referencesFactId: stay.collectionFactId,
        amountMinor: 1_000,
        method: "WECOM",
        note: "部分退款后按剩余企微净额升级会员"
      }
    }, "refunded-source-refund");

    const envelope = conversionEnvelope({
      orderId: stay.orderId,
      memberId,
      collectionFactId: stay.collectionFactId,
      remainingPaymentTransactionReference: "WX-STAGE47-REFUNDED-REMAINING"
    });
    const prepared = await preview(envelope, "refunded-source-conversion");
    expect(prepared.preview.effect).toMatchObject({
      transfer: {
        total: { currency: "CNY", minorUnits: 58_000 },
        collections: [{ factId: stay.collectionFactId, amount: { currency: "CNY", minorUnits: 58_000 } }]
      },
      remainingPayment: {
        amount: { currency: "CNY", minorUnits: 104_000 },
        transactionReference: "WX-STAGE47-REFUNDED-REMAINING"
      }
    });

    const receipt = await confirmPrepared(envelope, prepared, "refunded-source-conversion");
    expect(receipt.businessCommitted, JSON.stringify(receipt.error)).toBe(true);
    expect(receipt.result).toMatchObject({
      transferredCollectionFactIds: [stay.collectionFactId],
      transferredAmount: { currency: "CNY", minorUnits: 58_000 },
      remainingPaymentAmount: { currency: "CNY", minorUnits: 104_000 }
    });
    const lodgingNet = await db.selectFrom("collection_facts")
      .select(sql<number>`coalesce(sum(net_effect_minor), 0)::integer`.as("net"))
      .where("order_id", "=", stay.orderId)
      .executeTakeFirstOrThrow();
    expect(lodgingNet.net).toBe(0);
    const transferPayment = await db.selectFrom("membership_payment_facts")
      .select(["amount_minor", "source_type", "source_collection_fact_id"])
      .where("membership_order_id", "=", receipt.result!.membershipOrderId as string)
      .where("source_type", "=", "STAY_COLLECTION_TRANSFER")
      .executeTakeFirstOrThrow();
    expect(transferPayment).toEqual({
      amount_minor: 58_000,
      source_type: "STAY_COLLECTION_TRANSFER",
      source_collection_fact_id: stay.collectionFactId
    });
  });

  it("fails closed at the entry and preview for a historical WeCom refund that still carries its own transaction reference", async () => {
    const memberId = await createMember("STAGE86-LEGACY-REFUND-REFERENCE-ID", "legacy-refund-reference");
    const stay = await createCheckedOutStay({
      prefix: "legacy-refund-reference",
      documentNumber: "STAGE86-LEGACY-REFUND-REFERENCE-ID",
      skipCheckOut: true,
      transactionReference: "WX-STAGE86-LEGACY-REFUND-SOURCE"
    });
    const refund = await execute({
      commandType: "RECORD_REFUND",
      input: {
        propertyId: demo.propertyId,
        orderId: stay.orderId,
        referencesFactId: stay.collectionFactId,
        amountMinor: 1_000,
        method: "WECOM",
        note: "构造迁移 032 前遗留的企微退款交易单号"
      }
    }, "legacy-refund-reference-refund");

    // Migration 009 required a refund transaction number. Reproduce that
    // immutable historical shape without weakening the current write guard.
    await db.transaction().execute(async (trx) => {
      await sql`ALTER TABLE collection_facts DISABLE TRIGGER collection_facts_append_only`.execute(trx);
      await trx.updateTable("collection_facts")
        .set({ transaction_reference: "WX-STAGE86-LEGACY-REFUND" })
        .where("fact_id", "=", refund.result!.factId as string)
        .executeTakeFirstOrThrow();
      await sql`ALTER TABLE collection_facts ENABLE TRIGGER collection_facts_append_only`.execute(trx);
    });

    const before = await conversionRollbackSnapshot(stay.orderId, memberId);
    const view = await getOrderView(db, stay.orderId);
    expect(view.allowedActions.find((action) => action.code === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"))
      .toMatchObject({ enabled: false, disabledReason: "NO_TRANSFERABLE_COLLECTION" });
    await expect(preview(conversionEnvelope({
      orderId: stay.orderId,
      memberId,
      collectionFactId: stay.collectionFactId,
      remainingPaymentTransactionReference: "WX-STAGE86-LEGACY-REFUND-MEMBER"
    }), "legacy-refund-reference-conversion")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("住宿资金记录包含非企微、冲销或无法核对的收退款事实")
    });
    expect(await conversionRollbackSnapshot(stay.orderId, memberId)).toEqual(before);
  });

  it("fails closed at the entry when a historical lodging fact currency does not match the order", async () => {
    const memberId = await createMember("STAGE86-CURRENCY-MISMATCH-ID", "currency-mismatch");
    const stay = await createCheckedOutStay({
      prefix: "currency-mismatch",
      documentNumber: "STAGE86-CURRENCY-MISMATCH-ID",
      skipCheckOut: true,
      transactionReference: "WX-STAGE86-CURRENCY-MISMATCH-SOURCE"
    });
    await db.transaction().execute(async (trx) => {
      await sql`ALTER TABLE collection_facts DISABLE TRIGGER collection_facts_append_only`.execute(trx);
      await trx.updateTable("collection_facts")
        .set({ currency: "USD" })
        .where("fact_id", "=", stay.collectionFactId)
        .executeTakeFirstOrThrow();
      await sql`ALTER TABLE collection_facts ENABLE TRIGGER collection_facts_append_only`.execute(trx);
    });

    const before = await conversionRollbackSnapshot(stay.orderId, memberId);
    const view = await getOrderView(db, stay.orderId);
    expect(view.allowedActions.find((action) => action.code === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"))
      .toMatchObject({ enabled: false, disabledReason: "NO_TRANSFERABLE_COLLECTION" });
    await expect(preview(conversionEnvelope({
      orderId: stay.orderId,
      memberId,
      collectionFactId: stay.collectionFactId,
      remainingPaymentTransactionReference: "WX-STAGE86-CURRENCY-MISMATCH-MEMBER"
    }), "currency-mismatch-conversion")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("无法核对的收退款事实")
    });
    expect(await conversionRollbackSnapshot(stay.orderId, memberId)).toEqual(before);
  });

  it("rejects non-WeCom or ambiguous channels and disables the action for mixed funds", async () => {
    const memberId = await createMember("STAGE47-CHANNEL-ID", "channel-guard");
    const externalStay = await createCheckedOutStay({
      prefix: "external-channel",
      documentNumber: "STAGE47-CHANNEL-ID",
      bookingChannelCode: "MEITUAN",
      skipCollection: true
    });
    await expect(preview(conversionEnvelope({
      orderId: externalStay.orderId,
      memberId,
      collectionFactId: "fact_external_placeholder",
      remainingPaymentTransactionReference: "WX-STAGE47-EXTERNAL-REMAINING"
    }), "external-channel-conversion")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("外部渠道订单")
    });
    let view = await getOrderView(db, externalStay.orderId);
    expect(view.allowedActions.find((action) => action.code === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"))
      .toMatchObject({ enabled: false, disabledReason: expect.stringContaining("外部渠道订单") });

    await db.destroy();
    db = await resetDatabase(databaseUrl);
    const mixedMemberId = await createMember("STAGE47-MIXED-ID", "mixed-funds");
    const mixedStay = await createCheckedOutStay({
      prefix: "mixed-funds",
      documentNumber: "STAGE47-MIXED-ID",
      collectionAmountMinor: 59_000,
      transactionReference: "WX-STAGE47-MIXED-SOURCE"
    });
    await execute({
      commandType: "RECORD_COLLECTION",
      input: {
        propertyId: demo.propertyId,
        orderId: mixedStay.orderId,
        amountMinor: 1_000,
        method: "CASH",
        note: "Cashier A"
      }
    }, "mixed-cash-collection");
    view = await getOrderView(db, mixedStay.orderId);
    expect(view.allowedActions.find((action) => action.code === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"))
      .toMatchObject({ enabled: false, disabledReason: "NO_TRANSFERABLE_COLLECTION" });
    await expect(preview(conversionEnvelope({
      orderId: mixedStay.orderId,
      memberId: mixedMemberId,
      collectionFactId: mixedStay.collectionFactId,
      remainingPaymentTransactionReference: "WX-STAGE47-MIXED-REMAINING"
    }), "mixed-funds-conversion")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("住宿资金记录包含非企微、冲销或无法核对的收退款事实")
    });
    expect(await db.selectFrom("stay_collection_membership_transfers").select("id").execute()).toHaveLength(0);
  });

  it("fails closed for stale previews and concurrent confirmations without duplicating membership artifacts", async () => {
    const staleMemberId = await createMember("STAGE47-STALE-PREVIEW-ID", "stale-preview");
    const staleStay = await createCheckedOutStay({
      prefix: "stale-preview",
      documentNumber: "STAGE47-STALE-PREVIEW-ID",
      transactionReference: "WX-STAGE47-STALE-PREVIEW-SOURCE"
    });
    const staleEnvelope = conversionEnvelope({
      orderId: staleStay.orderId,
      memberId: staleMemberId,
      collectionFactId: staleStay.collectionFactId,
      remainingPaymentTransactionReference: "WX-STAGE47-STALE-PREVIEW-REMAINING"
    });
    const stalePrepared = await preview(staleEnvelope, "stale-preview-conversion");
    const beforeStale = await conversionArtifactCounts(staleStay.orderId);
    await execute({
      commandType: "RECORD_COLLECTION",
      input: {
        propertyId: demo.propertyId,
        orderId: staleStay.orderId,
        amountMinor: 1_000,
        method: "WECOM",
        transactionReference: "WX-STAGE47-STALE-PREVIEW-EXTRA",
        note: "核对后又登记了一笔住宿收款"
      }
    }, "stale-preview-extra-collection");
    const staleReceipt = await confirmPrepared(staleEnvelope, stalePrepared, "stale-preview-conversion");
    expect(staleReceipt).toMatchObject({
      executionStatus: "NOT_EXECUTED",
      businessCommitted: false,
      error: { code: "PREVIEW_STALE" }
    });
    expect(await conversionArtifactCounts(staleStay.orderId)).toEqual({
      ...beforeStale,
      pricingRevisions: beforeStale.pricingRevisions
    });

    await db.destroy();
    db = await resetDatabase(databaseUrl);
    const concurrentMemberId = await createMember("STAGE47-CONCURRENT-ID", "concurrent");
    const concurrentStay = await createCheckedOutStay({
      prefix: "concurrent",
      documentNumber: "STAGE47-CONCURRENT-ID",
      transactionReference: "WX-STAGE47-CONCURRENT-SOURCE"
    });
    const concurrentEnvelope = conversionEnvelope({
      orderId: concurrentStay.orderId,
      memberId: concurrentMemberId,
      collectionFactId: concurrentStay.collectionFactId,
      remainingPaymentTransactionReference: "WX-STAGE47-CONCURRENT-REMAINING"
    });
    const first = await preview(concurrentEnvelope, "concurrent-conversion-a");
    const second = await preview(concurrentEnvelope, "concurrent-conversion-b");
    const firstConfirmation = {
      propertyId: demo.propertyId,
      commandType: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP" as const,
      confirmation: true as const,
      expectedEffectHash: first.preview.effectHash,
      reason: { code: "STAGE47_ACCEPTANCE", note: "Concurrent conversion A" }
    };
    const firstMetadata = { idempotencyKey: "stage47-concurrent-confirm-a", correlationId: "stage47-concurrent-confirm-a" };
    const firstReceipt = await confirmCommandPreview(db, principal, first.preview.previewId, firstConfirmation, firstMetadata);
    const replayReceipt = await confirmCommandPreview(db, principal, first.preview.previewId, firstConfirmation, firstMetadata);
    expect(replayReceipt.receiptId).toBe(firstReceipt.receiptId);
    const secondReceipt = await confirmCommandPreview(db, principal, second.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
      confirmation: true,
      expectedEffectHash: second.preview.effectHash,
      reason: { code: "STAGE47_ACCEPTANCE", note: "Concurrent conversion B" }
    }, metadata("stage47-concurrent-confirm-b"));
    expect(firstReceipt.businessCommitted).toBe(true);
    expect(secondReceipt).toMatchObject({ executionStatus: "NOT_EXECUTED", businessCommitted: false, error: { code: "PREVIEW_STALE" } });
    expect(await db.selectFrom("stay_collection_membership_transfers").select("id").where("order_id", "=", concurrentStay.orderId).execute()).toHaveLength(1);
    expect(await db.selectFrom("membership_orders").select("id").where("created_by_command_id", "=", firstReceipt.commandId).execute()).toHaveLength(1);
    expect(await db.selectFrom("entitlement_ledger").select("fact_id").where("order_id", "=", concurrentStay.orderId).where("entry_type", "=", "CONVERSION_CONSUME").execute()).toHaveLength(7);
    expect(await db.selectFrom("amendments").select("id").where("order_id", "=", concurrentStay.orderId).where("amendment_type", "=", "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP").execute()).toHaveLength(1);
  });

  it("transfers all split WeCom lodging collections without an arbitrary 20-payment cap", async () => {
    const memberId = await createMember("STAGE47-MANY-ID", "many-collections");
    const stay = await createCheckedOutStay({
      prefix: "many-collections",
      documentNumber: "STAGE47-MANY-ID",
      collectionAmountMinor: 100,
      transactionReference: "WX-STAGE47-MANY-00"
    });
    const collectionFactIds = [stay.collectionFactId];
    for (let index = 1; index <= 20; index += 1) {
      const receipt = await execute({
        commandType: "RECORD_COLLECTION",
        input: {
          propertyId: demo.propertyId,
          orderId: stay.orderId,
          amountMinor: 100,
          method: "WECOM",
          transactionReference: `WX-STAGE47-MANY-${String(index).padStart(2, "0")}`,
          note: "分笔住宿收款"
        }
      }, `many-collections-${index}`);
      collectionFactIds.push(receipt.result!.factId as string);
    }
    expect(collectionFactIds).toHaveLength(21);
    const prepared = await preview(conversionEnvelope({
      orderId: stay.orderId,
      memberId,
      collectionFactId: stay.collectionFactId,
      collectionFactIds,
      remainingPaymentTransactionReference: "WX-STAGE47-MANY-REMAINING"
    }), "many-collections-conversion");
    expect(prepared.preview.effect).toMatchObject({
      transfer: {
        total: { currency: "CNY", minorUnits: 2_100 }
      },
      remainingPayment: {
        amount: { currency: "CNY", minorUnits: 159_900 }
      }
    });
    const receipt = await confirmPrepared(conversionEnvelope({
      orderId: stay.orderId,
      memberId,
      collectionFactId: stay.collectionFactId,
      collectionFactIds,
      remainingPaymentTransactionReference: "WX-STAGE47-MANY-REMAINING"
    }), prepared, "many-collections-conversion");
    expect(receipt.businessCommitted).toBe(true);
    expect(receipt.result).toMatchObject({
      transferredCollectionFactIds: collectionFactIds,
      transferredAmount: { currency: "CNY", minorUnits: 2_100 }
    });
    expect(await db.selectFrom("stay_collection_membership_transfers").select("id").where("order_id", "=", stay.orderId).execute()).toHaveLength(21);
  });

  describe("8.6 in-house stay membership conversion fulfillment", () => {
    it("fails closed before preview when the target member is linked to more than the current property", async () => {
      const prefix = "inhouse-multi-property-preview";
      const memberId = await createMember("STAGE86-MULTI-PROPERTY-PREVIEW-ID", prefix);
      const stay = await createCheckedOutStay({
        prefix,
        documentNumber: "STAGE86-MULTI-PROPERTY-PREVIEW-ID",
        skipCheckOut: true,
        skipCollection: true
      });
      await linkMemberToAdditionalProperty(memberId);
      const before = await conversionRollbackSnapshot(stay.orderId, memberId);

      await expect(withPropertyClockForTesting(new Date("2026-09-02T12:00:00.000Z"), () => preview(conversionEnvelope({
        orderId: stay.orderId,
        memberId,
        collectionFactId: "",
        collectionFactIds: [],
        remainingPaymentTransactionReference: "WX-STAGE86-MULTI-PROPERTY-PREVIEW-REMAINING"
      }), "inhouse-multi-property-preview-conversion"))).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: "当前版本仅支持单门店会员；该会员已关联其他门店，不能升级会员"
      });
      expect(await conversionRollbackSnapshot(stay.orderId, memberId)).toEqual(before);
    });

    it("rejects confirmation without conversion artifacts when a second property link appears after preview", async () => {
      const prefix = "inhouse-multi-property-confirm";
      const memberId = await createMember("STAGE86-MULTI-PROPERTY-CONFIRM-ID", prefix);
      const stay = await createCheckedOutStay({
        prefix,
        documentNumber: "STAGE86-MULTI-PROPERTY-CONFIRM-ID",
        skipCheckOut: true,
        skipCollection: true
      });
      const envelope = conversionEnvelope({
        orderId: stay.orderId,
        memberId,
        collectionFactId: "",
        collectionFactIds: [],
        remainingPaymentTransactionReference: "WX-STAGE86-MULTI-PROPERTY-CONFIRM-REMAINING"
      });
      const prepared = await withPropertyClockForTesting(new Date("2026-09-02T12:00:00.000Z"), () =>
        preview(envelope, "inhouse-multi-property-confirm-conversion")
      );
      const before = await conversionRollbackSnapshot(stay.orderId, memberId);
      await linkMemberToAdditionalProperty(memberId);

      const receipt = await withPropertyClockForTesting(new Date("2026-09-02T12:00:00.000Z"), () =>
        confirmPrepared(envelope, prepared, "inhouse-multi-property-confirm-conversion")
      );
      expect(receipt).toMatchObject({
        executionStatus: "NOT_EXECUTED",
        businessCommitted: false,
        error: { code: "PREVIEW_STALE" }
      });
      expect(await conversionCommandArtifactCounts(receipt.commandId)).toEqual({
        amendments: 0,
        lodgingCollections: 0,
        membershipCollections: 0,
        transfers: 0,
        entitlements: 0,
        membershipOrders: 0
      });
      expect(await conversionRollbackSnapshot(stay.orderId, memberId)).toEqual(before);
    });

    it("marks a zero-collection in-house stay as upgraded without creating a fictitious zero payment", async () => {
      const converted = await createInHouseConversion({
        prefix: "inhouse-zero-collection",
        skipCollection: true
      });
      expect(converted.receipt.result).toMatchObject({
        transferredCollectionFactIds: [],
        lodgingReversalFactIds: [],
        transferIds: [],
        transferredAmount: { currency: "CNY", minorUnits: 0 },
        remainingPaymentAmount: { currency: "CNY", minorUnits: 162_000 }
      });
      const order = await db.selectFrom("orders")
        .innerJoin("stays", "stays.order_id", "orders.id")
        .innerJoin("pricing_revisions", "pricing_revisions.id", "orders.current_revision_id")
        .select([
          "orders.status as orderStatus",
          "orders.member_id as memberId",
          "orders.member_contract_id as memberContractId",
          "stays.status as stayStatus",
          "pricing_revisions.current_contract_amount_minor as currentContractAmountMinor"
        ])
        .where("orders.id", "=", converted.stay.orderId)
        .executeTakeFirstOrThrow();
      expect(order).toEqual({
        orderStatus: "CHECKED_IN",
        memberId: converted.memberId,
        memberContractId: converted.contractId,
        stayStatus: "IN_HOUSE",
        currentContractAmountMinor: 0
      });
      expect(await db.selectFrom("collection_facts")
        .select("fact_id")
        .where("order_id", "=", converted.stay.orderId)
        .execute()).toEqual([]);
      expect(await db.selectFrom("stay_collection_membership_transfers")
        .select("id")
        .where("order_id", "=", converted.stay.orderId)
        .execute()).toEqual([]);
      expect(await db.selectFrom("membership_payment_facts")
        .select(["amount_minor", "source_type", "transaction_reference"])
        .where("membership_order_id", "=", converted.membershipOrderId)
        .execute()).toEqual([{
        amount_minor: 162_000,
        source_type: "DIRECT_WECOM",
        transaction_reference: "WX-STAGE86-INHOUSE-ZERO-COLLECTION-REMAINING"
      }]);
      const coverage = await db.selectFrom("coverage_items")
        .select(["id", "service_date", "status"])
        .where("order_id", "=", converted.stay.orderId)
        .orderBy("service_date")
        .execute();
      expect(coverage).toEqual(serviceDates(stayDates.arrival, stayDates.departure)
        .map((service_date) => expect.objectContaining({ service_date, status: "CONSUMED" })));
      const contract = await db.selectFrom("member_contracts")
        .select("valid_from")
        .where("id", "=", converted.contractId)
        .executeTakeFirstOrThrow();
      expect(contract.valid_from).toBe("2026-09-02");
      expect(coverage.filter((item) => item.service_date < contract.valid_from)
        .map((item) => item.service_date)).toEqual(["2026-09-01"]);
      expect(converted.receipt.result).toMatchObject({
        conversionCoverageIds: coverage.map((item) => item.id)
      });
      const conversionLedger = await db.selectFrom("entitlement_ledger")
        .select(["entry_type", "quantity_delta", "service_date"])
        .where("order_id", "=", converted.stay.orderId)
        .where("entry_type", "=", "CONVERSION_CONSUME")
        .orderBy("service_date")
        .execute();
      expect(conversionLedger).toEqual(serviceDates(stayDates.arrival, stayDates.departure)
        .map((service_date) => ({ entry_type: "CONVERSION_CONSUME", quantity_delta: -1, service_date })));
      expect((await getOrderView(db, converted.stay.orderId)).membershipConversion).toEqual({
        membershipOrderId: converted.membershipOrderId,
        memberId: converted.memberId,
        contractId: converted.contractId,
        entitlementLotId: converted.entitlementLotId,
        commandId: converted.receipt.commandId
      });

      const beforeClosedFundsAction = await conversionRollbackSnapshot(converted.stay.orderId, converted.memberId);
      await expect(preview({
        commandType: "RECORD_COLLECTION",
        input: {
          propertyId: demo.propertyId,
          orderId: converted.stay.orderId,
          amountMinor: 1_000,
          method: "WECOM",
          transactionReference: "WX-STAGE86-ZERO-AFTER-CONVERSION",
          note: "零转入升级后不得再追加住宿收款"
        }
      }, "inhouse-zero-after-conversion-collection")).rejects.toMatchObject({
        code: "AGGREGATE_VERSION_CONFLICT"
      });
      await expect(preview(conversionEnvelope({
        orderId: converted.stay.orderId,
        memberId: converted.memberId,
        collectionFactId: "",
        collectionFactIds: [],
        remainingPaymentTransactionReference: "WX-STAGE86-ZERO-REPEATED-CONVERSION"
      }), "inhouse-zero-repeated-conversion")).rejects.toMatchObject({
        code: "AGGREGATE_VERSION_CONFLICT"
      });
      expect(await conversionRollbackSnapshot(converted.stay.orderId, converted.memberId)).toEqual(beforeClosedFundsAction);
    });

    it("rejects untyped consumed coverage, pre-validity held coverage, and direct consumed release", async () => {
      const converted = await createInHouseConversion({
        prefix: "inhouse-coverage-write-guards",
        skipCollection: true
      });
      const source = await db.selectFrom("coverage_items")
        .selectAll()
        .where("order_id", "=", converted.stay.orderId)
        .where("service_date", "=", stayDates.arrival)
        .executeTakeFirstOrThrow();

      await expect(db.insertInto("coverage_items").values({
        ...source,
        id: "coverage_untyped_consumed_guard",
        created_at: new Date(),
        updated_at: new Date()
      }).execute()).rejects.toMatchObject({
        code: "55000",
        constraint: "coverage_conversion_consumed_insert"
      });

      await expect(db.insertInto("coverage_items").values({
        ...source,
        id: "coverage_pre_validity_held_guard",
        service_date: stayDates.arrival,
        status: "HELD",
        created_at: new Date(),
        updated_at: new Date()
      }).execute()).rejects.toMatchObject({
        code: "23514",
        constraint: "coverage_items_entitlement_valid"
      });

      await expect(db.updateTable("coverage_items")
        .set({ status: "RELEASED", updated_at: new Date() })
        .where("id", "=", source.id)
        .execute()).rejects.toMatchObject({
        code: "55000",
        constraint: "coverage_status_typed_transition"
      });
      expect(await db.selectFrom("coverage_items")
        .select("status")
        .where("id", "=", source.id)
        .executeTakeFirstOrThrow()).toEqual({ status: "CONSUMED" });
    });

    it("rejects fake typed conversion coverage with a mismatched revision, order, member, contract, or lot", async () => {
      const converted = await createInHouseConversion({
        prefix: "inhouse-conversion-coverage-binding",
        skipCollection: true
      });
      const other = await createInHouseConversion({
        prefix: "inhouse-conversion-coverage-binding-other",
        skipCollection: true,
        unitId: "unit_room_d_gen_04"
      });
      const source = await db.selectFrom("coverage_items")
        .selectAll()
        .where("order_id", "=", converted.stay.orderId)
        .where("service_date", "=", stayDates.arrival)
        .executeTakeFirstOrThrow();
      const originalRevision = await db.selectFrom("pricing_revisions")
        .select("id")
        .where("order_id", "=", converted.stay.orderId)
        .where("revision_no", "=", 1)
        .executeTakeFirstOrThrow();

      const mismatches = [
        {
          name: "fake conversion revision",
          values: { held_by_revision_id: originalRevision.id }
        },
        {
          name: "wrong order",
          values: { order_id: other.stay.orderId }
        },
        {
          name: "wrong member graph",
          values: { contract_id: other.contractId, lot_id: other.entitlementLotId }
        },
        {
          name: "wrong contract",
          values: { contract_id: other.contractId }
        },
        {
          name: "wrong lot",
          values: { lot_id: other.entitlementLotId }
        }
      ] as const;

      for (const [index, mismatch] of mismatches.entries()) {
        const coverageId = `coverage_conversion_binding_guard_${index}`;
        const corruptWrite = db.transaction().execute(async (trx) => {
          await sql`ALTER TABLE command_executions DISABLE TRIGGER command_executions_protect_identity`.execute(trx);
          await trx.updateTable("command_executions")
            .set({ state: "EXECUTING", completed_at: null })
            .where("id", "=", converted.receipt.commandId)
            .executeTakeFirstOrThrow();
          await trx.insertInto("coverage_items").values({
            ...source,
            id: coverageId,
            ...mismatch.values,
            created_at: new Date(),
            updated_at: new Date()
          }).execute();
          throw new Error(`coverage guard accepted ${mismatch.name}`);
        });
        await expect(corruptWrite, mismatch.name).rejects.toMatchObject({
          code: "55000",
          constraint: "coverage_conversion_consumed_insert"
        });
        expect(await db.selectFrom("coverage_items")
          .select("id")
          .where("id", "=", coverageId)
          .executeTakeFirst(), mismatch.name).toBeUndefined();
      }
      expect(await db.selectFrom("command_executions")
        .select("state")
        .where("id", "=", converted.receipt.commandId)
        .executeTakeFirstOrThrow()).toEqual({ state: "APPLIED" });
    });

    it("binds a full in-house WeCom lodging transfer to the source fact carrying the original real transaction", async () => {
      const converted = await createInHouseConversion({
        prefix: "inhouse-full-transfer",
        agreedPriceMinor: 59_000,
        priceAdjustmentReason: "住宿企微收款全额转入会员成交价"
      });
      expect(converted.receipt.result).toMatchObject({
        transferredAmount: { currency: "CNY", minorUnits: 59_000 },
        remainingPaymentAmount: { currency: "CNY", minorUnits: 0 }
      });
      expect(await db.selectFrom("membership_payment_facts")
        .select(["amount_minor", "source_type", "source_collection_fact_id", "transaction_reference"])
        .where("membership_order_id", "=", converted.membershipOrderId)
        .execute()).toEqual([{
        amount_minor: 59_000,
        source_type: "STAY_COLLECTION_TRANSFER",
        source_collection_fact_id: converted.stay.collectionFactId,
        transaction_reference: null
      }]);
      expect(await db.selectFrom("collection_facts")
        .select(["fact_id", "method", "transaction_reference"])
        .where("fact_id", "=", converted.stay.collectionFactId)
        .executeTakeFirstOrThrow()).toEqual({
        fact_id: converted.stay.collectionFactId,
        method: "WECOM",
        transaction_reference: "WX-STAGE86-INHOUSE-FULL-TRANSFER-SOURCE"
      });
      expect(await db.selectFrom("membership_payment_facts")
        .select("fact_id")
        .where("membership_order_id", "=", converted.membershipOrderId)
        .where("source_type", "=", "DIRECT_WECOM")
        .execute()).toEqual([]);
    });

    it("rejects a zero membership agreed price before creating any in-house conversion artifact", async () => {
      const memberId = await createMember("STAGE86-ZERO-AGREED-ID", "zero-agreed");
      const stay = await createCheckedOutStay({
        prefix: "zero-agreed",
        documentNumber: "STAGE86-ZERO-AGREED-ID",
        skipCheckOut: true,
        skipCollection: true
      });
      const before = await conversionRollbackSnapshot(stay.orderId, memberId);
      await expect(withPropertyClockForTesting(new Date("2026-09-02T12:00:00.000Z"), () => preview(conversionEnvelope({
        orderId: stay.orderId,
        memberId,
        collectionFactId: "",
        collectionFactIds: [],
        agreedPriceMinor: 0,
        priceAdjustmentReason: "会员成交价不能为零"
      }), "inhouse-zero-agreed-price"))).rejects.toMatchObject({
        code: "VALIDATION_ERROR"
      });
      expect(await conversionRollbackSnapshot(stay.orderId, memberId)).toEqual(before);
    });

    it("allows a fully refunded WeCom fund graph to upgrade with zero transfer and one real direct membership payment", async () => {
      const memberId = await createMember("STAGE86-NET-ZERO-REFUND-ID", "net-zero-refund-allowed");
      const stay = await createCheckedOutStay({
        prefix: "net-zero-refund-allowed",
        documentNumber: "STAGE86-NET-ZERO-REFUND-ID",
        skipCheckOut: true,
        transactionReference: "WX-STAGE86-NET-ZERO-REFUND-SOURCE"
      });
      await execute({
        commandType: "RECORD_REFUND",
        input: {
          propertyId: demo.propertyId,
          orderId: stay.orderId,
          referencesFactId: stay.collectionFactId,
          amountMinor: 59_000,
          method: "WECOM",
          note: "全额退款后本订单企微净额为零"
        }
      }, "net-zero-refund-allowed-wecom-refund");

      const envelope = conversionEnvelope({
        orderId: stay.orderId,
        memberId,
        collectionFactId: "",
        collectionFactIds: [],
        remainingPaymentTransactionReference: "WX-STAGE86-NET-ZERO-REFUND-MEMBER"
      });
      const prepared = await withPropertyClockForTesting(new Date("2026-09-02T12:00:00.000Z"), () =>
        preview(envelope, "net-zero-refund-allowed-conversion")
      );
      expect(prepared.preview.effect).toMatchObject({
        transfer: { total: { currency: "CNY", minorUnits: 0 }, collections: [] },
        remainingPayment: {
          amount: { currency: "CNY", minorUnits: 162_000 },
          transactionReference: "WX-STAGE86-NET-ZERO-REFUND-MEMBER"
        }
      });

      const receipt = await withPropertyClockForTesting(new Date("2026-09-02T12:00:00.000Z"), () =>
        confirmPrepared(envelope, prepared, "net-zero-refund-allowed-conversion")
      );
      expect(receipt.businessCommitted, JSON.stringify(receipt.error)).toBe(true);
      expect(receipt.result).toMatchObject({
        transferredCollectionFactIds: [],
        lodgingReversalFactIds: [],
        transferIds: [],
        transferredAmount: { currency: "CNY", minorUnits: 0 },
        remainingPaymentAmount: { currency: "CNY", minorUnits: 162_000 }
      });
      expect(await db.selectFrom("stay_collection_membership_transfers")
        .select("id")
        .where("order_id", "=", stay.orderId)
        .execute()).toEqual([]);
      expect(await db.selectFrom("collection_facts")
        .select(["fact_type", "amount_minor", "net_effect_minor"])
        .where("order_id", "=", stay.orderId)
        .orderBy("created_at")
        .execute()).toEqual([
        { fact_type: "COLLECTION", amount_minor: 59_000, net_effect_minor: 59_000 },
        { fact_type: "REFUND", amount_minor: 59_000, net_effect_minor: -59_000 }
      ]);
      expect(await db.selectFrom("membership_payment_facts")
        .select(["amount_minor", "source_type", "transaction_reference"])
        .where("membership_order_id", "=", receipt.result!.membershipOrderId as string)
        .execute()).toEqual([{
        amount_minor: 162_000,
        source_type: "DIRECT_WECOM",
        transaction_reference: "WX-STAGE86-NET-ZERO-REFUND-MEMBER"
      }]);
    });

    it("keeps the upgrade entry open after a refunded WeCom collection is followed by new valid collections", async () => {
      const memberId = await createMember("STAGE86-NET-RECOLLECT-ID", "net-recollect");
      const stay = await createCheckedOutStay({
        prefix: "net-recollect",
        documentNumber: "STAGE86-NET-RECOLLECT-ID",
        skipCheckOut: true,
        collectionAmountMinor: 3_300,
        transactionReference: "WX-STAGE86-NET-RECOLLECT-A"
      });
      await execute({
        commandType: "RECORD_REFUND",
        input: {
          propertyId: demo.propertyId,
          orderId: stay.orderId,
          referencesFactId: stay.collectionFactId,
          amountMinor: 3_300,
          method: "WECOM",
          note: "第一笔企微住宿收款全额退回"
        }
      }, "net-recollect-refund-a");
      const second = await execute({
        commandType: "RECORD_COLLECTION",
        input: {
          propertyId: demo.propertyId,
          orderId: stay.orderId,
          amountMinor: 3_300,
          method: "WECOM",
          transactionReference: "WX-STAGE86-NET-RECOLLECT-B",
          note: "退款后重新收到企微住宿收款"
        }
      }, "net-recollect-collection-b");
      const third = await execute({
        commandType: "RECORD_COLLECTION",
        input: {
          propertyId: demo.propertyId,
          orderId: stay.orderId,
          amountMinor: 30_000,
          method: "WECOM",
          transactionReference: "WX-STAGE86-NET-RECOLLECT-C",
          note: "后续追加的企微住宿收款"
        }
      }, "net-recollect-collection-c");

      const view = await getOrderView(db, stay.orderId);
      expect(view.allowedActions.find((action) => action.code === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"))
        .toMatchObject({ enabled: true, disabledReason: null });
      const envelope = conversionEnvelope({
        orderId: stay.orderId,
        memberId,
        collectionFactId: second.result!.factId as string,
        collectionFactIds: [second.result!.factId as string, third.result!.factId as string],
        remainingPaymentTransactionReference: "WX-STAGE86-NET-RECOLLECT-MEMBER"
      });
      const prepared = await withPropertyClockForTesting(new Date("2026-09-02T12:00:00.000Z"), () =>
        preview(envelope, "net-recollect-conversion")
      );
      expect(prepared.preview.effect).toMatchObject({
        transfer: {
          total: { currency: "CNY", minorUnits: 33_300 },
          collections: [
            { factId: second.result!.factId, amount: { currency: "CNY", minorUnits: 3_300 } },
            { factId: third.result!.factId, amount: { currency: "CNY", minorUnits: 30_000 } }
          ]
        },
        remainingPayment: {
          amount: { currency: "CNY", minorUnits: 128_700 },
          transactionReference: "WX-STAGE86-NET-RECOLLECT-MEMBER"
        }
      });
      const receipt = await withPropertyClockForTesting(new Date("2026-09-02T12:00:00.000Z"), () =>
        confirmPrepared(envelope, prepared, "net-recollect-conversion")
      );
      expect(receipt.businessCommitted, JSON.stringify(receipt.error)).toBe(true);
      expect(receipt.result).toMatchObject({
        transferredCollectionFactIds: [second.result!.factId, third.result!.factId],
        transferredAmount: { currency: "CNY", minorUnits: 33_300 },
        remainingPaymentAmount: { currency: "CNY", minorUnits: 128_700 }
      });
      const lodgingFacts = await db.selectFrom("collection_facts")
        .select(["fact_type", "amount_minor", "net_effect_minor", "reverses_fact_id"])
        .where("order_id", "=", stay.orderId)
        .orderBy("created_at")
        .execute();
      expect(lodgingFacts).toEqual([
        expect.objectContaining({ fact_type: "COLLECTION", amount_minor: 3_300, net_effect_minor: 3_300, reverses_fact_id: null }),
        expect.objectContaining({ fact_type: "REFUND", amount_minor: 3_300, net_effect_minor: -3_300, reverses_fact_id: null }),
        expect.objectContaining({ fact_type: "COLLECTION", amount_minor: 3_300, net_effect_minor: 3_300, reverses_fact_id: null }),
        expect.objectContaining({ fact_type: "COLLECTION", amount_minor: 30_000, net_effect_minor: 30_000, reverses_fact_id: null }),
        expect.objectContaining({ fact_type: "REVERSAL", amount_minor: 3_300, net_effect_minor: -3_300, reverses_fact_id: second.result!.factId }),
        expect.objectContaining({ fact_type: "REVERSAL", amount_minor: 30_000, net_effect_minor: -30_000, reverses_fact_id: third.result!.factId })
      ]);
      const lodgingNet = await db.selectFrom("collection_facts")
        .select(sql<number>`coalesce(sum(net_effect_minor), 0)::integer`.as("net"))
        .where("order_id", "=", stay.orderId)
        .executeTakeFirstOrThrow();
      expect(lodgingNet.net).toBe(0);
    });

    it.each(["reversal", "mixed"] as const)(
      "does not treat net-zero in-house %s funds as a zero-transfer conversion",
      async (variant) => {
        const memberId = await createMember(`STAGE86-NET-ZERO-${variant}`, `net-zero-${variant}`);
        const stay = await createCheckedOutStay({
          prefix: `net-zero-${variant}`,
          documentNumber: `STAGE86-NET-ZERO-${variant}`,
          skipCheckOut: true,
          transactionReference: `WX-STAGE86-NET-ZERO-${variant}`
        });
        if (variant === "reversal") {
          await execute({
            commandType: "REVERSE_FACT",
            input: {
              propertyId: demo.propertyId,
              orderId: stay.orderId,
              reversesFactId: stay.collectionFactId,
              note: "净零冲销资金不得升级会员"
            }
          }, "net-zero-reversal");
        }
        if (variant === "mixed") {
          await execute({
            commandType: "RECORD_REFUND",
            input: {
              propertyId: demo.propertyId,
              orderId: stay.orderId,
              referencesFactId: stay.collectionFactId,
              amountMinor: 59_000,
              method: "WECOM",
              note: "企微收款已全额退回，但订单还存在混合资金历史"
            }
          }, "net-zero-mixed-wecom-refund");
          const cash = await execute({
            commandType: "RECORD_COLLECTION",
            input: {
              propertyId: demo.propertyId,
              orderId: stay.orderId,
              amountMinor: 1_000,
              method: "CASH",
              cashCollector: "Stage 86 cashier",
              note: "混合资金"
            }
          }, "net-zero-mixed-cash");
          await execute({
            commandType: "RECORD_REFUND",
            input: {
              propertyId: demo.propertyId,
              orderId: stay.orderId,
              referencesFactId: cash.result!.factId as string,
              amountMinor: 1_000,
              method: "CASH",
              cashCollector: "Stage 86 cashier",
              note: "混合资金退款"
            }
          }, "net-zero-mixed-cash-refund");
        }
        const net = await db.selectFrom("collection_facts")
          .select(sql<number>`coalesce(sum(net_effect_minor), 0)::integer`.as("net"))
          .where("order_id", "=", stay.orderId)
          .executeTakeFirstOrThrow();
        expect(net.net).toBe(0);
        const before = await conversionRollbackSnapshot(stay.orderId, memberId);
        await expect(withPropertyClockForTesting(new Date("2026-09-02T12:00:00.000Z"), () => preview(conversionEnvelope({
          orderId: stay.orderId,
          memberId,
          collectionFactId: "",
          collectionFactIds: [],
          remainingPaymentTransactionReference: `WX-STAGE86-NET-ZERO-${variant}-MEMBER`
        }), `net-zero-${variant}-conversion`))).rejects.toMatchObject({
          code: "VALIDATION_ERROR"
        });
        expect(await conversionRollbackSnapshot(stay.orderId, memberId)).toEqual(before);
      }
    );

    it("adds entitlement only for new extension nights without rewriting converted coverage history", async () => {
      const converted = await createInHouseConversion({ prefix: "inhouse-extend" });
      expect(await conversionEntitlementBalance(converted.entitlementLotId)).toBe(23);
      const originalDates = serviceDates(stayDates.arrival, stayDates.departure);
      expect(await db.selectFrom("coverage_items")
        .select(["service_date", "status"])
        .where("order_id", "=", converted.stay.orderId)
        .orderBy("service_date")
        .execute()).toEqual(originalDates
        .map((service_date) => ({ service_date, status: "CONSUMED" })));
      const originalCoverage = await db.selectFrom("coverage_items")
        .selectAll()
        .where("order_id", "=", converted.stay.orderId)
        .where("service_date", "in", originalDates)
        .orderBy("service_date")
        .orderBy("id")
        .execute();
      const originalLedger = await db.selectFrom("entitlement_ledger")
        .selectAll()
        .where("order_id", "=", converted.stay.orderId)
        .where("service_date", "in", originalDates)
        .orderBy("service_date")
        .orderBy("fact_id")
        .execute();

      const extension = await withPropertyClockForTesting(new Date("2026-09-02T12:00:00.000Z"), () => execute({
        commandType: "EXTEND_STAY",
        input: {
          propertyId: demo.propertyId,
          orderId: converted.stay.orderId,
          newDepartureDate: "2026-09-09"
        }
      }, "inhouse-extend-one-night"));
      expect(extension.businessCommitted).toBe(true);
      expect(await conversionEntitlementBalance(converted.entitlementLotId)).toBe(22);
      expect(await db.selectFrom("coverage_items")
        .selectAll()
        .where("order_id", "=", converted.stay.orderId)
        .where("service_date", "in", originalDates)
        .orderBy("service_date")
        .orderBy("id")
        .execute()).toEqual(originalCoverage);
      expect(await db.selectFrom("entitlement_ledger")
        .selectAll()
        .where("order_id", "=", converted.stay.orderId)
        .where("service_date", "in", originalDates)
        .orderBy("service_date")
        .orderBy("fact_id")
        .execute()).toEqual(originalLedger);
      const extendedOrder = await db.selectFrom("orders")
        .select("current_revision_id")
        .where("id", "=", converted.stay.orderId)
        .executeTakeFirstOrThrow();
      await expect(db.insertInto("coverage_items").values({
        ...originalCoverage[0]!,
        id: "coverage_extend_pre_validity_guard",
        held_by_revision_id: extendedOrder.current_revision_id!,
        service_date: stayDates.arrival,
        status: "HELD",
        created_at: new Date(),
        updated_at: new Date()
      }).execute()).rejects.toMatchObject({
        code: "23514",
        constraint: "coverage_items_entitlement_valid"
      });

      const extensionLedger = await db.selectFrom("entitlement_ledger")
        .select(["entry_type", "quantity_delta", "service_date", "reason"])
        .where("order_id", "=", converted.stay.orderId)
        .orderBy("service_date")
        .execute();
      expect(extensionLedger.filter((item) => item.entry_type === "CONVERSION_CONSUME")).toHaveLength(7);
      expect(extensionLedger).toEqual(expect.arrayContaining([
        expect.objectContaining({
          entry_type: "HOLD",
          quantity_delta: -1,
          service_date: "2026-09-08",
          reason: "ORDER_COVERAGE_HOLD"
        }),
        expect.objectContaining({
          entry_type: "CONSUME",
          quantity_delta: 0,
          service_date: "2026-09-08",
          reason: "EXTEND_STAY_ENTITLEMENT_CONSUMED"
        })
      ]));
      await assertConversionCommandStillValid(converted.receipt.commandId);
      await assertCorruptConversionRevisionRejected(converted.receipt.commandId);

      await expect(withPropertyClockForTesting(new Date("2026-09-02T12:00:00.000Z"), () => preview({
        commandType: "EXTEND_STAY",
        input: {
          propertyId: demo.propertyId,
          orderId: converted.stay.orderId,
          newDepartureDate: "2026-10-02"
        }
      }, "inhouse-extend-insufficient"))).rejects.toMatchObject({
        code: "ENTITLEMENT_CONFLICT"
      });
      expect(await conversionEntitlementBalance(converted.entitlementLotId)).toBe(22);
    });

    it("returns only future converted nights when an in-house stay is shortened", async () => {
      const businessDate = await propertyLocalToday(db, demo.propertyId);
      const arrivalDate = shiftDate(businessDate, -1);
      const departureDate = shiftDate(businessDate, 6);
      const newDepartureDate = shiftDate(businessDate, 3);
      const restoredFutureDates = serviceDates(newDepartureDate, departureDate);
      const converted = await createInHouseConversion({
        prefix: "inhouse-shorten",
        businessDate,
        arrivalDate,
        departureDate
      });
      expect(await conversionEntitlementBalance(converted.entitlementLotId)).toBe(23);

      const receipt = await withPropertyClockForTesting(new Date(`${businessDate}T12:00:00.000Z`), () => execute({
        commandType: "SHORTEN_STAY",
        input: {
          propertyId: demo.propertyId,
          orderId: converted.stay.orderId,
          newDepartureDate
        }
      }, "inhouse-shorten-future-nights"));
      expect(receipt.businessCommitted).toBe(true);
      expect(await conversionEntitlementBalance(converted.entitlementLotId)).toBe(26);

      const restoredDates = await db.selectFrom("entitlement_ledger")
        .select("service_date")
        .where("order_id", "=", converted.stay.orderId)
        .where("quantity_delta", "=", 1)
        .orderBy("service_date")
        .execute();
      expect(restoredDates.map((item) => item.service_date)).toEqual(restoredFutureDates);
      const releasedCoverage = await db.selectFrom("coverage_items")
        .select(["id", "service_date", "status"])
        .where("order_id", "=", converted.stay.orderId)
        .where("service_date", "in", restoredFutureDates)
        .orderBy("service_date")
        .execute();
      expect(releasedCoverage).toEqual(restoredFutureDates.map((service_date) =>
        expect.objectContaining({ service_date, status: "RELEASED" })
      ));
      const order = await db.selectFrom("orders")
        .select(["status", "departure_date"])
        .where("id", "=", converted.stay.orderId)
        .executeTakeFirstOrThrow();
      expect(order).toEqual({ status: "CHECKED_IN", departure_date: newDepartureDate });
      await assertConversionCommandStillValid(converted.receipt.commandId);

      await withPropertyClockForTesting(new Date(`${businessDate}T12:00:00.000Z`), () => execute({
        commandType: "EXTEND_STAY",
        input: {
          propertyId: demo.propertyId,
          orderId: converted.stay.orderId,
          newDepartureDate: shiftDate(newDepartureDate, 1)
        }
      }, "inhouse-shorten-then-extend"));
      expect(await conversionEntitlementBalance(converted.entitlementLotId)).toBe(25);
      await assertConversionCommandStillValid(converted.receipt.commandId);
      const reusedDateCoverage = await db.selectFrom("coverage_items")
        .select(["id", "status"])
        .where("order_id", "=", converted.stay.orderId)
        .where("service_date", "=", newDepartureDate)
        .orderBy("id")
        .execute();
      expect(reusedDateCoverage).toHaveLength(2);
      expect(reusedDateCoverage.find((item) => item.id === releasedCoverage[0]!.id)).toMatchObject({ status: "RELEASED" });
      expect(reusedDateCoverage.find((item) => item.id !== releasedCoverage[0]!.id)).toMatchObject({ status: "CONSUMED" });
    });

    it("keeps the conversion snapshot valid after an entitlement-backed early checkout", async () => {
      const businessDate = await propertyLocalToday(db, demo.propertyId);
      const arrivalDate = shiftDate(businessDate, -2);
      const departureDate = shiftDate(businessDate, 5);
      const converted = await createInHouseConversion({
        prefix: "inhouse-early-checkout",
        businessDate,
        arrivalDate,
        departureDate
      });

      const receipt = await withPropertyClockForTesting(new Date(`${businessDate}T12:00:00.000Z`), () => execute({
        commandType: "SHORTEN_STAY",
        input: {
          propertyId: demo.propertyId,
          orderId: converted.stay.orderId,
          newDepartureDate: businessDate
        }
      }, "inhouse-early-checkout"));
      expect(receipt.businessCommitted).toBe(true);
      expect(receipt.result).toMatchObject({
        completionMode: "EARLY_CHECK_OUT",
        departureDate: businessDate
      });
      expect(await db.selectFrom("orders")
        .innerJoin("stays", "stays.order_id", "orders.id")
        .select(["orders.status as orderStatus", "stays.status as stayStatus"])
        .where("orders.id", "=", converted.stay.orderId)
        .executeTakeFirstOrThrow()).toEqual({
        orderStatus: "CHECKED_OUT",
        stayStatus: "COMPLETED"
      });
      expect(await db.selectFrom("amendments")
        .select("amendment_type")
        .where("command_id", "=", receipt.commandId)
        .orderBy("sequence")
        .execute()).toEqual([
        { amendment_type: "SHORTEN_STAY" },
        { amendment_type: "CHECK_OUT" }
      ]);
      await assertConversionCommandStillValid(converted.receipt.commandId);
    });

    it("keeps converted entitlement quantity stable for an applicable move and fails closed for an incompatible room type", async () => {
      const converted = await createInHouseConversion({ prefix: "inhouse-move" });
      const balanceBeforeMove = await conversionEntitlementBalance(converted.entitlementLotId);
      expect(balanceBeforeMove).toBe(23);

      const move = await withPropertyClockForTesting(new Date("2026-09-02T12:00:00.000Z"), () => execute({
        commandType: "MOVE_UNIT",
        input: {
          propertyId: demo.propertyId,
          orderId: converted.stay.orderId,
          newInventoryUnitId: "unit_room_d_gen_04",
          effectiveDate: "2026-09-03"
        }
      }, "inhouse-move-compatible"));
      expect(move.businessCommitted).toBe(true);
      expect(await conversionEntitlementBalance(converted.entitlementLotId)).toBe(balanceBeforeMove);
      expect(await db.selectFrom("coverage_items")
        .select(["service_date", "inventory_unit_id", "status"])
        .where("order_id", "=", converted.stay.orderId)
        .orderBy("service_date")
        .execute()).toEqual(serviceDates(stayDates.arrival, stayDates.departure).map((service_date) => ({
        service_date,
        inventory_unit_id: "unit_room_d_gen_01",
        status: "CONSUMED"
      })));
      expect(await db.selectFrom("inventory_claims as claim")
        .innerJoin("stay_segments as segment", "segment.id", "claim.source_id")
        .select(["claim.service_date", "claim.inventory_unit_id"])
        .where("claim.source_type", "=", "ORDER_SEGMENT")
        .where("claim.active", "=", true)
        .where("segment.stay_id", "=", converted.stay.stayId)
        .orderBy("claim.service_date")
        .execute()).toEqual(serviceDates(stayDates.arrival, stayDates.departure).map((service_date) => ({
        service_date,
        inventory_unit_id: service_date < "2026-09-03" ? "unit_room_d_gen_01" : "unit_room_d_gen_04"
      })));
      await assertConversionCommandStillValid(converted.receipt.commandId);

      await expect(withPropertyClockForTesting(new Date("2026-09-02T12:00:00.000Z"), () => preview({
        commandType: "MOVE_UNIT",
        input: {
          propertyId: demo.propertyId,
          orderId: converted.stay.orderId,
          newInventoryUnitId: "unit_room_e_gen_01",
          effectiveDate: "2026-09-03"
        }
      }, "inhouse-move-incompatible"))).rejects.toMatchObject({
        code: "ENTITLEMENT_CONFLICT"
      });
      expect(await conversionEntitlementBalance(converted.entitlementLotId)).toBe(balanceBeforeMove);
    });

    it("fails closed for ordinary reprice, check-in revocation, and coverage refresh after conversion", async () => {
      const converted = await createInHouseConversion({
        prefix: "inhouse-closed-actions",
        businessDate: "2026-09-01"
      });
      const baseInput = { propertyId: demo.propertyId, orderId: converted.stay.orderId };

      await expect(withPropertyClockForTesting(new Date("2026-09-01T12:00:00.000Z"), () => preview({
        commandType: "REPRICE_ORDER",
        input: { ...baseInput, targetCurrentContractAmountMinor: 1_000 }
      }, "inhouse-converted-reprice"))).rejects.toMatchObject({ code: "INVALID_ORDER_STATE" });
      await expect(withPropertyClockForTesting(new Date("2026-09-01T12:00:00.000Z"), () => preview({
        commandType: "REVOKE_CHECK_IN",
        input: { ...baseInput, unusedRoomConfirmed: true }
      }, "inhouse-converted-revoke"))).rejects.toMatchObject({ code: "INVALID_ORDER_STATE" });
      await expect(withPropertyClockForTesting(new Date("2026-09-01T12:00:00.000Z"), () => preview({
        commandType: "REFRESH_MEMBER_COVERAGE",
        input: baseInput
      }, "inhouse-converted-refresh"))).rejects.toMatchObject({ code: "INVALID_ORDER_STATE" });
      expect(await conversionEntitlementBalance(converted.entitlementLotId)).toBe(23);
    });

    it("allows one of two concurrent in-house conversion previews and idempotently replays only its receipt", async () => {
      const memberId = await createMember("STAGE86-CONCURRENT-INHOUSE-ID", "concurrent-inhouse");
      const stay = await createCheckedOutStay({
        prefix: "concurrent-inhouse",
        documentNumber: "STAGE86-CONCURRENT-INHOUSE-ID",
        skipCheckOut: true,
        transactionReference: "WX-STAGE86-CONCURRENT-INHOUSE-SOURCE"
      });
      const envelope = conversionEnvelope({
        orderId: stay.orderId,
        memberId,
        collectionFactId: stay.collectionFactId,
        remainingPaymentTransactionReference: "WX-STAGE86-CONCURRENT-INHOUSE-REMAINING"
      });
      const [first, second] = await withPropertyClockForTesting(new Date("2026-09-02T12:00:00.000Z"), async () => [
        await preview(envelope, "concurrent-inhouse-a"),
        await preview(envelope, "concurrent-inhouse-b")
      ]);
      const candidates = [
        {
          prepared: first,
          metadata: { idempotencyKey: "stage86-concurrent-inhouse-confirm-a", correlationId: "stage86-concurrent-inhouse-confirm-a" },
          reason: { code: "STAGE47_ACCEPTANCE", note: "8.6 concurrent conversion A" }
        },
        {
          prepared: second,
          metadata: { idempotencyKey: "stage86-concurrent-inhouse-confirm-b", correlationId: "stage86-concurrent-inhouse-confirm-b" },
          reason: { code: "STAGE47_ACCEPTANCE", note: "8.6 concurrent conversion B" }
        }
      ] as const;
      const receipts = await withPropertyClockForTesting(new Date("2026-09-02T12:00:00.000Z"), () => Promise.all(candidates.map((candidate) =>
        confirmCommandPreview(db, principal, candidate.prepared.preview.previewId, {
          propertyId: demo.propertyId,
          commandType: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
          confirmation: true,
          expectedEffectHash: candidate.prepared.preview.effectHash,
          reason: candidate.reason
        }, candidate.metadata)
      )));
      expect(receipts.filter((receipt) => receipt.businessCommitted)).toHaveLength(1);
      expect(receipts.filter((receipt) => !receipt.businessCommitted)).toEqual([
        expect.objectContaining({
          executionStatus: "NOT_EXECUTED",
          error: expect.objectContaining({ code: "PREVIEW_STALE" })
        })
      ]);
      const winnerIndex = receipts.findIndex((receipt) => receipt.businessCommitted);
      const winner = candidates[winnerIndex]!;
      const replay = await withPropertyClockForTesting(new Date("2026-09-02T12:00:00.000Z"), () => confirmCommandPreview(
        db,
        principal,
        winner.prepared.preview.previewId,
        {
          propertyId: demo.propertyId,
          commandType: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
          confirmation: true,
          expectedEffectHash: winner.prepared.preview.effectHash,
          reason: winner.reason
        },
        winner.metadata
      ));
      expect(replay.receiptId).toBe(receipts[winnerIndex]!.receiptId);
      expect(await db.selectFrom("stay_collection_membership_transfers")
        .select("id")
        .where("order_id", "=", stay.orderId)
        .execute()).toHaveLength(1);
      expect(await db.selectFrom("membership_orders")
        .select("id")
        .where("created_by_command_id", "=", receipts[winnerIndex]!.commandId)
        .execute()).toHaveLength(1);
      expect(await db.selectFrom("coverage_items")
        .select("id")
        .where("order_id", "=", stay.orderId)
        .where("status", "=", "CONSUMED")
        .execute()).toHaveLength(7);
      expect(await db.selectFrom("entitlement_ledger")
        .select("fact_id")
        .where("order_id", "=", stay.orderId)
        .where("entry_type", "=", "CONVERSION_CONSUME")
        .execute()).toHaveLength(7);
    });

    it.each([
      {
        artifact: "Receipt",
        tableName: "command_receipts",
        functionName: "fail_stage86_conversion_receipt",
        triggerName: "fail_stage86_conversion_receipt_at_commit",
        failureMessage: "forced stage86 conversion receipt failure"
      },
      {
        artifact: "audit",
        tableName: "audit_entries",
        functionName: "fail_stage86_conversion_audit",
        triggerName: "fail_stage86_conversion_audit_at_commit",
        failureMessage: "forced stage86 conversion audit failure"
      }
    ] as const)("rolls back every in-house conversion artifact when $artifact persistence fails", async ({
      tableName,
      functionName,
      triggerName,
      failureMessage
    }) => {
      const memberId = await createMember(`STAGE86-ROLLBACK-${functionName}`, `rollback-${functionName}`);
      const stay = await createCheckedOutStay({
        prefix: `rollback-${functionName}`,
        documentNumber: `STAGE86-ROLLBACK-${functionName}`,
        skipCheckOut: true,
        transactionReference: `WX-STAGE86-ROLLBACK-${functionName}`
      });
      const envelope = conversionEnvelope({
        orderId: stay.orderId,
        memberId,
        collectionFactId: stay.collectionFactId,
        remainingPaymentTransactionReference: `WX-STAGE86-ROLLBACK-REMAINING-${functionName}`
      });
      const prepared = await withPropertyClockForTesting(new Date("2026-09-02T12:00:00.000Z"), () =>
        preview(envelope, `rollback-${functionName}`)
      );
      const before = await conversionRollbackSnapshot(stay.orderId, memberId);
      const confirmationMetadata = metadata(`rollback-${functionName}-confirm`);
      const confirmation = {
        propertyId: demo.propertyId,
        commandType: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP" as const,
        confirmation: true as const,
        expectedEffectHash: prepared.preview.effectHash,
        reason: { code: "STAGE47_ACCEPTANCE", note: "8.6 conversion persistence rollback" }
      };

      try {
        await sql.raw(`
          CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION '${failureMessage}'; END $$;
          CREATE CONSTRAINT TRIGGER ${triggerName} AFTER INSERT ON ${tableName}
          DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW EXECUTE FUNCTION ${functionName}();
        `).execute(db);

        await expect(withPropertyClockForTesting(new Date("2026-09-02T12:00:00.000Z"), () => confirmCommandPreview(
          db,
          principal,
          prepared.preview.previewId,
          confirmation,
          confirmationMetadata
        ))).rejects.toThrow(failureMessage);
      } finally {
        await sql.raw(`
          DROP TRIGGER IF EXISTS ${triggerName} ON ${tableName};
          DROP FUNCTION IF EXISTS ${functionName}();
        `).execute(db);
      }

      expect(await conversionRollbackSnapshot(stay.orderId, memberId)).toEqual(before);
      expect(await db.selectFrom("command_executions")
        .select("id")
        .where("idempotency_key", "=", confirmationMetadata.idempotencyKey)
        .execute()).toEqual([]);
      expect(await db.selectFrom("audit_entries")
        .select("id")
        .where("correlation_id", "=", confirmationMetadata.correlationId)
        .execute()).toEqual([]);
      expect(await db.selectFrom("command_previews")
        .select(["status", "used_at"])
        .where("id", "=", prepared.preview.previewId)
        .executeTakeFirstOrThrow()).toEqual({ status: "OPEN", used_at: null });
    });
  });
});

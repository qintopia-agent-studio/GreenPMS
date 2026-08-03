import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthPrincipal, CommandEnvelope, ReceiptDto } from "@qintopia/contracts";
import {
  confirmCommandPreview,
  createCommandPreview,
  getOrderView,
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
      identityCardNumber,
      phone: "13800000002",
      wechat: `stage47-${prefix}`
    }
  }, `${prefix}-member`);
  return receipt.result!.memberId as string;
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
  unitId?: string;
  bookingChannelCode?: "WECOM" | "MEITUAN";
  skipCollection?: boolean;
  collectionAmountMinor?: number;
  transactionReference?: string;
}) {
  const unitId = options.unitId ?? "unit_room_d_gen_01";
  const quote = await createQuoteForTesting(db, {
    propertyId: demo.propertyId,
    inventoryUnitId: unitId,
    stayType: "CUSTOM",
    arrivalDate: stayDates.arrival,
    departureDate: stayDates.departure,
    pricingPolicyVersionId: demo.publicPricingPolicyId
  });
  const order = await execute({
    commandType: "CREATE_ORDER",
    input: {
      propertyId: demo.propertyId,
      quoteId: quote.quoteId,
      primaryGuest: {
        fullName: `Stage 47 Guest ${options.prefix}`,
        nickname: `Stage47 ${options.prefix}`,
        documentNumber: options.documentNumber
      },
      bookingChannelCode: options.bookingChannelCode ?? "WECOM",
      channelOrderReference: options.bookingChannelCode && options.bookingChannelCode !== "WECOM"
        ? `STAGE47-${options.prefix.toUpperCase()}-CHANNEL`
        : null,
      targetCurrentContractAmountMinor: quote.currentContractAmount.minorUnits
    }
  }, `${options.prefix}-order`);
  const orderId = order.result!.orderId as string;
  await withPropertyClockForTesting(new Date(`${stayDates.arrival}T12:00:00.000Z`), () => execute({
    commandType: "CHECK_IN",
    input: { propertyId: demo.propertyId, orderId }
  }, `${options.prefix}-checkin`));
  await withPropertyClockForTesting(new Date(`${stayDates.departure}T12:00:00.000Z`), () => execute({
    commandType: "CHECK_OUT",
    input: { propertyId: demo.propertyId, orderId }
  }, `${options.prefix}-checkout`));

  const collectionAmountMinor = options.collectionAmountMinor ?? 59_000;
  if (options.skipCollection) {
    return {
      orderId,
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
    const untransferredCollection = await execute({
      commandType: "RECORD_COLLECTION",
      input: {
        propertyId: demo.propertyId,
        orderId: stay.orderId,
        amountMinor: 100,
        method: "WECOM",
        transactionReference: "WX-STAGE47-REVERSAL-BRIDGE-REFUNDED",
        note: "用于验证转换命令不能夹带未转入收款的额外冲销"
      }
    }, "reversal-bridge-extra-collection");
    const untransferredCollectionFactId = untransferredCollection.result!.factId as string;
    const refund = await execute({
      commandType: "RECORD_REFUND",
      input: {
        propertyId: demo.propertyId,
        orderId: stay.orderId,
        referencesFactId: untransferredCollectionFactId,
        amountMinor: 100,
        method: "WECOM",
        note: "先全额退款，使额外收退款净影响为零"
      }
    }, "reversal-bridge-extra-refund");
    const refundFactId = refund.result!.factId as string;
    const envelope = conversionEnvelope({
      orderId: stay.orderId,
      memberId,
      collectionFactId: stay.collectionFactId,
      remainingPaymentTransactionReference: "WX-STAGE47-REVERSAL-BRIDGE-REMAINING"
    });
    const prepared = await preview(envelope, "reversal-bridge-conversion");
    const receipt = await confirmPrepared(envelope, prepared, "reversal-bridge-conversion");
    expect(receipt.businessCommitted).toBe(true);

    const order = await db.selectFrom("orders")
      .select("current_revision_id")
      .where("id", "=", stay.orderId)
      .executeTakeFirstOrThrow();
    const factsBefore = await db.selectFrom("collection_facts")
      .select(sql<number>`count(*)::integer`.as("count"))
      .where("order_id", "=", stay.orderId)
      .executeTakeFirstOrThrow();
    const corruptFactIds = [
      "fact_stage47_unbridged_refund_reversal",
      "fact_stage47_unbridged_collection_reversal"
    ] as const;

    const corruptWrite = db.transaction().execute(async (trx) => {
      await trx.insertInto("collection_facts").values({
        fact_id: corruptFactIds[0],
        order_id: stay.orderId,
        fact_type: "REVERSAL",
        amount_minor: 100,
        net_effect_minor: 100,
        currency: "CNY",
        references_fact_id: null,
        reverses_fact_id: refundFactId,
        method: "REVERSAL",
        note: "损坏形状：夹带未桥接的退款冲销",
        transaction_reference: null,
        pricing_revision_id: order.current_revision_id,
        command_id: receipt.commandId
      }).execute();
      await trx.insertInto("collection_facts").values({
        fact_id: corruptFactIds[1],
        order_id: stay.orderId,
        fact_type: "REVERSAL",
        amount_minor: 100,
        net_effect_minor: -100,
        currency: "CNY",
        references_fact_id: null,
        reverses_fact_id: untransferredCollectionFactId,
        method: "REVERSAL",
        note: "损坏形状：夹带未转入住宿收款的额外冲销",
        transaction_reference: null,
        pricing_revision_id: order.current_revision_id,
        command_id: receipt.commandId
      }).execute();
    });
    await expect(corruptWrite).rejects.toMatchObject({
      constraint: "stage13_conversion_reversal_bridge_exact"
    });
    expect(await db.selectFrom("collection_facts")
      .select("fact_id")
      .where("fact_id", "in", corruptFactIds)
      .execute()).toHaveLength(0);
    expect(await db.selectFrom("collection_facts")
      .select(sql<number>`count(*)::integer`.as("count"))
      .where("order_id", "=", stay.orderId)
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
      constraint: "stage13_conversion_command_fact_exclusivity"
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
      constraint: "stage13_conversion_command_fact_exclusivity"
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
          constraint: "stage13_conversion_execution_state"
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
      message: expect.stringContaining("身份证号必须与主要住宿人一致")
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
      message: expect.stringContaining("必须一次转入当前全部已记录净收款")
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
      message: expect.stringContaining("不能沿用原住宿收款交易单号")
    });
    expect(await db.selectFrom("stay_collection_membership_transfers").select("id").execute()).toHaveLength(0);
  });

  it("does not allow refunded lodging collections to be transferred", async () => {
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
        note: "登记过退款后不能再转会员"
      }
    }, "refunded-source-refund");

    await expect(preview(conversionEnvelope({
      orderId: stay.orderId,
      memberId,
      collectionFactId: stay.collectionFactId,
      remainingPaymentTransactionReference: "WX-STAGE47-REFUNDED-REMAINING"
    }), "refunded-source-conversion")).rejects.toMatchObject({
      code: "REFUND_LIMIT_EXCEEDED",
      message: expect.stringContaining("已登记退款")
    });
    expect(await db.selectFrom("stay_collection_membership_transfers").select("id").execute()).toHaveLength(0);
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
      message: expect.stringContaining("必须一次转入当前全部已记录净收款")
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
});

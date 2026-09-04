import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthPrincipal, CommandEnvelope, ReceiptDto } from "@qintopia/contracts";
import {
  confirmCommandPreview,
  createDatabase,
  createCommandPreview,
  getMemberView,
  getOrderView,
  propertyLocalToday,
  withPropertyClockForTesting,
  type Database
} from "@qintopia/db";
import { parseLocalDate } from "@qintopia/domain";
import fastJsonStringify from "fast-json-stringify";
import { sql, type Kysely, type Transaction } from "kysely";
import pg from "pg";
import { MemberResponseSchema, OrderDetailResponseSchema } from "../../apps/api/src/schemas.ts";
import {
  applyMemberCorrectionCommand,
  type MemberCorrectionCommandType
} from "../../packages/db/src/commands/member-corrections.ts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { authScope } from "../helpers/auth-principals.ts";
import { resetDatabase } from "../helpers/database.ts";
import { runtimeDatabaseUrlForTesting } from "../helpers/runtime-database.ts";

const databaseUrl = process.env.ADMIN_MEMBERSHIP_CORRECTIONS_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_admin_membership_corrections";

const administrator: AuthPrincipal = {
  subjectId: demo.administratorSubjectId,
  credentialId: "token_demo_admin_write",
  credentialType: "TOKEN",
  displayName: "Demo Administrator",
  ...authScope({ profile: "administrator" })
};

const ordinaryStaff: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Demo Agent",
  ...authScope()
};

let db: Kysely<Database>;
let sequence = 0;

function metadata(prefix: string) {
  sequence += 1;
  return { idempotencyKey: `${prefix}-${sequence}`, correlationId: `${prefix}-${sequence}` };
}

function envelope(commandType: string, input: Record<string, unknown>): CommandEnvelope {
  return { commandType, input } as unknown as CommandEnvelope;
}

async function preview(
  command: CommandEnvelope,
  prefix: string,
  principal: AuthPrincipal = administrator
) {
  return createCommandPreview(db, principal, command, metadata(`${prefix}-preview`));
}

async function confirm(
  command: CommandEnvelope,
  prefix: string,
  principal: AuthPrincipal = administrator
): Promise<ReceiptDto> {
  const prepared = await preview(command, prefix, principal);
  return confirmCommandPreview(db, principal, prepared.preview.previewId, {
    propertyId: command.input.propertyId as string,
    commandType: command.commandType,
    confirmation: true,
    expectedEffectHash: prepared.preview.effectHash,
    reason: command.commandType === "CREATE_ORDER"
      ? { code: "CREATE_STANDARD_ORDER", note: "" }
      : { code: "DATA_ENTRY_CORRECTION", note: `管理员复核 ${prefix}` }
  }, metadata(`${prefix}-confirm`));
}

async function confirmWithDatabase(
  targetDb: Kysely<Database>,
  command: CommandEnvelope,
  prefix: string,
  principal: AuthPrincipal = administrator
): Promise<ReceiptDto> {
  const prepared = await createCommandPreview(targetDb, principal, command, metadata(`${prefix}-preview`));
  return confirmCommandPreview(targetDb, principal, prepared.preview.previewId, {
    propertyId: command.input.propertyId as string,
    commandType: command.commandType,
    confirmation: true,
    expectedEffectHash: prepared.preview.effectHash,
    reason: { code: "DATA_ENTRY_CORRECTION", note: `管理员复核 ${prefix}` }
  }, metadata(`${prefix}-confirm`));
}

async function createMember(prefix: string): Promise<string> {
  const receipt = await confirm({
    commandType: "CREATE_MEMBER",
    input: {
      propertyId: demo.propertyId,
      fullName: `历史会员 ${prefix}`,
      nickname: `历史 ${prefix}`,
      identityCardNumber: `HISTORY-${prefix.toUpperCase()}`,
      phone: `137${String(sequence + 1).padStart(8, "0")}`,
      wechat: `history-${prefix}`
    }
  }, `${prefix}-create-member`, ordinaryStaff);
  return receipt.result!.memberId as string;
}

function shiftLocalDate(value: string, days: number): string {
  const date = parseLocalDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function addCalendarYear(value: string): string {
  const date = parseLocalDate(value);
  const year = date.getUTCFullYear() + 1;
  const month = date.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay))).toISOString().slice(0, 10);
}

async function createCompletedWecomStay(options: {
  prefix: string;
  phone: string;
  documentNumber: string;
  contractAmountMinor?: number;
  collectionAmountMinor?: number;
  checkOut?: boolean;
  arrivalDate?: string;
  departureDate?: string;
}) {
  const arrivalDate = options.arrivalDate ?? "2026-09-01";
  const departureDate = options.departureDate ?? "2026-09-03";
  const contractAmountMinor = options.contractAmountMinor ?? 20_000;
  const collectionAmountMinor = options.collectionAmountMinor ?? 20_000;
  const quote = await createQuoteForTesting(db, {
    propertyId: demo.propertyId,
    inventoryUnitId: "unit_room_d_gen_01",
    stayType: "TRANSIENT",
    arrivalDate,
    departureDate,
    pricingPolicyVersionId: demo.publicPricingPolicyId
  });
  const orderReceipt = await withPropertyClockForTesting(new Date(`${arrivalDate}T12:00:00.000Z`), () => confirm({
    commandType: "CREATE_ORDER",
    input: {
      propertyId: demo.propertyId,
      quoteId: quote.quoteId,
      primaryGuest: {
        fullName: `历史住宿 ${options.prefix}`,
        nickname: options.prefix,
        phone: options.phone,
        documentNumber: options.documentNumber
      },
      bookingChannelCode: "WECOM",
      channelOrderReference: null,
      targetCurrentContractAmountMinor: contractAmountMinor,
      manualPriceAdjustmentReason: "Cathy historical stay agreed price"
    }
  }, `${options.prefix}-stay-order`, ordinaryStaff));
  if (!orderReceipt.businessCommitted || !orderReceipt.result) {
    throw new Error(`CREATE_ORDER failed: ${JSON.stringify(orderReceipt.error)}`);
  }
  const orderId = orderReceipt.result!.orderId as string;
  const stayId = orderReceipt.result!.stayId as string;
  await withPropertyClockForTesting(new Date(`${arrivalDate}T12:00:00.000Z`), () => confirm({
    commandType: "CHECK_IN",
    input: { propertyId: demo.propertyId, orderId }
  }, `${options.prefix}-check-in`, ordinaryStaff));
  if (options.checkOut !== false) {
    await withPropertyClockForTesting(new Date(`${departureDate}T12:00:00.000Z`), () => confirm({
      commandType: "CHECK_OUT",
      input: { propertyId: demo.propertyId, orderId }
    }, `${options.prefix}-check-out`, ordinaryStaff));
  }
  const collectionReceipt = await confirm({
    commandType: "RECORD_COLLECTION",
    input: {
      propertyId: demo.propertyId,
      orderId,
      amountMinor: collectionAmountMinor,
      method: "WECOM",
      transactionReference: `WECOM-${options.prefix.toUpperCase()}-STAY`,
      note: "历史住宿真实企微收款"
    }
  }, `${options.prefix}-stay-collection`, ordinaryStaff);
  return {
    orderId,
    stayId,
    collectionFactId: collectionReceipt.result!.factId as string,
    collectionAmountMinor,
    collectionTransactionReference: `WECOM-${options.prefix.toUpperCase()}-STAY`,
    contractAmountMinor,
    arrivalDate,
    departureDate
  };
}

async function createCompletedStandardConversion(prefix: string) {
  const memberId = await createMember(`${prefix}-member`);
  const member = await db.selectFrom("members").selectAll()
    .where("id", "=", memberId).executeTakeFirstOrThrow();
  const sourceStay = await createCompletedWecomStay({
    prefix: `${prefix}-source`,
    phone: member.phone,
    documentNumber: member.identity_card_number!
  });
  const receipt = await confirm(envelope("CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP", {
    propertyId: demo.propertyId,
    orderId: sourceStay.orderId,
    memberId,
    membershipProductId: "membership_product_shared_bath_single_v1",
    collectionFactIds: [sourceStay.collectionFactId],
    agreedPriceMinor: 93_600,
    priceAdjustmentReason: "历史住宿按真实成交价升级会员",
    remainingPaymentTransactionReference: `WECOM-${prefix.toUpperCase()}-REMAINING`
  }), `${prefix}-conversion`, ordinaryStaff);
  return {
    commandId: receipt.commandId,
    member,
    membershipOrderId: receipt.result!.membershipOrderId as string,
    contractId: receipt.result!.contractId as string,
    entitlementLotId: receipt.result!.entitlementLotId as string,
    sourceStay
  };
}

async function createInHouseStandardConversion(prefix: string, options: {
  businessDate?: string;
  arrivalDate?: string;
  departureDate?: string;
} = {}) {
  const memberId = await createMember(`${prefix}-member`);
  const member = await db.selectFrom("members").selectAll()
    .where("id", "=", memberId).executeTakeFirstOrThrow();
  const sourceStay = await createCompletedWecomStay({
    prefix: `${prefix}-source`,
    phone: member.phone,
    documentNumber: member.identity_card_number!,
    checkOut: false,
    ...(options.arrivalDate ? { arrivalDate: options.arrivalDate } : {}),
    ...(options.departureDate ? { departureDate: options.departureDate } : {})
  });
  const businessDate = options.businessDate ?? "2026-09-02";
  const receipt = await withPropertyClockForTesting(new Date(`${businessDate}T12:00:00+08:00`), () => confirm(
    envelope("CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP", {
      propertyId: demo.propertyId,
      orderId: sourceStay.orderId,
      memberId,
      membershipProductId: "membership_product_shared_bath_single_v1",
      collectionFactIds: [sourceStay.collectionFactId],
      agreedPriceMinor: 93_600,
      priceAdjustmentReason: "在住期间按真实成交价升级会员",
      remainingPaymentTransactionReference: `WECOM-${prefix.toUpperCase()}-REMAINING`
    }),
    `${prefix}-conversion`,
    ordinaryStaff
  ));
  return {
    commandId: receipt.commandId,
    member,
    membershipOrderId: receipt.result!.membershipOrderId as string,
    contractId: receipt.result!.contractId as string,
    entitlementLotId: receipt.result!.entitlementLotId as string,
    sourceStay
  };
}

async function createDemoMemberStay(prefix: string, checkIn = false) {
  const businessDate = await propertyLocalToday(db, demo.propertyId);
  const departureDate = shiftLocalDate(businessDate, 2);
  const quote = await createQuoteForTesting(db, {
    propertyId: demo.propertyId,
    inventoryUnitId: "unit_room_d_gen_01",
    stayType: "TRANSIENT",
    arrivalDate: businessDate,
    departureDate,
    pricingPolicyVersionId: demo.publicPricingPolicyId,
    memberContractId: demo.memberContractId
  });
  const created = await confirm(envelope("CREATE_ORDER", {
    propertyId: demo.propertyId,
    quoteId: quote.quoteId,
    primaryGuest: { fullName: `会员住宿 ${prefix}`, nickname: prefix }
  }), `${prefix}-create`, ordinaryStaff);
  const orderId = created.result!.orderId as string;
  if (checkIn) {
    await confirm(envelope("CHECK_IN", {
      propertyId: demo.propertyId,
      orderId
    }), `${prefix}-check-in`, ordinaryStaff);
  }
  return { businessDate, departureDate, orderId };
}

async function createOrdinaryShortenedMemberStay(prefix: string) {
  const businessDate = await propertyLocalToday(db, demo.propertyId);
  const arrivalDate = shiftLocalDate(businessDate, -1);
  const departureDate = shiftLocalDate(businessDate, 3);
  const shortenedDepartureDate = shiftLocalDate(businessDate, 1);
  const quote = await createQuoteForTesting(db, {
    propertyId: demo.propertyId,
    inventoryUnitId: "unit_room_d_gen_01",
    stayType: "TRANSIENT",
    arrivalDate,
    departureDate,
    pricingPolicyVersionId: demo.publicPricingPolicyId,
    memberContractId: demo.memberContractId
  });
  const created = await withPropertyClockForTesting(new Date(`${arrivalDate}T12:00:00+08:00`), () => confirm(envelope("CREATE_ORDER", {
    propertyId: demo.propertyId,
    quoteId: quote.quoteId,
    primaryGuest: { fullName: `普通会员缩短住宿 ${prefix}`, nickname: prefix }
  }), `${prefix}-create`, ordinaryStaff));
  const orderId = created.result!.orderId as string;
  await withPropertyClockForTesting(new Date(`${arrivalDate}T12:00:00+08:00`), () => confirm(envelope("CHECK_IN", {
    propertyId: demo.propertyId,
    orderId
  }), `${prefix}-check-in`, ordinaryStaff));
  const shorteningReceipt = await withPropertyClockForTesting(new Date(`${businessDate}T12:00:00+08:00`), () => confirm(envelope("SHORTEN_STAY", {
    propertyId: demo.propertyId,
    orderId,
    newDepartureDate: shortenedDepartureDate
  }), prefix, ordinaryStaff));
  return { businessDate, orderId, shortenedDepartureDate, shorteningReceipt };
}

type VoidReconversionSetup = {
  command: CommandEnvelope;
  oldMembershipOrderId: string;
  sourceStay: Awaited<ReturnType<typeof createCompletedWecomStay>>;
};

type DirectHistoricalBackfillGraph = {
  prefix: string;
  memberId: string;
  actualMembershipDate: string;
  businessDate: string;
  transactionReference: string;
};

async function applyFrozenMemberCorrectionEffect(options: {
  commandType: MemberCorrectionCommandType;
  effect: Record<string, unknown>;
  label: string;
  previewEffect?: Record<string, unknown>;
  previewEffectAfterApply?: Record<string, unknown>;
  basisVersions?: Record<string, unknown>;
  auditEffectHash?: string;
  afterGraph?: (trx: Transaction<Database>) => Promise<void>;
}) {
  sequence += 1;
  const commandId = `command-frozen-member-correction-${options.label}-${sequence}`;
  const correlationId = `frozen-member-correction-${options.label}-${sequence}`;
  const previewId = `preview-frozen-member-correction-${options.label}-${sequence}`;
  const effectHash = "e".repeat(64);
  return db.transaction().execute(async (trx) => {
    await trx.insertInto("command_executions").values({
      id: commandId,
      subject_id: administrator.subjectId,
      credential_id: administrator.credentialId,
      property_id: demo.propertyId,
      command_type: options.commandType,
      idempotency_key: correlationId,
      request_hash: "f".repeat(64),
      correlation_id: correlationId,
      state: "EXECUTING",
      completed_at: null
    }).execute();
    await trx.insertInto("command_previews").values({
      id: previewId,
      subject_id: administrator.subjectId,
      property_id: demo.propertyId,
      command_type: options.commandType,
      normalized_input: {},
      input_hash: "d".repeat(64),
      effect: options.previewEffect ?? options.effect,
      effect_hash: effectHash,
      basis_versions: options.basisVersions ?? {},
      expires_at: new Date(Date.now() + 10 * 60_000),
      status: "USED",
      used_at: new Date()
    }).execute();
    const applied = await applyMemberCorrectionCommand(trx, {
      commandType: options.commandType,
      propertyId: demo.propertyId,
      effect: options.effect,
      commandId,
      reason: { code: "DATA_ENTRY_CORRECTION", note: `frozen SQL evidence ${options.label}` }
    });
    if (options.previewEffectAfterApply) {
      await sql`alter table command_previews disable trigger command_previews_stage11_preserve_evidence`.execute(trx);
      try {
        await trx.updateTable("command_previews")
          .set({ effect: options.previewEffectAfterApply })
          .where("id", "=", previewId)
          .execute();
      } finally {
        await sql`alter table command_previews enable trigger command_previews_stage11_preserve_evidence`.execute(trx);
      }
    }
    await trx.updateTable("command_executions").set({
      state: "APPLIED",
      completed_at: sql`transaction_timestamp()`
    }).where("id", "=", commandId).execute();
    await trx.insertInto("command_receipts").values({
      id: `receipt-frozen-member-correction-${options.label}-${sequence}`,
      command_id: commandId,
      execution_status: "EXECUTED",
      business_committed: true,
      result: applied.persistedResult,
      error: null,
      resource_refs: JSON.stringify(applied.resourceRefs),
      fact_refs: JSON.stringify(applied.factRefs),
      committed_at: sql`transaction_timestamp()`
    }).execute();
    await trx.insertInto("audit_entries").values({
      id: `audit-frozen-member-correction-${options.label}-${sequence}`,
      subject_id: administrator.subjectId,
      credential_id: administrator.credentialId,
      action: options.commandType,
      decision: "ALLOWED",
      command_id: commandId,
      correlation_id: correlationId,
      reason: { code: "DATA_ENTRY_CORRECTION", note: `frozen SQL evidence ${options.label}` },
      target_refs: JSON.stringify(applied.resourceRefs),
      metadata: {
        source: "integration-test-frozen-effect",
        previewId,
        effectHash: options.auditEffectHash ?? effectHash
      }
    }).execute();
    await options.afterGraph?.(trx);
    return applied;
  });
}

async function previewBasisVersions(previewId: string): Promise<Record<string, unknown>> {
  const preview = await db.selectFrom("command_previews")
    .select("basis_versions")
    .where("id", "=", previewId)
    .executeTakeFirstOrThrow();
  return structuredClone(preview.basis_versions) as Record<string, unknown>;
}

async function insertLegacyActiveProjection(options: {
  memberId: string;
  prefix: string;
  unitKind?: "BED_NIGHT" | "ROOM_NIGHT";
  totalUnits?: number;
}) {
  const propertyToday = await propertyLocalToday(db, demo.propertyId);
  const validFrom = shiftLocalDate(propertyToday, -30);
  const validUntil = addCalendarYear(validFrom);
  const contractId = `legacy-contract-${options.prefix}`;
  const lotId = `legacy-lot-${options.prefix}`;
  const member = await db.selectFrom("members").select("full_name")
    .where("id", "=", options.memberId).executeTakeFirstOrThrow();
  await db.insertInto("member_contracts").values({
    id: contractId,
    property_id: demo.propertyId,
    member_id: options.memberId,
    member_name: member.full_name,
    status: "ACTIVE",
    valid_from: validFrom,
    valid_until: validUntil,
    version: 1,
    membership_order_id: null
  }).execute();
  await db.insertInto("entitlement_lots").values({
    id: lotId,
    contract_id: contractId,
    unit_kind: options.unitKind ?? "BED_NIGHT",
    total_units: options.totalUnits ?? 30,
    expires_on: validUntil,
    status: "ACTIVE",
    version: 1
  }).execute();
  return { contractId, lotId, validFrom, validUntil };
}

async function forceActiveMembershipInterval(options: {
  membershipOrderId: string;
  contractId: string;
  lotId: string;
  validFrom: string;
  validUntil: string;
}): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("SET session_replication_role = replica");
    await client.query(`
      UPDATE membership_orders
      SET valid_from = $2, valid_until = $3
      WHERE id = $1 AND status = 'ACTIVE'
    `, [options.membershipOrderId, options.validFrom, options.validUntil]);
    await client.query(`
      UPDATE member_contracts
      SET valid_from = $2, valid_until = $3
      WHERE id = $1 AND status = 'ACTIVE'
    `, [options.contractId, options.validFrom, options.validUntil]);
    await client.query(`
      UPDATE entitlement_lots
      SET expires_on = $2
      WHERE id = $1 AND status = 'ACTIVE'
    `, [options.lotId, options.validUntil]);
  } finally {
    await client.query("SET session_replication_role = origin").catch(() => undefined);
    await client.end();
  }
}

async function forceSourcePrimaryDocumentNumber(orderId: string, documentNumber: string | null) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("SET session_replication_role = replica");
    await client.query(`
      UPDATE order_occupants
      SET document_number = $2
      WHERE order_id = $1 AND role = 'PRIMARY'
    `, [orderId, documentNumber]);
  } finally {
    await client.query("SET session_replication_role = origin").catch(() => undefined);
    await client.end();
  }
}

async function forceSourcePrimaryPhone(orderId: string, phoneNumber: string | null) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("SET session_replication_role = replica");
    await client.query(`
      UPDATE order_occupants
      SET phone = $2
      WHERE order_id = $1 AND role = 'PRIMARY'
    `, [orderId, phoneNumber]);
  } finally {
    await client.query("SET session_replication_role = origin").catch(() => undefined);
    await client.end();
  }
}

async function insertPendingDirectHistoricalBackfillGraph(
  client: pg.Client,
  fixture: DirectHistoricalBackfillGraph
) {
  const commandId = `direct-backfill-${fixture.prefix}-command`;
  const membershipOrderId = `direct-backfill-${fixture.prefix}-order`;
  const paymentFactId = `direct-backfill-${fixture.prefix}-payment`;
  const contractId = `direct-backfill-${fixture.prefix}-contract`;
  const entitlementLotId = `direct-backfill-${fixture.prefix}-lot`;
  const backfillId = `direct-backfill-${fixture.prefix}-root`;
  const previewId = `direct-backfill-${fixture.prefix}-preview`;
  const validUntil = addCalendarYear(fixture.actualMembershipDate);

  const correlationId = `direct-backfill-${fixture.prefix}`;
  await client.query(`
    INSERT INTO command_executions (
      id, subject_id, credential_id, property_id, command_type, idempotency_key,
      request_hash, correlation_id, state
    ) VALUES (
      $1, $2, $3, $4, 'BACKFILL_HISTORICAL_MEMBERSHIP', $5,
      repeat('a', 64), $5, 'EXECUTING'
    )
  `, [commandId, demo.administratorSubjectId, "token_demo_admin_write", demo.propertyId, correlationId]);
  await client.query(`
    INSERT INTO command_previews (
      id, subject_id, property_id, command_type, normalized_input, input_hash,
      effect, effect_hash, basis_versions, expires_at, status, used_at
    )
    SELECT $1, $2, $3, 'BACKFILL_HISTORICAL_MEMBERSHIP', '{}'::jsonb, repeat('a', 64),
      jsonb_build_object(
        'operation', 'BACKFILL_HISTORICAL_MEMBERSHIP',
        'evidenceNote', 'direct SQL database-lock serialization proof',
        'member', jsonb_build_object('memberId', member.id, 'fullName', member.full_name),
        'product', jsonb_build_object(
          'productId', product.id,
          'code', product.code,
          'version', product.version,
          'name', product.name,
          'listedPrice', jsonb_build_object('currency', product.currency, 'minorUnits', product.list_price_minor),
          'agreedPrice', jsonb_build_object('currency', product.currency, 'minorUnits', product.list_price_minor),
          'entitlementUnitKind', product.entitlement_unit_kind,
          'entitlementUnits', product.entitlement_units,
          'validityPeriod', product.validity_period,
          'allowedRoomTypeCode', product.allowed_room_type_code,
          'allowedInventoryKind', product.allowed_inventory_kind
        ),
        'payment', jsonb_build_object(
          'amount', jsonb_build_object('currency', product.currency, 'minorUnits', product.list_price_minor),
          'businessDate', $7::text,
          'transactionReference', $8::text,
          'note', 'direct SQL serialization proof'
        ),
        'validFrom', $5::text,
        'validUntil', $6::text,
        'entitlementUnitKind', product.entitlement_unit_kind,
        'entitlementUnits', product.entitlement_units,
        'status', 'ACTIVE'
      ),
      repeat('b', 64), '{}'::jsonb, now() + interval '10 minutes', 'USED', now()
    FROM membership_products AS product
    JOIN members AS member ON member.id = $4
    WHERE product.id = 'membership_product_shared_bath_quad_v1'
  `, [
    previewId,
    demo.administratorSubjectId,
    demo.propertyId,
    fixture.memberId,
    fixture.actualMembershipDate,
    validUntil,
    fixture.businessDate,
    fixture.transactionReference
  ]);
  await client.query(`
    INSERT INTO membership_orders (
      id, property_id, member_id, product_id, product_code, product_version, product_name,
      listed_price_minor, agreed_price_minor, price_adjustment_minor, price_adjustment_reason,
      currency, entitlement_unit_kind, entitlement_units, allowed_room_type_code,
      allowed_inventory_kind, status, activated_at, valid_from, valid_until, contract_id,
      entitlement_lot_id, version, created_by_command_id, activated_by_command_id
    )
    SELECT $1, $2, $3, product.id, product.code, product.version, product.name,
      product.list_price_minor, product.list_price_minor, 0, NULL,
      product.currency, product.entitlement_unit_kind, product.entitlement_units,
      product.allowed_room_type_code, product.allowed_inventory_kind,
      'DRAFT', NULL, NULL, NULL, NULL, NULL, 1, $4, NULL
    FROM membership_products AS product
    WHERE product.id = 'membership_product_shared_bath_quad_v1'
  `, [membershipOrderId, demo.propertyId, fixture.memberId, commandId]);
  await client.query(`
    INSERT INTO membership_payment_facts (
      fact_id, membership_order_id, fact_type, amount_minor, net_effect_minor, currency,
      transaction_reference, corrects_fact_id, reverses_fact_id, source_type,
      source_order_id, source_collection_fact_id, note, command_id, business_date
    ) VALUES (
      $1, $2, 'COLLECTION', 93600, 93600, 'CNY', $3, NULL, NULL, 'DIRECT_WECOM',
      NULL, NULL, 'direct SQL serialization proof', $4, $5
    )
  `, [paymentFactId, membershipOrderId, fixture.transactionReference, commandId, fixture.businessDate]);
  await client.query(`
    INSERT INTO member_contracts (
      id, property_id, member_id, member_name, status, valid_from, valid_until, version,
      membership_order_id
    )
    SELECT $1, $2, member.id, member.full_name, 'ACTIVE', $4, $5, 1, $6
    FROM members AS member
    WHERE member.id = $3
  `, [contractId, demo.propertyId, fixture.memberId, fixture.actualMembershipDate, validUntil, membershipOrderId]);
  await client.query(`
    INSERT INTO entitlement_lots (
      id, contract_id, unit_kind, total_units, expires_on, status, version
    ) VALUES ($1, $2, 'BED_NIGHT', 30, $3, 'ACTIVE', 1)
  `, [entitlementLotId, contractId, validUntil]);
  await client.query(`
    UPDATE membership_orders SET
      status = 'ACTIVE', activated_at = now(), valid_from = $2, valid_until = $3,
      contract_id = $4, entitlement_lot_id = $5, version = 2,
      activated_by_command_id = $6, updated_at = now()
    WHERE id = $1
  `, [
    membershipOrderId,
    fixture.actualMembershipDate,
    validUntil,
    contractId,
    entitlementLotId,
    commandId
  ]);

  return {
    commandId,
    membershipOrderId,
    paymentFactId,
    contractId,
    entitlementLotId,
    backfillId,
    previewId,
    validUntil
  };
}

async function insertDirectHistoricalBackfillRoot(
  client: pg.Client,
  fixture: DirectHistoricalBackfillGraph,
  graph: Awaited<ReturnType<typeof insertPendingDirectHistoricalBackfillGraph>>
) {
  await client.query(`
    INSERT INTO historical_membership_backfills (
      id, property_id, member_id, membership_order_id, contract_id, entitlement_lot_id,
      payment_fact_id, product_id, product_code, product_version, product_name,
      listed_price_minor, agreed_price_minor, currency, entitlement_unit_kind,
      entitlement_units, validity_period, allowed_room_type_code, allowed_inventory_kind,
      actual_membership_date, valid_until, business_date,
      transaction_reference, evidence_note, command_id
    )
    SELECT $1, $2, $3, $4, $5, $6, $7,
      product.id, product.code, product.version, product.name,
      product.list_price_minor, product.list_price_minor, product.currency,
      product.entitlement_unit_kind, product.entitlement_units,
      product.validity_period, product.allowed_room_type_code, product.allowed_inventory_kind,
      $8, $9, $10, $11, 'direct SQL database-lock serialization proof', $12
    FROM membership_products AS product
    WHERE product.id = 'membership_product_shared_bath_quad_v1'
  `, [
    graph.backfillId,
    demo.propertyId,
    fixture.memberId,
    graph.membershipOrderId,
    graph.contractId,
    graph.entitlementLotId,
    graph.paymentFactId,
    fixture.actualMembershipDate,
    graph.validUntil,
    fixture.businessDate,
    fixture.transactionReference,
    graph.commandId
  ]);
}

async function completeDirectHistoricalBackfillEvidence(
  client: pg.Client,
  fixture: DirectHistoricalBackfillGraph,
  graph: Awaited<ReturnType<typeof insertPendingDirectHistoricalBackfillGraph>>
) {
  const correlationId = `direct-backfill-${fixture.prefix}`;
  await client.query(`
    UPDATE command_executions
    SET state = 'APPLIED', completed_at = now()
    WHERE id = $1
  `, [graph.commandId]);
  await client.query(`
    INSERT INTO command_receipts (
      id, command_id, execution_status, business_committed, result, error,
      resource_refs, fact_refs, committed_at
    ) VALUES ($1, $2, 'EXECUTED', true, '{}'::jsonb, NULL, '[]'::jsonb, '[]'::jsonb, now())
  `, [`direct-backfill-${fixture.prefix}-receipt`, graph.commandId]);
  await client.query(`
    INSERT INTO audit_entries (
      id, subject_id, credential_id, action, decision, command_id, correlation_id,
      reason, target_refs, metadata
    ) VALUES (
      $1, $2, $3, 'BACKFILL_HISTORICAL_MEMBERSHIP', 'ALLOWED', $4, $5,
      '{"code":"DATA_ENTRY_CORRECTION","note":"direct SQL serialization proof"}'::jsonb,
      '[]'::jsonb, jsonb_build_object('previewId', $6::text, 'effectHash', repeat('b', 64))
    )
  `, [
    `direct-backfill-${fixture.prefix}-audit`,
    demo.administratorSubjectId,
    "token_demo_admin_write",
    graph.commandId,
    correlationId,
    graph.previewId
  ]);
}

async function prepareVoidReconversion(
  prefix: string,
  options: {
    agreedPriceMinor?: number;
    matchStayTransfer?: boolean;
    memberId?: string;
    oldErroneousDirectAmountMinor?: number;
    sourceDocumentNumber?: string;
    sourceContractAmountMinor?: number;
  } = {}
): Promise<VoidReconversionSetup> {
  const memberId = options.memberId ?? await createMember(`${prefix}-member`);
  const member = await db.selectFrom("members").selectAll().where("id", "=", memberId).executeTakeFirstOrThrow();
  const sourceStay = await createCompletedWecomStay({
    prefix: `${prefix}-source`,
    phone: member.phone,
    documentNumber: options.sourceDocumentNumber ?? member.identity_card_number!,
    ...(options.sourceContractAmountMinor === undefined
      ? {}
      : { contractAmountMinor: options.sourceContractAmountMinor })
  });
  const agreedPriceMinor = options.matchStayTransfer
    ? sourceStay.collectionAmountMinor
    : options.agreedPriceMinor ?? 93_600;
  const oldErroneousDirectAmountMinor = options.oldErroneousDirectAmountMinor ?? 93_600;
  const oldOrderReceipt = await confirm({
    commandType: "CREATE_MEMBERSHIP_ORDER",
    input: {
      propertyId: demo.propertyId,
      memberId,
      membershipProductId: "membership_product_shared_bath_single_v1",
      agreedPriceMinor,
      priceAdjustmentReason: "Cathy 错误会员链的原始成交价录入"
    }
  }, `${prefix}-old-order`, ordinaryStaff);
  const oldMembershipOrderId = oldOrderReceipt.result!.membershipOrderId as string;
  await confirm({
    commandType: "RECORD_MEMBERSHIP_PAYMENT",
    input: {
      propertyId: demo.propertyId,
      membershipOrderId: oldMembershipOrderId,
      amountMinor: oldErroneousDirectAmountMinor,
      transactionReference: `WECOM-${prefix.toUpperCase()}-OLD-DIRECT`
    }
  }, `${prefix}-old-payment`, ordinaryStaff);
  await confirm({
    commandType: "ACTIVATE_MEMBERSHIP_ORDER",
    input: { propertyId: demo.propertyId, membershipOrderId: oldMembershipOrderId }
  }, `${prefix}-old-activate`, ordinaryStaff);

  return {
    oldMembershipOrderId,
    sourceStay,
    command: envelope("VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY", {
      propertyId: demo.propertyId,
      erroneousMembershipOrderId: oldMembershipOrderId,
      sourceStayOrderId: sourceStay.orderId,
      actualMembershipDate: sourceStay.arrivalDate,
      ...(agreedPriceMinor > sourceStay.collectionAmountMinor ? {
        replacementDirectPayment: {
          businessDate: sourceStay.arrivalDate,
          transactionReference: `WECOM-${prefix.toUpperCase()}-RECLASSIFIED-DIRECT`
        }
      } : {}),
      evidenceNote: "错误会员链作废重建的攻击图回滚验证"
    })
  };
}

async function membershipCommandBusinessGraphSnapshot() {
  const [
    members,
    memberPropertyLinks,
    orders,
    membershipOrders,
    memberContracts,
    entitlementLots,
    entitlementLedger,
    coverageItems,
    inventoryClaims,
    membershipPayments,
    collectionFacts,
    adminPaymentEvidenceClaims,
    transfers,
    reclassifications,
    profileCorrections,
    effectiveDateCorrections,
    historicalBackfills,
    reconversions,
    amendments,
    pricingRevisions,
    roomStatusRevisions
  ] = await Promise.all([
    db.selectFrom("members").selectAll().orderBy("id").execute(),
    db.selectFrom("member_property_links").selectAll()
      .orderBy("member_id").orderBy("property_id").execute(),
    db.selectFrom("orders").selectAll().orderBy("id").execute(),
    db.selectFrom("membership_orders").selectAll().orderBy("id").execute(),
    db.selectFrom("member_contracts").selectAll().orderBy("id").execute(),
    db.selectFrom("entitlement_lots").selectAll().orderBy("id").execute(),
    db.selectFrom("entitlement_ledger").selectAll().orderBy("fact_id").execute(),
    db.selectFrom("coverage_items").selectAll().orderBy("id").execute(),
    db.selectFrom("inventory_claims").selectAll().orderBy("id").execute(),
    db.selectFrom("membership_payment_facts").selectAll().orderBy("fact_id").execute(),
    db.selectFrom("collection_facts").selectAll().orderBy("fact_id").execute(),
    db.selectFrom("admin_membership_payment_evidence_claims").selectAll().orderBy("normalized_reference").execute(),
    db.selectFrom("stay_collection_membership_transfers").selectAll().orderBy("id").execute(),
    db.selectFrom("membership_payment_reclassifications").selectAll().orderBy("id").execute(),
    db.selectFrom("member_profile_corrections").selectAll().orderBy("id").execute(),
    db.selectFrom("membership_effective_date_corrections").selectAll().orderBy("id").execute(),
    db.selectFrom("historical_membership_backfills").selectAll().orderBy("id").execute(),
    db.selectFrom("membership_void_reconversions").selectAll().orderBy("id").execute(),
    db.selectFrom("amendments").selectAll().orderBy("id").execute(),
    db.selectFrom("pricing_revisions").selectAll().orderBy("id").execute(),
    db.selectFrom("room_status_revisions").selectAll().orderBy("property_id").execute()
  ]);
  return {
    members,
    memberPropertyLinks,
    orders,
    membershipOrders,
    memberContracts,
    entitlementLots,
    entitlementLedger,
    coverageItems,
    inventoryClaims,
    membershipPayments,
    collectionFacts,
    adminPaymentEvidenceClaims,
    transfers,
    reclassifications,
    profileCorrections,
    effectiveDateCorrections,
    historicalBackfills,
    reconversions,
    amendments,
    pricingRevisions,
    roomStatusRevisions
  };
}

async function insertLegacyEffectiveDateLedgerAnomaly(options: {
  factId: string;
  entryType: "CONVERSION_CONSUME" | "EXPIRE" | "RESTORE";
  quantityDelta: number;
  serviceDate: string | null;
}) {
  await db.transaction().execute(async (trx) => {
    await sql`SET LOCAL session_replication_role = replica`.execute(trx);
    await trx.insertInto("entitlement_ledger").values({
      fact_id: options.factId,
      lot_id: demo.roomLotId,
      entry_type: options.entryType,
      quantity_delta: options.quantityDelta,
      service_date: options.serviceDate,
      order_id: null,
      coverage_id: null,
      reason: "legacy imported entitlement anomaly",
      command_id: null
    }).execute();
  });
}

async function refreshFrozenEffectiveDateEvidence(
  prepared: Awaited<ReturnType<typeof preview>>,
  target: { entitlementLotId: string; memberId: string } = {
    entitlementLotId: demo.roomLotId,
    memberId: demo.memberId
  }
): Promise<{ effect: Record<string, unknown>; basisVersions: Record<string, unknown> }> {
  const [ledger, coverage, memberView] = await Promise.all([
    db.selectFrom("entitlement_ledger")
      .leftJoin("coverage_items", "coverage_items.id", "entitlement_ledger.coverage_id")
      .selectAll("entitlement_ledger")
      .where((expression) => expression.or([
        expression("entitlement_ledger.lot_id", "=", target.entitlementLotId),
        expression("coverage_items.lot_id", "=", target.entitlementLotId)
      ]))
      .orderBy("created_at").orderBy("fact_id").execute(),
    db.selectFrom("coverage_items").selectAll().where("lot_id", "=", target.entitlementLotId)
      .orderBy("service_date").orderBy("id").execute(),
    getMemberView(db, demo.propertyId, target.memberId)
  ]);
  const effect = structuredClone(prepared.preview.effect) as Record<string, unknown>;
  const unchanged = effect.unchanged as Record<string, unknown>;
  unchanged.usedUnits = ledger.filter((item) =>
    item.entry_type === "CONSUME" || item.entry_type === "CONVERSION_CONSUME"
  ).length;
  unchanged.availableBalance = structuredClone(memberView.availableBalance);
  const basisVersions = await previewBasisVersions(prepared.preview.previewId);
  const sourceOrderIds = [...new Set(ledger.flatMap((item) =>
    item.order_id !== null && ["HOLD", "RELEASE", "CONSUME", "RESTORE", "CONVERSION_CONSUME"].includes(item.entry_type)
      ? [item.order_id]
      : []
  ))].sort();
  const sourceRows = sourceOrderIds.length === 0 ? [] : await db.selectFrom("orders")
    .innerJoin("stays", "stays.order_id", "orders.id")
    .select([
      "orders.id as order_id", "orders.version as order_version", "orders.status as order_status",
      "orders.current_revision_id", "stays.id as stay_id", "stays.status as stay_status"
    ])
    .where("orders.id", "in", sourceOrderIds)
    .orderBy("orders.id").orderBy("stays.id").execute();
  basisVersions.ledgerFactIds = ledger.map((item) => item.fact_id);
  basisVersions.coverageStates = coverage.map((item) => ({ id: item.id, status: item.status }));
  basisVersions.sourceStates = sourceRows.map((item) => ({
    orderId: item.order_id,
    version: item.order_version,
    status: item.order_status,
    currentRevisionId: item.current_revision_id,
    stayId: item.stay_id,
    stayStatus: item.stay_status
  }));
  basisVersions.memberBalance = structuredClone(memberView.availableBalance);
  return { effect, basisVersions };
}

type MembershipWriteFailureTarget = {
  table: string;
  event: "INSERT" | "UPDATE";
  condition?: string;
};

const membershipCompletionWriteFailureTargets = [
  { table: "command_previews", event: "UPDATE", condition: "NEW.status = 'USED'" },
  { table: "command_executions", event: "UPDATE", condition: "NEW.state = 'APPLIED'" },
  { table: "command_receipts", event: "INSERT", condition: "NEW.execution_status = 'EXECUTED'" },
  { table: "audit_entries", event: "INSERT", condition: "NEW.decision = 'ALLOWED'" }
] as const satisfies readonly MembershipWriteFailureTarget[];

const membershipWriteFailureTargets = {
  CORRECT_MEMBER_PROFILE: [
    { table: "member_profile_corrections", event: "INSERT" },
    { table: "members", event: "UPDATE" }
  ],
  CORRECT_MEMBERSHIP_EFFECTIVE_DATE: [
    { table: "membership_effective_date_corrections", event: "INSERT" },
    { table: "membership_orders", event: "UPDATE" },
    { table: "member_contracts", event: "UPDATE" },
    { table: "entitlement_lots", event: "UPDATE" }
  ],
  BACKFILL_HISTORICAL_MEMBERSHIP: [
    { table: "membership_orders", event: "INSERT" },
    { table: "membership_payment_facts", event: "INSERT" },
    { table: "member_contracts", event: "INSERT" },
    { table: "entitlement_lots", event: "INSERT" },
    { table: "membership_orders", event: "UPDATE" },
    { table: "historical_membership_backfills", event: "INSERT" },
    { table: "admin_membership_payment_evidence_claims", event: "INSERT" }
  ],
  VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY: [
    { table: "membership_void_reconversions", event: "INSERT" },
    { table: "admin_membership_payment_evidence_claims", event: "INSERT" },
    { table: "membership_orders", event: "INSERT" },
    { table: "membership_orders", event: "UPDATE", condition: "OLD.status = 'DRAFT' AND NEW.status = 'ACTIVE'" },
    { table: "membership_orders", event: "UPDATE", condition: "NEW.status = 'VOIDED'" },
    { table: "collection_facts", event: "INSERT" },
    { table: "membership_payment_facts", event: "INSERT", condition: "NEW.source_type = 'STAY_COLLECTION_TRANSFER'" },
    { table: "membership_payment_facts", event: "INSERT", condition: "NEW.fact_type = 'COLLECTION' AND NEW.source_type = 'DIRECT_WECOM'" },
    { table: "membership_payment_facts", event: "INSERT", condition: "NEW.fact_type = 'REVERSAL'" },
    { table: "stay_collection_membership_transfers", event: "INSERT" },
    { table: "member_contracts", event: "INSERT" },
    { table: "member_contracts", event: "UPDATE", condition: "NEW.status = 'VOIDED'" },
    { table: "member_contracts", event: "UPDATE", condition: "OLD.status = 'ACTIVE' AND NEW.status = 'ACTIVE'" },
    { table: "entitlement_lots", event: "INSERT" },
    { table: "entitlement_lots", event: "UPDATE", condition: "NEW.status = 'VOIDED'" },
    { table: "entitlement_lots", event: "UPDATE", condition: "OLD.status = 'ACTIVE' AND NEW.status = 'ACTIVE'" },
    { table: "membership_payment_reclassifications", event: "INSERT" },
    { table: "entitlement_ledger", event: "INSERT", condition: "NEW.entry_type = 'VOID'" },
    { table: "entitlement_ledger", event: "INSERT", condition: "NEW.entry_type = 'CONVERSION_CONSUME'" },
    { table: "amendments", event: "INSERT" },
    { table: "pricing_revisions", event: "INSERT" },
    { table: "orders", event: "UPDATE" }
  ]
} as const satisfies Record<MemberCorrectionCommandType, readonly MembershipWriteFailureTarget[]>;

async function installMembershipWriteFailure(target: MembershipWriteFailureTarget): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION qintopia_test_fail_membership_correction_write()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'injected membership correction write failure';
    END;
    $$
  `.execute(db);
  const condition = target.condition ? sql`WHEN (${sql.raw(target.condition)})` : sql``;
  await sql`CREATE TRIGGER qintopia_test_fail_membership_correction_write BEFORE ${sql.raw(target.event)} ON ${sql.table(target.table)} FOR EACH ROW ${condition} EXECUTE FUNCTION qintopia_test_fail_membership_correction_write()`.execute(db);
}

async function clearMembershipWriteFailure(table: string): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS qintopia_test_fail_membership_correction_write ON ${sql.table(table)}`.execute(db);
  await sql`DROP FUNCTION IF EXISTS qintopia_test_fail_membership_correction_write()`.execute(db);
}

async function assertMembershipWriteFailureRollsBack(
  command: CommandEnvelope,
  target: MembershipWriteFailureTarget,
  label: string
): Promise<void> {
  const prepared = await preview(command, `${label}-preview`);
  const before = await membershipCommandBusinessGraphSnapshot();
  const confirmMetadata = metadata(`${label}-confirm`);
  await installMembershipWriteFailure(target);
  let receipt: ReceiptDto;
  try {
    receipt = await confirmCommandPreview(db, administrator, prepared.preview.previewId, {
      propertyId: command.input.propertyId as string,
      commandType: command.commandType,
      confirmation: true,
      expectedEffectHash: prepared.preview.effectHash,
      reason: { code: "DATA_ENTRY_CORRECTION", note: `逐写点故障注入 ${label}` }
    }, confirmMetadata);
  } finally {
    await clearMembershipWriteFailure(target.table);
  }

  expect(receipt, label).toMatchObject({
    executionStatus: "NOT_EXECUTED",
    businessCommitted: false,
    resourceRefs: [],
    factRefs: [],
    error: { code: "COMMAND_INTERRUPTED" }
  });
  expect(await membershipCommandBusinessGraphSnapshot(), label).toEqual(before);
  expect(await db.selectFrom("command_previews").select(["status", "used_at"])
    .where("id", "=", prepared.preview.previewId).executeTakeFirstOrThrow(), label)
    .toEqual({ status: "OPEN", used_at: null });

  const execution = await db.selectFrom("command_executions").selectAll()
    .where("subject_id", "=", administrator.subjectId)
    .where("property_id", "=", command.input.propertyId as string)
    .where("command_type", "=", command.commandType)
    .where("idempotency_key", "=", confirmMetadata.idempotencyKey!)
    .executeTakeFirstOrThrow();
  expect(execution, label).toMatchObject({ state: "REJECTED", correlation_id: confirmMetadata.correlationId });
  expect(await db.selectFrom("command_receipts").selectAll().where("command_id", "=", execution.id).execute(), label)
    .toEqual([expect.objectContaining({ execution_status: "NOT_EXECUTED", business_committed: false, result: null, resource_refs: [], fact_refs: [] })]);
  expect(await db.selectFrom("audit_entries").selectAll().where("command_id", "=", execution.id).execute(), label)
    .toEqual([expect.objectContaining({ decision: "DENIED", target_refs: [] })]);
}

async function clearMembershipCommandScopeAttackTrigger() {
  await sql.raw(`
    DROP TRIGGER IF EXISTS qintopia_test_membership_command_scope_attack ON member_profile_corrections;
    DROP TRIGGER IF EXISTS qintopia_test_membership_command_scope_attack ON membership_effective_date_corrections;
    DROP TRIGGER IF EXISTS qintopia_test_membership_command_scope_attack ON historical_membership_backfills;
    DROP TRIGGER IF EXISTS qintopia_test_membership_command_scope_attack ON membership_void_reconversions;
    DROP TRIGGER IF EXISTS qintopia_test_membership_command_scope_attack ON membership_payment_reclassifications;
    DROP TRIGGER IF EXISTS qintopia_test_membership_command_scope_attack ON membership_payment_facts;
    DROP TRIGGER IF EXISTS qintopia_test_membership_command_scope_attack ON pricing_revisions;
    DROP FUNCTION IF EXISTS qintopia_test_membership_command_scope_attack();
  `).execute(db);
}

async function installMembershipCommandScopeAttack(options: {
  table: "member_profile_corrections" | "membership_effective_date_corrections"
    | "historical_membership_backfills" | "membership_void_reconversions"
    | "membership_payment_reclassifications" | "membership_payment_facts" | "pricing_revisions";
  timing?: "BEFORE" | "AFTER";
  declarations?: string | undefined;
  body: string;
}) {
  await clearMembershipCommandScopeAttackTrigger();
  await sql.raw(`
    CREATE FUNCTION qintopia_test_membership_command_scope_attack() RETURNS trigger
    LANGUAGE plpgsql AS $$
    ${options.declarations ?? ""}
    BEGIN
      IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
      ${options.body}
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER qintopia_test_membership_command_scope_attack
    ${options.timing ?? "AFTER"} INSERT ON ${options.table}
    FOR EACH ROW EXECUTE FUNCTION qintopia_test_membership_command_scope_attack();
  `).execute(db);
}

async function clearHistoricalBackfillProductSwapAttack() {
  await sql.raw(`
    DROP TRIGGER IF EXISTS qintopia_test_swap_backfill_order_product ON membership_orders;
    DROP TRIGGER IF EXISTS qintopia_test_swap_backfill_payment_product ON membership_payment_facts;
    DROP TRIGGER IF EXISTS qintopia_test_swap_backfill_lot_product ON entitlement_lots;
    DROP TRIGGER IF EXISTS qintopia_test_swap_backfill_root_product ON historical_membership_backfills;
    DROP FUNCTION IF EXISTS qintopia_test_swap_backfill_order_product();
    DROP FUNCTION IF EXISTS qintopia_test_swap_backfill_payment_product();
    DROP FUNCTION IF EXISTS qintopia_test_swap_backfill_lot_product();
    DROP FUNCTION IF EXISTS qintopia_test_swap_backfill_root_product();
  `).execute(db);
}

async function installHistoricalBackfillProductSwapAttack() {
  await clearHistoricalBackfillProductSwapAttack();
  await sql.raw(`
    CREATE FUNCTION qintopia_test_swap_backfill_order_product() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE replacement membership_products%ROWTYPE;
    BEGIN
      IF (SELECT command_type FROM command_executions WHERE id = NEW.created_by_command_id)
          = 'BACKFILL_HISTORICAL_MEMBERSHIP' THEN
        SELECT * INTO STRICT replacement
        FROM membership_products WHERE id = 'membership_product_shared_bath_single_v1';
        NEW.product_id := replacement.id;
        NEW.product_code := replacement.code;
        NEW.product_version := replacement.version;
        NEW.product_name := replacement.name;
        NEW.listed_price_minor := replacement.list_price_minor;
        NEW.agreed_price_minor := replacement.list_price_minor;
        NEW.price_adjustment_minor := 0;
        NEW.price_adjustment_reason := NULL;
        NEW.currency := replacement.currency;
        NEW.entitlement_unit_kind := replacement.entitlement_unit_kind;
        NEW.entitlement_units := replacement.entitlement_units;
        NEW.allowed_room_type_code := replacement.allowed_room_type_code;
        NEW.allowed_inventory_kind := replacement.allowed_inventory_kind;
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER qintopia_test_swap_backfill_order_product
    BEFORE INSERT ON membership_orders
    FOR EACH ROW EXECUTE FUNCTION qintopia_test_swap_backfill_order_product();

    CREATE FUNCTION qintopia_test_swap_backfill_payment_product() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF (SELECT command_type FROM command_executions WHERE id = NEW.command_id)
          = 'BACKFILL_HISTORICAL_MEMBERSHIP' THEN
        NEW.amount_minor := 162000;
        NEW.net_effect_minor := 162000;
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER qintopia_test_swap_backfill_payment_product
    BEFORE INSERT ON membership_payment_facts
    FOR EACH ROW EXECUTE FUNCTION qintopia_test_swap_backfill_payment_product();

    CREATE FUNCTION qintopia_test_swap_backfill_lot_product() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE target_command_type text;
    BEGIN
      SELECT execution.command_type INTO target_command_type
      FROM member_contracts AS contract
      JOIN membership_orders AS membership_order ON membership_order.id = contract.membership_order_id
      JOIN command_executions AS execution ON execution.id = membership_order.created_by_command_id
      WHERE contract.id = NEW.contract_id;
      IF target_command_type = 'BACKFILL_HISTORICAL_MEMBERSHIP' THEN
        NEW.unit_kind := 'ROOM_NIGHT';
        NEW.total_units := 30;
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER qintopia_test_swap_backfill_lot_product
    BEFORE INSERT ON entitlement_lots
    FOR EACH ROW EXECUTE FUNCTION qintopia_test_swap_backfill_lot_product();

    CREATE FUNCTION qintopia_test_swap_backfill_root_product() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE replacement membership_products%ROWTYPE;
    BEGIN
      IF (SELECT command_type FROM command_executions WHERE id = NEW.command_id)
          = 'BACKFILL_HISTORICAL_MEMBERSHIP' THEN
        SELECT * INTO STRICT replacement
        FROM membership_products WHERE id = 'membership_product_shared_bath_single_v1';
        NEW.product_id := replacement.id;
        NEW.product_code := replacement.code;
        NEW.product_version := replacement.version;
        NEW.product_name := replacement.name;
        NEW.listed_price_minor := replacement.list_price_minor;
        NEW.agreed_price_minor := replacement.list_price_minor;
        NEW.currency := replacement.currency;
        NEW.entitlement_unit_kind := replacement.entitlement_unit_kind;
        NEW.entitlement_units := replacement.entitlement_units;
        NEW.validity_period := replacement.validity_period;
        NEW.allowed_room_type_code := replacement.allowed_room_type_code;
        NEW.allowed_inventory_kind := replacement.allowed_inventory_kind;
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER qintopia_test_swap_backfill_root_product
    BEFORE INSERT ON historical_membership_backfills
    FOR EACH ROW EXECUTE FUNCTION qintopia_test_swap_backfill_root_product();
  `).execute(db);
}

beforeEach(async () => {
  db = await resetDatabase(databaseUrl);
});

afterEach(async () => {
  if (db) await db.destroy();
});

describe("step 9 administrator membership corrections", () => {
  it("replays all administrator membership previews for equivalent normalized input without merging different facts", async () => {
    const replayEquivalentPreview = async (
      label: string,
      canonical: CommandEnvelope,
      equivalent: CommandEnvelope
    ) => {
      const requestMetadata = {
        idempotencyKey: `normalized-member-preview-${label}`,
        correlationId: `normalized-member-preview-${label}`
      };
      const first = await createCommandPreview(db, administrator, canonical, requestMetadata);
      const replay = await createCommandPreview(db, administrator, equivalent, requestMetadata);
      expect(replay.preview.previewId, label).toBe(first.preview.previewId);
      expect(replay.receipt.commandId, label).toBe(first.receipt.commandId);
      return { first, requestMetadata };
    };

    const profileMemberId = await createMember("normalized-profile");
    const profileMember = await db.selectFrom("members").selectAll()
      .where("id", "=", profileMemberId).executeTakeFirstOrThrow();
    const profileInput = {
      propertyId: demo.propertyId,
      memberId: profileMemberId,
      expectedPriorProfile: {
        fullName: profileMember.full_name,
        nickname: profileMember.nickname,
        identityCardNumber: profileMember.identity_card_number,
        phone: profileMember.phone,
        wechat: profileMember.wechat
      },
      correctedProfile: {
        fullName: "会员资料已核实",
        nickname: "资料已核",
        identityCardNumber: "NORMALIZED-PROFILE-ID",
        phone: "13800009111",
        wechat: "normalized-profile-verified"
      },
      evidenceNote: "已核对会员本人资料"
    };
    const profileReplay = await replayEquivalentPreview(
      "profile",
      envelope("CORRECT_MEMBER_PROFILE", profileInput),
      envelope("CORRECT_MEMBER_PROFILE", {
        propertyId: ` ${demo.propertyId} `,
        memberId: ` ${profileMemberId} `,
        expectedPriorProfile: {
          fullName: ` ${profileMember.full_name} `,
          nickname: ` ${profileMember.nickname} `,
          identityCardNumber: ` ${profileMember.identity_card_number!.toLowerCase()} `,
          phone: profileMember.phone.replace(/(\d{3})(\d{4})(\d{4})/, "$1 $2 $3"),
          wechat: ` ${profileMember.wechat} `
        },
        correctedProfile: {
          fullName: " 会员资料已核实 ",
          nickname: " 资料已核 ",
          identityCardNumber: " normalized-profile-id ",
          phone: "138 0000 9111",
          wechat: " normalized-profile-verified "
        },
        evidenceNote: " 已核对会员本人资料 "
      })
    );
    await expect(createCommandPreview(db, administrator, envelope("CORRECT_MEMBER_PROFILE", {
      ...profileInput,
      correctedProfile: { ...profileInput.correctedProfile, fullName: "另一位会员姓名" }
    }), profileReplay.requestMetadata)).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });

    const transitionSetup = await prepareVoidReconversion("normalized-transition");
    const transitionOrder = await db.selectFrom("membership_orders").select("valid_from")
      .where("id", "=", transitionSetup.oldMembershipOrderId).executeTakeFirstOrThrow();
    const correctedStartDate = shiftLocalDate(transitionOrder.valid_from!, -1);
    await replayEquivalentPreview(
      "effective-date",
      envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
        propertyId: demo.propertyId,
        membershipOrderId: transitionSetup.oldMembershipOrderId,
        actualMembershipDate: correctedStartDate,
        evidenceNote: "已核对实际会员开始日期"
      }),
      envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
        propertyId: ` ${demo.propertyId} `,
        membershipOrderId: ` ${transitionSetup.oldMembershipOrderId} `,
        actualMembershipDate: ` ${correctedStartDate} `,
        evidenceNote: " 已核对实际会员开始日期 "
      })
    );

    const backfillMemberId = await createMember("normalized-backfill");
    const propertyToday = await propertyLocalToday(db, demo.propertyId);
    const backfillStartDate = shiftLocalDate(propertyToday, -30);
    const backfillPaymentDate = shiftLocalDate(propertyToday, -2);
    await replayEquivalentPreview(
      "backfill",
      envelope("BACKFILL_HISTORICAL_MEMBERSHIP", {
        propertyId: demo.propertyId,
        memberId: backfillMemberId,
        membershipProductId: "membership_product_shared_bath_quad_v1",
        actualMembershipDate: backfillStartDate,
        payment: {
          amountMinor: 93_600,
          businessDate: backfillPaymentDate,
          transactionReference: "WECOM-NORMALIZED-BACKFILL",
          note: "切换期真实收款"
        },
        evidenceNote: "已核对企微账单和原会员资料"
      }),
      envelope("BACKFILL_HISTORICAL_MEMBERSHIP", {
        propertyId: ` ${demo.propertyId} `,
        memberId: ` ${backfillMemberId} `,
        membershipProductId: " membership_product_shared_bath_quad_v1 ",
        actualMembershipDate: ` ${backfillStartDate} `,
        payment: {
          amountMinor: 93_600,
          businessDate: ` ${backfillPaymentDate} `,
          transactionReference: " WECOM-NORMALIZED-BACKFILL ",
          note: " 切换期真实收款 "
        },
        evidenceNote: " 已核对企微账单和原会员资料 "
      })
    );

    const canonicalVoidInput = transitionSetup.command.input;
    const replacement = canonicalVoidInput.replacementDirectPayment as Record<string, unknown>;
    await replayEquivalentPreview(
      "void-reconversion",
      transitionSetup.command,
      envelope("VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY", {
        propertyId: ` ${canonicalVoidInput.propertyId as string} `,
        erroneousMembershipOrderId: ` ${canonicalVoidInput.erroneousMembershipOrderId as string} `,
        sourceStayOrderId: ` ${canonicalVoidInput.sourceStayOrderId as string} `,
        actualMembershipDate: ` ${canonicalVoidInput.actualMembershipDate as string} `,
        replacementDirectPayment: {
          businessDate: ` ${replacement.businessDate as string} `,
          transactionReference: ` ${replacement.transactionReference as string} `
        },
        evidenceNote: ` ${canonicalVoidInput.evidenceNote as string} `
      })
    );
  });

  it("executes member-profile correction as qintopia_runtime without exposing private payment evidence", async () => {
    const runtimeDb = createDatabase(runtimeDatabaseUrlForTesting(databaseUrl));
    try {
      const before = await db.selectFrom("members").selectAll()
        .where("id", "=", demo.memberId).executeTakeFirstOrThrow();
      const command = envelope("CORRECT_MEMBER_PROFILE", {
        propertyId: demo.propertyId,
        memberId: demo.memberId,
        expectedPriorProfile: {
          fullName: before.full_name,
          nickname: before.nickname,
          identityCardNumber: before.identity_card_number,
          phone: before.phone,
          wechat: before.wechat
        },
        correctedProfile: {
          fullName: before.full_name,
          nickname: "Runtime profile correction",
          identityCardNumber: before.identity_card_number,
          phone: before.phone,
          wechat: before.wechat
        },
        evidenceNote: "runtime 身份只通过受控资料纠正命令访问必要事实"
      });

      const receipt = await confirmWithDatabase(runtimeDb, command, "runtime-profile-correction");
      expect(receipt).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });
      expect(await db.selectFrom("members").select("nickname")
        .where("id", "=", demo.memberId).executeTakeFirstOrThrow())
        .toEqual({ nickname: "Runtime profile correction" });

      await expect(sql`SELECT * FROM admin_membership_payment_evidence_claims`.execute(runtimeDb))
        .rejects.toThrow(/permission denied/i);
      const helperPrivilege = await sql<{ can_execute: boolean }>`
        SELECT has_function_privilege(
          current_user,
          'qintopia_validate_admin_membership_payment_evidence_scope()'::regprocedure,
          'EXECUTE'
        ) AS can_execute
      `.execute(runtimeDb);
      expect(helperPrivilege.rows[0]?.can_execute).toBe(false);
    } finally {
      await runtimeDb.destroy();
    }
  });

  it("executes 9.5 as qintopia_runtime with lock-only column grants that remain append-only", async () => {
    const setup = await prepareVoidReconversion("runtime-void-reconversion");
    const runtimeDb = createDatabase(runtimeDatabaseUrlForTesting(databaseUrl));
    try {
      const receipt = await confirmWithDatabase(runtimeDb, setup.command, "runtime-void-reconversion");
      expect(receipt.error).toBeUndefined();
      expect(receipt).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });
      const paymentFactId = (receipt.result!.transferPaymentFactIds as string[])[0]!;
      const transferId = (receipt.result!.transferIds as string[])[0]!;

      await expect(sql`
        UPDATE membership_payment_facts
        SET created_at = created_at
        WHERE fact_id = ${paymentFactId}
      `.execute(runtimeDb)).rejects.toThrow(/membership_payment_facts is append-only/i);
      await expect(sql`
        UPDATE stay_collection_membership_transfers
        SET created_at = created_at
        WHERE id = ${transferId}
      `.execute(runtimeDb)).rejects.toThrow(/stay_collection_membership_transfers is append-only/i);
      await expect(sql`
        UPDATE membership_payment_facts
        SET fact_id = fact_id
        WHERE fact_id = ${paymentFactId}
      `.execute(runtimeDb)).rejects.toThrow(/permission denied/i);
      await expect(sql`
        UPDATE stay_collection_membership_transfers
        SET id = id
        WHERE id = ${transferId}
      `.execute(runtimeDb)).rejects.toThrow(/permission denied/i);
    } finally {
      await runtimeDb.destroy();
    }
  });

  it("corrects a member profile through an append-only revision and never rewrites historical order occupants", async () => {
    const before = await db.selectFrom("members").selectAll().where("id", "=", demo.memberId).executeTakeFirstOrThrow();
    const conflictingMemberId = await createMember("profile-conflict");
    const conflictingMember = await db.selectFrom("members").select(["id", "phone"])
      .where("id", "=", conflictingMemberId).executeTakeFirstOrThrow();
    const occupantsBefore = await db.selectFrom("order_occupants").selectAll().orderBy("id").execute();
    const command = envelope("CORRECT_MEMBER_PROFILE", {
      propertyId: demo.propertyId,
      memberId: demo.memberId,
      expectedPriorProfile: {
        fullName: before.full_name,
        nickname: before.nickname,
        identityCardNumber: before.identity_card_number,
        phone: before.phone,
        wechat: before.wechat
      },
      correctedProfile: {
        fullName: "Demo Member Corrected",
        nickname: "演示会员已核对",
        identityCardNumber: "DEMO-ID-CORRECTED",
        phone: "13800000009",
        wechat: "qintopia-demo-member-corrected"
      },
      evidenceNote: "本人证件与企微资料复核"
    });

    await expect(preview(command, "profile-ordinary", ordinaryStaff)).rejects.toMatchObject({
      code: "INSUFFICIENT_ACCESS"
    });
    const receipt = await confirm(command, "profile-correct");
    expect(receipt).toMatchObject({ businessCommitted: true, executionStatus: "EXECUTED" });
    expect(receipt.result).toMatchObject({
      memberId: demo.memberId,
      correctionId: expect.any(String),
      changedFields: ["fullName", "nickname", "identityCardNumber", "phone", "wechat"],
      before: {
        fullName: before.full_name,
        nickname: before.nickname,
        identityCardNumber: null,
        phone: "138****0000",
        wechat: "q***er"
      },
      after: {
        fullName: "Demo Member Corrected",
        nickname: "演示会员已核对",
        identityCardNumber: "*************CTED",
        phone: "138****0009",
        wechat: "q***ed"
      },
      reason: { code: "DATA_ENTRY_CORRECTION", note: "管理员复核 profile-correct" },
      evidenceNote: command.input.evidenceNote,
      actor: { subjectId: demo.administratorSubjectId, displayName: "Demo Administrator" },
      recordedAt: expect.any(String)
    });

    const current = await db.selectFrom("members").selectAll().where("id", "=", demo.memberId).executeTakeFirstOrThrow();
    expect(current).toMatchObject({
      full_name: "Demo Member Corrected",
      nickname: "演示会员已核对",
      identity_card_number: "DEMO-ID-CORRECTED",
      phone: "13800000009",
      wechat: "qintopia-demo-member-corrected"
    });
    const corrections = await sql<{
      member_id: string;
      prior_phone: string;
      corrected_phone: string;
      command_id: string;
    }>`select member_id, prior_phone, corrected_phone, command_id from member_profile_corrections where member_id = ${demo.memberId}`.execute(db);
    expect(corrections.rows).toEqual([expect.objectContaining({
      member_id: demo.memberId,
      prior_phone: before.phone,
      corrected_phone: "13800000009",
      command_id: receipt.commandId
    })]);
    expect((await getMemberView(db, demo.propertyId, demo.memberId)).profileCorrections)
      .toEqual([expect.objectContaining({ id: receipt.result!.correctionId, command_id: receipt.commandId })]);
    expect(await db.selectFrom("order_occupants").selectAll().orderBy("id").execute()).toEqual(occupantsBefore);

    const conflicting = envelope("CORRECT_MEMBER_PROFILE", {
      ...command.input,
      expectedPriorProfile: command.input.correctedProfile,
      correctedProfile: { ...(command.input.correctedProfile as object), phone: conflictingMember.phone }
    });
    await expect(preview(conflicting, "profile-phone-conflict")).rejects.toMatchObject({
      code: "VALIDATION_ERROR"
    });
  });

  it("serializes two members concurrently claiming the same previously unused phone", async () => {
    const [firstMemberId, secondMemberId] = await Promise.all([
      createMember("profile-phone-race-first"),
      createMember("profile-phone-race-second")
    ]);
    const members = await db.selectFrom("members").selectAll()
      .where("id", "in", [firstMemberId, secondMemberId]).orderBy("id").execute();
    const targetPhone = "13900009999";
    const commandFor = (member: (typeof members)[number]) => envelope("CORRECT_MEMBER_PROFILE", {
      propertyId: demo.propertyId,
      memberId: member.id,
      expectedPriorProfile: {
        fullName: member.full_name,
        nickname: member.nickname,
        identityCardNumber: member.identity_card_number,
        phone: member.phone,
        wechat: member.wechat
      },
      correctedProfile: {
        fullName: member.full_name,
        nickname: member.nickname,
        identityCardNumber: member.identity_card_number,
        phone: targetPhone,
        wechat: member.wechat
      },
      evidenceNote: "并发手机号纠正只能由一个会员取得"
    });
    const commands = members.map(commandFor);
    const previews = await Promise.all(commands.map((command, index) =>
      preview(command, `profile-phone-race-${index + 1}`)));
    const receipts = await Promise.all(previews.map((prepared, index) =>
      confirmCommandPreview(db, administrator, prepared.preview.previewId, {
        propertyId: demo.propertyId,
        commandType: "CORRECT_MEMBER_PROFILE",
        confirmation: true,
        expectedEffectHash: prepared.preview.effectHash,
        reason: { code: "DATA_ENTRY_CORRECTION", note: "并发手机号归属复核" }
      }, metadata(`profile-phone-race-${index + 1}-confirm`))));

    const successful = receipts.filter((receipt) => receipt.businessCommitted && receipt.executionStatus === "EXECUTED");
    const rejected = receipts.filter((receipt) => !receipt.businessCommitted && receipt.executionStatus === "NOT_EXECUTED");
    expect(successful).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      error: { code: "PREVIEW_STALE" },
      resourceRefs: [],
      factRefs: []
    });
    const winnerId = successful[0]!.result!.memberId as string;
    const loserId = members.find((member) => member.id !== winnerId)!.id;
    expect(await db.selectFrom("members").select(["id", "phone"])
      .where("id", "in", [firstMemberId, secondMemberId]).orderBy("id").execute())
      .toEqual(expect.arrayContaining([
        { id: winnerId, phone: targetPhone },
        { id: loserId, phone: members.find((member) => member.id === loserId)!.phone }
      ]));
    expect(await db.selectFrom("member_profile_corrections").select(["member_id", "corrected_phone", "command_id"])
      .where("member_id", "in", [firstMemberId, secondMemberId]).execute())
      .toEqual([{ member_id: winnerId, corrected_phone: targetPhone, command_id: successful[0]!.commandId }]);
    expect(JSON.stringify(await membershipCommandBusinessGraphSnapshot())).not.toContain(rejected[0]!.commandId);
  });

  it("rejects global profile correction for a member linked to another property at application and SQL boundaries", async () => {
    const member = await db.selectFrom("members").selectAll()
      .where("id", "=", demo.memberId).executeTakeFirstOrThrow();
    const command = envelope("CORRECT_MEMBER_PROFILE", {
      propertyId: demo.propertyId,
      memberId: demo.memberId,
      expectedPriorProfile: {
        fullName: member.full_name,
        nickname: member.nickname,
        identityCardNumber: member.identity_card_number,
        phone: member.phone,
        wechat: member.wechat
      },
      correctedProfile: {
        fullName: member.full_name,
        nickname: "不得跨门店共享的资料纠正",
        identityCardNumber: member.identity_card_number,
        phone: member.phone,
        wechat: member.wechat
      },
      evidenceNote: "跨门店会员资料共享规则尚未设计"
    });
    const prepared = await preview(command, "profile-single-property-before-link");
    const otherPropertyId = "prop_profile_correction_other";
    await db.insertInto("properties").values({
      id: otherPropertyId,
      code: "PROFILE-OTHER",
      name: "Profile correction other property",
      timezone: "Asia/Shanghai",
      currency: "CNY"
    }).execute();
    await db.insertInto("member_property_links").values({
      member_id: demo.memberId,
      property_id: otherPropertyId
    }).execute();
    const before = await membershipCommandBusinessGraphSnapshot();

    const receipt = await confirmCommandPreview(db, administrator, prepared.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: command.commandType,
      confirmation: true,
      expectedEffectHash: prepared.preview.effectHash,
      reason: { code: "DATA_ENTRY_CORRECTION", note: "锁后必须重验唯一物业关联" }
    }, metadata("profile-single-property-confirm"));
    expect(receipt).toMatchObject({
      executionStatus: "NOT_EXECUTED",
      businessCommitted: false,
      error: { code: "PREVIEW_STALE" },
      resourceRefs: [],
      factRefs: []
    });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);

    await expect(preview(command, "profile-single-property-existing-link")).rejects.toMatchObject({
      code: "ENTITLEMENT_CONFLICT",
      message: expect.stringContaining("其他门店")
    });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);

    await expect(applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBER_PROFILE",
      effect: prepared.preview.effect as Record<string, unknown>,
      basisVersions: await previewBasisVersions(prepared.preview.previewId),
      label: "profile-single-property-forged-sql"
    })).rejects.toMatchObject({
      constraint: "member_profile_correction_single_property_scope"
    });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);

    const lateLinkMemberId = await createMember("profile-late-property-link");
    const lateLinkMember = await db.selectFrom("members").selectAll()
      .where("id", "=", lateLinkMemberId).executeTakeFirstOrThrow();
    const lateLinkCommand = envelope("CORRECT_MEMBER_PROFILE", {
      propertyId: demo.propertyId,
      memberId: lateLinkMemberId,
      expectedPriorProfile: {
        fullName: lateLinkMember.full_name,
        nickname: lateLinkMember.nickname,
        identityCardNumber: lateLinkMember.identity_card_number,
        phone: lateLinkMember.phone,
        wechat: lateLinkMember.wechat
      },
      correctedProfile: {
        fullName: lateLinkMember.full_name,
        nickname: "延迟插入关联也必须拒绝",
        identityCardNumber: lateLinkMember.identity_card_number,
        phone: lateLinkMember.phone,
        wechat: lateLinkMember.wechat
      },
      evidenceNote: "不能在提前校验纠正根后追加第二物业关联"
    });
    const lateLinkPrepared = await preview(lateLinkCommand, "profile-late-property-link");
    const beforeLateLinkGraph = await membershipCommandBusinessGraphSnapshot();
    await expect(applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBER_PROFILE",
      effect: lateLinkPrepared.preview.effect as Record<string, unknown>,
      basisVersions: await previewBasisVersions(lateLinkPrepared.preview.previewId),
      label: "profile-late-property-link-forged-sql",
      afterGraph: async (trx) => {
        await sql`SET CONSTRAINTS member_profile_corrections_validate_graph IMMEDIATE`.execute(trx);
        await trx.insertInto("member_property_links").values({
          member_id: lateLinkMemberId,
          property_id: otherPropertyId
        }).execute();
      }
    })).rejects.toMatchObject({
      constraint: "member_profile_correction_single_property_scope"
    });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(beforeLateLinkGraph);
  });

  it("moves one active membership interval atomically while keeping lifecycle, money, usage, and balance unchanged", async () => {
    const propertyToday = await propertyLocalToday(db, demo.propertyId);
    const actualMembershipDate = shiftLocalDate(propertyToday, -30);
    const expectedValidUntil = addCalendarYear(actualMembershipDate);
    const [orderBefore, contractBefore, lotBefore, paymentsBefore, ledgerBefore, viewBefore] = await Promise.all([
      db.selectFrom("membership_orders").selectAll().where("id", "=", demo.membershipOrderId).executeTakeFirstOrThrow(),
      db.selectFrom("member_contracts").selectAll().where("id", "=", demo.memberContractId).executeTakeFirstOrThrow(),
      db.selectFrom("entitlement_lots").selectAll().where("id", "=", demo.roomLotId).executeTakeFirstOrThrow(),
      db.selectFrom("membership_payment_facts").selectAll().where("membership_order_id", "=", demo.membershipOrderId).orderBy("fact_id").execute(),
      db.selectFrom("entitlement_ledger").selectAll().where("lot_id", "=", demo.roomLotId).orderBy("fact_id").execute(),
      getMemberView(db, demo.propertyId, demo.memberId)
    ]);
    const command = envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: demo.membershipOrderId,
      actualMembershipDate,
      evidenceNote: "企微收款凭证日期与合同原件一致"
    });

    const prepared = await preview(command, "effective-date");
    expect(prepared.preview.effect).toMatchObject({
      operation: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      membershipOrderId: demo.membershipOrderId,
      before: { validFrom: orderBefore.valid_from, validUntil: orderBefore.valid_until, status: "ACTIVE" },
      after: { validFrom: actualMembershipDate, validUntil: expectedValidUntil, status: "ACTIVE" },
      unchanged: { availableBalance: viewBefore.availableBalance }
    });
    const receipt = await confirmCommandPreview(db, administrator, prepared.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: command.commandType,
      confirmation: true,
      expectedEffectHash: prepared.preview.effectHash,
      reason: { code: "DATA_ENTRY_CORRECTION", note: "核对真实办卡日期" }
    }, metadata("effective-date-confirm"));
    expect(receipt.businessCommitted).toBe(true);
    expect(receipt.result).toMatchObject({
      before: prepared.preview.effect.before,
      after: prepared.preview.effect.after,
      unchanged: prepared.preview.effect.unchanged,
      reason: { code: "DATA_ENTRY_CORRECTION", note: "核对真实办卡日期" },
      evidenceNote: command.input.evidenceNote,
      actor: { subjectId: demo.administratorSubjectId, displayName: "Demo Administrator" },
      recordedAt: expect.any(String)
    });

    const orderAfter = await db.selectFrom("membership_orders").selectAll()
      .where("id", "=", demo.membershipOrderId).executeTakeFirstOrThrow();
    expect(orderAfter).toMatchObject({
      id: orderBefore.id,
      status: orderBefore.status,
      valid_from: actualMembershipDate,
      valid_until: expectedValidUntil,
      version: orderBefore.version + 1
    });
    expect(orderAfter.activated_at).toEqual(orderBefore.activated_at);
    expect(await db.selectFrom("member_contracts").selectAll().where("id", "=", demo.memberContractId).executeTakeFirstOrThrow())
      .toMatchObject({ ...contractBefore, valid_from: actualMembershipDate, valid_until: expectedValidUntil, status: "ACTIVE", version: contractBefore.version + 1 });
    expect(await db.selectFrom("entitlement_lots").selectAll().where("id", "=", demo.roomLotId).executeTakeFirstOrThrow())
      .toMatchObject({ ...lotBefore, expires_on: expectedValidUntil, version: lotBefore.version + 1 });
    expect(await db.selectFrom("membership_payment_facts").selectAll().where("membership_order_id", "=", demo.membershipOrderId).orderBy("fact_id").execute())
      .toEqual(paymentsBefore);
    expect(await db.selectFrom("entitlement_ledger").selectAll().where("lot_id", "=", demo.roomLotId).orderBy("fact_id").execute())
      .toEqual(ledgerBefore);
    const viewAfter = await getMemberView(db, demo.propertyId, demo.memberId);
    expect(viewAfter.availableBalance).toEqual(viewBefore.availableBalance);
    expect(viewAfter.effectiveDateCorrections).toEqual([expect.objectContaining({
      id: receipt.result!.correctionId,
      membership_order_id: demo.membershipOrderId,
      corrected_valid_from: actualMembershipDate
    })]);

    const expiredDate = shiftLocalDate(propertyToday, -400);
    await expect(preview(envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: demo.membershipOrderId,
      actualMembershipDate: expiredDate,
      evidenceNote: "该日期会触发过期，首版必须拒绝"
    }), "effective-date-expired")).rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
  });

  it("corrects a membership created by the standard completed-stay conversion graph", async () => {
    const conversion = await createCompletedStandardConversion("effective-date-standard-conversion");
    const correctedMembershipDate = shiftLocalDate(conversion.sourceStay.arrivalDate, -1);
    const viewBefore = await getMemberView(db, demo.propertyId, conversion.member.id);
    const ledgerBefore = await db.selectFrom("entitlement_ledger").selectAll()
      .where("lot_id", "=", conversion.entitlementLotId).orderBy("fact_id").execute();

    const receipt = await confirm(envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: conversion.membershipOrderId,
      actualMembershipDate: correctedMembershipDate,
      evidenceNote: "普通历史住宿转会员的命令图可唯一追溯"
    }), "effective-date-standard-conversion");

    expect(receipt).toMatchObject({
      businessCommitted: true,
      executionStatus: "EXECUTED",
      result: {
        membershipOrderId: conversion.membershipOrderId,
        validFrom: correctedMembershipDate,
        unchanged: { usedUnits: 2, availableBalance: viewBefore.availableBalance }
      }
    });
    expect(await db.selectFrom("entitlement_ledger").selectAll()
      .where("lot_id", "=", conversion.entitlementLotId).orderBy("fact_id").execute())
      .toEqual(ledgerBefore);
  });

  it("allows effective-date correction for entitlement consumed by BACKFILL_COMPLETED_STAY", async () => {
    const stay = await createDemoMemberStay("effective-date-backfill-completed", false);
    const completeCommand = envelope("COMPLETE_STAY", {
      propertyId: demo.propertyId,
      orderId: stay.orderId,
      actualStayCompletedConfirmed: true,
      reasonNote: "历史版本一次完成住宿的合法权益来源"
    });
    const completed = await withPropertyClockForTesting(
      new Date(`${stay.departureDate}T12:00:00+08:00`),
      async () => {
        const prepared = await preview(completeCommand, "effective-date-backfill-completed", ordinaryStaff);
        return confirmCommandPreview(db, ordinaryStaff, prepared.preview.previewId, {
          propertyId: demo.propertyId,
          commandType: "COMPLETE_STAY",
          confirmation: true,
          expectedEffectHash: prepared.preview.effectHash,
          reason: { code: "COMPLETE_STAY", note: "历史版本一次完成住宿的合法权益来源" }
        }, metadata("effective-date-backfill-completed-confirm"));
      }
    );
    expect(completed).toMatchObject({ businessCommitted: true, executionStatus: "EXECUTED" });
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await trx.updateTable("command_executions")
        .set({ command_type: "BACKFILL_COMPLETED_STAY" })
        .where("id", "=", completed.commandId).execute();
      await trx.updateTable("audit_entries")
        .set({ action: "BACKFILL_COMPLETED_STAY" })
        .where("command_id", "=", completed.commandId)
        .where("decision", "=", "ALLOWED").execute();
    });

    const receipt = await confirm(envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: demo.membershipOrderId,
      actualMembershipDate: shiftLocalDate(stay.businessDate, -30),
      evidenceNote: "兼容旧版本一次完成住宿产生的合法权益核销"
    }), "effective-date-backfill-completed-correction");
    expect(receipt).toMatchObject({ businessCommitted: true, executionStatus: "EXECUTED" });
  });

  it("rejects effective-date correction when an ordinary member stay is missing one complete coverage lifecycle", async () => {
    const stay = await createDemoMemberStay("effective-date-missing-complete-lifecycle", true);
    const command = envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: demo.membershipOrderId,
      actualMembershipDate: shiftLocalDate(stay.businessDate, -30),
      evidenceNote: "普通会员住宿必须保留每一晚完整 coverage 与 ledger 生命周期"
    });
    const prepared = await preview(command, "effective-date-missing-complete-lifecycle-frozen");
    const removedCoverage = await db.selectFrom("coverage_items").select("id")
      .where("order_id", "=", stay.orderId).orderBy("service_date").executeTakeFirstOrThrow();
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await trx.deleteFrom("entitlement_ledger")
        .where("coverage_id", "=", removedCoverage.id).execute();
      await trx.deleteFrom("coverage_items").where("id", "=", removedCoverage.id).execute();
    });
    const before = await membershipCommandBusinessGraphSnapshot();

    await expect(preview(command, "effective-date-missing-complete-lifecycle-application"))
      .rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    const frozen = await refreshFrozenEffectiveDateEvidence(prepared);
    await expect(applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      effect: frozen.effect,
      basisVersions: frozen.basisVersions,
      label: "effective-date-missing-complete-lifecycle-sql"
    })).rejects.toMatchObject({ constraint: "membership_effective_date_correction_exact_chain" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("rejects a completed-stay conversion whose uncovered service-date set is incomplete", async () => {
    const conversion = await createCompletedStandardConversion("effective-date-missing-conversion-night");
    const command = envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: conversion.membershipOrderId,
      actualMembershipDate: shiftLocalDate(conversion.sourceStay.arrivalDate, -1),
      evidenceNote: "历史住宿转换必须逐晚保留完整核销集合"
    });
    const prepared = await preview(command, "effective-date-missing-conversion-night-frozen");
    const conversionFacts = await db.selectFrom("entitlement_ledger").select("fact_id")
      .where("lot_id", "=", conversion.entitlementLotId)
      .where("entry_type", "=", "CONVERSION_CONSUME")
      .where("coverage_id", "is", null)
      .orderBy("service_date").execute();
    expect(conversionFacts).toHaveLength(2);
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await trx.deleteFrom("entitlement_ledger")
        .where("fact_id", "=", conversionFacts[0]!.fact_id).execute();
    });
    const before = await membershipCommandBusinessGraphSnapshot();

    await expect(preview(command, "effective-date-missing-conversion-night-application"))
      .rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    const frozen = await refreshFrozenEffectiveDateEvidence(prepared, {
      entitlementLotId: conversion.entitlementLotId,
      memberId: conversion.member.id
    });
    await expect(applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      effect: frozen.effect,
      basisVersions: frozen.basisVersions,
      label: "effective-date-missing-conversion-night-sql"
    })).rejects.toMatchObject({ constraint: "membership_effective_date_correction_exact_chain" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("rejects a completed-stay conversion whose entire conversion fact set is missing", async () => {
    const conversion = await createCompletedStandardConversion("effective-date-missing-all-conversion-nights");
    const command = envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: conversion.membershipOrderId,
      actualMembershipDate: shiftLocalDate(conversion.sourceStay.arrivalDate, -1),
      evidenceNote: "转换创建的会员不能把空核销集合当成未使用权益"
    });
    const prepared = await preview(command, "effective-date-missing-all-conversion-nights-frozen");
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await trx.deleteFrom("entitlement_ledger")
        .where("lot_id", "=", conversion.entitlementLotId)
        .where("entry_type", "=", "CONVERSION_CONSUME").execute();
    });
    const before = await membershipCommandBusinessGraphSnapshot();

    await expect(preview(command, "effective-date-missing-all-conversion-nights-application"))
      .rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    const frozen = await refreshFrozenEffectiveDateEvidence(prepared, {
      entitlementLotId: conversion.entitlementLotId,
      memberId: conversion.member.id
    });
    await expect(applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      effect: frozen.effect,
      basisVersions: frozen.basisVersions,
      label: "effective-date-missing-all-conversion-nights-sql"
    })).rejects.toMatchObject({ constraint: "membership_effective_date_correction_exact_chain" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("rejects SQL effective-date correction when conversion amendment serviceDates differ from conversion facts", async () => {
    const conversion = await createCompletedStandardConversion("effective-date-conversion-amendment-dates");
    const command = envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: conversion.membershipOrderId,
      actualMembershipDate: shiftLocalDate(conversion.sourceStay.arrivalDate, -1),
      evidenceNote: "转换 amendment 的服务日必须与核销事实完全一致"
    });
    const prepared = await preview(command, "effective-date-conversion-amendment-dates-frozen");
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await trx.updateTable("amendments")
        .set({ payload: sql`jsonb_set(payload, '{entitlement,serviceDates}', '[]'::jsonb, false)` })
        .where("command_id", "=", conversion.commandId).execute();
    });
    const before = await membershipCommandBusinessGraphSnapshot();

    await expect(preview(command, "effective-date-conversion-amendment-dates-application"))
      .rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    await expect(applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      effect: prepared.preview.effect as Record<string, unknown>,
      basisVersions: await previewBasisVersions(prepared.preview.previewId),
      label: "effective-date-conversion-amendment-dates-sql"
    })).rejects.toMatchObject({ constraint: "membership_effective_date_correction_exact_chain" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it.each([
    {
      label: "covered",
      createConversion: () => createInHouseStandardConversion("effective-date-covered-wrong-mode"),
      wrongMode: "COMPLETED"
    },
    {
      label: "uncovered",
      createConversion: () => createCompletedStandardConversion("effective-date-uncovered-wrong-mode"),
      wrongMode: "IN_HOUSE"
    }
  ])("rejects a $label standard conversion whose receipt mode contradicts its entitlement graph", async ({
    createConversion,
    label,
    wrongMode
  }) => {
    const conversion = await createConversion();
    const command = envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: conversion.membershipOrderId,
      actualMembershipDate: shiftLocalDate(conversion.sourceStay.arrivalDate, -1),
      evidenceNote: `标准 ${label} 转换的 Receipt 模式必须与权益图一致`
    });
    const prepared = await preview(command, `effective-date-${label}-wrong-mode-frozen`);
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await trx.updateTable("command_receipts")
        .set({ result: sql`jsonb_set(result, '{conversionMode}', to_jsonb(${wrongMode}::text), false)` })
        .where("command_id", "=", conversion.commandId).execute();
    });
    const before = await membershipCommandBusinessGraphSnapshot();

    const previewError = await preview(command, `effective-date-${label}-wrong-mode-application`)
      .then(() => undefined, (error: unknown) => error);
    const sqlError = await applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      effect: prepared.preview.effect as Record<string, unknown>,
      basisVersions: await previewBasisVersions(prepared.preview.previewId),
      label: `effective-date-${label}-wrong-mode-sql`
    }).then(() => undefined, (error: unknown) => error);

    expect(previewError).toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    expect(sqlError).toMatchObject({ constraint: "membership_effective_date_correction_exact_chain" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("rejects a covered standard conversion whose source order lost its member link", async () => {
    const conversion = await createInHouseStandardConversion("effective-date-covered-missing-member");
    const command = envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: conversion.membershipOrderId,
      actualMembershipDate: shiftLocalDate(conversion.sourceStay.arrivalDate, -1),
      evidenceNote: "在住转换来源订单必须仍与目标会员唯一关联"
    });
    const prepared = await preview(command, "effective-date-covered-missing-member-frozen");
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await trx.updateTable("orders").set({ member_id: null })
        .where("id", "=", conversion.sourceStay.orderId).execute();
    });
    const before = await membershipCommandBusinessGraphSnapshot();

    const previewError = await preview(command, "effective-date-covered-missing-member-application")
      .then(() => undefined, (error: unknown) => error);
    const sqlError = await applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      effect: prepared.preview.effect as Record<string, unknown>,
      basisVersions: await previewBasisVersions(prepared.preview.previewId),
      label: "effective-date-covered-missing-member-sql"
    }).then(() => undefined, (error: unknown) => error);

    expect(previewError).toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    expect(sqlError).toMatchObject({ constraint: "membership_effective_date_correction_exact_chain" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("corrects a membership created by a standard in-house conversion without rewriting coverage", async () => {
    const conversion = await createInHouseStandardConversion("effective-date-in-house-conversion");
    const correctedMembershipDate = shiftLocalDate(conversion.sourceStay.arrivalDate, -1);
    const viewBefore = await getMemberView(db, demo.propertyId, conversion.member.id);
    const [coverageBefore, ledgerBefore] = await Promise.all([
      db.selectFrom("coverage_items").selectAll()
        .where("lot_id", "=", conversion.entitlementLotId)
        .orderBy("service_date").orderBy("id").execute(),
      db.selectFrom("entitlement_ledger").selectAll()
        .where("lot_id", "=", conversion.entitlementLotId)
        .orderBy("created_at").orderBy("fact_id").execute()
    ]);
    expect(coverageBefore.length).toBeGreaterThan(0);
    expect(coverageBefore.every((item) => item.status === "CONSUMED")).toBe(true);
    expect(ledgerBefore.filter((item) => item.entry_type === "CONVERSION_CONSUME"))
      .toHaveLength(coverageBefore.length);
    expect(ledgerBefore.filter((item) => item.entry_type === "CONVERSION_CONSUME")
      .every((item) => item.coverage_id !== null && item.command_id === conversion.commandId)).toBe(true);
    const conversionCoverage = await db.selectFrom("coverage_items")
      .innerJoin("pricing_revisions", "pricing_revisions.id", "coverage_items.held_by_revision_id")
      .innerJoin("amendments", "amendments.id", "pricing_revisions.amendment_id")
      .select([
        "coverage_items.id",
        "coverage_items.contract_id",
        "coverage_items.lot_id",
        "amendments.command_id",
        "amendments.amendment_type"
      ])
      .where("coverage_items.lot_id", "=", conversion.entitlementLotId)
      .orderBy("coverage_items.service_date").execute();
    expect(conversionCoverage).toEqual(coverageBefore.map((item) => ({
      id: item.id,
      contract_id: conversion.contractId,
      lot_id: conversion.entitlementLotId,
      command_id: conversion.commandId,
      amendment_type: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"
    })));

    const receipt = await confirm(envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: conversion.membershipOrderId,
      actualMembershipDate: correctedMembershipDate,
      evidenceNote: "在住转换生成的 coverage 与权益核销链已完整核对"
    }), "effective-date-in-house-conversion");

    expect(receipt).toMatchObject({
      businessCommitted: true,
      executionStatus: "EXECUTED",
      result: {
        membershipOrderId: conversion.membershipOrderId,
        validFrom: correctedMembershipDate,
        unchanged: {
          usedUnits: coverageBefore.length,
          availableBalance: viewBefore.availableBalance
        }
      }
    });
    expect(await db.selectFrom("coverage_items").selectAll()
      .where("lot_id", "=", conversion.entitlementLotId)
      .orderBy("service_date").orderBy("id").execute()).toEqual(coverageBefore);
    expect(await db.selectFrom("entitlement_ledger").selectAll()
      .where("lot_id", "=", conversion.entitlementLotId)
      .orderBy("created_at").orderBy("fact_id").execute()).toEqual(ledgerBefore);
  });

  it("returns PREVIEW_STALE when an in-house source stay checks out after effective-date Preview", async () => {
    const conversion = await createInHouseStandardConversion("effective-date-source-checkout-stale");
    const command = envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: conversion.membershipOrderId,
      actualMembershipDate: shiftLocalDate(conversion.sourceStay.arrivalDate, -1),
      evidenceNote: "主管确认前来源住宿生命周期不得静默变化"
    });
    const prepared = await preview(command, "effective-date-source-checkout-stale");
    const checkout = await withPropertyClockForTesting(
      new Date(`${conversion.sourceStay.departureDate}T12:00:00+08:00`),
      () => confirm(envelope("CHECK_OUT", {
        propertyId: demo.propertyId,
        orderId: conversion.sourceStay.orderId
      }), "effective-date-source-checkout-stale-checkout", ordinaryStaff)
    );
    expect(checkout).toMatchObject({ businessCommitted: true, executionStatus: "EXECUTED" });
    const before = await membershipCommandBusinessGraphSnapshot();

    const rejected = await confirmCommandPreview(db, administrator, prepared.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: command.commandType,
      confirmation: true,
      expectedEffectHash: prepared.preview.effectHash,
      reason: { code: "DATA_ENTRY_CORRECTION", note: "来源住宿已变化，旧核对页必须失效" }
    }, metadata("effective-date-source-checkout-stale-confirm"));
    expect(rejected).toMatchObject({
      businessCommitted: false,
      executionStatus: "NOT_EXECUTED",
      error: { code: "PREVIEW_STALE" },
      resourceRefs: [],
      factRefs: []
    });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("rejects a non-exact source amendment set before and during effective-date correction", async () => {
    const stay = await createDemoMemberStay("effective-date-extra-source-amendment", true);
    const command = envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: demo.membershipOrderId,
      actualMembershipDate: shiftLocalDate(stay.businessDate, -30),
      evidenceNote: "每条权益来源命令只能保留规定的 amendment 集合"
    });
    const prepared = await preview(command, "effective-date-extra-source-amendment-frozen");
    const consumeCommandId = (await db.selectFrom("entitlement_ledger").select("command_id")
      .where("order_id", "=", stay.orderId).where("entry_type", "=", "CONSUME")
      .executeTakeFirstOrThrow()).command_id!;
    const sourceAmendment = await db.selectFrom("amendments").selectAll()
      .where("command_id", "=", consumeCommandId).executeTakeFirstOrThrow();
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await trx.insertInto("amendments").values({
        id: `amendment-extra-${sequence}`,
        order_id: sourceAmendment.order_id,
        sequence: sourceAmendment.sequence + 100,
        amendment_type: "CHECK_OUT",
        reason_code: sourceAmendment.reason_code,
        reason_note: sourceAmendment.reason_note,
        prior_version: sourceAmendment.prior_version,
        new_version: sourceAmendment.new_version,
        payload: sourceAmendment.payload,
        command_id: consumeCommandId
      }).execute();
    });
    const before = await membershipCommandBusinessGraphSnapshot();

    await expect(preview(command, "effective-date-extra-source-amendment-application"))
      .rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    const frozen = await refreshFrozenEffectiveDateEvidence(prepared);
    await expect(applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      effect: frozen.effect,
      basisVersions: frozen.basisVersions,
      label: "effective-date-extra-source-amendment-sql"
    })).rejects.toMatchObject({ constraint: "membership_effective_date_correction_exact_chain" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("rejects duplicate conversion revision cardinality before and during effective-date correction", async () => {
    const conversion = await createInHouseStandardConversion("effective-date-extra-conversion-revision");
    const command = envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: conversion.membershipOrderId,
      actualMembershipDate: shiftLocalDate(conversion.sourceStay.arrivalDate, -1),
      evidenceNote: "转换 amendment 必须且只能绑定一条定价 revision"
    });
    const prepared = await preview(command, "effective-date-extra-conversion-revision-frozen");
    const revision = await db.selectFrom("pricing_revisions")
      .innerJoin("amendments", "amendments.id", "pricing_revisions.amendment_id")
      .selectAll("pricing_revisions").where("amendments.command_id", "=", conversion.commandId)
      .executeTakeFirstOrThrow();
    const { created_at: _createdAt, ...revisionValues } = revision;
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await trx.insertInto("pricing_revisions").values({
        ...revisionValues,
        id: `revision-extra-${sequence}`,
        revision_no: revision.revision_no + 100
      }).execute();
    });
    const before = await membershipCommandBusinessGraphSnapshot();

    await expect(preview(command, "effective-date-extra-conversion-revision-application"))
      .rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    const frozen = await refreshFrozenEffectiveDateEvidence(prepared, {
      entitlementLotId: conversion.entitlementLotId,
      memberId: conversion.member.id
    });
    await expect(applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      effect: frozen.effect,
      basisVersions: frozen.basisVersions,
      label: "effective-date-extra-conversion-revision-sql"
    })).rejects.toMatchObject({ constraint: "membership_effective_date_correction_exact_chain" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("rejects an in-house conversion coverage rebound to a pre-conversion revision", async () => {
    const conversion = await createInHouseStandardConversion("effective-date-in-house-wrong-revision");
    const command = envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: conversion.membershipOrderId,
      actualMembershipDate: shiftLocalDate(conversion.sourceStay.arrivalDate, -1),
      evidenceNote: "在住转换 coverage 必须绑定原转换 revision"
    });
    const prepared = await preview(command, "effective-date-in-house-wrong-revision-frozen");
    const coverage = await db.selectFrom("coverage_items").selectAll()
      .where("lot_id", "=", conversion.entitlementLotId)
      .orderBy("service_date").executeTakeFirstOrThrow();
    const priorRevision = await db.selectFrom("pricing_revisions").select("id")
      .where("order_id", "=", conversion.sourceStay.orderId)
      .where("id", "!=", coverage.held_by_revision_id)
      .where("arrival_date", "=", conversion.sourceStay.arrivalDate)
      .where("departure_date", "=", conversion.sourceStay.departureDate)
      .orderBy("created_at", "desc").executeTakeFirstOrThrow();
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await trx.updateTable("coverage_items").set({ held_by_revision_id: priorRevision.id })
        .where("id", "=", coverage.id).execute();
    });
    const before = await membershipCommandBusinessGraphSnapshot();

    await expect(preview(command, "effective-date-in-house-wrong-revision-application"))
      .rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    const frozen = await refreshFrozenEffectiveDateEvidence(prepared, {
      entitlementLotId: conversion.entitlementLotId,
      memberId: conversion.member.id
    });
    await expect(applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      effect: frozen.effect,
      basisVersions: frozen.basisVersions,
      label: "effective-date-in-house-wrong-revision-sql"
    })).rejects.toMatchObject({ constraint: "membership_effective_date_correction_exact_chain" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("rejects a coverage-backed conversion whose quantity delta is corrupted", async () => {
    const conversion = await createInHouseStandardConversion("effective-date-in-house-wrong-delta");
    const command = envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: conversion.membershipOrderId,
      actualMembershipDate: shiftLocalDate(conversion.sourceStay.arrivalDate, -1),
      evidenceNote: "在住转换每个 coverage 必须严格核销一个权益单位"
    });
    const prepared = await preview(command, "effective-date-in-house-wrong-delta-frozen");
    const conversionFact = await db.selectFrom("entitlement_ledger").select("fact_id")
      .where("lot_id", "=", conversion.entitlementLotId)
      .where("entry_type", "=", "CONVERSION_CONSUME")
      .orderBy("fact_id").executeTakeFirstOrThrow();
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await trx.updateTable("entitlement_ledger").set({ quantity_delta: -2 })
        .where("fact_id", "=", conversionFact.fact_id).execute();
    });
    const before = await membershipCommandBusinessGraphSnapshot();

    await expect(preview(command, "effective-date-in-house-wrong-delta-application"))
      .rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    const frozen = await refreshFrozenEffectiveDateEvidence(prepared, {
      entitlementLotId: conversion.entitlementLotId,
      memberId: conversion.member.id
    });
    await expect(applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      effect: frozen.effect,
      basisVersions: frozen.basisVersions,
      label: "effective-date-in-house-wrong-delta-sql"
    })).rejects.toMatchObject({ constraint: "membership_effective_date_correction_exact_chain" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it.each([
    { entryType: "HOLD" as const, mutation: "missing-command" as const },
    { entryType: "CONSUME" as const, mutation: "wrong-reason" as const }
  ])("rejects a $entryType lifecycle fact with $mutation provenance", async ({ entryType, mutation }) => {
    const stay = await createDemoMemberStay(`effective-date-${entryType.toLowerCase()}-${mutation}`, true);
    const command = envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: demo.membershipOrderId,
      actualMembershipDate: shiftLocalDate(stay.businessDate, -30),
      evidenceNote: "普通会员住宿权益事实必须保留 typed 命令来源"
    });
    const prepared = await preview(command, `effective-date-${entryType}-${mutation}-frozen`);
    const lifecycleFact = await db.selectFrom("entitlement_ledger").select("fact_id")
      .where("order_id", "=", stay.orderId)
      .where("entry_type", "=", entryType)
      .orderBy("fact_id").executeTakeFirstOrThrow();
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await trx.updateTable("entitlement_ledger").set(mutation === "missing-command"
        ? { command_id: null }
        : { reason: "TAMPERED_ENTITLEMENT_PROVENANCE" })
        .where("fact_id", "=", lifecycleFact.fact_id).execute();
    });
    const before = await membershipCommandBusinessGraphSnapshot();

    await expect(preview(command, `effective-date-${entryType}-${mutation}-application`))
      .rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    const frozen = await refreshFrozenEffectiveDateEvidence(prepared);
    await expect(applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      effect: frozen.effect,
      basisVersions: frozen.basisVersions,
      label: `effective-date-${entryType}-${mutation}-sql`
    })).rejects.toMatchObject({ constraint: "membership_effective_date_correction_exact_chain" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("preserves a same-day revoked check-in lifecycle while correcting the membership date", async () => {
    const stay = await createDemoMemberStay("effective-date-revoked-check-in", true);
    await confirm(envelope("REVOKE_CHECK_IN", {
      propertyId: demo.propertyId,
      orderId: stay.orderId,
      unusedRoomConfirmed: true
    }), "effective-date-revoked-check-in", ordinaryStaff);
    const [coverageBefore, ledgerBefore, viewBefore] = await Promise.all([
      db.selectFrom("coverage_items").selectAll().where("order_id", "=", stay.orderId)
        .orderBy("service_date").execute(),
      db.selectFrom("entitlement_ledger").selectAll().where("order_id", "=", stay.orderId)
        .orderBy("created_at").orderBy("fact_id").execute(),
      getMemberView(db, demo.propertyId, demo.memberId)
    ]);
    expect(coverageBefore).toHaveLength(2);
    expect(coverageBefore.every((item) => item.status === "CONSUMED")).toBe(true);
    expect(ledgerBefore.filter((item) => item.entry_type === "RESTORE")).toHaveLength(2);

    const correctedMembershipDate = shiftLocalDate(stay.businessDate, -30);
    const receipt = await confirm(envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: demo.membershipOrderId,
      actualMembershipDate: correctedMembershipDate,
      evidenceNote: "撤销入住已返还余额，但保留历史核销与返还事实"
    }), "effective-date-revoked-check-in-correction");

    expect(receipt).toMatchObject({
      businessCommitted: true,
      executionStatus: "EXECUTED",
      result: {
        unchanged: { usedUnits: 2, availableBalance: viewBefore.availableBalance }
      }
    });
    expect(await db.selectFrom("coverage_items").selectAll().where("order_id", "=", stay.orderId)
      .orderBy("service_date").execute()).toEqual(coverageBefore);
    expect(await db.selectFrom("entitlement_ledger").selectAll().where("order_id", "=", stay.orderId)
      .orderBy("created_at").orderBy("fact_id").execute()).toEqual(ledgerBefore);
  });

  it("ignores earlier RESCHEDULE releases when validating a same-day revoked check-in", async () => {
    const stay = await createDemoMemberStay("effective-date-rescheduled-revoked-check-in");
    const rescheduledDepartureDate = shiftLocalDate(stay.businessDate, 1);
    await confirm(envelope("RESCHEDULE_STAY", {
      propertyId: demo.propertyId,
      orderId: stay.orderId,
      newArrivalDate: stay.businessDate,
      newDepartureDate: rescheduledDepartureDate
    }), "effective-date-rescheduled-revoked-check-in-reschedule", ordinaryStaff);
    await confirm(envelope("CHECK_IN", {
      propertyId: demo.propertyId,
      orderId: stay.orderId
    }), "effective-date-rescheduled-revoked-check-in-check-in", ordinaryStaff);
    await confirm(envelope("REVOKE_CHECK_IN", {
      propertyId: demo.propertyId,
      orderId: stay.orderId,
      unusedRoomConfirmed: true
    }), "effective-date-rescheduled-revoked-check-in-revoke", ordinaryStaff);
    const [coverageBefore, ledgerBefore, viewBefore] = await Promise.all([
      db.selectFrom("coverage_items").selectAll().where("order_id", "=", stay.orderId)
        .orderBy("service_date").orderBy("id").execute(),
      db.selectFrom("entitlement_ledger").selectAll().where("order_id", "=", stay.orderId)
        .orderBy("created_at").orderBy("fact_id").execute(),
      getMemberView(db, demo.propertyId, demo.memberId)
    ]);
    const released = ledgerBefore.filter((item) => item.entry_type === "RELEASE");
    const consumed = ledgerBefore.filter((item) => item.entry_type === "CONSUME");
    const restored = ledgerBefore.filter((item) => item.entry_type === "RESTORE");
    expect(released).toHaveLength(1);
    expect(consumed).toHaveLength(1);
    expect(restored).toHaveLength(consumed.length);
    expect(restored.every((restore) => consumed.some((consume) => consume.coverage_id === restore.coverage_id)))
      .toBe(true);
    expect(restored.some((restore) => released.some((release) => release.coverage_id === restore.coverage_id)))
      .toBe(false);

    const correctedMembershipDate = shiftLocalDate(stay.businessDate, -30);
    const receipt = await confirm(envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: demo.membershipOrderId,
      actualMembershipDate: correctedMembershipDate,
      evidenceNote: "撤销入住只返还实际核销过的 coverage，不重复返还改期已释放权益"
    }), "effective-date-rescheduled-revoked-check-in-correction");

    expect(receipt).toMatchObject({
      businessCommitted: true,
      executionStatus: "EXECUTED",
      result: {
        unchanged: { usedUnits: consumed.length, availableBalance: viewBefore.availableBalance }
      }
    });
    expect(await db.selectFrom("coverage_items").selectAll().where("order_id", "=", stay.orderId)
      .orderBy("service_date").orderBy("id").execute()).toEqual(coverageBefore);
    expect(await db.selectFrom("entitlement_ledger").selectAll().where("order_id", "=", stay.orderId)
      .orderBy("created_at").orderBy("fact_id").execute()).toEqual(ledgerBefore);
  });

  it("rejects a revoked check-in whose RESTORE set no longer covers every restored entitlement", async () => {
    const stay = await createDemoMemberStay("effective-date-revoked-missing-restore", true);
    await confirm(envelope("REVOKE_CHECK_IN", {
      propertyId: demo.propertyId,
      orderId: stay.orderId,
      unusedRoomConfirmed: true
    }), "effective-date-revoked-missing-restore", ordinaryStaff);
    const command = envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: demo.membershipOrderId,
      actualMembershipDate: shiftLocalDate(stay.businessDate, -30),
      evidenceNote: "撤销入住必须逐晚保留完整的权益返还集合"
    });
    const prepared = await preview(command, "effective-date-revoked-missing-restore-frozen");
    const restoreFacts = await db.selectFrom("entitlement_ledger").select("fact_id")
      .where("order_id", "=", stay.orderId).where("entry_type", "=", "RESTORE")
      .orderBy("service_date").execute();
    expect(restoreFacts).toHaveLength(2);
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await trx.deleteFrom("entitlement_ledger")
        .where("fact_id", "=", restoreFacts[0]!.fact_id).execute();
    });
    const before = await membershipCommandBusinessGraphSnapshot();
    const frozen = await refreshFrozenEffectiveDateEvidence(prepared);

    const previewError = await preview(command, "effective-date-revoked-missing-restore-application")
      .then(() => undefined, (error: unknown) => error);
    const sqlError = await applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      effect: frozen.effect,
      basisVersions: frozen.basisVersions,
      label: "effective-date-revoked-missing-restore-sql"
    }).then(() => undefined, (error: unknown) => error);

    expect(previewError).toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    expect(sqlError).toMatchObject({ constraint: "membership_effective_date_correction_exact_chain" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("rejects a revoked check-in whose entire RESTORE set was removed", async () => {
    const stay = await createDemoMemberStay("effective-date-revoked-no-restores", true);
    const revokeReceipt = await confirm(envelope("REVOKE_CHECK_IN", {
      propertyId: demo.propertyId,
      orderId: stay.orderId,
      unusedRoomConfirmed: true
    }), "effective-date-revoked-no-restores", ordinaryStaff);
    const command = envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: demo.membershipOrderId,
      actualMembershipDate: shiftLocalDate(stay.businessDate, -30),
      evidenceNote: "撤销入住不能在全部权益返还事实消失后伪装为完整历史"
    });
    const prepared = await preview(command, "effective-date-revoked-no-restores-frozen");
    const restoreFacts = await db.selectFrom("entitlement_ledger").select("fact_id")
      .where("command_id", "=", revokeReceipt.commandId)
      .where("entry_type", "=", "RESTORE").execute();
    expect(restoreFacts).toHaveLength(2);
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await trx.deleteFrom("entitlement_ledger")
        .where("fact_id", "in", restoreFacts.map((item) => item.fact_id)).execute();
    });
    const before = await membershipCommandBusinessGraphSnapshot();
    const frozen = await refreshFrozenEffectiveDateEvidence(prepared);

    const previewError = await preview(command, "effective-date-revoked-no-restores-application")
      .then(() => undefined, (error: unknown) => error);
    const sqlError = await applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      effect: frozen.effect,
      basisVersions: frozen.basisVersions,
      label: "effective-date-revoked-no-restores-sql"
    }).then(() => undefined, (error: unknown) => error);

    expect(previewError).toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    expect(sqlError).toMatchObject({ constraint: "membership_effective_date_correction_exact_chain" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it.each([
    { label: "unused-room-confirmation", jsonPath: "unusedRoomConfirmed" as const },
    { label: "business-date", jsonPath: "businessDate" as const }
  ])("rejects a revoked check-in whose $label evidence was tampered", async ({ jsonPath, label }) => {
    const stay = await createDemoMemberStay(`effective-date-revoked-wrong-${label}`, true);
    await confirm(envelope("REVOKE_CHECK_IN", {
      propertyId: demo.propertyId,
      orderId: stay.orderId,
      unusedRoomConfirmed: true
    }), `effective-date-revoked-wrong-${label}`, ordinaryStaff);
    const command = envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: demo.membershipOrderId,
      actualMembershipDate: shiftLocalDate(stay.businessDate, -30),
      evidenceNote: "撤销入住的未使用确认和营业日期必须保留原始事实"
    });
    const prepared = await preview(command, `effective-date-revoked-wrong-${label}-frozen`);
    const revoke = await db.selectFrom("amendments").select("command_id")
      .where("order_id", "=", stay.orderId)
      .where("amendment_type", "=", "REVOKE_CHECK_IN").executeTakeFirstOrThrow();
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      if (jsonPath === "unusedRoomConfirmed") {
        await trx.updateTable("amendments")
          .set({ payload: sql`jsonb_set(payload, '{unusedRoomConfirmed}', 'false'::jsonb, false)` })
          .where("command_id", "=", revoke.command_id).execute();
      } else {
        await trx.updateTable("amendments")
          .set({ payload: sql`jsonb_set(payload, '{businessDate}', to_jsonb(${shiftLocalDate(stay.businessDate, 1)}::text), false)` })
          .where("command_id", "=", revoke.command_id).execute();
      }
    });
    const before = await membershipCommandBusinessGraphSnapshot();

    const previewError = await preview(command, `effective-date-revoked-wrong-${label}-application`)
      .then(() => undefined, (error: unknown) => error);
    const sqlError = await applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      effect: prepared.preview.effect as Record<string, unknown>,
      basisVersions: await previewBasisVersions(prepared.preview.previewId),
      label: `effective-date-revoked-wrong-${label}-sql`
    }).then(() => undefined, (error: unknown) => error);

    expect(previewError).toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    expect(sqlError).toMatchObject({ constraint: "membership_effective_date_correction_exact_chain" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it.each([
    { label: "unused-room boolean", target: "amendment" as const },
    { label: "coverage-count number", target: "receipt" as const }
  ])("rejects a revoked check-in whose $label was replaced by a JSON string", async ({ label, target }) => {
    const stay = await createDemoMemberStay(`effective-date-revoked-string-${target}`, true);
    const revokeReceipt = await confirm(envelope("REVOKE_CHECK_IN", {
      propertyId: demo.propertyId,
      orderId: stay.orderId,
      unusedRoomConfirmed: true
    }), `effective-date-revoked-string-${target}`, ordinaryStaff);
    const command = envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: demo.membershipOrderId,
      actualMembershipDate: shiftLocalDate(stay.businessDate, -30),
      evidenceNote: "撤销入住证据必须保留原始 JSON 类型，不能用同文本字符串替代"
    });
    const prepared = await preview(command, `effective-date-revoked-string-${target}-frozen`);
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      if (target === "amendment") {
        await trx.updateTable("amendments").set({
          payload: sql`jsonb_set(payload, '{unusedRoomConfirmed}', to_jsonb('true'::text), false)`
        }).where("command_id", "=", revokeReceipt.commandId).execute();
      } else {
        await trx.updateTable("command_receipts").set({
          result: sql`jsonb_set(
            result,
            '{entitlementTransition,coverageCount}',
            to_jsonb((result #>> '{entitlementTransition,coverageCount}')::text),
            false
          )`
        }).where("command_id", "=", revokeReceipt.commandId).execute();
      }
    });
    const before = await membershipCommandBusinessGraphSnapshot();

    const previewError = await preview(command, `effective-date-revoked-string-${target}-application`)
      .then(() => undefined, (error: unknown) => error);
    const sqlError = await applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      effect: prepared.preview.effect as Record<string, unknown>,
      basisVersions: await previewBasisVersions(prepared.preview.previewId),
      label: `effective-date-revoked-string-${target}-sql`
    }).then(() => undefined, (error: unknown) => error);

    expect(previewError).toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    expect(sqlError).toMatchObject({ constraint: "membership_effective_date_correction_exact_chain" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("corrects the membership date after a typed in-house early checkout", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const arrivalDate = shiftLocalDate(businessDate, -1);
    const departureDate = shiftLocalDate(businessDate, 3);
    const conversion = await createInHouseStandardConversion("effective-date-shortened-positive", {
      businessDate,
      arrivalDate,
      departureDate
    });
    const shorteningReceipt = await withPropertyClockForTesting(new Date(`${businessDate}T12:00:00+08:00`), () => confirm(envelope("SHORTEN_STAY", {
      propertyId: demo.propertyId,
      orderId: conversion.sourceStay.orderId,
      newDepartureDate: businessDate
    }), "effective-date-shortened-positive", ordinaryStaff));
    expect(shorteningReceipt).toMatchObject({ businessCommitted: true, executionStatus: "EXECUTED" });
    const [coverageBefore, ledgerBefore] = await Promise.all([
      db.selectFrom("coverage_items").selectAll()
        .where("lot_id", "=", conversion.entitlementLotId)
        .orderBy("service_date").orderBy("id").execute(),
      db.selectFrom("entitlement_ledger").selectAll()
        .where("lot_id", "=", conversion.entitlementLotId)
        .orderBy("created_at").orderBy("fact_id").execute()
    ]);
    expect(coverageBefore.filter((item) => item.status === "RELEASED")).toHaveLength(3);
    expect(ledgerBefore.filter((item) => item.entry_type === "RESTORE")).toHaveLength(3);

    const receipt = await confirm(envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: conversion.membershipOrderId,
      actualMembershipDate: shiftLocalDate(arrivalDate, -1),
      evidenceNote: "在住转换早退后的逐晚返还事实已完整核对"
    }), "effective-date-shortened-positive-correction");

    expect(receipt).toMatchObject({ businessCommitted: true, executionStatus: "EXECUTED" });
    expect(await db.selectFrom("coverage_items").selectAll()
      .where("lot_id", "=", conversion.entitlementLotId)
      .orderBy("service_date").orderBy("id").execute()).toEqual(coverageBefore);
    expect(await db.selectFrom("entitlement_ledger").selectAll()
      .where("lot_id", "=", conversion.entitlementLotId)
      .orderBy("created_at").orderBy("fact_id").execute()).toEqual(ledgerBefore);
  });

  it("corrects the membership date after an ordinary typed SHORTEN with no entitlement writes", async () => {
    const { businessDate, orderId, shorteningReceipt } = await createOrdinaryShortenedMemberStay(
      "effective-date-ordinary-shorten"
    );
    expect(shorteningReceipt).toMatchObject({ businessCommitted: true, executionStatus: "EXECUTED" });
    expect(await db.selectFrom("entitlement_ledger").selectAll()
      .where("command_id", "=", shorteningReceipt.commandId).execute()).toEqual([]);
    const [coverageBefore, ledgerBefore] = await Promise.all([
      db.selectFrom("coverage_items").selectAll().where("order_id", "=", orderId)
        .orderBy("service_date").orderBy("id").execute(),
      db.selectFrom("entitlement_ledger").selectAll().where("order_id", "=", orderId)
        .orderBy("created_at").orderBy("fact_id").execute()
    ]);

    const receipt = await confirm(envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: demo.membershipOrderId,
      actualMembershipDate: shiftLocalDate(businessDate, -30),
      evidenceNote: "普通会员缩短住宿没有权益返还写入，仍须保留原权益事实"
    }), "effective-date-ordinary-shorten-correction");

    expect(receipt).toMatchObject({ businessCommitted: true, executionStatus: "EXECUTED" });
    expect(await db.selectFrom("coverage_items").selectAll().where("order_id", "=", orderId)
      .orderBy("service_date").orderBy("id").execute()).toEqual(coverageBefore);
    expect(await db.selectFrom("entitlement_ledger").selectAll().where("order_id", "=", orderId)
      .orderBy("created_at").orderBy("fact_id").execute()).toEqual(ledgerBefore);
  });

  it("rejects an ordinary SHORTEN that was forged to release member entitlement", async () => {
    const { businessDate, orderId, shorteningReceipt } =
      await createOrdinaryShortenedMemberStay("effective-date-ordinary-shorten-forged-release");
    const command = envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: demo.membershipOrderId,
      actualMembershipDate: shiftLocalDate(businessDate, -30),
      evidenceNote: "普通缩短住宿不得伪造会员权益释放事实"
    });
    const prepared = await preview(command, "effective-date-ordinary-shorten-forged-release-frozen");
    const coverage = await db.selectFrom("coverage_items").selectAll()
      .where("order_id", "=", orderId)
      .orderBy("service_date", "desc").executeTakeFirstOrThrow();
    const consumed = await db.selectFrom("entitlement_ledger").select("fact_id")
      .where("coverage_id", "=", coverage.id)
      .where("entry_type", "=", "CONSUME").executeTakeFirstOrThrow();
    const forgedReleaseFactId = `forged-ordinary-shorten-release-${sequence}`;
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await trx.deleteFrom("entitlement_ledger").where("fact_id", "=", consumed.fact_id).execute();
      await trx.updateTable("coverage_items").set({ status: "RELEASED" })
        .where("id", "=", coverage.id).execute();
      await trx.insertInto("entitlement_ledger").values({
        fact_id: forgedReleaseFactId,
        lot_id: coverage.lot_id,
        entry_type: "RELEASE",
        quantity_delta: 1,
        service_date: coverage.service_date,
        order_id: orderId,
        coverage_id: coverage.id,
        reason: "ORDER_COVERAGE_RELEASE",
        command_id: shorteningReceipt.commandId
      }).execute();
      await trx.updateTable("command_receipts").set({
        fact_refs: sql`fact_refs || jsonb_build_array(${forgedReleaseFactId}::text)`,
        resource_refs: sql`resource_refs || jsonb_build_array(${coverage.id}::text)`
      }).where("command_id", "=", shorteningReceipt.commandId).execute();
    });
    const before = await membershipCommandBusinessGraphSnapshot();
    const frozen = await refreshFrozenEffectiveDateEvidence(prepared);

    const previewError = await preview(command, "effective-date-ordinary-shorten-forged-release-application")
      .then(() => undefined, (error: unknown) => error);
    const sqlError = await applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      effect: frozen.effect,
      basisVersions: frozen.basisVersions,
      label: "effective-date-ordinary-shorten-forged-release-sql"
    }).then(() => undefined, (error: unknown) => error);

    expect(previewError).toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    expect(sqlError).toMatchObject({ constraint: "membership_effective_date_correction_exact_chain" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it.each([
    { label: "business-date", jsonPath: "businessDate" as const },
    { label: "after-departure", jsonPath: "afterDepartureDate" as const }
  ])("rejects a converted SHORTEN whose $label evidence is missing", async ({ jsonPath, label }) => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const arrivalDate = shiftLocalDate(businessDate, -1);
    const conversion = await createInHouseStandardConversion(`effective-date-shorten-missing-${label}`, {
      businessDate,
      arrivalDate,
      departureDate: shiftLocalDate(businessDate, 3)
    });
    const shorteningReceipt = await withPropertyClockForTesting(new Date(`${businessDate}T12:00:00+08:00`), () => confirm(envelope("SHORTEN_STAY", {
      propertyId: demo.propertyId,
      orderId: conversion.sourceStay.orderId,
      newDepartureDate: businessDate
    }), `effective-date-shorten-missing-${label}`, ordinaryStaff));
    const command = envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: conversion.membershipOrderId,
      actualMembershipDate: shiftLocalDate(arrivalDate, -1),
      evidenceNote: "缩短住宿的营业日期与新退房日期必须完整保留"
    });
    const prepared = await preview(command, `effective-date-shorten-missing-${label}-frozen`);
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      if (jsonPath === "businessDate") {
        await sql`UPDATE amendments SET payload = payload #- '{businessDate}' WHERE command_id = ${shorteningReceipt.commandId}`.execute(trx);
      } else {
        await sql`UPDATE amendments SET payload = payload #- '{after,departureDate}' WHERE command_id = ${shorteningReceipt.commandId}`.execute(trx);
      }
    });
    const before = await membershipCommandBusinessGraphSnapshot();

    const previewError = await preview(command, `effective-date-shorten-missing-${label}-application`)
      .then(() => undefined, (error: unknown) => error);
    const sqlError = await applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      effect: prepared.preview.effect as Record<string, unknown>,
      basisVersions: await previewBasisVersions(prepared.preview.previewId),
      label: `effective-date-shorten-missing-${label}-sql`
    }).then(() => undefined, (error: unknown) => error);

    expect(previewError).toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    expect(sqlError).toMatchObject({ constraint: "membership_effective_date_correction_exact_chain" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("rejects a converted SHORTEN whose payload and RESTORE chronology are both reversed", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const arrivalDate = shiftLocalDate(businessDate, -1);
    const conversion = await createInHouseStandardConversion("effective-date-shorten-reversed-dates", {
      businessDate,
      arrivalDate,
      departureDate: shiftLocalDate(businessDate, 3)
    });
    const shorteningReceipt = await withPropertyClockForTesting(new Date(`${businessDate}T12:00:00+08:00`), () => confirm(envelope("SHORTEN_STAY", {
      propertyId: demo.propertyId,
      orderId: conversion.sourceStay.orderId,
      newDepartureDate: businessDate
    }), "effective-date-shorten-reversed-dates", ordinaryStaff));
    const command = envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: conversion.membershipOrderId,
      actualMembershipDate: shiftLocalDate(arrivalDate, -1),
      evidenceNote: "缩短住宿返还日期必须保持生产者生成的规范升序"
    });
    const prepared = await preview(command, "effective-date-shorten-reversed-dates-frozen");
    const restoreFacts = await db.selectFrom("entitlement_ledger")
      .select(["fact_id", "service_date"])
      .where("command_id", "=", shorteningReceipt.commandId)
      .where("entry_type", "=", "RESTORE")
      .orderBy("service_date", "desc").execute();
    const reversedDates = restoreFacts.map((item) => item.service_date!);
    expect(reversedDates).toHaveLength(3);
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await trx.updateTable("amendments").set({
        payload: sql`jsonb_set(
          jsonb_set(payload, '{entitlementSummary,restoredFutureCoverageDates}', ${JSON.stringify(reversedDates)}::jsonb, false),
          '{inventoryChange,releasedDates}', ${JSON.stringify(reversedDates)}::jsonb, false
        )`
      }).where("command_id", "=", shorteningReceipt.commandId).execute();
      for (const [index, restore] of restoreFacts.entries()) {
        await trx.updateTable("entitlement_ledger")
          .set({ created_at: new Date(Date.UTC(2030, 0, 1, 0, 0, 0, index)) })
          .where("fact_id", "=", restore.fact_id).execute();
      }
    });
    const before = await membershipCommandBusinessGraphSnapshot();
    const frozen = await refreshFrozenEffectiveDateEvidence(prepared, {
      entitlementLotId: conversion.entitlementLotId,
      memberId: conversion.member.id
    });

    const previewError = await preview(command, "effective-date-shorten-reversed-dates-application")
      .then(() => undefined, (error: unknown) => error);
    const sqlError = await applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      effect: frozen.effect,
      basisVersions: frozen.basisVersions,
      label: "effective-date-shorten-reversed-dates-sql"
    }).then(() => undefined, (error: unknown) => error);

    expect(previewError).toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    expect(sqlError).toMatchObject({ constraint: "membership_effective_date_correction_exact_chain" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it.each(["not-a-date", "2026-13-40"])(
    "rejects malformed pricing coverage service date %s through the exact-chain constraint",
    async (invalidServiceDate) => {
      const stay = await createDemoMemberStay(`effective-date-invalid-coverage-${invalidServiceDate}`);
      const command = envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
        propertyId: demo.propertyId,
        membershipOrderId: demo.membershipOrderId,
        actualMembershipDate: shiftLocalDate(stay.businessDate, -30),
        evidenceNote: "定价 coverage 服务日格式错误时必须按完整事实链冲突处理"
      });
      const prepared = await preview(command, `effective-date-invalid-coverage-${invalidServiceDate}-frozen`);
      const sourceOrder = await db.selectFrom("orders").select("current_revision_id")
        .where("id", "=", stay.orderId).executeTakeFirstOrThrow();
      if (!sourceOrder.current_revision_id) throw new Error("Member stay is missing its pricing revision");
      await db.transaction().execute(async (trx) => {
        await sql`SET LOCAL session_replication_role = replica`.execute(trx);
        await trx.updateTable("pricing_revisions").set({
          coverage_set: sql`jsonb_set(coverage_set, '{0,serviceDate}', to_jsonb(${invalidServiceDate}::text), false)`
        }).where("id", "=", sourceOrder.current_revision_id).execute();
      });
      const before = await membershipCommandBusinessGraphSnapshot();

      const previewError = await preview(command, `effective-date-invalid-coverage-${invalidServiceDate}-application`)
        .then(() => undefined, (error: unknown) => error);
      const sqlError = await applyFrozenMemberCorrectionEffect({
        commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
        effect: prepared.preview.effect as Record<string, unknown>,
        basisVersions: await previewBasisVersions(prepared.preview.previewId),
        label: `effective-date-invalid-coverage-${invalidServiceDate}-sql`
      }).then(() => undefined, (error: unknown) => error);

      expect(previewError).toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
      expect(sqlError).toMatchObject({ constraint: "membership_effective_date_correction_exact_chain" });
      expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
    }
  );

  it("rejects a typed early-checkout RESTORE set repointed to a retained night", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const arrivalDate = shiftLocalDate(businessDate, -1);
    const departureDate = shiftLocalDate(businessDate, 3);
    const conversion = await createInHouseStandardConversion("effective-date-shortened-repointed", {
      businessDate,
      arrivalDate,
      departureDate
    });
    const shorteningReceipt = await withPropertyClockForTesting(new Date(`${businessDate}T12:00:00+08:00`), () => confirm(envelope("SHORTEN_STAY", {
      propertyId: demo.propertyId,
      orderId: conversion.sourceStay.orderId,
      newDepartureDate: businessDate
    }), "effective-date-shortened-repointed", ordinaryStaff));
    expect(shorteningReceipt).toMatchObject({ businessCommitted: true, executionStatus: "EXECUTED" });
    const command = envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: conversion.membershipOrderId,
      actualMembershipDate: shiftLocalDate(arrivalDate, -1),
      evidenceNote: "早退返还日期必须与 SHORTEN_STAY 的冻结集合一致"
    });
    const prepared = await preview(command, "effective-date-shortened-repointed-frozen");
    const retainedCoverage = await db.selectFrom("coverage_items").selectAll()
      .where("lot_id", "=", conversion.entitlementLotId)
      .where("service_date", "=", arrivalDate).executeTakeFirstOrThrow();
    const releasedCoverage = await db.selectFrom("coverage_items").selectAll()
      .where("lot_id", "=", conversion.entitlementLotId)
      .where("service_date", "=", businessDate).executeTakeFirstOrThrow();
    const restore = await db.selectFrom("entitlement_ledger").select("fact_id")
      .where("coverage_id", "=", releasedCoverage.id)
      .where("entry_type", "=", "RESTORE").executeTakeFirstOrThrow();
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await trx.updateTable("entitlement_ledger").set({
        coverage_id: retainedCoverage.id,
        service_date: retainedCoverage.service_date
      }).where("fact_id", "=", restore.fact_id).execute();
      await trx.updateTable("coverage_items").set({ status: "CONSUMED" })
        .where("id", "=", releasedCoverage.id).execute();
      await trx.updateTable("coverage_items").set({ status: "RELEASED" })
        .where("id", "=", retainedCoverage.id).execute();
    });
    const before = await membershipCommandBusinessGraphSnapshot();

    await expect(preview(command, "effective-date-shortened-repointed-application"))
      .rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    const frozen = await refreshFrozenEffectiveDateEvidence(prepared, {
      entitlementLotId: conversion.entitlementLotId,
      memberId: conversion.member.id
    });
    await expect(applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      effect: frozen.effect,
      basisVersions: frozen.basisVersions,
      label: "effective-date-shortened-repointed-sql"
    })).rejects.toMatchObject({ constraint: "membership_effective_date_correction_exact_chain" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it.each([
    { status: "ACTIVE" as const, label: "active" },
    { status: "VOIDED" as const, label: "voided" }
  ])("rejects effective-date correction when the contract has an additional $label entitlement lot", async ({ status, label }) => {
    const propertyToday = await propertyLocalToday(db, demo.propertyId);
    const order = await db.selectFrom("membership_orders").selectAll()
      .where("id", "=", demo.membershipOrderId).executeTakeFirstOrThrow();
    await db.insertInto("entitlement_lots").values({
      id: `lot-effective-date-independent-extra-${label}`,
      contract_id: order.contract_id!,
      unit_kind: "ROOM_NIGHT",
      total_units: 2,
      expires_on: order.valid_until!,
      status,
      version: 1
    }).execute();
    const before = await membershipCommandBusinessGraphSnapshot();

    await expect(preview(envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: demo.membershipOrderId,
      actualMembershipDate: shiftLocalDate(propertyToday, -30),
      evidenceNote: "附加权益有独立到期语义，不能随主权益一起猜测重算"
    }), `effective-date-extra-${label}-lot`)).rejects.toMatchObject({
      code: "ENTITLEMENT_CONFLICT",
      message: expect.stringContaining("额外权益记录")
    });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it.each([
    { label: "missing-service-date", entryType: "CONVERSION_CONSUME" as const, quantityDelta: -1, serviceDate: "missing" as const },
    { label: "out-of-range-service-date", entryType: "CONVERSION_CONSUME" as const, quantityDelta: -1, serviceDate: "before" as const },
    { label: "conversion-without-source-order", entryType: "CONVERSION_CONSUME" as const, quantityDelta: -1, serviceDate: "inside" as const },
    { label: "expire-fact", entryType: "EXPIRE" as const, quantityDelta: -2, serviceDate: "missing" as const },
    { label: "restore-without-coverage", entryType: "RESTORE" as const, quantityDelta: 1, serviceDate: "inside" as const }
  ])("rejects legacy $label entitlement facts before and during effective-date correction", async (scenario) => {
    const actualMembershipDate = shiftLocalDate(await propertyLocalToday(db, demo.propertyId), -30);
    const command = envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: demo.membershipOrderId,
      actualMembershipDate,
      evidenceNote: `旧数据图 ${scenario.label} 必须失败关闭`
    });
    const prepared = await preview(command, `effective-date-${scenario.label}-frozen`);
    await insertLegacyEffectiveDateLedgerAnomaly({
      factId: `legacy-effective-date-${scenario.label}`,
      entryType: scenario.entryType,
      quantityDelta: scenario.quantityDelta,
      serviceDate: scenario.serviceDate === "missing"
        ? null
        : scenario.serviceDate === "before"
          ? shiftLocalDate(actualMembershipDate, -1)
          : actualMembershipDate
    });
    const before = await membershipCommandBusinessGraphSnapshot();

    await expect(preview(command, `effective-date-${scenario.label}-application`))
      .rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    const frozen = await refreshFrozenEffectiveDateEvidence(prepared);
    await expect(applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      effect: frozen.effect,
      basisVersions: frozen.basisVersions,
      label: `effective-date-${scenario.label}-sql`
    })).rejects.toMatchObject({ constraint: "membership_effective_date_correction_exact_chain" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("rejects coverage with no complete entitlement lifecycle before and during effective-date correction", async () => {
    const actualMembershipDate = shiftLocalDate(await propertyLocalToday(db, demo.propertyId), -30);
    const command = envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: demo.membershipOrderId,
      actualMembershipDate,
      evidenceNote: "coverage 必须能由完整 ledger 生命周期唯一归属"
    });
    const prepared = await preview(command, "effective-date-orphan-coverage-frozen");
    const sourceStay = await createCompletedWecomStay({
      prefix: "effective-date-orphan-coverage",
      phone: "13900008888",
      documentNumber: "EFFECTIVE-DATE-ORPHAN-COVERAGE"
    });
    const sourceOrder = await db.selectFrom("orders").select("current_revision_id")
      .where("id", "=", sourceStay.orderId).executeTakeFirstOrThrow();
    if (!sourceOrder.current_revision_id) throw new Error("Source order is missing its current pricing revision");
    const sourceRevisionId = sourceOrder.current_revision_id;
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await trx.insertInto("coverage_items").values({
        id: "coverage-effective-date-orphan",
        order_id: sourceStay.orderId,
        contract_id: demo.memberContractId,
        lot_id: demo.roomLotId,
        inventory_unit_id: "unit_room_d_gen_01",
        service_date: sourceStay.arrivalDate,
        unit_kind: "ROOM_NIGHT",
        status: "HELD",
        held_by_revision_id: sourceRevisionId
      }).execute();
    });
    const before = await membershipCommandBusinessGraphSnapshot();

    await expect(preview(command, "effective-date-orphan-coverage-application"))
      .rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    const frozen = await refreshFrozenEffectiveDateEvidence(prepared);
    await expect(applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      effect: frozen.effect,
      basisVersions: frozen.basisVersions,
      label: "effective-date-orphan-coverage-sql"
    })).rejects.toMatchObject({ constraint: "membership_effective_date_correction_exact_chain" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("rejects a complete HOLD lifecycle whose coverage does not belong to the member order", async () => {
    const actualMembershipDate = shiftLocalDate(await propertyLocalToday(db, demo.propertyId), -30);
    const command = envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: demo.membershipOrderId,
      actualMembershipDate,
      evidenceNote: "coverage 数量守恒仍必须核对订单、会员、房型和 revision 归属"
    });
    const prepared = await preview(command, "effective-date-coverage-ownership-frozen");
    const sourceStay = await createCompletedWecomStay({
      prefix: "effective-date-coverage-ownership",
      phone: "13900007777",
      documentNumber: "EFFECTIVE-DATE-COVERAGE-OWNERSHIP"
    });
    const sourceOrder = await db.selectFrom("orders").select("current_revision_id")
      .where("id", "=", sourceStay.orderId).executeTakeFirstOrThrow();
    if (!sourceOrder.current_revision_id) throw new Error("Source order is missing its current pricing revision");
    const sourceRevisionId = sourceOrder.current_revision_id;
    const coverageId = "coverage-effective-date-wrong-owner";
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await trx.insertInto("coverage_items").values({
        id: coverageId,
        order_id: sourceStay.orderId,
        contract_id: demo.memberContractId,
        lot_id: demo.roomLotId,
        inventory_unit_id: "unit_room_d_gen_01",
        service_date: sourceStay.arrivalDate,
        unit_kind: "ROOM_NIGHT",
        status: "HELD",
        held_by_revision_id: sourceRevisionId
      }).execute();
      await trx.insertInto("entitlement_ledger").values({
        fact_id: "legacy-effective-date-wrong-owner-hold",
        lot_id: demo.roomLotId,
        entry_type: "HOLD",
        quantity_delta: -1,
        service_date: sourceStay.arrivalDate,
        order_id: sourceStay.orderId,
        coverage_id: coverageId,
        reason: "legacy imported wrong-owner hold",
        command_id: null
      }).execute();
    });
    const before = await membershipCommandBusinessGraphSnapshot();

    await expect(preview(command, "effective-date-coverage-ownership-application"))
      .rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    const frozen = await refreshFrozenEffectiveDateEvidence(prepared);
    await expect(applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      effect: frozen.effect,
      basisVersions: frozen.basisVersions,
      label: "effective-date-coverage-ownership-sql"
    })).rejects.toMatchObject({ constraint: "membership_effective_date_correction_exact_chain" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("rejects a target coverage referenced by an entitlement fact from another lot", async () => {
    const actualMembershipDate = shiftLocalDate(await propertyLocalToday(db, demo.propertyId), -30);
    const command = envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: demo.membershipOrderId,
      actualMembershipDate,
      evidenceNote: "coverage 不得被其他权益批次的 ledger 交叉引用"
    });
    const prepared = await preview(command, "effective-date-cross-lot-coverage-frozen");
    const sourceStay = await createCompletedWecomStay({
      prefix: "effective-date-cross-lot-coverage",
      phone: "13900006666",
      documentNumber: "EFFECTIVE-DATE-CROSS-LOT-COVERAGE"
    });
    const sourceOrder = await db.selectFrom("orders").select("current_revision_id")
      .where("id", "=", sourceStay.orderId).executeTakeFirstOrThrow();
    if (!sourceOrder.current_revision_id) throw new Error("Source order is missing its current pricing revision");
    const sourceRevisionId = sourceOrder.current_revision_id;
    const coverageId = "coverage-effective-date-cross-lot";
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await trx.insertInto("coverage_items").values({
        id: coverageId,
        order_id: sourceStay.orderId,
        contract_id: demo.memberContractId,
        lot_id: demo.roomLotId,
        inventory_unit_id: "unit_room_d_gen_01",
        service_date: sourceStay.arrivalDate,
        unit_kind: "ROOM_NIGHT",
        status: "HELD",
        held_by_revision_id: sourceRevisionId
      }).execute();
      await trx.insertInto("entitlement_ledger").values([
        {
          fact_id: "legacy-effective-date-target-hold",
          lot_id: demo.roomLotId,
          entry_type: "HOLD",
          quantity_delta: -1,
          service_date: sourceStay.arrivalDate,
          order_id: sourceStay.orderId,
          coverage_id: coverageId,
          reason: "legacy imported target hold",
          command_id: null
        },
        {
          fact_id: "legacy-effective-date-cross-lot-release",
          lot_id: "legacy-external-entitlement-lot",
          entry_type: "RELEASE",
          quantity_delta: 1,
          service_date: sourceStay.arrivalDate,
          order_id: sourceStay.orderId,
          coverage_id: coverageId,
          reason: "legacy imported cross-lot release",
          command_id: null
        }
      ]).execute();
    });
    const before = await membershipCommandBusinessGraphSnapshot();

    await expect(preview(command, "effective-date-cross-lot-coverage-application"))
      .rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    const frozen = await refreshFrozenEffectiveDateEvidence(prepared);
    await expect(applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      effect: frozen.effect,
      basisVersions: frozen.basisVersions,
      label: "effective-date-cross-lot-coverage-sql"
    })).rejects.toMatchObject({ constraint: "membership_effective_date_correction_exact_chain" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("rejects a foreign-lot ADJUST fact that points back to target coverage", async () => {
    const stay = await createDemoMemberStay("effective-date-foreign-adjust");
    const coverage = await db.selectFrom("coverage_items").selectAll()
      .where("order_id", "=", stay.orderId).orderBy("service_date").executeTakeFirstOrThrow();
    const actualMembershipDate = shiftLocalDate(stay.businessDate, -30);
    const command = envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: demo.membershipOrderId,
      actualMembershipDate,
      evidenceNote: "其他权益批次不得反向引用目标 coverage"
    });
    const prepared = await preview(command, "effective-date-foreign-adjust-frozen");
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await trx.insertInto("entitlement_ledger").values({
        fact_id: "legacy-effective-date-foreign-adjust",
        lot_id: "legacy-external-entitlement-lot-for-adjust",
        entry_type: "ADJUST",
        quantity_delta: 1,
        service_date: coverage.service_date,
        order_id: coverage.order_id,
        coverage_id: coverage.id,
        reason: "legacy imported foreign-lot adjustment",
        command_id: null
      }).execute();
    });
    const before = await membershipCommandBusinessGraphSnapshot();

    await expect(preview(command, "effective-date-foreign-adjust-application"))
      .rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    const frozen = await refreshFrozenEffectiveDateEvidence(prepared);
    await expect(applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      effect: frozen.effect,
      basisVersions: frozen.basisVersions,
      label: "effective-date-foreign-adjust-sql"
    })).rejects.toMatchObject({ constraint: "membership_effective_date_correction_exact_chain" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("rejects a legacy ADJUST fact that is disguised as a coverage lifecycle fact", async () => {
    const stay = await createDemoMemberStay("effective-date-adjust-coverage");
    const coverage = await db.selectFrom("coverage_items").selectAll()
      .where("order_id", "=", stay.orderId).orderBy("service_date").executeTakeFirstOrThrow();
    const actualMembershipDate = shiftLocalDate(stay.businessDate, -30);
    const command = envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: demo.membershipOrderId,
      actualMembershipDate,
      evidenceNote: "余额纠正不得伪装成某晚 coverage 的生命周期事实"
    });
    const prepared = await preview(command, "effective-date-adjust-coverage-frozen");
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await trx.insertInto("entitlement_ledger").values({
        fact_id: "legacy-effective-date-adjust-coverage",
        lot_id: demo.roomLotId,
        entry_type: "ADJUST",
        quantity_delta: 1,
        service_date: coverage.service_date,
        order_id: coverage.order_id,
        coverage_id: coverage.id,
        reason: "legacy imported malformed adjustment",
        command_id: null
      }).execute();
    });
    const before = await membershipCommandBusinessGraphSnapshot();

    await expect(preview(command, "effective-date-adjust-coverage-application"))
      .rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    const frozen = await refreshFrozenEffectiveDateEvidence(prepared);
    await expect(applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      effect: frozen.effect,
      basisVersions: frozen.basisVersions,
      label: "effective-date-adjust-coverage-sql"
    })).rejects.toMatchObject({ constraint: "membership_effective_date_correction_exact_chain" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("rejects coverage-backed conversion consumption without one typed conversion command", async () => {
    const stay = await createDemoMemberStay("effective-date-covered-conversion");
    const coverage = await db.selectFrom("coverage_items").selectAll()
      .where("order_id", "=", stay.orderId).orderBy("service_date").executeTakeFirstOrThrow();
    const actualMembershipDate = shiftLocalDate(stay.businessDate, -30);
    const command = envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: demo.membershipOrderId,
      actualMembershipDate,
      evidenceNote: "in-house 转会员核销必须能追溯到原转换命令"
    });
    const prepared = await preview(command, "effective-date-covered-conversion-frozen");
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await trx.deleteFrom("entitlement_ledger")
        .where("coverage_id", "=", coverage.id).where("entry_type", "=", "HOLD").execute();
      await trx.updateTable("coverage_items").set({ status: "CONSUMED" })
        .where("id", "=", coverage.id).execute();
      await trx.insertInto("entitlement_ledger").values({
        fact_id: "legacy-effective-date-covered-conversion",
        lot_id: coverage.lot_id,
        entry_type: "CONVERSION_CONSUME",
        quantity_delta: -1,
        service_date: coverage.service_date,
        order_id: coverage.order_id,
        coverage_id: coverage.id,
        reason: "STAY_COLLECTION_TO_MEMBERSHIP_CONSUMED",
        command_id: null
      }).execute();
    });
    const before = await membershipCommandBusinessGraphSnapshot();

    await expect(preview(command, "effective-date-covered-conversion-application"))
      .rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    const frozen = await refreshFrozenEffectiveDateEvidence(prepared);
    await expect(applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      effect: frozen.effect,
      basisVersions: frozen.basisVersions,
      label: "effective-date-covered-conversion-sql"
    })).rejects.toMatchObject({ constraint: "membership_effective_date_correction_exact_chain" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("rejects restored coverage whose typed command provenance was removed", async () => {
    const stay = await createDemoMemberStay("effective-date-restore-provenance", true);
    await confirm(envelope("REVOKE_CHECK_IN", {
      propertyId: demo.propertyId,
      orderId: stay.orderId,
      unusedRoomConfirmed: true
    }), "effective-date-restore-provenance", ordinaryStaff);
    const actualMembershipDate = shiftLocalDate(stay.businessDate, -30);
    const command = envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: demo.membershipOrderId,
      actualMembershipDate,
      evidenceNote: "权益返还必须保留原撤销入住命令来源"
    });
    const prepared = await preview(command, "effective-date-restore-provenance-frozen");
    const restore = await db.selectFrom("entitlement_ledger").select("fact_id")
      .where("order_id", "=", stay.orderId).where("entry_type", "=", "RESTORE")
      .orderBy("fact_id").executeTakeFirstOrThrow();
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await trx.updateTable("entitlement_ledger").set({ command_id: null })
        .where("fact_id", "=", restore.fact_id).execute();
    });
    const before = await membershipCommandBusinessGraphSnapshot();

    await expect(preview(command, "effective-date-restore-provenance-application"))
      .rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    const frozen = await refreshFrozenEffectiveDateEvidence(prepared);
    await expect(applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      effect: frozen.effect,
      basisVersions: frozen.basisVersions,
      label: "effective-date-restore-provenance-sql"
    })).rejects.toMatchObject({ constraint: "membership_effective_date_correction_exact_chain" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("keeps positive and negative adjustments separate from historical usage during date correction", async () => {
    const before = await getMemberView(db, demo.propertyId, demo.memberId);
    const initialBalance = before.availableBalance.ROOM_NIGHT;
    await confirm(envelope("CORRECT_MEMBER_ENTITLEMENT_BALANCE", {
      propertyId: demo.propertyId,
      entitlementLotId: demo.roomLotId,
      expectedAvailableBalance: initialBalance,
      targetAvailableBalance: initialBalance + 2,
      adjustmentReason: "核对发现应增加两间夜"
    }), "effective-date-positive-adjust", ordinaryStaff);
    await confirm(envelope("CORRECT_MEMBER_ENTITLEMENT_BALANCE", {
      propertyId: demo.propertyId,
      entitlementLotId: demo.roomLotId,
      expectedAvailableBalance: initialBalance + 2,
      targetAvailableBalance: initialBalance + 1,
      adjustmentReason: "复核后减少一间夜"
    }), "effective-date-negative-adjust", ordinaryStaff);

    const consumedFacts = await db.selectFrom("entitlement_ledger").select("fact_id")
      .where("lot_id", "=", demo.roomLotId)
      .where("entry_type", "in", ["CONSUME", "CONVERSION_CONSUME"])
      .execute();
    const adjustedView = await getMemberView(db, demo.propertyId, demo.memberId);
    const prepared = await preview(envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: demo.membershipOrderId,
      actualMembershipDate: shiftLocalDate(await propertyLocalToday(db, demo.propertyId), -30),
      evidenceNote: "权益调整与历史住宿核销分别核对"
    }), "effective-date-adjustments");

    expect(prepared.preview.effect).toMatchObject({
      unchanged: {
        usedUnits: consumedFacts.length,
        availableBalance: adjustedView.availableBalance
      }
    });
    const receipt = await confirmCommandPreview(db, administrator, prepared.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      confirmation: true,
      expectedEffectHash: prepared.preview.effectHash,
      reason: { code: "DATA_ENTRY_CORRECTION", note: "核对权益调整后纠正日期" }
    }, metadata("effective-date-adjustments-confirm"));
    expect(receipt).toMatchObject({ businessCommitted: true, executionStatus: "EXECUTED" });
    expect((await getMemberView(db, demo.propertyId, demo.memberId)).availableBalance)
      .toEqual(adjustedView.availableBalance);
  });

  it("cannot revive an ACTIVE projection whose prior interval is already expired", async () => {
    const memberId = await createMember("effective-date-expired-prior");
    const orderReceipt = await confirm({
      commandType: "CREATE_MEMBERSHIP_ORDER",
      input: {
        propertyId: demo.propertyId,
        memberId,
        membershipProductId: "membership_product_shared_bath_quad_v1",
        agreedPriceMinor: 93_600
      }
    }, "effective-date-expired-prior-order", ordinaryStaff);
    const membershipOrderId = orderReceipt.result!.membershipOrderId as string;
    await confirm({
      commandType: "RECORD_MEMBERSHIP_PAYMENT",
      input: {
        propertyId: demo.propertyId,
        membershipOrderId,
        amountMinor: 93_600,
        transactionReference: "WECOM-EFFECTIVE-DATE-EXPIRED-PRIOR"
      }
    }, "effective-date-expired-prior-payment", ordinaryStaff);
    await confirm({
      commandType: "ACTIVATE_MEMBERSHIP_ORDER",
      input: { propertyId: demo.propertyId, membershipOrderId }
    }, "effective-date-expired-prior-activate", ordinaryStaff);
    const activeOrder = await db.selectFrom("membership_orders").selectAll()
      .where("id", "=", membershipOrderId).executeTakeFirstOrThrow();
    const propertyToday = await propertyLocalToday(db, demo.propertyId);
    const correctedValidFrom = shiftLocalDate(propertyToday, -30);
    const command = envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId,
      actualMembershipDate: correctedValidFrom,
      evidenceNote: "旧有效期已自然过期时不得借纠正恢复权益"
    });
    const preparedWhileValid = await preview(command, "effective-date-expired-prior-frozen");
    const expiredValidFrom = shiftLocalDate(propertyToday, -400);
    const expiredValidUntil = addCalendarYear(expiredValidFrom);
    await forceActiveMembershipInterval({
      membershipOrderId,
      contractId: activeOrder.contract_id!,
      lotId: activeOrder.entitlement_lot_id!,
      validFrom: expiredValidFrom,
      validUntil: expiredValidUntil
    });

    const expiredView = await getMemberView(db, demo.propertyId, memberId);
    expect(expiredView.lotBalances).toEqual([
      expect.objectContaining({ lotId: activeOrder.entitlement_lot_id, availableUnits: 0 })
    ]);
    await expect(preview(command, "effective-date-expired-prior-application"))
      .rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });

    const frozenEffect = structuredClone(preparedWhileValid.preview.effect) as Record<string, unknown>;
    const prior = frozenEffect.before as Record<string, unknown>;
    prior.validFrom = expiredValidFrom;
    prior.validUntil = expiredValidUntil;
    const graphBefore = await membershipCommandBusinessGraphSnapshot();
    const forgedBasis = await previewBasisVersions(preparedWhileValid.preview.previewId);
    (forgedBasis.lot as Record<string, unknown>).expiresOn = expiredValidUntil;
    await expect(applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      effect: frozenEffect,
      basisVersions: forgedBasis,
      label: "expired-prior"
    })).rejects.toThrow(/membership date correction must preserve one exact active chain/i);
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(graphBefore);
    expect((await getMemberView(db, demo.propertyId, memberId)).lotBalances).toEqual(expiredView.lotBalances);
  });

  it("rejects a profile root whose evidence differs from the used Preview", async () => {
    const member = await db.selectFrom("members").selectAll().where("id", "=", demo.memberId).executeTakeFirstOrThrow();
    const prepared = await preview(envelope("CORRECT_MEMBER_PROFILE", {
      propertyId: demo.propertyId,
      memberId: member.id,
      expectedPriorProfile: {
        fullName: member.full_name,
        nickname: member.nickname,
        identityCardNumber: member.identity_card_number,
        phone: member.phone,
        wechat: member.wechat
      },
      correctedProfile: {
        fullName: member.full_name,
        nickname: `${member.nickname}-Preview绑定`,
        identityCardNumber: member.identity_card_number,
        phone: member.phone,
        wechat: member.wechat
      },
      evidenceNote: "已冻结的会员资料纠正证据"
    }), "profile-preview-root-binding");
    const before = await membershipCommandBusinessGraphSnapshot();
    await installMembershipCommandScopeAttack({
      table: "member_profile_corrections",
      timing: "BEFORE",
      body: "NEW.evidence_note := '数据库伪造的另一份资料证据';"
    });
    try {
      await expect(applyFrozenMemberCorrectionEffect({
        commandType: "CORRECT_MEMBER_PROFILE",
        effect: prepared.preview.effect as Record<string, unknown>,
        basisVersions: await previewBasisVersions(prepared.preview.previewId),
        label: "profile-preview-root-binding"
      })).rejects.toMatchObject({ constraint: "member_profile_correction_preview_binding" });
      expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
    } finally {
      await clearMembershipCommandScopeAttackTrigger();
    }
  });

  it("rejects a profile root when the ALLOWED audit effect hash does not identify its used Preview", async () => {
    const member = await db.selectFrom("members").selectAll().where("id", "=", demo.memberId).executeTakeFirstOrThrow();
    const prepared = await preview(envelope("CORRECT_MEMBER_PROFILE", {
      propertyId: demo.propertyId,
      memberId: member.id,
      expectedPriorProfile: {
        fullName: member.full_name,
        nickname: member.nickname,
        identityCardNumber: member.identity_card_number,
        phone: member.phone,
        wechat: member.wechat
      },
      correctedProfile: {
        fullName: member.full_name,
        nickname: `${member.nickname}-哈希绑定`,
        identityCardNumber: member.identity_card_number,
        phone: member.phone,
        wechat: member.wechat
      },
      evidenceNote: "会员资料纠正哈希必须绑定 Preview"
    }), "profile-preview-hash-binding");
    const before = await membershipCommandBusinessGraphSnapshot();

    await expect(applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBER_PROFILE",
      effect: prepared.preview.effect as Record<string, unknown>,
      basisVersions: await previewBasisVersions(prepared.preview.previewId),
      label: "profile-preview-hash-binding",
      auditEffectHash: "0".repeat(64)
    })).rejects.toMatchObject({ constraint: "member_profile_correction_preview_binding" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("binds a profile correction to the sequence baseline frozen in its Preview", async () => {
    const member = await db.selectFrom("members").selectAll().where("id", "=", demo.memberId).executeTakeFirstOrThrow();
    const prepared = await preview(envelope("CORRECT_MEMBER_PROFILE", {
      propertyId: demo.propertyId,
      memberId: member.id,
      expectedPriorProfile: {
        fullName: member.full_name,
        nickname: member.nickname,
        identityCardNumber: member.identity_card_number,
        phone: member.phone,
        wechat: member.wechat
      },
      correctedProfile: {
        fullName: member.full_name,
        nickname: `${member.nickname}-基线绑定`,
        identityCardNumber: member.identity_card_number,
        phone: member.phone,
        wechat: member.wechat
      },
      evidenceNote: "会员资料纠正必须使用 Preview 冻结的下一序号"
    }), "profile-preview-basis-binding");
    const forgedBasis = await previewBasisVersions(prepared.preview.previewId);
    forgedBasis.nextCorrectionSequence = 2;
    const before = await membershipCommandBusinessGraphSnapshot();

    await expect(applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBER_PROFILE",
      effect: prepared.preview.effect as Record<string, unknown>,
      basisVersions: forgedBasis,
      label: "profile-preview-basis-binding"
    })).rejects.toMatchObject({ constraint: "member_profile_correction_preview_binding" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("rejects an effective-date root whose evidence differs from the used Preview", async () => {
    const actualMembershipDate = shiftLocalDate(await propertyLocalToday(db, demo.propertyId), -30);
    const prepared = await preview(envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: demo.membershipOrderId,
      actualMembershipDate,
      evidenceNote: "已冻结的生效日纠正证据"
    }), "effective-date-preview-root-binding");
    const before = await membershipCommandBusinessGraphSnapshot();
    await installMembershipCommandScopeAttack({
      table: "membership_effective_date_corrections",
      timing: "BEFORE",
      body: "NEW.evidence_note := '数据库伪造的另一份日期证据';"
    });
    try {
      await expect(applyFrozenMemberCorrectionEffect({
        commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
        effect: prepared.preview.effect as Record<string, unknown>,
        basisVersions: await previewBasisVersions(prepared.preview.previewId),
        label: "effective-date-preview-root-binding"
      })).rejects.toMatchObject({ constraint: "membership_effective_date_correction_preview_binding" });
      expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
    } finally {
      await clearMembershipCommandScopeAttackTrigger();
    }
  });

  it("binds an effective-date correction to the sequence baseline frozen in its Preview", async () => {
    const actualMembershipDate = shiftLocalDate(await propertyLocalToday(db, demo.propertyId), -30);
    const prepared = await preview(envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: demo.membershipOrderId,
      actualMembershipDate,
      evidenceNote: "生效日纠正必须使用 Preview 冻结的下一序号"
    }), "effective-date-preview-basis-binding");
    const forgedBasis = await previewBasisVersions(prepared.preview.previewId);
    forgedBasis.nextCorrectionSequence = 2;
    const before = await membershipCommandBusinessGraphSnapshot();

    await expect(applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      effect: prepared.preview.effect as Record<string, unknown>,
      basisVersions: forgedBasis,
      label: "effective-date-preview-basis-binding"
    })).rejects.toMatchObject({ constraint: "membership_effective_date_correction_preview_binding" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("binds the unchanged available balance in an effective-date Preview to current entitlement facts", async () => {
    const actualMembershipDate = shiftLocalDate(await propertyLocalToday(db, demo.propertyId), -30);
    const prepared = await preview(envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: demo.membershipOrderId,
      actualMembershipDate,
      evidenceNote: "生效日纠正不得伪造保持不变的权益余额"
    }), "effective-date-preview-balance-binding");
    const forgedEffect = structuredClone(prepared.preview.effect) as Record<string, unknown>;
    const unchanged = forgedEffect.unchanged as Record<string, unknown>;
    const availableBalance = unchanged.availableBalance as Record<string, number>;
    availableBalance.ROOM_NIGHT = (availableBalance.ROOM_NIGHT ?? 0) + 1;
    const before = await membershipCommandBusinessGraphSnapshot();

    await expect(applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      effect: prepared.preview.effect as Record<string, unknown>,
      previewEffectAfterApply: forgedEffect,
      basisVersions: await previewBasisVersions(prepared.preview.previewId),
      label: "effective-date-preview-balance-binding"
    })).rejects.toMatchObject({ constraint: "membership_effective_date_correction_preview_binding" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it.each([
    "paymentFactIds",
    "ledgerFactIds",
    "coverageStates"
  ] as const)("binds the %s canonical witness in an effective-date Preview", async (witness) => {
    const stay = await createDemoMemberStay(`effective-date-${witness}-binding`, true);
    const prepared = await preview(envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: demo.membershipOrderId,
      actualMembershipDate: shiftLocalDate(stay.businessDate, -30),
      evidenceNote: "付款、权益与 coverage 的冻结集合必须由数据库复核"
    }), `effective-date-${witness}-binding`);
    const forgedBasis = await previewBasisVersions(prepared.preview.previewId);
    expect(forgedBasis[witness]).toEqual(expect.any(Array));
    expect((forgedBasis[witness] as unknown[]).length).toBeGreaterThan(0);
    forgedBasis[witness] = [];
    const before = await membershipCommandBusinessGraphSnapshot();

    await expect(applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      effect: prepared.preview.effect as Record<string, unknown>,
      basisVersions: forgedBasis,
      label: `effective-date-${witness}-binding`
    })).rejects.toMatchObject({ constraint: "membership_effective_date_correction_preview_binding" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("requires correction sequences to start at one at the database boundary", async () => {
    const member = await db.selectFrom("members").selectAll().where("id", "=", demo.memberId).executeTakeFirstOrThrow();
    const prepared = await preview(envelope("CORRECT_MEMBER_PROFILE", {
      propertyId: demo.propertyId,
      memberId: member.id,
      expectedPriorProfile: {
        fullName: member.full_name,
        nickname: member.nickname,
        identityCardNumber: member.identity_card_number,
        phone: member.phone,
        wechat: member.wechat
      },
      correctedProfile: {
        fullName: member.full_name,
        nickname: `${member.nickname}-序号`,
        identityCardNumber: member.identity_card_number,
        phone: member.phone,
        wechat: member.wechat
      },
      evidenceNote: "首条资料纠正序号必须为一"
    }), "profile-sequence-start");
    const before = await membershipCommandBusinessGraphSnapshot();
    await installMembershipCommandScopeAttack({
      table: "member_profile_corrections",
      timing: "BEFORE",
      body: "NEW.sequence := 2;"
    });
    try {
      await expect(applyFrozenMemberCorrectionEffect({
        commandType: "CORRECT_MEMBER_PROFILE",
        effect: prepared.preview.effect as Record<string, unknown>,
        basisVersions: await previewBasisVersions(prepared.preview.previewId),
        label: "profile-sequence-start"
      })).rejects.toMatchObject({ constraint: "member_profile_correction_sequence" });
      expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
    } finally {
      await clearMembershipCommandScopeAttackTrigger();
    }
  });

  it("requires effective-date correction sequences to use the next exact value", async () => {
    const propertyToday = await propertyLocalToday(db, demo.propertyId);
    const firstDate = shiftLocalDate(propertyToday, -30);
    await confirm(envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: demo.membershipOrderId,
      actualMembershipDate: firstDate,
      evidenceNote: "第一条有效日期纠正"
    }), "effective-date-sequence-first");
    const secondDate = shiftLocalDate(propertyToday, -31);
    const prepared = await preview(envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId: demo.membershipOrderId,
      actualMembershipDate: secondDate,
      evidenceNote: "第二条有效日期纠正必须连续"
    }), "effective-date-sequence-next");
    const before = await membershipCommandBusinessGraphSnapshot();
    await installMembershipCommandScopeAttack({
      table: "membership_effective_date_corrections",
      timing: "BEFORE",
      body: "NEW.sequence := NEW.sequence + 1;"
    });
    try {
      await expect(applyFrozenMemberCorrectionEffect({
        commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
        effect: prepared.preview.effect as Record<string, unknown>,
        basisVersions: await previewBasisVersions(prepared.preview.previewId),
        label: "effective-date-sequence-next"
      })).rejects.toMatchObject({ constraint: "membership_effective_date_correction_sequence" });
      expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
    } finally {
      await clearMembershipCommandScopeAttackTrigger();
    }
  });

  it("backfills one still-active historical purchase while keeping membership and payment dates independent", async () => {
    const memberId = await createMember("backfill");
    const propertyToday = await propertyLocalToday(db, demo.propertyId);
    const actualMembershipDate = shiftLocalDate(propertyToday, -20);
    const businessDate = shiftLocalDate(actualMembershipDate, 2);
    const command = envelope("BACKFILL_HISTORICAL_MEMBERSHIP", {
      propertyId: demo.propertyId,
      memberId,
      membershipProductId: "membership_product_shared_bath_quad_v1",
      actualMembershipDate,
      payment: {
        amountMinor: 93600,
        businessDate,
        transactionReference: "WECOM-HISTORY-BACKFILL-001",
        note: "切换期晚录"
      },
      evidenceNote: "企微账单与纸质合同复核"
    });

    const recordedAfter = new Date();
    await expect(preview(envelope("BACKFILL_HISTORICAL_MEMBERSHIP", {
      ...command.input,
      payment: {
        ...(command.input.payment as object),
        businessDate: shiftLocalDate(propertyToday, 1),
        transactionReference: "WECOM-HISTORY-FUTURE-PAYMENT-DATE"
      }
    }), "historical-backfill-future-payment-date")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "企业微信收款日期不能晚于物业营业日"
    });
    const receipt = await confirm(command, "historical-backfill");
    expect(receipt).toMatchObject({ businessCommitted: true, executionStatus: "EXECUTED" });
    expect(receipt.result).toMatchObject({
      memberId,
      status: "ACTIVE",
      validFrom: actualMembershipDate,
      validUntil: addCalendarYear(actualMembershipDate),
      entitlementUnits: 30,
      product: expect.objectContaining({ productId: command.input.membershipProductId, agreedPrice: { currency: "CNY", minorUnits: 93_600 } }),
      payment: {
        amount: { currency: "CNY", minorUnits: 93_600 },
        businessDate,
        transactionReference: "WECOM-HISTORY-BACKFILL-001",
        note: "切换期晚录"
      },
      reason: { code: "DATA_ENTRY_CORRECTION", note: "管理员复核 historical-backfill" },
      evidenceNote: command.input.evidenceNote,
      actor: { subjectId: demo.administratorSubjectId, displayName: "Demo Administrator" },
      recordedAt: expect.any(String)
    });

    const membershipOrderId = receipt.result!.membershipOrderId as string;
    const order = await db.selectFrom("membership_orders").selectAll().where("id", "=", membershipOrderId).executeTakeFirstOrThrow();
    expect(order).toMatchObject({
      member_id: memberId,
      status: "ACTIVE",
      valid_from: actualMembershipDate,
      valid_until: addCalendarYear(actualMembershipDate),
      agreed_price_minor: 93600
    });
    expect(order.created_at.getTime()).toBeGreaterThanOrEqual(recordedAfter.getTime() - 1_000);
    const payment = await sql<{
      amount_minor: number;
      transaction_reference: string;
      business_date: string;
      created_at: Date;
    }>`select amount_minor, transaction_reference, business_date, created_at from membership_payment_facts where membership_order_id = ${membershipOrderId}`.execute(db);
    expect(payment.rows).toEqual([expect.objectContaining({
      amount_minor: 93600,
      transaction_reference: "WECOM-HISTORY-BACKFILL-001",
      business_date: businessDate
    })]);
    expect(payment.rows[0]!.created_at.getTime()).toBeGreaterThanOrEqual(recordedAfter.getTime() - 1_000);
    expect(await db.selectFrom("member_contracts").selectAll().where("membership_order_id", "=", membershipOrderId).execute())
      .toEqual([expect.objectContaining({ valid_from: actualMembershipDate, valid_until: addCalendarYear(actualMembershipDate), status: "ACTIVE" })]);
    expect((await getMemberView(db, demo.propertyId, memberId)).historicalMembershipBackfills)
      .toEqual([expect.objectContaining({
        id: receipt.result!.backfillId,
        membership_order_id: membershipOrderId,
        business_date: businessDate
      })]);

    await expect(preview(command, "historical-backfill-duplicate")).rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    const expiredDate = shiftLocalDate(propertyToday, -400);
    await expect(preview(envelope("BACKFILL_HISTORICAL_MEMBERSHIP", {
      ...command.input,
      actualMembershipDate: expiredDate,
      payment: {
        ...(command.input.payment as object),
        businessDate: expiredDate,
        transactionReference: "WECOM-HISTORY-EXPIRED-001"
      }
    }), "historical-backfill-expired")).rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
  });

  it.each([
    { label: "underpayment", amountMinor: 50_000, expectedDifferenceMinor: -43_600, paymentDateOffset: -1 },
    { label: "overpayment", amountMinor: 100_000, expectedDifferenceMinor: 6_400, paymentDateOffset: 0 }
  ])("keeps the frozen product price independent from a real $label", async ({
    label,
    amountMinor,
    expectedDifferenceMinor,
    paymentDateOffset
  }) => {
    const memberId = await createMember(`backfill-${label}`);
    const actualMembershipDate = shiftLocalDate(await propertyLocalToday(db, demo.propertyId), -20);
    const businessDate = shiftLocalDate(actualMembershipDate, paymentDateOffset);
    const transactionReference = `WECOM-HISTORY-BACKFILL-${label.toUpperCase()}`;
    const evidenceNote = `企微账单确认历史办卡${label}`;
    const prefix = `historical-backfill-${label}`;
    const receipt = await confirm(envelope("BACKFILL_HISTORICAL_MEMBERSHIP", {
      propertyId: demo.propertyId,
      memberId,
      membershipProductId: "membership_product_shared_bath_quad_v1",
      actualMembershipDate,
      payment: {
        amountMinor,
        businessDate,
        transactionReference,
        note: `实际${label}`
      },
      evidenceNote
    }), prefix);

    expect(receipt).toMatchObject({ businessCommitted: true, executionStatus: "EXECUTED" });
    expect(receipt.result).toMatchObject({
      memberId,
      product: {
        productId: "membership_product_shared_bath_quad_v1",
        listedPrice: { currency: "CNY", minorUnits: 93_600 },
        agreedPrice: { currency: "CNY", minorUnits: 93_600 }
      },
      payment: {
        amount: { currency: "CNY", minorUnits: amountMinor },
        businessDate,
        transactionReference,
        note: `实际${label}`
      },
      reason: { code: "DATA_ENTRY_CORRECTION", note: `管理员复核 ${prefix}` },
      evidenceNote,
      actor: { subjectId: demo.administratorSubjectId, displayName: "Demo Administrator" },
      recordedAt: expect.any(String)
    });

    const membershipOrderId = receipt.result!.membershipOrderId as string;
    expect(await db.selectFrom("membership_orders").selectAll()
      .where("id", "=", membershipOrderId).executeTakeFirstOrThrow()).toMatchObject({
      listed_price_minor: 93_600,
      agreed_price_minor: 93_600,
      price_adjustment_minor: 0,
      price_adjustment_reason: null
    });
    expect(await db.selectFrom("membership_payment_facts").selectAll()
      .where("membership_order_id", "=", membershipOrderId).execute()).toEqual([
      expect.objectContaining({
        amount_minor: amountMinor,
        net_effect_minor: amountMinor,
        transaction_reference: transactionReference
      })
    ]);
    expect((await getMemberView(db, demo.propertyId, memberId)).membershipOrders).toEqual([
      expect.objectContaining({
        order: expect.objectContaining({ id: membershipOrderId, agreed_price_minor: 93_600 }),
        paymentTotalMinor: amountMinor,
        paymentDifferenceMinor: expectedDifferenceMinor
      })
    ]);
  });

  it("binds a historical backfill to the product, price, and entitlement facts frozen in its Preview", async () => {
    const memberId = await createMember("backfill-preview-product-binding");
    const actualMembershipDate = shiftLocalDate(await propertyLocalToday(db, demo.propertyId), -20);
    const command = envelope("BACKFILL_HISTORICAL_MEMBERSHIP", {
      propertyId: demo.propertyId,
      memberId,
      membershipProductId: "membership_product_shared_bath_quad_v1",
      actualMembershipDate,
      payment: {
        amountMinor: 93_600,
        businessDate: actualMembershipDate,
        transactionReference: "WECOM-BACKFILL-PREVIEW-PRODUCT-BINDING"
      },
      evidenceNote: "确认页冻结产品后不得在落库时替换整条会员链"
    });
    const prepared = await preview(command, "backfill-preview-product-binding");
    const before = await membershipCommandBusinessGraphSnapshot();
    await installHistoricalBackfillProductSwapAttack();
    try {
      const receipt = await confirmCommandPreview(db, administrator, prepared.preview.previewId, {
        propertyId: demo.propertyId,
        commandType: command.commandType,
        confirmation: true,
        expectedEffectHash: prepared.preview.effectHash,
        reason: { code: "DATA_ENTRY_CORRECTION", note: "数据库必须绑定确认页冻结的会员产品" }
      }, metadata("backfill-preview-product-binding-confirm"));
      expect(receipt).toMatchObject({
        executionStatus: "NOT_EXECUTED",
        businessCommitted: false
      });
      expect(receipt.error).toMatchObject({ code: "COMMAND_INTERRUPTED" });
      await expect(applyFrozenMemberCorrectionEffect({
        commandType: "BACKFILL_HISTORICAL_MEMBERSHIP",
        effect: prepared.preview.effect as Record<string, unknown>,
        basisVersions: await previewBasisVersions(prepared.preview.previewId),
        label: "backfill-preview-product-binding-direct"
      })).rejects.toMatchObject({
        constraint: "historical_membership_backfill_preview_binding"
      });
      expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
    } finally {
      await clearHistoricalBackfillProductSwapAttack();
    }
  });

  it("rejects historical backfill over a legacy ACTIVE contract and lot at both application and SQL boundaries", async () => {
    const memberId = await createMember("backfill-legacy-active");
    const propertyToday = await propertyLocalToday(db, demo.propertyId);
    const actualMembershipDate = shiftLocalDate(propertyToday, -20);
    const command = envelope("BACKFILL_HISTORICAL_MEMBERSHIP", {
      propertyId: demo.propertyId,
      memberId,
      membershipProductId: "membership_product_shared_bath_quad_v1",
      actualMembershipDate,
      payment: {
        amountMinor: 93_600,
        businessDate: actualMembershipDate,
        transactionReference: "WECOM-BACKFILL-LEGACY-ACTIVE"
      },
      evidenceNote: "legacy ACTIVE contract/Lot 必须阻断重复权益链"
    });
    const preparedBeforeLegacy = await preview(command, "backfill-legacy-active-frozen");
    await insertLegacyActiveProjection({ memberId, prefix: "backfill-active" });
    const before = await membershipCommandBusinessGraphSnapshot();

    await expect(preview(command, "backfill-legacy-active-application"))
      .rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    await expect(applyFrozenMemberCorrectionEffect({
      commandType: "BACKFILL_HISTORICAL_MEMBERSHIP",
      effect: preparedBeforeLegacy.preview.effect as Record<string, unknown>,
      basisVersions: await previewBasisVersions(preparedBeforeLegacy.preview.previewId),
      label: "backfill-legacy-active"
    })).rejects.toThrow(/historical membership backfill must create one exact current recording/i);
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("rejects historical backfill when the member already has a DRAFT membership order", async () => {
    const memberId = await createMember("backfill-draft-order");
    const propertyToday = await propertyLocalToday(db, demo.propertyId);
    const actualMembershipDate = shiftLocalDate(propertyToday, -20);
    const command = envelope("BACKFILL_HISTORICAL_MEMBERSHIP", {
      propertyId: demo.propertyId,
      memberId,
      membershipProductId: "membership_product_shared_bath_quad_v1",
      actualMembershipDate,
      payment: {
        amountMinor: 93_600,
        businessDate: actualMembershipDate,
        transactionReference: "WECOM-BACKFILL-DRAFT-ORDER"
      },
      evidenceNote: "已有待处理会员订单时不能通过历史补录叠加有效权益"
    });
    const preparedBeforeDraft = await preview(command, "backfill-draft-order-frozen");
    await confirm({
      commandType: "CREATE_MEMBERSHIP_ORDER",
      input: {
        propertyId: demo.propertyId,
        memberId,
        membershipProductId: "membership_product_shared_bath_quad_v1",
        agreedPriceMinor: 93_600
      }
    }, "backfill-draft-order-existing", ordinaryStaff);
    const before = await membershipCommandBusinessGraphSnapshot();

    await expect(preview(command, "backfill-draft-order-application"))
      .rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    await expect(applyFrozenMemberCorrectionEffect({
      commandType: "BACKFILL_HISTORICAL_MEMBERSHIP",
      effect: preparedBeforeDraft.preview.effect as Record<string, unknown>,
      basisVersions: await previewBasisVersions(preparedBeforeDraft.preview.previewId),
      label: "backfill-draft-order"
    })).rejects.toThrow(/historical membership backfill must create one exact current recording/i);
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("rejects ordinary membership activation when another active chain already exists for the member", async () => {
    const memberId = await createMember("activate-existing-active-chain");
    const createDraft = async (label: string) => {
      const order = await confirm({
        commandType: "CREATE_MEMBERSHIP_ORDER",
        input: {
          propertyId: demo.propertyId,
          memberId,
          membershipProductId: "membership_product_shared_bath_quad_v1",
          agreedPriceMinor: 93_600
        }
      }, `activate-existing-${label}-order`, ordinaryStaff);
      const membershipOrderId = order.result!.membershipOrderId as string;
      await confirm({
        commandType: "RECORD_MEMBERSHIP_PAYMENT",
        input: {
          propertyId: demo.propertyId,
          membershipOrderId,
          amountMinor: 93_600,
          transactionReference: `WECOM-ACTIVATE-EXISTING-${label.toUpperCase()}`
        }
      }, `activate-existing-${label}-payment`, ordinaryStaff);
      return membershipOrderId;
    };

    const firstOrderId = await createDraft("first");
    const secondOrderId = await createDraft("second");
    await confirm({
      commandType: "ACTIVATE_MEMBERSHIP_ORDER",
      input: { propertyId: demo.propertyId, membershipOrderId: firstOrderId }
    }, "activate-existing-first-activate", ordinaryStaff);
    const before = await membershipCommandBusinessGraphSnapshot();

    await expect(preview({
      commandType: "ACTIVATE_MEMBERSHIP_ORDER",
      input: { propertyId: demo.propertyId, membershipOrderId: secondOrderId }
    }, "activate-existing-second-preview", ordinaryStaff)).rejects.toMatchObject({
      code: "ENTITLEMENT_CONFLICT"
    });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("voids one unused erroneous direct membership and atomically rebuilds it from the completed stay money graph", async () => {
    const memberId = await createMember("void-reconversion");
    const member = await db.selectFrom("members").selectAll().where("id", "=", memberId).executeTakeFirstOrThrow();
    const stay = await createCompletedWecomStay({
      prefix: "void-reconversion",
      phone: member.phone,
      documentNumber: member.identity_card_number!
    });
    const agreedPriceMinor = 93_600;
    const oldErroneousDirectAmountMinor = 93_600;
    const replacementDirectAmountMinor = agreedPriceMinor - stay.collectionAmountMinor;
    expect(stay.collectionAmountMinor).toBe(20_000);
    expect(replacementDirectAmountMinor).toBe(73_600);

    const oldOrderReceipt = await confirm({
      commandType: "CREATE_MEMBERSHIP_ORDER",
      input: {
        propertyId: demo.propertyId,
        memberId,
        membershipProductId: "membership_product_shared_bath_single_v1",
        agreedPriceMinor,
        priceAdjustmentReason: "Cathy 错误会员链的原始成交价录入"
      }
    }, "void-old-membership-order", ordinaryStaff);
    const oldMembershipOrderId = oldOrderReceipt.result!.membershipOrderId as string;
    const oldPaymentReceipt = await confirm({
      commandType: "RECORD_MEMBERSHIP_PAYMENT",
      input: {
        propertyId: demo.propertyId,
        membershipOrderId: oldMembershipOrderId,
        amountMinor: oldErroneousDirectAmountMinor,
        transactionReference: "WECOM-VOID-OLD-DIRECT"
      }
    }, "void-old-membership-payment", ordinaryStaff);
    await confirm({
      commandType: "ACTIVATE_MEMBERSHIP_ORDER",
      input: { propertyId: demo.propertyId, membershipOrderId: oldMembershipOrderId }
    }, "void-old-membership-activate", ordinaryStaff);
    const oldOrder = await db.selectFrom("membership_orders").selectAll()
      .where("id", "=", oldMembershipOrderId).executeTakeFirstOrThrow();

    const command = envelope("VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY", {
      propertyId: demo.propertyId,
      erroneousMembershipOrderId: oldMembershipOrderId,
      sourceStayOrderId: stay.orderId,
      actualMembershipDate: stay.arrivalDate,
      replacementDirectPayment: {
        businessDate: stay.arrivalDate,
        transactionReference: "WECOM-VOID-RECLASSIFIED-DIRECT"
      },
      evidenceNote: "旧会员链录错，企微直收与历史住宿收款已逐笔复核"
    });
    const roomStatusRevisionBefore = await db.selectFrom("room_status_revisions").select("revision")
      .where("property_id", "=", demo.propertyId).executeTakeFirstOrThrow();
    const prepared = await preview(command, "void-reconversion");
    expect(prepared.preview.effect).toMatchObject({
      funds: {
        oldDirectCollectionTotal: { currency: "CNY", minorUnits: 93_600 },
        oldReversalTotal: { currency: "CNY", minorUnits: 93_600 },
        stayTransferTotal: { currency: "CNY", minorUnits: stay.collectionAmountMinor },
        replacementDirectPayment: { amount: { currency: "CNY", minorUnits: replacementDirectAmountMinor } },
        membershipAgreedPrice: { currency: "CNY", minorUnits: agreedPriceMinor },
        reclassificationOnly: true
      },
      entitlement: { totalUnits: 30, consumedUnits: 2, remainingUnits: 28 }
    });
    const confirmation = {
      propertyId: demo.propertyId,
      commandType: command.commandType,
      confirmation: true,
      expectedEffectHash: prepared.preview.effectHash,
      reason: { code: "DATA_ENTRY_CORRECTION", note: "核对旧链作废与历史住宿重建" }
    } as const;
    const confirmationMetadata = metadata("void-reconversion-confirm");
    const receipt = await confirmCommandPreview(db, administrator, prepared.preview.previewId, confirmation, confirmationMetadata);
    expect(receipt).toMatchObject({ businessCommitted: true, executionStatus: "EXECUTED" });
    const roomStatusRevisionAfter = await db.selectFrom("room_status_revisions").select("revision")
      .where("property_id", "=", demo.propertyId).executeTakeFirstOrThrow();
    expect(BigInt(roomStatusRevisionAfter.revision)).toBe(BigInt(roomStatusRevisionBefore.revision) + 1n);
    const replay = await confirmCommandPreview(db, administrator, prepared.preview.previewId, confirmation, confirmationMetadata);
    expect(replay).toMatchObject({ receiptId: receipt.receiptId, commandId: receipt.commandId, businessCommitted: true });
    expect(await db.selectFrom("room_status_revisions").select("revision")
      .where("property_id", "=", demo.propertyId).executeTakeFirstOrThrow()).toEqual(roomStatusRevisionAfter);
    expect(receipt.result).toMatchObject({
      oldMembershipOrderId,
      oldContractId: oldOrder.contract_id,
      oldEntitlementLotId: oldOrder.entitlement_lot_id,
      sourceStayOrderId: stay.orderId,
      sourceStayId: stay.stayId,
      oldDirectCollectionTotal: { currency: "CNY", minorUnits: 93_600 },
      membershipAgreedPrice: { currency: "CNY", minorUnits: agreedPriceMinor },
      validFrom: stay.arrivalDate,
      validUntil: addCalendarYear(stay.arrivalDate),
      serviceDates: expect.any(Array),
      oldPaymentReversalFactIds: expect.any(Array),
      paymentReclassificationFactIds: expect.any(Array),
      sourceReversalFactIds: expect.any(Array),
      transferPaymentFactIds: expect.any(Array),
      transferIds: expect.any(Array),
      conversionLedgerFactIds: expect.any(Array),
      reason: { code: "DATA_ENTRY_CORRECTION", note: "核对旧链作废与历史住宿重建" },
      evidenceNote: command.input.evidenceNote,
      actor: { subjectId: demo.administratorSubjectId, displayName: "Demo Administrator" },
      recordedAt: expect.any(String)
    });

    const newMembershipOrderId = receipt.result!.membershipOrderId as string;
    const paymentReclassificationFactIds = receipt.result!.paymentReclassificationFactIds as string[];
    expect(paymentReclassificationFactIds).toHaveLength(1);
    expect(receipt.factRefs).toEqual(expect.arrayContaining(paymentReclassificationFactIds));
    const [oldOrderAfter, oldContractAfter, oldLotAfter, newOrder, oldPayments, newPayments, stayFunds] = await Promise.all([
      db.selectFrom("membership_orders").selectAll().where("id", "=", oldMembershipOrderId).executeTakeFirstOrThrow(),
      db.selectFrom("member_contracts").selectAll().where("id", "=", oldOrder.contract_id!).executeTakeFirstOrThrow(),
      db.selectFrom("entitlement_lots").selectAll().where("id", "=", oldOrder.entitlement_lot_id!).executeTakeFirstOrThrow(),
      db.selectFrom("membership_orders").selectAll().where("id", "=", newMembershipOrderId).executeTakeFirstOrThrow(),
      db.selectFrom("membership_payment_facts").selectAll().where("membership_order_id", "=", oldMembershipOrderId).orderBy("fact_id").execute(),
      db.selectFrom("membership_payment_facts").selectAll().where("membership_order_id", "=", newMembershipOrderId).orderBy("fact_id").execute(),
      db.selectFrom("collection_facts").selectAll().where("order_id", "=", stay.orderId).orderBy("fact_id").execute()
    ]);
    expect(oldOrderAfter.status).toBe("VOIDED");
    expect(oldContractAfter.status).toBe("VOIDED");
    expect(oldLotAfter.status).toBe("VOIDED");
    expect(oldPayments.reduce((sum, fact) => sum + fact.net_effect_minor, 0)).toBe(0);
    const oldCollection = oldPayments.find((fact) => fact.fact_id === oldPaymentReceipt.result!.paymentFactId)!;
    const oldReversal = oldPayments.find((fact) => fact.reverses_fact_id === oldPaymentReceipt.result!.paymentFactId)!;
    expect(oldCollection).toMatchObject({ fact_type: "COLLECTION" });
    expect(oldReversal).toMatchObject({ fact_type: "REVERSAL", business_date: oldCollection.business_date });
    expect(newOrder).toMatchObject({
      member_id: memberId,
      status: "ACTIVE",
      agreed_price_minor: agreedPriceMinor,
      valid_from: stay.arrivalDate
    });
    expect(newPayments.reduce((sum, fact) => sum + fact.net_effect_minor, 0)).toBe(93_600);
    expect(newPayments).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_type: "DIRECT_WECOM", amount_minor: replacementDirectAmountMinor, net_effect_minor: replacementDirectAmountMinor }),
      expect.objectContaining({ source_type: "STAY_COLLECTION_TRANSFER", amount_minor: stay.collectionAmountMinor, net_effect_minor: stay.collectionAmountMinor })
    ]));
    expect(newPayments.map((fact) => fact.source_type).sort()).toEqual(["DIRECT_WECOM", "STAY_COLLECTION_TRANSFER"]);
    const sourceCollectionBusinessDate = await sql<{ business_date: string }>`
      SELECT (source.created_at AT TIME ZONE property_row.timezone)::date::text AS business_date
      FROM collection_facts AS source
      JOIN orders AS source_order ON source_order.id = source.order_id
      JOIN properties AS property_row ON property_row.id = source_order.property_id
      WHERE source.fact_id = ${stay.collectionFactId}
    `.execute(db);
    expect(newPayments.find((fact) => fact.source_type === "STAY_COLLECTION_TRANSFER")?.business_date)
      .toBe(sourceCollectionBusinessDate.rows[0]!.business_date);
    expect(stayFunds.reduce((sum, fact) => sum + fact.net_effect_minor, 0)).toBe(0);

    const [oldLedger, newLedger, transfers, view, sourceOrderView] = await Promise.all([
      db.selectFrom("entitlement_ledger").selectAll().where("lot_id", "=", oldOrder.entitlement_lot_id!).execute(),
      db.selectFrom("entitlement_ledger").selectAll().where("lot_id", "=", newOrder.entitlement_lot_id!).orderBy("service_date").execute(),
      db.selectFrom("stay_collection_membership_transfers").selectAll().where("order_id", "=", stay.orderId).execute(),
      getMemberView(db, demo.propertyId, memberId),
      getOrderView(db, stay.orderId, "WRITE", administrator.propertyCommandGrants.get(demo.propertyId)!)
    ]);
    expect(oldLedger).toEqual([expect.objectContaining({ entry_type: "VOID", quantity_delta: -30 })]);
    expect(newLedger).toHaveLength(2);
    expect(newLedger.every((entry) => entry.entry_type === "CONVERSION_CONSUME" && entry.quantity_delta === -1)).toBe(true);
    expect(transfers).toEqual([expect.objectContaining({ membership_order_id: newMembershipOrderId })]);
    expect(view.lotBalances).toEqual(expect.arrayContaining([
      { lotId: oldOrder.entitlement_lot_id, unitKind: "ROOM_NIGHT", availableUnits: 0 },
      { lotId: newOrder.entitlement_lot_id, unitKind: "ROOM_NIGHT", availableUnits: 28 }
    ]));
    const serializedMemberView = JSON.parse(fastJsonStringify(MemberResponseSchema)(view));
    expect(serializedMemberView.membershipOrders).toEqual(expect.arrayContaining([
      expect.objectContaining({ order: expect.objectContaining({ id: oldMembershipOrderId, status: "VOIDED" }) })
    ]));
    expect(serializedMemberView.contracts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: oldOrder.contract_id, status: "VOIDED" })
    ]));
    expect(serializedMemberView.lots).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: oldOrder.entitlement_lot_id, status: "VOIDED" })
    ]));
    expect(serializedMemberView.membershipOrders.flatMap((summary: { paymentFacts: Array<{ business_date?: string }> }) => summary.paymentFacts))
      .toEqual(expect.arrayContaining([expect.objectContaining({ business_date: expect.any(String) })]));
    expect(view.voidReconversions).toEqual([expect.objectContaining({
      old_membership_order_id: oldMembershipOrderId,
      new_membership_order_id: newMembershipOrderId,
      source_order_id: stay.orderId
    })]);
    expect(view.paymentReclassifications).toEqual([expect.objectContaining({
      id: paymentReclassificationFactIds[0],
      old_membership_order_id: oldMembershipOrderId,
      new_membership_order_id: newMembershipOrderId,
      amount_minor: oldErroneousDirectAmountMinor
    })]);
    expect(sourceOrderView.membershipConversion).toMatchObject({
      membershipOrderId: newMembershipOrderId,
      memberId,
      contractId: newOrder.contract_id,
      entitlementLotId: newOrder.entitlement_lot_id,
      commandId: receipt.commandId
    });
    expect(sourceOrderView.amendments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        amendment_type: "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY",
        command_id: receipt.commandId
      })
    ]));
    expect(() => JSON.parse(fastJsonStringify(OrderDetailResponseSchema)(sourceOrderView))).not.toThrow();
  });

  it("derives a non-936 void and reconversion from the old payment, stay transfer, and agreed price facts", async () => {
    const oldErroneousDirectAmountMinor = 88_800;
    const membershipAgreedPriceMinor = 120_000;
    const setup = await prepareVoidReconversion("void-non-936", {
      agreedPriceMinor: membershipAgreedPriceMinor,
      oldErroneousDirectAmountMinor
    });
    const prepared = await preview(setup.command, "void-non-936");
    expect(prepared.preview.effect).toMatchObject({
      funds: {
        oldDirectCollectionTotal: { currency: "CNY", minorUnits: oldErroneousDirectAmountMinor },
        oldReversalTotal: { currency: "CNY", minorUnits: oldErroneousDirectAmountMinor },
        stayTransferTotal: { currency: "CNY", minorUnits: setup.sourceStay.collectionAmountMinor },
        replacementDirectPayment: { amount: { currency: "CNY", minorUnits: 100_000 } },
        membershipAgreedPrice: { currency: "CNY", minorUnits: membershipAgreedPriceMinor }
      },
      entitlement: { totalUnits: 30, consumedUnits: 2, remainingUnits: 28 }
    });
    const receipt = await confirmCommandPreview(db, administrator, prepared.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: setup.command.commandType,
      confirmation: true,
      expectedEffectHash: prepared.preview.effectHash,
      reason: { code: "DATA_ENTRY_CORRECTION", note: "非 936 元旧链按真实资金事实重建" }
    }, metadata("void-non-936-confirm"));
    expect(receipt).toMatchObject({ businessCommitted: true, executionStatus: "EXECUTED" });

    const newMembershipOrderId = receipt.result!.membershipOrderId as string;
    const newOrder = await db.selectFrom("membership_orders").selectAll()
      .where("id", "=", newMembershipOrderId).executeTakeFirstOrThrow();
    const [oldPayments, newPayments, newLedger, view] = await Promise.all([
      db.selectFrom("membership_payment_facts").selectAll()
        .where("membership_order_id", "=", setup.oldMembershipOrderId).execute(),
      db.selectFrom("membership_payment_facts").selectAll()
        .where("membership_order_id", "=", newMembershipOrderId).execute(),
      db.selectFrom("entitlement_ledger").selectAll()
        .where("lot_id", "=", newOrder.entitlement_lot_id!).execute(),
      getMemberView(db, demo.propertyId, newOrder.member_id)
    ]);
    expect(oldPayments.reduce((sum, fact) => sum + fact.net_effect_minor, 0)).toBe(0);
    expect(oldPayments).toEqual(expect.arrayContaining([
      expect.objectContaining({ fact_type: "COLLECTION", amount_minor: oldErroneousDirectAmountMinor }),
      expect.objectContaining({ fact_type: "REVERSAL", amount_minor: oldErroneousDirectAmountMinor })
    ]));
    expect(newOrder.agreed_price_minor).toBe(membershipAgreedPriceMinor);
    expect(newPayments.reduce((sum, fact) => sum + fact.net_effect_minor, 0)).toBe(membershipAgreedPriceMinor);
    expect(newPayments).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_type: "STAY_COLLECTION_TRANSFER", amount_minor: 20_000, net_effect_minor: 20_000 }),
      expect.objectContaining({ source_type: "DIRECT_WECOM", amount_minor: 100_000, net_effect_minor: 100_000 })
    ]));
    expect(newLedger).toHaveLength(2);
    expect(newLedger.every((fact) => fact.entry_type === "CONVERSION_CONSUME" && fact.quantity_delta === -1)).toBe(true);
    expect(view.lotBalances).toEqual(expect.arrayContaining([
      { lotId: newOrder.entitlement_lot_id, unitKind: "ROOM_NIGHT", availableUnits: 28 }
    ]));
  });

  it("allows a later effective-date correction when the existing uncovered conversion came from a valid 9.5 rebuild", async () => {
    const setup = await prepareVoidReconversion("void-then-effective-date");
    const voidReceipt = await confirm(setup.command, "void-then-effective-date-rebuild");
    const membershipOrderId = voidReceipt.result!.membershipOrderId as string;
    const correctedMembershipDate = shiftLocalDate(setup.sourceStay.arrivalDate, -1);
    const ledgerBefore = await db.selectFrom("entitlement_ledger").selectAll()
      .where("lot_id", "=", voidReceipt.result!.entitlementLotId as string)
      .orderBy("fact_id").execute();
    const viewBefore = await getMemberView(
      db,
      demo.propertyId,
      voidReceipt.result!.memberId as string
    );

    const dateReceipt = await confirm(envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId,
      actualMembershipDate: correctedMembershipDate,
      evidenceNote: "9.5 重建链的原始 conversion 可唯一追溯，日期整体重算仍应可用"
    }), "void-then-effective-date-correction");
    expect(dateReceipt).toMatchObject({ businessCommitted: true, executionStatus: "EXECUTED" });
    expect(dateReceipt.result).toMatchObject({
      membershipOrderId,
      validFrom: correctedMembershipDate,
      unchanged: { usedUnits: 2, availableBalance: viewBefore.availableBalance }
    });
    expect(await db.selectFrom("entitlement_ledger").selectAll()
      .where("lot_id", "=", voidReceipt.result!.entitlementLotId as string)
      .orderBy("fact_id").execute()).toEqual(ledgerBefore);
  });

  it("rejects 9.5 conversion facts repointed to a different plausible completed stay", async () => {
    const setup = await prepareVoidReconversion("effective-date-repointed-source");
    const voidReceipt = await confirm(setup.command, "effective-date-repointed-source-rebuild");
    const membershipOrderId = voidReceipt.result!.membershipOrderId as string;
    const entitlementLotId = voidReceipt.result!.entitlementLotId as string;
    const member = await db.selectFrom("members").selectAll()
      .where("id", "=", voidReceipt.result!.memberId as string).executeTakeFirstOrThrow();
    const membershipOrder = await db.selectFrom("membership_orders").selectAll()
      .where("id", "=", membershipOrderId).executeTakeFirstOrThrow();
    const correctedMembershipDate = shiftLocalDate(setup.sourceStay.arrivalDate, -1);
    const command = envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
      propertyId: demo.propertyId,
      membershipOrderId,
      actualMembershipDate: correctedMembershipDate,
      evidenceNote: "核销事实必须指向 9.5 根记录冻结的同一张源住宿"
    });
    const prepared = await preview(command, "effective-date-repointed-source-frozen");
    const decoyStay = await createCompletedWecomStay({
      prefix: "effective-date-repointed-source-decoy",
      phone: member.phone,
      documentNumber: member.identity_card_number!
    });
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await trx.updateTable("orders").set({
        member_id: member.id,
        member_contract_id: membershipOrder.contract_id
      }).where("id", "=", decoyStay.orderId).execute();
      await trx.updateTable("entitlement_ledger").set({
        order_id: decoyStay.orderId
      }).where("lot_id", "=", entitlementLotId)
        .where("entry_type", "=", "CONVERSION_CONSUME").execute();
    });
    const before = await membershipCommandBusinessGraphSnapshot();

    await expect(preview(command, "effective-date-repointed-source-application"))
      .rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await trx.updateTable("entitlement_ledger").set({
        order_id: setup.sourceStay.orderId
      }).where("lot_id", "=", entitlementLotId)
        .where("entry_type", "=", "CONVERSION_CONSUME").execute();
    });
    const beforeSqlBoundary = await membershipCommandBusinessGraphSnapshot();
    await expect(applyFrozenMemberCorrectionEffect({
      commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      effect: prepared.preview.effect as Record<string, unknown>,
      basisVersions: await previewBasisVersions(prepared.preview.previewId),
      label: "effective-date-repointed-source-sql",
      afterGraph: async (trx) => {
        await sql`SET LOCAL session_replication_role = replica`.execute(trx);
        await trx.updateTable("entitlement_ledger").set({
          order_id: decoyStay.orderId
        }).where("lot_id", "=", entitlementLotId)
          .where("entry_type", "=", "CONVERSION_CONSUME").execute();
        await sql`SET LOCAL session_replication_role = origin`.execute(trx);
        await sql`SET CONSTRAINTS membership_effective_date_corrections_validate_graph IMMEDIATE`.execute(trx);
      }
    })).rejects.toMatchObject({ constraint: "membership_effective_date_correction_preview_binding" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(beforeSqlBoundary);
  });

  it("returns the same scoped 404 for a missing source stay and a source stay owned by another property", async () => {
    const setup = await prepareVoidReconversion("void-source-property-scope");
    const otherPropertyId = "prop_void_source_property_scope_other";
    await db.insertInto("properties").values({
      id: otherPropertyId,
      code: "VOID-SOURCE-OTHER",
      name: "VOID source scope other property",
      timezone: "Asia/Shanghai",
      currency: "CNY"
    }).execute();
    await sql`ALTER TABLE orders DISABLE TRIGGER orders_protect_identity`.execute(db);
    try {
      await db.updateTable("orders").set({ property_id: otherPropertyId })
        .where("id", "=", setup.sourceStay.orderId).executeTakeFirstOrThrow();
    } finally {
      await sql`ALTER TABLE orders ENABLE TRIGGER orders_protect_identity`.execute(db);
    }

    const missingCommand = envelope(setup.command.commandType, {
      ...setup.command.input,
      sourceStayOrderId: "order_void_source_property_scope_missing"
    });
    const errorShape = async (command: CommandEnvelope, prefix: string) => {
      try {
        await preview(command, prefix);
        throw new Error("expected source stay lookup to fail");
      } catch (error) {
        const failure = error as Error & { code?: string; statusCode?: number; retryable?: boolean; details?: unknown };
        return {
          name: failure.name,
          code: failure.code,
          statusCode: failure.statusCode,
          message: failure.message,
          retryable: failure.retryable,
          details: failure.details
        };
      }
    };

    const missing = await errorShape(missingCommand, "void-source-property-scope-missing");
    const crossProperty = await errorShape(setup.command, "void-source-property-scope-cross-property");
    expect(missing).toEqual({
      name: "DomainError",
      code: "NOT_FOUND",
      statusCode: 404,
      message: "源住宿订单不存在",
      retryable: false,
      details: undefined
    });
    expect(crossProperty).toEqual(missing);
  });

  it("allows VOID preview when the source stay document is missing but the phone still identifies the member", async () => {
    const setup = await prepareVoidReconversion("void-source-document-missing", { sourceDocumentNumber: "" });
    await expect(preview(setup.command, "void-source-document-missing")).resolves.toMatchObject({
      preview: {
        effect: {
          sourceStay: {
            identityEvidence: { phoneMatched: true, documentMatched: false }
          }
        }
      }
    });
  });

  it("rejects VOID preview when the source stay phone is missing even if its document matches the member", async () => {
    const setup = await prepareVoidReconversion("void-source-phone-missing");
    await forceSourcePrimaryPhone(setup.sourceStay.orderId, null);
    const before = await membershipCommandBusinessGraphSnapshot();

    await expect(preview(setup.command, "void-source-phone-missing")).rejects.toMatchObject({
      code: "ENTITLEMENT_CONFLICT",
      message: expect.stringContaining("手机号")
    });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("rejects VOID preview when source stay primary occupant document contradicts the target member", async () => {
    const setup = await prepareVoidReconversion("void-source-document-mismatched", {
      sourceDocumentNumber: "OTHER-DOCUMENT-NUMBER"
    });
    const before = await membershipCommandBusinessGraphSnapshot();

    await expect(preview(setup.command, "void-source-document-mismatched")).rejects.toMatchObject({
      code: "ENTITLEMENT_CONFLICT",
      message: expect.stringContaining("证件号")
    });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("rejects a frozen doc-only VOID graph at the SQL boundary even when its Preview repeats that weaker identity", async () => {
    const setup = await prepareVoidReconversion("void-source-doc-only-sql-boundary");
    const prepared = await preview(setup.command, "void-source-doc-only-sql-boundary");
    const frozenEffect = structuredClone(prepared.preview.effect as Record<string, unknown>);
    const frozenBasis = await previewBasisVersions(prepared.preview.previewId);
    const sourceStay = frozenEffect.sourceStay as Record<string, unknown>;
    const identityEvidence = sourceStay.identityEvidence as Record<string, unknown>;
    const sourceIdentity = frozenBasis.sourceIdentity as Record<string, unknown>;
    identityEvidence.phoneMatched = false;
    sourceIdentity.phoneMatched = false;
    sourceIdentity.sourcePhonePresent = false;
    await forceSourcePrimaryPhone(setup.sourceStay.orderId, null);
    const before = await membershipCommandBusinessGraphSnapshot();

    await expect(applyFrozenMemberCorrectionEffect({
      commandType: "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY",
      effect: frozenEffect,
      basisVersions: frozenBasis,
      label: "void-source-doc-only-sql-boundary"
    })).rejects.toMatchObject({ constraint: "membership_void_reconversion_exact_graph" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("rejects a frozen VOID graph when the source stay document changes after Preview", async () => {
    const setup = await prepareVoidReconversion("void-source-document-sql-boundary");
    const prepared = await preview(setup.command, "void-source-document-sql-boundary");
    await forceSourcePrimaryDocumentNumber(setup.sourceStay.orderId, "MUTATED-DOCUMENT-NUMBER");
    const before = await membershipCommandBusinessGraphSnapshot();

    await expect(applyFrozenMemberCorrectionEffect({
      commandType: "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY",
      effect: prepared.preview.effect as Record<string, unknown>,
      basisVersions: await previewBasisVersions(prepared.preview.previewId),
      label: "void-source-document-sql-boundary"
    })).rejects.toMatchObject({ constraint: "membership_void_reconversion_preview_binding" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("rejects a VOID root whose evidence differs from the used Preview", async () => {
    const setup = await prepareVoidReconversion("void-preview-root-binding");
    const prepared = await preview(setup.command, "void-preview-root-binding");
    const before = await membershipCommandBusinessGraphSnapshot();
    await installMembershipCommandScopeAttack({
      table: "membership_void_reconversions",
      timing: "BEFORE",
      body: "NEW.evidence_note := '数据库伪造的另一份作废重建证据';"
    });
    try {
      await expect(applyFrozenMemberCorrectionEffect({
        commandType: "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY",
        effect: prepared.preview.effect as Record<string, unknown>,
        basisVersions: await previewBasisVersions(prepared.preview.previewId),
        label: "void-preview-root-binding"
      })).rejects.toMatchObject({ constraint: "membership_void_reconversion_preview_binding" });
      expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
    } finally {
      await clearMembershipCommandScopeAttackTrigger();
    }
  });

  it("binds every old direct collection in a VOID Preview to its immutable payment fact", async () => {
    const setup = await prepareVoidReconversion("void-preview-payment-binding");
    const prepared = await preview(setup.command, "void-preview-payment-binding");
    const before = await membershipCommandBusinessGraphSnapshot();

    for (const attack of [
      {
        label: "transaction-reference",
        mutate: (collection: Record<string, unknown>) => {
          collection.transactionReference = "WECOM-FORGED-OLD-DIRECT-REFERENCE";
        }
      },
      {
        label: "business-date",
        mutate: (collection: Record<string, unknown>) => {
          collection.businessDate = "2026-01-01";
        }
      }
    ]) {
      const forgedEffect = structuredClone(prepared.preview.effect) as Record<string, unknown>;
      const oldMembership = forgedEffect.oldMembership as Record<string, unknown>;
      const directCollections = oldMembership.directCollections as Array<Record<string, unknown>>;
      attack.mutate(directCollections[0]!);

      await expect(applyFrozenMemberCorrectionEffect({
        commandType: "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY",
        effect: forgedEffect,
        basisVersions: await previewBasisVersions(prepared.preview.previewId),
        label: `void-preview-payment-binding-${attack.label}`
      })).rejects.toMatchObject({ constraint: "membership_void_reconversion_preview_binding" });
      expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
    }
  });

  it("binds a VOID correction to the old membership and source stay versions frozen in its Preview", async () => {
    const setup = await prepareVoidReconversion("void-preview-basis-binding");
    const prepared = await preview(setup.command, "void-preview-basis-binding");
    const forgedBasis = await previewBasisVersions(prepared.preview.previewId);
    const sourceOrder = forgedBasis.sourceOrder as Record<string, unknown>;
    sourceOrder.version = (sourceOrder.version as number) + 1;
    const before = await membershipCommandBusinessGraphSnapshot();

    await expect(applyFrozenMemberCorrectionEffect({
      commandType: "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY",
      effect: prepared.preview.effect as Record<string, unknown>,
      basisVersions: forgedBasis,
      label: "void-preview-basis-binding"
    })).rejects.toMatchObject({ constraint: "membership_void_reconversion_preview_binding" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("rebuilds a stay-funded membership without a replacement payment when the transfer equals the agreed price", async () => {
    const setup = await prepareVoidReconversion("void-zero-replacement", { matchStayTransfer: true });
    expect(setup.command.input.replacementDirectPayment).toBeUndefined();
    const prepared = await preview(setup.command, "void-zero-replacement");
    expect(prepared.preview.effect).toMatchObject({
      funds: {
        stayTransferTotal: { currency: "CNY", minorUnits: setup.sourceStay.collectionAmountMinor },
        membershipAgreedPrice: { currency: "CNY", minorUnits: setup.sourceStay.collectionAmountMinor },
        replacementDirectPayment: null
      }
    });
    const receipt = await confirmCommandPreview(db, administrator, prepared.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: setup.command.commandType,
      confirmation: true,
      expectedEffectHash: prepared.preview.effectHash,
      reason: { code: "DATA_ENTRY_CORRECTION", note: "住宿收款恰好覆盖会员成交价" }
    }, metadata("void-zero-replacement-confirm"));
    expect(receipt).toMatchObject({ businessCommitted: true, executionStatus: "EXECUTED" });
    const newMembershipOrderId = receipt.result!.membershipOrderId as string;
    const [payments, reconversion] = await Promise.all([
      db.selectFrom("membership_payment_facts").selectAll().where("membership_order_id", "=", newMembershipOrderId).execute(),
      db.selectFrom("membership_void_reconversions").selectAll()
        .where("old_membership_order_id", "=", setup.oldMembershipOrderId).executeTakeFirstOrThrow()
    ]);
    expect(payments).toEqual([expect.objectContaining({
      source_type: "STAY_COLLECTION_TRANSFER",
      amount_minor: setup.sourceStay.collectionAmountMinor,
      net_effect_minor: setup.sourceStay.collectionAmountMinor
    })]);
    expect(reconversion.replacement_payment_fact_id).toBeNull();
  });

  it("rebuilds an underpaid completed stay from its real net collection and derives the full membership difference", async () => {
    const setup = await prepareVoidReconversion("void-underpaid-stay", { sourceContractAmountMinor: 30_000 });
    const prepared = await preview(setup.command, "void-underpaid-stay");
    expect(setup.sourceStay).toMatchObject({ contractAmountMinor: 30_000, collectionAmountMinor: 20_000 });
    expect(prepared.preview.effect).toMatchObject({
      funds: {
        stayTransferTotal: { currency: "CNY", minorUnits: 20_000 },
        replacementDirectPayment: { amount: { currency: "CNY", minorUnits: 73_600 } },
        membershipAgreedPrice: { currency: "CNY", minorUnits: 93_600 }
      }
    });

    const receipt = await confirmCommandPreview(db, administrator, prepared.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: setup.command.commandType,
      confirmation: true,
      expectedEffectHash: prepared.preview.effectHash,
      reason: { code: "DATA_ENTRY_CORRECTION", note: "按历史住宿真实净收款计算会员差额" }
    }, metadata("void-underpaid-stay-confirm"));
    expect(receipt).toMatchObject({
      executionStatus: "EXECUTED",
      businessCommitted: true,
      result: {
        transferredAmount: { currency: "CNY", minorUnits: 20_000 },
        replacementDirectPaymentAmount: { currency: "CNY", minorUnits: 73_600 },
        membershipAgreedPrice: { currency: "CNY", minorUnits: 93_600 }
      }
    });
  });

  it("allows replacement direct-payment evidence on a different non-future business day", async () => {
    const setup = await prepareVoidReconversion("void-cross-day-replacement");
    const replacement = setup.command.input.replacementDirectPayment as Record<string, unknown>;
    const replacementBusinessDate = shiftLocalDate(setup.sourceStay.arrivalDate, 1);
    const command = envelope(setup.command.commandType, {
      ...setup.command.input,
      replacementDirectPayment: {
        ...replacement,
        businessDate: replacementBusinessDate,
        transactionReference: "WECOM-VOID-CROSS-DAY-REPLACEMENT"
      }
    });
    const receipt = await confirm(command, "void-cross-day-replacement");
    expect(receipt).toMatchObject({ businessCommitted: true, executionStatus: "EXECUTED" });
    expect(receipt.result).toMatchObject({
      funds: {
        replacementDirectPayment: {
          businessDate: replacementBusinessDate,
          transactionReference: "WECOM-VOID-CROSS-DAY-REPLACEMENT"
        }
      }
    });
    const payment = await db.selectFrom("membership_payment_facts").selectAll()
      .where("fact_id", "=", receipt.result!.replacementPaymentFactId as string)
      .executeTakeFirstOrThrow();
    expect(payment.business_date).toBe(replacementBusinessDate);
  });

  it("serializes two concurrent VOID confirmations into one correction graph", async () => {
    const setup = await prepareVoidReconversion("concurrent-void");
    const [first, second] = await Promise.all([
      preview(setup.command, "concurrent-void-first"),
      preview(setup.command, "concurrent-void-second")
    ]);
    const confirmPrepared = (prepared: Awaited<ReturnType<typeof preview>>, prefix: string) =>
      confirmCommandPreview(db, administrator, prepared.preview.previewId, {
        propertyId: demo.propertyId,
        commandType: setup.command.commandType,
        confirmation: true,
        expectedEffectHash: prepared.preview.effectHash,
        reason: { code: "DATA_ENTRY_CORRECTION", note: "同一错误会员链只能作废重建一次" }
      }, metadata(prefix));
    const receipts = await Promise.all([
      confirmPrepared(first, "concurrent-void-first-confirm"),
      confirmPrepared(second, "concurrent-void-second-confirm")
    ]);

    expect(receipts.filter((receipt) => receipt.businessCommitted && receipt.executionStatus === "EXECUTED")).toHaveLength(1);
    expect(receipts.filter((receipt) => !receipt.businessCommitted && receipt.executionStatus === "NOT_EXECUTED")).toHaveLength(1);
    expect(await db.selectFrom("membership_void_reconversions").select("id")
      .where("old_membership_order_id", "=", setup.oldMembershipOrderId).execute()).toHaveLength(1);
  });

  it("serializes stale BACKFILL against VOID on the same member without deadlock", async () => {
    const memberId = await createMember("void-backfill-race-member");
    const actualMembershipDate = shiftLocalDate(await propertyLocalToday(db, demo.propertyId), -20);
    const backfillCommand = envelope("BACKFILL_HISTORICAL_MEMBERSHIP", {
      propertyId: demo.propertyId,
      memberId,
      membershipProductId: "membership_product_shared_bath_quad_v1",
      actualMembershipDate,
      payment: {
        amountMinor: 93_600,
        businessDate: actualMembershipDate,
        transactionReference: "WECOM-VOID-BACKFILL-RACE"
      },
      evidenceNote: "VOID 与历史补录必须按同一会员锁顺序串行"
    });
    const backfillPreview = await preview(backfillCommand, "void-backfill-race-backfill");
    const setup = await prepareVoidReconversion("void-backfill-race", { memberId });
    const voidPreview = await preview(setup.command, "void-backfill-race-void");
    const [backfillReceipt, voidReceipt] = await Promise.all([
      confirmCommandPreview(db, administrator, backfillPreview.preview.previewId, {
        propertyId: demo.propertyId,
        commandType: backfillCommand.commandType,
        confirmation: true,
        expectedEffectHash: backfillPreview.preview.effectHash,
        reason: { code: "DATA_ENTRY_CORRECTION", note: "并发历史补录" }
      }, metadata("void-backfill-race-backfill-confirm")),
      confirmCommandPreview(db, administrator, voidPreview.preview.previewId, {
        propertyId: demo.propertyId,
        commandType: setup.command.commandType,
        confirmation: true,
        expectedEffectHash: voidPreview.preview.effectHash,
        reason: { code: "DATA_ENTRY_CORRECTION", note: "并发错误会员链作废重建" }
      }, metadata("void-backfill-race-void-confirm"))
    ]);

    expect(backfillReceipt).toMatchObject({ businessCommitted: false, executionStatus: "NOT_EXECUTED" });
    expect(voidReceipt).toMatchObject({ businessCommitted: true, executionStatus: "EXECUTED" });
    expect(await db.selectFrom("historical_membership_backfills").select("id")
      .where("member_id", "=", memberId).execute()).toEqual([]);
    expect(await db.selectFrom("membership_void_reconversions").select("id")
      .where("member_id", "=", memberId).execute()).toHaveLength(1);
  });

  it("rejects stale VOID confirms after duplicate replacement evidence or a real refund", async () => {
    const cases = ["duplicate-replacement", "refunded-stay"] as const;

    for (const [index, kind] of cases.entries()) {
      if (index > 0) {
        await db.destroy();
        db = await resetDatabase(databaseUrl);
      }
      const setup = await prepareVoidReconversion(`void-reject-${kind}`);
      let otherMembershipOrderId: string | undefined;
      if (kind === "duplicate-replacement") {
        const memberId = await createMember(`void-reject-${kind}-other-member`);
        const otherOrder = await confirm({
          commandType: "CREATE_MEMBERSHIP_ORDER",
          input: {
            propertyId: demo.propertyId,
            memberId,
            membershipProductId: "membership_product_shared_bath_quad_v1",
            agreedPriceMinor: 93_600
          }
        }, `void-reject-${kind}-other-order`, ordinaryStaff);
        otherMembershipOrderId = otherOrder.result!.membershipOrderId as string;
      }
      const prepared = await preview(setup.command, `void-reject-${kind}`);
      const replacement = setup.command.input.replacementDirectPayment as Record<string, unknown>;

      if (kind === "duplicate-replacement") {
        await confirm({
          commandType: "RECORD_MEMBERSHIP_PAYMENT",
          input: {
            propertyId: demo.propertyId,
            membershipOrderId: otherMembershipOrderId!,
            amountMinor: 93_600,
            transactionReference: replacement.transactionReference
          }
        }, `void-reject-${kind}-conflicting-payment`, ordinaryStaff);
      } else if (kind === "refunded-stay") {
        await confirm({
          commandType: "RECORD_REFUND",
          input: {
            propertyId: demo.propertyId,
            orderId: setup.sourceStay.orderId,
            referencesFactId: setup.sourceStay.collectionFactId,
            amountMinor: 1,
            method: "WECOM",
            note: "真实退款不能伪装为会员重分类"
          }
        }, `void-reject-${kind}-refund`, ordinaryStaff);
      }
      const beforeConfirm = await membershipCommandBusinessGraphSnapshot();
      const receipt = await confirmCommandPreview(db, administrator, prepared.preview.previewId, {
        propertyId: demo.propertyId,
        commandType: setup.command.commandType,
        confirmation: true,
        expectedEffectHash: prepared.preview.effectHash,
        reason: { code: "DATA_ENTRY_CORRECTION", note: `重建前事实变化：${kind}` }
      }, metadata(`void-reject-${kind}-confirm`));
      expect(receipt).toMatchObject({ executionStatus: "NOT_EXECUTED", businessCommitted: false });
      expect(await membershipCommandBusinessGraphSnapshot()).toEqual(beforeConfirm);
    }
  });

  it("rejects VOID when another legacy ACTIVE projection exists at both application and SQL boundaries", async () => {
    const setup = await prepareVoidReconversion("void-legacy-active");
    const preparedBeforeLegacy = await preview(setup.command, "void-legacy-active-frozen");
    const oldOrder = await db.selectFrom("membership_orders").select("member_id")
      .where("id", "=", setup.oldMembershipOrderId).executeTakeFirstOrThrow();
    await insertLegacyActiveProjection({
      memberId: oldOrder.member_id,
      prefix: "void-active",
      unitKind: "ROOM_NIGHT"
    });
    const before = await membershipCommandBusinessGraphSnapshot();

    await expect(preview(setup.command, "void-legacy-active-application"))
      .rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    await expect(applyFrozenMemberCorrectionEffect({
      commandType: "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY",
      effect: preparedBeforeLegacy.preview.effect as Record<string, unknown>,
      basisVersions: await previewBasisVersions(preparedBeforeLegacy.preview.previewId),
      label: "void-legacy-active"
    })).rejects.toThrow(/membership void and stay reconversion must conserve one complete typed graph/i);
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("rejects a frozen VOID graph when the stay has historical refund evidence even after refund reversal", async () => {
    const setup = await prepareVoidReconversion("void-historical-refund");
    const preparedBeforeRefund = await preview(setup.command, "void-historical-refund-frozen");
    const refund = await confirm({
      commandType: "RECORD_REFUND",
      input: {
        propertyId: demo.propertyId,
        orderId: setup.sourceStay.orderId,
        referencesFactId: setup.sourceStay.collectionFactId,
        amountMinor: 1,
        method: "WECOM",
        note: "真实退款历史必须永久阻断作废重建"
      }
    }, "void-historical-refund-record", ordinaryStaff);
    await confirm({
      commandType: "REVERSE_FACT",
      input: {
        propertyId: demo.propertyId,
        orderId: setup.sourceStay.orderId,
        reversesFactId: refund.result!.factId,
        note: "冲销退款不删除真实退款历史"
      }
    }, "void-historical-refund-reverse", ordinaryStaff);
    const before = await membershipCommandBusinessGraphSnapshot();

    await expect(applyFrozenMemberCorrectionEffect({
      commandType: "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY",
      effect: preparedBeforeRefund.preview.effect as Record<string, unknown>,
      basisVersions: await previewBasisVersions(preparedBeforeRefund.preview.previewId),
      label: "void-historical-refund"
    })).rejects.toThrow(/membership void and stay reconversion must conserve one complete typed graph/i);
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("rejects a VOID preview missing derived replacement evidence without writing business facts", async () => {
    const setup = await prepareVoidReconversion("void-missing-replacement");
    const { replacementDirectPayment: _replacementDirectPayment, ...withoutReplacement } = setup.command.input;
    const before = await membershipCommandBusinessGraphSnapshot();
    await expect(preview(envelope("VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY", withoutReplacement), "void-missing-replacement"))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
  });

  it("rejects injected backfill snapshot or recorded-at mutations with no partial membership chain", async () => {
    const attacks = [
      {
        label: "product-snapshot",
        body: `
          UPDATE membership_orders
          SET product_code = 'TAMPERED-PRODUCT-SNAPSHOT'
          WHERE id = NEW.membership_order_id;`
      },
      {
        label: "recorded-at",
        body: `
          UPDATE historical_membership_backfills
          SET created_at = NEW.created_at - interval '1 day'
          WHERE id = NEW.id;`
      }
    ];

    for (const [index, attack] of attacks.entries()) {
      if (index > 0) {
        await db.destroy();
        db = await resetDatabase(databaseUrl);
      }
      const memberId = await createMember(`backfill-malicious-${attack.label}`);
      const actualMembershipDate = shiftLocalDate(await propertyLocalToday(db, demo.propertyId), -20);
      const command = envelope("BACKFILL_HISTORICAL_MEMBERSHIP", {
        propertyId: demo.propertyId,
        memberId,
        membershipProductId: "membership_product_shared_bath_quad_v1",
        actualMembershipDate,
        payment: {
          amountMinor: 93_600,
          businessDate: actualMembershipDate,
          transactionReference: `WECOM-BACKFILL-MALICIOUS-${attack.label}`
        },
        evidenceNote: `恶意 SQL ${attack.label} 必须被历史补录图拒绝`
      });
      const prepared = await preview(command, `backfill-malicious-${attack.label}`);
      const before = await membershipCommandBusinessGraphSnapshot();
      await installMembershipCommandScopeAttack({ table: "historical_membership_backfills", body: attack.body });
      try {
        const receipt = await confirmCommandPreview(db, administrator, prepared.preview.previewId, {
          propertyId: demo.propertyId,
          commandType: command.commandType,
          confirmation: true,
          expectedEffectHash: prepared.preview.effectHash,
          reason: { code: "DATA_ENTRY_CORRECTION", note: `恶意 SQL ${attack.label}` }
        }, metadata(`backfill-malicious-${attack.label}-confirm`));
        expect(receipt, attack.label).toMatchObject({ executionStatus: "NOT_EXECUTED", businessCommitted: false });
        expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
      } finally {
        await clearMembershipCommandScopeAttackTrigger();
      }
    }
  });

  it("rejects injected VOID prior-revision, sole-active-chain, and replacement-business-date corruption", async () => {
    const attacks: Array<{
      label: string;
      table: "membership_void_reconversions" | "membership_payment_facts" | "pricing_revisions";
      timing?: "BEFORE" | "AFTER";
      declarations?: string;
      body: string;
    }> = [
      {
        label: "prior-revision-understates-transfer",
        table: "pricing_revisions",
        timing: "AFTER",
        body: `
          IF NEW.pricing_basis = 'MEMBER_ENTITLEMENT' THEN
            UPDATE pricing_revisions
            SET current_contract_amount_minor = current_contract_amount_minor - 100
            WHERE order_id = NEW.order_id
              AND revision_no = NEW.revision_no - 1;
          END IF;`
      },
      {
        label: "sole-active-chain",
        table: "membership_void_reconversions",
        declarations: `
          DECLARE
            extra_order_id text := 'void-malicious-extra-active-' || txid_current();`,
        body: `
          INSERT INTO membership_orders (
            id, property_id, member_id, product_id, product_code, product_version, product_name,
            listed_price_minor, agreed_price_minor, price_adjustment_minor, price_adjustment_reason,
            currency, entitlement_unit_kind, entitlement_units, allowed_room_type_code, allowed_inventory_kind,
            status, activated_at, valid_from, valid_until, contract_id, entitlement_lot_id, version,
            created_by_command_id, activated_by_command_id
          )
          SELECT extra_order_id, property_id, member_id, product_id, product_code, product_version, product_name,
            listed_price_minor, agreed_price_minor, price_adjustment_minor, price_adjustment_reason,
            currency, entitlement_unit_kind, entitlement_units, allowed_room_type_code, allowed_inventory_kind,
            'ACTIVE', now(), valid_from, valid_until, contract_id, entitlement_lot_id, 1,
            NEW.command_id, NEW.command_id
          FROM membership_orders WHERE id = NEW.old_membership_order_id;`
      },
      {
        label: "replacement-business-date",
        table: "membership_payment_facts",
        timing: "BEFORE",
        body: `
          IF NEW.note = '错误办卡作废后，实际差额收款计入新会员订单' THEN
            NEW.business_date := NEW.business_date + 1;
          END IF;`
      }
    ];
    const acceptedAttackLabels: string[] = [];

    for (const [index, attack] of attacks.entries()) {
      if (index > 0) {
        await db.destroy();
        db = await resetDatabase(databaseUrl);
      }
      const setup = await prepareVoidReconversion(`void-malicious-${attack.label}`);
      const prepared = await preview(setup.command, `void-malicious-${attack.label}`);
      const before = await membershipCommandBusinessGraphSnapshot();
      const disablesPricingRevisionAppendOnly = attack.table === "pricing_revisions";
      if (disablesPricingRevisionAppendOnly) {
        await sql.raw("ALTER TABLE pricing_revisions DISABLE TRIGGER pricing_revisions_append_only").execute(db);
      }
      try {
        await installMembershipCommandScopeAttack({
          table: attack.table,
          ...(attack.timing ? { timing: attack.timing } : {}),
          ...(attack.declarations ? { declarations: attack.declarations } : {}),
          body: attack.body
        });
        const receipt = await confirmCommandPreview(db, administrator, prepared.preview.previewId, {
          propertyId: demo.propertyId,
          commandType: setup.command.commandType,
          confirmation: true,
          expectedEffectHash: prepared.preview.effectHash,
          reason: { code: "DATA_ENTRY_CORRECTION", note: `恶意 SQL ${attack.label}` }
        }, metadata(`void-malicious-${attack.label}-confirm`));
        if (receipt.executionStatus !== "NOT_EXECUTED" || receipt.businessCommitted) {
          acceptedAttackLabels.push(attack.label);
        } else {
          expect(await membershipCommandBusinessGraphSnapshot(), attack.label).toEqual(before);
        }
      } finally {
        await clearMembershipCommandScopeAttackTrigger();
        if (disablesPricingRevisionAppendOnly) {
          await sql.raw("ALTER TABLE pricing_revisions ENABLE TRIGGER pricing_revisions_append_only").execute(db);
        }
      }
    }
    expect(acceptedAttackLabels).toEqual([]);
  });

  it("rejects a replacement direct-payment reference already used by another membership payment or lodging collection", async () => {
    const setup = await prepareVoidReconversion("replacement-reference-conflict");
    const otherMemberId = await createMember("replacement-reference-other-member");
    const otherOrderReceipt = await confirm({
      commandType: "CREATE_MEMBERSHIP_ORDER",
      input: {
        propertyId: demo.propertyId,
        memberId: otherMemberId,
        membershipProductId: "membership_product_shared_bath_quad_v1",
        agreedPriceMinor: 93_600
      }
    }, "replacement-reference-other-order", ordinaryStaff);
    const otherMembershipReference = "WECOM-REPLACEMENT-REFERENCE-OTHER-MEMBERSHIP";
    await confirm({
      commandType: "RECORD_MEMBERSHIP_PAYMENT",
      input: {
        propertyId: demo.propertyId,
        membershipOrderId: otherOrderReceipt.result!.membershipOrderId as string,
        amountMinor: 93_600,
        transactionReference: otherMembershipReference
      }
    }, "replacement-reference-other-payment", ordinaryStaff);
    const otherMember = await db.selectFrom("members").selectAll().where("id", "=", otherMemberId).executeTakeFirstOrThrow();
    const otherStay = await createCompletedWecomStay({
      prefix: "replacement-reference-other-stay",
      phone: otherMember.phone,
      documentNumber: otherMember.identity_card_number!
    });
    const before = await membershipCommandBusinessGraphSnapshot();
    const replacement = setup.command.input.replacementDirectPayment as Record<string, unknown>;

    for (const [label, transactionReference] of [
      ["membership", otherMembershipReference],
      ["membership-trimmed", ` ${otherMembershipReference} `],
      ["lodging", otherStay.collectionTransactionReference]
    ] as const) {
      await expect(preview(envelope("VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY", {
        ...setup.command.input,
        replacementDirectPayment: { ...replacement, transactionReference }
      }), `replacement-reference-${label}`)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
    }
  });

  it("serializes concurrent direct historical backfills so one transaction reference cannot commit twice", async () => {
    const [firstMemberId, secondMemberId] = await Promise.all([
      createMember("concurrent-backfill-first"),
      createMember("concurrent-backfill-second")
    ]);
    const actualMembershipDate = shiftLocalDate(await propertyLocalToday(db, demo.propertyId), -20);
    const transactionReference = "WECOM-CONCURRENT-DIRECT-BACKFILL";
    const commandFor = (memberId: string) => envelope("BACKFILL_HISTORICAL_MEMBERSHIP", {
      propertyId: demo.propertyId,
      memberId,
      membershipProductId: "membership_product_shared_bath_quad_v1",
      actualMembershipDate,
      payment: {
        amountMinor: 93_600,
        businessDate: actualMembershipDate,
        transactionReference
      },
      evidenceNote: "同一真实交易引用只能补录一次"
    });
    const [firstCommand, secondCommand] = [commandFor(firstMemberId), commandFor(secondMemberId)];
    const [firstPreview, secondPreview] = await Promise.all([
      preview(firstCommand, "concurrent-backfill-first"),
      preview(secondCommand, "concurrent-backfill-second")
    ]);
    const confirmPrepared = (command: CommandEnvelope, prepared: Awaited<ReturnType<typeof preview>>, prefix: string) =>
      confirmCommandPreview(db, administrator, prepared.preview.previewId, {
        propertyId: demo.propertyId,
        commandType: command.commandType,
        confirmation: true,
        expectedEffectHash: prepared.preview.effectHash,
        reason: { code: "DATA_ENTRY_CORRECTION", note: "并发直收历史补录" }
      }, metadata(prefix));
    const [firstReceipt, secondReceipt] = await Promise.all([
      confirmPrepared(firstCommand, firstPreview, "concurrent-backfill-first-confirm"),
      confirmPrepared(secondCommand, secondPreview, "concurrent-backfill-second-confirm")
    ]);
    const receipts = [firstReceipt, secondReceipt];
    expect(receipts.filter((receipt) => receipt.businessCommitted && receipt.executionStatus === "EXECUTED")).toHaveLength(1);
    expect(receipts.filter((receipt) => !receipt.businessCommitted && receipt.executionStatus === "NOT_EXECUTED")).toHaveLength(1);
    expect(await db.selectFrom("membership_payment_facts").select("fact_id")
      .where("transaction_reference", "=", transactionReference).execute()).toHaveLength(1);
    expect(await db.selectFrom("admin_membership_payment_evidence_claims").selectAll()
      .where("normalized_reference", "=", transactionReference).execute()).toEqual([
      expect.objectContaining({
        correction_type: "BACKFILL_HISTORICAL_MEMBERSHIP"
      })
    ]);
    expect(await db.selectFrom("membership_orders").select(["id", "member_id", "status"])
      .where("member_id", "in", [firstMemberId, secondMemberId]).execute())
      .toEqual([expect.objectContaining({ status: "ACTIVE" })]);
  });

  it("rejects edge-whitespace aliases of an administrator payment-evidence claim", async () => {
    const memberId = await createMember("claimed-reference-edge-whitespace");
    const actualMembershipDate = shiftLocalDate(await propertyLocalToday(db, demo.propertyId), -20);
    const transactionReference = "WECOM-CLAIMED-EDGE-WHITESPACE";
    const receipt = await confirm({
      commandType: "BACKFILL_HISTORICAL_MEMBERSHIP",
      input: {
        propertyId: demo.propertyId,
        memberId,
        membershipProductId: "membership_product_shared_bath_quad_v1",
        actualMembershipDate,
        payment: {
          amountMinor: 93_600,
          businessDate: actualMembershipDate,
          transactionReference
        },
        evidenceNote: "验证付款证据的空白规范化边界"
      }
    }, "claimed-reference-edge-whitespace");
    const claimedPaymentFactId = receipt.result!.paymentFactId as string;
    const claim = await db.selectFrom("admin_membership_payment_evidence_claims").selectAll()
      .where("normalized_reference", "=", transactionReference).executeTakeFirstOrThrow();
    expect(claim.membership_payment_fact_id).toBe(claimedPaymentFactId);

    await expect(db.insertInto("membership_payment_facts").values({
      fact_id: "membership_payment_claim_edge_whitespace_attack",
      membership_order_id: demo.membershipOrderId,
      fact_type: "COLLECTION",
      amount_minor: 100,
      net_effect_minor: 100,
      currency: "CNY",
      transaction_reference: `\t${transactionReference}\n`,
      corrects_fact_id: null,
      reverses_fact_id: null,
      source_type: "DIRECT_WECOM",
      source_order_id: null,
      source_collection_fact_id: null,
      note: "edge-whitespace claim bypass attempt",
      command_id: claim.command_id,
      business_date: await propertyLocalToday(db, demo.propertyId)
    }).execute()).rejects.toThrow(/reserved as administrator correction evidence|admin_membership_payment_evidence_claims/i);
    expect(await db.selectFrom("membership_payment_facts").select("fact_id")
      .where("fact_id", "=", "membership_payment_claim_edge_whitespace_attack").execute()).toEqual([]);
  });

  it("allows ordinary lodging and membership collections to share a transaction reference", async () => {
    const memberId = await createMember("cross-table-reference-race");
    const membershipOrderReceipt = await confirm({
      commandType: "CREATE_MEMBERSHIP_ORDER",
      input: {
        propertyId: demo.propertyId,
        memberId,
        membershipProductId: "membership_product_shared_bath_quad_v1",
        agreedPriceMinor: 93_600
      }
    }, "cross-table-reference-membership-order", ordinaryStaff);
    const membershipOrderId = membershipOrderReceipt.result!.membershipOrderId as string;
    const arrivalDate = shiftLocalDate(await propertyLocalToday(db, demo.propertyId), 20);
    const departureDate = shiftLocalDate(arrivalDate, 1);
    const quote = await createQuoteForTesting(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: "unit_room_d_gen_01",
      stayType: "TRANSIENT",
      arrivalDate,
      departureDate,
      pricingPolicyVersionId: demo.publicPricingPolicyId
    });
    const stayOrderReceipt = await confirm({
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: quote.quoteId,
        primaryGuest: {
          fullName: "跨表交易号验证",
          nickname: "跨表验证",
          phone: "13600009123",
          documentNumber: "CROSS-TABLE-REFERENCE"
        },
        bookingChannelCode: "WECOM",
        channelOrderReference: null,
        targetCurrentContractAmountMinor: 20_000,
        manualPriceAdjustmentReason: "跨表交易引用竞争测试"
      }
    }, "cross-table-reference-stay-order", ordinaryStaff);
    const stayOrderId = stayOrderReceipt.result!.orderId as string;
    const transactionReference = "WECOM-CROSS-TABLE-REFERENCE-RACE";
    const membershipCommand = envelope("RECORD_MEMBERSHIP_PAYMENT", {
      propertyId: demo.propertyId,
      membershipOrderId,
      amountMinor: 93_600,
      transactionReference
    });
    const lodgingCommand = envelope("RECORD_COLLECTION", {
      propertyId: demo.propertyId,
      orderId: stayOrderId,
      amountMinor: 20_000,
      method: "WECOM",
      transactionReference,
      note: "跨表交易引用竞争测试"
    });
    const [membershipPreview, lodgingPreview] = await Promise.all([
      preview(membershipCommand, "cross-table-reference-membership", ordinaryStaff),
      preview(lodgingCommand, "cross-table-reference-lodging", ordinaryStaff)
    ]);
    const confirmPrepared = (command: CommandEnvelope, prepared: Awaited<ReturnType<typeof preview>>, prefix: string) =>
      confirmCommandPreview(db, ordinaryStaff, prepared.preview.previewId, {
        propertyId: demo.propertyId,
        commandType: command.commandType,
        confirmation: true,
        expectedEffectHash: prepared.preview.effectHash,
        reason: { code: "CROSS_TABLE_REFERENCE_RACE", note: "普通资金事实允许保留既有重复交易号语义" }
      }, metadata(prefix));
    const receipts = await Promise.all([
      confirmPrepared(membershipCommand, membershipPreview, "cross-table-reference-membership-confirm"),
      confirmPrepared(lodgingCommand, lodgingPreview, "cross-table-reference-lodging-confirm")
    ]);

    expect(receipts.filter((receipt) => receipt.businessCommitted && receipt.executionStatus === "EXECUTED")).toHaveLength(2);
    const claims = await db.selectFrom("admin_membership_payment_evidence_claims").selectAll()
      .where("normalized_reference", "=", transactionReference).execute();
    expect(claims).toEqual([]);
    const facts = await sql<{ count: string }>`
      SELECT count(*)::text AS count
      FROM (
        SELECT fact_id FROM collection_facts WHERE transaction_reference = ${transactionReference}
        UNION ALL
        SELECT fact_id FROM membership_payment_facts WHERE transaction_reference = ${transactionReference}
      ) AS combined
    `.execute(db);
    expect(facts.rows[0]?.count).toBe("2");
  });

  it("atomically arbitrates a historical backfill against an ordinary payment using the same reference", async () => {
    const [backfillMemberId, ordinaryMemberId] = await Promise.all([
      createMember("backfill-ordinary-race-backfill"),
      createMember("backfill-ordinary-race-ordinary")
    ]);
    const ordinaryOrderReceipt = await confirm({
      commandType: "CREATE_MEMBERSHIP_ORDER",
      input: {
        propertyId: demo.propertyId,
        memberId: ordinaryMemberId,
        membershipProductId: "membership_product_shared_bath_quad_v1",
        agreedPriceMinor: 93_600
      }
    }, "backfill-ordinary-race-order", ordinaryStaff);
    const ordinaryMembershipOrderId = ordinaryOrderReceipt.result!.membershipOrderId as string;
    const actualMembershipDate = shiftLocalDate(await propertyLocalToday(db, demo.propertyId), -20);
    const transactionReference = "WECOM-BACKFILL-ORDINARY-RACE";
    const backfillCommand = envelope("BACKFILL_HISTORICAL_MEMBERSHIP", {
      propertyId: demo.propertyId,
      memberId: backfillMemberId,
      membershipProductId: "membership_product_shared_bath_quad_v1",
      actualMembershipDate,
      payment: {
        amountMinor: 93_600,
        businessDate: actualMembershipDate,
        transactionReference
      },
      evidenceNote: "主管历史补录与普通收款并发时不得复用付款证据"
    });
    const ordinaryCommand = envelope("RECORD_MEMBERSHIP_PAYMENT", {
      propertyId: demo.propertyId,
      membershipOrderId: ordinaryMembershipOrderId,
      amountMinor: 93_600,
      transactionReference
    });
    const [backfillPreview, ordinaryPreview] = await Promise.all([
      preview(backfillCommand, "backfill-ordinary-race-backfill"),
      preview(ordinaryCommand, "backfill-ordinary-race-ordinary", ordinaryStaff)
    ]);
    const [backfillReceipt, ordinaryReceipt] = await Promise.all([
      confirmCommandPreview(db, administrator, backfillPreview.preview.previewId, {
        propertyId: demo.propertyId,
        commandType: backfillCommand.commandType,
        confirmation: true,
        expectedEffectHash: backfillPreview.preview.effectHash,
        reason: { code: "DATA_ENTRY_CORRECTION", note: "并发历史补录付款证据验证" }
      }, metadata("backfill-ordinary-race-backfill-confirm")),
      confirmCommandPreview(db, ordinaryStaff, ordinaryPreview.preview.previewId, {
        propertyId: demo.propertyId,
        commandType: ordinaryCommand.commandType,
        confirmation: true,
        expectedEffectHash: ordinaryPreview.preview.effectHash,
        reason: { code: "RECORD_MEMBERSHIP_PAYMENT", note: "并发普通会员收款验证" }
      }, metadata("backfill-ordinary-race-ordinary-confirm"))
    ]);

    const receipts = [backfillReceipt, ordinaryReceipt];
    expect(receipts.filter((receipt) => receipt.businessCommitted && receipt.executionStatus === "EXECUTED")).toHaveLength(1);
    expect(receipts.filter((receipt) => !receipt.businessCommitted && receipt.executionStatus === "NOT_EXECUTED")).toHaveLength(1);
    expect(await db.selectFrom("membership_payment_facts").select("fact_id")
      .where("transaction_reference", "=", transactionReference).execute()).toHaveLength(1);
    const claims = await db.selectFrom("admin_membership_payment_evidence_claims").selectAll()
      .where("normalized_reference", "=", transactionReference).execute();
    const backfillCommitted = backfillReceipt.businessCommitted && backfillReceipt.executionStatus === "EXECUTED";
    expect(claims).toHaveLength(backfillCommitted ? 1 : 0);
    expect(await db.selectFrom("historical_membership_backfills").select("id")
      .where("transaction_reference", "=", transactionReference).execute()).toHaveLength(backfillCommitted ? 1 : 0);
  });

  it("atomically arbitrates a void reconversion replacement payment against an ordinary payment", async () => {
    const setup = await prepareVoidReconversion("void-ordinary-reference-race");
    const replacement = setup.command.input.replacementDirectPayment as Record<string, unknown>;
    const transactionReference = replacement.transactionReference as string;
    const ordinaryMemberId = await createMember("void-ordinary-reference-race-ordinary");
    const ordinaryOrderReceipt = await confirm({
      commandType: "CREATE_MEMBERSHIP_ORDER",
      input: {
        propertyId: demo.propertyId,
        memberId: ordinaryMemberId,
        membershipProductId: "membership_product_shared_bath_quad_v1",
        agreedPriceMinor: 93_600
      }
    }, "void-ordinary-reference-race-order", ordinaryStaff);
    const ordinaryCommand = envelope("RECORD_MEMBERSHIP_PAYMENT", {
      propertyId: demo.propertyId,
      membershipOrderId: ordinaryOrderReceipt.result!.membershipOrderId as string,
      amountMinor: 93_600,
      transactionReference
    });
    const [voidPreview, ordinaryPreview] = await Promise.all([
      preview(setup.command, "void-ordinary-reference-race-void"),
      preview(ordinaryCommand, "void-ordinary-reference-race-ordinary", ordinaryStaff)
    ]);
    const [voidReceipt, ordinaryReceipt] = await Promise.all([
      confirmCommandPreview(db, administrator, voidPreview.preview.previewId, {
        propertyId: demo.propertyId,
        commandType: setup.command.commandType,
        confirmation: true,
        expectedEffectHash: voidPreview.preview.effectHash,
        reason: { code: "DATA_ENTRY_CORRECTION", note: "并发重办卡付款证据验证" }
      }, metadata("void-ordinary-reference-race-void-confirm")),
      confirmCommandPreview(db, ordinaryStaff, ordinaryPreview.preview.previewId, {
        propertyId: demo.propertyId,
        commandType: ordinaryCommand.commandType,
        confirmation: true,
        expectedEffectHash: ordinaryPreview.preview.effectHash,
        reason: { code: "RECORD_MEMBERSHIP_PAYMENT", note: "并发普通会员收款验证" }
      }, metadata("void-ordinary-reference-race-ordinary-confirm"))
    ]);

    const receipts = [voidReceipt, ordinaryReceipt];
    expect(receipts.filter((receipt) => receipt.businessCommitted && receipt.executionStatus === "EXECUTED")).toHaveLength(1);
    expect(receipts.filter((receipt) => !receipt.businessCommitted && receipt.executionStatus === "NOT_EXECUTED")).toHaveLength(1);
    expect(await db.selectFrom("membership_payment_facts").select("fact_id")
      .where("transaction_reference", "=", transactionReference).execute()).toHaveLength(1);
    const claims = await db.selectFrom("admin_membership_payment_evidence_claims").selectAll()
      .where("normalized_reference", "=", transactionReference).execute();
    const voidCommitted = voidReceipt.businessCommitted && voidReceipt.executionStatus === "EXECUTED";
    expect(claims).toHaveLength(voidCommitted ? 1 : 0);
    expect(await db.selectFrom("membership_void_reconversions").select("id")
      .where("replacement_transaction_reference", "=", transactionReference).execute()).toHaveLength(voidCommitted ? 1 : 0);
  });

  it("takes the member entitlement lock before the order row during activation-versus-backfill", async () => {
    const memberId = await createMember("activation-backfill-lock-order");
    const orderReceipt = await confirm({
      commandType: "CREATE_MEMBERSHIP_ORDER",
      input: {
        propertyId: demo.propertyId,
        memberId,
        membershipProductId: "membership_product_shared_bath_quad_v1",
        agreedPriceMinor: 93_600
      }
    }, "activation-backfill-lock-order-create", ordinaryStaff);
    const membershipOrderId = orderReceipt.result!.membershipOrderId as string;
    await confirm({
      commandType: "RECORD_MEMBERSHIP_PAYMENT",
      input: {
        propertyId: demo.propertyId,
        membershipOrderId,
        amountMinor: 93_600,
        transactionReference: "WECOM-ACTIVATION-BACKFILL-LOCK-ORDER"
      }
    }, "activation-backfill-lock-order-payment", ordinaryStaff);
    const command = envelope("ACTIVATE_MEMBERSHIP_ORDER", {
      propertyId: demo.propertyId,
      membershipOrderId
    });
    const prepared = await preview(command, "activation-backfill-lock-order", ordinaryStaff);
    const holder = new pg.Client({ connectionString: databaseUrl });
    await holder.connect();
    let activation: Promise<ReceiptDto> | undefined;
    let activationSettled = false;
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0::bigint))",
        [`qintopia:member-entitlements:${memberId}`]
      );
      activation = confirmCommandPreview(db, ordinaryStaff, prepared.preview.previewId, {
        propertyId: demo.propertyId,
        commandType: command.commandType,
        confirmation: true,
        expectedEffectHash: prepared.preview.effectHash,
        reason: { code: "ACTIVATE_MEMBERSHIP_ORDER", note: "验证激活与历史补录锁顺序" }
      }, metadata("activation-backfill-lock-order-confirm")).finally(() => {
        activationSettled = true;
      });

      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      expect(activationSettled).toBe(false);

      await holder.query("SET LOCAL lock_timeout = '1s'");
      const backfillOrderLock = await holder.query<{ id: string }>(
        "SELECT id FROM membership_orders WHERE id = $1 FOR UPDATE",
        [membershipOrderId]
      );
      expect(backfillOrderLock.rows).toEqual([{ id: membershipOrderId }]);
      await holder.query("ROLLBACK");

      await expect(activation).resolves.toMatchObject({
        businessCommitted: true,
        executionStatus: "EXECUTED"
      });
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      if (activation) await activation.catch(() => undefined);
      await holder.end();
    }
  });

  it("takes the member entitlement lock before the source stay row during conversion-versus-void", async () => {
    const setup = await prepareVoidReconversion("conversion-void-lock-order");
    const memberId = (await db.selectFrom("membership_orders").select("member_id")
      .where("id", "=", setup.oldMembershipOrderId).executeTakeFirstOrThrow()).member_id;
    const conversionCommand = envelope("CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP", {
      propertyId: demo.propertyId,
      orderId: setup.sourceStay.orderId,
      memberId,
      membershipProductId: "membership_product_shared_bath_single_v1",
      collectionFactIds: [setup.sourceStay.collectionFactId],
      agreedPriceMinor: 93_600,
      priceAdjustmentReason: "验证住宿转会员与错误会员链作废重建的统一锁顺序",
      remainingPaymentTransactionReference: "WECOM-CONVERSION-VOID-LOCK-ORDER-REMAINING"
    });
    const prepared = await preview(conversionCommand, "conversion-void-lock-order", ordinaryStaff);
    const holder = new pg.Client({ connectionString: databaseUrl });
    await holder.connect();
    let conversion: Promise<ReceiptDto> | undefined;
    let conversionSettled = false;
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0::bigint))",
        [`qintopia:member-entitlements:${memberId}`]
      );
      conversion = confirmCommandPreview(db, ordinaryStaff, prepared.preview.previewId, {
        propertyId: demo.propertyId,
        commandType: conversionCommand.commandType,
        confirmation: true,
        expectedEffectHash: prepared.preview.effectHash,
        reason: { code: "STAY_COLLECTION_TO_MEMBERSHIP", note: "验证与主管作废重建统一锁顺序" }
      }, metadata("conversion-void-lock-order-confirm")).finally(() => {
        conversionSettled = true;
      });

      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      expect(conversionSettled).toBe(false);

      await holder.query("SET LOCAL lock_timeout = '1s'");
      const sourceOrderLock = await holder.query<{ id: string }>(
        "SELECT id FROM orders WHERE id = $1 FOR UPDATE",
        [setup.sourceStay.orderId]
      );
      expect(sourceOrderLock.rows).toEqual([{ id: setup.sourceStay.orderId }]);
      await holder.query("ROLLBACK");

      await expect(conversion).resolves.toMatchObject({
        businessCommitted: true,
        executionStatus: "EXECUTED"
      });
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      if (conversion) await conversion.catch(() => undefined);
      await holder.end();
    }
  });

  it("serializes direct SQL backfills at the administrator payment-evidence claim", async () => {
    const [firstMemberId, secondMemberId] = await Promise.all([
      createMember("database-lock-backfill-first"),
      createMember("database-lock-backfill-second")
    ]);
    const actualMembershipDate = shiftLocalDate(await propertyLocalToday(db, demo.propertyId), -20);
    const transactionReference = "WECOM-DATABASE-LOCK-DIRECT-BACKFILL";
    const fixtureFor = (prefix: string, memberId: string): DirectHistoricalBackfillGraph => ({
      prefix,
      memberId,
      actualMembershipDate,
      businessDate: actualMembershipDate,
      transactionReference
    });
    const firstFixture = fixtureFor("first", firstMemberId);
    const secondFixture = fixtureFor("second", secondMemberId);
    const firstClient = new pg.Client({ connectionString: databaseUrl });
    const secondClient = new pg.Client({ connectionString: databaseUrl });
    const observer = new pg.Client({ connectionString: databaseUrl });
    let secondGraphSettled = false;
    let secondGraphInsert: Promise<
      { ok: true; graph: Awaited<ReturnType<typeof insertPendingDirectHistoricalBackfillGraph>> }
      | { ok: false; error: unknown }
    > | undefined;

    await Promise.all([firstClient.connect(), secondClient.connect(), observer.connect()]);
    try {
      const secondBackend = await secondClient.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid"
      );
      const secondBackendPid = secondBackend.rows[0]?.pid;
      if (secondBackendPid === undefined) {
        throw new Error("failed to resolve the second direct-backfill backend PID");
      }
      await Promise.all([firstClient.query("BEGIN"), secondClient.query("BEGIN")]);
      const firstGraph = await insertPendingDirectHistoricalBackfillGraph(firstClient, firstFixture);
      await insertDirectHistoricalBackfillRoot(firstClient, firstFixture, firstGraph);
      await completeDirectHistoricalBackfillEvidence(firstClient, firstFixture, firstGraph);

      secondGraphInsert = insertPendingDirectHistoricalBackfillGraph(secondClient, secondFixture).then(
        (graph) => {
          secondGraphSettled = true;
          return { ok: true as const, graph };
        },
        (error: unknown) => {
          secondGraphSettled = true;
          return { ok: false as const, error };
        }
      );

      let evidenceLockWaitObserved = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const activity = await observer.query<{ wait_event_type: string | null; wait_event: string | null }>(`
          SELECT wait_event_type, wait_event
          FROM pg_stat_activity
          WHERE pid = $1
        `, [secondBackendPid]);
        const wait = activity.rows[0];
        if (wait?.wait_event_type === "Lock" && /advisory/i.test(wait.wait_event ?? "")) {
          evidenceLockWaitObserved = true;
          break;
        }
        if (secondGraphSettled) break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      expect(evidenceLockWaitObserved).toBe(true);
      expect(secondGraphSettled).toBe(false);

      await firstClient.query("COMMIT");

      const secondGraphOutcome = await secondGraphInsert;
      expect(secondGraphOutcome.ok).toBe(false);
      if (!secondGraphOutcome.ok) {
        expect(String(secondGraphOutcome.error)).toMatch(/reserved as administrator correction evidence|admin_membership_payment_evidence_claims/i);
      }
      await secondClient.query("ROLLBACK");

      const committedBackfills = await observer.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM historical_membership_backfills
        WHERE transaction_reference = $1
      `, [transactionReference]);
      const committedPayments = await observer.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM membership_payment_facts
        WHERE transaction_reference = $1
      `, [transactionReference]);
      const committedClaims = await observer.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM admin_membership_payment_evidence_claims
        WHERE normalized_reference = $1
      `, [transactionReference]);
      const activeChains = await observer.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM membership_orders
        WHERE member_id = ANY($1::text[]) AND status = 'ACTIVE'
      `, [[firstMemberId, secondMemberId]]);
      expect(committedBackfills.rows[0]?.count).toBe("1");
      expect(committedPayments.rows[0]?.count).toBe("1");
      expect(committedClaims.rows[0]?.count).toBe("1");
      expect(activeChains.rows[0]?.count).toBe("1");
    } finally {
      await firstClient.query("ROLLBACK").catch(() => undefined);
      if (secondGraphInsert) await secondGraphInsert;
      await secondClient.query("ROLLBACK").catch(() => undefined);
      await Promise.all([firstClient.end(), secondClient.end(), observer.end()]);
    }
  });

  it("rolls back every member-profile business, Receipt, and Audit write failure", async () => {
    const targets = [
      ...membershipWriteFailureTargets.CORRECT_MEMBER_PROFILE,
      ...membershipCompletionWriteFailureTargets
    ];
    for (const [index, target] of targets.entries()) {
      const member = await db.selectFrom("members").selectAll().where("id", "=", demo.memberId).executeTakeFirstOrThrow();
      const label = `profile-write-failure-${index}-${target.table}-${target.event.toLowerCase()}`;
      await assertMembershipWriteFailureRollsBack(envelope("CORRECT_MEMBER_PROFILE", {
        propertyId: demo.propertyId,
        memberId: member.id,
        expectedPriorProfile: {
          fullName: member.full_name,
          nickname: member.nickname,
          identityCardNumber: member.identity_card_number,
          phone: member.phone,
          wechat: member.wechat
        },
        correctedProfile: {
          fullName: member.full_name,
          nickname: `${member.nickname}-故障回滚核对`,
          identityCardNumber: member.identity_card_number,
          phone: member.phone,
          wechat: member.wechat
        },
        evidenceNote: "会员资料逐写点故障必须整体回滚"
      }), target, label);
    }
  });

  it("rolls back every membership effective-date business, Receipt, and Audit write failure", async () => {
    const actualMembershipDate = shiftLocalDate(await propertyLocalToday(db, demo.propertyId), -30);
    const targets = [
      ...membershipWriteFailureTargets.CORRECT_MEMBERSHIP_EFFECTIVE_DATE,
      ...membershipCompletionWriteFailureTargets
    ];
    for (const [index, target] of targets.entries()) {
      const label = `effective-date-write-failure-${index}-${target.table}-${target.event.toLowerCase()}`;
      await assertMembershipWriteFailureRollsBack(envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
        propertyId: demo.propertyId,
        membershipOrderId: demo.membershipOrderId,
        actualMembershipDate,
        evidenceNote: "会员日期逐写点故障必须整体回滚"
      }), target, label);
    }
  });

  it("rolls back every historical-membership backfill business, Receipt, and Audit write failure", async () => {
    const actualMembershipDate = shiftLocalDate(await propertyLocalToday(db, demo.propertyId), -20);
    const targets = [
      ...membershipWriteFailureTargets.BACKFILL_HISTORICAL_MEMBERSHIP,
      ...membershipCompletionWriteFailureTargets
    ];
    for (const [index, target] of targets.entries()) {
      const label = `backfill-write-failure-${index}-${target.table}-${target.event.toLowerCase()}`;
      const memberId = await createMember(label);
      await assertMembershipWriteFailureRollsBack(envelope("BACKFILL_HISTORICAL_MEMBERSHIP", {
        propertyId: demo.propertyId,
        memberId,
        membershipProductId: "membership_product_shared_bath_quad_v1",
        actualMembershipDate,
        payment: {
          amountMinor: 93_600,
          businessDate: actualMembershipDate,
          transactionReference: `WECOM-${label.toUpperCase()}`
        },
        evidenceNote: "历史办卡逐写点故障必须整体回滚"
      }), target, label);
    }
  });

  it("rolls back every void-and-reconversion business, Receipt, and Audit write failure", async () => {
    const targets = [
      ...membershipWriteFailureTargets.VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY,
      ...membershipCompletionWriteFailureTargets
    ];
    for (const [index, target] of targets.entries()) {
      const label = `void-write-failure-${index}-${target.table}-${target.event.toLowerCase()}`;
      const setup = await prepareVoidReconversion(label);
      await assertMembershipWriteFailureRollsBack(setup.command, target, label);
    }
  }, 60_000);

  it("keeps profile, effective-date, and historical-backfill commands scoped to their own graphs", async () => {
    const scenarios: Array<{
      label: string;
      table: "member_profile_corrections" | "membership_effective_date_corrections" | "historical_membership_backfills";
      command: () => Promise<CommandEnvelope>;
    }> = [
      {
        label: "profile",
        table: "member_profile_corrections",
        command: async () => {
          const member = await db.selectFrom("members").selectAll().where("id", "=", demo.memberId).executeTakeFirstOrThrow();
          return envelope("CORRECT_MEMBER_PROFILE", {
            propertyId: demo.propertyId,
            memberId: demo.memberId,
            expectedPriorProfile: {
              fullName: member.full_name,
              nickname: member.nickname,
              identityCardNumber: member.identity_card_number,
              phone: member.phone,
              wechat: member.wechat
            },
            correctedProfile: {
              fullName: member.full_name,
              nickname: `${member.nickname}-范围攻击`,
              identityCardNumber: member.identity_card_number,
              phone: member.phone,
              wechat: member.wechat
            },
            evidenceNote: "资料更正命令不得夹带无关会员收款"
          });
        }
      },
      {
        label: "effective-date",
        table: "membership_effective_date_corrections",
        command: async () => envelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", {
          propertyId: demo.propertyId,
          membershipOrderId: demo.membershipOrderId,
          actualMembershipDate: shiftLocalDate(await propertyLocalToday(db, demo.propertyId), -30),
          evidenceNote: "日期更正命令不得夹带无关会员收款"
        })
      },
      {
        label: "historical-backfill",
        table: "historical_membership_backfills",
        command: async () => {
          const memberId = await createMember("backfill-command-scope");
          const actualMembershipDate = shiftLocalDate(await propertyLocalToday(db, demo.propertyId), -20);
          return envelope("BACKFILL_HISTORICAL_MEMBERSHIP", {
            propertyId: demo.propertyId,
            memberId,
            membershipProductId: "membership_product_shared_bath_quad_v1",
            actualMembershipDate,
            payment: {
              amountMinor: 93_600,
              businessDate: actualMembershipDate,
              transactionReference: "WECOM-BACKFILL-COMMAND-SCOPE"
            },
            evidenceNote: "历史补录命令不得夹带无关会员收款"
          });
        }
      }
    ];

    for (const [index, scenario] of scenarios.entries()) {
      if (index > 0) {
        await db.destroy();
        db = await resetDatabase(databaseUrl);
      }
      const command = await scenario.command();
      const prepared = await preview(command, `command-scope-${scenario.label}`);
      const before = await membershipCommandBusinessGraphSnapshot();
      await installMembershipCommandScopeAttack({
        table: scenario.table,
        body: `
          INSERT INTO membership_payment_facts (
            fact_id, membership_order_id, fact_type, amount_minor, net_effect_minor, currency,
            transaction_reference, corrects_fact_id, reverses_fact_id, source_type,
            source_order_id, source_collection_fact_id, note, command_id, business_date
          ) VALUES (
            'scope-attack-${scenario.label}-payment-' || txid_current(), '${demo.membershipOrderId}',
            'COLLECTION', 1, 1, 'CNY', 'WECOM-SCOPE-ATTACK-${scenario.label}-' || txid_current(),
            NULL, NULL, 'DIRECT_WECOM', NULL, NULL, '命令范围攻击：夹带无关会员收款', NEW.command_id, DATE '2026-01-01'
          );`
      });
      try {
        const receipt = await confirmCommandPreview(db, administrator, prepared.preview.previewId, {
          propertyId: demo.propertyId,
          commandType: command.commandType,
          confirmation: true,
          expectedEffectHash: prepared.preview.effectHash,
          reason: { code: "DATA_ENTRY_CORRECTION", note: `命令范围攻击 ${scenario.label}` }
        }, metadata(`command-scope-${scenario.label}-confirm`));
        expect(receipt).toMatchObject({ executionStatus: "NOT_EXECUTED", businessCommitted: false });
        expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
      } finally {
        await clearMembershipCommandScopeAttackTrigger();
      }
    }
  });

  it("rejects every injected out-of-scope fact graph and rolls back the void command as one unit", async () => {
    const attacks = [
      {
        label: "other-order-collection-reversal",
        table: "membership_void_reconversions" as const,
        body: (otherCollectionFactId: string) => `
          INSERT INTO collection_facts (
            fact_id, order_id, fact_type, amount_minor, net_effect_minor, currency,
            references_fact_id, reverses_fact_id, method, note, transaction_reference,
            pricing_revision_id, command_id
          )
          SELECT 'scope-attack-other-order-reversal-' || txid_current(), source.order_id,
            'REVERSAL', source.amount_minor, -source.net_effect_minor, source.currency,
            NULL, source.fact_id, 'REVERSAL', '命令范围攻击：夹带其他住宿冲销', NULL,
            source.pricing_revision_id, NEW.command_id
          FROM collection_facts AS source
          WHERE source.fact_id = '${otherCollectionFactId}';`
      },
      {
        label: "other-membership-order-payment",
        table: "membership_void_reconversions" as const,
        body: () => `
          INSERT INTO membership_payment_facts (
            fact_id, membership_order_id, fact_type, amount_minor, net_effect_minor, currency,
            transaction_reference, corrects_fact_id, reverses_fact_id, source_type,
            source_order_id, source_collection_fact_id, note, command_id, business_date
          ) VALUES (
            'scope-attack-other-membership-payment-' || txid_current(), '${demo.membershipOrderId}',
            'COLLECTION', 1, 1, 'CNY', 'WECOM-SCOPE-ATTACK-OTHER-MEMBERSHIP-' || txid_current(),
            NULL, NULL, 'DIRECT_WECOM', NULL, NULL, '命令范围攻击：夹带其他会员收款', NEW.command_id, DATE '2026-01-01'
          );`
      },
      {
        label: "other-lot-entitlement-adjust",
        table: "membership_void_reconversions" as const,
        body: () => `
          INSERT INTO entitlement_ledger (
            fact_id, lot_id, entry_type, quantity_delta, service_date, order_id, coverage_id, reason, command_id
          ) VALUES (
            'scope-attack-other-lot-adjust-' || txid_current(), '${demo.roomLotId}',
            'ADJUST', 1, NULL, NULL, NULL, '命令范围攻击：夹带其他权益调整', NEW.command_id
          );`
      },
      {
        label: "extra-membership-order-contract-lot-chain",
        table: "membership_void_reconversions" as const,
        declarations: `
          DECLARE
            extra_order_id text := 'scope-attack-extra-order-' || txid_current();
            extra_contract_id text := 'scope-attack-extra-contract-' || txid_current();
            extra_lot_id text := 'scope-attack-extra-lot-' || txid_current();`,
        body: () => `
            INSERT INTO membership_orders (
              id, property_id, member_id, product_id, product_code, product_version, product_name,
              listed_price_minor, agreed_price_minor, price_adjustment_minor, price_adjustment_reason,
              currency, entitlement_unit_kind, entitlement_units, allowed_room_type_code, allowed_inventory_kind,
              status, activated_at, valid_from, valid_until, contract_id, entitlement_lot_id, version,
              created_by_command_id, activated_by_command_id
            )
            SELECT extra_order_id, property_id, member_id, product_id, product_code, product_version, product_name,
              listed_price_minor, agreed_price_minor, price_adjustment_minor, price_adjustment_reason,
              currency, entitlement_unit_kind, entitlement_units, allowed_room_type_code, allowed_inventory_kind,
              'DRAFT', NULL, NULL, NULL, NULL, NULL, 1, NEW.command_id, NULL
            FROM membership_orders WHERE id = NEW.old_membership_order_id;
            INSERT INTO member_contracts (
              id, property_id, member_id, member_name, status, valid_from, valid_until, version, membership_order_id
            )
            SELECT extra_contract_id, NEW.property_id, NEW.member_id, full_name,
              'ACTIVE', NEW.actual_membership_date, NEW.valid_until, 1, extra_order_id
            FROM members WHERE id = NEW.member_id;
            INSERT INTO entitlement_lots (
              id, contract_id, unit_kind, total_units, expires_on, status, version
            )
            SELECT extra_lot_id, extra_contract_id, unit_kind, total_units, NEW.valid_until, 'ACTIVE', 1
            FROM entitlement_lots WHERE id = NEW.old_entitlement_lot_id;
            UPDATE membership_orders SET
              status = 'ACTIVE', activated_at = now(), valid_from = NEW.actual_membership_date,
              valid_until = NEW.valid_until, contract_id = extra_contract_id, entitlement_lot_id = extra_lot_id,
              version = 2, activated_by_command_id = NEW.command_id
            WHERE id = extra_order_id;
          `
      },
      {
        label: "mixed-old-chain-extra-membership-payment-reclassification",
        table: "membership_payment_reclassifications" as const,
        declarations: `
          DECLARE
            extra_collection_id text := 'scope-attack-extra-old-collection-' || txid_current();
            extra_reversal_id text := 'scope-attack-extra-old-reversal-' || txid_current();`,
        body: () => `
            INSERT INTO membership_payment_facts (
              fact_id, membership_order_id, fact_type, amount_minor, net_effect_minor, currency,
              transaction_reference, corrects_fact_id, reverses_fact_id, source_type,
              source_order_id, source_collection_fact_id, note, command_id, business_date
            ) VALUES (
              extra_collection_id, NEW.old_membership_order_id, 'COLLECTION', 1, 1, NEW.currency,
              'WECOM-SCOPE-ATTACK-EXTRA-RECLASS-' || txid_current(), NULL, NULL, 'DIRECT_WECOM',
              NULL, NULL, '命令范围攻击：额外旧会员收款', NEW.command_id, DATE '2026-01-01'
            );
            INSERT INTO membership_payment_facts (
              fact_id, membership_order_id, fact_type, amount_minor, net_effect_minor, currency,
              transaction_reference, corrects_fact_id, reverses_fact_id, source_type,
              source_order_id, source_collection_fact_id, note, command_id, business_date
            ) VALUES (
              extra_reversal_id, NEW.old_membership_order_id, 'REVERSAL', 1, -1, NEW.currency,
              NULL, NULL, extra_collection_id, 'DIRECT_WECOM', NULL, NULL,
              '命令范围攻击：额外旧会员收款冲销', NEW.command_id, DATE '2026-01-01'
            );
            INSERT INTO membership_payment_reclassifications (
              id, property_id, member_id, old_membership_order_id, old_payment_fact_id,
              old_reversal_fact_id, new_membership_order_id, new_payment_fact_id,
              amount_minor, currency, evidence_note, command_id
            ) VALUES (
              'scope-attack-extra-reclassification-' || txid_current(), NEW.property_id, NEW.member_id,
              NEW.old_membership_order_id, extra_collection_id, extra_reversal_id,
              NEW.new_membership_order_id, NEW.new_payment_fact_id, 1, NEW.currency,
              '命令范围攻击：额外会员收款重分类', NEW.command_id
            );
          `
      }
    ];

    for (const [index, attack] of attacks.entries()) {
      if (index > 0) {
        await db.destroy();
        db = await resetDatabase(databaseUrl);
      }
      const setup = await prepareVoidReconversion(`scope-attack-${attack.label}`);
      const otherMemberId = await createMember(`scope-attack-other-${attack.label}`);
      const otherMember = await db.selectFrom("members").selectAll().where("id", "=", otherMemberId).executeTakeFirstOrThrow();
      const otherStay = await createCompletedWecomStay({
        prefix: `scope-attack-other-${attack.label}`,
        phone: otherMember.phone,
        documentNumber: otherMember.identity_card_number!
      });
      const prepared = await preview(setup.command, `scope-attack-${attack.label}`);
      const before = await membershipCommandBusinessGraphSnapshot();
      await installMembershipCommandScopeAttack({
        table: attack.table,
        declarations: attack.declarations,
        body: attack.body(otherStay.collectionFactId)
      });

      try {
        const receipt = await confirmCommandPreview(db, administrator, prepared.preview.previewId, {
          propertyId: demo.propertyId,
          commandType: setup.command.commandType,
          confirmation: true,
          expectedEffectHash: prepared.preview.effectHash,
          reason: { code: "DATA_ENTRY_CORRECTION", note: `命令范围攻击 ${attack.label}` }
        }, metadata(`scope-attack-${attack.label}-confirm`));
        expect(receipt).toMatchObject({ executionStatus: "NOT_EXECUTED", businessCommitted: false });
        expect(await membershipCommandBusinessGraphSnapshot()).toEqual(before);
      } finally {
        await clearMembershipCommandScopeAttackTrigger();
      }
    }
  });
});

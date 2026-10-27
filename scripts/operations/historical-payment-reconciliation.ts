import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { sql, type Kysely, type Transaction } from "kysely";
import type { AuthPrincipal, CommandReason, CommandType } from "@qintopia/contracts";
import { newId, stableHash } from "@qintopia/domain";
import { applyCommand, lockCommandResources } from "../../packages/db/src/commands/apply.ts";
import { buildCommandEffect } from "../../packages/db/src/commands/effects.ts";
import { bindExternalPayments } from "../../packages/db/src/external-payments.ts";
import { applyHistoricalStayArrangementCorrection, buildHistoricalStayArrangementCorrectionEffect, lockHistoricalStayArrangementCorrectionResources } from "../../packages/db/src/admin-historical-stay-corrections.ts";
import { createDatabase, databaseUrl } from "../../packages/db/src/database.ts";
import type { Database } from "../../packages/db/src/schema.ts";

export const HISTORICAL_RECONCILIATION_PLAN_ID = "historical-payment-reconciliation-2026-10-27";
export const HISTORICAL_RECONCILIATION_BASELINE = "7fd9920d21d4319c3311bb784c230b4da22b4c83";

export interface HistoricalOrderPlan {
  key: "303" | "306" | "D03" | "D04";
  orderId: string;
  expectedVersion: number;
  expectedCurrentContractAmountMinor: number;
  targetCurrentContractAmountMinor: 18000 | 13000;
  originalFactId: string | null;
  originalAmountMinor: 0 | 36000 | 31000;
  billKey: "xiaonian" | "liuguang";
}

export interface HistoricalBillPlan {
  key: "xiaonian" | "liuguang";
  billId: string;
  reference: string;
  amountMinor: 36000 | 31000;
  allocations: Array<{ orderKey: HistoricalOrderPlan["key"]; amountMinor: number }>;
}

export interface HistoricalPaymentPlan {
  planId: typeof HISTORICAL_RECONCILIATION_PLAN_ID;
  propertyId: string;
  planSha256: string;
  orders: HistoricalOrderPlan[];
  bills: HistoricalBillPlan[];
}

export interface ReconciliationOrderReport {
  key: HistoricalOrderPlan["key"];
  orderId: string;
  beforeMinor: number;
  afterMinor: number;
  targetMinor: number;
  originalFactId: string | null;
  originalAmountMinor: number;
}

export interface HistoricalReconciliationReport {
  mode: "dry-run" | "execute";
  planId: string;
  planSha256: string;
  propertyId: string;
  orders: ReconciliationOrderReport[];
  bills: Array<{ key: HistoricalBillPlan["key"]; billId: string; reference: string; amountMinor: number; allocations: Array<{ orderKey: string; amountMinor: number }> }>;
  cashBeforeMinor: number;
  cashAfterMinor: number;
}

const fixedOrderKeys = ["303", "306", "D03", "D04"] as const;
const fixedBillKeys = ["xiaonian", "liuguang"] as const;

/** Stable JSON is deliberately tiny and local: the plan hash is an audit guard, not a public API. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function calculatePlanSha256(plan: Omit<HistoricalPaymentPlan, "planSha256">): string {
  return createHash("sha256").update(canonical(plan)).digest("hex");
}

export function validateFixedPlan(plan: HistoricalPaymentPlan): void {
  if (plan.planId !== HISTORICAL_RECONCILIATION_PLAN_ID) throw new Error("固定历史收口计划标识不匹配");
  if (!plan.propertyId.trim()) throw new Error("propertyId is required");
  if (!/^[a-f0-9]{64}$/.test(plan.planSha256)) throw new Error("planSha256 must be a lowercase SHA-256");
  if (plan.orders.length !== fixedOrderKeys.length || new Set(plan.orders.map((order) => order.key)).size !== fixedOrderKeys.length
    || !fixedOrderKeys.every((key) => plan.orders.some((order) => order.key === key))) throw new Error("固定计划必须包含303/306/D03/D04四个订单");
  if (plan.bills.length !== fixedBillKeys.length || new Set(plan.bills.map((bill) => bill.key)).size !== fixedBillKeys.length
    || !fixedBillKeys.every((key) => plan.bills.some((bill) => bill.key === key))) throw new Error("固定计划必须包含笑念与流光两笔账单");
  const expectedTargets: Record<string, number> = { "303": 18000, "306": 18000, D03: 18000, D04: 13000 };
  const orders = new Map(plan.orders.map((order) => [order.key, order]));
  const orderIds = plan.orders.map((order) => order.orderId);
  if (orderIds.some((id) => !id.trim()) || new Set(orderIds).size !== orderIds.length) throw new Error("订单 ID 必须非空且唯一");
  for (const order of plan.orders) {
    if (!Number.isSafeInteger(order.expectedVersion) || order.expectedVersion < 1) throw new Error(`${order.key} expectedVersion 无效`);
    if (order.expectedCurrentContractAmountMinor < 0 || !Number.isSafeInteger(order.expectedCurrentContractAmountMinor)) throw new Error(`${order.key} 当前金额无效`);
    if (order.targetCurrentContractAmountMinor !== expectedTargets[order.key]) throw new Error(`${order.key} 目标金额不符合固定计划`);
    if (order.key === "D04" || order.key === "306") {
      if (order.originalFactId !== null || order.originalAmountMinor !== 0) throw new Error("D04 没有旧收款事实时必须使用 null/0");
    } else if (!order.originalFactId?.trim() || !Number.isSafeInteger(order.originalAmountMinor) || order.originalAmountMinor <= 0) throw new Error(`${order.key} 原收款事实无效`);
  }
  for (const bill of plan.bills) {
    if (!bill.billId.trim() || !bill.reference.trim() || !Number.isSafeInteger(bill.amountMinor) || bill.amountMinor <= 0) throw new Error(`${bill.key} 账单无效`);
    if (bill.allocations.length === 0 || bill.allocations.some((item) => !orders.has(item.orderKey) || !Number.isSafeInteger(item.amountMinor) || item.amountMinor <= 0)) throw new Error(`${bill.key} 分配明细无效`);
    if (bill.allocations.reduce((sum, item) => sum + item.amountMinor, 0) !== bill.amountMinor) throw new Error(`${bill.key} 分配金额不守恒`);
  }
  const xiaonian = plan.bills.find((bill) => bill.key === "xiaonian")!;
  const liuguang = plan.bills.find((bill) => bill.key === "liuguang")!;
  if (xiaonian.amountMinor !== 36000 || liuguang.amountMinor !== 31000) throw new Error("固定账单金额必须为36000/31000分");
  if (JSON.stringify(xiaonian.allocations) !== JSON.stringify([{ orderKey: "303", amountMinor: 18000 }, { orderKey: "306", amountMinor: 18000 }])) throw new Error("笑念账单分配必须为303/306各18000分");
  if (JSON.stringify(liuguang.allocations) !== JSON.stringify([{ orderKey: "D03", amountMinor: 18000 }, { orderKey: "D04", amountMinor: 13000 }])) throw new Error("流光账单分配必须为D03 18000分、D04 13000分");
  for (const order of plan.orders) {
    const bill = plan.bills.find((candidate) => candidate.key === order.billKey)!;
    const allocationTotal = bill.allocations.filter((item) => item.orderKey === order.key).reduce((sum, item) => sum + item.amountMinor, 0);
    if (allocationTotal !== order.targetCurrentContractAmountMinor) throw new Error(`${order.key} 目标金额与账单分配不守恒`);
  }
  const { planSha256, ...withoutSha } = plan;
  if (calculatePlanSha256(withoutSha) !== planSha256) throw new Error("计划 SHA 不匹配，拒绝执行");
}

export function fixedPlanFromEnvironment(env: NodeJS.ProcessEnv = process.env): HistoricalPaymentPlan {
  const base: Omit<HistoricalPaymentPlan, "planSha256"> = {
    planId: HISTORICAL_RECONCILIATION_PLAN_ID,
    propertyId: env.HISTORICAL_RECONCILIATION_PROPERTY_ID ?? "prop_qintopia_demo",
    orders: [
      { key: "303", orderId: env.HISTORICAL_ORDER_303 ?? "", expectedVersion: Number(env.HISTORICAL_ORDER_303_VERSION ?? 0), expectedCurrentContractAmountMinor: Number(env.HISTORICAL_ORDER_303_AMOUNT ?? 18000), targetCurrentContractAmountMinor: 18000, originalFactId: env.HISTORICAL_ORDER_303_FACT_ID ?? "", originalAmountMinor: 36000, billKey: "xiaonian" },
      { key: "306", orderId: env.HISTORICAL_ORDER_306 ?? "", expectedVersion: Number(env.HISTORICAL_ORDER_306_VERSION ?? 0), expectedCurrentContractAmountMinor: Number(env.HISTORICAL_ORDER_306_AMOUNT ?? 18000), targetCurrentContractAmountMinor: 18000, originalFactId: env.HISTORICAL_ORDER_306_FACT_ID ?? null, originalAmountMinor: 0, billKey: "xiaonian" },
      { key: "D03", orderId: env.HISTORICAL_ORDER_D03 ?? "", expectedVersion: Number(env.HISTORICAL_ORDER_D03_VERSION ?? 0), expectedCurrentContractAmountMinor: Number(env.HISTORICAL_ORDER_D03_AMOUNT ?? 18000), targetCurrentContractAmountMinor: 18000, originalFactId: env.HISTORICAL_ORDER_D03_FACT_ID ?? "", originalAmountMinor: 31000, billKey: "liuguang" },
      { key: "D04", orderId: env.HISTORICAL_ORDER_D04 ?? "", expectedVersion: Number(env.HISTORICAL_ORDER_D04_VERSION ?? 0), expectedCurrentContractAmountMinor: Number(env.HISTORICAL_ORDER_D04_AMOUNT ?? 0), targetCurrentContractAmountMinor: 13000, originalFactId: env.HISTORICAL_ORDER_D04_FACT_ID ?? null, originalAmountMinor: 0, billKey: "liuguang" }
    ],
    bills: [
      { key: "xiaonian", billId: env.HISTORICAL_BILL_XIAONIAN_ID ?? "", reference: env.HISTORICAL_BILL_XIAONIAN_REFERENCE ?? "", amountMinor: 36000, allocations: [{ orderKey: "303", amountMinor: 18000 }, { orderKey: "306", amountMinor: 18000 }] },
      { key: "liuguang", billId: env.HISTORICAL_BILL_LIUGUANG_ID ?? "", reference: env.HISTORICAL_BILL_LIUGUANG_REFERENCE ?? "", amountMinor: 31000, allocations: [{ orderKey: "D03", amountMinor: 18000 }, { orderKey: "D04", amountMinor: 13000 }] }
    ]
  };
  return { ...base, planSha256: calculatePlanSha256(base) };
}

type Db = Kysely<Database> | Transaction<Database>;
async function countFacts(db: Db, propertyId: string): Promise<number> {
  const row = await sql<{ total: string }>`SELECT COALESCE(sum(f.net_effect_minor),0)::text AS total FROM collection_facts f JOIN orders o ON o.id=f.order_id WHERE o.property_id=${propertyId}`.execute(db);
  return Number(row.rows[0]?.total ?? 0);
}

async function validateDatabaseState(db: Db, plan: HistoricalPaymentPlan): Promise<ReconciliationOrderReport[]> {
  const reports: ReconciliationOrderReport[] = [];
  for (const item of plan.orders) {
    const order = await sql<{ id: string; version: number; amount: number; property_id: string; currency: string }>`SELECT o.id,o.version,o.property_id,p.current_contract_amount_minor AS amount,p.currency FROM orders o JOIN pricing_revisions p ON p.id=o.current_revision_id WHERE o.id=${item.orderId} AND o.property_id=${plan.propertyId}`.execute(db);
    const row = order.rows[0];
    if (!row) throw new Error(`${item.key} 订单不存在或物业不匹配`);
    if (row.version !== item.expectedVersion || row.amount !== item.expectedCurrentContractAmountMinor) throw new Error(`${item.key} 订单版本或当前合同金额已漂移`);
    if (item.originalFactId) {
      const fact = await sql<{ fact_id: string; amount_minor: number; net_effect_minor: number; fact_type: string; currency: string; transaction_reference: string | null; bill_id: string | null }>`SELECT f.fact_id,f.amount_minor,f.net_effect_minor,f.fact_type,f.currency,f.transaction_reference,COALESCE(f.external_payment_bill_id,a.bill_id) AS bill_id FROM collection_facts f LEFT JOIN external_payment_allocations a ON a.collection_fact_id=f.fact_id WHERE f.fact_id=${item.originalFactId} AND f.order_id=${item.orderId}`.execute(db);
      const source = fact.rows[0];
      const expectedBill = plan.bills.find((bill) => bill.key === item.billKey)!;
      if (!source || source.fact_type !== "COLLECTION" || source.amount_minor !== item.originalAmountMinor || source.net_effect_minor !== source.amount_minor || source.currency !== row.currency || source.transaction_reference !== expectedBill.reference) throw new Error(String(item.key) + " 原始收款事实漂移");
      const reversed = await sql<{ value: boolean }>`SELECT EXISTS(SELECT 1 FROM collection_facts WHERE reverses_fact_id=${item.originalFactId}) AS value`.execute(db);
      if (reversed.rows[0]?.value) throw new Error(String(item.key) + " 原始收款事实已经被冲销");
      const occupied = await sql<{ value: string }>`SELECT (COALESCE((SELECT sum(r.amount_minor) FROM collection_facts r WHERE r.references_fact_id=${item.originalFactId} AND r.fact_type IN ('REFUND','REALLOCATION_OUT') AND NOT EXISTS(SELECT 1 FROM collection_facts v WHERE v.reverses_fact_id=r.fact_id)),0)+COALESCE((SELECT sum(l.amount_minor-COALESCE((SELECT sum(e.amount_minor) FROM retained_fund_entries e WHERE e.retained_fund_id=l.id),0)) FROM retained_funds l WHERE l.source_fact_id=${item.originalFactId}),0))::text AS value`.execute(db);
      if (Number(occupied.rows[0]?.value ?? 0) !== 0) throw new Error(`${item.key} 原始事实存在退款、留存或转出占用`);
    }
    reports.push({ key: item.key, orderId: item.orderId, beforeMinor: row.amount, afterMinor: item.targetCurrentContractAmountMinor, targetMinor: item.targetCurrentContractAmountMinor, originalFactId: item.originalFactId, originalAmountMinor: item.originalAmountMinor });
  }
  for (const bill of plan.bills) {
    const result = await sql<{ id: string; amount_minor: number; state: string; kind: string; property_id: string; needs_review: boolean }>`SELECT id,amount_minor,state,kind,property_id,needs_review FROM external_payment_bills WHERE id=${bill.billId} AND property_id=${plan.propertyId}`.execute(db);
    const row = result.rows[0];
    if (!row || row.kind !== "COLLECTION" || row.state !== "SUCCESS" || row.amount_minor !== bill.amountMinor || row.needs_review) throw new Error(`${bill.key} 外部账单缺失、状态异常或金额不一致`);
    const expectedLegacyFacts = plan.orders.filter((order) => order.billKey === bill.key && order.originalFactId).map((order) => order.originalFactId!);
    const prior = await sql<{ fact_id: string; amount_minor: number }>`SELECT a.collection_fact_id AS fact_id,a.amount_minor FROM external_payment_allocations a WHERE a.bill_id=${bill.billId} AND NOT EXISTS(SELECT 1 FROM external_payment_allocation_releases r WHERE r.allocation_id=a.id) ORDER BY a.collection_fact_id`.execute(db);
    if (prior.rows.length > 1 || prior.rows.some((row) => !expectedLegacyFacts.includes(row.fact_id))) throw new Error(String(bill.key) + " 旧账单归属与固定计划不一致");
    for (const row of prior.rows) {
      const expected = plan.orders.find((order) => order.originalFactId === row.fact_id)!.originalAmountMinor;
      if (row.amount_minor !== expected) throw new Error(String(bill.key) + " 旧账单归属金额不一致");
    }
  }
  const marker = await sql<{ count: string }>`SELECT count(*)::text AS count FROM audit_entries WHERE action='HISTORICAL_PAYMENT_RECONCILIATION' AND metadata->>'planSha256'=${plan.planSha256}`.execute(db);
  if (Number(marker.rows[0]?.count ?? 0) > 0) throw new Error("固定历史收口计划已经执行过，拒绝重复执行");
  return reports;
}

async function appendCommand(trx: Transaction<Database>, principal: AuthPrincipal, commandType: CommandType, input: Record<string, unknown>, reason: CommandReason, key: string, plan: HistoricalPaymentPlan): Promise<{ factRefs: string[]; resourceRefs: string[] }> {
  await lockCommandResources(trx, commandType, input);
  const built = await buildCommandEffect(trx, commandType, input, true);
  const commandId = newId("command");
  await trx.insertInto("command_executions").values({ id: commandId, subject_id: principal.subjectId, credential_id: principal.credentialId, property_id: plan.propertyId, command_type: commandType, idempotency_key: key, request_hash: stableHash(input), correlation_id: `${plan.planId}:${key}`, state: "EXECUTING", completed_at: null }).execute();
  const applied = await applyCommand(trx, { commandType, input, effect: built.effect, reason, commandId });
  await bindExternalPayments(trx, commandId, (built.basisVersions.externalPayments ?? []) as never);
  await trx.updateTable("command_executions").set({ state: "APPLIED", completed_at: new Date() }).where("id", "=", commandId).execute();
  await trx.insertInto("command_receipts").values({ id: newId("receipt"), command_id: commandId, execution_status: "EXECUTED", business_committed: true, result: applied.persistedResult, error: null, resource_refs: JSON.stringify(applied.resourceRefs), fact_refs: JSON.stringify(applied.factRefs), committed_at: new Date() }).execute();
  await trx.insertInto("audit_entries").values({ id: newId("audit"), subject_id: principal.subjectId, credential_id: principal.credentialId, action: "HISTORICAL_PAYMENT_RECONCILIATION", decision: "ALLOWED", command_id: commandId, correlation_id: `${plan.planId}:${key}`, reason, target_refs: JSON.stringify(applied.resourceRefs), metadata: { planId: plan.planId, planSha256: plan.planSha256, step: key } }).execute();
  return { factRefs: applied.factRefs, resourceRefs: applied.resourceRefs };
}

async function appendHistoricalReprice(
  trx: Transaction<Database>,
  principal: AuthPrincipal,
  item: HistoricalOrderPlan,
  plan: HistoricalPaymentPlan
): Promise<void> {
  if (item.key !== "D04") throw new Error("历史终态计价修订仅允许D04固定目标");
  const input = {
    propertyId: plan.propertyId,
    correctionSet: [{
      orderId: item.orderId,
      expectedVersion: item.expectedVersion,
      target: { inventoryUnitId: "unit_room_d_gen_04", arrivalDate: "2026-10-02", departureDate: "2026-10-03" }
    }],
    evidenceNote: "固定历史合付款收口：恢复D04真实合同金额"
  };
  await lockHistoricalStayArrangementCorrectionResources(trx, input);
  const built = await buildHistoricalStayArrangementCorrectionEffect(trx, input);
  const correction = (built.effect.corrections as Array<Record<string, any>>)[0]!;
  correction.after.pricing.currentContractAmount.minorUnits = item.targetCurrentContractAmountMinor;
  const commandId = newId("command");
  await trx.insertInto("command_executions").values({
    id: commandId,
    subject_id: principal.subjectId,
    credential_id: principal.credentialId,
    property_id: plan.propertyId,
    command_type: "CORRECT_HISTORICAL_STAY_ARRANGEMENTS",
    idempotency_key: "historical:" + plan.planId + ":D04-contract",
    request_hash: stableHash(input),
    correlation_id: plan.planId + ":D04-contract",
    state: "EXECUTING",
    completed_at: null
  }).execute();
  const applied = await applyHistoricalStayArrangementCorrection(trx, {
    input,
    effect: built.effect,
    reason: { code: "HISTORICAL_STAY_ARRANGEMENT_CORRECTION", note: "固定历史合付款收口：恢复D04真实合同金额" },
    commandId
  });
  await trx.updateTable("command_executions").set({ state: "APPLIED", completed_at: new Date() }).where("id", "=", commandId).execute();
  await trx.insertInto("command_receipts").values({
    id: newId("receipt"),
    command_id: commandId,
    execution_status: "EXECUTED",
    business_committed: true,
    result: applied.persistedResult,
    error: null,
    resource_refs: JSON.stringify(applied.resourceRefs),
    fact_refs: JSON.stringify(applied.factRefs),
    committed_at: new Date()
  }).execute();
  await trx.insertInto("audit_entries").values({
    id: newId("audit"),
    subject_id: principal.subjectId,
    credential_id: principal.credentialId,
    action: "HISTORICAL_PAYMENT_RECONCILIATION",
    decision: "ALLOWED",
    command_id: commandId,
    correlation_id: plan.planId + ":D04-contract",
    reason: { code: "HISTORICAL_STAY_ARRANGEMENT_CORRECTION", note: "固定历史合付款收口：恢复D04真实合同金额" },
    target_refs: JSON.stringify(applied.resourceRefs),
    metadata: { planId: plan.planId, planSha256: plan.planSha256, step: "D04-contract" }
  }).execute();
}

async function assertPostState(trx: Transaction<Database>, plan: HistoricalPaymentPlan, cashBeforeMinor: number): Promise<number> {
  const cashAfterMinor = await countFacts(trx, plan.propertyId);
  if (cashAfterMinor !== cashBeforeMinor) throw new Error("历史收口现金守恒校验失败");
  for (const item of plan.orders) {
    const row = (await sql<{ amount: number; net: string }>`SELECT p.current_contract_amount_minor AS amount,COALESCE(sum(f.net_effect_minor),0)::text AS net FROM orders o JOIN pricing_revisions p ON p.id=o.current_revision_id LEFT JOIN collection_facts f ON f.order_id=o.id WHERE o.id=${item.orderId} AND o.property_id=${plan.propertyId} GROUP BY p.current_contract_amount_minor`.execute(trx)).rows[0];
    if (!row || row.amount !== item.targetCurrentContractAmountMinor || Number(row.net) !== item.targetCurrentContractAmountMinor) throw new Error(String(item.key) + " 修复后合同或净收款不守恒");
  }
  for (const bill of plan.bills) {
    const row = (await sql<{ allocated: string }>`SELECT COALESCE(sum(a.amount_minor),0)::text AS allocated FROM external_payment_allocations a WHERE a.bill_id=${bill.billId} AND NOT EXISTS(SELECT 1 FROM external_payment_allocation_releases r WHERE r.allocation_id=a.id)`.execute(trx)).rows[0];
    if (!row || Number(row.allocated) !== bill.amountMinor) throw new Error(String(bill.key) + " 修复后账单分配不守恒");
  }
  return cashAfterMinor;
}
export async function runHistoricalReconciliation(db: Kysely<Database>, plan: HistoricalPaymentPlan, options: { dryRun?: boolean; principal: AuthPrincipal }): Promise<HistoricalReconciliationReport> {
  validateFixedPlan(plan);
  return db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`historical-payment-reconciliation:${plan.propertyId}`},0))`.execute(trx);
    if (options.dryRun !== false) await sql`SET TRANSACTION READ ONLY`.execute(trx);
    const reports = await validateDatabaseState(trx, plan);
    const cashBeforeMinor = await countFacts(trx, plan.propertyId);
    const base = { mode: options.dryRun === false ? "execute" as const : "dry-run" as const, planId: plan.planId, planSha256: plan.planSha256, propertyId: plan.propertyId, orders: reports, bills: plan.bills.map((bill) => ({ key: bill.key, billId: bill.billId, reference: bill.reference, amountMinor: bill.amountMinor, allocations: bill.allocations })), cashBeforeMinor, cashAfterMinor: cashBeforeMinor };
    if (options.dryRun !== false) return base;
    for (const item of plan.orders) {
      if (item.expectedCurrentContractAmountMinor !== item.targetCurrentContractAmountMinor) {
        const current = await sql<{ status: string; booking_channel_code: string | null }>`SELECT status,booking_channel_code FROM orders WHERE id=${item.orderId} AND property_id=${plan.propertyId}`.execute(trx);
        if (current.rows[0]?.status === "CHECKED_OUT" && current.rows[0]?.booking_channel_code === "WECOM") await appendHistoricalReprice(trx, options.principal, item, plan);
        else await appendCommand(trx, options.principal, "REPRICE_ORDER", { propertyId: plan.propertyId, orderId: item.orderId, targetCurrentContractAmountMinor: item.targetCurrentContractAmountMinor }, { code: "REPRICE_ORDER", note: "固定历史合付款收口：恢复真实合同金额" }, `reprice:${item.key}`, plan);
      }
    }
    for (const item of plan.orders) {
      if (item.originalFactId) {
        const activeAllocation = await sql<{ active: boolean }>`SELECT EXISTS(SELECT 1 FROM external_payment_allocations a WHERE a.collection_fact_id=${item.originalFactId} AND NOT EXISTS(SELECT 1 FROM external_payment_allocation_releases r WHERE r.allocation_id=a.id)) AS active`.execute(trx);
        const reverseInput = { propertyId: plan.propertyId, orderId: item.orderId, reversesFactId: item.originalFactId, ...(activeAllocation.rows[0]?.active ? { releaseExternalPaymentAllocation: true } : {}), note: "固定历史合付款收口：释放旧整笔归属" };
        await appendCommand(trx, options.principal, "REVERSE_FACT", reverseInput, { code: "REVERSE_FACT", note: "固定历史合付款收口：释放旧整笔归属" }, "reverse:" + item.key, plan);
      }
    }
    for (const bill of plan.bills) {
      for (const allocation of bill.allocations) {
        const item = plan.orders.find((order) => order.key === allocation.orderKey)!;
        await appendCommand(trx, options.principal, "RECORD_COLLECTION", { propertyId: plan.propertyId, orderId: item.orderId, externalPaymentBillId: bill.billId, amountMinor: allocation.amountMinor, method: "WECOM", transactionReference: bill.reference, note: "固定历史合付款收口：按真实金额分配" }, { code: "RECORD_COLLECTION", note: "固定历史合付款收口：按真实金额分配" }, `allocate:${bill.key}:${item.key}`, plan);
      }
    }
    return { ...base, cashAfterMinor: await assertPostState(trx, plan, cashBeforeMinor) };
  });
}

function parseArgs(argv: readonly string[]): { plan: string; dryRun: boolean } {
  const known = new Set(["--execute", "--dry-run"]);
  const planArg = argv.find((value) => value.startsWith("--plan="));
  const unknown = argv.filter((value) => value !== "--execute" && value !== "--dry-run" && !value.startsWith("--plan="));
  if (unknown.length > 0) throw new Error("存在未知参数：" + unknown.join(","));
  if (argv.includes("--execute") && argv.includes("--dry-run")) throw new Error("--execute 与 --dry-run 不能同时使用");
  return { plan: planArg?.slice(7) ?? "fixed-plan", dryRun: !argv.includes("--execute") };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.plan !== "fixed-plan") throw new Error("仅允许 --plan fixed-plan");
  const plan = fixedPlanFromEnvironment();
  const connectionString = process.env.MIGRATION_DATABASE_URL ?? databaseUrl();
  if (!args.dryRun && !process.env.MIGRATION_DATABASE_URL) throw new Error("正式执行必须使用MIGRATION_DATABASE_URL所有者连接");
  if (process.env.HISTORICAL_RECONCILIATION_APPROVED_SHA256 !== plan.planSha256) throw new Error("必须提供已审阅且完全匹配的计划 SHA");
  const db = createDatabase(connectionString);
  try {
    if (!args.dryRun) {
      const identity = await sql`SELECT current_user = pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = current_database()`.execute(db);
      if (!identity.rows[0]?.owner) throw new Error("正式历史收口只允许目标数据库所有者连接");
    }
    const subjectId = process.env.HISTORICAL_RECONCILIATION_SUBJECT_ID ?? "subject_demo_admin";
    const report = await runHistoricalReconciliation(db, plan, { dryRun: args.dryRun, principal: { subjectId, credentialId: "historical-payment-reconciliation", credentialType: "SESSION", displayName: "历史合付款收口" } });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally { await db.destroy(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) void main().catch((error) => { console.error(error); process.exitCode = 1; });

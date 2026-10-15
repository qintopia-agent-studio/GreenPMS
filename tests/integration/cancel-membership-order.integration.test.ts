import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthPrincipal, CommandEnvelope } from "@qintopia/contracts";
import {
  createDatabase,
  databaseReady,
  confirmCommandPreview,
  createCommandPreview,
  getMemberView,
  type Database
} from "@qintopia/db";
import { sql, type Kysely } from "kysely";
import { runtimeDatabaseUrlForTesting } from "../helpers/runtime-database.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { authScope } from "../helpers/auth-principals.ts";
import { resetDatabase } from "../helpers/database.ts";

const databaseUrl = process.env.CANCEL_MEMBERSHIP_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_cancel_membership";

const principal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Demo Agent",
  ...authScope()
};

const products = {
  sharedSingle: "membership_product_shared_bath_single_v1",
  privateSingle: "membership_product_private_bath_single_v1",
  sharedQuad: "membership_product_shared_bath_quad_v1"
} as const;

let db: Kysely<Database>;
let sequence = 0;
const memberId = "member_membership_orders_test";

function metadata(prefix: string) {
  sequence += 1;
  return { idempotencyKey: `${prefix}-${sequence}`, correlationId: `${prefix}-${sequence}` };
}

async function preview(envelope: CommandEnvelope, prefix: string) {
  return createCommandPreview(db, principal, envelope, metadata(`${prefix}-preview`));
}

async function confirm(envelope: CommandEnvelope, prefix: string) {
  const prepared = await preview(envelope, prefix);
  return confirmCommandPreview(db, principal, prepared.preview.previewId, {
    propertyId: demo.propertyId,
    commandType: envelope.commandType,
    confirmation: true,
    expectedEffectHash: prepared.preview.effectHash,
    reason: { code: envelope.commandType, note: `确认 ${prefix}` }
  }, metadata(`${prefix}-confirm`));
}

async function createMembershipOrder(productId: string = products.sharedSingle, agreedPriceMinor = 162000, reason?: string) {
  const receipt = await confirm({
    commandType: "CREATE_MEMBERSHIP_ORDER",
    input: {
      propertyId: demo.propertyId,
      memberId,
      membershipProductId: productId,
      agreedPriceMinor,
      ...(reason ? { priceAdjustmentReason: reason } : {})
    }
  }, "create-membership-order");
  return receipt.result!.membershipOrderId as string;
}

async function recordPayment(membershipOrderId: string, amountMinor: number, transactionReference: string) {
  return confirm({
    commandType: "RECORD_MEMBERSHIP_PAYMENT",
    input: { propertyId: demo.propertyId, membershipOrderId, amountMinor, transactionReference }
  }, `record-${transactionReference}`);
}


beforeEach(async () => {
  db = await resetDatabase(databaseUrl);
  await db.insertInto("members").values({
    id: memberId,
    identity_card_number: "MEMBERSHIP-ORDERS-TEST",
    nickname: "会员订单测试",
    full_name: "会员订单测试",
    phone: "13900009991",
    wechat: "membership-orders-test"
  }).execute();
  await db.insertInto("member_property_links").values({
    member_id: memberId,
    property_id: demo.propertyId
  }).execute();
});

afterEach(async () => {
  await db.destroy();
});

const cancelEnvelope = (membershipOrderId: string, reason = "重复办理"): CommandEnvelope => ({
  commandType: "CANCEL_MEMBERSHIP_ORDER", input: { propertyId: demo.propertyId, membershipOrderId, reason }
});

describe("取消空白会员订单", () => {
  it("通过 runtime 取消重复单并保留正常订单、合同、权益和操作人记录", async () => {
    const active = await createMembershipOrder();
    await recordPayment(active, 162000, "cancel-test-paid");
    await confirm({ commandType: "ACTIVATE_MEMBERSHIP_ORDER", input: { propertyId: demo.propertyId, membershipOrderId: active } }, "activate");
    const duplicate = await createMembershipOrder();
    const before = await getMemberView(db, demo.propertyId, memberId);
    const ledgerBefore = await db.selectFrom("entitlement_ledger").selectAll().orderBy("fact_id").execute();
    const coverageBefore = await db.selectFrom("coverage_items").selectAll().orderBy("id").execute();
    const runtime = createDatabase(runtimeDatabaseUrlForTesting(databaseUrl));
    try {
      const prepared = await createCommandPreview(runtime, principal, cancelEnvelope(duplicate), metadata("runtime-preview"));
      const input = { propertyId: demo.propertyId, commandType: "CANCEL_MEMBERSHIP_ORDER" as const, confirmation: true as const,
        expectedEffectHash: prepared.preview.effectHash, reason: { code: "CANCEL_MEMBERSHIP_ORDER", note: "重复办理" } };
      const meta = metadata("runtime-confirm");
      const receipt = await confirmCommandPreview(runtime, principal, prepared.preview.previewId, input, meta);
      expect(receipt.businessCommitted).toBe(true);
      const replay = await confirmCommandPreview(runtime, principal, prepared.preview.previewId, input, meta);
      expect(replay.commandId).toBe(receipt.commandId);
    } finally { await runtime.destroy(); }
    const after = await getMemberView(db, demo.propertyId, memberId);
    expect(after.membershipOrders.find(s => s.order.id === active)).toEqual(before.membershipOrders.find(s => s.order.id === active));
    expect(await db.selectFrom("entitlement_ledger").selectAll().orderBy("fact_id").execute()).toEqual(ledgerBefore);
    expect(await db.selectFrom("coverage_items").selectAll().orderBy("id").execute()).toEqual(coverageBefore);
    expect(after.contracts).toEqual(before.contracts);
    expect(after.lots).toEqual(before.lots);
    expect(after.membershipOrders.find(s => s.order.id === duplicate)).toMatchObject({ order: { status: "VOIDED" }, cancellation: { reason: "重复办理", actor_display_name: principal.displayName } });
    expect(await db.selectFrom("membership_order_cancellations").selectAll().execute()).toHaveLength(1);
    await expect(preview(cancelEnvelope(duplicate), "repeat-cancel")).rejects.toThrow("只能取消");
    await expect(recordPayment(duplicate, 93600, "after-cancel")).rejects.toThrow("已作废");
    await expect(preview({commandType:"ACTIVATE_MEMBERSHIP_ORDER", input:{propertyId:demo.propertyId,membershipOrderId:duplicate}},"activate-cancelled")).rejects.toThrow();
  });

  it("拒绝已收款、已生效及空白原因", async () => {
    const id = await createMembershipOrder();
    await expect(preview(cancelEnvelope(id, "   "), "blank")).rejects.toThrow();
    await recordPayment(id, 162000, "paid");
    await expect(preview(cancelEnvelope(id), "paid-cancel")).rejects.toThrow("只能取消");
    await confirm({commandType:"ACTIVATE_MEMBERSHIP_ORDER",input:{propertyId:demo.propertyId,membershipOrderId:id}},"activate-paid");
    await expect(preview(cancelEnvelope(id), "active-cancel")).rejects.toThrow("只能取消");
    expect(await db.selectFrom("membership_order_cancellations").selectAll().execute()).toHaveLength(0);
  });

  it("预览后新增收款会阻止取消，并发两个取消最多写入一次", async () => {
    const id = await createMembershipOrder();
    const prepared = await preview(cancelEnvelope(id), "stale");
    await recordPayment(id, 100, "intervening-payment");
    const result = await confirmCommandPreview(db, principal, prepared.preview.previewId, {
      propertyId:demo.propertyId, commandType:"CANCEL_MEMBERSHIP_ORDER", confirmation:true,
      expectedEffectHash:prepared.preview.effectHash, reason:{code:"CANCEL_MEMBERSHIP_ORDER",note:"重复办理"}
    },metadata("stale-confirm"));
    expect(result.businessCommitted).toBe(false);
    expect((await db.selectFrom("membership_orders").selectAll().where("id","=",id).executeTakeFirstOrThrow()).status).toBe("DRAFT");
    const empty = await createMembershipOrder();
    const previews = await Promise.all([preview(cancelEnvelope(empty),"race-a"),preview(cancelEnvelope(empty),"race-b")]);
    const receipts = await Promise.all(previews.map(p => confirmCommandPreview(db,principal,p.preview.previewId,{
      propertyId:demo.propertyId,commandType:"CANCEL_MEMBERSHIP_ORDER",confirmation:true,expectedEffectHash:p.preview.effectHash,
      reason:{code:"CANCEL_MEMBERSHIP_ORDER",note:"重复办理"}
    },metadata("race-confirm"))));
    expect(receipts.filter(r=>r.businessCommitted)).toHaveLength(1);
  });

  it("拒绝跨门店和缺少命令授权", async () => {
    const id = await createMembershipOrder();
    const forbidden = { ...principal, credentialId: "token_demo_read" };
    await expect(createCommandPreview(db,forbidden,cancelEnvelope(id),metadata("forbidden"))).rejects.toThrow();
    await expect(preview({commandType:"CANCEL_MEMBERSHIP_ORDER",input:{propertyId:"other-property",membershipOrderId:id,reason:"重复办理"}},"cross-property")).rejects.toThrow();
    await db.deleteFrom("token_command_ceilings").where("token_id","=",principal.credentialId)
      .where("command_type","=","CANCEL_MEMBERSHIP_ORDER").execute();
    await expect(preview(cancelEnvelope(id),"missing-token-ceiling")).rejects.toThrow();
  });

  it("数据库拒绝绕过命令直接作废和无完成证据的取消记录", async () => {
    const id = await createMembershipOrder();
    const runtime = createDatabase(runtimeDatabaseUrlForTesting(databaseUrl));
    try {
      await expect(runtime.updateTable("membership_orders").set({status:"VOIDED",version:2}).where("id","=",id).execute()).rejects.toThrow();
      await expect(runtime.insertInto("membership_order_cancellations").values({membership_order_id:id,command_id:"missing-command",reason:"重复办理",prior_version:1}).execute()).rejects.toThrow();
    } finally { await runtime.destroy(); }
    expect((await db.selectFrom("membership_orders").select("status").where("id","=",id).executeTakeFirstOrThrow()).status).toBe("DRAFT");
  });
  it("取消和收款并发时只能一方完成，不能留下已取消且有收款的订单", async () => {
    const id = await createMembershipOrder();
    const cancel = await preview(cancelEnvelope(id), "cancel-race");
    const payment = await preview({ commandType: "RECORD_MEMBERSHIP_PAYMENT", input: {
      propertyId: demo.propertyId, membershipOrderId: id, amountMinor: 93600, transactionReference: "payment-race"
    } }, "payment-race");
    const receipts = await Promise.all([cancel,payment].map(p => confirmCommandPreview(db,principal,p.preview.previewId,{
      propertyId:demo.propertyId, commandType:p.preview.commandType, confirmation:true,
      expectedEffectHash:p.preview.effectHash,reason:{code:p.preview.commandType,note:"并发验证"}
    },metadata("race"))));
    expect(receipts.filter(r=>r.businessCommitted)).toHaveLength(1);
    const order = await db.selectFrom("membership_orders").selectAll().where("id","=",id).executeTakeFirstOrThrow();
    const facts = await db.selectFrom("membership_payment_facts").selectAll().where("membership_order_id","=",id).execute();
    expect(facts).toHaveLength(order.status === "VOIDED" ? 0 : 1);
  });

  it("缺少最终回执审计时整笔取消回滚，审计表不可篡改", async () => {
    const id = await createMembershipOrder();
    await expect(db.transaction().execute(async trx => {
      await trx.insertInto("command_executions").values({ id:"incomplete-cancel",subject_id:principal.subjectId,
        credential_id:principal.credentialId,property_id:demo.propertyId,command_type:"CANCEL_MEMBERSHIP_ORDER",
        idempotency_key:"incomplete-cancel",request_hash:"a".repeat(64),correlation_id:"incomplete-cancel",state:"EXECUTING",completed_at:null }).execute();
      await trx.insertInto("membership_order_cancellations").values({membership_order_id:id,command_id:"incomplete-cancel",reason:"重复办理",prior_version:1}).execute();
      await trx.updateTable("membership_orders").set({status:"VOIDED",version:2}).where("id","=",id).execute();
    })).rejects.toThrow();
    expect(await db.selectFrom("membership_order_cancellations").selectAll().execute()).toHaveLength(0);
    expect((await db.selectFrom("membership_orders").select("status").where("id","=",id).executeTakeFirstOrThrow()).status).toBe("DRAFT");
    await confirm(cancelEnvelope(id),"complete-cancel");
    await expect(db.updateTable("membership_order_cancellations").set({reason:"篡改"}).where("membership_order_id","=",id).execute()).rejects.toThrow();
    await expect(db.deleteFrom("membership_order_cancellations").where("membership_order_id","=",id).execute()).rejects.toThrow();
  });

  it("运行角色就绪且取消守卫被禁用时拒绝就绪", async () => {
    const runtime = createDatabase(runtimeDatabaseUrlForTesting(databaseUrl));
    try {
      expect(await databaseReady(runtime,{staffProfileManifestName:"demo"})).toBe(true);
      await sql`ALTER TABLE membership_order_cancellations DISABLE TRIGGER membership_order_cancellation_complete`.execute(db);
      expect(await databaseReady(runtime,{staffProfileManifestName:"demo"})).toBe(false);
      await sql`ALTER TABLE membership_order_cancellations ENABLE TRIGGER membership_order_cancellation_complete`.execute(db);
      expect(await databaseReady(runtime,{staffProfileManifestName:"demo"})).toBe(true);
    } finally { await runtime.destroy(); }
  });

});

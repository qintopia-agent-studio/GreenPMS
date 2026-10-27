import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import type { AuthPrincipal, CommandEnvelope } from "@qintopia/contracts";
import { confirmCommandPreview, createCommandPreview, type Database } from "@qintopia/db";
import { newId } from "@qintopia/domain";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { resetDatabase, testDatabaseUrl } from "../helpers/database.ts";
import { authScope } from "../helpers/auth-principals.ts";

const url = new URL(testDatabaseUrl);
url.pathname = "/qintopia_wecom_positive_pricing_guard";
const principal: AuthPrincipal = {
  subjectId: demo.administratorSubjectId,
  credentialId: "token_demo_admin_write",
  credentialType: "TOKEN",
  displayName: "数据库金额约束测试",
  ...authScope({ profile: "administrator" })
};
let db: Kysely<Database>;
let sequence = 0;
const metadata = () => ({ idempotencyKey: `positive-pricing-${++sequence}`, correlationId: `positive-pricing-${sequence}` });

async function execute(command: CommandEnvelope) {
  const prepared = await createCommandPreview(db, principal, command, metadata());
  const receipt = await confirmCommandPreview(db, principal, prepared.preview.previewId, {
    propertyId: demo.propertyId,
    commandType: command.commandType,
    confirmation: true,
    expectedEffectHash: prepared.preview.effectHash,
    reason: command.commandType === "CREATE_ORDER"
      ? { code: "CREATE_STANDARD_ORDER", note: "" }
      : { code: "DATABASE_GUARD_TEST", note: "合成数据库边界验收" }
  }, metadata());
  expect(receipt.businessCommitted, JSON.stringify(receipt.error)).toBe(true);
  return receipt;
}

async function createOrder(kind: "ordinary" | "free" | "member", day: number) {
  const quote = await createQuoteForTesting(db, {
    propertyId: demo.propertyId,
    inventoryUnitId: kind === "member" ? "unit_room_d_gen_01" : demo.roomId,
    stayType: kind === "free" ? "FREE" : "TRANSIENT",
    arrivalDate: `2028-11-${String(day).padStart(2, "0")}`,
    departureDate: `2028-11-${String(day + 1).padStart(2, "0")}`,
    pricingPolicyVersionId: kind === "free" ? demo.freePolicyId : demo.transientPolicyId,
    ...(kind === "member" ? { memberId: demo.memberId } : {})
  });
  const receipt = await execute({ commandType: "CREATE_ORDER", input: {
    propertyId: demo.propertyId, quoteId: quote.quoteId,
    primaryGuest: { fullName: kind, nickname: kind },
    ...(kind === "ordinary" ? { bookingChannelCode: "WECOM", targetCurrentContractAmountMinor: quote.currentContractAmount.minorUnits } : {}),
    ...(kind === "free" ? { freeStayCategoryCode: "RECEPTION", freeStayReason: "测试免费接待" } : {})
  } });
  return String(receipt.result!.orderId);
}

async function currentAmount(orderId: string) {
  return db.selectFrom("orders").innerJoin("pricing_revisions", "pricing_revisions.id", "orders.current_revision_id")
    .select("pricing_revisions.current_contract_amount_minor").where("orders.id", "=", orderId).executeTakeFirstOrThrow();
}

describe.sequential("ordinary WECOM PostgreSQL amount guard", () => {
  beforeEach(async () => { db = await resetDatabase(url.toString()); });
  afterEach(async () => { if (db) await db.destroy(); });

  it("rejects a direct SQL zero revision for an ordinary WECOM order", async () => {
    const orderId = await createOrder("ordinary", 1);
    const before = await currentAmount(orderId);
    await expect(sql`INSERT INTO pricing_revisions(id,order_id,revision_no,amendment_id,policy_version_id,arrival_date,departure_date,
      coverage_set,cash_lines,policy_base_amount_minor,pricing_basis,manual_adjustment_minor,current_contract_amount_minor,currency)
      SELECT ${newId("revision")},p.order_id,p.revision_no+1,p.amendment_id,p.policy_version_id,p.arrival_date,p.departure_date,
        p.coverage_set,p.cash_lines,p.policy_base_amount_minor,'MANUAL_ADJUSTMENT',-p.policy_base_amount_minor,0,p.currency
      FROM orders o JOIN pricing_revisions p ON p.id=o.current_revision_id WHERE o.id=${orderId}`.execute(db))
      .rejects.toMatchObject({ code: "23514", constraint: "ordinary_wecom_positive_contract_amount" });
    expect(await currentAmount(orderId)).toEqual(before);
    expect((await db.selectFrom("pricing_revisions").select("id").where("order_id", "=", orderId).execute())).toHaveLength(1);
  });

  it("preserves committed FREE and member cash-zero revisions", async () => {
    const freeId = await createOrder("free", 3);
    const memberId = await createOrder("member", 5);
    expect(await currentAmount(freeId)).toMatchObject({ current_contract_amount_minor: 0 });
    expect(await currentAmount(memberId)).toMatchObject({ current_contract_amount_minor: 0 });
  });

  it("preserves ordinary WECOM cancellation zero revisions", async () => {
    const orderId = await createOrder("ordinary", 7);
    await execute({ commandType: "CANCEL_ORDER", input: { propertyId: demo.propertyId, orderId } });
    expect(await currentAmount(orderId)).toMatchObject({ current_contract_amount_minor: 0 });
    expect(await db.selectFrom("orders").select("status").where("id", "=", orderId).executeTakeFirstOrThrow())
      .toMatchObject({ status: "CANCELLED" });
  });

  it("lets runtime read maintenance evidence but denies the owner helper and evidence writes", async () => {
    await db.transaction().execute(async trx => {
      await sql`SET LOCAL ROLE qintopia_runtime`.execute(trx);
      expect((await sql`SELECT command_id FROM owner_historical_payment_reprices`.execute(trx)).rows).toEqual([]);
    });
    await expect(db.transaction().execute(async trx => {
      await sql`SET LOCAL ROLE qintopia_runtime`.execute(trx);
      await sql`SELECT qintopia_reprice_fixed_historical_d04('x','x',1,${"0".repeat(64)},'x','x','x','x','x','x','x')`.execute(trx);
    })).rejects.toMatchObject({ code: "42501" });
    await expect(db.transaction().execute(async trx => {
      await sql`SET LOCAL ROLE qintopia_runtime`.execute(trx);
      await sql`INSERT INTO owner_historical_payment_reprices DEFAULT VALUES`.execute(trx);
    })).rejects.toMatchObject({ code: "42501" });
  });
});


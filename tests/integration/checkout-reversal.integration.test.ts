import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import { createDatabase, databaseReady, createCommandPreview, confirmCommandPreview, getOrderViewSnapshot, type Database } from "@qintopia/db";
import { Value } from "@sinclair/typebox/value";
import { FormatRegistry } from "@sinclair/typebox";
import { CommandEffectSchema, ReceiptSchema } from "../../apps/api/src/schemas.ts";
import { checkoutReversalPreviewHasEvidence, receiptHasCommandEvidence } from "../../apps/web/src/ui.tsx";
import type { AuthPrincipal, CommandType } from "@qintopia/contracts";
import { demo } from "../../packages/db/src/seed.ts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import { withPropertyClockForTesting } from "../../packages/db/src/members.ts";
import { resetTestDatabase, testDatabaseUrl } from "../helpers/database.ts";
import { runtimeDatabaseUrlForTesting } from "../helpers/runtime-database.ts";
import { authScope } from "../helpers/auth-principals.ts";
import { assertOrderView } from "../../apps/web/src/orderViewValidation.ts";

let owner: Kysely<Database>;
let db: Kysely<Database>;
let sequence = 0;
const businessDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
function dateOffset(days: number) {
  const date = new Date(`${businessDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
FormatRegistry.Set("date", (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)));
FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
const admin: AuthPrincipal = { subjectId: demo.administratorSubjectId, credentialId: "token_demo_admin_write",
  credentialType: "TOKEN", displayName: "Admin", ...authScope({ profile: "administrator" }) };
const staff: AuthPrincipal = { subjectId: demo.agentSubjectId, credentialId: "token_demo_write",
  credentialType: "TOKEN", displayName: "Staff", ...authScope() };
const clock = <T>(date: string, run: () => Promise<T>) => withPropertyClockForTesting(new Date(`${date}T04:00:00Z`), run);
const meta = () => ({ idempotencyKey: `checkout-reversal-${++sequence}`, correlationId: `checkout-reversal-${sequence}` });
async function preview(commandType: CommandType, input: Record<string, unknown>, principal = admin) {
  return createCommandPreview(db, principal, { commandType, input: { propertyId: demo.propertyId, ...input } }, meta());
}
async function command(commandType: CommandType, input: Record<string, unknown>, principal = admin) {
  const prepared = await preview(commandType, input, principal);
  const receipt = await confirmCommandPreview(db, principal, prepared.preview.previewId, {
    propertyId: demo.propertyId, commandType, confirmation: true, expectedEffectHash: prepared.preview.effectHash,
    reason: commandType === "CREATE_ORDER" && !input.backfill ? { code: "CREATE_STANDARD_ORDER", note: "" }
      : { code: input.backfill ? "BACKFILL_STAY" : commandType,
        note: String(input.backfillReason ?? input.reasonNote ?? "客人改变行程，恢复原住宿") }
  }, meta());
  expect(receipt.error, JSON.stringify(receipt)).toBeUndefined();
  expect(receipt.businessCommitted, JSON.stringify(receipt)).toBe(true);
  if (commandType === "REVOKE_CHECK_OUT") {
    expect(Value.Check(CommandEffectSchema, prepared.preview.effect)).toBe(true);
    expect(Value.Check(ReceiptSchema, JSON.parse(JSON.stringify(receipt)))).toBe(true);
    expect(checkoutReversalPreviewHasEvidence(prepared.preview.effect, input)).toBe(true);
    expect(receiptHasCommandEvidence(commandType, JSON.parse(JSON.stringify(receipt)), input, prepared.preview.effect, prepared.preview.effectHash)).toBe(true);
    expect(receiptHasCommandEvidence(commandType, JSON.parse(JSON.stringify(receipt)), input, undefined, prepared.preview.effectHash)).toBe(true);
  }
  return receipt;
}
async function createOrder(member = false, unitId = demo.roomId as string, phone = "13800000000",
  options: { checkIn?: boolean; free?: boolean; channel?: "WECOM" | "CTRIP"; backfill?: boolean; amount?: number } = {}) {
  return clock(options.backfill ? dateOffset(5) : dateOffset(-5), async () => {
    const quote = await createQuoteForTesting(owner, { propertyId: demo.propertyId, inventoryUnitId: unitId,
      arrivalDate: dateOffset(-5), departureDate: dateOffset(4),
      pricingPolicyVersionId: options.free ? demo.freePolicyId : demo.publicPricingPolicyId,
      ...(options.free ? { stayType: "FREE" } : {}), ...(member ? { memberId: demo.memberId } : {}) });
    const created = await command("CREATE_ORDER", { quoteId: quote.quoteId,
      primaryGuest: { fullName: "撤销退房验收", nickname: "恢复原住宿", phone },
      ...(options.backfill ? { backfill: true, backfillReason: "补录实际住宿" } : {}),
      ...(options.free ? { freeStayCategoryCode: "VOLUNTEER", freeStayReason: "志愿服务住宿" }
        : member ? {} : { bookingChannelCode: options.channel ?? "WECOM", channelOrderReference: options.channel === "CTRIP" ? "CHANNEL-REVERSAL" : null }),
      ...(options.amount !== undefined ? { targetCurrentContractAmountMinor: options.amount,
        ...(options.channel === "CTRIP" ? { channelPriceDifferenceReason: "按原渠道成交价" } : { manualPriceAdjustmentReason: "按原协议价" }) } : {}) });
    const orderId = created.result!.orderId as string;
    if (options.checkIn !== false && !options.backfill) await command("CHECK_IN", { orderId });
    return orderId;
  });
}
async function confirmPrepared(prepared: Awaited<ReturnType<typeof preview>>, metadata = meta()) {
  return confirmCommandPreview(db, admin, prepared.preview.previewId, {
    propertyId: demo.propertyId, commandType: prepared.preview.commandType, confirmation: true,
    expectedEffectHash: prepared.preview.effectHash, reason: { code: "REVOKE_CHECK_OUT", note: "恢复原住宿" }
  }, metadata);
}
async function convertedOrder() {
  const orderId = await createOrder(false, "unit_room_201", "13977770001");
  const member = await command("CREATE_MEMBER", { fullName: "撤销退房验收", nickname: "恢复原住宿", phone: "13977770001", wechat: "checkout-reversal" });
  const converted = await clock(dateOffset(-4), () => command("CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP", { orderId,
    memberId: member.result!.memberId, membershipProductId: "membership_product_shared_bath_single_v1",
    collectionFactIds: [], agreedPriceMinor: 162000, remainingPaymentTransactionReference: "WX-REVERSE-CHECKOUT" }));
  await clock(businessDate, () => command("SHORTEN_STAY", { orderId, newDepartureDate: businessDate }));
  return { orderId, lotId: converted.result!.entitlementLotId as string };
}
async function snapshot(orderId: string) {
  const result = await getOrderViewSnapshot(db, orderId, "WRITE", admin.propertyCommandGrants.get(demo.propertyId)!);
  assertOrderView(JSON.parse(JSON.stringify(result)));
  return result;
}

beforeEach(async () => {
  owner = await resetTestDatabase();
  db = createDatabase(runtimeDatabaseUrlForTesting(testDatabaseUrl));
});
afterEach(async () => { await db?.destroy(); await owner?.destroy(); });

describe("administrator checkout reversal", () => {
  it("restores an early checkout atomically to the original dates and agreed price", async () => {
    const orderId = await createOrder();
    const before = await snapshot(orderId);
    await clock(businessDate, () => command("SHORTEN_STAY", { orderId, newDepartureDate: businessDate }));
    const result = await clock(businessDate, () => command("REVOKE_CHECK_OUT", { orderId }));
    expect(result.result).toMatchObject({ status: "CHECKED_IN", mode: "UNDO_EARLY_CHECK_OUT", after: { departureDate: dateOffset(4) } });
    const restored = await snapshot(orderId);
    expect(restored.order.current_contract_amount_minor).toBe(before.order.current_contract_amount_minor);
    expect(restored.fulfillment.checkOut).toBeNull();
    expect(restored.arrangementHistory.at(-1)?.type).toBe("CHECK_OUT_REVOCATION");
    expect(restored.effectiveArrangement.intervals).toEqual(before.effectiveArrangement.intervals);
  });
  it("allows repeated normal checkout and reversal without losing history", async () => {
    const orderId = await createOrder();
    await clock(dateOffset(4), async () => {
      for (let round = 0; round < 2; round += 1) {
        await command("CHECK_OUT", { orderId });
        await command("REVOKE_CHECK_OUT", { orderId });
        expect((await snapshot(orderId)).order.status).toBe("CHECKED_IN");
      }
      await command("CHECK_OUT", { orderId });
      expect((await snapshot(orderId)).amendments.filter((item) => item.amendment_type === "CHECK_OUT")).toHaveLength(3);
    });
  });
  it.each(["normal", "early"] as const)("restores available actions and permits membership conversion after %s checkout reversal", async (mode) => {
    const phone = "13977770009";
    const orderId = await createOrder(false, "unit_room_201", phone);
    const member = await command("CREATE_MEMBER", { fullName: "撤销退房验收", nickname: "恢复后升级", phone, wechat: "reversal-upgrade" });
    const payment = await command("RECORD_COLLECTION", { orderId, amountMinor: 60000, method: "WECOM", transactionReference: "SYNTHETIC-REOPEN-UPGRADE" });
    await clock(mode === "early" ? businessDate : dateOffset(4), async () => {
      const before = await snapshot(orderId);
      const input = { orderId, memberId: member.result!.memberId,
        membershipProductId: "membership_product_shared_bath_single_v1", collectionFactIds: payment.factRefs,
        agreedPriceMinor: 162000, remainingPaymentTransactionReference: "SYNTHETIC-REOPEN-UPGRADE-REMAINDER" };
      const beforeConversion = await preview("CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP", input, staff);
      await command(mode === "early" ? "SHORTEN_STAY" : "CHECK_OUT", {
        orderId, ...(mode === "early" ? { newDepartureDate: businessDate } : {})
      });
      await command("REVOKE_CHECK_OUT", { orderId });
      const restored = await snapshot(orderId);
      expect(restored.allowedActions).toEqual(before.allowedActions);
      const afterConversion = await preview("CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP", input, staff);
      expect(afterConversion.preview.effect).toEqual(beforeConversion.preview.effect);
      await command("CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP", input, mode === "early" ? staff : admin);
      const converted = await snapshot(orderId);
      expect(converted.order.status).toBe("CHECKED_IN");
      expect(converted.order.departure_date).toBe(dateOffset(4));
      expect(converted.membershipConversion?.memberId).toBe(member.result!.memberId);
      expect(converted.coverageSet.filter((coverage) => coverage.status === "CONSUMED")).toHaveLength(9);
      expect(converted.fulfillment.checkOut).toBeNull();
    });
  });
  it("rejects ordinary staff and direct status-only database updates", async () => {
    const orderId = await createOrder();
    await clock(dateOffset(4), () => command("CHECK_OUT", { orderId }));
    await expect(preview("REVOKE_CHECK_OUT", { orderId }, staff)).rejects.toThrow();
    await expect(owner.updateTable("orders").set({ status: "CHECKED_IN" }).where("id", "=", orderId).execute()).rejects.toThrow("requires a checkout reversal");
    expect((await snapshot(orderId)).order.status).toBe("CHECKED_OUT");
  });
  it("retains real collections and refuses a competing room claim", async () => {
    const orderId = await createOrder();
    await command("RECORD_COLLECTION", { orderId, amountMinor: 10000, method: "CASH", note: "已收现金" });
    await clock(businessDate, () => command("SHORTEN_STAY", { orderId, newDepartureDate: businessDate }));
    const before = await snapshot(orderId);
    await clock(businessDate, () => command("LOCK_MAINTENANCE", { inventoryUnitId: demo.roomId,
      arrivalDate: dateOffset(1), departureDate: dateOffset(2), reason: "维修" }));
    await expect(clock(businessDate, () => preview("REVOKE_CHECK_OUT", { orderId }))).rejects.toMatchObject({ code: "INVENTORY_CONFLICT" });
    expect((await snapshot(orderId)).collectionFacts).toEqual(before.collectionFacts);
    expect((await snapshot(orderId)).order.status).toBe("CHECKED_OUT");
  });
  it("does not consume ordinary membership entitlement a second time", async () => {
    const orderId = await createOrder(true, "unit_room_201");
    const before = await snapshot(orderId);
    await clock(businessDate, () => command("SHORTEN_STAY", { orderId, newDepartureDate: businessDate }));
    const result = await clock(businessDate, () => command("REVOKE_CHECK_OUT", { orderId }));
    expect(result.result!.entitlementReconsumeDates).toEqual([]);
    const restored = await snapshot(orderId);
    expect(restored.coverageSet).toEqual(before.coverageSet);
    const ledger = await db.selectFrom("entitlement_ledger").select(sql<string>`sum(quantity_delta)::text`.as("delta"))
      .where("order_id", "=", orderId).executeTakeFirstOrThrow();
    expect(Number(ledger.delta)).toBe(-2);
  });
  it("restores returned future entitlement for an in-house membership conversion", async () => {
    const { orderId } = await convertedOrder();
    const result = await clock(businessDate, () => command("REVOKE_CHECK_OUT", { orderId }));
    expect(result.result!.entitlementReconsumeDates).toEqual([businessDate, dateOffset(1), dateOffset(2), dateOffset(3)]);
    expect((await snapshot(orderId)).coverageSet.filter((item) => item.status === "CONSUMED")).toHaveLength(9);
    await clock(businessDate, () => command("SHORTEN_STAY", { orderId, newDepartureDate: businessDate }));
    await clock(businessDate, () => command("REVOKE_CHECK_OUT", { orderId }));
    await clock(dateOffset(4), () => command("CHECK_OUT", { orderId }));
    expect((await snapshot(orderId)).coverageSet.filter((item) => item.status === "CONSUMED")).toHaveLength(9);
  });
  it("preserves a real refund, invalidates the old preview, and restores the original price", async () => {
    const orderId = await createOrder();
    const collected = await command("RECORD_COLLECTION", { orderId, amountMinor: 200000, method: "CASH", note: "现金收款" });
    await clock(businessDate, () => command("SHORTEN_STAY", { orderId, newDepartureDate: businessDate }));
    const old = await preview("REVOKE_CHECK_OUT", { orderId });
    await command("RECORD_REFUND", { orderId, amountMinor: 10000, referencesFactId: collected.factRefs[0], method: "CASH", note: "已实际退款" });
    const before = await snapshot(orderId);
    expect(await confirmPrepared(old)).toMatchObject({ businessCommitted: false, error: { code: "PREVIEW_STALE" } });
    expect(await snapshot(orderId)).toEqual(before);
    const result = await command("REVOKE_CHECK_OUT", { orderId });
    expect(result.result!.fundsSummary).toMatchObject({ netRecordedCollection: { minorUnits: 190000 } });
    expect((await snapshot(orderId)).collectionFacts).toEqual(before.collectionFacts);
  });
  it.each([{ free: true }, { channel: "CTRIP" as const, amount: 80000 }, { amount: 80000 }])("restores original pricing without repricing: %j", async (options) => {
    const orderId = await createOrder(false, demo.roomId, "13800000000", options);
    const original = (await snapshot(orderId)).pricingRevisions.at(-1)!;
    await clock(businessDate, () => command("SHORTEN_STAY", { orderId, newDepartureDate: businessDate,
      ...(options.channel ? { targetCurrentContractAmountMinor: 40000, channelPriceDifferenceReason: "渠道提前退房结算" } : {}) }));
    await command("REVOKE_CHECK_OUT", { orderId });
    const restored = (await snapshot(orderId)).pricingRevisions.at(-1)!;
    expect(restored).toMatchObject({ pricing_basis: original.pricing_basis, cash_lines: original.cash_lines,
      current_contract_amount_minor: original.current_contract_amount_minor, manual_adjustment_minor: original.manual_adjustment_minor });
  });
  it("restores historical room moves and leaves earlier independent shortening in place", async () => {
    const orderId = await createOrder();
    await clock(businessDate, () => command("MOVE_UNIT", { orderId, newInventoryUnitId: demo.secondRoomId, effectiveDate: businessDate }));
    const original = await snapshot(orderId);
    await clock(businessDate, () => command("SHORTEN_STAY", { orderId, newDepartureDate: businessDate }));
    await command("REVOKE_CHECK_OUT", { orderId });
    expect((await snapshot(orderId)).effectiveArrangement.intervals).toEqual(original.effectiveArrangement.intervals);
    await command("SHORTEN_STAY", { orderId, newDepartureDate: dateOffset(2) });
    await clock(dateOffset(2), () => command("CHECK_OUT", { orderId }));
    const result = await clock(dateOffset(2), () => command("REVOKE_CHECK_OUT", { orderId }));
    expect(result.result).toMatchObject({ mode: "UNDO_CHECK_OUT", after: { departureDate: dateOffset(2) } });
  });
  it.each(["COMPLETE_STAY", "BACKFILL"])("restores checkout recorded through %s and preserves the original check-in", async (mode) => {
    const orderId = await createOrder(false, demo.roomId, "13800000000", { checkIn: false, backfill: mode === "BACKFILL" });
    await clock(dateOffset(5), async () => {
      if (mode === "COMPLETE_STAY") await command("COMPLETE_STAY", { orderId, actualStayCompletedConfirmed: true, reasonNote: "恢复原住宿" });
      const before = await snapshot(orderId);
      await command("REVOKE_CHECK_OUT", { orderId });
      expect((await snapshot(orderId)).fulfillment.checkIn).toEqual(before.fulfillment.checkIn);
    });
  });
  it.each(["balance", "expiry"])("refuses unavailable original membership entitlement: %s", async (mode) => {
    const { orderId, lotId } = await convertedOrder();
    if (mode === "balance") {
      const lot = await owner.selectFrom("entitlement_lots").select("total_units").where("id", "=", lotId).executeTakeFirstOrThrow();
      await command("CORRECT_MEMBER_ENTITLEMENT_BALANCE", { entitlementLotId: lotId, expectedAvailableBalance: lot.total_units - 5, targetAvailableBalance: 0, adjustmentReason: "核对剩余权益" });
    }
    const before = await snapshot(orderId);
    await expect(clock(mode === "expiry" ? dateOffset(1500) : businessDate, () => preview("REVOKE_CHECK_OUT", { orderId })))
      .rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    expect(await snapshot(orderId)).toEqual(before);
  });
  it("serializes competing reversals and replays the same confirmation", async () => {
    const orderId = await createOrder();
    await command("SHORTEN_STAY", { orderId, newDepartureDate: businessDate });
    const first = await preview("REVOKE_CHECK_OUT", { orderId });
    const second = await preview("REVOKE_CHECK_OUT", { orderId });
    const keys = [meta(), meta()];
    const results = await Promise.all([confirmPrepared(first, keys[0]), confirmPrepared(second, keys[1])]);
    expect(results.filter((result) => result.businessCommitted)).toHaveLength(1);
    const winner = results.findIndex((result) => result.businessCommitted);
    expect(await confirmPrepared(winner === 0 ? first : second, keys[winner])).toEqual(results[winner]);
    expect((await snapshot(orderId)).amendments.filter((item) => item.amendment_type === "REVOKE_CHECK_OUT")).toHaveLength(1);
  });
  it("serializes restoration against a competing booking of the released dates", async () => {
    const orderId = await createOrder();
    await command("SHORTEN_STAY", { orderId, newDepartureDate: businessDate });
    const reversal = await preview("REVOKE_CHECK_OUT", { orderId });
    const quote = await createQuoteForTesting(owner, { propertyId: demo.propertyId, inventoryUnitId: demo.roomId,
      arrivalDate: dateOffset(1), departureDate: dateOffset(4), pricingPolicyVersionId: demo.publicPricingPolicyId });
    const booking = await preview("CREATE_ORDER", { quoteId: quote.quoteId, primaryGuest: { fullName: "另一位客人", nickname: "新预订" }, bookingChannelCode: "WECOM", channelOrderReference: null });
    const results = await Promise.all([confirmPrepared(reversal), confirmPrepared(booking)]);
    expect(results.filter((result) => result.businessCommitted)).toHaveLength(1);
  });
  it("blocks a restored whole room when one of its beds is already occupied", async () => {
    const orderId = await createOrder();
    await command("SHORTEN_STAY", { orderId, newDepartureDate: businessDate });
    const prepared = await preview("REVOKE_CHECK_OUT", { orderId });
    await command("LOCK_MAINTENANCE", { inventoryUnitId: demo.bedAId, arrivalDate: dateOffset(1), departureDate: dateOffset(2), reason: "床位维修" });
    const before = await snapshot(orderId);
    expect(await confirmPrepared(prepared)).toMatchObject({ businessCommitted: false, error: { code: "PREVIEW_STALE" } });
    expect(await snapshot(orderId)).toEqual(before);
  });
  it("does not undo an independent membership conversion after checkout", async () => {
    const orderId = await createOrder(false, "unit_room_201", "13977770001");
    await command("SHORTEN_STAY", { orderId, newDepartureDate: businessDate });
    const member = await command("CREATE_MEMBER", { fullName: "撤销退房验收", nickname: "恢复原住宿", phone: "13977770001", wechat: "checkout-reversal" });
    await command("CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP", { orderId, memberId: member.result!.memberId,
      membershipProductId: "membership_product_shared_bath_single_v1", collectionFactIds: [],
      agreedPriceMinor: 162000, remainingPaymentTransactionReference: "WX-AFTER-CHECKOUT" });
    await expect(preview("REVOKE_CHECK_OUT", { orderId })).rejects.toMatchObject({ code: "INVALID_ORDER_STATE" });
  });
  it("checks overdue occupancy through the current business day", async () => {
    const orderId = await createOrder();
    await clock(dateOffset(4), () => command("CHECK_OUT", { orderId }));
    await command("LOCK_MAINTENANCE", { inventoryUnitId: demo.roomId, arrivalDate: dateOffset(5), departureDate: dateOffset(7), reason: "维修" });
    await expect(clock(dateOffset(6), () => preview("REVOKE_CHECK_OUT", { orderId }))).rejects.toMatchObject({ code: "INVENTORY_CONFLICT" });
  });
  it.each(["pricing_revisions", "inventory_claims", "coverage_items", "entitlement_ledger", "orders", "command_receipts"])("rolls back the complete business transaction on a %s failure", async (table) => {
    const { orderId } = await convertedOrder();
    const prepared = await preview("REVOKE_CHECK_OUT", { orderId });
    const before = await snapshot(orderId);
    const operation = table === "orders" ? "UPDATE" : "INSERT";
    await sql.raw(`CREATE FUNCTION test_reversal_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      ${table === "command_receipts" ? "IF NEW.execution_status <> 'EXECUTED' THEN RETURN NEW; END IF;" : ""}
      RAISE EXCEPTION 'injected reversal write failure'; END $$;
      CREATE TRIGGER test_reversal_failure BEFORE ${operation} ON ${table} FOR EACH ROW EXECUTE FUNCTION test_reversal_failure();`).execute(owner);
    expect(await confirmPrepared(prepared)).toMatchObject({ businessCommitted: false });
    expect(await snapshot(orderId)).toEqual(before);
  });
  it("rejects a forged restoration amount at the database boundary", async () => {
    const orderId = await createOrder();
    await command("SHORTEN_STAY", { orderId, newDepartureDate: businessDate });
    const prepared = await preview("REVOKE_CHECK_OUT", { orderId });
    const before = await snapshot(orderId);
    await sql`CREATE FUNCTION test_reversal_tamper() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      NEW.payload := jsonb_set(NEW.payload, '{after,currentContractAmount,minorUnits}', '0'::jsonb); RETURN NEW; END $$;
      CREATE TRIGGER test_reversal_tamper BEFORE INSERT ON amendments FOR EACH ROW
        WHEN (NEW.amendment_type = 'REVOKE_CHECK_OUT') EXECUTE FUNCTION test_reversal_tamper();`.execute(owner);
    expect(await confirmPrepared(prepared)).toMatchObject({ businessCommitted: false });
    expect(await snapshot(orderId)).toEqual(before);
  });
  it("fails startup readiness when any reversal guard is disabled or the unique source index is missing", async () => {
    const options = { staffProfileManifestName: "demo" };
    expect(await databaseReady(db, options)).toBe(true);
    for (const [table, name] of [["orders", "orders_checkout_reversal_transition"], ["stays", "stays_checkout_reversal_transition"],
      ["amendments", "amendments_checkout_reversal"], ["command_executions", "command_executions_checkout_reversal"]]) {
      await sql.raw(`ALTER TABLE ${table} DISABLE TRIGGER ${name}`).execute(owner);
      expect(await databaseReady(db, options)).toBe(false);
      await sql.raw(`ALTER TABLE ${table} ENABLE TRIGGER ${name}`).execute(owner);
    }
    expect(await databaseReady(db, options)).toBe(true);
    await sql`DROP INDEX amendments_one_reversal_per_checkout`.execute(owner);
    expect(await databaseReady(db, options)).toBe(false);
  });
});

import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { AuthPrincipal, CommandEnvelope } from "@qintopia/contracts";
import { createCommandPreview, confirmCommandPreview } from "@qintopia/db";
import { createDatabase } from "../../packages/db/src/database.ts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { syncWecomSource, type PaymentClient } from "../../packages/db/src/wecom-sync.ts";
import { authScope } from "../helpers/auth-principals.ts";


const propertyId = "prop_qintopia_demo";
function databaseUrl() {
  const value = process.env.E2E_DATABASE_URL;
  if (!value) throw new Error("Set E2E_DATABASE_URL explicitly to a local synthetic test database");
  const target = new URL(value);
  if (!["127.0.0.1", "localhost"].includes(target.hostname) || !/_(?:e2e|test)$/.test(target.pathname) || target.search || target.hash) throw new Error("Only a dedicated local e2e/test database is allowed");
  return value;
}
async function prepare(group: string) {
  const db = createDatabase(databaseUrl()), suffix = randomUUID();
  const principal: AuthPrincipal = { subjectId: demo.administratorSubjectId, credentialId: `refund-test-${suffix}`, credentialType: "SESSION", displayName: "合成验收管理员", ...authScope({ credentialType: "SESSION", profile: "administrator" }) };
  const metadata = () => ({ idempotencyKey: randomUUID(), correlationId: randomUUID() });
  const reference = `SYNTHETIC-REFUND-${group}-${suffix}`, refundReference = `${reference}-RETURN`;
  const sourceId = `synthetic-refund-${suffix}`, merchantId = `synthetic-merchant-${suffix}`;
  const nickname = `合成收退补记-${group}`;
  async function execute(command: CommandEnvelope) {
    const { preview } = await createCommandPreview(db, principal, command, metadata());
    const receipt = await confirmCommandPreview(db, principal, preview.previewId, { propertyId, commandType: command.commandType, confirmation: true, expectedEffectHash: preview.effectHash, reason: { code: command.commandType === "CREATE_ORDER" ? "CREATE_STANDARD_ORDER" : "CANCEL_ORDER", note: command.commandType === "CREATE_ORDER" ? "" : "合成验收：实际收退款均漏记" } }, metadata());
    if (!receipt.businessCommitted) throw new Error(JSON.stringify(receipt));
    return receipt;
  }
  try {
    await db.insertInto("web_sessions").values({ id: principal.credentialId, subject_id: principal.subjectId, secret_hash: randomBytes(32).toString("hex"), expires_at: new Date(Date.now() + 3600000), revoked_at: null }).execute();
    const arrival = `${new Date().getUTCFullYear() + 3}-02-${group === "mobile" ? "12" : "10"}`;
    const departure = `${new Date().getUTCFullYear() + 3}-02-${group === "mobile" ? "13" : "11"}`;
    const quote = await createQuoteForTesting(db, { propertyId, inventoryUnitId: demo.roomId, stayType: "TRANSIENT", arrivalDate: arrival, departureDate: departure, pricingPolicyVersionId: demo.transientPolicyId });
    const created = await execute({ commandType: "CREATE_ORDER", input: { propertyId, quoteId: quote.quoteId, primaryGuest: { fullName: nickname, nickname }, bookingChannelCode: "WECOM", targetCurrentContractAmountMinor: 100000, manualPriceAdjustmentReason: "合成验收约定价" } });
    const orderId = created.result!.orderId as string;
    await execute({ commandType: "CANCEL_ORDER", input: { propertyId, orderId } });
    const now = new Date(), occurredAt = new Date(now.getTime() - 1000);
    await sql`INSERT INTO external_payment_sources(id,corp_id,enabled,matching_since,import_since,synced_until,baseline_complete)
      VALUES(${sourceId},${sourceId},true,${new Date(now.getTime()-3600000)},${new Date(now.getTime()-3600000)},${new Date(now.getTime()-120000)},true)`.execute(db);
    await sql`INSERT INTO external_payment_accounts(source_id,merchant_id,property_id) VALUES(${sourceId},${merchantId},${propertyId})`.execute(db);
    const client: PaymentClient = { bills: async () => ({ bills: [
      { kind: "COLLECTION", merchantId, reference, transactionId: reference, originalTradeNo: reference, externalUserId: suffix, collectorId: "synthetic-staff", amountMinor: 100000, occurredAt, state: "SUCCESS" },
      { kind: "REFUND", merchantId, reference: refundReference, transactionId: reference, originalTradeNo: reference, externalUserId: suffix, collectorId: "synthetic-staff", amountMinor: 100000, occurredAt, state: "SUCCESS" }
    ], nextCursor: null }), nickname: async () => nickname };
    await syncWecomSource(db, sourceId, client, now);
    return { orderId, reference, refundReference, nickname };
  } finally { await db.destroy(); }
}

const group = process.argv[2];
if (group !== "desktop" && group !== "mobile") throw new Error("Expected desktop or mobile fixture");
void prepare(group).then(fixture => console.log(JSON.stringify(fixture))).catch(error => { console.error(error); process.exitCode = 1; });

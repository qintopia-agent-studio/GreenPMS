import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthPrincipal, CommandEnvelope, ReceiptDto } from "@qintopia/contracts";
import {
  confirmCommandPreview,
  createCommandPreview,
  getMemberView,
  listMemberSummaries,
  localDateInTimeZone,
  propertyLocalToday,
  type Database
} from "@qintopia/db";
import type { Kysely } from "kysely";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { resetDatabase } from "../helpers/database.ts";

const databaseUrl = process.env.MEMBER_ENTITLEMENT_EXPIRY_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_member_entitlement_expiry";

const principal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Demo Agent",
  propertyAccess: new Map([[demo.propertyId, "WRITE"]])
};

const memberId = "member_expiry_consistency";
const activeContractId = "contract_expiry_consistency_active";
const inactiveContractId = "contract_expiry_consistency_inactive";

let db: Kysely<Database>;
let today: string;
let yesterday: string;
let tomorrow: string;
let sequence = 0;

function shiftLocalDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function metadata(prefix: string) {
  sequence += 1;
  return { idempotencyKey: `${prefix}-${sequence}`, correlationId: `${prefix}-${sequence}` };
}

async function preview(envelope: CommandEnvelope, prefix: string) {
  return createCommandPreview(db, principal, envelope, metadata(`${prefix}-preview`));
}

async function confirm(envelope: CommandEnvelope, prefix: string): Promise<ReceiptDto> {
  const created = await preview(envelope, prefix);
  return confirmCommandPreview(db, principal, created.preview.previewId, {
    propertyId: envelope.input.propertyId as string,
    commandType: envelope.commandType,
    confirmation: true,
    expectedEffectHash: created.preview.effectHash,
    reason: { code: "ENTITLEMENT_EXPIRY_TEST", note: `Confirm ${prefix}` }
  }, metadata(`${prefix}-confirm`));
}

beforeEach(async () => {
  db = await resetDatabase(databaseUrl);
  const instant = new Date();
  const utcDate = instant.toISOString().slice(0, 10);
  const propertyTimeZone = ["Pacific/Kiritimati", "Pacific/Pago_Pago"]
    .find((timeZone) => localDateInTimeZone(timeZone, instant) !== utcDate);
  if (!propertyTimeZone) throw new Error("Expected an IANA timezone on the opposite side of the UTC date boundary");
  await db.updateTable("properties").set({ timezone: propertyTimeZone }).where("id", "=", demo.propertyId).execute();
  today = await propertyLocalToday(db, demo.propertyId);
  yesterday = shiftLocalDate(today, -1);
  tomorrow = shiftLocalDate(today, 1);
  await db.insertInto("members").values({
    id: memberId,
    identity_card_number: "EXPIRY-CONSISTENCY-ID",
    nickname: "到期一致性会员",
    full_name: "Expiry Consistency Member",
    phone: "13800000999",
    wechat: "expiry-consistency-member"
  }).execute();
  await db.insertInto("member_contracts").values([
    {
      id: activeContractId,
      property_id: demo.propertyId,
      member_id: memberId,
      member_name: "Expiry Consistency Member",
      status: "ACTIVE",
      valid_from: shiftLocalDate(today, -30),
      valid_until: shiftLocalDate(today, 30),
      version: 1
    },
    {
      id: inactiveContractId,
      property_id: demo.propertyId,
      member_id: memberId,
      member_name: "Expiry Consistency Member",
      status: "EXPIRED",
      valid_from: shiftLocalDate(today, -30),
      valid_until: shiftLocalDate(today, 30),
      version: 1
    }
  ]).execute();
  await db.insertInto("member_property_links").values({
    member_id: memberId,
    property_id: demo.propertyId
  }).onConflict((oc) => oc.columns(["member_id", "property_id"]).doNothing()).execute();
});

afterEach(async () => {
  await db.destroy();
});

describe("member entitlement natural expiry", () => {
  it("rejects a newly added already-expired Lot with zero writes while keeping expiresOn=today valid", async () => {
    const expiredEnvelope: CommandEnvelope = {
      commandType: "ADD_MEMBER_ENTITLEMENT_LOT",
      input: {
        propertyId: demo.propertyId,
        memberContractId: activeContractId,
        unitKind: "ROOM_NIGHT",
        units: 4,
        expiresOn: yesterday
      }
    };
    await expect(preview(expiredEnvelope, "add-expired-lot")).rejects.toMatchObject({
      code: "ENTITLEMENT_CONFLICT",
      details: { expiresOn: yesterday, propertyToday: today }
    });
    expect(await db.selectFrom("entitlement_lots").select("id").where("contract_id", "=", activeContractId).execute()).toEqual([]);
    expect(await db.selectFrom("entitlement_ledger").select("fact_id").execute()).toEqual([]);

    const validEnvelope: CommandEnvelope = {
      commandType: "ADD_MEMBER_ENTITLEMENT_LOT",
      input: {
        propertyId: demo.propertyId,
        memberContractId: activeContractId,
        unitKind: "ROOM_NIGHT",
        units: 3,
        expiresOn: today
      }
    };
    const created = await preview(validEnvelope, "add-today-lot");
    expect(created.preview.effect).toMatchObject({ expiresOn: today, units: 3 });
    expect(created.preview.effect).not.toHaveProperty("propertyToday");
    const receipt = await confirmCommandPreview(db, principal, created.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: validEnvelope.commandType,
      confirmation: true,
      expectedEffectHash: created.preview.effectHash,
      reason: { code: "LOT_ADDED", note: "Today remains a valid expiry date" }
    }, metadata("add-today-lot-confirm"));
    expect(receipt).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });
    const lotId = receipt.result!.entitlementLotId as string;
    expect((await getMemberView(db, demo.propertyId, memberId)).lotBalances)
      .toContainEqual({ lotId, unitKind: "ROOM_NIGHT", availableUnits: 3 });
  });

  it("rejects adjustments for both naturally expired Lots and Lots with an EXPIRE fact", async () => {
    await db.insertInto("entitlement_lots").values([
      { id: "lot_naturally_expired", contract_id: activeContractId, unit_kind: "ROOM_NIGHT", total_units: 4, expires_on: yesterday, version: 1 },
      { id: "lot_explicitly_expired", contract_id: activeContractId, unit_kind: "ROOM_NIGHT", total_units: 5, expires_on: tomorrow, version: 1 }
    ]).execute();
    await db.insertInto("entitlement_ledger").values({
      fact_id: "fact_explicit_expiration",
      lot_id: "lot_explicitly_expired",
      entry_type: "EXPIRE",
      quantity_delta: -5,
      service_date: null,
      order_id: null,
      coverage_id: null,
      reason: "Existing explicit expiry fact",
      command_id: null
    }).execute();

    await expect(preview({
      commandType: "ADJUST_MEMBER_ENTITLEMENT",
      input: {
        propertyId: demo.propertyId,
        entitlementLotId: "lot_naturally_expired",
        quantityDelta: 1,
        adjustmentReason: "Must not revive natural expiry"
      }
    }, "adjust-natural-expiry")).rejects.toMatchObject({
      code: "ENTITLEMENT_CONFLICT",
      details: { expiresOn: yesterday, propertyToday: today }
    });
    await expect(preview({
      commandType: "ADJUST_MEMBER_ENTITLEMENT",
      input: {
        propertyId: demo.propertyId,
        entitlementLotId: "lot_explicitly_expired",
        quantityDelta: 1,
        adjustmentReason: "Must not revive explicit expiry"
      }
    }, "adjust-explicit-expiry")).rejects.toMatchObject({
      code: "ENTITLEMENT_CONFLICT",
      details: { expirationFactId: "fact_explicit_expiration" }
    });
    expect(await db.selectFrom("entitlement_ledger").select("fact_id").where("entry_type", "=", "ADJUST").execute()).toEqual([]);
  });

  it("requires expiration asOfDate after expiresOn and no later than property today", async () => {
    await db.insertInto("entitlement_lots").values({
      id: "lot_ready_for_expiration",
      contract_id: activeContractId,
      unit_kind: "BED_NIGHT",
      total_units: 4,
      expires_on: yesterday,
      version: 1
    }).execute();

    await expect(preview({
      commandType: "EXPIRE_MEMBER_ENTITLEMENT",
      input: { propertyId: demo.propertyId, entitlementLotId: "lot_ready_for_expiration", asOfDate: yesterday }
    }, "expire-on-expiry-date")).rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    await expect(preview({
      commandType: "EXPIRE_MEMBER_ENTITLEMENT",
      input: { propertyId: demo.propertyId, entitlementLotId: "lot_ready_for_expiration", asOfDate: tomorrow }
    }, "expire-on-future-date")).rejects.toMatchObject({
      code: "ENTITLEMENT_CONFLICT",
      details: { asOfDate: tomorrow, propertyToday: today }
    });
    expect(await db.selectFrom("entitlement_ledger").select("fact_id").where("lot_id", "=", "lot_ready_for_expiration").execute()).toEqual([]);

    const receipt = await confirm({
      commandType: "EXPIRE_MEMBER_ENTITLEMENT",
      input: { propertyId: demo.propertyId, entitlementLotId: "lot_ready_for_expiration", asOfDate: today }
    }, "expire-on-property-today");
    expect(receipt).toMatchObject({
      executionStatus: "EXECUTED",
      businessCommitted: true,
      result: { entitlementLotId: "lot_ready_for_expiration", expiredUnits: 4, remainingAvailable: 0, asOfDate: today }
    });
    expect(await db.selectFrom("entitlement_ledger").select(["entry_type", "quantity_delta"])
      .where("lot_id", "=", "lot_ready_for_expiration").execute())
      .toEqual([{ entry_type: "EXPIRE", quantity_delta: -4 }]);
  });

  it("derives balances only from ACTIVE contracts and zeroes natural expiry without hiding history", async () => {
    await db.insertInto("entitlement_lots").values([
      { id: "lot_active_natural_expiry", contract_id: activeContractId, unit_kind: "ROOM_NIGHT", total_units: 4, expires_on: yesterday, version: 1 },
      { id: "lot_active_valid_today", contract_id: activeContractId, unit_kind: "ROOM_NIGHT", total_units: 3, expires_on: today, version: 1 },
      { id: "lot_inactive_contract", contract_id: inactiveContractId, unit_kind: "ROOM_NIGHT", total_units: 7, expires_on: tomorrow, version: 1 }
    ]).execute();
    await db.insertInto("entitlement_ledger").values([
      {
        fact_id: "fact_natural_expiry_history",
        lot_id: "lot_active_natural_expiry",
        entry_type: "ADJUST",
        quantity_delta: 2,
        service_date: null,
        order_id: null,
        coverage_id: null,
        reason: "Retained natural expiry history",
        command_id: null
      },
      {
        fact_id: "fact_inactive_contract_history",
        lot_id: "lot_inactive_contract",
        entry_type: "ADJUST",
        quantity_delta: 1,
        service_date: null,
        order_id: null,
        coverage_id: null,
        reason: "Retained inactive contract history",
        command_id: null
      }
    ]).execute();

    const view = await getMemberView(db, demo.propertyId, memberId);
    expect(view.balanceAsOfDate).toBe(today);
    expect(view.availableBalance).toEqual({ ROOM_NIGHT: 3, BED_NIGHT: 0 });
    expect(view.lotBalances).toEqual(expect.arrayContaining([
      { lotId: "lot_active_natural_expiry", unitKind: "ROOM_NIGHT", availableUnits: 0 },
      { lotId: "lot_active_valid_today", unitKind: "ROOM_NIGHT", availableUnits: 3 },
      { lotId: "lot_inactive_contract", unitKind: "ROOM_NIGHT", availableUnits: 0 }
    ]));
    expect(view.lots.map((lot) => lot.id)).toEqual(expect.arrayContaining([
      "lot_active_natural_expiry",
      "lot_active_valid_today",
      "lot_inactive_contract"
    ]));
    expect(view.ledger.map((entry) => entry.fact_id)).toEqual(expect.arrayContaining([
      "fact_natural_expiry_history",
      "fact_inactive_contract_history"
    ]));
    expect(await listMemberSummaries(db, demo.propertyId, "expiry-consistency-member")).toEqual([
      { member: expect.objectContaining({ id: "member_expiry_consistency" }) }
    ]);
  });

  it("never allocates a naturally expired Lot to a new Quote, including a historical service date", async () => {
    await db.insertInto("entitlement_lots").values([
      {
        id: "lot_expired_before_quote",
        contract_id: activeContractId,
        unit_kind: "ROOM_NIGHT",
        total_units: 4,
        expires_on: yesterday,
        version: 1
      },
      {
        id: "lot_valid_for_quote",
        contract_id: activeContractId,
        unit_kind: "ROOM_NIGHT",
        total_units: 1,
        expires_on: tomorrow,
        version: 1
      }
    ]).execute();

    const quote = await createQuoteForTesting(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.roomId,
      stayType: "TRANSIENT",
      arrivalDate: yesterday,
      departureDate: tomorrow,
      pricingPolicyVersionId: demo.publicPricingPolicyId,
      memberContractId: activeContractId
    });

    expect(quote.coverageSet).toEqual([{
      serviceDate: yesterday,
      inventoryUnitId: demo.roomId,
      unitKind: "ROOM_NIGHT",
      entitlementLotId: "lot_valid_for_quote"
    }]);
    expect(quote.cashLines).toEqual([expect.objectContaining({ serviceDate: today })]);
  });
});

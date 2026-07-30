import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthPrincipal, CommandEnvelope, ReceiptDto } from "@qintopia/contracts";
import {
  confirmCommandPreview,
  createCommandPreview,
  getMemberView,
  getOrderView,
  listMemberSummaries,
  propertyLocalToday,
  type Database
} from "@qintopia/db";
import { sql, type Kysely } from "kysely";
import { demo } from "../../packages/db/src/seed.ts";
import { createQuoteForTesting as createQuote } from "../../packages/db/src/pricing-service.ts";
import { resetDatabase } from "../helpers/database.ts";

const databaseUrl = process.env.MEMBER_PROFILE_LIFECYCLE_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_member_profile_lifecycle";

const principal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Demo Agent",
  propertyAccess: new Map([[demo.propertyId, "WRITE"]])
};

let db: Kysely<Database>;
let sequence = 0;

function shiftDate(value: string, days: number): string {
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
    reason: envelope.commandType === "CREATE_ORDER"
      ? { code: "CREATE_STANDARD_ORDER", note: "" }
      : { code: "MEMBER_LIFECYCLE_TEST", note: `Confirm ${prefix}` }
  }, metadata(`${prefix}-confirm`));
}

async function createMemberOrder(prefix: string, arrivalDate: string, departureDate: string): Promise<string> {
  const quote = await createQuote(db, {
    propertyId: demo.propertyId,
    inventoryUnitId: demo.roomId,
    stayType: "TRANSIENT",
    arrivalDate,
    departureDate,
    pricingPolicyVersionId: demo.publicPricingPolicyId,
    memberContractId: demo.memberContractId
  });
  const receipt = await confirm({
    commandType: "CREATE_ORDER",
    input: {
      propertyId: demo.propertyId,
      quoteId: quote.quoteId,
      primaryGuest: { fullName: `Member lifecycle ${prefix}`, nickname: `Member ${prefix}` }
    }
  }, `${prefix}-create-order`);
  return receipt.result!.orderId as string;
}

async function fulfillmentDatePair() {
  await db.updateTable("properties").set({ timezone: "Pacific/Pago_Pago" }).where("id", "=", demo.propertyId).execute();
  const arrivalDate = await propertyLocalToday(db, demo.propertyId);
  await db.updateTable("properties").set({ timezone: "Pacific/Kiritimati" }).where("id", "=", demo.propertyId).execute();
  const departureDate = await propertyLocalToday(db, demo.propertyId);
  expect(departureDate > arrivalDate).toBe(true);
  await db.updateTable("properties").set({ timezone: "Pacific/Pago_Pago" }).where("id", "=", demo.propertyId).execute();
  return { arrivalDate, departureDate };
}

beforeEach(async () => {
  db = await resetDatabase(databaseUrl);
});

afterEach(async () => {
  await db.destroy();
});

describe("member profile registration and directory", () => {
  const memberEnvelope = (identityCardNumber: string, fullName = "张三"): CommandEnvelope => ({
    commandType: "CREATE_MEMBER",
    input: {
      propertyId: demo.propertyId,
      fullName,
      identityCardNumber,
      phone: "13800000088",
      wechat: "zhangsan-wechat"
    }
  });

  it("atomically creates only a member profile and current-property link", async () => {
    const envelope = memberEnvelope("31000019900101001x");
    const before = {
      members: await db.selectFrom("members").select("id").execute(),
      links: await db.selectFrom("member_property_links").selectAll().execute(),
      contracts: await db.selectFrom("member_contracts").select("id").execute(),
      lots: await db.selectFrom("entitlement_lots").select("id").execute(),
      ledger: await db.selectFrom("entitlement_ledger").select("fact_id").execute(),
      references: await db.selectFrom("member_external_references").select("id").execute()
    };
    const createdPreview = await preview(envelope, "create-member");
    expect(createdPreview.preview.effect).toEqual({
      operation: "CREATE_MEMBER_PROFILE",
      memberId: null,
      member: {
        fullName: "张三",
        identityCardNumber: "31000019900101001X",
        phone: "13800000088",
        wechat: "zhangsan-wechat"
      },
      propertyLink: { operation: "CREATE" }
    });
    const receipt = await confirmCommandPreview(db, principal, createdPreview.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "CREATE_MEMBER",
      confirmation: true,
      expectedEffectHash: createdPreview.preview.effectHash,
      reason: { code: "CREATE_MEMBER_PROFILE", note: "创建会员档案" }
    }, metadata("create-member-confirm"));
    expect(receipt.result).toMatchObject({ memberCreated: true });
    const memberId = receipt.result!.memberId as string;
    expect(receipt.resourceRefs).toEqual([memberId]);
    expect(await db.selectFrom("members").select("id").execute()).toHaveLength(before.members.length + 1);
    expect(await db.selectFrom("member_property_links").selectAll().execute()).toEqual(expect.arrayContaining([
      expect.objectContaining({ member_id: memberId, property_id: demo.propertyId })
    ]));
    expect(await db.selectFrom("member_property_links").selectAll().execute()).toHaveLength(before.links.length + 1);
    expect(await db.selectFrom("member_contracts").select("id").execute()).toHaveLength(before.contracts.length);
    expect(await db.selectFrom("entitlement_lots").select("id").execute()).toHaveLength(before.lots.length);
    expect(await db.selectFrom("entitlement_ledger").select("fact_id").execute()).toHaveLength(before.ledger.length);
    expect(await db.selectFrom("member_external_references").select("id").execute()).toHaveLength(before.references.length);

    const view = await getMemberView(db, demo.propertyId, memberId);
    expect(view.member).toMatchObject({ identity_card_number: "31000019900101001X", full_name: "张三" });
    expect(view).toMatchObject({ contracts: [], lots: [], ledger: [], externalReferences: [], availableBalance: { ROOM_NIGHT: 0, BED_NIGHT: 0 } });
    await expect(db.updateTable("member_property_links").set({ property_id: "changed" }).where("member_id", "=", memberId).execute())
      .rejects.toThrow(/member_property_links is append-only/);
  });

  it("rolls back the member row when the property link cannot be inserted", async () => {
    const identityCardNumber = "TEST-MEMBER-LINK-ROLLBACK";
    const linksBefore = await db.selectFrom("member_property_links").select("member_id").execute();
    const created = await preview(memberEnvelope(identityCardNumber, "回滚会员"), "member-link-rollback");
    await sql`
      CREATE FUNCTION qintopia_reject_test_member_link() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM members
          WHERE id = NEW.member_id AND identity_card_number = 'TEST-MEMBER-LINK-ROLLBACK'
        ) THEN
          RAISE EXCEPTION 'test member link failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db);
    await sql`
      CREATE TRIGGER reject_test_member_link
      BEFORE INSERT ON member_property_links
      FOR EACH ROW EXECUTE FUNCTION qintopia_reject_test_member_link()
    `.execute(db);
    try {
      const rejected = await confirmCommandPreview(db, principal, created.preview.previewId, {
        propertyId: demo.propertyId,
        commandType: "CREATE_MEMBER",
        confirmation: true,
        expectedEffectHash: created.preview.effectHash,
        reason: { code: "CREATE_MEMBER_PROFILE", note: "验证原子回滚" }
      }, metadata("member-link-rollback-confirm"));
      expect(rejected).toMatchObject({ executionStatus: "NOT_EXECUTED", businessCommitted: false });
      expect(await db.selectFrom("members").select("id").where("identity_card_number", "=", identityCardNumber).execute()).toEqual([]);
      expect(await db.selectFrom("member_property_links").select("member_id").execute()).toEqual(linksBefore);
    } finally {
      await sql`DROP TRIGGER reject_test_member_link ON member_property_links`.execute(db);
      await sql`DROP FUNCTION qintopia_reject_test_member_link()`.execute(db);
    }
  });

  it("rejects a normalized duplicate identity while allowing repeated phone and WeChat values", async () => {
    const first = await confirm(memberEnvelope("TEST-UNIQUE-MEMBER-ID", "第一位会员"), "unique-member-first");
    await expect(preview(memberEnvelope(" test-unique-member-id ", "重复会员"), "unique-member-duplicate"))
      .rejects.toThrow("该身份证号已登记，不能重复创建会员档案");
    const second = await confirm(memberEnvelope("TEST-SECOND-MEMBER-ID", "第二位会员"), "unique-member-second");
    expect(first.result!.memberId).not.toBe(second.result!.memberId);
    expect(await db.selectFrom("members").select("id").where("phone", "=", "13800000088").execute()).toHaveLength(2);
    expect(await db.selectFrom("members").select("id").where("wechat", "=", "zhangsan-wechat").execute()).toHaveLength(2);
  });

  it("searches all four profile fields by safe partial text and enforces property isolation", async () => {
    const created = await confirm({
      commandType: "CREATE_MEMBER",
      input: {
        propertyId: demo.propertyId,
        fullName: "李晓云",
        identityCardNumber: "SEARCH-ID-998877X",
        phone: "13912345678",
        wechat: "cloud-search-wechat"
      }
    }, "search-member");
    const memberId = created.result!.memberId as string;
    for (const query of ["晓云", "998877x", "123456", "search-wechat"]) {
      expect(await listMemberSummaries(db, demo.propertyId, query)).toEqual([
        expect.objectContaining({ member: expect.objectContaining({ id: memberId }) })
      ]);
    }
    expect(await listMemberSummaries(db, demo.propertyId, "%")).toEqual([]);

    const otherPropertyId = "prop_member_isolation";
    await db.insertInto("properties").values({
      id: otherPropertyId,
      code: "MEMBER-ISOLATION",
      name: "Member isolation property",
      timezone: "Asia/Shanghai",
      currency: "CNY"
    }).execute();
    expect(await listMemberSummaries(db, otherPropertyId, "李晓云")).toEqual([]);
    await expect(getMemberView(db, otherPropertyId, memberId)).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    await db.insertInto("member_property_links").values({ member_id: memberId, property_id: otherPropertyId }).execute();
    expect(await listMemberSummaries(db, otherPropertyId, "李晓云")).toHaveLength(1);
    expect((await getMemberView(db, otherPropertyId, memberId)).member.id).toBe(memberId);
  });

  it("replays the original confirmation without duplicating the member", async () => {
    const envelope = memberEnvelope("TEST-IDEMPOTENT-MEMBER-ID", "幂等会员");
    const created = await preview(envelope, "idempotent-member");
    const confirmationInput = {
      propertyId: demo.propertyId,
      commandType: "CREATE_MEMBER" as const,
      confirmation: true as const,
      expectedEffectHash: created.preview.effectHash,
      reason: { code: "CREATE_MEMBER_PROFILE", note: "创建会员档案" }
    };
    const confirmationMetadata = { idempotencyKey: "member-idempotent-confirm", correlationId: "member-idempotent-first" };
    const first = await confirmCommandPreview(db, principal, created.preview.previewId, confirmationInput, confirmationMetadata);
    const replay = await confirmCommandPreview(db, principal, created.preview.previewId, confirmationInput, {
      ...confirmationMetadata,
      correlationId: "member-idempotent-replay"
    });
    expect(replay.receiptId).toBe(first.receiptId);
    expect(replay.result).toEqual(first.result);
    expect(await db.selectFrom("members").select("id").where("identity_card_number", "=", "TEST-IDEMPOTENT-MEMBER-ID").execute()).toHaveLength(1);
  });

  it("rejects a stale concurrent registration Preview without a second member write", async () => {
    const envelope: CommandEnvelope = {
      commandType: "CREATE_MEMBER",
      input: {
        propertyId: demo.propertyId,
        fullName: "Concurrent Member",
        identityCardNumber: "TEST-CONCURRENT-MEMBER-ID",
        phone: "13800000222",
        wechat: "concurrent-member"
      }
    };
    const first = await preview(envelope, "member-concurrent-first");
    const second = await preview(envelope, "member-concurrent-second");
    const [firstResult, secondResult] = await Promise.all([
      confirmCommandPreview(db, principal, first.preview.previewId, {
        propertyId: demo.propertyId,
        commandType: "CREATE_MEMBER",
        confirmation: true,
        expectedEffectHash: first.preview.effectHash,
        reason: { code: "CONCURRENT_ATTEMPT", note: "Concurrent member registration" }
      }, metadata("member-concurrent-first-confirm")),
      confirmCommandPreview(db, principal, second.preview.previewId, {
        propertyId: demo.propertyId,
        commandType: "CREATE_MEMBER",
        confirmation: true,
        expectedEffectHash: second.preview.effectHash,
        reason: { code: "CONCURRENT_ATTEMPT", note: "Concurrent member registration" }
      }, metadata("member-concurrent-second-confirm"))
    ]);
    expect([firstResult, secondResult].filter((receipt) => receipt.businessCommitted)).toHaveLength(1);
    expect([firstResult, secondResult].filter((receipt) => !receipt.businessCommitted)).toEqual([
      expect.objectContaining({
        executionStatus: "NOT_EXECUTED",
        error: expect.objectContaining({ code: "PREVIEW_STALE", message: expect.any(String) }),
        resourceRefs: [],
        factRefs: []
      })
    ]);
    expect(await db.selectFrom("members").select("id").where("identity_card_number", "=", "TEST-CONCURRENT-MEMBER-ID").execute()).toHaveLength(1);
  });
});

describe("check-in entitlement consumption lifecycle", () => {
  it("consumes HELD coverage at CHECK_IN and CHECK_OUT does not consume it again", async () => {
    const { arrivalDate, departureDate } = await fulfillmentDatePair();
    const orderId = await createMemberOrder("check-in-consume", arrivalDate, departureDate);
    const coverageCount = (await getOrderView(db, orderId)).coverageSet.length;
    const checkedInPreview = await preview({ commandType: "CHECK_IN", input: { propertyId: demo.propertyId, orderId } }, "check-in-consume");
    expect(checkedInPreview.preview.effect).toMatchObject({
      businessDate: arrivalDate,
      entitlementTransition: { from: "HELD", to: "CONSUMED", coverageCount }
    });
    const checkedIn = await confirmCommandPreview(db, principal, checkedInPreview.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "CHECK_IN",
      confirmation: true,
      expectedEffectHash: checkedInPreview.preview.effectHash,
      reason: { code: "CHECKED_IN", note: "Consume held member entitlement on arrival" }
    }, metadata("check-in-consume-confirm"));
    expect(checkedIn.factRefs).toHaveLength(coverageCount);
    expect((await getOrderView(db, orderId)).coverageSet.every((coverage) => coverage.status === "CONSUMED")).toBe(true);

    await db.updateTable("properties").set({ timezone: "Pacific/Kiritimati" }).where("id", "=", demo.propertyId).execute();
    const checkedOut = await confirm({ commandType: "CHECK_OUT", input: { propertyId: demo.propertyId, orderId } }, "check-out-no-repeat");
    expect(checkedOut.factRefs).toEqual([]);
    expect(await db.selectFrom("entitlement_ledger").select("fact_id").where("order_id", "=", orderId).where("entry_type", "=", "CONSUME").execute()).toHaveLength(coverageCount);
    expect(await db.selectFrom("cleaning_tasks").select("id").where("order_id", "=", orderId).execute()).toHaveLength(0);
  });

  it("keeps consumed nights unchanged when shortening is rejected on the arrival day", async () => {
    const arrivalDate = await propertyLocalToday(db, demo.propertyId);
    const orderId = await createMemberOrder("shorten-consumed", arrivalDate, shiftDate(arrivalDate, 2));
    await confirm({ commandType: "CHECK_IN", input: { propertyId: demo.propertyId, orderId } }, "shorten-consumed-check-in");
    const before = await getOrderView(db, orderId);
    await expect(preview({
      commandType: "SHORTEN_STAY",
      input: { propertyId: demo.propertyId, orderId, newDepartureDate: shiftDate(arrivalDate, 1) }
    }, "shorten-consumed-command")).rejects.toMatchObject({
      code: "INVALID_ORDER_STATE",
      message: "入住当天暂不办理缩短或提前退房；未实际使用房间时请使用后续的撤销入住流程"
    });
    const coverage = (await getOrderView(db, orderId)).coverageSet;
    expect(coverage).toEqual(before.coverageSet);
    expect(coverage.every((item) => item.status === "CONSUMED")).toBe(true);
    expect(await db.selectFrom("entitlement_ledger").select("fact_id").where("order_id", "=", orderId).where("entry_type", "=", "RELEASE").execute()).toHaveLength(0);
  });

  it("keeps consumed coverage identity on a same-kind in-house move", async () => {
    const arrivalDate = await propertyLocalToday(db, demo.propertyId);
    const orderId = await createMemberOrder("move-consumed", arrivalDate, shiftDate(arrivalDate, 2));
    await confirm({ commandType: "CHECK_IN", input: { propertyId: demo.propertyId, orderId } }, "move-consumed-check-in");
    const before = await getOrderView(db, orderId);
    const moved = await confirm({
      commandType: "MOVE_UNIT",
      input: { propertyId: demo.propertyId, orderId, newInventoryUnitId: demo.secondRoomId, effectiveDate: shiftDate(arrivalDate, 1) }
    }, "move-consumed-command");
    expect(moved.factRefs).toEqual([]);
    const after = await getOrderView(db, orderId);
    expect(after.currentSegment.inventoryUnitId).toBe(demo.secondRoomId);
    expect(after.coverageSet.map((coverage) => ({ id: coverage.id, inventory: coverage.inventory_unit_id, status: coverage.status })))
      .toEqual(before.coverageSet.map((coverage) => ({ id: coverage.id, inventory: coverage.inventory_unit_id, status: "CONSUMED" })));
  });

  it("immediately consumes newly covered nights added to an in-house order", async () => {
    const arrivalDate = await propertyLocalToday(db, demo.propertyId);
    const orderId = await createMemberOrder("refresh-in-house", arrivalDate, shiftDate(arrivalDate, 3));
    await confirm({ commandType: "CHECK_IN", input: { propertyId: demo.propertyId, orderId } }, "refresh-in-house-check-in");
    expect((await getOrderView(db, orderId)).coverageSet).toHaveLength(2);
    await confirm({
      commandType: "ADD_MEMBER_ENTITLEMENT_LOT",
      input: { propertyId: demo.propertyId, memberContractId: demo.memberContractId, unitKind: "ROOM_NIGHT", units: 1, expiresOn: "2029-12-31" }
    }, "refresh-in-house-top-up");
    const refreshed = await confirm({ commandType: "REFRESH_MEMBER_COVERAGE", input: { propertyId: demo.propertyId, orderId } }, "refresh-in-house-command");
    const refreshedFacts = await db.selectFrom("entitlement_ledger").select(["entry_type", "coverage_id"])
      .where("command_id", "=", refreshed.commandId).orderBy("entry_type").execute();
    expect(refreshedFacts.map((fact) => fact.entry_type).sort()).toEqual(["CONSUME", "HOLD"]);
    const view = await getOrderView(db, orderId);
    expect(view.coverageSet).toHaveLength(3);
    expect(view.coverageSet.every((coverage) => coverage.status === "CONSUMED")).toBe(true);
    expect(view.pricingRevisions.at(-1)!.current_contract_amount_minor).toBe(0);
  });
});

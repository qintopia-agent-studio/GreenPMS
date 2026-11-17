import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import { propertyLocalToday, databaseReady, createDatabase, createCommandPreview, confirmCommandPreview, type Database } from "@qintopia/db";
import { addMembershipValidity, sha256 } from "@qintopia/domain";
import type { AuthPrincipal, MembershipCatalogInput, MembershipCatalogEffect, CommandType } from "@qintopia/contracts";
import { resetDatabase } from "../helpers/database.ts";
import { runtimeDatabaseUrlForTesting } from "../helpers/runtime-database.ts";
import { authScope } from "../helpers/auth-principals.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { buildRoomCatalogEffect, readRoomCatalog } from "../../packages/db/src/room-catalog.ts";
import { readMembershipCatalog, requireMembershipProduct } from "../../packages/db/src/membership-catalog.ts";
const url = "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_membership_catalog_test";
let owner: Kysely<Database>, db: Kysely<Database>;
let sequence = 0;
const metadata = () => ({ idempotencyKey: `membership-catalog-${++sequence}`, correlationId: `membership-catalog-${sequence}` });
const admin: AuthPrincipal = { subjectId: demo.administratorSubjectId, credentialId: "session_membership_catalog_admin", credentialType: "SESSION",
  displayName: "会员产品管理员", ...authScope({ credentialType: "SESSION", profile: "administrator" }) };
async function run(commandType: CommandType, input: Record<string, unknown>) {
  const prepared = await createCommandPreview(db, admin, { commandType, input: { propertyId: demo.propertyId, ...input } }, metadata());
  const receipt = await confirmCommandPreview(db, admin, prepared.preview.previewId, { propertyId: demo.propertyId, commandType,
    expectedEffectHash: prepared.preview.effectHash, confirmation: true, reason: { code: commandType, note: "合成验收" } }, metadata());
  expect(receipt.businessCommitted, JSON.stringify(receipt.error)).toBe(true);
  return receipt;
}
async function newMember() {
  const receipt = await run("CREATE_MEMBER", { fullName: `合成会员${sequence}`, nickname: `合成${sequence}`, phone: `139${String(sequence).padStart(8,"0")}`, wechat: `synthetic-${sequence}` });
  return String(receipt.result!.memberId);
}
describe.sequential("membership catalog restricted runtime", () => {
  beforeAll(async () => {
    owner = await resetDatabase(url);
    await owner.insertInto("web_sessions").values({ id: admin.credentialId, subject_id: admin.subjectId,
      secret_hash: sha256("synthetic-membership-catalog-session"), expires_at: new Date("2030-01-01"), revoked_at: null }).execute();
    db = createDatabase(runtimeDatabaseUrlForTesting(url));
  }, 120000);
  afterAll(async () => { if (db) await db.destroy(); if (owner) await owner.destroy(); });
  it("passes complete readiness", async () => { expect(await databaseReady(db, { staffProfileManifestName: "demo" })).toBe(true); });
  it("retains four immutable templates and creates a six month product", async () => {
    expect((await readMembershipCatalog(db, demo.propertyId)).entries).toHaveLength(4);
    const input: MembershipCatalogInput = { propertyId: demo.propertyId, expectedRoomCatalogVersion: 0, action: "CREATE",
      specification: { name: "合成20夜会员", listPriceMinor: 180000, entitlementUnits: 20, validityPeriod: "P6M",
        allowedRoomTypeCodes: ["private_bath_standard", "private_bath_king"] } };
    const prepared = await createCommandPreview(db, admin, { commandType: "MANAGE_MEMBERSHIP_CATALOG", input: input as unknown as Record<string, unknown> }, metadata());
    const result = await confirmCommandPreview(db, admin, prepared.preview.previewId, { propertyId: demo.propertyId,
      commandType: "MANAGE_MEMBERSHIP_CATALOG", expectedEffectHash: prepared.preview.effectHash, confirmation: true,
      reason: { code: "MEMBERSHIP_CATALOG_CHANGE", note: "合成测试" } }, metadata());
    expect(result.businessCommitted, JSON.stringify(result.error)).toBe(true);
    const effect = prepared.preview.effect as unknown as MembershipCatalogEffect;
    expect((await readMembershipCatalog(db, demo.propertyId)).entries.find(e => e.code === effect.after.code)?.current.validityPeriod).toBe("P6M");
  });
  it("preserves DRAFT and ACTIVE snapshots after editing and stopping sale", async () => {
    const old = (await readMembershipCatalog(db,demo.propertyId)).entries.find(e=>e.current.validityPeriod==="P6M")!;
    const memberId = await newMember();
    const draft = await run("CREATE_MEMBERSHIP_ORDER", {memberId,membershipProductId:old.current.productId,agreedPriceMinor:180000});
    const orderId = String(draft.result!.membershipOrderId);
    await run("MANAGE_MEMBERSHIP_CATALOG", {propertyId:demo.propertyId,expectedRoomCatalogVersion:0,action:"UPDATE",code:old.code,expectedRevision:old.revision,
      specification:{name:"新规格",listPriceMinor:200000,entitlementUnits:24,validityPeriod:"P1Y",allowedRoomTypeCodes:["private_bath_king"]}});
    const edited=(await readMembershipCatalog(db,demo.propertyId)).entries.find(e=>e.code===old.code)!;
    await run("MANAGE_MEMBERSHIP_CATALOG", {expectedRoomCatalogVersion:0,action:"SET_SALE_STATUS",code:old.code,expectedRevision:edited.revision,saleStatus:"OFF_SALE"});
    await expect(requireMembershipProduct(db,demo.propertyId,old.current.productId)).rejects.toThrow();
    expect((await requireMembershipProduct(db,demo.propertyId,old.current.productId,true)).validity_period).toBe("P6M");
    await run("RECORD_MEMBERSHIP_PAYMENT", {membershipOrderId:orderId,amountMinor:180000,transactionReference:`synthetic-${sequence}`});
    await run("ACTIVATE_MEMBERSHIP_ORDER", {membershipOrderId:orderId});
    const active=await db.selectFrom("membership_orders").selectAll().where("id","=",orderId).executeTakeFirstOrThrow();
    expect(active).toMatchObject({product_id:old.current.productId,entitlement_units:20,validity_period:"P6M",agreed_price_minor:180000,status:"ACTIVE"});
    expect(active.valid_until).toBe(addMembershipValidity(active.valid_from!,"P6M"));
    const stopped=(await readMembershipCatalog(db,demo.propertyId)).entries.find(e=>e.code===old.code)!;
    await run("MANAGE_MEMBERSHIP_CATALOG", {expectedRoomCatalogVersion:0,action:"SET_SALE_STATUS",code:old.code,expectedRevision:stopped.revision,saleStatus:"ON_SALE"});
    expect(await db.selectFrom("membership_orders").selectAll().where("id","=",orderId).executeTakeFirst()).toEqual(active);
  });
  it("rejects token management and mixed room/bed scopes", async () => {
    const input={propertyId:demo.propertyId,expectedRoomCatalogVersion:0,action:"CREATE",specification:{name:"反例",listPriceMinor:10000,entitlementUnits:20,validityPeriod:"P6M",allowedRoomTypeCodes:["private_bath_king","shared_bath_quad"]}};
    await expect(createCommandPreview(db,admin,{commandType:"MANAGE_MEMBERSHIP_CATALOG",input},metadata())).rejects.toThrow("不能混用");
    await expect(createCommandPreview(db,{...admin,credentialType:"TOKEN"},{commandType:"MANAGE_MEMBERSHIP_CATALOG",input},metadata())).rejects.toThrow("管理员");
  });
  it("serializes competing edits and replays the original receipt once", async () => {
    const entry=(await readMembershipCatalog(db,demo.propertyId)).entries[0]!;
    const input={propertyId:demo.propertyId,expectedRoomCatalogVersion:0,action:"SET_SALE_STATUS",code:entry.code,expectedRevision:entry.revision,saleStatus:"OFF_SALE"};
    const previews=await Promise.all([createCommandPreview(db,admin,{commandType:"MANAGE_MEMBERSHIP_CATALOG",input},metadata()),createCommandPreview(db,admin,{commandType:"MANAGE_MEMBERSHIP_CATALOG",input},metadata())]);
    const keys=[metadata(),metadata()];
    const confirm=(index:number)=>confirmCommandPreview(db,admin,previews[index]!.preview.previewId,{propertyId:demo.propertyId,commandType:"MANAGE_MEMBERSHIP_CATALOG",expectedEffectHash:previews[index]!.preview.effectHash,confirmation:true,reason:{code:"MEMBERSHIP_CATALOG_CHANGE",note:"并发合成测试"}},keys[index]!);
    const results=await Promise.all([confirm(0),confirm(1)]);
    expect(results.filter(r=>r.businessCommitted)).toHaveLength(1);
    const success=results.findIndex(r=>r.businessCommitted);
    expect((await confirm(success)).receiptId).toBe(results[success]!.receiptId);
    expect((await readMembershipCatalog(db,demo.propertyId)).entries.find(e=>e.code===entry.code)?.revision).toBe(entry.revision+1);
  });

  it("backfills an off-sale historical six month version and corrects dates using its snapshot", async () => {
    const product=(await readMembershipCatalog(db,demo.propertyId)).versions.find(p=>p.validityPeriod==="P6M")!;
    const memberId=await newMember(); const today=await propertyLocalToday(db,demo.propertyId);
    const date=new Date(`${today}T00:00:00Z`);date.setUTCDate(date.getUTCDate()-10);const actual=date.toISOString().slice(0,10);
    const receipt=await run("BACKFILL_HISTORICAL_MEMBERSHIP",{memberId,membershipProductId:product.productId,actualMembershipDate:actual,evidenceNote:"合成历史凭据",
      payment:{amountMinor:180000,businessDate:actual,transactionReference:`backfill-${sequence}`}});
    const order=await db.selectFrom("membership_orders").selectAll().where("member_id","=",memberId).executeTakeFirstOrThrow();
    expect(order.valid_until).toBe(addMembershipValidity(actual,"P6M"));expect(order.validity_period).toBe("P6M");
    date.setUTCDate(date.getUTCDate()-1);const corrected=date.toISOString().slice(0,10);
    await run("CORRECT_MEMBERSHIP_EFFECTIVE_DATE",{membershipOrderId:order.id,actualMembershipDate:corrected,evidenceNote:"核实合成日期"});
    expect((await db.selectFrom("membership_orders").selectAll().where("id","=",order.id).executeTakeFirstOrThrow()).valid_until).toBe(addMembershipValidity(corrected,"P6M"));
    expect(receipt.businessCommitted).toBe(true);
  });

  it("denies runtime mutations, owner-only initialization and forged catalog pointers", async () => {
    const entries=(await readMembershipCatalog(db,demo.propertyId)).entries;
    const first=entries[0]!, second=entries[1]!;
    await expect(sql`select qintopia_initialize_membership_catalog(${demo.propertyId})`.execute(db)).rejects.toThrow("permission denied");
    await expect(db.updateTable("membership_product_catalog").set({sale_status:"OFF_SALE"}).where("code","=",first.code).execute()).rejects.toThrow("permission denied");
    await expect(owner.updateTable("membership_product_catalog").set({current_product_id:second.current.productId,revision:first.revision+1}).where("code","=",first.code).execute()).rejects.toThrow();
    const order=await db.selectFrom("membership_orders").selectAll().where("validity_period","=","P6M").executeTakeFirstOrThrow();
    await expect(owner.updateTable("membership_orders").set({validity_period:"P1Y"}).where("id","=",order.id).execute()).rejects.toThrow();
    expect((await db.selectFrom("membership_orders").select("validity_period").where("id","=",order.id).executeTakeFirstOrThrow()).validity_period).toBe("P6M");
    expect((await readMembershipCatalog(db,demo.propertyId)).entries).toEqual(entries);
  });
  it("rejects stale sales after catalog editing without creating an order", async () => {
    const entry=(await readMembershipCatalog(db,demo.propertyId)).entries.find(e=>e.saleStatus==="ON_SALE")!;
    const memberId=await newMember();
    const preview=await createCommandPreview(db,admin,{commandType:"CREATE_MEMBERSHIP_ORDER",input:{propertyId:demo.propertyId,memberId,membershipProductId:entry.current.productId,agreedPriceMinor:entry.current.listPriceMinor}},metadata());
    await run("MANAGE_MEMBERSHIP_CATALOG",{expectedRoomCatalogVersion:0,action:"SET_SALE_STATUS",code:entry.code,expectedRevision:entry.revision,saleStatus:"OFF_SALE"});
    const receipt=await confirmCommandPreview(db,admin,preview.preview.previewId,{propertyId:demo.propertyId,commandType:"CREATE_MEMBERSHIP_ORDER",expectedEffectHash:preview.preview.effectHash,confirmation:true,reason:{code:"TEST",note:"合成失效销售"}},metadata());
    expect(receipt.businessCommitted).toBe(false);expect(receipt.error?.code).toBe("PREVIEW_STALE");
    expect(await db.selectFrom("membership_orders").select("id").where("member_id","=",memberId).execute()).toHaveLength(0);
  });

  it("supports shared BED scopes without changing the existing bed transfer rules", async () => {
    const receipt=await run("MANAGE_MEMBERSHIP_CATALOG",{expectedRoomCatalogVersion:0,action:"CREATE",specification:{name:"合成共享床夜",listPriceMinor:100000,entitlementUnits:20,validityPeriod:"P6M",allowedRoomTypeCodes:["shared_bath_double","shared_bath_quad"]}});
    const after=receipt.result!.after as unknown as MembershipCatalogEffect["after"];
    expect(after.current).toMatchObject({entitlementUnitKind:"BED_NIGHT",entitlementUnits:20,validityPeriod:"P6M",allowedInventoryKind:"BED",allowedRoomTypeCodes:["shared_bath_double","shared_bath_quad"]});
  });
  it("rolls back a privileged catalog write that omits its receipt and audit", async () => {
    const before=await readMembershipCatalog(db,demo.propertyId);
    const prepared=await createCommandPreview(db,admin,{commandType:"MANAGE_MEMBERSHIP_CATALOG",input:{propertyId:demo.propertyId,expectedRoomCatalogVersion:0,action:"CREATE",specification:{name:"缺失回执反例",listPriceMinor:180000,entitlementUnits:20,validityPeriod:"P6M",allowedRoomTypeCodes:["private_bath_king"]}}},metadata());
    await expect(db.transaction().execute(async trx=>{
      await trx.insertInto("command_executions").values({id:"membership_incomplete",subject_id:admin.subjectId,credential_id:admin.credentialId,property_id:demo.propertyId,command_type:"MANAGE_MEMBERSHIP_CATALOG",idempotency_key:"membership_incomplete",request_hash:sha256("incomplete"),correlation_id:"membership_incomplete",state:"EXECUTING",completed_at:null}).execute();
      await sql`select qintopia_apply_membership_catalog('membership_incomplete',${JSON.stringify(prepared.preview.effect)}::jsonb,'缺少回执')`.execute(trx);
    })).rejects.toThrow("catalog command requires matching change, receipt and audit");
    expect(await readMembershipCatalog(db,demo.propertyId)).toEqual(before);
  });
  it("rejects another property's versions and keeps failed commands atomic", async () => {
    await owner.insertInto("properties").values({id:"property_membership_other",code:"MEMBERSHIP_OTHER",name:"合成另一门店",timezone:"Asia/Shanghai",currency:"CNY"}).execute();
    const localRooms=await readRoomCatalog(db,demo.propertyId);
    await owner.insertInto("room_catalog_state").values({property_id:"property_membership_other",version:1,snapshot:{version:1,types:[localRooms.types.find(type=>type.code==="shared_bath_single")!],rates:[]}}).execute();
    await expect(buildRoomCatalogEffect(db,{propertyId:"property_membership_other",expectedVersion:1,action:"DELETE_TYPE",typeCode:"shared_bath_single"})).resolves.toBeDefined();
    const product=(await readMembershipCatalog(db,demo.propertyId)).versions[0]!;
    await expect(requireMembershipProduct(db,"property_membership_other",product.productId,true)).rejects.toThrow("本门店");
    const before=await readMembershipCatalog(db,demo.propertyId);
    await expect(run("MANAGE_MEMBERSHIP_CATALOG",{expectedRoomCatalogVersion:0,action:"CREATE",specification:{name:"不可售房型",listPriceMinor:180000,entitlementUnits:20,validityPeriod:"P6M",allowedRoomTypeCodes:["missing"]}})).rejects.toThrow();
    expect(await readMembershipCatalog(db,demo.propertyId)).toEqual(before);
  });



  it("serializes a new sale against stopping the same product", async () => {
    const created=await run("MANAGE_MEMBERSHIP_CATALOG",{expectedRoomCatalogVersion:0,action:"CREATE",specification:{name:"销售停售竞争",listPriceMinor:180000,entitlementUnits:20,validityPeriod:"P6M",allowedRoomTypeCodes:["private_bath_king"]}});
    const entry=created.result!.after as unknown as MembershipCatalogEffect["after"];const memberId=await newMember();
    const sale=await createCommandPreview(db,admin,{commandType:"CREATE_MEMBERSHIP_ORDER",input:{propertyId:demo.propertyId,memberId,membershipProductId:entry.current.productId,agreedPriceMinor:180000}},metadata());
    const stop=await createCommandPreview(db,admin,{commandType:"MANAGE_MEMBERSHIP_CATALOG",input:{propertyId:demo.propertyId,expectedRoomCatalogVersion:0,action:"SET_SALE_STATUS",code:entry.code,expectedRevision:entry.revision,saleStatus:"OFF_SALE"}},metadata());
    const results=await Promise.all([sale,stop].map(prepared=>confirmCommandPreview(db,admin,prepared.preview.previewId,{propertyId:demo.propertyId,commandType:prepared.preview.commandType,expectedEffectHash:prepared.preview.effectHash,confirmation:true,reason:{code:"MEMBERSHIP_CATALOG_CHANGE",note:"合成销售停售竞争"}},metadata())));
    expect(results[1]!.businessCommitted).toBe(true);
    const orders=await db.selectFrom("membership_orders").selectAll().where("member_id","=",memberId).execute();
    expect(orders).toHaveLength(results[0]!.businessCommitted?1:0);
    if(orders.length)expect(orders[0]).toMatchObject({product_id:entry.current.productId,entitlement_units:20,validity_period:"P6M",agreed_price_minor:180000});
    else expect(results[0]!.error?.code).toBe("PREVIEW_STALE");
    expect((await readMembershipCatalog(db,demo.propertyId)).entries.find(item=>item.code===entry.code)?.saleStatus).toBe("OFF_SALE");
    expect(await databaseReady(db,{staffProfileManifestName:"demo"})).toBe(true);
  });
  it("rechecks withdrawn administrator grants before confirming", async () => {
    const rooms=await readRoomCatalog(db,demo.propertyId);const before=await readMembershipCatalog(db,demo.propertyId);
    const prepared=await createCommandPreview(db,admin,{commandType:"MANAGE_MEMBERSHIP_CATALOG",input:{propertyId:demo.propertyId,expectedRoomCatalogVersion:rooms.version,action:"CREATE",specification:{name:"撤权反例",listPriceMinor:180000,entitlementUnits:20,validityPeriod:"P6M",allowedRoomTypeCodes:["private_bath_king"]}}},metadata());
    await owner.deleteFrom("subject_command_grants").where("subject_id","=",admin.subjectId).where("property_id","=",demo.propertyId).where("command_type","=","MANAGE_MEMBERSHIP_CATALOG").execute();
    try {
      await expect(confirmCommandPreview(db,admin,prepared.preview.previewId,{propertyId:demo.propertyId,commandType:"MANAGE_MEMBERSHIP_CATALOG",expectedEffectHash:prepared.preview.effectHash,confirmation:true,reason:{code:"MEMBERSHIP_CATALOG_CHANGE",note:"合成撤权"}},metadata())).rejects.toMatchObject({code:"INSUFFICIENT_ACCESS"});
      expect(await readMembershipCatalog(db,demo.propertyId)).toEqual(before);
    } finally {
      await owner.insertInto("subject_command_grants").values({subject_id:admin.subjectId,property_id:demo.propertyId,command_type:"MANAGE_MEMBERSHIP_CATALOG"}).execute();
    }
  });
  it("invalidates a catalog preview when the room catalog changes", async () => {
    const before=await readMembershipCatalog(db,demo.propertyId);
    const rooms=await readRoomCatalog(db,demo.propertyId);
    const prepared=await createCommandPreview(db,admin,{commandType:"MANAGE_MEMBERSHIP_CATALOG",input:{propertyId:demo.propertyId,expectedRoomCatalogVersion:rooms.version,action:"CREATE",specification:{name:"过期房型预览",listPriceMinor:180000,entitlementUnits:20,validityPeriod:"P6M",allowedRoomTypeCodes:["private_bath_king"]}}},metadata());
    const type=rooms.types.find(type=>type.code==="private_bath_king")!;
    await run("MANAGE_ROOM_CATALOG",{expectedVersion:rooms.version,action:"SAVE_TYPE",typeCode:type.code,name:`${type.name}验收`,bathroom:type.bathroom,saleMode:type.saleMode,bedCount:type.bedCount,capacity:type.capacity});
    const receipt=await confirmCommandPreview(db,admin,prepared.preview.previewId,{propertyId:demo.propertyId,commandType:"MANAGE_MEMBERSHIP_CATALOG",expectedEffectHash:prepared.preview.effectHash,confirmation:true,reason:{code:"MEMBERSHIP_CATALOG_CHANGE",note:"合成失效房型"}},metadata());
    expect(receipt.businessCommitted).toBe(false);expect(await readMembershipCatalog(db,demo.propertyId)).toEqual(before);
  });

});

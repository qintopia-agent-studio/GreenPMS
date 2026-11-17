import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { createDatabase, type Database } from "@qintopia/db";
import { buildServer } from "../../apps/api/src/server.ts";
import { resetDatabase } from "../helpers/database.ts";
import { runtimeDatabaseUrlForTesting } from "../helpers/runtime-database.ts";
import { demo } from "../../packages/db/src/seed.ts";
const url="postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_membership_catalog_contract";
let owner:Kysely<Database>,db:Kysely<Database>,app:FastifyInstance,cookie:string;
describe("membership catalog HTTP boundary",()=>{
 beforeAll(async()=>{owner=await resetDatabase(url);db=createDatabase(runtimeDatabaseUrlForTesting(url));app=await buildServer(db);
  const login=await app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username:"admin",password:"demo-pass-2026"}});
  expect(login.statusCode,login.body).toBe(200);cookie=String(login.headers["set-cookie"]).split(";")[0]!;
 },120000);
 afterAll(async()=>{if(app)await app.close();if(db)await db.destroy();if(owner)await owner.destroy();});
 it("reads management and historical catalogs only for an authorized session",async()=>{
  for(const suffix of ["membership-catalog","membership-versions"]){
   const response=await app.inject({method:"GET",url:`/api/v1/properties/${demo.propertyId}/${suffix}`,headers:{cookie}});
   expect(response.statusCode,response.body).toBe(200);
   const denied=await app.inject({method:"GET",url:`/api/v1/properties/other/${suffix}`,headers:{cookie}});expect(denied.statusCode).toBe(403);
  }
 });
 it("publishes strict configurable product schemas",async()=>{
  const spec=app.swagger() as unknown as {paths:Record<string,unknown>};
  expect(spec.paths).toHaveProperty(`/api/v1/properties/{id}/membership-catalog`);
  const response=await app.inject({method:"POST",url:"/api/v1/command-previews",headers:{cookie,"idempotency-key":"catalog-invalid","x-correlation-id":"catalog-invalid"},payload:{commandType:"MANAGE_MEMBERSHIP_CATALOG",input:{propertyId:demo.propertyId,expectedRoomCatalogVersion:0,action:"CREATE",specification:{name:"非法",listPriceMinor:10000,entitlementUnits:20,validityPeriod:"P30D",allowedRoomTypeCodes:["private_bath_king"]}}}});
  expect(response.statusCode).toBe(400);
 });
 it("denies ordinary employees both management reads and preview writes",async()=>{
  const login=await app.inject({method:"POST",url:"/api/v1/auth/login",payload:{username:"operator",password:"demo-pass-2026"}});
  expect(login.statusCode).toBe(200);const staffCookie=String(login.headers["set-cookie"]).split(";")[0]!;
  const response=await app.inject({method:"GET",url:`/api/v1/properties/${demo.propertyId}/membership-catalog`,headers:{cookie:staffCookie}});expect(response.statusCode).toBe(403);
  const preview=await app.inject({method:"POST",url:"/api/v1/command-previews",headers:{cookie:staffCookie,"idempotency-key":"catalog-staff-denied","x-correlation-id":"catalog-staff-denied"},payload:{commandType:"MANAGE_MEMBERSHIP_CATALOG",input:{propertyId:demo.propertyId,expectedRoomCatalogVersion:0,action:"CREATE",specification:{name:"越权反例",listPriceMinor:180000,entitlementUnits:20,validityPeriod:"P6M",allowedRoomTypeCodes:["private_bath_king"]}}}});expect(preview.statusCode).toBe(403);
 });

 it("accepts all three action branches through HTTP without stripping fields",async()=>{
  const catalog=await app.inject({method:"GET",url:`/api/v1/properties/${demo.propertyId}/membership-catalog`,headers:{cookie}});
  const entry=catalog.json().entries[0];
  const specification={name:"HTTP半年20夜",listPriceMinor:180000,entitlementUnits:20,validityPeriod:"P6M",allowedRoomTypeCodes:["private_bath_king"]};
  for(const input of [{propertyId:demo.propertyId,expectedRoomCatalogVersion:0,action:"CREATE",specification},
    {propertyId:demo.propertyId,expectedRoomCatalogVersion:0,action:"UPDATE",code:entry.code,expectedRevision:entry.revision,specification},
    {propertyId:demo.propertyId,expectedRoomCatalogVersion:0,action:"SET_SALE_STATUS",code:entry.code,expectedRevision:entry.revision+1,saleStatus:"OFF_SALE"}]){
    const response=await app.inject({method:"POST",url:"/api/v1/command-previews",headers:{cookie,"idempotency-key":`http-${input.action}`,"x-correlation-id":`http-${input.action}`},payload:{commandType:"MANAGE_MEMBERSHIP_CATALOG",input}});
    expect(response.statusCode,response.body).toBe(200);const prepared=response.json().preview;
    const confirmed=await app.inject({method:"POST",url:`/api/v1/command-previews/${prepared.previewId}/confirm`,headers:{cookie,"idempotency-key":`http-confirm-${input.action}`,"x-correlation-id":`http-confirm-${input.action}`},payload:{propertyId:demo.propertyId,commandType:"MANAGE_MEMBERSHIP_CATALOG",expectedEffectHash:prepared.effectHash,confirmation:true,reason:{code:"MEMBERSHIP_CATALOG_CHANGE",note:"合成HTTP验收"}}});
    expect(confirmed.statusCode,confirmed.body).toBe(200);expect(confirmed.json().businessCommitted,confirmed.body).toBe(true);
  }
 });

});

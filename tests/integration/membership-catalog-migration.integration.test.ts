import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { createDatabase } from "@qintopia/db";
import { seedDemo, demo } from "../../packages/db/src/seed.ts";
import { addMembershipValidity } from "@qintopia/domain";
const url="postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_membership_catalog_migration_test";
const directory=resolve("packages/db/src/migrations");
async function baseline() {
  const admin=new pg.Client({connectionString:url.replace(/\/[^/]+$/,"/qintopia")});await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS qintopia_membership_catalog_migration_test');
  await admin.query('CREATE DATABASE qintopia_membership_catalog_migration_test');await admin.end();
  const client=new pg.Client({connectionString:url});await client.connect();
  for(const file of (await readdir(directory)).filter(f=>/^\d+.*\.sql$/.test(f)&&f<"083").sort())await client.query(await readFile(resolve(directory,file),"utf8"));
  return client;
}
async function migrate(client:pg.Client){await client.query("BEGIN");try{await client.query(await readFile(resolve(directory,"083_membership_product_catalog.sql"),"utf8"));await client.query("COMMIT");}catch(e){await client.query("ROLLBACK");throw e;}}
async function facts(client:pg.Client){const result:Record<string,unknown>={};for(const table of ["membership_products","membership_orders","member_contracts","entitlement_lots","membership_payment_facts","entitlement_ledger","audit_entries"]){result[table]=(await client.query(`SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) value FROM ${table} t`)).rows[0].value;}return result;}
describe.sequential("membership catalog migration",()=>{
 it("migrates an empty database then initializes only after seed creates the property",async()=>{
  const client=await baseline();try{const before=(await client.query("SELECT jsonb_agg(to_jsonb(p) ORDER BY id) value FROM membership_products p")).rows[0].value;
   await migrate(client);expect((await client.query("SELECT count(*)::int n FROM membership_product_catalog")).rows[0].n).toBe(0);
   const db=createDatabase(url);try{await seedDemo(db,{includeProtocolFixturePolicy:true});}finally{await db.destroy();}
   expect((await client.query("SELECT count(*)::int n FROM membership_product_catalog")).rows[0].n).toBe(4);
   expect((await client.query("SELECT jsonb_agg(to_jsonb(p) ORDER BY id) value FROM membership_products p")).rows[0].value).toEqual(before);
   await client.query("UPDATE membership_product_catalog SET sale_status='OFF_SALE',revision=revision+1 WHERE code='PRIVATE_BATH_SHARED_30'");
   await client.query("SELECT qintopia_initialize_membership_catalog($1)",[demo.propertyId]);
   expect((await client.query("SELECT sale_status FROM membership_product_catalog WHERE code='PRIVATE_BATH_SHARED_30'")).rows[0].sale_status).toBe("OFF_SALE");
  }finally{await client.end();}
 },120000);
 it("upgrades an existing property without changing any original business fact",async()=>{
  const client=await baseline();try{const db=createDatabase(url);try{await seedDemo(db,{includeProtocolFixturePolicy:true});}finally{await db.destroy();}
   const before=await facts(client);await migrate(client);const after=await facts(client);
   if(Array.isArray(after.membership_orders))after.membership_orders=after.membership_orders.map(({validity_period,...row})=>row);
   expect(after).toEqual(before);
  }finally{await client.end();}
 },120000);
 it("atomically rejects ambiguous ownership",async()=>{
  const client=await baseline();try{await client.query("INSERT INTO properties(id,code,name,timezone,currency) VALUES('a','A','a','Asia/Shanghai','CNY'),('b','B','b','Asia/Shanghai','CNY')");
   await expect(migrate(client)).rejects.toThrow("ambiguous property ownership");
   expect((await client.query("SELECT to_regclass('membership_product_catalog') value")).rows[0].value).toBeNull();
   expect((await client.query("SELECT count(*)::int n FROM membership_products")).rows[0].n).toBe(4);
  }finally{await client.end();}
 },120000);
 it("matches TypeScript calendar rules and rejects overflow",async()=>{
  const client=await baseline();try{await migrate(client);
   for(const [date,period] of [["2026-01-31","P1M"],["2026-01-31","P2M"],["2028-02-29","P1Y"],["2026-11-17","P6M"]]){
    expect((await client.query("SELECT qintopia_membership_valid_until($1::date,$2)::text value",[date,period])).rows[0].value).toBe(addMembershipValidity(date!,period!));
   }
   await expect(client.query("SELECT qintopia_membership_valid_until('9999-12-31','P1M')")).rejects.toThrow();
   for(const period of ["P0M","P1D","P1Y1M","P01Y","P2147483648M"])expect((await client.query("SELECT qintopia_membership_validity_valid($1) value",[period])).rows[0].value).toBe(false);
  }finally{await client.end();}
 },120000);
});

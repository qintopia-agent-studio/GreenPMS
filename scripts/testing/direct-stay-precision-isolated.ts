/**
 * 独立验证：node --import tsx scripts/testing/direct-stay-precision-isolated.ts [已提交 ref]
 * 只创建全新本地 cluster；不读取环境数据库配置、不调用 reset/seed。
 * 每次保留快照、迁移日志、检查日志及已停止的 cluster 于 .local-workspace/。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, appendFileSync, symlinkSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import pg from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";

async function main() {
// 只作用于本验证进程，显式启用既有分配功能以测试正式分笔匹配。
process.env.PMS_PAYMENT_ALLOCATION_ENABLED = "true";
const root = resolve(__dirname, "../..");
// 子进程环境使用允许清单，排除 PG*/DATABASE_URL、启动钩子和所有凭据配置。
const env = { PATH: process.env.PATH!, LANG: "C", LC_ALL: "C", TZ: "Asia/Shanghai", PGPASSFILE: "/dev/null", PGSERVICEFILE: "/dev/null" };
function run(bin: string, args: string[], options: { cwd?: string; input?: Buffer | string } = {}) {
  const result = spawnSync(bin, args, { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${bin} ${args.join(" ")}\n${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
const revision = run("git", ["rev-parse", "--verify", `${process.argv[2] ?? "b0ff5c3e2dd865fd15708a8d4b4b1e62990bf05b"}^{commit}`], { cwd: root }).trim();
run("git", ["check-ignore", ".local-workspace/direct-stay-precision-validation"], { cwd: root });
const base = join(root, ".local-workspace/direct-stay-precision-validation");
mkdirSync(base, { recursive: true });
const work = mkdtempSync(join(base, "run-"));
writeFileSync(join(work,"script.ts"),readFileSync(__filename));
const log = (text: string) => { console.log(text); appendFileSync(join(work, "checks.log"), `${text}\n`); };
const snapshot = join(work, "source");
mkdirSync(snapshot);
const archive = spawnSync("git", ["archive", revision, "packages", "scripts/operations/initialize-operating-sales.ts", "package.json", "tsconfig.json", "tsconfig.base.json"], { cwd: root, env, maxBuffer: 64 * 1024 * 1024 });
assert.equal(archive.status, 0);
run("tar", ["-xf", "-", "-C", snapshot], { input: archive.stdout });
mkdirSync(join(snapshot, "node_modules"));
for (const name of readdirSync(join(root, "node_modules"))) {
  if (name !== "@qintopia") symlinkSync(join(root, "node_modules", name), join(snapshot, "node_modules", name));
}
mkdirSync(join(snapshot, "node_modules/@qintopia"));
for (const name of readdirSync(join(snapshot, "packages"))) {
  const manifest = JSON.parse(readFileSync(join(snapshot, "packages", name, "package.json"), "utf8"));
  symlinkSync(join(snapshot, "packages", name), join(snapshot, "node_modules", manifest.name));
}
const server = createServer();
await new Promise<void>((res, rej) => { server.once("error", rej); server.listen(0, "127.0.0.1", res); });
const port = (server.address() as { port: number }).port;
await new Promise<void>((res, rej) => server.close(error => error ? rej(error) : res()));
const pgBinArgument = process.argv.indexOf("--pg-bin");
const bin = pgBinArgument >= 0 ? resolve(process.argv[pgBinArgument + 1] ?? "") : dirname(run("which", ["initdb"]).trim());
if(pgBinArgument >= 0) assert.ok(process.argv[pgBinArgument + 1], "--pg-bin 必须指定目录");
for (const name of ["initdb", "postgres", "pg_ctl", "psql"]) assert.ok(existsSync(join(bin, name)), `缺少 ${name}`);
const data = join(work, "cluster");
writeFileSync(join(work, "initdb.log"), run(join(bin, "initdb"), ["-D", data, "-U", "isolated_owner", "-A", "trust", "--no-locale", "--encoding=UTF8"]));
// 禁用 Unix socket，仅监听随机本机端口；启动竞争时失败，不改连任何服务。
appendFileSync(join(data, "postgresql.conf"), `\nlisten_addresses = '127.0.0.1'\nport = ${port}\nunix_socket_directories = ''\n`);
const config = { host: "127.0.0.1", port, user: "isolated_owner", password: "isolated-synthetic-only", ssl: false, database: "direct_stay_precision_isolated", connectionTimeoutMillis: 5000, statement_timeout: 15000 };
let client: pg.Client | undefined;
let db: Kysely<any> | undefined;
let runtimeDb: Kysely<any> | undefined;
let started = false;
const interrupt = (signal: string) => {
  try {
    if (started || existsSync(join(data,"postmaster.pid"))) writeFileSync(join(work,"stop.log"),run(join(bin,"pg_ctl"),["-D",data,"-m","fast","-w","stop"]));
    log(`中断 ${signal}；临时服务已停止；验证未完成`);
  } finally { process.exit(signal === "SIGINT" ? 130 : 143); }
};
process.once("SIGINT",interrupt);
process.once("SIGTERM",interrupt);
let before073:any[]=[];
let passed = 0;
let failed = 0;
const missing: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; log(`PASS ${name}`); }
  catch (error) { failed++; log(`FAIL ${name}\n${error instanceof Error ? error.stack : String(error)}`); }
}
try {
  log(`基线 ${revision}\n目录 ${work}\nPostgreSQL ${run(join(bin, "postgres"), ["--version"]).trim()}\n端口 ${port}`);
  run(join(bin, "pg_ctl"), ["-D", data, "-l", join(work, "postgres.log"), "-w", "start"]);
  started = true;
  const admin = new pg.Client({ ...config, database: "postgres" });
  await admin.connect();
  try {
    assert.equal((await admin.query("SHOW data_directory")).rows[0].data_directory, data);
    await admin.query('CREATE DATABASE direct_stay_precision_isolated');
  } finally { await admin.end(); }
  client = new pg.Client(config);
  await client.connect();
  pg.types.setTypeParser(1082, value => value);
  const migrations = join(snapshot, "packages/db/src/migrations");
  const names = readdirSync(migrations).filter(name => /^\d+.*\.sql$/.test(name)).sort();
  assert.equal(names.length,72,"指定快照应有72个迁移");
  assert.ok(names.includes("073_direct_stay_amount_precision.sql"));
  for (const name of names) {
    if(name==='073_direct_stay_amount_precision.sql')before073=(await client.query("SELECT proname,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE proname IN ('qintopia_validate_stage9_pricing_revision','qintopia_validate_stage10_pricing_revision','qintopia_validate_stage11_move_revision') ORDER BY proname")).rows;
    const output = run(join(bin, "psql"), ["-X", "-w", "-h", config.host, "-p", String(port), "-U", config.user, "-d", config.database, "-v", "ON_ERROR_STOP=1", "-1", "-f", join(migrations, name)]);
    appendFileSync(join(work, "migrations.log"), `\n${name}\n${output}`);
    await client.query("INSERT INTO schema_migrations(name) VALUES($1) ON CONFLICT DO NOTHING", [name]);
  }
  log(`PASS 全新数据库应用 ${names.length} 个已提交迁移（含073）`);
  db = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool(config) }) });
  await verify(client, db);
} catch (error) {
  failed++;
  log(`FAIL 执行中断\n${error instanceof Error ? error.stack : String(error)}`);
} finally {
  if (runtimeDb) await runtimeDb.destroy();
  if (db) await db.destroy();
  if (client) await client.end();
  if (started || existsSync(join(data, "postmaster.pid"))) {
    writeFileSync(join(work, "stop.log"), run(join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"]));
  }
  assert.ok(!existsSync(join(data, "postmaster.pid")), "临时服务必须已停止");
  log(`临时 PostgreSQL 已停止；通过 ${passed}，失败 ${failed}；未覆盖：${missing.join("；") || "见检查项范围"}`);
  writeFileSync(join(work, "result.json"), JSON.stringify({ revision, port, work, passed, failed, missing, stopped: true }, null, 2));
}
process.exitCode = failed ? 1 : 0;

async function verify(client:pg.Client,db:Kysely<any>){
 const moduleAt=(name:string)=>import(pathToFileURL(join(snapshot,'packages/db/src',name)).href);
 const propertyId='prop_qintopia_demo';
 await client.query(`INSERT INTO properties(id,code,name,timezone,currency) VALUES('prop_qintopia_demo','DIRECT-ISO','合成直订精度门店','Asia/Shanghai','CNY');
  INSERT INTO subjects(id,username,display_name,password_salt,password_hash,status) VALUES
   ('subject_demo_operator','iso-direct-operator','合成操作员','synthetic','not-login','ACTIVE'),
   ('subject_demo_agent','iso-direct-agent','合成代理','synthetic','not-login','ACTIVE'),
   ('subject_demo_administrator','iso-direct-admin','合成管理员','synthetic','not-login','ACTIVE');
  INSERT INTO subject_property_grants(subject_id,property_id,access_level) SELECT id,'prop_qintopia_demo','WRITE' FROM subjects;
  INSERT INTO web_sessions(id,subject_id,secret_hash,expires_at) VALUES('direct-session','subject_demo_administrator',repeat('f',64),now()+interval '1 hour');
  INSERT INTO pricing_policy_versions(id,property_id,code,version,stay_type,calculation_kind,nightly_rate_minor,currency) VALUES
   ('direct-policy','prop_qintopia_demo','DIRECT-FLAT',1,'TRANSIENT','FLAT_NIGHTLY',30000,'CNY'),
   ('direct-free','prop_qintopia_demo','DIRECT-FREE',1,'FREE','FREE',0,'CNY');
  INSERT INTO external_payment_sources(id,corp_id,enabled,matching_since,import_since,baseline_complete) VALUES('direct-source','direct-corp',true,'2026-01-01','2026-01-01',true);
  INSERT INTO external_payment_accounts(source_id,merchant_id,property_id) VALUES('direct-source','direct-merchant','prop_qintopia_demo');
  INSERT INTO external_payment_bills(id,source_id,merchant_id,property_id,kind,reference,original_trade_no,amount_minor,occurred_at,state) VALUES('direct-bill-38750','direct-source','direct-merchant','prop_qintopia_demo','COLLECTION','DIRECT-38750','DIRECT-38750',38750,now()-interval '1 day','SUCCESS');`);
 const {reconcileStaffProfileManifest}=await moduleAt('staff-profile-manifest.ts');await reconcileStaffProfileManifest(db,'demo');
 runtimeDb=new Kysely({dialect:new PostgresDialect({pool:new pg.Pool({...config,user:'qintopia_runtime'})})});
 const {databaseReady}=await moduleAt('database.ts');
 const evidence=(name:string,value:unknown)=>writeFileSync(join(work,`${name}.json`),JSON.stringify(value,null,2));
 const readinessResults:unknown[]=[];
 const diagnosticDb=runtimeDb.withPlugin({transformQuery(args:any){return args.node;},async transformResult(args:any){readinessResults.push(args.result.rows);return args.result;}});
 await check('直接qintopia_runtime完整databaseReady返回true（demo合成权限清单）',async()=>{
   const ready=await databaseReady(diagnosticDb,{staffProfileManifestName:'demo'});evidence('runtime-readiness',{ready,rows:readinessResults});assert.equal(ready,true);
 });
 await check('073只扩普通WECOM分精度，其他三函数守卫保留',async()=>{
   const after=(await client.query("SELECT proname,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE proname IN ('qintopia_validate_stage9_pricing_revision','qintopia_validate_stage10_pricing_revision','qintopia_validate_stage11_move_revision') ORDER BY proname")).rows;
   evidence('073-functions',{before:before073,after});assert.equal(after.length,3);
   const normalize=(text:string)=>text.replace(/\n\s+AND NOT \([^\n]+IS NULL\)/g,'').replaceAll('member amounts retain whole yuan','non-channel amounts require whole yuan');
   assert.deepEqual(after.map(r=>[r.proname,normalize(r.definition)]),before073.map(r=>[r.proname,r.definition]));
 });
 const {createCommandPreview,confirmCommandPreview,executeQuoteCommand}=await moduleAt('commands/service.ts');const {getOrderView}=await moduleAt('orders.ts');
 const grants=new Set((await client.query("SELECT command_type FROM subject_command_grants WHERE subject_id='subject_demo_administrator' AND property_id=$1",[propertyId])).rows.map(r=>r.command_type));
 const principal={subjectId:'subject_demo_administrator',credentialId:'direct-session',credentialType:'SESSION',displayName:'合成管理员',propertyAccess:new Map([[propertyId,'WRITE']]),propertyCommandGrants:new Map([[propertyId,grants]]),tokenCommandCeiling:null};
 let sequence=0;const metadata=()=>({idempotencyKey:`direct-${++sequence}`,correlationId:`direct-${sequence}`});
 const today=(await client.query("SELECT qintopia_stage10_property_today($1)::text AS date",[propertyId])).rows[0].date;
 const day=(offset:number)=>new Date(Date.parse(today+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
 async function command(commandType:string,input:Record<string,unknown>){
   const preview=await createCommandPreview(runtimeDb!,principal,{commandType,input:{propertyId,...input}},metadata());
   const reason=commandType==='CREATE_ORDER'?(input.backfill?{code:'BACKFILL_STAY',note:String(input.backfillReason)}:{code:'CREATE_STANDARD_ORDER',note:''}):{code:'AUTOMATED_ACCEPTANCE',note:'合成直订角分验证'};
   const body={propertyId,commandType,confirmation:true,expectedEffectHash:preview.preview.effectHash,reason};const meta=metadata();
   const receipt=await confirmCommandPreview(runtimeDb!,principal,preview.preview.previewId,body,meta);assert.equal(receipt.businessCommitted,true,JSON.stringify(receipt));
   return {preview,receipt,repeat:()=>confirmCommandPreview(runtimeDb!,principal,preview.preview.previewId,body,meta)};
 }
 async function unit(roomType?:string){const id=`direct-room-${++sequence}`;await db.insertInto('inventory_units').values({id,property_id:propertyId,kind:'ROOM',code:id,name:'合成直订测试房',...(roomType?{room_type_code:roomType}:{})}).execute();return id;}
 async function prepare(options:{amount?:number;arrival?:string;departure?:string;free?:boolean;memberId?:string;collection?:Record<string,unknown>;phone?:string}={}){
   const arrival=options.arrival??today,departure=options.departure??day(1);const inventoryUnitId=await unit(options.memberId?'shared_bath_single':undefined);
   const quoted=await executeQuoteCommand(runtimeDb!,principal,{propertyId,inventoryUnitId,arrivalDate:arrival,departureDate:departure,pricingPolicyVersionId:options.free?'direct-free':'direct-policy',...(options.free?{stayType:'FREE'}:{}),...(options.memberId?{memberId:options.memberId}:{})},metadata());
   assert.equal(quoted.receipt.businessCommitted,true);assert.ok(quoted.quote.quoteId);
   const amount=options.amount??38750;const backfill=arrival<today;
   const input:Record<string,unknown>={quoteId:quoted.quote.quoteId,primaryGuest:{fullName:'合成直订客人',nickname:'合成直订客人',...(options.phone?{phone:options.phone}:{})},
     ...(backfill?{backfill:true,backfillReason:'根据合成凭据补录历史住宿'}:{}),
     ...(options.free?{freeStayReason:'合成义工入住',freeStayCategoryCode:'VOLUNTEER'}:options.memberId?{}:{bookingChannelCode:'WECOM',channelOrderReference:null,targetCurrentContractAmountMinor:amount,...(amount!==quoted.quote.currentContractAmount.minorUnits?{manualPriceAdjustmentReason:'根据合成凭据确认手工本单金额'}:{})}),
     ...(options.collection?{backfillCollection:options.collection}:{})};
   return {input,quoted,inventoryUnitId};
 }
 async function view(orderId:string){return getOrderView(runtimeDb!,orderId,'WRITE',grants);}
 async function business(){const result:Record<string,unknown>={};for(const table of ['orders','stays','amendments','pricing_revisions','collection_facts','inventory_claims','inventory_room_days','coverage_items','entitlement_ledger','membership_orders','membership_payment_facts'])result[table]=(await client.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS rows FROM ${table} t`)).rows[0].rows;return result;}
 async function rejectUnchanged(type:string,input:Record<string,unknown>,message?:RegExp){const before=await business();await assert.rejects(command(type,input),(error:any)=>{assert.equal(error.code,'VALIDATION_ERROR');if(message)assert.match(error.message,message);return true;});assert.deepEqual(await business(),before);}
 function exact(view:any,amount:number){assert.equal(view.order.current_contract_amount_minor,amount);const last=view.pricingRevisions.at(-1);assert.equal(last.current_contract_amount_minor,amount);assert.equal(last.policy_base_amount_minor%100,0);assert.equal(last.manual_adjustment_minor,amount-last.policy_base_amount_minor);}
 await check('已完成正式历史补录WECOM 38750+成功企微38750：Preview/Confirm/匹配/读回/幂等',async()=>{
   const prepared=await prepare({arrival:day(-3),departure:day(-1),collection:{amountMinor:38750,method:'WECOM',transactionReference:'DIRECT-38750',note:'合成成功企微收款'}});
   const r=await command('CREATE_ORDER',prepared.input);const orderId=r.receipt.result.orderId;const dto=await view(orderId);exact(dto,38750);assert.equal(dto.order.status,'CHECKED_OUT');assert.equal(dto.stay.status,'COMPLETED');
   assert.equal(dto.collectionFacts.length,1);assert.equal(dto.collectionFacts[0].amount_minor,38750);assert.equal(dto.amounts.netRecordedCollection.minorUnits,38750);assert.equal(dto.amounts.collectionDifference.minorUnits,0);
   const match=(await client.query("SELECT * FROM external_payment_matches WHERE bill_id='direct-bill-38750'")).rows[0];assert.equal(match.collection_fact_id,dto.collectionFacts[0].fact_id);
   const before=await business();assert.equal((await r.repeat()).commandId,r.receipt.commandId);assert.deepEqual(await business(),before);
   evidence('completed-backfill',{preview:r.preview,receipt:r.receipt,match});evidence('completed-backfill-order-view',dto);
 });
 await check('跨今日在住正式补录WECOM 38750+成功企微38750匹配读回',async()=>{
   await client.query(`INSERT INTO external_payment_bills(id,source_id,merchant_id,property_id,kind,reference,original_trade_no,amount_minor,occurred_at,state) VALUES('direct-bill-inhouse','direct-source','direct-merchant','prop_qintopia_demo','COLLECTION','DIRECT-INHOUSE','DIRECT-INHOUSE',38750,now()-interval '1 day','SUCCESS')`);
   const p=await prepare({arrival:day(-1),departure:day(2),collection:{amountMinor:38750,method:'WECOM',transactionReference:'DIRECT-INHOUSE',note:'合成在住收款'}});
   const r=await command('CREATE_ORDER',p.input);const dto=await view(r.receipt.result.orderId);exact(dto,38750);assert.equal(dto.order.status,'CHECKED_IN');assert.equal(dto.stay.status,'IN_HOUSE');assert.equal(dto.collectionFacts[0].amount_minor,38750);
   const matched=(await client.query("SELECT * FROM external_payment_matches WHERE bill_id='direct-bill-inhouse'")).rows[0];assert.equal(matched.collection_fact_id,dto.collectionFacts[0].fact_id);evidence('inhouse-backfill-order-view',dto);
 });
 let reserved:string|undefined,inhouse:string|undefined;
 await check('普通WECOM新建38750，政策基价整元、手工差额保留分',async()=>{const p=await prepare();const r=await command('CREATE_ORDER',p.input);reserved=r.receipt.result.orderId;const dto=await view(reserved!);exact(dto,38750);assert.equal(dto.order.status,'RESERVED');assert.equal(dto.pricingRevisions[0].policy_base_amount_minor,30000);assert.equal(dto.pricingRevisions[0].manual_adjustment_minor,8750);});
 await check('普通WECOM REPRICE保留38851分与原修订',async()=>{assert.ok(reserved);const before=await view(reserved);await command('REPRICE_ORDER',{orderId:reserved,targetCurrentContractAmountMinor:38851});const after=await view(reserved);exact(after,38851);assert.deepEqual(after.pricingRevisions.slice(0,-1),before.pricingRevisions);});
 await check('普通WECOM改期保留38752分并读回',async()=>{assert.ok(reserved);await command('RESCHEDULE_STAY',{orderId:reserved,newArrivalDate:day(1),newDepartureDate:day(2),targetCurrentContractAmountMinor:38752,manualPriceAdjustmentReason:'合成改期手工差额'});exact(await view(reserved),38752);});
 await check('普通WECOM换房保留38753分并读回',async()=>{assert.ok(reserved);await command('MOVE_UNIT',{orderId:reserved,newInventoryUnitId:await unit(),effectiveDate:day(1),targetCurrentContractAmountMinor:38753,manualPriceAdjustmentReason:'合成换房手工差额'});exact(await view(reserved),38753);});
 await check('普通WECOM续住保留38754分并读回',async()=>{const p=await prepare({arrival:day(-2),departure:day(2)});inhouse=(await command('CREATE_ORDER',p.input)).receipt.result.orderId;await command('EXTEND_STAY',{orderId:inhouse,newDepartureDate:day(4),targetCurrentContractAmountMinor:38754,manualPriceAdjustmentReason:'合成续住手工差额'});exact(await view(inhouse!),38754);});
 await check('普通WECOM缩短保留38755分并读回',async()=>{assert.ok(inhouse);await command('SHORTEN_STAY',{orderId:inhouse,newDepartureDate:day(1),targetCurrentContractAmountMinor:38755,manualPriceAdjustmentReason:'合成缩短手工差额'});exact(await view(inhouse),38755);});
 await check('补录实收超过38750本单拒绝且零业务写入',async()=>{const p=await prepare({arrival:day(-3),departure:day(-1),collection:{amountMinor:38751,method:'WECOM',transactionReference:'DIRECT-38750',note:'不得超收'}});await rejectUnchanged('CREATE_ORDER',p.input,/不能超过/);});
 await check('普通WECOM负数/越界/非整数分新建及REPRICE拒绝',async()=>{
   for(const amount of [-1,2147483601,38750.5]){const p=await prepare();await rejectUnchanged('CREATE_ORDER',{...p.input,targetCurrentContractAmountMinor:amount});assert.ok(reserved);await rejectUnchanged('REPRICE_ORDER',{orderId:reserved,targetCurrentContractAmountMinor:amount});}
 });
 await check('普通WECOM手工价格变更仍要求原因',async()=>{const p=await prepare();delete p.input.manualPriceAdjustmentReason;await rejectUnchanged('CREATE_ORDER',p.input,/manualPriceAdjustmentReason/);});
 await check('免费住宿0价保持；非零新建和REPRICE拒绝',async()=>{const p=await prepare({free:true});await rejectUnchanged('CREATE_ORDER',{...p.input,targetCurrentContractAmountMinor:1});const r=await command('CREATE_ORDER',p.input);const id=r.receipt.result.orderId;assert.equal((await view(id)).order.current_contract_amount_minor,0);await rejectUnchanged('REPRICE_ORDER',{orderId:id,targetCurrentContractAmountMinor:100});});
 let memberId:string|undefined;
 await check('会员卡38750分约定价仍拒绝；合法会员住宿不得角分REPRICE',async()=>{
   memberId=(await command('CREATE_MEMBER',{fullName:'合成精度会员',nickname:'合成精度会员',phone:'13900000006',wechat:'direct-test-member'})).receipt.result.memberId;
   await rejectUnchanged('CREATE_MEMBERSHIP_ORDER',{memberId,membershipProductId:'membership_product_shared_bath_single_v1',agreedPriceMinor:38750,priceAdjustmentReason:'不得放宽会员卡整元'});
   const membership=(await command('CREATE_MEMBERSHIP_ORDER',{memberId,membershipProductId:'membership_product_shared_bath_single_v1',agreedPriceMinor:162000})).receipt.result.membershipOrderId;
   await client.query(`INSERT INTO external_payment_bills(id,source_id,merchant_id,property_id,kind,reference,original_trade_no,amount_minor,occurred_at,state) VALUES('direct-member-bill','direct-source','direct-merchant','prop_qintopia_demo','COLLECTION','DIRECT-MEMBER','DIRECT-MEMBER',162000,now(),'SUCCESS')`);
   await command('RECORD_MEMBERSHIP_PAYMENT',{membershipOrderId:membership,amountMinor:162000,transactionReference:'DIRECT-MEMBER',note:'合成完整售卡'});await command('ACTIVATE_MEMBERSHIP_ORDER',{membershipOrderId:membership});
   const p=await prepare({memberId:memberId!});await rejectUnchanged('CREATE_ORDER',{...p.input,bookingChannelCode:'WECOM',targetCurrentContractAmountMinor:38750});
   const r=await command('CREATE_ORDER',p.input);const id=r.receipt.result.orderId;assert.equal((await view(id)).order.member_id,memberId);
   await rejectUnchanged('REPRICE_ORDER',{orderId:id,targetCurrentContractAmountMinor:38750,bookingChannelCode:'WECOM'});evidence('member-order-view',await view(id));
 });
 await check('执行后runtime完整databaseReady仍为true',async()=>assert.equal(await databaseReady(runtimeDb!,{staffProfileManifestName:'demo'}),true));
 missing.push('未验证前端金额输入/HTTP或生产数据；历史会员已存WECOM组合未通过伪造事实构建，本轮验证合法会员与客户端WECOM标记不能绕过规则');

}
}
main().catch(error=>{console.error(error);process.exitCode=1;});

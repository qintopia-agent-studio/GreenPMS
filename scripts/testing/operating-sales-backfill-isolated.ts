/**
 * 独立验证：node --import tsx scripts/testing/operating-sales-backfill-isolated.ts [已提交 ref]
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
const revision = run("git", ["rev-parse", "--verify", `${process.argv[2] ?? "c5efd219d5fde8f52689dfc3e72eeabedc0f5be4"}^{commit}`], { cwd: root }).trim();
run("git", ["check-ignore", ".local-workspace/operating-sales-backfill-validation"], { cwd: root });
const base = join(root, ".local-workspace/operating-sales-backfill-validation");
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
const bin = dirname(run("which", ["initdb"]).trim());
for (const name of ["initdb", "postgres", "pg_ctl", "psql"]) assert.ok(existsSync(join(bin, name)), `缺少 ${name}`);
const data = join(work, "cluster");
writeFileSync(join(work, "initdb.log"), run(join(bin, "initdb"), ["-D", data, "-U", "isolated_owner", "-A", "trust", "--no-locale", "--encoding=UTF8"]));
// 禁用 Unix socket，仅监听随机本机端口；启动竞争时失败，不改连任何服务。
appendFileSync(join(data, "postgresql.conf"), `\nlisten_addresses = '127.0.0.1'\nport = ${port}\nunix_socket_directories = ''\n`);
const config = { host: "127.0.0.1", port, user: "isolated_owner", password: "isolated-synthetic-only", ssl: false, database: "operating_sales_isolated", connectionTimeoutMillis: 5000, statement_timeout: 15000 };
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
let passed = 0;
let failed = 0;
const missing: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; log(`PASS ${name}`); }
  catch (error) { failed++; log(`FAIL ${name}\n${error instanceof Error ? error.stack : String(error)}`); }
}
const legacyRevision='553b0eb3a3dbb77babab6db168b73cbd1bda1997';
const initializerRevision='0bd45f5502299fcedd244d5d9fc107057fff21a6';
let fixture:any;
let seq=0;const meta=()=>({idempotencyKey:`hist-${++seq}`,correlationId:`hist-${seq}`});
const propertyIds=['hist-property','member-cutover-property','rematch-fact-property','rematch-bill-property'];
try {
  log(`基线 ${revision}\n目录 ${work}\nPostgreSQL ${run(join(bin, "postgres"), ["--version"]).trim()}\n端口 ${port}`);
  run(join(bin, "pg_ctl"), ["-D", data, "-l", join(work, "postgres.log"), "-w", "start"]);
  started = true;
  const admin = new pg.Client({ ...config, database: "postgres" });
  await admin.connect();
  try {
    assert.equal((await admin.query("SHOW data_directory")).rows[0].data_directory, data);
    await admin.query('CREATE DATABASE operating_sales_isolated');
  } finally { await admin.end(); }
  client = new pg.Client(config);
  await client.connect();
  pg.types.setTypeParser(1082, value => value);
  const migrations = join(snapshot, "packages/db/src/migrations");
  const names = readdirSync(migrations).filter(name => /^\d+.*\.sql$/.test(name)).sort();
  assert.equal(names.length,71,"指定快照应有71个迁移");
  assert.ok(names.includes("072_channel_operating_facts.sql"));
  for (const name of names) {
    if(name === "072_channel_operating_facts.sql") await seedLegacy(client);
    const output = run(join(bin, "psql"), ["-X", "-w", "-h", config.host, "-p", String(port), "-U", config.user, "-d", config.database, "-v", "ON_ERROR_STOP=1", "-1", "-f", join(migrations, name)]);
    appendFileSync(join(work, "migrations.log"), `\n${name}\n${output}`);
    await client.query("INSERT INTO schema_migrations(name) VALUES($1) ON CONFLICT DO NOTHING", [name]);
  }
  log(`PASS 全新数据库应用 ${names.length} 个已提交迁移（含072）`);
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




function evidence(name:string,value:unknown){writeFileSync(join(work,`${name}.json`),JSON.stringify(value,null,2));}
async function fixtureClock(client:pg.Client,at:string|null){
  if(at)assert.match(at,/^2026-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  for(const table of ['pricing_revisions','amendments','orders','stays','membership_payment_facts','collection_facts']){
    const expression=at?`'${at}'::timestamptz`:'now()';
    await client.query(`ALTER TABLE ${table} ALTER COLUMN created_at SET DEFAULT ${expression}`);
  }
  appendFileSync(join(work,'fixture-clock.log'),`${at??'restored now()'}\n`);
}
function attachDependencies(dir:string){
 mkdirSync(join(dir,'node_modules'));for(const name of readdirSync(join(root,'node_modules')))if(name!=='@qintopia')symlinkSync(join(root,'node_modules',name),join(dir,'node_modules',name));
 mkdirSync(join(dir,'node_modules/@qintopia'));
 for(const name of readdirSync(join(dir,'packages'))){const manifest=JSON.parse(readFileSync(join(dir,'packages',name,'package.json'),'utf8'));symlinkSync(join(dir,'packages',name),join(dir,'node_modules',manifest.name));}
}
function actor(){const commands=new Set(['CREATE_ORDER','CHECK_IN','CHECK_OUT','MOVE_UNIT','REPRICE_ORDER','CANCEL_ORDER','CREATE_MEMBER','CREATE_MEMBERSHIP_ORDER','RECORD_MEMBERSHIP_PAYMENT','CORRECT_MEMBERSHIP_PAYMENT','RECORD_REFUND','RECORD_COLLECTION','REVERSE_FACT']);
 return {subjectId:'hist-user',credentialId:'hist-session',credentialType:'SESSION',displayName:'合成升级前操作人',propertyAccess:new Map(propertyIds.map(id=>[id,'WRITE'])),propertyCommandGrants:new Map(propertyIds.map(id=>[id,commands])),tokenCommandCeiling:null};}

function commandFactory(db:Kysely<any>,service:any){return async(type:string,input:Record<string,unknown>)=>{
 const propertyId=String(input.propertyId??'hist-property');const p=actor();const preview=await service.createCommandPreview(db,p,{commandType:type,input:{...input,propertyId}},meta());
 const receipt=await service.confirmCommandPreview(db,p,preview.preview.previewId,{propertyId,commandType:type,confirmation:true,expectedEffectHash:preview.preview.effectHash,reason:type==='CREATE_ORDER'?{code:'CREATE_STANDARD_ORDER',note:''}:{code:'AUTOMATED_ACCEPTANCE',note:'独立历史升级验证'}},meta());
 assert.equal(receipt.businessCommitted,true,JSON.stringify(receipt));return receipt;
};}
async function seedLegacy(client:pg.Client){
 const legacy=join(work,'legacy-source');mkdirSync(legacy);
 const archive=spawnSync('git',['archive',legacyRevision,'packages','package.json','tsconfig.json','tsconfig.base.json'],{cwd:root,env,maxBuffer:64*1024*1024});assert.equal(archive.status,0);
 run('tar',['-xf','-','-C',legacy],{input:archive.stdout});attachDependencies(legacy);
 const moduleAt=(path:string)=>import(pathToFileURL(join(legacy,'packages/db/src',path)).href);
 const service=await moduleAt('commands/service.ts');const {createQuoteForTesting}=await moduleAt('pricing-service.ts');const {withPropertyClockForTesting}=await moduleAt('members.ts');
 const oldDb=new Kysely<any>({dialect:new PostgresDialect({pool:new pg.Pool(config)})});
 const command=commandFactory(oldDb,service);
 try{
  assert.equal((await client.query("SELECT to_regclass('channel_operating_facts') AS table_name")).rows[0].table_name,null);
  await client.query(`INSERT INTO properties(id,code,name,timezone,currency) VALUES('hist-property','HIST','合成历史渠道门店','Asia/Shanghai','CNY'),('member-cutover-property','MEMBER-HIST','合成会员切换门店','Asia/Shanghai','CNY');
   INSERT INTO inventory_units(id,property_id,kind,code,name) VALUES('hist-room-a','hist-property','ROOM','HIST-A','合成历史A'),('hist-room-b','hist-property','ROOM','HIST-B','合成历史B'),('hist-room-c','hist-property','ROOM','HIST-C','合成历史C');
   INSERT INTO pricing_policy_versions(id,property_id,code,version,stay_type,calculation_kind,nightly_rate_minor,currency) VALUES('hist-policy','hist-property','HIST-FLAT',1,'TRANSIENT','FLAT_NIGHTLY',30000,'CNY');
   INSERT INTO subjects(id,username,display_name,password_salt,password_hash,status) VALUES('hist-user','historical-fixture','合成历史人员','synthetic','not-login','ACTIVE');
   INSERT INTO subject_property_grants(subject_id,property_id,access_level) VALUES('hist-user','hist-property','WRITE'),('hist-user','member-cutover-property','WRITE');
   INSERT INTO web_sessions(id,subject_id,secret_hash,expires_at) VALUES('hist-session','hist-user',repeat('e',64),now()+interval '1 hour');
   INSERT INTO subject_command_grants(subject_id,property_id,command_type) SELECT 'hist-user',p,cmd FROM unnest(ARRAY['hist-property','member-cutover-property']) p CROSS JOIN unnest(ARRAY['CREATE_ORDER','CHECK_IN','CHECK_OUT','MOVE_UNIT','REPRICE_ORDER','CANCEL_ORDER','CREATE_MEMBER','CREATE_MEMBERSHIP_ORDER','RECORD_MEMBERSHIP_PAYMENT','CORRECT_MEMBERSHIP_PAYMENT','RECORD_REFUND','RECORD_COLLECTION','REVERSE_FACT']) cmd;
   INSERT INTO external_payment_sources(id,corp_id,enabled,matching_since,import_since,baseline_complete) VALUES('hist-source','hist-corp',true,'2026-01-01','2026-01-01',true);
   INSERT INTO external_payment_accounts(source_id,merchant_id,property_id) VALUES('hist-source','hist-merchant','member-cutover-property');
   INSERT INTO external_payment_bills(id,source_id,merchant_id,property_id,kind,reference,original_trade_no,amount_minor,occurred_at,state) VALUES('hist-member-bill','hist-source','hist-merchant','member-cutover-property','COLLECTION','hist-member-bill','hist-member-bill',30000,'2026-09-20T04:00:00Z','SUCCESS'),('hist-member-before-bill','hist-source','hist-merchant','member-cutover-property','COLLECTION','hist-member-before-bill','hist-member-before-bill',30000,'2026-09-20T04:00:00Z','SUCCESS');`);
  const today=(await client.query("SELECT qintopia_stage10_property_today('hist-property')::text AS date")).rows[0].date;
  const next=new Date(Date.parse(today+'T00:00:00Z')+86400000).toISOString().slice(0,10);
  async function create(unit:string,amount:number){const q=await createQuoteForTesting(oldDb,{propertyId:'hist-property',inventoryUnitId:unit,arrivalDate:today,departureDate:next,pricingPolicyVersionId:'hist-policy'});return (await command('CREATE_ORDER',{quoteId:q.quoteId,primaryGuest:{fullName:'合成历史客人',nickname:'合成历史客人'},bookingChannelCode:'YOUMUDAO',channelOrderReference:`HIST-${unit}`,targetCurrentContractAmountMinor:amount})).result.orderId;}
  await fixtureClock(client,'2026-09-05T04:00:00Z');const orderA=await create('hist-room-a',27600);
  await fixtureClock(client,'2026-09-06T04:00:00Z');await command('MOVE_UNIT',{orderId:orderA,newInventoryUnitId:'hist-room-b',effectiveDate:today,targetCurrentContractAmountMinor:27600});
  await fixtureClock(client,'2026-09-07T04:00:00Z');await command('REPRICE_ORDER',{orderId:orderA,targetCurrentContractAmountMinor:27700});
  await fixtureClock(client,null);await command('CHECK_IN',{orderId:orderA});await withPropertyClockForTesting(new Date(next+'T04:00:00Z'),()=>command('CHECK_OUT',{orderId:orderA}));
  await fixtureClock(client,'2026-09-10T04:00:00Z');const orderB=await create('hist-room-c',30000);
  await fixtureClock(client,'2026-09-11T04:00:00Z');await command('CANCEL_ORDER',{orderId:orderB});
  await fixtureClock(client,'2026-09-20T04:00:00Z');
  const member=(await command('CREATE_MEMBER',{propertyId:'member-cutover-property',fullName:'合成九月会员',nickname:'合成九月会员',phone:'13900000008',wechat:'hist-member'})).result.memberId;
  const members=[];
  for(const reference of ['hist-member-bill','hist-member-before-bill']){
   const membership=(await command('CREATE_MEMBERSHIP_ORDER',{propertyId:'member-cutover-property',memberId:member,membershipProductId:'membership_product_shared_bath_single_v1',agreedPriceMinor:30000,priceAdjustmentReason:'合成九月会员价'})).result.membershipOrderId;
   const payment=(await command('RECORD_MEMBERSHIP_PAYMENT',{propertyId:'member-cutover-property',membershipOrderId:membership,amountMinor:30000,transactionReference:reference,note:'九月M0合成匹配'})).result.paymentFactId;
   members.push({membership,payment,reference});
  }
  fixture={legacyRevision,revision,initializerRevision,orderA,orderB,today,members};evidence('legacy-fixture',fixture);
  evidence('before-072-revisions',(await client.query("SELECT p.*,a.amendment_type FROM pricing_revisions p JOIN amendments a ON a.id=p.amendment_id ORDER BY p.order_id,p.revision_no")).rows);
  passed++;log('PASS 071阶段旧正式命令完成建单/同价换房/更正/取消/入住退房与九月会员M0');
 }finally{await fixtureClock(client,null);await oldDb.destroy();}
}
async function verify(client:pg.Client,db:Kysely<any>){
 const moduleAt=(path:string)=>import(pathToFileURL(join(snapshot,'packages/db/src',path)).href);
 const service=await moduleAt('commands/service.ts');const {operatingSalesReady}=await moduleAt('operating-sales-readiness.ts');const {getOrderView}=await moduleAt('orders.ts');const {loadOperatingSales}=await moduleAt('operating-sales.ts');
 await client.query('CREATE ROLE hist_runtime LOGIN INHERIT');await client.query('GRANT qintopia_runtime TO hist_runtime');runtimeDb=new Kysely({dialect:new PostgresDialect({pool:new pg.Pool({...config,user:'hist_runtime'})})});
 const command=commandFactory(runtimeDb,service);
 const channelFacts=async()=>(await client.query('SELECT * FROM channel_operating_facts ORDER BY order_id,created_at,id')).rows;
 await check('真实072历史回填：原sale/同价无新增/纠错原日期/取消不退款',async()=>{
  const rows=await channelFacts();evidence('after-072-facts',rows);assert.equal(rows.length,3);
  const a=rows.filter(r=>r.order_id===fixture.orderA),b=rows.filter(r=>r.order_id===fixture.orderB);assert.equal(a.length,2);assert.equal(b.length,1);
  assert.equal(a.find(r=>r.kind==='SALE').amount_minor,27600);assert.equal(a.find(r=>r.kind==='CORRECTION').amount_minor,100);
  assert.ok(a.every(r=>r.business_date==='2026-09-05'));assert.equal(b[0].kind,'SALE');assert.equal(b[0].amount_minor,30000);assert.equal(b[0].business_date,'2026-09-10');
  assert.ok(rows.every(r=>!['REFUND','REVERSAL'].includes(r.kind)));assert.equal((await getOrderView(runtimeDb!,fixture.orderB,'WRITE',actor().propertyCommandGrants.get('hist-property'))).order.current_contract_amount_minor,0);
 });
 await check('升级后owner及runtime readiness真实通过',async()=>{assert.equal(await operatingSalesReady(db),true);assert.equal(await operatingSalesReady(runtimeDb!),true);});
 const oldInitializer=join(snapshot,'scripts/operations/initialize-operating-sales-05d8a4f.ts');writeFileSync(oldInitializer,run('git',['show','05d8a4fe1cdd538da082dcf0cffccb43cff3e3c8:scripts/operations/initialize-operating-sales.ts'],{cwd:root}));
 const newInitializer=join(snapshot,'scripts/operations/initialize-operating-sales-0bd45f.ts');writeFileSync(newInitializer,run('git',['show',`${initializerRevision}:scripts/operations/initialize-operating-sales.ts`],{cwd:root}));
 function init(plan:any,apply:boolean,newVersion=false){const data=JSON.stringify(plan,null,2);const path=join(work,`${plan.propertyId}-${newVersion?'0bd45f':'05d8a4f'}-plan.json`);writeFileSync(path,data);const sha=createHash('sha256').update(data).digest('hex');
  const args=['--import','tsx',newVersion?newInitializer:oldInitializer,'--plan',path,...(apply?['--apply','--expected-sha',sha]:[])];
  const r=spawnSync(process.execPath,args,{cwd:snapshot,env:{...env,MIGRATION_DATABASE_URL:`postgresql://isolated_owner:synthetic@127.0.0.1:${port}/${config.database}`},encoding:'utf8',timeout:40000});appendFileSync(join(work,'initializer.log'),JSON.stringify({version:newVersion?initializerRevision:revision,plan,apply,status:r.status,stdout:r.stdout,stderr:r.stderr})+'\n');return r;
 }
 async function sales(propertyId:string,from:string,to:string){return db.transaction().execute(trx=>loadOperatingSales(trx,propertyId,'Asia/Shanghai','CNY',{from,to},fixture.today)) as Promise<any>;}
 const channelPlan={propertyId:'hist-property',recognitionFrom:'2026-10-01',currency:'CNY',baselines:[{month:'2026-09-01',amountMinor:'52700',evidenceNote:'合成九月渠道净额封账'}],opening:[{sourceKind:'CHANNEL_REFUND',sourceId:fixture.orderB,amountMinor:'5000',evidenceNote:'另有合成已核实历史退款50元，并非取消自动退款'}]};
 await check('先initializer九月基准/opening再终态REPRICE：九月不变、十月零新增且可读',async()=>{
  const r=init(channelPlan,true);assert.equal(r.status,0,r.stderr);const beforeSep=await sales('hist-property','2026-09-01','2026-09-30'),beforeOct=await sales('hist-property','2026-10-01','2026-10-31');
  assert.equal(beforeSep.summary.totals[0].netMinor,'52700');assert.equal(beforeOct.summary.totals[0].netMinor,'0');
  const receipt=await command('REPRICE_ORDER',{orderId:fixture.orderA,targetCurrentContractAmountMinor:27720});
  const afterSep=await sales('hist-property','2026-09-01','2026-09-30'),afterOct=await sales('hist-property','2026-10-01','2026-10-31');assert.deepEqual(afterSep,beforeSep);assert.deepEqual(afterOct,beforeOct);
  const view=await getOrderView(runtimeDb!,fixture.orderA,'WRITE',actor().propertyCommandGrants.get('hist-property'));assert.equal(view.order.status,'CHECKED_OUT');assert.equal(view.order.current_contract_amount_minor,27720);
  const corrected=(await channelFacts()).find(r=>r.command_id===receipt.commandId)!;assert.equal(corrected.kind,'CORRECTION');assert.equal(corrected.amount_minor,20);assert.equal(corrected.business_date,'2026-09-05');
  evidence('sealed-september-reprice',{beforeSep,afterSep,beforeOct,afterOct,receipt,corrected});evidence('sealed-september-reprice-order-view',view);
 });
 // 两份会员M0均在九月；一份在九月撤销，另一份在十月（北京时间10月1日00:30）仅更正备注。
 const m=fixture.members[0],negative=fixture.members[1];
 await fixtureClock(client,'2026-09-25T04:00:00Z');try{await command('CORRECT_MEMBERSHIP_PAYMENT',{propertyId:'member-cutover-property',membershipOrderId:negative.membership,originalPaymentFactId:negative.payment,correctedAmountMinor:30000,correctedTransactionReference:negative.reference,note:'九月已更正对照'});}finally{await fixtureClock(client,null);}
 let replacement:string;
 await fixtureClock(client,'2026-09-30T16:30:00Z');try{replacement=(await command('CORRECT_MEMBERSHIP_PAYMENT',{propertyId:'member-cutover-property',membershipOrderId:m.membership,originalPaymentFactId:m.payment,correctedAmountMinor:30000,correctedTransactionReference:m.reference,note:'十月只改备注M1'})).result.replacementFactId;}finally{await fixtureClock(client,null);}
 const memberPlan=(source:string)=>({propertyId:'member-cutover-property',recognitionFrom:'2026-10-01',currency:'CNY',baselines:[{month:'2026-09-01',amountMinor:'60000',evidenceNote:'合成九月会员封账'}],opening:[{sourceKind:'MEMBER_FACT',sourceId:source,amountMinor:'30000',evidenceNote:'九月M0已计来源'}]});
 await check('0bd45f首次初始化仍拒绝门店截止日前已撤销M0且零写',async()=>{const r=init(memberPlan(negative.payment),true,true);assert.equal(r.status,1);assert.match(r.stderr,/期初来源不存在/);assert.equal((await client.query("SELECT 1 FROM operating_sales_baselines WHERE property_id='member-cutover-property'")).rowCount,0);assert.equal((await client.query("SELECT 1 FROM operating_sales_opening WHERE property_id='member-cutover-property'")).rowCount,0);});
 await check('对照05初始化拒绝九月M0被十月备注更正，0bd45f只读及首次apply成功',async()=>{
  const plan=memberPlan(m.payment);const old=init(plan,false);assert.equal(old.status,1);assert.match(old.stderr,/期初来源不存在/);
  const validated=init(plan,false,true);assert.equal(validated.status,0,validated.stderr);assert.equal(JSON.parse(validated.stdout).status,'validated_read_only');
  const r=init(plan,true,true);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).status,'applied');
  const rows=(await client.query("SELECT fact_id,fact_type,reverses_fact_id,created_at,(created_at AT TIME ZONE 'Asia/Shanghai')::date::text AS local_date FROM membership_payment_facts WHERE membership_order_id=$1 ORDER BY created_at,fact_id",[m.membership])).rows;
  assert.equal(rows.find(r=>r.fact_id===m.payment).local_date,'2026-09-20');assert.equal(rows.find(r=>r.fact_id===replacement).local_date,'2026-10-01');evidence('member-cutoff-initialization',{rows,old:{status:old.status,stderr:old.stderr},validated:JSON.parse(validated.stdout),applied:JSON.parse(r.stdout)});
 });
 await check('0bd45f已应用原计划在后续再次reversal后幂等，十月不重复收入',async()=>{
  await command('CORRECT_MEMBERSHIP_PAYMENT',{propertyId:'member-cutover-property',membershipOrderId:m.membership,originalPaymentFactId:replacement!,correctedAmountMinor:30000,correctedTransactionReference:m.reference,note:'第二次备注更正M2'});
  const before=(await client.query("SELECT row_to_json(o) AS row FROM operating_sales_opening o WHERE property_id='member-cutover-property'")).rows;
  const r=init(memberPlan(m.payment),true,true);assert.equal(r.status,0,r.stderr);assert.deepEqual((await client.query("SELECT row_to_json(o) AS row FROM operating_sales_opening o WHERE property_id='member-cutover-property'")).rows,before);
  const result=await sales('member-cutover-property','2026-10-01','2026-10-31');assert.equal(result.summary.totals[0].netMinor,'0');evidence('member-cutoff-sales',result);
 });
 for(const sourceKind of ['STAY_FACT','PAYMENT_BILL'])await check(`c5 ${sourceKind}期初300：10/2 B收入300、10/3 A1收入0，归属不得交换`,async()=>{
  const propertyId=sourceKind==='STAY_FACT'?'rematch-fact-property':'rematch-bill-property';const billId=`${propertyId}-600`;const merchant=`${propertyId}-merchant`;
  await client.query(`INSERT INTO properties(id,code,name,timezone,currency) VALUES($1,$1,'合成重配时间门店','Asia/Shanghai','CNY');`,[propertyId]);
  await client.query(`INSERT INTO subject_property_grants(subject_id,property_id,access_level) VALUES('hist-user',$1,'WRITE');`,[propertyId]);
  await client.query(`INSERT INTO subject_command_grants(subject_id,property_id,command_type) SELECT subject_id,$1,command_type FROM subject_command_grants WHERE subject_id='hist-user' AND property_id='hist-property'`,[propertyId]);
  await client.query(`INSERT INTO pricing_policy_versions(id,property_id,code,version,stay_type,calculation_kind,nightly_rate_minor,currency) VALUES($1,$2,$1,1,'TRANSIENT','FLAT_NIGHTLY',30000,'CNY')`,[`${propertyId}-policy`,propertyId]);
  await client.query(`INSERT INTO external_payment_accounts(source_id,merchant_id,property_id) VALUES('hist-source',$1,$2)`,[merchant,propertyId]);
  await client.query(`INSERT INTO external_payment_bills(id,source_id,merchant_id,property_id,kind,reference,original_trade_no,amount_minor,occurred_at,state) VALUES($1,'hist-source',$2,$3,'COLLECTION',$1,$1,60000,'2026-09-20T04:00:00Z','SUCCESS')`,[billId,merchant,propertyId]);
  const {createQuoteForTesting}=await moduleAt('pricing-service.ts');const orders:string[]=[];
  try{
   await fixtureClock(client,'2026-09-19T04:00:00Z');
   for(const suffix of ['A0','B','A1']){
    const unit=`${propertyId}-${suffix}`;await client.query(`INSERT INTO inventory_units(id,property_id,kind,code,name) VALUES($1,$2,'ROOM',$1,'合成重配房间')`,[unit,propertyId]);
    const quote=await createQuoteForTesting(db,{propertyId,inventoryUnitId:unit,arrivalDate:fixture.today,departureDate:new Date(Date.parse(fixture.today+'T00:00:00Z')+86400000).toISOString().slice(0,10),pricingPolicyVersionId:`${propertyId}-policy`});
    orders.push((await command('CREATE_ORDER',{propertyId,quoteId:quote.quoteId,primaryGuest:{fullName:'合成重配客人',nickname:suffix},bookingChannelCode:'WECOM',channelOrderReference:null,targetCurrentContractAmountMinor:30000})).result.orderId);
   }
   const match=async(orderId:string)=>command('RECORD_COLLECTION',{propertyId,orderId,amountMinor:30000,method:'WECOM',transactionReference:billId,externalPaymentBillId:billId,note:'合成600元流水分配300'});
   await fixtureClock(client,'2026-09-20T04:00:00Z');const a0=await match(orders[0]!);
   const plan={propertyId,recognitionFrom:'2026-10-01',currency:'CNY',baselines:[{month:'2026-09-01',amountMinor:'30000',evidenceNote:'合成A0九月已计300元'}],opening:[{sourceKind,sourceId:sourceKind==='STAY_FACT'?a0.result.factId:billId,amountMinor:'30000',evidenceNote:'合成原登记A0占期初'}]};
   const initialized=init(plan,true,true);assert.equal(initialized.status,0,initialized.stderr);
   await fixtureClock(client,'2026-10-02T04:00:00Z');const b=await match(orders[1]!);
   const beforeRelease=await sales(propertyId,'2026-10-01','2026-10-31');assert.equal(beforeRelease.summary.totals[0].netMinor,'30000');assert.equal(beforeRelease.events.length,1);
   assert.equal(beforeRelease.events[0].orderId,orders[1]);assert.equal(beforeRelease.events[0].date,'2026-10-02');
   await fixtureClock(client,'2026-10-03T04:00:00Z');const reversal=await command('REVERSE_FACT',{propertyId,orderId:orders[0],reversesFactId:a0.result.factId,releaseExternalPaymentAllocation:true,note:'A0解除原分配'});
   await fixtureClock(client,'2026-10-03T04:01:00Z');const a1=await match(orders[2]!);
   await fixtureClock(client,null);
   const after=await sales(propertyId,'2026-10-01','2026-10-31');const oct2=await sales(propertyId,'2026-10-02','2026-10-02');const oct3=await sales(propertyId,'2026-10-03','2026-10-03');
   assert.equal(after.summary.complete,true);assert.equal(after.summary.totals[0].netMinor,'30000');assert.equal(after.events.length,1);
   assert.equal(after.events[0].id,`STAY:${b.result.factId}`);assert.equal(after.events[0].orderId,orders[1]);assert.equal(after.events[0].date,'2026-10-02');assert.equal(after.events[0].amountMinor,'30000');
   assert.equal(oct2.summary.totals[0].netMinor,'30000');assert.equal(oct2.events[0].orderId,orders[1]);assert.equal(oct3.summary.totals[0].netMinor,'0');assert.equal(oct3.events.length,0);
   assert.ok(!after.events.some((event:any)=>event.orderId===orders[2]));
   const facts=(await client.query("SELECT fact_id,order_id,fact_type,net_effect_minor,created_at,(created_at AT TIME ZONE 'Asia/Shanghai')::date::text AS local_date,reverses_fact_id FROM collection_facts WHERE order_id=ANY($1) ORDER BY created_at,fact_id",[orders])).rows;
   assert.equal(facts.find(f=>f.fact_id===a0.result.factId).local_date,'2026-09-20');assert.equal(facts.find(f=>f.fact_id===a1.result.factId).local_date,'2026-10-03');
   evidence(`rematch-${sourceKind}`,{sourceKind,billId,orders,a0:a0.result,b:b.result,reversal:reversal.result,a1:a1.result,plan,facts,beforeRelease,after,oct2,oct3});
  }finally{await fixtureClock(client,null);}
 });
 missing.push('历史时间通过独立库created_at默认值生成并恢复，不代表生产时钟；未穷举其他历史业务组合');
}
}
main().catch(error=>{console.error(error);process.exitCode=1;});

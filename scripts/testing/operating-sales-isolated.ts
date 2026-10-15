/**
 * 独立验证：node --import tsx scripts/testing/operating-sales-isolated.ts [已提交 ref]
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
import { Kysely, PostgresDialect } from "kysely";

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
const revision = run("git", ["rev-parse", "--verify", `${process.argv[2] ?? "b6c1b2db5dd05c65219a936b34edfac574af8c8b"}^{commit}`], { cwd: root }).trim();
run("git", ["check-ignore", ".local-workspace/operating-sales-validation"], { cwd: root });
const base = join(root, ".local-workspace/operating-sales-validation");
mkdirSync(base, { recursive: true });
const work = mkdtempSync(join(base, "run-"));
writeFileSync(join(work,"script.ts"),readFileSync(__filename));
const log = (text: string) => { console.log(text); appendFileSync(join(work, "checks.log"), `${text}\n`); };
const snapshot = join(work, "source");
mkdirSync(snapshot);
const archive = spawnSync("git", ["archive", revision, "packages", "scripts/operations/initialize-operating-sales.ts", "package.json", "tsconfig.json"], { cwd: root, env, maxBuffer: 64 * 1024 * 1024 });
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

async function verify(client: pg.Client, db: Kysely<any>) {
  await client.query(`
    INSERT INTO properties(id,code,name,timezone,currency) VALUES('iso-property','ISO','独立合成测试','Asia/Shanghai','CNY');
    INSERT INTO inventory_units(id,property_id,kind,code,name) VALUES('iso-room','iso-property','ROOM','ISO-ROOM','合成房间');
    INSERT INTO pricing_policy_versions(id,property_id,code,version,stay_type,calculation_kind,nightly_rate_minor,currency)
      VALUES('iso-policy','iso-property','ISO-FLAT',1,'TRANSIENT','FLAT_NIGHTLY',30000,'CNY');
  `);
  await client.query(`
    INSERT INTO subjects(id,username,display_name,password_salt,password_hash,status)
      VALUES('iso-user','isolated-fixture','合成验证人员','not-a-login','not-a-login','ACTIVE');
    INSERT INTO subject_property_grants(subject_id,property_id,access_level) VALUES('iso-user','iso-property','WRITE');
    INSERT INTO web_sessions(id,subject_id,secret_hash,expires_at) VALUES('iso-session','iso-user',repeat('a',64),now()+interval '1 hour');
    INSERT INTO subject_command_grants(subject_id,property_id,command_type)
      SELECT 'iso-user','iso-property',unnest(ARRAY['CREATE_ORDER','CHECK_IN','CHECK_OUT','REPRICE_ORDER','CANCEL_ORDER','RECORD_REFUND','REVERSE_FACT','RECORD_COLLECTION','CREATE_MEMBER','CREATE_MEMBERSHIP_ORDER','RECORD_MEMBERSHIP_PAYMENT','ACTIVATE_MEMBERSHIP_ORDER']);
  `);
  const moduleAt = (name: string) => import(pathToFileURL(join(snapshot, "packages/db/src", name)).href);
  const { createCommandPreview, confirmCommandPreview } = await moduleAt("commands/service.ts");
  const { createQuoteForTesting } = await moduleAt("pricing-service.ts");
  const { withPropertyClockForTesting } = await moduleAt("members.ts");
  const grants = new Set(["CREATE_ORDER", "CHECK_IN", "CHECK_OUT", "REPRICE_ORDER", "CANCEL_ORDER", "RECORD_REFUND", "REVERSE_FACT", "RECORD_COLLECTION", "CREATE_MEMBER", "CREATE_MEMBERSHIP_ORDER", "RECORD_MEMBERSHIP_PAYMENT", "ACTIVATE_MEMBERSHIP_ORDER"]);
  const principal = { subjectId: "iso-user", credentialId: "iso-session", credentialType: "SESSION", displayName: "合成验证人员",
    propertyAccess: new Map([["iso-property", "WRITE"]]), propertyCommandGrants: new Map([["iso-property", grants]]), tokenCommandCeiling: null };
  let seq = 0;
  const metadata = () => ({ idempotencyKey: `isolated-${++seq}`, correlationId: `isolated-${seq}` });
  const reason = { code: "AUTOMATED_ACCEPTANCE", note: "独立合成渠道角分验证，非真实业务" };
  async function command(commandType: string, input: Record<string, unknown>, executor=db) {
    const preview = await createCommandPreview(executor, principal, { commandType, input: { propertyId: "iso-property", ...input } }, metadata());
    const body = { propertyId: "iso-property", commandType, confirmation: true, expectedEffectHash: preview.preview.effectHash, reason: commandType === "CREATE_ORDER" ? { code: "CREATE_STANDARD_ORDER", note: "" } : reason };
    const meta = metadata();
    const receipt = await confirmCommandPreview(executor, principal, preview.preview.previewId, body, meta);
    assert.equal(receipt.businessCommitted, true, JSON.stringify(receipt));
    return { receipt, preview, repeat: () => confirmCommandPreview(executor, principal, preview.preview.previewId, body, meta) };
  }
  const today = (await client.query("SELECT qintopia_stage10_property_today('iso-property')::text AS day")).rows[0].day;
  const day = (offset: number) => new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
  const clock = <T>(date: string, fn: () => Promise<T>) => withPropertyClockForTesting(new Date(`${date}T04:00:00Z`), fn);
  async function create(amount: number, channel = "YOUMUDAO", offset = 0) {
    const unitId = `iso-room-${++seq}`;
    await db.insertInto("inventory_units").values({ id: unitId, property_id: "iso-property", kind: "ROOM", code: unitId, name: "合成房间" }).execute();
    const quote = await createQuoteForTesting(db, { propertyId: "iso-property", inventoryUnitId: unitId,
      arrivalDate: day(offset), departureDate: day(offset + 1), pricingPolicyVersionId: "iso-policy" });
    const result = await command("CREATE_ORDER", { quoteId: quote.quoteId, primaryGuest: { fullName: "合成客人", nickname: "合成客人" },
      bookingChannelCode: channel, channelOrderReference: channel === "WECOM" ? null : `ISO-${seq}`,
      targetCurrentContractAmountMinor: amount, ...(channel === "WECOM" ? (amount===30000 ? {} : {manualPriceAdjustmentReason:reason.note}) : { channelPriceDifferenceReason: reason.note }) });
    return result.receipt.result.orderId as string;
  }
  async function snapshotOrder(orderId: string) {
    return (await client.query(`SELECT jsonb_build_object('order',to_jsonb(o),'stay',(SELECT to_jsonb(s) FROM stays s WHERE s.order_id=o.id),
      'claims',COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM inventory_claims c WHERE c.property_id=o.property_id),'[]'),
      'roomDays',COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.room_id,d.service_date) FROM inventory_room_days d JOIN inventory_units u ON u.id=d.room_id WHERE u.property_id=o.property_id),'[]'),
      'segments',COALESCE((SELECT jsonb_agg(to_jsonb(g) ORDER BY g.id) FROM stay_segments g JOIN stays st ON st.id=g.stay_id WHERE st.order_id=o.id),'[]'),
      'revisions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY revision_no) FROM pricing_revisions r WHERE r.order_id=o.id),
      'amendments',(SELECT jsonb_agg(to_jsonb(a) ORDER BY sequence) FROM amendments a WHERE a.order_id=o.id)) AS state
      FROM orders o WHERE o.id=$1`, [orderId])).rows[0].state;
  }
  const {operatingSalesReady}=await moduleAt("operating-sales-readiness.ts");
  await check("operatingSalesReady 在071+072真实数据库返回true",async()=>assert.equal(await operatingSalesReady(db),true));
  const {loadOperatingSales}=await moduleAt("operating-sales.ts");
  const {channelOperatingSummary}=await moduleAt("channel-operating.ts");
  const evidence=(name:string,data:unknown)=>writeFileSync(join(work,`${name}.json`),JSON.stringify(data,null,2));
  async function facts(id:string){return (await client.query("SELECT * FROM channel_operating_facts WHERE order_id=$1 ORDER BY created_at,id",[id])).rows;}
  async function business(id:string){return {order:await snapshotOrder(id),facts:await facts(id),collections:(await client.query("SELECT * FROM collection_facts ORDER BY fact_id")).rows};}
  async function setupState(){return (await client.query(`SELECT jsonb_build_object('opening',(SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY source_kind,source_id),'[]') FROM operating_sales_opening o),
    'baseline',(SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY month),'[]') FROM operating_sales_baselines b)) AS state`)).rows[0].state;}
  async function readSales(from=today,to=today):Promise<any>{return db.transaction().execute(trx=>loadOperatingSales(trx,"iso-property","Asia/Shanghai","CNY",{from,to},today));}
  async function rejectsUnchanged(id:string,input:Record<string,unknown>,code:string,message?:RegExp,type="RECORD_REFUND"){
    const before=await business(id);
    await assert.rejects(command(type,{orderId:id,...input}),(error:any)=>{assert.equal(error.code,code);if(message)assert.match(error.message,message);return true;});
    assert.deepEqual(await business(id),before);
  }
  await check("072 实际函数、权限、检查约束与索引清单",async()=>{
    const catalog={
      columns:(await client.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_name IN ('channel_operating_facts','operating_sales_opening','operating_sales_baselines') ORDER BY table_name,ordinal_position")).rows,
      constraints:(await client.query("SELECT conrelid::regclass::text AS relation,conname,contype,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid IN ('channel_operating_facts'::regclass,'operating_sales_opening'::regclass,'operating_sales_baselines'::regclass) ORDER BY conname")).rows,
      indexes:(await client.query("SELECT indexname,indexdef FROM pg_indexes WHERE tablename='channel_operating_facts' ORDER BY indexname")).rows,
      function:(await client.query("SELECT pg_get_functiondef('qintopia_guard_channel_operating_fact()'::regprocedure) AS definition")).rows,
      grants:(await client.query("SELECT table_name,privilege_type FROM information_schema.role_table_grants WHERE grantee='qintopia_runtime' AND table_name IN ('channel_operating_facts','operating_sales_opening','operating_sales_baselines') ORDER BY table_name,privilege_type")).rows
    };evidence("072-catalog",catalog);
    assert.equal(catalog.columns.length,28);assert.equal(catalog.constraints.filter(c=>c.contype==='c').length,11);
    for(const name of ['channel_operating_command_kind','channel_operating_revision','channel_operating_reversal'])assert.ok(catalog.indexes.some(i=>i.indexname===name&&i.indexdef.includes('UNIQUE')));
    assert.deepEqual(catalog.grants,[{table_name:'channel_operating_facts',privilege_type:'INSERT'},{table_name:'channel_operating_facts',privilege_type:'SELECT'},{table_name:'operating_sales_baselines',privilege_type:'SELECT'},{table_name:'operating_sales_opening',privilege_type:'SELECT'}]);
  });
  await check("未初始化经营收入关闭（真实SQL）",async()=>assert.equal((await readSales()).summary.enabled,false));
  const id=await create(27720);
  const secondId=await create(30000);
  await check("正式渠道CREATE_ORDER产生唯一SALE且不写collection_facts",async()=>{
    const state=await business(id);assert.equal(state.facts.length,1);assert.equal(state.facts[0].kind,'SALE');assert.equal(state.facts[0].amount_minor,27720);
    assert.equal(state.facts[0].business_date,today);assert.equal(state.collections.length,0);evidence("created-channel",state);
  });
  const sale=(await facts(id))[0]!;
  const refund={amountMinor:16500,method:'CHANNEL',referencesFactId:sale.id,refundReference:'ISO-REFUND-165',note:'独立合成平台退款165元',businessDate:today};
  await check("期初未初始化时正式退款拒绝且业务零写入",()=>rejectsUnchanged(id,refund,'VALIDATION_ERROR',/尚未承接/));
  await command('CANCEL_ORDER',{orderId:id});
  await check("取消后合同归零但原渠道SALE保留",async()=>{
    const state=await business(id);assert.equal(state.order.order.status,'CANCELLED');assert.equal(state.order.revisions.at(-1).current_contract_amount_minor,0);
    assert.equal(state.facts.length,1);assert.equal(state.facts[0].amount_minor,27720);assert.equal(state.collections.length,0);
  });
  const plan={propertyId:'iso-property',recognitionFrom:'2026-10-01',currency:'CNY',baselines:[{month:'2026-09-01',amountMinor:'99900',evidenceNote:'合成9月封账，非真实业务'}],
    opening:[{sourceKind:'CHANNEL_REFUND',sourceId:id,amountMinor:'10000',evidenceNote:'合成历史已退100元承接'}]};
  const planPath=join(work,'opening-plan.json');writeFileSync(planPath,JSON.stringify(plan,null,2));
  const sha=createHash('sha256').update(readFileSync(planPath)).digest('hex');
  await client.query('CREATE ROLE isolated_runtime LOGIN INHERIT');await client.query('GRANT qintopia_runtime TO isolated_runtime');
  runtimeDb=new Kysely({dialect:new PostgresDialect({pool:new pg.Pool({...config,user:'isolated_runtime'})})});
  function initialize(extra:string[]=[],role='isolated_owner',path=planPath){
    const url=`postgresql://${role}:synthetic@127.0.0.1:${port}/operating_sales_isolated`;
    const result=spawnSync(process.execPath,['--import','tsx',join(snapshot,'scripts/operations/initialize-operating-sales.ts'),'--plan',path,...extra],{cwd:snapshot,env:{...env,MIGRATION_DATABASE_URL:url},encoding:'utf8',timeout:40000});
    appendFileSync(join(work,'initializer.log'),JSON.stringify({role,args:extra,path,status:result.status,stdout:result.stdout,stderr:result.stderr,error:result.error?.message})+'\n');return result;
  }
  await check("初始化入口默认只读",async()=>{const before=await setupState();const r=initialize();assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).status,'validated_read_only');assert.deepEqual(await setupState(),before);});
  await check("初始化入口SHA不匹配拒绝且零写入",async()=>{const before=await setupState();const r=initialize(['--apply','--expected-sha','0'.repeat(64)]);assert.equal(r.status,1);assert.match(r.stderr,/expected-sha/);assert.deepEqual(await setupState(),before);});
  await check("初始化入口运行身份拒绝写入",async()=>{const before=await setupState();const r=initialize(['--apply','--expected-sha',sha],'isolated_runtime');assert.equal(r.status,1);assert.match(r.stderr,/只允许目标数据库所有者/);assert.deepEqual(await setupState(),before);});
  await check("所有者匹配SHA初始化封账及期初",async()=>{const r=initialize(['--apply','--expected-sha',sha]);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).status,'applied');const state=await setupState();assert.equal(state.baseline[0].amount_minor,99900);assert.equal(state.opening[0].amount_minor,10000);evidence('initialized',state);});
  await check("初始化重复执行不覆盖既有行",async()=>{const before=await setupState();const r=initialize(['--apply','--expected-sha',sha]);assert.equal(r.status,0,r.stderr);assert.deepEqual(await setupState(),before);});
  await check("变更期初计划即使SHA匹配仍不得覆盖",async()=>{const before=await setupState();const altered=JSON.stringify({...plan,opening:[{...plan.opening[0],amountMinor:'9999'}]});const path=join(work,'conflicting-plan.json');writeFileSync(path,altered);const r=initialize(['--apply','--expected-sha',createHash('sha256').update(altered).digest('hex')],'isolated_owner',path);assert.equal(r.status,1);assert.match(r.stderr,/禁止覆盖/);assert.deepEqual(await setupState(),before);});
  await check("导出正式getOrderView：已取消且可退177.20元合成DTO",async()=>{
    const {getOrderView}=await moduleAt('orders.ts');
    const view=await getOrderView(runtimeDb!,id,'WRITE',grants);
    evidence('cancelled-refundable-order-view',view);
    assert.equal(view.order.status,'CANCELLED');assert.equal(view.order.current_contract_amount_minor,0);
    assert.equal(view.channelOperating.initialized,true);assert.equal(view.channelOperating.netMinor,'17720');
    assert.equal(view.allowedActions.find((action:any)=>action.code==='RECORD_REFUND')?.enabled,true);
    assert.equal(view.collectionFacts.length,0);
    evidence('order-view-fixture-info',{synthetic:true,revision,producer:'getOrderView(runtimeDb, orderId, WRITE, grants)',file:'cancelled-refundable-order-view.json',propertyId:'iso-property',orderId:id,
      status:'CANCELLED',contractAmountMinor:0,originalSaleMinor:27720,openingRefundMinor:10000,remainingRefundableMinor:17720,
      suggestedRefundMinor:16500,refundActionEnabled:true,currency:'CNY',capturedBeforeCurrentRefund:true,
      note:'完整DTO直接JSON序列化，无手写字段替代；全部合成数据，不含凭据。'});
  });
  await check("退款未来日期/早于成交日期拒绝",async()=>{
    for(const businessDate of [day(1),day(-1)])await rejectsUnchanged(id,{...refund,businessDate},'VALIDATION_ERROR',/不得晚于今天或早于原成交/);
  });
  await check("退款空单号/空原因及错误原SALE关联拒绝",async()=>{
    await rejectsUnchanged(id,{...refund,refundReference:' '},'VALIDATION_ERROR',/refundReference/);
    await rejectsUnchanged(id,{...refund,note:' '},'VALIDATION_ERROR',/note/);
    await rejectsUnchanged(id,{...refund,referencesFactId:(await facts(secondId))[0]!.id},'VALIDATION_ERROR',/必须关联本订单/);
  });
  await check("渠道退款不得套用企微method或流水",async()=>{
    await rejectsUnchanged(id,{...refund,method:'WECOM'},'VALIDATION_ERROR',/平台退款凭据/);
    await rejectsUnchanged(id,{...refund,externalPaymentBillId:'synthetic-other-bill'},'VALIDATION_ERROR',/平台退款凭据/);
  });
  await check("期初承接100元后余额177.20；超额退款拒绝",async()=>{assert.equal((await channelOperatingSummary(db,'iso-property',id)).netMinor,'17720');await rejectsUnchanged(id,{...refund,amountMinor:17721},'VALIDATION_ERROR',/不超过/);});
  await check("runtime正式命令：取消且合同0仍可退款165；幂等、库存不变、不伪造收款",async()=>{
    const before=await business(id);const r=await command('RECORD_REFUND',{orderId:id,...refund},runtimeDb);const after=await business(id);
    assert.deepEqual(after.order,before.order);assert.deepEqual(after.collections,before.collections);assert.equal(after.facts.length,before.facts.length+1);
    const f=after.facts.find(x=>x.id===r.receipt.result.factId)!;assert.equal(f.kind,'REFUND');assert.equal(f.amount_minor,-16500);assert.equal(f.references_fact_id,sale.id);
    assert.equal((await r.repeat()).commandId,r.receipt.commandId);assert.deepEqual(await business(id),after);evidence('refund-165',{before,after,receipt:r.receipt});
  });
  await check("退款后剩12.20再次超额拒绝",()=>rejectsUnchanged(id,{...refund,amountMinor:1221,refundReference:'ISO-OVER'},'VALIDATION_ERROR',/不超过/));
  await check("同平台另一订单重复退款单号拒绝",async()=>{const source=(await facts(secondId))[0]!;await rejectsUnchanged(secondId,{...refund,amountMinor:100,referencesFactId:source.id},'AGGREGATE_VERSION_CONFLICT',/已经登记/);});
  await check("runtime正式命令：反向误录追加REVERSAL且保留原REFUND；库存与收款不变、幂等",async()=>{
    const before=await business(id);const original=before.facts.find(f=>f.kind==='REFUND');assert.ok(original);
    const r=await command('REVERSE_FACT',{orderId:id,reversesFactId:original.id,note:'合成误录撤销，不代表平台实退'},runtimeDb);const after=await business(id);
    assert.deepEqual(after.order,before.order);assert.deepEqual(after.collections,before.collections);assert.deepEqual(after.facts.filter(f=>f.id!==r.receipt.result.factId),before.facts);
    const reverse=after.facts.find(f=>f.id===r.receipt.result.factId)!;assert.equal(reverse.kind,'REVERSAL');assert.equal(reverse.amount_minor,16500);assert.equal(reverse.references_fact_id,original.id);assert.equal(reverse.business_date,original.business_date);
    assert.equal((await r.repeat()).commandId,r.receipt.commandId);assert.deepEqual(await business(id),after);evidence('reversal',{before,after,receipt:r.receipt});
  });
  await check("同笔退款再次反向误录拒绝",async()=>{const original=(await facts(id)).find(f=>f.kind==='REFUND')!;await rejectsUnchanged(id,{reversesFactId:original.id,note:'再次撤销'},'FACT_ALREADY_REVERSED',/已经撤销/,'REVERSE_FACT');});
  await check("072事实和期初封账不可原地修改/删除（含owner）",async()=>{
    for(const text of ["UPDATE channel_operating_facts SET note='篡改'",'DELETE FROM channel_operating_facts',"UPDATE operating_sales_opening SET amount_minor=1",'DELETE FROM operating_sales_baselines']) {
      await client.query('BEGIN');try{await assert.rejects(client.query(text),(e:any)=>{assert.equal(e.code,'23514');assert.match(e.message,/allocation history is append-only/);return true;});}finally{await client.query('ROLLBACK');}
    }
  });
  await check("runtime无权写封账/期初、无权修改渠道事实",async()=>{
    for(const text of ["UPDATE channel_operating_facts SET note='篡改'","INSERT INTO operating_sales_opening VALUES('iso-property','CHANNEL_REFUND','forged',0,'CNY','forged',now())","DELETE FROM operating_sales_baselines"]) {
      await client.query('BEGIN');try{await client.query('SET LOCAL ROLE qintopia_runtime');await assert.rejects(client.query(text),{code:'42501'});}finally{await client.query('ROLLBACK');}
    }
  });
  await check("loadOperatingSales真实SQL含会员及企微proof：当前渠道收入",async()=>{const value=await readSales();evidence('sales-current',value);assert.equal(value.summary.enabled,true);assert.equal(value.summary.complete,true);assert.equal(value.summary.totals[0].netMinor,'57720');});
  await check("loadOperatingSales真实SQL：9月仅封账基准，不重算当前事实",async()=>{const value=await readSales('2026-09-01','2026-09-30');evidence('sales-september',value);assert.equal(value.summary.complete,true);assert.equal(value.summary.totals[0].netMinor,'99900');assert.equal(value.events.length,1);assert.equal(value.events[0].source,'BASELINE');});

  await client.query(`INSERT INTO external_payment_sources(id,corp_id,enabled,matching_since,import_since,baseline_complete) VALUES('iso-source','iso-corp',true,'2026-01-01','2026-01-01',true);
    INSERT INTO external_payment_accounts(source_id,merchant_id,property_id) VALUES('iso-source','iso-merchant','iso-property');`);
  async function bill(id:string,amount:number,state='SUCCESS'){
    await client.query(`INSERT INTO external_payment_bills(id,source_id,merchant_id,property_id,kind,reference,original_trade_no,amount_minor,occurred_at,state)
      VALUES($1,'iso-source','iso-merchant','iso-property','COLLECTION',$1,$1,$2,'2026-09-15T04:00:00Z',$3)`,[id,amount,state]);
  }
  await bill('iso-bill-split',100000);
  await check("未匹配企微流水1000元不计经营收入",async()=>{const value=await readSales();assert.equal(value.summary.totals[0].netMinor,'57720');evidence('unmatched-bill',value);});
  await check("初始化PAYMENT_BILL来源应成功（固定快照回归，不豁免已知currency缺列）",async()=>{
    const paymentPlan={...plan,opening:[{sourceKind:'PAYMENT_BILL',sourceId:'iso-bill-split',amountMinor:'100000',evidenceNote:'合成9月已计流水1000元'}]};
    const path=join(work,'payment-bill-plan.json');writeFileSync(path,JSON.stringify(paymentPlan));
    const before=await setupState();const r=initialize([], 'isolated_owner',path);assert.deepEqual(await setupState(),before);
    if(r.status!==0){try{await client.query('SELECT amount_minor::text AS amount,currency FROM external_payment_bills WHERE id=$1',['iso-bill-split']);}catch(error:any){evidence('payment-bill-schema-failure',{code:error.code,message:error.message,position:error.position});}}
    assert.equal(r.status,0,r.stderr);
  });
  let firstFact:string|undefined;
  await check("正式企微匹配1000元流水中的300元仅认300元",async()=>{
    const stayId=await create(30000,'WECOM');const result=await command('RECORD_COLLECTION',{orderId:stayId,amountMinor:30000,method:'WECOM',transactionReference:'iso-bill-split',externalPaymentBillId:'iso-bill-split',note:'合成分配300元'});
    firstFact=result.receipt.result.factId;const value=await readSales();evidence('matched-300',value);assert.equal(value.summary.totals[0].netMinor,'87720');
  });
  await check("同一企微流水再匹配700元不重复1000元本金",async()=>{
    assert.ok(firstFact,'依赖第一笔匹配');const stayId=await create(70000,'WECOM');await command('RECORD_COLLECTION',{orderId:stayId,amountMinor:70000,method:'WECOM',transactionReference:'iso-bill-split',externalPaymentBillId:'iso-bill-split',note:'合成剩余分配700元'});
    const value=await readSales();evidence('matched-1000',value);assert.equal(value.summary.totals[0].netMinor,'157720');
  });
  await check("9月已计来源STAY_FACT期初承接：10月匹配不再计该300元",async()=>{
    assert.ok(firstFact,'依赖已匹配事实');
    const carryPlan={...plan,opening:[{sourceKind:'STAY_FACT',sourceId:firstFact,amountMinor:'30000',evidenceNote:'合成9月已计300元，10月补关联'}]};
    const data=JSON.stringify(carryPlan);const path=join(work,'stay-carry-plan.json');writeFileSync(path,data);
    const r=initialize(['--apply','--expected-sha',createHash('sha256').update(data).digest('hex'),'--existing-baseline-sha',sha],'isolated_owner',path);assert.equal(r.status,0,r.stderr);
    const value=await readSales();evidence('carry-stay-300',value);assert.equal(value.summary.totals[0].netMinor,'127720');
    const september=await readSales('2026-09-01','2026-09-30');assert.equal(september.summary.totals[0].netMinor,'99900');
  });
  let memberId:string|undefined, membershipId:string|undefined;
  await check("正式会员售卡匹配1620元只计一次（真实memberProof SQL）",async()=>{
    await bill('iso-member-bill',162000);
    memberId=(await command('CREATE_MEMBER',{fullName:'合成会员',nickname:'合成会员',phone:'13900000001',wechat:'isolated-synthetic'})).receipt.result.memberId;
    membershipId=(await command('CREATE_MEMBERSHIP_ORDER',{memberId,membershipProductId:'membership_product_shared_bath_single_v1',agreedPriceMinor:162000})).receipt.result.membershipOrderId;
    const before=await readSales();const payment=await command('RECORD_MEMBERSHIP_PAYMENT',{membershipOrderId:membershipId,amountMinor:162000,transactionReference:'iso-member-bill',note:'合成售卡收款'});
    const after=await readSales();assert.equal(BigInt(after.summary.totals[0].netMinor)-BigInt(before.summary.totals[0].netMinor),162000n);
    assert.equal(after.events.filter((e:any)=>e.source==='MEMBERSHIP'&&e.memberId===memberId).length,1);
    assert.equal((await payment.repeat()).commandId,payment.receipt.commandId);assert.deepEqual(await readSales(),after);evidence('member-paid',after);
  });
  await check("会员激活及权益入住不重复售卡收入",async()=>{
    assert.ok(memberId&&membershipId,'依赖会员收款');const before=await readSales();await command('ACTIVATE_MEMBERSHIP_ORDER',{membershipOrderId:membershipId});
    await db.insertInto('inventory_units').values({id:'iso-member-room',property_id:'iso-property',kind:'ROOM',code:'ISO-MEMBER',name:'合成会员房',room_type_code:'shared_bath_single'}).execute();
    const quote=await createQuoteForTesting(db,{propertyId:'iso-property',inventoryUnitId:'iso-member-room',arrivalDate:today,departureDate:day(1),pricingPolicyVersionId:'iso-policy',memberId});
    const created=await command('CREATE_ORDER',{quoteId:quote.quoteId,primaryGuest:{fullName:'合成会员',nickname:'合成会员'}});
    const orderId=created.receipt.result.orderId;await command('CHECK_IN',{orderId});
    const state=await snapshotOrder(orderId);assert.equal(state.order.member_id,memberId);assert.equal(state.revisions.at(-1).pricing_basis,'MEMBER_ENTITLEMENT');assert.equal(state.revisions.at(-1).current_contract_amount_minor,0);
    assert.deepEqual(await readSales(),before);assert.equal((await facts(orderId)).length,0);evidence('member-entitlement-stay',state);
  });
  await check("缺可核实匹配的历史企微收款不计且提示待核实",async()=>{
    const stayId=await create(30000,'WECOM');const revision=(await snapshotOrder(stayId)).order.current_revision_id;
    await client.query(`INSERT INTO command_executions(id,subject_id,credential_id,property_id,command_type,idempotency_key,request_hash,correlation_id,state)
      VALUES('iso-historical-command','iso-user','iso-session','iso-property','RECORD_COLLECTION','iso-historical',repeat('c',64),'iso-historical','APPLIED')`);
    const before=await readSales();
    await client.query(`INSERT INTO collection_facts(fact_id,order_id,fact_type,amount_minor,net_effect_minor,currency,method,transaction_reference,note,pricing_revision_id,command_id)
      VALUES('iso-unverified-fact',$1,'COLLECTION',5000,5000,'CNY','WECOM','ISO-NO-BILL','合成历史缺匹配事实',$2,'iso-historical-command')`,[stayId,revision]);
    const after=await readSales();assert.equal(after.summary.totals[0].netMinor,before.summary.totals[0].netMinor);assert.equal(after.summary.complete,false);assert.equal(after.summary.reviewCount,before.summary.reviewCount+1);evidence('unverified-excluded',after);
  });
  await check("执行后operatingSalesReady仍返回true",async()=>assert.equal(await operatingSalesReady(db),true));
  missing.push('未覆盖历史已有订单072迁移回填、并发退款、住宿转会员的完整内部转款/解除重匹配组合、HTTP/UI；未接触生产或既有库');


}
}
main().catch(error => { console.error(error); process.exitCode = 1; });

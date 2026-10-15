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
const revision = run("git", ["rev-parse", "--verify", `${process.argv[2] ?? "05d8a4fe1cdd538da082dcf0cffccb43cff3e3c8"}^{commit}`], { cwd: root }).trim();
run("git", ["check-ignore", ".local-workspace/operating-sales-validation"], { cwd: root });
const base = join(root, ".local-workspace/operating-sales-validation");
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
      SELECT 'iso-user','iso-property',unnest(ARRAY['CREATE_ORDER','CHECK_IN','CHECK_OUT','REPRICE_ORDER','CANCEL_ORDER','RECORD_REFUND','REVERSE_FACT','RECORD_COLLECTION','CREATE_MEMBER','CREATE_MEMBERSHIP_ORDER','RECORD_MEMBERSHIP_PAYMENT','ACTIVATE_MEMBERSHIP_ORDER','MOVE_UNIT','EXTEND_STAY','CORRECT_MEMBERSHIP_PAYMENT','CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP']);
  `);
  const moduleAt = (name: string) => import(pathToFileURL(join(snapshot, "packages/db/src", name)).href);
  const { createCommandPreview, confirmCommandPreview } = await moduleAt("commands/service.ts");
  const { createQuoteForTesting } = await moduleAt("pricing-service.ts");
  const { withPropertyClockForTesting } = await moduleAt("members.ts");
  const grants = new Set(["CREATE_ORDER", "CHECK_IN", "CHECK_OUT", "REPRICE_ORDER", "CANCEL_ORDER", "RECORD_REFUND", "REVERSE_FACT", "RECORD_COLLECTION", "CREATE_MEMBER", "CREATE_MEMBERSHIP_ORDER", "RECORD_MEMBERSHIP_PAYMENT", "ACTIVATE_MEMBERSHIP_ORDER", "MOVE_UNIT", "EXTEND_STAY", "CORRECT_MEMBERSHIP_PAYMENT", "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"]);
  const principal = { subjectId: "iso-user", credentialId: "iso-session", credentialType: "SESSION", displayName: "合成验证人员",
    propertyAccess: new Map([["iso-property", "WRITE"]]), propertyCommandGrants: new Map([["iso-property", grants]]), tokenCommandCeiling: null };
  let seq = 0;
  const metadata = () => ({ idempotencyKey: `isolated-${++seq}`, correlationId: `isolated-${seq}` });
  const reason = { code: "AUTOMATED_ACCEPTANCE", note: "独立合成渠道角分验证，非真实业务" };
  async function command(commandType: string, input: Record<string, unknown>, executor=db) {
    const preview = await createCommandPreview(executor, principal, { commandType, input: { propertyId: "iso-property", ...input } }, metadata());
    const body = { propertyId: String(input.propertyId ?? "iso-property"), commandType, confirmation: true, expectedEffectHash: preview.preview.effectHash, reason: commandType === "CREATE_ORDER" ? { code: "CREATE_STANDARD_ORDER", note: "" } : reason };
    const meta = metadata();
    const receipt = await confirmCommandPreview(executor, principal, preview.preview.previewId, body, meta);
    assert.equal(receipt.businessCommitted, true, JSON.stringify(receipt));
    return { receipt, preview, repeat: () => confirmCommandPreview(executor, principal, preview.preview.previewId, body, meta) };
  }
  const today = (await client.query("SELECT qintopia_stage10_property_today('iso-property')::text AS day")).rows[0].day;
  const day = (offset: number) => new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
  const clock = <T>(date: string, fn: () => Promise<T>) => withPropertyClockForTesting(new Date(`${date}T04:00:00Z`), fn);
  async function create(amount: number, channel = "YOUMUDAO", offset = 0, options:{phone?:string;roomType?:string}={}) {
    const unitId = `iso-room-${++seq}`;
    await db.insertInto("inventory_units").values({ id: unitId, property_id: "iso-property", kind: "ROOM", code: unitId, name: "合成房间", ...(options.roomType ? {room_type_code:options.roomType} : {}) }).execute();
    const quote = await createQuoteForTesting(db, { propertyId: "iso-property", inventoryUnitId: unitId,
      arrivalDate: day(offset), departureDate: day(offset + 1), pricingPolicyVersionId: "iso-policy" });
    const result = await command("CREATE_ORDER", { quoteId: quote.quoteId, primaryGuest: { fullName: "合成客人", nickname: "合成客人", ...(options.phone ? {phone:options.phone} : {}) },
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
  async function business(id:string){return {refundClaims:(await client.query('SELECT * FROM channel_refund_claims ORDER BY property_id,channel_code,refund_reference')).rows,order:await snapshotOrder(id),facts:await facts(id),collections:(await client.query("SELECT * FROM collection_facts ORDER BY fact_id")).rows};}
  // 资金命令只允许version/updated_at/current_revision_id以及追加资金amendment/必要修订变化。
  function assertFundsTransition(before:any,after:any,target:number,type:string){
    const strip=(order:any)=>{const {version,updated_at,current_revision_id,...identity}=order;return identity;};
    assert.deepEqual(strip(after.order),strip(before.order));assert.equal(after.order.version,before.order.version+1);
    assert.ok(Date.parse(after.order.updated_at)>=Date.parse(before.order.updated_at));
    for(const key of ['stay','claims','roomDays','segments'])assert.deepEqual(after[key],before[key],key);
    assert.deepEqual(after.amendments.slice(0,-1),before.amendments);assert.equal(after.amendments.length,before.amendments.length+1);
    const amendment=after.amendments.at(-1);assert.equal(amendment.amendment_type,type);assert.equal(amendment.payload.channelOperating,true);
    assert.equal(amendment.prior_version,before.order.version);assert.equal(amendment.new_version,after.order.version);
    assert.equal(amendment.payload.contractBeforeMinor,before.revisions.at(-1).current_contract_amount_minor);assert.equal(amendment.payload.contractTargetMinor,target);
    if(target===before.revisions.at(-1).current_contract_amount_minor){assert.deepEqual(after.revisions,before.revisions);assert.equal(after.order.current_revision_id,before.order.current_revision_id);}
    else{assert.equal(after.revisions.length,before.revisions.length+1);assert.deepEqual(after.revisions.slice(0,-1),before.revisions);
      assert.equal(after.revisions.at(-1).amendment_id,amendment.id);assert.equal(after.revisions.at(-1).pricing_basis,'CHANNEL_CONTRACT');
      assert.equal(after.revisions.at(-1).manual_adjustment_minor,0);assert.equal(after.revisions.at(-1).current_contract_amount_minor,target);
      assert.equal(after.order.current_revision_id,after.revisions.at(-1).id);}
  }
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
      columns:(await client.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_name IN ('channel_operating_facts','operating_sales_opening','operating_sales_baselines','channel_refund_claims') ORDER BY table_name,ordinal_position")).rows,
      constraints:(await client.query("SELECT conrelid::regclass::text AS relation,conname,contype,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid IN ('channel_operating_facts'::regclass,'operating_sales_opening'::regclass,'operating_sales_baselines'::regclass,'channel_refund_claims'::regclass) ORDER BY conname")).rows,
      indexes:(await client.query("SELECT indexname,indexdef FROM pg_indexes WHERE tablename IN ('channel_operating_facts','channel_refund_claims') ORDER BY indexname")).rows,
      function:(await client.query("SELECT proname,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE oid IN ('qintopia_guard_channel_operating_fact()'::regprocedure,'qintopia_assert_channel_operating_commit()'::regprocedure) ORDER BY proname")).rows,
      grants:(await client.query("SELECT table_name,privilege_type FROM information_schema.role_table_grants WHERE grantee='qintopia_runtime' AND table_name IN ('channel_operating_facts','operating_sales_opening','operating_sales_baselines','channel_refund_claims') ORDER BY table_name,privilege_type")).rows
    };evidence("072-catalog",catalog);
    assert.equal(catalog.columns.length,33);assert.equal(catalog.constraints.filter(c=>c.contype==='c').length,14);
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
  await client.query(`INSERT INTO external_payment_sources(id,corp_id,enabled,matching_since,import_since,baseline_complete) VALUES('iso-source','iso-corp',true,'2026-01-01','2026-01-01',true);
    INSERT INTO external_payment_accounts(source_id,merchant_id,property_id) VALUES('iso-source','iso-merchant','iso-property');`);
  async function bill(id:string,amount:number,state='SUCCESS'){
    await client.query(`INSERT INTO external_payment_bills(id,source_id,merchant_id,property_id,kind,reference,original_trade_no,amount_minor,occurred_at,state)
      VALUES($1,'iso-source','iso-merchant','iso-property','COLLECTION',$1,$1,$2,'2026-09-15T04:00:00Z',$3)`,[id,amount,state]);
  }
  // 新入口要求一次性计划SHA完全一致；在初始化前备齐独立承接来源。
  await bill('iso-carry-bill',30000);
  const carriedOrderId=await create(30000,'WECOM');
  const carriedPayment=await command('RECORD_COLLECTION',{orderId:carriedOrderId,amountMinor:30000,method:'WECOM',transactionReference:'iso-carry-bill',externalPaymentBillId:'iso-carry-bill',note:'合成9月已计来源'});
  const carriedFactId=carriedPayment.receipt.result.factId;
  await bill('iso-opening-bill',40000);
  await bill('iso-member-opening-bill',30000);
  const carriedMemberId=(await command('CREATE_MEMBER',{fullName:'合成期初会员',nickname:'合成期初会员',phone:'13900000002',wechat:'iso-opening-member'})).receipt.result.memberId;
  const carriedMembershipId=(await command('CREATE_MEMBERSHIP_ORDER',{memberId:carriedMemberId,membershipProductId:'membership_product_shared_bath_single_v1',agreedPriceMinor:30000,priceAdjustmentReason:'合成期初会员价'})).receipt.result.membershipOrderId;
  const carriedMemberFactId=(await command('RECORD_MEMBERSHIP_PAYMENT',{membershipOrderId:carriedMembershipId,amountMinor:30000,transactionReference:'iso-member-opening-bill',note:'已计历史会员款'})).receipt.result.paymentFactId;
  assert.ok(carriedMemberFactId);

  const plan={propertyId:'iso-property',recognitionFrom:'2026-10-01',currency:'CNY',baselines:[{month:'2026-09-01',amountMinor:'99900',evidenceNote:'合成9月封账，非真实业务'}],
    opening:[{sourceKind:'CHANNEL_REFUND',sourceId:id,amountMinor:'10000',evidenceNote:'合成历史已退100元承接'},
      {sourceKind:'STAY_FACT',sourceId:carriedFactId,amountMinor:'30000',evidenceNote:'合成9月已计300元'},
      {sourceKind:'PAYMENT_BILL',sourceId:'iso-opening-bill',amountMinor:'40000',evidenceNote:'合成9月已计400元'},
      {sourceKind:'MEMBER_FACT',sourceId:carriedMemberFactId,amountMinor:'30000',evidenceNote:'合成9月已计会员300元'}]};
  const planPath=join(work,'opening-plan.json');writeFileSync(planPath,JSON.stringify(plan,null,2));
  const sha=createHash('sha256').update(readFileSync(planPath)).digest('hex');
  await client.query('CREATE ROLE isolated_runtime LOGIN INHERIT');await client.query('GRANT qintopia_runtime TO isolated_runtime');
  runtimeDb=new Kysely({dialect:new PostgresDialect({pool:new pg.Pool({...config,user:'isolated_runtime'})})});
  await check("runtime无claim表权限但readiness真实返回true，pg_attribute完整33列",async()=>{
    const row=(await sql<{actor:string;owner:boolean;columns:number;visible_columns:number;claim_select:boolean;claim_write:boolean}>`SELECT current_user AS actor,
      current_user=pg_get_userbyid((SELECT datdba FROM pg_database WHERE datname=current_database())) AS owner,
      (SELECT count(*)::integer FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('channel_operating_facts','operating_sales_opening','operating_sales_baselines','channel_refund_claims') AND a.attnum>0 AND NOT a.attisdropped) AS columns,
      (SELECT count(*)::integer FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('channel_operating_facts','operating_sales_opening','operating_sales_baselines','channel_refund_claims')) AS visible_columns,
      has_table_privilege(current_user,'channel_refund_claims','SELECT') AS claim_select,
      has_table_privilege(current_user,'channel_refund_claims','INSERT,UPDATE,DELETE') AS claim_write`.execute(runtimeDb!)).rows[0]!;
    assert.equal(row.actor,'isolated_runtime');assert.equal(row.owner,false);assert.equal(row.columns,33);assert.equal(row.visible_columns,29);
    assert.equal(row.claim_select,false);assert.equal(row.claim_write,false);assert.equal(await operatingSalesReady(runtimeDb!),true);evidence('runtime-readiness',row);
  });
  function initialize(extra:string[]=[],role='isolated_owner',path=planPath){
    const url=`postgresql://${role}:synthetic@127.0.0.1:${port}/operating_sales_isolated`;
    const result=spawnSync(process.execPath,['--import','tsx',join(snapshot,'scripts/operations/initialize-operating-sales.ts'),'--plan',path,...extra],{cwd:snapshot,env:{...env,MIGRATION_DATABASE_URL:url},encoding:'utf8',timeout:40000});
    appendFileSync(join(work,'initializer.log'),JSON.stringify({role,args:extra,path,status:result.status,stdout:result.stdout,stderr:result.stderr,error:result.error?.message})+'\n');return result;
  }
  await check("初始化入口默认只读",async()=>{const before=await setupState();const r=initialize();assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).status,'validated_read_only');assert.deepEqual(await setupState(),before);});
  await check("初始化入口SHA不匹配拒绝且零写入",async()=>{const before=await setupState();const r=initialize(['--apply','--expected-sha','0'.repeat(64)]);assert.equal(r.status,1);assert.match(r.stderr,/expected-sha/);assert.deepEqual(await setupState(),before);});
  await check("初始化入口运行身份拒绝写入",async()=>{const before=await setupState();const r=initialize(['--apply','--expected-sha',sha],'isolated_runtime');assert.equal(r.status,1);assert.match(r.stderr,/只允许目标数据库所有者/);assert.deepEqual(await setupState(),before);});
  await check("所有者匹配SHA初始化封账及期初",async()=>{const r=initialize(['--apply','--expected-sha',sha]);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).status,'applied');const state=await setupState();assert.equal(state.baseline[0].amount_minor,99900);assert.equal(state.opening.find((r:any)=>r.source_kind==='CHANNEL_REFUND').amount_minor,10000);assert.equal(state.opening.find((r:any)=>r.source_kind==='PAYMENT_BILL').amount_minor,40000);evidence('initialized',state);});
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
    assertFundsTransition(before.order,after.order,0,'RECORD_REFUND');assert.deepEqual(after.collections,before.collections);assert.equal(after.facts.length,before.facts.length+1);
    const f=after.facts.find(x=>x.id===r.receipt.result.factId)!;assert.equal(f.kind,'REFUND');assert.equal(f.amount_minor,-16500);assert.equal(f.references_fact_id,sale.id);assert.equal(f.contract_effect_minor,0);assert.equal(after.refundClaims.filter((c:any)=>c.fact_id===f.id).length,1);
    assert.equal((await r.repeat()).commandId,r.receipt.commandId);assert.deepEqual(await business(id),after);evidence('refund-165',{before,after,receipt:r.receipt});
  });
  await check("退款后剩12.20再次超额拒绝",()=>rejectsUnchanged(id,{...refund,amountMinor:1221,refundReference:'ISO-OVER'},'VALIDATION_ERROR',/不超过/));
  await check("同平台另一订单重复退款单号拒绝",async()=>{const source=(await facts(secondId))[0]!;await rejectsUnchanged(secondId,{...refund,amountMinor:100,referencesFactId:source.id},'AGGREGATE_VERSION_CONFLICT',/已经登记/);});
  await check("runtime正式命令：反向误录追加REVERSAL且保留原REFUND；库存与收款不变、幂等",async()=>{
    const before=await business(id);const original=before.facts.find(f=>f.kind==='REFUND');assert.ok(original);
    const r=await command('REVERSE_FACT',{orderId:id,reversesFactId:original.id,note:'合成误录撤销，不代表平台实退'},runtimeDb);const after=await business(id);
    assertFundsTransition(before.order,after.order,0,'REVERSE_FACT');assert.deepEqual(after.collections,before.collections);assert.deepEqual(after.facts.filter(f=>f.id!==r.receipt.result.factId),before.facts);
    const reverse=after.facts.find(f=>f.id===r.receipt.result.factId)!;assert.equal(reverse.kind,'REVERSAL');assert.equal(reverse.amount_minor,16500);assert.equal(reverse.references_fact_id,original.id);assert.equal(reverse.business_date,original.business_date);assert.equal(reverse.contract_effect_minor,0);assert.equal(after.refundClaims.filter((c:any)=>c.fact_id===original.id).length,0);
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
  await check("误录退款撤销后不再计实际退款或冲回金额，净额不变，审计事实保留",async()=>{
    const value=await readSales();assert.equal(value.summary.totals[0].netMinor,'57720');
    assert.equal(value.summary.totals[0].refundsMinor,'0');assert.equal(value.summary.totals[0].correctedMinor,'0');
    const audit=(await facts(id)).filter(f=>['REFUND','REVERSAL'].includes(f.kind));assert.equal(audit.length,2);
    assert.ok(audit.every(f=>!value.events.some((event:any)=>event.id===f.id)));evidence('reversed-refund-sales',{value,audit});
  });
  await check("loadOperatingSales真实SQL：9月仅封账基准，不重算当前事实",async()=>{const value=await readSales('2026-09-01','2026-09-30');evidence('sales-september',value);assert.equal(value.summary.complete,true);assert.equal(value.summary.totals[0].netMinor,'99900');assert.equal(value.events.length,1);assert.equal(value.events[0].source,'BASELINE');});

  await bill('iso-bill-split',100000);
  await check("未匹配企微流水1000元不计经营收入",async()=>{const value=await readSales();assert.equal(value.summary.totals[0].netMinor,'57720');evidence('unmatched-bill',value);});
  await check("原计划含PAYMENT_BILL的默认只读校验成功且零写",async()=>{
    const before=await setupState();const r=initialize();assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).status,'validated_read_only');assert.deepEqual(await setupState(),before);
  });
  await check("封账后不同计划即使只读也拒绝且零写",async()=>{
    const path=join(work,'changed-readonly-plan.json');writeFileSync(path,JSON.stringify({...plan,opening:[{sourceKind:'PAYMENT_BILL',sourceId:'iso-bill-split',amountMinor:'100000',evidenceNote:'改动后的计划'}]}));
    const before=await setupState();const r=initialize([],'isolated_owner',path);assert.equal(r.status,1);assert.match(r.stderr,/已有封账基准不同/);assert.deepEqual(await setupState(),before);
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
  await check("一次性初始化STAY_FACT与PAYMENT_BILL：已计9月来源不重计",async()=>{
    const before=await readSales();assert.equal(before.summary.totals[0].netMinor,'157720');
    assert.ok(!before.events.some((e:any)=>e.id===`STAY:${carriedFactId}`));
    const stayId=await create(40000,'WECOM');await command('RECORD_COLLECTION',{orderId:stayId,amountMinor:40000,method:'WECOM',transactionReference:'iso-opening-bill',externalPaymentBillId:'iso-opening-bill',note:'10月补匹配9月已计流水'});
    const after=await readSales();assert.equal(after.summary.totals[0].netMinor,'157720');evidence('carry-payment-and-stay',{before,after});
    assert.equal((await readSales('2026-09-01','2026-09-30')).summary.totals[0].netMinor,'99900');
  });
  await check("企微收入证明优先明确匹配ID，其他来源同号流水不干扰",async()=>{
    const before=await readSales();
    await client.query(`INSERT INTO external_payment_sources(id,corp_id,enabled,matching_since,import_since,baseline_complete) VALUES('iso-shadow-source','iso-shadow-corp',true,'2026-01-01','2026-01-01',true);
      INSERT INTO external_payment_accounts(source_id,merchant_id,property_id) VALUES('iso-shadow-source','iso-shadow-merchant','iso-property');
      INSERT INTO external_payment_bills(id,source_id,merchant_id,property_id,kind,reference,original_trade_no,amount_minor,occurred_at,state)
      VALUES('iso-shadow-bill','iso-shadow-source','iso-shadow-merchant','iso-property','COLLECTION','iso-bill-split','iso-bill-split',77700,now(),'SUCCESS');`);
    const after=await readSales();assert.deepEqual(after,before);evidence('explicit-payment-proof',after);
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
  const {getOrderView}=await moduleAt('orders.ts');
  async function channelRefund(orderId:string,amountMinor:number,refundReference:string){
    const source=(await facts(orderId)).find(f=>f.kind==='SALE');assert.ok(source);
    return command('RECORD_REFUND',{orderId,amountMinor,method:'CHANNEL',referencesFactId:source.id,refundReference,note:'独立退款一致性验证',businessDate:today},runtimeDb);
  }
  async function assertBoundReceipt(fact:any){
    const row=(await client.query(`SELECT c.state,r.execution_status,r.business_committed,r.result,a.payload FROM command_executions c
      JOIN command_receipts r ON r.command_id=c.id JOIN amendments a ON a.command_id=c.id AND a.order_id=$2 WHERE c.id=$1`,[fact.command_id,fact.order_id])).rows[0];
    assert.ok(row);assert.equal(row.state,'APPLIED');assert.equal(row.execution_status,'EXECUTED');assert.equal(row.business_committed,true);
    assert.equal(row.result.factId,fact.id);assert.equal(row.payload.channelOperating,true);
    assert.equal(row.payload.contractTargetMinor-row.payload.contractBeforeMinor,fact.contract_effect_minor);
  }
  let activeOrderId:string|undefined;
  let activeRefundId:string|undefined;
  await check('未取消订单部分退款同步应结200元，OrderView可读，库存不变',async()=>{
    activeOrderId=await create(30000);const before=await business(activeOrderId);
    const r=await channelRefund(activeOrderId,10000,'ISO-ACTIVE-PARTIAL');activeRefundId=r.receipt.result.factId;
    const after=await business(activeOrderId);assertFundsTransition(before.order,after.order,20000,'RECORD_REFUND');assert.deepEqual(after.collections,before.collections);
    assert.deepEqual(after.facts.filter(f=>f.id!==activeRefundId),before.facts);
    const f=after.facts.find(f=>f.id===activeRefundId)!;assert.equal(f.amount_minor,-10000);assert.equal(f.contract_effect_minor,-10000);await assertBoundReceipt(f);
    assert.equal((await r.repeat()).commandId,r.receipt.commandId);assert.deepEqual(await business(activeOrderId),after);
    const view=await getOrderView(runtimeDb!,activeOrderId,'WRITE',grants);assert.equal(view.order.status,'RESERVED');assert.equal(view.order.current_contract_amount_minor,20000);assert.equal(view.channelOperating.netMinor,'20000');
    assert.equal(view.allowedActions.find((a:any)=>a.code==='RECORD_REFUND')?.enabled,true);
    evidence('active-partial-refund-order-view',view);evidence('active-partial-refund',{before,after,receipt:r.receipt});
  });
  await check('撤销部分退款仅恢复其实际应结变化，原事实/修订保留且幂等',async()=>{
    assert.ok(activeOrderId&&activeRefundId);const before=await business(activeOrderId);
    const r=await command('REVERSE_FACT',{orderId:activeOrderId,reversesFactId:activeRefundId,note:'合成退款误录撤销'},runtimeDb);
    const after=await business(activeOrderId);assertFundsTransition(before.order,after.order,30000,'REVERSE_FACT');assert.deepEqual(after.collections,before.collections);
    assert.deepEqual(after.facts.filter(f=>f.id!==r.receipt.result.factId),before.facts);
    const f=after.facts.find(f=>f.id===r.receipt.result.factId)!;assert.equal(f.amount_minor,10000);assert.equal(f.contract_effect_minor,10000);await assertBoundReceipt(f);
    assert.equal(after.refundClaims.filter((c:any)=>c.fact_id===activeRefundId).length,0);
    assert.equal((await r.repeat()).commandId,r.receipt.commandId);assert.deepEqual(await business(activeOrderId),after);
    const view=await getOrderView(runtimeDb!,activeOrderId,'WRITE',grants);assert.equal(view.order.current_contract_amount_minor,30000);assert.equal(view.channelOperating.netMinor,'30000');evidence('active-reversal-order-view',view);
  });
  let movedId:string|undefined;
  let movedRefundId:string|undefined;
  await check('退款后同应结金额换房不得重复计入已退旧金额',async()=>{
    movedId=await create(30000);movedRefundId=(await channelRefund(movedId,10000,'ISO-MOVE-REFUND')).receipt.result.factId;
    await db.insertInto('inventory_units').values({id:'iso-move-room',property_id:'iso-property',kind:'ROOM',code:'ISO-MOVE',name:'合成换房目标'}).execute();
    const before=await facts(movedId);
    await command('MOVE_UNIT',{orderId:movedId,newInventoryUnitId:'iso-move-room',effectiveDate:today,targetCurrentContractAmountMinor:20000,channelPriceDifferenceReason:'退款后的应结保持200元'},runtimeDb);
    assert.deepEqual(await facts(movedId),before);const view=await getOrderView(runtimeDb!,movedId,'WRITE',grants);
    assert.equal(view.order.current_contract_amount_minor,20000);assert.equal(view.channelOperating.netMinor,'20000');evidence('same-price-move-view',view);
  });
  await check('退款后同应结金额续住不得重复计入已退旧金额',async()=>{
    assert.ok(movedId);await command('CHECK_IN',{orderId:movedId},runtimeDb);const before=await facts(movedId);
    await command('EXTEND_STAY',{orderId:movedId,newDepartureDate:day(2),targetCurrentContractAmountMinor:20000,channelPriceDifferenceReason:'合成同价延住，不新增成交'},runtimeDb);
    assert.deepEqual(await facts(movedId),before);const view=await getOrderView(runtimeDb!,movedId,'WRITE',grants);
    assert.equal(view.order.status,'CHECKED_IN');assert.equal(view.order.departure_date,day(2));assert.equal(view.order.current_contract_amount_minor,20000);assert.equal(view.channelOperating.netMinor,'20000');evidence('same-price-extend-view',view);
  });
  await check('退款后有同价住宿定价修订，旧退款仍拒绝自动恢复',async()=>{
    assert.ok(movedId&&movedRefundId);await rejectsUnchanged(movedId,{reversesFactId:movedRefundId,note:'不应自动撤销'},'AGGREGATE_VERSION_CONFLICT',/新的渠道定价/,'REVERSE_FACT');
  });
  await check('退款后REPRICE_ORDER更正金额，旧退款拒绝自动恢复',async()=>{
    const orderId=await create(30000);const refunded=await channelRefund(orderId,10000,'ISO-REPRICE-REFUND');
    await command('REPRICE_ORDER',{orderId,targetCurrentContractAmountMinor:21000},runtimeDb);
    await rejectsUnchanged(orderId,{reversesFactId:refunded.receipt.result.factId,note:'不应自动恢复旧退款'},'AGGREGATE_VERSION_CONFLICT',/已有渠道成交或金额更正/,'REVERSE_FACT');
  });
  await check('两订单并发同平台退款号最多一笔提交，失败方无事实和claim',async()=>{
    const ids=[await create(30000),await create(30000)];const reference='ISO-CONCURRENT-REFUND';
    const before=await Promise.all(ids.map(business));
    // 两份有效Preview均先完成，再并发Confirm，避免第二份仅在Preview阶段被挡。
    const prepared=[];
    for(const orderId of ids){const source=(await facts(orderId)).find(f=>f.kind==='SALE')!;
      const envelope={commandType:'RECORD_REFUND',input:{propertyId:'iso-property',orderId,amountMinor:1000,method:'CHANNEL',referencesFactId:source.id,refundReference:reference,note:'并发相同退款号',businessDate:today}};
      const preview=await createCommandPreview(runtimeDb!,principal,envelope,metadata());
      prepared.push({preview,body:{propertyId:'iso-property',commandType:'RECORD_REFUND',confirmation:true,expectedEffectHash:preview.preview.effectHash,reason},meta:metadata()});
    }
    const results=await Promise.allSettled(prepared.map(p=>confirmCommandPreview(runtimeDb!,principal,p.preview.preview.previewId,p.body,p.meta)));
    const outcomes=results.map(r=>r.status==='fulfilled'?{status:r.status,receipt:r.value}:{status:r.status,error:{code:r.reason?.code,message:r.reason?.message}});
    evidence('concurrent-refunds',{ids,outcomes});
    const winners=results.flatMap((r,i)=>r.status==='fulfilled'&&r.value.businessCommitted?[i]:[]);assert.equal(winners.length,1);
    const winner=winners[0]!;const loser=1-winner;
    const rows=(await client.query('SELECT * FROM channel_refund_claims WHERE refund_reference=$1',[reference])).rows;assert.equal(rows.length,1);
    const winnerFact=(await facts(ids[winner]!)).find(f=>f.kind==='REFUND')!;assert.equal(rows[0].fact_id,winnerFact.id);await assertBoundReceipt(winnerFact);
    const loserAfter=await business(ids[loser]!);assert.deepEqual(loserAfter.order,before[loser]!.order);assert.deepEqual(loserAfter.facts,before[loser]!.facts);assert.deepEqual(loserAfter.collections,before[loser]!.collections);
    const r=await command('REVERSE_FACT',{orderId:ids[winner],reversesFactId:winnerFact.id,note:'释放并发测试误录退款号'},runtimeDb);assert.ok(r.receipt.businessCommitted);
    assert.equal((await client.query('SELECT * FROM channel_refund_claims WHERE refund_reference=$1',[reference])).rowCount,0);
    const retry=await channelRefund(ids[loser]!,1000,reference);assert.equal(retry.receipt.businessCommitted,true);
    assert.equal((await client.query('SELECT fact_id FROM channel_refund_claims WHERE refund_reference=$1',[reference])).rows[0].fact_id,retry.receipt.result.factId);
  });
  await check('延迟提交拒绝孤立事实/非APPLIED/错绑回执，回滚不遗留claim',async()=>{
    const orderId=await create(30000);const source=(await facts(orderId)).find(f=>f.kind==='SALE')!;
    const attempts:Array<{mode:string;code:string;message:string}>=[];
    for(const mode of ['missing-receipt','executing-command','wrong-fact-id','missing-funds-amendment']){
      const before=await business(orderId);const prefix=`iso-orphan-${mode}`;await client.query('BEGIN');
      try{
        await client.query(`INSERT INTO command_executions(id,subject_id,credential_id,property_id,command_type,idempotency_key,request_hash,correlation_id,state)
          VALUES($1,'iso-user','iso-session','iso-property','RECORD_REFUND',$1,repeat('d',64),$1,'EXECUTING')`,[prefix]);
        await client.query(`INSERT INTO channel_operating_facts(id,property_id,order_id,kind,amount_minor,contract_effect_minor,currency,business_date,references_fact_id,refund_reference,command_id,note)
          VALUES($1,'iso-property',$2,'REFUND',-1000,-1000,'CNY',$3,$4,$5,$5,'合成孤立事实提交挑战')`,[`${prefix}-fact`,orderId,today,source.id,prefix]);
        assert.equal((await client.query('SELECT 1 FROM channel_refund_claims WHERE refund_reference=$1',[prefix])).rowCount,1,'事务内应已占用退款号');
        if(mode!=='missing-receipt'){
          if(mode!=='executing-command')await client.query("UPDATE command_executions SET state='APPLIED',completed_at=now() WHERE id=$1",[prefix]);
          await client.query(`INSERT INTO command_receipts(id,command_id,execution_status,business_committed,result,resource_refs,fact_refs,committed_at)
            VALUES($1,$2,'EXECUTED',true,$3,'[]','[]',now())`,[`${prefix}-receipt`,prefix,JSON.stringify({factId:mode==='wrong-fact-id'?'wrong-id':`${prefix}-fact`})]);
        }
        await assert.rejects(client.query('COMMIT'),(error:any)=>{
          const expected=mode==='missing-receipt'||mode==='missing-funds-amendment'?'P0002':'23514';assert.equal(error.code,expected);attempts.push({mode,code:error.code,message:error.message});return true;
        });
      }finally{await client.query('ROLLBACK');}
      assert.deepEqual(await business(orderId),before);assert.equal((await client.query('SELECT 1 FROM command_executions WHERE id=$1',[prefix])).rowCount,0);
    }
    evidence('deferred-commit-rollback',attempts);
    const reused=await channelRefund(orderId,1000,'iso-orphan-missing-receipt');assert.equal(reused.receipt.businessCommitted,true);
  });
  for(const [original,target] of [[161000,161028],[27600,27720]] as const)await check(`已退房渠道REPRICE ${original}→${target} 写入/终态读回/幂等/纠错汇总`,async()=>{
    const orderId=await create(original);await clock(day(0),()=>command('CHECK_IN',{orderId},runtimeDb));await clock(day(1),()=>command('CHECK_OUT',{orderId},runtimeDb));
    const before=await business(orderId);const beforeView=await getOrderView(runtimeDb!,orderId,'WRITE',grants);const salesBefore=await readSales();
    const result=await command('REPRICE_ORDER',{orderId,targetCurrentContractAmountMinor:target},runtimeDb);const after=await business(orderId);
    assert.equal(after.order.order.status,'CHECKED_OUT');assert.equal(after.order.order.version,before.order.order.version+1);
    for(const key of ['stay','claims','roomDays','segments'])assert.deepEqual(after.order[key],before.order[key]);
    assert.deepEqual(after.order.revisions.slice(0,-1),before.order.revisions);assert.deepEqual(after.order.amendments.slice(0,-1),before.order.amendments);
    assert.equal(after.order.revisions.at(-1).current_contract_amount_minor,target);assert.deepEqual(after.collections,before.collections);
    assert.equal((await result.repeat()).commandId,result.receipt.commandId);assert.deepEqual(await business(orderId),after);
    const view=await getOrderView(runtimeDb!,orderId,'WRITE',grants);assert.equal(view.order.status,'CHECKED_OUT');assert.equal(view.order.current_contract_amount_minor,target);
    assert.deepEqual(view.fulfillment,beforeView.fulfillment);assert.deepEqual(view.effectiveArrangement,beforeView.effectiveArrangement);
    const salesAfter=await readSales();assert.equal(BigInt(salesAfter.summary.totals[0].netMinor)-BigInt(salesBefore.summary.totals[0].netMinor),BigInt(target-original));
    assert.equal(BigInt(salesAfter.summary.totals[0].correctedMinor)-BigInt(salesBefore.summary.totals[0].correctedMinor),BigInt(target-original));
    assert.ok(salesAfter.events.some((event:any)=>event.orderId===orderId&&event.kind==='CORRECTION'&&event.amountMinor===String(target-original)));
    evidence(`checked-out-reprice-${original}-order-view`,view);evidence(`checked-out-reprice-${original}`,{before,after,salesBefore,salesAfter});
  });
  await check('已退房渠道退款及撤销均能终态读回，严格保持履约及库存',async()=>{
    const orderId=await create(30000);await clock(day(0),()=>command('CHECK_IN',{orderId},runtimeDb));await clock(day(1),()=>command('CHECK_OUT',{orderId},runtimeDb));
    const before=await business(orderId);const beforeView=await getOrderView(runtimeDb!,orderId,'WRITE',grants);
    const refunded=await channelRefund(orderId,10000,'ISO-CHECKEDOUT-REFUND');const after=await business(orderId);assertFundsTransition(before.order,after.order,20000,'RECORD_REFUND');
    const refundedView=await getOrderView(runtimeDb!,orderId,'WRITE',grants);assert.equal(refundedView.order.status,'CHECKED_OUT');assert.equal(refundedView.order.current_contract_amount_minor,20000);
    assert.deepEqual(refundedView.fulfillment,beforeView.fulfillment);assert.deepEqual(refundedView.effectiveArrangement,beforeView.effectiveArrangement);
    const reversed=await command('REVERSE_FACT',{orderId,reversesFactId:refunded.receipt.result.factId,note:'合成终态退款误录撤销'},runtimeDb);
    const restored=await business(orderId);assertFundsTransition(after.order,restored.order,30000,'REVERSE_FACT');assert.deepEqual(restored.collections,before.collections);
    const reversedView=await getOrderView(runtimeDb!,orderId,'WRITE',grants);assert.equal(reversedView.order.status,'CHECKED_OUT');assert.equal(reversedView.order.current_contract_amount_minor,30000);
    assert.deepEqual(reversedView.fulfillment,beforeView.fulfillment);assert.deepEqual(reversedView.effectiveArrangement,beforeView.effectiveArrangement);
    assert.equal((await reversed.repeat()).commandId,reversed.receipt.commandId);assert.deepEqual(await business(orderId),restored);
    evidence('checked-out-refunded-order-view',refundedView);evidence('checked-out-reversed-order-view',reversedView);
  });
  await check('已取消渠道退款/撤销后正式终态读回，不恢复0合同',async()=>{
    const view=await getOrderView(runtimeDb!,id,'WRITE',grants);assert.equal(view.order.status,'CANCELLED');assert.equal(view.order.current_contract_amount_minor,0);
    assert.ok(view.amendments.some((a:any)=>a.amendment_type==='RECORD_REFUND'));assert.ok(view.amendments.some((a:any)=>a.amendment_type==='REVERSE_FACT'));
    evidence('cancelled-after-funds-order-view',view);
  });
  await check('真实渠道边界：非渠道已退房与渠道已取消仍禁止REPRICE',async()=>{
    await rejectsUnchanged(id,{targetCurrentContractAmountMinor:27720},'INVALID_ORDER_STATE',/CANCELLED/,'REPRICE_ORDER');
    const orderId=await create(30000,'WECOM');await clock(day(0),()=>command('CHECK_IN',{orderId},runtimeDb));await clock(day(1),()=>command('CHECK_OUT',{orderId},runtimeDb));
    await rejectsUnchanged(orderId,{targetCurrentContractAmountMinor:30100},'INVALID_ORDER_STATE',/CHECKED_OUT/,'REPRICE_ORDER');
    const view=await getOrderView(runtimeDb!,orderId,'WRITE',grants);assert.equal(view.order.status,'CHECKED_OUT');assert.equal(view.order.current_contract_amount_minor,30000);
  });
  await check('STAY_FACT opening解除分配后同bill重配不新增收入；initializer原计划仍幂等',async()=>{
    const before=await readSales();const setupBefore=await setupState();
    await command('REVERSE_FACT',{orderId:carriedOrderId,reversesFactId:carriedFactId,releaseExternalPaymentAllocation:true,note:'合成期初来源解除归属'},runtimeDb);
    const rerun=initialize(['--apply','--expected-sha',sha]);assert.equal(rerun.status,0,rerun.stderr);assert.deepEqual(await setupState(),setupBefore);
    const newOrder=await create(30000,'WECOM');const matched=await command('RECORD_COLLECTION',{orderId:newOrder,amountMinor:30000,method:'WECOM',transactionReference:'iso-carry-bill',externalPaymentBillId:'iso-carry-bill',note:'同流水重配'},runtimeDb);
    assert.notEqual(matched.receipt.result.factId,carriedFactId);const after=await readSales();assert.equal(after.summary.totals[0].netMinor,before.summary.totals[0].netMinor);
    assert.ok(!after.events.some((e:any)=>e.id===`STAY:${matched.receipt.result.factId}`));evidence('stay-opening-rematch',{before,after,originalFactId:carriedFactId,newFactId:matched.receipt.result.factId,initializer:JSON.parse(rerun.stdout)});
  });
  await check('MEMBER_FACT opening冲销替换同bill两次不新增收入；initializer原计划仍幂等',async()=>{
    const before=await readSales();const setupBefore=await setupState();let original=carriedMemberFactId;
    const replacements=[];
    for(let i=1;i<=2;i++){
      const r=await command('CORRECT_MEMBERSHIP_PAYMENT',{membershipOrderId:carriedMembershipId,originalPaymentFactId:original,correctedAmountMinor:30000,correctedTransactionReference:'iso-member-opening-bill',note:`期初会员备注更正${i}`},runtimeDb);
      original=r.receipt.result.replacementFactId;replacements.push(r.receipt.result);
      const after=await readSales();assert.equal(after.summary.totals[0].netMinor,before.summary.totals[0].netMinor);assert.ok(!after.events.some((e:any)=>e.id===`MEMBER:${original}`));
    }
    const rerun=initialize(['--apply','--expected-sha',sha]);assert.equal(rerun.status,0,rerun.stderr);assert.deepEqual(await setupState(),setupBefore);
    evidence('member-opening-replacements',{before,after:await readSales(),replacements,initializer:JSON.parse(rerun.stdout)});
  });
  await check('住宿转会员后原住宿收入保留，内部会员转款不新增',async()=>{
    const member=(await command('CREATE_MEMBER',{fullName:'合成转会员',nickname:'合成转会员',phone:'13900000003',wechat:'iso-conversion'})).receipt.result.memberId;
    const stay=await create(30000,'WECOM',0,{phone:'13900000003',roomType:'shared_bath_single'});await bill('iso-convert-bill',30000);
    const payment=await command('RECORD_COLLECTION',{orderId:stay,amountMinor:30000,method:'WECOM',transactionReference:'iso-convert-bill',externalPaymentBillId:'iso-convert-bill',note:'完整住宿收款转会员'},runtimeDb);
    await command('CHECK_IN',{orderId:stay},runtimeDb);await clock(day(1),()=>command('CHECK_OUT',{orderId:stay},runtimeDb));
    const before=await readSales();const sourceEvent=before.events.find((e:any)=>e.id===`STAY:${payment.receipt.result.factId}`);assert.ok(sourceEvent);assert.equal(sourceEvent.amountMinor,'30000');
    const converted=await clock(day(1),()=>command('CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP',{orderId:stay,memberId:member,membershipProductId:'membership_product_shared_bath_single_v1',collectionFactIds:[payment.receipt.result.factId],agreedPriceMinor:30000,priceAdjustmentReason:'合成全额300元转会员'},runtimeDb));
    const after=await readSales();assert.equal(after.summary.totals[0].netMinor,before.summary.totals[0].netMinor);assert.deepEqual(after.events.find((e:any)=>e.id===sourceEvent.id),sourceEvent);
    const transfers=(await client.query('SELECT * FROM stay_collection_membership_transfers WHERE order_id=$1',[stay])).rows;assert.equal(transfers.length,1);
    assert.ok(!after.events.some((e:any)=>e.id===`MEMBER:${transfers[0].membership_payment_fact_id}`));evidence('stay-to-member-income',{before,after,transfers,receipt:converted.receipt});
  });
  await check('会员连续两次note更正保留首次匹配日期（真实SQL跨日期投影）',async()=>{
    const member=(await command('CREATE_MEMBER',{fullName:'合成日期会员',nickname:'合成日期会员',phone:'13900000004',wechat:'iso-note-dates'})).receipt.result.memberId;
    const membership=(await command('CREATE_MEMBERSHIP_ORDER',{memberId:member,membershipProductId:'membership_product_shared_bath_single_v1',agreedPriceMinor:31000,priceAdjustmentReason:'合成日期会员价'})).receipt.result.membershipOrderId;
    await bill('iso-note-bill',31000);const paid=await command('RECORD_MEMBERSHIP_PAYMENT',{membershipOrderId:membership,amountMinor:31000,transactionReference:'iso-note-bill',note:'原备注'},runtimeDb);
    const firstId=paid.receipt.result.paymentFactId;const first=(await client.query('SELECT created_at FROM membership_payment_facts WHERE fact_id=$1',[firstId])).rows[0];
    // 不改事实时间。选取合法PostgreSQL固定偏移，将原记录与后续更正分隔到两个投影日期。
    const boundary=new Date(Math.ceil(new Date(first.created_at).getTime()/1000)*1000);
    const zone=`UTC+${boundary.toISOString().slice(11,19)}`;
    await new Promise(resolve=>setTimeout(resolve,1100));
    let previous=firstId;const replacements=[];
    for(let i=1;i<=2;i++){
      const r=await command('CORRECT_MEMBERSHIP_PAYMENT',{membershipOrderId:membership,originalPaymentFactId:previous,correctedAmountMinor:31000,correctedTransactionReference:'iso-note-bill',note:`仅备注更正${i}`},runtimeDb);
      previous=r.receipt.result.replacementFactId;replacements.push(r.receipt.result);
    }
    const dates=(await client.query("SELECT fact_id,to_char(created_at AT TIME ZONE $1,'YYYY-MM-DD') AS date FROM membership_payment_facts WHERE fact_id=ANY($2)",[zone,[firstId,previous]])).rows;
    const firstDate=dates.find(d=>d.fact_id===firstId)!.date;const lastDate=dates.find(d=>d.fact_id===previous)!.date;assert.notEqual(firstDate,lastDate,'日期探针必须区分首次与后续记录');
    const result:any=await db.transaction().execute(trx=>loadOperatingSales(trx,'iso-property',zone,'CNY',{from:firstDate,to:lastDate},lastDate));
    const events=result.events.filter((e:any)=>e.memberId===member);assert.equal(events.length,1);assert.equal(events[0].id,`MEMBER:${previous}`);assert.equal(events[0].date,firstDate);assert.equal(events[0].amountMinor,'31000');
    evidence('member-two-note-corrections-date',{zone,firstId,latestId:previous,firstDate,lastDate,replacements,events,explanation:'正式命令均用真实记录时间，仅SQL读取使用固定偏移日期边界，未改数据库时钟或事实'});
  });
  let gapContext:any;
  await check('新CHANNEL_REFUND opening使current contract大于net：拒绝且零写',async()=>{
    const propertyId='iso-gap-property';
    await client.query(`INSERT INTO properties(id,code,name,timezone,currency) VALUES('iso-gap-property','ISO-GAP','合成期初读回门店','Asia/Shanghai','CNY');
      INSERT INTO inventory_units(id,property_id,kind,code,name) VALUES('iso-gap-room','iso-gap-property','ROOM','ISO-GAP-ROOM','合成期初客房');
      INSERT INTO pricing_policy_versions(id,property_id,code,version,stay_type,calculation_kind,nightly_rate_minor,currency) VALUES('iso-gap-policy','iso-gap-property','ISO-GAP-FLAT',1,'TRANSIENT','FLAT_NIGHTLY',30000,'CNY');
      INSERT INTO subject_property_grants(subject_id,property_id,access_level) VALUES('iso-user','iso-gap-property','WRITE');
      INSERT INTO subject_command_grants(subject_id,property_id,command_type) SELECT subject_id,'iso-gap-property',command_type FROM subject_command_grants WHERE subject_id='iso-user' AND property_id='iso-property';`);
    principal.propertyAccess.set(propertyId,'WRITE');principal.propertyCommandGrants.set(propertyId,grants);
    const quote=await createQuoteForTesting(db,{propertyId,inventoryUnitId:'iso-gap-room',arrivalDate:today,departureDate:day(1),pricingPolicyVersionId:'iso-gap-policy'});
    const created=await command('CREATE_ORDER',{propertyId,quoteId:quote.quoteId,primaryGuest:{fullName:'合成期初客人',nickname:'合成期初客人'},bookingChannelCode:'YOUMUDAO',channelOrderReference:'ISO-GAP-CHANNEL',targetCurrentContractAmountMinor:30000},runtimeDb);
    const orderId=created.receipt.result.orderId;const source=(await facts(orderId)).find(f=>f.kind==='SALE')!;
    const gapPlan={propertyId,recognitionFrom:'2026-10-01',currency:'CNY',baselines:[{month:'2026-09-01',amountMinor:'0',evidenceNote:'合成封账'}],opening:[{sourceKind:'CHANNEL_REFUND',sourceId:orderId,amountMinor:'10000',evidenceNote:'合成历史退款已承接，旧合同仍300元'}]};
    const data=JSON.stringify(gapPlan);const path=join(work,'opening-contract-gap-plan.json');writeFileSync(path,data);

    gapContext={propertyId,orderId,path,data,source};const before=await business(orderId);const stateBefore=await setupState();
    for(const flags of [[],['--apply','--expected-sha',createHash('sha256').update(data).digest('hex')]]){
      const r=initialize(flags,'isolated_owner',path);assert.equal(r.status,1);assert.match(r.stderr,/期初退款与当前渠道应结不一致/);
      assert.deepEqual(await business(orderId),before);assert.deepEqual(await setupState(),stateBefore);
    }
    evidence('opening-gap-rejected',{before,stateBefore,after:await business(orderId),stateAfter:await setupState()});
  });
  await check('current contract200/net200正式退款50只降50且可读',async()=>{
    assert.ok(gapContext);const {propertyId,orderId,path,data,source}=gapContext;
    await client.query("INSERT INTO inventory_units(id,property_id,kind,code,name) VALUES('iso-gap-move','iso-gap-property','ROOM','ISO-GAP-MOVE','合成历史应结调整房')");
    await command('MOVE_UNIT',{propertyId,orderId,newInventoryUnitId:'iso-gap-move',effectiveDate:today,targetCurrentContractAmountMinor:20000,channelPriceDifferenceReason:'合成历史应结已核实为200元'},runtimeDb);
    const initialized=initialize(['--apply','--expected-sha',createHash('sha256').update(data).digest('hex')],'isolated_owner',path);assert.equal(initialized.status,0,initialized.stderr);
    const before=await business(orderId);assert.equal(before.order.revisions.at(-1).current_contract_amount_minor,20000);assert.equal((await channelOperatingSummary(db,propertyId,orderId)).netMinor,'20000');
    const result=await command('RECORD_REFUND',{propertyId,orderId,amountMinor:5000,method:'CHANNEL',referencesFactId:source.id,refundReference:'ISO-OPENING-CONSISTENT',note:'一致余额退款50元',businessDate:today},runtimeDb);
    const after=await business(orderId);assertFundsTransition(before.order,after.order,15000,'RECORD_REFUND');assert.equal(after.facts.find(f=>f.id===result.receipt.result.factId)!.contract_effect_minor,-5000);
    const view=await getOrderView(runtimeDb!,orderId,'WRITE',grants);assert.equal(view.order.current_contract_amount_minor,15000);assert.equal(view.channelOperating.netMinor,'15000');
    evidence('opening-consistent-order-view',view);evidence('opening-consistent-refund',{before,after,receipt:result.receipt});
  });
  await check("执行后operatingSalesReady仍返回true",async()=>{assert.equal(await operatingSalesReady(db),true);assert.equal(await operatingSalesReady(runtimeDb!),true);});
  missing.push('未覆盖历史已有订单072迁移回填、同一订单不同退款号并发、住宿转会员完整内部转款/解除重匹配组合、HTTP/UI；未接触生产或既有库');


}
}
main().catch(error => { console.error(error); process.exitCode = 1; });

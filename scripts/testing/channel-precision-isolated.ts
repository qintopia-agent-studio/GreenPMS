/**
 * 独立验证：node --import tsx scripts/testing/channel-precision-isolated.ts [已提交 ref]
 * 只创建全新本地 cluster；不读取环境数据库配置、不调用 reset/seed。
 * 每次保留快照、迁移日志、检查日志及已停止的 cluster 于 .local-workspace/。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, appendFileSync, symlinkSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import pg from "pg";
import { Kysely, PostgresDialect } from "kysely";

async function main() {
const root = resolve(__dirname, "../..");
// 子进程环境使用允许清单，排除 PG*/DATABASE_URL、启动钩子和所有凭据配置。
const env = { PATH: process.env.PATH!, LANG: "C", LC_ALL: "C", TZ: "Asia/Shanghai", PGPASSFILE: "/dev/null", PGSERVICEFILE: "/dev/null" };
function run(bin: string, args: string[], options: { cwd?: string; input?: Buffer | string } = {}) {
  const result = spawnSync(bin, args, { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${bin} ${args.join(" ")}\n${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
const revision = run("git", ["rev-parse", "--verify", `${process.argv[2] ?? "HEAD"}^{commit}`], { cwd: root }).trim();
run("git", ["check-ignore", ".local-workspace/channel-precision-validation"], { cwd: root });
const base = join(root, ".local-workspace/channel-precision-validation");
mkdirSync(base, { recursive: true });
const work = mkdtempSync(join(base, "run-"));
writeFileSync(join(work,"script.ts"),readFileSync(__filename));
const log = (text: string) => { console.log(text); appendFileSync(join(work, "checks.log"), `${text}\n`); };
const snapshot = join(work, "source");
mkdirSync(snapshot);
const archive = spawnSync("git", ["archive", revision, "packages", "package.json", "tsconfig.json"], { cwd: root, env, maxBuffer: 64 * 1024 * 1024 });
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
const config = { host: "127.0.0.1", port, user: "isolated_owner", password: "isolated-synthetic-only", ssl: false, database: "channel_precision_isolated", connectionTimeoutMillis: 5000, statement_timeout: 15000 };
let client: pg.Client | undefined;
let db: Kysely<any> | undefined;
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
    await admin.query('CREATE DATABASE channel_precision_isolated');
  } finally { await admin.end(); }
  client = new pg.Client(config);
  await client.connect();
  pg.types.setTypeParser(1082, value => value);
  const migrations = join(snapshot, "packages/db/src/migrations");
  const names = readdirSync(migrations).filter(name => /^\d+.*\.sql$/.test(name)).sort();
  assert.ok(names.includes("071_channel_amount_precision.sql"));
  const functions = ["qintopia_validate_stage9_pricing_revision", "qintopia_validate_stage10_pricing_revision", "qintopia_validate_stage11_move_revision"];
  const definitions = async () => (await client!.query("SELECT proname,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE proname=ANY($1) ORDER BY proname",[functions])).rows;
  let before071: { proname: string; definition: string }[] = [];
  for (const name of names) {
    if (name === "071_channel_amount_precision.sql") before071 = await definitions();
    const output = run(join(bin, "psql"), ["-X", "-w", "-h", config.host, "-p", String(port), "-U", config.user, "-d", config.database, "-v", "ON_ERROR_STOP=1", "-1", "-f", join(migrations, name)]);
    appendFileSync(join(work, "migrations.log"), `\n${name}\n${output}`);
    await client.query("INSERT INTO schema_migrations(name) VALUES($1) ON CONFLICT DO NOTHING", [name]);
  }
  const after071 = await definitions();
  writeFileSync(join(work,"trigger-definitions.json"),JSON.stringify({before071,after071},null,2));
  await check("071 函数定义除渠道角分条件与对应错误文案外保持一致",async () => {
    assert.equal(before071.length,3);
    assert.equal(after071.length,3);
    const normalize = (text: string) => text
      .replace(/\(COALESCE\((?:channel_code|target_order\.booking_channel_code), ''\) NOT IN \('YOUMUDAO', 'CTRIP', 'MEITUAN'\)\s+AND mod\(NEW\.current_contract_amount_minor, 100\) <> 0\)/g,"mod(NEW.current_contract_amount_minor, 100) <> 0")
      .replace(/must be a supported non-negative amount \(non-channel amounts require whole yuan\)/g,"must be a non-negative whole-yuan PostgreSQL integer");
    assert.deepEqual(after071.map(row => [row.proname,normalize(row.definition)]),before071.map(row => [row.proname,row.definition]));
  });
  log(`PASS 全新数据库应用 ${names.length} 个已提交迁移（含071）`);
  db = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool(config) }) });
  await verify(client, db);
} catch (error) {
  failed++;
  log(`FAIL 执行中断\n${error instanceof Error ? error.stack : String(error)}`);
} finally {
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
      SELECT 'iso-user','iso-property',unnest(ARRAY['CREATE_ORDER','CHECK_IN','CHECK_OUT','REPRICE_ORDER','CANCEL_ORDER']);
  `);
  // 直接写真实表检验即时触发器；各场景回滚，不宣称完整住宿变更的延迟提交守卫已覆盖。
  const todaySql = (await client.query("SELECT qintopia_stage10_property_today('iso-property')::text AS day")).rows[0].day;
  const triggerDay = (offset: number) => new Date(Date.parse(`${todaySql}T00:00:00Z`) + offset * 86400000).toISOString().slice(0,10);
  let probe = 0;
  async function triggerCase(operation: string, options: { channel?: string; amount?: number; status?: string; basis?: string; note?: string; badDates?: boolean; mismatch?: boolean } = {}) {
    const id = `probe-${++probe}`;
    const channel = options.channel ?? "YOUMUDAO";
    const amount = options.amount ?? 27720;
    const status = options.status ?? (operation === "RESCHEDULE_STAY" || operation === "MOVE_UNIT" ? "RESERVED" : "CHECKED_IN");
    const arrival = triggerDay(operation === "SHORTEN_STAY" ? -2 : 0);
    const departure = triggerDay(4);
    const afterDeparture = operation === "SHORTEN_STAY" ? triggerDay(2) : departure;
    const payload = { operation, completionMode: "SHORTEN_IN_HOUSE", effectiveDate: options.badDates ? "not-a-date" : triggerDay(0),
      before: { arrivalDate: arrival, departureDate: departure }, after: { arrivalDate: arrival, departureDate: options.badDates ? departure : afterDeparture },
      pricingDecision: { reason: { note: options.note ?? "独立测试偏差说明" } } };
    await client.query("BEGIN");
    try {
      await client.query(`INSERT INTO orders(id,property_id,status,stay_type,arrival_date,departure_date,primary_guest_snapshot,pricing_policy_version_id,booking_channel_code,channel_order_reference)
        VALUES($1,'iso-property',$2,'TRANSIENT',$3,$4,'{"fullName":"合成","nickname":"合成"}','iso-policy',$5,$6)`,
        [id,status,arrival,departure,channel,channel === "WECOM" ? null : id]);
      if (options.mismatch) await client.query(`INSERT INTO orders(id,property_id,status,stay_type,arrival_date,departure_date,primary_guest_snapshot,pricing_policy_version_id,booking_channel_code,channel_order_reference)
        SELECT $2,property_id,status,stay_type,arrival_date,departure_date,primary_guest_snapshot,pricing_policy_version_id,booking_channel_code,$2 FROM orders WHERE id=$1`,[id,`${id}-other`]);
      await client.query(`INSERT INTO command_executions(id,subject_id,credential_id,property_id,command_type,idempotency_key,request_hash,correlation_id,state)
        VALUES($1,'iso-user','iso-session','iso-property',$2,$1,repeat('b',64),$1,'EXECUTING')`,[`${id}-cmd`,operation]);
      await client.query(`INSERT INTO amendments(id,order_id,sequence,amendment_type,reason_code,reason_note,prior_version,new_version,payload,command_id)
        VALUES($1,$2,1,$3,'AUTOMATED_ACCEPTANCE','独立合成',0,1,$4,$5)`,[`${id}-a`,options.mismatch ? `${id}-other` : id,operation,JSON.stringify(payload),`${id}-cmd`]);
      await client.query(`INSERT INTO pricing_revisions(id,order_id,revision_no,amendment_id,policy_version_id,arrival_date,departure_date,coverage_set,cash_lines,
        manual_adjustment_minor,current_contract_amount_minor,currency,policy_base_amount_minor,pricing_basis)
        VALUES($1,$2,2,$3,'iso-policy',$4,$5,'[]','[]',0,$6,'CNY',$7,$8)`,
        [`${id}-r`,id,`${id}-a`,arrival,afterDeparture,amount,channel === "WECOM" ? amount : 30000,options.basis ?? (channel === "WECOM" ? "POLICY" : "CHANNEL_CONTRACT")]);
    } finally { await client.query("ROLLBACK"); }
  }
  for (const operation of ["RESCHEDULE_STAY","EXTEND_STAY","SHORTEN_STAY","MOVE_UNIT"]) {
    for (const channel of ["YOUMUDAO","CTRIP","MEITUAN"]) for (const amount of [161028,27720,1]) {
      await check(`071 ${operation} ${channel} 接受 ${amount} 分（即时触发器）`, () => triggerCase(operation,{channel,amount}));
    }
    const stage = operation === "SHORTEN_STAY" ? "stage10" : "stage9";
    const prefix = operation === "MOVE_UNIT" ? "stage11_move" : `pricing_revisions_${stage}`;
    for (const amount of [27720,2147483601]) await check(`071 ${operation} 拒绝 ${amount === 27720 ? "非渠道角分" : "金额越界"}`, async () => {
      await assert.rejects(triggerCase(operation,{channel: amount === 27720 ? "WECOM" : "YOUMUDAO",amount}),{ code: "23514",constraint:`${prefix}_contract_amount` });
    });
    await check(`071 ${operation} WECOM 整元仍接受`, () => triggerCase(operation,{channel:"WECOM",amount:30000}));
    await check(`071 ${operation} 取消终态拒绝`, async () => {
      await assert.rejects(triggerCase(operation,{status:"CANCELLED"}),{code:"23514",constraint: operation === "MOVE_UNIT" ? "stage11_move_state_date_matrix" : `${prefix}_order_status`});
    });
    await check(`071 ${operation} 跨订单 amendment 拒绝`, async () => {
      await assert.rejects(triggerCase(operation,{mismatch:true}),{code:"23514",constraint: operation === "MOVE_UNIT" ? "stage11_move_state_date_matrix" : `${prefix}_amendment_order`});
    });
    await check(`071 ${operation} 渠道错误定价基础拒绝`, async () => {
      await assert.rejects(triggerCase(operation,{amount:30000,basis:"POLICY"}),{code:"23514",constraint:`${prefix}_channel_basis`});
    });
    if (operation === "SHORTEN_STAY" || operation === "MOVE_UNIT") {
      await check(`071 ${operation} 超15%缺说明拒绝`, async () => {
        await assert.rejects(triggerCase(operation,{amount:161028,note:""}),{code:"23514",constraint:`${prefix}_channel_basis`});
      });
      await check(`071 ${operation} 日期门禁保留`, async () => {
        await assert.rejects(triggerCase(operation,{badDates:true}),{code:"23514",constraint:operation === "MOVE_UNIT" ? "stage11_move_typed_effective_date" : `${prefix}_date_matrix`});
      });
    }
  }
  missing.push("改期/续住/缩短/换房仅直接验证真实表即时触发器，未跑这四类正式命令及延迟组合提交守卫");
  const moduleAt = (name: string) => import(pathToFileURL(join(snapshot, "packages/db/src", name)).href);
  const { createCommandPreview, confirmCommandPreview } = await moduleAt("commands/service.ts");
  const { createQuoteForTesting } = await moduleAt("pricing-service.ts");
  const { withPropertyClockForTesting } = await moduleAt("members.ts");
  const grants = new Set(["CREATE_ORDER", "CHECK_IN", "CHECK_OUT", "REPRICE_ORDER", "CANCEL_ORDER"]);
  const principal = { subjectId: "iso-user", credentialId: "iso-session", credentialType: "SESSION", displayName: "合成验证人员",
    propertyAccess: new Map([["iso-property", "WRITE"]]), propertyCommandGrants: new Map([["iso-property", grants]]), tokenCommandCeiling: null };
  let seq = 0;
  const metadata = () => ({ idempotencyKey: `isolated-${++seq}`, correlationId: `isolated-${seq}` });
  const reason = { code: "AUTOMATED_ACCEPTANCE", note: "独立合成渠道角分验证，非真实业务" };
  async function command(commandType: string, input: Record<string, unknown>) {
    const preview = await createCommandPreview(db, principal, { commandType, input: { propertyId: "iso-property", ...input } }, metadata());
    const body = { propertyId: "iso-property", commandType, confirmation: true, expectedEffectHash: preview.preview.effectHash, reason: commandType === "CREATE_ORDER" ? { code: "CREATE_STANDARD_ORDER", note: "" } : reason };
    const meta = metadata();
    const receipt = await confirmCommandPreview(db, principal, preview.preview.previewId, body, meta);
    assert.equal(receipt.businessCommitted, true, JSON.stringify(receipt));
    return { receipt, preview, repeat: () => confirmCommandPreview(db, principal, preview.preview.previewId, body, meta) };
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
      targetCurrentContractAmountMinor: amount, ...(channel === "WECOM" ? {} : { channelPriceDifferenceReason: reason.note }) });
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
  for (const channel of ["YOUMUDAO","CTRIP","MEITUAN"]) for (const amount of [161028, 27720]) await check(`正式 CREATE_ORDER ${channel} 精确持久化 ${amount} 分`, async () => {
    const id = await create(amount,channel);
    const state = await snapshotOrder(id);
    assert.equal(state.revisions[0].current_contract_amount_minor, amount);
    assert.equal(state.revisions[0].pricing_basis, "CHANNEL_CONTRACT");
    assert.equal(state.revisions[0].manual_adjustment_minor, 0);
  });
  for (const [original, target] of [[161000,161028],[27600,27720]] as const) await check(`已退房 REPRICE_ORDER ${original}→${target}：旧值、库存、终态、幂等`, async () => {
    const id = await create(original);
    await clock(day(0), () => command("CHECK_IN", { orderId: id }));
    await clock(day(1), () => command("CHECK_OUT", { orderId: id }));
    const before = await snapshotOrder(id);
    assert.equal(before.order.status, "CHECKED_OUT");
    writeFileSync(join(work,`checked-out-${original}-before.json`),JSON.stringify(before,null,2));
    let result;
    try { result = await command("REPRICE_ORDER", { orderId: id, targetCurrentContractAmountMinor: target }); }
    catch (error) {
      const afterFailure = await snapshotOrder(id);
      assert.deepEqual(afterFailure,before,"失败的更正不可写入业务事实");
      writeFileSync(join(work,`checked-out-${original}-failure.json`),JSON.stringify({ error: { code: (error as any).code, message: (error as Error).message, details: (error as any).details }, businessUnchanged: true, before, afterFailure },null,2));
      missing.push(`${original}→${target}已退房更正被预览异常阻断：成功追加旧值/状态库存不变/重复确认幂等尚未验证`);
      throw error;
    }
    const after = await snapshotOrder(id);
    assert.equal(after.order.status, "CHECKED_OUT");
    assert.equal(after.order.version, before.order.version + 1);
    assert.deepEqual(after.stay, before.stay);
    assert.deepEqual(after.claims, before.claims);
    assert.deepEqual(after.roomDays,before.roomDays);
    assert.deepEqual(after.segments,before.segments);
    assert.deepEqual(after.revisions.slice(0,-1), before.revisions);
    assert.deepEqual(after.amendments.slice(0,-1), before.amendments);
    assert.equal(after.revisions.at(-1).current_contract_amount_minor, target);
    assert.equal(after.revisions.at(-1).pricing_basis, "CHANNEL_CONTRACT");
    assert.equal(after.amendments.at(-1).reason_note, reason.note);
    const repeated = await result.repeat();
    assert.equal(repeated.commandId, result.receipt.commandId);
    assert.deepEqual(await snapshotOrder(id), after);
  });
  await check("在订渠道 REPRICE_ORDER 对照：追加修订、保留原值、重复确认幂等", async () => {
    const id = await create(27600);
    const before = await snapshotOrder(id);
    const result = await command("REPRICE_ORDER",{orderId:id,targetCurrentContractAmountMinor:27720});
    const after = await snapshotOrder(id);
    assert.equal(after.revisions.at(-1).current_contract_amount_minor,27720);
    assert.deepEqual(after.revisions.slice(0,-1),before.revisions);
    assert.deepEqual(after.claims,before.claims);
    assert.deepEqual(after.roomDays,before.roomDays);
    assert.deepEqual(after.segments,before.segments);
    assert.equal(after.order.status,"RESERVED");
    assert.equal((await result.repeat()).commandId,result.receipt.commandId);
    assert.deepEqual(await snapshotOrder(id),after);
  });
  await check("非渠道 CREATE_ORDER 角分拒绝",async () => {
    const before = (await client.query("SELECT count(*) FROM orders")).rows[0].count;
    await assert.rejects(create(27720,"WECOM"),{code:"VALIDATION_ERROR"});
    assert.equal((await client.query("SELECT count(*) FROM orders")).rows[0].count,before);
  });
  await check("非渠道已退房 REPRICE_ORDER 整元仍拒绝",async () => {
    const id = await create(30000,"WECOM");
    await clock(day(0), () => command("CHECK_IN",{orderId:id}));
    await clock(day(1), () => command("CHECK_OUT",{orderId:id}));
    const before = await snapshotOrder(id);
    await assert.rejects(command("REPRICE_ORDER",{orderId:id,targetCurrentContractAmountMinor:27700}),{code:"INVALID_ORDER_STATE"});
    assert.deepEqual(await snapshotOrder(id),before);
  });
  missing.push("未执行HTTP/UI、真实模型问答、会员/免费订单全链路及并发确认；未验证主线程未提交的新销售额/退款链路");
  await check("非渠道 REPRICE_ORDER 分精度仍拒绝且业务零写入", async () => {
    const id = await create(30000,"WECOM");
    const before = await snapshotOrder(id);
    await assert.rejects(command("REPRICE_ORDER", { orderId: id, targetCurrentContractAmountMinor: 27720 }), { code: "VALIDATION_ERROR" });
    assert.deepEqual(await snapshotOrder(id),before);
  });
  await check("取消外部渠道终态 REPRICE_ORDER 仍拒绝且业务零写入", async () => {
    const id = await create(30000);
    await command("CANCEL_ORDER", { orderId: id });
    const before = await snapshotOrder(id);
    assert.equal(before.order.status,"CANCELLED");
    await assert.rejects(command("REPRICE_ORDER", { orderId: id, targetCurrentContractAmountMinor: 27720 }), { code: "INVALID_ORDER_STATE" });
    assert.deepEqual(await snapshotOrder(id),before);
  });

}

}
main().catch(error => { console.error(error); process.exitCode = 1; });

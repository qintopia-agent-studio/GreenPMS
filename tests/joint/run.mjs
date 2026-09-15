import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { preparePms, demo } from './pms-fixture.mjs';
import { prepareAgent } from './agent-fixture.mjs';
import { assertIsolation, source, property, ownerUrl, hash, tlsProxy, readProxy, until } from './support.mjs';
import { eventSignature } from '../../packages/db/src/integration-worker.ts';
import { pmsProjectionHash } from '../../packages/domain/src/pms-projection-hash.ts';

assertIsolation();
const results = [];
let pms, agent, tls, reads, mainOrder, historicalOrder, cancelledOrder;
const report = { started_at: new Date().toISOString(), pms_head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), node: process.version, cases: results };
async function test(id, title, run) {
  const started = Date.now();
  try { await run(); results.push({ id, title, status: 'passed', duration_ms: Date.now() - started }); console.log(`${id} PASS ${title}`); }
  catch (error) {
    const code = error.code === 'ERR_ASSERTION' ? 'ASSERTION_FAILED' : /^[A-Za-z0-9_ -]{1,160}$/.test(error.message) ? error.message : error.code ?? 'CASE_FAILED';
    const location = error.stack?.match(/tests\/joint\/run\.mjs:\d+:\d+/)?.[0] ?? null;
    results.push({ id, title, status: 'failed', code, location, duration_ms: Date.now() - started }); console.log(`${id} FAIL ${code} ${location ?? ''}`);
  }
}
const aQuery = async (text, args = []) => (await agent.db.query(text, args)).rows;
const pQuery = async (text, args = []) => (await pms.owner.query(text, args)).rows;
const inbox = async () => aQuery('SELECT event_id,body_hash,status FROM qintopia_agent_os.welcome_inbox WHERE source_instance=$1 AND property_id=$2', [source, property]);
const snapshot = async id => (await aQuery("SELECT revision::text,projection_hash,projection,invalidated,conflicted FROM qintopia_agent_os.welcome_source_versions WHERE source_instance=$1 AND property_id=$2 AND aggregate_type='order' AND aggregate_id=$3", [source, property, id]))[0];
const cursor = async () => (await aQuery('SELECT cursor FROM qintopia_agent_os.welcome_sources WHERE source_instance=$1 AND property_id=$2', [source, property]))[0].cursor;
const events = async () => pQuery('SELECT event_id,body,body_hash,publish_seq::text FROM integration_published_events WHERE property_id=$1 ORDER BY publish_seq', [property]);
async function delivered(id) { await until(async () => (await pQuery('SELECT state FROM integration_deliveries WHERE event_id=$1', [id]))[0]?.state === 'accepted', 'DELIVERY_NOT_ACCEPTED', 30000); }
async function drain() { await pms.publish(); await agent.pullAll(); await agent.consumeAll(); }
async function signed(body, mutate = {}) {
  const sent = String(Math.floor(Date.now() / 1000)); const delivery = randomUUID();
  const headers = { 'content-type': 'application/json', 'x-qt-key-id': 'local-synthetic', 'x-qt-sent-at': sent, 'x-qt-delivery-id': delivery, 'x-qt-signature': eventSignature(body, sent, delivery, pms.signingKey), ...mutate };
  const r = await fetch('http://127.0.0.1:18872/api/v1/ingress/pms/events', { method: 'POST', body, headers, signal: AbortSignal.timeout(6000) });
  return { status: r.status, body: await r.json() };
}
try {
  pms = await preparePms(); await pms.startApi();
  tls = await tlsProxy(); reads = await readProxy();
  agent = await prepareAgent(pms);
  report.agent_manifest = agent.manifestHash; report.agent_binary = agent.binaryHash; report.agent_source_head = agent.manifest.head;
  const common = agent.manifest.files.find(f => f.path.endsWith('/unified-person-welcome-v1-contract.md'));
  report.contract_sha256 = common.sha256;
  report.fixture_sha256 = hash(await readFile('tests/fixtures/pms-integration/order-projection.json'));
  await agent.startReceiver();
  console.log('BOTH_REAL_PROGRAMS_READY');

  await test('J01', '真实预订入住及原字节签名ACK', async () => {
    // Establish baseline with real pull; defer its webhook attempts so fault
    // injection targets a new business event, not catalog initialization.
    await drain();
    await pQuery("UPDATE integration_deliveries SET next_attempt_at=clock_timestamp()+interval '1 day'");
    const made = await pms.booking(); mainOrder = made.receipt.result.orderId;
    const before = (await pQuery('SELECT count(*)::int n FROM integration_outbox')).at(0).n;
    await made.replay();
    assert.equal((await pQuery('SELECT count(*)::int n FROM integration_outbox'))[0].n, before);
    await pms.command('CHECK_IN', { orderId: mainOrder });
    await pms.resume(); await pms.startWorker(tls.ca);
    await until(async () => (await events()).filter(e => JSON.parse(e.body).aggregate_id === mainOrder).length === 2, 'LIVE_EVENTS_NOT_PUBLISHED');
    for (const e of (await events()).filter(e => JSON.parse(e.body).aggregate_id === mainOrder)) {
      await delivered(e.event_id);
      const accepted = (await inbox()).find(i => i.event_id === e.event_id);
      assert.equal(accepted.body_hash, hash(e.body));
      assert.ok(tls.state.records.some(r => r.eventId === e.event_id && r.hash === accepted.body_hash && r.status === 202));
    }
    await agent.consumeAll();
    assert.equal((await snapshot(mainOrder)).revision, '2');
    await pms.stopWorker();
  });
  await test('J02', '签名错误与跨来源跨物业拒绝', async () => {
    const original = (await events()).find(e => JSON.parse(e.body).aggregate_id === mainOrder).body;
    const count = (await inbox()).length;
    assert.equal((await signed(original, { 'x-qt-signature': '0'.repeat(64) })).status, 401);
    for (const changed of [{ property_id: 'synthetic-other-property' }, { source_instance: 'synthetic-other-source' }]) {
      assert.equal((await signed(JSON.stringify({ ...JSON.parse(original), ...changed, event_id: randomUUID() }))).status, 403);
    }
    assert.equal((await inbox()).length, count);
    await pms.request(`/api/v1/integration-events?propertyId=synthetic-other-property`, { expected: 403 });
  });
  await test('J03', 'ACK丢失后同事件重试并保持单Inbox', async () => {
    tls.state.mode = 'drop-ack';
    const made = await pms.booking(5); const order = made.receipt.result.orderId;
    await pms.publish();
    const event = (await events()).find(e => JSON.parse(e.body).aggregate_id === order);
    await pms.startWorker(tls.ca);
    await until(async () => tls.state.records.some(r => r.eventId === event.event_id && r.status === 202 && r.dropped), 'ACK_LOSS_NOT_INJECTED');
    await pms.stopWorker();
    assert.equal((await pQuery('SELECT state FROM integration_deliveries WHERE event_id=$1', [event.event_id]))[0].state, 'pending');
    tls.state.mode = 'normal'; await agent.startReceiver(); await pms.startWorker(tls.ca);
    await delivered(event.event_id); await pms.stopWorker();
    assert.equal((await inbox()).filter(i => i.event_id === event.event_id).length, 1);
    const attempts = tls.state.records.filter(r => r.eventId === event.event_id);
    assert.ok(attempts.some(r => r.status === 200));
    assert.equal(new Set(attempts.map(r => r.hash)).size, 1);
    assert.equal(new Set(attempts.map(r => r.deliveryId)).size, attempts.length);
  });
  await test('J04', 'push与pull同时到达及乱序去重', async () => {
    await drain();
    const made = await pms.booking(10); const order = made.receipt.result.orderId;
    await pms.command('CANCEL_ORDER', { orderId: order });
    await pms.publish();
    const pair = (await events()).filter(e => JSON.parse(e.body).aggregate_id === order);
    assert.equal(pair.length, 2);
    await Promise.all([agent.pullAll(), ...pair.toReversed().map(e => signed(e.body))]);
    await agent.consumeAll();
    for (const e of pair) assert.equal((await inbox()).filter(i => i.event_id === e.event_id).length, 1);
    assert.equal((await snapshot(order)).revision, '2');
    assert.equal((await aQuery('SELECT count(*)::int n FROM qintopia_agent_os.welcome_cases WHERE order_id=$1', [order]))[0].n, 1);
    cancelledOrder = order;
  });
  await test('J05', '同event_id异原字节冲突保留原记录', async () => {
    const e = (await events()).find(e => JSON.parse(e.body).aggregate_id === mainOrder);
    const original = (await inbox()).find(i => i.event_id === e.event_id);
    assert.equal((await signed(`${e.body} `)).status, 409);
    assert.equal((await inbox()).find(i => i.event_id === e.event_id).body_hash, original.body_hash);
  });
  await test('J06', '断网重启后事件与投递状态恢复', async () => {
    // Pending events already accepted by pull can still receive duplicate ACKs.
    await pms.stopWorker(); tls.state.mode = 'offline';
    const made = await pms.booking(15); const order = made.receipt.result.orderId;
    await pms.publish();
    const e = (await events()).find(e => JSON.parse(e.body).aggregate_id === order);
    // Defer unrelated deliveries, preserving their payload/status.
    await pQuery("UPDATE integration_deliveries SET next_attempt_at=clock_timestamp()+interval '1 day' WHERE event_id<>$1 AND state='pending'", [e.event_id]);
    await pms.startWorker(tls.ca);
    await until(async () => tls.state.records.some(r => r.eventId === e.event_id && r.dropped), 'OUTAGE_NOT_EXERCISED');
    await pms.stopWorker(); await agent.stopReceiver(); await pms.stopApi();
    await pms.startApi(); await agent.startReceiver(); tls.state.mode = 'normal';
    await pms.startWorker(tls.ca); await delivered(e.event_id); await pms.stopWorker();
    await drain(); assert.equal((await snapshot(order)).revision, '1');
  });
  await test('J07', '分页失败检查点不前进且新进程继续', async () => {
    await pms.booking(20); await pms.booking(25); await pms.booking(30); await pms.publish();
    const first = await agent.step('pull'); assert.equal(first.ok, true); assert.equal(first.value.result.has_more, true);
    const checkpoint = await cursor(); reads.state.fail = 503;
    assert.equal((await agent.step('pull')).ok, false); assert.equal(await cursor(), checkpoint);
    reads.state.fail = null;
    await agent.pullAll(); assert.notEqual(await cursor(), checkpoint);
    const rows = await inbox(); assert.equal(new Set(rows.map(i => i.event_id)).size, rows.length);
    await agent.consumeAll();
  });
  await test('J08', '并发拉取CAS只允许一次推进', async () => {
    await pms.booking(35); await pms.publish();
    let release; const wait = new Promise(r => { release = r; }); let arrived = 0;
    reads.state.barrier = async url => { if (url.pathname === '/api/v1/integration-events') { arrived++; if (arrived === 2) release(); await wait; } };
    const safety = setTimeout(release, 10000);
    try {
      const values = await Promise.all([agent.step('pull'), agent.step('pull')]);
      assert.equal(arrived, 2); assert.equal(values.filter(r => r.ok).length, 1);
    } finally { clearTimeout(safety); release(); reads.state.barrier = null; }
    await drain();
  });
  await test('J09', '同版本投影冲突持久隔离', async () => {
    const before = await snapshot(mainOrder);
    reads.state.transform = (url, body) => {
      if (!url.pathname.endsWith(`/orders/${mainOrder}`)) return body;
      const p = JSON.parse(body); p.occupants.push({ occupant_id: 'synthetic-conflicting-occupant', role: 'ADDITIONAL', registration_state: 'active' }); p.projection_hash = pmsProjectionHash(p); return JSON.stringify(p);
    };
    assert.equal((await agent.step('refresh')).ok, false);
    reads.state.transform = null;
    assert.equal((await snapshot(mainOrder)).conflicted, true);
    assert.equal((await snapshot(mainOrder)).projection_hash, before.projection_hash);
    assert.equal((await agent.step('refresh')).ok, false);
    assert.equal((await snapshot(mainOrder)).conflicted, true);
    await pms.command('EXTEND_STAY', { orderId: mainOrder, newDepartureDate: pms.date(4) });
    await drain(); assert.equal((await snapshot(mainOrder)).conflicted, false);
  });
  await test('J10', '库存墓碑恢复与关联修订', async () => {
    await pms.maintenance(demo.bedDId, false); await drain();
    let row = (await aQuery("SELECT invalidated,revision::text FROM qintopia_agent_os.welcome_source_versions WHERE source_instance=$1 AND property_id=$2 AND aggregate_type='inventory_unit' AND aggregate_id=$3", [source, property, demo.bedDId]))[0];
    assert.equal(row.invalidated, true); const old = BigInt(row.revision);
    await pms.maintenance(demo.bedDId, true); await drain();
    row = (await aQuery("SELECT invalidated,revision::text FROM qintopia_agent_os.welcome_source_versions WHERE source_instance=$1 AND property_id=$2 AND aggregate_type='inventory_unit' AND aggregate_id=$3", [source, property, demo.bedDId]))[0];
    assert.equal(row.invalidated, false); assert.ok(BigInt(row.revision) > old);
  });
  await test('J11', '真实会员删除得到200墓碑且不可见不作删除', async () => {
    // A generated synthetic phone is required by the existing CREATE_MEMBER
    // command; it is never logged or placed in the event/projection/report.
    const made = await pms.command('CREATE_MEMBER', { fullName: '合成误建会员', nickname: '测试', phone: '199' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), wechat: 'synthetic' });
    const id = made.receipt.result.memberId; await drain();
    const login = await pms.request('/api/v1/auth/login', { method: 'POST', body: { username: 'admin', password: ['demo', 'pass', '2026'].join('-') } });
    const cookie = login.response.headers.get('set-cookie').split(';')[0];
    const preview = await pms.request(`/api/v1/members/${id}/deletion-preview?propertyId=${property}`, { cookie });
    await pms.request('/api/v1/account-management', { method: 'POST', cookie, body: { action: 'DELETE_MEMBER', propertyId: property, requestId: randomUUID(), reason: '合成误建清理', confirmation: true, targetId: id, expectedVersion: preview.value.version } });
    const tomb = await pms.request(`/api/v1/integrations/agent-os/members/${id}?propertyId=${property}`);
    assert.equal(tomb.value.resource_state, 'tombstone'); await drain();
    const row = (await aQuery("SELECT invalidated FROM qintopia_agent_os.welcome_source_versions WHERE aggregate_type='member' AND aggregate_id=$1", [id]))[0];
    assert.equal(row.invalidated, true);
    await pms.request(`/api/v1/integrations/agent-os/members/synthetic-missing?propertyId=${property}`, { expected: 404 });
  });
  await test('J12', '未来换房跨营业日无新事件仍收敛', async () => {
    await pms.command('MOVE_UNIT', { orderId: mainOrder, newInventoryUnitId: demo.secondRoomId, effectiveDate: pms.date(1) }); await drain();
    const before = await pms.request(`/api/v1/integrations/agent-os/orders/${mainOrder}?propertyId=${property}`);
    const count = (await events()).length;
    await pms.startApi(`${pms.date(1)}T04:00:00Z`);
    const tomorrow = await pms.request(`/api/v1/integrations/agent-os/orders/${mainOrder}?propertyId=${property}`);
    assert.equal(tomorrow.value.projection_hash, before.value.projection_hash);
    assert.equal(tomorrow.value.read_context.current_interval.inventory_unit_id, demo.secondRoomId);
    assert.equal((await agent.step('refresh')).ok, true);
    assert.equal((await snapshot(mainOrder)).projection.business_date, pms.date(1));
    assert.equal((await events()).length, count);
    await pms.startApi();
  });
  await test('J13', '历史补录复合事件只同步不准入欢迎', async () => {
    const made = await pms.booking(-4, 2, demo.secondRoomId, { backfill: true, backfillReason: '合成历史住宿' }); historicalOrder = made.receipt.result.orderId;
    await drain();
    const set = (await events()).map(e => JSON.parse(e.body)).filter(e => e.aggregate_id === historicalOrder);
    assert.equal(set.length, 3); assert.ok(set.every(e => e.origin === 'historical_correction' && e.aggregate_revision === '3'));
    assert.equal(new Set(set.map(e => e.source_fact_ref)).size, 3);
    assert.equal((await aQuery('SELECT admitted FROM qintopia_agent_os.welcome_cases WHERE order_id=$1', [historicalOrder]))[0].admitted, false);
  });
  await test('J14', '晚提交位于已消费水位之后且回滚不留事件', async () => {
    const late = new pg.Client({ connectionString: ownerUrl }); await late.connect();
    try {
      const old = (await events()).length;
      await late.query('BEGIN'); await late.query("SET LOCAL qintopia.integration_maintenance_ref='migration:joint-rollback'");
      await late.query('UPDATE inventory_units SET active=false WHERE id=$1', [demo.bedCId]); await late.query('SET CONSTRAINTS integration_context_capture IMMEDIATE'); await late.query('ROLLBACK');
      await pms.publish(); assert.equal((await events()).length, old);
      await late.query('BEGIN'); await late.query("SET LOCAL qintopia.integration_maintenance_ref='migration:joint-late'");
      await late.query('UPDATE inventory_units SET active=false WHERE id=$1', [demo.bedCId]); await late.query('SET CONSTRAINTS integration_context_capture IMMEDIATE');
      await pms.maintenance(demo.bedBId, false); await drain(); const saved = await cursor();
      await late.query('COMMIT'); await drain(); assert.notEqual(await cursor(), saved);
      const e = (await events()).find(e => JSON.parse(e.body).source_fact_ref === 'migration:joint-late'); assert.ok((await inbox()).some(i => i.event_id === e.event_id));
    } finally { await late.query('ROLLBACK'); await late.end(); }
    await pms.maintenance(demo.bedBId, true); await pms.maintenance(demo.bedCId, true); await drain();
  });
  await test('J15', '分scope领取互不干扰', async () => {
    const other = 'synthetic-other-property';
    assert.equal((await agent.step('init', { QINTOPIA_WELCOME_LOCAL_PROPERTY: other })).ok, true);
    const made = await pms.booking(40); await pms.publish();
    const pending = (await events()).find(e => JSON.parse(e.body).aggregate_id === made.receipt.result.orderId);
    assert.equal((await signed(pending.body)).status, 202);
    const mainBefore = await agent.state();
    const before = (await aQuery('SELECT cursor FROM qintopia_agent_os.welcome_sources WHERE source_instance=$1 AND property_id=$2', [source, other]))[0].cursor;
    const empty = await agent.step('consume', { QINTOPIA_WELCOME_LOCAL_PROPERTY: other }); assert.equal(empty.ok, true); assert.equal(empty.value.result.consumed, false);
    assert.equal((await aQuery('SELECT cursor FROM qintopia_agent_os.welcome_sources WHERE source_instance=$1 AND property_id=$2', [source, other]))[0].cursor, before);
    assert.equal((await aQuery('SELECT count(*)::int n FROM qintopia_agent_os.welcome_cases WHERE property_id=$1', [other]))[0].n, 0);
    assert.equal((await inbox()).find(i => i.event_id === pending.event_id).status, 'queued');
    assert.equal((await agent.step('pull', { QINTOPIA_WELCOME_LOCAL_PROPERTY: other })).ok, false);
    assert.equal((await agent.step('status', { QINTOPIA_WELCOME_LOCAL_PROPERTY: other })).value.rebuilding, true);
    assert.deepEqual(await agent.state(), mainBefore);
    await drain();
  });
  await test('J16', '410过期重建及分页重启始终禁发', async () => {
    await pms.stopWorker(); await drain();
    const early = (await pms.request(`/api/v1/integration-events?propertyId=${property}&limit=1`)).value.next_cursor;
    // Real worker receives duplicate ACKs for baseline already accepted by pull.
    await pQuery("UPDATE integration_deliveries SET next_attempt_at=clock_timestamp() WHERE state='pending'");
    await pms.startWorker(tls.ca);
    await until(async () => (await pQuery("SELECT count(*)::int n FROM integration_deliveries WHERE state<>'accepted'"))[0].n === 0, 'ALL_EVENTS_NOT_ACKED', 240000);
    await pms.stopWorker();
    await pQuery('BEGIN');
    try {
      await pQuery('ALTER TABLE integration_published_events DISABLE TRIGGER integration_published_immutable');
      await pQuery("UPDATE integration_published_events SET published_at=clock_timestamp()-interval '31 days'");
      await pQuery('ALTER TABLE integration_published_events ENABLE TRIGGER integration_published_immutable'); await pQuery('COMMIT');
    } catch(e) { await pQuery('ROLLBACK'); throw e; }
    await pQuery('SELECT qintopia_integration_prune($1,30)', [property]);
    await aQuery('UPDATE qintopia_agent_os.welcome_sources SET cursor=$3 WHERE source_instance=$1 AND property_id=$2', [source, property, early]);
    await pms.request(`/api/v1/integration-events?propertyId=${property}&cursor=${encodeURIComponent(early)}`, { expected: 410 });
    assert.equal((await agent.step('pull')).ok, false); assert.equal(await cursor(), early);
    assert.equal((await agent.state()).rebuilding, true); assert.equal((await agent.state()).admission_enabled, false);
    const scannedOnly = await pms.booking(45); await pms.publish();
    assert.equal((await agent.step('rebuild')).ok, true);
    const first = await agent.step('scan'); assert.equal(first.ok, true); assert.equal(first.value.result.complete, false);
    const saved = (await aQuery('SELECT generation,after_id FROM qintopia_agent_os.welcome_rebuilds WHERE source_instance=$1 AND property_id=$2', [source, property]))[0];
    reads.state.fail = 503; assert.equal((await agent.step('scan')).ok, false); reads.state.fail = null;
    assert.deepEqual((await aQuery('SELECT generation,after_id FROM qintopia_agent_os.welcome_rebuilds WHERE source_instance=$1 AND property_id=$2', [source, property]))[0], saved);
    await agent.scanAll(); await agent.pullAll();
    assert.equal((await agent.state()).admission_enabled, false);
    assert.equal((await aQuery('SELECT admitted FROM qintopia_agent_os.welcome_cases WHERE order_id=$1', [scannedOnly.receipt.result.orderId]))[0].admitted, false);
    assert.equal((await aQuery("SELECT count(*)::int n FROM qintopia_agent_os.welcome_source_versions WHERE aggregate_type='order' AND source_instance=$1 AND property_id=$2", [source, property]))[0].n, (await pQuery('SELECT count(*)::int n FROM orders WHERE property_id=$1', [property]))[0].n);
    assert.equal((await pQuery('SELECT qintopia_integration_publish($1,100) n', [property]))[0].n, 0);
  });
  await test('J17', '旧重建代次不能提交覆盖新代次', async () => {
    assert.equal((await agent.step('rebuild')).ok, true);
    let release, reached; const held = new Promise(r => { release = r; }); const entered = new Promise(r => { reached = r; });
    reads.state.barrier = async url => { if (url.pathname.endsWith('/orders')) { reached(); await held; } };
    const old = agent.step('scan');
    const safety = setTimeout(release, 10000);
    try {
      await entered;
      assert.equal((await agent.step('rebuild')).ok, true);
      release(); assert.equal((await old).ok, false);
    } finally { clearTimeout(safety); release(); reads.state.barrier = null; }
    await agent.scanAll();
  });
  await test('J18', '所有补偿重建无制卡上传发送效果', async () => {
    assert.equal((await agent.step('recover')).ok, true);
    for (const table of ['welcome_actions', 'welcome_upload_intents', 'welcome_artifact_bindings']) assert.equal((await aQuery(`SELECT count(*)::int n FROM qintopia_agent_os.${table}`))[0].n, 0);
    assert.equal((await aQuery("SELECT count(*)::int n FROM qintopia_agent_os.work_items WHERE work_item_type IN ('welcome_delivery','welcome_card')"))[0].n, 0);
    assert.equal((await agent.state()).admission_enabled, false);
  });
  await test('J19', '真实签名失败暂停Worker并受控恢复', async () => {
    const made = await pms.booking(50); await pms.publish();
    const e = (await events()).find(e => JSON.parse(e.body).aggregate_id === made.receipt.result.orderId);
    // Defer any scan-only event; this case targets exactly one delivery.
    await pQuery("UPDATE integration_deliveries SET next_attempt_at=clock_timestamp()+interval '1 day' WHERE event_id<>$1 AND state='pending'", [e.event_id]);
    tls.state.mode = 'bad-signature'; await pms.resume(); await pms.startWorker(tls.ca);
    await until(async () => (await pQuery('SELECT paused FROM integration_subscription_state'))[0].paused, 'SIGNATURE_FAILURE_DID_NOT_PAUSE');
    await pms.stopWorker();
    assert.equal((await pQuery('SELECT state,last_error_code FROM integration_deliveries WHERE event_id=$1', [e.event_id]))[0].last_error_code, 'HTTP_401');
    tls.state.mode = 'normal'; await pms.resume(); await pms.startWorker(tls.ca); await delivered(e.event_id); await pms.stopWorker();
    await agent.consumeAll();
    assert.equal((await aQuery('SELECT admitted FROM qintopia_agent_os.welcome_cases WHERE order_id=$1', [made.receipt.result.orderId]))[0].admitted, false);
  });
} catch (error) {
  report.fatal = /^[A-Za-z0-9_ -]{1,160}$/.test(error.message) ? error.message : error.code ?? 'HARNESS_SETUP_FAILED';
  console.log('JOINT_FATAL', report.fatal);
} finally {
  if (reads) { reads.state.fail = null; reads.state.transform = null; reads.state.barrier = null; }
  if (tls) { tls.state.mode = 'normal'; report.https_requests = tls.state.records.length; report.https_accepted = tls.state.records.filter(r => r.status === 202).length; report.https_duplicates = tls.state.records.filter(r => r.status === 200).length; }
  await agent?.close(); await pms?.close(); await tls?.close(); await reads?.close();
  report.finished_at = new Date().toISOString();
  report.pms_runtime_files = {};
  for (const path of ['packages/db/src/external-payments-readiness.ts', 'packages/db/src/integration-worker-main.ts', 'packages/db/src/integration-worker.ts', 'packages/db/src/integration-queries.ts', 'apps/api/src/integration.ts', 'tests/joint/run.mjs', 'tests/joint/support.mjs', 'tests/joint/pms-fixture.mjs', 'tests/joint/agent-fixture.mjs', 'tests/joint/pms-api.mjs']) report.pms_runtime_files[path] = hash(await readFile(path));
  report.status = !report.fatal && results.length === 19 && results.every(r => r.status === 'passed') ? 'passed' : 'failed';
  await writeFile('tests/joint/latest-result.json', JSON.stringify(report, null, 2) + '\n');
  console.log('JOINT_RESULT', report.status);
  if (report.status !== 'passed') process.exitCode = 1;
}

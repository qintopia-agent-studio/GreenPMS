import assert from 'node:assert/strict';
import pg from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createDatabase } from '../../packages/db/src/database.ts';
import { seedDemo, demo } from '../../packages/db/src/seed.ts';
import { source, property, ownerUrl, runtimeUrl, workerUrl, hash, child, stop, until } from './support.mjs';

export { demo };
export async function preparePms() {
  const admin = new pg.Client({ connectionString: 'postgres://qintopia@127.0.0.1:55442/qintopia' });
  await admin.connect();
  try {
    const { rows } = await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname='qintopia_joint_test'");
    assert.equal(rows[0].n, 0, 'refuse reset while joint test processes are connected');
    await admin.query('DROP DATABASE IF EXISTS qintopia_joint_test');
    await admin.query('CREATE DATABASE qintopia_joint_test');
  } finally { await admin.end(); }
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  try {
  const dir = 'packages/db/src/migrations';
  for (const name of (await readdir(dir)).filter(s => /^\d.*\.sql$/.test(s)).sort()) {
    await owner.query(await readFile(`${dir}/${name}`, 'utf8'));
    await owner.query('INSERT INTO schema_migrations(name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
  }
  const db = createDatabase(ownerUrl);
  try { await seedDemo(db, { includeProtocolFixturePolicy: true }); } finally { await db.destroy(); }
  await owner.query('ALTER ROLE qintopia_integration_worker LOGIN');
  const readToken = demo.readToken;
  const writeToken = demo.administratorWriteToken;
  const signingKey = randomBytes(32).toString('base64url');
  await owner.query('SELECT qintopia_integration_configure($1,\'baseline\')', [source]);
  await owner.query('SELECT qintopia_integration_configure($1,\'live\')', [source]);
  let api, worker;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  function date(offset) { const d = new Date(`${day}T04:00:00Z`); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); }
  async function startApi(clock) {
    await stop(api);
    api = child(process.execPath, ['--import', 'tsx', 'tests/joint/pms-api.mjs'], { DATABASE_URL: runtimeUrl, ...(clock ? { PMS_JOINT_CLOCK: clock } : {}) }, process.cwd(), true);
    await Promise.race([new Promise(resolve => api.once('message', resolve)), api.done.then(() => { throw Error(`PMS_API_EXITED_${api.output.trim()}`); }), new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('PMS_API_START_TIMEOUT')), 15000); timer.unref(); })]);
  }
  async function request(path, { method = 'GET', body, token = readToken, key = randomUUID(), expected = 200, cookie } = {}) {
    const response = await fetch(`http://127.0.0.1:18442${path}`, { method, headers: { ...(cookie ? { cookie } : { authorization: `Bearer ${token}` }), 'content-type': 'application/json', 'idempotency-key': key, 'x-correlation-id': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000), redirect: 'manual' });
    const raw = await response.text();
    let value; try { value = JSON.parse(raw); } catch { value = {}; }
    assert.equal(response.status, expected, `PMS_HTTP_${response.status}_${value.error?.code ?? value.code ?? 'UNKNOWN'}`);
    return { value, raw, response };
  }
  async function command(commandType, input, reason = { code: commandType, note: '合成联合验收' }) {
    const { value: p } = await request('/api/v1/command-previews', { method: 'POST', token: writeToken, body: { commandType, input: { propertyId: property, ...input } } });
    const key = randomUUID();
    const path = `/api/v1/command-previews/${p.preview.previewId}/confirm`;
    const body = { propertyId: property, commandType, confirmation: true, expectedEffectHash: p.preview.effectHash, reason };
    const { value } = await request(path, { method: 'POST', token: writeToken, body, key });
    const receipt = value.receipt ?? value;
    assert.equal(receipt.businessCommitted, true, `PMS_COMMAND_${receipt.error?.code ?? 'NOT_COMMITTED'}`);
    return { receipt, replay: () => request(path, { method: 'POST', token: writeToken, body, key }) };
  }
  async function booking(offset = 0, duration = 3, room = demo.roomId, extra = {}) {
    const { value: quoted } = await request('/api/v1/quotes', { method: 'POST', body: { propertyId: property, inventoryUnitId: room, arrivalDate: date(offset), departureDate: date(offset + duration), pricingPolicyVersionId: demo.publicPricingPolicyId } });
    return command('CREATE_ORDER', { quoteId: quoted.quote.quoteId, primaryGuest: { fullName: '合成联合验收', nickname: '测试住客' }, bookingChannelCode: 'WECOM', channelOrderReference: null, ...extra }, extra.backfill ? { code: 'BACKFILL_STAY', note: '合成历史住宿' } : { code: 'CREATE_STANDARD_ORDER', note: '' });
  }
  async function publish() {
    let total = 0, n;
    do { n = (await owner.query('SELECT qintopia_integration_publish($1,100) n', [property])).rows[0].n; total += n; } while (n === 100);
    return total;
  }
  async function startWorker(ca, deliver = true) {
    await stop(worker);
    worker = child(process.execPath, ['--import', 'tsx', 'packages/db/src/integration-worker-main.ts'], { NODE_EXTRA_CA_CERTS: ca, PMS_INTEGRATION_WORKER_DATABASE_URL: workerUrl, PMS_INTEGRATION_SOURCE_INSTANCE: source, PMS_INTEGRATION_PROPERTY_IDS: property, PMS_INTEGRATION_PUBLISH_ENABLED: 'true', PMS_INTEGRATION_DELIVERY_ENABLED: String(deliver), PMS_INTEGRATION_PRUNE_ENABLED: 'false', PMS_INTEGRATION_ENDPOINT: 'https://127.0.0.1:18444/api/v1/ingress/pms/events', PMS_INTEGRATION_KEY_ID: 'local-synthetic', PMS_INTEGRATION_SIGNING_KEY: signingKey });
    await until(async () => {
      assert.equal(worker.exitCode, null, 'PMS_WORKER_EXITED');
      return worker.output.includes('INTEGRATION_STATUS');
    }, 'PMS_WORKER_START_TIMEOUT');
  }
  async function pause() { await owner.query("SELECT qintopia_integration_control('PAUSE','joint-v1','TEST_PAUSE')"); }
  async function resume() { await owner.query("SELECT qintopia_integration_control('RESUME','joint-v1','TEST_RESUME')"); }
  async function maintenance(id, active, suffix = randomUUID()) {
    await owner.query('BEGIN');
    try {
      await owner.query("SELECT set_config('qintopia.integration_maintenance_ref',$1,true)", [`migration:joint-${suffix}`]);
      await owner.query('UPDATE inventory_units SET active=$1 WHERE id=$2', [active, id]);
      await owner.query('COMMIT');
    } catch (e) { await owner.query('ROLLBACK'); throw e; }
  }
  async function close() { await stop(worker); await stop(api); await owner.query('ALTER ROLE qintopia_integration_worker NOLOGIN'); await owner.end(); }
  return { owner, readToken, writeToken, signingKey, day, date, startApi, request, command, booking, publish, startWorker, pause, resume, maintenance, close, stopWorker: () => stop(worker), stopApi: () => stop(api) };
  } catch (error) { await owner.end(); throw error; }
}

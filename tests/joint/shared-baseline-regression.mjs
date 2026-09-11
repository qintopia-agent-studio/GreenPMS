// Limited follow-up for A's final shared build/migration. The v2 19-case report
// remains separate; this does not relabel it as a full A-version acceptance.
import assert from 'node:assert/strict';
import pg from 'pg';
import { readFile, writeFile } from 'node:fs/promises';
import { preparePms } from './pms-fixture.mjs';
import { prepareAgent } from './agent-fixture.mjs';
import { assertIsolation, source, property, agentUrl, child, hash, tlsProxy, readProxy, until } from './support.mjs';

assertIsolation();
const baseline = '/private/tmp/green-pms-joint-agentos-a-20260911-v1';
const binary = '/private/tmp/green-pms-joint-agentos-a-target/debug/qintopia-message-sidecar';
const manifestHash = 'ea995750d41e039f2af0cd0661d65700fb7ecf2e0058cdbf9d5f274e19cde35d';
const manifestBytes = await readFile(`${baseline}/BASELINE.json`);
assert.equal(hash(manifestBytes), manifestHash);
const manifest = JSON.parse(manifestBytes);
for (const f of manifest.files) assert.equal(hash(await readFile(`${baseline}/${f.path}`)), f.sha256);
const previous = JSON.parse(await readFile('/private/tmp/green-pms-joint-agentos-20260911-v2/BASELINE.json'));
for (const f of previous.files.filter(f => f.path.includes('/migrations/') || f.path.endsWith('/unified-person-welcome-v1-contract.md'))) {
  assert.equal(manifest.files.find(a => a.path === f.path)?.sha256, f.sha256, 'old migration or common contract changed');
}
const report = { manifest_sha256: manifestHash, binary_sha256: hash(await readFile(binary)), node: process.version, started_at: new Date().toISOString(), cases: [] };
let pms, agent, tls, reads;
async function step(name, run) { await run(); report.cases.push({ name, status: 'passed' }); console.log('PASS', name); }
try {
  await step('existing_v2_database_upgrade_preserves_history', async () => {
    const db = new pg.Client({ connectionString: agentUrl }); await db.connect();
    try {
      const oldMigrations = (await db.query("SELECT version::text,encode(checksum,'hex') checksum FROM qintopia_messages._sqlx_migrations ORDER BY version")).rows;
      assert.ok(!oldMigrations.some(m => m.version === '202609110001'), 'upgrade case requires the preserved v2 database');
      const tables = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='qintopia_agent_os' AND tablename LIKE 'welcome_%' ORDER BY tablename")).rows.map(r => r.tablename);
      assert.ok(tables.length > 10);
      async function fingerprints() {
        const data = {};
        for (const table of tables) {
          assert.match(table, /^welcome_[a-z_]+$/);
          data[table] = (await db.query(`SELECT count(*)::int n,encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'[]'),'UTF8')),'hex') hash FROM qintopia_agent_os.${table} t`)).rows[0];
        }
        return data;
      }
      const before = await fingerprints();
      // init runs the real migration runner first. Duplicate source registration
      // must then refuse, so it cannot re-enable the preserved disabled source.
      const driver = child(binary, ['welcome-synthetic', 'init'], { QINTOPIA_WELCOME_SYNTHETIC_ENABLE: '1', QINTOPIA_WELCOME_LOCAL_DATABASE_URL: agentUrl, QINTOPIA_WELCOME_LOCAL_SOURCE: source, QINTOPIA_WELCOME_LOCAL_PROPERTY: property, RUST_MIN_STACK: '33554432' }, baseline);
      const timeout = setTimeout(() => driver.kill('SIGKILL'), 45000);
      const done = await driver.done; clearTimeout(timeout); assert.equal(done.code, 1);
      const afterMigrations = (await db.query("SELECT version::text,encode(checksum,'hex') checksum FROM qintopia_messages._sqlx_migrations ORDER BY version")).rows;
      assert.equal(afterMigrations.length, oldMigrations.length + 1);
      assert.deepEqual(afterMigrations.filter(m => m.version !== '202609110001'), oldMigrations);
      assert.deepEqual(await fingerprints(), before);
      for (const name of ['collaboration_positions', 'collaboration_ledger', 'collaboration_audiences']) {
        assert.equal((await db.query(`SELECT count(*)::int n FROM qintopia_agent_os.${name}`)).rows[0].n, 0);
      }
      report.preserved_welcome_tables = tables.length;
      report.old_migration_count = oldMigrations.length;
    } finally { await db.end(); }
  });
  await step('fresh_install_and_both_real_processes_start', async () => {
    pms = await preparePms(); await pms.startApi();
    tls = await tlsProxy(); reads = await readProxy();
    process.env.AGENTOS_JOINT_BASELINE = baseline;
    process.env.AGENTOS_JOINT_BINARY = binary;
    process.env.AGENTOS_JOINT_MANIFEST_SHA256 = manifestHash;
    agent = await prepareAgent(pms); await agent.startReceiver();
    assert.equal((await agent.state()).external_effects, false);
  });
  await step('signed_delivery_pull_dedup_and_real_projection_consumption', async () => {
    await pms.publish(); await agent.pullAll(); await agent.consumeAll();
    await pms.owner.query("UPDATE integration_deliveries SET next_attempt_at=clock_timestamp()+interval '1 day'");
    const booking = await pms.booking(); const order = booking.receipt.result.orderId;
    await pms.command('CHECK_IN', { orderId: order }); await pms.publish();
    const events = (await pms.owner.query("SELECT event_id,body,body_hash FROM integration_published_events WHERE body::jsonb->>'aggregate_id'=$1", [order])).rows;
    assert.equal(events.length, 2);
    await pms.resume(); await pms.startWorker(tls.ca);
    await until(async () => (await pms.owner.query("SELECT count(*)::int n FROM integration_deliveries WHERE event_id=ANY($1::text[]) AND state='accepted'", [events.map(e => e.event_id)])).rows[0].n === 2, 'shared baseline delivery failed', 15000);
    await pms.stopWorker(); await agent.pullAll(); await agent.consumeAll();
    for (const e of events) {
      const row = (await agent.db.query('SELECT body_hash FROM qintopia_agent_os.welcome_inbox WHERE source_instance=$1 AND event_id=$2', [source, e.event_id])).rows;
      assert.equal(row.length, 1); assert.equal(row[0].body_hash, hash(e.body));
      assert.ok(tls.state.records.some(r => r.eventId === e.event_id && r.status === 202));
    }
    assert.equal((await agent.db.query("SELECT revision::text FROM qintopia_agent_os.welcome_source_versions WHERE source_instance=$1 AND aggregate_type='order' AND aggregate_id=$2", [source, order])).rows[0].revision, '2');
  });
  await step('rebuild_entry_preserves_disabled_admission_and_zero_effects', async () => {
    assert.equal((await agent.step('rebuild')).ok, true);
    await agent.scanAll(); await agent.pullAll(); assert.equal((await agent.step('recover')).ok, true);
    assert.equal((await agent.state()).admission_enabled, false);
    for (const table of ['welcome_actions', 'welcome_upload_intents', 'welcome_artifact_bindings']) assert.equal((await agent.db.query(`SELECT count(*)::int n FROM qintopia_agent_os.${table}`)).rows[0].n, 0);
  });
} catch (error) {
  report.failure = error.code ?? 'SHARED_REGRESSION_FAILED';
  report.location = error.stack?.match(/shared-baseline-regression\.mjs:\d+:\d+/)?.[0] ?? null;
  console.log('FAILED', report.failure, report.location);
} finally {
  await agent?.close(); await pms?.close(); await tls?.close(); await reads?.close();
  report.status = report.cases.length === 4 && !report.failure ? 'passed' : 'failed';
  report.finished_at = new Date().toISOString();
  await writeFile('docs/implementation/evidence/pms-agentos-joint-20260911/a-final-shared-regression.json', JSON.stringify(report, null, 2) + '\n');
  if (report.status !== 'passed') process.exitCode = 1;
}

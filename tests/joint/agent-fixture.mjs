import assert from 'node:assert/strict';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { agentUrl, source, property, child, stop, until, hash } from './support.mjs';

export async function prepareAgent(pms) {
  const baseline = resolve(process.env.AGENTOS_JOINT_BASELINE ?? '/private/tmp/green-pms-joint-agentos-20260911-v2');
  const binary = resolve(process.env.AGENTOS_JOINT_BINARY ?? '/private/tmp/green-pms-joint-agentos-target/debug/qintopia-message-sidecar');
  const expected = process.env.AGENTOS_JOINT_MANIFEST_SHA256 ?? '56cc9ee18f93eabd6be177f73be7ca523cd5f91f5105e4f63069e59ca05da291';
  assert.ok(baseline.startsWith('/private/tmp/green-pms-joint-agentos-'));
  assert.ok(binary.startsWith('/private/tmp/green-pms-joint-agentos-'));
  const bytes = await readFile(`${baseline}/BASELINE.json`);
  assert.equal(hash(bytes), expected, 'receiver manifest changed');
  const manifest = JSON.parse(bytes);
  for (const f of manifest.files) {
    const path = resolve(baseline, f.path);
    assert.ok(path.startsWith(`${baseline}/`));
    const value = await readFile(path);
    assert.equal(value.length, f.bytes, 'receiver file size changed');
    assert.equal(hash(value), f.sha256, 'receiver file changed');
  }
  const admin = new pg.Client({ connectionString: 'postgres://qintopia@127.0.0.1:55443/postgres' });
  await admin.connect();
  try {
    assert.equal((await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname='qintopia_test'")).rows[0].n, 0);
    await admin.query('DROP DATABASE IF EXISTS qintopia_test');
    await admin.query('CREATE DATABASE qintopia_test');
  } finally { await admin.end(); }
  const env = { QINTOPIA_WELCOME_SYNTHETIC_ENABLE: '1', QINTOPIA_WELCOME_LOCAL_DATABASE_URL: agentUrl, QINTOPIA_WELCOME_LOCAL_SOURCE: source, QINTOPIA_WELCOME_LOCAL_PROPERTY: property, QINTOPIA_WELCOME_SYNTHETIC_READ_ROOT: 'http://127.0.0.1:18443/', QINTOPIA_WELCOME_SYNTHETIC_READ_TOKEN: pms.readToken, RUST_MIN_STACK: '33554432' };
  let receiver;
  const live = new Set();
  async function step(name, options = {}) {
    const p = child(binary, ['welcome-synthetic', name], { ...env, ...options }, baseline);
    live.add(p);
    const timer = setTimeout(() => p.kill('SIGKILL'), 45000);
    const result = await p.done;
    clearTimeout(timer); live.delete(p);
    const line = p.output.trim().split('\n').findLast(v => v.startsWith('{'));
    return { ok: result.code === 0, value: line ? JSON.parse(line) : null };
  }
  const initialized = await step('init');
  assert.equal(initialized.ok, true, 'AGENT_INIT_FAILED');
  const db = new pg.Client({ connectionString: agentUrl });
  await db.connect();
  async function startReceiver() {
    await stop(receiver);
    receiver = child(binary, ['run-welcome-local', '--port', '18872'], { ...env, QINTOPIA_WELCOME_LOCAL_ENABLE: '1', QINTOPIA_WELCOME_LOCAL_OPERATOR_LINK: initialized.value.synthetic_operator_link, QINTOPIA_WELCOME_LOCAL_SIGNING_KEY: pms.signingKey }, baseline);
    await until(async () => {
      assert.equal(receiver.exitCode, null, 'AGENT_RECEIVER_EXITED');
      try { return (await fetch('http://127.0.0.1:18872/', { signal: AbortSignal.timeout(500) })).status === 200; } catch { return false; }
    }, 'AGENT_RECEIVER_START_TIMEOUT');
  }
  async function state() { return (await step('status')).value; }
  async function pullAll() {
    for (let i = 0; i < 1000; i++) {
      const r = await step('pull');
      assert.equal(r.ok, true, 'AGENT_PULL_FAILED');
      if (!r.value.result.has_more) return;
    }
    throw Error('AGENT_PULL_DID_NOT_FINISH');
  }
  async function consumeAll() {
    for (let i = 0; i < 1000; i++) {
      const r = await step('consume');
      assert.equal(r.ok, true, 'AGENT_CONSUME_FAILED');
      if (!r.value.result.consumed) return;
    }
    throw Error('AGENT_CONSUME_DID_NOT_FINISH');
  }
  async function scanAll() {
    for (let i = 0; i < 1000; i++) {
      const r = await step('scan');
      assert.equal(r.ok, true, 'AGENT_SCAN_FAILED');
      if (r.value.result.complete) return;
    }
    throw Error('AGENT_SCAN_DID_NOT_FINISH');
  }
  async function close() { for (const p of live) await stop(p); await stop(receiver); await db.end(); }
  return { db, env, manifest, manifestHash: expected, binaryHash: hash(await readFile(binary)), step, state, startReceiver, stopReceiver: () => stop(receiver), pullAll, consumeAll, scanAll, close };
}

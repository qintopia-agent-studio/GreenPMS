import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer as httpsServer } from 'node:https';
import { request as httpRequest, createServer as httpServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const source = 'synthetic-pms-joint-20260911';
export const property = 'prop_qintopia_demo';
export const ownerUrl = 'postgres://qintopia@127.0.0.1:55442/qintopia_joint_test';
export const agentUrl = 'postgres://qintopia@127.0.0.1:55443/qintopia_test';
export const runtimeUrl = 'postgres://qintopia_runtime@127.0.0.1:55442/qintopia_joint_test';
export const workerUrl = 'postgres://qintopia_integration_worker@127.0.0.1:55442/qintopia_joint_test';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const cleanEnv = extra => ({ PATH: process.env.PATH, TMPDIR: tmpdir(), LOG_LEVEL: 'silent', STAFF_PROFILE_MANIFEST_NAME: 'demo', PMS_AGENTOS_JOINT_ENABLE: '1', ...extra });
export function assertIsolation() {
  assert.equal(process.env.PMS_AGENTOS_JOINT_ENABLE, '1', 'explicit joint test enable required');
  assert.equal(process.env.QINTOPIA_DATABASE_TEST_LOCK_HELD, '1', 'use the database test lock runner');
  for (const [name, port] of [['green-pms-joint-pg-20260911', '55442'], ['green-pms-joint-agentos-pg-20260911', '55443']]) {
    const raw = execFileSync('docker', ['inspect', '--format', '{{ index .Config.Labels "qintopia.task" }}|{{ (index (index .NetworkSettings.Ports "5432/tcp") 0).HostIp }}|{{ (index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort }}', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(raw.trim(), `pms-agentos-joint-20260911|127.0.0.1|${port}`, 'isolated container identity mismatch');
  }
}
export function child(command, args, env, cwd = process.cwd(), ipc = false) {
  const p = spawn(command, args, { cwd, env: cleanEnv(env), stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] });
  p.output = '';
  // Captured only in memory, never dump command environments or raw error logs.
  p.stdout.on('data', b => { p.output = (p.output + b).slice(-65536); });
  p.stderr.on('data', () => {});
  p.done = new Promise(resolve => p.once('exit', (code, signal) => resolve({ code, signal })));
  return p;
}
export async function stop(p) {
  if (!p || p.exitCode !== null || p.signalCode !== null) return;
  p.kill('SIGTERM');
  const timeout = setTimeout(() => p.kill('SIGKILL'), 12000);
  await p.done;
  clearTimeout(timeout);
}
export async function until(fn, message, ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw Error(message);
}

// Fresh private key is held only in process memory. Only the public test CA is
// written temporarily for NODE_EXTRA_CA_CERTS; no system trust store is changed.
export async function tlsProxy() {
  const dir = await mkdtemp(join(tmpdir(), 'pms-joint-ca-'));
  const config = join(dir, 'openssl.cnf');
  await writeFile(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=PMS joint synthetic loopback\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n');
  const pem = execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', '/dev/stdout', '-out', '/dev/stdout', '-days', '1', '-config', config], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const cert = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)[0];
  const key = pem.match(/-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA )?PRIVATE KEY-----/)[0];
  const ca = join(dir, 'public-ca.pem');
  await writeFile(ca, cert);
  const state = { mode: 'normal', records: [], hold: null };
  const server = httpsServer({ cert, key }, async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/v1/ingress/pms/events') { res.writeHead(404).end(); return; }
    const chunks = [];
    for await (const b of req) chunks.push(b);
    const body = Buffer.concat(chunks);
    if (body.length > 65536) { res.writeHead(413).end(); return; }
    const record = { hash: hash(body), eventId: JSON.parse(body).event_id, deliveryId: req.headers['x-qt-delivery-id'], status: null, dropped: false };
    state.records.push(record);
    const mode = state.mode;
    if (mode === 'offline') { record.dropped = true; req.socket.destroy(); return; }
    if (mode === 'hold' && state.hold) await state.hold;
    const headers = { ...req.headers, host: '127.0.0.1:18872', 'content-length': String(body.length), connection: 'close' };
    if (mode === 'bad-signature') headers['x-qt-signature'] = '0'.repeat(64);
    const upstream = httpRequest({ host: '127.0.0.1', port: 18872, path: req.url, method: 'POST', headers }, response => {
      const received = [];
      response.on('data', b => received.push(b));
      response.on('end', () => {
        record.status = response.statusCode;
        if (mode === 'drop-ack') { record.dropped = true; req.socket.destroy(); return; }
        res.writeHead(response.statusCode, { 'content-type': 'application/json' });
        res.end(Buffer.concat(received));
      });
    });
    upstream.on('error', () => { record.dropped = true; req.socket.destroy(); });
    upstream.end(body);
  });
  server.listen(18444, '127.0.0.1');
  await once(server, 'listening');
  return { ...state, state, ca, async close() { server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(dir, { recursive: true, force: true }); } };
}

// Fixed read-only loopback hop. Faults affect test responses, never stored PMS
// facts. Normal traffic and pagination responses come from the running API.
export async function readProxy() {
  const state = { limit: 2, fail: null, transform: null, barrier: null, requests: [] };
  const server = httpServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1:18442');
    if (req.method !== 'GET' || !(/^\/api\/v1\/integration-events$|^\/api\/v1\/integrations\/agent-os\/(orders|members|inventory-units)(\/[^/]+)?$/.test(url.pathname))) {
      res.writeHead(403).end(); return;
    }
    if (url.pathname === '/api/v1/integration-events' || url.pathname.endsWith('/orders')) url.searchParams.set('limit', String(state.limit));
    state.requests.push({ path: url.pathname, status: null });
    const record = state.requests.at(-1);
    if (state.fail) { record.status = state.fail; res.writeHead(state.fail).end('{"code":"SYNTHETIC_READ_FAULT"}'); return; }
    try {
      const response = await fetch(url, { headers: { authorization: req.headers.authorization ?? '' }, redirect: 'manual', signal: AbortSignal.timeout(5000) });
      let body = Buffer.from(await response.arrayBuffer());
      record.status = response.status;
      if (state.transform && response.status === 200) body = Buffer.from(await state.transform(url, body));
      if (state.barrier) await state.barrier(url);
      res.writeHead(response.status, { 'content-type': 'application/json', 'content-length': body.length });
      res.end(body);
    } catch { res.writeHead(502).end('{"code":"SYNTHETIC_UPSTREAM_UNAVAILABLE"}'); }
  });
  server.listen(18443, '127.0.0.1');
  await once(server, 'listening');
  return { state, async close() { server.closeAllConnections(); await new Promise(r => server.close(r)); } };
}

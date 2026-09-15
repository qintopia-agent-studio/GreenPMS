// Synthetic-only process wrapper; all routes, auth and readiness are the real API.
import assert from 'node:assert/strict';
import { listenRuntimeApi } from '../../apps/api/src/runtime-startup.ts';
import { withPropertyClockForTesting } from '../../packages/db/src/members.ts';

assert.equal(process.env.PMS_AGENTOS_JOINT_ENABLE, '1');
const database = new URL(process.env.DATABASE_URL);
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '55442');
assert.equal(database.pathname, '/qintopia_joint_test');
assert.equal(database.username, 'qintopia_runtime');
const start = async () => {
  const { app } = await listenRuntimeApi({ host: '127.0.0.1', port: 18442 });
  process.send?.({ ready: true });
  const stop = async () => { await app.close(); process.exit(0); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
};
try {
  if (process.env.PMS_JOINT_CLOCK) {
    await withPropertyClockForTesting(new Date(process.env.PMS_JOINT_CLOCK), start);
  } else await start();
} catch (error) { console.log('JOINT_API_START_FAILED', error.name); process.exitCode = 1; }

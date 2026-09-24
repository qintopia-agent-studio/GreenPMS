// Explicit loopback-only payment fixture. Uses real PMS API, transactions and sender.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { sql } from 'kysely';
import { createDatabase, createCommandPreview, confirmCommandPreview } from '../../packages/db/src/index.ts';
import { demo } from '../../packages/db/src/seed.ts';
import { createQuoteForTesting } from '../../packages/db/src/pricing-service.ts';
import { authScope } from '../helpers/auth-principals.ts';
import { runtimeDatabaseUrlForTesting } from '../helpers/runtime-database.ts';
import { syncWecomSource } from '../../packages/db/src/wecom-sync.ts';
import { readExternalPaymentEvents, readExternalPaymentEventHead } from '../../packages/db/src/external-payments.ts';
import { publishPaymentEvents, deliverOnePayment } from '../../packages/db/src/payment-event-worker.ts';
import { listenRuntimeApi } from '../../apps/api/src/runtime-startup.ts';

assert.equal(process.env.PMS_PAYMENT_JOINT_ENABLE, '1', 'explicit local fixture opt-in required');
const ownerUrl = 'postgres://qintopia@127.0.0.1:55448/qintopia_wecom_payment_joint';
const runtimeUrl = runtimeDatabaseUrlForTesting(ownerUrl);
const workerUrl = 'postgres://qintopia_payment_delivery_worker@127.0.0.1:55448/qintopia_wecom_payment_joint';
const sourceInstance = 'synthetic-pms-joint-20260924';
const directory = '.local-workspace/payment-events/joint';
const mode = process.argv[2];
process.env.STAFF_PROFILE_MANIFEST_NAME = 'demo';
if (mode === 'proxy') {
  const {tlsProxy} = await import('./support.mjs');
  const proxy = await tlsProxy({listenPort: 18450, receiverPort: 18449});
  await mkdir(directory, {recursive: true});
  await writeFile(`${directory}/proxy-mode`, 'normal');
  await writeFile(`${directory}/tls.json`, JSON.stringify({ca: proxy.ca, endpoint: 'https://127.0.0.1:18450/api/v1/ingress/pms/events'}));
  const tick = setInterval(async () => {
    const mode = (await readFile(`${directory}/proxy-mode`, 'utf8')).trim();
    assert.ok(['normal','drop-ack','bad-signature','offline'].includes(mode));
    proxy.state.mode = mode;
    await writeFile(`${directory}/tls-records.json`, JSON.stringify(proxy.state.records, null, 2));
  }, 250);
  const stop = async () => { clearInterval(tick); await proxy.close(); process.exit(0); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  console.log(JSON.stringify({code: 'PAYMENT_JOINT_TLS_READY', ca: proxy.ca}));
} else if (mode === 'api') {
  const {app} = await listenRuntimeApi({databaseUrl: runtimeUrl, host: '127.0.0.1', port: 18448});
  const stop = async () => { await app.close(); process.exit(0); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
} else if (mode === 'setup') {
  // Test reset uses the original lock; never permits arbitrary database destinations.
  assert.equal(process.env.QINTOPIA_DATABASE_TEST_LOCK_HELD, '1');
  assert.equal(process.env.TEST_DATABASE_URL, ownerUrl);
  const {resetTestDatabase} = await import('../helpers/database.ts');
  const owner = await resetTestDatabase();
  const runtime = createDatabase(runtimeUrl);
  try {
    await sql`ALTER ROLE qintopia_payment_delivery_worker LOGIN`.execute(owner);
    await sql`INSERT INTO payment_delivery_source(source_instance) VALUES(${sourceInstance})`.execute(owner);
    const now = new Date();
    await sql`INSERT INTO external_payment_sources(id,corp_id,enabled,matching_since,import_since,synced_until,baseline_complete)
      VALUES('joint-source','simulation-corp',true,${new Date(now.getTime()-86400000)},${new Date(now.getTime()-86400000)},${new Date(now.getTime()-120000)},true)`.execute(owner);
    await sql`INSERT INTO external_payment_accounts VALUES('joint-source','simulation-merchant',${demo.propertyId})`.execute(owner);
    const date = offset => new Date(now.getTime()+offset*86400000).toISOString().slice(0,10);
    const quote = await createQuoteForTesting(owner, {propertyId: demo.propertyId, inventoryUnitId: demo.roomId,
      stayType: 'TRANSIENT', arrivalDate: date(1), departureDate: date(3), pricingPolicyVersionId: demo.publicPricingPolicyId});
    const actor = {subjectId: demo.agentSubjectId, credentialId: 'token_demo_write', credentialType: 'TOKEN', displayName: '模拟工作人员', ...authScope()};
    const meta = () => ({idempotencyKey: randomUUID(), correlationId: randomUUID()});
    const preview = await createCommandPreview(runtime, actor, {commandType: 'CREATE_ORDER', input: {
      propertyId: demo.propertyId, quoteId: quote.quoteId, primaryGuest: {fullName: '联合验证模拟住客', nickname: '模拟客人'}, bookingChannelCode: 'WECOM',
      targetCurrentContractAmountMinor: quote.currentContractAmount.minorUnits}}, meta());
    const receipt = await confirmCommandPreview(runtime, actor, preview.preview.previewId, {propertyId: demo.propertyId,
      commandType: 'CREATE_ORDER', confirmation: true, expectedEffectHash: preview.preview.effectHash,
      reason: {code: 'CREATE_STANDARD_ORDER', note: ''}}, meta());
    assert.equal(receipt.businessCommitted, true);
    const fixture = {sourceInstance, propertyId: demo.propertyId, orderId: receipt.result.orderId, amountMinor: 12000,
      api: 'http://127.0.0.1:18448', readToken: demo.readToken, writeToken: demo.writeToken,
      head: await readExternalPaymentEventHead(runtime, demo.propertyId)};
    await mkdir(directory, {recursive: true});
    await writeFile(`${directory}/fixture.json`, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(JSON.stringify(fixture));
  } finally { await runtime.destroy(); await owner.destroy(); }
} else if (mode === 'discover') {
  const owner = createDatabase(ownerUrl);
  try {
    const reference = process.argv[3] ?? `simulation-${randomUUID()}`;
    assert.match(reference, /^simulation-[A-Za-z0-9-]+$/);
    const now = new Date(); const occurredAt = new Date(now.getTime()-1000);
    await syncWecomSource(owner, 'joint-source', {bills: async (begin,end) => ({bills: occurredAt>=begin && occurredAt<=end ? [{
      kind: 'COLLECTION', merchantId: 'simulation-merchant', reference, originalTradeNo: reference, transactionId: reference,
      externalUserId: null, collectorId: null, amountMinor: 12000, occurredAt, state: 'SUCCESS'}] : [], nextCursor: null}), nickname: async () => null}, now);
    console.log(JSON.stringify(await readExternalPaymentEvents(owner, demo.propertyId, '0')));
  } finally { await owner.destroy(); }
} else if (mode === 'deliver') {
  const endpoint = process.env.PMS_PAYMENT_JOINT_ENDPOINT;
  const parsed = new URL(endpoint); assert.equal(parsed.hostname, '127.0.0.1'); assert.equal(parsed.protocol, 'https:');
  const worker = createDatabase(workerUrl);
  const owner = createDatabase(ownerUrl);
  try {
    await publishPaymentEvents(worker, demo.propertyId, sourceInstance);
    await sql`SELECT qintopia_payment_delivery_control('RESUME','JOINT_TEST')`.execute(owner);
    const attempted = await deliverOnePayment(worker, {endpoint, sourceInstance, propertyIds: [demo.propertyId],
      keyId: process.env.PMS_PAYMENT_JOINT_KEY_ID ?? 'local-payment-joint', signingKey: (await readFile(process.env.PMS_PAYMENT_JOINT_KEY_FILE, 'utf8')).trim(), timeoutMs: 10000, leaseMs: 30000});
    console.log(JSON.stringify({attempted, deliveries: (await sql`SELECT event_id,state,receipt_id,last_error_code FROM payment_deliveries ORDER BY event_id`.execute(owner)).rows}));
  } finally { await worker.destroy(); await owner.destroy(); }
} else if (mode === 'status') {
  const owner = createDatabase(ownerUrl);
  try {
    const fixture = JSON.parse(await readFile(`${directory}/fixture.json`, 'utf8'));
    console.log(JSON.stringify({events: await readExternalPaymentEvents(owner, demo.propertyId, '0'),
      collections: await owner.selectFrom('collection_facts').select(['fact_id','amount_minor','transaction_reference']).where('order_id','=',fixture.orderId).execute(),
      deliveries: (await sql`SELECT event_id,state,receipt_id,last_error_code FROM payment_deliveries ORDER BY event_id`.execute(owner)).rows}));
  } finally { await owner.destroy(); }
} else throw Error('expected setup, api, proxy, discover, deliver or status');

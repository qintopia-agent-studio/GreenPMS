import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { AuthPrincipal } from '@qintopia/contracts';
import { confirmCommandPreview, createCommandPreview, createDatabase, type Database } from '@qintopia/db';
import { buildServer } from '../../apps/api/src/server.ts';
import { getWorkbenchExceptions } from '../../packages/db/src/workbench-exceptions.ts';
import { createQuoteForTesting } from '../../packages/db/src/pricing-service.ts';
import { demo } from '../../packages/db/src/seed.ts';
import { authScope } from '../helpers/auth-principals.ts';
import { resetDatabase, testDatabaseUrl } from '../helpers/database.ts';
import { runtimeDatabaseUrlForTesting } from '../helpers/runtime-database.ts';

const databaseUrl = new URL(testDatabaseUrl);
databaseUrl.pathname = '/qintopia_workbench_contract';
const path = `/api/v1/workbench/exceptions?propertyId=${demo.propertyId}`;
const headers = { authorization: `Bearer ${demo.readToken}` };
let owner: Kysely<Database>, runtime: Kysely<Database>, app: FastifyInstance;
const ids: string[] = [];
const principal: AuthPrincipal = { subjectId: demo.administratorSubjectId, credentialId: 'token_demo_admin_write',
  credentialType: 'TOKEN', displayName: '模拟管理员', ...authScope({ profile: 'administrator' }) };

beforeAll(async () => {
  owner = await resetDatabase(databaseUrl.toString());
  runtime = createDatabase(runtimeDatabaseUrlForTesting(databaseUrl.toString()));
  for (let i = 1; i <= 2; i++) {
    const quote = await createQuoteForTesting(owner, { propertyId: demo.propertyId, inventoryUnitId: demo.roomId,
      stayType: 'TRANSIENT', arrivalDate: `2033-05-0${i}`, departureDate: `2033-05-0${i + 1}`, pricingPolicyVersionId: demo.transientPolicyId });
    const prepared = await createCommandPreview(runtime, principal, { commandType: 'CREATE_ORDER', input: {
      propertyId: demo.propertyId, quoteId: quote.quoteId, primaryGuest: { fullName: `模拟住客${i}`, nickname: `样例${i}`, phone: '13800001234' },
      bookingChannelCode: 'WECOM', targetCurrentContractAmountMinor: 10000, manualPriceAdjustmentReason: '模拟协议价'
    } }, { idempotencyKey: `workbench-create-${i}`, correlationId: `workbench-create-${i}` });
    const receipt = await confirmCommandPreview(runtime, principal, prepared.preview.previewId, {
      propertyId: demo.propertyId, commandType: 'CREATE_ORDER', confirmation: true, expectedEffectHash: prepared.preview.effectHash,
      reason: { code: 'CREATE_STANDARD_ORDER', note: '' }
    }, { idempotencyKey: `workbench-confirm-${i}`, correlationId: `workbench-confirm-${i}` });
    expect(receipt.businessCommitted, JSON.stringify(receipt.error)).toBe(true);
    ids.push(receipt.result!.orderId as string);
  }
  app = await buildServer(runtime);
  await app.ready();
});
afterAll(async () => { await app?.close(); await runtime?.destroy(); await owner?.destroy(); });

describe('workbench exception API contract', () => {
  it('requires authentication and property READ access', async () => {
    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/workbench/exceptions?propertyId=other_property', headers })).statusCode).toBe(403);
  });

  it('serves the same structured reasons to a READ token, excludes private contact data and does not mutate business facts', async () => {
    const before = await owner.selectFrom('orders').select(['id', 'version', 'status']).orderBy('id').execute();
    const response = await app.inject({ method: 'GET', url: path, headers });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json();
    const direct = await getWorkbenchExceptions(runtime, { propertyId: demo.propertyId });
    expect(body).toMatchObject({ propertyId: demo.propertyId, businessDate: direct.businessDate, totalOrders: 2, nextCursor: null, items: direct.items });
    expect(body.items.map((item: { orderId: string }) => item.orderId)).toEqual([...ids].sort());
    for (const item of body.items) expect(item.reasons).toEqual([{
      code: 'BALANCE_DUE', category: 'FUNDS', message: expect.any(String), amount: { currency: 'CNY', minorUnits: 10000 }
    }]);
    expect(response.body).not.toMatch(/phone|secret|documentNumber|13800001234/);
    expect(await owner.selectFrom('orders').select(['id', 'version', 'status']).orderBy('id').execute()).toEqual(before);
  });

  it('paginates without changing the total or repeating an order', async () => {
    const first = (await app.inject({ method: 'GET', url: `${path}&limit=1`, headers })).json();
    expect(first.totalOrders).toBe(2); expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBe(first.items[0].orderId);
    const next = (await app.inject({ method: 'GET', url: `${path}&limit=1&afterId=${encodeURIComponent(first.nextCursor)}`, headers })).json();
    expect(next.totalOrders).toBe(2); expect(next.items).toHaveLength(1); expect(next.nextCursor).toBeNull();
    expect([first.items[0].orderId, next.items[0].orderId]).toEqual([...ids].sort());
  });

  it.each(['limit=0', 'limit=101', 'limit=1.5', 'afterId=x'] )('rejects invalid pagination: %s', async query => {
    expect((await app.inject({ method: 'GET', url: `${path}&${query}`, headers })).statusCode).toBe(400);
  });

  it('publishes GET-only structured OpenAPI and offers no write action', async () => {
    const document = (await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json();
    const endpoint = document.paths['/api/v1/workbench/exceptions'];
    expect(Object.keys(endpoint)).toEqual(['get']);
    const schema = endpoint.get.responses[200].content['application/json'].schema;
    expect(schema.required).toContain('totalOrders');
    expect(schema.properties.items.items.properties.reasons.items.required).toEqual(expect.arrayContaining(['code', 'category', 'message', 'amount']));
    expect((await app.inject({ method: 'POST', url: path, headers, payload: {} })).statusCode).toBe(404);
  });

  it('rechecks revocation on every request', async () => {
    await owner.updateTable('api_tokens').set({ revoked_at: new Date() }).where('id', '=', 'token_demo_read').execute();
    expect((await app.inject({ method: 'GET', url: path, headers })).statusCode).toBe(401);
  });
});

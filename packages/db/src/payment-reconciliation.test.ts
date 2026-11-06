import { describe, expect, it } from 'vitest';
import { projectPaymentReconciliation, summarizePaymentReconciliation,
  type ReconciliationBill, type ReconciliationFact, type ReconciliationClaim, type ReconciliationSnapshot } from './payment-reconciliation.ts';
const date = '2026-10-01T00:00:00.000Z';
const bill = (patch: Partial<ReconciliationBill> = {}): ReconciliationBill => ({ id: 'bill-parent', sourceId: 'source', merchantId: 'merchant',
  kind: 'COLLECTION', reference: 'collect', originalReference: null, amountMinor: 10000, state: 'SUCCESS', needsReview: false,
  nickname: '样例', occurredAt: date, discoveredAt: date, matchingEligible: true, ...patch });
const fact = (patch: Partial<ReconciliationFact> = {}): ReconciliationFact => ({ id: 'fact-collect', family: 'STAY', kind: 'COLLECTION',
  amountMinor: 10000, currency: 'CNY', reference: 'collect', originalReference: null, originalBillId: null, explicitBillId: null,
  orderId: 'order-one', membershipOrderId: null, predecessorId: null, createdAt: date, effective: true, ...patch });
const claim = (patch: Partial<ReconciliationClaim> = {}): ReconciliationClaim => ({ billId: 'bill-parent', factId: 'fact-collect', family: 'STAY',
  amountMinor: 10000, released: false, allocation: true, ...patch });
const snapshot = (patch: Partial<ReconciliationSnapshot> = {}): ReconciliationSnapshot => ({ bills: [bill()], facts: [], claims: [],
  matchingSince: '2026-08-31T16:00:00.000Z', ...patch });
const refund = (patch: Partial<ReconciliationBill> = {}) => bill({ id: 'bill-refund', kind: 'REFUND', reference: 'refund', originalReference: 'collect', ...patch });

describe('persistent per-payment reconciliation', () => {
  it('does not cancel missing collection and refund business against a zero net amount', () => {
    const rows = projectPaymentReconciliation(snapshot({ bills: [bill(), refund()] }));
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.issues.some(reason => reason.code === 'UNASSIGNED'))).toBe(true);
    expect(summarizePaymentReconciliation(rows)).toMatchObject({ collections: { externalMinor: '10000', businessMinor: '0', unassignedMinor: '10000' },
      refunds: { externalMinor: '10000', businessMinor: '0', unassignedMinor: '10000' } });
  });
  it('keeps old unresolved events without a today filter but excludes pre-boundary parents from totals', () => {
    const rows = projectPaymentReconciliation(snapshot({ bills: [bill({ matchingEligible: false, occurredAt: '2020-01-01T00:00:00.000Z' }), refund()] }));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.issues.map(reason => reason.code)).toEqual(['UNASSIGNED']);
    expect(summarizePaymentReconciliation(rows).collections.externalMinor).toBe('0');
  });
  it('distinguishes retained source occupation from reversed business rather than hiding a fully claimed bill', () => {
    const rows = projectPaymentReconciliation(snapshot({ facts: [fact({ effective: false })], claims: [claim()] }));
    expect(rows[0]).toMatchObject({ allocatedMinor: '10000', businessMinor: '0', unassignedMinor: '10000', orderId: 'order-one', orderIds: ['order-one'] });
    expect(rows[0]?.issues.map(reason => reason.code)).toEqual(['UNASSIGNED', 'BUSINESS_MISMATCH']);
  });
  it('drops released historical ownership and keeps all still-reserved order correction links', () => {
    const rows = projectPaymentReconciliation(snapshot({ facts: [fact({ effective: false }), fact({ id: 'fact-two', orderId: 'order-two', effective: false })],
      claims: [claim(), claim({ factId: 'fact-two' })] }));
    expect(rows[0]).toMatchObject({ orderId: null, orderIds: ['order-one', 'order-two'], businessMinor: '0' });
    const released = projectPaymentReconciliation(snapshot({ facts: [fact({ effective: false })], claims: [claim({ released: true }), claim({ allocation: false })] }));
    expect(released[0]).toMatchObject({ orderIds: [], allocatedMinor: '0' });
  });
  it('deduplicates migrated legacy matches and allocation records', () => {
    const rows = projectPaymentReconciliation(snapshot({ facts: [fact()], claims: [claim(), claim({ allocation: false })] }));
    expect(rows[0]).toMatchObject({ allocatedMinor: '10000', businessMinor: '10000', issues: [] });
  });
  it('shows the outstanding share after partial allocation and does not release refunded collection money', () => {
    const rows = projectPaymentReconciliation(snapshot({ bills: [bill(), refund({ amountMinor: 2000 })],
      facts: [fact({ amountMinor: 4000 }), fact({ id: 'fact-refund', kind: 'REFUND', reference: 'refund', amountMinor: 2000, originalBillId: 'bill-parent', originalReference: 'collect' })],
      claims: [claim({ amountMinor: 4000 }), claim({ billId: 'bill-refund', factId: 'fact-refund', amountMinor: 2000 })] }));
    expect(rows.find(row => row.kind === 'COLLECTION')).toMatchObject({ businessMinor: '4000', allocatedMinor: '4000', unassignedMinor: '6000' });
    expect(rows.find(row => row.kind === 'REFUND')?.issues).toEqual([]);
  });
  it('uses an active membership correction only once while tracing the original match', () => {
    const member = fact({ family: 'MEMBER', orderId: null, membershipOrderId: 'membership-one', effective: false });
    const rows = projectPaymentReconciliation(snapshot({ facts: [member, { ...member, id: 'correction-one', predecessorId: member.id },
      { ...member, id: 'correction-two', predecessorId: 'correction-one', effective: true }], claims: [claim({ family: 'MEMBER', allocation: false })] }));
    expect(rows[0]).toMatchObject({ businessMinor: '10000', allocatedMinor: '10000', membershipOrderId: 'membership-one', issues: [] });
  });
  it('can recognize an unlinked legacy membership correction without counting its reversed predecessor', () => {
    const rows = projectPaymentReconciliation(snapshot({ facts: [fact({ family: 'MEMBER', effective: false }),
      fact({ id: 'replacement', family: 'MEMBER', predecessorId: 'fact-collect' })] }));
    expect(rows[0]).toMatchObject({ businessMinor: '10000', allocatedMinor: '10000', issues: [] });
  });
  it('includes effective business without source and does not fabricate a matching bill from equal amounts', () => {
    const rows = projectPaymentReconciliation(snapshot({ facts: [fact({ reference: 'different-reference' })] }));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ billId: null, businessMinor: '10000', issues: [{ code: 'BUSINESS_WITHOUT_BILL', message: expect.any(String) }] });
    expect(summarizePaymentReconciliation(rows).collections).toMatchObject({ unassignedMinor: '10000', unbackedMinor: '10000' });
  });
  it('does not resolve duplicate references across merchants without an explicit source', () => {
    const rows = projectPaymentReconciliation(snapshot({ bills: [bill(), bill({ id: 'other-source', merchantId: 'other' })], facts: [fact()] }));
    expect(rows.filter(row => row.billId).every(row => row.issues.some(reason => reason.code === 'SOURCE_REVIEW'))).toBe(true);
    expect(rows.find(row => !row.billId)?.issues[0]?.code).toBe('SOURCE_REVIEW');
    expect(summarizePaymentReconciliation(rows).collections.externalMinor).toBe('0');
  });
  it('validates refund original identity with source and merchant, including missing original payments', () => {
    const rows = projectPaymentReconciliation(snapshot({ bills: [bill(), refund({ merchantId: 'other' })] }));
    expect(rows.find(row => row.kind === 'REFUND')?.issues.some(reason => reason.code === 'MISSING_ORIGINAL')).toBe(true);
  });
  it('flags a refund business linked to the wrong original instead of accepting equal gross totals', () => {
    const rows = projectPaymentReconciliation(snapshot({ bills: [bill(), refund()], facts: [fact({ kind: 'REFUND', reference: 'refund', originalBillId: 'wrong' })] }));
    expect(rows.find(row => row.kind === 'REFUND')?.issues.some(reason => reason.code === 'SOURCE_REVIEW')).toBe(true);
  });
  it.each([{ state: 'PENDING' }, { needsReview: true }, { amountMinor: null }])('never declares unverified fully allocated sources reconciled: %j', patch => {
    const rows = projectPaymentReconciliation(snapshot({ bills: [bill(patch)], facts: [fact()], claims: [claim()] }));
    expect(rows[0]?.issues.some(reason => reason.code === 'UNVERIFIED')).toBe(true);
    expect(summarizePaymentReconciliation(rows).collections).toMatchObject({ externalMinor: '0', unknownCount: 1 });
  });
  it('keeps overclaims visible and preserves exact totals above 32 bit', () => {
    const rows = projectPaymentReconciliation(snapshot({ bills: [bill({ amountMinor: 2147483647 }), bill({ id: 'second', reference: 'second', amountMinor: 2147483647 })],
      facts: [fact({ amountMinor: 2147483647 }), fact({ id: 'extra', amountMinor: 100 })] }));
    expect(rows[0]?.issues.some(reason => reason.code === 'OVERCLAIMED')).toBe(true);
    expect(summarizePaymentReconciliation(rows).collections.externalMinor).toBe('4294967294');
  });
  it('hides resolved closed flows, retains closed flows with claimed business, and excludes old unbacked history', () => {
    expect(projectPaymentReconciliation(snapshot({ bills: [bill({ state: 'CLOSED' })] }))).toEqual([]);
    expect(projectPaymentReconciliation(snapshot({ bills: [bill({ state: 'CLOSED' })], facts: [fact()] }))[0]?.issues[0]?.code).toBe('UNVERIFIED');
    expect(projectPaymentReconciliation(snapshot({ bills: [], facts: [fact({ createdAt: '2020-01-01T00:00:00.000Z' })] }))).toEqual([]);
  });
});

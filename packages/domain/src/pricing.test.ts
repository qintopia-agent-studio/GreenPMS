import { describe, expect, it } from 'vitest';
import { DomainError } from '@qintopia/contracts';
import { amountSummary, calculatePricing, type PricingInput, type PricingPolicy } from './pricing.ts';

const base = {
  propertyId: '10000000-0000-4000-8000-000000000001',
  inventoryUnitId: '20000000-0000-4000-8000-000000000001',
  inventoryUnitKind: 'ROOM' as const,
  arrivalDate: '2026-07-20',
  departureDate: '2026-07-23',
  stayType: 'TRANSIENT' as const,
} satisfies Omit<PricingInput, 'policy'>;

const policy: PricingPolicy = {
  id: '30000000-0000-4000-8000-000000000001',
  stayType: 'TRANSIENT',
  calculationKind: 'FLAT_NIGHTLY',
  currency: 'CNY',
  nightlyRateMinor: 12_800,
};

describe('approved finite pricing policies', () => {
  it('forms coverage before calculating the cash remainder', () => {
    const quote = calculatePricing({
      ...base,
      policy,
      coverageCandidates: [{
        serviceDate: '2026-07-20',
        entitlementLotId: '40000000-0000-4000-8000-000000000099',
      }],
    });
    expect(quote.coverageSet).toHaveLength(1);
    expect(quote.cashLines.filter((line) => 'serviceDate' in line).map((line) => line.serviceDate)).toEqual(['2026-07-21', '2026-07-22']);
    expect(quote.currentContractAmount.minorUnits).toBe(25_600);
  });

  it.each(['WEEKLY', 'MONTHLY', 'CUSTOM', 'FIXED_TERM', 'ROLLING'] as const)('rejects a matching but unapproved %s nightly policy', (stayType) => {
    const unapprovedPolicy: PricingPolicy = { ...policy, stayType };
    expect(() => calculatePricing({ ...base, stayType, policy: unapprovedPolicy, coverageCandidates: [] }))
      .toThrow(expect.objectContaining<Partial<DomainError>>({ code: 'PRICING_POLICY_UNCONFIGURED' }));
  });

  it('rejects policy calculation shapes that are not approved for their stay type', () => {
    expect(() => calculatePricing({
      ...base,
      policy: { ...policy, calculationKind: 'FREE', nightlyRateMinor: 0 },
      coverageCandidates: [],
    })).toThrow(expect.objectContaining<Partial<DomainError>>({ code: 'PRICING_POLICY_UNCONFIGURED' }));

    expect(() => calculatePricing({
      ...base,
      stayType: 'FREE',
      policy: { ...policy, stayType: 'FREE', calculationKind: 'FLAT_NIGHTLY' },
      coverageCandidates: [],
    })).toThrow(expect.objectContaining<Partial<DomainError>>({ code: 'PRICING_POLICY_UNCONFIGURED' }));
  });

  it('rejects unapproved cross-month fixed-night calculations', () => {
    expect(() => calculatePricing({
      ...base,
      arrivalDate: '2026-07-31',
      departureDate: '2026-08-02',
      policy,
      coverageCandidates: [],
    })).toThrowError(/Cross-month/);
  });

  it('does not carry a prior manual adjustment into a new revision', () => {
    const oldRevision = calculatePricing({ ...base, manualAdjustmentMinor: -800, policy, coverageCandidates: [] });
    const newRevision = calculatePricing({ ...base, policy, coverageCandidates: [] });
    expect(oldRevision.currentContractAmount.minorUnits).toBe(37_600);
    expect(newRevision.currentContractAmount.minorUnits).toBe(38_400);
  });

  it('derives a non-negative refund reference from recorded collection facts', () => {
    expect(amountSummary('CNY', 20_000, [15_000, 10_000, -2_000])).toEqual({
      currentContractAmount: { currency: 'CNY', minorUnits: 20_000 },
      netRecordedCollection: { currency: 'CNY', minorUnits: 23_000 },
      collectionDifference: { currency: 'CNY', minorUnits: -3_000 },
      refundReferenceAmount: { currency: 'CNY', minorUnits: 3_000 },
    });
    expect(amountSummary('CNY', 20_000, [8_000])).toMatchObject({
      refundReferenceAmount: { currency: 'CNY', minorUnits: 0 },
    });
  });

  it('fails closed when aggregated collections would exceed the refund reference contract', () => {
    expect(() => amountSummary('CNY', 0, [2_000_000_000, 200_000_000]))
      .toThrowError(/建议退款金额超出支持范围/);
  });

  it('accepts the maximum public refund reference and rejects the next minor unit', () => {
    expect(amountSummary('CNY', 100, [2_147_483_747]).refundReferenceAmount)
      .toEqual({ currency: 'CNY', minorUnits: 2_147_483_647 });
    expect(() => amountSummary('CNY', 99, [2_147_483_747]))
      .toThrowError(/建议退款金额超出支持范围/);
  });
});

import { describe, expect, it } from 'vitest';
import { workbenchExceptionReasons, type WorkbenchExceptionEvidence } from './workbench-exception-rules.ts';

const today = '2026-10-24';
const base: WorkbenchExceptionEvidence = {
  orderStatus: 'CANCELLED', stayStatus: 'CANCELLED', arrivalDate: '2026-10-20', departureDate: '2026-10-27',
  stayType: 'TRANSIENT', bookingChannelCode: 'WECOM', currency: 'CNY', contractMinor: '0', netMinor: '0', retainedMinor: '0',
  fundsInconsistent: false, lifecycleInconsistent: false, activeClaims: 0, heldCoverage: 0,
  channelInitialized: true, channelFactCount: 0, channelHasSale: false, channelNetMinor: '0', channelInconsistent: false
};
const project = (overrides: Partial<WorkbenchExceptionEvidence> = {}, date = today) => workbenchExceptionReasons({ ...base, ...overrides }, date);
const codes = (overrides: Partial<WorkbenchExceptionEvidence> = {}, date = today) => project(overrides, date).map(r => r.code);
const amount = (overrides: Partial<WorkbenchExceptionEvidence>, expected: number, code: string) => expect(project(overrides)).toEqual([expect.objectContaining({ code, amount: { currency: 'CNY', minorUnits: expected } })]);

describe('workbench actionable exception rules', () => {
  it.each(['CANCELLED', 'NO_SHOW', 'CHECK_IN_REVOKED'])('does not treat resolved %s as a task, regardless of former dates', status => {
    for (const date of ['2020-01-01', today, '2030-01-01']) expect(codes({ orderStatus: status, stayStatus: status }, date)).toEqual([]);
  });
  it('keeps the three equivalent free/channel/direct cancellation cases out of the queue', () => {
    expect(project({ stayType: 'FREE' })).toEqual([]);
    expect(project({ bookingChannelCode: 'MEITUAN', channelFactCount: 2, channelHasSale: true })).toEqual([]);
    expect(project()).toEqual([]);
  });
  it('distinguishes overdue planned arrivals from completed no-show handling and retains very old unhandled arrivals', () => {
    expect(codes({ orderStatus: 'RESERVED', stayStatus: 'PLANNED', arrivalDate: today })).toEqual([]);
    expect(codes({ orderStatus: 'RESERVED', stayStatus: 'PLANNED', departureDate: '2026-10-21' })).toEqual(['OVERDUE_ARRIVAL']);
    expect(codes({ orderStatus: 'NO_SHOW', stayStatus: 'NO_SHOW' })).toEqual([]);
  });
  it('only marks in-house departure overdue after, not on, the departure day', () => {
    expect(codes({ orderStatus: 'CHECKED_IN', stayStatus: 'IN_HOUSE', departureDate: today })).toEqual([]);
    expect(codes({ orderStatus: 'CHECKED_IN', stayStatus: 'IN_HOUSE', departureDate: '2026-10-23' })).toEqual(['OVERDUE_DEPARTURE']);
  });
  it.each(['RESERVED', 'CHECKED_IN', 'CHECKED_OUT'])('includes %s underpayments without treating paid membership rights as cash debt', status => {
    const stayStatus = { RESERVED: 'PLANNED', CHECKED_IN: 'IN_HOUSE', CHECKED_OUT: 'COMPLETED' }[status]!;
    amount({ orderStatus: status, stayStatus, arrivalDate: today, contractMinor: '10000', netMinor: '8000' }, 2000, 'BALANCE_DUE');
    expect(project({ orderStatus: status, stayStatus, arrivalDate: today, contractMinor: '0', netMinor: '0' })).toEqual([]);
  });
  it('keeps normal checked-out contract amounts and flags only the excess', () => {
    amount({ orderStatus: 'CHECKED_OUT', stayStatus: 'COMPLETED', contractMinor: '10000', netMinor: '12000' }, 2000, 'OVERPAYMENT');
  });
  it('shows only remaining unrefunded and unretained money across former stay dates', () => {
    amount({ netMinor: '60000', arrivalDate: '2020-01-01', departureDate: '2020-01-02' }, 60000, 'REFUND_DUE');
    amount({ netMinor: '40000' }, 40000, 'REFUND_DUE');
    amount({ netMinor: '60000', retainedMinor: '20000' }, 40000, 'REFUND_DUE');
    expect(project({ netMinor: '60000', retainedMinor: '60000' })).toEqual([]);
  });
  it('updates remaining source net and retention after use, refund, release and reversal', () => {
    expect(project({ netMinor: '20000', retainedMinor: '20000' })).toEqual([]); // used 400 of 600
    expect(project({ netMinor: '0', retainedMinor: '0' })).toEqual([]); // refunded remaining 200
    amount({ netMinor: '20000', retainedMinor: '0' }, 20000, 'REFUND_DUE'); // released, or refund reversed
  });
  it.each([{ netMinor: '-1' }, { retainedMinor: '-1' }, { netMinor: '100', retainedMinor: '101' }, { fundsInconsistent: true }, { contractMinor: '100' }, { contractMinor: null }, { currency: null }, { netMinor: '9007199254740992' }])('does not disguise corrupt funds as settled or payable: %j', overrides => {
    expect(codes(overrides)).toEqual(['FUNDS_INCONSISTENT']);
  });
  it('does not create normal receivables for free accommodation', () => {
    expect(codes({ stayType: 'FREE', contractMinor: '100' })).toEqual(['FUNDS_INCONSISTENT']);
  });
  it('uses the channel ledger instead of zero PMS cash collections', () => {
    expect(project({ orderStatus: 'RESERVED', stayStatus: 'PLANNED', arrivalDate: today, bookingChannelCode: 'MEITUAN', contractMinor: '10000', channelNetMinor: '10000', channelHasSale: true, channelFactCount: 1 })).toEqual([]);
    amount({ bookingChannelCode: 'MEITUAN', channelNetMinor: '10000', channelHasSale: true, channelFactCount: 1 }, 10000, 'CHANNEL_REFUND_DUE');
    amount({ bookingChannelCode: 'CTRIP', channelNetMinor: '4000', channelHasSale: true, channelFactCount: 2 }, 4000, 'CHANNEL_REFUND_DUE');
    expect(project({ bookingChannelCode: 'YOUMUDAO', channelNetMinor: '0', channelHasSale: true, channelFactCount: 2 })).toEqual([]);
  });
  it.each([{ netMinor: '10000' }, { retainedMinor: '10000' }, { fundsInconsistent: true }])('keeps ordinary historical money visible even after the channel refund is settled: %j', overrides => {
    expect(project({ bookingChannelCode: 'MEITUAN', channelHasSale: true, channelFactCount: 2, ...overrides }))
      .toEqual([expect.objectContaining({ code: 'FUNDS_INCONSISTENT', category: 'DATA', amount: null })]);
  });
  it('does not offset ordinary historical money against the channel refund', () => {
    const reasons = project({ bookingChannelCode: 'MEITUAN', channelHasSale: true, channelFactCount: 1, channelNetMinor: '27720', netMinor: '-10000' });
    expect(reasons.map(reason => reason.code)).toEqual(['FUNDS_INCONSISTENT', 'CHANNEL_REFUND_DUE']);
    expect(reasons[1]?.amount).toEqual({ currency: 'CNY', minorUnits: 27720 });
  });
  it.each([{ channelInitialized: false }, { channelHasSale: false }, { channelFactCount: 0 }, { channelInconsistent: true }])('keeps missing channel evidence visible: %j', overrides => {
    expect(codes({ bookingChannelCode: 'MEITUAN', channelHasSale: true, channelFactCount: 2, ...overrides })).toEqual(['CHANNEL_DATA_REVIEW']);
  });
  it('shows channel amount mismatch without inventing customer debt', () => {
    expect(codes({ orderStatus: 'CHECKED_OUT', stayStatus: 'COMPLETED', bookingChannelCode: 'MEITUAN', contractMinor: '100', channelNetMinor: '50', channelHasSale: true, channelFactCount: 2 })).toEqual(['CHANNEL_AMOUNT_MISMATCH']);
  });
  it('includes every independent reason for one order', () => {
    expect(codes({ stayStatus: 'IN_HOUSE', lifecycleInconsistent: true, activeClaims: 3, heldCoverage: 2, netMinor: '600' })).toEqual(['LIFECYCLE_INCONSISTENT', 'INVENTORY_NOT_RELEASED', 'COVERAGE_NOT_RELEASED', 'REFUND_DUE']);
    expect(codes({ orderStatus: 'RESERVED', stayStatus: 'PLANNED', contractMinor: '100' })).toEqual(['OVERDUE_ARRIVAL', 'BALANCE_DUE']);
  });
});

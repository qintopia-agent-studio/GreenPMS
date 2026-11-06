import type { WorkbenchExceptionReason } from '@qintopia/contracts';

/** Aggregated, read-only evidence. Integer strings avoid rounding database SUM(bigint). */
export interface WorkbenchExceptionEvidence {
  orderStatus: string;
  stayStatus: string | null;
  arrivalDate: string;
  departureDate: string;
  stayType: string;
  bookingChannelCode: string | null;
  currency: string | null;
  contractMinor: string | null;
  netMinor: string;
  retainedMinor: string;
  fundsInconsistent: boolean;
  lifecycleInconsistent: boolean;
  activeClaims: number;
  heldCoverage: number;
  channelInitialized: boolean;
  channelFactCount: number;
  channelHasSale: boolean;
  channelNetMinor: string;
  channelInconsistent: boolean;
}
const endedWithoutStay = new Set(['CANCELLED', 'NO_SHOW', 'CHECK_IN_REVOKED']);
const terminal = new Set([...endedWithoutStay, 'CHECKED_OUT']);
const endedLabel: Record<string, string> = { CANCELLED: '已取消', NO_SHOW: '已标记未到', CHECK_IN_REVOKED: '已撤销入住', CHECKED_OUT: '已退房' };
const expectedStay: Record<string, string> = { RESERVED: 'PLANNED', CHECKED_IN: 'IN_HOUSE', CHECKED_OUT: 'COMPLETED', CANCELLED: 'CANCELLED', NO_SHOW: 'NO_SHOW', CHECK_IN_REVOKED: 'CHECK_IN_REVOKED' };
const channels = new Set(['MEITUAN', 'CTRIP', 'YOUMUDAO']);
function integer(value: string | null): bigint | null {
  return value !== null && /^-?\d+$/.test(value) ? BigInt(value) : null;
}

export function workbenchExceptionReasons(e: WorkbenchExceptionEvidence, businessDate: string): WorkbenchExceptionReason[] {
  const reasons: WorkbenchExceptionReason[] = [];
  const add = (code: WorkbenchExceptionReason['code'], category: WorkbenchExceptionReason['category'], message: string, amount: bigint | null = null) => {
    // A malformed/oversized balance remains visible as DATA, never as a rounded amount.
    const safe = amount === null || amount <= BigInt(Number.MAX_SAFE_INTEGER);
    reasons.push({ code, category, message, amount: amount !== null && safe && e.currency ? { currency: e.currency, minorUnits: Number(amount) } : null });
  };
  if (e.lifecycleInconsistent || !expectedStay[e.orderStatus] || expectedStay[e.orderStatus] !== e.stayStatus) {
    add('LIFECYCLE_INCONSISTENT', 'DATA', '订单显示的入住或退房情况，与住宿记录对不上');
  }
  if (e.orderStatus === 'RESERVED' && e.stayStatus === 'PLANNED' && e.arrivalDate < businessDate) {
    add('OVERDUE_ARRIVAL', 'FULFILLMENT', `${e.arrivalDate} 应到店，还没办理入住，请确认客人是否到店`);
  }
  if (e.orderStatus === 'CHECKED_IN' && e.stayStatus === 'IN_HOUSE' && e.departureDate < businessDate) {
    add('OVERDUE_DEPARTURE', 'FULFILLMENT', `${e.departureDate} 应离店，仍显示在住，请确认退房或续住`);
  }
  if (terminal.has(e.orderStatus) && e.activeClaims > 0) add('INVENTORY_NOT_RELEASED', 'INVENTORY', `订单${endedLabel[e.orderStatus]}，房间或床位仍被这张订单占用`);
  if (terminal.has(e.orderStatus) && e.heldCoverage > 0) add('COVERAGE_NOT_RELEASED', 'INVENTORY', `订单${endedLabel[e.orderStatus]}，仍占着会员可用的住宿额度`);

  const c = integer(e.contractMinor), n = integer(e.netMinor), l = integer(e.retainedMinor);
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  const externalChannel = channels.has(e.bookingChannelCode ?? '') && e.stayType !== 'FREE';
  if (c === null || !e.currency || c < 0n || c > maxSafe
    || (endedWithoutStay.has(e.orderStatus) && c !== 0n)) {
    add('FUNDS_INCONSISTENT', 'DATA', '订单应收金额或币种不对，请查看订单账目');
    return reasons;
  }
  if (externalChannel) {
    // Historical channel orders can still carry old ordinary collection facts.
    // They cannot be silently ignored, or offset against the separate channel ledger.
    if (e.fundsInconsistent || n !== 0n || l !== 0n) {
      add('FUNDS_INCONSISTENT', 'DATA', '平台订单里还记有另外收退的钱或留给下次用的钱，请查看是否记错');
    }
    const channelNet = integer(e.channelNetMinor);
    if (!e.channelInitialized || !e.channelHasSale || e.channelFactCount === 0 || e.channelInconsistent || channelNet === null) {
      add('CHANNEL_DATA_REVIEW', 'DATA', '平台订单的成交、退款或历史账资料不完整，请先核实这些记录');
    } else if (channelNet < c || channelNet < 0n || channelNet > maxSafe) {
      add('CHANNEL_AMOUNT_MISMATCH', 'DATA', '平台订单应结算的钱，与已记的成交和退款金额对不上', channelNet >= 0n && channelNet < c ? c - channelNet : null);
    } else if (channelNet > c) {
      add('CHANNEL_REFUND_DUE', 'FUNDS', '平台订单里还有款项待退，请确认平台退款是否已登记', channelNet - c);
    }
    return reasons;
  }
  if (e.fundsInconsistent || n === null || l === null || n < 0n || l < 0n || n > maxSafe || l > maxSafe
    || (e.stayType === 'FREE' && (c !== 0n || n !== 0n || l !== 0n))) {
    add('FUNDS_INCONSISTENT', 'DATA', '这张订单的应收、收退款或留给下次用的钱对不上');
    return reasons;
  }
  if (l > (n > c ? n - c : 0n)) {
    add('FUNDS_INCONSISTENT', 'DATA', '记作留给下次用的钱，超过了这张订单多收的钱');
    return reasons;
  }
  if (n < c && ['RESERVED', 'CHECKED_IN', 'CHECKED_OUT'].includes(e.orderStatus)) {
    add('BALANCE_DUE', 'FUNDS', '订单里还有住宿款未收齐', c - n);
  } else if (n - c - l > 0n) {
    add(endedWithoutStay.has(e.orderStatus) ? 'REFUND_DUE' : 'OVERPAYMENT', 'FUNDS', endedWithoutStay.has(e.orderStatus) ? '订单里还有款项待退，请先确认是否已经退款' : '订单里有多收的款还没处理', n - c - l);
  }
  return reasons;
}

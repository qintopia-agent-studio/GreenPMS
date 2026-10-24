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
    add('LIFECYCLE_INCONSISTENT', 'DATA', '订单与住宿状态或履约记录不一致，需核对');
  }
  if (e.orderStatus === 'RESERVED' && e.stayStatus === 'PLANNED' && e.arrivalDate < businessDate) {
    add('OVERDUE_ARRIVAL', 'FULFILLMENT', `计划到店日 ${e.arrivalDate} 已过，尚未处理到店`);
  }
  if (e.orderStatus === 'CHECKED_IN' && e.stayStatus === 'IN_HOUSE' && e.departureDate < businessDate) {
    add('OVERDUE_DEPARTURE', 'FULFILLMENT', `计划离店日 ${e.departureDate} 已过，需确认实际住宿状态`);
  }
  if (terminal.has(e.orderStatus) && e.activeClaims > 0) add('INVENTORY_NOT_RELEASED', 'INVENTORY', '已结束订单仍有有效库存占用，需核对释放记录');
  if (terminal.has(e.orderStatus) && e.heldCoverage > 0) add('COVERAGE_NOT_RELEASED', 'INVENTORY', '已结束订单仍有预留会员权益，需核对释放记录');

  const c = integer(e.contractMinor), n = integer(e.netMinor), l = integer(e.retainedMinor);
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  const externalChannel = channels.has(e.bookingChannelCode ?? '') && e.stayType !== 'FREE';
  if (c === null || !e.currency || c < 0n || c > maxSafe
    || (endedWithoutStay.has(e.orderStatus) && c !== 0n)) {
    add('FUNDS_INCONSISTENT', 'DATA', '当前应收或币种存在不一致，需核对资金记录');
    return reasons;
  }
  if (externalChannel) {
    // Historical channel orders can still carry old ordinary collection facts.
    // They cannot be silently ignored, or offset against the separate channel ledger.
    if (e.fundsInconsistent || n !== 0n || l !== 0n) {
      add('FUNDS_INCONSISTENT', 'DATA', '渠道订单仍有普通收退款或留存余额，需核对资金归属');
    }
    const channelNet = integer(e.channelNetMinor);
    if (!e.channelInitialized || !e.channelHasSale || e.channelFactCount === 0 || e.channelInconsistent || channelNet === null) {
      add('CHANNEL_DATA_REVIEW', 'DATA', '渠道成交或期初承接资料不完整，需核对渠道记录');
    } else if (channelNet < c || channelNet < 0n || channelNet > maxSafe) {
      add('CHANNEL_AMOUNT_MISMATCH', 'DATA', '当前渠道应结与渠道经营净额不一致，需核对成交及退款记录', channelNet >= 0n && channelNet < c ? c - channelNet : null);
    } else if (channelNet > c) {
      add('CHANNEL_REFUND_DUE', 'FUNDS', '渠道应退金额尚未完成退款登记', channelNet - c);
    }
    return reasons;
  }
  if (e.fundsInconsistent || n === null || l === null || n < 0n || l < 0n || n > maxSafe || l > maxSafe
    || (e.stayType === 'FREE' && (c !== 0n || n !== 0n || l !== 0n))) {
    add('FUNDS_INCONSISTENT', 'DATA', '应收、收退款或留存来源存在不一致，需核对资金记录');
    return reasons;
  }
  if (l > (n > c ? n - c : 0n)) {
    add('FUNDS_INCONSISTENT', 'DATA', '剩余留存超过本单可留存款项，需核对资金归属');
    return reasons;
  }
  if (n < c && ['RESERVED', 'CHECKED_IN', 'CHECKED_OUT'].includes(e.orderStatus)) {
    add('BALANCE_DUE', 'FUNDS', '住宿款尚未收齐', c - n);
  } else if (n - c - l > 0n) {
    add(endedWithoutStay.has(e.orderStatus) ? 'REFUND_DUE' : 'OVERPAYMENT', 'FUNDS', endedWithoutStay.has(e.orderStatus) ? '取消或终止住宿后仍有未退款且未留存的款项' : '多收款项尚未处理', n - c - l);
  }
  return reasons;
}

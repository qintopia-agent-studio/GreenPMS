/** 普通住宿手工最终金额按十进制文本转整数分；不舍入政策基价。 */
export function parseStayFinalYuanToMinor(value: string): number | undefined {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return undefined;
  const minor = BigInt(match[1]!) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  return minor <= 2_147_483_600n ? Number(minor) : undefined;
}

export function isExternalBookingChannel(value: unknown): boolean {
  return value === "YOUMUDAO" || value === "CTRIP" || value === "MEITUAN";
}

// 保留已有渠道入口，所有普通住宿最终金额共用同一精度和范围约束。
export const parseChannelYuanToMinor = parseStayFinalYuanToMinor;

export function supportsDecimalStayFinalAmount(order: {
  booking_channel_code: unknown;
  stay_type?: unknown;
  member_id?: unknown;
  member_contract_id?: unknown;
}): boolean {
  return order.stay_type !== "FREE" && !order.member_id && !order.member_contract_id
    && (order.booking_channel_code === "WECOM" || isExternalBookingChannel(order.booking_channel_code));
}

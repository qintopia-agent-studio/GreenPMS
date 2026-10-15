/** 渠道应结金额按十进制文本转整数分，不舍入，不改变非渠道定价规则。 */
export function parseChannelYuanToMinor(value: string): number | undefined {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return undefined;
  const minor = BigInt(match[1]!) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  return minor <= 2_147_483_600n ? Number(minor) : undefined;
}

export function isExternalBookingChannel(value: unknown): boolean {
  return value === "YOUMUDAO" || value === "CTRIP" || value === "MEITUAN";
}

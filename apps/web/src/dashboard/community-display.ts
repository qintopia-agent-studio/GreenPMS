import type { CommunityDay } from "@qintopia/contracts";

export const registrationExplanation = "按每条有效住宿人登记统计，同一登记在当天只计一次；尚未跨订单合并同一住客，不等于统计期内去重接待人数。无需证件号即可查看登记事实。";
export function displayedCommunityDay(day: CommunityDay, registrationBasis: boolean): CommunityDay {
  if (!registrationBasis) return day;
  if (!day.registered) return { ...day, total: null };
  return { ...day, ...day.registered };
}
export function displayedCommunityTrend(trend: CommunityDay[]) {
  const registrationBasis = trend.some(day => day.total === null && day.registered !== undefined);
  const rows = trend.map(day => displayedCommunityDay(day, registrationBasis));
  const dailyAverage = rows.length && rows.every(day => day.total !== null)
    ? rows.reduce((sum, day) => sum + day.total!, 0) / rows.length : null;
  return { registrationBasis, rows, dailyAverage };
}

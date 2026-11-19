// Product and room names are staff-entered. A price embedded in a label is also private here.
export function memberFacingLabel(label: string, fallback = "住宿会员权益") {
  return /[¥￥]|人民币|(?:CNY|RMB)\s*[\d.,]+|[\d零〇一二两三四五六七八九十百千万.,]+\s*(?:元|块钱|RMB|CNY)/i.test(label) ? fallback : label;
}

export type MemberCardStatus = "ACTIVE" | "PENDING" | "EXPIRED" | "VOIDED" | "CANCELLED";
export type MemberNightUnit = "ROOM_NIGHT" | "BED_NIGHT";
export function mainlandMemberPhone(input: string): string | undefined {
  const number = input.replace(/[\s()-]/g, "").replace(/^(?:\+86|0086|86)/, "");
  return /^1[3-9]\d{9}$/.test(number) ? number : undefined;
}
export interface MemberEntitlementCard {
  product: string;
  rooms: string[];
  unit: MemberNightUnit;
  status: MemberCardStatus;
  available: number | null;
  held: number;
  startsOn: string | null;
  expiresOn: string | null;
  reminderDates: string[];
}
export interface MemberEntitlementHistory {
  product: string;
  unit: MemberNightUnit;
  action: string;
  quantity: number;
  serviceDate: string | null;
  recordedOn: string;
}
export interface MemberCenterView {
  asOf: string;
  cards: MemberEntitlementCard[];
  history: MemberEntitlementHistory[];
  next: string | null;
}
export type MemberCenterState =
  | { status: "DISABLED" | "SIGNED_OUT" }
  | { status: "UNBOUND"; smsAvailable: boolean }
  | { status: "BOUND"; view: MemberCenterView; remindersEnabled: boolean; subscribed: boolean };

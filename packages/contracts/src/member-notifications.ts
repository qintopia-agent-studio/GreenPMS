export type MemberNoticeField =
  | "product"
  | "expiry"
  | "days"
  | "room"
  | "arrival"
  | "departure"
  | "status"
  | "reference";
export interface MemberNoticeTemplate {
  template: string;
  fields: Partial<Record<string, MemberNoticeField>>;
}
export interface MemberNoticeRules {
  leadDays: number[];
  expiryEnabled: boolean;
  bookingEnabled: boolean;
  smsEnabled: boolean;
  expiry: MemberNoticeTemplate | null;
  booking: MemberNoticeTemplate | null;
  smsSign: string;
  smsTemplate: string;
}
export const defaultNoticeRules: MemberNoticeRules = {
  leadDays: [60, 30],
  expiryEnabled: true,
  bookingEnabled: true,
  smsEnabled: true,
  expiry: null,
  booking: null,
  smsSign: "",
  smsTemplate: ""
};
export const noticeFieldNames: Record<MemberNoticeField, string> = {
  product: "权益名称",
  expiry: "到期日",
  days: "提前天数",
  room: "房型",
  arrival: "入住日",
  departure: "离店日",
  status: "排房结果",
  reference: "预订编号"
};
export const noticeFieldExample: Record<MemberNoticeField, string> = {
  product: "住宿会员",
  expiry: "2027-05-31",
  days: "30",
  room: "独卫标间",
  arrival: "2027-04-01",
  departure: "2027-04-03",
  status: "已确认",
  reference: "Q123456789"
};
const fieldPatterns: Record<MemberNoticeField, RegExp> = {
  product: /^thing\d+$/,
  expiry: /^date\d+$/,
  days: /^number\d+$/,
  room: /^thing\d+$/,
  arrival: /^date\d+$/,
  departure: /^date\d+$/,
  status: /^(?:thing|phrase)\d+$/,
  reference: /^character_string\d+$/
};
export function validNoticeTemplate(setting: MemberNoticeTemplate, kind: "expiry" | "booking") {
  const allow: MemberNoticeField[] =
    kind === "expiry" ? ["product", "expiry", "days"] : ["room", "arrival", "departure", "status", "reference"];
  const fields = Object.entries(setting.fields);
  return (
    /^[A-Za-z0-9_-]{1,160}$/.test(setting.template) &&
    fields.length > 0 &&
    new Set(fields.map(([, value]) => value)).size === fields.length &&
    fields.every(([key, value]) => value && allow.includes(value) && fieldPatterns[value].test(key)) &&
    fields.some(([, value]) => value === (kind === "expiry" ? "expiry" : "status"))
  );
}
export function renderNoticeFields(setting: MemberNoticeTemplate, values: Partial<Record<MemberNoticeField, string>>) {
  return Object.fromEntries(
    Object.entries(setting.fields).map(([key, field]) => {
      const raw = values[field!] ?? "";
      const value =
        key.startsWith("date") && /^\d{4}-\d{2}-\d{2}$/.test(raw)
          ? raw.slice(0, 4) + "年" + Number(raw.slice(5, 7)) + "月" + Number(raw.slice(8)) + "日"
          : raw;
      return [key, { value: key.startsWith("thing") ? Array.from(value).slice(0, 20).join("") : value }];
    })
  );
}
export type BookingStatus = "PENDING" | "CONFIRMED" | "DECLINED";
export interface MemberBooking {
  id: string;
  arrival: string;
  departure: string;
  room: string;
  kind: "ROOM" | "BED";
  status: BookingStatus;
  created: string;
  decided: string | null;
  attention?: string;
  stay?: { status: string; arrival: string; departure: string };
}
export interface BookingRoom {
  code: string;
  name: string;
  kind: "ROOM" | "BED";
}
export interface MemberBookings {
  bookings: MemberBooking[];
  rooms: BookingRoom[];
  today: string;
  next: string | null;
}
export interface StaffBooking extends MemberBooking {
  member: string;
  memberId: string;
  orderId: string | null;
  operator: string | null;
  notice: string | null;
}
export interface MemberInteraction {
  id: string;
  member: string | null;
  kind: string;
  state: string;
  detail: string;
  template: string | null;
  content: Record<string, string>;
  created: string;
  updated: string;
}
export interface MemberSettingsView {
  rules: MemberNoticeRules;
  version: number;
  updatedBy: string | null;
  updatedAt: string | null;
  wechatReady: boolean;
  smsReady: boolean;
  entry: string | null;
}

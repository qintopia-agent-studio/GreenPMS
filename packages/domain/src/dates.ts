import { DomainError } from "@qintopia/contracts";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_SERVICE_NIGHTS = 366;

/** Add a calendar duration once, clamping only in the destination month. */
export function addMembershipValidity(localDate: string, period: string): string {
  const start = parseLocalDate(localDate);
  if (start.getUTCFullYear() < 1) throw new DomainError("VALIDATION_ERROR", "会员起始日期超出支持范围");
  const match = /^P([1-9]\d*)(M|Y)$/.exec(period);
  if (!match) throw new DomainError("VALIDATION_ERROR", "会员有效期须为正整数月或年");
  const count = Number(match[1]);
  if (!Number.isSafeInteger(count) || count > 2_147_483_647) {
    throw new DomainError("VALIDATION_ERROR", "会员有效期超出支持范围");
  }
  const months = count * (match[2] === "Y" ? 12 : 1);
  const targetMonth = start.getUTCFullYear() * 12 + start.getUTCMonth() + months;
  const year = Math.floor(targetMonth / 12);
  const month = targetMonth % 12;
  if (year > 9999 || year < 1) throw new DomainError("VALIDATION_ERROR", "会员到期日期超出支持范围");
  // setUTCFullYear also handles years 1–99 without Date.UTC's 1900 offset.
  const end = new Date(0);
  end.setUTCFullYear(year, month + 1, 0);
  const day = Math.min(start.getUTCDate(), end.getUTCDate());
  end.setUTCFullYear(year, month, day);
  return end.toISOString().slice(0, 10);
}

export function parseLocalDate(value: string): Date {
  if (!ISO_DATE.test(value)) throw new DomainError("VALIDATION_ERROR", `Invalid local date: ${value}`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new DomainError("VALIDATION_ERROR", `Invalid local date: ${value}`);
  }
  return date;
}

export function enumerateServiceDates(arrivalDate: string, departureDate: string): string[] {
  const arrival = parseLocalDate(arrivalDate);
  const departure = parseLocalDate(departureDate);
  if (departure <= arrival) {
    throw new DomainError("VALIDATION_ERROR", "departureDate must be after arrivalDate");
  }
  const nightCount = (departure.getTime() - arrival.getTime()) / 86_400_000;
  if (nightCount > MAX_SERVICE_NIGHTS) {
    throw new DomainError("VALIDATION_ERROR", `Stay cannot exceed ${MAX_SERVICE_NIGHTS} service nights`);
  }
  const dates: string[] = [];
  for (let cursor = arrival.getTime(); cursor < departure.getTime(); cursor += 86_400_000) {
    dates.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return dates;
}

export function todayInTimeZone(timeZone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

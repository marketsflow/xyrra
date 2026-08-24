/** Reporting timezone for outreach send dates (Bangkok business day). */
export const SENT_EMAIL_TIMEZONE = "Asia/Bangkok";

export function toSentEmailDateKey(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SENT_EMAIL_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function sentEmailDateKeyWithOffset(dayOffset: number) {
  const todayKey = toSentEmailDateKey(new Date());
  const [year, month, day] = todayKey.split("-").map(Number);
  const adjusted = new Date(year, month - 1, day);
  adjusted.setDate(adjusted.getDate() + dayOffset);

  const nextYear = adjusted.getFullYear();
  const nextMonth = String(adjusted.getMonth() + 1).padStart(2, "0");
  const nextDay = String(adjusted.getDate()).padStart(2, "0");
  return `${nextYear}-${nextMonth}-${nextDay}`;
}

export function formatSentEmailDateKeyLabel(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function formatSentEmailDayLabel(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

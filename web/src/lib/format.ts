const time = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
const dayMonth = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });
const dayMonthYear = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" });
const shortDate = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });
const number = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export function formatTime(iso: string): string {
  return time.format(new Date(iso));
}

/** «Сегодня», «Вчера», «12 октября», with the year only when it differs. */
export function formatDay(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const diff = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diff === 0) return "Сегодня";
  if (diff === 1) return "Вчера";
  return d.getFullYear() === now.getFullYear() ? dayMonth.format(d) : dayMonthYear.format(d);
}

/** List-row timestamp: time today, short date otherwise. */
export function formatStamp(iso: string, now = new Date()): string {
  const d = new Date(iso);
  return startOfDay(d) === startOfDay(now) ? time.format(d) : shortDate.format(d).replace(".", "");
}

export function formatDateTime(iso: string, now = new Date()): string {
  return `${formatDay(iso, now)}, ${formatTime(iso)}`;
}

export function formatNumber(n: number): string {
  return number.format(n);
}

/** Decimal strings from the API («1234.5») to «1 234,5 ₽». Empty for null. */
export function formatMoney(value: string | null | undefined, currency: "RUB" | "USD"): string {
  if (value == null || value === "") return "";
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  const s = number.format(n);
  return currency === "RUB" ? `${s} ₽` : `$${s}`;
}

export function sameDay(a: string, b: string): boolean {
  return startOfDay(new Date(a)) === startOfDay(new Date(b));
}

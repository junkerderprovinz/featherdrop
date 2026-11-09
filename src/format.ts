import { locale, num, plural, t } from "@/src/i18n";

const UNITS = ["B", "KB", "MB", "GB", "TB"];
export function size(bytes: number) {
  let i = 0;
  let v = bytes;
  while (v >= 1000 && i < UNITS.length - 1) {
    v /= 1000;
    i++;
  }
  return `${num(v, { maximumFractionDigits: i === 0 ? 0 : 1 })} ${UNITS[i]}`;
}

export const fileCount = (n: number) => plural(n, "common.files");

export const dateTime = (ms: number) =>
  new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(ms);

/** "in 6 days" in the page's language. */
export function relative(ms: number, now = Date.now()) {
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: "auto" });
  const s = (ms - now) / 1000;
  if (Math.abs(s) < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (Math.abs(s) < 86400) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86400), "day");
}

export function duration(seconds: number) {
  const unit = seconds < 90 ? "second" : seconds < 5400 ? "minute" : "hour";
  const value = unit === "second" ? Math.max(1, Math.round(seconds)) : Math.round(seconds / (unit === "minute" ? 60 : 3600));
  return new Intl.NumberFormat(locale(), { style: "unit", unit, unitDisplay: "long" }).format(value);
}

/** The sentence that asks to come back later, with the wait the server named. */
export const wait = (seconds: number | null) =>
  seconds ? t("common.tryAgainIn", { time: duration(seconds) }) : t("common.tryAgainLater");

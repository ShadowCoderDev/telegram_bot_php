const PERSIAN = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC = '٠١٢٣٤٥٦٧٨٩';

/** convertNumbersToEnglish(): "۰۹۱۲" / "٠٩١٢" → "0912". */
export const toEnglishDigits = (s: string): string =>
  s.replace(/[۰-۹]/g, (d) => String(PERSIAN.indexOf(d))).replace(/[٠-٩]/g, (d) => String(ARABIC.indexOf(d)));

export const toPersianDigits = (s: string): string => s.replace(/\d/g, (d) => PERSIAN[Number(d)]!);

/** Parses a non-negative integer typed with any digit set, or returns null. */
export const parseAmount = (s: string | undefined): number | null => {
  if (!s) return null;
  const clean = toEnglishDigits(s).replace(/[,\s٬]/g, '');
  return /^\d+$/.test(clean) ? Number(clean) : null;
};

export const isIranMobile = (s: string): boolean => /^09\d{9}$/.test(s);

/** Gregorian → Jalali (same algorithm as format_persian_date in functions.php). */
export function toJalali(gy: number, gm: number, gd: number): [number, number, number] {
  const gDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const jDays = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, 29];
  const y = gy - 1600;
  const m = gm - 1;
  let dayNo = 365 * y + Math.floor((y + 3) / 4) - Math.floor((y + 99) / 100) + Math.floor((y + 399) / 400);
  for (let i = 0; i < m; i++) dayNo += gDays[i]!;
  if (m > 1 && ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0)) dayNo++;
  dayNo += gd - 1;

  let jDayNo = dayNo - 79;
  const jNp = Math.floor(jDayNo / 12053);
  jDayNo %= 12053;
  let jy = 979 + 33 * jNp + 4 * Math.floor(jDayNo / 1461);
  jDayNo %= 1461;
  if (jDayNo >= 366) {
    jy += Math.floor((jDayNo - 1) / 365);
    jDayNo = (jDayNo - 1) % 365;
  }
  let i = 0;
  for (; i < 11 && jDayNo >= jDays[i]!; i++) jDayNo -= jDays[i]!;
  return [jy, i + 1, jDayNo + 1];
}

const TEHRAN = 'Asia/Tehran';

/** Wall-clock parts of a unix timestamp in Tehran. */
export function tehranParts(unix: number) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TEHRAN,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(unix * 1000));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}

/** "۱۴۰۴/۰۷/۱۵ - ۱۴:۳۰" */
export function formatPersianDate(unix: number): string {
  const { year, month, day, hour, minute } = tehranParts(unix);
  const [jy, jm, jd] = toJalali(year, month, day);
  const pad = (n: number) => String(n).padStart(2, '0');
  return toPersianDigits(`${jy}/${pad(jm)}/${pad(jd)} - ${pad(hour)}:${pad(minute)}`);
}

// Iran has had no DST since 2022, so Tehran is a fixed UTC+03:30.
const TEHRAN_OFFSET_SEC = 3.5 * 3600;

/** Unix time of 00:00 Tehran today and on the 1st of this (Gregorian) month – for the stats screen. */
export function tehranDayAndMonthStart(nowUnix: number): { day: number; month: number } {
  const { year, month, day } = tehranParts(nowUnix);
  const midnight = (d: number) => Date.UTC(year, month - 1, d) / 1000 - TEHRAN_OFFSET_SEC;
  return { day: midnight(day), month: midnight(1) };
}

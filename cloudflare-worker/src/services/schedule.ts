/**
 * Order scheduling rules, as pure functions: which days and times a category can be booked, and
 * how they are written for people. Everything is in Tehran time (a fixed UTC+03:30; Iran has no
 * DST) and the week starts on Saturday. Capacity is not decided here – the database counts the
 * orders in each slot (see db/schedule.ts); these functions are given those counts.
 */
import { toEnglishDigits, toJalali, toPersianDigits } from '../utils/persian';

export const TEHRAN_OFFSET = 12_600; // seconds
const DAY = 86_400;

/** Weekday names, index 0 = Saturday. */
export const WEEKDAYS = ['شنبه', 'یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه'] as const;
const JALALI_MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];

export const ALL_DAYS = 0b1111111;
/** Saturday to Wednesday / Saturday to Thursday – the usual working weeks. */
export const DAYS_SAT_WED = 0b0011111;
export const DAYS_SAT_THU = 0b0111111;

export const MAX_TIMES = 48;

/** What one category's schedule is made of (a row of category_schedules). */
export interface Schedule {
  category_id: number;
  enabled: number;
  label: string;
  days: number;
  /** "16:00,16:30", always sorted and without duplicates. */
  times: string;
  /** Orders one slot can hold; 0 = no limit. */
  capacity: number;
  lead_minutes: number;
  horizon_days: number;
  /** Reminder to the customer this long before the slot; 0 = none. */
  remind_minutes: number;
}

/* ------------------------------------------------------------------ */
/* Days                                                                 */
/* ------------------------------------------------------------------ */

/** Number of the Tehran calendar day a moment falls in (days since 1970-01-01). */
export const dayNo = (unix: number): number => Math.floor((unix + TEHRAN_OFFSET) / DAY);
/** Unix time of 00:00 Tehran on a day. */
export const dayStart = (day: number): number => day * DAY - TEHRAN_OFFSET;
/** Weekday of a day, 0 = Saturday … 6 = Friday (1970-01-01 was a Thursday). */
export const weekday = (day: number): number => (day + 5) % 7;
/** Unix time of HH:MM Tehran on a day. */
export const slotAt = (day: number, minutes: number): number => dayStart(day) + minutes * 60;
/** Minutes after midnight (Tehran) of a moment. */
export const minuteOfDay = (unix: number): number => Math.floor(((unix + TEHRAN_OFFSET) % DAY) / 60);

export const hasDay = (mask: number, wd: number): boolean => (mask & (1 << wd)) !== 0;
export const toggleDay = (mask: number, wd: number): number => (mask ^ (1 << wd)) & ALL_DAYS;

/** "شنبه، یکشنبه و دوشنبه" / "هر روز" / "شنبه تا چهارشنبه". */
export function describeDays(mask: number): string {
  const days = WEEKDAYS.filter((_, i) => hasDay(mask, i));
  if (days.length === 7) return 'هر روز';
  if (!days.length) return 'هیچ روزی';
  const first = WEEKDAYS.findIndex((_, i) => hasDay(mask, i));
  const contiguous = days.every((_, k) => hasDay(mask, first + k)) && first + days.length <= 7;
  if (days.length >= 3 && contiguous) return `${days[0]} تا ${days.at(-1)}`;
  return days.length === 1 ? days[0]! : `${days.slice(0, -1).join('، ')} و ${days.at(-1)}`;
}

/** The Gregorian (y, m, d) of a Tehran day. */
const civil = (day: number): [number, number, number] => {
  const d = new Date(day * DAY * 1000);
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
};

/** "شنبه ۱۰ مهر" */
export function formatDay(day: number): string {
  const [, jm, jd] = toJalali(...civil(day));
  return `${WEEKDAYS[weekday(day)]} ${toPersianDigits(String(jd))} ${JALALI_MONTHS[jm - 1]}`;
}

/** "شنبه ۱۴۰۵/۰۷/۱۰" */
export function formatDayFull(day: number): string {
  const [jy, jm, jd] = toJalali(...civil(day));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${WEEKDAYS[weekday(day)]} ${toPersianDigits(`${jy}/${pad(jm)}/${pad(jd)}`)}`;
}

export const formatClock = (minutes: number): string => toPersianDigits(`${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`);

/** "شنبه ۱۴۰۵/۰۷/۱۰ · ساعت ۱۶:۳۰" */
export const formatSlot = (unix: number): string => `${formatDayFull(dayNo(unix))} · ساعت ${formatClock(minuteOfDay(unix))}`;

/* ------------------------------------------------------------------ */
/* Times                                                                */
/* ------------------------------------------------------------------ */

export type ParsedTimes = { ok: true; times: string[] } | { ok: false; error: string };

const clock = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export const timesToMinutes = (times: string): number[] =>
  times
    .split(',')
    .filter(Boolean)
    .map((t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)));

/**
 * Reads what the seller typed. Any mix of:
 *   times            10:00  14:30  ۱۶:۰۰
 *   ranges with step 09:00-12:00/30   (from 9 to 12, every 30 minutes: 9:00 … 11:30)
 * separated by spaces, commas or lines. A range's end is not a start time: the last slot ends there.
 */
export function parseTimes(input: string): ParsedTimes {
  const text = toEnglishDigits(input).replace(/[،,;\n]+/g, ' ').replace(/\s+/g, ' ');
  const found = new Set<number>();
  const at = (h: string, m: string): number | null => {
    const hh = Number(h);
    const mm = Number(m);
    return hh <= 23 && mm <= 59 ? hh * 60 + mm : null;
  };

  const rest = text.replace(/(\d{1,2}):(\d{2})\s*(?:-|–|تا)\s*(\d{1,2}):(\d{2})\s*(?:\/|هر)\s*(\d{1,3})/g, (_, h1, m1, h2, m2, step) => {
    const from = at(h1, m1);
    const to = at(h2, m2);
    const every = Number(step);
    if (from === null || to === null || to <= from) found.add(-1);
    else if (every < 5 || every > 720) found.add(-2);
    else for (let t = from; t < to; t += every) found.add(t);
    return ' ';
  });
  if (found.has(-1)) return { ok: false, error: 'در بازه، ساعت پایان باید بعد از ساعت شروع باشد و ساعت‌ها درست باشند (مثل 09:00-12:00/30).' };
  if (found.has(-2)) return { ok: false, error: 'فاصله‌ی بین زمان‌ها باید بین ۵ تا ۷۲۰ دقیقه باشد.' };

  for (const token of rest.split(' ').filter(Boolean)) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(token);
    const t = m ? at(m[1]!, m[2]!) : null;
    if (t === null) return { ok: false, error: `«${token}» ساعت معتبری نیست. مثل 16:30 بنویسید.` };
    found.add(t);
  }
  if (!found.size) return { ok: false, error: 'هیچ ساعتی پیدا نشد.' };
  if (found.size > MAX_TIMES) return { ok: false, error: `حداکثر ${toPersianDigits(String(MAX_TIMES))} زمان در روز؛ فاصله‌ی بازه را بیشتر کنید.` };
  return { ok: true, times: [...found].sort((a, b) => a - b).map(clock) };
}

/** "۱۶:۰۰ تا ۱۹:۳۰ (۸ زمان)" for a long list, the times themselves for a short one. */
export function describeTimes(times: string): string {
  const list = timesToMinutes(times);
  if (!list.length) return 'تنظیم نشده';
  if (list.length <= 6) return list.map(formatClock).join('، ');
  return `${formatClock(list[0]!)} تا ${formatClock(list.at(-1)!)} (${toPersianDigits(String(list.length))} زمان)`;
}

/* ------------------------------------------------------------------ */
/* Slots                                                                */
/* ------------------------------------------------------------------ */

export interface Slot {
  at: number;
  /** Orders still welcome in this slot; null when the capacity is unlimited. */
  left: number | null;
}

export interface DaySlots {
  day: number;
  slots: Slot[];
}

export interface Availability {
  now: number;
  /** Days the shop is closed (set by the admin), as day numbers. */
  closed: ReadonlySet<number>;
  /** Orders already in each slot (by slot start). */
  taken: ReadonlyMap<number, number>;
}

/** Is `at` one of the moments this schedule offers at all (capacity not considered)? */
export function isOffered(s: Schedule, at: number, a: Pick<Availability, 'now' | 'closed'>): boolean {
  const day = dayNo(at);
  const today = dayNo(a.now);
  return (
    s.enabled === 1 &&
    at >= a.now + s.lead_minutes * 60 &&
    day >= today &&
    day < today + s.horizon_days &&
    hasDay(s.days, weekday(day)) &&
    !a.closed.has(day) &&
    timesToMinutes(s.times).includes(minuteOfDay(at)) &&
    at % 60 === 0
  );
}

/** Every bookable slot, day by day; days without a free slot are left out. */
export function availableSlots(s: Schedule, a: Availability): DaySlots[] {
  const today = dayNo(a.now);
  const minutes = timesToMinutes(s.times);
  const out: DaySlots[] = [];
  for (let day = today; day < today + s.horizon_days; day++) {
    if (!hasDay(s.days, weekday(day)) || a.closed.has(day)) continue;
    const slots: Slot[] = [];
    for (const m of minutes) {
      const at = slotAt(day, m);
      if (at < a.now + s.lead_minutes * 60) continue;
      const left = s.capacity > 0 ? s.capacity - (a.taken.get(at) ?? 0) : null;
      if (left !== null && left <= 0) continue;
      slots.push({ at, left });
    }
    if (slots.length) out.push({ day, slots });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Ready-made schedules                                                 */
/* ------------------------------------------------------------------ */

export type PresetKey = 'food' | 'visit' | 'pickup';
export type Preset = Omit<Schedule, 'category_id' | 'enabled'> & { title: string };

/** One tap sets a sensible schedule; the seller adjusts whatever differs. */
export const PRESETS: Record<PresetKey, Preset> = {
  food: { title: '🍽 تحویل غذا و سفارش روزانه', label: 'زمان تحویل', days: ALL_DAYS, times: '12:00,13:00,14:00,18:00,19:00,20:00,21:00', capacity: 10, lead_minutes: 60, horizon_days: 3, remind_minutes: 60 },
  visit: { title: '🩺 نوبت‌دهی (پزشک، مشاوره، آرایشگاه)', label: 'زمان نوبت', days: DAYS_SAT_WED, times: '16:00,16:30,17:00,17:30,18:00,18:30,19:00,19:30', capacity: 1, lead_minutes: 120, horizon_days: 14, remind_minutes: 180 },
  pickup: { title: '📦 دریافت حضوری کالا (کتاب، سفارش)', label: 'زمان دریافت', days: DAYS_SAT_THU, times: '10:00,11:00,12:00,13:00,14:00,15:00,16:00,17:00', capacity: 5, lead_minutes: 240, horizon_days: 7, remind_minutes: 120 },
};

/* ------------------------------------------------------------------ */
/* Closed days                                                          */
/* ------------------------------------------------------------------ */

/** The shop's closed days are stored as a comma list of day numbers; unreadable parts are dropped. */
export function parseClosedDays(raw: string | null, today: number): Set<number> {
  return new Set((raw ?? '').split(',').map(Number).filter((n) => Number.isSafeInteger(n) && n >= today));
}

export const MAX_CLOSED_DAYS = 60;

/** Adds or removes `day`, forgetting past days. Returns the new stored value. */
export function toggleClosedDay(raw: string | null, day: number, today: number): string {
  const set = parseClosedDays(raw, today);
  if (set.has(day)) set.delete(day);
  else if (set.size < MAX_CLOSED_DAYS) set.add(day);
  return [...set].sort((a, b) => a - b).join(',');
}

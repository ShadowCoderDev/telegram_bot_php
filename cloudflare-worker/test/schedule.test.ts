import { describe, expect, it } from 'vitest';
import {
  ALL_DAYS, DAYS_SAT_WED, PRESETS, availableSlots, dayNo, dayStart, describeDays, describeTimes, formatDay, formatDayFull, formatSlot,
  hasDay, isOffered, minuteOfDay, parseClosedDays, parseTimes, slotAt, toggleClosedDay, toggleDay, weekday, type Schedule,
} from '../src/services/schedule';

// Thursday 1 October 2026, 10:00 in Tehran (= 06:30 UTC) – 9 Mehr 1405.
const NOW = Date.UTC(2026, 9, 1, 6, 30) / 1000;
const TODAY = dayNo(NOW);

const schedule = (over: Partial<Schedule> = {}): Schedule => ({
  category_id: 1, enabled: 1, label: 'زمان نوبت', days: ALL_DAYS, times: '10:00,12:00,16:00', capacity: 0, lead_minutes: 0, horizon_days: 3, ...over,
});
const open = (taken: [number, number][] = [], closed: number[] = []) => ({ now: NOW, closed: new Set(closed), taken: new Map(taken) });

describe('Tehran days', () => {
  it('knows the weekday (Saturday = 0) and writes the Jalali date', () => {
    expect(weekday(TODAY)).toBe(5); // پنجشنبه
    expect(weekday(TODAY + 2)).toBe(0); // Saturday
    expect(formatDayFull(TODAY)).toBe('پنجشنبه ۱۴۰۵/۰۷/۰۹');
    expect(formatDay(TODAY)).toBe('پنجشنبه ۹ مهر');
    expect(formatSlot(slotAt(TODAY, 16 * 60 + 30))).toBe('پنجشنبه ۱۴۰۵/۰۷/۰۹ · ساعت ۱۶:۳۰');
  });

  it('puts a moment on the Tehran day, not the UTC day', () => {
    const lateUtc = Date.UTC(2026, 9, 1, 21, 0) / 1000; // 00:30 on 2 October in Tehran
    expect(dayNo(lateUtc)).toBe(TODAY + 1);
    expect(minuteOfDay(lateUtc)).toBe(30);
    expect(dayStart(TODAY + 1)).toBe(Date.UTC(2026, 9, 1, 20, 30) / 1000);
  });

  it('describes sets of days', () => {
    expect(describeDays(ALL_DAYS)).toBe('هر روز');
    expect(describeDays(DAYS_SAT_WED)).toBe('شنبه تا چهارشنبه');
    expect(describeDays(0b0000101)).toBe('شنبه و دوشنبه');
    expect(describeDays(0b1000000)).toBe('جمعه');
    expect(describeDays(0b0001011)).toBe('شنبه، یکشنبه و سه‌شنبه');
    expect(describeDays(0)).toBe('هیچ روزی');
    expect(hasDay(toggleDay(0, 3), 3)).toBe(true);
    expect(toggleDay(toggleDay(0, 3), 3)).toBe(0);
  });
});

describe('typed times', () => {
  const times = (s: string) => {
    const r = parseTimes(s);
    return r.ok ? r.times.join(' ') : `ERR ${r.error}`;
  };

  it('reads lists in any digits, sorted and without repeats', () => {
    expect(times('16:30 ۱۰:۰۰، 10:00\n9:05')).toBe('09:05 10:00 16:30');
  });

  it('reads ranges with a step; the end is not a start time', () => {
    expect(times('09:00-11:00/30')).toBe('09:00 09:30 10:00 10:30');
    expect(times('۰۹:۰۰ تا ۱۱:۰۰ هر ۶۰')).toBe('09:00 10:00');
    expect(times('09:00-10:00/30 16:00-17:00/30 20:00')).toBe('09:00 09:30 16:00 16:30 20:00');
  });

  it('refuses nonsense with a reason', () => {
    expect(times('25:00')).toContain('معتبری نیست');
    expect(times('hello')).toContain('معتبری نیست');
    expect(times('')).toContain('هیچ ساعتی');
    expect(times('12:00-10:00/30')).toContain('ساعت پایان');
    expect(times('09:00-17:00/2')).toContain('فاصله');
    expect(times('00:00-23:59/5')).toContain('حداکثر'); // 288 slots
    expect(times('00:00 12:00')).toBe('00:00 12:00'); // midnight is a time too
  });

  it('shortens long lists', () => {
    expect(describeTimes('16:00,16:30')).toBe('۱۶:۰۰، ۱۶:۳۰');
    expect(describeTimes(PRESETS.visit.times)).toBe('۱۶:۰۰ تا ۱۹:۳۰ (۸ زمان)');
    expect(describeTimes('')).toBe('تنظیم نشده');
  });
});

describe('available slots', () => {
  it('lists the rest of today, then the following days up to the horizon', () => {
    const days = availableSlots(schedule(), open());
    expect(days.map((d) => d.day)).toEqual([TODAY, TODAY + 1, TODAY + 2]);
    expect(days[0]!.slots.map((s) => minuteOfDay(s.at) / 60)).toEqual([10, 12, 16]); // it is 10:00 now: a slot starting now is still allowed
    expect(availableSlots(schedule(), { ...open(), now: NOW + 1 })[0]!.slots.map((s) => minuteOfDay(s.at) / 60)).toEqual([12, 16]);
    expect(days[1]!.slots).toHaveLength(3);
  });

  it('keeps the lead time between now and the first slot', () => {
    const days = availableSlots(schedule({ lead_minutes: 3 * 60 }), open());
    expect(days[0]!.slots.map((s) => minuteOfDay(s.at) / 60)).toEqual([16]);
    expect(availableSlots(schedule({ lead_minutes: 24 * 60 }), open())[0]!.day).toBe(TODAY + 1);
  });

  it('skips days of the week the shop is off, and closed days', () => {
    const noThursday = ALL_DAYS & ~(1 << 5);
    expect(availableSlots(schedule({ days: noThursday }), open()).map((d) => d.day)).toEqual([TODAY + 1, TODAY + 2]);
    expect(availableSlots(schedule(), open([], [TODAY + 1])).map((d) => d.day)).toEqual([TODAY, TODAY + 2]);
  });

  it('hides slots that reached their capacity and reports what is left', () => {
    const full = slotAt(TODAY + 1, 10 * 60);
    const nearlyFull = slotAt(TODAY + 1, 12 * 60);
    const days = availableSlots(schedule({ capacity: 2 }), open([[full, 2], [nearlyFull, 1]]));
    const tomorrow = days.find((d) => d.day === TODAY + 1)!.slots;
    expect(tomorrow.map((s) => [minuteOfDay(s.at) / 60, s.left])).toEqual([[12, 1], [16, 2]]);
    expect(availableSlots(schedule(), open())[1]!.slots[0]!.left).toBeNull(); // unlimited
  });

  it('offers nothing from a switched-off or empty schedule', () => {
    expect(availableSlots(schedule({ times: '' }), open())).toEqual([]);
    expect(isOffered(schedule({ enabled: 0 }), slotAt(TODAY + 1, 600), open())).toBe(false);
  });

  it('accepts only moments the schedule really offers', () => {
    const s = schedule({ lead_minutes: 60, horizon_days: 2 });
    const ok = (at: number) => isOffered(s, at, open());
    expect(ok(slotAt(TODAY + 1, 12 * 60))).toBe(true);
    expect(ok(slotAt(TODAY + 1, 12 * 60 + 5))).toBe(false); // not one of the times
    expect(ok(slotAt(TODAY, 10 * 60))).toBe(false); // already inside the lead time
    expect(ok(slotAt(TODAY + 2, 12 * 60))).toBe(false); // beyond the horizon
    expect(ok(slotAt(TODAY - 1, 12 * 60))).toBe(false); // the past
    expect(isOffered(s, slotAt(TODAY + 1, 12 * 60), open([], [TODAY + 1]))).toBe(false); // closed day
  });
});

describe('closed days', () => {
  it('toggles days, forgets past ones and ignores junk', () => {
    expect(toggleClosedDay(null, TODAY + 3, TODAY)).toBe(String(TODAY + 3));
    expect(toggleClosedDay(String(TODAY + 3), TODAY + 3, TODAY)).toBe('');
    expect(toggleClosedDay(`${TODAY - 5},${TODAY + 9}`, TODAY + 2, TODAY)).toBe(`${TODAY + 2},${TODAY + 9}`);
    expect([...parseClosedDays(`abc,${TODAY + 1},,${TODAY - 1}`, TODAY)]).toEqual([TODAY + 1]);
  });
});

describe('presets', () => {
  it('are valid schedules', () => {
    for (const p of Object.values(PRESETS)) {
      expect(parseTimes(p.times).ok).toBe(true);
      expect(availableSlots({ ...p, category_id: 1, enabled: 1 }, open()).length).toBeGreaterThan(0);
    }
  });
});

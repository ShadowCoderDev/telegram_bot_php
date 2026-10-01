/** The seller's side of order scheduling: switch, per-category schedules, closed days, agenda. */
import type { Session } from '../db/models';
import type { Deps } from '../deps';
import { ALL_DAYS, PRESETS, availableSlots, dayNo, dayStart, parseTimes, toggleDay, type PresetKey, type Schedule } from '../services/schedule';
import type { BotContext } from '../telegram/BotContext';
import type { Router } from '../telegram/Router';
import type { View } from '../telegram/types';
import { charCount } from '../limits';
import { CB } from '../views/callbacks';
import { CANCEL_HINT, sections } from '../views/common';
import * as v from '../views/schedule';

const A = CB.admin;
const now = () => Math.floor(Date.now() / 1000);

/** Admin flows that wait for typed text. */
export const SCHEDULE_FLOW = { times: 'sched_times', label: 'sched_label' } as const;

/** Value ranges accepted from the choice buttons (a forged button can't store anything else). */
const RANGES = { cap: ['capacity', 0, 1000], lead: ['lead_minutes', 0, 14_400], hor: ['horizon_days', 1, 60] } as const;
const MANUAL: Omit<Schedule, 'category_id'> = { enabled: 1, label: 'زمان', days: ALL_DAYS, times: '', capacity: 0, lead_minutes: 60, horizon_days: 7 };
const LABEL_MAX = 30;

export function registerScheduleRoutes(router: Router, d: Deps): Router {
  const home = async (): Promise<View> => {
    const enabled = await d.schedules.isEnabled();
    if (!enabled) return v.scheduleHome(false, [], 0, 0);
    const today = dayNo(now());
    const [items, closed, bookings] = await Promise.all([d.schedules.list(), d.schedules.closedDays(today), d.schedules.agenda(dayStart(today), dayStart(today + 1), 100)]);
    return v.scheduleHome(true, items, closed.size, bookings.length);
  };

  /** The editor of one category's schedule (or the home when it isn't there / scheduling is off). */
  const editor = async (id: number): Promise<View> => {
    const cat = await d.categories.find(id);
    if (!cat || !(await d.schedules.isEnabled())) return home();
    const s = await d.schedules.find(id);
    let next: number | null = null;
    if (s?.enabled && s.times) {
      const t = now();
      next = availableSlots(s, { now: t, closed: await d.schedules.closedDays(dayNo(t)), taken: new Map() })[0]?.slots[0]?.at ?? null;
    }
    return v.scheduleEditor(cat, s, next);
  };

  const withSchedule = (handler: (ctx: BotContext, id: number, s: Schedule) => Promise<unknown>) => async (ctx: BotContext, [rawId]: string[]) => {
    const s = await d.schedules.find(Number(rawId));
    if (!s) return ctx.render(await editor(Number(rawId)));
    await handler(ctx, Number(rawId), s);
  };

  return router
    .callback(A.schedule, async (ctx) => ctx.render(await home()))
    .callback(A.scheduleToggle, async (ctx) => {
      await d.schedules.setEnabled(!(await d.schedules.isEnabled()));
      await ctx.render(await home());
    })
    .callback(/^a:sch:cat:(\d+)$/, async (ctx, [id]) => ctx.render(await editor(Number(id))))

    .callback(/^a:sch:preset:(\d+):(food|visit|pickup|manual)$/, async (ctx, [rawId, key]) => {
      const id = Number(rawId);
      if (!(await d.schedules.isEnabled()) || (await d.schedules.find(id))) return ctx.render(await editor(id));
      const p = PRESETS[key as PresetKey];
      const fields: Omit<Schedule, 'category_id'> = key === 'manual' ? MANUAL : { enabled: 1, label: p.label, days: p.days, times: p.times, capacity: p.capacity, lead_minutes: p.lead_minutes, horizon_days: p.horizon_days };
      if (!(await d.schedules.save(id, fields))) return ctx.render(await home());
      if (key !== 'manual') return ctx.render(await editor(id));
      await ctx.render(await editor(id));
      await d.sessions.set(ctx.chatId, SCHEDULE_FLOW.times, 'times', { categoryId: id });
      await ctx.reply({ text: v.TIMES_PROMPT });
    })

    /* ----- days ----- */
    .callback(/^a:sch:days:(\d+)$/, withSchedule((ctx, id, s) => ctx.render(v.daysPicker(id, s.days))))
    .callback(/^a:sch:day:(\d+):([0-6])$/, async (ctx, [rawId, wd]) => {
      const s = await d.schedules.find(Number(rawId));
      if (!s) return ctx.render(await editor(Number(rawId)));
      const days = toggleDay(s.days, Number(wd));
      await d.schedules.update(s.category_id, 'days', days);
      await ctx.render(v.daysPicker(s.category_id, days));
    })
    .callback(/^a:sch:dayset:(\d+):(\d+)$/, async (ctx, [rawId, mask]) => {
      const s = await d.schedules.find(Number(rawId));
      if (!s || Number(mask) > ALL_DAYS) return ctx.render(await editor(Number(rawId)));
      await d.schedules.update(s.category_id, 'days', Number(mask));
      await ctx.render(v.daysPicker(s.category_id, Number(mask)));
    })

    /* ----- typed values ----- */
    .callback(
      /^a:sch:times:(\d+)$/,
      withSchedule(async (ctx, id) => {
        await d.sessions.set(ctx.chatId, SCHEDULE_FLOW.times, 'times', { categoryId: id });
        await ctx.reply({ text: v.TIMES_PROMPT });
      }),
    )
    .callback(
      /^a:sch:label:(\d+)$/,
      withSchedule(async (ctx, id) => {
        await d.sessions.set(ctx.chatId, SCHEDULE_FLOW.label, 'label', { categoryId: id });
        await ctx.reply({ text: v.LABEL_PROMPT });
      }),
    )

    /* ----- capacity, lead time, horizon ----- */
    .callback(/^a:sch:pick:(\d+):(cap|lead|hor)$/, async (ctx, [rawId, kind]) => {
      const s = await d.schedules.find(Number(rawId));
      await ctx.render(s ? v.choicePage(s.category_id, kind as v.ChoiceKind, s) : await editor(Number(rawId)));
    })
    .callback(/^a:sch:set:(\d+):(cap|lead|hor):(\d+)$/, async (ctx, [rawId, kind, value]) => {
      const [column, min, max] = RANGES[kind as keyof typeof RANGES];
      if ((await d.schedules.find(Number(rawId))) && Number(value) >= min && Number(value) <= max) await d.schedules.update(Number(rawId), column, Number(value));
      await ctx.render(await editor(Number(rawId)));
    })

    /* ----- on / off / delete ----- */
    .callback(/^a:sch:en:(\d+)$/, async (ctx, [rawId]) => {
      const s = await d.schedules.find(Number(rawId));
      if (s) await d.schedules.update(s.category_id, 'enabled', s.enabled ? 0 : 1);
      await ctx.render(await editor(Number(rawId)));
    })
    .callback(/^a:sch:del:(\d+)$/, async (ctx, [rawId]) => {
      const cat = await d.categories.find(Number(rawId));
      await ctx.render(cat && (await d.schedules.find(cat.id)) ? v.scheduleDeleteConfirm(cat) : await editor(Number(rawId)));
    })
    .callback(/^a:sch:delok:(\d+)$/, async (ctx, [rawId]) => {
      await d.schedules.remove(Number(rawId));
      await ctx.render(await editor(Number(rawId)));
    })

    /* ----- closed days ----- */
    .callback(A.closedDays, async (ctx) => ctx.render(await closedDays()))
    .callback(/^a:sch:closed:(\d+)$/, async (ctx, [day]) => {
      const today = dayNo(now());
      if (Number(day) >= today && Number(day) < today + CLOSED_WINDOW) await d.schedules.toggleClosed(Number(day), today);
      await ctx.render(await closedDays());
    })

    /* ----- agenda ----- */
    .callback(A.agenda, async (ctx) => ctx.render(await agenda(dayNo(now()))))
    .callback(/^a:agenda:(\d+)$/, async (ctx, [day]) => ctx.render(await agenda(Number(day))));

  async function closedDays(): Promise<View> {
    const today = dayNo(now());
    const closed = await d.schedules.closedDays(today);
    return v.closedDaysView(Array.from({ length: CLOSED_WINDOW }, (_, i) => ({ day: today + i, closed: closed.has(today + i) })));
  }

  async function agenda(day: number): Promise<View> {
    const today = dayNo(now());
    const shown = Math.max(today - 30, Math.min(day, today + 120));
    return v.agendaView(shown, today, await d.schedules.agenda(dayStart(shown), dayStart(shown + 1)));
  }
}

/** Days shown on the closed-days page. */
const CLOSED_WINDOW = 21;

/** Text typed for the schedule flows (times, label). */
export async function scheduleFlowStep(ctx: BotContext, s: Session<Record<string, unknown>>, d: Deps): Promise<void> {
  const id = Number(s.data.categoryId);
  const text = (ctx.text ?? '').trim();
  const again = (message: string) => ctx.reply({ text: sections(message, CANCEL_HINT) });

  if (!text || text.startsWith('/')) return again('⚠️ لطفاً یک متن بفرستید.');
  if (s.flow === SCHEDULE_FLOW.times) {
    const parsed = parseTimes(text);
    if (!parsed.ok) return again(`⚠️ ${parsed.error}`);
    await d.schedules.update(id, 'times', parsed.times.join(','));
  } else {
    if (charCount(text) < 2 || charCount(text) > LABEL_MAX) return again(`⚠️ عنوان بین ۲ تا ${LABEL_MAX} کاراکتر باشد.`);
    await d.schedules.update(id, 'label', text);
  }
  await d.sessions.clear(ctx.chatId);
  await ctx.reply({ text: '✅ ذخیره شد.' });
  const cat = await d.categories.find(id);
  const schedule = await d.schedules.find(id);
  if (!cat || !schedule) return;
  const t = now();
  const next = schedule.enabled && schedule.times ? (availableSlots(schedule, { now: t, closed: await d.schedules.closedDays(dayNo(t)), taken: new Map() })[0]?.slots[0]?.at ?? null) : null;
  await ctx.reply(v.scheduleEditor(cat, schedule, next));
}

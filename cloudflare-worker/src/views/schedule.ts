/** Screens for order scheduling: the seller's setup and agenda, and the customer's day/time pickers. */
import type { AgendaEntry, ScheduledCategory } from '../db/schedule';
import {
  ALL_DAYS, DAYS_SAT_THU, DAYS_SAT_WED, PRESETS, WEEKDAYS, describeDays, describeTimes, formatClock, formatDay, formatDayFull, formatSlot, hasDay,
  minuteOfDay, type DaySlots, type PresetKey, type Schedule,
} from '../services/schedule';
import { backRow, button, inline } from '../telegram/keyboard';
import type { InlineKeyboardButton, View } from '../telegram/types';
import { escapeHtml as e } from '../utils/format';
import { CB } from './callbacks';
import { CANCEL_HINT, fa, heading, hint, quote, sections } from './common';
import { stepView } from './user';

const A = CB.admin;
const rows = <T>(items: T[], size: number): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

/* ------------------------------------------------------------------ */
/* Seller: setup                                                        */
/* ------------------------------------------------------------------ */

const capacityText = (n: number) => (n === 0 ? 'نامحدود' : `${fa(n)} سفارش`);
const leadText = (minutes: number): string =>
  minutes === 0 ? 'بدون محدودیت' : minutes < 60 ? `${fa(minutes)} دقیقه قبل` : minutes % 1440 === 0 ? `${fa(minutes / 1440)} روز قبل` : `${fa(minutes / 60)} ساعت قبل`;
const horizonText = (days: number) => `${fa(days)} روز آینده`;

const summary = (s: Schedule): string =>
  `📅 روزها: <b>${describeDays(s.days)}</b>\n` +
  `🕒 ساعت‌ها: <b>${describeTimes(s.times)}</b>\n` +
  `👥 ظرفیت هر زمان: <b>${capacityText(s.capacity)}</b>\n` +
  `⏳ حداقل فاصله تا زمان: <b>${leadText(s.lead_minutes)}</b>\n` +
  `📆 قابل رزرو تا: <b>${horizonText(s.horizon_days)}</b>`;

export interface ScheduleListItem {
  category_id: number;
  name: string;
  icon: string;
  schedule: Schedule | null;
}

const itemLabel = (c: ScheduleListItem): string => {
  const s = c.schedule;
  const state = !s ? '➕ تنظیم نشده' : !s.times ? '⚠️ ساعت ندارد' : s.enabled ? `🟢 ${describeDays(s.days)}` : '⏸ خاموش';
  return `${c.icon} ${c.name} · ${state}`;
};

export const scheduleHome = (enabled: boolean, items: ScheduleListItem[], closedCount: number, bookingsToday: number): View =>
  enabled
    ? {
        text: sections(
          heading('⏰', 'زمان‌بندی سفارش'),
          '🟢 <b>روشن است.</b> برای هر دسته‌بندی که می‌خواهید مشتری هنگام خرید روز و ساعت انتخاب کند، زمان‌بندی بگذارید.',
          items.length ? '👇 یک دسته‌بندی را انتخاب کنید:' : '⚠️ اول یک دسته‌بندی بسازید؛ بعد برایش زمان‌بندی می‌گذارید.',
          hint('هر سفارشی که حتی یک محصول از دسته‌ی زمان‌دار داشته باشد، زمان می‌خواهد.'),
        ),
        keyboard: inline(
          ...items.map((c) => [button(itemLabel(c), A.scheduleCategory(c.category_id))]),
          [button(bookingsToday ? `📅 برنامه و نوبت‌ها (${fa(bookingsToday)} امروز)` : '📅 برنامه و نوبت‌ها', A.agenda, 'primary')],
          [button(closedCount ? `🚫 روزهای تعطیل (${fa(closedCount)})` : '🚫 روزهای تعطیل', A.closedDays), button('⏸ خاموش کردن', A.scheduleToggle, 'danger')],
          backRow(A.settings, '🔙 تنظیمات'),
        ),
      }
    : {
        text: sections(
          heading('⏰', 'زمان‌بندی سفارش'),
          'اگر کالا یا خدمتی می‌فروشید که زمان دارد، این قابلیت را روشن کنید:',
          quote('🍽 تحویل غذا در ساعت مشخص\n📦 دریافت حضوری کتاب یا سفارش\n🩺 نوبت پزشک، مشاوره، آرایشگاه'),
          '<b>چطور کار می‌کند؟</b>\n' +
            '۱. روشن کنید.\n' +
            '۲. برای دسته‌بندی مورد نظر روزها و ساعت‌ها را بگذارید (قالب آماده هم هست).\n' +
            '۳. مشتری هنگام خرید روز و ساعت را انتخاب می‌کند؛ پر شدن ظرفیت هر زمان خودکار است.\n' +
            '۴. شما «برنامه‌ی نوبت‌ها» را می‌بینید.',
        ),
        keyboard: inline([button('✅ روشن کردن زمان‌بندی', A.scheduleToggle, 'success')], backRow(A.settings, '🔙 تنظیمات')),
      };

export const scheduleEditor = (c: { id: number; name: string; icon: string }, s: Schedule | null, nextSlot: number | null): View => {
  const title = `${c.icon} <b>${e(c.name)}</b>`;
  if (!s) {
    return {
      text: sections(
        heading('🗓', 'زمان‌بندی این دسته‌بندی'),
        title,
        'مشتری‌ای که از این دسته محصول بخرد، روز و ساعت را انتخاب می‌کند. با یک قالب آماده شروع کنید؛ بعداً هرچه خواستید عوض کنید:',
      ),
      keyboard: inline(
        ...(Object.keys(PRESETS) as PresetKey[]).map((k) => [button(PRESETS[k].title, A.schedulePreset(c.id, k))]),
        [button('✍️ تنظیم دستی', A.schedulePreset(c.id, 'manual'))],
        backRow(A.schedule, '🔙 زمان‌بندی'),
      ),
    };
  }
  const problem = !s.times ? '⚠️ <b>هنوز ساعتی تعریف نشده</b>؛ تا آن موقع مشتری زمان نمی‌بیند. «🕒 ساعت‌ها» را بزنید.' : '';
  return {
    text: sections(
      heading('🗓', `زمان‌بندی: ${e(s.label)}`),
      title,
      quote(summary(s)),
      problem || (s.enabled ? (nextSlot ? `👀 نزدیک‌ترین زمان برای مشتری:\n<b>${formatSlot(nextSlot)}</b>` : '⚠️ الان هیچ زمانی برای مشتری باقی نمانده (روز، ساعت یا فاصله را بررسی کنید).') : '⏸ <b>خاموش است</b>؛ مشتری برای این دسته زمان انتخاب نمی‌کند.'),
    ),
    keyboard: inline(
      [button('📅 روزها', A.scheduleDays(c.id)), button('🕒 ساعت‌ها', A.scheduleTimes(c.id))],
      [button('👥 ظرفیت', A.scheduleChoices(c.id, 'cap')), button('⏳ حداقل فاصله', A.scheduleChoices(c.id, 'lead'))],
      [button('📆 تا چند روز بعد', A.scheduleChoices(c.id, 'hor')), button('🔖 عنوان', A.scheduleLabel(c.id))],
      [s.enabled ? button('⏸ خاموش کردن', A.scheduleEnable(c.id)) : button('▶️ روشن کردن', A.scheduleEnable(c.id), 'success'), button('🗑 حذف', A.scheduleDelete(c.id), 'danger')],
      backRow(A.schedule, '🔙 زمان‌بندی'),
    ),
  };
};

export const scheduleDeleteConfirm = (c: { id: number; name: string; icon: string }): View => ({
  text: sections(heading('⚠️', 'حذف زمان‌بندی'), `${c.icon} <b>${e(c.name)}</b>`, hint('نوبت‌هایی که قبلاً ثبت شده‌اند می‌مانند؛ فقط از این به بعد مشتری زمان انتخاب نمی‌کند.')),
  keyboard: inline([button('🗑 بله، حذف کن', A.scheduleDeleteConfirm(c.id), 'danger'), button('انصراف', A.scheduleCategory(c.id))]),
});

export const daysPicker = (id: number, mask: number): View => ({
  text: sections(heading('📅', 'روزهای کاری'), 'روی هر روز بزنید تا روشن یا خاموش شود:', hint('مشتری فقط در روزهای ✅ زمان می‌بیند.')),
  keyboard: inline(
    ...rows(
      WEEKDAYS.map((name, i): InlineKeyboardButton => button(`${hasDay(mask, i) ? '✅' : '⬜️'} ${name}`, A.scheduleDay(id, i), hasDay(mask, i) ? 'success' : undefined)),
      2,
    ),
    [button('هر روز', A.scheduleDaySet(id, ALL_DAYS)), button('شنبه تا چهارشنبه', A.scheduleDaySet(id, DAYS_SAT_WED))],
    [button('شنبه تا پنجشنبه', A.scheduleDaySet(id, DAYS_SAT_THU))],
    backRow(A.scheduleCategory(id), '🔙 زمان‌بندی دسته'),
  ),
});

export const TIMES_PROMPT = sections(
  heading('🕒', 'ساعت‌های قابل انتخاب'),
  'ساعت‌ها را بفرستید. دو روش دارید و می‌توانید ترکیب کنید:',
  quote(
    '<b>فهرست ساعت‌ها:</b>\n<code>10:00 11:30 16:00</code>\n\n' +
      '<b>بازه با فاصله:</b>\n<code>16:00-20:00/30</code>\n' +
      hint('یعنی از ۱۶ تا ۲۰ هر ۳۰ دقیقه: ۱۶:۰۰، ۱۶:۳۰ … ۱۹:۳۰') +
      '\n\n<b>ترکیب (با ساعت ناهار):</b>\n<code>09:00-12:00/30 15:00-18:00/30</code>',
  ),
  hint('هر زمان، شروع یک نوبت است؛ ساعتی که بازه تمام می‌شود نوبت جدید نیست.'),
  CANCEL_HINT,
);

export const LABEL_PROMPT = sections(
  heading('🔖', 'عنوان زمان‌بندی'),
  'مشتری این عنوان را می‌بیند. مثلاً <code>زمان نوبت</code>، <code>زمان تحویل</code> یا <code>زمان دریافت</code> را بفرستید:',
  CANCEL_HINT,
);

export type ChoiceKind = 'cap' | 'lead' | 'hor';
const CHOICES: Record<ChoiceKind, { title: string; body: string; options: [string, number][]; text: (n: number) => string; field: (s: Schedule) => number }> = {
  cap: {
    title: '👥 ظرفیت هر زمان',
    body: 'هر زمان حداکثر برای چند سفارش قابل رزرو باشد؟ وقتی پر شد، دیگر به مشتری نشان داده نمی‌شود.',
    options: [['۱ (نوبت تک‌نفره)', 1], ['۲', 2], ['۳', 3], ['۵', 5], ['۱۰', 10], ['۲۰', 20], ['نامحدود', 0]],
    text: capacityText,
    field: (s) => s.capacity,
  },
  lead: {
    title: '⏳ حداقل فاصله تا زمان',
    body: 'مشتری حداقل چقدر قبل از زمان باید سفارش بدهد؟ (برای آماده کردن غذا، سفارش یا نوبت)',
    options: [['بدون محدودیت', 0], ['۳۰ دقیقه', 30], ['۱ ساعت', 60], ['۲ ساعت', 120], ['۶ ساعت', 360], ['۱۲ ساعت', 720], ['۱ روز', 1440], ['۲ روز', 2880]],
    text: leadText,
    field: (s) => s.lead_minutes,
  },
  hor: {
    title: '📆 تا چند روز بعد رزرو شود؟',
    body: 'مشتری از امروز تا چند روز آینده می‌تواند زمان انتخاب کند؟',
    options: [['فقط امروز', 1], ['۳ روز', 3], ['۷ روز', 7], ['۱۴ روز', 14], ['۲۱ روز', 21], ['۳۰ روز', 30]],
    text: horizonText,
    field: (s) => s.horizon_days,
  },
};

export const choicePage = (id: number, kind: ChoiceKind, s: Schedule): View => {
  const c = CHOICES[kind];
  return {
    text: sections(`<b>${c.title}</b>`, c.body, `الان: <b>${c.text(c.field(s))}</b>`),
    keyboard: inline(
      ...rows(
        c.options.map(([label, value]) => button(`${c.field(s) === value ? '✅ ' : ''}${label}`, A.scheduleSet(id, kind, value), c.field(s) === value ? 'success' : undefined)),
        2,
      ),
      backRow(A.scheduleCategory(id), '🔙 زمان‌بندی دسته'),
    ),
  };
};

/** The next days as on/off buttons: tap a day to close the shop on it (holiday, travel, sick). */
export const closedDaysView = (days: { day: number; closed: boolean }[]): View => ({
  text: sections(
    heading('🚫', 'روزهای تعطیل'),
    'روی روزی که نمی‌خواهید مشتری زمان رزرو کند بزنید (تعطیلی، سفر، مرخصی):',
    hint('⛔ = تعطیل. نوبت‌هایی که قبلاً ثبت شده‌اند لغو نمی‌شوند؛ با مشتری تماس بگیرید.'),
  ),
  keyboard: inline(
    ...rows(days.map((d) => button(`${d.closed ? '⛔' : '▫️'} ${formatDay(d.day)}`, A.closedDay(d.day), d.closed ? 'danger' : undefined)), 2),
    backRow(A.schedule, '🔙 زمان‌بندی'),
  ),
});

/* ------------------------------------------------------------------ */
/* Seller: agenda                                                       */
/* ------------------------------------------------------------------ */

const AGENDA_ICON: Record<string, string> = { payed: '🟡', approved: '🟢', sending: '📤' };

export const agendaView = (day: number, today: number, entries: AgendaEntry[]): View => {
  const manyCategories = new Set(entries.map((x) => x.category_name)).size > 1;
  const lines = entries.map(
    (x) =>
      `${AGENDA_ICON[x.status] ?? '▫️'} <b>${formatClock(minuteOfDay(x.slot_at))}</b> · ${e(x.customer || '—')}` +
      `${x.phone ? ` · <code>${e(x.phone)}</code>` : ''}${manyCategories ? ` · ${e(x.category_icon)} ${e(x.category_name)}` : ''}`,
  );
  return {
    text: sections(
      heading('📅', day === today ? 'برنامه‌ی امروز' : 'برنامه'),
      `🗓 ${formatDayFull(day)}`,
      lines.length ? quote(lines.join('\n')) : 'نوبت یا سفارش زمان‌داری برای این روز ثبت نشده است.',
      lines.length ? hint('🟡 منتظر تایید   🟢 تایید شده   📤 ارسال شده') : '',
    ),
    keyboard: inline(
      ...entries.slice(0, 8).map((x) => [button(`🧾 ${formatClock(minuteOfDay(x.slot_at))} · ${x.track_id}`, A.order(x.order_id))]),
      [button('◀️ روز قبل', A.agendaDay(day - 1)), ...(day === today ? [] : [button('امروز', A.agendaDay(today))]), button('روز بعد ▶️', A.agendaDay(day + 1))],
      backRow(A.schedule, '🔙 زمان‌بندی'),
    ),
  };
};

/* ------------------------------------------------------------------ */
/* Customer: checkout steps                                             */
/* ------------------------------------------------------------------ */

const forWhat = (s: ScheduledCategory) => `برای «${e(`${s.icon} ${s.name}`.trim())}»`;

/** Step: pick the day. `note` is a line above (e.g. "that time was just taken"). */
export const slotDayPicker = (s: ScheduledCategory, days: DaySlots[], n: number, total: number, note = ''): View => {
  const view = stepView(n, total, sections(note, `📅 ${forWhat(s)} <b>${e(s.label)}</b> را انتخاب کنید.`, '👇 اول روز:'));
  return {
    ...view,
    keyboard: inline(...rows(days.map((d) => button(`📅 ${formatDay(d.day)}`, CB.slotDay(s.category_id, d.day))), 2), [button('❌ انصراف از خرید', CB.cancelCheckout)]),
  };
};

/** Step: pick the time on a day. */
export const slotTimePicker = (s: ScheduledCategory, day: DaySlots, n: number, total: number): View => {
  const view = stepView(n, total, sections(`📅 <b>${formatDayFull(day.day)}</b>`, `🕒 ${forWhat(s)} ساعت را انتخاب کنید:`));
  return {
    ...view,
    keyboard: inline(
      ...rows(day.slots.map((x) => button(`🕒 ${formatClock(minuteOfDay(x.at))}`, CB.slotPick(s.category_id, x.at))), 3),
      backRow(CB.slotDays(s.category_id), '🔙 انتخاب روز دیگر'),
      [button('❌ انصراف از خرید', CB.cancelCheckout)],
    ),
  };
};

export const noSlotsAvailable = (s: ScheduledCategory): View => ({
  text: sections(
    heading('😔', 'فعلاً زمان خالی نداریم'),
    `برای ${forWhat(s)} در حال حاضر زمانی برای انتخاب باقی نمانده است.`,
    hint('کمی بعد دوباره سر بزنید، یا اگر سبد خرید شما محصول دیگری هم دارد، همین محصول را از سبد حذف کنید.'),
  ),
  // "cancelCheckout" also clears a checkout stuck at this step (e.g. the schedule was switched off meanwhile).
  keyboard: inline([button('🛒 سبد خرید', CB.cancelCheckout, 'primary')], backRow(CB.home, '🏠 منوی اصلی')),
});

export const slotTaken = (): string => '⚠️ همین الان این زمان توسط کس دیگری رزرو شد؛ لطفاً زمان دیگری انتخاب کنید.';


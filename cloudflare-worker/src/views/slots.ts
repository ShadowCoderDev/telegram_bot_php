/** Small pieces about a scheduled order, shared by the customer's and the seller's screens. */
import type { OrderSlotInfo, ScheduledCategory } from '../db/schedule';
import type { Schedule } from '../services/schedule';
import { formatSlot } from '../services/schedule';
import { backRow, button, inline } from '../telegram/keyboard';
import type { View } from '../telegram/types';
import { escapeHtml as e } from '../utils/format';
import { CB } from './callbacks';
import { fa, heading, hint, quote, sections } from './common';

/** "📅 زمان نوبت: شنبه ۱۴۰۵/۰۷/۱۰ · ساعت ۱۶:۳۰" – one line per scheduled category of the order. */
export const slotLines = (slots: OrderSlotInfo[]): string =>
  slots
    .map((s) => `📅 ${e(s.label)}${slots.length > 1 && s.category_name ? ` (${e(`${s.category_icon} ${s.category_name}`.trim())})` : ''}: <b>${formatSlot(s.slot_at)}</b>`)
    .join('\n');

/** On the cart: tells the customer a time will be asked for, before they start. */
export const cartScheduleHint = (required: ScheduledCategory[]): string =>
  required.length
    ? `📅 ${required.length > 1 ? 'این سفارش چند زمان می‌خواهد' : `این سفارش <b>${e(required[0]!.label)}</b> می‌خواهد`}؛ هنگام «تکمیل خرید» انتخابش می‌کنید.`
    : '';

/** On a product card: a time is part of buying this product. */
export const productScheduleHint = (s: Pick<Schedule, 'label'> | null): string => (s ? `📅 این محصول با انتخاب <b>${e(s.label)}</b> سفارش داده می‌شود.` : '');

/** "۲ ساعت دیگر" / "۴۵ دقیقه دیگر" – how long until a moment, for the reminder. */
export const untilText = (seconds: number): string => {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${fa(minutes)} دقیقه دیگر`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${fa(hours)} ساعت دیگر` : `${fa(Math.round(hours / 24))} روز دیگر`;
};

/** The reminder a customer gets before their booked slot. */
export const appointmentReminder = (r: { label: string; slot_at: number; track_id: string; category_name: string; category_icon: string; shop_name: string }, now: number): View => ({
  text: sections(
    heading('🔔', 'یادآوری'),
    `🏪 <b>${e(r.shop_name)}</b>`,
    quote(`📅 ${e(r.label)}${r.category_name ? ` (${e(`${r.category_icon} ${r.category_name}`.trim())})` : ''}\n🕒 <b>${formatSlot(r.slot_at)}</b>\n⏳ ${untilText(r.slot_at - now)}`),
    hint(`کد پیگیری سفارش: ${r.track_id}`),
  ),
  keyboard: inline([button('📋 سفارش‌های من', CB.myOrders, 'primary')], backRow(CB.home, '🏠 منوی اصلی')),
});

import type { OrderLine } from '../db/models';
import { cartTotal } from '../services/CartService';
import { escapeHtml as e, money } from '../utils/format';
import { toPersianDigits } from '../utils/persian';

/*
 * Shared formatting so every screen has the same rhythm:
 *   heading (emoji + bold) → blank line → details in a <blockquote> (drawn with a coloured bar
 *   in Telegram) → blank line → a short hint in italics.
 */

export const HR = '┈┈┈┈┈┈┈┈┈┈┈┈┈┈';

export const toman = (n: number): string => `${money(n)} تومان`;
export const fa = (n: number | string): string => toPersianDigits(String(n));

export const heading = (emoji: string, title: string): string => `${emoji} <b>${title}</b>`;
export const quote = (body: string): string => `<blockquote>${body.trimEnd()}</blockquote>`;
/** Collapsed by default with a "show more" toggle – for long descriptions and answers. */
export const expandable = (body: string): string => `<blockquote expandable>${body.trimEnd()}</blockquote>`;
export const hint = (text: string): string => `<i>${text}</i>`;
export const CANCEL_HINT = hint('✖️ برای انصراف /cancel را بفرستید.');

/** Joins non-empty sections with a blank line between them. */
export const sections = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join('\n\n');

/** 🟩🟩⬜⬜  مرحله ۲ از ۴ */
export const progress = (step: number, total: number): string =>
  `${'🟩'.repeat(step)}${'⬜'.repeat(total - step)}  ${hint(`مرحله ${fa(step)} از ${fa(total)}`)}`;

/**
 * One product line as a small readable block – shared by the cart, "my orders" and the admin order card:
 *
 *   📦 Book name
 *   ┃ 💰 قیمت واحد: 7,800,000 تومان
 *   ┃ 🔢 تعداد: 3
 *   ┃ 💵 جمع: 23,400,000 تومان
 */
export const lineItemBlock = (l: Pick<OrderLine, 'title' | 'price' | 'quantity'>, index?: number): string =>
  `${index !== undefined ? `<b>${fa(index)}.</b> ` : ''}📦 <b>${e(l.title)}</b>\n` +
  quote(`💰 قیمت واحد: ${toman(l.price)}\n🔢 تعداد: ${fa(l.quantity)}\n💵 جمع: <b>${toman(l.price * l.quantity)}</b>`);

export const itemsWithTotal = (lines: OrderLine[], totalLabel = 'جمع کل'): string =>
  lines.map((l, i) => lineItemBlock(l, lines.length > 1 ? i + 1 : undefined)).join('\n\n') +
  `\n\n🧾 <b>${totalLabel}: ${toman(cartTotal(lines))}</b>`;

import type { OrderLine } from '../db/models';
import { cartTotal } from '../services/CartService';
import { escapeHtml as e, money } from '../utils/format';

export const toman = (n: number): string => `${money(n)} تومان`;

/**
 * One product line as a small readable block – shared by the cart, "my orders" and the admin order card:
 *
 *   📦 Book name
 *      💰 قیمت واحد: 7,800,000 تومان
 *      🔢 تعداد: 3
 *      💵 جمع: 23,400,000 تومان
 */
export const lineItemBlock = (l: Pick<OrderLine, 'title' | 'price' | 'quantity'>, extra = ''): string =>
  `📦 <b>${e(l.title)}</b>\n` +
  `      💰 قیمت واحد: ${toman(l.price)}\n` +
  `      🔢 تعداد: ${l.quantity}\n` +
  `      💵 جمع: ${toman(l.price * l.quantity)}\n` +
  extra;

export const itemsWithTotal = (lines: OrderLine[], extra: (l: OrderLine) => string = () => ''): string =>
  lines.map((l) => lineItemBlock(l, extra(l))).join('\n') + `\n🧾 <b>جمع کل: ${toman(cartTotal(lines))}</b>`;

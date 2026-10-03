/**
 * Inline mode: in any chat, "@shop_bot kitchen" shows the shop's matching products as cards the
 * person can send on – a friend lands in the shop through the card's button. It only reads: no
 * database write per query, and answers are shared (Telegram caches them, and so do we for a moment).
 */
import type { Product } from './db/models';
import { addInline } from './db/usage';
import type { Deps } from './deps';
import { flooding } from './flood';
import { shopAccess } from './services/subscription';
import { TelegramApiError } from './telegram/TelegramClient';
import type { InlineQuery } from './telegram/types';
import { escapeHtml as e, money, truncate } from './utils/format';

const MAX_RESULTS = 20;
const QUERY_MAX = 64;
const CACHE_MS = 30_000;
const CACHE_KEYS = 500;

export const INLINE_CLOSED_TITLE = '🔒 این فروشگاه موقتاً در دسترس نیست';
/** The "open the shop" button shown above the results; /start shop opens the main menu. */
const OPEN_BUTTON = { text: '🛍 باز کردن فروشگاه', start_parameter: 'shop' };

interface InlineResult {
  type: 'photo' | 'article';
  id: string;
  reply_markup?: { inline_keyboard: { text: string; url: string }[][] };
  [key: string]: unknown;
}

/** The text of a product card sent from inline mode. */
export const inlineCard = (p: Product, shopName: string): string =>
  [
    `📘 <b>${e(p.title)}</b>`,
    p.author && `✍️ ${e(p.author)}`,
    p.inventory > 0 ? `💰 <b>${money(p.price)} تومان</b>` : `💰 ${money(p.price)} تومان · ⛔ <b>ناموجود</b>`,
    p.description && `\n${e(truncate(p.description, 160))}`,
    `\n<i>🏪 ${e(shopName)}</i>`,
  ]
    .filter(Boolean)
    .join('\n');

/**
 * One result per product: a photo card when the product has a photo uploaded to Telegram, a text
 * card otherwise. The card's button opens the product in the shop's bot (a /start deep link).
 */
export function inlineResults(products: Product[], shopName: string, botUsername: string, withPhotos = true): InlineResult[] {
  return products.map((p): InlineResult => {
    const description = `${money(p.price)} تومان · ${p.inventory > 0 ? 'موجود' : 'ناموجود'}`;
    const reply_markup = botUsername ? { inline_keyboard: [[{ text: '🛍 مشاهده و خرید', url: `https://t.me/${botUsername}?start=p_${p.id}` }]] } : undefined;
    const text = inlineCard(p, shopName);
    return p.image_file_id && withPhotos
      ? { type: 'photo', id: `p${p.id}`, photo_file_id: p.image_file_id, title: p.title, description, caption: text, parse_mode: 'HTML', reply_markup }
      : { type: 'article', id: `p${p.id}`, title: p.title, description, input_message_content: { message_text: text, parse_mode: 'HTML' }, reply_markup };
  });
}

/* Answers kept for a moment per isolate: the same words typed by many people cost one search. */
const cache = new Map<string, { at: number; results: InlineResult[] }>();

export async function handleInline(d: Deps, q: InlineQuery): Promise<void> {
  addInline(d.shop.id);
  await d.usage.flushInline(Math.floor(Date.now() / 1000));
  // A person typing fast sends many queries; Telegram debounces, this is the backstop.
  if (flooding(`inline:${d.shop.id}:${q.from.id}`, 20, 10)) return;

  const access = shopAccess(d.shop, Math.floor(Date.now() / 1000));
  if (access !== 'ok') {
    const results = [
      { type: 'article', id: 'closed', title: INLINE_CLOSED_TITLE, description: 'لطفاً بعداً دوباره سر بزنید.', input_message_content: { message_text: INLINE_CLOSED_TITLE } },
    ];
    return void (await d.tg.answerInlineQuery(q.id, results, { cacheTime: 60 }).catch(() => {}));
  }

  const query = q.query.trim().slice(0, QUERY_MAX);
  const key = `${d.shop.id}|${query}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at <= CACHE_MS) {
    await d.tg.answerInlineQuery(q.id, hit.results, { cacheTime: 60, button: OPEN_BUTTON }).catch((err) => console.error('inline answer', err));
    return;
  }

  const username = d.shop.bot_username || (await d.settings.raw('bot_username')) || '';
  const [products, setName] = await Promise.all([d.products.searchVisible(query, MAX_RESULTS), d.settings.raw('shop_name')]);
  // A shop that never named itself shows under its bot's @username, not a placeholder.
  const name = setName ?? (username ? `@${username}` : '');
  let results = inlineResults(products, name, username);
  try {
    await d.tg.answerInlineQuery(q.id, results, { cacheTime: 60, button: OPEN_BUTTON });
  } catch (err) {
    // One photo Telegram won't take as a photo (e.g. an image sent as a file) fails the whole answer:
    // answer again with text cards only, and remember that version.
    if (!(err instanceof TelegramApiError) || !products.some((p) => p.image_file_id)) return void console.error('inline answer', err);
    results = inlineResults(products, name, username, false);
    await d.tg.answerInlineQuery(q.id, results, { cacheTime: 60, button: OPEN_BUTTON }).catch((e2) => console.error('inline answer', e2));
  }
  if (cache.size >= CACHE_KEYS) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), results });
}

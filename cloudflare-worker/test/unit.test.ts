import { describe, expect, it } from 'vitest';
import { planTransition } from '../src/services/orderStatus';
import { cartTotal, clampQty, stockProblems } from '../src/services/CartService';
import { BotContext } from '../src/telegram/BotContext';
import { Router } from '../src/telegram/Router';
import { button } from '../src/telegram/keyboard';
import type { TelegramClient } from '../src/telegram/TelegramClient';
import type { Update } from '../src/telegram/types';
import { escapeHtml, money, splitHtml } from '../src/utils/format';
import { formatPersianDate, parseAmount, tehranDayAndMonthStart, toEnglishDigits, toJalali } from '../src/utils/persian';
import { cartView, myOrdersView, productCard } from '../src/views/user';
import { parseAdminIds } from '../src/deps';
import { capAlert, dailyCap, parseCapacitySettings } from '../src/capacity';
import { PLATFORM_SETTING_DEFAULTS } from '../src/db/repositories';
import { UNCAPPED, utcDay } from '../src/db/usage';
import { flooding, onceEvery } from '../src/flood';
import { dueReminder, purgeAt } from '../src/services/subscription';
import { LESSONS, lessonView } from '../src/views/tutorial';

describe('persian utils', () => {
  it('normalises Persian and Arabic digits', () => {
    expect(toEnglishDigits('۰۹۱۲٣٤٥')).toBe('0912345');
    expect(parseAmount('۱۲۰,۰۰۰')).toBe(120000);
    expect(parseAmount('12a')).toBeNull();
  });
  it('converts Gregorian to Jalali', () => {
    expect(toJalali(2025, 3, 21)).toEqual([1404, 1, 1]);
    expect(toJalali(2026, 9, 26)).toEqual([1405, 7, 4]);
  });
  it('formats dates in Tehran time with Persian digits', () => {
    // 2025-10-07T10:30:00Z = 14:00 in Tehran
    expect(formatPersianDate(Date.UTC(2025, 9, 7, 10, 30) / 1000)).toBe('۱۴۰۴/۰۷/۱۵ - ۱۴:۰۰');
  });
  it('computes Tehran midnight and month start', () => {
    const { day, month } = tehranDayAndMonthStart(Date.UTC(2025, 9, 7, 22, 0) / 1000); // 01:30 on Oct 8 Tehran
    expect(new Date(day * 1000).toISOString()).toBe('2025-10-07T20:30:00.000Z');
    expect(new Date(month * 1000).toISOString()).toBe('2025-09-30T20:30:00.000Z');
  });
});

describe('format', () => {
  it('escapes HTML and formats money', () => {
    expect(escapeHtml('<b>"x" & y</b>')).toBe('&lt;b&gt;&quot;x&quot; &amp; y&lt;/b&gt;');
    expect(money(1250000)).toBe('1,250,000');
  });
});

describe('splitHtml', () => {
  it('keeps short text whole', () => {
    expect(splitHtml('<b>hi</b>')).toEqual(['<b>hi</b>']);
  });
  it('splits between lines and re-opens tags that span the cut', () => {
    const text = '<b>title</b>\n<blockquote>' + Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n') + '</blockquote>\nend';
    const parts = splitHtml(text, 500);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(500);
      expect(part.split('<blockquote>').length).toBe(part.split('</blockquote>').length); // balanced
    }
    expect(parts.join('\n')).toContain('line 299');
  });
});

describe('order state machine', () => {
  it('takes stock on first approval and returns it on rejection', () => {
    expect(planTransition({ status: 'payed', stock_taken: 0 }, 'approve')).toEqual({ status: 'approved', stock: 'take' });
    expect(planTransition({ status: 'approved', stock_taken: 1 }, 'reject')).toEqual({ status: 'rejected', stock: 'return' });
    expect(planTransition({ status: 'payed', stock_taken: 0 }, 'reject')).toEqual({ status: 'rejected', stock: 'keep' });
    expect(planTransition({ status: 'approved', stock_taken: 1 }, 'send')).toEqual({ status: 'sending', stock: 'keep' });
  });
  it('refuses invalid transitions', () => {
    expect(planTransition({ status: 'pending', stock_taken: 0 }, 'approve')).toBeNull();
    expect(planTransition({ status: 'sending', stock_taken: 1 }, 'reject')).toBeNull();
    expect(planTransition({ status: 'payed', stock_taken: 0 }, 'send')).toBeNull();
  });
});

describe('cart helpers', () => {
  it('clamps quantities and totals lines', () => {
    expect([clampQty(0), clampQty(5), clampQty(500), clampQty(NaN)]).toEqual([1, 5, 99, 1]);
    expect([clampQty(8, 3), clampQty(2, 3), clampQty(5, 0)]).toEqual([3, 2, 1]);
    expect(cartTotal([{ price: 1000, quantity: 2 }, { price: 50, quantity: 3 }])).toBe(2150);
  });
  it('reports lines exceeding inventory', () => {
    const line = { item_id: 1, product_id: 1, price: 1, title: 'Book', quantity: 3, inventory: 2, available: 1 };
    expect(stockProblems([line, { ...line, quantity: 1 }, { ...line, quantity: 1, title: 'Gone', available: 0 }])).toEqual([
      { title: 'Book', inventory: 2, available: true },
      { title: 'Gone', inventory: 2, available: false },
    ]);
  });
});

const PRODUCT = {
  id: 1, category_id: 2, title: 'Book', description: 'd', price: 1000, author: '',
  image_url: '', image_file_id: '', inventory: 5, status: 'enable' as const,
};

describe('keyboard & views', () => {
  it('rejects callback data over 64 bytes', () => {
    expect(() => button('x', 'a'.repeat(65))).toThrow();
  });
  it('escapes product fields in the card', () => {
    const view = productCard(
      { ...PRODUCT, title: '<script>' },
      2,
    );
    expect(view.text).toContain('&lt;script&gt;');
    expect(view.text).toContain('2,000');
    expect(view.photo).toBeUndefined();
  });
  it('offers no quantity or add-to-cart buttons for an out-of-stock product', () => {
    const view = productCard({ ...PRODUCT, inventory: 0 }, 1);
    const data = (view.keyboard as { inline_keyboard: { callback_data?: string }[][] }).inline_keyboard.flat().map((b) => b.callback_data);
    expect(data).toEqual(['cat:2']);
    expect(view.text).toContain('ناموجود');
  });
  it('disables ➕ at the stock limit', () => {
    const view = productCard({ ...PRODUCT, inventory: 2 }, 2);
    const row = (view.keyboard as { inline_keyboard: { callback_data?: string }[][] }).inline_keyboard[0]!;
    expect(row.map((b) => b.callback_data)).toEqual(['qty:1:1', 'noop', 'noop']);
  });
  it('shows an uploaded product photo as a photo card within the caption limit', () => {
    const view = productCard({ ...PRODUCT, image_file_id: 'PHOTO', description: 'x'.repeat(3000) }, 1);
    expect(view.photo).toBe('PHOTO');
    expect(view.text.length).toBeLessThanOrEqual(1024);
  });
  it('lists the unit price on its own line in the cart and in orders', () => {
    const line = { item_id: 3, product_id: 1, title: 'Book', price: 7_800_000, quantity: 3, inventory: 9, available: 1 };
    for (const text of [
      cartView([line]).text,
      myOrdersView([{ id: 1, user_id: 1, user_chat_id: 1, track_id: 'T', status: 'payed', stock_taken: 0, time: 0 }], new Map([[1, [line]]])).text,
    ]) {
      expect(text).toContain('💰 قیمت واحد: 7,800,000 تومان\n');
      expect(text).toContain('🔢 تعداد: ۳\n');
      expect(text).toMatch(/(جمع کل|مبلغ قابل پرداخت): 23,400,000 تومان/);
    }
  });
  it('parses admin ids', () => {
    expect(parseAdminIds(' 1, 2 ,x,')).toEqual([1, 2]);
  });
});

describe('Router', () => {
  const tg = {} as TelegramClient;
  const cbUpdate = (data: string): Update => ({
    update_id: 1,
    callback_query: { id: 'q', from: { id: 7, first_name: 'A' }, data, message: { message_id: 3, chat: { id: 7, type: 'private' } } },
  });

  it('matches exact strings and regex params in registration order', async () => {
    const seen: string[] = [];
    const router = new Router()
      .callback('home', async () => void seen.push('home'))
      .callback(/^prod:(\d+)$/, async (_c, [id]) => void seen.push(`prod ${id}`));
    await router.dispatch(new BotContext(cbUpdate('prod:42'), tg));
    await router.dispatch(new BotContext(cbUpdate('home'), tg));
    expect(seen).toEqual(['prod 42', 'home']);
  });

  it('reports unhandled when a fallback declines, so routers can chain', async () => {
    const router = new Router().fallback(async () => false);
    expect(await router.dispatch(new BotContext(cbUpdate('zzz'), tg))).toBe(false);
  });

  it('edits a photo message in place and swaps between text and photo', async () => {
    const calls: string[] = [];
    const tg = new Proxy({}, { get: (_t, m) => async () => void calls.push(String(m)) }) as unknown as TelegramClient;
    const onPhoto = cbUpdate('x');
    onPhoto.callback_query!.message!.photo = [{ file_id: 'old', file_unique_id: 'u', width: 1, height: 1 }];

    await new BotContext(onPhoto, tg).render({ text: 'card', photo: 'P' });
    expect(calls).toEqual(['editMessagePhoto']);
    calls.length = 0;
    await new BotContext(onPhoto, tg).render({ text: 'list' });
    expect(calls).toEqual(['deleteMessage', 'sendMessage']);
    calls.length = 0;
    await new BotContext(cbUpdate('x'), tg).render({ text: 'card', photo: 'P' });
    expect(calls).toEqual(['deleteMessage', 'sendPhoto']);
  });

  it('marks admins from the configured ids', () => {
    expect(new BotContext(cbUpdate('x'), tg, [7]).isAdmin).toBe(true);
    expect(new BotContext(cbUpdate('x'), tg, [8]).isAdmin).toBe(false);
  });
});

describe('capacity policy', () => {
  const c = parseCapacitySettings({ ...PLATFORM_SETTING_DEFAULTS });

  it('gives each shop its plan cap, its own override, or none for the owner shop', () => {
    expect(dailyCap({ plan: 'trial', daily_limit: null }, c)).toBe(1000);
    expect(dailyCap({ plan: 'paid', daily_limit: null }, c)).toBe(5000);
    expect(dailyCap({ plan: 'paid', daily_limit: 12_000 }, c)).toBe(12_000);
    expect(dailyCap({ plan: 'owner', daily_limit: 10 }, c)).toBe(UNCAPPED);
  });

  it('falls back to the defaults when a setting is not a positive number', () => {
    const broken = parseCapacitySettings({ ...PLATFORM_SETTING_DEFAULTS, trial_daily_limit: 'abc', alert_percent: '-5' });
    expect(broken.trialCap).toBe(1000);
    expect(broken.alertShare).toBe(0.7);
    expect(broken.quota).toEqual({ requests: 100_000, writes: 100_000, reads: 5_000_000, storage: 500 * 1024 * 1024 });
  });

  it('alerts exactly once at 80% and once at the cap', () => {
    const alerts = Array.from({ length: 1200 }, (_, i) => capAlert(i + 1, 1000)).map((a, i) => a && `${a}@${i + 1}`).filter(Boolean);
    expect(alerts).toEqual(['warn@800', 'full@1000']);
    expect(capAlert(5, UNCAPPED)).toBeNull();
    expect(capAlert(1, 1)).toBe('full');
  });

  it('counts days in UTC, the way Cloudflare resets its quotas (03:30 in Tehran)', () => {
    const midnightUtc = Date.UTC(2026, 8, 26) / 1000;
    expect(utcDay(midnightUtc - 1)).toBe(utcDay(midnightUtc) - 1);
    expect(utcDay(midnightUtc + 86_399)).toBe(utcDay(midnightUtc));
  });
});

describe('flood guard (in memory)', () => {
  it('lets a chat through up to the limit within the window, then again after it', () => {
    const t = 1_000_000;
    const results = Array.from({ length: 12 }, (_, i) => flooding('u1', 10, 10, t + i));
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(flooding('u2', 10, 10, t)).toBe(false); // other chats are not affected
    expect(flooding('u1', 10, 10, t + 11_000)).toBe(false); // the window moved on
  });

  it('says "slow down" at most once per window', () => {
    expect(onceEvery('k', 60, 0)).toBe(true);
    expect(onceEvery('k', 60, 59_000)).toBe(false);
    expect(onceEvery('k', 60, 61_000)).toBe(true);
  });
});

describe('subscription reminders and data retention', () => {
  const D = 86_400;
  const shop = (paidUntil: number, stage = 0) => ({ plan: 'paid' as const, status: 'active' as const, paid_until: paidUntil, reminder_stage: stage });

  it('deletes data retention days after the shop closed (expiry + grace)', () => {
    expect(purgeAt(1000, 30)).toBe(1000 + 33 * D);
  });

  it('warns 3 days before, at expiry, when closed, and a week before deletion – each once', () => {
    const t = 10_000 * D;
    expect(dueReminder(shop(t + 2 * D), t, 30)).toBe(1);
    expect(dueReminder(shop(t - D, 1), t, 30)).toBe(2);
    expect(dueReminder(shop(t - 4 * D, 2), t, 30)).toBe(3);
    expect(dueReminder(shop(t - 20 * D, 3), t, 30)).toBe(0);
    expect(dueReminder(shop(t - 27 * D, 3), t, 30)).toBe(4);
    expect(dueReminder(shop(t - 27 * D, 4), t, 30)).toBe(0);
    expect(dueReminder({ ...shop(t - 27 * D), status: 'suspended' as const }, t, 30)).toBe(0);
  });
});

describe('tutorial', () => {
  it('fits every lesson in a photo caption and links each one to the next', () => {
    LESSONS.forEach((_, i) => {
      const v = lessonView(i + 1, 'PHOTO', true);
      expect(v.text.length, `lesson ${i + 1}`).toBeLessThanOrEqual(1024);
      const data = JSON.stringify(v.keyboard);
      if (i + 1 < LESSONS.length) expect(data).toContain(`p:learn:${i + 2}`);
      if (i > 0) expect(data).toContain(`p:learn:${i}`);
    });
    expect(JSON.stringify(lessonView(1, null, false).keyboard)).not.toContain('pa:learnpic');
  });
});

import { SHOP_MAX_SHARE, WARN_SHARE, capAlert } from './capacity';
import { addDropped } from './db/usage';
import type { Deps } from './deps';
import { flooding, onceEvery } from './flood';
import { handleInline } from './inline';
import { registerAdminRoutes } from './handlers/admin';
import { ADMIN_HOME } from './views/admin';
import { registerUserRoutes } from './handlers/user';
import { shopAccess } from './services/subscription';
import { BotContext } from './telegram/BotContext';
import { Router } from './telegram/Router';
import { TelegramApiError } from './telegram/TelegramClient';
import type { Update } from './telegram/types';
import { fa, heading, num, sections } from './views/common';

const FLOOD_WINDOW_SECONDS = 10;
export const CLOSED_TEXT = '🔒 این فروشگاه موقتاً در دسترس نیست.\nلطفاً بعداً دوباره سر بزنید.';
export const BLOCKED_TEXT = '⛔ دسترسی شما به این ربات محدود شده است.\nبرای پیگیری با پشتیبانی تماس بگیرید.';
export const SLOW_DOWN_TEXT = '⏳ لطفاً کمی آهسته‌تر';
export const CAPACITY_FULL_TEXT = '⏳ ظرفیت امروز این فروشگاه تکمیل شده است.\nلطفاً بعد از ساعت ۳:۳۰ بامداد دوباره سر بزنید. 🙏';
export const ERROR_TEXT = '⚠️ مشکلی موقتی پیش آمد.\nلطفاً چند دقیقه‌ی دیگر دوباره امتحان کنید. 🙏';
export const EXPIRED_ADMIN_TEXT = '🔒 اشتراک این فروشگاه تمام شده و فروشگاه بسته است.\nتا تمدید، فقط سفارش‌های ثبت‌شده را می‌توانید رسیدگی کنید.';
export const SUSPENDED_ADMIN_TEXT = '⛔ این فروشگاه توسط پلتفرم متوقف شده است.\nبرای پیگیری با پشتیبانی پلتفرم تماس بگیرید.';
const CLOSED_ADMIN_CALLBACKS = /^(a:root|a:orders(:\d+)?|a:order:.+|a:dialog:.+|a:agenda(:\d+)?|a:cancel|noop)$/;
export const ADMIN_CAPACITY_FULL_TEXT = '⛔ مصرف امروز این فروشگاه به سقف رسیده و ربات تا ساعت ۳:۳۰ بامداد پاسخ نمی‌دهد.\nبرای افزایش سقف با پشتیبانی پلتفرم تماس بگیرید.';

/** Builds the routers once per request from the wired dependencies. */
export function createBot(d: Deps) {
  const userRouter = registerUserRoutes(new Router(), d);
  const adminRouter = registerAdminRoutes(new Router(), d);

  async function handleUpdate(update: Update, ctx: BotContext): Promise<void> {
    const cb = update.callback_query;
    const now = Math.floor(Date.now() / 1000);
    // Refused before counting (no database write): a chat sending faster than a person can,
    // and customers the shop blocked – neither uses up the shop's daily cap.
    if (!ctx.isAdmin && flooding(`${d.shop.id}:${ctx.chatId}`, d.floodLimit, FLOOD_WINDOW_SECONDS)) {
      addDropped(d.shop.id);
      if (cb) await d.tg.answerCallbackQuery(cb.id, SLOW_DOWN_TEXT).catch(() => {});
      return;
    }
    const user = ctx.isAdmin ? null : await d.users.findByChatId(ctx.chatId);
    if (user?.status === 'disable') {
      addDropped(d.shop.id);
      if (cb) await d.tg.answerCallbackQuery(cb.id, BLOCKED_TEXT, true).catch(() => {});
      else if (onceEvery(`blocked:${d.shop.id}:${ctx.chatId}`, 600)) await d.tg.sendMessage(ctx.chatId, BLOCKED_TEXT);
      return;
    }

    // One write per update: skips Telegram's redeliveries, counts today's usage and applies the
    // shop's limits. Admins may go past the customers' cap, so they can always run the shop.
    const customerLimits = await d.limits(false);
    const cap = customerLimits.updates;
    const tracked = await d.usage.track(update.update_id, now, ctx.isAdmin ? await d.limits(true) : customerLimits);
    if (tracked.status === 'duplicate') return;
    if (tracked.status === 'capped') return refuse(ctx, tracked.by);
    const alert = capAlert(tracked.updates, cap);
    if (alert) await capacityAlert(d, alert, cap);

    // Subscription gate: a shop whose subscription ran out (the grace days included) or that the
    // platform suspended is closed to customers at once, so nobody can use it unpaid. Its admins
    // still get in during the grace days, to renew; after that only to renew and finish paid orders.
    const access = shopAccess(d.shop, now);
    if (!ctx.isAdmin && access !== 'ok') {
      if (cb) await d.tg.answerCallbackQuery(cb.id, CLOSED_TEXT, true).catch(() => {});
      else await d.tg.sendMessage(ctx.chatId, CLOSED_TEXT);
      return;
    }
    // A closed shop is closed for its admins too – they can only finish the orders customers already
    // paid for. Renewing opens everything again; nothing is deleted until the retention period ends.
    if (ctx.isAdmin && (access === 'expired' || access === 'suspended') && !(await closedAdminMayUse(ctx))) {
      const text = access === 'suspended' ? SUSPENDED_ADMIN_TEXT : EXPIRED_ADMIN_TEXT;
      if (cb) await d.tg.answerCallbackQuery(cb.id, text, true).catch(() => {});
      else await d.tg.sendMessage(ctx.chatId, text);
      return;
    }
    // Keep the customer list current when someone changes their name or @username.
    if (user && (user.name !== ctx.firstName || user.username !== ctx.username)) {
      await d.users.upsert(ctx.chatId, ctx.firstName, ctx.username);
    }

    // Stop the button's loading spinner right away; failures here are cosmetic.
    const answered = cb ? d.tg.answerCallbackQuery(cb.id).catch(() => {}) : Promise.resolve();
    try {
      if (!(ctx.isAdmin && (await adminRouter.dispatch(ctx)))) await userRouter.dispatch(ctx);
    } finally {
      await answered;
    }
  }

  /** What an admin of a closed shop may still do: the panel, paid orders, and talking to those buyers. */
  async function closedAdminMayUse(ctx: BotContext): Promise<boolean> {
    if (ctx.callbackData !== undefined) return CLOSED_ADMIN_CALLBACKS.test(ctx.callbackData);
    if (['/start', '/admin', '/cancel', ADMIN_HOME].includes(ctx.text ?? '')) return true;
    return (await d.sessions.get(ctx.chatId))?.flow === 'dialog';
  }

  /** Today's limit is reached: say so (once in a while, not on every message). */
  async function refuse(ctx: BotContext, by: 'updates' | 'rows'): Promise<void> {
    const text = ctx.isAdmin ? ADMIN_CAPACITY_FULL_TEXT : CAPACITY_FULL_TEXT;
    const cb = ctx.update.callback_query;
    if (cb) await d.tg.answerCallbackQuery(cb.id, text, true).catch(() => {});
    else if (onceEvery(`full:${d.shop.id}:${ctx.chatId}`, 600)) await d.tg.sendMessage(ctx.chatId, text).catch(() => {});
    // The safety net stopped the shop: the platform owner should look at it (once an hour per isolate).
    if (by === 'rows' && onceEvery(`rows:${d.shop.id}`, 3600)) {
      const name = d.shop.bot_username ? `@${d.shop.bot_username}` : `#${d.shop.id}`;
      await d.alertPlatform(
        sections(
          heading('🚨', 'مصرف غیرعادی یک فروشگاه'),
          `${name} امروز به سقف ایمنی دیتابیس رسید (${fa(Math.round(SHOP_MAX_SHARE * 100))}٪ سهمیه‌ی روزانه) و تا ۳:۳۰ بامداد متوقف شد.`,
          'در 📈 ظرفیت ← پرمصرف‌ها ببینید؛ اگر سوءاستفاده است، فروشگاه را متوقف کنید.',
        ),
      );
    }
  }

  return async function (update: Update): Promise<void> {
    // "@bot words" typed in some other chat: answered from the catalogue, no chat of ours involved.
    if (update.inline_query) return handleInline(d, update.inline_query);
    d.adminIds = [...new Set([...d.envAdminIds, ...(await d.settings.claimedAdmins())])];
    const ctx = new BotContext(update, d.tg, d.adminIds);
    // Channel posts, edited messages, and anything in groups: the shop only works in private chats.
    if (!ctx.chatId || ctx.chatType !== 'private') return;
    try {
      await handleUpdate(update, ctx);
    } catch (err) {
      // A failed database query (or a bug) must not leave the person waiting for an answer.
      if (!(err instanceof TelegramApiError) && onceEvery(`error:${d.shop.id}:${ctx.chatId}`, 60)) {
        await d.tg.sendMessage(ctx.chatId, ERROR_TEXT).catch(() => {});
      }
      throw err;
    }
  };
}

/** Tells the shop's admins (and, when the cap is reached, the platform owner) once per day. */
async function capacityAlert(d: Deps, alert: 'warn' | 'full', cap: number): Promise<void> {
  const shopName = d.shop.bot_username ? `@${d.shop.bot_username}` : `#${d.shop.id}`;
  const text =
    alert === 'warn'
      ? sections(
          heading('⚠️', 'نزدیک سقف روزانه'),
          `ربات امروز <b>${num(Math.ceil(cap * WARN_SHARE))}</b> پیام از سقف <b>${num(cap)}</b> پیام روزانه را جواب داده است.`,
          'اگر به سقف برسد، مشتری‌ها تا ساعت ۳:۳۰ بامداد پیام «ظرفیت امروز تکمیل شده» می‌بینند. شما (ادمین‌ها) تا دو برابر سقف به ربات دسترسی دارید.',
        )
      : sections(
          heading('⛔', 'ظرفیت امروز تکمیل شد'),
          `ربات به سقف <b>${num(cap)}</b> پیام در روز رسید. مشتری‌ها تا ساعت ۳:۳۰ بامداد پیام «ظرفیت امروز تکمیل شده» می‌بینند.`,
          'برای افزایش سقف با پشتیبانی پلتفرم تماس بگیرید.',
        );
  await Promise.all(d.adminIds.map((id) => d.tg.sendMessage(id, text).catch((err) => console.error('capacity alert', err))));
  if (alert === 'full') {
    await d.alertPlatform(sections(heading('📈', 'یک فروشگاه به سقف روزانه رسید'), `${shopName} امروز به سقف <b>${num(cap)}</b> پیام رسید.`, 'برای بالا بردن سقفش: پنل مدیریت پلتفرم ← فروشگاه‌ها.'));
  }
}

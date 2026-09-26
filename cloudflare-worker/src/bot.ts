import type { Deps } from './deps';
import { registerAdminRoutes } from './handlers/admin';
import { registerUserRoutes } from './handlers/user';
import { BotContext } from './telegram/BotContext';
import { Router } from './telegram/Router';
import type { Update } from './telegram/types';

const FLOOD_WINDOW_SECONDS = 10;
export const BLOCKED_TEXT = '⛔ دسترسی شما به این ربات محدود شده است.\nبرای پیگیری با پشتیبانی تماس بگیرید.';

/** Builds the routers once per request from the wired dependencies. */
export function createBot(d: Deps) {
  const userRouter = registerUserRoutes(new Router(), d);
  const adminRouter = registerAdminRoutes(new Router(), d);

  return async function handleUpdate(update: Update): Promise<void> {
    d.adminIds = [...new Set([...d.envAdminIds, ...(await d.settings.claimedAdmins())])];
    const ctx = new BotContext(update, d.tg, d.adminIds);
    // Channel posts, edited messages, and anything in groups: the shop only works in private chats.
    if (!ctx.chatId || ctx.chatType !== 'private') return;

    // Telegram redelivers an update it thinks failed; handle each one exactly once.
    if (!(await d.updateLog.firstTime(update.update_id, ctx.chatId))) return;
    if (update.update_id % 200 === 0) await d.updateLog.prune();

    const cb = update.callback_query;
    if (!ctx.isAdmin) {
      // Flood guard: a chat sending faster than a human can is ignored for a few seconds.
      if ((await d.updateLog.recentCount(ctx.chatId, FLOOD_WINDOW_SECONDS)) > d.floodLimit) {
        if (cb) await d.tg.answerCallbackQuery(cb.id, '⏳ لطفاً کمی آهسته‌تر').catch(() => {});
        return;
      }
      const user = await d.users.findByChatId(ctx.chatId);
      if (user?.status === 'disable') {
        if (cb) await d.tg.answerCallbackQuery(cb.id, BLOCKED_TEXT, true).catch(() => {});
        else await d.tg.sendMessage(ctx.chatId, BLOCKED_TEXT);
        return;
      }
      // Keep the customer list current when someone changes their name or @username.
      if (user && (user.name !== ctx.firstName || user.username !== ctx.username)) {
        await d.users.upsert(ctx.chatId, ctx.firstName, ctx.username);
      }
    }

    // Stop the button's loading spinner right away; failures here are cosmetic.
    const answered = cb ? d.tg.answerCallbackQuery(cb.id).catch(() => {}) : Promise.resolve();
    if (!(ctx.isAdmin && (await adminRouter.dispatch(ctx)))) await userRouter.dispatch(ctx);
    await answered;
  };
}

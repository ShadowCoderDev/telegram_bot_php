import type { Deps } from './deps';
import { registerAdminRoutes } from './handlers/admin';
import { registerUserRoutes } from './handlers/user';
import { BotContext } from './telegram/BotContext';
import { Router } from './telegram/Router';
import type { Update } from './telegram/types';

/** Builds the routers once per request from the wired dependencies. */
export function createBot(d: Deps) {
  const userRouter = registerUserRoutes(new Router(), d);
  const adminRouter = registerAdminRoutes(new Router(), d);

  return async function handleUpdate(update: Update): Promise<void> {
    const ctx = new BotContext(update, d.tg, d.adminIds);
    if (!ctx.chatId) return; // channel posts, edited messages, ... – not handled

    const cb = update.callback_query;
    // Stop the button's loading spinner right away; failures here are cosmetic.
    const answered = cb ? d.tg.answerCallbackQuery(cb.id).catch(() => {}) : Promise.resolve();

    if (!(ctx.isAdmin && (await adminRouter.dispatch(ctx)))) await userRouter.dispatch(ctx);
    await answered;
  };
}

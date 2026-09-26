import { createBot } from './bot';
import { ensureSchema } from './db/migrate';
import { createDeps } from './deps';
import type { Env } from './env';
import { createPlatformBot, createPlatformDeps, sendReminders } from './platform';
import { FileStore } from './services/FileStore';
import { statusPage } from './setup';
import { TelegramClient } from './telegram/TelegramClient';
import type { Update } from './telegram/types';
import { OWNER_SHOP_ID, platformWebhookSecret, resolveShop } from './tenancy';
import { sameSecret } from './crypto';

/**
 * Routes:
 *   POST /webhook        the platform owner's own shop (shop 1)
 *   POST /webhook/<id>   a seller's shop bot
 *   POST /platform       the platform bot (create / renew shops, owner panel)
 *   GET  /               status page; also connects the webhooks (first-time setup)
 *   GET  /files/<key>    public product images from R2 (only when R2 is configured)
 *   cron (hourly)        subscription expiry reminders
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const secret = request.headers.get('x-telegram-bot-api-secret-token');

    const shopRoute = /^\/webhook(?:\/(\d+))?$/.exec(url.pathname);
    if (request.method === 'POST' && shopRoute) {
      await ensureSchema(env.DB);
      const shop = await resolveShop(env, Number(shopRoute[1] ?? OWNER_SHOP_ID), secret);
      if (!shop) return new Response('Forbidden', { status: 403 });
      return handle(request, (update) => createBot(createDeps(env, url.origin, shop))(update));
    }

    if (request.method === 'POST' && url.pathname === '/platform') {
      if (!env.PLATFORM_BOT_TOKEN || !env.MASTER_KEY || !secret || !(await sameSecret(secret, await platformWebhookSecret(env.MASTER_KEY)))) {
        return new Response('Forbidden', { status: 403 });
      }
      await ensureSchema(env.DB);
      return handle(request, (update) => createPlatformBot(createPlatformDeps(env, url.origin))(update));
    }

    if (request.method === 'GET' && url.pathname === '/') {
      await ensureSchema(env.DB);
      return statusPage(env, url.origin);
    }

    if (request.method === 'GET' && url.pathname.startsWith('/files/') && env.FILES) {
      return new FileStore(env.FILES, new TelegramClient(''), url.origin).serve(decodeURIComponent(url.pathname.slice('/files/'.length)));
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await ensureSchema(env.DB);
    await sendReminders(createPlatformDeps(env, ''));
  },
} satisfies ExportedHandler<Env>;

/** Runs a bot on one update and always ACKs: a non-2xx makes Telegram redeliver it in a loop. */
async function handle(request: Request, run: (update: Update) => Promise<void>): Promise<Response> {
  const update = (await request.json()) as Update;
  try {
    await run(update);
  } catch (err) {
    console.error('update failed', update.update_id, err);
  }
  return new Response('ok');
}

import { createBot } from './bot';
import { meterD1, emptyUsage, type D1Usage } from './db/meter';
import { ensureSchema } from './db/migrate';
import { addPendingUsage } from './db/usage';
import { createDeps } from './deps';
import type { Env } from './env';
import { checkCapacity, createPlatformBot, createPlatformDeps, purgeLapsedShops, sendReminders } from './platform';
import { REMINDERS_HOURLY, sendAppointmentReminders } from './reminders';
import { FileStore } from './services/FileStore';
import { statusPage } from './setup';
import { HOOK_VERSION, TelegramClient } from './telegram/TelegramClient';
import { ShopRepository } from './db/platform';
import type { Update } from './telegram/types';
import { OWNER_SHOP_ID, platformWebhookSecret, resolveShop, type ShopContext } from './tenancy';
import { sameSecret } from './crypto';

/**
 * Routes:
 *   POST /webhook        the platform owner's own shop (shop 1)
 *   POST /webhook/<id>   a seller's shop bot
 *   POST /platform       the platform bot (create / renew shops, owner panel)
 *   GET  /               status page; also connects the webhooks (first-time setup)
 *   GET  /files/<key>    public product images from R2 (only when R2 is configured)
 *   cron (quarter-hourly) appointment reminders to customers; on the hour also: expiry reminders to
 *                        sellers, deleting lapsed shops' data, capacity alarm
 *
 * Every D1 query goes through a meter; what a request cost is added to its bot's daily usage
 * (src/db/usage.ts) – the numbers behind the daily caps and the capacity page.
 */
/** The wrangler.jsonc trigger that runs only the appointment reminders. */
const QUARTER_CRON = '15,30,45 * * * *';

export default {
  async fetch(request: Request, rawEnv: Env): Promise<Response> {
    const url = new URL(request.url);
    // Every query of this request goes through the meter (rows read / written, as Cloudflare counts them).
    const usage = emptyUsage();
    const env: Env = { ...rawEnv, DB: meterD1(rawEnv.DB, usage) };
    const secret = request.headers.get('x-telegram-bot-api-secret-token');

    const shopRoute = /^\/webhook(?:\/(\d+))?$/.exec(url.pathname);
    if (request.method === 'POST' && shopRoute) {
      await ensureSchema(env.DB);
      const shop = await resolveShop(env, Number(shopRoute[1] ?? OWNER_SHOP_ID), secret);
      if (!shop) return new Response('Forbidden', { status: 403 });
      const response = await handle(request, usage, shop.id, (update) => createBot(createDeps(env, url.origin, shop))(update));
      await upgradeWebhook(env, shop, url.origin);
      return response;
    }

    if (request.method === 'POST' && url.pathname === '/platform') {
      if (!env.PLATFORM_BOT_TOKEN || !env.MASTER_KEY || !secret || !(await sameSecret(secret, await platformWebhookSecret(env.MASTER_KEY)))) {
        return new Response('Forbidden', { status: 403 });
      }
      await ensureSchema(env.DB);
      return handle(request, usage, 0, (update) => createPlatformBot(createPlatformDeps(env, url.origin))(update));
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

  async scheduled(controller: ScheduledController, rawEnv: Env): Promise<void> {
    const usage = emptyUsage();
    const env: Env = { ...rawEnv, DB: meterD1(rawEnv.DB, usage) };
    try {
      await ensureSchema(env.DB);
      // Two triggers: on the hour (everything) and at :15/:30/:45 (appointment reminders only).
      const hourly = controller.cron !== QUARTER_CRON;
      await sendAppointmentReminders(env, Math.floor(Date.now() / 1000), hourly ? REMINDERS_HOURLY : undefined);
      if (!hourly) return;
      const d = createPlatformDeps(env, '');
      await sendReminders(d);
      await purgeLapsedShops(d);
      await checkCapacity(d);
    } finally {
      addPendingUsage(0, usage); // the cron's own cost counts as the platform's
    }
  },
} satisfies ExportedHandler<Env>;

/** Shops whose re-registration failed lately, so a bad token isn't retried on every update. */
const upgradeFailed = new Map<number, number>();
const UPGRADE_RETRY_MS = 10 * 60_000;

/**
 * A seller's bot registered before a newer update type existed (inline mode) is registered again,
 * the first time it receives an update after the deploy. Updates already waiting are kept.
 */
async function upgradeWebhook(env: Env, shop: ShopContext, origin: string): Promise<void> {
  if (shop.id === OWNER_SHOP_ID || shop.hook_version >= HOOK_VERSION) return; // the owner's shop is registered by the status page
  if (Date.now() - (upgradeFailed.get(shop.id) ?? 0) < UPGRADE_RETRY_MS) return;
  try {
    await new TelegramClient(shop.token, env.TELEGRAM_API_BASE).setWebhook(`${origin}/webhook/${shop.id}`, shop.webhook_secret, false);
    await new ShopRepository(env.DB).setHookVersion(shop.id, HOOK_VERSION);
    shop.hook_version = HOOK_VERSION;
  } catch (err) {
    upgradeFailed.set(shop.id, Date.now());
    console.error('webhook upgrade failed', shop.id, err);
  }
}

/**
 * Runs a bot on one update and always ACKs: a non-2xx makes Telegram redeliver it in a loop.
 * The response reports what the update cost in D1 (Telegram ignores it; tests and ops read it).
 */
async function handle(request: Request, usage: D1Usage, shopId: number, run: (update: Update) => Promise<void>): Promise<Response> {
  const update = (await request.json()) as Update;
  try {
    await run(update);
  } catch (err) {
    console.error('update failed', update.update_id, err);
  }
  addPendingUsage(shopId, usage);
  return new Response('ok', { headers: usageHeaders(usage) });
}

const usageHeaders = (u: D1Usage) => ({
  'x-d1-queries': String(u.queries),
  'x-d1-rows-read': String(u.rowsRead),
  'x-d1-rows-written': String(u.rowsWritten),
});

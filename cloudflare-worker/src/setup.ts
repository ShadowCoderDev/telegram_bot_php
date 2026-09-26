import { derivedSecret } from './crypto';
import { ShopRepository } from './db/platform';
import { PLATFORM_SETTING_DEFAULTS, SettingsRepository } from './db/repositories';
import { parseAdminIds } from './deps';
import type { Env } from './env';
import { TelegramClient } from './telegram/TelegramClient';
import { OWNER_SHOP_ID, platformWebhookSecret } from './tenancy';
import { escapeHtml as e } from './utils/format';

interface BotStatus {
  ok: boolean;
  bot?: string;
  error?: string;
  admins: number;
}

/**
 * Points a bot's webhook at this Worker, only when the URL or secret changed since last time.
 * Runs when someone opens the Worker's URL, so after a deploy one visit finishes the setup.
 */
async function ensureWebhook(tg: TelegramClient, settings: SettingsRepository<string>, url: string, secret: string): Promise<string | undefined> {
  const me = await tg.call<{ username?: string }>('getMe');
  const marker = await derivedSecret(secret, url);
  if ((await settings.raw('webhook_marker')) !== marker) {
    await tg.setWebhook(url, secret);
    await settings.set('webhook_marker', marker);
  }
  if (me.username) await settings.set('bot_username', me.username);
  return me.username;
}

const failure = (err: unknown) => String(err instanceof Error ? err.message : err);

async function platformStatus(env: Env, origin: string): Promise<BotStatus | null> {
  if (!env.PLATFORM_BOT_TOKEN) return null;
  const settings = new SettingsRepository(env.DB, 0, PLATFORM_SETTING_DEFAULTS);
  const admins = new Set([...parseAdminIds(env.PLATFORM_ADMIN_IDS), ...(await settings.claimedAdmins())]).size;
  if (!env.MASTER_KEY || env.MASTER_KEY.length < 32) return { ok: false, error: 'MASTER_KEY باید حداقل ۳۲ کاراکتر باشد.', admins };
  try {
    const tg = new TelegramClient(env.PLATFORM_BOT_TOKEN, env.TELEGRAM_API_BASE);
    const bot = await ensureWebhook(tg, settings as SettingsRepository<string>, `${origin}/platform`, await platformWebhookSecret(env.MASTER_KEY));
    return { ok: true, bot, admins };
  } catch (err) {
    return { ok: false, error: failure(err), admins };
  }
}

async function ownerShopStatus(env: Env, origin: string): Promise<BotStatus | null> {
  if (!env.BOT_TOKEN) return null;
  const settings = new SettingsRepository(env.DB, OWNER_SHOP_ID);
  const admins = new Set([...parseAdminIds(env.ADMIN_CHAT_IDS), ...(await settings.claimedAdmins())]).size;
  if (!env.WEBHOOK_SECRET || !/^[A-Za-z0-9_-]{16,256}$/.test(env.WEBHOOK_SECRET)) {
    return { ok: false, error: 'WEBHOOK_SECRET باید حداقل ۱۶ کاراکتر و فقط شامل A-Z a-z 0-9 _ - باشد.', admins };
  }
  try {
    const tg = new TelegramClient(env.BOT_TOKEN, env.TELEGRAM_API_BASE);
    return { ok: true, bot: await ensureWebhook(tg, settings as SettingsRepository<string>, `${origin}/webhook`, env.WEBHOOK_SECRET), admins };
  } catch (err) {
    return { ok: false, error: failure(err), admins };
  }
}

const botLine = (label: string, s: BotStatus, claimHint: string) =>
  s.ok
    ? `<h2>✅ ${label}</h2>${s.bot ? `<p><a href="https://t.me/${e(s.bot)}">@${e(s.bot)}</a></p>` : ''}
       ${s.admins ? `<p>مدیرها: ${s.admins}</p>` : `<p><b>قدم آخر:</b> در این ربات بفرستید:</p><pre>/claim ${claimHint}</pre>`}`
    : `<h2>⚠️ ${label}</h2><p>${e(s.error)}</p>`;

/** GET /: connects the webhooks and shows what is configured. */
export async function statusPage(env: Env, origin: string): Promise<Response> {
  const [platform, owner, shops] = await Promise.all([platformStatus(env, origin), ownerShopStatus(env, origin), new ShopRepository(env.DB).count()]);
  const parts = [
    platform && botLine('ربات پلتفرم (فروشگاه‌ساز)', platform, 'MASTER_KEY'),
    platform?.ok && `<p>تعداد فروشگاه‌ها: ${shops}</p>`,
    owner && botLine('فروشگاه اصلی', owner, 'WEBHOOK_SECRET'),
    !platform && !owner && '<h2>⚠️ هیچ رباتی تنظیم نشده</h2><p>PLATFORM_BOT_TOKEN و MASTER_KEY (برای پلتفرم) یا BOT_TOKEN و WEBHOOK_SECRET (برای یک فروشگاه) را تنظیم کنید.</p>',
  ].filter(Boolean);
  const ok = [platform, owner].every((s) => !s || s.ok) && Boolean(platform || owner);
  return new Response(
    `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>وضعیت ربات</title><style>
body{font-family:system-ui,Tahoma,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;line-height:1.9;color:#1f2328;background:#fff}
h2{font-size:1.15em;margin-top:1.6em}pre{background:#f3f4f6;padding:12px;border-radius:8px;direction:ltr;text-align:left}
@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}pre{background:#161b22}a{color:#58a6ff}}
</style></head><body>${parts.join('\n')}
<p style="color:#6b7280;font-size:.9em">به‌جای MASTER_KEY یا WEBHOOK_SECRET همان مقداری را بنویسید که در تنظیمات Cloudflare گذاشته‌اید.</p></body></html>`,
    { status: ok ? 200 : 503, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

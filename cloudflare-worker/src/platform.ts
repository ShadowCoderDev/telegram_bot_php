/**
 * The platform bot: sellers create and renew shops here; the platform owner reviews payments and
 * manages every shop. Served at POST /platform. Each shop's own bot is served at /webhook/<id>.
 */
import { decryptToken, encryptToken, randomSecret, sameSecret } from './crypto';
import { ShopRepository, SubscriptionPaymentRepository, type ShopRow } from './db/platform';
import { PLATFORM_SETTING_DEFAULTS, PLATFORM_SETTING_KEYS, SessionRepository, SettingsRepository, UpdateLogRepository, type PlatformSettingKey } from './db/repositories';
import { parseAdminIds } from './deps';
import type { Env } from './env';
import { LIMITS, charCount } from './limits';
import { DAY, MONTH, RENEW_OPTIONS, dueReminder } from './services/subscription';
import { BotContext } from './telegram/BotContext';
import { Router } from './telegram/Router';
import { TelegramApiError, TelegramClient } from './telegram/TelegramClient';
import type { Update } from './telegram/types';
import { shopClaimCode } from './tenancy';
import { formatPersianDate, parseAmount, tehranDayAndMonthStart } from './utils/persian';
import { CANCEL_HINT, heading, sections } from './views/common';
import * as pv from './views/platform';

const { PCB } = pv;
const now = () => Math.floor(Date.now() / 1000);

/** How many shops one seller may own. */
export const MAX_SHOPS_PER_SELLER = 3;
const FLOW = { newShop: 'p_new_shop', changeToken: 'p_change_token', renew: 'p_renew', setting: 'pa_setting' } as const;
const TOKEN_FORMAT = /^\d{5,15}:[A-Za-z0-9_-]{30,50}$/;

export function createPlatformDeps(env: Env, origin: string) {
  const settings = new SettingsRepository(env.DB, 0, PLATFORM_SETTING_DEFAULTS);
  const envAdminIds = parseAdminIds(env.PLATFORM_ADMIN_IDS);
  return {
    env,
    origin,
    tg: new TelegramClient(env.PLATFORM_BOT_TOKEN ?? '', env.TELEGRAM_API_BASE),
    shops: new ShopRepository(env.DB),
    payments: new SubscriptionPaymentRepository(env.DB),
    settings,
    sessions: new SessionRepository(env.DB, 0),
    updateLog: new UpdateLogRepository(env.DB, 0),
    masterKey: env.MASTER_KEY ?? '',
    envAdminIds,
    adminIds: envAdminIds,
    floodLimit: Number(env.FLOOD_LIMIT) || 30,
    /** A Telegram client for one seller's bot. */
    botClient: (token: string) => new TelegramClient(token, env.TELEGRAM_API_BASE),
  };
}
export type PlatformDeps = ReturnType<typeof createPlatformDeps>;

async function price(d: PlatformDeps): Promise<number> {
  return Number(await d.settings.get('monthly_price')) || Number(PLATFORM_SETTING_DEFAULTS.monthly_price);
}
async function trialDays(d: PlatformDeps): Promise<number> {
  return Math.max(0, Math.min(30, Number(await d.settings.get('trial_days')) || 0));
}

/** Loads a shop only if `chatId` owns it (or is a platform admin); forged buttons get nothing. */
async function ownedShop(d: PlatformDeps, ctx: BotContext, id: number): Promise<ShopRow | null> {
  const shop = await d.shops.find(id);
  if (!shop || shop.status === 'deleted' || shop.plan === 'owner') return null;
  return shop.owner_chat_id === ctx.chatId || ctx.isAdmin ? shop : null;
}

/* ------------------------------------------------------------------ */
/* Shop provisioning                                                    */
/* ------------------------------------------------------------------ */

type ProvisionResult =
  | { ok: true; shop: ShopRow; revived: boolean }
  | { ok: false; reason: 'format' | 'invalid' | 'platform_bot' | 'taken' | 'already_yours' | 'too_many' | 'webhook'; detail?: string };

/** Validates a BotFather token and turns the bot into a shop served by this Worker. */
export async function provisionShop(d: PlatformDeps, ownerChatId: number, token: string): Promise<ProvisionResult> {
  if (!TOKEN_FORMAT.test(token)) return { ok: false, reason: 'format' };
  if (token === d.env.PLATFORM_BOT_TOKEN || token === d.env.BOT_TOKEN) return { ok: false, reason: 'platform_bot' };
  const bot = d.botClient(token);
  let me: { id: number; username?: string };
  try {
    me = await bot.call('getMe');
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  const existing = await d.shops.findByBotId(me.id);
  if (existing && existing.status !== 'deleted') return { ok: false, reason: existing.owner_chat_id === ownerChatId ? 'already_yours' : 'taken' };
  if (!existing && (await d.shops.listByOwner(ownerChatId)).length >= MAX_SHOPS_PER_SELLER) return { ok: false, reason: 'too_many' };

  const webhookSecret = randomSecret();
  const tokenEnc = await encryptToken(token, d.masterKey);
  const username = me.username ?? '';
  let id: number;
  if (existing) {
    // Same bot, deleted earlier: bring the shop and its data back.
    await d.shops.revive(existing.id, { ownerChatId, botUsername: username, tokenEnc, webhookSecret });
    id = existing.id;
  } else {
    id = await d.shops.create({ ownerChatId, botId: me.id, botUsername: username, tokenEnc, webhookSecret, paidUntil: now() + (await trialDays(d)) * DAY });
  }
  try {
    await bot.setWebhook(`${d.origin}/webhook/${id}`, webhookSecret);
  } catch (err) {
    if (!existing) await d.shops.setStatus(id, 'deleted');
    return { ok: false, reason: 'webhook', detail: err instanceof TelegramApiError ? err.description : String(err) };
  }
  return { ok: true, shop: (await d.shops.find(id))!, revived: Boolean(existing) };
}

const PROVISION_ERRORS: Record<Exclude<ProvisionResult, { ok: true }>['reason'], string> = {
  format: '⚠️ این شبیه توکن ربات نیست. توکن را کامل از @BotFather کپی کنید؛ مثل <code>123456789:AAH...</code>',
  invalid: '❌ تلگرام این توکن را قبول نکرد. شاید باطل شده؛ از @BotFather با <code>/token</code> توکن تازه بگیرید.',
  platform_bot: '⚠️ این توکن متعلق به خود پلتفرم است. یک ربات جدید در @BotFather بسازید.',
  taken: '⚠️ این ربات قبلاً در پلتفرم ثبت شده است.',
  already_yours: 'ℹ️ این ربات قبلاً فروشگاه شماست؛ از «فروشگاه‌های من» مدیریتش کنید.',
  too_many: `⚠️ هر فروشنده حداکثر ${MAX_SHOPS_PER_SELLER} فروشگاه می‌تواند داشته باشد.`,
  webhook: '❌ اتصال ربات به پلتفرم ناموفق بود. چند دقیقه بعد دوباره تلاش کنید.',
};

/* ------------------------------------------------------------------ */
/* Bot                                                                  */
/* ------------------------------------------------------------------ */

export function createPlatformBot(d: PlatformDeps) {
  const seller = registerSellerRoutes(new Router(), d);
  const admin = registerAdminRoutes(new Router(), d);

  return async function handleUpdate(update: Update): Promise<void> {
    d.adminIds = [...new Set([...d.envAdminIds, ...(await d.settings.claimedAdmins())])];
    const ctx = new BotContext(update, d.tg, d.adminIds);
    if (!ctx.chatId || ctx.chatType !== 'private') return;
    if (!(await d.updateLog.firstTime(update.update_id, ctx.chatId))) return;
    if (update.update_id % 200 === 0) await d.updateLog.prune();
    const cb = update.callback_query;
    if (!ctx.isAdmin && (await d.updateLog.recentCount(ctx.chatId, 10)) > d.floodLimit) {
      if (cb) await d.tg.answerCallbackQuery(cb.id, '⏳ لطفاً کمی آهسته‌تر').catch(() => {});
      return;
    }
    const answered = cb ? d.tg.answerCallbackQuery(cb.id).catch(() => {}) : Promise.resolve();
    if (!(ctx.isAdmin && (await admin.dispatch(ctx)))) await seller.dispatch(ctx);
    await answered;
  };
}

function registerSellerRoutes(router: Router, d: PlatformDeps): Router {
  const home = async (ctx: BotContext) => ctx.render(pv.welcome(await price(d), await trialDays(d), ctx.isAdmin));
  const shops = async (ctx: BotContext) => ctx.render(pv.myShops(await d.shops.listByOwner(ctx.chatId), now()));
  const shopPage = async (ctx: BotContext, id: number) => {
    const shop = await ownedShop(d, ctx, id);
    if (!shop) return shops(ctx);
    const pending = (await d.payments.pendingCountForShop(shop.id)) > 0;
    await ctx.render(pv.shopPage(shop, now(), await shopClaimCode(d.masterKey, shop.id), pending));
  };
  const renew = async (ctx: BotContext, id: number) => {
    const shop = await ownedShop(d, ctx, id);
    if (!shop) return shops(ctx);
    await ctx.render(pv.renewOptions(shop, await price(d), now()));
  };

  return router
    .text(/^\/start(?:\s+(\S+))?$/, async (ctx, [payload]) => {
      await d.sessions.clear(ctx.chatId);
      const renewId = /^renew_(\d+)$/.exec(payload ?? '')?.[1];
      if (renewId) return renew(ctx, Number(renewId)); // deep link from a shop's admin panel
      await home(ctx);
    })
    .text('/cancel', async (ctx) => {
      await d.sessions.clear(ctx.chatId);
      await ctx.reply({ text: '✅ لغو شد.' });
      await home(ctx);
    })
    .text(/^\/claim(?:\s+(\S+))?$/, async (ctx, [code]) => {
      // The platform owner becomes platform admin with MASTER_KEY.
      if (d.masterKey.length < 32 || !code || !(await sameSecret(code, d.masterKey))) return ctx.reply({ text: '❌ کد اشتباه است.' });
      await d.settings.addAdmin(ctx.chatId);
      await ctx.reply({ text: '✅ شما مدیر پلتفرم شدید. /start را بزنید.' });
    })
    .callback(PCB.home, home)
    .callback('noop', async () => {})
    .callback(PCB.shops, shops)
    .callback(PCB.limits, async (ctx) => ctx.render(pv.limitsView(await price(d), await trialDays(d))))
    .callback(PCB.support, async (ctx) => ctx.render(pv.supportView(await d.settings.get('support'))))
    .callback(PCB.newShop, async (ctx) => {
      if (!d.masterKey) return ctx.reply({ text: '⚠️ پلتفرم هنوز کامل راه‌اندازی نشده (MASTER_KEY).' });
      await d.sessions.set(ctx.chatId, FLOW.newShop, 'token');
      await ctx.render(pv.newShopInstructions());
    })
    .callback(/^p:shop:(\d+)$/, (ctx, [id]) => shopPage(ctx, Number(id)))
    .callback(/^p:renew:(\d+)$/, (ctx, [id]) => renew(ctx, Number(id)))
    .callback(/^p:pay:(\d+):(\d+)$/, async (ctx, [id, rawMonths]) => {
      const shop = await ownedShop(d, ctx, Number(id));
      const months = Number(rawMonths);
      if (!shop || !RENEW_OPTIONS.includes(months as (typeof RENEW_OPTIONS)[number])) return shops(ctx);
      if ((await d.payments.pendingCountForShop(shop.id)) > 0) {
        return ctx.reply({ text: '⏳ یک پرداخت این فروشگاه هنوز در حال بررسی است؛ بعد از بررسی آن دوباره اقدام کنید.' });
      }
      const amount = (await price(d)) * months;
      await d.sessions.set(ctx.chatId, FLOW.renew, 'receipt', { shopId: shop.id, months, amount });
      await ctx.render(pv.paymentInstructions(shop, months, amount, await d.settings.get('bank_info')));
    })
    .callback(/^p:token:(\d+)$/, async (ctx, [id]) => {
      const shop = await ownedShop(d, ctx, Number(id));
      if (!shop) return shops(ctx);
      await d.sessions.set(ctx.chatId, FLOW.changeToken, 'token', { shopId: shop.id });
      await ctx.reply({ text: sections(heading('🔑', `توکن جدید @${shop.bot_username}`), 'اگر توکن را در @BotFather عوض کرده‌اید، توکن جدید <b>همان ربات</b> را بفرستید:', CANCEL_HINT) });
    })
    .callback(/^p:hook:(\d+)$/, async (ctx, [id]) => {
      const shop = await ownedShop(d, ctx, Number(id));
      if (!shop) return shops(ctx);
      try {
        await d.botClient(await decryptToken(shop.bot_token_enc, d.masterKey)).setWebhook(`${d.origin}/webhook/${shop.id}`, shop.webhook_secret);
        await ctx.reply({ text: '✅ ربات دوباره به پلتفرم وصل شد.' });
      } catch {
        await ctx.reply({ text: '❌ اتصال ناموفق بود. اگر توکن را عوض کرده‌اید، از «🔑 تغییر توکن» استفاده کنید.' });
      }
    })
    .callback(/^p:del:(\d+)$/, async (ctx, [id]) => {
      const shop = await ownedShop(d, ctx, Number(id));
      await (shop ? ctx.render(pv.deleteConfirm(shop)) : shops(ctx));
    })
    .callback(/^p:delok:(\d+)$/, async (ctx, [id]) => {
      const shop = await ownedShop(d, ctx, Number(id));
      if (!shop) return shops(ctx);
      await d.shops.setStatus(shop.id, 'deleted');
      await d.botClient(await decryptToken(shop.bot_token_enc, d.masterKey)).call('deleteWebhook').catch(() => {});
      await ctx.reply({ text: `🗑 فروشگاه @${shop.bot_username} حذف شد.` });
      await shops(ctx);
    })
    .fallback(async (ctx) => {
      if (ctx.isCallback) return home(ctx);
      const s = await d.sessions.get<{ shopId?: number; months?: number; amount?: number }>(ctx.chatId);
      if (s?.flow === FLOW.newShop || s?.flow === FLOW.changeToken) {
        const token = ctx.text?.trim() ?? '';
        // The message holds a secret: remove it from the chat right away (best effort).
        if (ctx.update.message) await d.tg.deleteMessage(ctx.chatId, ctx.update.message.message_id).catch(() => {});
        if (s.flow === FLOW.newShop) {
          const result = await provisionShop(d, ctx.chatId, token);
          if (!result.ok) return ctx.reply({ text: sections(PROVISION_ERRORS[result.reason], CANCEL_HINT) });
          await d.sessions.clear(ctx.chatId);
          return ctx.reply(pv.shopCreated(result.shop, await trialDays(d)));
        }
        return changeToken(ctx, d, Number(s.data.shopId), token);
      }
      if (s?.flow === FLOW.renew) return receiveReceipt(ctx, d, s.data as { shopId: number; months: number; amount: number });
      await home(ctx);
    });
}

async function changeToken(ctx: BotContext, d: PlatformDeps, shopId: number, token: string): Promise<void> {
  const shop = await ownedShop(d, ctx, shopId);
  if (!shop) return void (await d.sessions.clear(ctx.chatId));
  if (!TOKEN_FORMAT.test(token)) return ctx.reply({ text: sections(PROVISION_ERRORS.format, CANCEL_HINT) });
  const bot = d.botClient(token);
  const me = await bot.call<{ id: number; username?: string }>('getMe').catch(() => null);
  if (!me) return ctx.reply({ text: sections(PROVISION_ERRORS.invalid, CANCEL_HINT) });
  if (me.id !== shop.bot_id) return ctx.reply({ text: sections('⚠️ این توکن مال ربات دیگری است؛ توکن جدید همان ربات فروشگاه را بفرستید.', CANCEL_HINT) });
  await d.shops.updateToken(shop.id, await encryptToken(token, d.masterKey), me.username ?? shop.bot_username);
  await bot.setWebhook(`${d.origin}/webhook/${shop.id}`, shop.webhook_secret);
  await d.sessions.clear(ctx.chatId);
  await ctx.reply({ text: '✅ توکن به‌روز شد و ربات دوباره وصل شد.' });
}

async function receiveReceipt(ctx: BotContext, d: PlatformDeps, data: { shopId: number; months: number; amount: number }): Promise<void> {
  const image = ctx.image;
  if (!image) return ctx.reply({ text: sections('📸 لطفاً <b>عکس رسید</b> واریز را بفرستید.', CANCEL_HINT) });
  const shop = await ownedShop(d, ctx, data.shopId);
  if (!shop) return void (await d.sessions.clear(ctx.chatId));
  if ((await d.payments.pendingCountForShop(shop.id)) > 0) {
    await d.sessions.clear(ctx.chatId);
    return ctx.reply({ text: '⏳ یک پرداخت این فروشگاه هنوز در حال بررسی است.' });
  }
  const created = await d.payments.create({
    shopId: shop.id,
    payerChatId: ctx.chatId,
    months: data.months,
    amount: data.amount,
    fileId: image.fileId,
    uniqueId: image.uniqueId,
  });
  if (!created.ok) return ctx.reply({ text: sections('⚠️ این رسید قبلاً استفاده شده است. رسید همین پرداخت را بفرستید.', CANCEL_HINT) });
  await d.sessions.clear(ctx.chatId);
  await ctx.reply(pv.paymentReceived());
  const payment = (await d.payments.find(created.id))!;
  const alert = pv.paymentView(payment, shop, now(), heading('🔔', 'پرداخت جدید اشتراک'));
  await Promise.all(d.adminIds.map((id) => ctx.sendTo(id, alert).catch((err) => console.error('notify platform admin', err))));
}

/* ---------- platform owner ---------- */

function registerAdminRoutes(router: Router, d: PlatformDeps): Router {
  const root = async (ctx: BotContext) => ctx.render(pv.adminRoot(await d.payments.countPending(), await d.shops.stats(now())));
  const payments = async (ctx: BotContext) => {
    const list = await d.payments.listPending();
    const shops = new Map<number, ShopRow>();
    for (const p of list) if (!shops.has(p.shop_id)) shops.set(p.shop_id, (await d.shops.find(p.shop_id))!);
    await ctx.render(pv.paymentsList(list, shops));
  };
  const shopsPage = async (ctx: BotContext, page: number) => {
    const size = 10;
    const pages = Math.max(1, Math.ceil((await d.shops.count()) / size));
    const p = Math.max(0, Math.min(page, pages - 1));
    await ctx.render(pv.shopsList(await d.shops.page(size, p * size), p, pages, now()));
  };
  const shopPage = async (ctx: BotContext, id: number) => {
    const shop = await d.shops.find(id);
    await (shop ? ctx.render(pv.adminShopPage(shop, now(), await d.payments.forShop(id))) : shopsPage(ctx, 0));
  };
  const notifyOwner = (shop: ShopRow, text: string) =>
    shop.owner_chat_id ? d.tg.sendMessage(shop.owner_chat_id, text).catch((err) => console.error('notify seller', err)) : undefined;

  return router
    .text('/start', root)
    .callback(PCB.admin.root, root)
    .callback(PCB.admin.payments, payments)
    .callback(/^pa:pay:(\d+)$/, async (ctx, [id]) => {
      const p = await d.payments.find(Number(id));
      await (p ? ctx.render(pv.paymentView(p, await d.shops.find(p.shop_id), now())) : payments(ctx));
    })
    .callback(/^pa:pay:ok:(\d+)$/, async (ctx, [id]) => {
      const until = await d.payments.approve(Number(id), now());
      const p = (await d.payments.find(Number(id)))!;
      const shop = await d.shops.find(p.shop_id);
      if (until === null) {
        await ctx.reply({ text: 'ℹ️ این پرداخت قبلاً بررسی شده بود.' });
      } else if (shop) {
        await ctx.reply({ text: `✅ اشتراک @${shop.bot_username} تمدید شد.` });
        await notifyOwner(
          shop,
          sections(heading('✅', 'اشتراک تمدید شد'), `فروشگاه @${shop.bot_username} تا <b>${pvDate(until)}</b> فعال است. ممنون از اعتمادتان 🙏`),
        );
      }
      await payments(ctx);
    })
    .callback(/^pa:pay:no:(\d+)$/, async (ctx, [id]) => {
      const rejected = await d.payments.reject(Number(id), now());
      const p = (await d.payments.find(Number(id)))!;
      const shop = await d.shops.find(p.shop_id);
      if (rejected && shop) {
        await notifyOwner(shop, sections(heading('❌', 'پرداخت تایید نشد'), `رسید تمدید @${shop.bot_username} تایید نشد. برای پیگیری با پشتیبانی تماس بگیرید.`));
      }
      await ctx.reply({ text: rejected ? '❌ پرداخت رد شد.' : 'ℹ️ این پرداخت قبلاً بررسی شده بود.' });
      await payments(ctx);
    })
    .callback(PCB.admin.shops, (ctx) => shopsPage(ctx, 0))
    .callback(/^pa:shops:(\d+)$/, (ctx, [page]) => shopsPage(ctx, Number(page)))
    .callback(/^pa:shop:(\d+)$/, (ctx, [id]) => shopPage(ctx, Number(id)))
    .callback(/^pa:shop:add30:(\d+)$/, async (ctx, [id]) => {
      const shop = await d.shops.find(Number(id));
      if (shop && shop.plan !== 'owner') {
        await d.shops.extend(shop.id, MONTH, now());
        await notifyOwner(shop, `🎁 ۳۰ روز رایگان به اشتراک @${shop.bot_username} اضافه شد.`);
      }
      await shopPage(ctx, Number(id));
    })
    .callback(/^pa:shop:susp:(\d+)$/, async (ctx, [id]) => {
      const shop = await d.shops.find(Number(id));
      if (shop && shop.plan !== 'owner') await d.shops.setStatus(shop.id, shop.status === 'suspended' ? 'active' : 'suspended');
      await shopPage(ctx, Number(id));
    })
    .callback(PCB.admin.stats, async (ctx) => {
      const { month } = tehranDayAndMonthStart(now());
      const [monthRevenue, total, stats] = await Promise.all([d.payments.revenue(month), d.payments.revenue(0), d.shops.stats(now())]);
      await ctx.render(pv.revenueView({ month: monthRevenue, total }, stats));
    })
    .callback(PCB.admin.settings, async (ctx) => ctx.render(pv.settingsView(await d.settings.getMany(PLATFORM_SETTING_KEYS))))
    .callback(/^pa:set:(\w+)$/, async (ctx, [key]) => {
      if (!PLATFORM_SETTING_KEYS.includes(key as PlatformSettingKey)) return;
      await d.sessions.set(ctx.chatId, FLOW.setting, 'value', { key });
      await ctx.reply({ text: sections(pv.PLATFORM_SETTING_LABELS[key as PlatformSettingKey].prompt, CANCEL_HINT) });
    })
    .fallback(async (ctx) => {
      if (ctx.isCallback) return false;
      const s = await d.sessions.get<{ key: PlatformSettingKey }>(ctx.chatId);
      if (s?.flow !== FLOW.setting) return false;
      const text = ctx.text ?? '';
      let value = text;
      if (s.data.key === 'monthly_price') {
        const n = parseAmount(text);
        if (n === null || n < 1000 || n > 100_000_000) return ctx.reply({ text: sections('⚠️ یک مبلغ معتبر به تومان بفرستید؛ مثل 49000', CANCEL_HINT) });
        value = String(n);
      } else if (s.data.key === 'trial_days') {
        const n = parseAmount(text);
        if (n === null || n > 30) return ctx.reply({ text: sections('⚠️ عددی بین ۰ تا ۳۰ بفرستید.', CANCEL_HINT) });
        value = String(n);
      } else if (!text || charCount(text) > LIMITS.setting) {
        return ctx.reply({ text: sections('⚠️ یک متن کوتاه بفرستید.', CANCEL_HINT) });
      }
      await d.settings.set(s.data.key, value);
      await d.sessions.clear(ctx.chatId);
      await ctx.reply({ text: '✅ ذخیره شد.' });
      await ctx.reply(pv.settingsView(await d.settings.getMany(PLATFORM_SETTING_KEYS)));
    });
}

const pvDate = (unix: number) => formatPersianDate(unix).split(' - ')[0];

/* ------------------------------------------------------------------ */
/* Cron: expiry reminders                                               */
/* ------------------------------------------------------------------ */

/**
 * Sends each due expiry reminder once (3 days before, at expiry, when closed). Runs hourly;
 * a batch is capped well under the free plan's 50 outgoing requests per invocation.
 */
export async function sendReminders(d: PlatformDeps, batch = 40): Promise<number> {
  if (!d.env.PLATFORM_BOT_TOKEN) return 0;
  const t = now();
  let sent = 0;
  for (const shop of await d.shops.reminderCandidates(t, batch)) {
    const stage = dueReminder(shop, t);
    if (!stage) continue;
    const view = pv.reminder(shop, stage);
    await d.tg.sendMessage(shop.owner_chat_id, view.text, view.keyboard).catch((err) => console.error('reminder', shop.id, err));
    await d.shops.setReminderStage(shop.id, stage);
    sent++;
  }
  return sent;
}

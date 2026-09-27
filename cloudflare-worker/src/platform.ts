/**
 * The platform bot: sellers create and renew shops here; the platform owner reviews payments and
 * manages every shop. Served at POST /platform. Each shop's own bot is served at /webhook/<id>.
 */
import { CAPACITY_KEYS, CAPACITY_RANGES, capacityReport, capacitySettings, dailyCap, forgetCapacitySettings, quotaUsage, type CapacityKey } from './capacity';
import { ERROR_TEXT, SLOW_DOWN_TEXT } from './bot';
import { decryptToken, encryptToken, randomSecret, sameSecret } from './crypto';
import { ShopRepository, SubscriptionPaymentRepository, type ShopRow } from './db/platform';
import { PLATFORM_SETTING_DEFAULTS, PLATFORM_SETTING_KEYS, SessionRepository, SettingsRepository, type PlatformSettingKey } from './db/repositories';
import { UNCAPPED, UsageRepository, addDropped } from './db/usage';
import { parseAdminIds } from './deps';
import { flooding, onceEvery } from './flood';
import type { Env } from './env';
import { LIMITS, charCount } from './limits';
import { DAY, MONTH, RENEW_OPTIONS, dueReminder } from './services/subscription';
import { BotContext } from './telegram/BotContext';
import { Router } from './telegram/Router';
import { TelegramApiError, TelegramClient } from './telegram/TelegramClient';
import type { Update } from './telegram/types';
import { shopClaimCode } from './tenancy';
import { formatPersianDate, parseAmount, tehranDayAndMonthStart } from './utils/persian';
import { CANCEL_HINT, heading, num, sections } from './views/common';
import * as pv from './views/platform';

const { PCB } = pv;
const PLATFORM_FULL_TEXT = '⏳ ظرفیت امروز ربات تکمیل شده است.\nلطفاً بعد از ساعت ۳:۳۰ بامداد دوباره سر بزنید. 🙏';
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
    /** Redelivery protection and usage counters of the platform bot itself (shop 0, never capped). */
    usage: new UsageRepository(env.DB, 0),
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
/** Days a lapsed shop's data is kept after it closes (platform setting, 7–365). */
export async function retentionDays(d: PlatformDeps): Promise<number> {
  const n = Number(await d.settings.get('retention_days'));
  return Number.isFinite(n) && n >= 7 ? Math.min(365, n) : Number(PLATFORM_SETTING_DEFAULTS.retention_days);
}
async function trialDays(d: PlatformDeps): Promise<number> {
  return Math.max(0, Math.min(30, Number(await d.settings.get('trial_days')) || 0));
}
/** A shop's usage today and its daily cap. */
async function shopUsage(d: PlatformDeps, shop: ShopRow): Promise<pv.ShopUsage> {
  const [today, c] = await Promise.all([new UsageRepository(d.env.DB, shop.id).today(now()), capacitySettings(d.settings)]);
  return { today, cap: dailyCap(shop, c) };
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
  let me: { id: number; username?: string; first_name?: string };
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
    // Customers see the shop under its bot's name until the seller sets another one.
    if (me.first_name?.trim()) await new SettingsRepository(d.env.DB, id).set('shop_name', me.first_name.trim());
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

  async function handleUpdate(update: Update, ctx: BotContext): Promise<void> {
    const cb = update.callback_query;
    if (!ctx.isAdmin && flooding(`0:${ctx.chatId}`, d.floodLimit)) {
      addDropped(0);
      if (cb) await d.tg.answerCallbackQuery(cb.id, SLOW_DOWN_TEXT).catch(() => {});
      return;
    }
    // Redeliveries are skipped. Sellers share a daily cap on this bot, so nobody can spend the
    // platform's quota through it; platform admins are never capped.
    const limit = ctx.isAdmin ? UNCAPPED : (await capacitySettings(d.settings)).platformCap;
    const tracked = await d.usage.track(update.update_id, now(), { updates: limit, written: UNCAPPED, read: UNCAPPED });
    if (tracked.status === 'duplicate') return;
    if (tracked.status === 'capped') {
      if (cb) await d.tg.answerCallbackQuery(cb.id, PLATFORM_FULL_TEXT, true).catch(() => {});
      else if (onceEvery(`full:0:${ctx.chatId}`, 600)) await d.tg.sendMessage(ctx.chatId, PLATFORM_FULL_TEXT).catch(() => {});
      return;
    }
    const answered = cb ? d.tg.answerCallbackQuery(cb.id).catch(() => {}) : Promise.resolve();
    try {
      if (!(ctx.isAdmin && (await admin.dispatch(ctx)))) await seller.dispatch(ctx);
    } finally {
      await answered;
    }
  }

  return async function (update: Update): Promise<void> {
    d.adminIds = [...new Set([...d.envAdminIds, ...(await d.settings.claimedAdmins())])];
    const ctx = new BotContext(update, d.tg, d.adminIds);
    if (!ctx.chatId || ctx.chatType !== 'private') return;
    try {
      await handleUpdate(update, ctx);
    } catch (err) {
      // A failed database query (or a bug) must not leave the seller waiting for an answer.
      if (!(err instanceof TelegramApiError) && onceEvery(`error:0:${ctx.chatId}`, 60)) await d.tg.sendMessage(ctx.chatId, ERROR_TEXT).catch(() => {});
      throw err;
    }
  };
}

function registerSellerRoutes(router: Router, d: PlatformDeps): Router {
  const home = async (ctx: BotContext) => ctx.render(pv.welcome(await price(d), await trialDays(d), ctx.isAdmin));
  const shops = async (ctx: BotContext) => ctx.render(pv.myShops(await d.shops.listByOwner(ctx.chatId), now()));
  const shopPage = async (ctx: BotContext, id: number) => {
    const shop = await ownedShop(d, ctx, id);
    if (!shop) return shops(ctx);
    const pending = (await d.payments.pendingCountForShop(shop.id)) > 0;
    await ctx.render(pv.shopPage(shop, now(), await shopClaimCode(d.masterKey, shop.id), pending, await shopUsage(d, shop), await retentionDays(d)));
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
    .callback(PCB.limits, async (ctx) => {
      const c = await capacitySettings(d.settings);
      await ctx.render(pv.limitsView(await price(d), await trialDays(d), { trial: c.trialCap, paid: c.paidCap }, await retentionDays(d)));
    })
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
    await (shop ? ctx.render(pv.adminShopPage(shop, now(), await d.payments.forShop(id), await shopUsage(d, shop), await retentionDays(d))) : shopsPage(ctx, 0));
  };
  const capacity = async (ctx: BotContext) => ctx.render(pv.capacityView(await capacityReport(d.env.DB, await capacitySettings(d.settings), now())));
  const capacitySettingsPage = async (ctx: BotContext) => ctx.render(pv.capacitySettingsView(await d.settings.getMany(CAPACITY_KEYS)));
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
    .callback(/^pa:shop:cap2:(\d+)$/, async (ctx, [id]) => {
      const shop = await d.shops.find(Number(id));
      if (shop && shop.plan !== 'owner') {
        const cap = dailyCap(shop, await capacitySettings(d.settings));
        await d.shops.setDailyLimit(shop.id, Math.min(cap * 2, CAPACITY_RANGES.paid_daily_limit[1]));
      }
      await shopPage(ctx, Number(id));
    })
    .callback(/^pa:shop:capdef:(\d+)$/, async (ctx, [id]) => {
      await d.shops.setDailyLimit(Number(id), null);
      await shopPage(ctx, Number(id));
    })
    .callback(PCB.admin.capacity, capacity)
    .callback(PCB.admin.capacitySettings, capacitySettingsPage)
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
      } else if (s.data.key === 'retention_days') {
        const n = parseAmount(text);
        if (n === null || n < 7 || n > 365) return ctx.reply({ text: sections('⚠️ عددی بین ۷ تا ۳۶۵ بفرستید.', CANCEL_HINT) });
        value = String(n);
      } else if (isCapacityKey(s.data.key)) {
        const n = parseAmount(text);
        const [min, max] = CAPACITY_RANGES[s.data.key];
        if (n === null || n < min || n > max) return ctx.reply({ text: sections(`⚠️ عددی بین ${num(min)} و ${num(max)} بفرستید.`, CANCEL_HINT) });
        value = String(n);
      } else if (!text || charCount(text) > LIMITS.setting) {
        return ctx.reply({ text: sections('⚠️ یک متن کوتاه بفرستید.', CANCEL_HINT) });
      }
      await d.settings.set(s.data.key, value);
      await d.sessions.clear(ctx.chatId);
      await ctx.reply({ text: '✅ ذخیره شد.' });
      if (isCapacityKey(s.data.key)) {
        forgetCapacitySettings();
        return ctx.reply(pv.capacitySettingsView(await d.settings.getMany(CAPACITY_KEYS)));
      }
      await ctx.reply(pv.settingsView(await d.settings.getMany(PLATFORM_SETTING_KEYS)));
    });
}

const pvDate = (unix: number) => formatPersianDate(unix).split(' - ')[0];
const isCapacityKey = (key: string): key is CapacityKey => (CAPACITY_KEYS as readonly string[]).includes(key);

/* ------------------------------------------------------------------ */
/* Cron: expiry reminders                                               */
/* ------------------------------------------------------------------ */

/**
 * Sends each due expiry reminder once (3 days before, at expiry, when closed, a week before the
 * data is deleted). Runs hourly; a batch is capped well under the free plan's 50 outgoing
 * requests per invocation.
 */
export async function sendReminders(d: PlatformDeps, batch = 30): Promise<number> {
  if (!d.env.PLATFORM_BOT_TOKEN) return 0;
  const t = now();
  const retention = await retentionDays(d);
  let sent = 0;
  for (const shop of await d.shops.reminderCandidates(t, retention, batch)) {
    const stage = dueReminder(shop, t, retention);
    if (!stage) continue;
    const view = pv.reminder(shop, stage, retention);
    await d.tg.sendMessage(shop.owner_chat_id, view.text, view.keyboard).catch((err) => console.error('reminder', shop.id, err));
    await d.shops.setReminderStage(shop.id, stage);
    sent++;
  }
  return sent;
}

/**
 * Deletes the data of shops that stayed unpaid for the whole retention period, disconnects their
 * bots and tells the sellers. A few shops per run: each one is a handful of deletes.
 */
export async function purgeLapsedShops(d: PlatformDeps, batch = 3): Promise<number> {
  const t = now();
  let purged = 0;
  for (const shop of await d.shops.purgeCandidates(t, await retentionDays(d), batch)) {
    // Disconnect the bot first (needs its token, which the purge erases).
    if (d.masterKey && shop.bot_token_enc) {
      const token = await decryptToken(shop.bot_token_enc, d.masterKey).catch(() => null);
      if (token) await d.botClient(token).call('deleteWebhook').catch(() => {});
    }
    if (!(await d.shops.purge(shop.id, t, shop.paid_until))) continue; // renewed meanwhile
    purged++;
    if (d.env.PLATFORM_BOT_TOKEN) {
      const view = pv.purgedNotice(shop);
      await d.tg.sendMessage(shop.owner_chat_id, view.text, view.keyboard).catch((err) => console.error('purge notice', shop.id, err));
    }
  }
  return purged;
}

/* ------------------------------------------------------------------ */
/* Cron: capacity alarm                                                 */
/* ------------------------------------------------------------------ */

/**
 * Hourly: warns the platform admins when today's use of a Cloudflare quota passes the alarm
 * threshold, and again when it becomes critical – each at most once per day.
 * Returns the level that was announced (0 = nothing sent).
 */
export async function checkCapacity(d: PlatformDeps): Promise<number> {
  if (!d.env.PLATFORM_BOT_TOKEN) return 0;
  const report = await quotaUsage(d.env.DB, await capacitySettings(d.settings), now());
  if (report.level === 0) return 0;
  const [day, level] = ((await d.settings.raw('capacity_alert')) ?? '0:0').split(':').map(Number);
  if (day === report.day && (level ?? 0) >= report.level) return 0;
  await d.settings.set('capacity_alert', `${report.day}:${report.level}`);
  const view = pv.capacityAlarm(report);
  const admins = new Set([...d.envAdminIds, ...(await d.settings.claimedAdmins())]);
  await Promise.all([...admins].map((id) => d.tg.sendMessage(id, view.text, view.keyboard).catch((err) => console.error('capacity alarm', err))));
  return report.level;
}

import {
  PLATFORM_SETTING_DEFAULTS,
  CategoryRepository,
  DialogRepository,
  FaqRepository,
  OrderRepository,
  ProductRepository,
  SessionRepository,
  SettingsRepository,
  UserRepository,
} from './db/repositories';
import type { UserRow } from './db/models';
import { UsageRepository } from './db/usage';
import { NO_LIMITS, capacitySettings, shopLimits, type Limits } from './capacity';
import type { Env } from './env';
import type { ShopContext } from './tenancy';
import { CartService } from './services/CartService';
import { FileStore } from './services/FileStore';
import { OrderService } from './services/OrderService';
import { TelegramClient } from './telegram/TelegramClient';
import { parseCheckoutFields, type CheckoutField } from './services/checkoutFields';

/**
 * Composition root: builds every object once per request and hands them to handlers.
 * Nothing below this layer reads `env` or globals, so each piece can be tested with fakes.
 */
export function createDeps(env: Env, publicOrigin: string, shop: ShopContext) {
  const tg = new TelegramClient(shop.token, env.TELEGRAM_API_BASE);
  const id = shop.id;
  const users = new UserRepository(env.DB, id);
  const orders = new OrderRepository(env.DB, id);
  const products = new ProductRepository(env.DB, id);
  const settings = new SettingsRepository(env.DB, id);
  const platformSettings = new SettingsRepository(env.DB, 0, PLATFORM_SETTING_DEFAULTS);
  // Admins: the seller who owns the shop, ADMIN_CHAT_IDS for the owner's own shop, plus /claim-ed ones.
  const fixedAdmins = [...(shop.owner_chat_id ? [shop.owner_chat_id] : []), ...(id === 1 ? parseAdminIds(env.ADMIN_CHAT_IDS) : [])];
  return {
    shop,
    tg,
    users,
    orders,
    products,
    categories: new CategoryRepository(env.DB, id),
    faqs: new FaqRepository(env.DB, id),
    settings,
    /** The platform's settings (shop 0) – e.g. the platform bot's @username for renewal links. */
    platformSettings,
    sessions: new SessionRepository(env.DB, id),
    dialogs: new DialogRepository(env.DB, id),
    /** Redelivery protection, today's usage and the daily cap (one row per bot). */
    usage: new UsageRepository(env.DB, id),
    /** What the shop's bot may still do today, for a customer's or an admin's update (src/capacity.ts). */
    limits: async (isAdmin: boolean): Promise<Limits> => (shop.plan === 'owner' ? NO_LIMITS : shopLimits(shop, await capacitySettings(platformSettings), isAdmin)),
    floodLimit: Number(env.FLOOD_LIMIT) || 30,
    /** Tells the platform owner(s) something through the platform bot; does nothing without one. */
    async alertPlatform(text: string): Promise<void> {
      if (!env.PLATFORM_BOT_TOKEN) return;
      const platformBot = new TelegramClient(env.PLATFORM_BOT_TOKEN, env.TELEGRAM_API_BASE);
      const ids = new Set([...parseAdminIds(env.PLATFORM_ADMIN_IDS), ...(await platformSettings.claimedAdmins())]);
      await Promise.all([...ids].map((chatId) => platformBot.sendMessage(chatId, text).catch((err) => console.error('platform alert', err))));
    },
    cart: new CartService(orders, products, settings),
    orderService: new OrderService(orders),
    files: env.FILES ? new FileStore(env.FILES, tg, publicOrigin) : null,
    /** Admins that can't be removed from the bot (shop owner, ADMIN_CHAT_IDS); /claim-ed ones are added per update. */
    envAdminIds: fixedAdmins,
    adminIds: fixedAdmins,
    /** What customers are asked for at checkout (admin settings). */
    checkoutFields: async (): Promise<CheckoutField[]> => parseCheckoutFields(await settings.raw('checkout_fields')),
    /** `/claim <code>` makes the sender an extra admin of this shop. */
    claimCode: shop.claimCode,
    /** Finds the shopper's row, creating it on first contact. */
    async user(ctx: { chatId: number; firstName: string; username: string }): Promise<UserRow> {
      return (await users.findByChatId(ctx.chatId)) ?? users.upsert(ctx.chatId, ctx.firstName, ctx.username);
    },
  };
}

export type Deps = ReturnType<typeof createDeps>;

export const parseAdminIds = (raw: string | undefined): number[] =>
  (raw ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isSafeInteger(n) && n !== 0);

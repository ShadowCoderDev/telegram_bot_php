import {
  CategoryRepository,
  DialogRepository,
  FaqRepository,
  OrderRepository,
  ProductRepository,
  SessionRepository,
  SettingsRepository,
  UpdateLogRepository,
  UserRepository,
} from './db/repositories';
import type { UserRow } from './db/models';
import type { Env } from './env';
import { CartService } from './services/CartService';
import { FileStore } from './services/FileStore';
import { OrderService } from './services/OrderService';
import { TelegramClient } from './telegram/TelegramClient';

/**
 * Composition root: builds every object once per request and hands them to handlers.
 * Nothing below this layer reads `env` or globals, so each piece can be tested with fakes.
 */
export function createDeps(env: Env, publicOrigin: string) {
  const tg = new TelegramClient(env.BOT_TOKEN, env.TELEGRAM_API_BASE);
  const users = new UserRepository(env.DB);
  const orders = new OrderRepository(env.DB);
  const products = new ProductRepository(env.DB);
  return {
    tg,
    users,
    orders,
    products,
    categories: new CategoryRepository(env.DB),
    faqs: new FaqRepository(env.DB),
    settings: new SettingsRepository(env.DB),
    sessions: new SessionRepository(env.DB),
    dialogs: new DialogRepository(env.DB),
    updateLog: new UpdateLogRepository(env.DB),
    floodLimit: Number(env.FLOOD_LIMIT) || 30,
    cart: new CartService(orders, products),
    orderService: new OrderService(orders),
    files: env.FILES ? new FileStore(env.FILES, tg, publicOrigin) : null,
    adminIds: parseAdminIds(env.ADMIN_CHAT_IDS),
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

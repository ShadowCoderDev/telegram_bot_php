import type { Order, OrderLine, Product, UserRow } from '../db/models';
import type { OrderRepository, ProductRepository, SettingsRepository } from '../db/repositories';
import { generateTrackId } from '../utils/trackId';

export const MAX_QTY = 99;
/** 1 … min(99, stock). `max` is the stock left; with no stock the result is still 1 (nothing is sold anyway). */
export const clampQty = (n: number, max = MAX_QTY): number => Math.max(1, Math.min(MAX_QTY, max, Math.trunc(n) || 1));

export type AddResult =
  | { ok: true; qty: number }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'no_stock'; product: Product; inCart: number };

export interface StockProblem {
  title: string;
  inventory: number;
  /** False when the product was disabled (or its category was) after it went into the cart. */
  available: boolean;
}

export class CartService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly products: ProductRepository,
    private readonly settings: SettingsRepository,
  ) {}

  /** The user's open (pending) order, created on demand. */
  async openCart(user: UserRow): Promise<Order> {
    const existing = await this.orders.findPendingForUser(user.id);
    if (existing) return existing;
    const prefix = await this.settings.get('track_prefix');
    for (let attempt = 0; ; attempt++) {
      try {
        const id = await this.orders.create(user.id, user.chat_id, generateTrackId(5, prefix));
        return (await this.orders.find(id))!;
      } catch (err) {
        // Track-id collision on the UNIQUE index: try another one.
        if (attempt >= 4 || !String(err).includes('UNIQUE')) throw err;
      }
    }
  }

  async add(user: UserRow, productId: number, qty: number): Promise<AddResult> {
    const product = await this.products.findVisible(productId);
    if (!product) return { ok: false, reason: 'not_found' };
    const cart = await this.openCart(user);
    const inCart = await this.orders.quantityInCart(cart.id, productId);
    if (product.inventory < inCart + qty) return { ok: false, reason: 'no_stock', product, inCart };
    await this.orders.addItem(cart.id, productId, qty);
    return { ok: true, qty };
  }

  async contents(user: UserRow): Promise<{ order: Order; lines: OrderLine[] } | null> {
    const order = await this.orders.findPendingForUser(user.id);
    if (!order) return null;
    const lines = await this.orders.lines(order.id);
    return lines.length ? { order, lines } : null;
  }

  async removeItem(user: UserRow, itemId: number): Promise<boolean> {
    const order = await this.orders.findPendingForUser(user.id);
    return order ? this.orders.removeItem(order.id, itemId) : false;
  }

  async clear(user: UserRow): Promise<void> {
    const order = await this.orders.findPendingForUser(user.id);
    if (order) await this.orders.setStatus(order.id, 'cancel');
  }
}

export const cartTotal = (lines: Pick<OrderLine, 'price' | 'quantity'>[]): number =>
  lines.reduce((sum, l) => sum + l.price * l.quantity, 0);

export const stockProblems = (lines: OrderLine[]): StockProblem[] =>
  lines
    .filter((l) => !l.available || l.inventory < l.quantity)
    .map(({ title, inventory, available }) => ({ title, inventory, available: Boolean(available) }));

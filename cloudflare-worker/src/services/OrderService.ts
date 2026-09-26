import type { Order, OrderDetails, OrderLine } from '../db/models';
import type { OrderRepository } from '../db/repositories';
import { planTransition, type AdminOrderAction } from './orderStatus';

export interface FullOrder {
  order: Order;
  details: OrderDetails | null;
  lines: OrderLine[];
}

export type ActionResult =
  | { ok: true; order: FullOrder }
  | { ok: false; reason: 'not_found' | 'invalid_transition' }
  | { ok: false; reason: 'no_stock'; problems: OrderLine[] };

export class OrderService {
  constructor(private readonly orders: OrderRepository) {}

  async load(orderId: number): Promise<FullOrder | null> {
    const order = await this.orders.find(orderId);
    if (!order) return null;
    const [details, lines] = await Promise.all([this.orders.details(orderId), this.orders.lines(orderId)]);
    return { order, details, lines };
  }

  async apply(orderId: number, action: AdminOrderAction): Promise<ActionResult> {
    const full = await this.load(orderId);
    if (!full) return { ok: false, reason: 'not_found' };
    const plan = planTransition(full.order, action);
    if (!plan) return { ok: false, reason: 'invalid_transition' };

    if (plan.stock === 'take') {
      // Friendly pre-check; the CHECK constraint is the real guard against races.
      const problems = full.lines.filter((l) => l.inventory < l.quantity);
      if (problems.length) return { ok: false, reason: 'no_stock', problems };
    }
    try {
      await this.orders.changeStatusWithStock(orderId, plan.status, plan.stock);
    } catch (err) {
      if (String(err).includes('CHECK constraint')) {
        const fresh = await this.orders.lines(orderId);
        return { ok: false, reason: 'no_stock', problems: fresh.filter((l) => l.inventory < l.quantity) };
      }
      throw err;
    }
    return { ok: true, order: (await this.load(orderId))! };
  }
}

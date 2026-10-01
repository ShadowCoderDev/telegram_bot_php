import type { Order, OrderDetails, OrderLine } from '../db/models';
import type { OrderRepository } from '../db/repositories';
import type { OrderSlotInfo, ScheduleRepository } from '../db/schedule';
import { planTransition, type AdminOrderAction } from './orderStatus';

export interface FullOrder {
  order: Order;
  details: OrderDetails | null;
  lines: OrderLine[];
  /** The day and time the customer picked, for categories that are scheduled. */
  slots: OrderSlotInfo[];
}

export type ActionResult =
  | { ok: true; order: FullOrder }
  | { ok: false; reason: 'not_found' | 'invalid_transition' | 'already_changed' }
  | { ok: false; reason: 'no_stock'; problems: OrderLine[] };

export class OrderService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly schedules: ScheduleRepository,
  ) {}

  async load(orderId: number): Promise<FullOrder | null> {
    const order = await this.orders.find(orderId);
    if (!order) return null;
    const [details, lines, slots] = await Promise.all([this.orders.details(orderId), this.orders.lines(orderId), this.schedules.forOrder(orderId)]);
    return { order, details, lines, slots };
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
      const changed = await this.orders.changeStatusWithStock(orderId, full.order.status, plan.status, plan.stock);
      // Someone else changed the order between our read and write (double click, second admin).
      if (!changed) return { ok: false, reason: 'already_changed' };
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

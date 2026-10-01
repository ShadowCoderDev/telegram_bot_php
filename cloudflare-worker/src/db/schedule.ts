import type { OrderStatus } from './models';
import { Repository, SettingsRepository } from './repositories';
import { parseClosedDays, toggleClosedDay, type Schedule } from '../services/schedule';

/** A schedule with the name of the category it belongs to. */
export interface ScheduledCategory extends Schedule {
  name: string;
  icon: string;
}

/** The slot an order picked, for showing on cards and messages. */
export interface OrderSlotInfo {
  order_id: number;
  category_id: number;
  category_name: string;
  category_icon: string;
  /** What the seller calls this time: "زمان نوبت", "زمان تحویل"… */
  label: string;
  slot_at: number;
}

export interface AgendaEntry {
  slot_at: number;
  order_id: number;
  track_id: string;
  status: OrderStatus;
  category_name: string;
  category_icon: string;
  customer: string;
  phone: string;
}

export type ScheduleField = 'enabled' | 'label' | 'days' | 'times' | 'capacity' | 'lead_minutes' | 'horizon_days';
const FIELDS: readonly ScheduleField[] = ['enabled', 'label', 'days', 'times', 'capacity', 'lead_minutes', 'horizon_days'];

/** Orders that take a slot for good (a pending order only holds it for a while). */
const TAKEN_STATUS = "('payed','approved','sending')";
/** Scheduling is a switch for the whole shop: nothing below applies while it is off. */
const MASTER_ON = "EXISTS (SELECT 1 FROM settings WHERE shop_id = ?1 AND setting_key = 'scheduling_enabled' AND setting_value = '1')";
/** Slots counted as taken: paid orders, and pending orders whose hold has not run out. */
const COUNTED = `(o.status IN ${TAKEN_STATUS} OR (o.status = 'pending' AND s.hold_until > ?NOW))`;

/**
 * Per-category order scheduling: the schedules, the shop's closed days, and the slots orders have
 * picked. A slot is reserved with one guarded INSERT, so two customers can't both take the last place.
 */
export class ScheduleRepository extends Repository {
  private readonly settings = new SettingsRepository(this.db, this.shopId);

  async isEnabled(): Promise<boolean> {
    return (await this.settings.raw('scheduling_enabled')) === '1';
  }
  setEnabled(on: boolean) {
    return this.settings.set('scheduling_enabled', on ? '1' : '0');
  }

  /* ----- schedules ----- */

  find(categoryId: number) {
    return this.first<Schedule>('SELECT * FROM category_schedules WHERE shop_id = ?1 AND category_id = ?2', categoryId);
  }

  /** The schedule that applies to customers now: scheduling on, this schedule on. */
  active(categoryId: number) {
    return this.first<ScheduledCategory>(
      `SELECT cs.category_id, cs.enabled, cs.label, cs.days, cs.times, cs.capacity, cs.lead_minutes, cs.horizon_days, c.name, c.icon
         FROM category_schedules cs JOIN categories c ON c.shop_id = cs.shop_id AND c.id = cs.category_id
        WHERE cs.shop_id = ?1 AND cs.category_id = ?2 AND cs.enabled = 1 AND cs.times != '' AND ${MASTER_ON}`,
      categoryId,
    );
  }

  /** Every category with its schedule (null when it has none). */
  async list(): Promise<{ category_id: number; name: string; icon: string; schedule: Schedule | null }[]> {
    const rows = await this.all<Schedule & { name: string; icon: string; configured: number }>(
      `SELECT c.id AS category_id, c.name, c.icon, cs.category_id IS NOT NULL AS configured,
              cs.enabled, cs.label, cs.days, cs.times, cs.capacity, cs.lead_minutes, cs.horizon_days
         FROM categories c LEFT JOIN category_schedules cs ON cs.shop_id = c.shop_id AND cs.category_id = c.id
        WHERE c.shop_id = ?1 ORDER BY c.id`,
    );
    return rows.map(({ name, icon, configured, ...schedule }) => ({ category_id: schedule.category_id, name, icon, schedule: configured ? schedule : null }));
  }

  /** Creates or replaces a category's schedule; false when the category isn't this shop's. */
  async save(categoryId: number, s: Omit<Schedule, 'category_id'>): Promise<boolean> {
    const r = await this.run(
      `INSERT INTO category_schedules (shop_id, category_id, enabled, label, days, times, capacity, lead_minutes, horizon_days)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9 WHERE EXISTS (SELECT 1 FROM categories WHERE shop_id = ?1 AND id = ?2)
       ON CONFLICT (shop_id, category_id) DO UPDATE SET enabled = excluded.enabled, label = excluded.label, days = excluded.days,
         times = excluded.times, capacity = excluded.capacity, lead_minutes = excluded.lead_minutes, horizon_days = excluded.horizon_days`,
      categoryId, s.enabled, s.label, s.days, s.times, s.capacity, s.lead_minutes, s.horizon_days,
    );
    return r.meta.changes > 0;
  }

  /** `field` is checked against a whitelist, so using it as a column name is safe. */
  update(categoryId: number, field: ScheduleField, value: string | number) {
    if (!FIELDS.includes(field)) throw new Error(`bad schedule field ${field}`);
    return this.run(`UPDATE category_schedules SET ${field} = ?2 WHERE shop_id = ?1 AND category_id = ?3`, value, categoryId);
  }

  remove(categoryId: number) {
    return this.run('DELETE FROM category_schedules WHERE shop_id = ?1 AND category_id = ?2', categoryId);
  }

  /** The schedules an order has to pick a slot for: one per scheduled category among its products. */
  requiredFor(orderId: number) {
    return this.all<ScheduledCategory>(
      `SELECT cs.category_id, cs.enabled, cs.label, cs.days, cs.times, cs.capacity, cs.lead_minutes, cs.horizon_days, c.name, c.icon
         FROM category_schedules cs JOIN categories c ON c.shop_id = cs.shop_id AND c.id = cs.category_id
        WHERE cs.shop_id = ?1 AND cs.enabled = 1 AND cs.times != '' AND ${MASTER_ON}
          AND cs.category_id IN (SELECT p.category_id FROM order_items oi JOIN products p ON p.id = oi.product_id AND p.shop_id = ?1
                                  WHERE oi.shop_id = ?1 AND oi.order_id = ?2)
        ORDER BY cs.category_id`,
      orderId,
    );
  }

  /* ----- closed days (shop-wide) ----- */

  async closedDays(today: number): Promise<Set<number>> {
    return parseClosedDays(await this.settings.raw('closed_days'), today);
  }
  async toggleClosed(day: number, today: number): Promise<Set<number>> {
    const value = toggleClosedDay(await this.settings.raw('closed_days'), day, today);
    await this.settings.set('closed_days', value);
    return parseClosedDays(value, today);
  }

  /* ----- slots ----- */

  /** Orders in each slot of a category within [from, to) – not counting `exceptOrderId` (the customer choosing). */
  async taken(categoryId: number, from: number, to: number, now: number, exceptOrderId = 0): Promise<Map<number, number>> {
    const rows = await this.all<{ at: number; n: number }>(
      `SELECT s.slot_at AS at, count(*) AS n FROM order_slots s JOIN orders o ON o.id = s.order_id AND o.shop_id = ?1
        WHERE s.shop_id = ?1 AND s.category_id = ?2 AND s.slot_at >= ?3 AND s.slot_at < ?4 AND s.order_id != ?6
          AND ${COUNTED.replace('?NOW', '?5')}
        GROUP BY s.slot_at`,
      categoryId, from, to, now, exceptOrderId,
    );
    return new Map(rows.map((r) => [r.at, r.n]));
  }

  /**
   * Gives the order a slot (replacing its earlier pick for the category) and holds it for
   * `holdSeconds`. Returns false when the slot is full – decided in the same statement that
   * inserts, inside one transaction, so the last place can't go to two orders.
   */
  async reserve(orderId: number, categoryId: number, at: number, capacity: number, now: number, holdSeconds: number): Promise<boolean> {
    const results = await this.db.batch([
      this.prepare('DELETE FROM order_slots WHERE shop_id = ?1 AND order_id = ?2 AND category_id = ?3', orderId, categoryId),
      // Holds that ran out stop counting; forget them so the table doesn't collect abandoned checkouts.
      this.prepare(
        `DELETE FROM order_slots WHERE shop_id = ?1 AND category_id = ?2 AND slot_at = ?3 AND hold_until < ?4
            AND order_id IN (SELECT id FROM orders WHERE shop_id = ?1 AND status = 'pending')`,
        categoryId, at, now,
      ),
      this.prepare(
        `INSERT INTO order_slots (shop_id, order_id, category_id, slot_at, hold_until)
         SELECT ?1, ?2, ?3, ?4, ?5
          WHERE EXISTS (SELECT 1 FROM orders WHERE shop_id = ?1 AND id = ?2 AND status = 'pending')
            AND (?6 = 0 OR (SELECT count(*) FROM order_slots s JOIN orders o ON o.id = s.order_id AND o.shop_id = ?1
                             WHERE s.shop_id = ?1 AND s.category_id = ?3 AND s.slot_at = ?4 AND ${COUNTED.replace('?NOW', '?7')}) < ?6)`,
        orderId, categoryId, at, now + holdSeconds, capacity, now,
      ),
    ]);
    return results.at(-1)!.meta.changes > 0;
  }

  /** Frees what a pending order was holding (checkout cancelled or restarted). */
  release(orderId: number) {
    return this.run("DELETE FROM order_slots WHERE shop_id = ?1 AND order_id = ?2 AND order_id IN (SELECT id FROM orders WHERE shop_id = ?1 AND status = 'pending')", orderId);
  }

  /** The order's slots as they are now, oldest pick first. */
  slotsOf(orderId: number) {
    return this.all<{ category_id: number; slot_at: number; hold_until: number }>(
      'SELECT category_id, slot_at, hold_until FROM order_slots WHERE shop_id = ?1 AND order_id = ?2 ORDER BY category_id',
      orderId,
    );
  }

  /**
   * Checks the order still holds `needed` slots and keeps them for `extendTo`. One statement: a hold
   * that is valid now can't run out between the check and the extension.
   */
  async stillHeld(orderId: number, needed: number, now: number, extendTo: number): Promise<boolean> {
    const r = await this.run(
      'UPDATE order_slots SET hold_until = MAX(hold_until, ?3) WHERE shop_id = ?1 AND order_id = ?2 AND hold_until >= ?4',
      orderId, extendTo, now,
    );
    return r.meta.changes >= needed;
  }

  /** Slots of several orders, for cards and messages. */
  async forOrders(orderIds: number[]): Promise<Map<number, OrderSlotInfo[]>> {
    const out = new Map<number, OrderSlotInfo[]>();
    if (!orderIds.length) return out;
    const rows = await this.all<OrderSlotInfo>(
      `SELECT s.order_id, s.category_id, s.slot_at, COALESCE(c.name, '') AS category_name, COALESCE(c.icon, '') AS category_icon,
              COALESCE(cs.label, 'زمان') AS label
         FROM order_slots s
         LEFT JOIN categories c ON c.shop_id = s.shop_id AND c.id = s.category_id
         LEFT JOIN category_schedules cs ON cs.shop_id = s.shop_id AND cs.category_id = s.category_id
        WHERE s.shop_id = ?1 AND s.order_id IN (${orderIds.map((_, i) => `?${i + 2}`).join(',')}) ORDER BY s.order_id, s.slot_at`,
      ...orderIds,
    );
    for (const r of rows) out.set(r.order_id, [...(out.get(r.order_id) ?? []), r]);
    return out;
  }
  async forOrder(orderId: number): Promise<OrderSlotInfo[]> {
    return (await this.forOrders([orderId])).get(orderId) ?? [];
  }

  /** Paid bookings in [from, to), earliest first – the seller's agenda. */
  agenda(from: number, to: number, limit = 60) {
    return this.all<AgendaEntry>(
      `SELECT s.slot_at, o.id AS order_id, o.track_id, o.status, COALESCE(c.name, '') AS category_name, COALESCE(c.icon, '') AS category_icon,
              COALESCE(NULLIF(trim(od.first_name || ' ' || od.last_name), ''), u.name, '') AS customer, COALESCE(od.phone_number, '') AS phone
         FROM order_slots s
         JOIN orders o ON o.id = s.order_id AND o.shop_id = ?1
         LEFT JOIN categories c ON c.shop_id = s.shop_id AND c.id = s.category_id
         LEFT JOIN users u ON u.id = o.user_id
         LEFT JOIN order_details od ON od.order_id = o.id
        WHERE s.shop_id = ?1 AND s.slot_at >= ?2 AND s.slot_at < ?3 AND o.status IN ${TAKEN_STATUS}
        ORDER BY s.slot_at, o.id LIMIT ?4`,
      from, to, limit,
    );
  }
}

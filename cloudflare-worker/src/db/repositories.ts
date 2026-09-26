import type { Category, CategoryWithCount, CustomerSummary, Dialog, Faq, Order, OrderDetails, OrderLine, OrderStatus, Product, Session, Toggle, UserRow } from './models';

/*
 * One small class per aggregate. Every query is a prepared statement with bound parameters.
 *
 * Multi-tenant rule: every repository belongs to one shop, and every query receives that shop's id
 * as parameter ?1 (other parameters are ?2, ?3, …). `prepare` refuses SQL that doesn't use ?1, so a
 * query that forgets the shop filter fails loudly in tests instead of leaking another shop's data.
 */

abstract class Repository {
  constructor(
    protected readonly db: D1Database,
    readonly shopId: number,
  ) {}
  protected prepare(sql: string, ...args: unknown[]): D1PreparedStatement {
    if (!/\?1(?!\d)/.test(sql)) throw new Error(`Query is not scoped to a shop: ${sql}`);
    return this.db.prepare(sql).bind(this.shopId, ...args);
  }
  protected all<T>(sql: string, ...args: unknown[]): Promise<T[]> {
    return this.prepare(sql, ...args).all<T>().then((r) => r.results);
  }
  protected first<T>(sql: string, ...args: unknown[]): Promise<T | null> {
    return this.prepare(sql, ...args).first<T>();
  }
  protected run(sql: string, ...args: unknown[]): Promise<D1Result> {
    return this.prepare(sql, ...args).run();
  }
}

const CUSTOMER_STATS = `
  (SELECT count(*) FROM orders o WHERE o.shop_id = ?1 AND o.user_id = u.id AND o.status NOT IN ('pending', 'cancel')) AS orders_count,
  (SELECT COALESCE(SUM(oi.price * oi.quantity), 0) FROM orders o JOIN order_items oi ON oi.order_id = o.id
     WHERE o.shop_id = ?1 AND o.user_id = u.id AND o.status IN ('approved', 'sending')) AS total_spent,
  (SELECT count(*) FROM orders o WHERE o.shop_id = ?1 AND o.user_id = u.id AND o.status = 'payed') AS awaiting_review,
  COALESCE((SELECT MAX(o.time) FROM orders o WHERE o.shop_id = ?1 AND o.user_id = u.id AND o.status NOT IN ('pending', 'cancel')), u.created_at) AS last_activity`;

/** Escapes LIKE wildcards so a search for "50%" matches literally. */
const likeTerm = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export class UserRepository extends Repository {
  findByChatId(chatId: number) {
    return this.first<UserRow>('SELECT * FROM users WHERE shop_id = ?1 AND chat_id = ?2', chatId);
  }
  find(id: number) {
    return this.first<UserRow>('SELECT * FROM users WHERE shop_id = ?1 AND id = ?2', id);
  }
  /** Insert-or-refresh; returns the row. */
  async upsert(chatId: number, name: string, username = ''): Promise<UserRow> {
    await this.run(
      `INSERT INTO users (shop_id, chat_id, name, username) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(shop_id, chat_id) DO UPDATE SET name = excluded.name, username = excluded.username`,
      chatId,
      name,
      username,
    );
    return (await this.findByChatId(chatId))!;
  }
  setStatus(id: number, status: Toggle) {
    return this.run('UPDATE users SET status = ?2 WHERE shop_id = ?1 AND id = ?3', status, id);
  }
  customer(id: number) {
    return this.first<CustomerSummary>(`SELECT u.*, ${CUSTOMER_STATS} FROM users u WHERE u.shop_id = ?1 AND u.id = ?2`, id);
  }
  /** Customers, most recently active first. */
  customersPage(limit: number, offset: number) {
    return this.all<CustomerSummary>(
      `SELECT u.*, ${CUSTOMER_STATS} FROM users u WHERE u.shop_id = ?1 ORDER BY last_activity DESC, u.id DESC LIMIT ?2 OFFSET ?3`,
      limit,
      offset,
    );
  }
  /** Finds customers by name, @username, chat id, phone number or order tracking code. */
  searchCustomers(query: string, limit = 20) {
    const q = query.trim().replace(/^@/, '');
    const numeric = /^\d+$/.test(q) ? Number(q) : -1;
    return this.all<CustomerSummary>(
      `SELECT u.*, ${CUSTOMER_STATS} FROM users u
        WHERE u.shop_id = ?1
          AND (u.name LIKE ?2 ESCAPE '\\' OR u.username LIKE ?2 ESCAPE '\\' OR u.chat_id = ?3
               OR EXISTS (SELECT 1 FROM orders o LEFT JOIN order_details od ON od.order_id = o.id
                           WHERE o.shop_id = ?1 AND o.user_id = u.id AND (o.track_id = ?4 COLLATE NOCASE OR od.phone_number LIKE ?2 ESCAPE '\\')))
        ORDER BY last_activity DESC LIMIT ?5`,
      likeTerm(q),
      numeric,
      q,
      limit,
    );
  }
  /** Latest shipping details the customer entered, for the customer page. */
  lastContact(userId: number) {
    return this.first<{ phone_number: string; address: string }>(
      `SELECT od.phone_number, od.address FROM order_details od JOIN orders o ON o.id = od.order_id
        WHERE o.shop_id = ?1 AND o.user_id = ?2 ORDER BY o.id DESC LIMIT 1`,
      userId,
    );
  }
  async count(): Promise<number> {
    return (await this.first<{ n: number }>('SELECT count(*) AS n FROM users WHERE shop_id = ?1'))!.n;
  }
}

export class CategoryRepository extends Repository {
  list(onlyEnabled: boolean) {
    return onlyEnabled
      ? this.all<Category>("SELECT * FROM categories WHERE shop_id = ?1 AND status = 'enable' ORDER BY id")
      : this.all<Category>('SELECT * FROM categories WHERE shop_id = ?1 ORDER BY id DESC');
  }
  find(id: number) {
    return this.first<Category>('SELECT * FROM categories WHERE shop_id = ?1 AND id = ?2', id);
  }
  /** All categories with how many products each holds, for the admin. */
  listWithCounts() {
    return this.all<CategoryWithCount>(
      `SELECT c.*, (SELECT count(*) FROM products p WHERE p.shop_id = ?1 AND p.category_id = c.id) AS product_count
         FROM categories c WHERE c.shop_id = ?1 ORDER BY c.id`,
    );
  }
  findWithCount(id: number) {
    return this.first<CategoryWithCount>(
      `SELECT c.*, (SELECT count(*) FROM products p WHERE p.shop_id = ?1 AND p.category_id = c.id) AS product_count
         FROM categories c WHERE c.shop_id = ?1 AND c.id = ?2`,
      id,
    );
  }
  rename(id: number, name: string) {
    return this.run('UPDATE categories SET name = ?2 WHERE shop_id = ?1 AND id = ?3', name, id);
  }
  setIcon(id: number, icon: string) {
    return this.run('UPDATE categories SET icon = ?2 WHERE shop_id = ?1 AND id = ?3', icon, id);
  }
  async create(name: string, icon: string): Promise<number> {
    const r = await this.run('INSERT INTO categories (shop_id, name, icon) VALUES (?1, ?2, ?3)', name, icon);
    return r.meta.last_row_id;
  }
  setStatus(id: number, status: Toggle) {
    return this.run('UPDATE categories SET status = ?2 WHERE shop_id = ?1 AND id = ?3', status, id);
  }
  /** Deletes only an empty category; returns false when it still has products. */
  async deleteIfEmpty(id: number): Promise<boolean> {
    const r = await this.run(
      'DELETE FROM categories WHERE shop_id = ?1 AND id = ?2 AND NOT EXISTS (SELECT 1 FROM products WHERE shop_id = ?1 AND category_id = ?2)',
      id,
    );
    return r.meta.changes > 0;
  }
  async count(): Promise<number> {
    return (await this.first<{ n: number }>('SELECT count(*) AS n FROM categories WHERE shop_id = ?1'))!.n;
  }
}

export type ProductDraft = Omit<Product, 'id' | 'status'>;

const VISIBLE_JOIN = 'LEFT JOIN categories c ON c.id = p.category_id AND c.shop_id = ?1';
const VISIBLE = "p.status = 'enable' AND (p.category_id IS NULL OR c.status = 'enable')";
/** A product image is either an uploaded photo or a link; setting one clears the other. */
export type ProductImage = Pick<Product, 'image_url' | 'image_file_id'>;
export const EDITABLE_PRODUCT_FIELDS = ['title', 'description', 'price', 'author', 'image_url', 'inventory'] as const;
export type EditableProductField = (typeof EDITABLE_PRODUCT_FIELDS)[number];

export class ProductRepository extends Repository {
  find(id: number) {
    return this.first<Product>('SELECT * FROM products WHERE shop_id = ?1 AND id = ?2', id);
  }
  /** A product customers may see and buy: enabled, in an enabled category (or none). */
  findVisible(id: number) {
    return this.first<Product>(`SELECT p.* FROM products p ${VISIBLE_JOIN} WHERE p.shop_id = ?1 AND p.id = ?2 AND ${VISIBLE}`, id);
  }
  listByCategory(categoryId: number) {
    return this.all<Product>(
      `SELECT p.* FROM products p ${VISIBLE_JOIN} WHERE p.shop_id = ?1 AND p.category_id = ?2 AND ${VISIBLE} ORDER BY p.id`,
      categoryId,
    );
  }
  listPage(limit: number, offset: number) {
    return this.all<Product>('SELECT * FROM products WHERE shop_id = ?1 ORDER BY id DESC LIMIT ?2 OFFSET ?3', limit, offset);
  }
  /** The category must belong to this shop; otherwise nothing is inserted and null is returned. */
  async create(p: ProductDraft): Promise<number | null> {
    const r = await this.run(
      `INSERT INTO products (shop_id, category_id, title, description, price, author, image_url, image_file_id, inventory)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
        WHERE ?2 IS NULL OR EXISTS (SELECT 1 FROM categories WHERE shop_id = ?1 AND id = ?2)`,
      p.category_id, p.title, p.description, p.price, p.author, p.image_url ?? '', p.image_file_id ?? '', p.inventory,
    );
    return r.meta.changes ? r.meta.last_row_id : null;
  }
  /** `field` is checked against a whitelist, so interpolating the column name is safe. */
  update(id: number, field: EditableProductField | 'status', value: string | number) {
    if (![...EDITABLE_PRODUCT_FIELDS, 'status'].includes(field)) throw new Error(`bad field ${field}`);
    return this.run(`UPDATE products SET ${field} = ?2 WHERE shop_id = ?1 AND id = ?3`, value, id);
  }
  /** Moves a product to another category of the same shop. */
  async setCategory(id: number, categoryId: number): Promise<boolean> {
    const r = await this.run(
      'UPDATE products SET category_id = ?2 WHERE shop_id = ?1 AND id = ?3 AND EXISTS (SELECT 1 FROM categories WHERE shop_id = ?1 AND id = ?2)',
      categoryId,
      id,
    );
    return r.meta.changes > 0;
  }
  setImage(id: number, image: ProductImage) {
    return this.run('UPDATE products SET image_url = ?2, image_file_id = ?3 WHERE shop_id = ?1 AND id = ?4', image.image_url, image.image_file_id, id);
  }
  async count(): Promise<number> {
    return (await this.first<{ n: number }>('SELECT count(*) AS n FROM products WHERE shop_id = ?1'))!.n;
  }
}

const PLACED = "shop_id = ?1 AND status NOT IN ('pending', 'cancel')";

export class OrderRepository extends Repository {
  find(id: number) {
    return this.first<Order>('SELECT * FROM orders WHERE shop_id = ?1 AND id = ?2', id);
  }
  findPendingForUser(userId: number) {
    return this.first<Order>("SELECT * FROM orders WHERE shop_id = ?1 AND user_id = ?2 AND status = 'pending' ORDER BY id DESC", userId);
  }
  async create(userId: number, chatId: number, trackId: string): Promise<number> {
    const r = await this.run('INSERT INTO orders (shop_id, user_id, user_chat_id, track_id) VALUES (?1, ?2, ?3, ?4)', userId, chatId, trackId);
    return r.meta.last_row_id;
  }
  setStatus(id: number, status: OrderStatus) {
    return this.run('UPDATE orders SET status = ?2 WHERE shop_id = ?1 AND id = ?3', status, id);
  }
  /** Placed orders only: open carts ('pending') and emptied carts ('cancel') are not orders. */
  recentForUser(userId: number, limit = 5) {
    return this.all<Order>(`SELECT * FROM orders WHERE ${PLACED} AND user_id = ?2 ORDER BY id DESC LIMIT ?3`, userId, limit);
  }
  placedPage(limit: number, offset: number, userId?: number) {
    return userId === undefined
      ? this.all<Order>(`SELECT * FROM orders WHERE ${PLACED} ORDER BY id DESC LIMIT ?2 OFFSET ?3`, limit, offset)
      : this.all<Order>(`SELECT * FROM orders WHERE ${PLACED} AND user_id = ?2 ORDER BY id DESC LIMIT ?3 OFFSET ?4`, userId, limit, offset);
  }
  async countPlaced(userId?: number): Promise<number> {
    const r =
      userId === undefined
        ? await this.first<{ n: number }>(`SELECT count(*) AS n FROM orders WHERE ${PLACED}`)
        : await this.first<{ n: number }>(`SELECT count(*) AS n FROM orders WHERE ${PLACED} AND user_id = ?2`, userId);
    return r!.n;
  }
  /** All paid orders waiting for an admin – shown as a badge in the admin panel. */
  async countAllAwaitingReview(): Promise<number> {
    return (await this.first<{ n: number }>("SELECT count(*) AS n FROM orders WHERE shop_id = ?1 AND status = 'payed'"))!.n;
  }
  /** Paid orders still waiting for an admin – capped per customer to stop receipt spam. */
  async countAwaitingReview(userId: number): Promise<number> {
    return (await this.first<{ n: number }>("SELECT count(*) AS n FROM orders WHERE shop_id = ?1 AND user_id = ?2 AND status = 'payed'", userId))!.n;
  }
  /** The order a receipt photo was already used for, if any. */
  async orderUsingReceipt(uniqueId: string): Promise<number | null> {
    const r = await this.first<{ order_id: number }>('SELECT order_id FROM order_details WHERE shop_id = ?1 AND receipt_unique_id = ?2', uniqueId);
    return r?.order_id ?? null;
  }

  /**
   * Price lock: copies the current price/title into every line of an open cart. Done when the
   * customer is shown the amount to pay, so the amount they pay is the amount the order records.
   */
  lockPrices(orderId: number) {
    return this.run(
      `UPDATE order_items SET
         price         = (SELECT price FROM products WHERE products.id = order_items.product_id),
         product_title = (SELECT title FROM products WHERE products.id = order_items.product_id)
       WHERE shop_id = ?1 AND order_id = ?2 AND order_id IN (SELECT id FROM orders WHERE shop_id = ?1 AND status = 'pending')`,
      orderId,
    );
  }
  /** Releases a lock (checkout abandoned or cart changed) so the cart follows live prices again. */
  unlockPrices(orderId: number) {
    return this.run(
      `UPDATE order_items SET price = NULL, product_title = NULL
       WHERE shop_id = ?1 AND order_id = ?2 AND order_id IN (SELECT id FROM orders WHERE shop_id = ?1 AND status = 'pending')`,
      orderId,
    );
  }
  /** Sum of the locked lines, plus how many lines are not locked (0 means the whole cart is locked). */
  async lockedTotal(orderId: number): Promise<{ total: number; unlocked: number; lines: number }> {
    const r = await this.first<{ total: number; unlocked: number | null; lines: number }>(
      'SELECT COALESCE(SUM(price * quantity), 0) AS total, SUM(price IS NULL) AS unlocked, COUNT(*) AS lines FROM order_items WHERE shop_id = ?1 AND order_id = ?2',
      orderId,
    );
    return { total: r!.total, unlocked: r!.unlocked ?? 0, lines: r!.lines };
  }

  /** Lines of an order. Unlocked lines show the live product price/title; locked or paid lines the snapshot. */
  lines(orderId: number) {
    return this.all<OrderLine>(
      `SELECT oi.id AS item_id, oi.product_id, oi.quantity,
              COALESCE(oi.product_title, p.title) AS title,
              COALESCE(oi.price, p.price)         AS price,
              COALESCE(p.inventory, 0)            AS inventory,
              COALESCE(${VISIBLE}, 0)            AS available
         FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id AND p.shop_id = ?1 ${VISIBLE_JOIN}
        WHERE oi.shop_id = ?1 AND oi.order_id = ?2 ORDER BY oi.id`,
      orderId,
    );
  }
  /** Lines for many orders in one round-trip (avoids N+1 on the "my orders" screen). */
  async linesFor(orderIds: number[]): Promise<Map<number, OrderLine[]>> {
    const out = new Map<number, OrderLine[]>();
    if (!orderIds.length) return out;
    const rows = await this.all<OrderLine & { order_id: number }>(
      `SELECT oi.order_id, oi.id AS item_id, oi.product_id, oi.quantity,
              COALESCE(oi.product_title, p.title) AS title, COALESCE(oi.price, p.price) AS price, 0 AS inventory, 1 AS available
         FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id AND p.shop_id = ?1
        WHERE oi.shop_id = ?1 AND oi.order_id IN (${orderIds.map((_, i) => `?${i + 2}`).join(',')}) ORDER BY oi.id`,
      ...orderIds,
    );
    for (const { order_id, ...line } of rows) out.set(order_id, [...(out.get(order_id) ?? []), line]);
    return out;
  }

  /** Adds qty to the cart line, creating it if needed. */
  addItem(orderId: number, productId: number, qty: number) {
    return this.run(
      `INSERT INTO order_items (shop_id, order_id, product_id, quantity) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(order_id, product_id) DO UPDATE SET quantity = quantity + excluded.quantity`,
      orderId, productId, qty,
    );
  }
  async quantityInCart(orderId: number, productId: number): Promise<number> {
    const r = await this.first<{ quantity: number }>(
      'SELECT quantity FROM order_items WHERE shop_id = ?1 AND order_id = ?2 AND product_id = ?3', orderId, productId,
    );
    return r?.quantity ?? 0;
  }
  async removeItem(orderId: number, itemId: number): Promise<boolean> {
    const r = await this.run('DELETE FROM order_items WHERE shop_id = ?1 AND id = ?2 AND order_id = ?3', itemId, orderId);
    return r.meta.changes > 0;
  }

  details(orderId: number) {
    return this.first<OrderDetails>('SELECT * FROM order_details WHERE shop_id = ?1 AND order_id = ?2', orderId);
  }

  /**
   * Payment submitted: store details and mark as payed – atomically. Lines are already price-locked;
   * the snapshot below only fills a line that somehow is not (it never overwrites a locked price).
   */
  async markPaid(d: OrderDetails): Promise<'ok' | 'not_pending' | 'receipt_reused'> {
    try {
      const results = await this.db.batch([
        this.prepare(
          `INSERT INTO order_details (shop_id, order_id, first_name, last_name, address, phone_number, receipt_file_id, receipt_r2_key, receipt_unique_id)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9 WHERE EXISTS (SELECT 1 FROM orders WHERE shop_id = ?1 AND id = ?2 AND status = 'pending')`,
          d.order_id, d.first_name, d.last_name, d.address, d.phone_number, d.receipt_file_id, d.receipt_r2_key, d.receipt_unique_id,
        ),
        this.prepare(
          `UPDATE order_items SET
             price         = (SELECT price FROM products WHERE products.id = order_items.product_id),
             product_title = (SELECT title FROM products WHERE products.id = order_items.product_id)
           WHERE shop_id = ?1 AND order_id = ?2 AND price IS NULL`,
          d.order_id,
        ),
        this.prepare("UPDATE orders SET status = 'payed' WHERE shop_id = ?1 AND id = ?2 AND status = 'pending'", d.order_id),
      ]);
      return results.at(-1)!.meta.changes > 0 ? 'ok' : 'not_pending';
    } catch (err) {
      // Same receipt photo as another order, or two photos at once (an album) racing for this order.
      if (/receipt_unique_id/.test(String(err))) return 'receipt_reused';
      if (/UNIQUE constraint failed: order_details\.order_id/.test(String(err))) return 'not_pending';
      throw err;
    }
  }

  /**
   * Moves the order from `from` to `to` and stock in or out for every line, in one transaction.
   * Taking stock that isn't there violates CHECK(inventory >= 0) and rolls everything back.
   */
  async changeStatusWithStock(orderId: number, from: OrderStatus, to: OrderStatus, stock: 'take' | 'return' | 'keep'): Promise<boolean> {
    // Every statement re-checks the order is still in `from`, so two admins (or a double click)
    // acting at once can't both move stock: the second batch changes nothing and returns false.
    const stmts: D1PreparedStatement[] = [];
    if (stock !== 'keep') {
      const sign = stock === 'take' ? '-' : '+';
      stmts.push(
        this.prepare(
          `UPDATE products SET inventory = inventory ${sign}
             (SELECT quantity FROM order_items WHERE shop_id = ?1 AND order_id = ?2 AND product_id = products.id)
           WHERE shop_id = ?1 AND id IN (SELECT product_id FROM order_items WHERE shop_id = ?1 AND order_id = ?2)
             AND EXISTS (SELECT 1 FROM orders WHERE shop_id = ?1 AND id = ?2 AND status = ?3 AND stock_taken = ?4)`,
          orderId, from, stock === 'take' ? 0 : 1,
        ),
      );
    }
    stmts.push(
      this.prepare(
        `UPDATE orders SET status = ?4,
           stock_taken = CASE ?5 WHEN 'take' THEN 1 WHEN 'return' THEN 0 ELSE stock_taken END
         WHERE shop_id = ?1 AND id = ?2 AND status = ?3`,
        orderId, from, to, stock,
      ),
    );
    const results = await this.db.batch(stmts);
    return results.at(-1)!.meta.changes > 0;
  }

  async stats(since: { day: number; month: number }) {
    const ok = "('payed','approved','sending')";
    const [completed, daily, monthly] = await Promise.all([
      this.first<{ n: number }>(`SELECT count(*) AS n FROM orders WHERE shop_id = ?1 AND status IN ${ok}`),
      this.first<{ s: number | null }>(
        `SELECT SUM(oi.price * oi.quantity) AS s FROM order_items oi JOIN orders o ON o.id = oi.order_id
          WHERE o.shop_id = ?1 AND o.status IN ${ok} AND o.time >= ?2`,
        since.day,
      ),
      this.first<{ s: number | null }>(
        `SELECT SUM(oi.price * oi.quantity) AS s FROM order_items oi JOIN orders o ON o.id = oi.order_id
          WHERE o.shop_id = ?1 AND o.status IN ${ok} AND o.time >= ?2`,
        since.month,
      ),
    ]);
    return { completed: completed!.n, daily: daily!.s ?? 0, monthly: monthly!.s ?? 0 };
  }
}

export class FaqRepository extends Repository {
  list(onlyEnabled: boolean) {
    return onlyEnabled
      ? this.all<Faq>("SELECT * FROM faqs WHERE shop_id = ?1 AND status = 'enable' ORDER BY id")
      : this.all<Faq>('SELECT * FROM faqs WHERE shop_id = ?1 ORDER BY id DESC');
  }
  find(id: number) {
    return this.first<Faq>('SELECT * FROM faqs WHERE shop_id = ?1 AND id = ?2', id);
  }
  create(question: string, answer: string) {
    return this.run('INSERT INTO faqs (shop_id, question, answer) VALUES (?1, ?2, ?3)', question, answer);
  }
  setStatus(id: number, status: Toggle) {
    return this.run('UPDATE faqs SET status = ?2 WHERE shop_id = ?1 AND id = ?3', status, id);
  }
  update(id: number, field: 'question' | 'answer', value: string) {
    return this.run(
      field === 'question' ? 'UPDATE faqs SET question = ?2 WHERE shop_id = ?1 AND id = ?3' : 'UPDATE faqs SET answer = ?2 WHERE shop_id = ?1 AND id = ?3',
      value,
      id,
    );
  }
  delete(id: number) {
    return this.run('DELETE FROM faqs WHERE shop_id = ?1 AND id = ?2', id);
  }
  async count(): Promise<number> {
    return (await this.first<{ n: number }>('SELECT count(*) AS n FROM faqs WHERE shop_id = ?1'))!.n;
  }
}

/** Admin-editable settings and their defaults (a new seller's bot starts with these). */
export const SETTING_DEFAULTS = {
  shop_name: 'فروشگاه ما',
  welcome_text: 'به فروشگاه ما خوش آمدید ❤️',
  track_prefix: 'ORD-',
  bank_info: 'شماره کارت هنوز تنظیم نشده است.',
  support: 'پشتیبانی تنظیم نشده',
  help_text: 'راهنما هنوز تنظیم نشده است.',
} as const;
export type SettingKey = keyof typeof SETTING_DEFAULTS;
export const SETTING_KEYS = Object.keys(SETTING_DEFAULTS) as SettingKey[];

/** Settings of the platform bot itself (stored under shop_id 0). */
export const PLATFORM_SETTING_DEFAULTS = {
  monthly_price: '49000',
  trial_days: '7',
  bank_info: 'شماره کارت هنوز تنظیم نشده است.',
  support: 'پشتیبانی تنظیم نشده',
} as const;
export type PlatformSettingKey = keyof typeof PLATFORM_SETTING_DEFAULTS;
export const PLATFORM_SETTING_KEYS = Object.keys(PLATFORM_SETTING_DEFAULTS) as PlatformSettingKey[];

/** Internal values the bot keeps for itself (not shown in the settings menu). */
type InternalKey = 'admin_chat_ids' | 'webhook_marker' | 'bot_username';

/** Per-shop key/value settings with defaults; the platform uses the same table under shop 0. */
export class SettingsRepository<K extends string = SettingKey> extends Repository {
  constructor(
    db: D1Database,
    shopId: number,
    private readonly defaults: Record<K, string> = SETTING_DEFAULTS as unknown as Record<K, string>,
  ) {
    super(db, shopId);
  }
  async get(key: K): Promise<string> {
    return (await this.raw(key)) ?? this.defaults[key];
  }
  async getMany<P extends K>(keys: readonly P[]): Promise<Record<P, string>> {
    const rows = await this.all<{ setting_key: P; setting_value: string }>(
      `SELECT setting_key, setting_value FROM settings WHERE shop_id = ?1 AND setting_key IN (${keys.map((_, i) => `?${i + 2}`).join(',')})`,
      ...keys,
    );
    const found = new Map(rows.map((r) => [r.setting_key, r.setting_value]));
    return Object.fromEntries(keys.map((k) => [k, found.get(k) ?? this.defaults[k]])) as Record<P, string>;
  }
  set(key: K | InternalKey, value: string) {
    return this.run(
      `INSERT INTO settings (shop_id, setting_key, setting_value) VALUES (?1, ?2, ?3)
       ON CONFLICT(shop_id, setting_key) DO UPDATE SET setting_value = excluded.setting_value`,
      key,
      value,
    );
  }
  async raw(key: K | InternalKey): Promise<string | null> {
    const r = await this.first<{ setting_value: string }>('SELECT setting_value FROM settings WHERE shop_id = ?1 AND setting_key = ?2', key);
    return r?.setting_value ?? null;
  }

  /** Admins who joined with /claim (in addition to ADMIN_CHAT_IDS from the Worker config). */
  async claimedAdmins(): Promise<number[]> {
    return (await this.raw('admin_chat_ids') ?? '').split(',').map(Number).filter((n) => Number.isSafeInteger(n) && n !== 0);
  }
  async addAdmin(chatId: number) {
    const ids = new Set(await this.claimedAdmins()).add(chatId);
    await this.set('admin_chat_ids', [...ids].join(','));
  }
  async removeAdmin(chatId: number) {
    await this.set('admin_chat_ids', (await this.claimedAdmins()).filter((id) => id !== chatId).join(','));
  }
}

export class SessionRepository extends Repository {
  async get<D = Record<string, unknown>>(chatId: number): Promise<Session<D> | null> {
    const r = await this.first<{ chat_id: number; flow: string; step: string; data: string }>(
      'SELECT chat_id, flow, step, data FROM sessions WHERE shop_id = ?1 AND chat_id = ?2',
      chatId,
    );
    return r ? { ...r, data: JSON.parse(r.data) as D } : null;
  }
  /** Starts or advances a flow (one active flow per chat). */
  set(chatId: number, flow: string, step: string | number, data: object = {}) {
    return this.run(
      `INSERT INTO sessions (shop_id, chat_id, flow, step, data, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, unixepoch())
       ON CONFLICT(shop_id, chat_id) DO UPDATE SET flow = excluded.flow, step = excluded.step, data = excluded.data, updated_at = excluded.updated_at`,
      chatId, flow, String(step), JSON.stringify(data),
    );
  }
  clear(chatId: number) {
    return this.run('DELETE FROM sessions WHERE shop_id = ?1 AND chat_id = ?2', chatId);
  }
}

export class DialogRepository extends Repository {
  findByBuyer(buyerChatId: number) {
    return this.first<Dialog>('SELECT buyer_chat_id, admin_chat_id, order_id FROM dialogs WHERE shop_id = ?1 AND buyer_chat_id = ?2', buyerChatId);
  }
  open(d: Dialog) {
    return this.run(
      `INSERT INTO dialogs (shop_id, buyer_chat_id, admin_chat_id, order_id) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(shop_id, buyer_chat_id) DO UPDATE SET admin_chat_id = excluded.admin_chat_id, order_id = excluded.order_id`,
      d.buyer_chat_id, d.admin_chat_id, d.order_id,
    );
  }
  close(buyerChatId: number) {
    return this.run('DELETE FROM dialogs WHERE shop_id = ?1 AND buyer_chat_id = ?2', buyerChatId);
  }
}

/** Records every Telegram update once: retries are skipped and per-chat floods are throttled. */
export class UpdateLogRepository extends Repository {
  /** False when this update_id was already processed (Telegram redelivery). */
  async firstTime(updateId: number, chatId: number): Promise<boolean> {
    const r = await this.run('INSERT INTO processed_updates (shop_id, update_id, chat_id) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING', updateId, chatId);
    return r.meta.changes > 0;
  }
  async recentCount(chatId: number, seconds: number): Promise<number> {
    const r = await this.first<{ n: number }>(
      'SELECT count(*) AS n FROM processed_updates WHERE shop_id = ?1 AND chat_id = ?2 AND at >= unixepoch() - ?3',
      chatId,
      seconds,
    );
    return r!.n;
  }
  prune(olderThanSeconds = 2 * 86400) {
    return this.run('DELETE FROM processed_updates WHERE shop_id = ?1 AND at < unixepoch() - ?2', olderThanSeconds);
  }
}

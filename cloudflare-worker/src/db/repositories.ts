import type { Category, CategoryWithCount, CustomerSummary, Dialog, Faq, Order, OrderDetails, OrderLine, OrderStatus, Product, Session, Toggle, UserRow } from './models';

/*
 * One small class per aggregate. Every query is a prepared statement with bound parameters –
 * the generic query("SELECT", $table, ...) helper built SQL from table/column names, which is
 * exactly where injection bugs hide.
 */

abstract class Repository {
  constructor(protected readonly db: D1Database) {}
  protected all<T>(sql: string, ...args: unknown[]): Promise<T[]> {
    return this.db.prepare(sql).bind(...args).all<T>().then((r) => r.results);
  }
  protected first<T>(sql: string, ...args: unknown[]): Promise<T | null> {
    return this.db.prepare(sql).bind(...args).first<T>();
  }
  protected run(sql: string, ...args: unknown[]): Promise<D1Result> {
    return this.db.prepare(sql).bind(...args).run();
  }
}

const CUSTOMER_STATS = `
  (SELECT count(*) FROM orders o WHERE o.user_id = u.id AND o.status NOT IN ('pending', 'cancel')) AS orders_count,
  (SELECT COALESCE(SUM(oi.price * oi.quantity), 0) FROM orders o JOIN order_items oi ON oi.order_id = o.id
     WHERE o.user_id = u.id AND o.status IN ('approved', 'sending')) AS total_spent,
  (SELECT count(*) FROM orders o WHERE o.user_id = u.id AND o.status = 'payed') AS awaiting_review,
  COALESCE((SELECT MAX(o.time) FROM orders o WHERE o.user_id = u.id AND o.status NOT IN ('pending', 'cancel')), u.created_at) AS last_activity`;

/** Escapes LIKE wildcards so a search for "50%" matches literally. */
const likeTerm = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export class UserRepository extends Repository {
  findByChatId(chatId: number) {
    return this.first<UserRow>('SELECT * FROM users WHERE chat_id = ?', chatId);
  }
  find(id: number) {
    return this.first<UserRow>('SELECT * FROM users WHERE id = ?', id);
  }
  /** Insert-or-refresh; returns the row. */
  async upsert(chatId: number, name: string, username = ''): Promise<UserRow> {
    await this.run(
      `INSERT INTO users (chat_id, name, username) VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET name = excluded.name, username = excluded.username`,
      chatId,
      name,
      username,
    );
    return (await this.findByChatId(chatId))!;
  }
  setStatus(id: number, status: Toggle) {
    return this.run('UPDATE users SET status = ? WHERE id = ?', status, id);
  }
  customer(id: number) {
    return this.first<CustomerSummary>(`SELECT u.*, ${CUSTOMER_STATS} FROM users u WHERE u.id = ?`, id);
  }
  /** Customers, most recently active first. */
  customersPage(limit: number, offset: number) {
    return this.all<CustomerSummary>(
      `SELECT u.*, ${CUSTOMER_STATS} FROM users u ORDER BY last_activity DESC, u.id DESC LIMIT ? OFFSET ?`,
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
        WHERE u.name LIKE ?1 ESCAPE '\\' OR u.username LIKE ?1 ESCAPE '\\' OR u.chat_id = ?2
           OR EXISTS (SELECT 1 FROM orders o LEFT JOIN order_details od ON od.order_id = o.id
                       WHERE o.user_id = u.id AND (o.track_id = ?3 COLLATE NOCASE OR od.phone_number LIKE ?1 ESCAPE '\\'))
        ORDER BY last_activity DESC LIMIT ?4`,
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
        WHERE o.user_id = ? ORDER BY o.id DESC LIMIT 1`,
      userId,
    );
  }
  async count(): Promise<number> {
    return (await this.first<{ n: number }>('SELECT count(*) AS n FROM users'))!.n;
  }
}

export class CategoryRepository extends Repository {
  list(onlyEnabled: boolean) {
    return onlyEnabled
      ? this.all<Category>("SELECT * FROM categories WHERE status = 'enable' ORDER BY id")
      : this.all<Category>('SELECT * FROM categories ORDER BY id DESC');
  }
  find(id: number) {
    return this.first<Category>('SELECT * FROM categories WHERE id = ?', id);
  }
  /** All categories with how many products each holds, for the admin. */
  listWithCounts() {
    return this.all<CategoryWithCount>(
      'SELECT c.*, (SELECT count(*) FROM products p WHERE p.category_id = c.id) AS product_count FROM categories c ORDER BY c.id',
    );
  }
  findWithCount(id: number) {
    return this.first<CategoryWithCount>(
      'SELECT c.*, (SELECT count(*) FROM products p WHERE p.category_id = c.id) AS product_count FROM categories c WHERE c.id = ?',
      id,
    );
  }
  rename(id: number, name: string) {
    return this.run('UPDATE categories SET name = ? WHERE id = ?', name, id);
  }
  setIcon(id: number, icon: string) {
    return this.run('UPDATE categories SET icon = ? WHERE id = ?', icon, id);
  }
  async create(name: string, icon: string): Promise<number> {
    const r = await this.run('INSERT INTO categories (name, icon) VALUES (?, ?)', name, icon);
    return r.meta.last_row_id;
  }
  setStatus(id: number, status: Toggle) {
    return this.run('UPDATE categories SET status = ? WHERE id = ?', status, id);
  }
  /** Deletes only an empty category; returns false when it still has products. */
  async deleteIfEmpty(id: number): Promise<boolean> {
    const r = await this.run('DELETE FROM categories WHERE id = ? AND NOT EXISTS (SELECT 1 FROM products WHERE category_id = ?)', id, id);
    return r.meta.changes > 0;
  }
}

export type ProductDraft = Omit<Product, 'id' | 'status'>;

const VISIBLE_JOIN = 'LEFT JOIN categories c ON c.id = p.category_id';
const VISIBLE = "p.status = 'enable' AND (p.category_id IS NULL OR c.status = 'enable')";
/** A product image is either an uploaded photo or a link; setting one clears the other. */
export type ProductImage = Pick<Product, 'image_url' | 'image_file_id'>;
export const EDITABLE_PRODUCT_FIELDS = ['title', 'description', 'price', 'author', 'image_url', 'inventory'] as const;
export type EditableProductField = (typeof EDITABLE_PRODUCT_FIELDS)[number];

export class ProductRepository extends Repository {
  find(id: number) {
    return this.first<Product>('SELECT * FROM products WHERE id = ?', id);
  }
  /** A product customers may see and buy: enabled, in an enabled category (or none). */
  findVisible(id: number) {
    return this.first<Product>(`SELECT p.* FROM products p ${VISIBLE_JOIN} WHERE p.id = ? AND ${VISIBLE}`, id);
  }
  listByCategory(categoryId: number) {
    return this.all<Product>(`SELECT p.* FROM products p ${VISIBLE_JOIN} WHERE p.category_id = ? AND ${VISIBLE} ORDER BY p.id`, categoryId);
  }
  listPage(limit: number, offset: number) {
    return this.all<Product>('SELECT * FROM products ORDER BY id DESC LIMIT ? OFFSET ?', limit, offset);
  }
  async create(p: ProductDraft): Promise<number> {
    const r = await this.run(
      'INSERT INTO products (category_id, title, description, price, author, image_url, image_file_id, inventory) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      p.category_id, p.title, p.description, p.price, p.author, p.image_url ?? '', p.image_file_id ?? '', p.inventory,
    );
    return r.meta.last_row_id;
  }
  /** `field` is checked against a whitelist, so interpolating the column name is safe. */
  update(id: number, field: EditableProductField | 'category_id' | 'status', value: string | number) {
    if (![...EDITABLE_PRODUCT_FIELDS, 'category_id', 'status'].includes(field)) throw new Error(`bad field ${field}`);
    return this.run(`UPDATE products SET ${field} = ? WHERE id = ?`, value, id);
  }
  setImage(id: number, image: ProductImage) {
    return this.run('UPDATE products SET image_url = ?, image_file_id = ? WHERE id = ?', image.image_url, image.image_file_id, id);
  }
  async count(): Promise<number> {
    return (await this.first<{ n: number }>('SELECT count(*) AS n FROM products'))!.n;
  }
}

const PLACED = "status NOT IN ('pending', 'cancel')";

export class OrderRepository extends Repository {
  find(id: number) {
    return this.first<Order>('SELECT * FROM orders WHERE id = ?', id);
  }
  findPendingForUser(userId: number) {
    return this.first<Order>("SELECT * FROM orders WHERE user_id = ? AND status = 'pending' ORDER BY id DESC", userId);
  }
  async create(userId: number, chatId: number, trackId: string): Promise<number> {
    const r = await this.run('INSERT INTO orders (user_id, user_chat_id, track_id) VALUES (?, ?, ?)', userId, chatId, trackId);
    return r.meta.last_row_id;
  }
  setStatus(id: number, status: OrderStatus) {
    return this.run('UPDATE orders SET status = ? WHERE id = ?', status, id);
  }
  /** Placed orders only: open carts ('pending') and emptied carts ('cancel') are not orders. */
  recentForUser(userId: number, limit = 5) {
    return this.all<Order>("SELECT * FROM orders WHERE user_id = ? AND status NOT IN ('pending', 'cancel') ORDER BY id DESC LIMIT ?", userId, limit);
  }
  placedPage(limit: number, offset: number, userId?: number) {
    return userId === undefined
      ? this.all<Order>(`SELECT * FROM orders WHERE ${PLACED} ORDER BY id DESC LIMIT ? OFFSET ?`, limit, offset)
      : this.all<Order>(`SELECT * FROM orders WHERE ${PLACED} AND user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`, userId, limit, offset);
  }
  async countPlaced(userId?: number): Promise<number> {
    const r =
      userId === undefined
        ? await this.first<{ n: number }>(`SELECT count(*) AS n FROM orders WHERE ${PLACED}`)
        : await this.first<{ n: number }>(`SELECT count(*) AS n FROM orders WHERE ${PLACED} AND user_id = ?`, userId);
    return r!.n;
  }
  /** All paid orders waiting for an admin – shown as a badge in the admin panel. */
  async countAllAwaitingReview(): Promise<number> {
    return (await this.first<{ n: number }>("SELECT count(*) AS n FROM orders WHERE status = 'payed'"))!.n;
  }
  /** Paid orders still waiting for an admin – capped per customer to stop receipt spam. */
  async countAwaitingReview(userId: number): Promise<number> {
    return (await this.first<{ n: number }>("SELECT count(*) AS n FROM orders WHERE user_id = ? AND status = 'payed'", userId))!.n;
  }
  /** The order a receipt photo was already used for, if any. */
  async orderUsingReceipt(uniqueId: string): Promise<number | null> {
    const r = await this.first<{ order_id: number }>('SELECT order_id FROM order_details WHERE receipt_unique_id = ?', uniqueId);
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
       WHERE order_id = ? AND order_id IN (SELECT id FROM orders WHERE status = 'pending')`,
      orderId,
    );
  }
  /** Releases a lock (checkout abandoned or cart changed) so the cart follows live prices again. */
  unlockPrices(orderId: number) {
    return this.run(
      `UPDATE order_items SET price = NULL, product_title = NULL
       WHERE order_id = ? AND order_id IN (SELECT id FROM orders WHERE status = 'pending')`,
      orderId,
    );
  }
  /** Sum of the locked lines, plus how many lines are not locked (0 means the whole cart is locked). */
  async lockedTotal(orderId: number): Promise<{ total: number; unlocked: number; lines: number }> {
    const r = await this.first<{ total: number; unlocked: number | null; lines: number }>(
      'SELECT COALESCE(SUM(price * quantity), 0) AS total, SUM(price IS NULL) AS unlocked, COUNT(*) AS lines FROM order_items WHERE order_id = ?',
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
         FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id ${VISIBLE_JOIN}
        WHERE oi.order_id = ? ORDER BY oi.id`,
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
         FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id IN (${orderIds.map(() => '?').join(',')}) ORDER BY oi.id`,
      ...orderIds,
    );
    for (const { order_id, ...line } of rows) out.set(order_id, [...(out.get(order_id) ?? []), line]);
    return out;
  }

  /** Adds qty to the cart line, creating it if needed. */
  addItem(orderId: number, productId: number, qty: number) {
    return this.run(
      `INSERT INTO order_items (order_id, product_id, quantity) VALUES (?, ?, ?)
       ON CONFLICT(order_id, product_id) DO UPDATE SET quantity = quantity + excluded.quantity`,
      orderId, productId, qty,
    );
  }
  async quantityInCart(orderId: number, productId: number): Promise<number> {
    const r = await this.first<{ quantity: number }>(
      'SELECT quantity FROM order_items WHERE order_id = ? AND product_id = ?', orderId, productId,
    );
    return r?.quantity ?? 0;
  }
  async removeItem(orderId: number, itemId: number): Promise<boolean> {
    const r = await this.run('DELETE FROM order_items WHERE id = ? AND order_id = ?', itemId, orderId);
    return r.meta.changes > 0;
  }

  details(orderId: number) {
    return this.first<OrderDetails>('SELECT * FROM order_details WHERE order_id = ?', orderId);
  }

  /**
   * Payment submitted: store details and mark as payed – atomically. Lines are already price-locked;
   * the snapshot below only fills a line that somehow is not (it never overwrites a locked price).
   */
  async markPaid(d: OrderDetails): Promise<'ok' | 'not_pending' | 'receipt_reused'> {
    try {
      const results = await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO order_details (order_id, first_name, last_name, address, phone_number, receipt_file_id, receipt_r2_key, receipt_unique_id)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 WHERE EXISTS (SELECT 1 FROM orders WHERE id = ?1 AND status = 'pending')`,
          )
          .bind(d.order_id, d.first_name, d.last_name, d.address, d.phone_number, d.receipt_file_id, d.receipt_r2_key, d.receipt_unique_id),
        this.db
          .prepare(
            `UPDATE order_items SET
               price         = (SELECT price FROM products WHERE products.id = order_items.product_id),
               product_title = (SELECT title FROM products WHERE products.id = order_items.product_id)
             WHERE order_id = ? AND price IS NULL`,
          )
          .bind(d.order_id),
        this.db.prepare("UPDATE orders SET status = 'payed' WHERE id = ? AND status = 'pending'").bind(d.order_id),
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
        this.db
          .prepare(
            `UPDATE products SET inventory = inventory ${sign}
               (SELECT quantity FROM order_items WHERE order_id = ?1 AND product_id = products.id)
             WHERE id IN (SELECT product_id FROM order_items WHERE order_id = ?1)
               AND EXISTS (SELECT 1 FROM orders WHERE id = ?1 AND status = ?2 AND stock_taken = ?3)`,
          )
          .bind(orderId, from, stock === 'take' ? 0 : 1),
      );
    }
    stmts.push(
      this.db
        .prepare(
          `UPDATE orders SET status = ?3,
             stock_taken = CASE ?4 WHEN 'take' THEN 1 WHEN 'return' THEN 0 ELSE stock_taken END
           WHERE id = ?1 AND status = ?2`,
        )
        .bind(orderId, from, to, stock),
    );
    const results = await this.db.batch(stmts);
    return results.at(-1)!.meta.changes > 0;
  }

  async stats(since: { day: number; month: number }) {
    const ok = "('payed','approved','sending')";
    const [completed, daily, monthly] = await Promise.all([
      this.first<{ n: number }>(`SELECT count(*) AS n FROM orders WHERE status IN ${ok}`),
      this.first<{ s: number | null }>(
        `SELECT SUM(oi.price * oi.quantity) AS s FROM order_items oi JOIN orders o ON o.id = oi.order_id
          WHERE o.status IN ${ok} AND o.time >= ?`,
        since.day,
      ),
      this.first<{ s: number | null }>(
        `SELECT SUM(oi.price * oi.quantity) AS s FROM order_items oi JOIN orders o ON o.id = oi.order_id
          WHERE o.status IN ${ok} AND o.time >= ?`,
        since.month,
      ),
    ]);
    return { completed: completed!.n, daily: daily!.s ?? 0, monthly: monthly!.s ?? 0 };
  }
}

export class FaqRepository extends Repository {
  list(onlyEnabled: boolean) {
    return onlyEnabled
      ? this.all<Faq>("SELECT * FROM faqs WHERE status = 'enable' ORDER BY id")
      : this.all<Faq>('SELECT * FROM faqs ORDER BY id DESC');
  }
  find(id: number) {
    return this.first<Faq>('SELECT * FROM faqs WHERE id = ?', id);
  }
  create(question: string, answer: string) {
    return this.run('INSERT INTO faqs (question, answer) VALUES (?, ?)', question, answer);
  }
  setStatus(id: number, status: Toggle) {
    return this.run('UPDATE faqs SET status = ? WHERE id = ?', status, id);
  }
  update(id: number, field: 'question' | 'answer', value: string) {
    return this.run(field === 'question' ? 'UPDATE faqs SET question = ? WHERE id = ?' : 'UPDATE faqs SET answer = ? WHERE id = ?', value, id);
  }
  delete(id: number) {
    return this.run('DELETE FROM faqs WHERE id = ?', id);
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

/** Internal values the bot keeps for itself (not shown in the settings menu). */
type InternalKey = 'admin_chat_ids' | 'webhook_marker';

export class SettingsRepository extends Repository {
  async get(key: SettingKey): Promise<string> {
    return (await this.raw(key)) ?? SETTING_DEFAULTS[key];
  }
  async getMany<K extends SettingKey>(keys: readonly K[]): Promise<Record<K, string>> {
    const rows = await this.all<{ setting_key: K; setting_value: string }>(
      `SELECT setting_key, setting_value FROM settings WHERE setting_key IN (${keys.map(() => '?').join(',')})`,
      ...keys,
    );
    const found = new Map(rows.map((r) => [r.setting_key, r.setting_value]));
    return Object.fromEntries(keys.map((k) => [k, found.get(k) ?? SETTING_DEFAULTS[k]])) as Record<K, string>;
  }
  set(key: SettingKey | InternalKey, value: string) {
    return this.run(
      'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value',
      key,
      value,
    );
  }
  async raw(key: SettingKey | InternalKey): Promise<string | null> {
    const r = await this.first<{ setting_value: string }>('SELECT setting_value FROM settings WHERE setting_key = ?', key);
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
      'SELECT chat_id, flow, step, data FROM sessions WHERE chat_id = ?',
      chatId,
    );
    return r ? { ...r, data: JSON.parse(r.data) as D } : null;
  }
  /** Starts or advances a flow (one active flow per chat). */
  set(chatId: number, flow: string, step: string | number, data: object = {}) {
    return this.run(
      `INSERT INTO sessions (chat_id, flow, step, data, updated_at) VALUES (?, ?, ?, ?, unixepoch())
       ON CONFLICT(chat_id) DO UPDATE SET flow = excluded.flow, step = excluded.step, data = excluded.data, updated_at = excluded.updated_at`,
      chatId, flow, String(step), JSON.stringify(data),
    );
  }
  clear(chatId: number) {
    return this.run('DELETE FROM sessions WHERE chat_id = ?', chatId);
  }
}

export class DialogRepository extends Repository {
  findByBuyer(buyerChatId: number) {
    return this.first<Dialog>('SELECT * FROM dialogs WHERE buyer_chat_id = ?', buyerChatId);
  }
  open(d: Dialog) {
    return this.run(
      `INSERT INTO dialogs (buyer_chat_id, admin_chat_id, order_id) VALUES (?, ?, ?)
       ON CONFLICT(buyer_chat_id) DO UPDATE SET admin_chat_id = excluded.admin_chat_id, order_id = excluded.order_id`,
      d.buyer_chat_id, d.admin_chat_id, d.order_id,
    );
  }
  close(buyerChatId: number) {
    return this.run('DELETE FROM dialogs WHERE buyer_chat_id = ?', buyerChatId);
  }
}

/** Records every Telegram update once: retries are skipped and per-chat floods are throttled. */
export class UpdateLogRepository extends Repository {
  /** False when this update_id was already processed (Telegram redelivery). */
  async firstTime(updateId: number, chatId: number): Promise<boolean> {
    const r = await this.run('INSERT INTO processed_updates (update_id, chat_id) VALUES (?, ?) ON CONFLICT DO NOTHING', updateId, chatId);
    return r.meta.changes > 0;
  }
  async recentCount(chatId: number, seconds: number): Promise<number> {
    const r = await this.first<{ n: number }>('SELECT count(*) AS n FROM processed_updates WHERE chat_id = ? AND at >= unixepoch() - ?', chatId, seconds);
    return r!.n;
  }
  prune(olderThanSeconds = 2 * 86400) {
    return this.run('DELETE FROM processed_updates WHERE at < unixepoch() - ?', olderThanSeconds);
  }
}

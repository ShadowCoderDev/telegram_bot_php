import type { Category, Dialog, Faq, Order, OrderDetails, OrderLine, OrderStatus, Product, Session, Toggle, UserRow } from './models';

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

export class UserRepository extends Repository {
  findByChatId(chatId: number) {
    return this.first<UserRow>('SELECT * FROM users WHERE chat_id = ?', chatId);
  }
  /** Insert-or-refresh; returns the row. */
  async upsert(chatId: number, name: string): Promise<UserRow> {
    await this.run(
      'INSERT INTO users (chat_id, name) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET name = excluded.name',
      chatId,
      name,
    );
    return (await this.findByChatId(chatId))!;
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
  async create(name: string, icon: string): Promise<number> {
    const r = await this.run('INSERT INTO categories (name, icon) VALUES (?, ?)', name, icon);
    return r.meta.last_row_id;
  }
  setStatus(id: number, status: Toggle) {
    return this.run('UPDATE categories SET status = ? WHERE id = ?', status, id);
  }
  async hasProducts(id: number): Promise<boolean> {
    return (await this.first('SELECT 1 FROM products WHERE category_id = ? LIMIT 1', id)) !== null;
  }
  delete(id: number) {
    return this.run('DELETE FROM categories WHERE id = ?', id);
  }
}

export type ProductDraft = Omit<Product, 'id' | 'status'>;
export const EDITABLE_PRODUCT_FIELDS = ['title', 'description', 'price', 'author', 'image_url', 'inventory'] as const;
export type EditableProductField = (typeof EDITABLE_PRODUCT_FIELDS)[number];

export class ProductRepository extends Repository {
  find(id: number) {
    return this.first<Product>('SELECT * FROM products WHERE id = ?', id);
  }
  listByCategory(categoryId: number) {
    return this.all<Product>("SELECT * FROM products WHERE category_id = ? AND status = 'enable' ORDER BY id", categoryId);
  }
  listAll() {
    return this.all<Product>('SELECT * FROM products ORDER BY id DESC');
  }
  async create(p: ProductDraft): Promise<number> {
    const r = await this.run(
      'INSERT INTO products (category_id, title, description, price, author, image_url, inventory) VALUES (?, ?, ?, ?, ?, ?, ?)',
      p.category_id, p.title, p.description, p.price, p.author, p.image_url, p.inventory,
    );
    return r.meta.last_row_id;
  }
  /** `field` is checked against a whitelist, so interpolating the column name is safe. */
  update(id: number, field: EditableProductField | 'category_id' | 'status', value: string | number) {
    if (![...EDITABLE_PRODUCT_FIELDS, 'category_id', 'status'].includes(field)) throw new Error(`bad field ${field}`);
    return this.run(`UPDATE products SET ${field} = ? WHERE id = ?`, value, id);
  }
  async count(): Promise<number> {
    return (await this.first<{ n: number }>('SELECT count(*) AS n FROM products'))!.n;
  }
}

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
  recentForUser(userId: number, limit = 5) {
    return this.all<Order>("SELECT * FROM orders WHERE user_id = ? AND status != 'pending' ORDER BY id DESC LIMIT ?", userId, limit);
  }
  recentNonPending(limit = 50) {
    return this.all<Order>("SELECT * FROM orders WHERE status != 'pending' ORDER BY id DESC LIMIT ?", limit);
  }

  /** Lines of an order. Before payment the live product price/title is used; after, the snapshot. */
  lines(orderId: number) {
    return this.all<OrderLine>(
      `SELECT oi.id AS item_id, oi.product_id, oi.quantity,
              COALESCE(oi.product_title, p.title) AS title,
              COALESCE(oi.price, p.price)         AS price,
              COALESCE(p.inventory, 0)            AS inventory
         FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
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
              COALESCE(oi.product_title, p.title) AS title, COALESCE(oi.price, p.price) AS price, 0 AS inventory
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
   * Payment submitted: store details, freeze prices/titles and mark as payed – atomically.
   */
  async markPaid(d: OrderDetails): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO order_details (order_id, first_name, last_name, address, phone_number, receipt_file_id, receipt_r2_key)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(d.order_id, d.first_name, d.last_name, d.address, d.phone_number, d.receipt_file_id, d.receipt_r2_key),
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
  }

  /**
   * Moves stock in or out for every line of the order together with the status change, in one
   * transaction. Taking stock that isn't there violates CHECK(inventory >= 0) and rolls everything back.
   */
  async changeStatusWithStock(orderId: number, status: OrderStatus, stock: 'take' | 'return' | 'keep'): Promise<void> {
    const stmts: D1PreparedStatement[] = [];
    if (stock !== 'keep') {
      const sign = stock === 'take' ? '-' : '+';
      stmts.push(
        this.db
          .prepare(
            `UPDATE products SET inventory = inventory ${sign}
               (SELECT quantity FROM order_items WHERE order_id = ?1 AND product_id = products.id)
             WHERE id IN (SELECT product_id FROM order_items WHERE order_id = ?1)`,
          )
          .bind(orderId),
      );
    }
    stmts.push(
      this.db
        .prepare(
          `UPDATE orders SET status = ?2,
             stock_taken = CASE ?3 WHEN 'take' THEN 1 WHEN 'return' THEN 0 ELSE stock_taken END
           WHERE id = ?1`,
        )
        .bind(orderId, status, stock),
    );
    await this.db.batch(stmts);
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
}

export const SETTING_KEYS = ['help_text', 'support', 'bank_info'] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export class SettingsRepository extends Repository {
  async get(key: SettingKey, fallback: string): Promise<string> {
    const r = await this.first<{ setting_value: string }>('SELECT setting_value FROM settings WHERE setting_key = ?', key);
    return r?.setting_value ?? fallback;
  }
  set(key: SettingKey, value: string) {
    return this.run(
      'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value',
      key,
      value,
    );
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

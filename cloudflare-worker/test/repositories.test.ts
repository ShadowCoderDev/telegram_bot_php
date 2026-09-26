/**
 * Integration tests for the SQL guards, against a real local D1 (via wrangler's platform proxy).
 * They reproduce races deterministically: two writers that both read the same starting state.
 */
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { getPlatformProxy } from 'wrangler';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyUsage, meterD1 } from '../src/db/meter';
import { CategoryRepository, FaqRepository, OrderRepository, ProductRepository, SessionRepository, SettingsRepository, UserRepository } from '../src/db/repositories';
import { PlatformUsageRepository, UNCAPPED, UsageRepository, addPendingUsage, utcDay } from '../src/db/usage';

const PERSIST = '.wrangler/repo-test';
let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
let db: D1Database;
let orders: OrderRepository;

const exec = (sql: string) => db.exec(sql.replace(/\s+/g, ' '));

/** A user with an order of 2 × product 1 (price 100, stock 5) in the given status. */
async function seedOrder(status: string): Promise<number> {
  const r = await db
    .prepare("INSERT INTO orders (user_id, user_chat_id, track_id, status) VALUES (1, 111, ?, ?)")
    .bind(`T-${Math.random()}`, status)
    .run();
  const id = r.meta.last_row_id;
  await db.prepare('INSERT INTO order_items (order_id, product_id, quantity) VALUES (?, 1, 2)').bind(id).run();
  return id;
}
const inventory = async () => (await db.prepare('SELECT inventory FROM products WHERE id = 1').first<{ inventory: number }>())!.inventory;
const details = (orderId: number, unique: string) => ({
  order_id: orderId, first_name: 'A', last_name: 'B', address: 'addr', phone_number: '0912',
  receipt_file_id: 'f', receipt_r2_key: null, receipt_unique_id: unique,
});

beforeAll(async () => {
  rmSync(PERSIST, { recursive: true, force: true });
  execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'shop', '--local', '--persist-to', PERSIST], { stdio: 'ignore' });
  // `--persist-to X` stores state under X/v3, which is what the proxy expects.
  proxy = await getPlatformProxy<{ DB: D1Database }>({ persist: { path: `${PERSIST}/v3` } });
  db = proxy.env.DB;
  orders = new OrderRepository(db, 1);
  await exec(`
    INSERT INTO users (id, chat_id, name, username) VALUES (1, 111, 'Sara 50% off', 'sara_x');
    INSERT INTO categories (id, name) VALUES (1, 'Books');
    INSERT INTO products (id, category_id, title, price, inventory) VALUES (1, 1, 'Book', 100, 5);
  `);
});

afterAll(async () => {
  await proxy?.dispose();
});

describe('order status changes', () => {
  it('moves stock only once when two approvals race from the same state', async () => {
    const id = await seedOrder('payed');
    // Both callers read "payed" before either wrote – exactly what a double click can produce.
    expect(await orders.changeStatusWithStock(id, 'payed', 'approved', 'take')).toBe(true);
    expect(await orders.changeStatusWithStock(id, 'payed', 'approved', 'take')).toBe(false);
    expect(await inventory()).toBe(3);

    // Same for returning stock on rejection.
    expect(await orders.changeStatusWithStock(id, 'approved', 'rejected', 'return')).toBe(true);
    expect(await orders.changeStatusWithStock(id, 'approved', 'rejected', 'return')).toBe(false);
    expect(await inventory()).toBe(5);
  });

  it('never oversells: taking more than is in stock rolls the whole change back', async () => {
    await exec('UPDATE products SET inventory = 1 WHERE id = 1');
    const id = await seedOrder('payed');
    await expect(orders.changeStatusWithStock(id, 'payed', 'approved', 'take')).rejects.toThrow(/CHECK constraint/);
    expect(await inventory()).toBe(1);
    expect((await orders.find(id))!.status).toBe('payed');
    await exec('UPDATE products SET inventory = 5 WHERE id = 1');
  });
});

describe('payment', () => {
  it('accepts one receipt per order and one order per receipt', async () => {
    const first = await seedOrder('pending');
    const second = await seedOrder('pending');
    expect(await orders.markPaid(details(first, 'photo-1'))).toBe('ok');
    expect(await orders.markPaid(details(first, 'photo-2'))).toBe('not_pending'); // album / double send
    expect(await orders.markPaid(details(second, 'photo-1'))).toBe('receipt_reused');
    expect((await orders.find(second))!.status).toBe('pending');
    expect(await orders.orderUsingReceipt('photo-1')).toBe(first);

    // A receipt sent for a cart that was emptied meanwhile is not stored (and not "used up").
    const cancelled = await seedOrder('cancel');
    expect(await orders.markPaid(details(cancelled, 'photo-3'))).toBe('not_pending');
    expect(await orders.orderUsingReceipt('photo-3')).toBeNull();
  });

  it('keeps a locked price when the product price changes, and releases it on unlock', async () => {
    const id = await seedOrder('pending');
    await orders.lockPrices(id);
    await exec('UPDATE products SET price = 999 WHERE id = 1');
    expect(await orders.lockedTotal(id)).toMatchObject({ total: 200, unlocked: 0 });
    await orders.unlockPrices(id);
    expect((await orders.lines(id))[0]!.price).toBe(999);
    await exec('UPDATE products SET price = 100 WHERE id = 1');
  });
});

describe('customers', () => {
  it('searches customers with LIKE wildcards taken literally', async () => {
    const users = new UserRepository(db, 1);
    expect((await users.searchCustomers('50%')).map((u) => u.id)).toEqual([1]);
    expect(await users.searchCustomers('S%a')).toEqual([]); // % is not a wildcard
    expect((await users.searchCustomers('@sara_x')).map((u) => u.id)).toEqual([1]);
    expect(await users.searchCustomers('sara_')).toHaveLength(1);
    expect(await users.searchCustomers('sar__')).toEqual([]);
  });
});

describe('usage tracking (redeliveries, daily cap)', () => {
  const T = 1_800_000_000; // a fixed "now"
  const DAY = 86_400;
  const OPEN = { updates: UNCAPPED, written: UNCAPPED, read: UNCAPPED };
  const cap = (updates: number) => ({ ...OPEN, updates });

  it('handles each update id once, in any order, for one write each', async () => {
    const usage = emptyUsage();
    const bot = new UsageRepository(meterD1(db, usage), 7);
    expect(await bot.track(500, T, OPEN)).toEqual({ status: 'ok', updates: 1 });
    expect(usage.rowsWritten).toBe(1);
    expect(await bot.track(502, T, OPEN)).toEqual({ status: 'ok', updates: 2 });
    expect(await bot.track(501, T, OPEN)).toEqual({ status: 'ok', updates: 3 }); // late, not a duplicate
    expect(await bot.track(502, T, OPEN)).toEqual({ status: 'duplicate' });
    expect(await bot.track(500, T, OPEN)).toEqual({ status: 'duplicate' });
    expect(usage.rowsWritten).toBe(3);
    // Telegram restarts ids from a random number after a week of silence: still accepted.
    expect(await bot.track(3, T, OPEN)).toEqual({ status: 'ok', updates: 4 });
    // Two deliveries of the same update at the same moment: only one passes.
    const both = await Promise.all([bot.track(900, T, OPEN), bot.track(900, T, OPEN)]);
    expect(both.map((r) => r.status).sort()).toEqual(['duplicate', 'ok']);
  });

  it('remembers enough recent ids even when they are long', async () => {
    const bot = new UsageRepository(db, 8);
    const base = 987_654_321;
    for (let i = 0; i < 60; i++) await bot.track(base + i, T, OPEN);
    for (let i = 20; i < 60; i++) expect((await bot.track(base + i, T, OPEN)).status, `id ${i}`).toBe('duplicate');
  });

  it('refuses updates over the daily cap without writing, and starts again the next day', async () => {
    const bot = new UsageRepository(db, 9);
    for (let i = 1; i <= 3; i++) expect(await bot.track(i, T, cap(3))).toEqual({ status: 'ok', updates: i });
    const usage = emptyUsage();
    const metered = new UsageRepository(meterD1(db, usage), 9);
    expect(await metered.track(4, T, cap(3))).toEqual({ status: 'capped', updates: 3, by: 'updates' });
    expect(usage.rowsWritten).toBe(0);
    expect((await bot.track(4, T, cap(3))).status).toBe('capped'); // still refused, so not remembered as seen
    expect(await bot.track(5, T, OPEN)).toEqual({ status: 'ok', updates: 4 }); // admins are never capped
    expect(await bot.track(4, T + DAY, cap(3))).toEqual({ status: 'ok', updates: 1 }); // a new UTC day

    // Yesterday's numbers moved to the history (by the trigger), including the 2 refused requests;
    // today's row starts from zero.
    expect(await db.prepare('SELECT day, updates, dropped FROM usage_history WHERE shop_id = 9').all().then((r) => r.results)).toEqual([
      { day: utcDay(T), updates: 4, dropped: 2 },
    ]);
    const history = await new PlatformUsageRepository(db).history(utcDay(T + DAY));
    expect(history.find((h) => h.day === utcDay(T))!.updates).toBeGreaterThanOrEqual(4);
    expect(await bot.today(T + DAY)).toMatchObject({ updates: 1 });
    expect(await bot.today(T + 2 * DAY)).toMatchObject({ updates: 0 });
  });

  it('stops a bot that used its share of the rows, whatever its update count', async () => {
    const bot = new UsageRepository(db, 11);
    await bot.track(1, T, OPEN);
    addPendingUsage(11, { queries: 1, rowsRead: 900, rowsWritten: 40 });
    const budget = { updates: UNCAPPED, written: 50, read: 1000 };
    expect((await bot.track(2, T, budget)).status).toBe('ok'); // brings the day to 40 written, 900 read
    addPendingUsage(11, { queries: 1, rowsRead: 200, rowsWritten: 0 });
    expect((await bot.track(3, T, budget)).status).toBe('ok'); // reads now 1,100: over the budget
    expect(await bot.track(4, T, budget)).toEqual({ status: 'capped', updates: 3, by: 'rows' });
    expect((await bot.track(4, T + DAY, budget)).status).toBe('ok'); // a new day
  });

  it("adds each request's measured cost with the bot's next update", async () => {
    const bot = new UsageRepository(db, 10);
    await bot.track(1, T, OPEN);
    addPendingUsage(10, { queries: 3, rowsRead: 40, rowsWritten: 6 });
    addPendingUsage(10, { queries: 1, rowsRead: 2, rowsWritten: 1 });
    await bot.track(2, T, OPEN);
    expect(await bot.today(T)).toMatchObject({ updates: 2, rows_written: 7, rows_read: 42 });
    const totals = await new PlatformUsageRepository(db).totals(utcDay(T));
    expect(totals.rows_written).toBeGreaterThanOrEqual(7);
  });
});

describe('shop isolation', () => {
  it('never lets one shop read or change another shop\'s rows, even by id', async () => {
    // Shop 1's data was seeded above (user 1, category 1, product 1, orders). Shop 2 looks at it by id.
    const [users, categories, products, orders2, faqs, settings, sessions] = [
      new UserRepository(db, 2), new CategoryRepository(db, 2), new ProductRepository(db, 2), new OrderRepository(db, 2),
      new FaqRepository(db, 2), new SettingsRepository(db, 2), new SessionRepository(db, 2),
    ];
    expect(await users.find(1)).toBeNull();
    expect(await users.findByChatId(111)).toBeNull();
    expect(await categories.find(1)).toBeNull();
    expect(await categories.list(false)).toEqual([]);
    expect(await products.find(1)).toBeNull();
    expect(await products.findVisible(1)).toBeNull();
    expect(await orders2.find(1)).toBeNull();
    expect(await orders2.lines(1)).toEqual([]);
    expect(await orders2.placedPage(10, 0)).toEqual([]);
    expect(await users.customersPage(10, 0)).toEqual([]);
    expect(await users.searchCustomers('Sara')).toEqual([]);

    // Writes by id are no-ops across shops.
    await products.update(1, 'price', 1);
    await categories.rename(1, 'hijacked');
    expect(await categories.deleteIfEmpty(1)).toBe(false);
    expect(await orders2.changeStatusWithStock(1, 'rejected', 'approved', 'take')).toBe(false);
    expect(await new ProductRepository(db, 1).find(1)).toMatchObject({ price: 100 });
    expect(await new CategoryRepository(db, 1).find(1)).toMatchObject({ name: 'Books' });

    // A shop can't attach its product to another shop's category.
    const cat2 = await categories.create('Mine', '📦');
    const product2 = (await products.create({ category_id: 1, title: 'x', description: '', price: 1, author: '', image_url: '', image_file_id: '', inventory: 1 }));
    expect(product2).toBeNull();
    const own = (await products.create({ category_id: cat2, title: 'x', description: '', price: 1, author: '', image_url: '', image_file_id: '', inventory: 1 }))!;
    expect(await products.setCategory(own, 1)).toBe(false);

    // Same Telegram user, separate customer and separate conversation state per shop.
    await users.upsert(111, 'Ali in shop 2');
    expect((await new UserRepository(db, 1).findByChatId(111))!.name).not.toBe('Ali in shop 2');
    await sessions.set(111, 'checkout', 'name');
    expect(await new SessionRepository(db, 1).get(111)).toBeNull();
    await settings.set('shop_name', 'Shop 2');
    expect(await new SettingsRepository(db, 1).get('shop_name')).not.toBe('Shop 2');
    expect(await faqs.list(false)).toEqual([]);
  });

  it('refuses to run a query that is not scoped to a shop', async () => {
    class Leaky extends UserRepository {
      leak() {
        return this.all('SELECT * FROM users');
      }
    }
    expect(() => new Leaky(db, 2).leak()).toThrow(/not scoped/);
  });
});


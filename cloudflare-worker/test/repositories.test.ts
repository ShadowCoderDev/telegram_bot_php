/**
 * Integration tests for the SQL guards, against a real local D1 (via wrangler's platform proxy).
 * They reproduce races deterministically: two writers that both read the same starting state.
 */
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { getPlatformProxy } from 'wrangler';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrderRepository, UpdateLogRepository, UserRepository } from '../src/db/repositories';

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
  orders = new OrderRepository(db);
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

describe('customers & update log', () => {
  it('searches customers with LIKE wildcards taken literally', async () => {
    const users = new UserRepository(db);
    expect((await users.searchCustomers('50%')).map((u) => u.id)).toEqual([1]);
    expect(await users.searchCustomers('S%a')).toEqual([]); // % is not a wildcard
    expect((await users.searchCustomers('@sara_x')).map((u) => u.id)).toEqual([1]);
    expect(await users.searchCustomers('sara_')).toHaveLength(1);
    expect(await users.searchCustomers('sar__')).toEqual([]);
  });

  it('processes each update id once', async () => {
    const log = new UpdateLogRepository(db);
    expect(await log.firstTime(42, 111)).toBe(true);
    expect(await log.firstTime(42, 111)).toBe(false);
    expect(await log.recentCount(111, 10)).toBe(1);
  });
});

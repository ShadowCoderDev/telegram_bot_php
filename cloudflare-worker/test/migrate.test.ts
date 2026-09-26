/**
 * The Worker's own migrator must produce the same schema and bookkeeping as
 * `wrangler d1 migrations apply`, so a seller can use either (or both).
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { getPlatformProxy } from 'wrangler';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, splitSql } from '../src/db/migrate';

const PERSIST = '.wrangler/migrate-test';
let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;

beforeAll(async () => {
  rmSync(PERSIST, { recursive: true, force: true });
  rmSync(`${PERSIST}-legacy`, { recursive: true, force: true });
  proxy = await getPlatformProxy<{ DB: D1Database }>({ persist: { path: `${PERSIST}/v3` } });
});
afterAll(async () => {
  await proxy?.dispose();
});

describe('runtime migrations', () => {
  it('splits statements and ignores comment-only chunks', () => {
    expect(splitSql('-- note\nCREATE TABLE a (x);\n\n-- only a comment;\nINSERT INTO a VALUES (1);')).toEqual([
      '-- note\nCREATE TABLE a (x)',
      'INSERT INTO a VALUES (1)',
    ]);
  });

  it('applies every migration file once, recording it where wrangler looks', async () => {
    const db = proxy.env.DB;
    await migrate(db);
    await migrate(db); // idempotent
    const names = (await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>()).results.map((r) => r.name);
    expect(names).toEqual(readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort());
    expect(await db.prepare("SELECT setting_value FROM settings WHERE setting_key = 'bank_info'").first()).toBeTruthy();
    expect(await db.prepare('SELECT count(*) AS n FROM processed_updates').first()).toEqual({ n: 0 });
  });

  it('leaves nothing for wrangler to apply afterwards', async () => {
    await proxy.dispose();
    const out = execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'shop', '--local', '--persist-to', PERSIST], { encoding: 'utf8' });
    expect(out).toMatch(/No migrations to apply/);
    proxy = await getPlatformProxy<{ DB: D1Database }>({ persist: { path: `${PERSIST}/v3` } });
  });

describe('multi-tenant migration over existing data', () => {
  it('moves every existing row into shop 1 and keeps foreign keys valid', async () => {
    const legacy = await getPlatformProxy<{ DB: D1Database }>({ persist: { path: `${PERSIST}-legacy/v3` } });
    try {
      const db = legacy.env.DB;
      await migrate(db, 3); // the single-shop schema
      await db.batch([
        db.prepare("INSERT INTO users (id, chat_id, name) VALUES (1, 111, 'Ali')"),
        db.prepare("INSERT INTO categories (id, name) VALUES (1, 'Books')"),
        db.prepare("INSERT INTO products (id, category_id, title, price, inventory) VALUES (1, 1, 'Book', 100, 5)"),
        db.prepare("INSERT INTO orders (id, user_id, user_chat_id, track_id, status) VALUES (1, 1, 111, 'T1', 'payed')"),
        db.prepare('INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (1, 1, 2, 100)'),
        db.prepare("INSERT INTO order_details (order_id, first_name, last_name, address, phone_number, receipt_unique_id) VALUES (1, 'A', 'B', 'addr', '0912', 'u1')"),
        db.prepare("INSERT INTO settings (setting_key, setting_value) VALUES ('shop_name', 'IELTS')"),
        db.prepare("INSERT INTO sessions (chat_id, flow, step) VALUES (111, 'checkout', 'name')"),
        db.prepare('INSERT INTO dialogs (buyer_chat_id, admin_chat_id, order_id) VALUES (111, 999, 1)'),
        db.prepare('INSERT INTO processed_updates (update_id, chat_id) VALUES (5, 111)'),
      ]);

      await migrate(db); // → multi-tenant

      const count = async (sql: string) => ((await db.prepare(sql).first<{ n: number }>())!).n;
      for (const table of ['users', 'categories', 'products', 'orders', 'order_items', 'order_details', 'sessions', 'dialogs', 'processed_updates']) {
        expect(await count(`SELECT count(*) AS n FROM ${table} WHERE shop_id = 1`), table).toBe(1);
      }
      expect(await db.prepare("SELECT setting_value FROM settings WHERE shop_id = 1 AND setting_key = 'shop_name'").first()).toEqual({ setting_value: 'IELTS' });
      expect(await db.prepare('SELECT plan FROM shops WHERE id = 1').first()).toEqual({ plan: 'owner' });
      expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
      // Old ids survive, so existing orders still point at their customer.
      expect(await db.prepare('SELECT u.name FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = 1').first()).toEqual({ name: 'Ali' });
      // The same Telegram user can now be a customer of another shop too.
      await db.prepare("INSERT INTO users (shop_id, chat_id, name) VALUES (2, 111, 'Ali')").run();
    } finally {
      await legacy.dispose();
    }
  });
});
});

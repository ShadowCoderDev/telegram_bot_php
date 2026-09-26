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
});

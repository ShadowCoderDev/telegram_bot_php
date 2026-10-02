import m0001 from '../../migrations/0001_init.sql';
import m0002 from '../../migrations/0002_product_image_file_id.sql';
import m0003 from '../../migrations/0003_customers_and_abuse_guards.sql';
import m0004 from '../../migrations/0004_multi_tenant.sql';
import m0005 from '../../migrations/0005_cheaper_bookkeeping.sql';
import m0006 from '../../migrations/0006_reads_that_scale.sql';
import m0007 from '../../migrations/0007_data_retention.sql';
import m0008 from '../../migrations/0008_schedules_and_inline.sql';
import m0009 from '../../migrations/0009_appointment_reminders.sql';

/**
 * The Worker brings its own database up to date on first use, so a plain `wrangler deploy`
 * (e.g. from the "Deploy to Cloudflare" button) is enough. It records migrations in the same
 * `d1_migrations` table as `wrangler d1 migrations apply`, so both ways can be mixed freely.
 * Add every new file in migrations/ here too.
 */
const MIGRATIONS: { name: string; sql: string }[] = [
  { name: '0001_init.sql', sql: m0001 },
  { name: '0002_product_image_file_id.sql', sql: m0002 },
  { name: '0003_customers_and_abuse_guards.sql', sql: m0003 },
  { name: '0004_multi_tenant.sql', sql: m0004 },
  { name: '0005_cheaper_bookkeeping.sql', sql: m0005 },
  { name: '0006_reads_that_scale.sql', sql: m0006 },
  { name: '0007_data_retention.sql', sql: m0007 },
  { name: '0008_schedules_and_inline.sql', sql: m0008 },
  { name: '0009_appointment_reminders.sql', sql: m0009 },
];

/**
 * Splits a migration file into statements at semicolons that end a line. A CREATE TRIGGER body has
 * its own semicolons, so everything up to its closing END stays one statement.
 * (Our files have no semicolons at line ends inside strings.)
 */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let trigger: string | null = null;
  for (const piece of sql.split(/;\s*(?:\n|$)/)) {
    if (trigger !== null) {
      trigger += `;\n${piece}`;
      if (/\bEND\s*$/i.test(piece.trim())) {
        out.push(trigger.trim());
        trigger = null;
      }
      continue;
    }
    const code = piece.replace(/^\s*--.*$/gm, '').trim();
    if (/^CREATE\s+TRIGGER\b/i.test(code) && !/\bEND\s*$/i.test(code)) trigger = piece;
    else out.push(piece.trim());
  }
  if (trigger !== null) out.push(trigger.trim());
  return out.filter((stmt) => stmt.replace(/^\s*--.*$/gm, '').trim());
}

/** Applies every pending migration. Exported for tests; the Worker uses ensureSchema(). */
export async function migrate(db: D1Database, upTo = MIGRATIONS.length): Promise<void> {
  await db
    .prepare(
      'CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)',
    )
    .run();
  const applied = new Set((await db.prepare('SELECT name FROM d1_migrations').all<{ name: string }>()).results.map((r) => r.name));
  for (const m of MIGRATIONS.slice(0, upTo)) {
    if (applied.has(m.name)) continue;
    const statements = splitSql(m.sql).map((sql) => db.prepare(sql));
    try {
      // One transaction per file: the schema change and its bookkeeping row land together.
      await db.batch([...statements, db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(m.name)]);
    } catch (err) {
      // Another isolate may have applied it at the same moment; only that case is fine.
      if (!(await db.prepare('SELECT 1 FROM d1_migrations WHERE name = ?').bind(m.name).first())) throw err;
    }
  }
}

let ready: Promise<void> | undefined;

/** Runs pending migrations once per isolate; retried on the next request if it failed. */
export function ensureSchema(db: D1Database): Promise<void> {
  ready ??= migrate(db).catch((err) => {
    ready = undefined;
    throw err;
  });
  return ready;
}

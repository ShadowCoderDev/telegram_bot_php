/**
 * Counts what one request costs in D1 – the numbers Cloudflare bills and limits (rows read / rows
 * written, where every index entry counts as a written row). Wraps the D1 binding transparently;
 * the totals are returned in response headers and added to the shop's daily usage row.
 */

export interface D1Usage {
  queries: number;
  rowsRead: number;
  rowsWritten: number;
}

export const emptyUsage = (): D1Usage => ({ queries: 0, rowsRead: 0, rowsWritten: 0 });

function record(usage: D1Usage, meta: D1Meta | undefined) {
  usage.queries++;
  usage.rowsRead += meta?.rows_read ?? 0;
  usage.rowsWritten += meta?.rows_written ?? 0;
}

const REAL = Symbol('real statement');
type Metered = D1PreparedStatement & { [REAL]: D1PreparedStatement };

function meterStatement(stmt: D1PreparedStatement, usage: D1Usage): Metered {
  const metered = {
    [REAL]: stmt,
    bind: (...values: unknown[]) => meterStatement(stmt.bind(...values), usage),
    async run() {
      const r = await stmt.run();
      record(usage, r.meta);
      return r;
    },
    async all() {
      const r = await stmt.all();
      record(usage, r.meta);
      return r;
    },
    // first() hides the metadata, so it is answered from all() – same query, same cost.
    async first(column?: string) {
      const r = await stmt.all<Record<string, unknown>>();
      record(usage, r.meta);
      const row = r.results[0];
      if (!row) return null;
      return column === undefined ? row : (row[column] ?? null);
    },
    raw: (...args: Parameters<D1PreparedStatement['raw']>) => stmt.raw(...args),
  };
  return metered as unknown as Metered;
}

export function meterD1(db: D1Database, usage: D1Usage): D1Database {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') return (sql: string) => meterStatement(target.prepare(sql), usage);
      if (prop === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements.map((s) => (s as Metered)[REAL] ?? s));
          for (const r of results) record(usage, r.meta);
          return results;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

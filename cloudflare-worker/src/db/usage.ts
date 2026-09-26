import type { D1Usage } from './meter';
import { Repository } from './repositories';

/** UTC day number – Cloudflare's daily quotas reset at 00:00 UTC (03:30 in Tehran). */
export const utcDay = (unix: number): number => Math.floor(unix / 86_400);

/** No daily cap (admins, the platform bot, the platform owner's own shop). */
export const UNCAPPED = 1e12;

/** How much of the latest update ids each bot remembers (≈ 40 ids) to skip Telegram's redeliveries. */
const RECENT_CHARS = 480;
/** A capped shop is refused without writing; its counters are still flushed once per this many refusals. */
const DROPPED_FLUSH = 50;

interface Pending {
  written: number;
  read: number;
  dropped: number;
}

/*
 * What a request cost in D1 is known only at its end. It waits here and is added to the shop's usage
 * row by that shop's next update, so measuring costs no extra write. (Kept per isolate: when an
 * isolate is recycled its last few numbers are lost, so the stored counts are a close lower bound.)
 */
const pending = new Map<number, Pending>();

function take(shopId: number): Pending {
  const p = pending.get(shopId) ?? { written: 0, read: 0, dropped: 0 };
  pending.delete(shopId);
  return p;
}

function give(shopId: number, p: Pending) {
  const cur = pending.get(shopId);
  pending.set(shopId, cur ? { written: cur.written + p.written, read: cur.read + p.read, dropped: cur.dropped + p.dropped } : p);
}

/** Adds a finished request's D1 cost to its bot's usage (stored with the bot's next update). */
export const addPendingUsage = (shopId: number, usage: D1Usage) => give(shopId, { written: usage.rowsWritten, read: usage.rowsRead, dropped: 0 });

/** Counts a refused request (flood): Cloudflare still bills it as a Worker request. */
export const addDropped = (shopId: number) => give(shopId, { written: 0, read: 0, dropped: 1 });

/** What a bot may do today (see src/capacity.ts). */
export interface TrackLimits {
  updates: number;
  written: number;
  read: number;
}

export type TrackResult =
  | { status: 'ok'; updates: number }
  | { status: 'duplicate' }
  /** Refused: today's update count reached the limit, or the bot's rows did (the safety net). */
  | { status: 'capped'; updates: number; by: 'updates' | 'rows' };

export interface DayUsage {
  updates: number;
  dropped: number;
  rows_written: number;
  rows_read: number;
}

const NO_USAGE: DayUsage = { updates: 0, dropped: 0, rows_written: 0, rows_read: 0 };

/** Update ids go into the "recent" list as text: D1 binds JS numbers as REAL ("123.0"). */
const idText = (updateId: number) => String(Math.trunc(updateId));

/** One row per bot: redelivery protection, today's usage and the daily cap, in one write per update. */
export class UsageRepository extends Repository {
  /**
   * Records an update: skips it when it was seen already (Telegram redelivers an update when our
   * reply was late), counts it for today, and refuses it once today's updates or rows reached
   * `limits`. Skipped and refused updates write nothing, and the check is atomic, so concurrent
   * deliveries of one update can't both pass.
   */
  async track(updateId: number, now: number, limits: TrackLimits): Promise<TrackResult> {
    const day = utcDay(now);
    const carried = take(this.shopId);
    let row: { updates: number } | null;
    try {
      row = await this.first<{ updates: number }>(
        `INSERT INTO bot_usage (shop_id, recent, last_at, day, updates, dropped, rows_written, rows_read)
         VALUES (?1, ',' || ?2 || ',', ?3, ?4, 1, ?5, ?6, ?7)
         ON CONFLICT (shop_id) DO UPDATE SET
           recent       = substr(',' || ?2 || ',' || substr(bot_usage.recent, 2), 1, ?9),
           last_at      = excluded.last_at,
           updates      = CASE WHEN bot_usage.day = excluded.day THEN bot_usage.updates + 1 ELSE 1 END,
           dropped      = CASE WHEN bot_usage.day = excluded.day THEN bot_usage.dropped ELSE 0 END + excluded.dropped,
           rows_written = CASE WHEN bot_usage.day = excluded.day THEN bot_usage.rows_written ELSE 0 END + excluded.rows_written,
           rows_read    = CASE WHEN bot_usage.day = excluded.day THEN bot_usage.rows_read ELSE 0 END + excluded.rows_read,
           day          = excluded.day
         WHERE instr(bot_usage.recent, ',' || ?2 || ',') = 0
           AND (bot_usage.day != excluded.day
                OR (bot_usage.updates < ?8 AND bot_usage.rows_written < ?10 AND bot_usage.rows_read < ?11))
         RETURNING updates`,
        idText(updateId), now, day, carried.dropped, carried.written, carried.read, limits.updates, RECENT_CHARS, limits.written, limits.read,
      );
    } catch (err) {
      give(this.shopId, carried);
      throw err;
    }
    if (row) return { status: 'ok', updates: row.updates };

    // Nothing was written: a redelivery, or a limit is reached.
    carried.dropped++;
    const state = await this.first<{ seen: number; day: number; updates: number; rows_written: number; rows_read: number }>(
      "SELECT instr(recent, ',' || ?2 || ',') > 0 AS seen, day, updates, rows_written, rows_read FROM bot_usage WHERE shop_id = ?1",
      idText(updateId),
    );
    if (state?.seen) {
      give(this.shopId, carried);
      return { status: 'duplicate' };
    }
    if (carried.dropped >= DROPPED_FLUSH && state?.day === day) {
      await this.run(
        'UPDATE bot_usage SET dropped = dropped + ?2, rows_written = rows_written + ?3, rows_read = rows_read + ?4 WHERE shop_id = ?1 AND day = ?5',
        carried.dropped, carried.written, carried.read, day,
      );
    } else {
      give(this.shopId, carried);
    }
    const byUpdates = !state || state.updates >= limits.updates;
    return { status: 'capped', updates: state?.updates ?? 0, by: byUpdates ? 'updates' : 'rows' };
  }

  /** This bot's counters for today (zeros before its first update of the day). */
  async today(now: number): Promise<DayUsage> {
    const row = await this.first<DayUsage & { day: number }>('SELECT day, updates, dropped, rows_written, rows_read FROM bot_usage WHERE shop_id = ?1');
    return row && row.day === utcDay(now) ? row : { ...NO_USAGE };
  }
}

export interface ShopDayUsage extends DayUsage {
  shop_id: number;
  bot_username: string | null;
}

/** Whole-platform numbers for the capacity page and alarm (all bots, not one shop). */
export class PlatformUsageRepository {
  constructor(private readonly db: D1Database) {}

  /** All bots together on `day`; `shops` counts the shop bots that had updates (the platform bot excluded). */
  async totals(day: number): Promise<DayUsage & { shops: number }> {
    const r = await this.db
      .prepare(
        `SELECT COALESCE(SUM(updates), 0) AS updates, COALESCE(SUM(dropped), 0) AS dropped,
                COALESCE(SUM(rows_written), 0) AS rows_written, COALESCE(SUM(rows_read), 0) AS rows_read,
                COUNT(CASE WHEN shop_id != 0 AND updates > 0 THEN 1 END) AS shops
           FROM bot_usage WHERE day = ?`,
      )
      .bind(day)
      .first<DayUsage & { shops: number }>();
    return r ?? { ...NO_USAGE, shops: 0 };
  }

  /** Size of the whole database in bytes, as D1 reports it after any query. */
  async databaseBytes(): Promise<number> {
    const r = await this.db.prepare('SELECT 1').all();
    return Number((r.meta as { size_after?: number }).size_after ?? 0);
  }

  /** The busiest bots on `day`, most rows written first. */
  top(day: number, limit = 5): Promise<ShopDayUsage[]> {
    return this.db
      .prepare(
        `SELECT u.shop_id, u.updates, u.dropped, u.rows_written, u.rows_read, s.bot_username
           FROM bot_usage u LEFT JOIN shops s ON s.id = u.shop_id
          WHERE u.day = ? ORDER BY u.rows_written DESC, u.updates DESC LIMIT ?`,
      )
      .bind(day, limit)
      .all<ShopDayUsage>()
      .then((r) => r.results);
  }

  /** Totals of each of the `days` days before `day`, newest first (bots idle since then included). */
  history(day: number, days = 7): Promise<(DayUsage & { day: number; shops: number })[]> {
    return this.db
      .prepare(
        `SELECT day, SUM(updates) AS updates, SUM(dropped) AS dropped, SUM(rows_written) AS rows_written, SUM(rows_read) AS rows_read,
                COUNT(CASE WHEN shop_id != 0 AND updates > 0 THEN 1 END) AS shops
           FROM (SELECT day, shop_id, updates, dropped, rows_written, rows_read FROM usage_history WHERE day >= ?1 - ?2 AND day < ?1
                 UNION ALL
                 SELECT day, shop_id, updates, dropped, rows_written, rows_read FROM bot_usage WHERE day >= ?1 - ?2 AND day < ?1)
          GROUP BY day ORDER BY day DESC`,
      )
      .bind(day, days)
      .all<DayUsage & { day: number; shops: number }>()
      .then((r) => r.results);
  }
}

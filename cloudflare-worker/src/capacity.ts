/**
 * Capacity: every seller shop gets a daily cap on the updates its bot handles, so the platform as
 * a whole stays inside Cloudflare's daily quotas. On the free plan, once one quota runs out every
 * query fails until 00:00 UTC (03:30 Tehran), for every shop. The platform owner sees the numbers
 * and gets an alarm long before that happens.
 */
import { ShopRepository, type ShopRow } from './db/platform';
import type { PlatformSettingKey, SettingsRepository } from './db/repositories';
import { PLATFORM_SETTING_DEFAULTS } from './db/repositories';
import { PlatformUsageRepository, UNCAPPED, utcDay, type DayUsage, type ShopDayUsage } from './db/usage';

/** Share of its daily cap after which a shop's admins are warned. */
export const WARN_SHARE = 0.8;
/** A shop's admins may keep working past the cap, up to this many times the cap. */
export const ADMIN_HEADROOM = 2;
/**
 * Safety net: whatever it does, one seller shop may use at most this share of any daily quota
 * (rows written, rows read). Normal use stays far below; it stops unusually costly use (e.g. an
 * admin hammering a heavy page) from taking the platform down.
 */
export const SHOP_MAX_SHARE = 0.2;
/** Share of a quota that raises the second, "critical" alarm. */
export const CRITICAL_SHARE = 0.9;
/**
 * Rows written per update when there is no measurement yet: a typical mix of browsing, buying and
 * admin work, measured by test/capacity.e2e.test.ts at about 1.8 and rounded up (see CAPACITY.md).
 */
export const DEFAULT_WRITES_PER_UPDATE = 2;

export const CAPACITY_KEYS = [
  'trial_daily_limit',
  'paid_daily_limit',
  'platform_daily_limit',
  'alert_percent',
  'quota_requests',
  'quota_writes',
  'quota_reads',
  'quota_storage_mb',
] as const;
export type CapacityKey = (typeof CAPACITY_KEYS)[number];

/** Allowed range of each capacity setting. */
export const CAPACITY_RANGES: Record<CapacityKey, [number, number]> = {
  trial_daily_limit: [50, 1_000_000],
  paid_daily_limit: [50, 1_000_000],
  platform_daily_limit: [100, 1_000_000],
  alert_percent: [10, 85],
  quota_requests: [1_000, 1_000_000_000],
  quota_writes: [1_000, 1_000_000_000],
  quota_reads: [10_000, 100_000_000_000],
  quota_storage_mb: [10, 1_000_000],
};

export interface Quota {
  requests: number;
  writes: number;
  reads: number;
  /** Size of the database, in bytes (free plan: 500 MB per database). */
  storage: number;
}

export interface CapacitySettings {
  trialCap: number;
  paidCap: number;
  /** Updates per day the platform bot handles for non-admins (sellers). */
  platformCap: number;
  /** Alarm threshold, 0–1. */
  alertShare: number;
  quota: Quota;
}

const positive = (raw: string, fallback: string): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : Number(fallback);
};

export function parseCapacitySettings(v: Record<CapacityKey, string>): CapacitySettings {
  const d = PLATFORM_SETTING_DEFAULTS;
  return {
    trialCap: positive(v.trial_daily_limit, d.trial_daily_limit),
    paidCap: positive(v.paid_daily_limit, d.paid_daily_limit),
    platformCap: positive(v.platform_daily_limit, d.platform_daily_limit),
    alertShare: positive(v.alert_percent, d.alert_percent) / 100,
    quota: {
      requests: positive(v.quota_requests, d.quota_requests),
      writes: positive(v.quota_writes, d.quota_writes),
      reads: positive(v.quota_reads, d.quota_reads),
      storage: positive(v.quota_storage_mb, d.quota_storage_mb) * 1024 * 1024,
    },
  };
}

/* Read on every update, so kept for a minute per isolate. */
let cached: { at: number; value: CapacitySettings } | null = null;
const CACHE_MS = 60_000;

export async function capacitySettings(settings: SettingsRepository<PlatformSettingKey>, nowMs = Date.now()): Promise<CapacitySettings> {
  if (cached && nowMs - cached.at < CACHE_MS) return cached.value;
  const value = parseCapacitySettings(await settings.getMany(CAPACITY_KEYS));
  cached = { at: nowMs, value };
  return value;
}

/** Call after the platform owner changes a capacity setting (other isolates catch up within a minute). */
export const forgetCapacitySettings = () => {
  cached = null;
};

/** A shop's daily cap: its own override, else its plan's default. The owner's own shop has none. */
export function dailyCap(shop: Pick<ShopRow, 'plan' | 'daily_limit'>, c: CapacitySettings): number {
  if (shop.plan === 'owner') return UNCAPPED;
  if (shop.daily_limit) return shop.daily_limit;
  return shop.plan === 'paid' ? c.paidCap : c.trialCap;
}

/** What a bot may do today; checked in the same write that counts the update (UsageRepository.track). */
export interface Limits {
  /** Updates per day. */
  updates: number;
  /** D1 rows per day. */
  written: number;
  read: number;
}

export const NO_LIMITS: Limits = { updates: UNCAPPED, written: UNCAPPED, read: UNCAPPED };

/**
 * A shop's limits for one update: customers stop at the daily cap, admins at ADMIN_HEADROOM times
 * it, and nobody past the shop's share of the platform's rows. The owner's own shop has none.
 */
export function shopLimits(shop: Pick<ShopRow, 'plan' | 'daily_limit'>, c: CapacitySettings, isAdmin: boolean): Limits {
  if (shop.plan === 'owner') return NO_LIMITS;
  const cap = dailyCap(shop, c);
  return {
    updates: isAdmin ? cap * ADMIN_HEADROOM : cap,
    written: Math.round(c.quota.writes * SHOP_MAX_SHARE),
    read: Math.round(c.quota.reads * SHOP_MAX_SHARE),
  };
}

/** Which shop alert, if any, the update that brought today's count to `updates` must send. */
export function capAlert(updates: number, cap: number): 'warn' | 'full' | null {
  if (cap >= UNCAPPED) return null;
  if (updates === cap) return 'full';
  return updates === Math.ceil(cap * WARN_SHARE) && updates < cap ? 'warn' : null;
}

/* ------------------------------------------------------------------ */
/* Platform report                                                      */
/* ------------------------------------------------------------------ */

export interface Share {
  used: number;
  quota: number;
  /** used / quota */
  share: number;
}

/** Today's use of each quota: what the hourly alarm checks (a few cheap queries). */
export interface QuotaUsage {
  day: number;
  today: DayUsage & { shops: number };
  requests: Share;
  writes: Share;
  reads: Share;
  /** Database size (not daily: it only grows). */
  storage: Share;
  /** The fullest quota, 0–1+. */
  worst: number;
  /** 0 fine · 1 over the alarm threshold · 2 critical */
  level: 0 | 1 | 2;
  alertShare: number;
}

/** The capacity page: quota use plus what it means for growth. */
export interface CapacityReport extends QuotaUsage {
  /** Measured cost of one update, today (or the last days when today has too little traffic). */
  perUpdate: { writes: number; reads: number; measured: boolean };
  /** Updates that still fit today before the alarm threshold is reached. */
  updatesLeft: number;
  top: ShopDayUsage[];
  history: (DayUsage & { day: number; shops: number })[];
  /** From the busiest of the last days: an average shop's day, and how many more such shops fit. */
  growth: { perShopWrites: number; perShopRequests: number; moreShops: number } | null;
  /** If every open seller shop used its whole daily cap at once (the owner's own shop has no cap). */
  worstCase: { shops: number; updates: number; writes: number; share: number };
}

const share = (used: number, quota: number): Share => ({ used, quota, share: quota > 0 ? used / quota : 0 });
/** Worker requests: handled updates plus refused ones (flood, cap, redelivery). */
const requestsOf = (u: DayUsage) => u.updates + u.dropped;

export async function quotaUsage(db: D1Database, c: CapacitySettings, now: number): Promise<QuotaUsage> {
  const usage = new PlatformUsageRepository(db);
  const day = utcDay(now);
  const [today, bytes] = await Promise.all([usage.totals(day), usage.databaseBytes()]);
  const requests = share(requestsOf(today), c.quota.requests);
  const writes = share(today.rows_written, c.quota.writes);
  const reads = share(today.rows_read, c.quota.reads);
  const storage = share(bytes, c.quota.storage);
  const worst = Math.max(requests.share, writes.share, reads.share, storage.share);
  const level = worst >= CRITICAL_SHARE ? 2 : worst >= c.alertShare ? 1 : 0;
  return { day, today, requests, writes, reads, storage, worst, level, alertShare: c.alertShare };
}

export async function capacityReport(db: D1Database, c: CapacitySettings, now: number): Promise<CapacityReport> {
  const usage = new PlatformUsageRepository(db);
  const [q, top, history, capGroups] = await Promise.all([
    quotaUsage(db, c, now),
    usage.top(utcDay(now)),
    usage.history(utcDay(now)),
    new ShopRepository(db).openCapGroups(now),
  ]);
  const { today, requests, writes, reads } = q;

  // Cost per update: today's traffic if there is enough of it, else the last days'.
  const sample = [today, ...history].reduce(
    (s, d) => (s.updates >= 200 ? s : { updates: s.updates + d.updates, written: s.written + d.rows_written, read: s.read + d.rows_read }),
    { updates: 0, written: 0, read: 0 },
  );
  const perUpdate =
    sample.updates >= 50
      ? { writes: sample.written / sample.updates, reads: sample.read / sample.updates, measured: true }
      : { writes: DEFAULT_WRITES_PER_UPDATE, reads: 10, measured: false };

  const left = (s: Share, perUpdateCost: number) => (perUpdateCost > 0 ? (s.quota * c.alertShare - s.used) / perUpdateCost : Infinity);
  const updatesLeft = Math.max(0, Math.floor(Math.min(left(requests, 1), left(writes, perUpdate.writes), left(reads, perUpdate.reads))));

  // Growth: the busiest recent day, divided by the shops that were active on it.
  const peak = [today, ...history].filter((d) => d.shops > 0).sort((a, b) => b.rows_written - a.rows_written)[0];
  let growth: CapacityReport['growth'] = null;
  if (peak) {
    const perShopWrites = peak.rows_written / peak.shops;
    const perShopRequests = requestsOf(peak) / peak.shops;
    const fit = (quota: number, used: number, perShop: number) => (perShop > 0 ? (quota * c.alertShare - used) / perShop : Infinity);
    const moreShops = Math.max(0, Math.floor(Math.min(fit(c.quota.writes, peak.rows_written, perShopWrites), fit(c.quota.requests, requestsOf(peak), perShopRequests))));
    growth = { perShopWrites, perShopRequests, moreShops };
  }

  const capsTotal = capGroups.reduce((sum, g) => sum + g.shops * dailyCap(g, c), 0);
  const worstWrites = capsTotal * perUpdate.writes;
  const worstCase = {
    shops: capGroups.reduce((sum, g) => sum + g.shops, 0),
    updates: capsTotal,
    writes: worstWrites,
    share: Math.max(worstWrites / c.quota.writes, capsTotal / c.quota.requests),
  };

  return { ...q, perUpdate, updatesLeft, top, history, growth, worstCase };
}

/*
 * In-memory limits: no database writes. A chat that floods is stopped here; the per-shop daily cap
 * (stored in D1) is the hard limit that protects the whole platform.
 *
 * Telegram delivers a bot's updates one at a time (max_connections = 1), so they mostly reach the
 * same isolate and these counters see them. Memory is bounded: the oldest keys are dropped.
 */

const MAX_KEYS = 20_000;

function remember<V>(map: Map<string, V>, key: string, value: V) {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_KEYS) map.delete(map.keys().next().value!);
}

const hits = new Map<string, number[]>();

/** True when `key` made more than `limit` requests within the last `windowSeconds`. */
export function flooding(key: string, limit: number, windowSeconds = 10, now = Date.now()): boolean {
  const since = now - windowSeconds * 1000;
  const recent = (hits.get(key) ?? []).filter((t) => t > since);
  recent.push(now);
  remember(hits, key, recent);
  return recent.length > limit;
}

const notified = new Map<string, number>();

/** True at most once per `windowSeconds` for `key` – for "please slow down"-style replies. */
export function onceEvery(key: string, windowSeconds: number, now = Date.now()): boolean {
  const last = notified.get(key);
  if (last !== undefined && now - last < windowSeconds * 1000) return false;
  remember(notified, key, now);
  return true;
}

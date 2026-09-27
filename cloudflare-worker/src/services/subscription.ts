import type { ShopRow } from '../db/platform';

export const DAY = 86_400;
/** A subscription month. */
export const MONTH = 30 * DAY;
/** After expiry the shop keeps working this long, with warnings, before customers are locked out. */
export const GRACE_DAYS = 3;
/** Months a seller can pay for at once. */
export const RENEW_OPTIONS = [1, 3, 6] as const;

/** ok · grace (expired, still open) · expired (closed to customers) · suspended (by the platform owner). */
export type Access = 'ok' | 'grace' | 'expired' | 'suspended';

export function shopAccess(shop: Pick<ShopRow, 'plan' | 'paid_until' | 'status'>, now: number): Access {
  if (shop.status !== 'active') return 'suspended';
  if (shop.plan === 'owner' || now <= shop.paid_until) return 'ok';
  return now <= shop.paid_until + GRACE_DAYS * DAY ? 'grace' : 'expired';
}

/** Whole days left until paid_until (negative once expired). */
export const daysLeft = (paidUntil: number, now: number): number => Math.ceil((paidUntil - now) / DAY);

/** New expiry after paying `months`: added to the current period, or from now if it already ran out. */
export const extendedUntil = (paidUntil: number, now: number, months: number): number => Math.max(paidUntil, now) + months * MONTH;

/** Days before the data is deleted that the seller gets a last warning. */
export const PURGE_WARNING_DAYS = 7;

/**
 * When a lapsed shop's data is deleted: `retentionDays` after it closed (expiry + grace days).
 * Renewing before then keeps everything.
 */
export const purgeAt = (paidUntil: number, retentionDays: number): number => paidUntil + (GRACE_DAYS + retentionDays) * DAY;

export type ReminderStage = 1 | 2 | 3 | 4;

/**
 * Which expiry reminder is due: 1 = three days before, 2 = expired (grace starts), 3 = closed,
 * 4 = the data is deleted in PURGE_WARNING_DAYS. Each stage is sent once per period
 * (reminder_stage resets on renewal).
 */
export function dueReminder(shop: Pick<ShopRow, 'plan' | 'paid_until' | 'status' | 'reminder_stage'>, now: number, retentionDays: number): 0 | ReminderStage {
  if (shop.plan === 'owner' || shop.status !== 'active') return 0;
  const stage =
    now > purgeAt(shop.paid_until, retentionDays) - PURGE_WARNING_DAYS * DAY
      ? 4
      : now > shop.paid_until + GRACE_DAYS * DAY
        ? 3
        : now > shop.paid_until
          ? 2
          : now > shop.paid_until - 3 * DAY
            ? 1
            : 0;
  return stage > shop.reminder_stage ? stage : 0;
}

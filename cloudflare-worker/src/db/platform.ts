import { extendedUntil } from '../services/subscription';

/*
 * Platform-level tables (not owned by any one shop): the shops themselves and their subscription
 * payments. Only the platform bot and the router use these.
 */

export type ShopPlan = 'owner' | 'trial' | 'paid';
export type ShopStatus = 'active' | 'suspended' | 'deleted';

export interface ShopRow {
  id: number;
  owner_chat_id: number;
  bot_id: number | null;
  bot_username: string;
  bot_token_enc: string;
  webhook_secret: string;
  plan: ShopPlan;
  paid_until: number;
  status: ShopStatus;
  reminder_stage: number;
  created_at: number;
}

export interface SubscriptionPayment {
  id: number;
  shop_id: number;
  payer_chat_id: number;
  months: number;
  amount: number;
  receipt_file_id: string;
  receipt_unique_id: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: number;
  reviewed_at: number | null;
}

abstract class GlobalRepository {
  constructor(protected readonly db: D1Database) {}
  protected all<T>(sql: string, ...args: unknown[]): Promise<T[]> {
    return this.db.prepare(sql).bind(...args).all<T>().then((r) => r.results);
  }
  protected first<T>(sql: string, ...args: unknown[]): Promise<T | null> {
    return this.db.prepare(sql).bind(...args).first<T>();
  }
  protected run(sql: string, ...args: unknown[]): Promise<D1Result> {
    return this.db.prepare(sql).bind(...args).run();
  }
}

export class ShopRepository extends GlobalRepository {
  find(id: number) {
    return this.first<ShopRow>('SELECT * FROM shops WHERE id = ?', id);
  }
  findByBotId(botId: number) {
    return this.first<ShopRow>('SELECT * FROM shops WHERE bot_id = ?', botId);
  }
  /** A seller's shops (deleted ones excluded). */
  listByOwner(ownerChatId: number) {
    return this.all<ShopRow>("SELECT * FROM shops WHERE owner_chat_id = ? AND status != 'deleted' ORDER BY id", ownerChatId);
  }
  async create(s: { ownerChatId: number; botId: number; botUsername: string; tokenEnc: string; webhookSecret: string; paidUntil: number }) {
    const r = await this.run(
      `INSERT INTO shops (owner_chat_id, bot_id, bot_username, bot_token_enc, webhook_secret, plan, paid_until)
       VALUES (?, ?, ?, ?, ?, 'trial', ?)`,
      s.ownerChatId, s.botId, s.botUsername, s.tokenEnc, s.webhookSecret, s.paidUntil,
    );
    return r.meta.last_row_id;
  }
  /** Re-activates a deleted shop of the same bot (the seller came back). */
  revive(id: number, s: { ownerChatId: number; botUsername: string; tokenEnc: string; webhookSecret: string }) {
    return this.run(
      "UPDATE shops SET owner_chat_id = ?, bot_username = ?, bot_token_enc = ?, webhook_secret = ?, status = 'active' WHERE id = ?",
      s.ownerChatId, s.botUsername, s.tokenEnc, s.webhookSecret, id,
    );
  }
  updateToken(id: number, tokenEnc: string, botUsername: string) {
    return this.run('UPDATE shops SET bot_token_enc = ?, bot_username = ? WHERE id = ?', tokenEnc, botUsername, id);
  }
  setStatus(id: number, status: ShopStatus) {
    return this.run('UPDATE shops SET status = ? WHERE id = ?', status, id);
  }
  /** Free days granted by the platform owner. */
  extend(id: number, seconds: number, now: number) {
    return this.run('UPDATE shops SET paid_until = MAX(paid_until, ?) + ?, reminder_stage = 0 WHERE id = ?', now, seconds, id);
  }
  setReminderStage(id: number, stage: number) {
    return this.run('UPDATE shops SET reminder_stage = ? WHERE id = ?', stage, id);
  }
  page(limit: number, offset: number) {
    return this.all<ShopRow>("SELECT * FROM shops WHERE status != 'deleted' ORDER BY id DESC LIMIT ? OFFSET ?", limit, offset);
  }
  async count(): Promise<number> {
    return (await this.first<{ n: number }>("SELECT count(*) AS n FROM shops WHERE status != 'deleted'"))!.n;
  }
  async stats(now: number) {
    return (await this.first<{ total: number; paid: number; trial: number; expired: number; suspended: number }>(
      `SELECT count(*) AS total,
              SUM(plan = 'paid' AND paid_until >= ?1 AND status = 'active') AS paid,
              SUM(plan = 'trial' AND paid_until >= ?1 AND status = 'active') AS trial,
              SUM(plan != 'owner' AND paid_until < ?1 AND status = 'active') AS expired,
              SUM(status = 'suspended') AS suspended
         FROM shops WHERE status != 'deleted'`,
      now,
    ))!;
  }
  /** Shops that may need an expiry reminder (the exact stage is decided in code). */
  reminderCandidates(now: number, limit: number) {
    return this.all<ShopRow>(
      `SELECT * FROM shops WHERE plan != 'owner' AND status = 'active' AND reminder_stage < 3
         AND paid_until < ? ORDER BY paid_until LIMIT ?`,
      now + 3 * 86_400,
      limit,
    );
  }
}

export class SubscriptionPaymentRepository extends GlobalRepository {
  async create(p: { shopId: number; payerChatId: number; months: number; amount: number; fileId: string; uniqueId: string }) {
    try {
      const r = await this.run(
        `INSERT INTO subscription_payments (shop_id, payer_chat_id, months, amount, receipt_file_id, receipt_unique_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        p.shopId, p.payerChatId, p.months, p.amount, p.fileId, p.uniqueId,
      );
      return { ok: true as const, id: r.meta.last_row_id };
    } catch (err) {
      if (/receipt_unique_id/.test(String(err))) return { ok: false as const, reason: 'receipt_reused' as const };
      throw err;
    }
  }
  find(id: number) {
    return this.first<SubscriptionPayment>('SELECT * FROM subscription_payments WHERE id = ?', id);
  }
  async pendingCountForShop(shopId: number): Promise<number> {
    return (await this.first<{ n: number }>("SELECT count(*) AS n FROM subscription_payments WHERE shop_id = ? AND status = 'pending'", shopId))!.n;
  }
  listPending(limit = 20) {
    return this.all<SubscriptionPayment>("SELECT * FROM subscription_payments WHERE status = 'pending' ORDER BY id LIMIT ?", limit);
  }
  async countPending(): Promise<number> {
    return (await this.first<{ n: number }>("SELECT count(*) AS n FROM subscription_payments WHERE status = 'pending'"))!.n;
  }
  forShop(shopId: number, limit = 10) {
    return this.all<SubscriptionPayment>('SELECT * FROM subscription_payments WHERE shop_id = ? ORDER BY id DESC LIMIT ?', shopId, limit);
  }

  /**
   * Approves a pending payment and extends the shop in one transaction. Both statements re-check
   * the payment is still pending, so a double click can't extend twice. Returns the new expiry,
   * or null when the payment was not pending any more.
   */
  async approve(id: number, now: number): Promise<number | null> {
    const payment = await this.find(id);
    if (!payment || payment.status !== 'pending') return null;
    const shop = await this.first<{ paid_until: number }>('SELECT paid_until FROM shops WHERE id = ?', payment.shop_id);
    const until = extendedUntil(shop?.paid_until ?? 0, now, payment.months);
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE shops SET paid_until = ?, plan = 'paid', reminder_stage = 0
            WHERE id = ? AND EXISTS (SELECT 1 FROM subscription_payments WHERE id = ? AND status = 'pending')`,
        )
        .bind(until, payment.shop_id, id),
      this.db.prepare("UPDATE subscription_payments SET status = 'approved', reviewed_at = ? WHERE id = ? AND status = 'pending'").bind(now, id),
    ]);
    return results.at(-1)!.meta.changes > 0 ? until : null;
  }
  async reject(id: number, now: number): Promise<boolean> {
    const r = await this.run("UPDATE subscription_payments SET status = 'rejected', reviewed_at = ? WHERE id = ? AND status = 'pending'", now, id);
    return r.meta.changes > 0;
  }
  async revenue(since: number): Promise<number> {
    const r = await this.first<{ s: number | null }>(
      "SELECT SUM(amount) AS s FROM subscription_payments WHERE status = 'approved' AND reviewed_at >= ?",
      since,
    );
    return r?.s ?? 0;
  }
}

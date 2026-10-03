
/** One booked slot whose reminder is due, with what is needed to send it. */
export interface DueReminder {
  shop_id: number;
  order_id: number;
  category_id: number;
  slot_at: number;
  chat_id: number;
  track_id: string;
  label: string;
  category_name: string;
  category_icon: string;
  shop_name: string;
  bot_username: string;
  plan: string;
  bot_token_enc: string;
}

/** The longest reminder lead a seller can choose (minutes): bounds the lookup range. */
export const MAX_REMIND_MINUTES = 2880;

/**
 * Appointment reminders across all shops (the cron's view). A slot is due when its reminder time
 * has come and the slot has not started; it is claimed with one conditional UPDATE, so a reminder
 * goes out at most once even if two runs overlap.
 */
export class ReminderRepository {
  constructor(private readonly db: D1Database) {}

  /**
   * Paid bookings of open shops whose reminder time has come, soonest first. A booking made after
   * its own reminder time (a same-day appointment) is not reminded: the customer just chose it.
   */
  async due(now: number, limit: number): Promise<DueReminder[]> {
    const r = await this.db
      .prepare(
        `SELECT s.shop_id, s.order_id, s.category_id, s.slot_at, o.user_chat_id AS chat_id, o.track_id,
                cs.label, COALESCE(c.name, '') AS category_name, COALESCE(c.icon, '') AS category_icon,
                COALESCE(st.setting_value, '') AS shop_name, sh.bot_username, sh.plan, sh.bot_token_enc
           FROM order_slots s
           JOIN orders o ON o.id = s.order_id AND o.shop_id = s.shop_id
           JOIN category_schedules cs ON cs.shop_id = s.shop_id AND cs.category_id = s.category_id
           JOIN shops sh ON sh.id = s.shop_id
           LEFT JOIN categories c ON c.shop_id = s.shop_id AND c.id = s.category_id
           LEFT JOIN settings st ON st.shop_id = s.shop_id AND st.setting_key = 'shop_name'
          WHERE s.reminded_at = 0 AND s.slot_at > ?1 AND s.slot_at <= ?1 + ?2
            AND cs.remind_minutes > 0 AND s.slot_at - cs.remind_minutes * 60 <= ?1
            AND o.status IN ('payed','approved','sending') AND o.time < s.slot_at - cs.remind_minutes * 60
            AND sh.status = 'active' AND (sh.plan = 'owner' OR sh.paid_until >= ?1)
          ORDER BY s.slot_at LIMIT ?3`,
      )
      .bind(now, MAX_REMIND_MINUTES * 60, limit)
      .all<DueReminder>();
    return r.results;
  }

  /** True for the one run that gets to send this reminder. */
  async claim(orderId: number, categoryId: number, now: number): Promise<boolean> {
    const r = await this.db
      .prepare('UPDATE order_slots SET reminded_at = ?3 WHERE order_id = ?1 AND category_id = ?2 AND reminded_at = 0')
      .bind(orderId, categoryId, now)
      .run();
    return r.meta.changes > 0;
  }
}

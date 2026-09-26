export interface Env {
  DB: D1Database;
  /** Optional archive for receipts. Photos (receipts, products) are always kept as Telegram file_ids. */
  FILES?: R2Bucket;
  /** Secret: token from @BotFather. */
  BOT_TOKEN: string;
  /** Secret: echoed by Telegram in X-Telegram-Bot-Api-Secret-Token on every webhook call. */
  WEBHOOK_SECRET: string;
  /** Comma-separated numeric chat ids. */
  ADMIN_CHAT_IDS: string;
  TELEGRAM_API_BASE?: string;
  /** Max updates per chat in 10 seconds before the bot stops answering that chat (default 30). */
  FLOOD_LIMIT?: string;
}

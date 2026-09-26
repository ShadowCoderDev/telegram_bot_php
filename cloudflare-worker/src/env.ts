export interface Env {
  DB: D1Database;
  /** Optional archive for receipts. Photos (receipts, products) are always kept as Telegram file_ids. */
  FILES?: R2Bucket;

  /* ---- The platform owner's own shop (shop 1), served at /webhook ---- */
  /** Secret: token of the owner's own shop bot. Optional on a pure SaaS deployment. */
  BOT_TOKEN?: string;
  /** Secret: webhook secret of the owner's shop; also its /claim code. */
  WEBHOOK_SECRET?: string;
  /** Comma-separated numeric chat ids of the owner's shop admins. */
  ADMIN_CHAT_IDS?: string;

  /* ---- SaaS platform ---- */
  /** Secret: token of the platform bot sellers use to create and renew shops (served at /platform). */
  PLATFORM_BOT_TOKEN?: string;
  /** Secret, 32+ chars: encrypts sellers' bot tokens and derives webhook secrets and /claim codes. Never change it. */
  MASTER_KEY?: string;
  /** Comma-separated chat ids of platform admins (who approve payments). Or use /claim <MASTER_KEY> in the platform bot. */
  PLATFORM_ADMIN_IDS?: string;

  TELEGRAM_API_BASE?: string;
  /** Max updates per chat in 10 seconds before the bot stops answering that chat (default 30). */
  FLOOD_LIMIT?: string;
}

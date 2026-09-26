-- Fewer rows written per Telegram update (D1 bills every row and every index entry written).
-- Measured before this migration: ~3 writes per update just to remember processed update ids, and
-- ~3 more when they were pruned. Now: 1 write per update, which also counts the shop's daily usage.
--
-- processed_updates is no longer used but is kept for now: the Worker that is still running while a
-- deploy applies this migration writes to it. A later migration drops it.

-- One row per bot (shop_id 0 = the platform bot).
CREATE TABLE bot_usage (
  shop_id      INTEGER PRIMARY KEY,
  recent       TEXT    NOT NULL DEFAULT '',  -- ",id,id,…": the latest update ids, to skip redeliveries
  last_at      INTEGER NOT NULL DEFAULT 0,   -- time of the latest update
  day          INTEGER NOT NULL DEFAULT 0,   -- UTC day number; Cloudflare's daily quotas reset at 00:00 UTC
  updates      INTEGER NOT NULL DEFAULT 0,   -- updates handled today (what the daily cap counts)
  dropped      INTEGER NOT NULL DEFAULT 0,   -- refused today (flood, cap, redelivery): still Worker requests
  rows_written INTEGER NOT NULL DEFAULT 0,   -- D1 rows this bot wrote today, as Cloudflare counts them
  rows_read    INTEGER NOT NULL DEFAULT 0
);

-- Daily totals of past days, for the capacity report.
CREATE TABLE usage_history (
  day          INTEGER NOT NULL,
  shop_id      INTEGER NOT NULL,
  updates      INTEGER NOT NULL,
  dropped      INTEGER NOT NULL,
  rows_written INTEGER NOT NULL,
  rows_read    INTEGER NOT NULL,
  PRIMARY KEY (day, shop_id)
) WITHOUT ROWID;

-- When a bot's first update of a new day resets its counters, keep yesterday's numbers.
CREATE TRIGGER bot_usage_rollover BEFORE UPDATE OF day ON bot_usage
WHEN NEW.day != OLD.day AND (OLD.updates > 0 OR OLD.dropped > 0)
BEGIN
  INSERT INTO usage_history (day, shop_id, updates, dropped, rows_written, rows_read)
  VALUES (OLD.day, OLD.shop_id, OLD.updates, OLD.dropped, OLD.rows_written, OLD.rows_read)
  ON CONFLICT (day, shop_id) DO NOTHING;
END;

-- Per-shop override of the daily cap (NULL = the plan's default from the platform settings).
ALTER TABLE shops ADD COLUMN daily_limit INTEGER;

-- Indexes: each one costs a written row on every insert (and on updates of its columns).
DROP INDEX idx_products_category;      -- superseded by idx_products_shop (shop_id, category_id)
DROP INDEX idx_orders_user_status;     -- status changes updated two indexes
CREATE INDEX idx_orders_shop_user ON orders(shop_id, user_id);

-- Composite-key tables without a hidden rowid: an insert writes 1 row instead of 2.
CREATE TABLE sessions_new (
  shop_id    INTEGER NOT NULL DEFAULT 1,
  chat_id    INTEGER NOT NULL,
  flow       TEXT    NOT NULL,
  step       TEXT    NOT NULL,
  data       TEXT    NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (shop_id, chat_id)
) WITHOUT ROWID;
INSERT INTO sessions_new SELECT shop_id, chat_id, flow, step, data, updated_at FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;

CREATE TABLE settings_new (
  shop_id       INTEGER NOT NULL DEFAULT 1,
  setting_key   TEXT    NOT NULL,
  setting_value TEXT    NOT NULL,
  PRIMARY KEY (shop_id, setting_key)
) WITHOUT ROWID;
INSERT INTO settings_new SELECT shop_id, setting_key, setting_value FROM settings;
DROP TABLE settings;
ALTER TABLE settings_new RENAME TO settings;

CREATE TABLE dialogs_new (
  shop_id       INTEGER NOT NULL DEFAULT 1,
  buyer_chat_id INTEGER NOT NULL,
  admin_chat_id INTEGER NOT NULL,
  order_id      INTEGER NOT NULL,
  PRIMARY KEY (shop_id, buyer_chat_id)
) WITHOUT ROWID;
INSERT INTO dialogs_new SELECT shop_id, buyer_chat_id, admin_chat_id, order_id FROM dialogs;
DROP TABLE dialogs;
ALTER TABLE dialogs_new RENAME TO dialogs;

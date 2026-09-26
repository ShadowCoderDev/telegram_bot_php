-- Multi-tenant (SaaS): one Worker and one database serve many shops, each with its own bot.
-- Everything that existed before becomes shop 1 (the platform owner's own shop). shop_id 0 is
-- reserved for the platform bot's own settings, sessions and update log.

-- Tables are rebuilt below; foreign keys are checked at commit instead of per statement.
PRAGMA defer_foreign_keys = true;

CREATE TABLE shops (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_chat_id  INTEGER NOT NULL,           -- the seller; always an admin of the shop
  bot_id         INTEGER UNIQUE,             -- Telegram id of the shop's bot (getMe)
  bot_username   TEXT    NOT NULL DEFAULT '',
  bot_token_enc  TEXT    NOT NULL DEFAULT '', -- AES-GCM with MASTER_KEY; empty for shop 1 (uses BOT_TOKEN)
  webhook_secret TEXT    NOT NULL DEFAULT '',
  plan           TEXT    NOT NULL DEFAULT 'trial' CHECK (plan IN ('owner', 'trial', 'paid')),
  paid_until     INTEGER NOT NULL DEFAULT 0,  -- unix time the subscription (or trial) runs out
  status         TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  reminder_stage INTEGER NOT NULL DEFAULT 0,  -- expiry reminders already sent for this period
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_shops_owner ON shops(owner_chat_id);
INSERT INTO shops (id, owner_chat_id, plan) VALUES (1, 0, 'owner');

-- Monthly subscription payments (card-to-card receipts reviewed by the platform owner).
CREATE TABLE subscription_payments (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id           INTEGER NOT NULL REFERENCES shops(id),
  payer_chat_id     INTEGER NOT NULL,
  months            INTEGER NOT NULL CHECK (months > 0),
  amount            INTEGER NOT NULL,
  receipt_file_id   TEXT    NOT NULL,
  receipt_unique_id TEXT    NOT NULL UNIQUE,
  status            TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  reviewed_at       INTEGER
);
CREATE INDEX idx_subscription_payments_status ON subscription_payments(status, shop_id);

-- Simple tables: a shop_id column (existing rows belong to shop 1).
ALTER TABLE categories    ADD COLUMN shop_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE products      ADD COLUMN shop_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE orders        ADD COLUMN shop_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE order_items   ADD COLUMN shop_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE order_details ADD COLUMN shop_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE faqs          ADD COLUMN shop_id INTEGER NOT NULL DEFAULT 1;

CREATE INDEX idx_categories_shop ON categories(shop_id);
CREATE INDEX idx_products_shop ON products(shop_id, category_id);
CREATE INDEX idx_orders_shop ON orders(shop_id, status);
CREATE INDEX idx_faqs_shop ON faqs(shop_id);

-- A receipt can back one order per shop (different shops are different businesses).
DROP INDEX idx_order_details_receipt;
CREATE UNIQUE INDEX idx_order_details_receipt ON order_details(shop_id, receipt_unique_id) WHERE receipt_unique_id IS NOT NULL;

-- Tables whose unique keys become per shop are rebuilt.

-- users: the same Telegram user is a separate customer in every shop.
-- users is the parent of orders.user_id, so it is recreated under its own name: re-inserting the
-- rows into "users" is what clears the deferred foreign-key violations the DROP creates.
CREATE TABLE users_backup AS SELECT id, chat_id, name, username, status, created_at FROM users;
DROP TABLE users;
CREATE TABLE users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id    INTEGER NOT NULL DEFAULT 1,
  chat_id    INTEGER NOT NULL,
  name       TEXT    NOT NULL DEFAULT '',
  username   TEXT    NOT NULL DEFAULT '',
  status     TEXT    NOT NULL DEFAULT 'enable',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (shop_id, chat_id)
);
INSERT INTO users (id, shop_id, chat_id, name, username, status, created_at)
  SELECT id, 1, chat_id, name, username, status, created_at FROM users_backup;
DROP TABLE users_backup;

CREATE TABLE settings_new (
  shop_id       INTEGER NOT NULL DEFAULT 1,
  setting_key   TEXT    NOT NULL,
  setting_value TEXT    NOT NULL,
  PRIMARY KEY (shop_id, setting_key)
);
INSERT INTO settings_new (shop_id, setting_key, setting_value) SELECT 1, setting_key, setting_value FROM settings;
DROP TABLE settings;
ALTER TABLE settings_new RENAME TO settings;

CREATE TABLE sessions_new (
  shop_id    INTEGER NOT NULL DEFAULT 1,
  chat_id    INTEGER NOT NULL,
  flow       TEXT    NOT NULL,
  step       TEXT    NOT NULL,
  data       TEXT    NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (shop_id, chat_id)
);
INSERT INTO sessions_new (shop_id, chat_id, flow, step, data, updated_at)
  SELECT 1, chat_id, flow, step, data, updated_at FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;

CREATE TABLE dialogs_new (
  shop_id       INTEGER NOT NULL DEFAULT 1,
  buyer_chat_id INTEGER NOT NULL,
  admin_chat_id INTEGER NOT NULL,
  order_id      INTEGER NOT NULL,
  PRIMARY KEY (shop_id, buyer_chat_id)
);
INSERT INTO dialogs_new (shop_id, buyer_chat_id, admin_chat_id, order_id)
  SELECT 1, buyer_chat_id, admin_chat_id, order_id FROM dialogs;
DROP TABLE dialogs;
ALTER TABLE dialogs_new RENAME TO dialogs;

-- update_id is only unique per bot.
CREATE TABLE processed_updates_new (
  shop_id   INTEGER NOT NULL DEFAULT 1,
  update_id INTEGER NOT NULL,
  chat_id   INTEGER NOT NULL,
  at        INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (shop_id, update_id)
);
INSERT INTO processed_updates_new (shop_id, update_id, chat_id, at)
  SELECT 1, update_id, chat_id, at FROM processed_updates;
DROP TABLE processed_updates;
ALTER TABLE processed_updates_new RENAME TO processed_updates;
CREATE INDEX idx_processed_updates_chat ON processed_updates(shop_id, chat_id, at);

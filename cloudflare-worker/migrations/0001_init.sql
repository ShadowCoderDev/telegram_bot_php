-- D1 (SQLite) schema. Mirrors the MySQL tables used by the PHP bot, with the
-- conversation-state tables simplified to one row per chat.

CREATE TABLE users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    INTEGER NOT NULL UNIQUE,
  name       TEXT    NOT NULL DEFAULT '',
  status     TEXT    NOT NULL DEFAULT 'enable',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE categories (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL,
  icon   TEXT NOT NULL DEFAULT '📂',
  status TEXT NOT NULL DEFAULT 'enable' CHECK (status IN ('enable', 'disable'))
);

CREATE TABLE products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER REFERENCES categories(id),
  title       TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  price       INTEGER NOT NULL DEFAULT 0,
  author      TEXT    NOT NULL DEFAULT '',
  image_url   TEXT    NOT NULL DEFAULT '',
  -- The CHECK makes an over-selling UPDATE fail, which rolls back the whole
  -- D1 batch it belongs to (see OrderService.approve).
  inventory   INTEGER NOT NULL DEFAULT 0 CHECK (inventory >= 0),
  status      TEXT    NOT NULL DEFAULT 'enable' CHECK (status IN ('enable', 'disable'))
);
CREATE INDEX idx_products_category ON products(category_id);

CREATE TABLE orders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  user_chat_id INTEGER NOT NULL,
  track_id     TEXT    NOT NULL UNIQUE,
  status       TEXT    NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'payed', 'approved', 'rejected', 'cancel', 'sending')),
  -- 1 while stock for this order has been taken out of inventory.
  stock_taken  INTEGER NOT NULL DEFAULT 0,
  time         INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_orders_user_status ON orders(user_id, status);

CREATE TABLE order_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id    INTEGER NOT NULL REFERENCES products(id),
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  -- Snapshot taken at payment time so later price edits don't change old orders.
  price         INTEGER,
  product_title TEXT,
  UNIQUE (order_id, product_id)
);

CREATE TABLE order_details (
  order_id         INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  first_name       TEXT NOT NULL,
  last_name        TEXT NOT NULL,
  address          TEXT NOT NULL,
  phone_number     TEXT NOT NULL,
  receipt_file_id  TEXT,            -- Telegram file_id, re-sendable without re-upload
  receipt_r2_key   TEXT             -- archived copy in R2 (optional)
);

CREATE TABLE faqs (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  answer   TEXT NOT NULL,
  status   TEXT NOT NULL DEFAULT 'enable' CHECK (status IN ('enable', 'disable'))
);

CREATE TABLE settings (
  setting_key   TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL
);

-- One multi-step flow per chat (checkout, add_product, edit_setting, ...).
-- Replaces both user_checkout_state and admin_process_state.
CREATE TABLE sessions (
  chat_id    INTEGER PRIMARY KEY,
  flow       TEXT    NOT NULL,
  step       TEXT    NOT NULL,
  data       TEXT    NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Open admin <-> buyer conversations, keyed by the buyer.
CREATE TABLE dialogs (
  buyer_chat_id INTEGER PRIMARY KEY,
  admin_chat_id INTEGER NOT NULL,
  order_id      INTEGER NOT NULL
);

INSERT INTO settings (setting_key, setting_value) VALUES
  ('help_text', 'راهنما هنوز تنظیم نشده است.'),
  ('support',   'پشتیبانی تنظیم نشده'),
  ('bank_info', 'شماره کارت هنوز تنظیم نشده است.');

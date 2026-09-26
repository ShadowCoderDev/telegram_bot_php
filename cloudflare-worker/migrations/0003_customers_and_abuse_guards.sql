-- Customer list: remember the Telegram @username (users.status = 'disable' now means blocked).
ALTER TABLE users ADD COLUMN username TEXT NOT NULL DEFAULT '';

-- The same receipt photo (same Telegram file_unique_id) can't be submitted for two orders.
ALTER TABLE order_details ADD COLUMN receipt_unique_id TEXT;
CREATE UNIQUE INDEX idx_order_details_receipt ON order_details(receipt_unique_id) WHERE receipt_unique_id IS NOT NULL;

-- Every update is recorded once: Telegram retries are ignored and per-chat flooding is throttled.
CREATE TABLE processed_updates (
  update_id INTEGER PRIMARY KEY,
  chat_id   INTEGER NOT NULL,
  at        INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_processed_updates_chat ON processed_updates(chat_id, at);

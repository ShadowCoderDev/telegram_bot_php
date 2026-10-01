-- Order scheduling: a category can ask the customer to pick a day and time (delivery, pickup,
-- an appointment). A slot can hold a limited number of orders.
CREATE TABLE category_schedules (
  shop_id      INTEGER NOT NULL,
  category_id  INTEGER NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  label        TEXT    NOT NULL DEFAULT 'زمان',  -- "زمان نوبت", "زمان تحویل"…
  days         INTEGER NOT NULL DEFAULT 127,     -- bit i = weekday i, Saturday = 0
  times        TEXT    NOT NULL DEFAULT '',      -- "16:00,16:30,…", Tehran time
  capacity     INTEGER NOT NULL DEFAULT 0,       -- orders per slot; 0 = unlimited
  lead_minutes INTEGER NOT NULL DEFAULT 60,      -- earliest booking: this long from now
  horizon_days INTEGER NOT NULL DEFAULT 7,       -- bookable this many days ahead, today included
  PRIMARY KEY (shop_id, category_id)
) WITHOUT ROWID;

-- The slot an order picked for a category. A pending order holds its slot until hold_until; a paid
-- one keeps it for good (counted by the order's status), a rejected or cancelled one frees it.
CREATE TABLE order_slots (
  shop_id     INTEGER NOT NULL,
  order_id    INTEGER NOT NULL,
  category_id INTEGER NOT NULL,
  slot_at     INTEGER NOT NULL,                  -- unix time of the slot start
  hold_until  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (order_id, category_id)
) WITHOUT ROWID;
CREATE INDEX idx_order_slots_slot ON order_slots(shop_id, category_id, slot_at);

-- Inline mode: shops whose webhook was registered before it existed are re-registered (with the
-- inline_query update type) the next time they receive an update.
ALTER TABLE shops ADD COLUMN hook_version INTEGER NOT NULL DEFAULT 0;

-- Inline queries are Worker requests too; counted in the usage rows (flushed in batches).
ALTER TABLE bot_usage ADD COLUMN inline INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_history ADD COLUMN inline INTEGER NOT NULL DEFAULT 0;
DROP TRIGGER bot_usage_rollover;
CREATE TRIGGER bot_usage_rollover BEFORE UPDATE OF day ON bot_usage
WHEN NEW.day != OLD.day AND (OLD.updates > 0 OR OLD.dropped > 0 OR OLD.inline > 0)
BEGIN
  INSERT INTO usage_history (day, shop_id, updates, dropped, inline, rows_written, rows_read)
  VALUES (OLD.day, OLD.shop_id, OLD.updates, OLD.dropped, OLD.inline, OLD.rows_written, OLD.rows_read)
  ON CONFLICT (day, shop_id) DO NOTHING;
END;

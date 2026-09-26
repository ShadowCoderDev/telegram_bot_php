-- Admin pages whose reads grew with the size of the shop. Measured by test/capacity.e2e.test.ts in a
-- shop with 5,000 customers and 20,000 orders: the orders list read 55,000 rows, the customers list
-- 145,000 and the stats page 50,000 – on every view. Now each reads about one page of rows.

-- Orders newest first, and a day's or a month's sales, without reading the shop's whole history.
CREATE INDEX idx_orders_shop_time ON orders(shop_id, time);

-- Customers "by last activity": stored on the customer (set when they place an order) instead of
-- computed from all of their orders for every customer on every page view.
ALTER TABLE users ADD COLUMN last_activity INTEGER NOT NULL DEFAULT 0;
UPDATE users SET last_activity = COALESCE(
  (SELECT MAX(o.time) FROM orders o WHERE o.shop_id = users.shop_id AND o.user_id = users.id AND o.status NOT IN ('pending', 'cancel')),
  created_at);
CREATE INDEX idx_users_activity ON users(shop_id, last_activity);

-- Customer search: a tracking code is found through its unique index, and a phone number among
-- this shop's orders only (it used to look at every order of every customer).
CREATE INDEX idx_order_details_phone ON order_details(shop_id, phone_number);

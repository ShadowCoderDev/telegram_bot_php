-- Appointment reminders: a customer with a booked slot is reminded a while before it.
-- remind_minutes: how long before the slot (0 = no reminder). reminded_at: when it was sent (0 = not yet).
ALTER TABLE category_schedules ADD COLUMN remind_minutes INTEGER NOT NULL DEFAULT 60;
ALTER TABLE order_slots ADD COLUMN reminded_at INTEGER NOT NULL DEFAULT 0;
-- Only slots still waiting for their reminder are indexed, so the cron's lookup stays tiny.
CREATE INDEX idx_order_slots_due ON order_slots(slot_at) WHERE reminded_at = 0;

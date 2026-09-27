-- A shop whose subscription ran out is closed; its data is kept for the platform's retention period
-- (platform setting retention_days) and then deleted. purged_at records when that happened.
ALTER TABLE shops ADD COLUMN purged_at INTEGER;

-- Product photos uploaded by the admin are kept as Telegram file_ids: Telegram stores the file,
-- so no R2 bucket is needed. image_url remains for images given as links.
ALTER TABLE products ADD COLUMN image_file_id TEXT NOT NULL DEFAULT '';

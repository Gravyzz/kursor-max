-- 006: администратор возвращает страницу с проверки на доработку с причиной (APP-11).
-- Причина видна в редакторе, пока страницу не отправят на проверку снова или не опубликуют.
ALTER TABLE pages ADD COLUMN IF NOT EXISTS return_note text;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS returned_at timestamptz;

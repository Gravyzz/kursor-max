-- 003: вопрос дежурному из чата больше не создаёт заготовку заранее.
-- Ожидание текста вопроса хранится в kv (ключ hbq:<user_id>, 15 минут), поэтому столбец не нужен.
ALTER TABLE handbook_readers DROP COLUMN IF EXISTS pending_question_id;

-- Заготовки «Вопрос из чата», которые так и не дописали, не должны висеть в очереди дежурного
DELETE FROM handbook_questions WHERE status = 'open' AND text = 'Вопрос из чата';

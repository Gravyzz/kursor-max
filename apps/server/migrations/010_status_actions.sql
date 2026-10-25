-- Отметка «не помогла» должна сниматься, когда страницу исправили. Счётчики оценок копятся за всё время,
-- поэтому при каждой публикации запоминаем, сколько оценок было: «свежие» оценки — те, что пришли после.
ALTER TABLE pages
  ADD COLUMN helpful_before integer NOT NULL DEFAULT 0,
  ADD COLUMN not_helpful_before integer NOT NULL DEFAULT 0;

-- Уточнение к общей странице, которое редактор отправил администратору факультета на публикацию.
ALTER TABLE page_supplements
  ADD COLUMN review_requested_at timestamptz,
  ADD COLUMN review_requested_by uuid REFERENCES persons(id) ON DELETE SET NULL,
  ADD COLUMN review_note text;

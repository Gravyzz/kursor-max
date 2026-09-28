-- 005: правки опубликованной страницы уходят на проверку, не снимая страницу с публикации.
-- Раньше «На проверку» ставило status = 'review', и страница пропадала у студентов, из поиска и напоминаний.
ALTER TABLE pages ADD COLUMN review_requested_at timestamptz;
UPDATE pages SET review_requested_at = updated_at WHERE status = 'review';
-- Страницы, которые уже были опубликованы и попали на проверку прежним кодом, возвращаются студентам
UPDATE pages SET status = 'published' WHERE status = 'review' AND published_at IS NOT NULL;

-- Читатель без тегов видит всё, как и без курса или общежития — так же, как audienceMatches в коде.
-- Раньше пустой массив тегов прятал адресные страницы и объявления из поиска и рассылки.
CREATE OR REPLACE FUNCTION audience_matches(a jsonb, p_course int, p_dorm boolean, p_tags text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    (a->'courses' IS NULL OR jsonb_array_length(a->'courses') = 0 OR p_course IS NULL
       OR (a->'courses') @> to_jsonb(p_course))
    AND (a->'dorm' IS NULL OR p_dorm IS NULL OR (a->>'dorm')::boolean = p_dorm)
    AND (a->'tags' IS NULL OR jsonb_array_length(a->'tags') = 0 OR p_tags IS NULL OR cardinality(p_tags) = 0
       OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(a->'tags') t WHERE t = ANY(p_tags)));
$$;

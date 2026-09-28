-- 007: в записи срока — только аудитория самого блока «Срок» (WRK-2).
-- Раньше туда копировалась аудитория страницы, и её смена не доходила до календаря и напоминаний.
-- Аудитории страницы и раздела теперь проверяются при выдаче календаря и постановке напоминаний.
UPDATE handbook_deadlines d
   SET audience = COALESCE((
         SELECT b->'audience'
           FROM pages p
          CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(p.blocks) = 'array' THEN p.blocks ELSE '[]'::jsonb END) b
          WHERE p.id = d.page_id AND b->>'id' = d.block_id AND jsonb_typeof(b->'audience') = 'object'
          LIMIT 1), '{}'::jsonb);

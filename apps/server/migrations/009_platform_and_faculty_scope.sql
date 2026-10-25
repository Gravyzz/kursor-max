-- Общая страница может быть не для всех факультетов: NULL — для всех, иначе — только для перечисленных институтов.
-- Справочник факультета, которого нет в списке, не показывает страницу ни в разделах, ни в поиске, ни в сроках.
ALTER TABLE pages ADD COLUMN institute_ids uuid[];

-- Видна ли страница в справочнике: свои страницы и общие «для всех» — да, общие с выбором — только выбранным факультетам
CREATE OR REPLACE FUNCTION page_for_handbook(p_institutes uuid[], p_handbook uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT p_institutes IS NULL
      OR EXISTS (SELECT 1 FROM handbooks h WHERE h.id = p_handbook AND h.institute_id = ANY(p_institutes));
$$;

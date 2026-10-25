-- Закрыть справочник или отключить факультет — не удалить сразу: 90 дней всё можно вернуть одним нажатием,
-- потом worker удаляет закрытые справочники насовсем. Студенты закрытый справочник не видят с первой минуты.
ALTER TABLE handbooks
  ADD COLUMN closed_at timestamptz,
  ADD COLUMN closed_by uuid REFERENCES persons(id) ON DELETE SET NULL,
  -- Справочник закрыт вместе с факультетом: вернётся, когда факультет восстановят
  ADD COLUMN closed_with_faculty boolean NOT NULL DEFAULT false;

ALTER TABLE institutes
  ADD COLUMN closed_at timestamptz,
  ADD COLUMN closed_by uuid REFERENCES persons(id) ON DELETE SET NULL,
  -- Справочники удалены по истечении срока хранения: восстановить факультет уже нельзя
  ADD COLUMN purged_at timestamptz;

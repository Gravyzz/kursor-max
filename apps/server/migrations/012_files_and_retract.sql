-- 012: файл в блоке «Файл» загружается в приложение, а не вставляется ссылкой;
-- рассылку удалённого объявления бот убирает и из чатов.

-- Файлы справочника. Отдаются по случайному id (/api/files/<id>), удаляются вместе со справочником,
-- а незакреплённые ни в одной странице — через двое суток после загрузки.
CREATE TABLE handbook_files (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handbook_id uuid NOT NULL REFERENCES handbooks(id) ON DELETE CASCADE,
  name        text NOT NULL,
  mime        text NOT NULL,
  size        integer NOT NULL CHECK (size > 0 AND size <= 10485760),
  data        bytea NOT NULL,
  uploaded_by uuid REFERENCES persons(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX handbook_files_handbook_idx ON handbook_files(handbook_id);

-- Отзыв отправленного сообщения: объявление удалили — бот удаляет его сообщение у каждого читателя
ALTER TABLE notifications
  ADD COLUMN retract_requested_at timestamptz,
  ADD COLUMN retracted_at timestamptz,
  ADD COLUMN retract_attempts integer NOT NULL DEFAULT 0;
CREATE INDEX notifications_retract_idx ON notifications(retract_requested_at)
  WHERE retract_requested_at IS NOT NULL AND retracted_at IS NULL;

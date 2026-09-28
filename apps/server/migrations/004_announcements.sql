-- 004: объявления — правка и удаление администратором, «прочитано» у читателя.
-- Прочитанное объявление уходит с главной в архив объявлений читателя.
ALTER TABLE announcements ADD COLUMN updated_at timestamptz;

CREATE TABLE announcement_reads (
  announcement_id uuid NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  reader_id       uuid NOT NULL REFERENCES handbook_readers(id) ON DELETE CASCADE,
  read_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (announcement_id, reader_id)
);
CREATE INDEX announcement_reads_reader_idx ON announcement_reads(reader_id);

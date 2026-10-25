-- 008: общая база университета как управляемый слой.
-- Роли университета и факультета — назначения, а не поле записи вуза; уточнение факультета к общей странице;
-- явная «своя версия» с номером общей версии, из которой она создана; ответственный и срок проверки.

-- Назначения: администратор университета (весь вуз) и администратор факультета (один институт).
-- Право выдаётся и отзывается отдельно от записи человека: одна запись может вести несколько институтов.
CREATE TABLE org_roles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id     uuid NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  university_id uuid NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  institute_id  uuid REFERENCES institutes(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('university_admin', 'faculty_admin')),
  granted_by    uuid REFERENCES persons(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  CHECK ((role = 'university_admin') = (institute_id IS NULL))
);
CREATE UNIQUE INDEX org_roles_active_uq
  ON org_roles(person_id, role, COALESCE(institute_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE revoked_at IS NULL;
CREATE INDEX org_roles_university_idx ON org_roles(university_id) WHERE revoked_at IS NULL;

-- Деканат института становится администратором факультета. Правило «деканат по должности» пока остаётся в коде.
INSERT INTO org_roles(person_id, university_id, institute_id, role)
SELECT p.id, p.university_id, p.institute_id, 'faculty_admin'
  FROM persons p
 WHERE p.role = 'dean' AND p.institute_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- Версии публикаций: номер растёт при каждой публикации, своя версия помнит, с какой общей она сверена
ALTER TABLE pages ADD COLUMN version_no int NOT NULL DEFAULT 0;
ALTER TABLE pages ADD COLUMN base_version int;
ALTER TABLE pages ADD COLUMN override_reason text;
ALTER TABLE page_versions ADD COLUMN version_no int;

UPDATE page_versions v SET version_no = n.rn
  FROM (SELECT id, row_number() OVER (PARTITION BY page_id ORDER BY created_at, id) AS rn FROM page_versions) n
 WHERE n.id = v.id;
UPDATE pages p SET version_no = GREATEST(
    COALESCE((SELECT max(v.version_no) FROM page_versions v WHERE v.page_id = p.id), 0),
    CASE WHEN p.published_at IS NOT NULL THEN 1 ELSE 0 END);
-- Опубликованные страницы без записи в истории (демо, старые данные) получают версию 1 с текущими блоками:
-- без неё «сравнить со своей версией» было бы не с чем
INSERT INTO page_versions(page_id, title, summary, blocks, author_person_id, note, version_no, created_at)
SELECT p.id, p.title, p.summary, p.blocks, p.owner_person_id, NULL, 1, COALESCE(p.published_at, p.updated_at)
  FROM pages p
 WHERE p.published_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM page_versions v WHERE v.page_id = p.id);

-- Ответственность за актуальность
ALTER TABLE pages ADD COLUMN owner_unit text;
ALTER TABLE pages ADD COLUMN backup_owner_person_id uuid REFERENCES persons(id) ON DELETE SET NULL;
ALTER TABLE pages ADD COLUMN review_interval_days int NOT NULL DEFAULT 180 CHECK (review_interval_days BETWEEN 7 AND 730);

-- Неявные переопределения (страница факультета с тем же разделом и адресом, что и общая) становятся явными:
-- иначе список показывал одну версию, а поиск — другую (и ссылка вела в «не найдено»)
UPDATE pages fp
   SET inherited_from = bp.id, base_version = bp.version_no
  FROM handbooks fh, sections fs, pages bp, sections bs
 WHERE fh.id = fp.handbook_id AND fh.parent_id IS NOT NULL
   AND fs.id = fp.section_id
   AND bp.handbook_id = fh.parent_id AND bs.id = bp.section_id
   AND bs.slug = fs.slug AND bp.slug = fp.slug
   AND fp.inherited_from IS NULL AND fp.status <> 'archived';
UPDATE pages fp SET base_version = bp.version_no
  FROM pages bp WHERE bp.id = fp.inherited_from AND fp.base_version IS NULL;

CREATE UNIQUE INDEX pages_one_override ON pages(handbook_id, inherited_from)
  WHERE inherited_from IS NOT NULL AND status <> 'archived';

-- Уточнение факультета к общей странице: несколько блоков, вставленных после блока общей страницы.
-- Общая часть не копируется и продолжает обновляться сама.
CREATE TABLE page_supplements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handbook_id     uuid NOT NULL REFERENCES handbooks(id) ON DELETE CASCADE,
  base_page_id    uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  anchor_block_id text,
  blocks          jsonb NOT NULL DEFAULT '[]'::jsonb,
  draft_blocks    jsonb,
  draft_anchor_block_id text,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  owner_person_id uuid REFERENCES persons(id) ON DELETE SET NULL,
  search_text     text NOT NULL DEFAULT '',
  search_vector   tsvector GENERATED ALWAYS AS (to_tsvector('russian', search_text)) STORED,
  checked_at      timestamptz,
  published_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (handbook_id, base_page_id)
);
CREATE INDEX page_supplements_base_idx ON page_supplements(base_page_id);
CREATE INDEX page_supplements_search_idx ON page_supplements USING gin(search_vector);

CREATE INDEX audit_log_university_idx ON audit_log(university_id, at DESC);

-- 002: модуль «Справочник факультета» — конструктор живого справочника внутри MAX.
-- Справочник вуза наследуется справочниками факультетов; страницы собираются из блоков (jsonb),
-- адресуются аудитории (курс, общежитие, теги) и ищутся полнотекстовым поиском.

-- Устойчивость поиска к опечаткам. Если расширения нет (нет прав, облачная база без contrib,
-- PostgreSQL в браузере) — справочник работает, просто без опечаточного поиска.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION
  WHEN OTHERS THEN RAISE NOTICE 'pg_trgm недоступно (%): поиск без устойчивости к опечаткам', SQLERRM;
END
$$;

-- Совпадает ли аудитория блока/страницы с профилем читателя.
-- Пустые поля аудитории означают «для всех», неизвестный профиль ничего не скрывает.
CREATE OR REPLACE FUNCTION audience_matches(a jsonb, p_course int, p_dorm boolean, p_tags text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    (a->'courses' IS NULL OR jsonb_array_length(a->'courses') = 0 OR p_course IS NULL
       OR (a->'courses') @> to_jsonb(p_course))
    AND (a->'dorm' IS NULL OR p_dorm IS NULL OR (a->>'dorm')::boolean = p_dorm)
    AND (a->'tags' IS NULL OR jsonb_array_length(a->'tags') = 0 OR p_tags IS NULL
       OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(a->'tags') t WHERE t = ANY(p_tags)));
$$;

CREATE TABLE handbooks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id uuid NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  -- NULL — общеуниверситетский справочник, от которого наследуются факультетские
  institute_id  uuid REFERENCES institutes(id) ON DELETE CASCADE,
  parent_id     uuid REFERENCES handbooks(id) ON DELETE SET NULL,
  -- Слаг уникален на всей платформе: он входит в диплинк hb_<слаг>, по которому бот открывает справочник
  slug          text NOT NULL UNIQUE,
  title         text NOT NULL,
  subtitle      text,
  emoji         text NOT NULL DEFAULT '📘',
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  -- settings: { synonyms: {…}, dutyContact: '…' }
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX handbooks_university_idx ON handbooks(university_id);
CREATE INDEX handbooks_institute_idx ON handbooks(institute_id);

-- Кто ведёт справочник: студсовет, тьюторы, деканат
CREATE TABLE handbook_members (
  handbook_id uuid NOT NULL REFERENCES handbooks(id) ON DELETE CASCADE,
  person_id   uuid NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('editor', 'admin')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (handbook_id, person_id)
);
CREATE INDEX handbook_members_person_idx ON handbook_members(person_id);

CREATE TABLE sections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handbook_id uuid NOT NULL REFERENCES handbooks(id) ON DELETE CASCADE,
  slug        text NOT NULL,
  title       text NOT NULL,
  emoji       text NOT NULL DEFAULT '📄',
  summary     text,
  position    integer NOT NULL DEFAULT 100,
  audience    jsonb NOT NULL DEFAULT '{}'::jsonb,
  visible     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (handbook_id, slug)
);
CREATE INDEX sections_handbook_idx ON sections(handbook_id, position);

CREATE TABLE pages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handbook_id    uuid NOT NULL REFERENCES handbooks(id) ON DELETE CASCADE,
  section_id     uuid NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  slug           text NOT NULL,
  title          text NOT NULL,
  summary        text,
  audience       jsonb NOT NULL DEFAULT '{}'::jsonb,
  position       integer NOT NULL DEFAULT 100,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'published', 'archived')),
  -- Опубликованная версия и черновик рядом: студент видит blocks, редактор правит draft_*
  blocks         jsonb NOT NULL DEFAULT '[]'::jsonb,
  draft_title    text,
  draft_summary  text,
  draft_blocks   jsonb,
  draft_note     text,
  owner_person_id uuid REFERENCES persons(id) ON DELETE SET NULL,
  -- Переопределение страницы общеуниверситетского справочника
  inherited_from uuid REFERENCES pages(id) ON DELETE SET NULL,
  views          integer NOT NULL DEFAULT 0,
  helpful        integer NOT NULL DEFAULT 0,
  not_helpful    integer NOT NULL DEFAULT 0,
  review_at      date,
  checked_at     timestamptz,
  published_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- Поиск взвешен: совпадение в заголовке и названии раздела весомее совпадения в тексте,
  -- иначе страница, где слово встретилось мимоходом, обгоняет страницу про это слово.
  search_title   text NOT NULL DEFAULT '',
  search_text    text NOT NULL DEFAULT '',
  search_vector  tsvector GENERATED ALWAYS AS (
                   setweight(to_tsvector('russian', search_title), 'A') ||
                   setweight(to_tsvector('russian', search_text), 'B')
                 ) STORED,
  UNIQUE (handbook_id, slug)
);
CREATE INDEX pages_section_idx ON pages(section_id, position);
CREATE INDEX pages_search_idx ON pages USING gin(search_vector);
CREATE INDEX pages_status_idx ON pages(handbook_id, status);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX pages_trgm_idx ON pages USING gin ((search_title || '' '' || search_text) gin_trgm_ops)';
  END IF;
END
$$;

CREATE TABLE page_versions (
  id               bigserial PRIMARY KEY,
  page_id          uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  title            text NOT NULL,
  summary          text,
  blocks           jsonb NOT NULL,
  author_person_id uuid REFERENCES persons(id) ON DELETE SET NULL,
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX page_versions_page_idx ON page_versions(page_id, created_at DESC);

-- Читатель справочника: любой пользователь MAX, открывший справочник факультета.
-- Он не обязан быть в списках деканата; person_id заполняется, если аккаунт уже связан с записью вуза.
CREATE TABLE handbook_readers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handbook_id  uuid NOT NULL REFERENCES handbooks(id) ON DELETE CASCADE,
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  person_id    uuid REFERENCES persons(id) ON DELETE SET NULL,
  course       smallint CHECK (course BETWEEN 1 AND 6),
  program      text,
  dorm         boolean,
  tags         text[] NOT NULL DEFAULT '{}',
  reminders    boolean NOT NULL DEFAULT true,
  -- Заданный из чата вопрос, который читатель ещё дополняет: следующее сообщение уйдёт в него, а не в поиск
  pending_question_id uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (handbook_id, user_id)
);
CREATE INDEX handbook_readers_user_idx ON handbook_readers(user_id);

-- Личный прогресс по чеклистам и пошаговым инструкциям
CREATE TABLE reader_progress (
  reader_id  uuid NOT NULL REFERENCES handbook_readers(id) ON DELETE CASCADE,
  page_id    uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  item_id    text NOT NULL,
  done       boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reader_id, page_id, item_id)
);

-- Сроки из блоков deadline: календарь студента и напоминания в чат
CREATE TABLE handbook_deadlines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handbook_id uuid NOT NULL REFERENCES handbooks(id) ON DELETE CASCADE,
  page_id     uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  block_id    text NOT NULL,
  title       text NOT NULL,
  starts_on   date NOT NULL,
  ends_on     date,
  remind_days integer[] NOT NULL DEFAULT '{3,1}',
  audience    jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (page_id, block_id)
);
CREATE INDEX handbook_deadlines_date_idx ON handbook_deadlines(handbook_id, starts_on);

-- Вопрос дежурному: то, чего не нашлось в справочнике
CREATE TABLE handbook_questions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handbook_id uuid NOT NULL REFERENCES handbooks(id) ON DELETE CASCADE,
  reader_id   uuid REFERENCES handbook_readers(id) ON DELETE SET NULL,
  user_id     bigint REFERENCES users(id) ON DELETE SET NULL,
  text        text NOT NULL,
  query       text,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered')),
  answer      text,
  answered_by uuid REFERENCES persons(id) ON DELETE SET NULL,
  answered_at timestamptz,
  page_id     uuid REFERENCES pages(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX handbook_questions_open_idx ON handbook_questions(handbook_id, status, created_at DESC);

CREATE TABLE page_feedback (
  page_id    uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  reader_id  uuid NOT NULL REFERENCES handbook_readers(id) ON DELETE CASCADE,
  helpful    boolean NOT NULL,
  comment    text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, reader_id)
);

-- Журнал поиска: бэклог редактора (что ищут и чего не находят)
CREATE TABLE search_log (
  id             bigserial PRIMARY KEY,
  handbook_id    uuid NOT NULL REFERENCES handbooks(id) ON DELETE CASCADE,
  reader_id      uuid REFERENCES handbook_readers(id) ON DELETE SET NULL,
  query          text NOT NULL,
  normalized     text NOT NULL,
  results        integer NOT NULL DEFAULT 0,
  opened_page_id uuid REFERENCES pages(id) ON DELETE SET NULL,
  source         text NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'bot')),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX search_log_handbook_idx ON search_log(handbook_id, created_at DESC);

CREATE TABLE announcements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handbook_id uuid NOT NULL REFERENCES handbooks(id) ON DELETE CASCADE,
  title       text NOT NULL,
  body        text NOT NULL,
  audience    jsonb NOT NULL DEFAULT '{}'::jsonb,
  page_id     uuid REFERENCES pages(id) ON DELETE SET NULL,
  starts_on   date,
  ends_on     date,
  created_by  uuid REFERENCES persons(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX announcements_handbook_idx ON announcements(handbook_id, created_at DESC);

ALTER TABLE handbook_readers
  ADD CONSTRAINT handbook_readers_pending_question_fkey
  FOREIGN KEY (pending_question_id) REFERENCES handbook_questions(id) ON DELETE SET NULL;

-- Уведомления модуля справочника адресуются читателю, а не только записи вуза
ALTER TABLE notifications ADD COLUMN reader_id uuid REFERENCES handbook_readers(id) ON DELETE CASCADE;
CREATE INDEX notifications_reader_idx ON notifications(reader_id, created_at DESC);

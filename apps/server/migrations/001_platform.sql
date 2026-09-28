-- 001: ядро платформы — вузы, аккаунты MAX, записи вуза, приглашения, очередь уведомлений, аудит.
-- Модули (справочник факультета и будущие) строятся поверх этих таблиц.

CREATE TABLE universities (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code               text NOT NULL UNIQUE,
  name               text NOT NULL,
  short_name         text NOT NULL,
  timezone           text NOT NULL DEFAULT 'Europe/Moscow',
  is_demo            boolean NOT NULL DEFAULT false,
  -- Демо-песочница принадлежит одному аккаунту MAX и не видна остальным
  demo_owner_user_id bigint,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Аккаунты MAX: все, кто открыл бота или мини-приложение
CREATE TABLE users (
  id               bigserial PRIMARY KEY,
  max_user_id      bigint NOT NULL UNIQUE,
  first_name       text,
  last_name        text,
  username         text,
  active_person_id uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE institutes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id uuid NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  name          text NOT NULL,
  short_name    text NOT NULL
);

CREATE TABLE groups (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institute_id uuid NOT NULL REFERENCES institutes(id) ON DELETE CASCADE,
  name         text NOT NULL,
  course       smallint NOT NULL CHECK (course BETWEEN 1 AND 6),
  UNIQUE (institute_id, name)
);

-- Записи вуза: кто есть кто. student — студент (в том числе студсовет),
-- staff — тьютор или сотрудник учебного офиса, dean — сотрудник деканата.
CREATE TABLE persons (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id uuid NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  institute_id  uuid REFERENCES institutes(id) ON DELETE SET NULL,
  group_id      uuid REFERENCES groups(id) ON DELETE SET NULL,
  role          text NOT NULL CHECK (role IN ('student', 'staff', 'dean')),
  full_name     text NOT NULL,
  external_id   text,
  phone_hash    text,
  user_id       bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX persons_user_idx ON persons(user_id);
CREATE INDEX persons_group_idx ON persons(group_id);
CREATE UNIQUE INDEX persons_external_uq ON persons(university_id, role, external_id) WHERE external_id IS NOT NULL;

ALTER TABLE users ADD CONSTRAINT users_active_person_fk
  FOREIGN KEY (active_person_id) REFERENCES persons(id) ON DELETE SET NULL;

-- Персональные приглашения: ссылка ?start=inv_<код> связывает аккаунт MAX с записью вуза
CREATE TABLE invites (
  code       text PRIMARY KEY,
  person_id  uuid NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  used_by    bigint REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX invites_person_idx ON invites(person_id);

-- Outbox уведомлений и журнал доставки. Адресат — запись вуза (person_id)
-- или читатель справочника (reader_id, добавляется миграцией модуля).
CREATE TABLE notifications (
  id              bigserial PRIMARY KEY,
  university_id   uuid REFERENCES universities(id) ON DELETE CASCADE,
  person_id       uuid REFERENCES persons(id) ON DELETE CASCADE,
  user_id         bigint REFERENCES users(id) ON DELETE SET NULL,
  kind            text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key      text UNIQUE,
  send_after      timestamptz NOT NULL DEFAULT now(),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled', 'skipped')),
  attempts        smallint NOT NULL DEFAULT 0,
  claimed_at      timestamptz,
  last_error      text,
  max_message_id  text,
  simulated       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  acknowledged_at timestamptz,
  ack             text
);
CREATE INDEX notifications_due_idx ON notifications(send_after) WHERE status = 'pending';
CREATE INDEX notifications_person_idx ON notifications(person_id, created_at DESC);

CREATE TABLE audit_log (
  id              bigserial PRIMARY KEY,
  university_id   uuid REFERENCES universities(id) ON DELETE CASCADE,
  actor_person_id uuid REFERENCES persons(id) ON DELETE SET NULL,
  actor_user_id   bigint REFERENCES users(id) ON DELETE SET NULL,
  action          text NOT NULL,
  entity          text NOT NULL,
  entity_id       text,
  data            jsonb NOT NULL DEFAULT '{}'::jsonb,
  at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_entity_idx ON audit_log(entity, entity_id);

-- Служебные значения (например, данные бота из /me)
CREATE TABLE kv (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Идемпотентный приём обновлений MAX: повторная доставка webhook или перезапуск long polling
-- не должны обработать одно и то же событие дважды.
CREATE TABLE processed_updates (
  key        text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX processed_updates_created_idx ON processed_updates(created_at);

import { one, tx, type Db } from '../db/pool.js';
import { config } from '../config.js';
import { audit } from './common.js';
import { AppError } from '../lib/errors.js';
import type { UserRow } from './identity.js';
import { createDemoHandbook } from './demo-handbook.js';

/**
 * Демо-песочница для жюри и тестирования: «Модельный университет» со справочником
 * Института информационных технологий. У каждого аккаунта MAX своя изолированная копия;
 * /reset пересоздаёт её с нуля. Все имена и данные вымышлены.
 */

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const MALE_SURNAMES = ['Волков', 'Соколов', 'Морозов', 'Павлов', 'Козлов', 'Степанов', 'Николаев', 'Орлов', 'Макаров', 'Зайцев', 'Беляев', 'Григорьев', 'Романов', 'Васильев', 'Тихонов', 'Фёдоров', 'Ершов', 'Никитин', 'Белов', 'Комаров'];
const MALE_NAMES = ['Артём', 'Максим', 'Даниил', 'Кирилл', 'Егор', 'Илья', 'Матвей', 'Тимофей', 'Роман', 'Глеб', 'Лев', 'Марк'];
const FEMALE_NAMES = ['Анастасия', 'Дарья', 'Полина', 'Виктория', 'Алина', 'Софья', 'Ксения', 'Екатерина', 'Вероника', 'Милана', 'Ульяна', 'Ева'];
const PATRONYMIC_BASE = ['Александров', 'Сергеев', 'Дмитриев', 'Андреев', 'Игорев', 'Олегов', 'Евгеньев', 'Викторов', 'Павлов', 'Михайлов'];

function fakeName(random: () => number): string {
  const female = random() < 0.5;
  const surname = MALE_SURNAMES[Math.floor(random() * MALE_SURNAMES.length)]!;
  const name = (female ? FEMALE_NAMES : MALE_NAMES)[Math.floor(random() * 12)]!;
  const patronymic = PATRONYMIC_BASE[Math.floor(random() * PATRONYMIC_BASE.length)]!;
  return `${female ? `${surname}а` : surname} ${name} ${patronymic}${female ? 'на' : 'ич'}`;
}

type TxClient = Parameters<Parameters<typeof tx>[0]>[0];

const insertId = async (client: TxClient, sql: string, values: unknown[]) =>
  (await one<{ id: string }>(client, sql, values))!.id;

/**
 * Роль посетителя в демо. Настоящий вуз даёт роль только по личному приглашению деканата;
 * в демо её выбирают сами, чтобы увидеть продукт глазами студента, редактора или деканата.
 */
export type DemoRole = 'student' | 'editor' | 'dean';
export const DEMO_ROLES: readonly DemoRole[] = ['student', 'editor', 'dean'];

export interface DemoSandbox {
  universityId: string;
  instituteId: string;
  deanId: string;
  editorIds: string[];
  handbookId: string;
  handbookSlug: string;
  role: DemoRole;
}

/** Код записи посетителя в модельном вузе: по нему роль меняется, не пересоздавая данные. */
const VISITOR_CODE = 'D-001';

interface SandboxRef {
  universityId: string;
  visitorId: string;
  visitorUserId: number | null;
  visitorRole: string;
  handbookId: string;
  handbookSlug: string;
}

async function findSandbox(db: Db, userId: number): Promise<SandboxRef | null> {
  const ref = await one<SandboxRef>(
    db,
    `SELECT u.id AS "universityId", p.id AS "visitorId", p.user_id AS "visitorUserId", p.role AS "visitorRole",
            h.id AS "handbookId", h.slug AS "handbookSlug"
       FROM universities u
       JOIN persons p ON p.university_id = u.id AND p.external_id = $2
       JOIN handbooks h ON h.university_id = u.id AND h.institute_id IS NOT NULL
      WHERE u.is_demo AND u.demo_owner_user_id = $1
      ORDER BY h.created_at
      LIMIT 1`,
    [userId, VISITOR_CODE],
  );
  return ref ?? null;
}

const roleOf = (ref: SandboxRef): DemoRole => (ref.visitorUserId === null ? 'student' : ref.visitorRole === 'dean' ? 'dean' : 'editor');

/** Текущая роль в демо или null, если у пользователя нет песочницы. */
export async function getDemoRole(db: Db, userId: number): Promise<DemoRole | null> {
  const ref = await findSandbox(db, userId);
  return ref ? roleOf(ref) : null;
}

/**
 * Роль задаётся записью посетителя в модельном вузе:
 * студент — аккаунт MAX не связан с записью (просто читатель); редактор — сотрудник с правами редактора;
 * деканат — сотрудник деканата, администратор справочника по должности.
 */
async function applyDemoRole(client: Db, userId: number, ref: { visitorId: string; handbookId: string }, role: DemoRole) {
  if (role === 'student') {
    await client.query('UPDATE persons SET user_id = NULL WHERE id = $1', [ref.visitorId]);
    await client.query('UPDATE users SET active_person_id = NULL WHERE id = $1 AND active_person_id = $2', [userId, ref.visitorId]);
    return;
  }
  await client.query('UPDATE persons SET user_id = $2, role = $3 WHERE id = $1', [ref.visitorId, userId, role === 'dean' ? 'dean' : 'staff']);
  await client.query(
    `INSERT INTO handbook_members(handbook_id, person_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (handbook_id, person_id) DO UPDATE SET role = EXCLUDED.role`,
    [ref.handbookId, ref.visitorId, role === 'dean' ? 'admin' : 'editor'],
  );
  await client.query('UPDATE users SET active_person_id = $2 WHERE id = $1', [userId, ref.visitorId]);
}

/** Сменить роль в демо, сохранив всё, что посетитель уже сделал; нет песочницы — создать. */
export async function setDemoRole(user: UserRow, role: DemoRole): Promise<{ handbookId: string; handbookSlug: string; role: DemoRole }> {
  assertDemoEnabled();
  // Песочницу ищем уже под блокировкой: иначе смена роли во время сброса или двойное нажатие
  // создали бы две песочницы или сослались бы на удалённую
  return tx(async (client) => {
    await lockDemo(client, user.id);
    const existing = await findSandbox(client, user.id);
    if (!existing) {
      const created = await buildDemoSandbox(client, user, role);
      return { handbookId: created.handbookId, handbookSlug: created.handbookSlug, role };
    }
    await applyDemoRole(client, user.id, existing, role);
    await audit(client, { universityId: existing.universityId, actorUserId: user.id, action: 'demo.role', entity: 'university', entityId: existing.universityId, data: { role } });
    return { handbookId: existing.handbookId, handbookSlug: existing.handbookSlug, role };
  });
}

function assertDemoEnabled() {
  if (!config.DEMO_ENABLED) throw new AppError('demo_disabled', 'Демо выключено на этом сервере', 403);
}

/** Одна песочница — одна очередь: сброс, создание и смена роли одного пользователя не пересекаются. */
async function lockDemo(client: Db, userId: number) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`demo:${userId}`]);
}

export async function createDemoSandbox(user: UserRow, role: DemoRole = 'dean'): Promise<DemoSandbox> {
  assertDemoEnabled();
  return tx(async (client) => {
    await lockDemo(client, user.id);
    return buildDemoSandbox(client, user, role);
  });
}

async function buildDemoSandbox(client: TxClient, user: UserRow, role: DemoRole): Promise<DemoSandbox> {
  {
    // Прошлая песочница уходит целиком: вуз каскадом уносит справочники, страницы, читателей (и посторонних),
    // вопросы, журнал поиска, объявления, уведомления и аудит. Отдельно — то, что на неё ссылается без внешнего ключа:
    // ожидание вопроса из чата (kv hbq:<userId>) иначе отправило бы следующий текст в другой справочник.
    await client.query(
      `DELETE FROM kv WHERE key LIKE 'hbq:%' AND value->>'handbookId' IN (
         SELECT h.id::text FROM handbooks h JOIN universities u ON u.id = h.university_id
          WHERE u.is_demo AND u.demo_owner_user_id = $1)`,
      [user.id],
    );
    await client.query('DELETE FROM universities WHERE is_demo AND demo_owner_user_id = $1', [user.id]);
    await client.query('DELETE FROM users WHERE max_user_id < 0 AND username = $1', [`demo-model-${user.id}`]);

    const random = rng(user.max_user_id % 2_147_483_647);
    const universityId = await insertId(
      client,
      `INSERT INTO universities(code, name, short_name, timezone, is_demo, demo_owner_user_id)
       VALUES ($1, 'Модельный университет', 'МУ', $2, true, $3) RETURNING id`,
      [`demo-${user.id}-${Date.now()}`, config.APP_TIMEZONE, user.id],
    );
    const instituteId = await insertId(
      client,
      "INSERT INTO institutes(university_id, name, short_name) VALUES ($1, 'Институт информационных технологий', 'ИИТ') RETURNING id",
      [universityId],
    );

    const groups: Record<string, string> = {};
    for (const [name, course] of [['ИТ-101', 1], ['ИТ-102', 1], ['ПИ-101', 1], ['ИТ-201', 2], ['ИТ-301', 3]] as const) {
      groups[name] = await insertId(client, 'INSERT INTO groups(institute_id, name, course) VALUES ($1, $2, $3) RETURNING id', [instituteId, name, course]);
    }

    const person = (role: 'student' | 'staff' | 'dean', fullName: string, userId: number | null, groupId: string | null, externalId: string | null) =>
      insertId(
        client,
        `INSERT INTO persons(university_id, institute_id, group_id, role, full_name, user_id, external_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [universityId, instituteId, groupId, role, fullName, userId, externalId],
      );

    // Посетитель демо — сотрудник деканата: читает справочник и может его редактировать
    const visitorName = [user.last_name, user.first_name].filter(Boolean).join(' ').trim() || 'Демо Гость';
    const deanId = await person('dean', visitorName, user.id, null, VISITOR_CODE);

    // Модельные читатели: у части есть аккаунты MAX (отрицательные id — сообщения им только имитируются)
    const modelUsers: number[] = [];
    for (let i = 0; i < 28; i += 1) {
      const row = await one<{ id: number }>(
        client,
        'INSERT INTO users(max_user_id, first_name, username) VALUES ($1, $2, $3) RETURNING id',
        [-(user.id * 1000 + i + 1), 'Модельный пользователь', `demo-model-${user.id}`],
      );
      modelUsers.push(row!.id);
    }
    const groupNames = Object.keys(groups);
    const students: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      const groupName = groupNames[i % groupNames.length]!;
      students.push(await person('student', fakeName(random), i < modelUsers.length ? modelUsers[i]! : null, groups[groupName]!, `2025-${String(1000 + i)}`));
    }

    // Студсовет ведёт справочник вместе с деканатом
    const editorIds = [students[0]!, students[1]!];

    const handbook = await createDemoHandbook(client, {
      universityId,
      instituteId,
      editorPersonId: editorIds[0]!,
      deanPersonId: deanId,
      readerPersonIds: students,
    });
    await client.query(
      "INSERT INTO handbook_members(handbook_id, person_id, role) VALUES ($1, $2, 'editor') ON CONFLICT DO NOTHING",
      [handbook.handbookId, editorIds[1]],
    );
    await client.query(
      `INSERT INTO handbook_readers(handbook_id, user_id, person_id, course) VALUES ($1, $2, NULL, 1)
       ON CONFLICT (handbook_id, user_id) DO NOTHING`,
      [handbook.handbookId, user.id],
    );

    await client.query('UPDATE users SET active_person_id = $2 WHERE id = $1', [user.id, deanId]);
    if (role !== 'dean') await applyDemoRole(client, user.id, { visitorId: deanId, handbookId: handbook.handbookId }, role);
    await audit(client, { universityId, actorUserId: user.id, action: 'demo.create', entity: 'university', entityId: universityId, data: { role } });
    return { universityId, instituteId, deanId, editorIds, handbookId: handbook.handbookId, handbookSlug: handbook.slug, role };
  }
}

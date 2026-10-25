import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { config } from '../config.js';
import { one, pool, tx } from '../db/pool.js';
import { deepLink, getBotIdentity } from '../max/bot.js';
import { audit } from '../services/common.js';
import { ensureInvite } from '../services/identity.js';

export const BOOTSTRAP_USAGE = `Подключение реального вуза: создаёт вуз, администратора университета,
при необходимости — институт с сотрудниками деканата, и печатает персональные ссылки-приглашения.
Повторный запуск с теми же данными ничего не дублирует.

  node dist/index.js bootstrap \\
    --university "Модельный университет" --short "МУ" \\
    --university-admin "Орлова Марина Викторовна"

  node dist/index.js bootstrap \\
    --university "Модельный университет" \\
    --institute "Институт информационных технологий" \\
    --dean "Сидоров Павел Андреевич"

Параметры:
  --university   полное название вуза (обязательно)
  --short        краткое название (по умолчанию — полное)
  --institute    институт или факультет (обязательно)
  --timezone     часовой пояс вуза, например Asia/Tomsk (по умолчанию APP_TIMEZONE)
  --university-admin  ФИО администратора университета: ведёт общую базу и подключает факультеты;
                 можно указать несколько раз
  --institute    институт или факультет (вместе с --dean)
  --dean         ФИО сотрудника деканата — администратора факультета; можно указать несколько раз

Нужен хотя бы один --university-admin или пара --institute и --dean.
Администратор университета открывает ссылку в MAX, заполняет общую базу и подключает факультеты
из кабинета университета; деканат — создаёт справочник факультета и приглашает редакторов.`;

export interface BootstrapPerson {
  role: 'dean' | 'university_admin';
  fullName: string;
  personId: string;
  inviteCode: string;
}

export interface BootstrapResult {
  universityId: string;
  instituteId: string | null;
  people: BootstrapPerson[];
}

export async function bootstrapUniversity(argv: string[]): Promise<BootstrapResult | null> {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      university: { type: 'string' },
      short: { type: 'string' },
      institute: { type: 'string' },
      timezone: { type: 'string' },
      dean: { type: 'string', multiple: true },
      'university-admin': { type: 'string', multiple: true },
      help: { type: 'boolean' },
    },
  });
  const universityName = values.university?.trim();
  const instituteName = values.institute?.trim();
  const deans = (values.dean ?? []).map((name) => name.trim()).filter(Boolean);
  const uniAdmins = (values['university-admin'] ?? []).map((name) => name.trim()).filter(Boolean);
  const facultyOk = Boolean(instituteName) && deans.length > 0;
  if (values.help || !universityName || (!facultyOk && uniAdmins.length === 0) || Boolean(instituteName) !== deans.length > 0) {
    console.log(BOOTSTRAP_USAGE);
    if (!values.help) throw new Error('Укажите --university и хотя бы одного --university-admin или пару --institute и --dean');
    return null;
  }
  if ([...deans, ...uniAdmins].some((name) => name.length < 3)) throw new Error('Укажите ФИО у каждого --dean и --university-admin');
  const timezone = values.timezone?.trim() || config.APP_TIMEZONE;
  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone: timezone });
  } catch {
    throw new Error(`Неизвестный часовой пояс: ${timezone}`);
  }

  const result = await tx(async (client) => {
    const code = `uni-${createHash('sha256').update(universityName.toLowerCase()).digest('hex').slice(0, 12)}`;
    const university =
      (await one<{ id: string }>(client, 'SELECT id FROM universities WHERE code = $1', [code])) ??
      (await one<{ id: string }>(
        client,
        'INSERT INTO universities(code, name, short_name, timezone) VALUES ($1, $2, $3, $4) RETURNING id',
        [code, universityName, values.short?.trim() || universityName, timezone],
      ))!;
    const institute = instituteName
      ? ((await one<{ id: string }>(client, 'SELECT id FROM institutes WHERE university_id = $1 AND name = $2', [university.id, instituteName])) ??
        (await one<{ id: string }>(client, 'INSERT INTO institutes(university_id, name, short_name) VALUES ($1, $2, $2) RETURNING id', [university.id, instituteName]))!)
      : null;

    const person = async (role: 'dean' | 'staff', fullName: string, instituteId: string | null) =>
      (
        (await one<{ id: string }>(
          client,
          'SELECT id FROM persons WHERE university_id = $1 AND institute_id IS NOT DISTINCT FROM $2 AND role = $3 AND full_name = $4',
          [university.id, instituteId, role, fullName],
        )) ??
        (await one<{ id: string }>(
          client,
          'INSERT INTO persons(university_id, institute_id, role, full_name) VALUES ($1, $2, $3, $4) RETURNING id',
          [university.id, instituteId, role, fullName],
        ))!
      ).id;
    // Назначение — отдельная строка org_roles; повторный запуск не создаёт второе активное назначение
    const grant = (personId: string, role: 'university_admin' | 'faculty_admin', instituteId: string | null) =>
      client.query('INSERT INTO org_roles(person_id, university_id, institute_id, role) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [personId, university.id, instituteId, role]);

    const people: BootstrapPerson[] = [];
    for (const fullName of uniAdmins) {
      const personId = await person('staff', fullName, null);
      await grant(personId, 'university_admin', null);
      people.push({ role: 'university_admin', fullName, personId, inviteCode: await ensureInvite(client, personId) });
    }
    for (const fullName of deans) {
      const personId = await person('dean', fullName, institute!.id);
      await grant(personId, 'faculty_admin', institute!.id);
      people.push({ role: 'dean', fullName, personId, inviteCode: await ensureInvite(client, personId) });
    }
    await audit(client, {
      universityId: university.id,
      action: 'cli.bootstrap',
      entity: 'university',
      entityId: university.id,
      data: { deans: deans.length, universityAdmins: uniAdmins.length },
    });
    return { universityId: university.id, instituteId: institute?.id ?? null, people };
  });

  const identity = await getBotIdentity();
  console.log(`\nВуз: ${universityName}${instituteName ? ` · ${instituteName}` : ''} (часовой пояс ${timezone})\n`);
  for (const item of result.people) {
    const link = identity.username ? deepLink(identity, 'start', `inv_${item.inviteCode}`) : `код ${item.inviteCode} (имя бота неизвестно: задайте BOT_USERNAME или запустите бота)`;
    console.log(`${item.role === 'university_admin' ? 'Администратор университета' : 'Деканат'}: ${item.fullName}\n  ${link}\n`);
  }
  console.log('Отправьте каждому его личную ссылку. Код можно также ввести в чате с ботом или в мини-приложении.');
  return result;
}

export async function runBootstrapCli(argv: string[]): Promise<void> {
  try {
    await bootstrapUniversity(argv);
  } finally {
    await pool.end();
  }
}

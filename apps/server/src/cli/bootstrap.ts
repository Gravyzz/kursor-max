import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { config } from '../config.js';
import { one, pool, tx } from '../db/pool.js';
import { deepLink, getBotIdentity } from '../max/bot.js';
import { audit } from '../services/common.js';
import { ensureInvite } from '../services/identity.js';

export const BOOTSTRAP_USAGE = `Подключение реального вуза: создаёт вуз, институт и сотрудников деканата
и печатает их персональные ссылки-приглашения. Повторный запуск с теми же данными ничего не дублирует.

  node dist/index.js bootstrap \\
    --university "Модельный университет" --short "МУ" \\
    --institute "Институт информационных технологий" \\
    --dean "Орлова Марина Викторовна"

Параметры:
  --university   полное название вуза (обязательно)
  --short        краткое название (по умолчанию — полное)
  --institute    институт или факультет (обязательно)
  --timezone     часовой пояс вуза, например Asia/Tomsk (по умолчанию APP_TIMEZONE)
  --dean         ФИО сотрудника деканата; можно указать несколько раз (хотя бы один)

Дальше сотрудник деканата открывает свою ссылку в MAX, создаёт справочник факультета
и приглашает редакторов — студсовет и тьюторов — прямо из мини-приложения.`;

export interface BootstrapPerson {
  role: 'dean';
  fullName: string;
  personId: string;
  inviteCode: string;
}

export interface BootstrapResult {
  universityId: string;
  instituteId: string;
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
      help: { type: 'boolean' },
    },
  });
  const universityName = values.university?.trim();
  const instituteName = values.institute?.trim();
  const deans = (values.dean ?? []).map((name) => name.trim()).filter(Boolean);
  if (values.help || !universityName || !instituteName || deans.length === 0) {
    console.log(BOOTSTRAP_USAGE);
    if (!values.help) throw new Error('Укажите --university, --institute и хотя бы одного --dean');
    return null;
  }
  if (deans.some((name) => name.length < 3)) throw new Error('Укажите ФИО у каждого --dean');
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
    const institute =
      (await one<{ id: string }>(client, 'SELECT id FROM institutes WHERE university_id = $1 AND name = $2', [university.id, instituteName])) ??
      (await one<{ id: string }>(client, 'INSERT INTO institutes(university_id, name, short_name) VALUES ($1, $2, $2) RETURNING id', [university.id, instituteName]))!;

    const person = async (role: 'dean', fullName: string) =>
      (
        (await one<{ id: string }>(
          client,
          'SELECT id FROM persons WHERE university_id = $1 AND institute_id = $2 AND role = $3 AND full_name = $4',
          [university.id, institute.id, role, fullName],
        )) ??
        (await one<{ id: string }>(
          client,
          'INSERT INTO persons(university_id, institute_id, role, full_name) VALUES ($1, $2, $3, $4) RETURNING id',
          [university.id, institute.id, role, fullName],
        ))!
      ).id;

    const people: BootstrapPerson[] = [];
    for (const fullName of deans) {
      const personId = await person('dean', fullName);
      people.push({ role: 'dean', fullName, personId, inviteCode: await ensureInvite(client, personId) });
    }
    await audit(client, {
      universityId: university.id,
      action: 'cli.bootstrap',
      entity: 'university',
      entityId: university.id,
      data: { deans: deans.length },
    });
    return { universityId: university.id, instituteId: institute.id, people };
  });

  const identity = await getBotIdentity();
  console.log(`\nВуз: ${universityName} · ${instituteName} (часовой пояс ${timezone})\n`);
  for (const item of result.people) {
    const link = identity.username ? deepLink(identity, 'start', `inv_${item.inviteCode}`) : `код ${item.inviteCode} (имя бота неизвестно: задайте BOT_USERNAME или запустите бота)`;
    console.log(`Деканат: ${item.fullName}\n  ${link}\n`);
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

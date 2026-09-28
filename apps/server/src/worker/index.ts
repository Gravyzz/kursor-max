import { MaxError, type Bot } from '@maxhub/max-bot-api';
import { config } from '../config.js';
import { many, one, pool, tx } from '../db/pool.js';
import { createLogger } from '../lib/logger.js';
import { getBotIdentity } from '../max/bot.js';
import { prepareNotification } from '../notify/render.js';
import { enqueueToReader } from '../notify/outbox.js';
import { notBefore } from '../domain/dates.js';

export { notBefore };
import { tlsTrustHint } from '../max/tls.js';

const log = createLogger('worker');
/** ~5 часов попыток: 30 с, 1, 2, 4, 8, 16, 32 мин, дальше раз в час — переживём сбой MAX или неудачный деплой. */
const MAX_ATTEMPTS = 12;
/** Ошибки, при которых повтор бессмыслен: неверный запрос, бот заблокирован, чат не найден. */
const PERMANENT_STATUSES = new Set([400, 403, 404]);
const BATCH = 25;
/** Сколько ждём ответа MAX на одно сообщение: без предела зависший запрос держал бы всю пачку до 5 минут (undici). */
export const SEND_TIMEOUT_MS = 15_000;
/**
 * Через сколько «зависшая» отправка возвращается в очередь (процесс упал посреди пачки).
 * Заметно больше, чем пачка × таймаут (25 × 15 с ≈ 6 мин) плюс паузы ограничителя частоты:
 * живой обработчик не должен лишиться своей пачки, иначе второй экземпляр worker разошлёт её повторно.
 */
export const STALE_SENDING_MINUTES = 30;

/** Простой ограничитель частоты: не больше NOTIFY_RPS запросов в секунду к API MAX (лимит платформы — 30). */
function createLimiter(rps: number) {
  const interval = 1000 / rps;
  let next = 0;
  return async () => {
    const now = Date.now();
    const wait = Math.max(0, next - now);
    next = Math.max(now, next) + interval;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  };
}

interface DueRow {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  person_id: string | null;
  reader_id: string | null;
  dedupe_key: string | null;
  role: string;
  max_user_id: number | null;
  simulated: boolean;
  attempts: number;
}

export async function dispatchDue(bot: Bot | null, limiter = createLimiter(config.NOTIFY_RPS)): Promise<number> {
  const claim = await tx(async (client) => {
    const rows = await many<DueRow>(
      client,
      `SELECT n.id, n.kind, n.payload, n.person_id, n.reader_id, n.dedupe_key, COALESCE(p.role, 'reader') AS role,
              u.max_user_id, n.simulated, n.attempts
         FROM notifications n
         LEFT JOIN persons p ON p.id = n.person_id
         LEFT JOIN users u ON u.id = n.user_id
        WHERE n.status = 'pending' AND n.send_after <= now()
        ORDER BY n.send_after
        LIMIT ${BATCH}
        FOR UPDATE OF n SKIP LOCKED`,
    );
    if (rows.length === 0) return { rows, claimedAt: '' };
    // Метка захвата — текстом с микросекундами: по ней ниже проверяем, что строка всё ещё за этим обработчиком
    const stamp = await one<{ at: string }>(client, 'SELECT now()::text AS at');
    await client.query(
      "UPDATE notifications SET status = 'sending', attempts = attempts + 1, claimed_at = $2::timestamptz WHERE id = ANY($1::bigint[])",
      [rows.map((r) => r.id), stamp!.at],
    );
    return { rows, claimedAt: stamp!.at };
  });
  const due = claim.rows;
  if (due.length === 0) return 0;
  const identity = await getBotIdentity(bot ?? undefined);

  for (const row of due) {
    // Перед каждой отправкой продлеваем захват. Не вышло — строку уже вернули в очередь и забрал другой экземпляр
    // worker (мы слишком долго ждали MAX): не отправляем, иначе человек получит сообщение дважды.
    const lease = await one<{ at: string }>(
      pool,
      `UPDATE notifications SET claimed_at = now() WHERE id = $1 AND status = 'sending' AND claimed_at = $2::timestamptz
       RETURNING claimed_at::text AS at`,
      [row.id, claim.claimedAt],
    );
    if (!lease) {
      log.warn('Уведомление уже обрабатывает другой worker', { id: row.id });
      continue;
    }
    // Итоговое обновление — только если строка всё ещё наша
    const finish = (sql: string, values: unknown[] = []) =>
      pool.query(`${sql} WHERE id = $1 AND status = 'sending' AND claimed_at = $2::timestamptz`, [row.id, lease.at, ...values]);
    try {
      if (row.simulated) {
        await finish("UPDATE notifications SET status = 'sent', sent_at = now()");
        continue;
      }
      const prepared = await prepareNotification(pool, row, identity);
      if (prepared.action === 'skip') {
        await finish("UPDATE notifications SET status = 'skipped', last_error = 'not_relevant'");
        continue;
      }
      if (prepared.action === 'defer') {
        // Ещё рано (объявление с будущей датой начала): вернуть в очередь, попытку не засчитывать
        await finish("UPDATE notifications SET status = 'pending', send_after = $3, attempts = GREATEST(attempts - 1, 0)", [prepared.until]);
        continue;
      }
      if (!bot || !row.max_user_id) throw new Error('bot_unavailable');
      await limiter();
      const sent = await bot.api.sendMessageToUser(row.max_user_id, prepared.message.text, {
        format: 'markdown',
        attachments: prepared.message.attachments as never,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      await finish("UPDATE notifications SET status = 'sent', sent_at = now(), max_message_id = $3, last_error = NULL", [sent?.body?.mid ?? null]);
    } catch (error) {
      // 401 (токен сменили или ошиблись), 429 и 5xx, сеть, TLS и таймаут — временные: чиним и уведомления дойдут
      const permanent = error instanceof MaxError && PERMANENT_STATUSES.has(error.status);
      const attempts = row.attempts + 1;
      const giveUp = permanent || attempts >= MAX_ATTEMPTS;
      const delaySec = Math.min(3600, 30 * 2 ** (attempts - 1));
      const cause = (error as { cause?: { code?: string } })?.cause?.code;
      const timedOut = (error as { name?: string })?.name === 'TimeoutError';
      const text = (
        tlsTrustHint(error) ??
        (timedOut
          ? `MAX не ответил за ${SEND_TIMEOUT_MS / 1000} с`
          : `${error instanceof Error ? error.message : String(error)}${cause ? ` (${cause})` : ''}`)
      ).slice(0, 300);
      if (error instanceof MaxError && error.status === 401) log.error('MAX API отклоняет токен бота (401): проверьте BOT_TOKEN в .env', { id: row.id });
      await finish('UPDATE notifications SET status = $3, last_error = $4, send_after = now() + make_interval(secs => $5)', [
        giveUp ? 'failed' : 'pending',
        text,
        delaySec,
      ]);
      log.warn('Не удалось отправить уведомление', { id: row.id, kind: row.kind, attempts, giveUp, error: text });
    }
  }
  return due.length;
}

/**
 * Напоминания о сроках из блоков «Срок» опубликованных страниц.
 * Каждому читателю, которого касается срок (аудитория блока) и который не выключил напоминания,
 * — одно сообщение за каждый день из remind_days до последнего дня срока. Повтор не отправится:
 * ключ уведомления включает срок, читателя и число дней.
 */
export async function enqueueDeadlineReminders(): Promise<number> {
  const due = await many<{ deadline_id: string; due_on: string; days_left: number; reader_id: string; user_id: number; university_id: string; timezone: string }>(
    pool,
    `SELECT DISTINCT ON (dl.id, r.user_id)
            dl.id AS deadline_id, to_char(COALESCE(dl.ends_on, dl.starts_on), 'YYYY-MM-DD') AS due_on,
            (COALESCE(dl.ends_on, dl.starts_on) - (now() AT TIME ZONE un.timezone)::date) AS days_left,
            r.id AS reader_id, r.user_id, h.university_id, un.timezone
       FROM handbook_deadlines dl
       JOIN pages pg ON pg.id = dl.page_id AND pg.status = 'published'
       JOIN sections sc ON sc.id = pg.section_id AND sc.visible
       JOIN handbooks h ON h.id = dl.handbook_id AND h.status = 'active'
       JOIN universities un ON un.id = h.university_id
                           -- демо напоминает о вымышленных сроках только первые две недели, а не месяцами
                           AND (NOT un.is_demo OR un.created_at > now() - interval '14 days')
       -- читатели этого справочника и справочников факультетов, которые его наследуют
       JOIN handbooks rh ON (rh.id = dl.handbook_id OR rh.parent_id = dl.handbook_id) AND rh.status = 'active'
       JOIN handbook_readers r ON r.handbook_id = rh.id AND r.reminders
      WHERE (COALESCE(dl.ends_on, dl.starts_on) - (now() AT TIME ZONE un.timezone)::date) = ANY(dl.remind_days)
        AND audience_matches(dl.audience, r.course::int, r.dorm, r.tags)
        AND audience_matches(pg.audience, r.course::int, r.dorm, r.tags)
        AND audience_matches(sc.audience, r.course::int, r.dorm, r.tags)
        -- факультет переписал страницу вуза — напоминает его версия, а не исходная
        AND NOT EXISTS (
          SELECT 1 FROM pages ov
           WHERE rh.id <> dl.handbook_id AND ov.handbook_id = rh.id
             AND ov.inherited_from = dl.page_id AND ov.status = 'published'
        )
        -- уже поставленные напоминания не выбираем: иначе после первых тысяч строк очередь застрянет
        AND NOT EXISTS (
          SELECT 1 FROM notifications n
           WHERE n.dedupe_key = 'hb_deadline:' || dl.id || ':' || to_char(COALESCE(dl.ends_on, dl.starts_on), 'YYYY-MM-DD')
                 || ':u' || r.user_id || ':' || (COALESCE(dl.ends_on, dl.starts_on) - (now() AT TIME ZONE un.timezone)::date)
        )
      ORDER BY dl.id, r.user_id, (rh.id = dl.handbook_id) ASC, r.last_seen_at DESC
      LIMIT 5000`,
  );
  let queued = 0;
  for (const row of due) {
    const id = await enqueueToReader(pool, {
      readerId: row.reader_id,
      userId: row.user_id,
      universityId: row.university_id,
      kind: 'handbook_deadline',
      payload: { deadlineId: row.deadline_id, daysLeft: row.days_left },
      // Не будим ночью: напоминание уходит с 10:00 до 21:00 по времени вуза, поздно вечером — на следующее утро
      sendAfter: notBefore(row.timezone, '10:00', '21:00'),
      // Один человек — одно напоминание, даже если он читает и справочник вуза, и факультета.
      // Дата срока в ключе: перенесённый срок напомнит о себе заново.
      dedupeKey: `hb_deadline:${row.deadline_id}:${row.due_on}:u${row.user_id}:${row.days_left}`,
    });
    if (id !== null) queued += 1;
  }
  if (queued) log.info('Напоминания о сроках поставлены в очередь', { count: queued });
  return queued;
}

/** Периодические проверки: напоминания о сроках, служебная уборка. */
export async function runScheduledChecks(): Promise<void> {
  // Advisory lock живёт в сессии PostgreSQL: берём и отпускаем его на одном выделенном соединении,
  // чтобы при нескольких экземплярах worker проверки выполнял только один.
  const lockClient = await pool.connect();
  let locked = false;
  try {
    locked = Boolean((await one<{ locked: boolean }>(lockClient, 'SELECT pg_try_advisory_lock(727002) AS locked'))?.locked);
  } finally {
    if (!locked) lockClient.release();
  }
  if (!locked) return;
  try {
    // Ключи принятых обновлений MAX нужны только на время возможных повторных доставок
    await pool.query("DELETE FROM processed_updates WHERE created_at < now() - interval '3 days'");
    // Уведомления, «зависшие» в отправке после падения процесса, возвращаем в очередь.
    // Живой обработчик продлевает захват перед каждым сообщением, так что его строки сюда не попадут.
    await pool.query(
      "UPDATE notifications SET status = 'pending' WHERE status = 'sending' AND claimed_at < now() - make_interval(mins => $1)",
      [STALE_SENDING_MINUTES],
    );
    await enqueueDeadlineReminders();
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock(727002)').catch(() => undefined);
    lockClient.release();
  }
}

export async function startWorker(bot: Bot | null): Promise<() => Promise<void>> {
  let stopped = false;
  const limiter = createLimiter(config.NOTIFY_RPS);
  if (bot) await getBotIdentity(bot);
  log.info('Worker запущен', { tickMs: config.WORKER_TICK_MS });

  const loop = async () => {
    let lastChecks = 0;
    while (!stopped) {
      // Сбой проверок по расписанию не должен останавливать доставку ответов и объявлений
      if (Date.now() - lastChecks > 60_000) {
        try {
          await runScheduledChecks();
        } catch (error) {
          log.error('Ошибка проверок по расписанию', error);
        } finally {
          lastChecks = Date.now();
        }
      }
      try {
        const processed = await dispatchDue(bot, limiter);
        if (processed === BATCH) continue;
      } catch (error) {
        log.error('Ошибка цикла worker', error);
      }
      await new Promise((resolve) => setTimeout(resolve, config.WORKER_TICK_MS));
    }
  };
  const running = loop();
  return async () => {
    stopped = true;
    await running;
  };
}

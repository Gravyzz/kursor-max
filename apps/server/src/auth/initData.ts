import { createHmac, timingSafeEqual } from 'node:crypto';

export interface MaxWebAppUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  photo_url?: string;
}

export interface ValidatedInitData {
  user: MaxWebAppUser;
  authDate: number;
  startParam: string | null;
  queryId: string | null;
}

export type InitDataResult = { ok: true; data: ValidatedInitData } | { ok: false; reason: string };

/**
 * Документация MAX декодирует значения через decodeURIComponent без замены «+» на пробел.
 * Вариант с «+» как пробелом проверяется вторым: подпись всё равно должна сойтись, так что безопасность не страдает.
 */
function safeDecode(value: string, plusAsSpace = false): string {
  try {
    return decodeURIComponent(plusAsSpace ? value.replace(/\+/g, '%20') : value);
  } catch {
    return value;
  }
}

function parsePairs(raw: string, plusAsSpace = false): Array<[string, string]> {
  return raw
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const index = pair.indexOf('=');
      const key = index === -1 ? pair : pair.slice(0, index);
      const value = index === -1 ? '' : pair.slice(index + 1);
      return [safeDecode(key, plusAsSpace), safeDecode(value, plusAsSpace)] as [string, string];
    });
}

function signatureFor(pairs: Array<[string, string]>, botToken: string): string {
  const dataCheckString = pairs
    .filter(([key]) => key !== 'hash')
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  return createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
}

function equalHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Проверка подписи initData мини-приложения MAX (dev.max.ru/docs/webapps/validation):
 * secret = HMAC_SHA256("WebAppData", token); hash = HMAC_SHA256(secret, отсортированные пары key=value через \n).
 */
export function validateInitData(
  initData: string,
  botToken: string,
  maxAgeSec: number,
  nowSec = Math.floor(Date.now() / 1000),
): InitDataResult {
  if (!initData) return { ok: false, reason: 'empty' };
  if (!botToken) return { ok: false, reason: 'no_bot_token' };

  // Некоторые клиенты передают строку, закодированную ещё раз целиком.
  const raws = [initData];
  if (/%26|%3D/i.test(initData) && !initData.includes('&')) raws.push(safeDecode(initData));
  const candidates = raws.flatMap((raw) => [parsePairs(raw, false), parsePairs(raw, true)]);

  for (const pairs of candidates) {
    const keys = pairs.map(([key]) => key);
    if (new Set(keys).size !== keys.length) continue;
    const hash = pairs.find(([key]) => key === 'hash')?.[1];
    if (!hash) continue;
    if (!equalHex(signatureFor(pairs, botToken), hash)) continue;

    const map = new Map(pairs);
    const authDate = Number(map.get('auth_date'));
    if (!Number.isFinite(authDate) || authDate <= 0) return { ok: false, reason: 'bad_auth_date' };
    if (nowSec - authDate > maxAgeSec) return { ok: false, reason: 'expired' };

    let user: MaxWebAppUser;
    try {
      user = JSON.parse(map.get('user') ?? '') as MaxWebAppUser;
    } catch {
      return { ok: false, reason: 'bad_user' };
    }
    if (!user || typeof user.id !== 'number') return { ok: false, reason: 'bad_user' };

    return {
      ok: true,
      data: {
        user,
        authDate,
        startParam: map.get('start_param') || null,
        queryId: map.get('query_id') || null,
      },
    };
  }
  return { ok: false, reason: 'bad_signature' };
}

/** Для тестов и max-mock: подписывает набор параметров так же, как клиент MAX. */
export function signInitData(params: Record<string, string>, botToken: string): string {
  const pairs = Object.entries(params);
  const hash = signatureFor(pairs, botToken);
  return [...pairs, ['hash', hash]]
    .map(([key, value]) => `${encodeURIComponent(key!)}=${encodeURIComponent(value!)}`)
    .join('&');
}

/**
 * Проверка номера из WebApp.requestContact() (dev.max.ru/docs/webapps/bridge, «Проверка номера телефона»):
 * HMAC_SHA256(authDate + phone + userId, botToken), где параметры в алфавитном порядке собраны в строку
 * пар key=value через \n, а номер указывается без «+».
 * Запасные варианты покрывают иную трактовку записи HMAC в документации; каждый требует знания токена бота.
 */
export function validateContact(
  input: { phone: string; authDate: string | number; hash: string },
  userId: number,
  botToken: string,
): boolean {
  if (!botToken || !input.hash) return false;
  const phone = String(input.phone).trim().replace(/^\+/, '');
  const authDate = String(input.authDate).trim();
  const documented = `authDate=${authDate}\nphone=${phone}\nuserId=${userId}`;
  const hash = input.hash.trim().toLowerCase();
  const variants = [
    createHmac('sha256', botToken).update(documented).digest('hex'),
    createHmac('sha256', documented).update(botToken).digest('hex'),
    createHmac('sha256', botToken).update(`${authDate}${phone}${userId}`).digest('hex'),
  ];
  return variants.some((expected) => equalHex(expected, hash));
}

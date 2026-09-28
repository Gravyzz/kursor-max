import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { signInitData, validateContact, validateInitData } from '../src/auth/initData.js';

const token = 'test-bot-token:ABC';
const nowSec = 1_790_000_000;

describe('initData мини-приложения', () => {
  const params = {
    auth_date: String(nowSec - 60),
    query_id: 'q-1',
    user: JSON.stringify({ id: 42, first_name: 'Анна', last_name: 'Смирнова & Ко', username: 'anna' }),
    start_param: 'hb_itfak',
  };

  it('принимает корректную подпись и возвращает пользователя', () => {
    const result = validateInitData(signInitData(params, token), token, 3600, nowSec);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.data.user.id, 42);
    assert.equal(result.ok && result.data.startParam, 'hb_itfak');
  });

  it('отклоняет подмену пользователя', () => {
    const tampered = signInitData(params, token).replace(encodeURIComponent('"id":42'), encodeURIComponent('"id":43'));
    assert.deepEqual(validateInitData(tampered, token, 3600, nowSec), { ok: false, reason: 'bad_signature' });
  });

  it('отклоняет чужой токен и устаревшие данные', () => {
    assert.equal(validateInitData(signInitData(params, token), 'other', 3600, nowSec).ok, false);
    const old = validateInitData(signInitData({ ...params, auth_date: String(nowSec - 7200) }, token), token, 3600, nowSec);
    assert.deepEqual(old, { ok: false, reason: 'expired' });
  });

  it('пример из документации: пары key=value отсортированы и объединены через \\n', () => {
    const secret = createHmac('sha256', 'WebAppData').update(token).digest();
    const check = ['auth_date=1', 'user={"id":1}'].join('\n');
    const hash = createHmac('sha256', secret).update(check).digest('hex');
    const raw = `user=${encodeURIComponent('{"id":1}')}&auth_date=1&hash=${hash}`;
    assert.equal(validateInitData(raw, token, 10, 5).ok, true);
  });
});

describe('номер телефона из requestContact', () => {
  const documented = 'authDate=1790000000\nphone=79991234567\nuserId=42';

  it('проверяет подпись в формате документации MAX: пары key=value по алфавиту через перевод строки', () => {
    const hash = createHmac('sha256', token).update(documented).digest('hex');
    assert.equal(validateContact({ phone: '+79991234567', authDate: '1790000000', hash }, 42, token), true);
    assert.equal(validateContact({ phone: '+79991234567', authDate: 1790000000, hash: hash.toUpperCase() }, 42, token), true);
  });

  it('отклоняет чужой userId, подменённый номер и чужой токен', () => {
    const hash = createHmac('sha256', token).update(documented).digest('hex');
    assert.equal(validateContact({ phone: '+79991234567', authDate: '1790000000', hash }, 43, token), false);
    assert.equal(validateContact({ phone: '+79990000000', authDate: '1790000000', hash }, 42, token), false);
    assert.equal(validateContact({ phone: '+79991234567', authDate: '1790000000', hash }, 42, 'other-token'), false);
  });
});

describe('initData: декодирование как в документации MAX', () => {
  it('буквальный «+» в значении не превращается в пробел', () => {
    const user = JSON.stringify({ id: 7, first_name: 'Анна+Мария' });
    const raw = signInitData({ auth_date: String(nowSec), user, query_id: 'q' }, token);
    const result = validateInitData(raw, token, 60, nowSec);
    assert.equal(result.ok && result.data.user.first_name, 'Анна+Мария');
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { updateKey } from '../src/bot/dedupe.js';
import { allowMessage, INVITE_RE } from '../src/bot/guards.js';

describe('идемпотентность обновлений MAX', () => {
  it('строит ключ по идентификатору события', () => {
    assert.equal(updateKey({ update_type: 'message_callback', timestamp: 1, callback: { callback_id: 'cb-1' } }), 'cb:cb-1');
    assert.equal(updateKey({ update_type: 'message_created', timestamp: 1, message: { body: { mid: 'mid.42' } } }), 'msg:mid.42');
    assert.equal(updateKey({ update_type: 'bot_started', timestamp: 1790000000000, user: { user_id: 7 } }), 'start:7:1790000000000');
  });

  it('не дедуплицирует события без надёжного идентификатора', () => {
    assert.equal(updateKey({ update_type: 'bot_started', timestamp: 1 }), null);
    assert.equal(updateKey({ update_type: 'message_created', timestamp: 1, message: null }), null);
    assert.equal(updateKey({ update_type: 'user_added', timestamp: 1 }), null);
    assert.equal(updateKey(undefined), null);
  });
});

describe('входящие сообщения', () => {
  it('код приглашения из чата распознаётся в том формате, который выдаёт сервер', () => {
    const code = 'H-AB2C-D3EF'; // формат generateInviteCode() в services/identity.ts
    assert.match(code, INVITE_RE);
    assert.match(`inv_${code}`, INVITE_RE);
    assert.doesNotMatch('как получить справку', INVITE_RE);
  });

  it('частые сообщения одного пользователя притормаживаются, другие не страдают', () => {
    const now = 1_000_000;
    for (let i = 0; i < 20; i += 1) assert.equal(allowMessage(501, now + i), 'ok');
    assert.equal(allowMessage(501, now + 30), 'warn', 'первый лишний — одно предупреждение');
    assert.equal(allowMessage(501, now + 31), 'silent', 'дальше молчим, а не отвечаем спамом на спам');
    assert.equal(allowMessage(502, now + 30), 'ok');
    assert.equal(allowMessage(501, now + 61_000), 'ok', 'через минуту снова можно');
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validReviewKey } from '../src/auth/reviewKey.js';

describe('ключ проверки API', () => {
  const key = '0123456789abcdef0123456789abcdef';

  it('принимает только точное совпадение с настроенным непустым ключом', () => {
    assert.equal(validReviewKey(key, key), true);
    assert.equal(validReviewKey(`${key}x`, key), false);
    assert.equal(validReviewKey('0123456789abcdef0123456789abcdeg', key), false);
    assert.equal(validReviewKey(undefined, key), false);
    assert.equal(validReviewKey(key, ''), false);
  });
});

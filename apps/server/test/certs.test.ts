import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';

/**
 * Без цепочки УЦ Минцифры бот не достучится до platform-api2.max.ru.
 * Тест не даёт случайно подменить или потерять файл, который подключает Dockerfile.
 */
describe('сертификаты УЦ Минцифры для MAX Bot API', () => {
  const root = new URL('../', import.meta.url);
  const pem = readFileSync(new URL('certs/russian_trusted_ca.pem', root), 'utf8');
  const certs = (pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []).map((block) => new X509Certificate(block));
  const byName = (cn: string) => certs.find((cert) => cert.subject.includes(`CN=${cn}`));

  it('в файле корневой и выпускающий сертификаты с опубликованными отпечатками', () => {
    assert.equal(certs.length, 2);
    assert.equal(
      byName('Russian Trusted Root CA')?.fingerprint256,
      'D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31',
    );
    assert.equal(byName('Russian Trusted Root CA')?.fingerprint, '8F:F9:15:CC:AB:7B:C1:6F:8C:5C:80:99:D5:3E:0E:11:5B:3A:EC:2F');
    assert.equal(
      byName('Russian Trusted Sub CA')?.fingerprint256,
      'BB:BD:E2:10:3E:79:0B:99:9E:C6:2B:D0:3C:F6:25:A5:A2:E7:C3:16:E1:0A:FE:6A:49:0E:ED:EA:D8:B3:FD:9B',
    );
  });

  it('выпускающий подписан корневым, корневой — самоподписанный', () => {
    const rootCa = byName('Russian Trusted Root CA')!;
    const subCa = byName('Russian Trusted Sub CA')!;
    assert.ok(subCa.checkIssued(rootCa) && subCa.verify(rootCa.publicKey));
    assert.ok(rootCa.verify(rootCa.publicKey));
  });

  it('Docker-образ сервера подключает файл через NODE_EXTRA_CA_CERTS', () => {
    const dockerfile = readFileSync(new URL('Dockerfile', root), 'utf8');
    assert.match(dockerfile, /COPY apps\/server\/certs \.\/certs/);
    assert.match(dockerfile, /ENV NODE_EXTRA_CA_CERTS=\/app\/certs\/russian_trusted_ca\.pem/);
  });
});

describe('подсказка при ошибке TLS', () => {
  it('узнаёт недоверие к сертификату в цепочке причин fetch', async () => {
    const { tlsTrustHint } = await import('../src/max/tls.js');
    const error = new TypeError('fetch failed', { cause: Object.assign(new Error('unable to get local issuer certificate'), { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' }) });
    assert.match(tlsTrustHint(error) ?? '', /Минцифры/);
    assert.equal(tlsTrustHint(new Error('timeout')), null);
  });
});

/** Без зависимостей от конфигурации: используется и в тестах, и в диагностике check-max. */

/**
 * MAX Bot API (platform-api2.max.ru) отвечает сертификатом УЦ Минцифры (Russian Trusted CA),
 * которого нет в стандартном наборе Node.js. В Docker-образе сервера цепочка подключена через
 * NODE_EXTRA_CA_CERTS (apps/server/certs); без Docker её нужно указать самому.
 * Возвращает понятную подсказку, если ошибка похожа на недоверие к сертификату.
 */
export function tlsTrustHint(error: unknown): string | null {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') codes.push(code);
    current = (current as { cause?: unknown }).cause;
  }
  if (!codes.some((code) => /CERT|ISSUER|SELF_SIGNED|VERIFY/.test(code))) return null;
  return process.env.NODE_EXTRA_CA_CERTS
    ? `TLS-ошибка ${codes.join(', ')} при заданном NODE_EXTRA_CA_CERTS=${process.env.NODE_EXTRA_CA_CERTS}: проверьте, что файл на месте и содержит сертификаты Минцифры`
    : `MAX API отвечает сертификатом УЦ Минцифры, которому Node.js не доверяет (${codes.join(', ')}). ` +
        'Запустите сервер с NODE_EXTRA_CA_CERTS=<путь>/apps/server/certs/russian_trusted_ca.pem — в Docker-образе это уже сделано';
}

# Сертификаты УЦ Минцифры для MAX Bot API

MAX Bot API (`platform-api2.max.ru`) отвечает сертификатом, выпущенным Национальным удостоверяющим
центром Минцифры (Russian Trusted CA). Документация MAX прямо просит добавить его в доверенные. В наборе
корневых сертификатов Node.js его нет, поэтому без этого файла любой запрос бота к MAX падает с ошибкой
`UNABLE_TO_GET_ISSUER_CERT_LOCALLY` или `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.

`russian_trusted_ca.pem` — два публичных сертификата (не секрет):

| Сертификат | Действует до | SHA-256 | SHA-1 |
|---|---|---|---|
| Russian Trusted Root CA | 2032-02-27 | `D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31` | `8F:F9:15:CC:AB:7B:C1:6F:8C:5C:80:99:D5:3E:0E:11:5B:3A:EC:2F` |
| Russian Trusted Sub CA | 2027-03-06 | `BB:BD:E2:10:3E:79:0B:99:9E:C6:2B:D0:3C:F6:25:A5:A2:E7:C3:16:E1:0A:FE:6A:49:0E:ED:EA:D8:B3:FD:9B` | `33:5D:43:F5:34:51:B7:81:53:5F:F3:88:2D:F7:13:D3:C1:4F:8A:01` |

Источник — официальный файл Госуслуг `https://gu-st.ru/content/Other/doc/russiantrustedca.pem`
(страница https://www.gosuslugi.ru/crt); тот же файл поставляется в Python-библиотеке MAX `maxapi`.
Отпечаток корня сверен с опубликованными значениями; тест `test/certs.test.ts` проверяет отпечатки и цепочку.

**Как подключено.** В Docker-образе сервера: `ENV NODE_EXTRA_CA_CERTS=/app/certs/russian_trusted_ca.pem`
(см. `apps/server/Dockerfile`) — сертификаты добавляются к стандартным, проверка TLS остаётся включённой.
Без Docker запускайте сервер из папки `apps/server` (нужны Node.js 22 и PostgreSQL 16). Сервер сам `.env`
не читает: переменные загружаются в оболочку, а `DATABASE_URL` задаётся отдельно (в Docker его собирает compose).

```bash
cd apps/server
npm ci && npm run build
set -a && . ../../.env && set +a        # .env, заполненный по .env.production.example
export DATABASE_URL=postgres://<пользователь>:<пароль>@localhost:5432/<база>
NODE_EXTRA_CA_CERTS=$PWD/certs/russian_trusted_ca.pem node dist/index.js check-max   # связь с MAX
NODE_EXTRA_CA_CERTS=$PWD/certs/russian_trusted_ca.pem node dist/index.js all         # миграции, API, бот и worker
```

Если путь в `NODE_EXTRA_CA_CERTS` неверный, Node.js лишь печатает предупреждение и продолжает без
сертификатов Минцифры — запросы к MAX снова падают с ошибкой TLS, а `check-max` подскажет, что проверить.

Проверка связи после развёртывания в Docker: `docker compose exec bot node dist/index.js check-max`.

**Обновление.** Выпускающий сертификат действует до марта 2027 года. Когда Минцифры выпустит новый,
замените файл и отпечатки в тесте.

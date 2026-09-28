# Развёртывание с настоящим MAX: пошагово

Около часа работы. Результат: бот и мини-приложение работают в MAX по HTTPS, жюри открывает бота по ссылке из начала [README](../README.md).

**Что понадобится**

- VPS с Ubuntu 22.04 или 24.04: 2 vCPU, 2–4 ГБ памяти, 20 ГБ диска. Лучше в России: там без проблем доступны MAX API и зеркала образов.
- Домен или поддомен, который можно направить на сервер, например `kursor.example.ru`.
- Токен бота от организаторов. Ник бота после создания не меняется — выбирайте один раз.
- Сервер должен работать до конца проверки (14 октября) и до финала (29 октября).

## 1. Сервер и DNS

В панели регистратора домена создайте A-запись `kursor.<ваш домен>` → IP сервера. Затем на сервере:

```bash
ssh root@<IP сервера>
curl -fsSL https://get.docker.com | sh
docker compose version          # нужна 2.24 или новее
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp && ufw --force enable
dig +short kursor.<ваш домен>   # должен вернуть IP сервера
```

Порт 80 обязателен: через него Caddy получает сертификат Let's Encrypt.

## 2. Код и настройки

```bash
git clone https://github.com/Gravyzz/kursor-max.git
cd kursor-max
git checkout <хеш-из-файла-сдачи>  # точная финальная версия
cp .env.production.example .env
sed -i "s/^WEBHOOK_SECRET=.*/WEBHOOK_SECRET=$(openssl rand -hex 32)/" .env
sed -i "s/^APP_SECRET=.*/APP_SECRET=$(openssl rand -hex 32)/" .env
sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" .env
nano .env
```

В `nano` заполните три строки и сохраните (Ctrl+O, Enter, Ctrl+X):

```
SITE_ADDRESS=kursor.<ваш домен>
PUBLIC_URL=https://kursor.<ваш домен>
BOT_TOKEN=<токен от организаторов>
```

Остальное не трогайте: `DEMO_ENABLED=true` нужен жюри, `DEV_AUTH=false` обязателен на сервере.

## 3. Запуск и проверка

```bash
docker compose up --build -d
docker compose ps -a                                # api — healthy, migrate — exited (0)
docker compose exec bot node dist/index.js check-max
```

`check-max` должен вывести три строки с ✅:

1. MAX API отвечает и называет вашего бота.
2. Webhook указывает на `https://kursor.<ваш домен>/webhook/max`.
3. `/api/health` мини-приложения отвечает 200.

## 4. Подключить мини-приложение к боту

В настройках бота на платформе MAX для партнёров укажите адрес мини-приложения `https://kursor.<ваш домен>/`. Затем откройте в MAX `https://max.ru/t753_hakaton_max_bot?start=demo` и пройдите [сценарий А из README](../README.md#а-в-max-мобильное-приложение-или-веб-версия) — на телефоне и в веб-версии.

Если организаторам нужна автоматическая проверка API, сгенерируйте отдельный ключ `openssl rand -hex 32`, задайте его как `REVIEW_API_KEY` в серверном `.env` и передайте только в закрытом файле сдачи. Инструкция — в [`API_REVIEW.md`](API_REVIEW.md).

Для мониторинга добавьте `https://kursor.<ваш домен>/api/health` в любой сервис проверки доступности, например UptimeRobot, с уведомлением в Telegram или на почту.

## Если что-то не так

| Симптом | Причина | Что сделать |
|---|---|---|
| `check-max`: ошибка TLS, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` | Образ собран из версии без сертификатов Минцифры | Проверьте, что в коммите есть `apps/server/certs/russian_trusted_ca.pem`, затем `docker compose up --build -d` |
| `check-max`: 401 или `Invalid access_token` | Неверный `BOT_TOKEN` | Исправьте `.env`, затем `docker compose up -d` |
| Webhook ❌, в `docker compose logs web` ошибки ACME | DNS ещё не обновился или закрыт порт 80 | Проверьте `dig` и `ufw status`, подождите 5–10 минут, `docker compose restart web` |
| Webhook так и не заработал | MAX не достучался до сервера | Временно `BOT_MODE=polling` в `.env`, затем `docker compose up -d bot worker` — бот сам забирает обновления |
| Бот молчит, в `docker compose logs bot` ошибки 400 при отправке | Кнопка мини-приложения не принята: адрес мини-приложения не указан в настройках бота | Укажите адрес (шаг 4) или временно `MINIAPP_BUTTON=link` в `.env` и `docker compose up -d bot worker` |
| В браузере «Откройте приложение из MAX» | Это нормально: без подписи MAX вход закрыт | Открывайте через кнопку бота |
| Сборка падает на скачивании образов (403, 429) | Docker Hub недоступен из сети сервера | `IMAGE_REGISTRY=dockerhub.timeweb.cloud/library` в `.env` |

**Не запускайте второй экземпляр бота с тем же токеном** (например, локально с настоящим токеном): он заберёт обновления у сервера или перепишет webhook. Для локальной проверки токен не нужен — там имитация MAX.

Журналы: `docker compose logs -f bot api worker`. Перезапуск без изменений кода: `docker compose restart`. После дедлайна код на сервере не меняйте — жюри проверяет зафиксированный коммит.

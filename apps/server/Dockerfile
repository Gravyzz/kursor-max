# Курсор: бот, API мини-приложения и воркер уведомлений.
# Один образ — роль выбирается командой контейнера: migrate | api | bot | worker | all | bootstrap | check-max.
# Контекст сборки — корень репозитория: docker build -f apps/server/Dockerfile .

# Откуда брать базовые образы. При недоступности Docker Hub: IMAGE_REGISTRY=dockerhub.timeweb.cloud/library
ARG IMAGE_REGISTRY=docker.io/library

FROM ${IMAGE_REGISTRY}/node:22-alpine AS build
WORKDIR /app
COPY apps/server/package.json apps/server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/server/tsconfig.json apps/server/tsconfig.build.json ./
COPY apps/server/src ./src
RUN npm run build && npm prune --omit=dev

FROM ${IMAGE_REGISTRY}/node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY apps/server/migrations ./migrations
# MAX Bot API (platform-api2.max.ru) подписан УЦ Минцифры — добавляем его к доверенным для Node.js,
# иначе каждый запрос к MAX падает с UNABLE_TO_GET_ISSUER_CERT_LOCALLY. Проверка TLS не отключается.
COPY apps/server/certs ./certs
ENV NODE_EXTRA_CA_CERTS=/app/certs/russian_trusted_ca.pem
# Процесс не работает от root
USER node
EXPOSE 3000 3001
ENTRYPOINT ["node", "dist/index.js"]
CMD ["all"]

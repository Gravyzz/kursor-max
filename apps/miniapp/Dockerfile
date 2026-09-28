# Курсор: мини-приложение MAX (React + MAX UI) и входной веб-сервер Caddy.
# Caddy отдаёт статику, проксирует /api → api:3000 и /webhook → bot:3001,
# а при указании домена в SITE_ADDRESS сам получает TLS-сертификат (MAX требует HTTPS).
# Контекст сборки — корень репозитория: docker build -f apps/miniapp/Dockerfile .

# Откуда брать базовые образы. При недоступности Docker Hub: IMAGE_REGISTRY=dockerhub.timeweb.cloud/library
ARG IMAGE_REGISTRY=docker.io/library

FROM ${IMAGE_REGISTRY}/node:22-alpine AS build
WORKDIR /app
COPY apps/miniapp/package.json apps/miniapp/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/miniapp/tsconfig.json apps/miniapp/vite.config.ts apps/miniapp/index.html ./
COPY apps/miniapp/public ./public
COPY apps/miniapp/src ./src
RUN npm run build

FROM ${IMAGE_REGISTRY}/caddy:2-alpine AS runtime
COPY apps/miniapp/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
EXPOSE 8080 80 443

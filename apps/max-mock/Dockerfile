# Курсор: имитация MAX Bot API для офлайн-проверки без токена (только локальный запуск).
# Зависимостей нет — используется только стандартная библиотека Node.js.
# Контекст сборки — корень репозитория: docker build -f apps/max-mock/Dockerfile .

ARG IMAGE_REGISTRY=docker.io/library
FROM ${IMAGE_REGISTRY}/node:22-alpine
WORKDIR /app
COPY apps/max-mock/package.json apps/max-mock/server.mjs ./
USER node
EXPOSE 9090
CMD ["node", "server.mjs"]

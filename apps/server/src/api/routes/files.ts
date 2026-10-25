import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { notFound } from '../../lib/errors.js';
import { readFile } from '../../services/files.js';

const fileParams = z.object({ id: z.string().uuid('Файл не найден'), name: z.string().optional() });

/**
 * Файл из блока «Файл». Открывается во внешнем браузере по ссылке из мини-приложения, поэтому без входа через MAX:
 * id случайный, как у ссылки «доступ по ссылке». Только для API-сервера: в браузерном демо файл открывает сама витрина.
 */
export function registerFileRoutes(app: FastifyInstance) {
  const handler = async (request: { params: unknown }, reply: import('fastify').FastifyReply) => {
    const { id } = fileParams.parse(request.params);
    const file = await readFile(pool, id);
    if (!file) throw notFound('Файл не найден: его убрали со страницы или справочник закрыт');
    const encoded = encodeURIComponent(file.name);
    return reply
      .header('content-type', file.mime)
      .header('content-length', String(file.size))
      .header('content-disposition', `${file.inline ? 'inline' : 'attachment'}; filename="file"; filename*=UTF-8''${encoded}`)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox")
      .header('cache-control', 'private, max-age=3600')
      .send(Buffer.from(file.data));
  };
  app.get('/api/files/:id', handler);
  // Имя в адресе — чтобы браузер и «Сохранить как» показывали понятное название
  app.get('/api/files/:id/:name', handler);
}

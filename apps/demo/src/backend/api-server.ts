/** Замена api/server.ts: маршрутам нужна только общая схема параметра :id. */
import { z } from 'zod';

export const uuidParam = z.object({ id: z.string().uuid('Некорректный идентификатор') });

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { one, pool } from '../../db/pool.js';
import { AppError, forbidden, notFound } from '../../lib/errors.js';
import { uuidParam } from '../server.js';
import { baseHandbook, contextFor, findHandbook, membership } from '../../services/handbook.js';
import { uploadFile, uploadSchema } from '../../services/files.js';
import {
  addMember, analytics, announce, announcementSchema, announcementUpdateSchema, answerQuestion, archivePage, createHandbook, deleteAnnouncement,
  inviteEditor, inviteSchema, listAnnouncements, updateAnnouncement,
  createPage, editorStructure, handbookInputSchema, listMembers,
  teamPowers, editorDeadlines, pageForEditor,
  pageInputSchema, pageVersionSchema, parsePageDraft, publishPage, removeMember, returnPage, returnPageSchema, saveDraft, sectionInputSchema,
  createSection, sectionPatchSchema, submitForReview, updateSection, verifyPage, setOwnership, ownershipSchema, setFacultyScope, facultyScopeSchema,
  type EditorScope,
} from '../../services/handbook-editor.js';
import {
  ackOverride, archiveSupplement, baseUsage, compareOverride, createOverride, overrideInputSchema, pageImpact, publishSupplement,
  revertOverride, saveSupplement, sharedBaseId, sharedForFaculty, sharedPage, submitSupplement, supplementInputSchema, supplementReviewSchema,
} from '../../services/shared.js';
import { RETENTION_DAYS, closeHandbook, manageableHandbooks, reopenHandbook } from '../../services/lifecycle.js';

/**
 * Редактор справочника: студсовет, тьюторы и деканат ведут содержимое с телефона.
 * Право даёт членство в справочнике; сотрудник деканата своего института — администратор по должности.
 */
async function scope(request: FastifyRequest): Promise<EditorScope> {
  if (!request.actor) throw new AppError('unauthorized', 'Нужен вход через MAX', 401);
  const query = z
    .object({ handbookId: z.string().uuid().optional(), handbook: z.string().trim().max(80).optional() })
    .partial()
    .parse(request.query ?? {});
  // Явно указанный справочник обязан существовать: после сброса демо старый id не должен молча
  // превратиться в другой справочник, где правка или рассылка уйдут не туда.
  // Без явного справочника берём тот же, что открыт у пользователя как у читателя.
  const explicit = Boolean(query.handbookId || query.handbook);
  const handbook = explicit
    ? await findHandbook(pool, { id: query.handbookId ?? null, slug: query.handbook ?? null })
    : (await contextFor(request.actor.user))?.handbook;
  if (!handbook) throw notFound(explicit ? 'Справочник не найден — возможно, демо сбросили. Откройте его заново из чата' : 'Справочник не найден');
  if (request.actor.viaReviewAuth) {
    const owned = await one<{ ok: boolean }>(
      pool,
      'SELECT EXISTS (SELECT 1 FROM universities WHERE id = $1 AND is_demo AND demo_owner_user_id = $2) AS ok',
      [handbook.university_id, request.actor.user.id],
    );
    if (!owned?.ok) throw forbidden('Ключ проверки работает только с собственной модельной демо-песочницей');
  }
  const member = await membership(pool, handbook.id, request.actor.user);
  if (!member) throw forbidden('Редактор открыт только команде справочника. В команду приглашает деканат личной ссылкой');
  return {
    handbook,
    role: member.role,
    // Правки подписываются записью вуза, которая даёт право на этот справочник
    personId: member.personId,
    userId: request.actor.user.id,
  };
}

export function registerHandbookEditorRoutes(app: FastifyInstance) {
  app.post('/api/handbook-editor/handbooks', async (request) => {
    const person = request.actor?.person;
    if (!person || (person.role !== 'dean' && !(person.isDemo && person.role === 'staff'))) {
      throw forbidden('Создавать справочник может деканат или редактор своей демо-песочницы');
    }
    const body = handbookInputSchema.parse(request.body);
    return createHandbook(
      {
        personId: person.id,
        userId: request.actor!.user.id,
        universityId: person.universityId,
        role: person.role,
        instituteId: person.instituteId,
        isDemo: person.isDemo,
      },
      body,
    );
  });

  // Справочники факультета, которыми человек управляет, — с закрытыми, пока их можно вернуть
  app.get('/api/handbook-editor/handbooks', async (request) => {
    if (!request.actor) throw new AppError('unauthorized', 'Нужен вход через MAX', 401);
    const person = request.actor.person;
    return {
      handbooks: await manageableHandbooks(pool, request.actor.user),
      retentionDays: RETENTION_DAYS,
      /** Есть ли у вуза общая база: только тогда при создании справочника есть выбор «подключить общие страницы». */
      hasBase: person ? Boolean(await baseHandbook(pool, person.universityId)) : false,
    };
  });

  app.post('/api/handbook-editor/handbooks/:id/close', async (request) => {
    if (!request.actor) throw new AppError('unauthorized', 'Нужен вход через MAX', 401);
    const { id } = uuidParam.parse(request.params);
    return closeHandbook(pool, request.actor.user, id);
  });

  app.post('/api/handbook-editor/handbooks/:id/reopen', async (request) => {
    if (!request.actor) throw new AppError('unauthorized', 'Нужен вход через MAX', 401);
    const { id } = uuidParam.parse(request.params);
    return reopenHandbook(pool, request.actor.user, id);
  });

  // Файл для блока «Файл»: до 10 МБ, в base64 — поэтому тело запроса больше обычного
  app.post('/api/handbook-editor/files', { bodyLimit: 15 * 1024 * 1024 }, async (request) => uploadFile(pool, await scope(request), uploadSchema.parse(request.body)));

  // Сроки для студентов: блоки «Срок» опубликованных страниц и черновые, которые студенты ещё не видят
  app.get('/api/handbook-editor/deadlines', async (request) => editorDeadlines(pool, await scope(request)));

  app.get('/api/handbook-editor/structure', async (request) => {
    const editor = await scope(request);
    const isBase = editor.handbook.institute_id === null;
    return {
      handbook: {
        id: editor.handbook.id, slug: editor.handbook.slug, title: editor.handbook.title, emoji: editor.handbook.emoji,
        /** Общая база университета: редактор показывает ответственных, сроки и кто использует страницу. */
        isBase,
        hasBase: Boolean(editor.handbook.parent_id),
      },
      role: editor.role,
      sections: await editorStructure(pool, editor),
      /** Общие страницы над справочником факультета — в тех же разделах, что видит студент. */
      shared: isBase ? [] : await sharedForFaculty(pool, editor),
      /** Для общей базы: сколько факультетов показывают страницу, уточнения, свои версии. */
      usage: isBase ? await baseUsage(pool, editor.handbook.id) : {},
    };
  });

  app.post('/api/handbook-editor/sections', async (request) => {
    const editor = await scope(request);
    return createSection(pool, editor, sectionInputSchema.parse(request.body));
  });

  // Правка раздела меняет только переданные поля
  app.patch('/api/handbook-editor/sections/:id', async (request) => {
    const editor = await scope(request);
    const { id } = uuidParam.parse(request.params);
    return updateSection(pool, editor, id, sectionPatchSchema.parse(request.body ?? {}));
  });

  app.post('/api/handbook-editor/pages', async (request) => {
    const editor = await scope(request);
    return createPage(pool, editor, pageInputSchema.parse(request.body));
  });

  app.get('/api/handbook-editor/pages/:id', async (request) => {
    const editor = await scope(request);
    const { id } = uuidParam.parse(request.params);
    return pageForEditor(pool, editor, id);
  });

  app.patch('/api/handbook-editor/pages/:id', async (request) => {
    const editor = await scope(request);
    const { id } = uuidParam.parse(request.params);
    return saveDraft(pool, editor, id, parsePageDraft(request.body));
  });

  app.post('/api/handbook-editor/pages/:id/review', async (request) => {
    const editor = await scope(request);
    const { id } = uuidParam.parse(request.params);
    const body = z.object({ note: z.string().trim().max(300).optional().nullable() }).parse(request.body ?? {});
    return submitForReview(pool, editor, id, body.note || null);
  });

  app.post('/api/handbook-editor/pages/:id/publish', async (request) => {
    const editor = await scope(request);
    const { id } = uuidParam.parse(request.params);
    const body = z.object({ baseUpdatedAt: pageVersionSchema.optional().nullable() }).parse(request.body ?? {});
    return publishPage(pool, editor, id, body.baseUpdatedAt ?? null);
  });

  // Вернуть страницу с проверки на доработку с причиной (только администратор)
  app.post('/api/handbook-editor/pages/:id/return', async (request) => {
    const editor = await scope(request);
    const { id } = uuidParam.parse(request.params);
    const body = returnPageSchema.parse(request.body ?? {});
    return returnPage(pool, editor, id, body.note || null);
  });

  app.post('/api/handbook-editor/pages/:id/archive', async (request) => {
    const editor = await scope(request);
    const { id } = uuidParam.parse(request.params);
    return archivePage(pool, editor, id);
  });

  // Ответственный подтверждает, что страница актуальна, без новой публикации
  app.post('/api/handbook-editor/pages/:id/verify', async (request) => {
    const editor = await scope(request);
    const { id } = uuidParam.parse(request.params);
    return verifyPage(pool, editor, id);
  });

  app.patch('/api/handbook-editor/pages/:id/ownership', async (request) => {
    const editor = await scope(request);
    const { id } = uuidParam.parse(request.params);
    return setOwnership(pool, editor, id, ownershipSchema.parse(request.body ?? {}));
  });

  // Для каких факультетов общая страница
  app.patch('/api/handbook-editor/pages/:id/faculties', async (request) => {
    const editor = await scope(request);
    const { id } = uuidParam.parse(request.params);
    return setFacultyScope(pool, editor, id, facultyScopeSchema.parse(request.body ?? {}));
  });

  // Кто использует общую страницу: факультеты, уточнения, свои версии
  app.get('/api/handbook-editor/pages/:id/impact', async (request) => {
    const editor = await scope(request);
    const { id } = uuidParam.parse(request.params);
    if (editor.handbook.institute_id !== null) throw new AppError('not_base', 'Влияние считается только для страниц общей базы', 409);
    return pageImpact(pool, editor.handbook.id, id);
  });

  app.get('/api/handbook-editor/pages/:id/compare', async (request) => {
    const editor = await scope(request);
    const { id } = uuidParam.parse(request.params);
    return compareOverride(pool, editor, id);
  });

  app.post('/api/handbook-editor/pages/:id/override/ack', async (request) => {
    const editor = await scope(request);
    const { id } = uuidParam.parse(request.params);
    return ackOverride(pool, editor, id);
  });

  app.post('/api/handbook-editor/pages/:id/override/revert', async (request) => {
    const editor = await scope(request);
    const { id } = uuidParam.parse(request.params);
    return revertOverride(pool, editor, id);
  });

  // Общая страница в редакторе факультета: общая часть, уточнение, своя версия
  app.get('/api/handbook-editor/shared/:id', async (request) => {
    const editor = await scope(request);
    const { id } = uuidParam.parse(request.params);
    const baseId = await sharedBaseId(pool, editor, id);
    return sharedPage(pool, editor, baseId);
  });

  app.put('/api/handbook-editor/shared/:id/supplement', async (request) => {
    const editor = await scope(request);
    const { id } = uuidParam.parse(request.params);
    const baseId = await sharedBaseId(pool, editor, id);
    return saveSupplement(pool, editor, baseId, supplementInputSchema.parse(request.body));
  });

  app.post('/api/handbook-editor/shared/:id/supplement/review', async (request) => {
    const editor = await scope(request);
    const { id } = uuidParam.parse(request.params);
    const baseId = await sharedBaseId(pool, editor, id);
    const body = supplementReviewSchema.parse(request.body ?? {});
    return submitSupplement(pool, editor, baseId, body.note ?? null);
  });

  app.post('/api/handbook-editor/shared/:id/supplement/publish', async (request) => {
    const editor = await scope(request);
    const { id } = uuidParam.parse(request.params);
    const baseId = await sharedBaseId(pool, editor, id);
    return publishSupplement(pool, editor, baseId);
  });

  app.post('/api/handbook-editor/shared/:id/supplement/archive', async (request) => {
    const editor = await scope(request);
    const { id } = uuidParam.parse(request.params);
    const baseId = await sharedBaseId(pool, editor, id);
    return archiveSupplement(pool, editor, baseId);
  });

  app.post('/api/handbook-editor/shared/:id/override', async (request) => {
    const editor = await scope(request);
    const { id } = uuidParam.parse(request.params);
    const baseId = await sharedBaseId(pool, editor, id);
    const body = overrideInputSchema.parse(request.body ?? {});
    return createOverride(pool, editor, baseId, body.reason);
  });

  app.get('/api/handbook-editor/analytics', async (request) => analytics(pool, await scope(request)));

  app.post('/api/handbook-editor/questions/:id/answer', async (request) => {
    const editor = await scope(request);
    const { id } = uuidParam.parse(request.params);
    const body = z
      .object({ answer: z.string().trim().min(2, 'Напишите ответ').max(1500), addToPageId: z.string().uuid().optional().nullable() })
      .parse(request.body);
    return answerQuestion(pool, editor, id, body.answer, body.addToPageId ?? null);
  });

  app.post('/api/handbook-editor/announcements', async (request) => {
    const editor = await scope(request);
    return announce(pool, editor, announcementSchema.parse(request.body));
  });

  app.get('/api/handbook-editor/announcements', async (request) => {
    const editor = await scope(request);
    return { announcements: await listAnnouncements(pool, editor), role: editor.role };
  });

  app.patch('/api/handbook-editor/announcements/:id', async (request) => {
    const editor = await scope(request);
    const { id } = uuidParam.parse(request.params);
    return updateAnnouncement(pool, editor, id, announcementUpdateSchema.parse(request.body));
  });

  app.delete('/api/handbook-editor/announcements/:id', async (request) => {
    const editor = await scope(request);
    const { id } = uuidParam.parse(request.params);
    return deleteAnnouncement(pool, editor, id);
  });

  app.get('/api/handbook-editor/members', async (request) => {
    const editor = await scope(request);
    return { members: await listMembers(pool, editor), role: editor.role, ...(await teamPowers(pool, editor)) };
  });

  app.post('/api/handbook-editor/members', async (request) => {
    const editor = await scope(request);
    const body = z.object({ personId: z.string().uuid('Выберите человека'), role: z.enum(['editor', 'admin']) }).parse(request.body);
    return addMember(pool, editor, body.personId, body.role);
  });

  app.post('/api/handbook-editor/invites', async (request) => {
    const editor = await scope(request);
    return inviteEditor(pool, editor, inviteSchema.parse(request.body));
  });

  app.delete('/api/handbook-editor/members/:id', async (request) => {
    const editor = await scope(request);
    const { id } = uuidParam.parse(request.params);
    return removeMember(pool, editor, id);
  });
}

import { z } from 'zod';
import type { Db } from '../db/pool.js';
import { one } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { audit } from './common.js';
import type { EditorScope } from './handbook-editor.js';

/** Не больше 10 МБ: бланк, шаблон заявления или памятка, а не видеозапись. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Какие файлы принимаем — по расширению. HTML, SVG и скрипты не принимаем: файл открывается с нашего домена,
 * и такой «бланк» мог бы выполнить код у студента.
 */
export const FILE_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  rtf: 'application/rtf',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  zip: 'application/zip',
};

/** Что можно открыть прямо в браузере; остальное скачивается. */
const INLINE = new Set(['application/pdf', 'image/jpeg', 'image/png', 'text/plain; charset=utf-8']);

export const uploadSchema = z.object({
  name: z.string().trim().min(1, 'У файла нет имени').max(200, 'Слишком длинное имя файла — переименуйте файл'),
  /** Содержимое в base64: мини-приложение шлёт JSON, как и остальные запросы. */
  data: z.string().min(1, 'Файл пустой'),
});

/** Имя без пути и служебных символов: «C:\\fakepath\\Заявление.docx» → «Заявление.docx». */
export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\u0000-\u001f\u007f"<>|*?:]/g, '').trim().slice(0, 200) || 'file';
}

export function fileExtension(name: string): string {
  const match = /\.([a-z0-9]{1,5})$/i.exec(name);
  return match ? match[1]!.toLowerCase() : '';
}

/** base64 → байты: и в Node, и в браузерном демо (там нет Buffer). */
function decodeBase64(text: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return Buffer.from(text, 'base64');
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Загрузить файл для блока «Файл». Права — как на правку страниц: любой участник команды справочника. */
export async function uploadFile(db: Db, scope: EditorScope, input: z.infer<typeof uploadSchema>) {
  const name = cleanFileName(input.name);
  const mime = FILE_TYPES[fileExtension(name)];
  if (!mime) {
    throw new AppError('file_type', 'Такой файл не подойдёт. Загрузите PDF, Word, Excel, PowerPoint, картинку JPG или PNG, текст или архив ZIP', 400);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.data)) throw new AppError('file_broken', 'Файл не прочитался — выберите его ещё раз', 400);
  const data = decodeBase64(input.data);
  if (data.length === 0) throw new AppError('file_empty', 'Файл пустой — выберите другой', 400);
  if (data.length > MAX_FILE_BYTES) throw new AppError('file_too_large', 'Файл больше 10 МБ — сожмите его или разделите на части', 413);
  const row = await one<{ id: string }>(
    db,
    'INSERT INTO handbook_files(handbook_id, name, mime, size, data, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [scope.handbook.id, name, mime, data.length, data, scope.personId],
  );
  await audit(db, {
    universityId: scope.handbook.university_id, actorPersonId: scope.personId, actorUserId: scope.userId,
    action: 'handbook.file.upload', entity: 'file', entityId: row!.id, data: { name, size: data.length },
  });
  return { id: row!.id, name, size: data.length, mime };
}

/** Файл для студента. Справочник закрыт — файла больше нет, как и самого справочника. */
export async function readFile(db: Db, id: string): Promise<{ name: string; mime: string; size: number; data: Uint8Array; inline: boolean } | null> {
  const row = await one<{ name: string; mime: string; size: number; data: Uint8Array }>(
    db,
    `SELECT f.name, f.mime, f.size, f.data FROM handbook_files f JOIN handbooks h ON h.id = f.handbook_id
      WHERE f.id = $1 AND h.status <> 'archived'`,
    [id],
  );
  return row ? { ...row, inline: INLINE.has(row.mime) } : null;
}

/**
 * Файлы, которые загрузили, но так и не оставили ни на одной странице, уточнении или в истории версий:
 * через двое суток удаляем, чтобы база не копила черновой мусор.
 */
export async function purgeOrphanFiles(db: Db): Promise<number> {
  const result = await db.query(
    `DELETE FROM handbook_files f
      WHERE f.created_at < now() - interval '2 days'
        AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.handbook_id = f.handbook_id
                          AND (strpos(p.blocks::text, f.id::text) > 0 OR strpos(COALESCE(p.draft_blocks::text, ''), f.id::text) > 0))
        AND NOT EXISTS (SELECT 1 FROM page_supplements s WHERE s.handbook_id = f.handbook_id
                          AND (strpos(s.blocks::text, f.id::text) > 0 OR strpos(COALESCE(s.draft_blocks::text, ''), f.id::text) > 0))
        AND NOT EXISTS (SELECT 1 FROM page_versions v JOIN pages p ON p.id = v.page_id
                         WHERE p.handbook_id = f.handbook_id AND strpos(v.blocks::text, f.id::text) > 0)`,
  );
  return result.rowCount ?? 0;
}

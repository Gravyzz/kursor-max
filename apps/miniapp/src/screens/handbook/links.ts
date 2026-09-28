import { api } from '../../lib/api';
import type { HandbookHome } from '../../lib/types';
import type { HandbookRoute } from './context';

/**
 * Диплинки мини-приложения (параметр startapp):
 *   hbp_<id страницы> — страница справочника
 *   hbe               — редактор справочника
 *   hbe_<id страницы> — страница в редакторе (из уведомления «ждёт проверки»)
 *   dean              — экран деканата: создать справочник, команда
 * hb и hb_<слаг справочника> обрабатывает сервер: они выбирают сам справочник.
 */
export function handbookStartRoutes(param: string | null): HandbookRoute[] {
  if (!param) return [];
  if (param.startsWith('hbp_')) return [{ name: 'hb-page', id: param.slice(4) }];
  if (param === 'hbe' || param === 'hb_edit') return [{ name: 'hb-editor' }];
  if (param.startsWith('hbe_')) return [{ name: 'hb-editor' }, { name: 'hb-editor-page', id: param.slice(4) }];
  if (param === 'dean') return [{ name: 'hb-create' }];
  return [];
}

/** Параметр из ссылки MAX (QR-плакат): https://max.ru/<бот>?startapp=hbp_… или ?start=hb_… */
export function paramFromLink(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (!/(^|\.)max\.ru$/i.test(url.hostname)) return null;
    return url.searchParams.get('startapp') || url.searchParams.get('start') || null;
  } catch {
    return null;
  }
}

export type ScanTarget =
  /** Справочник (возможно, другой) и параметр запуска внутри него: hb_<слаг>, hbp_<страница> */
  | { kind: 'handbook'; handbookId: string; start: string | null }
  /** Экран текущего справочника: редактор, деканат */
  | { kind: 'route'; route: HandbookRoute };

/**
 * Разобрать отсканированный QR-код. Справочник страницы определяет сервер (/api/handbook?page=…):
 * плакат другого факультета откроет свой справочник, а не «страница не найдена» в текущем.
 */
export async function resolveScanned(value: string): Promise<ScanTarget | null> {
  const param = paramFromLink(value);
  if (!param) return null;
  if (param.startsWith('hb_') && param !== 'hb_edit') {
    const home = await api<HandbookHome>(`/api/handbook?handbook=${encodeURIComponent(param.slice(3))}`);
    return { kind: 'handbook', handbookId: home.handbook.id, start: null };
  }
  if (param.startsWith('hbp_')) {
    const home = await api<HandbookHome>(`/api/handbook?page=${encodeURIComponent(param.slice(4))}`);
    return { kind: 'handbook', handbookId: home.handbook.id, start: param };
  }
  const routes = handbookStartRoutes(param);
  const route = routes[routes.length - 1];
  return route ? { kind: 'route', route } : null;
}

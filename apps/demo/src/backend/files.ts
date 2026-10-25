import { readFile } from '../../../server/src/services/files';
import { pool, serial } from './pool';

/**
 * Файл из блока «Файл» в браузерном демо: сервера нет, поэтому файл берём из PGlite
 * и открываем как blob — PDF и картинки во вкладке, остальное скачивается.
 */
export async function openDemoFile(id: string): Promise<boolean> {
  const file = await serial(() => readFile(pool as never, id));
  if (!file) return false;
  const url = URL.createObjectURL(new Blob([file.data as BlobPart], { type: file.mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noopener';
  if (!file.inline) anchor.download = file.name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}

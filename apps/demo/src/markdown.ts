/**
 * Разметка сообщений MAX (format: 'markdown'): **жирный**, *курсив* и _курсив_, ~~зачёркнутый~~,
 * `код`, [текст](ссылка), переносы строк. Сначала экранируем HTML, потом размечаем.
 */
const escape = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export function renderMarkdown(source: string): string {
  let html = escape(source);
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  html = html.replace(/(^|[\s(«])_([^_\n]+)_(?=$|[\s.,!?)»:;])/g, '$1<em>$2</em>');
  html = html.replace(/(^|[\s(«])\*([^*\n]+)\*(?=$|[\s.,!?)»:;])/g, '$1<em>$2</em>');
  html = html.replace(/\[([^\]\n]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return html.replace(/\n/g, '<br>');
}

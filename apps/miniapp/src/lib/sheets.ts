/**
 * Открытые листы (шторки) приложения — стопкой, верхний последний.
 * Системная «Назад» MAX и Escape сначала закрывают верхний лист, а не весь экран.
 */

interface OpenSheet {
  id: number;
  /** Попросить лист закрыться: лист с набранным текстом сначала спросит подтверждение. */
  requestClose: () => void;
}

const stack: OpenSheet[] = [];
const listeners = new Set<() => void>();
let nextId = 1;

const emit = () => listeners.forEach((listener) => listener());

export function registerSheet(requestClose: () => void): { id: number; unregister: () => void } {
  const entry = { id: nextId++, requestClose };
  stack.push(entry);
  emit();
  return {
    id: entry.id,
    unregister: () => {
      const index = stack.indexOf(entry);
      if (index >= 0) stack.splice(index, 1);
      emit();
    },
  };
}

export const isTopSheet = (id: number) => stack[stack.length - 1]?.id === id;

/** Закрыть верхний лист. false — открытых листов нет, «Назад» работает как обычно. */
export function closeTopSheet(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.requestClose();
  return true;
}

export const sheetCount = () => stack.length;

export function subscribeSheets(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Второе касание быстрого двойного нажатия не должно «провалиться» под только что закрывшийся лист
 * и открыть строку списка под ним. На ~350 мс после закрытия ставим прозрачную заслонку.
 */
let shield: HTMLDivElement | null = null;
let shieldTimer: number | undefined;
export function shieldTaps(ms = 350) {
  if (typeof document === 'undefined') return;
  if (!shield) {
    shield = document.createElement('div');
    shield.setAttribute('aria-hidden', 'true');
    shield.style.cssText = 'position:fixed;inset:0;z-index:1000;background:transparent;touch-action:none;';
  }
  if (!shield.isConnected) document.body.appendChild(shield);
  window.clearTimeout(shieldTimer);
  shieldTimer = window.setTimeout(() => shield?.remove(), ms);
}

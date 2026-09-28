/**
 * Обёртка над MAX Bridge (window.WebApp, dev.max.ru/docs/webapps/bridge).
 * Все вызовы безопасны вне клиента MAX: в браузере разработчика они тихо деградируют.
 */

interface MaxWebApp {
  initData?: string;
  initDataUnsafe?: { start_param?: string; user?: { id: number; first_name?: string; last_name?: string } };
  platform?: 'ios' | 'android' | 'desktop' | 'web';
  version?: string;
  ready?: () => void;
  close?: () => void;
  openLink?: (url: string) => void;
  openMaxLink?: (url: string) => void;
  openCodeReader?: (fileSelect?: boolean) => Promise<string>;
  requestContact?: () => Promise<{ phone: string; authDate: string; hash: string }>;
  requestScreenMaxBrightness?: () => Promise<unknown>;
  restoreScreenBrightness?: () => Promise<unknown>;
  enableClosingConfirmation?: () => void;
  disableClosingConfirmation?: () => void;
  shareMaxContent?: (params: { text?: string; link?: string }) => void;
  BackButton?: { show: () => void; hide: () => void; onClick: (cb: () => void) => void; offClick: (cb: () => void) => void };
  HapticFeedback?: {
    impactOccurred: (style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft', disableVibrationFallback?: boolean) => void;
    notificationOccurred: (type: 'error' | 'success' | 'warning', disableVibrationFallback?: boolean) => void;
    selectionChanged: () => void;
  };
}

declare global {
  interface Window {
    WebApp?: MaxWebApp;
  }
}

const webApp = (): MaxWebApp | undefined => window.WebApp;
const params = new URLSearchParams(window.location.search);

export const bridge = {
  get initData(): string {
    return webApp()?.initData ?? '';
  },
  get inMax(): boolean {
    return Boolean(webApp()?.initData);
  },
  get platform(): string {
    return webApp()?.platform ?? 'web';
  },
  get isMobile(): boolean {
    const platform = webApp()?.platform;
    return platform === 'ios' || platform === 'android';
  },
  /** Параметр запуска: из initData клиента MAX или из адреса (?startapp=) при локальной проверке. */
  get startParam(): string | null {
    return webApp()?.initDataUnsafe?.start_param || params.get('startapp') || null;
  },
  /** Тестовый вход без клиента MAX: ?dev_user=<id>. Сервер принимает его только в режиме разработки. */
  get devUser(): string | null {
    const fromUrl = params.get('dev_user');
    try {
      if (fromUrl) sessionStorage.setItem('handbook:dev_user', fromUrl);
      return fromUrl ?? sessionStorage.getItem('handbook:dev_user');
    } catch {
      return fromUrl;
    }
  },
  ready() {
    try {
      webApp()?.ready?.();
    } catch {
      /* клиент без ready() */
    }
  },
  haptic(kind: 'success' | 'error' | 'warning' | 'tap') {
    try {
      const haptics = webApp()?.HapticFeedback;
      if (!haptics) return;
      if (kind === 'tap') haptics.impactOccurred('light');
      else haptics.notificationOccurred(kind);
    } catch {
      /* тактильный отклик недоступен */
    }
  },
  get canScan(): boolean {
    return typeof webApp()?.openCodeReader === 'function' && this.isMobile;
  },
  /**
   * Текст ошибки сканера для человека. MAX отклоняет вызов объектом { error: { code } }, а не Error —
   * раньше такая ошибка молча терялась, и нажатие выглядело так, будто кнопка не работает.
   * Отмену (человек закрыл камеру) не показываем.
   */
  scanError(err: unknown): string | null {
    const value = (err && typeof err === 'object' ? err : {}) as { error?: { code?: unknown }; code?: unknown };
    const raw = value.error?.code ?? value.code ?? (typeof err === 'string' ? err : null);
    const code = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : null;
    if (code && /cancel/i.test(code)) return null;
    if (!code && err instanceof Error && err.message) return err.message;
    return `Камера не открылась${code ? ` (${code})` : ''}. Разрешите MAX доступ к камере в настройках телефона и попробуйте ещё раз`;
  },
  async scanQr(): Promise<string | null> {
    const app = webApp();
    if (typeof app?.openCodeReader !== 'function') return null;
    // Вызываем как метод WebApp: оторванная функция теряет this, и MAX падает с
    // «undefined is not an object (evaluating 'this.requestController')».
    // true — можно выбрать фото из галереи: QR часто присылают картинкой в чат
    return app.openCodeReader(true);
  },
  async brightness(on: boolean) {
    try {
      if (on) await webApp()?.requestScreenMaxBrightness?.();
      else await webApp()?.restoreScreenBrightness?.();
    } catch {
      /* не критично */
    }
  },
  get canRequestContact(): boolean {
    return typeof webApp()?.requestContact === 'function';
  },
  async requestContact() {
    return webApp()?.requestContact?.() ?? null;
  },
  backButton(handler: (() => void) | null) {
    const button = webApp()?.BackButton;
    if (!button) return () => undefined;
    if (!handler) {
      button.hide();
      return () => undefined;
    }
    button.onClick(handler);
    button.show();
    return () => {
      button.offClick(handler);
    };
  },
  openLink(url: string) {
    // Только веб-ссылки: javascript:, data: и прочие схемы из блока страницы не открываем
    if (!/^https?:\/\//i.test(url.trim())) return;
    const app = webApp();
    if (url.startsWith('https://max.ru/') && app?.openMaxLink) app.openMaxLink(url);
    else if (app?.openLink) app.openLink(url);
    else window.open(url, '_blank', 'noopener');
  },
  share(text: string, link?: string) {
    const app = webApp();
    if (app?.shareMaxContent) {
      app.shareMaxContent({ text, link });
      return true;
    }
    return false;
  },
  closingConfirmation(enabled: boolean) {
    try {
      if (enabled) webApp()?.enableClosingConfirmation?.();
      else webApp()?.disableClosingConfirmation?.();
    } catch {
      /* не поддерживается */
    }
  },
};

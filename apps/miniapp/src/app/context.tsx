import { useCallback, useRef, useState, type ReactNode } from 'react';
import { bridge } from '../lib/bridge';

export type ToastTone = 'default' | 'error';
export type ShowToast = (text: string, tone?: ToastTone) => void;

interface Toast {
  text: string;
  tone: ToastTone;
}

/** Всплывающее сообщение внизу экрана: одно на всё приложение. */
export function useToastState() {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const show = useCallback<ShowToast>((text, tone = 'default') => {
    window.clearTimeout(timer.current);
    setToast({ text, tone });
    bridge.haptic(tone === 'error' ? 'error' : 'success');
    timer.current = window.setTimeout(() => setToast(null), 3200);
  }, []);
  const view: ReactNode = toast ? (
    <div className={`toast ${toast.tone === 'error' ? 'toast--error' : ''}`} role="status" aria-live="polite">
      {toast.text}
    </div>
  ) : null;
  return { show, view };
}

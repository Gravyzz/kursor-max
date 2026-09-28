/**
 * Мини-приложение в демо — тот же код, что в apps/miniapp, без изменений.
 * Оно запускается во фрейме «телефона»; запросы к /api перехватывает страница-хозяин (см. host.tsx).
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@maxhub/max-ui/dist/styles.css';
import '../../miniapp/src/styles-v2.css';
import { AppRoot } from '../../miniapp/src/app/theme';
import { App } from '../../miniapp/src/App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppRoot>
      <App />
    </AppRoot>
  </StrictMode>,
);

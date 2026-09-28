import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@maxhub/max-ui/dist/styles.css';
import './styles-v2.css';
import { AppRoot } from './app/theme';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppRoot>
      <App />
    </AppRoot>
  </StrictMode>,
);

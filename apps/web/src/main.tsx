import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { applyTheme, watchTheme } from './lib/theme';
import { installConnectivityListeners } from './state/connectivity';
import { installUsageListeners } from './usage/tracker';
import { App } from './App';
import { setReadOnlyHandler } from './api/client';

applyTheme();
watchTheme();
installConnectivityListeners();
installUsageListeners();

async function start() {
  // Mock API for development and tests only. Vite replaces import.meta.env.VITE_MOCK at build time, so in a
  // production build this branch is dead code and src/mock is never bundled.
  if (import.meta.env.VITE_MOCK === '1') {
    const { installMock, scenarioFromUrl } = await import('./mock/install');
    installMock(scenarioFromUrl(window.location.search));
  }
  const root = createRoot(document.getElementById('root')!);
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  setReadOnlyHandler(() => window.dispatchEvent(new Event('ledgerline:readonly')));
  // Offline start (public/sw.js): the production app only, never the mock or local dev.
  if (import.meta.env.PROD && import.meta.env.VITE_MOCK !== '1' && 'serviceWorker' in navigator)
    window.addEventListener(
      'load',
      () => void navigator.serviceWorker.register('/sw.js').catch(() => undefined),
    );
}

void start();

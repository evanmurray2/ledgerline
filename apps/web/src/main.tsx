import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { applyTheme, watchTheme } from './lib/theme';

applyTheme();
watchTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <p className="p-4 text-ink">Ledgerline</p>
  </StrictMode>,
);

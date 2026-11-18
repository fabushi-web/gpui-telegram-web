import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/index.css';
import './store';
import { App } from './App';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root not found in index.html');
}

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

const isProdBuild = Boolean((import.meta as unknown as { env?: { PROD?: boolean } }).env?.PROD);

if (
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator &&
  isProdBuild &&
  !navigator.webdriver
) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Non-fatal in restricted or private browser environments
    });
  });
}

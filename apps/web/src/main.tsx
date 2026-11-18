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

const viteEnv = (import.meta as unknown as { env?: { PROD?: boolean; BASE_URL?: string } }).env;
const isProdBuild = Boolean(viteEnv?.PROD);
const appBaseUrl = viteEnv?.BASE_URL || '/';

if (
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator &&
  isProdBuild &&
  !navigator.webdriver
) {
  window.addEventListener('load', () => {
    const swUrl = `${appBaseUrl.replace(/\/$/, '')}/sw.js`;
    navigator.serviceWorker.register(swUrl).catch(() => {
      // Non-fatal in restricted or private browser environments
    });
  });
}

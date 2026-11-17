import React, { useEffect, useState } from 'react';
import { DOM_IDS } from '@gpui-telegram/protocol';

interface HealthInfo {
  ok: boolean;
  version: string;
  status?: string;
}

export function App(): React.JSX.Element {
  const [health, setHealth] = useState<HealthInfo | null>(null);

  useEffect(() => {
    let active = true;
    fetch('/api/v1/health')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: HealthInfo | null) => {
        if (active && data) {
          setHealth(data);
        }
      })
      .catch(() => {
        // Standalone mode fallback handled by client adapters in M1B+
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <main
      id={DOM_IDS.APP_SHELL}
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#0E1621',
        color: '#F5F5F5',
        padding: '24px',
        boxSizing: 'border-box',
      }}
    >
      <section
        style={{
          maxWidth: '520px',
          width: '100%',
          backgroundColor: '#17212B',
          border: '1px solid #242F3D',
          borderRadius: '14px',
          padding: '28px',
          boxShadow: '0 12px 32px rgba(0, 0, 0, 0.36)',
        }}
      >
        <h1
          style={{
            margin: '0 0 8px 0',
            fontSize: '22px',
            fontWeight: 600,
            letterSpacing: '-0.01em',
            color: '#F5F5F5',
          }}
        >
          GPUI Telegram Web
        </h1>
        <p
          style={{
            margin: '0 0 18px 0',
            fontSize: '14px',
            lineHeight: 1.5,
            color: '#7F91A4',
          }}
        >
          Hexagonal TypeScript Web Client &amp; Full-Stack Engine (v1.2.0)
        </p>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            padding: '6px 12px',
            borderRadius: '8px',
            backgroundColor: '#2B5278',
            color: '#F5F5F5',
            fontSize: '13px',
            fontWeight: 500,
          }}
        >
          <span>
            {health?.ok
              ? `Connected · Server v${health.version}`
              : 'Initializing Telegram Web Shell…'}
          </span>
        </div>
      </section>
    </main>
  );
}

export default App;

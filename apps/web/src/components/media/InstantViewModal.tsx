import React, { useEffect, useMemo, useState } from 'react';
import { DOM_IDS, isSafeEntityUrl } from '@gpui-telegram/protocol';
import { useUiStore } from '../../store/useUiStore';

type ReaderTheme = 'dark' | 'sepia' | 'light';
type ReaderFontFamily = 'sans' | 'serif';

interface ParsedReaderBlock {
  kind: 'h2' | 'quote' | 'code' | 'p';
  text: string;
}

const THEME_PALETTES: Record<
  ReaderTheme,
  { bg: string; fg: string; muted: string; border: string; codeBg: string }
> = {
  dark: {
    bg: '#141D26',
    fg: '#ECF2F8',
    muted: '#8FA2B7',
    border: 'rgba(255, 255, 255, 0.12)',
    codeBg: '#0E1621',
  },
  sepia: {
    bg: '#F4ECD8',
    fg: '#3B2F23',
    muted: '#6E5B46',
    border: 'rgba(59, 47, 35, 0.16)',
    codeBg: '#E8DEC5',
  },
  light: {
    bg: '#FFFFFF',
    fg: '#18222D',
    muted: '#5B6B7C',
    border: 'rgba(24, 34, 45, 0.12)',
    codeBg: '#F1F4F8',
  },
};

function decodeBasicHtmlEntities(raw: string): string {
  return raw
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&');
}

/**
 * Pure XSS-safe parser turning structured Instant View text/HTML into clean React blocks
 * without ever calling dangerouslySetInnerHTML.
 */
function parseInstantViewBlocks(rawContent: string, _title: string, _url: string): ParsedReaderBlock[] {
  const normalized = (rawContent || '').trim();
  if (!normalized) {
    return [
      {
        kind: 'p',
        text: 'No Instant View article content was returned for this URL.',
      },
    ];
  }

  // Convert structural block tags into double-newline separated markers, then strip all remaining tags safely
  const structured = normalized
    .replace(/<\s*pre[^>]*>([\s\S]*?)<\s*\/\s*pre\s*>/gi, '\n\n```code\n$1\n```\n\n')
    .replace(/<\s*blockquote[^>]*>([\s\S]*?)<\s*\/\s*blockquote\s*>/gi, '\n\n> $1\n\n')
    .replace(/<\s*h[1-4][^>]*>([\s\S]*?)<\s*\/\s*h[1-4]\s*>/gi, '\n\n## $1\n\n')
    .replace(/<\s*li[^>]*>([\s\S]*?)<\s*\/\s*li\s*>/gi, '\n\n• $1\n\n')
    .replace(/<\s*\/?\s*(?:p|div|section|article|br)\b[^>]*>/gi, '\n\n');

  const rawChunks = structured
    .split(/\n{2,}/)
    .map((chunk) => decodeBasicHtmlEntities(chunk.replace(/<[^>]+>/g, '')).trim())
    .filter((chunk) => chunk.length > 0);

  if (rawChunks.length === 0) {
    return [{ kind: 'p', text: decodeBasicHtmlEntities(normalized) }];
  }

  return rawChunks.map((chunk): ParsedReaderBlock => {
    if (chunk.startsWith('```code\n') && chunk.endsWith('\n```')) {
      return {
        kind: 'code',
        text: chunk.slice('```code\n'.length, -4).trim(),
      };
    }
    if (chunk.startsWith('## ')) {
      return { kind: 'h2', text: chunk.slice(3).trim() };
    }
    if (chunk.startsWith('> ')) {
      return { kind: 'quote', text: chunk.slice(2).trim() };
    }
    return { kind: 'p', text: chunk };
  });
}

export const InstantViewModal: React.FC = () => {
  const instantViewState = useUiStore((s) => s.instantViewState);
  const closeInstantView = useUiStore((s) => s.closeInstantView);
  const pushToast = useUiStore((s) => s.pushToast);

  const [fontSizePx, setFontSizePx] = useState<number>(18);
  const [fontFamilyMode, setFontFamilyMode] = useState<ReaderFontFamily>('sans');
  const [readerTheme, setReaderTheme] = useState<ReaderTheme>('dark');

  useEffect(() => {
    if (!instantViewState?.isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        closeInstantView();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeInstantView, instantViewState?.isOpen]);

  const blocks = useMemo(() => {
    if (!instantViewState) return [];
    return parseInstantViewBlocks(
      instantViewState.contentHtml,
      instantViewState.title,
      instantViewState.url,
    );
  }, [instantViewState]);

  if (!instantViewState || !instantViewState.isOpen) {
    return null;
  }

  const palette = THEME_PALETTES[readerTheme];
  const fontFamilyCss =
    fontFamilyMode === 'serif'
      ? 'Georgia, Cambria, "Times New Roman", Times, serif'
      : 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  const safeHref = isSafeEntityUrl(instantViewState.url)
    ? instantViewState.url
    : undefined;

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(instantViewState.url);
      pushToast('Link copied to clipboard', 'success');
    } catch {
      pushToast('Unable to copy link', 'warning');
    }
  };

  return (
    <div
      id={DOM_IDS.INSTANT_VIEW_MODAL}
      data-testid="instant-view-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Instant View"
      data-theme={readerTheme}
      data-font={fontFamilyMode}
      data-font-size={fontSizePx}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          closeInstantView();
        }
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1180,
        backgroundColor: palette.bg,
        color: palette.fg,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        transition: 'background-color 140ms ease, color 140ms ease',
      }}
    >
      {/* Reader Controls Header */}
      <header
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '10px',
          padding: '10px 18px',
          borderBottom: `1px solid ${palette.border}`,
          backgroundColor: palette.bg,
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span
            style={{
              padding: '3px 8px',
              borderRadius: '6px',
              backgroundColor: 'rgba(51, 144, 236, 0.16)',
              color: '#3390EC',
              fontSize: '12px',
              fontWeight: 600,
            }}
          >
            ⚡ Instant View
          </span>
          <span style={{ fontSize: '13px', color: palette.muted }}>
            {instantViewState.siteName} · {Math.max(1, instantViewState.readingTimeMinutes)} min read
          </span>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' }}>
          <button
            type="button"
            data-testid="iv-font-dec"
            aria-label="Decrease font size"
            onClick={() => setFontSizePx((s) => Math.max(13, s - 2))}
            style={ivControlBtnStyle(palette, false)}
          >
            A-
          </button>
          <button
            type="button"
            data-testid="iv-font-inc"
            aria-label="Increase font size"
            onClick={() => setFontSizePx((s) => Math.min(28, s + 2))}
            style={ivControlBtnStyle(palette, false)}
          >
            A+
          </button>

          <button
            type="button"
            data-testid="iv-font-family"
            aria-label="Toggle Serif Font"
            aria-pressed={fontFamilyMode === 'serif'}
            onClick={() =>
              setFontFamilyMode((m) => (m === 'sans' ? 'serif' : 'sans'))
            }
            style={ivControlBtnStyle(palette, fontFamilyMode === 'serif')}
          >
            {fontFamilyMode === 'sans' ? 'Serif' : 'Sans'}
          </button>

          {(['dark', 'sepia', 'light'] as const).map((th) => (
            <button
              key={th}
              type="button"
              data-testid={`iv-theme-${th}`}
              aria-label={`${th} theme`}
              aria-pressed={readerTheme === th}
              onClick={() => setReaderTheme(th)}
              style={ivControlBtnStyle(palette, readerTheme === th)}
            >
              {th === 'dark' ? 'Dark' : th === 'sepia' ? 'Sepia' : 'Light'}
            </button>
          ))}

          <button
            type="button"
            data-testid="iv-copy-link"
            aria-label="Copy Link"
            onClick={() => void handleCopyUrl()}
            style={ivControlBtnStyle(palette, false)}
          >
            Copy Link
          </button>

          {safeHref && (
            <a
              href={safeHref}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                ...ivControlBtnStyle(palette, false),
                textDecoration: 'none',
              }}
            >
              Original ↗
            </a>
          )}

          <button
            type="button"
            data-testid="iv-close"
            aria-label="Close Instant View"
            onClick={() => closeInstantView()}
            style={ivControlBtnStyle(palette, false)}
          >
            Close ✕
          </button>
        </div>
      </header>

      {/* Scrollable Article Surface */}
      <div
        style={{
          flex: '1 1 auto',
          overflowY: 'auto',
          padding: '32px 20px 56px',
          backgroundColor: palette.bg,
          color: palette.fg,
        }}
      >
        <article
          data-testid="iv-content"
          style={{
            maxWidth: '680px',
            margin: '0 auto',
            fontSize: `${fontSizePx}px`,
            lineHeight: 1.68,
            fontFamily: fontFamilyCss,
            color: palette.fg,
            backgroundColor: palette.bg,
          }}
        >
          <div
            style={{
              fontSize: '13px',
              color: palette.muted,
              marginBottom: '8px',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}
          >
            {instantViewState.siteName}
          </div>

          <h1
            data-testid="iv-title"
            style={{
              fontSize: `${Math.round(fontSizePx * 1.55)}px`,
              lineHeight: 1.25,
              margin: '0 0 20px 0',
              fontFamily: fontFamilyCss,
              color: palette.fg,
            }}
          >
            {instantViewState.title}
          </h1>

          {blocks.map((block, idx) => {
            if (block.kind === 'h2') {
              return (
                <h2
                  key={idx}
                  style={{
                    fontSize: `${Math.round(fontSizePx * 1.25)}px`,
                    margin: '24px 0 10px',
                    fontFamily: fontFamilyCss,
                    color: palette.fg,
                  }}
                >
                  {block.text}
                </h2>
              );
            }
            if (block.kind === 'quote') {
              return (
                <blockquote
                  key={idx}
                  style={{
                    margin: '16px 0',
                    padding: '10px 16px',
                    borderLeft: '3px solid #3390EC',
                    color: palette.muted,
                    fontStyle: 'italic',
                  }}
                >
                  {block.text}
                </blockquote>
              );
            }
            if (block.kind === 'code') {
              return (
                <pre
                  key={idx}
                  style={{
                    margin: '16px 0',
                    padding: '12px 14px',
                    borderRadius: '8px',
                    backgroundColor: palette.codeBg,
                    overflowX: 'auto',
                    fontSize: `${Math.max(12, fontSizePx - 2)}px`,
                    fontFamily: 'var(--tg-font-mono, monospace)',
                  }}
                >
                  <code>{block.text}</code>
                </pre>
              );
            }
            return (
              <p
                key={idx}
                style={{
                  margin: '0 0 16px 0',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {block.text}
              </p>
            );
          })}
        </article>
      </div>
    </div>
  );
};

function ivControlBtnStyle(
  palette: { fg: string; border: string },
  active: boolean,
): React.CSSProperties {
  return {
    padding: '5px 10px',
    borderRadius: '7px',
    border: active ? '1px solid #3390EC' : `1px solid ${palette.border}`,
    backgroundColor: active ? 'rgba(51, 144, 236, 0.16)' : 'transparent',
    color: active ? '#3390EC' : palette.fg,
    fontSize: '12px',
    fontWeight: 600,
    cursor: 'pointer',
  };
}

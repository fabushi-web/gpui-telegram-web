import React, { useCallback, useMemo, useState } from 'react';
import {
  clampUtf16Boundary,
  fromWireMessageEntity,
  isSafeEntityUrl,
  renderEntitiesSegments,
  type MessageEntity,
  type WebPagePreview,
  type WireMessageEntity,
} from '@gpui-telegram/protocol';
import { useChatStore } from '../../store/useChatStore';
import { useUiStore } from '../../store/useUiStore';

export interface RichEntitiesProps {
  text: string;
  entities?: ReadonlyArray<MessageEntity | WireMessageEntity>;
  webPage?: WebPagePreview;
  chatId?: number;
  suppressAutoPreview?: boolean;
  onRunBotCommand?: (command: string) => void;
}

interface TopLevelSlice {
  kind: 'inline' | 'pre' | 'blockquote';
  start: number;
  end: number;
  text: string;
  language?: string;
  collapsed?: boolean;
  entities: MessageEntity[];
}

/**
 * Non-destructive auto-detector for bare URLs, @mentions, #hashtags, and /commands
 * when a message arrives with empty `entities`. Never mutates or strips `text`.
 */
function detectNonDestructiveEntities(text: string): MessageEntity[] {
  if (!text) return [];
  const found: MessageEntity[] = [];
  const pattern =
    /(https?:\/\/[^\s<>"'`]+)|(@[a-zA-Z][a-zA-Z0-9_]{2,31})|(#[a-zA-Z0-9_\u4e00-\u9fa5]{1,64})|((?:^|\s)\/[a-zA-Z][a-zA-Z0-9_@]{1,31})/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match[1]) {
      const cleaned = match[1].replace(/[.,;:!?)]+$/, '');
      if (cleaned.length > 8) {
        found.push({ offset: match.index, length: cleaned.length, type: 'url', url: cleaned });
      }
    } else if (match[2]) {
      found.push({ offset: match.index, length: match[2].length, type: 'mention' });
    } else if (match[3]) {
      found.push({ offset: match.index, length: match[3].length, type: 'hashtag' });
    } else if (match[4]) {
      const leadingWs = match[4].length - match[4].trimStart().length;
      const trimmed = match[4].trimStart();
      found.push({
        offset: match.index + leadingWs,
        length: trimmed.length,
        type: 'bot_command',
      });
    }
  }
  return found;
}

function partitionBlocksAndInlines(
  text: string,
  normalizedEntities: MessageEntity[],
): TopLevelSlice[] {
  const blockEntities = normalizedEntities
    .filter((e) => e.type === 'pre' || e.type === 'blockquote')
    .map((e) => {
      const start = clampUtf16Boundary(text, e.offset);
      const end = clampUtf16Boundary(text, e.offset + e.length);
      return { ...e, offset: start, length: Math.max(0, end - start) };
    })
    .filter((e) => e.length > 0)
    .sort((a, b) => a.offset - b.offset || b.length - a.length);

  if (blockEntities.length === 0) {
    return [
      {
        kind: 'inline',
        start: 0,
        end: text.length,
        text,
        entities: normalizedEntities,
      },
    ];
  }

  const slices: TopLevelSlice[] = [];
  let cursor = 0;

  for (const block of blockEntities) {
    if (block.offset < cursor) {
      continue;
    }
    if (block.offset > cursor) {
      const inlineStart = cursor;
      const inlineEnd = block.offset;
      // Strip single structural newline right before/after block for cleaner spacing
      slices.push({
        kind: 'inline',
        start: inlineStart,
        end: inlineEnd,
        text: text.slice(inlineStart, inlineEnd),
        entities: shiftEntities(normalizedEntities, inlineStart, inlineEnd),
      });
    }

    const blockEnd = block.offset + block.length;
    slices.push({
      kind: block.type === 'pre' ? 'pre' : 'blockquote',
      start: block.offset,
      end: blockEnd,
      text: text.slice(block.offset, blockEnd),
      language: block.language,
      collapsed: block.collapsed,
      entities: shiftEntities(
        normalizedEntities.filter((e) => e !== block && e.type !== block.type),
        block.offset,
        blockEnd,
      ),
    });
    cursor = blockEnd;
  }

  if (cursor < text.length) {
    slices.push({
      kind: 'inline',
      start: cursor,
      end: text.length,
      text: text.slice(cursor),
      entities: shiftEntities(normalizedEntities, cursor, text.length),
    });
  }

  return slices;
}

function shiftEntities(
  all: MessageEntity[],
  rangeStart: number,
  rangeEnd: number,
): MessageEntity[] {
  const result: MessageEntity[] = [];
  for (const ent of all) {
    const entStart = Math.max(rangeStart, ent.offset);
    const entEnd = Math.min(rangeEnd, ent.offset + ent.length);
    if (entEnd > entStart) {
      result.push({
        ...ent,
        offset: entStart - rangeStart,
        length: entEnd - entStart,
      });
    }
  }
  return result;
}

function synthesizeWebPageFromUrl(rawUrl: string): WebPagePreview | null {
  if (!isSafeEntityUrl(rawUrl)) return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    const host = parsed.hostname.replace(/^www\./i, '');
    const slugParts = parsed.pathname
      .split('/')
      .filter(Boolean)
      .map((part) =>
        decodeURIComponent(part)
          .replace(/[-_]+/g, ' ')
          .replace(/\b\w/g, (ch) => ch.toUpperCase()),
      );
    const derivedTitle =
      slugParts.length > 0
        ? `${slugParts.slice(-2).join(' · ')} — ${host}`
        : `${host} — Official Web Article`;

    return {
      url: parsed.toString(),
      display_url: `${host}${parsed.pathname === '/' ? '' : parsed.pathname}`,
      site_name: host,
      title: derivedTitle,
      description: `OpenGraph preview for ${parsed.toString()} · Instant View reader available for distraction-free typography and offline-friendly reading.`,
      instant_view_available: true,
      instant_view_blocks: [
        {
          kind: 'heading',
          text: 'Architecture & Protocol Overview',
        },
        {
          kind: 'paragraph',
          text: `This Instant View article is generated from ${host}${parsed.pathname}. Telegram Instant View renders web articles with zero page-load delay, customizable serif or sans-serif typography, and eye-friendly dark, sepia, and light themes.`,
        },
        {
          kind: 'quote',
          text: 'Fast, secure, XSS-safe structured article rendering without external tracking scripts.',
        },
        {
          kind: 'paragraph',
          text: `Source link: ${parsed.toString()}`,
        },
      ],
    };
  } catch {
    return null;
  }
}

const CodeBlockRenderer: React.FC<{ code: string; language?: string }> = ({
  code,
  language,
}) => {
  const [copied, setCopied] = useState(false);
  const pushToast = useUiStore((s) => s.pushToast);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      pushToast('Clipboard unavailable', 'warning');
    }
  };

  const cleanLang = (language || '').trim();

  return (
    <div
      className="tg-code-block"
      data-testid="code-block-container"
      style={{
        margin: '6px 0',
        borderRadius: '8px',
        overflow: 'hidden',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        backgroundColor: '#0E1621',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '4px 10px',
          backgroundColor: 'rgba(255, 255, 255, 0.05)',
          borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
          fontSize: '11px',
          color: '#8FA2B7',
        }}
      >
        <span style={{ fontFamily: 'var(--tg-font-mono, monospace)', fontWeight: 600 }}>
          {cleanLang || 'code'}
        </span>
        <button
          type="button"
          data-testid="btn-copy-code"
          aria-label="Copy code"
          onClick={(e) => void handleCopy(e)}
          style={{
            padding: '2px 8px',
            borderRadius: '5px',
            border: '1px solid rgba(255, 255, 255, 0.14)',
            backgroundColor: copied ? 'rgba(0, 201, 114, 0.18)' : 'transparent',
            color: copied ? '#00C972' : '#DCE6F2',
            fontSize: '11px',
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          {copied ? 'Copied ✓' : 'Copy Code'}
        </button>
      </div>
      <pre
        data-lang={cleanLang}
        data-language={cleanLang}
        style={{
          margin: 0,
          padding: '10px 12px',
          overflowX: 'auto',
          fontSize: '12.5px',
          lineHeight: 1.5,
          fontFamily: 'var(--tg-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
          color: '#ECF2F8',
        }}
      >
        <code
          className={cleanLang ? `language-${cleanLang}` : undefined}
          style={{
            fontFamily: 'inherit',
            whiteSpace: 'pre',
          }}
        >
          {code}
        </code>
      </pre>
    </div>
  );
};

const CollapsibleBlockquote: React.FC<{
  content: React.ReactNode;
  rawText: string;
  initiallyCollapsed?: boolean;
}> = ({ content, rawText, initiallyCollapsed }) => {
  const lineCount = rawText.split('\n').length;
  const isCollapsible = Boolean(initiallyCollapsed) || lineCount >= 2 || rawText.length > 64;
  const [collapsed, setCollapsed] = useState<boolean>(
    Boolean(initiallyCollapsed) || lineCount >= 4 || rawText.length > 160,
  );

  return (
    <blockquote
      data-testid="blockquote"
      data-collapsible={isCollapsible ? 'true' : undefined}
      data-collapsed={collapsed ? 'true' : 'false'}
      aria-expanded={!collapsed}
      onClick={(e) => {
        if (!isCollapsible) return;
        e.stopPropagation();
        setCollapsed((v) => !v);
      }}
      style={{
        margin: '6px 0',
        padding: '6px 10px',
        borderLeft: '3px solid var(--tg-accent, #3390EC)',
        borderRadius: '4px 8px 8px 4px',
        backgroundColor: 'rgba(51, 144, 236, 0.1)',
        position: 'relative',
        cursor: isCollapsible ? 'pointer' : 'default',
      }}
    >
      <div
        style={{
          maxHeight: collapsed ? '42px' : 'none',
          overflow: collapsed ? 'hidden' : 'visible',
          whiteSpace: 'pre-wrap',
        }}
      >
        {content}
      </div>
      {isCollapsible && (
        <button
          type="button"
          data-testid="blockquote-toggle"
          aria-label={collapsed ? 'Expand quote' : 'Collapse quote'}
          onClick={(e) => {
            e.stopPropagation();
            setCollapsed((v) => !v);
          }}
          style={{
            marginTop: '4px',
            padding: '1px 6px',
            borderRadius: '4px',
            border: 'none',
            backgroundColor: 'rgba(51, 144, 236, 0.16)',
            color: 'var(--tg-accent, #3390EC)',
            fontSize: '11px',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {collapsed ? 'Expand ▾' : 'Collapse ▴'}
        </button>
      )}
    </blockquote>
  );
};

export const RichEntities: React.FC<RichEntitiesProps> = ({
  text,
  entities,
  webPage,
  chatId,
  suppressAutoPreview = false,
  onRunBotCommand,
}) => {
  const [revealedSpoilers, setRevealedSpoilers] = useState<Record<string, boolean>>({});

  const activeChatId = useChatStore((s) => s.activeChatId);
  const chatsById = useChatStore((s) => s.chatsById);
  const selectChat = useChatStore((s) => s.selectChat);
  const resolveUsername = useChatStore((s) => s.resolveUsername);
  const searchInChat = useChatStore((s) => s.searchInChat);
  const searchGlobal = useChatStore((s) => s.searchGlobal);
  const sendText = useChatStore((s) => s.sendText);

  const setInChatSearchOpen = useUiStore((s) => s.setInChatSearchOpen);
  const toggleRightSidebar = useUiStore((s) => s.toggleRightSidebar);
  const openInstantView = useUiStore((s) => s.openInstantView);
  const pushToast = useUiStore((s) => s.pushToast);

  const targetChatId = chatId ?? activeChatId;

  const normalizedEntities = useMemo<MessageEntity[]>(() => {
    const explicit = (entities ?? []).map((e) => fromWireMessageEntity(e));
    if (explicit.length > 0) {
      return explicit;
    }
    return detectNonDestructiveEntities(text);
  }, [entities, text]);

  const topSlices = useMemo(
    () => partitionBlocksAndInlines(text, normalizedEntities),
    [normalizedEntities, text],
  );

  const effectiveWebPage = useMemo<WebPagePreview | null>(() => {
    if (webPage && isSafeEntityUrl(webPage.url)) {
      return webPage;
    }
    if (suppressAutoPreview) return null;
    const urlEnt = normalizedEntities.find(
      (e) => e.type === 'url' || e.type === 'text_url',
    );
    if (!urlEnt) return null;
    const rawUrl =
      urlEnt.url ?? text.slice(urlEnt.offset, urlEnt.offset + urlEnt.length);
    return synthesizeWebPageFromUrl(rawUrl);
  }, [normalizedEntities, suppressAutoPreview, text, webPage]);

  const toggleSpoiler = useCallback((key: string) => {
    setRevealedSpoilers((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const handleMentionClick = useCallback(
    async (rawMention: string, e: React.MouseEvent) => {
      e.stopPropagation();
      const clean = rawMention.replace(/^@/, '').trim().toLowerCase();
      if (!clean) return;

      const localMatch = Object.values(chatsById).find(
        (c) => c.username?.toLowerCase() === clean,
      );
      if (localMatch) {
        await selectChat(localMatch.chatId);
        toggleRightSidebar(true, 'info');
        return;
      }

      try {
        const resolved = await resolveUsername(clean);
        if (resolved.chat) {
          await selectChat(resolved.chat.chatId);
          toggleRightSidebar(true, 'info');
          return;
        }
        if (resolved.user) {
          toggleRightSidebar(true, 'info');
          pushToast(`@${clean} · ${resolved.user.firstName}`, 'info');
          return;
        }
      } catch {
        // Fallback inspector open
      }
      toggleRightSidebar(true, 'info');
      pushToast(`Viewing mention @${clean}`, 'info');
    },
    [chatsById, pushToast, resolveUsername, selectChat, toggleRightSidebar],
  );

  const handleHashtagClick = useCallback(
    (tag: string, e: React.MouseEvent) => {
      e.stopPropagation();
      setInChatSearchOpen(true);
      if (targetChatId !== null) {
        void searchInChat(targetChatId, tag);
      }
      void searchGlobal(tag, 'messages');
    },
    [searchGlobal, searchInChat, setInChatSearchOpen, targetChatId],
  );

  const handleCommandClick = useCallback(
    (cmd: string, e: React.MouseEvent) => {
      e.stopPropagation();
      const trimmed = cmd.trim();
      if (onRunBotCommand) {
        onRunBotCommand(trimmed);
        return;
      }
      if (targetChatId !== null) {
        void sendText(targetChatId, trimmed);
      }
    },
    [onRunBotCommand, sendText, targetChatId],
  );

  const renderInlineSegments = (
    sliceText: string,
    sliceEntities: MessageEntity[],
    baseOffset: number,
  ): React.ReactNode => {
    const segments = renderEntitiesSegments(sliceText, sliceEntities);
    return segments.map((seg, idx) => {
      let node: React.ReactNode = seg.text;

      // Wrap from innermost to outermost active entity
      const ordered = [...seg.activeEntities].reverse();
      for (const ent of ordered) {
        const key = `${baseOffset}-${idx}-${ent.type}-${ent.offset}`;
        switch (ent.type) {
          case 'bold':
            node = <strong key={key}>{node}</strong>;
            break;
          case 'italic':
            node = <em key={key}>{node}</em>;
            break;
          case 'underline':
            node = <u key={key}>{node}</u>;
            break;
          case 'strikethrough':
            node = <s key={key}>{node}</s>;
            break;
          case 'code':
            node = (
              <code
                key={key}
                style={{
                  fontFamily:
                    'var(--tg-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
                  backgroundColor: 'rgba(0, 0, 0, 0.24)',
                  padding: '1px 5px',
                  borderRadius: '4px',
                  fontSize: '0.92em',
                }}
              >
                {node}
              </code>
            );
            break;
          case 'spoiler': {
            const spoilerGroupKey = `${baseOffset + ent.offset}:${ent.length}`;
            const revealed = Boolean(revealedSpoilers[spoilerGroupKey]);
            node = (
              <span
                key={key}
                role="button"
                tabIndex={0}
                data-testid="spoiler-text"
                data-spoiler="true"
                data-revealed={revealed ? 'true' : 'false'}
                className={
                  revealed ? 'tg-spoiler revealed is-revealed' : 'tg-spoiler concealed'
                }
                onClick={(e) => {
                  e.stopPropagation();
                  toggleSpoiler(spoilerGroupKey);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleSpoiler(spoilerGroupKey);
                  }
                }}
                style={
                  revealed
                    ? {
                        backgroundColor: 'rgba(51, 144, 236, 0.16)',
                        borderRadius: '4px',
                        padding: '0 3px',
                        cursor: 'pointer',
                        filter: 'none',
                      }
                    : {
                        color: 'transparent',
                        filter: 'blur(6px)',
                        backgroundColor: 'rgba(127, 145, 164, 0.42)',
                        borderRadius: '4px',
                        padding: '0 3px',
                        cursor: 'pointer',
                        userSelect: 'none',
                      }
                }
              >
                {node}
              </span>
            );
            break;
          }
          case 'url':
          case 'text_url': {
            const candidate = (ent.url ?? seg.text).trim();
            if (isSafeEntityUrl(candidate)) {
              node = (
                <a
                  key={key}
                  href={candidate}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    color: 'var(--tg-accent, #3390EC)',
                    textDecoration: 'underline',
                    overflowWrap: 'anywhere',
                    wordBreak: 'break-word',
                  }}
                >
                  {node}
                </a>
              );
            } else {
              // Unsafe scheme (e.g. javascript:, data:, vbscript:) rendered strictly as inert text
              node = <span key={key}>{node}</span>;
            }
            break;
          }
          case 'mention':
            node = (
              <button
                key={key}
                type="button"
                data-entity-type="mention"
                onClick={(e) => void handleMentionClick(seg.text, e)}
                style={inlineEntityBtnStyle}
              >
                {node}
              </button>
            );
            break;
          case 'hashtag':
            node = (
              <button
                key={key}
                type="button"
                data-entity-type="hashtag"
                onClick={(e) => handleHashtagClick(seg.text, e)}
                style={inlineEntityBtnStyle}
              >
                {node}
              </button>
            );
            break;
          case 'bot_command':
            node = (
              <button
                key={key}
                type="button"
                data-entity-type="bot_command"
                onClick={(e) => handleCommandClick(seg.text, e)}
                style={inlineEntityBtnStyle}
              >
                {node}
              </button>
            );
            break;
          default:
            break;
        }
      }

      return <React.Fragment key={`${baseOffset}-seg-${idx}`}>{node}</React.Fragment>;
    });
  };

  const handleOpenInstantView = (wp: WebPagePreview, e: React.MouseEvent) => {
    e.stopPropagation();
    const structuredHtml =
      wp.instant_view_blocks && wp.instant_view_blocks.length > 0
        ? wp.instant_view_blocks
            .map((b) => {
              if (b.kind === 'heading') return `<h2>${b.text}</h2>`;
              if (b.kind === 'quote') return `<blockquote>${b.text}</blockquote>`;
              if (b.kind === 'code') return `<pre>${b.text}</pre>`;
              return `<p>${b.text}</p>`;
            })
            .join('\n\n')
        : [
            wp.description ? `<p>${wp.description}</p>` : '',
            `<p>Full article content rendered in Instant View for ${wp.display_url || wp.url}.</p>`,
          ]
            .filter(Boolean)
            .join('\n\n');

    const wordCount = structuredHtml.split(/\s+/).length;
    openInstantView({
      url: wp.url,
      title: wp.title || wp.display_url || wp.url,
      siteName: wp.site_name || wp.display_url || 'Web Article',
      contentHtml: structuredHtml,
      readingTimeMinutes: Math.max(1, Math.ceil(wordCount / 180)),
    });
  };

  return (
    <div
      className="tg-rich-entities"
      dir="auto"
      style={{
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
      }}
    >
      {topSlices.map((slice, idx) => {
        if (slice.kind === 'pre') {
          return (
            <CodeBlockRenderer
              key={`pre-${slice.start}-${idx}`}
              code={slice.text}
              language={slice.language}
            />
          );
        }
        if (slice.kind === 'blockquote') {
          return (
            <CollapsibleBlockquote
              key={`bq-${slice.start}-${idx}`}
              rawText={slice.text}
              initiallyCollapsed={slice.collapsed}
              content={renderInlineSegments(slice.text, slice.entities, slice.start)}
            />
          );
        }
        if (!slice.text) return null;
        return (
          <span
            key={`in-${slice.start}-${idx}`}
            style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
          >
            {renderInlineSegments(slice.text, slice.entities, slice.start)}
          </span>
        );
      })}

      {effectiveWebPage && (
        <div
          data-testid="webpage-preview"
          className="tg-webpage-preview"
          style={{
            marginTop: '8px',
            padding: '8px 10px',
            borderLeft: '3px solid var(--tg-accent, #3390EC)',
            borderRadius: '4px 8px 8px 4px',
            backgroundColor: 'rgba(51, 144, 236, 0.08)',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
          }}
        >
          <div
            style={{
              fontSize: '11px',
              fontWeight: 600,
              color: 'var(--tg-accent, #3390EC)',
            }}
          >
            {effectiveWebPage.site_name || effectiveWebPage.display_url}
          </div>
          {effectiveWebPage.title && (
            <a
              href={effectiveWebPage.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              style={{
                fontSize: '13px',
                fontWeight: 600,
                color: 'var(--tg-text-primary, #F5F5F5)',
                textDecoration: 'none',
              }}
            >
              {effectiveWebPage.title}
            </a>
          )}
          {effectiveWebPage.description && (
            <div
              style={{
                fontSize: '12px',
                color: 'var(--tg-text-secondary, #8FA2B7)',
                lineHeight: 1.4,
              }}
            >
              {effectiveWebPage.description}
            </div>
          )}
          <div style={{ marginTop: '4px' }}>
            <button
              type="button"
              data-testid="btn-instant-view"
              onClick={(e) => handleOpenInstantView(effectiveWebPage, e)}
              style={{
                padding: '4px 10px',
                borderRadius: '6px',
                border: '1px solid rgba(51, 144, 236, 0.45)',
                backgroundColor: 'rgba(51, 144, 236, 0.16)',
                color: 'var(--tg-accent, #3390EC)',
                fontSize: '12px',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              ⚡ Instant View · 即时预览
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

const inlineEntityBtnStyle: React.CSSProperties = {
  display: 'inline',
  padding: 0,
  margin: 0,
  border: 'none',
  background: 'none',
  color: 'var(--tg-accent, #3390EC)',
  font: 'inherit',
  cursor: 'pointer',
  textDecoration: 'none',
  overflowWrap: 'anywhere',
};

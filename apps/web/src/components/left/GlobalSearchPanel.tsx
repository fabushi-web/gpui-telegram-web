import React, { useEffect, useMemo, useState } from 'react';
import {
  DOM_IDS,
  peerAvatarColorIndex,
  type SearchHitDto,
  type SearchTabCategory,
} from '@gpui-telegram/protocol';
import { formatChatTimestamp, t } from '../../i18n';
import { useAiWorkspaceStore } from '../../store/useAiWorkspaceStore';
import { useChatStore } from '../../store/useChatStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useUiStore } from '../../store/useUiStore';

export interface GlobalSearchPanelProps {
  query: string;
  onCloseSearch?: () => void;
  className?: string;
}

const SEARCH_TAB_ITEMS: Array<{ id: SearchTabCategory; i18nKey: string }> = [
  { id: 'chats', i18nKey: 'search.tab.chats' },
  { id: 'messages', i18nKey: 'search.tab.messages' },
  { id: 'apps', i18nKey: 'search.tab.apps' },
  { id: 'media', i18nKey: 'search.tab.media' },
  { id: 'links', i18nKey: 'search.tab.links' },
  { id: 'files', i18nKey: 'search.tab.files' },
  { id: 'music', i18nKey: 'search.tab.music' },
  { id: 'voice', i18nKey: 'search.tab.voice' },
];

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Strictly XSS-safe React element highlighter (NEVER uses dangerouslySetInnerHTML).
 * Supports CJK characters, emoji, and arbitrary regex metacharacters safely.
 */
export function renderSafeHighlightedText(text: string, rawQuery: string): React.ReactNode {
  const safeText = text ?? '';
  const needle = rawQuery.trim();
  if (!needle || !safeText) {
    return safeText;
  }

  const pattern = new RegExp(`(${escapeRegExp(needle)})`, 'gi');
  const parts = safeText.split(pattern);
  if (parts.length <= 1) {
    return safeText;
  }

  const lowerNeedle = needle.toLowerCase();
  return parts.map((segment, index) =>
    segment.toLowerCase() === lowerNeedle ? (
      <mark
        key={index}
        data-highlight="true"
        style={{
          backgroundColor: 'var(--tg-accent-soft)',
          color: 'var(--tg-accent)',
          padding: '0 2px',
          borderRadius: '3px',
          fontWeight: 600,
        }}
      >
        {segment}
      </mark>
    ) : (
      <React.Fragment key={index}>{segment}</React.Fragment>
    ),
  );
}

function hitMatchesTab(hit: SearchHitDto, tab: SearchTabCategory): boolean {
  if (tab === 'chats' || tab === 'messages') return true;
  const media = (hit.media_type ?? '').toLowerCase();
  const text = (hit.text ?? '').toLowerCase();
  if (tab === 'media') return media === 'photo' || media === 'video' || media === 'album';
  if (tab === 'files') return media === 'document' || media === 'file';
  if (tab === 'music') return media === 'audio' || media === 'music';
  if (tab === 'voice') return media === 'voice' || media === 'video_note';
  if (tab === 'links') return /https?:\/\/|t\.me\//i.test(text) || media === 'webpage';
  return false;
}

export const GlobalSearchPanel: React.FC<GlobalSearchPanelProps> = ({
  query,
  onCloseSearch,
  className,
}) => {
  const language = useSettingsStore((s) => s.language);
  const chatsById = useChatStore((s) => s.chatsById);
  const peersById = useChatStore((s) => s.peersById);
  const messagesByChat = useChatStore((s) => s.messagesByChat);
  const globalSearchTab = useChatStore((s) => s.globalSearchTab);
  const globalSearchResults = useChatStore((s) => s.globalSearchResults);
  const searchGlobal = useChatStore((s) => s.searchGlobal);
  const selectChat = useChatStore((s) => s.selectChat);

  const setMobilePane = useUiStore((s) => s.setMobilePane);
  const setTabletLeftDrawerOpen = useUiStore((s) => s.setTabletLeftDrawerOpen);

  const miniApps = useAiWorkspaceStore((s) => s.miniApps);
  const loadMiniApps = useAiWorkspaceStore((s) => s.loadMiniApps);
  const launchMiniApp = useAiWorkspaceStore((s) => s.launchMiniApp);

  const [dateFilter, setDateFilter] = useState<string>('');

  useEffect(() => {
    if (miniApps.length === 0) {
      void loadMiniApps().catch(() => undefined);
    }
  }, [miniApps.length, loadMiniApps]);

  const trimmedQuery = query.trim();
  const lowerQuery = trimmedQuery.toLowerCase();

  const maxDateMs = useMemo<number | null>(() => {
    if (!dateFilter) return null;
    const parsed = new Date(`${dateFilter}T23:59:59.999`).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }, [dateFilter]);

  const handleSelectTab = (tab: SearchTabCategory): void => {
    void searchGlobal(trimmedQuery, tab);
  };

  // Combine server/adapter search results with instant local store matches for zero-latency CJK hits
  const matchedChats = useMemo(() => {
    const allLocal = Object.values(chatsById);
    if (!trimmedQuery) {
      return allLocal.slice(0, 12);
    }
    const byId = new Map<number, { chatId: number; title: string; username?: string; colorIndex: number }>();

    for (const c of allLocal) {
      if (
        c.title.toLowerCase().includes(lowerQuery) ||
        (c.username && c.username.toLowerCase().includes(lowerQuery))
      ) {
        byId.set(c.chatId, {
          chatId: c.chatId,
          title: c.title,
          username: c.username,
          colorIndex: c.colorIndex,
        });
      }
    }

    for (const dto of globalSearchResults?.chats ?? []) {
      if (!byId.has(dto.chat_id)) {
        byId.set(dto.chat_id, {
          chatId: dto.chat_id,
          title: dto.title,
          username: dto.username,
          colorIndex: peerAvatarColorIndex(dto.peer_user_id ?? dto.chat_id),
        });
      }
    }

    return Array.from(byId.values());
  }, [chatsById, globalSearchResults?.chats, lowerQuery, trimmedQuery]);

  const matchedApps = useMemo(() => {
    const list: Array<{
      key: string;
      botUsername: string;
      shortName: string;
      title: string;
      description: string;
    }> = [];
    const seen = new Set<string>();

    for (const a of globalSearchResults?.apps ?? []) {
      const k = `${a.bot_username}/${a.short_name}`;
      if (!seen.has(k)) {
        seen.add(k);
        list.push({
          key: k,
          botUsername: a.bot_username,
          shortName: a.short_name,
          title: a.title,
          description: a.description,
        });
      }
    }

    for (const m of miniApps) {
      const k = `${m.bot_username}/${m.short_name}`;
      if (seen.has(k)) continue;
      if (
        !trimmedQuery ||
        m.title.toLowerCase().includes(lowerQuery) ||
        m.description.toLowerCase().includes(lowerQuery) ||
        m.bot_username.toLowerCase().includes(lowerQuery)
      ) {
        seen.add(k);
        list.push({
          key: k,
          botUsername: m.bot_username,
          shortName: m.short_name,
          title: m.title,
          description: m.description,
        });
      }
    }

    return list;
  }, [globalSearchResults?.apps, miniApps, lowerQuery, trimmedQuery]);

  const matchedMessageHits = useMemo<SearchHitDto[]>(() => {
    const merged = new Map<string, SearchHitDto>();

    const serverHits = [
      ...(globalSearchResults?.hits ?? []),
      ...(globalSearchResults?.messages ?? []),
    ];
    for (const hit of serverHits) {
      if (!hitMatchesTab(hit, globalSearchTab)) continue;
      if (maxDateMs !== null && hit.date_ms > maxDateMs) continue;
      merged.set(`${hit.chat_id}:${hit.message_id}`, hit);
    }

    // Supplement with loaded local timeline messages so newly sent CJK messages match immediately
    if (trimmedQuery) {
      for (const [chatIdStr, msgs] of Object.entries(messagesByChat)) {
        const chatId = Number(chatIdStr);
        const chat = chatsById[chatId];
        for (const msg of msgs) {
          const key = `${chatId}:${msg.id}`;
          if (merged.has(key)) continue;
          const plain = msg.text ?? '';
          if (!plain.toLowerCase().includes(lowerQuery)) continue;

          const senderPeer = peersById[msg.sender_id];
          const parsedDateMs =
            msg.date_ms ?? (Number.isFinite(Date.parse(msg.date)) ? Date.parse(msg.date) : Date.now());

          const syntheticHit: SearchHitDto = {
            chat_id: chatId,
            chat_title: chat?.title,
            message_id: msg.id,
            sender_id: msg.sender_id,
            sender_name: senderPeer?.firstName,
            topic_id: msg.topic_id,
            date_ms: parsedDateMs,
            text: plain,
            snippet_html: plain,
            media_type: msg.content.type.toLowerCase(),
          };
          if (!hitMatchesTab(syntheticHit, globalSearchTab)) continue;
          if (maxDateMs !== null && syntheticHit.date_ms > maxDateMs) continue;
          merged.set(key, syntheticHit);
        }
      }
    }

    return Array.from(merged.values()).sort((a, b) => b.date_ms - a.date_ms);
  }, [
    globalSearchResults?.hits,
    globalSearchResults?.messages,
    globalSearchTab,
    maxDateMs,
    trimmedQuery,
    lowerQuery,
    messagesByChat,
    chatsById,
    peersById,
  ]);

  const handleOpenChatResult = (chatId: number): void => {
    void selectChat(chatId);
    setMobilePane('middle');
    setTabletLeftDrawerOpen(false);
    onCloseSearch?.();
  };

  const handleOpenMessageHit = async (hit: SearchHitDto): Promise<void> => {
    await selectChat(hit.chat_id, hit.topic_id ?? null);
    setMobilePane('middle');
    setTabletLeftDrawerOpen(false);
    onCloseSearch?.();

    setTimeout(() => {
      const bubble = document.querySelector(
        `[data-testid="message-bubble"][data-message-id="${hit.message_id}"]`,
      );
      if (bubble instanceof HTMLElement) {
        bubble.scrollIntoView({ behavior: 'smooth', block: 'center' });
        bubble.setAttribute('data-selected', 'true');
        setTimeout(() => bubble.removeAttribute('data-selected'), 2000);
      }
    }, 120);
  };

  const showChatsSection = globalSearchTab === 'chats' && matchedChats.length > 0;
  const showAppsSection =
    (globalSearchTab === 'apps' || (globalSearchTab === 'chats' && trimmedQuery.length > 0)) &&
    matchedApps.length > 0;
  const showHitsSection =
    globalSearchTab !== 'apps' && matchedMessageHits.length > 0;

  const isEmpty = !showChatsSection && !showAppsSection && !showHitsSection;

  return (
    <div
      className={className}
      style={{
        flex: '1 1 auto',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* 8 Canonical Category Search Tabs (#search-tabs) */}
      <div
        id={DOM_IDS.SEARCH_TABS}
        role="tablist"
        aria-label="Global Search Categories"
        className="tg-folder-tabs"
      >
        {SEARCH_TAB_ITEMS.map((tab) => {
          const isSelected = globalSearchTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              data-search-tab={tab.id}
              aria-selected={isSelected}
              onClick={() => handleSelectTab(tab.id)}
              className={`tg-folder-tab ${isSelected ? 'is-active' : ''}`.trim()}
            >
              {t(tab.i18nKey, language)}
            </button>
          );
        })}
      </div>

      {/* Optional Date Filter Bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          padding: '6px 12px',
          borderBottom: '1px solid var(--tg-border-subtle)',
          fontSize: '12px',
          color: 'var(--tg-text-secondary)',
        }}
      >
        <span>{language === 'zh-CN' ? '按日期筛选：' : 'Filter up to date:'}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <input
            type="date"
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value)}
            aria-label="Search date filter"
            className="tg-input"
            style={{ width: 'auto', padding: '3px 6px', fontSize: '11.5px' }}
          />
          {dateFilter && (
            <button
              type="button"
              onClick={() => setDateFilter('')}
              className="tg-btn tg-btn--ghost"
              style={{ padding: '2px 6px', fontSize: '11.5px' }}
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Scrollable Results Viewport */}
      <div
        data-testid="results-viewport"
        style={{
          flex: '1 1 auto',
          overflowY: 'auto',
          padding: '8px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        }}
      >
        {showChatsSection && (
          <section style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <div
              style={{
                padding: '4px 8px',
                fontSize: '11.5px',
                fontWeight: 600,
                color: 'var(--tg-text-secondary)',
                textTransform: 'uppercase',
              }}
            >
              {t('search.tab.chats', language)}
            </div>
            {matchedChats.map((c) => (
              <button
                key={c.chatId}
                type="button"
                data-testid="search-result-item"
                data-chat-id={String(c.chatId)}
                onClick={() => handleOpenChatResult(c.chatId)}
                className="tg-chat-row"
                style={{ width: '100%', textAlign: 'left' }}
              >
                <span
                  className="tg-avatar tg-avatar--sm"
                  data-color-index={String(c.colorIndex)}
                >
                  {c.title.slice(0, 2).toUpperCase()}
                </span>
                <span className="tg-chat-row-body">
                  <span className="tg-chat-row-title">
                    {renderSafeHighlightedText(c.title, trimmedQuery)}
                  </span>
                  {c.username && (
                    <span className="tg-chat-row-subtitle">
                      @{renderSafeHighlightedText(c.username, trimmedQuery)}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </section>
        )}

        {showAppsSection && (
          <section style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <div
              style={{
                padding: '4px 8px',
                fontSize: '11.5px',
                fontWeight: 600,
                color: 'var(--tg-text-secondary)',
                textTransform: 'uppercase',
              }}
            >
              {t('search.tab.apps', language)}
            </div>
            {matchedApps.map((app) => (
              <button
                key={app.key}
                type="button"
                data-testid="search-result-item"
                onClick={() => {
                  void launchMiniApp(app.botUsername, app.shortName);
                  useUiStore.getState().setMiniAppModalOpen(true);
                }}
                className="tg-chat-row"
                style={{ width: '100%', textAlign: 'left' }}
              >
                <span className="tg-avatar tg-avatar--sm" data-color-index="2">
                  🧩
                </span>
                <span className="tg-chat-row-body">
                  <span className="tg-chat-row-title">
                    {renderSafeHighlightedText(app.title, trimmedQuery)}
                  </span>
                  <span className="tg-chat-row-subtitle">
                    {renderSafeHighlightedText(app.description, trimmedQuery)}
                  </span>
                </span>
              </button>
            ))}
          </section>
        )}

        {showHitsSection && (
          <section style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <div
              style={{
                padding: '4px 8px',
                fontSize: '11.5px',
                fontWeight: 600,
                color: 'var(--tg-text-secondary)',
                textTransform: 'uppercase',
              }}
            >
              {t('search.tab.messages', language)} ({matchedMessageHits.length})
            </div>
            {matchedMessageHits.map((hit) => {
              const chatTitle =
                hit.chat_title || chatsById[hit.chat_id]?.title || `Chat #${hit.chat_id}`;
              return (
                <button
                  key={`${hit.chat_id}-${hit.message_id}`}
                  type="button"
                  data-testid="search-result-item"
                  data-chat-id={String(hit.chat_id)}
                  data-message-id={String(hit.message_id)}
                  onClick={() => void handleOpenMessageHit(hit)}
                  className="tg-chat-row"
                  style={{ width: '100%', textAlign: 'left' }}
                >
                  <span
                    className="tg-avatar tg-avatar--sm"
                    data-color-index={String(peerAvatarColorIndex(hit.chat_id))}
                  >
                    {chatTitle.slice(0, 2).toUpperCase()}
                  </span>
                  <span className="tg-chat-row-body">
                    <span className="tg-chat-row-top">
                      <span className="tg-chat-row-title">
                        {renderSafeHighlightedText(chatTitle, trimmedQuery)}
                      </span>
                      <span className="tg-chat-row-time">
                        {formatChatTimestamp(hit.date_ms, language)}
                      </span>
                    </span>
                    <span className="tg-chat-row-subtitle">
                      {renderSafeHighlightedText(hit.text, trimmedQuery)}
                    </span>
                  </span>
                </button>
              );
            })}
          </section>
        )}

        {isEmpty && (
          <div
            role="status"
            data-testid="search-empty-state"
            style={{
              padding: '36px 16px',
              textAlign: 'center',
              color: 'var(--tg-text-secondary)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <span style={{ fontSize: '28px' }} aria-hidden="true">
              🔍
            </span>
            <strong style={{ fontSize: '14px', color: 'var(--tg-text-primary)' }}>
              {t('search.noResults', language)}
            </strong>
          </div>
        )}
      </div>
    </div>
  );
};

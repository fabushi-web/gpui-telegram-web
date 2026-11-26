import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  DOM_IDS,
  extractPlainTextFromContent,
} from '@gpui-telegram/protocol';
import { useChatStore } from '../../store/useChatStore';
import { useUiStore } from '../../store/useUiStore';

export interface InChatSearchBarProps {
  chatId: number;
  onJumpToMessage: (messageId: number) => void;
}

export const InChatSearchBar: React.FC<InChatSearchBarProps> = ({
  chatId,
  onJumpToMessage,
}) => {
  const inChatSearchOpen = useUiStore((s) => s.inChatSearchOpen);
  const setInChatSearchOpen = useUiStore((s) => s.setInChatSearchOpen);

  const inChatSearchQuery = useChatStore((s) => s.inChatSearchQuery);
  const inChatSearchHits = useChatStore((s) => s.inChatSearchHits);
  const searchInChat = useChatStore((s) => s.searchInChat);
  const messagesByChat = useChatStore((s) => s.messagesByChat);
  const peersById = useChatStore((s) => s.peersById);

  const [query, setQuery] = useState<string>(inChatSearchQuery || '');
  const [senderFilter, setSenderFilter] = useState<string>('all');
  const [dateFilter, setDateFilter] = useState<string>('');
  const [activeHitIdx, setActiveHitIdx] = useState<number>(0);

  const inputRef = useRef<HTMLInputElement | null>(null);

  // Sync external hashtag/store query into input when opened
  useEffect(() => {
    if (inChatSearchQuery !== query) {
      setQuery(inChatSearchQuery);
      setActiveHitIdx(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inChatSearchQuery]);

  useEffect(() => {
    if (inChatSearchOpen) {
      window.requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [inChatSearchOpen, chatId]);

  const chatMessages = useMemo(
    () => messagesByChat[chatId] ?? [],
    [chatId, messagesByChat],
  );

  const senderOptions = useMemo(() => {
    const map = new Map<number, string>();
    for (const msg of chatMessages) {
      if (!msg.sender_id || map.has(msg.sender_id)) continue;
      const peer = peersById[msg.sender_id];
      const label = peer
        ? `${peer.firstName}${peer.lastName ? ` ${peer.lastName}` : ''}`
        : `User #${msg.sender_id}`;
      map.set(msg.sender_id, label);
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [chatMessages, peersById]);

  const matchedMessageIds = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    const hasFilter =
      trimmed.length > 0 || senderFilter !== 'all' || dateFilter.length > 0;
    if (!hasFilter) return [];

    const dateStartMs = dateFilter ? Date.parse(`${dateFilter}T00:00:00`) : null;
    const dateEndMs = dateFilter ? Date.parse(`${dateFilter}T23:59:59.999`) : null;

    const localIds: number[] = [];
    for (const msg of chatMessages) {
      if (msg.content.type === 'Service') continue;
      if (senderFilter !== 'all' && String(msg.sender_id) !== senderFilter) {
        continue;
      }
      if (dateStartMs !== null && dateEndMs !== null && Number.isFinite(dateStartMs)) {
        const msgMs = msg.date_ms ?? Date.parse(msg.date);
        if (msgMs < dateStartMs || msgMs > dateEndMs) {
          continue;
        }
      }
      if (trimmed.length > 0) {
        const body = (
          msg.text ?? extractPlainTextFromContent(msg.content)
        ).toLowerCase();
        if (!body.includes(trimmed)) {
          continue;
        }
      }
      localIds.push(msg.id);
    }

    // Merge adapter hits if not already in localIds
    if (trimmed.length > 0 && senderFilter === 'all' && !dateFilter) {
      for (const hit of inChatSearchHits) {
        if (hit.chat_id === chatId && !localIds.includes(hit.message_id)) {
          localIds.push(hit.message_id);
        }
      }
    }

    return localIds.sort((a, b) => a - b);
  }, [chatId, chatMessages, dateFilter, inChatSearchHits, query, senderFilter]);

  useEffect(() => {
    if (matchedMessageIds.length > 0) {
      const clampedIdx = Math.min(activeHitIdx, matchedMessageIds.length - 1);
      const targetId = matchedMessageIds[clampedIdx];
      if (targetId !== undefined) {
        onJumpToMessage(targetId);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchedMessageIds.length, query, senderFilter, dateFilter]);

  if (!inChatSearchOpen) {
    return null;
  }

  const hasCriteria =
    query.trim().length > 0 || senderFilter !== 'all' || dateFilter.length > 0;
  const totalMatches = matchedMessageIds.length;
  const safeActiveIdx =
    totalMatches > 0 ? ((activeHitIdx % totalMatches) + totalMatches) % totalMatches : 0;

  const stepHit = (delta: -1 | 1) => {
    if (totalMatches === 0) return;
    const nextIdx = (safeActiveIdx + delta + totalMatches) % totalMatches;
    setActiveHitIdx(nextIdx);
    const msgId = matchedMessageIds[nextIdx];
    if (msgId !== undefined) {
      onJumpToMessage(msgId);
    }
  };

  const handleDateChange = (nextDate: string) => {
    setDateFilter(nextDate);
    setActiveHitIdx(0);
    if (nextDate && query.trim().length === 0 && senderFilter === 'all') {
      const targetMs = Date.parse(`${nextDate}T00:00:00`);
      if (Number.isFinite(targetMs)) {
        const nearest = chatMessages.find(
          (m) => (m.date_ms ?? Date.parse(m.date)) >= targetMs,
        );
        if (nearest) {
          onJumpToMessage(nearest.id);
        }
      }
    }
  };

  const handleCloseSearch = (): void => {
    setQuery('');
    setActiveHitIdx(0);
    void searchInChat(chatId, '');
    setInChatSearchOpen(false);
  };

  return (
    <div
      id="in-chat-search-bar"
      data-testid="in-chat-search-bar"
      role="search"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 14px',
        backgroundColor: 'var(--tg-bg-elevated)',
        borderBottom: '1px solid var(--tg-hairline-border)',
        flexShrink: 0,
        zIndex: 6,
      }}
    >
      <input
        ref={inputRef}
        id={DOM_IDS.IN_CHAT_SEARCH_INPUT}
        type="search"
        placeholder="Search in this chat…"
        aria-label="Search in chat"
        value={query}
        onChange={(e) => {
          const val = e.target.value;
          setQuery(val);
          setActiveHitIdx(0);
          void searchInChat(chatId, val);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            handleCloseSearch();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            stepHit(e.shiftKey ? -1 : 1);
          }
        }}
        style={{
          flex: '1 1 180px',
          minWidth: '140px',
          padding: '5px 10px',
          borderRadius: '8px',
          border: '1px solid var(--tg-hairline-border)',
          backgroundColor: 'var(--tg-bg-input)',
          color: 'var(--tg-text-primary)',
          fontSize: '13px',
        }}
      />

      <select
        data-testid="in-chat-search-sender"
        aria-label="Filter by sender"
        value={senderFilter}
        onChange={(e) => {
          setSenderFilter(e.target.value);
          setActiveHitIdx(0);
        }}
        style={{
          padding: '5px 8px',
          borderRadius: '8px',
          border: '1px solid var(--tg-hairline-border)',
          backgroundColor: 'var(--tg-bg-input)',
          color: 'var(--tg-text-primary)',
          fontSize: '12px',
        }}
      >
        <option value="all">All Senders</option>
        {senderOptions.map((opt) => (
          <option key={opt.id} value={String(opt.id)}>
            {opt.name}
          </option>
        ))}
      </select>

      <input
        type="date"
        data-testid="in-chat-search-date"
        aria-label="Jump to date"
        value={dateFilter}
        onChange={(e) => handleDateChange(e.target.value)}
        style={{
          padding: '4px 8px',
          borderRadius: '8px',
          border: '1px solid var(--tg-hairline-border)',
          backgroundColor: 'var(--tg-bg-input)',
          color: 'var(--tg-text-primary)',
          fontSize: '12px',
        }}
      />

      <span
        data-testid="in-chat-search-counter"
        style={{
          fontSize: '12px',
          color: 'var(--tg-text-secondary)',
          minWidth: '52px',
          textAlign: 'center',
        }}
      >
        {hasCriteria
          ? totalMatches > 0
            ? `${safeActiveIdx + 1} / ${totalMatches}`
            : '0 / 0'
          : ''}
      </span>

      <button
        id={DOM_IDS.IN_CHAT_SEARCH_PREV}
        type="button"
        aria-label="Previous match"
        disabled={totalMatches === 0}
        onClick={() => stepHit(-1)}
        style={searchNavBtnStyle(totalMatches === 0)}
      >
        ▲
      </button>

      <button
        id={DOM_IDS.IN_CHAT_SEARCH_NEXT}
        type="button"
        aria-label="Next match"
        disabled={totalMatches === 0}
        onClick={() => stepHit(1)}
        style={searchNavBtnStyle(totalMatches === 0)}
      >
        ▼
      </button>

      <button
        type="button"
        data-testid="in-chat-search-close"
        aria-label="Close search"
        onClick={handleCloseSearch}
        style={searchNavBtnStyle(false)}
      >
        ✕
      </button>
    </div>
  );
};

function searchNavBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: '4px 8px',
    borderRadius: '6px',
    border: '1px solid var(--tg-border, #242F3D)',
    backgroundColor: 'transparent',
    color: 'var(--tg-text-primary, #F5F5F5)',
    fontSize: '12px',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.4 : 1,
  };
}

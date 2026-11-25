import React, { useState } from 'react';
import {
  DOM_IDS,
  type BotRegistryEntry,
  type ChatSummary,
} from '@gpui-telegram/protocol';
import { useChatStore } from '../../store/useChatStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useUiStore } from '../../store/useUiStore';
import { GrokBotAvatar } from '../common/GrokBotAvatar';

export interface BotDescriptionCardProps {
  chat: ChatSummary;
  bot?: BotRegistryEntry;
}

export const BotDescriptionCard: React.FC<BotDescriptionCardProps> = ({ chat, bot }) => {
  const language = useSettingsStore((s) => s.language);
  const isZh = language === 'zh-CN';
  const sourceId =
    bot?.agent_id || bot?.username || chat.username || String(chat.peerUserId ?? chat.chatId);
  const description =
    (bot?.description || bot?.about || chat.about || '').trim() ||
    (isZh
      ? '点击下方“开始”按钮发送 /start 以启动与该机器人的对话。'
      : 'Click START below to send /start and begin chatting with this bot.');

  return (
    <div id="stage-bot-description-card" data-testid="bot-description-card">
      <GrokBotAvatar
        sourceId={sourceId}
        shape={bot?.avatar_shape}
        color={bot?.avatar_color}
        sizePx={68}
        title={chat.title}
      />
      <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--tg-text-primary)' }}>
        {chat.title}
      </div>
      <div
        style={{
          fontSize: '13px',
          fontWeight: 600,
          color: 'var(--tg-accent)',
        }}
      >
        {isZh ? '这个机器人能做什么？ · What can this bot do?' : 'What can this bot do? · 这个机器人能做什么？'}
      </div>
      <p
        style={{
          fontSize: '13px',
          lineHeight: 1.5,
          color: 'var(--tg-text-secondary)',
          whiteSpace: 'pre-wrap',
        }}
      >
        {description}
      </p>
    </div>
  );
};

export interface BotPreStartBarProps {
  chat: ChatSummary;
  onStarted: () => void;
}

export const BotPreStartBar: React.FC<BotPreStartBarProps> = ({ chat, onStarted }) => {
  const language = useSettingsStore((s) => s.language);
  const isZh = language === 'zh-CN';
  const sendText = useChatStore((s) => s.sendText);
  const pushToast = useUiStore((s) => s.pushToast);
  const [starting, setStarting] = useState<boolean>(false);

  const handleStart = async (): Promise<void> => {
    if (starting) return;
    setStarting(true);
    try {
      onStarted();
      await sendText(chat.chatId, '/start');
    } catch (err) {
      pushToast(
        err instanceof Error ? err.message : isZh ? '发送 /start 失败' : 'Failed to send /start',
        'error',
      );
    } finally {
      setStarting(false);
    }
  };

  return (
    <div id={DOM_IDS.BOT_PRESTART_BAR} data-testid="bot-prestart-bar">
      <div className="tg-bot-prestart-inner">
        <button
          id="stage-bot-start-btn"
          type="button"
          disabled={starting}
          onClick={() => void handleStart()}
          className="tg-btn tg-btn--primary"
          style={{
            minWidth: '180px',
            borderRadius: 'var(--tg-radius-pill)',
            fontWeight: 700,
            letterSpacing: '0.4px',
          }}
        >
          {starting
            ? isZh
              ? '正在启动…'
              : 'Starting…'
            : isZh
              ? 'START · 开始'
              : 'START · 开始'}
        </button>
      </div>
    </div>
  );
};

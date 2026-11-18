import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  DOM_IDS,
  extractPlainTextFromContent,
} from '@gpui-telegram/protocol';
import { formatDurationClock } from '../../i18n';
import { useChatStore } from '../../store/useChatStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useUiStore } from '../../store/useUiStore';
import {
  CanonicalComposer,
  type CanonicalComposerHandle,
} from './CanonicalComposer';
import { ChatHeader } from './ChatHeader';
import { InChatSearchBar } from './InChatSearchBar';
import { MessageList, type MessageListHandle } from './MessageList';
import { PinnedBanner } from './PinnedBanner';
import { SelectionToolbar } from './SelectionToolbar';

type FallbackDialogState =
  | { kind: 'delete'; chatId: number; messageIds: number[] }
  | { kind: 'forward'; fromChatId: number; messageIds: number[] }
  | { kind: 'poll'; chatId: number }
  | { kind: 'todo'; chatId: number }
  | { kind: 'invoice'; chatId: number }
  | null;

export const MiddleColumn: React.FC = () => {
  const activeChatId = useChatStore((s) => s.activeChatId);
  const chatsById = useChatStore((s) => s.chatsById);
  const orderedChatIds = useChatStore((s) => s.orderedChatIds);
  const activeTopicId = useChatStore((s) => s.activeTopicId);
  const clearMultiSelect = useChatStore((s) => s.clearMultiSelect);
  const deleteMessages = useChatStore((s) => s.deleteMessages);
  const forwardMessages = useChatStore((s) => s.forwardMessages);
  const createPoll = useChatStore((s) => s.createPoll);
  const createTodo = useChatStore((s) => s.createTodo);
  const createInvoice = useChatStore((s) => s.createInvoice);
  const selectChat = useChatStore((s) => s.selectChat);

  const audioPlayerState = useUiStore((s) => s.audioPlayerState);
  const toggleAudioPlayPause = useUiStore((s) => s.toggleAudioPlayPause);
  const seekAudioProgress = useUiStore((s) => s.seekAudioProgress);
  const cycleAudioRate = useUiStore((s) => s.cycleAudioRate);
  const closeAudioPlayer = useUiStore((s) => s.closeAudioPlayer);
  const closeModal = useUiStore((s) => s.closeModal);

  const wallpaper = useSettingsStore((s) => s.wallpaper);
  const wallpaperBlur = useSettingsStore((s) => s.wallpaperBlur);

  const messageListRef = useRef<MessageListHandle | null>(null);
  const composerRef = useRef<CanonicalComposerHandle | null>(null);

  const [highlightedMessageId, setHighlightedMessageId] = useState<
    number | null
  >(null);
  const [hasExternalAudioBar, setHasExternalAudioBar] =
    useState<boolean>(false);
  const [fallbackDialog, setFallbackDialog] =
    useState<FallbackDialogState>(null);

  // Form states for non-colliding fallback dialogs
  const [fwdHideSender, setFwdHideSender] = useState<boolean>(false);
  const [fwdComment, setFwdComment] = useState<string>('');
  const [pollQuestion, setPollQuestion] = useState<string>('');
  const [pollOptions, setPollOptions] = useState<string[]>(['', '']);
  const [pollIsQuiz, setPollIsQuiz] = useState<boolean>(false);
  const [pollMultiple, setPollMultiple] = useState<boolean>(false);
  const [pollAnonymous, setPollAnonymous] = useState<boolean>(true);
  const [pollCorrectIdx, setPollCorrectIdx] = useState<number>(0);
  const [pollExplanation, setPollExplanation] = useState<string>('');
  const [todoTitle, setTodoTitle] = useState<string>('');
  const [todoItems, setTodoItems] = useState<string[]>(['', '']);
  const [invoiceTitle, setInvoiceTitle] = useState<string>('');
  const [invoiceDesc, setInvoiceDesc] = useState<string>('');
  const [invoiceAmount, setInvoiceAmount] = useState<string>('50');

  const activeChat =
    activeChatId !== null ? (chatsById[activeChatId] ?? null) : null;

  // Reset highlighted bubble when switching chats
  useEffect(() => {
    setHighlightedMessageId(null);
  }, [activeChatId]);

  // Detect if AppShell/Calls already mounts an external #top-audio-player-bar to avoid duplicate DOM IDs
  useEffect(() => {
    if (!audioPlayerState.isOpen || typeof document === 'undefined') {
      setHasExternalAudioBar(false);
      return;
    }
    const existing = document.querySelector(
      `#${DOM_IDS.TOP_AUDIO_PLAYER_BAR}:not([data-middle-audio-bar="true"])`,
    );
    setHasExternalAudioBar(Boolean(existing));
  }, [audioPlayerState.isOpen]);

  const openFallbackIfNoExternalModal = useCallback(
    (nextState: Exclude<FallbackDialogState, null>) => {
      window.requestAnimationFrame(() => {
        const externalDialogs = document.querySelectorAll(
          '[role="dialog"]:not([data-middle-fallback-dialog="true"])',
        );
        if (externalDialogs.length === 0) {
          setFallbackDialog(nextState);
        }
      });
    },
    [],
  );

  const handleJumpToMessage = useCallback((messageId: number) => {
    void messageListRef.current?.scrollToMessage(messageId);
  }, []);

  const handleRequestDelete = useCallback(
    (messageIds: number[]) => {
      if (!activeChat) return;
      useUiStore.getState().openModal('delete_confirm', {
        chatId: activeChat.chatId,
        messageIds,
      });
      openFallbackIfNoExternalModal({
        kind: 'delete',
        chatId: activeChat.chatId,
        messageIds,
      });
    },
    [activeChat, openFallbackIfNoExternalModal],
  );

  const handleRequestForward = useCallback(
    (messageIds: number[]) => {
      if (!activeChat) return;
      setFwdHideSender(false);
      setFwdComment('');
      openFallbackIfNoExternalModal({
        kind: 'forward',
        fromChatId: activeChat.chatId,
        messageIds,
      });
    },
    [activeChat, openFallbackIfNoExternalModal],
  );

  const handleRequestCreator = useCallback(
    (kind: 'poll' | 'todo' | 'invoice') => {
      if (!activeChat) return;
      if (kind === 'poll') {
        setPollQuestion('');
        setPollOptions(['', '']);
        setPollIsQuiz(false);
        setPollMultiple(false);
        setPollAnonymous(true);
        setPollCorrectIdx(0);
        setPollExplanation('');
        openFallbackIfNoExternalModal({ kind: 'poll', chatId: activeChat.chatId });
      } else if (kind === 'todo') {
        setTodoTitle('');
        setTodoItems(['', '']);
        openFallbackIfNoExternalModal({ kind: 'todo', chatId: activeChat.chatId });
      } else {
        setInvoiceTitle('');
        setInvoiceDesc('');
        setInvoiceAmount('50');
        openFallbackIfNoExternalModal({
          kind: 'invoice',
          chatId: activeChat.chatId,
        });
      }
    },
    [activeChat, openFallbackIfNoExternalModal],
  );

  useEffect(() => {
    if (!fallbackDialog) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setFallbackDialog(null);
        closeModal();
      }
    };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [closeModal, fallbackDialog]);

  const closeFallback = () => {
    setFallbackDialog(null);
    closeModal();
  };

  const renderPersistentAudioBar = () => {
    if (!audioPlayerState.isOpen || hasExternalAudioBar) {
      return null;
    }
    const trackMsg = audioPlayerState.message;
    const trackChat =
      audioPlayerState.chatId !== null
        ? chatsById[audioPlayerState.chatId]
        : undefined;
    const trackTitle = trackMsg
      ? trackMsg.content.type === 'Audio' && trackMsg.content.data.title
        ? trackMsg.content.data.title
        : `Voice Note · ${trackChat?.title || 'Chat'}`
      : 'Voice Message';

    return (
      <div
        id={DOM_IDS.TOP_AUDIO_PLAYER_BAR}
        data-testid="top-audio-player-bar"
        data-middle-audio-bar="true"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '10px',
          padding: '6px 14px',
          backgroundColor: 'var(--tg-bg-elevated, #1E2C3A)',
          borderBottom: '1px solid var(--tg-border, #242F3D)',
          flexShrink: 0,
          zIndex: 7,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flex: '1 1 auto' }}>
          <button
            type="button"
            data-testid="top-audio-play-pause"
            aria-label={audioPlayerState.isPlaying ? 'Pause audio' : 'Play audio'}
            onClick={() => toggleAudioPlayPause()}
            style={{
              width: '30px',
              height: '30px',
              borderRadius: '50%',
              border: 'none',
              backgroundColor: 'var(--tg-accent, #3390EC)',
              color: '#FFFFFF',
              fontSize: '12px',
              fontWeight: 700,
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            {audioPlayerState.isPlaying ? '❚❚' : '▶'}
          </button>

          <div
            onClick={() => {
              if (audioPlayerState.chatId !== null) {
                void selectChat(audioPlayerState.chatId);
              }
            }}
            style={{ minWidth: 0, flex: '1 1 auto', cursor: 'pointer' }}
          >
            <div
              style={{
                fontSize: '12.5px',
                fontWeight: 600,
                color: 'var(--tg-text-primary, #F5F5F5)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {trackTitle}
            </div>
            <div
              onClick={(e) => {
                e.stopPropagation();
                const rect = e.currentTarget.getBoundingClientRect();
                if (rect.width > 0) {
                  seekAudioProgress((e.clientX - rect.left) / rect.width);
                }
              }}
              style={{
                marginTop: '3px',
                height: '4px',
                borderRadius: '999px',
                backgroundColor: 'rgba(255,255,255,0.14)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${Math.round(audioPlayerState.progress * 100)}%`,
                  height: '100%',
                  backgroundColor: 'var(--tg-accent, #3390EC)',
                }}
              />
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
          <span style={{ fontSize: '11.5px', color: 'var(--tg-text-secondary, #8FA2B7)' }}>
            {formatDurationClock(audioPlayerState.currentTimeSec)} /{' '}
            {formatDurationClock(audioPlayerState.durationSec)}
          </span>
          <button
            type="button"
            aria-label="Cycle playback speed"
            onClick={() => cycleAudioRate()}
            style={smallPillStyle}
          >
            {audioPlayerState.rate}x
          </button>
          <button
            type="button"
            data-testid="top-audio-close"
            aria-label="Close audio player"
            onClick={() => closeAudioPlayer()}
            style={smallPillStyle}
          >
            ✕
          </button>
        </div>
      </div>
    );
  };

  return (
    <section
      id={DOM_IDS.MIDDLE_COLUMN}
      className="tg-middle-column"
      data-wallpaper={wallpaper}
      data-wallpaper-blur={wallpaperBlur ? 'true' : 'false'}
      style={{
        position: 'relative',
        flex: '1 1 auto',
        minWidth: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {!activeChat ? (
        <>
          {renderPersistentAudioBar()}
          <div
            data-testid="middle-empty-state"
            style={{
              flex: '1 1 auto',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '24px',
            }}
          >
            <div
              style={{
                padding: '10px 20px',
                borderRadius: '999px',
                backgroundColor: 'rgba(14, 22, 33, 0.65)',
                border: '1px solid var(--tg-border, #242F3D)',
                color: 'var(--tg-text-secondary, #8FA2B7)',
                fontSize: '14px',
                fontWeight: 500,
              }}
            >
              Select a chat to start messaging · 选择会话开始聊天
            </div>
          </div>
        </>
      ) : (
        <>
          <ChatHeader
            chat={activeChat}
            onOpenLocalCreator={handleRequestCreator}
          />
          {renderPersistentAudioBar()}
          <InChatSearchBar
            chatId={activeChat.chatId}
            onJumpToMessage={handleJumpToMessage}
          />
          <PinnedBanner
            chatId={activeChat.chatId}
            onJumpToMessage={handleJumpToMessage}
          />
          <MessageList
            ref={messageListRef}
            chat={activeChat}
            highlightedMessageId={highlightedMessageId}
            onHighlightMessage={setHighlightedMessageId}
            onDropFiles={(files) =>
              void composerRef.current?.handleIncomingFiles(files)
            }
            onRequestForward={handleRequestForward}
            onRequestDelete={handleRequestDelete}
          />
          <SelectionToolbar
            chatId={activeChat.chatId}
            onRequestForward={handleRequestForward}
            onRequestDelete={handleRequestDelete}
          />
          <CanonicalComposer
            ref={composerRef}
            chat={activeChat}
            onSentScrollToBottom={() => messageListRef.current?.scrollToBottom()}
            onOpenLocalCreator={handleRequestCreator}
          />
        </>
      )}

      {/* Non-colliding Fallback Dialogs (only active if external Modals manager did not mount a dialog) */}
      {fallbackDialog?.kind === 'delete' && (
        <div
          className="tg-modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeFallback();
          }}
          style={modalBackdropStyle}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Delete Messages"
            data-middle-fallback-dialog="true"
            style={modalCardStyle}
          >
            <strong>
              Delete {fallbackDialog.messageIds.length} message(s)? · 确认删除消息？
            </strong>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
              <button
                type="button"
                onClick={async () => {
                  const { chatId, messageIds } = fallbackDialog;
                  closeFallback();
                  await deleteMessages(chatId, messageIds, true);
                  clearMultiSelect();
                }}
                style={dangerSolidBtnStyle}
              >
                Delete for everyone · 为所有人删除
              </button>
              <button
                type="button"
                onClick={async () => {
                  const { chatId, messageIds } = fallbackDialog;
                  closeFallback();
                  await deleteMessages(chatId, messageIds, false);
                  clearMultiSelect();
                }}
                style={secondaryModalBtnStyle}
              >
                Delete for me · 仅为我删除
              </button>
              <button
                type="button"
                onClick={closeFallback}
                style={secondaryModalBtnStyle}
              >
                Cancel · 取消
              </button>
            </div>
          </div>
        </div>
      )}

      {fallbackDialog?.kind === 'forward' && (
        <div
          className="tg-modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeFallback();
          }}
          style={modalBackdropStyle}
        >
          <div
            id={DOM_IDS.MODAL_FORWARD}
            role="dialog"
            aria-modal="true"
            aria-label="Forward Messages"
            data-middle-fallback-dialog="true"
            style={modalCardStyle}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>Forward {fallbackDialog.messageIds.length} message(s) · 转发至…</strong>
              <button type="button" onClick={closeFallback} style={smallPillStyle}>
                ✕
              </button>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
              <input
                type="checkbox"
                checked={fwdHideSender}
                onChange={(e) => setFwdHideSender(e.target.checked)}
              />
              <span>Hide sender name · 隐藏发送者署名</span>
            </label>

            <input
              type="text"
              placeholder="Optional comment…"
              value={fwdComment}
              onChange={(e) => setFwdComment(e.target.value)}
              style={modalInputStyle}
            />

            <div style={{ maxHeight: '220px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {orderedChatIds.map((cid) => {
                const target = chatsById[cid];
                if (!target) return null;
                return (
                  <button
                    key={cid}
                    type="button"
                    data-forward-target-id={String(cid)}
                    onClick={async () => {
                      const { fromChatId, messageIds } = fallbackDialog;
                      closeFallback();
                      await forwardMessages(fromChatId, cid, messageIds, {
                        hideSender: fwdHideSender,
                        comment: fwdComment.trim() || undefined,
                      });
                      clearMultiSelect();
                      await selectChat(cid);
                    }}
                    style={{
                      padding: '8px 10px',
                      borderRadius: '8px',
                      border: '1px solid var(--tg-border, #242F3D)',
                      backgroundColor: 'rgba(255,255,255,0.04)',
                      color: '#F5F5F5',
                      textAlign: 'left',
                      fontSize: '13.5px',
                      cursor: 'pointer',
                    }}
                  >
                    {target.title}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {fallbackDialog?.kind === 'poll' && (
        <div
          className="tg-modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeFallback();
          }}
          style={modalBackdropStyle}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Create Poll"
            data-middle-fallback-dialog="true"
            style={modalCardStyle}
          >
            <strong>Create Poll / Quiz · 发起投票</strong>
            <input
              type="text"
              placeholder="Ask a question…"
              aria-label="Poll question"
              value={pollQuestion}
              onChange={(e) => setPollQuestion(e.target.value)}
              style={modalInputStyle}
            />
            {pollOptions.map((opt, idx) => (
              <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                {pollIsQuiz && (
                  <input
                    type="radio"
                    name="quiz-correct"
                    aria-label={`Correct option ${idx + 1}`}
                    checked={pollCorrectIdx === idx}
                    onChange={() => setPollCorrectIdx(idx)}
                  />
                )}
                <input
                  type="text"
                  placeholder={`Option ${idx + 1}`}
                  aria-label={`Option ${idx + 1}`}
                  value={opt}
                  onChange={(e) => {
                    const copy = [...pollOptions];
                    copy[idx] = e.target.value;
                    setPollOptions(copy);
                  }}
                  style={{ ...modalInputStyle, flex: '1 1 auto' }}
                />
              </div>
            ))}
            {pollOptions.length < 10 && (
              <button
                type="button"
                onClick={() => setPollOptions([...pollOptions, ''])}
                style={secondaryModalBtnStyle}
              >
                + Add Option · 添加选项
              </button>
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
              <input
                type="checkbox"
                checked={pollAnonymous}
                onChange={(e) => setPollAnonymous(e.target.checked)}
              />
              <span>Anonymous Voting · 匿名投票</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
              <input
                type="checkbox"
                checked={pollMultiple}
                disabled={pollIsQuiz}
                onChange={(e) => setPollMultiple(e.target.checked)}
              />
              <span>Multiple Answers · 多选</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
              <input
                type="checkbox"
                checked={pollIsQuiz}
                onChange={(e) => {
                  setPollIsQuiz(e.target.checked);
                  if (e.target.checked) setPollMultiple(false);
                }}
              />
              <span>Quiz Mode · 测验模式</span>
            </label>
            {pollIsQuiz && (
              <input
                type="text"
                placeholder="Quiz explanation (shown after answering)…"
                aria-label="Quiz explanation"
                value={pollExplanation}
                onChange={(e) => setPollExplanation(e.target.value)}
                style={modalInputStyle}
              />
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button type="button" onClick={closeFallback} style={secondaryModalBtnStyle}>
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  const q = pollQuestion.trim();
                  const opts = pollOptions.map((o) => o.trim()).filter(Boolean);
                  if (!q || opts.length < 2) return;
                  const cid = fallbackDialog.chatId;
                  closeFallback();
                  await createPoll(cid, {
                    question: q,
                    options: opts,
                    isAnonymous: pollAnonymous,
                    allowsMultipleAnswers: pollMultiple && !pollIsQuiz,
                    isQuiz: pollIsQuiz,
                    correctOptionId: pollIsQuiz ? pollCorrectIdx : undefined,
                    explanation: pollIsQuiz ? pollExplanation.trim() || undefined : undefined,
                    topicId: activeTopicId ?? undefined,
                  });
                  messageListRef.current?.scrollToBottom();
                }}
                style={primaryModalBtnStyle}
              >
                Create · 创建
              </button>
            </div>
          </div>
        </div>
      )}

      {fallbackDialog?.kind === 'todo' && (
        <div
          className="tg-modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeFallback();
          }}
          style={modalBackdropStyle}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Create Todo Checklist"
            data-middle-fallback-dialog="true"
            style={modalCardStyle}
          >
            <strong>Create Todo Checklist · 创建待办清单</strong>
            <input
              type="text"
              placeholder="Checklist title…"
              aria-label="Checklist title"
              value={todoTitle}
              onChange={(e) => setTodoTitle(e.target.value)}
              style={modalInputStyle}
            />
            {todoItems.map((it, idx) => (
              <input
                key={idx}
                type="text"
                placeholder={`Task ${idx + 1}`}
                aria-label={`Task ${idx + 1}`}
                value={it}
                onChange={(e) => {
                  const copy = [...todoItems];
                  copy[idx] = e.target.value;
                  setTodoItems(copy);
                }}
                style={modalInputStyle}
              />
            ))}
            <button
              type="button"
              onClick={() => setTodoItems([...todoItems, ''])}
              style={secondaryModalBtnStyle}
            >
              + Add Task · 添加任务
            </button>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button type="button" onClick={closeFallback} style={secondaryModalBtnStyle}>
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  const title = todoTitle.trim() || 'Shared Checklist';
                  const items = todoItems.map((i) => i.trim()).filter(Boolean);
                  if (items.length === 0) return;
                  const cid = fallbackDialog.chatId;
                  closeFallback();
                  await createTodo(cid, title, items, activeTopicId ?? undefined);
                  messageListRef.current?.scrollToBottom();
                }}
                style={primaryModalBtnStyle}
              >
                Create · 创建
              </button>
            </div>
          </div>
        </div>
      )}

      {fallbackDialog?.kind === 'invoice' && (
        <div
          className="tg-modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeFallback();
          }}
          style={modalBackdropStyle}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Create Invoice"
            data-middle-fallback-dialog="true"
            style={modalCardStyle}
          >
            <strong>Create Stars Invoice · 创建账单</strong>
            <input
              type="text"
              placeholder="Product or service title…"
              aria-label="Invoice title"
              value={invoiceTitle}
              onChange={(e) => setInvoiceTitle(e.target.value)}
              style={modalInputStyle}
            />
            <input
              type="text"
              placeholder="Description…"
              aria-label="Invoice description"
              value={invoiceDesc}
              onChange={(e) => setInvoiceDesc(e.target.value)}
              style={modalInputStyle}
            />
            <input
              type="number"
              min={1}
              placeholder="Amount in Stars"
              aria-label="Stars amount"
              value={invoiceAmount}
              onChange={(e) => setInvoiceAmount(e.target.value)}
              style={modalInputStyle}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button type="button" onClick={closeFallback} style={secondaryModalBtnStyle}>
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  const title = invoiceTitle.trim() || 'Stars Digital Pass';
                  const amt = Math.max(1, Number(invoiceAmount) || 25);
                  const cid = fallbackDialog.chatId;
                  closeFallback();
                  await createInvoice(cid, {
                    title,
                    description: invoiceDesc.trim() || 'Digital unlock via Telegram Stars',
                    currency: 'XTR',
                    amount: amt,
                  });
                  messageListRef.current?.scrollToBottom();
                }}
                style={primaryModalBtnStyle}
              >
                Send Invoice · 发送账单
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};

// Re-export plain-text helper convenience if needed
export { extractPlainTextFromContent };

const smallPillStyle: React.CSSProperties = {
  padding: '3px 8px',
  borderRadius: '6px',
  border: '1px solid var(--tg-border, #242F3D)',
  backgroundColor: 'rgba(255, 255, 255, 0.06)',
  color: 'var(--tg-text-primary, #F5F5F5)',
  fontSize: '11.5px',
  fontWeight: 600,
  cursor: 'pointer',
};

const modalBackdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1320,
  backgroundColor: 'rgba(10, 15, 22, 0.8)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '16px',
};

const modalCardStyle: React.CSSProperties = {
  width: 'min(420px, 94vw)',
  maxHeight: '86dvh',
  overflowY: 'auto',
  padding: '18px',
  borderRadius: '12px',
  backgroundColor: 'var(--tg-bg-surface, #17212B)',
  border: '1px solid var(--tg-border, #242F3D)',
  color: 'var(--tg-text-primary, #F5F5F5)',
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
  boxShadow: '0 20px 48px rgba(0, 0, 0, 0.5)',
};

const modalInputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 11px',
  borderRadius: '8px',
  border: '1px solid var(--tg-border, #242F3D)',
  backgroundColor: '#0E1621',
  color: '#F5F5F5',
  fontSize: '13.5px',
  boxSizing: 'border-box',
};

const primaryModalBtnStyle: React.CSSProperties = {
  padding: '7px 15px',
  borderRadius: '8px',
  border: 'none',
  backgroundColor: 'var(--tg-accent, #3390EC)',
  color: '#FFFFFF',
  fontSize: '13px',
  fontWeight: 600,
  cursor: 'pointer',
};

const secondaryModalBtnStyle: React.CSSProperties = {
  padding: '7px 14px',
  borderRadius: '8px',
  border: '1px solid var(--tg-border, #242F3D)',
  backgroundColor: 'rgba(255, 255, 255, 0.05)',
  color: '#F5F5F5',
  fontSize: '13px',
  fontWeight: 500,
  cursor: 'pointer',
};

const dangerSolidBtnStyle: React.CSSProperties = {
  padding: '8px 14px',
  borderRadius: '8px',
  border: 'none',
  backgroundColor: '#E15B64',
  color: '#FFFFFF',
  fontSize: '13px',
  fontWeight: 600,
  cursor: 'pointer',
};

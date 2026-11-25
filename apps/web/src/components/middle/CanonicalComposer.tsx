import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  CODING_SLASH_COMMANDS,
  DOM_IDS,
  ImeSafetyFsm,
  extractPlainTextFromContent,
  serializeEntitiesToMarkdown,
  type BotRegistryEntry,
  type ChatSummary,
  type GifResultDto,
  type StickerItemDto,
} from '@gpui-telegram/protocol';
import { formatDurationClock } from '../../i18n';
import {
  startRoundVideoRecording,
  startVoiceRecording,
  type ActiveRoundVideoRecorderSession,
  type ActiveVoiceRecorderSession,
} from '../../services/audioRecorder';
import { useAiWorkspaceStore } from '../../store/useAiWorkspaceStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useChatStore } from '../../store/useChatStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useUiStore } from '../../store/useUiStore';

export interface CanonicalComposerHandle {
  handleIncomingFiles: (files: File[]) => Promise<void>;
  focusInput: () => void;
}

export interface CanonicalComposerProps {
  chat: ChatSummary;
  botMeta?: BotRegistryEntry;
  onSentScrollToBottom?: () => void;
  onOpenLocalCreator?: (kind: 'poll' | 'todo' | 'invoice') => void;
}

interface AutocompleteCandidate {
  kind: 'command' | 'mention';
  token: string;
  label: string;
  subtitle: string;
}

const POPULAR_EMOJIS = [
  '😀', '😂', '🤣', '😊', '😍', '🥰', '😎', '🤩',
  '🤔', '😮', '😢', '😭', '😡', '🤯', '🥳', '🙏',
  '👍', '👎', '👏', '🙌', '🔥', '❤️', '💯', '🎉',
  '✨', '⚡', '🚀', '💎', '🏆', '🎯', '✅', '👀',
] as const;

const BUILTIN_SLASH_COMMANDS: Array<{ command: string; description: string }> = [
  { command: '/start', description: 'Start bot or workspace session' },
  { command: '/help', description: 'Show available commands and tips' },
  { command: '/model', description: 'Switch active Hermes LLM model' },
  { command: '/status', description: 'Show gateway & runtime status' },
  { command: '/newbot', description: 'Register a new Fabushi bot' },
  { command: '/clear', description: 'Reset conversation context' },
];

function splitLongMessageIntoChunks(raw: string, maxLen = 4096): string[] {
  if (raw.length <= maxLen) return [raw];
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < raw.length) {
    const remaining = raw.length - cursor;
    if (remaining <= maxLen) {
      chunks.push(raw.slice(cursor));
      break;
    }
    const candidate = raw.slice(cursor, cursor + maxLen);
    let splitAt = candidate.lastIndexOf('\n');
    if (splitAt < maxLen * 0.5) {
      splitAt = candidate.lastIndexOf(' ');
    }
    if (splitAt <= 0) {
      splitAt = maxLen;
    }
    chunks.push(raw.slice(cursor, cursor + splitAt));
    cursor += splitAt;
    if (raw[cursor] === '\n' || raw[cursor] === ' ') {
      cursor += 1;
    }
  }
  return chunks.filter((c) => c.length > 0);
}

function probeImageDecodable(file: File | Blob): Promise<{ valid: boolean; objectUrl: string }> {
  const objectUrl = URL.createObjectURL(file);
  return new Promise((resolve) => {
    const img = new Image();
    let settled = false;
    const finish = (valid: boolean) => {
      if (settled) return;
      settled = true;
      resolve({ valid, objectUrl });
    };
    const timer = window.setTimeout(() => finish(false), 1200);
    img.onload = () => {
      window.clearTimeout(timer);
      finish(img.naturalWidth > 0 && img.naturalHeight > 0);
    };
    img.onerror = () => {
      window.clearTimeout(timer);
      finish(false);
    };
    img.src = objectUrl;
  });
}

function defaultFutureDatetimeLocal(): string {
  const d = new Date(Date.now() + 3_600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export const CanonicalComposer = React.forwardRef<
  CanonicalComposerHandle,
  CanonicalComposerProps
>(function CanonicalComposer(
  { chat, botMeta, onSentScrollToBottom, onOpenLocalCreator },
  ref,
) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const voiceSessionRef = useRef<ActiveVoiceRecorderSession | null>(null);
  const roundVideoSessionRef = useRef<ActiveRoundVideoRecorderSession | null>(null);
  const roundPreviewVideoRef = useRef<HTMLVideoElement | null>(null);
  const recordTimerRef = useRef<number | null>(null);
  const lastTypingSentAtRef = useRef<number>(0);

  const sendByEnter = useSettingsStore((s) => s.sendByEnter);
  const imeFsmRef = useRef<ImeSafetyFsm>(new ImeSafetyFsm({ sendByEnter }));

  useEffect(() => {
    imeFsmRef.current.setSendByEnter(sendByEnter);
  }, [sendByEnter]);

  const activeTopicId = useChatStore((s) => s.activeTopicId);
  const draftsByChat = useChatStore((s) => s.draftsByChat);
  const replyTargetByChat = useChatStore((s) => s.replyTargetByChat);
  const editingMessageByChat = useChatStore((s) => s.editingMessageByChat);
  const messagesByChat = useChatStore((s) => s.messagesByChat);
  const membersByChat = useChatStore((s) => s.membersByChat);
  const peersById = useChatStore((s) => s.peersById);
  const stickerSets = useChatStore((s) => s.stickerSets);
  const gifResults = useChatStore((s) => s.gifResults);
  const uploadProgress = useChatStore((s) => s.uploadProgress);

  const setReplyTarget = useChatStore((s) => s.setReplyTarget);
  const setEditingMessage = useChatStore((s) => s.setEditingMessage);
  const sendText = useChatStore((s) => s.sendText);
  const editMessage = useChatStore((s) => s.editMessage);
  const sendMediaFiles = useChatStore((s) => s.sendMediaFiles);
  const sendVoiceRecording = useChatStore((s) => s.sendVoiceRecording);
  const sendRoundVideoRecording = useChatStore((s) => s.sendRoundVideoRecording);
  const sendSticker = useChatStore((s) => s.sendSticker);
  const sendGif = useChatStore((s) => s.sendGif);
  const saveDraft = useChatStore((s) => s.saveDraft);
  const sendTyping = useChatStore((s) => s.sendTyping);
  const updateChatSettings = useChatStore((s) => s.updateChatSettings);
  const loadStickersAndGifs = useChatStore((s) => s.loadStickersAndGifs);
  const searchGifs = useChatStore((s) => s.searchGifs);
  const runAiComposeAssist = useChatStore((s) => s.runAiComposeAssist);

  const composerPopover = useUiStore((s) => s.composerPopover);
  const setComposerPopover = useUiStore((s) => s.setComposerPopover);
  const openMediaEditor = useUiStore((s) => s.openMediaEditor);
  const openModal = useUiStore((s) => s.openModal);
  const toggleRightSidebar = useUiStore((s) => s.toggleRightSidebar);
  const setMiniAppModalOpen = useUiStore((s) => s.setMiniAppModalOpen);
  const pushToast = useUiStore((s) => s.pushToast);

  const bots = useAiWorkspaceStore((s) => s.bots);
  const hermesCommands = useAiWorkspaceStore((s) => s.hermesCommands);
  const launchMiniApp = useAiWorkspaceStore((s) => s.launchMiniApp);
  const streamPrompt = useAiWorkspaceStore((s) => s.streamPrompt);
  const runSlashCommand = useAiWorkspaceStore((s) => s.runSlashCommand);
  const currentUser = useAuthStore((s) => s.currentUser);

  const replyTarget = replyTargetByChat[chat.chatId] ?? null;
  const editingMsg = editingMessageByChat[chat.chatId] ?? null;

  const [text, setText] = useState<string>(
    () => draftsByChat[chat.chatId]?.text ?? chat.draft?.text ?? '',
  );
  const [formattingOpen, setFormattingOpen] = useState<boolean>(false);
  const [pickerTab, setPickerTab] = useState<'emoji' | 'stickers' | 'gifs'>('emoji');
  const [gifSearchQuery, setGifSearchQuery] = useState<string>('');
  const [acHighlightIdx, setAcHighlightIdx] = useState<number>(0);
  const [sendMenuPos, setSendMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState<boolean>(false);
  const [scheduleDatetime, setScheduleDatetime] = useState<string>(defaultFutureDatetimeLocal);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState<boolean>(false);

  // Voice / Round Video Recording state
  const [recordMode, setRecordMode] = useState<'voice' | 'round_video'>('voice');
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [recordingElapsedSec, setRecordingElapsedSec] = useState<number>(0);

  // Sync text when switching chats
  useEffect(() => {
    const activeEdit = useChatStore.getState().editingMessageByChat[chat.chatId];
    if (activeEdit) {
      const plain =
        activeEdit.text ?? extractPlainTextFromContent(activeEdit.content);
      const md =
        activeEdit.entities && activeEdit.entities.length > 0
          ? serializeEntitiesToMarkdown(plain, activeEdit.entities)
          : plain;
      setText(md);
    } else {
      const draftText =
        useChatStore.getState().draftsByChat[chat.chatId]?.text ??
        chat.draft?.text ??
        '';
      setText(draftText);
    }
    setAcHighlightIdx(0);
    setSendMenuPos(null);
    setScheduleDialogOpen(false);
    imeFsmRef.current.onCompositionCancel();
  }, [chat.chatId, chat.draft?.text]);

  // Populate composer when entering or exiting edit mode
  useEffect(() => {
    if (editingMsg) {
      const plain =
        editingMsg.text ?? extractPlainTextFromContent(editingMsg.content);
      const md =
        editingMsg.entities && editingMsg.entities.length > 0
          ? serializeEntitiesToMarkdown(plain, editingMsg.entities)
          : plain;
      setText(md);
      window.requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    }
  }, [editingMsg]);

  // Focus composer when reply/quote banner is activated
  useEffect(() => {
    if (replyTarget) {
      window.requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    }
  }, [replyTarget]);

  // Load stickers/GIFs when emoji/sticker/gif popover opens
  useEffect(() => {
    if (composerPopover === 'emoji') {
      void loadStickersAndGifs();
    }
  }, [composerPopover, loadStickersAndGifs]);

  // Close send options menu on outside click
  useEffect(() => {
    if (!sendMenuPos) return;
    const close = () => setSendMenuPos(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [sendMenuPos]);

  // Cleanup active recording on unmount
  useEffect(() => {
    return () => {
      if (recordTimerRef.current !== null) {
        window.clearInterval(recordTimerRef.current);
      }
      void voiceSessionRef.current?.cancel();
      void roundVideoSessionRef.current?.cancel();
    };
  }, []);

  // Auto-resize textarea height in [36px .. 192px]
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (!text) {
      el.style.height = '36px';
      el.style.overflowY = 'hidden';
      return;
    }
    el.style.height = '36px';
    const sh = el.scrollHeight;
    const clamped = Math.max(36, Math.min(192, sh));
    el.style.height = `${clamped}px`;
    el.style.overflowY = sh > 192 ? 'auto' : 'hidden';
  }, [text]);

  const handleIncomingFiles = useCallback(
    async (rawFiles: File[]) => {
      if (rawFiles.length === 0) return;

      const allStaticImages = rawFiles.every((f) => {
        const m = (f.type || '').toLowerCase();
        return m.startsWith('image/') && !m.includes('gif');
      });

      // Trap #11 (A06-T1-02): Single OR multi-photo selection opens MediaEditorModal!
      if (allStaticImages) {
        const primary = rawFiles[0]!;
        const { valid, objectUrl } = await probeImageDecodable(primary);
        if (valid) {
          openMediaEditor({
            chatId: chat.chatId,
            file: primary,
            extraFiles: rawFiles.length > 1 ? rawFiles.slice(1) : undefined,
            previewUrl: objectUrl,
            fileName: primary.name || 'image.png',
            mimeType: primary.type || 'image/png',
            caption: text.trim(),
            hasSpoiler: false,
            cropRatio: 'free',
            annotations: [],
          });
          if (text.trim()) {
            setText('');
            void saveDraft(chat.chatId, '');
          }
          return;
        }

        // Corrupt image bytes fallback: upload safely as Document without crashing
        URL.revokeObjectURL(objectUrl);
        if (rawFiles.length === 1) {
          const safeDoc = new File(
            [primary],
            primary.name || 'corrupt-attachment.bin',
            { type: 'application/octet-stream' },
          );
          await sendMediaFiles(chat.chatId, [safeDoc], {
            caption: text.trim() || undefined,
            topicId: activeTopicId ?? undefined,
            replyToMsgId: replyTarget?.messageId,
          });
          pushToast('Invalid image format sent as file attachment', 'warning');
          onSentScrollToBottom?.();
          return;
        }
      }

      // Single non-image file (PDF, ZIP, video, audio, GIF)
      if (rawFiles.length === 1) {
        const single = rawFiles[0]!;
        await sendMediaFiles(chat.chatId, [single], {
          caption: text.trim() || undefined,
          topicId: activeTopicId ?? undefined,
          replyToMsgId: replyTarget?.messageId,
        });
        if (text.trim()) {
          setText('');
          void saveDraft(chat.chatId, '');
        }
        if (replyTarget) {
          setReplyTarget(chat.chatId, null);
        }
        onSentScrollToBottom?.();
        return;
      }

      // Multi-file non-image upload: split >10 items into max 10-item Album chunks
      const captionToUse = text.trim() || undefined;
      for (let offset = 0; offset < rawFiles.length; offset += 10) {
        const chunk = rawFiles.slice(offset, offset + 10);
        await sendMediaFiles(chat.chatId, chunk, {
          caption: offset === 0 ? captionToUse : undefined,
          topicId: activeTopicId ?? undefined,
          replyToMsgId: offset === 0 ? replyTarget?.messageId : undefined,
        });
      }

      if (captionToUse) {
        setText('');
        void saveDraft(chat.chatId, '');
      }
      if (replyTarget) {
        setReplyTarget(chat.chatId, null);
      }
      onSentScrollToBottom?.();
    },
    [
      activeTopicId,
      chat.chatId,
      onSentScrollToBottom,
      openMediaEditor,
      pushToast,
      replyTarget,
      saveDraft,
      sendMediaFiles,
      setReplyTarget,
      text,
    ],
  );

  useImperativeHandle(
    ref,
    () => ({
      handleIncomingFiles,
      focusInput: () => textareaRef.current?.focus(),
    }),
    [handleIncomingFiles],
  );

  // Autocomplete candidates for `/command` (including all 13 Coding Agent commands) and `@mention`
  const autocompleteCandidates = useMemo<AutocompleteCandidate[]>(() => {
    if (!text) return [];

    // Slash command at start of input
    if (text.startsWith('/') && !text.includes(' ') && !text.includes('\n')) {
      const q = text.toLowerCase();
      const merged = new Map<string, string>();
      if (botMeta?.coding_agent) {
        for (const cmdSpec of CODING_SLASH_COMMANDS) {
          const cmd = cmdSpec.command.startsWith('/') ? cmdSpec.command : `/${cmdSpec.command}`;
          merged.set(cmd, cmdSpec.description);
        }
      }
      for (const bCmd of botMeta?.commands ?? []) {
        const cmd = bCmd.command.startsWith('/') ? bCmd.command : `/${bCmd.command}`;
        if (!merged.has(cmd)) {
          merged.set(cmd, bCmd.description);
        }
      }
      for (const item of BUILTIN_SLASH_COMMANDS) {
        if (!merged.has(item.command)) {
          merged.set(item.command, item.description);
        }
      }
      for (const hc of hermesCommands) {
        const cmd = hc.name.startsWith('/') ? hc.name : `/${hc.name}`;
        if (!merged.has(cmd)) {
          merged.set(cmd, hc.description);
        }
      }
      return Array.from(merged.entries())
        .filter(([cmd]) => cmd.toLowerCase().startsWith(q))
        .slice(0, 14)
        .map(([cmd, desc]) => ({
          kind: 'command' as const,
          token: cmd,
          label: cmd,
          subtitle: desc,
        }));
    }

    // Trailing @mention token (real members, room bots, @everyone in groups — zero fake handles!)
    const mentionMatch = /(?:^|\s)@([a-zA-Z0-9_]{0,24})$/.exec(text);
    if (mentionMatch) {
      const query = (mentionMatch[1] ?? '').toLowerCase();
      const candidates = new Map<string, string>();
      if (chat.isGroup || chat.isSupergroup) {
        candidates.set('@everyone', '所有人 · Notify all members & room bots');
      }
      for (const b of bots) {
        if (b.username) {
          candidates.set(`@${b.username}`, `${b.display_name || b.username} · AI Bot`);
        }
      }
      for (const m of membersByChat[chat.chatId] ?? []) {
        const handle = m.username || m.first_name.replace(/\s+/g, '');
        if (handle && !candidates.has(`@${handle}`)) {
          candidates.set(`@${handle}`, `${m.first_name} ${m.last_name ?? ''}`.trim());
        }
      }
      for (const p of Object.values(peersById)) {
        const handle = p.username || p.firstName.replace(/\s+/g, '');
        if (handle && !candidates.has(`@${handle}`)) {
          candidates.set(`@${handle}`, `${p.firstName} ${p.lastName ?? ''}`.trim());
        }
      }

      return Array.from(candidates.entries())
        .filter(
          ([handle, name]) =>
            handle.slice(1).toLowerCase().startsWith(query) ||
            name.toLowerCase().includes(query),
        )
        .slice(0, 10)
        .map(([handle, name]) => ({
          kind: 'mention' as const,
          token: handle,
          label: handle,
          subtitle: name,
        }));
    }

    return [];
  }, [botMeta, bots, chat.chatId, chat.isGroup, chat.isSupergroup, hermesCommands, membersByChat, peersById, text]);

  const applyAutocomplete = (candidate: AutocompleteCandidate) => {
    let nextText = text;
    if (candidate.kind === 'command') {
      nextText = `${candidate.token} `;
    } else {
      nextText = text.replace(/(^|\s)@[a-zA-Z0-9_]{0,24}$/, `$1${candidate.token} `);
    }
    setText(nextText);
    if (!editingMsg) {
      void saveDraft(
        chat.chatId,
        nextText,
        replyTarget?.messageId,
        replyTarget?.quoteText,
      );
    }
    window.requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(nextText.length, nextText.length);
      }
    });
  };

  const wrapSelectionWithMarkdown = (prefix: string, suffix: string, placeholder = 'text') => {
    const el = textareaRef.current;
    const start = el ? el.selectionStart : text.length;
    const end = el ? el.selectionEnd : text.length;
    const selected = text.slice(start, end) || placeholder;
    const updated = `${text.slice(0, start)}${prefix}${selected}${suffix}${text.slice(end)}`;
    setText(updated);
    if (!editingMsg) {
      void saveDraft(chat.chatId, updated, replyTarget?.messageId, replyTarget?.quoteText);
    }
    window.requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        const selStart = start + prefix.length;
        textareaRef.current.setSelectionRange(selStart, selStart + selected.length);
      }
    });
  };

  const handleTextChange = (nextVal: string) => {
    setText(nextVal);
    setAcHighlightIdx(0);
    if (!editingMsg) {
      void saveDraft(
        chat.chatId,
        nextVal,
        replyTarget?.messageId,
        replyTarget?.quoteText,
      );
      const now = Date.now();
      if (nextVal.trim().length > 0 && now - lastTypingSentAtRef.current > 3500) {
        lastTypingSentAtRef.current = now;
        void sendTyping(chat.chatId, 'typing');
      }
    }
  };

  const handleSubmitSend = async (opts?: {
    silent?: boolean;
    scheduleAtMs?: number;
  }) => {
    if (isRecording) {
      await handleStopAndSendRecording();
      return;
    }

    const trimmed = text.trim();
    if (!trimmed) return;

    const currentEdit = editingMsg;
    const currentReply = replyTarget;

    setText('');
    setSendMenuPos(null);
    setComposerPopover(null);

    if (currentEdit) {
      setEditingMessage(chat.chatId, null);
      await editMessage(chat.chatId, currentEdit.id, trimmed);
      return;
    }

    void saveDraft(chat.chatId, '');
    if (currentReply) {
      setReplyTarget(chat.chatId, null);
    }

    const chunks = splitLongMessageIntoChunks(trimmed, 4096);
    for (let i = 0; i < chunks.length; i++) {
      await sendText(chat.chatId, chunks[i]!, {
        replyToMsgId: i === 0 ? currentReply?.messageId : undefined,
        quoteText: i === 0 ? currentReply?.quoteText : undefined,
        topicId: activeTopicId ?? undefined,
        silent: opts?.silent,
        scheduleAtMs: opts?.scheduleAtMs,
        ttlSeconds: chat.ttlSeconds,
      });
    }

    const isHermesChat =
      chat.title.toLowerCase().includes('hermes') ||
      chat.username?.toLowerCase().includes('hermes');
    if (isHermesChat) {
      if (trimmed.startsWith('/')) {
        void runSlashCommand(trimmed, chat.chatId).catch(() => undefined);
      } else {
        void streamPrompt({ prompt: trimmed, chatId: chat.chatId }).catch(
          () => undefined,
        );
      }
    }

    onSentScrollToBottom?.();
  };

  const handleStartRecording = async () => {
    if (isRecording) {
      await handleStopAndSendRecording();
      return;
    }

    try {
      setRecordingElapsedSec(0);
      if (recordMode === 'round_video') {
        const session = await startRoundVideoRecording();
        roundVideoSessionRef.current = session;
        setIsRecording(true);
        window.requestAnimationFrame(() => {
          if (roundPreviewVideoRef.current && session.previewStream) {
            roundPreviewVideoRef.current.srcObject = session.previewStream;
            void roundPreviewVideoRef.current.play().catch(() => undefined);
          }
        });
      } else {
        const session = await startVoiceRecording();
        voiceSessionRef.current = session;
        setIsRecording(true);
      }

      recordTimerRef.current = window.setInterval(() => {
        setRecordingElapsedSec((s) => s + 1);
      }, 1000);
    } catch (err) {
      pushToast(
        err instanceof Error ? err.message : 'Unable to start recorder',
        'error',
      );
    }
  };

  const handleStopAndSendRecording = async () => {
    if (recordTimerRef.current !== null) {
      window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    setIsRecording(false);

    try {
      if (roundVideoSessionRef.current) {
        const session = roundVideoSessionRef.current;
        roundVideoSessionRef.current = null;
        const result = await session.stop();
        await sendRoundVideoRecording(
          chat.chatId,
          result,
          activeTopicId ?? undefined,
        );
        onSentScrollToBottom?.();
        return;
      }

      if (voiceSessionRef.current) {
        const session = voiceSessionRef.current;
        voiceSessionRef.current = null;
        const result = await session.stop();
        await sendVoiceRecording(chat.chatId, result, activeTopicId ?? undefined);
        onSentScrollToBottom?.();
      }
    } catch (err) {
      pushToast(
        err instanceof Error ? err.message : 'Failed to save recording',
        'error',
      );
    }
  };

  const handleCancelRecording = async () => {
    if (recordTimerRef.current !== null) {
      window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    setIsRecording(false);
    await voiceSessionRef.current?.cancel();
    voiceSessionRef.current = null;
    await roundVideoSessionRef.current?.cancel();
    roundVideoSessionRef.current = null;
  };

  const handleAiAssist = async (
    mode: 'improve' | 'shorter' | 'formal' | 'translate_zh' | 'translate_en',
  ) => {
    setComposerPopover(null);
    const source = text.trim();
    if (!source || aiBusy) return;
    setAiBusy(true);
    try {
      const assisted = await runAiComposeAssist(source, mode);
      if (!assisted || assisted.trim().length === 0) {
        pushToast(
          'AI compose provider not configured or returned empty response · AI 润色服务未配置',
          'error',
          { scope: 'window', chatId: chat.chatId },
        );
        return;
      }
      setText(assisted);
      if (!editingMsg) {
        void saveDraft(
          chat.chatId,
          assisted,
          replyTarget?.messageId,
          replyTarget?.quoteText,
        );
      }
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : 'AI compose assist unavailable · 请先配置 AI 供应商';
      pushToast(msg, 'error', { scope: 'window', chatId: chat.chatId });
    } finally {
      setAiBusy(false);
    }
  };

  // Non-admin broadcast channel check
  const myUserId = currentUser?.userId ?? 1;
  const isPureBroadcastChannel =
    chat.isChannel && !chat.isGroup && !chat.isSupergroup;
  const isChannelAdmin =
    chat.creatorId === myUserId ||
    (membersByChat[chat.chatId] ?? []).some(
      (m) => m.user_id === myUserId && (m.role === 'owner' || m.role === 'admin'),
    );

  if (isPureBroadcastChannel && !isChannelAdmin) {
    return (
      <div
        data-testid="channel-readonly-bar"
        className="tg-composer-shell"
        style={{
          width: '100%',
          maxWidth: '780px',
          margin: '0 auto',
          padding: '0 12px 10px',
          boxSizing: 'border-box',
        }}
      >
        {/* Keep hidden file input mounted for DOM contract */}
        <input
          ref={fileInputRef}
          id={DOM_IDS.FILE_UPLOAD_INPUT}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            const list = Array.from(e.target.files ?? []);
            e.target.value = '';
            void handleIncomingFiles(list);
          }}
        />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '12px',
            padding: '10px 16px',
            borderRadius: '12px',
            backgroundColor: 'var(--tg-bg-surface, #17212B)',
            border: '1px solid var(--tg-border, #242F3D)',
          }}
        >
          <button
            type="button"
            data-testid="btn-channel-mute"
            onClick={() =>
              void updateChatSettings(chat.chatId, { isMuted: !chat.isMuted })
            }
            style={channelBottomBtnStyle}
          >
            {chat.isMuted ? '🔔 Unmute · 取消静音' : '🔕 Mute · 静音频道'}
          </button>
          <button
            type="button"
            data-testid="btn-channel-discuss"
            onClick={() => toggleRightSidebar(true, 'info')}
            style={channelBottomBtnStyle}
          >
            💬 Discuss · 讨论区
          </button>
        </div>
      </div>
    );
  }

  const availableStickers = stickerSets.flatMap((s) => s.stickers);
  const availableGifs = gifResults;

  return (
    <div
      className="tg-composer-shell"
      style={{
        position: 'relative',
        zIndex: 10,
        width: '100%',
        maxWidth: '780px',
        margin: '0 auto',
        padding: '0 12px 10px',
        boxSizing: 'border-box',
        flexShrink: 0,
      }}
    >
      {/* Always-mounted file input for E2E & attach menu */}
      <input
        ref={fileInputRef}
        id={DOM_IDS.FILE_UPLOAD_INPUT}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          void handleIncomingFiles(files);
        }}
      />

      {/* Upload Progress Indicator */}
      {uploadProgress !== null && (
        <div
          data-testid="upload-progress-bar"
          style={{
            marginBottom: '6px',
            padding: '4px 10px',
            borderRadius: '8px',
            backgroundColor: 'var(--tg-bg-surface, #17212B)',
            border: '1px solid var(--tg-border, #242F3D)',
            fontSize: '12px',
            color: '#7CC2FF',
          }}
        >
          Uploading media… {Math.round(uploadProgress)}%
        </div>
      )}

      {/* Reply / Partial Quote / Edit Context Banner */}
      {(editingMsg || replyTarget) && (
        <div
          id={DOM_IDS.COMPOSER_REPLY_EDIT_BANNER}
          data-testid="composer-reply-edit-banner"
          data-mode={editingMsg ? 'edit' : replyTarget?.quoteText ? 'quote' : 'reply'}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '10px',
            padding: '7px 12px',
            marginBottom: '6px',
            borderRadius: '10px',
            backgroundColor: 'var(--tg-bg-surface, #17212B)',
            border: '1px solid var(--tg-border, #242F3D)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              minWidth: 0,
              flex: '1 1 auto',
            }}
          >
            <div
              style={{
                width: '3px',
                height: '28px',
                borderRadius: '2px',
                backgroundColor: 'var(--tg-accent, #3390EC)',
                flexShrink: 0,
              }}
            />
            <div style={{ minWidth: 0, flex: '1 1 auto' }}>
              <div
                style={{
                  fontSize: '11.5px',
                  fontWeight: 700,
                  color: 'var(--tg-accent, #3390EC)',
                }}
              >
                {editingMsg
                  ? '✎ Edit Message · 编辑消息'
                  : replyTarget?.quoteText
                    ? `❝ Quote ${replyTarget.senderName || ''}`.trim()
                    : `↩ Reply to ${replyTarget?.senderName || 'Message'}`}
              </div>
              <div
                style={{
                  fontSize: '12.5px',
                  color: 'var(--tg-text-primary, #F5F5F5)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {editingMsg
                  ? editingMsg.text ?? extractPlainTextFromContent(editingMsg.content)
                  : replyTarget?.quoteText || replyTarget?.previewText}
              </div>
            </div>
          </div>

          <button
            type="button"
            data-testid="btn-cancel-reply-edit"
            aria-label="Cancel reply or edit"
            onClick={() => {
              if (editingMsg) {
                setEditingMessage(chat.chatId, null);
                setText(draftsByChat[chat.chatId]?.text ?? '');
              } else {
                setReplyTarget(chat.chatId, null);
              }
            }}
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--tg-text-secondary, #8FA2B7)',
              fontSize: '16px',
              cursor: 'pointer',
              padding: '2px 6px',
            }}
          >
            ×
          </button>
        </div>
      )}

      {/* Markdown Formatting Toolbar */}
      {formattingOpen && (
        <div
          role="toolbar"
          aria-label="Text formatting"
          data-testid="formatting-toolbar"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '4px',
            padding: '6px 10px',
            marginBottom: '6px',
            borderRadius: '10px',
            backgroundColor: 'var(--tg-bg-surface, #17212B)',
            border: '1px solid var(--tg-border, #242F3D)',
          }}
        >
          <button
            type="button"
            aria-label="Bold"
            onClick={() => wrapSelectionWithMarkdown('**', '**', 'bold')}
            style={fmtBtnStyle}
          >
            <strong>B</strong> Bold
          </button>
          <button
            type="button"
            aria-label="Italic"
            onClick={() => wrapSelectionWithMarkdown('*', '*', 'italic')}
            style={fmtBtnStyle}
          >
            <em>I</em> Italic
          </button>
          <button
            type="button"
            aria-label="Underline"
            onClick={() => wrapSelectionWithMarkdown('__', '__', 'underline')}
            style={fmtBtnStyle}
          >
            <u>U</u> Underline
          </button>
          <button
            type="button"
            aria-label="Strikethrough"
            onClick={() => wrapSelectionWithMarkdown('~~', '~~', 'strike')}
            style={fmtBtnStyle}
          >
            <s>S</s> Strike
          </button>
          <button
            type="button"
            aria-label="Monospace"
            onClick={() => wrapSelectionWithMarkdown('`', '`', 'code')}
            style={fmtBtnStyle}
          >
            {'</>'} Code
          </button>
          <button
            type="button"
            aria-label="Code Block"
            onClick={() => wrapSelectionWithMarkdown('```ts\n', '\n```', 'const x = 1;')}
            style={fmtBtnStyle}
          >
            {'{ }'} Pre
          </button>
          <button
            type="button"
            aria-label="Spoiler"
            onClick={() => wrapSelectionWithMarkdown('||', '||', 'spoiler')}
            style={fmtBtnStyle}
          >
            ▒▒ Spoiler
          </button>
          <button
            type="button"
            aria-label="Quote"
            onClick={() => wrapSelectionWithMarkdown('> ', '', 'quoted line')}
            style={fmtBtnStyle}
          >
            ❝ Quote
          </button>
          <button
            type="button"
            aria-label="Link"
            onClick={() =>
              wrapSelectionWithMarkdown('[', '](https://telegram.org)', 'link')
            }
            style={fmtBtnStyle}
          >
            🔗 Link
          </button>
        </div>
      )}

      {/* /Command & @Mention Autocomplete Listbox */}
      {autocompleteCandidates.length > 0 && (
        <div
          role="listbox"
          aria-label="Autocomplete suggestions"
          data-testid="composer-autocomplete"
          style={{
            position: 'absolute',
            left: '16px',
            right: '16px',
            bottom: 'calc(100% + 4px)',
            maxHeight: '220px',
            overflowY: 'auto',
            borderRadius: '12px',
            backgroundColor: 'var(--tg-bg-elevated)',
            border: '1px solid var(--tg-hairline-border)',
            boxShadow: 'inset 0 1px 0 var(--tg-specular-top), var(--tg-shadow-lg)',
            padding: '4px',
            zIndex: 35,
          }}
        >
          {autocompleteCandidates.map((cand, idx) => {
            const active = idx === acHighlightIdx;
            return (
              <button
                key={cand.token}
                type="button"
                role="option"
                aria-selected={active}
                data-autocomplete-token={cand.token}
                onMouseDown={(e) => {
                  e.preventDefault();
                }}
                onClick={() => applyAutocomplete(cand)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '10px',
                  padding: '7px 10px',
                  borderRadius: '8px',
                  border: 'none',
                  backgroundColor: active ? 'var(--tg-accent-soft)' : 'transparent',
                  color: 'var(--tg-text-primary)',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <strong style={{ fontSize: '13px', color: 'var(--tg-accent)' }}>
                  {cand.label}
                </strong>
                <span
                  style={{
                    fontSize: '12px',
                    color: 'var(--tg-text-secondary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {cand.subtitle}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* 3-Tab Emoji / Sticker / GIF Popover */}
      {composerPopover === 'emoji' && (
        <div
          id={DOM_IDS.EMOJI_STICKER_GIF_POPOVER}
          data-testid="emoji-sticker-gif-popover"
          role="dialog"
          aria-label="Emoji, Stickers, and GIFs"
          style={{
            position: 'absolute',
            left: '16px',
            bottom: 'calc(100% + 6px)',
            width: 'min(340px, calc(100vw - 32px))',
            height: '300px',
            borderRadius: '14px',
            backgroundColor: 'var(--tg-bg-elevated)',
            border: '1px solid var(--tg-hairline-border)',
            boxShadow: 'inset 0 1px 0 var(--tg-specular-top), var(--tg-shadow-lg)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            zIndex: 40,
          }}
        >
          <div
            role="tablist"
            style={{
              display: 'flex',
              borderBottom: '1px solid var(--tg-hairline-border)',
              padding: '4px',
              gap: '4px',
            }}
          >
            {(
              [
                { id: 'emoji', label: 'Emoji' },
                { id: 'stickers', label: 'Stickers' },
                { id: 'gifs', label: 'GIFs' },
              ] as const
            ).map((tb) => (
              <button
                key={tb.id}
                type="button"
                role="tab"
                aria-selected={pickerTab === tb.id}
                onClick={() => setPickerTab(tb.id)}
                style={{
                  flex: '1 1 0',
                  padding: '6px 8px',
                  borderRadius: '8px',
                  border: 'none',
                  backgroundColor:
                    pickerTab === tb.id ? 'var(--tg-accent-soft)' : 'transparent',
                  color:
                    pickerTab === tb.id
                      ? 'var(--tg-accent)'
                      : 'var(--tg-text-secondary)',
                  fontSize: '12.5px',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {tb.label}
              </button>
            ))}
          </div>

          <div style={{ flex: '1 1 auto', overflowY: 'auto', padding: '8px' }}>
            {pickerTab === 'emoji' && (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(8, 1fr)',
                  gap: '4px',
                }}
              >
                {POPULAR_EMOJIS.map((em) => (
                  <button
                    key={em}
                    type="button"
                    aria-label={`Insert ${em}`}
                    onClick={() => {
                      const el = textareaRef.current;
                      const pos = el ? el.selectionStart : text.length;
                      const next = `${text.slice(0, pos)}${em}${text.slice(pos)}`;
                      handleTextChange(next);
                    }}
                    style={{
                      height: '34px',
                      borderRadius: '6px',
                      border: 'none',
                      backgroundColor: 'transparent',
                      fontSize: '20px',
                      cursor: 'pointer',
                    }}
                  >
                    {em}
                  </button>
                ))}
              </div>
            )}

            {pickerTab === 'stickers' &&
              (availableStickers.length === 0 ? (
                <div
                  style={{
                    padding: '18px 8px',
                    textAlign: 'center',
                    fontSize: '12px',
                    color: 'var(--tg-text-secondary)',
                  }}
                >
                  暂无可用贴纸包 · No stickers available
                </div>
              ) : (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(4, 1fr)',
                    gap: '6px',
                  }}
                >
                  {availableStickers.map((stk) => (
                    <button
                      key={stk.id}
                      type="button"
                      data-sticker-id={stk.id}
                      aria-label={`Send sticker ${stk.emoji}`}
                      onClick={() => {
                        setComposerPopover(null);
                        void sendSticker(
                          chat.chatId,
                          stk,
                          activeTopicId ?? undefined,
                        ).then(() => onSentScrollToBottom?.());
                      }}
                      style={{
                        height: '68px',
                        borderRadius: '8px',
                        border: '1px solid var(--tg-border-subtle)',
                        backgroundColor: 'var(--tg-bg-input)',
                        fontSize: '36px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {stk.svg_data_url ? (
                        <img
                          src={stk.svg_data_url}
                          alt={stk.emoji}
                          style={{ width: '52px', height: '52px', objectFit: 'contain' }}
                        />
                      ) : (
                        stk.emoji
                      )}
                    </button>
                  ))}
                </div>
              ))}

            {pickerTab === 'gifs' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <input
                  type="search"
                  placeholder="Search GIFs…"
                  value={gifSearchQuery}
                  onChange={(e) => {
                    const q = e.target.value;
                    setGifSearchQuery(q);
                    void searchGifs(q);
                  }}
                  className="tg-input"
                  style={{ padding: '6px 10px', fontSize: '12.5px' }}
                />
                {availableGifs.length === 0 ? (
                  <div
                    style={{
                      padding: '18px 8px',
                      textAlign: 'center',
                      fontSize: '12px',
                      color: 'var(--tg-text-secondary)',
                    }}
                  >
                    暂无 GIF 搜索结果 · No GIFs found
                  </div>
                ) : (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(2, 1fr)',
                      gap: '6px',
                    }}
                  >
                    {availableGifs.map((gif) => (
                      <button
                        key={gif.id}
                        type="button"
                        data-gif-id={gif.id}
                        aria-label={`Send GIF ${gif.title}`}
                        onClick={() => {
                          setComposerPopover(null);
                          void sendGif(
                            chat.chatId,
                            gif,
                            activeTopicId ?? undefined,
                          ).then(() => onSentScrollToBottom?.());
                        }}
                        style={{
                          padding: 0,
                          height: '84px',
                          borderRadius: '8px',
                          overflow: 'hidden',
                          border: '1px solid var(--tg-hairline-border)',
                          backgroundColor: 'var(--tg-bg-input)',
                          cursor: 'pointer',
                        }}
                      >
                        <img
                          src={gif.preview_url || gif.url}
                          alt={gif.title}
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Attach Popover */}
      {composerPopover === 'attach' && (
        <div
          role="menu"
          aria-label="Attach media or card"
          data-testid="attach-menu"
          className="tg-context-menu"
          style={{
            position: 'absolute',
            left: '48px',
            bottom: 'calc(100% + 6px)',
            width: '220px',
          }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setComposerPopover(null);
              fileInputRef.current?.click();
            }}
            className="tg-context-menu-item"
          >
            🖼 Photo or Video · 照片或视频
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setComposerPopover(null);
              fileInputRef.current?.click();
            }}
            className="tg-context-menu-item"
          >
            📄 Document / File · 文件
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setComposerPopover(null);
              openModal('create_poll', { chatId: chat.chatId });
              onOpenLocalCreator?.('poll');
            }}
            className="tg-context-menu-item"
          >
            📊 Poll / Quiz · 投票测验
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setComposerPopover(null);
              openModal('create_todo', { chatId: chat.chatId });
              onOpenLocalCreator?.('todo');
            }}
            className="tg-context-menu-item"
          >
            ☑️ Todo Checklist · 待办清单
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setComposerPopover(null);
              openModal('create_invoice', { chatId: chat.chatId });
              onOpenLocalCreator?.('invoice');
            }}
            className="tg-context-menu-item"
          >
            💳 Invoice / Payment · 账单收款
          </button>
        </div>
      )}

      {/* AI Compose Assist Popover */}
      {composerPopover === 'ai' && (
        <div
          role="menu"
          aria-label="AI Compose Assist"
          data-testid="ai-compose-menu"
          className="tg-context-menu"
          style={{
            position: 'absolute',
            right: '56px',
            bottom: 'calc(100% + 6px)',
            width: '232px',
          }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => void handleAiAssist('improve')}
            className="tg-context-menu-item"
          >
            ✨ Polish &amp; Improve · 润色优化
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void handleAiAssist('shorter')}
            className="tg-context-menu-item"
          >
            ✂ Make Concise · 精简压缩
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void handleAiAssist('formal')}
            className="tg-context-menu-item"
          >
            🎩 Formal Tone · 正式语气
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void handleAiAssist('translate_zh')}
            className="tg-context-menu-item"
          >
            🀄 Translate to Chinese · 翻译中文
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void handleAiAssist('translate_en')}
            className="tg-context-menu-item"
          >
            🌐 Translate to English · 翻译英文
          </button>
        </div>
      )}

      {/* Composer Row: External Bot Controls (STRICTLY OUTSIDE #cmp-input-wrap, Trap #16) + Apple Glass Capsule */}
      <div className="tg-composer-row">
        {Boolean(chat.isBot || chat.kind === 'bot') && !isRecording && (
          <div className="tg-bot-external-controls" data-testid="bot-external-controls">
            <button
              id="composer-bot-menu-btn"
              data-testid="bot-menu-button"
              type="button"
              aria-label="Bot Menu"
              onClick={() => {
                if (botMeta?.has_main_app && botMeta.username && botMeta.main_app_short_name) {
                  setMiniAppModalOpen(true);
                  void launchMiniApp(
                    botMeta.username,
                    botMeta.main_app_short_name,
                    chat.chatId,
                  ).catch(() => {
                    openModal('miniapp_catalog', { chatId: chat.chatId });
                  });
                } else {
                  handleTextChange('/');
                  textareaRef.current?.focus();
                }
              }}
              className={`tg-bot-menu-btn ${text.length > 0 ? 'is-compact' : ''}`.trim()}
            >
              <span aria-hidden="true">☰</span>
              {text.length === 0 && (
                <span>
                  {botMeta?.has_main_app
                    ? botMeta.menu_button_text || 'Open App'
                    : 'Menu'}
                </span>
              )}
            </button>

            <button
              id="composer-bot-slash-btn"
              type="button"
              aria-label="Bot Slash Commands"
              title="Slash Commands (/)"
              onClick={() => {
                handleTextChange('/');
                textareaRef.current?.focus();
              }}
              className="tg-bot-slash-btn"
            >
              /
            </button>
          </div>
        )}

        {/* Main Apple Messages Glass Input Capsule (#cmp-input-wrap) */}
        <div id={DOM_IDS.CMP_INPUT_WRAP} className="tg-cmp-input-wrap">
          {isRecording ? (
            <div
              data-testid="composer-recording-bar"
              style={{
                flex: '1 1 auto',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '12px',
                minHeight: '38px',
                padding: '0 6px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span
                  style={{
                    width: '10px',
                    height: '10px',
                    borderRadius: '50%',
                    backgroundColor: 'var(--tg-danger)',
                    display: 'inline-block',
                  }}
                />
                <strong style={{ fontSize: '13.5px', color: 'var(--tg-text-primary)' }}>
                  {recordMode === 'round_video'
                    ? 'Recording Round Video'
                    : 'Recording Voice'}{' '}
                  · {formatDurationClock(recordingElapsedSec)}
                </strong>
                {recordMode === 'round_video' && (
                  <video
                    ref={roundPreviewVideoRef}
                    muted
                    playsInline
                    style={{
                      width: '36px',
                      height: '36px',
                      borderRadius: '50%',
                      objectFit: 'cover',
                      border: '1.5px solid var(--tg-accent)',
                    }}
                  />
                )}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <button
                  type="button"
                  data-testid="btn-cancel-recording"
                  aria-label="Cancel recording"
                  onClick={() => void handleCancelRecording()}
                  className="tg-btn tg-btn--danger-soft"
                  style={{ padding: '5px 12px', fontSize: '12.5px' }}
                >
                  🗑 Cancel · 取消
                </button>

                <button
                  id={DOM_IDS.BTN_SEND_MESSAGE}
                  type="button"
                  data-testid="btn-send-recording"
                  aria-label="Stop and send recording"
                  onClick={() => void handleStopAndSendRecording()}
                  className="tg-btn tg-btn--primary"
                  style={{ padding: '5px 14px', fontSize: '12.5px' }}
                >
                  ↑ Send · 发送
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                id={DOM_IDS.BTN_ATTACH_MENU}
                type="button"
                aria-label="Attach files or interactive cards"
                aria-expanded={composerPopover === 'attach'}
                onClick={() =>
                  setComposerPopover(
                    composerPopover === 'attach' ? null : 'attach',
                  )
                }
                style={composerIconBtnStyle(composerPopover === 'attach')}
              >
                📎
              </button>

              <button
                id={DOM_IDS.BTN_EMOJI_PICKER}
                type="button"
                aria-label="Emoji, Stickers, and GIFs"
                aria-expanded={composerPopover === 'emoji'}
                onClick={() =>
                  setComposerPopover(composerPopover === 'emoji' ? null : 'emoji')
                }
                style={composerIconBtnStyle(composerPopover === 'emoji')}
              >
                😊
              </button>

              <button
                id={DOM_IDS.BTN_FORMATTING_TOOLBAR}
                type="button"
                aria-label="Formatting toolbar"
                aria-pressed={formattingOpen}
                onClick={() => setFormattingOpen((v) => !v)}
                style={composerIconBtnStyle(formattingOpen)}
              >
                Aa
              </button>

              <textarea
                ref={textareaRef}
                id={DOM_IDS.MESSAGE_COMPOSER_INPUT}
                rows={1}
                dir="auto"
                placeholder={
                  chat.isSecret
                    ? 'Write an E2EE secret message…'
                    : 'Message · 输入消息…'
                }
                aria-label="Message input"
                value={text}
                onChange={(e) => handleTextChange(e.target.value)}
                onCompositionStart={(e) =>
                  imeFsmRef.current.onCompositionStart(e.data)
                }
                onCompositionUpdate={(e) =>
                  imeFsmRef.current.onCompositionUpdate(e.data)
                }
                onCompositionEnd={(e) => {
                  imeFsmRef.current.onCompositionEnd(e.data);
                  window.requestAnimationFrame(() => {
                    window.requestAnimationFrame(() => {
                      imeFsmRef.current.resetCommitFence();
                    });
                  });
                }}
                onBlur={() => imeFsmRef.current.onCompositionCancel()}
                onPaste={(e) => {
                  const pastedFiles = Array.from(e.clipboardData?.files ?? []);
                  if (pastedFiles.length > 0) {
                    e.preventDefault();
                    void handleIncomingFiles(pastedFiles);
                  }
                }}
                onKeyDown={(e) => {
                  const isMod = e.ctrlKey || e.metaKey;
                  const lowerKey = e.key.toLowerCase();

                  if (isMod && !e.altKey) {
                    if (!e.shiftKey && lowerKey === 'b') {
                      e.preventDefault();
                      wrapSelectionWithMarkdown('**', '**', 'bold');
                      return;
                    }
                    if (!e.shiftKey && lowerKey === 'i') {
                      e.preventDefault();
                      wrapSelectionWithMarkdown('*', '*', 'italic');
                      return;
                    }
                    if (!e.shiftKey && lowerKey === 'u') {
                      e.preventDefault();
                      wrapSelectionWithMarkdown('__', '__', 'underline');
                      return;
                    }
                    if (!e.shiftKey && lowerKey === 'k') {
                      e.preventDefault();
                      wrapSelectionWithMarkdown('[', '](https://example.com)', 'link');
                      return;
                    }
                    if (e.shiftKey && lowerKey === 'x') {
                      e.preventDefault();
                      wrapSelectionWithMarkdown('~~', '~~', 'strike');
                      return;
                    }
                    if (e.shiftKey && lowerKey === 'm') {
                      e.preventDefault();
                      wrapSelectionWithMarkdown('`', '`', 'code');
                      return;
                    }
                    if (e.shiftKey && lowerKey === 'p') {
                      e.preventDefault();
                      wrapSelectionWithMarkdown('||', '||', 'spoiler');
                      return;
                    }
                  }

                  if (autocompleteCandidates.length > 0) {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setAcHighlightIdx(
                        (i) => (i + 1) % autocompleteCandidates.length,
                      );
                      return;
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setAcHighlightIdx(
                        (i) =>
                          (i - 1 + autocompleteCandidates.length) %
                          autocompleteCandidates.length,
                      );
                      return;
                    }
                    if (e.key === 'Tab') {
                      e.preventDefault();
                      const chosen = autocompleteCandidates[acHighlightIdx];
                      if (chosen) applyAutocomplete(chosen);
                      return;
                    }
                  }

                  if (
                    e.key === 'ArrowUp' &&
                    text.length === 0 &&
                    !editingMsg &&
                    !e.shiftKey &&
                    !isMod
                  ) {
                    const history = messagesByChat[chat.chatId] ?? [];
                    for (let idx = history.length - 1; idx >= 0; idx--) {
                      const m = history[idx]!;
                      if (
                        (m.flags?.is_out || m.sender_id === myUserId) &&
                        m.content.type === 'Text'
                      ) {
                        e.preventDefault();
                        setEditingMessage(chat.chatId, m);
                        return;
                      }
                    }
                  }

                  if (e.key === 'Escape') {
                    if (composerPopover) {
                      e.preventDefault();
                      e.stopPropagation();
                      setComposerPopover(null);
                      return;
                    }
                    if (editingMsg) {
                      e.preventDefault();
                      e.stopPropagation();
                      setEditingMessage(chat.chatId, null);
                      setText(draftsByChat[chat.chatId]?.text ?? '');
                      return;
                    }
                    if (replyTarget) {
                      e.preventDefault();
                      e.stopPropagation();
                      setReplyTarget(chat.chatId, null);
                      return;
                    }
                  }

                  if (e.key === 'Enter') {
                    const rawKeyCode = e.nativeEvent.keyCode || e.keyCode;
                    if (e.nativeEvent.isComposing || rawKeyCode === 229) {
                      imeFsmRef.current.handleKeyDown(
                        {
                          key: e.key,
                          keyCode: rawKeyCode,
                          shiftKey: e.shiftKey,
                          ctrlKey: e.ctrlKey,
                          altKey: e.altKey,
                          metaKey: e.metaKey,
                          isComposing: e.nativeEvent.isComposing,
                        },
                        { text, sendByEnter },
                      );
                      return;
                    }

                    if (isMod && !imeFsmRef.current.isComposingOrCommitted()) {
                      e.preventDefault();
                      void handleSubmitSend();
                      return;
                    }

                    const action = imeFsmRef.current.handleKeyDown(
                      {
                        key: e.key,
                        keyCode: rawKeyCode,
                        shiftKey: e.shiftKey,
                        ctrlKey: e.ctrlKey,
                        altKey: e.altKey,
                        metaKey: e.metaKey,
                        isComposing: e.nativeEvent.isComposing,
                      },
                      { text, sendByEnter },
                    );

                    if (
                      action !== 'ImeCandidateChosen' &&
                      autocompleteCandidates.length > 0 &&
                      !e.shiftKey &&
                      !isMod
                    ) {
                      e.preventDefault();
                      const chosen = autocompleteCandidates[acHighlightIdx];
                      if (chosen) applyAutocomplete(chosen);
                      return;
                    }

                    if (action === 'SendMessage') {
                      e.preventDefault();
                      void handleSubmitSend();
                    }
                  }
                }}
              />

              <button
                id={DOM_IDS.BTN_AI_COMPOSE}
                type="button"
                aria-label="AI Compose Assist"
                aria-expanded={composerPopover === 'ai'}
                disabled={aiBusy}
                onClick={() =>
                  setComposerPopover(composerPopover === 'ai' ? null : 'ai')
                }
                style={composerIconBtnStyle(composerPopover === 'ai')}
              >
                {aiBusy ? '…' : '✨'}
              </button>

              <button
                type="button"
                data-testid="btn-toggle-record-mode"
                aria-label={
                  recordMode === 'voice'
                    ? 'Switch to round video note'
                    : 'Switch to voice note'
                }
                title={
                  recordMode === 'voice'
                    ? 'Mode: Voice (click for Round Video)'
                    : 'Mode: Round Video (click for Voice)'
                }
                onClick={() =>
                  setRecordMode((m) => (m === 'voice' ? 'round_video' : 'voice'))
                }
                style={composerIconBtnStyle(recordMode === 'round_video')}
              >
                {recordMode === 'voice' ? '🎙' : '🎥'}
              </button>

              <button
                id={DOM_IDS.BTN_RECORD_VOICE}
                type="button"
                aria-label={
                  recordMode === 'round_video'
                    ? 'Record round video message'
                    : 'Record voice message'
                }
                onClick={() => void handleStartRecording()}
                style={composerIconBtnStyle(false)}
              >
                {recordMode === 'round_video' ? '⏺' : '🎤'}
              </button>

              <button
                id={DOM_IDS.BTN_SEND_MESSAGE}
                type="button"
                aria-label={editingMsg ? 'Save edited message' : 'Send message'}
                disabled={text.trim().length === 0}
                onClick={() => void handleSubmitSend()}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  setSendMenuPos({
                    x: Math.max(8, rect.right - 220),
                    y: Math.max(8, rect.top - 96),
                  });
                }}
                className="tg-send-pill-btn"
                style={{
                  fontSize: '15px',
                  fontWeight: 700,
                }}
              >
                {editingMsg ? '✓' : '↑'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Right-Click Send Options Menu (Silent & Scheduled Send) */}
      {sendMenuPos && (
        <div
          role="menu"
          aria-label="Send options"
          data-testid="send-options-menu"
          className="tg-context-menu"
          onClick={(e) => e.stopPropagation()}
          style={{
            left: `${sendMenuPos.x}px`,
            top: `${sendMenuPos.y}px`,
            width: '220px',
          }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => void handleSubmitSend({ silent: true })}
            className="tg-context-menu-item"
          >
            🔕 Send Without Sound · 静音发送
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setSendMenuPos(null);
              setScheduleDatetime(defaultFutureDatetimeLocal());
              setScheduleError(null);
              setScheduleDialogOpen(true);
            }}
            className="tg-context-menu-item"
          >
            📅 Schedule Message · 定时发送
          </button>
        </div>
      )}

      {/* Schedule Message Datetime Picker Dialog */}
      {scheduleDialogOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Schedule Message"
          data-testid="schedule-dialog"
          className="tg-modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setScheduleDialogOpen(false);
          }}
        >
          <div className="tg-modal-card" style={{ width: 'min(360px, 92vw)', padding: '18px', gap: '12px' }}>
            <strong>Schedule Message · 定时发送</strong>
            <input
              type="datetime-local"
              aria-label="Scheduled date and time"
              value={scheduleDatetime}
              onChange={(e) => {
                setScheduleDatetime(e.target.value);
                setScheduleError(null);
              }}
              className="tg-input"
            />
            {scheduleError && (
              <div
                role="alert"
                style={{ fontSize: '12px', color: 'var(--tg-danger)', fontWeight: 600 }}
              >
                {scheduleError}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button
                type="button"
                onClick={() => setScheduleDialogOpen(false)}
                className="tg-btn tg-btn--secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const targetMs = Date.parse(scheduleDatetime);
                  if (!Number.isFinite(targetMs) || targetMs <= Date.now() + 5_000) {
                    setScheduleError(
                      'Please choose a future date and time · 请选择未来的时间',
                    );
                    return;
                  }
                  setScheduleDialogOpen(false);
                  void handleSubmitSend({ scheduleAtMs: targetMs });
                }}
                className="tg-btn tg-btn--primary"
              >
                Schedule · 确认定时
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

const composerIconBtnStyle = (active: boolean): React.CSSProperties => ({
  width: '32px',
  height: '34px',
  borderRadius: '50%',
  border: 'none',
  backgroundColor: active ? 'var(--tg-accent-soft)' : 'transparent',
  color: active ? 'var(--tg-accent)' : 'var(--tg-text-secondary)',
  fontSize: '15px',
  fontWeight: 600,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  flexShrink: 0,
  marginBottom: '1px',
});

const fmtBtnStyle: React.CSSProperties = {
  padding: '4px 9px',
  borderRadius: '6px',
  border: '1px solid var(--tg-hairline-border)',
  backgroundColor: 'var(--tg-bg-input)',
  color: 'var(--tg-text-primary)',
  fontSize: '12px',
  cursor: 'pointer',
};

const channelBottomBtnStyle: React.CSSProperties = {
  padding: '7px 16px',
  borderRadius: '8px',
  border: '1px solid var(--tg-hairline-border)',
  backgroundColor: 'var(--tg-accent-soft)',
  color: 'var(--tg-accent)',
  fontSize: '13px',
  fontWeight: 600,
  cursor: 'pointer',
};

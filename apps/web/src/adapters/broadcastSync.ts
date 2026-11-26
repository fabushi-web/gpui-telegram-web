import type {
  ChatSummary,
  DraftState,
  MessageItem,
  PtsUpdate,
  ReactionCount,
  UpdateEvent,
} from '@gpui-telegram/protocol';
import type { LocaleCode } from '../i18n';

export const BROADCAST_SYNC_CHANNEL_NAME = 'gpui-telegram-web-sync';

export type SyncThemeName = 'night' | 'tinted' | 'day' | 'classic' | 'system';

export type BroadcastSyncPayload =
  | {
      kind: 'message_upsert';
      accountId: string;
      chatId: number;
      message: MessageItem;
      pts?: number;
    }
  | {
      kind: 'messages_deleted';
      accountId: string;
      chatId: number;
      messageIds: number[];
      pts?: number;
    }
  | {
      kind: 'reaction_updated';
      accountId: string;
      chatId: number;
      messageId: number;
      reactions: ReactionCount[];
      pts?: number;
    }
  | {
      kind: 'chat_updated';
      accountId: string;
      chat: ChatSummary;
    }
  | {
      kind: 'chat_deleted';
      accountId: string;
      chatId: number;
    }
  | {
      kind: 'read_history';
      accountId: string;
      chatId: number;
      maxId: number;
      unreadCount: number;
    }
  | {
      kind: 'draft_updated';
      accountId: string;
      chatId: number;
      draft: DraftState | null;
    }
  | {
      kind: 'settings_updated';
      patch: {
        theme?: SyncThemeName;
        accentColor?: string;
        fontSize?: number;
        bubbleRadius?: number;
        uiScale?: number;
        language?: LocaleCode;
        sendByEnter?: boolean;
      };
    }
  | {
      kind: 'auth_switched';
      activeAccountId: string | null;
    }
  | {
      kind: 'passcode_lock';
      isLocked: boolean;
    }
  | {
      kind: 'protocol_update';
      accountId: string;
      event: UpdateEvent;
      ptsUpdate?: PtsUpdate;
    };

export interface BroadcastSyncEnvelope {
  channel: typeof BROADCAST_SYNC_CHANNEL_NAME;
  senderTabId: string;
  sentAtMs: number;
  payload: BroadcastSyncPayload;
}

type BroadcastListener = (payload: BroadcastSyncPayload, envelope: BroadcastSyncEnvelope) => void;

class BroadcastSyncBus {
  public readonly tabId: string;
  private channel: BroadcastChannel | null = null;
  private listeners = new Set<BroadcastListener>();

  constructor() {
    this.tabId = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    this.ensureChannel();
  }

  private ensureChannel(): BroadcastChannel | null {
    if (this.channel) return this.channel;
    if (typeof BroadcastChannel === 'undefined') return null;

    try {
      const bc = new BroadcastChannel(BROADCAST_SYNC_CHANNEL_NAME);
      bc.onmessage = (event: MessageEvent) => {
        const data = event.data as BroadcastSyncEnvelope | null;
        if (!data || data.channel !== BROADCAST_SYNC_CHANNEL_NAME || !data.payload) {
          return;
        }
        if (data.senderTabId === this.tabId) {
          return;
        }
        for (const listener of this.listeners) {
          try {
            listener(data.payload, data);
          } catch {
            // Ignore subscriber errors
          }
        }
      };
      this.channel = bc;
      return bc;
    } catch {
      return null;
    }
  }

  public publish(payload: BroadcastSyncPayload): void {
    const bc = this.ensureChannel();
    if (!bc) return;

    const envelope: BroadcastSyncEnvelope = {
      channel: BROADCAST_SYNC_CHANNEL_NAME,
      senderTabId: this.tabId,
      sentAtMs: Date.now(),
      payload,
    };

    try {
      bc.postMessage(envelope);
    } catch {
      this.channel = null;
      try {
        this.ensureChannel()?.postMessage(envelope);
      } catch {
        // Ignore
      }
    }
  }

  public subscribe(listener: BroadcastListener): () => void {
    this.ensureChannel();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const broadcastSync = new BroadcastSyncBus();
export { BroadcastSyncBus };

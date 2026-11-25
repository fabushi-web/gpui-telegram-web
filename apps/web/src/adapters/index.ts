import type {
  AdapterMode,
  BrowserControlClientPort,
  MessageItem,
  TelegramClientPort,
  UserProfile,
} from '@gpui-telegram/protocol';
import { HttpWsServerAdapter } from './httpWsServerAdapter';

export * from './indexedDbCache';
export * from './broadcastSync';
export * from './httpWsServerAdapter';

export type ExtendedTelegramAdapter = TelegramClientPort &
  BrowserControlClientPort & {
    getDiscoveredPeers(): UserProfile[];
    sendCallbackQuery?: (
      chatId: number,
      messageId: number,
      data: string,
    ) => Promise<{ answerText?: string; message?: MessageItem }>;
    clearChatHistory?: (chatId: number, forEveryone?: boolean) => Promise<void>;
  };

const sharedServerAdapter = new HttpWsServerAdapter();

export function getServerAdapter(): HttpWsServerAdapter {
  return sharedServerAdapter;
}

export function getClientAdapter(_mode?: AdapterMode): ExtendedTelegramAdapter {
  return sharedServerAdapter;
}

export async function switchClientAdapterMode(
  _nextMode: AdapterMode,
  options?: {
    serverUrl?: string;
    token?: string | null;
    accountId?: string;
    userId?: number | string;
  },
): Promise<ExtendedTelegramAdapter> {
  if (options) {
    sharedServerAdapter.configure({
      serverUrl: options.serverUrl,
      token: options.token,
      accountId: options.accountId,
      userId: options.userId !== undefined ? Number(options.userId) : undefined,
    });
  }
  return sharedServerAdapter;
}

export function getActiveAdapterMode(): AdapterMode {
  return 'server';
}

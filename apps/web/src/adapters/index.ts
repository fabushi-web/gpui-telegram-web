import type {
  AdapterMode,
  BrowserControlClientPort,
  MessageItem,
  TelegramClientPort,
  UserProfile,
} from '@gpui-telegram/protocol';
import { HttpWsServerAdapter } from './httpWsServerAdapter';
import { LocalSandboxAdapter } from './localSandboxAdapter';
import { MtprotoAdapter } from './mtprotoAdapter';

export * from './indexedDbCache';
export * from './broadcastSync';
export * from './httpWsServerAdapter';
export * from './localSandboxAdapter';
export * from './mtprotoAdapter';

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
const sharedSandboxAdapter = new LocalSandboxAdapter();
const sharedMtprotoAdapter = new MtprotoAdapter(sharedServerAdapter, sharedSandboxAdapter);

let activeAdapterMode: AdapterMode = 'server';

export function getServerAdapter(): HttpWsServerAdapter {
  return sharedServerAdapter;
}

export function getSandboxAdapter(): LocalSandboxAdapter {
  return sharedSandboxAdapter;
}

export function getMtprotoAdapter(): MtprotoAdapter {
  return sharedMtprotoAdapter;
}

export function getClientAdapter(mode: AdapterMode = activeAdapterMode): ExtendedTelegramAdapter {
  switch (mode) {
    case 'sandbox':
      return sharedSandboxAdapter;
    case 'mtproto':
      return sharedMtprotoAdapter;
    case 'server':
    default:
      return sharedServerAdapter;
  }
}

export async function switchClientAdapterMode(
  nextMode: AdapterMode,
  options?: {
    serverUrl?: string;
    token?: string | null;
    accountId?: string;
    userId?: number | string;
  },
): Promise<ExtendedTelegramAdapter> {
  if (nextMode !== activeAdapterMode) {
    await getClientAdapter(activeAdapterMode).disconnect().catch(() => undefined);
    activeAdapterMode = nextMode;
  }

  if (options) {
    sharedServerAdapter.configure({
      serverUrl: options.serverUrl,
      token: options.token,
      accountId: options.accountId,
      userId: options.userId !== undefined ? Number(options.userId) : undefined,
    });
  }

  return getClientAdapter(activeAdapterMode);
}

export function getActiveAdapterMode(): AdapterMode {
  return activeAdapterMode;
}

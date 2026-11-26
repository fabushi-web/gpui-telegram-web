import type {
  ChatSummary,
  DraftState,
  MessageItem,
  SendMessagePortInput,
} from '@gpui-telegram/protocol';

export interface PendingOutboxItem {
  clientNonce: number;
  chatId: number;
  req: SendMessagePortInput;
  optimisticMessageId: number;
  createdAtMs: number;
}

export interface PersistedOutboxRecord extends PendingOutboxItem {
  accountId: string;
}

export const IDB_NAME = 'gpui_telegram_idb_v1';
export const IDB_VERSION = 2;

const STORE_CHATS = 'chats';
const STORE_MESSAGES = 'messages';
const STORE_PTS = 'pts_cursors';
const STORE_OUTBOX = 'outbox';
const STORE_DRAFTS = 'drafts';
const STORE_E2EE = 'e2ee_keys';
const STORE_CLOUD = 'cloud_storage';
const STORE_CREATIONS = 'creations';
const STORE_COMMUNITY_CACHE = 'community_cache';
const STORE_KV = 'kv';

export const ALL_STORES = [
  STORE_CHATS,
  STORE_MESSAGES,
  STORE_PTS,
  STORE_OUTBOX,
  STORE_DRAFTS,
  STORE_E2EE,
  STORE_CLOUD,
  STORE_CREATIONS,
  STORE_COMMUNITY_CACHE,
  STORE_KV,
] as const;

export type StoreName = (typeof ALL_STORES)[number];

class IndexedDbCacheService {
  private dbPromise: Promise<IDBDatabase | null> | null = null;
  private memoryFallback = new Map<string, unknown>();

  private openDb(): Promise<IDBDatabase | null> {
    if (this.dbPromise) return this.dbPromise;

    if (typeof indexedDB === 'undefined') {
      this.dbPromise = Promise.resolve(null);
      return this.dbPromise;
    }

    this.dbPromise = new Promise<IDBDatabase | null>((resolve) => {
      try {
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          for (const name of ALL_STORES) {
            if (!db.objectStoreNames.contains(name)) {
              db.createObjectStore(name);
            }
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });

    return this.dbPromise;
  }

  private memKey(store: StoreName, key: string): string {
    return `${store}::${key}`;
  }

  public async get<T>(store: StoreName, key: string): Promise<T | undefined> {
    const db = await this.openDb();
    if (!db) {
      return this.memoryFallback.get(this.memKey(store, key)) as T | undefined;
    }

    return new Promise<T | undefined>((resolve) => {
      try {
        const tx = db.transaction(store, 'readonly');
        const os = tx.objectStore(store);
        const req = os.get(key);
        req.onsuccess = () => resolve(req.result as T | undefined);
        req.onerror = () =>
          resolve(this.memoryFallback.get(this.memKey(store, key)) as T | undefined);
      } catch {
        resolve(this.memoryFallback.get(this.memKey(store, key)) as T | undefined);
      }
    });
  }

  public async set<T>(store: StoreName, key: string, value: T): Promise<void> {
    this.memoryFallback.set(this.memKey(store, key), value);
    const db = await this.openDb();
    if (!db) return;

    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  public async delete(store: StoreName, key: string): Promise<void> {
    this.memoryFallback.delete(this.memKey(store, key));
    const db = await this.openDb();
    if (!db) return;

    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  public async getAllByPrefix<T>(
    store: StoreName,
    prefix: string,
  ): Promise<Array<{ key: string; value: T }>> {
    const db = await this.openDb();
    if (!db) {
      const results: Array<{ key: string; value: T }> = [];
      const fullPrefix = `${store}::${prefix}`;
      for (const [k, v] of this.memoryFallback.entries()) {
        if (k.startsWith(fullPrefix)) {
          results.push({
            key: k.slice(`${store}::`.length),
            value: v as T,
          });
        }
      }
      return results;
    }

    return new Promise<Array<{ key: string; value: T }>>((resolve) => {
      try {
        const results: Array<{ key: string; value: T }> = [];
        const tx = db.transaction(store, 'readonly');
        const os = tx.objectStore(store);
        const cursorReq = os.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) {
            resolve(results);
            return;
          }
          const k = String(cursor.key);
          if (k.startsWith(prefix)) {
            results.push({ key: k, value: cursor.value as T });
          }
          cursor.continue();
        };
        cursorReq.onerror = () => resolve(results);
      } catch {
        resolve([]);
      }
    });
  }

  // Domain-Specific Convenience Helpers

  public async saveChats(accountId: string, chats: readonly ChatSummary[]): Promise<void> {
    await this.set(STORE_CHATS, `list:${accountId}`, [...chats]);
  }

  public async loadChats(accountId: string): Promise<ChatSummary[]> {
    return (await this.get<ChatSummary[]>(STORE_CHATS, `list:${accountId}`)) ?? [];
  }

  public async saveChatMessages(
    accountId: string,
    chatId: number | string,
    messages: readonly MessageItem[],
  ): Promise<void> {
    const trimmed = messages.length > 400 ? messages.slice(-400) : [...messages];
    await this.set(STORE_MESSAGES, `${accountId}:${chatId}`, trimmed);
  }

  public async loadChatMessages(
    accountId: string,
    chatId: number | string,
  ): Promise<MessageItem[]> {
    return (await this.get<MessageItem[]>(STORE_MESSAGES, `${accountId}:${chatId}`)) ?? [];
  }

  public async getPtsCursor(accountId: string, scope = 'global'): Promise<number> {
    return (await this.get<number>(STORE_PTS, `${accountId}:${scope}`)) ?? 0;
  }

  public async setPtsCursor(accountId: string, pts: number, scope = 'global'): Promise<void> {
    const prev = await this.getPtsCursor(accountId, scope);
    if (pts >= prev) {
      await this.set(STORE_PTS, `${accountId}:${scope}`, pts);
    }
  }

  public async enqueueOutbox(item: PersistedOutboxRecord): Promise<void> {
    await this.set(STORE_OUTBOX, `${item.accountId}:${item.clientNonce}`, item);
  }

  public async removeOutbox(accountId: string, clientNonce: number | string): Promise<void> {
    await this.delete(STORE_OUTBOX, `${accountId}:${clientNonce}`);
  }

  public async listOutbox(accountId: string): Promise<PersistedOutboxRecord[]> {
    const rows = await this.getAllByPrefix<PersistedOutboxRecord>(
      STORE_OUTBOX,
      `${accountId}:`,
    );
    return rows
      .map((r) => r.value)
      .sort((a, b) => a.createdAtMs - b.createdAtMs);
  }

  public async saveDraft(
    accountId: string,
    chatId: number | string,
    draft: DraftState | null,
  ): Promise<void> {
    if (!draft || (!draft.text.trim() && !draft.replyToMsgId)) {
      await this.delete(STORE_DRAFTS, `${accountId}:${chatId}`);
      return;
    }
    await this.set(STORE_DRAFTS, `${accountId}:${chatId}`, draft);
  }

  public async loadDrafts(accountId: string): Promise<Record<number, DraftState>> {
    const rows = await this.getAllByPrefix<DraftState>(STORE_DRAFTS, `${accountId}:`);
    const map: Record<number, DraftState> = {};
    for (const r of rows) {
      const chatIdNum = Number(r.key.slice(`${accountId}:`.length));
      if (Number.isFinite(chatIdNum)) {
        map[chatIdNum] = r.value;
      }
    }
    return map;
  }

  public async getCloudStorageItems(
    accountId: string,
    botUsername: string,
    shortName: string,
    keys?: string[],
  ): Promise<Record<string, string>> {
    const scopeKey = `${accountId}:${botUsername.toLowerCase()}:${shortName.toLowerCase()}`;
    const bag = (await this.get<Record<string, string>>(STORE_CLOUD, scopeKey)) ?? {};
    if (!keys || keys.length === 0) {
      return { ...bag };
    }
    const filtered: Record<string, string> = {};
    for (const k of keys) {
      if (k in bag) filtered[k] = bag[k];
    }
    return filtered;
  }

  public async setCloudStorageItem(
    accountId: string,
    botUsername: string,
    shortName: string,
    key: string,
    value: string,
  ): Promise<void> {
    const scopeKey = `${accountId}:${botUsername.toLowerCase()}:${shortName.toLowerCase()}`;
    const bag = (await this.get<Record<string, string>>(STORE_CLOUD, scopeKey)) ?? {};
    bag[key] = value;
    await this.set(STORE_CLOUD, scopeKey, bag);
  }

  public async deleteCloudStorageItems(
    accountId: string,
    botUsername: string,
    shortName: string,
    keys: string[],
  ): Promise<void> {
    const scopeKey = `${accountId}:${botUsername.toLowerCase()}:${shortName.toLowerCase()}`;
    const bag = (await this.get<Record<string, string>>(STORE_CLOUD, scopeKey)) ?? {};
    for (const k of keys) {
      delete bag[k];
    }
    await this.set(STORE_CLOUD, scopeKey, bag);
  }

  public async deleteByPrefix(store: StoreName, prefix: string): Promise<void> {
    const fullPrefix = `${store}::${prefix}`;
    for (const k of Array.from(this.memoryFallback.keys())) {
      if (k.startsWith(fullPrefix)) {
        this.memoryFallback.delete(k);
      }
    }
    const db = await this.openDb();
    if (!db) return;

    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(store, 'readwrite');
        const os = tx.objectStore(store);
        const cursorReq = os.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          if (String(cursor.key).startsWith(prefix)) {
            cursor.delete();
          }
          cursor.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  public async saveCreations<T>(accountId: string, scope: string, value: T): Promise<void> {
    await this.set(STORE_CREATIONS, `${accountId}:${scope}`, value);
  }

  public async loadCreations<T>(accountId: string, scope: string): Promise<T | undefined> {
    return this.get<T>(STORE_CREATIONS, `${accountId}:${scope}`);
  }

  public async saveCommunityCache<T>(accountId: string, scope: string, value: T): Promise<void> {
    await this.set(STORE_COMMUNITY_CACHE, `${accountId}:${scope}`, value);
  }

  public async loadCommunityCache<T>(accountId: string, scope: string): Promise<T | undefined> {
    return this.get<T>(STORE_COMMUNITY_CACHE, `${accountId}:${scope}`);
  }

  public async getKv<T>(key: string): Promise<T | undefined> {
    return this.get<T>(STORE_KV, key);
  }

  public async setKv<T>(key: string, value: T): Promise<void> {
    await this.set(STORE_KV, key, value);
  }

  public async clearAccountData(accountId: string): Promise<void> {
    if (!accountId) return;
    const prefix = `${accountId}:`;
    await Promise.all([
      this.delete(STORE_CHATS, `list:${accountId}`),
      this.deleteByPrefix(STORE_MESSAGES, prefix),
      this.deleteByPrefix(STORE_PTS, prefix),
      this.deleteByPrefix(STORE_OUTBOX, prefix),
      this.deleteByPrefix(STORE_DRAFTS, prefix),
      this.deleteByPrefix(STORE_E2EE, prefix),
      this.deleteByPrefix(STORE_CLOUD, prefix),
      this.deleteByPrefix(STORE_CREATIONS, prefix),
      this.deleteByPrefix(STORE_COMMUNITY_CACHE, prefix),
      this.deleteByPrefix(STORE_KV, prefix),
    ]);
  }

  public async clearAll(): Promise<void> {
    this.memoryFallback.clear();
    const db = await this.openDb();
    if (!db) return;
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(ALL_STORES as unknown as string[], 'readwrite');
        for (const name of ALL_STORES) {
          tx.objectStore(name).clear();
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }
}

export const indexedDbCache = new IndexedDbCacheService();
export { IndexedDbCacheService };

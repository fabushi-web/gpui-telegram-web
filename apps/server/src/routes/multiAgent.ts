import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  BOTFATHER_USER_ID,
  type BotRegistryEntry,
} from '@gpui-telegram/protocol';
import type { ServerConfig } from '../config.js';
import {
  createMessageAtomic,
  ensureChatReadAccess,
  ensureChatWriteAccess,
  parseOptionalNonNegativeInt,
} from '../db/queries.js';

function parsePositiveChatId(raw: unknown): number | undefined {
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const n = Number(raw.trim());
    return Number.isSafeInteger(n) && n >= 1 ? n : undefined;
  }
  return undefined;
}
import {
  ApiError,
  readJsonBody,
  requireAuth,
  sendJson,
  type HttpRouter,
} from '../utils/http.js';
import type { RealtimeGatewayHub } from '../ws/hub.js';
import { getHermesMemoryState } from './hermes.js';
import { runConfiguredLlmCompletion, type LlmChatMessage } from './magpie.js';

// ============================================================================
// 1. FloorControlQueue — Priority, 30s Lease, Nonce-Fenced, Starvation Protection
// ============================================================================

export enum FloorPriority {
  UserInterruption = 0,
  DirectMention = 1,
  TaskAssignee = 2,
  GeneralContribution = 3,
}

export interface FloorTurnGrant {
  agent_id: string;
  nonce: string;
  acquired_at_ms: number;
  stale_after_ms: number;
  is_winding_down: boolean;
}

interface FloorWaiter {
  agentId: string;
  priority: FloorPriority;
  seq: number;
  promotions: number;
  isWindingDown: boolean;
  resolve: (grant: FloorTurnGrant | null) => void;
  timer?: NodeJS.Timeout;
}

export class FloorControlQueue {
  private active: FloorTurnGrant | null = null;
  private readonly waiters: FloorWaiter[] = [];
  private readonly cancelledNonces = new Set<string>();
  private seqCounter = 0;

  constructor(private readonly leaseMs = 30_000) {}

  private expireIfStale(now = Date.now()): void {
    if (this.active && now - this.active.acquired_at_ms >= this.active.stale_after_ms) {
      this.cancelledNonces.add(this.active.nonce);
      this.active = null;
    }
  }

  private promoteNext(now = Date.now()): void {
    this.expireIfStale(now);
    if (this.active || this.waiters.length === 0) return;

    this.waiters.sort((a, b) => {
      const effA = a.promotions >= 8 ? Math.min(a.priority, FloorPriority.DirectMention) : a.priority;
      const effB = b.promotions >= 8 ? Math.min(b.priority, FloorPriority.DirectMention) : b.priority;
      if (effA !== effB) return effA - effB;
      return a.seq - b.seq;
    });

    const chosen = this.waiters.shift()!;
    if (chosen.timer) clearTimeout(chosen.timer);

    // Increment promotions for remaining waiters that were bypassed
    for (const w of this.waiters) {
      w.promotions += 1;
    }

    this.seqCounter += 1;
    const grant: FloorTurnGrant = {
      agent_id: chosen.agentId,
      nonce: `trn_${this.seqCounter}_${crypto.randomBytes(6).toString('hex')}`,
      acquired_at_ms: now,
      stale_after_ms: this.leaseMs,
      is_winding_down: chosen.isWindingDown,
    };
    this.active = grant;
    chosen.resolve(grant);
  }

  acquireFloorWait(
    agentId: string,
    priority: FloorPriority,
    timeoutMs = 15_000,
    isWindingDown = false,
  ): Promise<FloorTurnGrant | null> {
    const now = Date.now();
    this.expireIfStale(now);

    if (!this.active && this.waiters.length === 0) {
      this.seqCounter += 1;
      const grant: FloorTurnGrant = {
        agent_id: agentId,
        nonce: `trn_${this.seqCounter}_${crypto.randomBytes(6).toString('hex')}`,
        acquired_at_ms: now,
        stale_after_ms: this.leaseMs,
        is_winding_down: isWindingDown,
      };
      this.active = grant;
      return Promise.resolve(grant);
    }

    return new Promise<FloorTurnGrant | null>((resolve) => {
      this.seqCounter += 1;
      const waiter: FloorWaiter = {
        agentId,
        priority,
        seq: this.seqCounter,
        promotions: 0,
        isWindingDown,
        resolve,
      };
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) {
            this.waiters.splice(idx, 1);
            resolve(null);
          }
        }, timeoutMs);
        waiter.timer.unref();
      }
      this.waiters.push(waiter);
      this.promoteNext(now);
    });
  }

  preemptForHuman(_humanLabel: string): void {
    if (this.active) {
      this.cancelledNonces.add(this.active.nonce);
      this.active = null;
    }
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      if (w.timer) clearTimeout(w.timer);
      w.resolve(null);
    }
  }

  validateDelivery(agentId: string, nonce: string, now = Date.now()): 'accepted' | 'unknown_nonce' | 'expired' {
    if (this.cancelledNonces.has(nonce)) {
      return 'expired';
    }
    if (!this.active || this.active.nonce !== nonce || this.active.agent_id !== agentId) {
      return 'unknown_nonce';
    }
    if (now - this.active.acquired_at_ms >= this.active.stale_after_ms) {
      this.cancelledNonces.add(this.active.nonce);
      this.active = null;
      this.promoteNext(now);
      return 'expired';
    }
    return 'accepted';
  }

  releaseTurn(agentId: string, nonce: string): FloorTurnGrant | null {
    if (this.active && this.active.agent_id === agentId && this.active.nonce === nonce) {
      this.active = null;
      this.promoteNext();
    }
    return this.active;
  }

  getSnapshot(now = Date.now()): { current_speaker: string | null; queued_count: number } {
    this.expireIfStale(now);
    return {
      current_speaker: this.active?.agent_id ?? null,
      queued_count: this.waiters.length,
    };
  }

  clear(): void {
    this.preemptForHuman('reset');
    this.cancelledNonces.clear();
  }
}

// ============================================================================
// 2. LoopBudget — Strictly Bounds Bot-to-Bot Hops <= 5
// ============================================================================

export const DEFAULT_MAX_LOOP_HOPS = 5;

export class LoopBudgetExceededError extends Error {
  constructor(public readonly maxHops: number, public readonly currentHop: number) {
    super(`Multi-agent loop budget exceeded (${currentHop}/${maxHops} hops)`);
    this.name = 'LoopBudgetExceededError';
  }
}

export class LoopBudget {
  private currentHop = 0;
  private causalTrace: string[] = [];

  constructor(public readonly maxHops = DEFAULT_MAX_LOOP_HOPS) {}

  reset(): void {
    this.currentHop = 0;
    this.causalTrace = [];
  }

  get hop(): number {
    return this.currentHop;
  }

  get remaining(): number {
    return Math.max(0, this.maxHops - this.currentHop);
  }

  get isWindingDown(): boolean {
    return this.maxHops - this.currentHop <= 1;
  }

  get trace(): readonly string[] {
    return this.causalTrace;
  }

  consumeHop(agentId: string): number {
    if (this.currentHop >= this.maxHops) {
      throw new LoopBudgetExceededError(this.maxHops, this.currentHop);
    }
    this.currentHop += 1;
    this.causalTrace.push(agentId);
    return this.currentHop;
  }
}

// ============================================================================
// 3. Two-Stage Reply Gate (Stage 1 Wake Scoring + Stage 2 Sentinel & Echo Filter)
// ============================================================================

export interface GroupBotCandidate {
  bot_user_id: number;
  agent_id: string;
  username: string;
  display_name: string;
  description: string;
  skills: string[];
  last_spoken_ms?: number;
}

export interface WakeDecision {
  status: 'wake' | 'pass' | 'skipped';
  reason: string;
  targets: GroupBotCandidate[];
}

const LOW_SIGNAL_ACKS = new Set([
  'ok',
  'okay',
  'k',
  'kk',
  'yes',
  'yep',
  'sure',
  'thanks',
  'thx',
  'ty',
  'cool',
  'nice',
  'got it',
  '好的',
  '收到',
  '谢谢',
  '明白',
  '嗯',
  '好',
  '👍',
  '👌',
  '🙏',
]);

const PASS_SENTINELS = new Set([
  '[pass]',
  '<pass/>',
  '<pass />',
  '<pass></pass>',
  'no_reply',
  '[no_reply]',
  '<no_reply/>',
  '<no_reply />',
  '__pass__',
  'pass',
  'pass.',
]);

export function normalizeForSimilarity(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function charTrigramJaccard(a: string, b: string): number {
  const na = normalizeForSimilarity(a);
  const nb = normalizeForSimilarity(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const toGrams = (s: string): Set<string> => {
    const out = new Set<string>();
    if (s.length <= 3) {
      out.add(s);
      return out;
    }
    for (let i = 0; i <= s.length - 3; i++) {
      out.add(s.slice(i, i + 3));
    }
    return out;
  };
  const ga = toGrams(na);
  const gb = toGrams(nb);
  let intersection = 0;
  for (const gram of ga) {
    if (gb.has(gram)) intersection += 1;
  }
  const union = ga.size + gb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function evaluateGroupWakeGate(params: {
  text: string;
  senderIsHuman: boolean;
  senderUserId: number;
  remainingLoopBudget: number;
  candidates: GroupBotCandidate[];
  replyToSenderId?: number | null;
  lastSpeakerAgentId?: string | null;
  nowMs?: number;
  cooldownMs?: number;
}): WakeDecision {
  const now = params.nowMs ?? Date.now();
  const cooldownMs = params.cooldownMs ?? 15_000;
  const eligible = params.candidates.filter((c) => c.bot_user_id !== params.senderUserId);

  if (eligible.length === 0) {
    return { status: 'skipped', reason: 'no_bots_in_room', targets: [] };
  }
  if (params.remainingLoopBudget <= 0 && !params.senderIsHuman) {
    return { status: 'skipped', reason: 'budget_exhausted', targets: [] };
  }

  const trimmed = params.text.trim();
  const lower = trimmed.toLowerCase();

  // Rule 1: @all / @everyone / @here / @所有人
  if (/(?:^|\s)@(?:all|everyone|here|所有人)(?:\b|$)/i.test(trimmed)) {
    return { status: 'wake', reason: 'mention_all', targets: eligible };
  }

  // Rule 2: explicit @mention matching username, agent_id, display_name, or bot_user_id
  const mentioned: GroupBotCandidate[] = [];
  const mentionTokens = Array.from(trimmed.matchAll(/@([A-Za-z0-9_.-]+)/g)).map((m) =>
    m[1]!.toLowerCase(),
  );
  if (mentionTokens.length > 0) {
    for (const bot of eligible) {
      const aliases = new Set([
        bot.username.toLowerCase(),
        bot.agent_id.toLowerCase(),
        bot.display_name.toLowerCase().replace(/\s+/g, ''),
        String(bot.bot_user_id),
      ]);
      if (mentionTokens.some((tok) => aliases.has(tok))) {
        mentioned.push(bot);
      }
    }
    if (mentioned.length > 0) {
      return { status: 'wake', reason: 'explicit_mention', targets: mentioned };
    }
  }

  // Rule 3: direct reply to a bot's message
  if (params.replyToSenderId) {
    const replyBot = eligible.find((c) => c.bot_user_id === params.replyToSenderId);
    if (replyBot) {
      return { status: 'wake', reason: 'reply_to_bot', targets: [replyBot] };
    }
  }

  // Rule 4: single-bot room (human message wakes sole bot)
  if (params.candidates.length === 1 && params.senderIsHuman) {
    return { status: 'wake', reason: 'single_bot_room', targets: [eligible[0]!] };
  }

  // Rule 5: multi-bot unmentioned message scoring
  if (LOW_SIGNAL_ACKS.has(lower) || trimmed.length <= 2) {
    return { status: 'pass', reason: 'low_signal_ack', targets: [] };
  }

  const words = normalizeForSimilarity(trimmed)
    .split(' ')
    .filter((w) => w.length >= 2);
  let best: { bot: GroupBotCandidate; score: number } | null = null;

  for (const bot of eligible) {
    let score = 0;
    const botNameLower = bot.display_name.toLowerCase();
    const botUserLower = bot.username.toLowerCase();
    if (lower.includes(botNameLower) || lower.includes(botUserLower)) {
      score += 0.55;
    }

    let skillScore = 0;
    for (const sk of bot.skills) {
      if (sk && lower.includes(sk.toLowerCase())) {
        skillScore += 0.25;
      }
    }
    score += Math.min(0.55, skillScore);

    const descWords = new Set(
      normalizeForSimilarity(bot.description)
        .split(' ')
        .filter((w) => w.length >= 3),
    );
    let overlap = 0;
    for (const w of words) {
      if (descWords.has(w)) overlap += 1;
    }
    score += Math.min(0.45, overlap * 0.15);

    if (params.lastSpeakerAgentId === bot.agent_id) {
      score += params.senderIsHuman ? 0.38 : 0.15;
    }

    if (bot.last_spoken_ms && now - bot.last_spoken_ms < cooldownMs) {
      score -= params.senderIsHuman ? 0.2 : 0.35;
    }

    if (score >= 0.35 && (!best || score > best.score)) {
      best = { bot, score };
    }
  }

  if (best) {
    return { status: 'wake', reason: 'scored_relevance', targets: [best.bot] };
  }

  return { status: 'pass', reason: 'no_relevant_candidate', targets: [] };
}

export function evaluateOutboundTurnReview(
  candidateText: string,
  recentRoomMessages: string[],
): { allow: boolean; reason: string; similarity?: number } {
  const trimmed = candidateText.trim();
  if (!trimmed) {
    return { allow: false, reason: 'empty_response' };
  }
  const lower = trimmed.toLowerCase();
  if (PASS_SENTINELS.has(lower)) {
    return { allow: false, reason: 'explicit_pass_sentinel' };
  }
  for (const sentinel of ['[pass]', '<pass/>', '<pass />', 'no_reply', '[no_reply]', '<no_reply/>']) {
    if (
      lower.startsWith(`${sentinel} `) ||
      lower.startsWith(`${sentinel}\n`) ||
      lower.startsWith(`${sentinel}:`) ||
      lower.startsWith(`${sentinel}-`) ||
      lower.startsWith(`${sentinel}—`)
    ) {
      return { allow: false, reason: 'explicit_pass_sentinel' };
    }
  }

  let maxSim = 0;
  for (const prev of recentRoomMessages.slice(-8)) {
    const sim = charTrigramJaccard(trimmed, prev);
    if (sim > maxSim) maxSim = sim;
    if (sim >= 0.85) {
      return { allow: false, reason: 'duplicate_echo', similarity: sim };
    }
  }

  return { allow: true, reason: 'approved', similarity: maxSim };
}

// ============================================================================
// 4. Ed25519 ScopedCapabilityToken
// ============================================================================

export interface ScopedCapabilityToken {
  token_id: string;
  agent_id: string;
  chat_id: number;
  allowed_actions: string[];
  expires_at: number;
  signature_hex: string;
}

export class CapabilityTokenAuthority {
  private readonly privateKey: crypto.KeyObject;
  private readonly publicKey: crypto.KeyObject;

  constructor() {
    const pair = crypto.generateKeyPairSync('ed25519');
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
  }

  private canonicalPayload(token: Omit<ScopedCapabilityToken, 'signature_hex'>): Buffer {
    return Buffer.from(
      JSON.stringify({
        token_id: token.token_id,
        agent_id: token.agent_id,
        chat_id: token.chat_id,
        allowed_actions: [...token.allowed_actions].sort(),
        expires_at: token.expires_at,
      }),
      'utf8',
    );
  }

  issue(
    agentId: string,
    chatId: number,
    allowedActions: string[],
    ttlSecs = 120,
  ): ScopedCapabilityToken {
    const base = {
      token_id: `cap_${crypto.randomBytes(8).toString('hex')}`,
      agent_id: agentId,
      chat_id: chatId,
      allowed_actions: [...allowedActions].sort(),
      expires_at: Math.floor(Date.now() / 1000) + ttlSecs,
    };
    const sig = crypto.sign(null, this.canonicalPayload(base), this.privateKey).toString('hex');
    return { ...base, signature_hex: sig };
  }

  verify(
    token: ScopedCapabilityToken,
    expectedAgentId: string,
    expectedChatId: number,
    requiredAction: string,
    nowSecs = Math.floor(Date.now() / 1000),
  ): boolean {
    if (!token || typeof token.signature_hex !== 'string') return false;
    if (token.agent_id !== expectedAgentId || token.chat_id !== expectedChatId) return false;
    if (token.expires_at < nowSecs) return false;
    if (!token.allowed_actions.includes(requiredAction)) return false;
    try {
      const sigBuf = Buffer.from(token.signature_hex, 'hex');
      if (sigBuf.length !== 64) return false;
      const payload = this.canonicalPayload({
        token_id: token.token_id,
        agent_id: token.agent_id,
        chat_id: token.chat_id,
        allowed_actions: token.allowed_actions,
        expires_at: token.expires_at,
      });
      return crypto.verify(null, payload, this.publicKey, sigBuf);
    } catch {
      return false;
    }
  }
}

// ============================================================================
// 5. Revisioned SharedGroupWorkspace (SQLite + 409 Optimistic Concurrency)
// ============================================================================

export interface GroupWorkspaceEntryDto {
  key: string;
  value: unknown;
  updated_by: string;
  updated_at_ms: number;
}

export interface GroupWorkspaceSnapshot {
  chat_id: number;
  revision: number;
  entries: Record<string, GroupWorkspaceEntryDto>;
}

export class SharedGroupWorkspaceStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly hub: RealtimeGatewayHub,
  ) {}

  getSnapshot(chatId: number): GroupWorkspaceSnapshot {
    const wsRow = this.db
      .prepare(`SELECT revision FROM group_workspaces WHERE chat_id = ?`)
      .get(chatId) as { revision: number } | undefined;
    const rows = this.db
      .prepare(
        `SELECT entry_key, value_json, updated_by, updated_at_ms
         FROM group_workspace_entries WHERE chat_id = ? ORDER BY entry_key ASC`,
      )
      .all(chatId) as Array<{
        entry_key: string;
        value_json: string;
        updated_by: string;
        updated_at_ms: number;
      }>;

    const entries: Record<string, GroupWorkspaceEntryDto> = {};
    for (const r of rows) {
      let parsed: unknown = r.value_json;
      try {
        parsed = JSON.parse(r.value_json);
      } catch {
        parsed = r.value_json;
      }
      Object.defineProperty(entries, r.entry_key, {
        value: {
          key: r.entry_key,
          value: parsed,
          updated_by: r.updated_by,
          updated_at_ms: Number(r.updated_at_ms),
        },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }

    return {
      chat_id: chatId,
      revision: wsRow ? Number(wsRow.revision) : 0,
      entries,
    };
  }

  readKey(chatId: number, key: string): { revision: number; entry: GroupWorkspaceEntryDto | null } {
    const snap = this.getSnapshot(chatId);
    const entry = Object.prototype.hasOwnProperty.call(snap.entries, key)
      ? snap.entries[key]!
      : null;
    return {
      revision: snap.revision,
      entry,
    };
  }

  writeKey(
    chatId: number,
    key: string,
    value: unknown,
    updatedBy: string,
    expectedRevision?: number,
  ): { revision: number; entry: GroupWorkspaceEntryDto } {
    const cleanKey = typeof key === 'string' ? key.trim() : '';
    if (!cleanKey || cleanKey.length > 128) {
      throw new ApiError(400, 'invalid_workspace_key', 'Workspace key must be 1..128 characters');
    }
    const normalizedValue = value === undefined ? null : value;
    const serializedValue = value === undefined ? 'null' : (JSON.stringify(value) ?? 'null');

    const now = Date.now();
    let nextRevision = 0;

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const wsRow = this.db
        .prepare(`SELECT revision FROM group_workspaces WHERE chat_id = ?`)
        .get(chatId) as { revision: number } | undefined;
      const actualRevision = wsRow ? Number(wsRow.revision) : 0;

      if (expectedRevision !== undefined && actualRevision !== expectedRevision) {
        this.db.exec('ROLLBACK;');
        throw new ApiError(
          409,
          'revision_conflict',
          `Workspace revision conflict: expected ${expectedRevision}, actual ${actualRevision}`,
          { expected_revision: expectedRevision, actual_revision: actualRevision },
        );
      }

      nextRevision = actualRevision + 1;
      this.db
        .prepare(`
          INSERT OR REPLACE INTO group_workspaces (chat_id, revision, updated_at_ms)
          VALUES (?, ?, ?)
        `)
        .run(chatId, nextRevision, now);

      this.db
        .prepare(`
          INSERT OR REPLACE INTO group_workspace_entries (
            chat_id, entry_key, value_json, updated_by, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?)
        `)
        .run(chatId, cleanKey, serializedValue, updatedBy, now);

      this.db.exec('COMMIT;');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // Already rolled back
      }
      throw err;
    }

    this.hub.broadcastAgentWorkspaceUpdated(chatId, {
      chat_id: chatId,
      revision: nextRevision,
      key: cleanKey,
      value: normalizedValue,
      updated_by: updatedBy,
    });

    return {
      revision: nextRevision,
      entry: {
        key: cleanKey,
        value: normalizedValue,
        updated_by: updatedBy,
        updated_at_ms: now,
      },
    };
  }
}

// ============================================================================
// 6. MultiAgentOrchestrator (Multi-Turn OpenAI Tool Loop + WS Broadcasts)
// ============================================================================

const MULTI_AGENT_TOOLS: Array<Record<string, unknown>> = [
  {
    type: 'function',
    function: {
      name: 'group_workspace_list',
      description: 'List all keys and the current revision in this group chat shared workspace.',
      parameters: {
        type: 'object',
        properties: {
          chat_id: { type: 'integer', description: 'Optional chat ID (defaults to current group)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'group_workspace_read',
      description: 'Read a specific key from this group chat shared workspace.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Entry key to read' },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'group_workspace_write',
      description: 'Write a key/value entry to this group chat shared workspace with optional optimistic concurrency check.',
      parameters: {
        type: 'object',
        properties: {
          chat_id: { type: 'integer', description: 'Target chat ID (must match current group)' },
          key: { type: 'string', description: 'Entry key' },
          value: { description: 'JSON value to store' },
          expected_revision: { type: 'integer', description: 'Expected workspace revision for optimistic concurrency' },
        },
        required: ['key', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'SendToAgent',
      description: 'Hand off the conversation to another bot in this group chat.',
      parameters: {
        type: 'object',
        properties: {
          targetId: { type: 'string', description: 'Target bot username, agent_id, display_name, or bot_user_id' },
          target_id: { type: 'string', description: 'Alias for targetId' },
          target_agent: { type: 'string', description: 'Alias for targetId' },
          target_bot: { type: 'string', description: 'Alias for targetId' },
          message: { type: 'string', description: 'Handoff task/context message for the target agent' },
          task: { type: 'string', description: 'Alias for message' },
        },
        required: ['message'],
      },
    },
  },
];

interface RoomRuntimeState {
  floor: FloorControlQueue;
  budget: LoopBudget;
  lastSpeakerAgentId: string | null;
  lastSpokenByBot: Map<number, number>;
}

export class MultiAgentOrchestrator {
  public readonly workspace: SharedGroupWorkspaceStore;
  public readonly capabilities = new CapabilityTokenAuthority();
  private readonly rooms = new Map<number, RoomRuntimeState>();
  private disposed = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly config: ServerConfig,
    private readonly hub: RealtimeGatewayHub,
  ) {
    this.workspace = new SharedGroupWorkspaceStore(db, hub);
  }

  private getRoom(chatId: number): RoomRuntimeState {
    let room = this.rooms.get(chatId);
    if (!room) {
      room = {
        floor: new FloorControlQueue(30_000),
        budget: new LoopBudget(DEFAULT_MAX_LOOP_HOPS),
        lastSpeakerAgentId: null,
        lastSpokenByBot: new Map(),
      };
      this.rooms.set(chatId, room);
    }
    return room;
  }

  getFloorSnapshot(chatId: number) {
    const room = this.getRoom(chatId);
    const snap = room.floor.getSnapshot();
    return {
      chat_id: chatId,
      current_speaker: snap.current_speaker,
      queued_count: snap.queued_count,
      loop_hops: room.budget.hop,
      max_hops: room.budget.maxHops,
    };
  }

  listGroupFabushiBots(chatId: number): Array<{ entry: BotRegistryEntry; candidate: GroupBotCandidate }> {
    const rows = this.db
      .prepare(
        `SELECT br.bot_user_id, br.bot_json
         FROM chat_members cm
         INNER JOIN bots_registry br ON br.bot_user_id = cm.user_id
         WHERE cm.chat_id = ? AND br.bot_user_id != ?`,
      )
      .all(chatId, BOTFATHER_USER_ID) as Array<{ bot_user_id: number; bot_json: string }>;

    const room = this.getRoom(chatId);
    const out: Array<{ entry: BotRegistryEntry; candidate: GroupBotCandidate }> = [];
    for (const r of rows) {
      try {
        const entry = JSON.parse(r.bot_json) as BotRegistryEntry;
        // Coding Agent bots are dispatched by CodingAgentBroker, not Hermes LLM orchestrator
        if (entry.coding_agent) continue;
        if (entry.bot_user_id === 777002) continue; // FabushiBot MiniApp bot
        const agentId = entry.agent_id || entry.username.toLowerCase();
        out.push({
          entry,
          candidate: {
            bot_user_id: entry.bot_user_id,
            agent_id: agentId,
            username: entry.username,
            display_name: entry.display_name,
            description: entry.description || entry.ai_persona || '',
            skills: [],
            last_spoken_ms: room.lastSpokenByBot.get(entry.bot_user_id),
          },
        });
      } catch {
        // Skip corrupt bot entry
      }
    }
    return out;
  }

  handleGroupMessage(chatId: number, senderUserId: number, text: string): boolean {
    if (this.disposed) return false;
    const bots = this.listGroupFabushiBots(chatId);
    if (bots.length === 0) return false;

    const room = this.getRoom(chatId);
    // Human message resets loop budget & preempts any stale bot floor
    room.budget.reset();
    room.floor.preemptForHuman(`user:${senderUserId}`);

    const wake = evaluateGroupWakeGate({
      text,
      senderIsHuman: true,
      senderUserId,
      remainingLoopBudget: room.budget.remaining,
      candidates: bots.map((b) => b.candidate),
      lastSpeakerAgentId: room.lastSpeakerAgentId,
    });

    if (wake.status !== 'wake' || wake.targets.length === 0) {
      return true;
    }

    const priority =
      wake.reason === 'explicit_mention' || wake.reason === 'mention_all'
        ? FloorPriority.DirectMention
        : FloorPriority.GeneralContribution;

    for (const target of wake.targets) {
      const botMeta = bots.find((b) => b.candidate.bot_user_id === target.bot_user_id);
      if (!botMeta) continue;
      void this.executeGroupBotTurn({
        chatId,
        triggerUserId: senderUserId,
        bot: botMeta.entry,
        agentId: botMeta.candidate.agent_id,
        allBots: bots,
        promptText: text,
        priority,
        fromAgentId: null,
      });
    }
    return true;
  }

  private async executeGroupBotTurn(params: {
    chatId: number;
    triggerUserId: number;
    bot: BotRegistryEntry;
    agentId: string;
    allBots: Array<{ entry: BotRegistryEntry; candidate: GroupBotCandidate }>;
    promptText: string;
    priority: FloorPriority;
    fromAgentId: string | null;
  }): Promise<void> {
    if (this.disposed) return;
    const { chatId, triggerUserId, bot, agentId, allBots, promptText, priority } = params;
    const room = this.getRoom(chatId);

    // Strictly enforce <= 5 hops loop budget
    let currentHop: number;
    try {
      currentHop = room.budget.consumeHop(agentId);
    } catch {
      return;
    }

    const isWindingDown = room.budget.isWindingDown;
    const grant = await room.floor.acquireFloorWait(agentId, priority, 15_000, isWindingDown);
    if (!grant || this.disposed) return;

    const snapAcquired = room.floor.getSnapshot();
    this.hub.broadcastAgentFloorChanged(chatId, {
      chat_id: chatId,
      current_speaker: agentId,
      queued_count: snapAcquired.queued_count,
      loop_hops: currentHop,
    });
    this.hub.broadcastBotActivity(chatId, {
      chat_id: chatId,
      bot_user_id: bot.bot_user_id,
      state: 'thinking',
      detail: `Hop ${currentHop}/${room.budget.maxHops}`,
    });

    const pendingHandoffs: Array<{
      target: { entry: BotRegistryEntry; candidate: GroupBotCandidate };
      message: string;
    }> = [];
    const handoffDispatchedTargets = new Set<number>();

    try {
      const capToken = this.capabilities.issue(agentId, chatId, [
        'workspace:read',
        'workspace:write',
        'agent:handoff',
      ]);

      // Isolated group session (`group:<chatId>:<botUserId>`) — NEVER touches 1:1 DM sessions!
      const sessionId = `group:${chatId}:${bot.bot_user_id}`;
      const existingSessionRow = this.db
        .prepare(`SELECT messages_json FROM hermes_sessions WHERE session_id = ?`)
        .get(sessionId) as { messages_json: string } | undefined;
      let sessionHistory: Array<{ role: string; content: string }> = [];
      if (existingSessionRow) {
        try {
          const parsed = JSON.parse(existingSessionRow.messages_json) as Array<{
            role: string;
            content: string;
          }>;
          if (Array.isArray(parsed)) sessionHistory = parsed.slice(-12);
        } catch {
          sessionHistory = [];
        }
      }

      const mem = getHermesMemoryState(this.db, triggerUserId);
      const roomBotList = allBots
        .map((b) => `@${b.entry.username} (${b.entry.display_name})`)
        .join(', ');
      const systemPrompt = [
        bot.ai_persona || mem.soul,
        `You are participating in group chat #${chatId} as @${bot.username} (agent_id=${agentId}).`,
        `Other bots in this room: ${roomBotList}.`,
        `If you have nothing new to add, reply with exactly [PASS].`,
        isWindingDown
          ? `Loop budget warning (${currentHop}/${room.budget.maxHops}): converge concisely and do not delegate further.`
          : '',
      ]
        .filter(Boolean)
        .join('\n');

      const llmMessages: LlmChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...sessionHistory.map((m) => ({ role: m.role, content: m.content })),
        {
          role: 'user',
          content: params.fromAgentId
            ? `[Handoff from ${params.fromAgentId}]: ${promptText}`
            : promptText,
        },
      ];

      let finalText = '';
      for (let round = 0; round < 8; round++) {
        if (this.disposed) return;
        const llmRes = await runConfiguredLlmCompletion(
          this.db,
          this.config,
          triggerUserId,
          llmMessages,
          {
            model: bot.preferred_model || undefined,
            tools: MULTI_AGENT_TOOLS,
          },
        );
        if (!llmRes.usedUpstream) {
          finalText = '';
          break;
        }

        if (llmRes.toolCalls && llmRes.toolCalls.length > 0) {
          llmMessages.push({
            role: 'assistant',
            content: llmRes.text || null,
            tool_calls: llmRes.toolCalls,
          });

          for (const tc of llmRes.toolCalls) {
            let args: Record<string, unknown> = {};
            try {
              const parsed: unknown = JSON.parse(tc.function.arguments || '{}');
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                args = parsed as Record<string, unknown>;
              }
            } catch {
              args = {};
            }

            let toolResult: Record<string, unknown>;
            if (tc.function.name === 'group_workspace_list') {
              if (args.chat_id !== undefined && Number(args.chat_id) !== chatId) {
                toolResult = { ok: false, error: 'forbidden_cross_chat_workspace' };
              } else {
                toolResult = { ok: true, ...this.workspace.getSnapshot(chatId) };
              }
            } else if (tc.function.name === 'group_workspace_read') {
              const key = typeof args.key === 'string' ? args.key : '';
              toolResult = { ok: true, ...this.workspace.readKey(chatId, key) };
            } else if (tc.function.name === 'group_workspace_write') {
              const targetCid = args.chat_id !== undefined ? Number(args.chat_id) : chatId;
              if (
                targetCid !== chatId ||
                !this.capabilities.verify(capToken, agentId, chatId, 'workspace:write')
              ) {
                toolResult = { ok: false, error: 'forbidden_capability_or_chat' };
              } else {
                try {
                  const key = typeof args.key === 'string' ? args.key : '';
                  const expectedRev =
                    typeof args.expected_revision === 'number' &&
                    Number.isInteger(args.expected_revision) &&
                    args.expected_revision >= 0
                      ? args.expected_revision
                      : undefined;
                  const written = this.workspace.writeKey(
                    chatId,
                    key,
                    args.value,
                    agentId,
                    expectedRev,
                  );
                  toolResult = { ok: true, ...written };
                } catch (err) {
                  toolResult = {
                    ok: false,
                    error: err instanceof ApiError ? err.code : 'workspace_write_failed',
                    message: err instanceof Error ? err.message : String(err),
                  };
                }
              }
            } else if (tc.function.name === 'SendToAgent') {
              if (!this.capabilities.verify(capToken, agentId, chatId, 'agent:handoff')) {
                toolResult = { ok: false, error: 'forbidden_capability' };
              } else if (room.budget.remaining <= 0) {
                toolResult = { ok: false, error: 'loop_budget_exhausted' };
              } else {
                const rawTargetVal =
                  args.targetId ?? args.target_id ?? args.target_agent ?? args.target_bot ?? '';
                const rawTarget = (
                  typeof rawTargetVal === 'string' || typeof rawTargetVal === 'number'
                    ? String(rawTargetVal)
                    : ''
                )
                  .trim()
                  .replace(/^@/, '')
                  .toLowerCase();
                const targetMeta = allBots.find(
                  (b) =>
                    b.entry.bot_user_id !== bot.bot_user_id &&
                    (b.entry.username.toLowerCase() === rawTarget ||
                      b.candidate.agent_id.toLowerCase() === rawTarget ||
                      b.entry.display_name.toLowerCase() === rawTarget ||
                      String(b.entry.bot_user_id) === rawTarget),
                );
                const rawMsgVal = args.message ?? args.task ?? '';
                const handoffMsg = (typeof rawMsgVal === 'string' ? rawMsgVal : '').trim();
                if (!targetMeta || !handoffMsg) {
                  toolResult = { ok: false, error: 'target_agent_not_found' };
                } else {
                  handoffDispatchedTargets.add(targetMeta.entry.bot_user_id);
                  pendingHandoffs.push({ target: targetMeta, message: handoffMsg });
                  this.hub.broadcastAgentHandoff(chatId, {
                    chat_id: chatId,
                    from_agent: agentId,
                    to_agent: targetMeta.candidate.agent_id,
                    hop: currentHop,
                    max_hops: room.budget.maxHops,
                  });
                  toolResult = {
                    ok: true,
                    handed_off_to: targetMeta.candidate.agent_id,
                    hop: currentHop,
                    max_hops: room.budget.maxHops,
                  };
                }
              }
            } else {
              toolResult = { ok: false, error: `unknown_tool:${tc.function.name}` };
            }

            llmMessages.push({
              role: 'tool',
              tool_call_id: tc.id,
              name: tc.function.name,
              content: JSON.stringify(toolResult),
            });
          }
          continue;
        }

        finalText = llmRes.text;
        break;
      }

      // Stage 2 outbound review (suppress [PASS], NO_REPLY, empty, or >= 0.85 Jaccard echo)
      const recentRows = this.db
        .prepare(
          `SELECT text_plain FROM messages WHERE chat_id = ? ORDER BY message_id DESC LIMIT 8`,
        )
        .all(chatId) as Array<{ text_plain: string | null }>;
      const recentTexts = recentRows
        .map((r) => String(r.text_plain ?? ''))
        .filter((s) => s.trim().length > 0);

      const review = evaluateOutboundTurnReview(finalText, recentTexts);
      if (review.allow && room.floor.validateDelivery(agentId, grant.nonce) === 'accepted') {
        createMessageAtomic(this.db, this.hub, {
          chatId,
          senderId: bot.bot_user_id,
          text: finalText.trim(),
        });
        room.lastSpeakerAgentId = agentId;
        room.lastSpokenByBot.set(bot.bot_user_id, Date.now());

        // Persist strictly isolated group session trajectory
        const now = Date.now();
        const nextHistory = [
          ...sessionHistory,
          { role: 'user', content: promptText },
          { role: 'assistant', content: finalText.trim() },
        ].slice(-30);
        this.db
          .prepare(`
            INSERT OR REPLACE INTO hermes_sessions (
              session_id, user_id, parent_session_id, chat_id, bot_id, title, source, model,
              messages_json, checkpoints_json, total_tokens, total_cost_usd, created_at_ms, updated_at_ms
            ) VALUES (?, ?, NULL, ?, ?, ?, 'group', ?, ?, '[]', 0, 0, ?, ?)
          `)
          .run(
            sessionId,
            triggerUserId,
            chatId,
            bot.bot_user_id,
            `Group #${chatId} (${bot.username})`,
            bot.preferred_model || '',
            JSON.stringify(nextHistory),
            now,
            now,
          );

        // Check for bot-to-bot @mention handoff (deduped against explicit SendToAgent targets)
        if (room.budget.remaining > 0) {
          const mentionWake = evaluateGroupWakeGate({
            text: finalText,
            senderIsHuman: false,
            senderUserId: bot.bot_user_id,
            remainingLoopBudget: room.budget.remaining,
            candidates: allBots.map((b) => b.candidate),
            lastSpeakerAgentId: agentId,
          });
          if (mentionWake.status === 'wake' && mentionWake.reason === 'explicit_mention') {
            for (const t of mentionWake.targets) {
              if (handoffDispatchedTargets.has(t.bot_user_id)) continue;
              const targetMeta = allBots.find((b) => b.candidate.bot_user_id === t.bot_user_id);
              if (targetMeta) {
                handoffDispatchedTargets.add(t.bot_user_id);
                pendingHandoffs.push({ target: targetMeta, message: finalText.trim() });
                this.hub.broadcastAgentHandoff(chatId, {
                  chat_id: chatId,
                  from_agent: agentId,
                  to_agent: targetMeta.candidate.agent_id,
                  hop: currentHop,
                  max_hops: room.budget.maxHops,
                });
              }
            }
          }
        }
      }
    } finally {
      room.floor.releaseTurn(agentId, grant.nonce);
      const snapAfter = room.floor.getSnapshot();
      this.hub.broadcastAgentFloorChanged(chatId, {
        chat_id: chatId,
        current_speaker: snapAfter.current_speaker,
        queued_count: snapAfter.queued_count,
        loop_hops: room.budget.hop,
      });
      this.hub.broadcastBotActivity(chatId, {
        chat_id: chatId,
        bot_user_id: bot.bot_user_id,
        state: 'idle',
        detail: null,
      });
    }

    // Dispatch any queued bot-to-bot handoffs AFTER releasing floor
    for (const h of pendingHandoffs) {
      if (this.disposed || room.budget.remaining <= 0) break;
      void this.executeGroupBotTurn({
        chatId,
        triggerUserId,
        bot: h.target.entry,
        agentId: h.target.candidate.agent_id,
        allBots,
        promptText: h.message,
        priority: FloorPriority.TaskAssignee,
        fromAgentId: agentId,
      });
    }
  }

  reset(): void {
    for (const room of this.rooms.values()) {
      room.floor.clear();
      room.budget.reset();
      room.lastSpokenByBot.clear();
    }
    this.rooms.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.reset();
  }
}

// ============================================================================
// 7. REST Inspection & Workspace Routes
// ============================================================================

export function registerMultiAgentRoutes(
  router: HttpRouter,
  db: DatabaseSync,
  orchestrator: MultiAgentOrchestrator,
): void {
  router.get('/api/v1/chats/:chatId/workspace', (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = parsePositiveChatId(ctx.params.chatId);
    if (!chatId) throw new ApiError(400, 'invalid_chat_id', 'Invalid chatId');
    ensureChatReadAccess(db, chatId, auth.userId);
    sendJson(ctx.res, 200, orchestrator.workspace.getSnapshot(chatId));
  });

  router.put('/api/v1/chats/:chatId/workspace/:key', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = parsePositiveChatId(ctx.params.chatId);
    if (!chatId) throw new ApiError(400, 'invalid_chat_id', 'Invalid chatId');
    ensureChatWriteAccess(db, chatId, auth.userId);

    const body = await readJsonBody<{
      value?: unknown;
      expected_revision?: unknown;
    }>(ctx.req);
    const expectedRevision = parseOptionalNonNegativeInt(
      body.expected_revision,
      'invalid_revision',
      'expected_revision must be a non-negative integer',
    );
    const result = orchestrator.workspace.writeKey(
      chatId,
      ctx.params.key!,
      body.value ?? null,
      `user:${auth.userId}`,
      expectedRevision,
    );
    sendJson(ctx.res, 200, { ok: true, chat_id: chatId, ...result });
  });

  router.get('/api/v1/chats/:chatId/floor', (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = parsePositiveChatId(ctx.params.chatId);
    if (!chatId) throw new ApiError(400, 'invalid_chat_id', 'Invalid chatId');
    ensureChatReadAccess(db, chatId, auth.userId);
    sendJson(ctx.res, 200, orchestrator.getFloorSnapshot(chatId));
  });
}

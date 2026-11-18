/**
 * Real-Time WebSocket Frames (`WsClientFrame` / `WsServerFrame`),
 * All `UpdateEvent` Variants, and Monotonic Per-Chat `PtsUpdate` Sync Engine Contracts.
 */

import type { WireMessageEntity } from './entities.js';
import type {
  CallSignalPayload,
  ChatDetailDto,
  ChatFolderDto,
  DeleteTombstone,
  ForumTopicDto,
  InlineKeyboardButton,
  MessageContent,
  MessageItem,
  PollData,
  ReactionCount,
  StoryItem,
  TodoListCard,
  UserProfileDto,
  WireDraftDto,
  WireUserStatus,
} from './models.js';
import type { TailnetStatusDto } from './aiContracts.js';
import type {
  BrowserCommandRequest,
  BrowserCommandResult,
  BrowserControlRevokedPayload,
  BrowserRegisterPayload,
  BrowserStateReportPayload,
  BrowserTargetDescriptor,
} from './browserControl.js';

export type TypingAction =
  | 'typing'
  | 'record_audio'
  | 'upload_audio'
  | 'record_video'
  | 'upload_video'
  | 'record_round'
  | 'upload_round'
  | 'upload_photo'
  | 'upload_document'
  | 'choose_sticker'
  | 'cancel';

export interface TypingEvent {
  chat_id: number;
  user_id: number;
  topic_id?: number;
  action: TypingAction;
  timestamp_ms: number;
}

export interface ReadHistoryEvent {
  chat_id: number;
  max_id: number;
  is_outbox: boolean;
  unread_count: number;
}

export interface ReactionEvent {
  chat_id: number;
  message_id: number;
  user_id: number;
  reactions: ReactionCount[];
}

export type ChatActionEvent =
  | { action: 'TitleChanged'; payload: { new_title: string } }
  | { action: 'PhotoChanged'; payload: { photo_id: string | null } }
  | { action: 'UserJoined'; payload: { user_id: number } }
  | { action: 'UserLeft'; payload: { user_id: number } }
  | { action: 'PinnedMessageChanged'; payload: { message_id: number | null } };

/**
 * Complete discriminated union of real-time `UpdateEvent` variants (`tag = "type", content = "data"`),
 * encompassing all 23 upstream `sync/events.rs` variants plus server gateway aliases.
 */
export type UpdateEvent =
  | { type: 'NewMessage'; data: MessageItem }
  | { type: 'EditMessage'; data: MessageItem }
  | { type: 'DeleteMessages'; data: DeleteTombstone }
  | { type: 'UserTyping'; data: TypingEvent }
  | { type: 'ChatAction'; data: ChatActionEvent }
  | { type: 'ReadHistory'; data: ReadHistoryEvent }
  | { type: 'ReadHistoryInbox'; data: ReadHistoryEvent }
  | { type: 'ReadHistoryOutbox'; data: ReadHistoryEvent }
  | { type: 'ReadHistoryOut'; data: { max_id: number; chat_id?: number } }
  | { type: 'ReadHistoryIn'; data: { max_id: number; chat_id?: number } }
  | { type: 'MessageReactions'; data: ReactionEvent }
  | { type: 'ReactionUpdated'; data: ReactionEvent }
  | { type: 'UserStatusChanged'; data: { user_id: number; status: WireUserStatus | string } }
  | { type: 'ChatUpdated'; data: ChatDetailDto }
  | { type: 'UserUpdated'; data: UserProfileDto }
  | { type: 'PinnedMessageChanged'; data: { chat_id?: number; message_id: number | null } }
  | { type: 'PinnedMessagesChanged'; data: { chat_id: number; pinned_ids: number[] } }
  | { type: 'PollUpdated'; data: { chat_id: number; message_id: number; poll: PollData } }
  | { type: 'TodoUpdated'; data: { chat_id: number; message_id: number; todo: TodoListCard } }
  | { type: 'DraftUpdated'; data: { chat_id: number; topic_id: number | null; draft: WireDraftDto | null } }
  | { type: 'ForumTopicChanged'; data: { chat_id: number; topic: ForumTopicDto } }
  | { type: 'ForumTopicDeleted'; data: { chat_id: number; topic_id: number } }
  | { type: 'FolderChanged'; data: { folder: ChatFolderDto } }
  | { type: 'FolderDeleted'; data: { folder_id: string | number } }
  | { type: 'CallUpdated'; data: { call_id: string; state: string; signal: CallSignalPayload | null } }
  | { type: 'CallSignal'; data: CallSignalPayload }
  | { type: 'StoryUpdated'; data: { story: StoryItem } }
  | { type: 'StoryDeleted'; data: { story_id: string | number; user_id: number } }
  | { type: 'MessageViewsUpdated'; data: { chat_id: number; message_id: number; views: number; forwards: number } }
  | { type: 'PtsGapDetected'; data: { chat_id: number; local_pts: number; remote_pts: number } }
  | { type: 'MiniAppStatePatch'; data: { app_id: string; chat_id?: number; patch: Record<string, unknown> } }
  | { type: 'AgentFloorChanged'; data: { chat_id: number; current_speaker: string | null; queued_count: number; loop_hops: number } }
  | { type: 'AgentWorkspaceUpdated'; data: { chat_id: number; revision: number; key: string; value: unknown; updated_by: string } }
  | { type: 'AgentHandoffEvent'; data: { chat_id: number; from_agent: string; to_agent: string; hop: number; max_hops: number } };

export interface PtsUpdate {
  chat_id: number;
  pts: number;
  pts_count: number;
  event: UpdateEvent;
  timestamp_ms: number;
  date?: string;
}

export interface PtsGapRange {
  fromPts: number;
  toPts: number;
}

export function prevPts(update: Pick<PtsUpdate, 'pts' | 'pts_count'>): number {
  return Math.max(0, update.pts - update.pts_count);
}

/**
 * Checks whether an incoming `PtsUpdate` applies cleanly on top of `currentPts` without a gap.
 */
export function isPtsContinuous(
  update: Pick<PtsUpdate, 'pts' | 'pts_count'>,
  currentPts: number,
): boolean {
  if (update.pts_count === 0) {
    return update.pts <= currentPts || prevPts(update) === currentPts;
  }
  return prevPts(update) === currentPts;
}

/**
 * Detects a missing PTS sequence window `(currentPts + 1 .. prevPts)` requiring `sync/get_difference`.
 */
export function detectPtsGap(
  update: Pick<PtsUpdate, 'pts' | 'pts_count'>,
  currentPts: number,
): PtsGapRange | null {
  const prev = prevPts(update);
  if (prev > currentPts) {
    return {
      fromPts: currentPts + 1,
      toPts: prev,
    };
  }
  return null;
}

/**
 * Returns `true` when `update` has already been applied (`pts <= currentPts` for state-mutating updates).
 */
export function isPtsStaleOrDuplicate(
  update: Pick<PtsUpdate, 'pts' | 'pts_count'>,
  currentPts: number,
): boolean {
  return update.pts_count > 0 && update.pts <= currentPts;
}

export interface SyncGetDifferenceRequest {
  chat_id: number;
  pts?: number;
  from_pts?: number;
  pts_total_limit?: number;
  limit?: number;
  date?: number;
  filter?: string;
}

export interface SyncGetDifferenceResponse {
  status?: 'UpToDate' | 'Updates' | 'TooLong';
  chat_id: number;
  new_messages: MessageItem[];
  other_updates: UpdateEvent[];
  pts: number;
  current_pts: number;
  updates: PtsUpdate[];
  has_more: boolean;
  snapshot_required: boolean;
}

// ============================================================================
// WebSocket Bidirectional Frames (`#[serde(tag = "type", content = "payload")]`)
// ============================================================================

export interface WsSendMessagePayload {
  chat_id: number;
  client_nonce: number;
  reply_to?: number;
  topic_id?: number;
  content?: MessageContent;
  text?: string;
  silent?: boolean;
  entities?: WireMessageEntity[];
  quote_text?: string;
  forward_from_chat_id?: number;
  forward_from_msg_id?: number;
  scheduled_at_ms?: number;
  inline_keyboard?: InlineKeyboardButton[][];
  media_id?: string;
}

export interface WsEditMessagePayload {
  chat_id: number;
  message_id: number;
  content?: MessageContent;
  text?: string;
  entities?: WireMessageEntity[];
}

export interface WsDeleteMessagesPayload {
  chat_id: number;
  message_ids: number[];
  for_everyone: boolean;
}

export interface WsReactionPayload {
  chat_id: number;
  message_id: number;
  emoji: string;
  add?: boolean;
  action?: 'toggle' | 'add' | 'remove';
}

export interface WsReadHistoryPayload {
  chat_id: number;
  max_id: number;
  topic_id?: number;
}

export type WsClientFrame =
  | { type: 'Auth'; payload: { token: string } }
  | { type: 'Ping'; payload: { nonce?: number; client_ts?: number } }
  | { type: 'Sync'; payload: SyncGetDifferenceRequest }
  | { type: 'GetDifference'; payload: SyncGetDifferenceRequest }
  | { type: 'SendMessage'; payload: WsSendMessagePayload }
  | { type: 'EditMessage'; payload: WsEditMessagePayload }
  | { type: 'DeleteMessages'; payload: WsDeleteMessagesPayload }
  | { type: 'SendReaction'; payload: WsReactionPayload }
  | { type: 'Reaction'; payload: WsReactionPayload }
  | { type: 'ReadHistory'; payload: WsReadHistoryPayload }
  | { type: 'SendTyping'; payload: { chat_id: number; topic_id?: number; action: TypingAction } }
  | { type: 'Typing'; payload: { chat_id: number; topic_id?: number; action: TypingAction } }
  | { type: 'SubscribeChat'; payload: { chat_id: number } }
  | { type: 'SubscribeChats'; payload: { chat_ids: number[] } }
  | { type: 'UnsubscribeChat'; payload: { chat_id: number } }
  | { type: 'VotePoll'; payload: { chat_id: number; message_id: number; poll_id: number; option_ids: number[] } }
  | { type: 'CallSignal'; payload: CallSignalPayload }
  | { type: 'AckUpdates'; payload: { chat_id: number; pts: number } }
  | { type: 'BrowserRegister'; payload: BrowserRegisterPayload }
  | { type: 'BrowserStateReport'; payload: BrowserStateReportPayload }
  | { type: 'BrowserCommandResult'; payload: BrowserCommandResult }
  | { type: 'BrowserCommand'; payload: BrowserCommandRequest };

export type WsServerFrame =
  | { type: 'AuthOk'; payload: { user_id: number; session_id: string; server_time_ms: number } }
  | { type: 'AuthError'; payload: { reason: string } }
  | { type: 'Pong'; payload: { nonce?: number; client_ts?: number; server_ts: number } }
  | { type: 'Update'; payload: UpdateEvent }
  | { type: 'PtsPush'; payload: PtsUpdate }
  | { type: 'PtsUpdate'; payload: PtsUpdate }
  | { type: 'SyncDiff'; payload: SyncGetDifferenceResponse }
  | { type: 'Difference'; payload: SyncGetDifferenceResponse }
  | {
      type: 'Ack';
      payload: {
        correlation_id?: number;
        client_nonce: number;
        chat_id: number;
        message_id: number;
        pts: number;
        duplicate?: boolean;
        date_ms: number;
      };
    }
  | {
      type: 'SendAck';
      payload: {
        client_nonce: number;
        chat_id: number;
        message_id: number;
        pts: number;
        duplicate?: boolean;
        date_ms: number;
      };
    }
  | { type: 'TailnetMapUpdate'; payload: TailnetStatusDto }
  | { type: 'BrowserRegistered'; payload: BrowserTargetDescriptor }
  | {
      type: 'BrowserCommand';
      payload: BrowserCommandRequest & {
        command_id: string;
        target_id: string;
        generation: number;
      };
    }
  | { type: 'BrowserCommandResult'; payload: BrowserCommandResult }
  | {
      type: 'BrowserTargetsUpdated';
      payload: { targets: BrowserTargetDescriptor[]; control_generation: number };
    }
  | { type: 'BrowserControlRevoked'; payload: BrowserControlRevokedPayload }
  | { type: 'Error'; payload: { code: number; message: string; details?: string } };

/**
 * Shared Domain Models & Wire DTOs for `@gpui-telegram/protocol`.
 *
 * Exports both ergonomic TypeScript domain interfaces (`UserProfile`, `PeerEntity`, `ChatSummary`,
 * `ForumTopic`, `ChatFolder`, `StoryItem`, `StoryGroup`, `MessageItem`, `PollData`, `TodoListCard`,
 * `InvoiceCard`, `LocationCard`, `ContactCard`, `WebPagePreview`, `GenerativeCard`, `CallSessionState`,
 * `DraftState`, etc.) AND wire-compatible `snake_case` DTOs + mappers.
 */

import type { EncryptedEnvelope } from './e2ee.js';
import type { MessageEntity, WireMessageEntity } from './entities.js';
import { fromWireMessageEntity, toWireMessageEntity } from './entities.js';
import type { AuthVersion } from './userVault.js';

export type WirePeerId =
  | { User: number }
  | { Chat: number }
  | { Channel: number }
  | { Fake: number };

export interface PeerRef {
  kind: 'user' | 'chat' | 'channel' | 'fake';
  id: number;
}

export function peerAvatarColorIndex(numericId: number): number {
  return Math.abs(Math.trunc(numericId)) % 7;
}

export type WireUserStatus =
  | { Online: { expires_at: string } }
  | { Offline: { was_online: string | null } }
  | 'Recently'
  | 'LastWeek'
  | 'LastMonth'
  | 'LongAgo'
  | 'Hidden';

export interface UserProfile {
  userId: number;
  user_id?: number;
  username?: string;
  firstName: string;
  first_name?: string;
  lastName?: string;
  last_name?: string;
  bio?: string;
  phone?: string;
  avatarMediaId?: string;
  photoFileId?: string;
  emojiStatus?: string;
  isBot: boolean;
  isVerified: boolean;
  isPremium: boolean;
  status: 'online' | 'offline' | 'recently' | 'last_week' | 'last_month' | 'bot' | string;
  lastSeenMs?: number;
  colorIndex: number;
}

export interface UserProfileDto {
  user_id: number;
  username?: string;
  first_name: string;
  last_name?: string;
  bio?: string;
  phone?: string;
  avatar_media_id?: string;
  photo_file_id?: string;
  emoji_status?: string;
  is_bot: boolean;
  is_verified: boolean;
  is_premium: boolean;
  status: string;
  last_seen_ms?: number;
}

export function mapUserDtoToDomain(dto: UserProfileDto): UserProfile {
  return {
    userId: dto.user_id,
    user_id: dto.user_id,
    username: dto.username,
    firstName: dto.first_name,
    first_name: dto.first_name,
    lastName: dto.last_name,
    last_name: dto.last_name,
    bio: dto.bio,
    phone: dto.phone,
    avatarMediaId: dto.avatar_media_id ?? dto.photo_file_id,
    photoFileId: dto.photo_file_id ?? dto.avatar_media_id,
    emojiStatus: dto.emoji_status,
    isBot: Boolean(dto.is_bot),
    isVerified: Boolean(dto.is_verified),
    isPremium: Boolean(dto.is_premium),
    status: dto.status ?? 'recently',
    lastSeenMs: dto.last_seen_ms,
    colorIndex: peerAvatarColorIndex(dto.user_id),
  };
}

export interface PeerEntity {
  peerId: number;
  kind: 'user' | 'group' | 'supergroup' | 'channel' | 'bot' | 'secret';
  title: string;
  username?: string;
  avatarUrl?: string;
  colorIndex: number;
  isOnline: boolean;
  isVerified: boolean;
  isPremium: boolean;
  isBot: boolean;
  about?: string;
  phone?: string;
  memberCount?: number;
}

export interface DraftState {
  chatId: number;
  text: string;
  entities: MessageEntity[];
  replyToMsgId?: number;
  quoteText?: string;
  topicId?: number;
  dateMs: number;
}

export interface WireDraftDto {
  chat_id: number;
  text: string;
  entities: WireMessageEntity[];
  reply_to_msg_id?: number;
  quote_text?: string;
  topic_id?: number;
  date_ms: number;
}

export type ChatKind = 'saved' | 'private' | 'bot' | 'group' | 'supergroup' | 'channel' | 'secret';

export interface ChatSummary {
  chatId: number;
  chat_id?: number;
  title: string;
  kind: ChatKind;
  chatType: number; // 0=private/saved, 1=group, 2=supergroup/forum, 3=channel, 4=secret
  creatorId: number;
  peerUserId?: number;
  username?: string;
  about?: string;
  photoFileId?: string;
  colorIndex: number;
  isGroup: boolean;
  isSupergroup: boolean;
  isChannel: boolean;
  isBot: boolean;
  isForum: boolean;
  isSecret: boolean;
  isSavedMessages: boolean;
  isVerified?: boolean;
  isArchived: boolean;
  isPinned: boolean;
  isMuted: boolean;
  muteUntilMs?: number;
  unreadMark?: boolean;
  folderId?: number | null;
  pts: number;
  lastMessageId: number;
  lastMessageDateMs: number;
  lastMessagePreview?: string;
  lastMessageSenderName?: string;
  lastMessageMediaType?: string;
  lastMessageStatus?: 'sending' | 'sent' | 'read' | 'failed';
  unreadCount: number;
  unreadMentionsCount: number;
  unreadReactionsCount: number;
  readInboxMaxId: number;
  readOutboxMaxId: number;
  memberCount: number;
  pinnedMessageIds: number[];
  draft?: DraftState | null;
  ttlSeconds?: number;
  slowModeSeconds?: number;
  sendAsPeerId?: number;
  emojiFingerprint?: string[];
}

export interface ChatDetailDto {
  chat_id: number;
  title: string;
  kind: string;
  chat_type: number;
  creator_id: number;
  peer_user_id?: number;
  username?: string;
  about?: string;
  photo_file_id?: string;
  is_group: boolean;
  is_supergroup?: boolean;
  is_channel: boolean;
  is_bot: boolean;
  is_forum: boolean;
  is_secret?: boolean;
  is_saved_messages?: boolean;
  is_verified?: boolean;
  is_archived: boolean;
  is_pinned: boolean;
  is_muted: boolean;
  mute_until_ms?: number;
  unread_mark?: boolean;
  folder_id?: number | null;
  pts: number;
  last_message_id: number;
  last_message_date_ms: number;
  last_message_preview?: string;
  last_message_sender_name?: string;
  last_message_media_type?: string;
  last_message_status?: 'sending' | 'sent' | 'read' | 'failed';
  unread_count: number;
  unread_mentions_count?: number;
  unread_reactions_count?: number;
  read_inbox_max_id: number;
  read_outbox_max_id: number;
  member_count: number;
  pinned_message_id?: number;
  pinned_message_ids?: number[];
  draft?: WireDraftDto | null;
  ttl_seconds?: number;
  slow_mode_seconds?: number;
  send_as_peer_id?: number;
  emoji_fingerprint?: string[];
}

export function mapChatDtoToDomain(dto: ChatDetailDto): ChatSummary {
  const pinnedIds =
    dto.pinned_message_ids ??
    (dto.pinned_message_id !== undefined && dto.pinned_message_id !== null
      ? [dto.pinned_message_id]
      : []);
  return {
    chatId: dto.chat_id,
    chat_id: dto.chat_id,
    title: dto.title,
    kind: (dto.kind as ChatKind) ?? 'private',
    chatType: dto.chat_type,
    creatorId: dto.creator_id,
    peerUserId: dto.peer_user_id,
    username: dto.username,
    about: dto.about,
    photoFileId: dto.photo_file_id,
    colorIndex: peerAvatarColorIndex(dto.peer_user_id ?? dto.chat_id),
    isGroup: Boolean(dto.is_group),
    isSupergroup: Boolean(dto.is_supergroup ?? (dto.chat_type === 2)),
    isChannel: Boolean(dto.is_channel),
    isBot: Boolean(dto.is_bot),
    isForum: Boolean(dto.is_forum),
    isSecret: Boolean(dto.is_secret ?? (dto.chat_type === 4)),
    isSavedMessages: Boolean(dto.is_saved_messages),
    isVerified: dto.is_verified,
    isArchived: Boolean(dto.is_archived),
    isPinned: Boolean(dto.is_pinned),
    isMuted: Boolean(dto.is_muted),
    muteUntilMs: dto.mute_until_ms,
    unreadMark: dto.unread_mark,
    folderId: dto.folder_id,
    pts: dto.pts,
    lastMessageId: dto.last_message_id,
    lastMessageDateMs: dto.last_message_date_ms,
    lastMessagePreview: dto.last_message_preview,
    lastMessageSenderName: dto.last_message_sender_name,
    lastMessageMediaType: dto.last_message_media_type,
    lastMessageStatus: dto.last_message_status,
    unreadCount: dto.unread_count,
    unreadMentionsCount: dto.unread_mentions_count ?? 0,
    unreadReactionsCount: dto.unread_reactions_count ?? 0,
    readInboxMaxId: dto.read_inbox_max_id,
    readOutboxMaxId: dto.read_outbox_max_id,
    memberCount: dto.member_count,
    pinnedMessageIds: pinnedIds,
    draft: dto.draft
      ? {
          chatId: dto.draft.chat_id,
          text: dto.draft.text,
          entities: (dto.draft.entities ?? []).map(fromWireMessageEntity),
          replyToMsgId: dto.draft.reply_to_msg_id,
          quoteText: dto.draft.quote_text,
          topicId: dto.draft.topic_id,
          dateMs: dto.draft.date_ms,
        }
      : null,
    ttlSeconds: dto.ttl_seconds,
    slowModeSeconds: dto.slow_mode_seconds,
    sendAsPeerId: dto.send_as_peer_id,
    emojiFingerprint: dto.emoji_fingerprint,
  };
}

export interface ForumTopic {
  chatId: number;
  topicId: number;
  topic_id?: number;
  title: string;
  iconColor: number;
  iconEmoji?: string;
  iconEmojiId?: number;
  creatorId: number;
  isPinned: boolean;
  isClosed: boolean;
  isHidden: boolean;
  lastMessageId?: number;
  unreadCount: number;
  createdAtMs: number;
}

export interface ForumTopicDto {
  chat_id: number;
  topic_id: number;
  title: string;
  icon_color: number;
  icon_emoji?: string;
  icon_emoji_id?: number;
  creator_id: number;
  is_pinned: boolean;
  is_closed: boolean;
  is_hidden: boolean;
  last_message_id?: number;
  unread_count: number;
  created_at_ms: number;
}

export interface ChatFolder {
  id: number;
  folderId: string;
  title: string;
  emoticon?: string;
  includedChatIds: number[];
  excludedChatIds: number[];
  pinnedChatIds: number[];
  includeContacts: boolean;
  includeNonContacts: boolean;
  includeGroups: boolean;
  includeChannels: boolean;
  includeBots: boolean;
  excludeMuted: boolean;
  excludeRead: boolean;
  excludeArchived: boolean;
  sortOrder: number;
}

export interface ChatFolderDto {
  id: number;
  folder_id?: string | number;
  title: string;
  emoticon?: string;
  icon?: string;
  include_chats: number[];
  included_chat_ids?: number[];
  exclude_chats: number[];
  excluded_chat_ids?: number[];
  pinned_chats: number[];
  pinned_chat_ids?: number[];
  include_contacts: boolean;
  include_non_contacts: boolean;
  include_groups: boolean;
  include_channels: boolean;
  include_bots: boolean;
  exclude_muted: boolean;
  exclude_read: boolean;
  exclude_archived: boolean;
  sort_order: number;
}

export interface StoryItem {
  storyId: string;
  story_id?: string;
  userId: number;
  username?: string;
  firstName: string;
  mediaId?: string;
  mediaType: string;
  caption?: string;
  backgroundGradient?: string;
  privacy: string;
  viewsCount: number;
  isViewed: boolean;
  createdAtMs: number;
  expiresAtMs: number;
}

export function mapForumTopicDtoToDomain(dto: ForumTopicDto): ForumTopic {
  return {
    chatId: dto.chat_id,
    topicId: dto.topic_id,
    topic_id: dto.topic_id,
    title: dto.title,
    iconColor: dto.icon_color,
    iconEmoji: dto.icon_emoji,
    iconEmojiId: dto.icon_emoji_id,
    creatorId: dto.creator_id,
    isPinned: Boolean(dto.is_pinned),
    isClosed: Boolean(dto.is_closed),
    isHidden: Boolean(dto.is_hidden),
    lastMessageId: dto.last_message_id,
    unreadCount: dto.unread_count,
    createdAtMs: dto.created_at_ms,
  };
}

export function mapChatFolderDtoToDomain(dto: ChatFolderDto): ChatFolder {
  return {
    id: dto.id,
    folderId: String(dto.folder_id ?? dto.id),
    title: dto.title,
    emoticon: dto.emoticon ?? dto.icon,
    includedChatIds: dto.included_chat_ids ?? dto.include_chats ?? [],
    excludedChatIds: dto.excluded_chat_ids ?? dto.exclude_chats ?? [],
    pinnedChatIds: dto.pinned_chat_ids ?? dto.pinned_chats ?? [],
    includeContacts: Boolean(dto.include_contacts),
    includeNonContacts: Boolean(dto.include_non_contacts),
    includeGroups: Boolean(dto.include_groups),
    includeChannels: Boolean(dto.include_channels),
    includeBots: Boolean(dto.include_bots),
    excludeMuted: Boolean(dto.exclude_muted),
    excludeRead: Boolean(dto.exclude_read),
    excludeArchived: dto.exclude_archived ?? true,
    sortOrder: dto.sort_order,
  };
}

export interface StoryDto {
  story_id: string;
  storyId?: string;
  user_id: number;
  userId?: number;
  username?: string;
  first_name: string;
  firstName?: string;
  media_id?: string;
  mediaId?: string;
  media_type: string;
  mediaType?: string;
  caption?: string;
  background_gradient?: string;
  backgroundGradient?: string;
  privacy: string;
  views_count: number;
  viewsCount?: number;
  is_viewed?: boolean;
  isViewed?: boolean;
  created_at_ms: number;
  createdAtMs?: number;
  expires_at_ms: number;
  expiresAtMs?: number;
}

export function mapStoryDtoToDomain(dto: StoryDto | StoryItem): StoryItem {
  const raw = dto as StoryDto & Partial<StoryItem>;
  const sid = raw.storyId ?? raw.story_id;
  return {
    storyId: sid,
    story_id: sid,
    userId: raw.userId ?? raw.user_id,
    username: raw.username,
    firstName: raw.firstName ?? raw.first_name,
    mediaId: raw.mediaId ?? raw.media_id,
    mediaType: raw.mediaType ?? raw.media_type ?? 'gradient',
    caption: raw.caption,
    backgroundGradient: raw.backgroundGradient ?? raw.background_gradient,
    privacy: raw.privacy ?? 'everyone',
    viewsCount: raw.viewsCount ?? raw.views_count ?? 0,
    isViewed: Boolean(raw.isViewed ?? raw.is_viewed),
    createdAtMs: raw.createdAtMs ?? raw.created_at_ms,
    expiresAtMs: raw.expiresAtMs ?? raw.expires_at_ms,
  };
}

export interface StoryGroup {
  userId: number;
  username?: string;
  firstName: string;
  avatarMediaId?: string;
  hasUnviewed: boolean;
  stories: StoryItem[];
}

export interface MediaThumbnail {
  file_id: string;
  width: number;
  height: number;
  data_base64?: string;
}

export interface MediaDescriptor {
  file_id: string;
  sha256?: string;
  file_name?: string;
  mime_type: string;
  size_bytes: number;
  url?: string;
  width?: number;
  height?: number;
  duration_seconds?: number;
  waveform?: number[];
  waveform_b64?: string;
  has_spoiler?: boolean;
  thumbnail?: MediaThumbnail;
  caption?: string;
}

export interface PollOption {
  option_id: number;
  text: string;
  vote_count: number;
  is_chosen: boolean;
  percentage: number;
  voter_ids?: number[];
}

export interface PollData {
  id: string;
  poll_id: number;
  question: string;
  options: PollOption[];
  total_voters: number;
  total_votes?: number;
  is_closed: boolean;
  is_anonymous: boolean;
  allows_multiple_answers: boolean;
  is_quiz: boolean;
  correct_option_id?: number;
  solution?: string;
  explanation?: string;
  solution_entities?: WireMessageEntity[];
  close_period?: number;
  close_date?: number;
}

export type PollCard = PollData;

export type CardActionType = 'callback' | 'url' | 'mini_app' | 'toggle_todo';

export interface CardActionButton {
  id: string;
  label: string;
  action_type: CardActionType;
  payload: string;
}

export interface TodoItem {
  id: string;
  title: string;
  completed: boolean;
  assignee?: string;
  completed_at_ms?: number;
}

export interface TodoListCard {
  id: string;
  list_id: string;
  title: string;
  items: TodoItem[];
  completed_count: number;
  action_buttons: CardActionButton[];
}

export type TodoCard = TodoListCard;

export type PaymentStatus =
  | 'draft'
  | 'pending'
  | 'requires_action'
  | 'authorized'
  | 'paid'
  | 'refunded'
  | 'cancelled'
  | 'failed';

export interface PriceLine {
  label: string;
  amount_cents: number;
}

export interface InvoiceCard {
  id: string;
  invoice_id: string;
  title: string;
  description: string;
  currency: string; // 'XTR' | 'TON' | 'USD' | ...
  amount_cents: number;
  total_amount: number;
  status: PaymentStatus;
  is_paid: boolean;
  receipt_id?: string;
  payload?: string;
  provider_id?: string;
  prices: PriceLine[];
}

export interface GiftCard {
  gift_id: string;
  emoji: string;
  title: string;
  stars: number;
  from_user_id: number;
  to_user_id?: number;
  message?: string;
}

export interface LocationCard {
  latitude: number;
  longitude: number;
  title?: string;
  address?: string;
  live_period_secs?: number;
}

export interface ContactCard {
  user_id?: number;
  first_name: string;
  last_name?: string;
  phone_number: string;
  vcard?: string;
}

export interface WebPagePreview {
  url: string;
  display_url: string;
  site_name?: string;
  title?: string;
  description?: string;
  image_file_id?: string;
  instant_view_available?: boolean;
  instant_view_blocks?: Array<{
    kind: 'heading' | 'paragraph' | 'code' | 'quote' | 'image';
    text: string;
  }>;
}

export type GenerativeCardLayout = 'VerticalStack' | 'HorizontalRow' | 'KeyValueGrid';

export type GenerativeComponent =
  | { type: 'Text'; text: string; bold: boolean; color: string | null }
  | { type: 'Badge'; label: string; color: string }
  | { type: 'Progress'; value: number; max: number; label: string | null }
  | { type: 'Button'; id: string; label: string; action_payload: string }
  | { type: 'Divider' };

export interface GenerativeCard {
  card_id: string;
  title: string;
  subtitle: string | null;
  layout: GenerativeCardLayout;
  components: GenerativeComponent[];
  status: string | null;
}

export function clampGenerativeProgress(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, value / max));
}

export interface VoiceContentData {
  file_id: string;
  duration_seconds: number;
  waveform: number[];
  waveform_b64?: string;
  mime_type: string;
  size_bytes: number;
  transcript?: string;
}

export interface VideoNoteContentData {
  file_id: string;
  duration_seconds: number;
  diameter: number;
  thumbnail?: MediaThumbnail;
  size_bytes: number;
}

export interface AlbumMediaItem {
  file_id: string;
  mime_type: string;
  width?: number;
  height?: number;
  size_bytes: number;
  has_spoiler?: boolean;
  caption?: string;
}

export type ServiceEventData =
  | { kind: 'chat_created'; title: string }
  | { kind: 'user_joined'; user_id: number }
  | { kind: 'user_left'; user_id: number }
  | { kind: 'title_changed'; new_title: string }
  | { kind: 'photo_changed'; photo_id: string | null }
  | { kind: 'message_pinned'; message_id: number }
  | { kind: 'call_ended'; call_id: string; duration_secs: number; is_video: boolean }
  | { kind: 'history_cleared' }
  | { kind: 'custom_text'; text: string };

export type MessageContent =
  | { type: 'Text'; data: { text: string; entities?: WireMessageEntity[] } }
  | { type: 'Media'; data: MediaDescriptor }
  | { type: 'Voice'; data: VoiceContentData }
  | { type: 'VideoNote'; data: VideoNoteContentData }
  | { type: 'Todo'; data: TodoListCard }
  | { type: 'Poll'; data: PollData }
  | { type: 'Invoice'; data: InvoiceCard }
  | { type: 'Gift'; data: GiftCard }
  | { type: 'Location'; data: LocationCard }
  | { type: 'Contact'; data: ContactCard }
  | { type: 'GenerativeCard'; data: GenerativeCard }
  | { type: 'Photo'; data: { file_id: string; caption: string | null; width: number; height: number; has_spoiler?: boolean } }
  | { type: 'Video'; data: { file_id: string; duration: number; width: number; height: number; caption: string | null; has_spoiler?: boolean } }
  | { type: 'Audio'; data: { file_id: string; duration: number; title: string | null; performer: string | null; size_bytes?: number } }
  | { type: 'Document'; data: { file_id: string; file_name: string; mime_type: string; size_bytes: number; caption?: string } }
  | { type: 'Sticker'; data: { file_id: string; emoji: string; set_id?: string; width: number; height: number; is_animated?: boolean } }
  | { type: 'Gif'; data: { file_id: string; url?: string; width: number; height: number; caption?: string } }
  | { type: 'Album'; data: { items: AlbumMediaItem[]; caption?: string; entities?: WireMessageEntity[] } }
  | { type: 'Service'; data: ServiceEventData }
  | { type: 'Encrypted'; data: EncryptedEnvelope };

export interface ReplyHeader {
  reply_to_msg_id: number;
  reply_to_peer_id?: WirePeerId;
  reply_to_top_id?: number;
  quote_text?: string;
  quote_entities?: WireMessageEntity[];
  sender_name?: string;
  preview_text?: string;
}

export interface ForwardInfo {
  from_id?: WirePeerId;
  from_name?: string;
  date: number;
  original_message_id?: number;
  hidden_sender?: boolean;
}

export interface ReactionCount {
  emoji: string;
  count: number;
  is_chosen_by_me: boolean;
  chosen?: boolean;
  user_ids?: number[];
}

export interface ReactionDetail {
  emoji: string;
  count: number;
  chosen: boolean;
  user_ids: number[];
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
  web_app_url?: string;
}

export interface MessageFlags {
  is_out: boolean;
  is_pinned: boolean;
  is_silent: boolean;
  is_edited: boolean;
  is_scheduled: boolean;
  media_unread: boolean;
  has_reactions: boolean;
  no_forwards: boolean;
  is_forwarded: boolean;
  is_unread?: boolean;
  is_mentioned?: boolean;
  is_post?: boolean;
}

export interface DeleteTombstone {
  chat_id: WirePeerId | number;
  message_ids: number[];
  deleted_at: string;
  for_everyone: boolean;
  timestamp_ms: number;
}

export interface MessageItem {
  id: number;
  chat_id: number;
  peer_id: WirePeerId;
  to_peer: WirePeerId;
  sender_id: number;
  send_as_peer_id?: number;
  topic_id?: number;
  flags: MessageFlags;
  date: string; // ISO-8601 UTC
  date_ms?: number;
  edit_date?: string;
  isEdited?: boolean;
  text?: string;
  entities?: MessageEntity[];
  content: MessageContent;
  reply_to?: ReplyHeader;
  forward_info?: ForwardInfo;
  reactions: ReactionCount[];
  client_nonce?: number;
  inline_keyboard?: InlineKeyboardButton[][];
  web_page?: WebPagePreview;
  views?: number;
  forwards?: number;
  ttl_seconds?: number;
  expires_at_ms?: number;
  delivery_status?: 'sending' | 'sent' | 'read' | 'failed';
}

export function extractPlainTextFromContent(content: MessageContent): string {
  switch (content.type) {
    case 'Text':
      return content.data.text;
    case 'Media':
      return content.data.caption ?? `[Media: ${content.data.file_name ?? content.data.mime_type}]`;
    case 'Photo':
      return content.data.caption ?? '[Photo]';
    case 'Video':
      return content.data.caption ?? '[Video]';
    case 'Audio':
      return content.data.title ?? '[Audio]';
    case 'Voice':
      return content.data.transcript ?? '[Voice Message]';
    case 'VideoNote':
      return '[Video Message]';
    case 'Document':
      return content.data.caption ?? `[File: ${content.data.file_name}]`;
    case 'Sticker':
      return `${content.data.emoji} Sticker`;
    case 'Gif':
      return content.data.caption ?? '[GIF]';
    case 'Album':
      return content.data.caption ?? `[Album (${content.data.items.length} items)]`;
    case 'Poll':
      return `📊 ${content.data.question}`;
    case 'Todo':
      return `☑️ ${content.data.title}`;
    case 'Invoice':
      return `💳 ${content.data.title}`;
    case 'Gift':
      return `${content.data.emoji} ${content.data.title}`;
    case 'Location':
      return `📍 ${content.data.title ?? `${content.data.latitude}, ${content.data.longitude}`}`;
    case 'Contact':
      return `👤 ${content.data.first_name}`;
    case 'GenerativeCard':
      return content.data.title;
    case 'Service':
      return content.data.kind === 'custom_text' ? content.data.text : `[${content.data.kind}]`;
    case 'Encrypted':
      return '🔐 Encrypted Message';
  }
}

export function enrichMessageItem(item: MessageItem): MessageItem {
  const text = item.text ?? extractPlainTextFromContent(item.content);
  const entities =
    item.entities ??
    (item.content.type === 'Text' && item.content.data.entities
      ? item.content.data.entities.map(fromWireMessageEntity)
      : []);
  return {
    ...item,
    text,
    entities,
    isEdited: Boolean(item.flags?.is_edited || item.edit_date),
    date_ms: item.date_ms ?? Date.parse(item.date),
  };
}

export function createTextContent(text: string, entities?: MessageEntity[]): MessageContent {
  return {
    type: 'Text',
    data: {
      text,
      entities: entities ? entities.map(toWireMessageEntity) : [],
    },
  };
}

// ============================================================================
// Auth, Session, Contacts, Privacy, Search, Stats, Media & Calls DTOs
// ============================================================================

export interface ServerStatusResponse {
  server: string;
  status: string;
  version: string;
  capabilities: string[];
}

export interface CreateChatRequest {
  title?: string;
  chat_type?: number | string;
  peer_user_id?: number;
  username?: string;
  about?: string;
  is_forum?: boolean;
  member_ids?: number[];
  member_usernames?: string[];
  client_nonce?: string;
}

export interface SendMessageRequest {
  chat_id?: number;
  text?: string;
  content?: MessageContent;
  entities?: Array<MessageEntity | WireMessageEntity>;
  parse_markdown?: boolean;
  reply_to?: number | { reply_to_msg_id: number; quote_text?: string };
  reply_to_id?: number;
  quote_text?: string;
  topic_id?: number;
  client_nonce?: number;
  forward_from_chat_id?: number;
  forward_from_msg_id?: number;
  forward_info?: ForwardInfo;
  silent?: boolean;
  schedule_at_ms?: number;
  scheduled_at_ms?: number;
  ttl_seconds?: number;
  inline_keyboard?: InlineKeyboardButton[][];
  send_as_peer_id?: number;
  skip_server_bot_reply?: boolean;
}

export type SendMessageHttpRequest = SendMessageRequest;

export interface AuthResponse {
  user_id: number;
  username: string;
  session_id: string;
  token: string;
  first_name?: string;
  last_name?: string;
  expires_at_ms?: number;
  user?: UserProfileDto;
  account_generation?: number;
  created_at?: string;
  expires_at?: string;
  auth_version?: AuthVersion;
}

export interface SessionDto {
  session_id: string;
  device_name: string;
  platform?: string;
  ip_address?: string;
  created_at_ms: number;
  last_active_ms: number;
  expires_at_ms?: number;
  is_current: boolean;
}

export interface TwoFactorStatusDto {
  enabled: boolean;
  has_password: boolean;
  hint?: string;
  recovery_email?: string | null;
  updated_at_ms?: number;
}

export interface QrPairSessionDto {
  pair_id: string;
  pair_token: string;
  qr_url: string;
  svg: string;
  status: 'pending' | 'approved' | 'expired';
  expires_at_ms: number;
  token?: string;
  session?: AuthResponse;
  user?: UserProfileDto;
}

export interface UserPrivacySettingsDto {
  phone_privacy: string;
  last_seen_privacy: string;
  photo_privacy: string;
  calls_privacy: string;
  forwards_privacy: string;
  groups_privacy: string;
  ttl_months: number;
  global_ttl_seconds: number;
  sensitive_content_enabled: boolean;
  passcode_enabled: boolean;
  notifications_private: boolean;
  notifications_groups: boolean;
  notifications_channels: boolean;
  notifications_sound: boolean;
  include_muted_in_badge: boolean;
  badge_count_messages: boolean;
  p2p_mode: string;
  accept_calls: boolean;
  is_premium: boolean;
}

export interface ChatMemberDto {
  user_id: number;
  username?: string;
  first_name: string;
  last_name?: string;
  role: 'owner' | 'admin' | 'member' | 'restricted' | 'banned';
  admin_rights: number;
  banned_rights: number;
  custom_title?: string;
  joined_at_ms: number;
}

export interface InviteLinkDto {
  invite_id: string;
  chat_id: number;
  creator_id: number;
  link: string;
  code: string;
  title?: string;
  usage_limit: number | null;
  usage_count: number;
  expire_date_ms: number | null;
  request_needed: boolean;
  is_revoked: boolean;
  created_at_ms: number;
}

export type SearchTabCategory =
  | 'chats'
  | 'messages'
  | 'apps'
  | 'media'
  | 'links'
  | 'files'
  | 'music'
  | 'voice';

export interface SearchHitDto {
  chat_id: number;
  chat_title?: string;
  message_id: number;
  sender_id: number;
  sender_name?: string;
  topic_id?: number;
  date_ms: number;
  text: string;
  snippet_html: string;
  media_type?: string;
}

export interface GlobalSearchResponse {
  query: string;
  tab: SearchTabCategory;
  total: number;
  chats: ChatDetailDto[];
  users: UserProfileDto[];
  apps: Array<{ app_id: string; bot_username: string; short_name: string; title: string; description: string }>;
  hits: SearchHitDto[];
  messages: SearchHitDto[];
}

export interface DailyStatPoint {
  day: string;
  date?: string;
  timestamp_ms: number;
  messages: number;
  views: number;
  members: number;
  reactions: number;
  active_senders: number;
}

export interface ChannelStatisticsDto {
  chat_id: number;
  title: string;
  member_count: number;
  total_messages: number;
  messages_last_7d: number;
  views_per_post: number;
  shares_per_post: number;
  enabled_notifications_pct: number;
  boosts_count: number;
  total_reactions: number;
  active_posters_7d: number;
  growth_rate_pct: number;
  daily_series: DailyStatPoint[];
  daily_growth: Array<{ date: string; members: number; views: number }>;
  top_emojis: [string, number][];
}

export interface StickerItemDto {
  id: string;
  set_id: string;
  emoji: string;
  file_id?: string;
  svg_data_url?: string;
  mime_type: string;
  width: number;
  height: number;
  is_animated: boolean;
  is_video: boolean;
}

export interface StickerSetDto {
  set_id: string;
  short_name: string;
  title: string;
  count: number;
  is_installed: boolean;
  stickers: StickerItemDto[];
}

export interface GifResultDto {
  id: string;
  title: string;
  file_id: string;
  url: string;
  preview_url: string;
  width: number;
  height: number;
  mime_type: string;
}

export type CallStateKind =
  | 'idle'
  | 'dialing'
  | 'ringing'
  | 'connecting'
  | 'active'
  | 'connected'
  | 'ended'
  | 'failed';

export interface CallSessionState {
  call_id: string;
  chat_id?: number;
  caller_id: number;
  callee_id: number;
  is_video: boolean;
  is_screen_sharing?: boolean;
  is_muted?: boolean;
  is_minimized?: boolean;
  state: CallStateKind;
  duration_secs: number;
  rating?: number;
  key_fingerprint?: string;
  emoji_fingerprint?: string[];
  participants?: number[];
  started_at_ms: number;
  ended_at_ms?: number;
}

export interface CallSignalPayload {
  call_id: string;
  chat_id?: number;
  from_user_id?: number;
  target_user_id?: number;
  signal_type: 'ringing' | 'accept' | 'offer' | 'answer' | 'ice_candidate' | 'hangup' | string;
  sdp?: string;
  candidate?: string;
  sdp_mid?: string;
  sdp_mline_index?: number;
  reason?: string;
}

export interface TurnCredentialsDto {
  username: string;
  credential: string;
  uris: string[];
  ttl_seconds: number;
  expires_at: number;
}

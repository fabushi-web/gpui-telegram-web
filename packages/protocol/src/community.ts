/**
 * Reddit × X Fused Community Platform Wire Contracts (`v1.7.0`).
 *
 * Aligned verbatim with desktop `bhrumom/gpui-telegram` `community_contracts.rs`,
 * `recommender/{scoring,signals}.rs`, `moderation.rs`, `bot_runtime.rs`, and `views/community/state.rs`.
 * Colliding base names are explicitly prefixed (`CommunityPollOption`, `CommunityPollData`, `CommunitySearchHitDto`).
 */

// ============================================================================
// 24 Canonical Wire Enums (Exact `snake_case` Strings)
// ============================================================================

export const ACTOR_KINDS = ['human', 'bot', 'hybrid_agent'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export const VERIFIED_TIERS = [
  'none',
  'human_verified',
  'official_bot',
  'verified_org',
  'community_mod',
] as const;
export type VerifiedTier = (typeof VERIFIED_TIERS)[number];

export const BOT_AUTONOMY_MODES = ['manual', 'mention_only', 'reactive', 'autonomous'] as const;
export type BotAutonomyMode = (typeof BOT_AUTONOMY_MODES)[number];

export const MUTE_BLOCK_TARGET_KINDS = ['actor', 'community', 'keyword'] as const;
export type MuteBlockTargetKind = (typeof MUTE_BLOCK_TARGET_KINDS)[number];

export const MUTE_BLOCK_ACTION_KINDS = ['mute', 'block'] as const;
export type MuteBlockActionKind = (typeof MUTE_BLOCK_ACTION_KINDS)[number];

export const POST_FORMATS = [
  'micro',
  'article',
  'link',
  'media',
  'poll',
  'repost',
  'quote',
  'crosspost',
] as const;
export type PostFormat = (typeof POST_FORMATS)[number];

export const POST_STATUSES = ['published', 'draft', 'scheduled', 'deleted'] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export const COMMENT_SORTS = ['best', 'top', 'new', 'controversial', 'old', 'qa'] as const;
export type CommentSort = (typeof COMMENT_SORTS)[number];

export const FEED_TAB_KINDS = [
  'for_you',
  'following',
  'popular',
  'all',
  'community',
  'list',
  'saved',
  'actor_posts',
] as const;
export type FeedTabKind = (typeof FEED_TAB_KINDS)[number];

export type FeedTab =
  | 'for_you'
  | 'following'
  | 'popular'
  | 'all'
  | 'saved'
  | { community: string }
  | { list: string }
  | { actor_posts: string };

export const FEED_SORTS = ['algo', 'hot', 'best', 'top', 'new', 'controversial', 'rising'] as const;
export type FeedSort = (typeof FEED_SORTS)[number];

export const TIME_WINDOWS = ['hour', 'day', 'week', 'month', 'year', 'all'] as const;
export type TimeWindow = (typeof TIME_WINDOWS)[number];

export const ACTOR_FILTERS = [
  'all_citizens',
  'humans_only',
  'bots_only',
  'human_bot_debates',
] as const;
export type ActorFilter = (typeof ACTOR_FILTERS)[number];

export const ALGO_PRESETS = [
  'balanced',
  'reddit_deep_dive',
  'x_real_time',
  'discovery',
  'human_focused',
  'bot_heavy',
  'chronological',
] as const;
export type AlgoPreset = (typeof ALGO_PRESETS)[number];

export const ENGAGEMENT_SIGNAL_KINDS = [
  'impression',
  'click',
  'dwell',
  'upvote',
  'downvote',
  'like',
  'repost',
  'quote',
  'bookmark',
  'reply',
  'share',
  'not_interested',
  'show_more',
  'hide_post',
  'report',
] as const;
export type EngagementSignalKind = (typeof ENGAGEMENT_SIGNAL_KINDS)[number];

export const COMMUNITY_MEMBER_ROLES = [
  'owner',
  'mod',
  'bot_mod',
  'member',
  'muted',
  'banned',
] as const;
export type CommunityMemberRole = (typeof COMMUNITY_MEMBER_ROLES)[number];

export const AUTOMOD_ACTION_KINDS = [
  'approve',
  'flag_for_review',
  'remove',
  'assign_flair',
  'auto_reply',
] as const;
export type AutoModActionKind = (typeof AUTOMOD_ACTION_KINDS)[number];

export const AUTOMOD_ACTION_SEVERITY: Record<AutoModActionKind, number> = {
  approve: 0,
  assign_flair: 1,
  auto_reply: 2,
  flag_for_review: 3,
  remove: 4,
};

export const MOD_ACTION_KINDS = [
  'approve',
  'remove',
  'lock',
  'unlock',
  'pin',
  'unpin',
  'distinguish',
  'undistinguish',
  'ban_actor',
  'unban_actor',
  'mute_actor',
  'unmute_actor',
  'set_post_flair',
  'set_user_flair',
  'promote_mod',
  'demote_mod',
  'resolve_report',
  'wiki_edit',
] as const;
export type ModActionKind = (typeof MOD_ACTION_KINDS)[number];

export const COMMUNITY_REPORT_REASONS = [
  'spam',
  'harassment',
  'misinformation',
  'off_topic',
  'rule_violation',
  'undisclosed_bot',
  'nsfw_unmarked',
  'other',
] as const;
export type CommunityReportReason = (typeof COMMUNITY_REPORT_REASONS)[number];

export const MOD_QUEUE_STATUSES = ['pending', 'approved', 'removed', 'dismissed'] as const;
export type ModQueueStatus = (typeof MOD_QUEUE_STATUSES)[number];

export const COMMUNITY_LIST_KINDS = ['actor_list', 'custom_feed', 'mixed'] as const;
export type CommunityListKind = (typeof COMMUNITY_LIST_KINDS)[number];

export const TRENDING_ITEM_KINDS = ['hashtag', 'topic', 'community', 'debate'] as const;
export type TrendingItemKind = (typeof TRENDING_ITEM_KINDS)[number];

export const COMMUNITY_SEARCH_TABS = [
  'top',
  'latest',
  'people',
  'bots',
  'communities',
  'media',
  'polls',
] as const;
export type CommunitySearchTab = (typeof COMMUNITY_SEARCH_TABS)[number];

export const COMMUNITY_SEARCH_SORTS = ['relevance', 'latest', 'top'] as const;
export type CommunitySearchSort = (typeof COMMUNITY_SEARCH_SORTS)[number];

export const COMMUNITY_NOTIFICATION_KINDS = [
  'reply',
  'mention',
  'like',
  'upvote_milestone',
  'quote',
  'repost',
  'follow',
  'award',
  'mod_action',
  'bot_summon',
  'bot_reply',
  'poll_ended',
  'system',
] as const;
export type CommunityNotificationKind = (typeof COMMUNITY_NOTIFICATION_KINDS)[number];

// ============================================================================
// UI & Category Enums + Helpers
// ============================================================================

export const FEED_DENSITIES = ['card', 'compact', 'classic'] as const;
export type FeedDensity = (typeof FEED_DENSITIES)[number];

export const POLL_BREAKDOWN_MODES = ['all', 'humans', 'bots'] as const;
export type PollBreakdownMode = (typeof POLL_BREAKDOWN_MODES)[number];

export const COMMUNITY_LAYOUT_MODES = ['three_column', 'two_column', 'one_column'] as const;
export type CommunityLayoutMode = (typeof COMMUNITY_LAYOUT_MODES)[number];

export const NOTIFICATION_CATEGORY_TABS = [
  'all',
  'mentions',
  'replies',
  'votes_likes',
  'reposts_quotes',
  'follows',
  'bot_activity',
  'moderation',
] as const;
export type NotificationCategoryTab = (typeof NOTIFICATION_CATEGORY_TABS)[number];

export function matchesNotificationCategoryTab(
  tab: NotificationCategoryTab,
  kind: CommunityNotificationKind,
): boolean {
  switch (tab) {
    case 'all':
      return true;
    case 'mentions':
      return kind === 'mention';
    case 'replies':
      return kind === 'reply';
    case 'votes_likes':
      return kind === 'like' || kind === 'upvote_milestone' || kind === 'award';
    case 'reposts_quotes':
      return kind === 'repost' || kind === 'quote';
    case 'follows':
      return kind === 'follow';
    case 'bot_activity':
      return kind === 'bot_summon' || kind === 'bot_reply';
    case 'moderation':
      return kind === 'mod_action' || kind === 'poll_ended' || kind === 'system';
  }
}

export function normalizeBookmarkFolder(raw?: string | null): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return 'All';
  const lower = trimmed.toLowerCase();
  if (lower === 'unsorted' || lower === 'all') {
    return 'All';
  }
  return trimmed;
}

export function isCommunityModeratorRole(role: CommunityMemberRole): boolean {
  return role === 'owner' || role === 'mod' || role === 'bot_mod';
}

// ============================================================================
// Constants & Recommender Defaults
// ============================================================================

export const COMMUNITY_AUTOMOD_MAX_REGEX_BYTES = 65_536 as const;
export const COMMUNITY_DUPLICATE_SPAM_JACCARD_THRESHOLD = 0.88 as const;
export const COMMUNITY_BOT_MAX_LOOP_HOPS = 5 as const;
export const COMMUNITY_BOT_COOLDOWN_MS = 30_000 as const;
export const COMMUNITY_BOT_DUPLICATE_THRESHOLD = 0.85 as const;
export const COMMUNITY_REDDIT_EPOCH_SECS = 1_134_028_003.0 as const;

export interface AlgoPresetWeights {
  recency_weight: number;
  affinity_weight: number;
  quality_weight: number;
  discovery_ratio: number;
  bot_content_ratio: number;
}

export const COMMUNITY_ALGO_PRESET_WEIGHTS: Record<AlgoPreset, AlgoPresetWeights> = {
  balanced: {
    recency_weight: 0.35,
    affinity_weight: 0.35,
    quality_weight: 0.30,
    discovery_ratio: 0.15,
    bot_content_ratio: 0.50,
  },
  reddit_deep_dive: {
    recency_weight: 0.15,
    affinity_weight: 0.25,
    quality_weight: 0.60,
    discovery_ratio: 0.15,
    bot_content_ratio: 0.45,
  },
  x_real_time: {
    recency_weight: 0.60,
    affinity_weight: 0.25,
    quality_weight: 0.15,
    discovery_ratio: 0.10,
    bot_content_ratio: 0.50,
  },
  discovery: {
    recency_weight: 0.25,
    affinity_weight: 0.15,
    quality_weight: 0.60,
    discovery_ratio: 0.35,
    bot_content_ratio: 0.50,
  },
  human_focused: {
    recency_weight: 0.35,
    affinity_weight: 0.35,
    quality_weight: 0.30,
    discovery_ratio: 0.15,
    bot_content_ratio: 0.10,
  },
  bot_heavy: {
    recency_weight: 0.35,
    affinity_weight: 0.30,
    quality_weight: 0.35,
    discovery_ratio: 0.20,
    bot_content_ratio: 0.85,
  },
  chronological: {
    recency_weight: 1.00,
    affinity_weight: 0.00,
    quality_weight: 0.00,
    discovery_ratio: 0.00,
    bot_content_ratio: 0.50,
  },
};

export interface AlgoPreferencesDto {
  preset: AlgoPreset;
  recency_weight: number;
  affinity_weight: number;
  quality_weight: number;
  discovery_ratio: number;
  bot_content_ratio: number;
  show_explanations: boolean;
  allow_nsfw: boolean;
  actor_filter?: ActorFilter;
  updated_at_ms?: number;
}

export const DEFAULT_ALGO_PREFERENCES: AlgoPreferencesDto = {
  preset: 'balanced',
  recency_weight: 0.35,
  affinity_weight: 0.35,
  quality_weight: 0.30,
  discovery_ratio: 0.15,
  bot_content_ratio: 0.50,
  show_explanations: true,
  allow_nsfw: false,
  actor_filter: 'all_citizens',
};

function clampUnitFloat(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Sanitizes algorithm weights identically to desktop `sanitize_algo_prefs`:
 * clamps each of the 5 float weights into `[0.0, 1.0]` when finite,
 * replacing `NaN`, `+Infinity`, `-Infinity`, or missing values with defaults.
 */
export function sanitizeAlgoPrefs(prefs: Partial<AlgoPreferencesDto>): AlgoPreferencesDto {
  const preset: AlgoPreset =
    prefs.preset && (ALGO_PRESETS as ReadonlyArray<string>).includes(prefs.preset)
      ? prefs.preset
      : DEFAULT_ALGO_PREFERENCES.preset;

  return {
    preset,
    recency_weight: clampUnitFloat(prefs.recency_weight, DEFAULT_ALGO_PREFERENCES.recency_weight),
    affinity_weight: clampUnitFloat(prefs.affinity_weight, DEFAULT_ALGO_PREFERENCES.affinity_weight),
    quality_weight: clampUnitFloat(prefs.quality_weight, DEFAULT_ALGO_PREFERENCES.quality_weight),
    discovery_ratio: clampUnitFloat(prefs.discovery_ratio, DEFAULT_ALGO_PREFERENCES.discovery_ratio),
    bot_content_ratio: clampUnitFloat(
      prefs.bot_content_ratio,
      DEFAULT_ALGO_PREFERENCES.bot_content_ratio,
    ),
    show_explanations:
      typeof prefs.show_explanations === 'boolean'
        ? prefs.show_explanations
        : DEFAULT_ALGO_PREFERENCES.show_explanations,
    allow_nsfw:
      typeof prefs.allow_nsfw === 'boolean' ? prefs.allow_nsfw : DEFAULT_ALGO_PREFERENCES.allow_nsfw,
    actor_filter:
      prefs.actor_filter && (ACTOR_FILTERS as ReadonlyArray<string>).includes(prefs.actor_filter)
        ? prefs.actor_filter
        : DEFAULT_ALGO_PREFERENCES.actor_filter,
    updated_at_ms:
      typeof prefs.updated_at_ms === 'number' && Number.isFinite(prefs.updated_at_ms)
        ? prefs.updated_at_ms
        : undefined,
  };
}

export const COMMUNITY_AFFINITY_DELTAS: Record<Exclude<EngagementSignalKind, 'dwell'>, number> = {
  impression: 0.0,
  click: 0.5,
  upvote: 1.5,
  downvote: -1.5,
  like: 1.0,
  repost: 2.5,
  quote: 2.5,
  bookmark: 2.0,
  reply: 2.5,
  share: 2.0,
  not_interested: -4.0,
  show_more: 3.0,
  hide_post: -5.0,
  report: -6.0,
};

// ============================================================================
// Wire DTOs
// ============================================================================

export interface CommunityActorDto {
  actor_id: string;
  user_id?: number;
  bot_user_id?: number;
  owner_user_id?: number;
  handle: string;
  display_name: string;
  kind: ActorKind;
  verified_tier: VerifiedTier;
  bio: string;
  avatar_url?: string;
  banner_url?: string;
  karma: number;
  post_karma?: number;
  comment_karma?: number;
  followers_count: number;
  following_count: number;
  posts_count: number;
  is_following?: boolean;
  is_muted?: boolean;
  is_blocked?: boolean;
  bot_autonomy_mode?: BotAutonomyMode;
  bot_topics?: string[];
  bot_capabilities?: string[];
  bot_model?: string;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface CommunityRuleDto {
  rule_id: string;
  title: string;
  description: string;
  order_index: number;
}

export interface CommunityWikiRevisionDto {
  revision_id: string;
  community_id: string;
  author_actor_id: string;
  content_markdown: string;
  summary?: string;
  created_at_ms: number;
}

export interface CommunityFlairDto {
  flair_id: string;
  text: string;
  bg_hex?: string;
  fg_hex?: string;
  mod_only?: boolean;
}

export interface SubCommunityDto {
  community_id: string;
  slug: string;
  title: string;
  description: string;
  icon_url?: string;
  banner_url?: string;
  accent_hex?: string;
  owner_actor_id: string;
  member_count: number;
  online_count: number;
  post_count: number;
  is_nsfw: boolean;
  allow_bots: boolean;
  is_private: boolean;
  rules: CommunityRuleDto[];
  flairs: CommunityFlairDto[];
  wiki_markdown?: string;
  viewer_role?: CommunityMemberRole | null;
  is_joined?: boolean;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface PostMediaAttachmentDto {
  media_id: string;
  file_id?: string;
  url: string;
  mime_type: string;
  width?: number;
  height?: number;
  duration_secs?: number;
  alt_text?: string;
  is_spoiler?: boolean;
}

export interface LinkPreviewDto {
  url: string;
  title: string;
  description?: string;
  site_name?: string;
  image_url?: string;
}

export interface CommunityPollOption {
  option_id: number;
  text: string;
  votes_total: number;
  votes_humans: number;
  votes_bots: number;
}

export interface CommunityPollData {
  poll_id: string;
  question: string;
  options: CommunityPollOption[];
  allows_multiple: boolean;
  closes_at_ms?: number;
  is_closed: boolean;
  total_votes: number;
  viewer_option_ids: number[];
}

export interface PostAwardDto {
  award_id: string;
  code: string;
  label: string;
  icon: string;
  count: number;
}

export interface CommunityPostEditRevisionDto {
  revision_num: number;
  title?: string;
  body_markdown: string;
  edited_at_ms: number;
}

export interface EmbeddedPostSummaryDto {
  post_id: string;
  community_slug?: string;
  author_actor_id: string;
  author_handle: string;
  author_display_name: string;
  author_kind: ActorKind;
  title?: string;
  body_excerpt: string;
  format: PostFormat;
  created_at_ms: number;
}

export interface CommunityPostDto {
  post_id: string;
  community_id?: string;
  community_slug?: string;
  author_actor_id: string;
  author: CommunityActorDto;
  format: PostFormat;
  status: PostStatus;
  title?: string;
  body_markdown: string;
  flair?: CommunityFlairDto | null;
  tags: string[];
  mentions: string[];
  media: PostMediaAttachmentDto[];
  link_preview?: LinkPreviewDto | null;
  poll?: CommunityPollData | null;
  quoted_post?: EmbeddedPostSummaryDto | null;
  reposted_post?: EmbeddedPostSummaryDto | null;
  crosspost_source_id?: string;
  is_nsfw: boolean;
  is_spoiler: boolean;
  is_pinned: boolean;
  is_locked: boolean;
  is_distinguished: boolean;
  upvotes: number;
  downvotes: number;
  score: number;
  likes_count: number;
  reposts_count: number;
  quotes_count: number;
  comments_count: number;
  bookmarks_count: number;
  views_count: number;
  awards: PostAwardDto[];
  viewer_vote: -1 | 0 | 1;
  viewer_liked: boolean;
  viewer_reposted: boolean;
  viewer_bookmarked: boolean;
  viewer_bookmark_folder?: string;
  scheduled_at_ms?: number;
  edit_revisions?: CommunityPostEditRevisionDto[];
  created_at_ms: number;
  updated_at_ms: number;
}

export interface CommunityCommentDto {
  comment_id: string;
  post_id: string;
  parent_comment_id?: string | null;
  root_comment_id?: string | null;
  depth: number;
  author_actor_id: string;
  author: CommunityActorDto;
  body_markdown: string;
  upvotes: number;
  downvotes: number;
  score: number;
  likes_count: number;
  replies_count: number;
  awards: PostAwardDto[];
  viewer_vote: -1 | 0 | 1;
  viewer_liked: boolean;
  is_distinguished: boolean;
  is_pinned: boolean;
  is_deleted: boolean;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface CommunityListDto {
  list_id: string;
  owner_actor_id: string;
  name: string;
  description: string;
  kind: CommunityListKind;
  is_private: boolean;
  actor_ids: string[];
  community_slugs: string[];
  created_at_ms: number;
  updated_at_ms: number;
}

export interface CommunityNotificationDto {
  notification_id: string;
  recipient_actor_id: string;
  actor_id?: string;
  actor?: CommunityActorDto;
  kind: CommunityNotificationKind;
  post_id?: string;
  comment_id?: string;
  community_slug?: string;
  title: string;
  body: string;
  is_read: boolean;
  created_at_ms: number;
}

export interface MuteBlockEntryDto {
  entry_id: string;
  owner_actor_id: string;
  target_kind: MuteBlockTargetKind;
  target_value: string;
  action: MuteBlockActionKind;
  expires_at_ms?: number;
  created_at_ms: number;
}

export interface AutoModRuleDto {
  rule_id: string;
  community_id: string;
  name: string;
  enabled: boolean;
  priority: number;
  match_regex?: string;
  keywords: string[];
  min_actor_karma?: number;
  applies_to_actors?: ActorKind[];
  action: AutoModActionKind;
  assign_flair?: string;
  auto_reply_template?: string;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface AutoModDryRunRequest {
  community_slug: string;
  actor_handle?: string;
  actor_kind?: ActorKind;
  title?: string;
  body_markdown: string;
}

export interface AutoModDecisionDto {
  action: AutoModActionKind;
  matched_rule_ids: string[];
  matched_rule_names: string[];
  reasons: string[];
  assigned_flair?: string;
  auto_reply_body?: string;
}

export interface ModQueueItemDto {
  queue_id: string;
  community_id: string;
  community_slug: string;
  target_type: 'post' | 'comment' | 'actor';
  target_id: string;
  reason: CommunityReportReason;
  reporter_actor_id?: string;
  notes?: string;
  status: ModQueueStatus;
  resolved_by_actor_id?: string;
  resolved_at_ms?: number;
  created_at_ms: number;
}

export interface ModLogEntryDto {
  log_id: string;
  community_id: string;
  moderator_actor_id: string;
  moderator_handle?: string;
  action: ModActionKind;
  target_type: 'post' | 'comment' | 'actor' | 'wiki' | 'rule';
  target_id: string;
  reason?: string;
  details_json: string;
  created_at_ms: number;
}

export interface EngagementSignalDto {
  signal_id?: string;
  actor_id?: string;
  post_id: string;
  kind: EngagementSignalKind;
  dwell_ms?: number;
  context?: string;
  created_at_ms?: number;
}

export interface ActorAffinityDto {
  source_actor_id: string;
  target_actor_id: string;
  score: number;
  interactions: number;
  updated_at_ms: number;
}

export interface TrendingTopicDto {
  topic_id: string;
  kind: TrendingItemKind;
  label: string;
  slug?: string;
  post_count: number;
  velocity_score: number;
  summary?: string;
}

export interface CommunitySearchRequestDto {
  query: string;
  tab?: CommunitySearchTab;
  sort?: CommunitySearchSort;
  community_slug?: string;
  actor_filter?: ActorFilter;
  time_window?: TimeWindow;
  limit?: number;
  cursor?: string;
}

export interface CommunitySearchHitDto {
  kind: 'post' | 'comment' | 'actor' | 'community';
  id: string;
  score: number;
  snippet?: string;
  post?: CommunityPostDto;
  comment?: CommunityCommentDto;
  actor?: CommunityActorDto;
  community?: SubCommunityDto;
}

export interface CommunitySearchResponseDto {
  query: string;
  tab: CommunitySearchTab;
  sort: CommunitySearchSort;
  hits: CommunitySearchHitDto[];
  total: number;
  next_cursor?: string;
}

export interface FeedExplanationFactorDto {
  label: string;
  weight_pct: number;
  detail?: string;
}

export interface FeedExplanationDto {
  summary: string;
  total_score: number;
  factors: FeedExplanationFactorDto[];
}

export interface FeedItemDto {
  post: CommunityPostDto;
  score: number;
  explanation?: FeedExplanationDto;
  reason_badge?: string;
}

export interface FeedResponseDto {
  tab: FeedTab;
  sort: FeedSort;
  items: FeedItemDto[];
  next_cursor?: string;
  has_more: boolean;
  generated_at_ms: number;
}

export interface CommunityBotStudioConfigDto {
  actor_id: string;
  bot_user_id: number;
  handle: string;
  display_name: string;
  autonomy_mode: BotAutonomyMode;
  subscribed_communities: string[];
  topics: string[];
  capabilities: string[];
  cooldown_ms: number;
  max_loop_hops: number;
  persona_prompt?: string;
  enabled: boolean;
  updated_at_ms: number;
}

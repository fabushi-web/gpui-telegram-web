/**
 * Creation Studio & Public Catalog Wire Contracts (`v1.7.0`).
 *
 * Aligned verbatim with desktop `bhrumom/gpui-telegram` `creation_contracts.rs`,
 * with dark-safe non-purple Content Hub accents (`235°..315°` strictly avoided).
 */

export const CREATOR_STUDIO_BOT_USERNAME = 'creator_studio_bot' as const;
export const CREATOR_STUDIO_BOT_USER_ID = 777_100 as const;
export const CREATOR_STUDIO_BOT_DISPLAY_NAME = 'CreatorStudioBot' as const;

export const MAX_CREATION_JSON_BYTES = 8_388_608 as const; // 8 MiB
export const MAX_COVER_BASE64_BYTES = 2_097_152 as const; // 2 MiB
export const MAX_REVIEW_NOTE_CHARS = 2_000 as const;
export const MAX_REVIEW_COMMENT_CHARS = 2_000 as const;
export const MAX_GENRES = 8 as const;
export const MAX_TAGS = 16 as const;
export const MAX_TITLE_CHARS = 160 as const;
export const MAX_SUBTITLE_CHARS = 240 as const;
export const MAX_SUMMARY_CHARS = 1_200 as const;

/**
 * Dark-safe Content Hub category accent hex tokens.
 * Every hue stays strictly outside the forbidden dark-purple band (`235°..315°`).
 */
export const CONTENT_HUB_ACCENTS = {
  books: '#FF9500',
  music: '#FA2D48',
  games: '#30D158',
  appstore: '#007AFF',
  creations: '#32ADE6',
  pending_review: '#FF9F0A',
} as const;

export type ContentHubAccentKey = keyof typeof CONTENT_HUB_ACCENTS;

export const CREATION_KINDS = ['book', 'music', 'game', 'app'] as const;
export type CreationKind = (typeof CREATION_KINDS)[number];

export const CREATION_VISIBILITIES = ['private', 'unlisted', 'public'] as const;
export type CreationVisibility = (typeof CREATION_VISIBILITIES)[number];

export const CREATION_REVIEW_STATUSES = [
  'draft',
  'pending_review',
  'approved',
  'rejected',
  'removed',
] as const;
export type CreationReviewStatus = (typeof CREATION_REVIEW_STATUSES)[number];

export const CREATION_REVIEW_DECISIONS = ['approve', 'reject', 'remove'] as const;
export type CreationReviewDecision = (typeof CREATION_REVIEW_DECISIONS)[number];

export type CreationKindPath = 'books' | 'music' | 'games' | 'appstore';

// ============================================================================
// Cover & Vertical Payload DTOs
// ============================================================================

export interface CoverArtwork {
  accent_hex: string;
  secondary_hex?: string;
  glyph?: string;
  thumbnail_b64?: string;
  image_url?: string;
}

export interface BookSectionDto {
  id: string;
  heading?: string;
  markdown: string;
}

export interface BookChapterDto {
  id: string;
  title: string;
  summary?: string;
  content_markdown: string;
  sections?: BookSectionDto[];
  estimated_read_mins?: number;
}

export interface BookTypographyDto {
  font_family?: 'serif' | 'sans' | 'mono';
  font_size_px?: number;
  line_height?: number;
  theme?: 'paper' | 'sepia' | 'night';
}

export interface BookPayload {
  chapters: BookChapterDto[];
  language?: string;
  word_count?: number;
  estimated_read_mins?: number;
  typography?: BookTypographyDto;
  reading_metadata?: {
    isbn?: string;
    edition?: string;
    author_note?: string;
  };
}

export interface MusicNoteEventDto {
  pitch: string; // e.g. 'C4', 'F#4'
  start_beat: number;
  duration_beats: number;
  velocity?: number; // 0..1
}

export interface MusicChordEventDto {
  symbol: string; // e.g. 'Cmaj7'
  notes: string[];
  start_beat: number;
  duration_beats: number;
}

export interface MusicInstrumentTrackDto {
  id: string;
  name: string;
  waveform: 'sine' | 'triangle' | 'sawtooth' | 'square';
  gain?: number;
  notes: MusicNoteEventDto[];
}

export interface MusicTrackPayload {
  bpm: number;
  musical_key?: string;
  time_signature?: string;
  duration_secs?: number;
  instruments?: MusicInstrumentTrackDto[];
  notes?: MusicNoteEventDto[];
  chords?: MusicChordEventDto[];
  lyrics?: Array<{ time_secs: number; text: string }> | string;
  audio_file_id?: string;
  waveform?: number[];
}

export type MiniGameMode = 'trivia' | 'quiz' | 'arcade' | 'puzzle';

export interface GameQuestionDto {
  id: string;
  prompt: string;
  choices: string[];
  correct_index: number;
  explanation?: string;
  points?: number;
  time_limit_secs?: number;
}

export interface GameLevelDto {
  id: string;
  name: string;
  difficulty?: 'easy' | 'normal' | 'hard';
  target_score?: number;
  speed?: number;
  grid?: number[][];
  config?: Record<string, unknown>;
}

export interface GameAchievementDto {
  id: string;
  title: string;
  description: string;
  threshold_score?: number;
  icon?: string;
}

export interface GameControlsDto {
  keyboard?: string[];
  touch?: boolean;
  mouse?: boolean;
  instructions?: string;
}

export interface GamePayload {
  genre: string;
  mode: MiniGameMode;
  questions?: GameQuestionDto[];
  levels?: GameLevelDto[];
  controls?: GameControlsDto;
  achievements?: GameAchievementDto[];
  max_score?: number;
}

export interface AppWebMcpToolDeclDto {
  name: string;
  description: string;
  input_schema?: Record<string, unknown>;
}

export interface AppPayload {
  entry_url: string;
  short_name: string;
  permissions: string[];
  web_mcp_tools?: AppWebMcpToolDeclDto[];
  icon?: string;
  version?: string;
}

// ============================================================================
// Wire DTOs (Verbatim with desktop `creation_contracts.rs`)
// ============================================================================

export interface UserCreationDto {
  creation_id: string;
  owner_user_id: number;
  owner_display_name: string;
  kind: CreationKind;
  title: string;
  subtitle: string;
  summary: string;
  genres: string[];
  tags: string[];
  cover: CoverArtwork;
  payload_json: string;
  visibility: CreationVisibility;
  review_status: CreationReviewStatus;
  review_note?: string;
  reviewer_user_id?: number;
  reviewed_at_ms?: number;
  submitted_at_ms?: number;
  published_at_ms?: number;
  cloud_revision: number;
  created_at_ms: number;
  updated_at_ms: number;
  deleted_at_ms?: number;
}

export interface UpsertCreationRequest {
  creation_id?: string;
  kind: CreationKind;
  title: string;
  subtitle?: string;
  summary?: string;
  genres?: string[];
  tags?: string[];
  cover?: CoverArtwork;
  payload_json: string;
  expected_revision?: number;
  submit_for_review?: boolean;
}

export interface UpsertCreationResponse {
  creation: UserCreationDto;
  created: boolean;
  conflict: boolean;
}

export interface CreationListResponse {
  items: UserCreationDto[];
  total: number;
}

export interface CreationSyncResponse {
  items: UserCreationDto[];
  latest_revision: number;
  server_time_ms: number;
}

export interface SubmitReviewRequest {
  note?: string;
}

export interface ReviewDecisionRequest {
  decision: CreationReviewDecision | 'approved' | 'rejected' | 'removed';
  note?: string;
}

export interface CreationAuditEventDto {
  event_id: number;
  creation_id: string;
  actor_user_id: number;
  actor_role: string;
  action: string;
  from_status: string;
  to_status: string;
  note?: string;
  created_at_ms: number;
}

export interface CreationAuditListResponse {
  creation_id: string;
  events: CreationAuditEventDto[];
}

export interface PublicCatalogEntryDto {
  creation_id: string;
  owner_user_id: number;
  author_display_name: string;
  kind: CreationKind;
  title: string;
  subtitle: string;
  summary: string;
  genres: string[];
  tags: string[];
  cover: CoverArtwork;
  payload_json: string;
  rating_avg: number;
  rating_count: number;
  play_or_read_count: number;
  favorite_count: number;
  install_count: number;
  published_at_ms: number;
  updated_at_ms: number;
  deep_link: string;
}

export interface PublicCatalogSearchResponse {
  items: PublicCatalogEntryDto[];
  total: number;
  kind?: CreationKind;
  query?: string;
  genre?: string;
}

export interface CatalogRecommendResponse {
  items: PublicCatalogEntryDto[];
  generated_at_ms: number;
}

export interface UserCreationStateDto {
  user_id: number;
  creation_id: string;
  kind: CreationKind;
  is_favorite: boolean;
  is_installed: boolean;
  progress_json: string;
  last_opened_at_ms: number;
  updated_at_ms: number;
}

export interface UpsertCatalogStateRequest {
  is_favorite?: boolean;
  is_installed?: boolean;
  progress_json?: string;
  increment_usage?: boolean;
}

export interface CatalogReviewDto {
  creation_id: string;
  user_id: number;
  user_display_name: string;
  rating: number;
  comment: string;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface UpsertCatalogReviewRequest {
  rating: number;
  comment?: string;
}

export interface CatalogReviewsResponse {
  creation_id: string;
  rating_avg: number;
  rating_count: number;
  reviews: CatalogReviewDto[];
}

export interface SubmitGameScoreRequest {
  score: number;
  metadata_json?: string;
}

export interface GameScoreEntryDto {
  rank: number;
  user_id: number;
  user_display_name: string;
  score: number;
  metadata_json: string;
  achieved_at_ms: number;
}

export interface GameLeaderboardResponse {
  creation_id: string;
  entries: GameScoreEntryDto[];
  my_best?: GameScoreEntryDto;
}

export interface BotRecommendationItem {
  creation_id: string;
  kind: CreationKind;
  title: string;
  subtitle: string;
  summary: string;
  author_display_name: string;
  genres: string[];
  cover: CoverArtwork;
  rating_avg: number;
  rating_count: number;
  score: number;
  reason: string;
  deep_link: string;
}

export interface BotRecommendationResponse {
  query?: string;
  kind?: CreationKind;
  genre?: string;
  items: BotRecommendationItem[];
  total: number;
}

export interface CreationPublicAssetDto {
  asset_id: string;
  creation_id: string;
  file_id: string;
  mime_type: string;
  role: 'cover' | 'audio' | 'attachment' | 'bundle';
  published_at_ms: number;
}

// ============================================================================
// Review FSM, Kind & Deep-Link Helpers
// ============================================================================

const ALLOWED_REVIEW_TRANSITIONS: Record<CreationReviewStatus, ReadonlySet<CreationReviewStatus>> = {
  draft: new Set<CreationReviewStatus>(['draft', 'pending_review']),
  pending_review: new Set<CreationReviewStatus>(['pending_review', 'draft', 'approved', 'rejected']),
  approved: new Set<CreationReviewStatus>(['approved', 'draft', 'pending_review', 'removed']),
  rejected: new Set<CreationReviewStatus>(['rejected', 'draft', 'pending_review']),
  removed: new Set<CreationReviewStatus>(['removed', 'draft', 'pending_review']),
};

export function isCreationPubliclyVisible(status: CreationReviewStatus): boolean {
  return status === 'approved';
}

export function canTransitionCreationReviewStatus(
  from: CreationReviewStatus,
  to: CreationReviewStatus,
): boolean {
  return ALLOWED_REVIEW_TRANSITIONS[from]?.has(to) ?? false;
}

export type CreationReviewTransitionResult =
  | { ok: true }
  | {
      ok: false;
      code: 'invalid_transition' | 'admin_required' | 'reason_required' | 'note_too_long';
      httpStatus: 400 | 403 | 409;
      message: string;
    };

export function validateCreationReviewTransition(
  from: CreationReviewStatus,
  to: CreationReviewStatus,
  actorIsAdmin: boolean,
  note?: string | null,
): CreationReviewTransitionResult {
  if (!canTransitionCreationReviewStatus(from, to)) {
    return {
      ok: false,
      code: 'invalid_transition',
      httpStatus: 409,
      message: `Cannot transition creation review status from '${from}' to '${to}'`,
    };
  }

  const requiresAdmin = to === 'approved' || to === 'rejected' || to === 'removed';
  if (requiresAdmin && !actorIsAdmin) {
    return {
      ok: false,
      code: 'admin_required',
      httpStatus: 403,
      message: `Review transition to '${to}' requires support/admin privileges`,
    };
  }

  const trimmedNote = typeof note === 'string' ? note.trim() : '';
  if ((to === 'rejected' || to === 'removed') && visibleCharCount(trimmedNote) === 0) {
    return {
      ok: false,
      code: 'reason_required',
      httpStatus: 400,
      message: `A non-empty reason note is required when marking a creation '${to}'`,
    };
  }

  const noteCodePoints = Array.from(trimmedNote).length;
  if (noteCodePoints > MAX_REVIEW_NOTE_CHARS) {
    return {
      ok: false,
      code: 'note_too_long',
      httpStatus: 400,
      message: `Review note exceeds maximum length of ${MAX_REVIEW_NOTE_CHARS} characters`,
    };
  }

  return { ok: true };
}

export function parseCreationReviewDecision(raw: string): CreationReviewDecision | null {
  switch (raw.trim().toLowerCase()) {
    case 'approve':
    case 'approved':
      return 'approve';
    case 'reject':
    case 'rejected':
      return 'reject';
    case 'remove':
    case 'removed':
      return 'remove';
    default:
      return null;
  }
}

export function creationKindToPath(kind: CreationKind): CreationKindPath {
  switch (kind) {
    case 'book':
      return 'books';
    case 'music':
      return 'music';
    case 'game':
      return 'games';
    case 'app':
      return 'appstore';
  }
}

export function creationKindDisplayNameZh(kind: CreationKind): string {
  switch (kind) {
    case 'book':
      return '图书';
    case 'music':
      return '音乐';
    case 'game':
      return '游戏';
    case 'app':
      return '应用';
  }
}

export function parseCreationKind(raw: string): CreationKind | null {
  switch (raw.trim().toLowerCase()) {
    case 'book':
    case 'books':
      return 'book';
    case 'music':
    case 'song':
    case 'track':
    case 'audio':
      return 'music';
    case 'game':
    case 'games':
      return 'game';
    case 'app':
    case 'apps':
    case 'appstore':
    case 'app_store':
    case 'miniapp':
      return 'app';
    default:
      return null;
  }
}

const CREATION_KIND_PATH_MAP: Readonly<Record<CreationKind, CreationKindPath>> = {
  book: 'books',
  music: 'music',
  game: 'games',
  app: 'appstore',
};

const SAFE_CREATION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function formatCreationDeepLink(
  kind: CreationKind,
  creationId: string,
  format: 'native' | 'web' = 'native',
): string {
  if (typeof kind !== 'string' || !Object.hasOwn(CREATION_KIND_PATH_MAP, kind)) {
    throw new Error(`Invalid creation deep-link kind: ${String(kind)}`);
  }
  const path = CREATION_KIND_PATH_MAP[kind];
  if (typeof creationId !== 'string' || !SAFE_CREATION_ID_RE.test(creationId)) {
    throw new Error(`Invalid creation deep-link id: ${String(creationId)}`);
  }
  if (format === 'web') {
    return `https://fabushi.app/catalog/${path}/${creationId}`;
  }
  return `fabushi://catalog/${path}/${creationId}`;
}

export interface ParsedCreationDeepLink {
  kind: CreationKind;
  creationId: string;
}

export function parseCreationDeepLink(uri: string): ParsedCreationDeepLink | null {
  if (typeof uri !== 'string' || /[\u0000-\u001F\u007F]/.test(uri)) {
    return null;
  }
  const trimmed = uri.trim();
  if (!trimmed || /[\u0000-\u001F\u007F\s]/.test(trimmed)) {
    return null;
  }

  let rest: string | null = null;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('fabushi://catalog/')) {
    rest = trimmed.slice('fabushi://catalog/'.length);
  } else if (lower.startsWith('https://fabushi.app/catalog/')) {
    rest = trimmed.slice('https://fabushi.app/catalog/'.length);
  } else if (lower.startsWith('http://fabushi.app/catalog/')) {
    rest = trimmed.slice('http://fabushi.app/catalog/'.length);
  }

  if (rest === null) return null;

  // Strip ?query and #fragment
  const stripped = rest.split(/[?#]/, 1)[0] ?? '';
  const parts = stripped.split('/');
  if (parts.length !== 2) return null;

  const [rawKind, rawId] = parts;
  if (!rawKind || !rawId) return null;

  const kind = parseCreationKind(rawKind);
  if (!kind) return null;
  if (!SAFE_CREATION_ID_RE.test(rawId)) return null;

  return { kind, creationId: rawId };
}

// ============================================================================
// Zero-Leak & Publish Validation Helpers
// ============================================================================

/**
 * Returns `true` for invisible Unicode format, control, zero-width, bidi,
 * soft-hyphen, variation-selector, filler, or whitespace code points.
 */
export function isInvisibleFormatChar(ch: string): boolean {
  if (!ch) return true;
  const cp = ch.codePointAt(0);
  if (cp === undefined) return true;

  // ASCII/C1 control characters and whitespace
  if (cp <= 0x20 || (cp >= 0x7f && cp <= 0xa0)) return true;
  // Soft hyphen, combining grapheme joiner, Mongolian vowel separator
  if (cp === 0x00ad || cp === 0x034f || cp === 0x061c || cp === 0x180e) return true;
  // Unicode general spaces, zero-width chars, directional formatting (U+2000..U+206F)
  if (cp >= 0x2000 && cp <= 0x206f) return true;
  // Braille Pattern Blank (U+2800), Ideographic space (U+3000), Hangul fillers
  if (cp === 0x115f || cp === 0x1160 || cp === 0x2800 || cp === 0x3000 || cp === 0x3164 || cp === 0xffa0) {
    return true;
  }
  // Variation selectors (U+FE00..U+FE0F), BOM/ZWNBSP (U+FEFF), Tags (U+E0000..U+E007F)
  if ((cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0xfeff || (cp >= 0xe0000 && cp <= 0xe007f)) {
    return true;
  }
  return false;
}

export function visibleCharCount(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (!isInvisibleFormatChar(ch)) {
      count += 1;
    }
  }
  return count;
}

function decodeBasicHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => {
      const cp = Number.parseInt(hex, 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    })
    .replace(/&#([0-9]+);?/g, (_, dec: string) => {
      const cp = Number.parseInt(dec, 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    })
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&colon;/gi, ':')
    .replace(/&sol;/gi, '/')
    .replace(/&equals;/gi, '=')
    .replace(/&lpar;/gi, '(')
    .replace(/&rpar;/gi, ')')
    .replace(/&tab;/gi, '\t')
    .replace(/&newline;/gi, '\n')
    .replace(/&amp;/gi, '&');
}

function stripInvisibleForSecurityScan(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    // Keep normal ASCII space/tab/newline for pattern boundaries, strip zero-width/control/bidi obfuscators
    if (cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d || !isInvisibleFormatChar(ch)) {
      out += ch;
    }
  }
  return out;
}

const OBSCURED_XSS_PATTERNS: ReadonlyArray<RegExp> = [
  /<\s*\/?\s*script\b/i,
  /<\s*\/?\s*iframe\b/i,
  /<\s*\/?\s*object\b/i,
  /<\s*\/?\s*embed\b/i,
  /<\s*svg\b[^>]*\bon[a-z]+\s*=/i,
  /<\s*[a-z][^>]*\bon[a-z]{2,}\s*=/i,
  /\bj[\t\r\n]*a[\t\r\n]*v[\t\r\n]*a[\t\r\n]*s[\t\r\n]*c[\t\r\n]*r[\t\r\n]*i[\t\r\n]*p[\t\r\n]*t[\t\r\n\s]*:/i,
  /\bv[\t\r\n]*b[\t\r\n]*s[\t\r\n]*c[\t\r\n]*r[\t\r\n]*i[\t\r\n]*p[\t\r\n]*t[\t\r\n\s]*:/i,
  /\bd[\t\r\n]*a[\t\r\n]*t[\t\r\n]*a[\t\r\n\s]*:[\t\r\n\s]*t[\t\r\n]*e[\t\r\n]*x[\t\r\n]*t[\t\r\n\s]*\/[\t\r\n\s]*h[\t\r\n]*t[\t\r\n]*m[\t\r\n]*l/i,
  /\bsrcdoc\s*=/i,
];

/**
 * Detects plain, zero-width, tab/CR/LF-split (WHATWG URL stripping), and HTML-entity obscured XSS payloads.
 */
export function containsObscuredXssPattern(text: string): boolean {
  if (!text) return false;
  const decoded = decodeBasicHtmlEntities(text);
  const strippedRaw = stripInvisibleForSecurityScan(text);
  const strippedDecoded = stripInvisibleForSecurityScan(decoded);
  const candidates = [
    text,
    decoded,
    strippedRaw,
    strippedDecoded,
    // Strip ASCII tab/CR/LF per WHATWG URL parsing while keeping ASCII space (0x20) for word boundaries
    strippedRaw.replace(/[\t\r\n]+/g, ''),
    strippedDecoded.replace(/[\t\r\n]+/g, ''),
  ];
  for (const candidate of candidates) {
    for (const pattern of OBSCURED_XSS_PATTERNS) {
      if (pattern.test(candidate)) {
        return true;
      }
    }
  }
  return false;
}

const MAX_PAYLOAD_JSON_SCAN_NODES = 100_000;

function payloadJsonContainsObscuredXss(rawJson: string): boolean {
  if (containsObscuredXssPattern(rawJson)) {
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return false;
  }
  const stack: unknown[] = [parsed];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_PAYLOAD_JSON_SCAN_NODES) {
    const current = stack.pop();
    visited += 1;
    if (typeof current === 'string') {
      if (containsObscuredXssPattern(current)) {
        return true;
      }
      continue;
    }
    if (Array.isArray(current)) {
      for (let i = 0; i < current.length; i += 1) {
        const item = current[i];
        if (typeof item === 'string') {
          if (visited >= MAX_PAYLOAD_JSON_SCAN_NODES) {
            return true;
          }
          visited += 1;
          if (containsObscuredXssPattern(item)) {
            return true;
          }
        } else if (item !== null && typeof item === 'object') {
          stack.push(item);
        }
      }
      continue;
    }
    if (current !== null && typeof current === 'object') {
      const record = current as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (visited >= MAX_PAYLOAD_JSON_SCAN_NODES) {
          return true;
        }
        visited += 1;
        if (containsObscuredXssPattern(key)) {
          return true;
        }
        const value = record[key];
        if (typeof value === 'string') {
          if (visited >= MAX_PAYLOAD_JSON_SCAN_NODES) {
            return true;
          }
          visited += 1;
          if (containsObscuredXssPattern(value)) {
            return true;
          }
        } else if (value !== null && typeof value === 'object') {
          stack.push(value);
        }
      }
    }
  }
  return stack.length > 0;
}

export interface CreationPublishValidationInput {
  title: string;
  subtitle?: string;
  summary?: string;
  genres?: string[];
  tags?: string[];
  payload_json?: string;
  cover?: CoverArtwork;
}

export type CreationPublishValidationResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export function validateCreationPublishInput(
  input: CreationPublishValidationInput,
): CreationPublishValidationResult {
  const title = typeof input.title === 'string' ? input.title : '';
  const subtitle = typeof input.subtitle === 'string' ? input.subtitle : '';
  const summary = typeof input.summary === 'string' ? input.summary : '';

  if (visibleCharCount(title) === 0) {
    return {
      ok: false,
      code: 'invalid_title',
      message: 'Creation title must contain visible non-whitespace characters',
    };
  }
  if (Array.from(title).length > MAX_TITLE_CHARS) {
    return {
      ok: false,
      code: 'title_too_long',
      message: `Creation title exceeds ${MAX_TITLE_CHARS} characters`,
    };
  }
  if (Array.from(subtitle).length > MAX_SUBTITLE_CHARS) {
    return {
      ok: false,
      code: 'subtitle_too_long',
      message: `Creation subtitle exceeds ${MAX_SUBTITLE_CHARS} characters`,
    };
  }
  if (input.summary !== undefined && visibleCharCount(summary) === 0) {
    return {
      ok: false,
      code: 'invalid_summary',
      message: 'Creation summary must contain visible non-whitespace characters when provided',
    };
  }
  if (Array.from(summary).length > MAX_SUMMARY_CHARS) {
    return {
      ok: false,
      code: 'summary_too_long',
      message: `Creation summary exceeds ${MAX_SUMMARY_CHARS} characters`,
    };
  }
  if (input.genres && input.genres.length > MAX_GENRES) {
    return {
      ok: false,
      code: 'too_many_genres',
      message: `At most ${MAX_GENRES} genres are allowed`,
    };
  }
  if (input.tags && input.tags.length > MAX_TAGS) {
    return {
      ok: false,
      code: 'too_many_tags',
      message: `At most ${MAX_TAGS} tags are allowed`,
    };
  }

  const textFields = [
    title,
    subtitle,
    summary,
    ...(input.genres ?? []),
    ...(input.tags ?? []),
    input.cover?.glyph ?? '',
    input.cover?.image_url ?? '',
  ];
  for (const field of textFields) {
    if (containsObscuredXssPattern(field)) {
      return {
        ok: false,
        code: 'xss_rejected',
        message: 'Creation metadata contains disallowed script or XSS pattern',
      };
    }
  }

  if (input.payload_json !== undefined) {
    const payloadBytes = new TextEncoder().encode(input.payload_json).byteLength;
    if (payloadBytes > MAX_CREATION_JSON_BYTES) {
      return {
        ok: false,
        code: 'payload_too_large',
        message: `Creation payload exceeds maximum ${MAX_CREATION_JSON_BYTES} bytes`,
      };
    }
    if (payloadJsonContainsObscuredXss(input.payload_json)) {
      return {
        ok: false,
        code: 'xss_rejected',
        message: 'Creation payload contains disallowed script or XSS pattern',
      };
    }
  }

  if (input.cover?.thumbnail_b64) {
    const b64Bytes = new TextEncoder().encode(input.cover.thumbnail_b64).byteLength;
    if (b64Bytes > MAX_COVER_BASE64_BYTES) {
      return {
        ok: false,
        code: 'cover_too_large',
        message: `Cover thumbnail exceeds maximum ${MAX_COVER_BASE64_BYTES} bytes`,
      };
    }
  }

  return { ok: true };
}

const SENSITIVE_RECOMMENDATION_MARKERS: ReadonlyArray<string> = [
  'draft',
  'pending_review',
  'pending review',
  'rejected',
  'private',
  'unlisted',
  'unreviewed',
  'review_note',
  'audit_log',
  'user_creations',
  '草稿',
  '待审核',
  '未审核',
  '已驳回',
  '未公开',
  '私有',
  '私人',
];

export const DEFAULT_RECOMMENDATION_REASON = '来自公开精选目录' as const;

export function sanitizeRecommendationReason(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed || visibleCharCount(trimmed) === 0) {
    return DEFAULT_RECOMMENDATION_REASON;
  }
  const normalizedAllSpaces = trimmed.replace(/[\s\u00A0\u2000-\u200A\u3000]+/g, ' ');
  const normalizedRealSpaces = trimmed.replace(
    /[ \t\r\n\f\v\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/g,
    ' ',
  );
  const stripped = stripInvisibleForSecurityScan(trimmed);
  const strippedNormalizedAll = stripInvisibleForSecurityScan(normalizedAllSpaces)
    .replace(/\s+/g, ' ')
    .trim();
  const strippedNormalizedReal = stripInvisibleForSecurityScan(normalizedRealSpaces)
    .replace(/\s+/g, ' ')
    .trim();
  const candidates = [
    trimmed.toLowerCase(),
    stripped.toLowerCase(),
    stripped.replace(/[\t\r\n]+/g, '').toLowerCase(),
    stripped.replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ').toLowerCase(),
    strippedNormalizedAll.toLowerCase(),
    strippedNormalizedReal.toLowerCase(),
  ];
  for (const candidate of candidates) {
    for (const marker of SENSITIVE_RECOMMENDATION_MARKERS) {
      if (candidate.includes(marker)) {
        return DEFAULT_RECOMMENDATION_REASON;
      }
    }
  }
  if (containsObscuredXssPattern(trimmed)) {
    return DEFAULT_RECOMMENDATION_REASON;
  }
  return trimmed;
}

function creationKindIcon(kind: CreationKind): string {
  switch (kind) {
    case 'book':
      return '📚';
    case 'music':
      return '🎵';
    case 'game':
      return '🎮';
    case 'app':
      return '🧩';
  }
}

export function buildBotRecommendationMessage(
  items: ReadonlyArray<BotRecommendationItem>,
  heading = '公开目录推荐',
): string {
  if (items.length === 0) {
    return `${heading}\n暂无匹配的公开作品。`;
  }
  const lines: string[] = [heading];
  items.forEach((item, index) => {
    const icon = creationKindIcon(item.kind);
    const ratingText =
      item.rating_count > 0 ? `★ ${item.rating_avg.toFixed(1)} (${item.rating_count})` : '新上架';
    const safeReason = sanitizeRecommendationReason(item.reason);
    const summaryLine = item.summary.trim() ? `\n   ${item.summary.trim()}` : '';
    lines.push(
      `${index + 1}. ${icon} ${item.title} · ${item.author_display_name} · ${ratingText}${summaryLine}\n   推荐理由：${safeReason}\n   ${item.deep_link}`,
    );
  });
  return lines.join('\n');
}

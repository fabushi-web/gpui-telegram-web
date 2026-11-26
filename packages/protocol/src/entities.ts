/**
 * UTF-16 `MessageEntity` & XSS-Safe Markdown Parser / Serializer / HTML Renderer.
 *
 * JavaScript strings are sequences of 16-bit UTF-16 code units (`string.length`, `string.slice`),
 * matching Telegram's `MessageEntity { offset, length }` specification natively across ASCII,
 * CJK (`中文`), and astral surrogate-pair emojis (`🎉`, `👨‍👩‍👧‍👦`).
 */

export type MessageEntityKind =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strikethrough'
  | 'spoiler'
  | 'code'
  | 'pre'
  | 'blockquote'
  | 'expandable_blockquote'
  | 'url'
  | 'text_url'
  | 'mention'
  | 'hashtag'
  | 'cashtag'
  | 'bot_command'
  | 'timestamp'
  | 'custom_emoji';

export type MessageEntityType = MessageEntityKind;

export type WireMessageEntityType =
  | { type: 'Bold' }
  | { type: 'Italic' }
  | { type: 'Underline' }
  | { type: 'Strikethrough' }
  | { type: 'Spoiler' }
  | { type: 'Code' }
  | { type: 'Pre'; value: { language: string | null } }
  | { type: 'Blockquote'; value?: { collapsed?: boolean } }
  | { type: 'ExpandableBlockquote'; value?: { collapsed?: boolean } }
  | { type: 'Url' }
  | { type: 'TextUrl'; value: { url: string } }
  | { type: 'Mention' }
  | { type: 'Hashtag' }
  | { type: 'Cashtag' }
  | { type: 'BotCommand' }
  | { type: 'Timestamp'; value?: { seconds: number } }
  | { type: 'CustomEmoji'; value: { document_id: number } };

export interface WireMessageEntity {
  offset: number;
  length: number;
  entity_type: WireMessageEntityType;
}

export interface MessageEntity {
  offset: number;
  length: number;
  type: MessageEntityKind;
  language?: string;
  url?: string;
  documentId?: number;
  collapsed?: boolean;
  seconds?: number;
  entity_type?: WireMessageEntityType;
}

export interface ParsedMarkdownResult {
  text: string;
  entities: MessageEntity[];
}

export interface EntitySegment {
  text: string;
  offset: number;
  length: number;
  activeEntities: MessageEntity[];
}

const SAFE_URL_PROTOCOLS = new Set(['http:', 'https:', 'tg:', 'mailto:']);

export function isSafeEntityUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  // Disallow control chars or whitespace tricks
  if (/[\u0000-\u001F\u007F\s]/.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    return SAFE_URL_PROTOCOLS.has(parsed.protocol.toLowerCase());
  } catch {
    return false;
  }
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Idempotent XSS-safe HTML sanitizer matching upstream `sanitize_text_once`:
 * escapes `&`, `<`, `>`, `"`, `'` without double-escaping existing HTML entities.
 */
export function sanitizeTextOnce(input: string): string {
  return input
    .replace(/&(?!(?:amp|lt|gt|quot|#39|#x27);)/gi, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Ensures an arbitrary index falls on a valid UTF-16 code-point boundary (never mid-surrogate pair).
 */
export function clampUtf16Boundary(text: string, index: number): number {
  const clamped = Math.max(0, Math.min(text.length, Math.trunc(index)));
  if (clamped > 0 && clamped < text.length) {
    const prev = text.charCodeAt(clamped - 1);
    const curr = text.charCodeAt(clamped);
    if (isHighSurrogate(prev) && isLowSurrogate(curr)) {
      return clamped - 1;
    }
  }
  return clamped;
}

export function extractEntityUtf16(
  text: string,
  entity: Pick<MessageEntity, 'offset' | 'length'>,
): string {
  const start = clampUtf16Boundary(text, entity.offset);
  const end = clampUtf16Boundary(text, entity.offset + entity.length);
  if (end <= start) return '';
  return text.slice(start, end);
}

export function toWireMessageEntityType(entity: MessageEntity): WireMessageEntityType {
  switch (entity.type) {
    case 'bold':
      return { type: 'Bold' };
    case 'italic':
      return { type: 'Italic' };
    case 'underline':
      return { type: 'Underline' };
    case 'strikethrough':
      return { type: 'Strikethrough' };
    case 'spoiler':
      return { type: 'Spoiler' };
    case 'code':
      return { type: 'Code' };
    case 'pre':
      return { type: 'Pre', value: { language: entity.language ?? null } };
    case 'blockquote':
      return entity.collapsed ? { type: 'Blockquote', value: { collapsed: true } } : { type: 'Blockquote' };
    case 'expandable_blockquote':
      return { type: 'ExpandableBlockquote', value: { collapsed: entity.collapsed ?? true } };
    case 'url':
      return { type: 'Url' };
    case 'text_url':
      return { type: 'TextUrl', value: { url: entity.url ?? '' } };
    case 'mention':
      return { type: 'Mention' };
    case 'hashtag':
      return { type: 'Hashtag' };
    case 'cashtag':
      return { type: 'Cashtag' };
    case 'bot_command':
      return { type: 'BotCommand' };
    case 'timestamp':
      return entity.seconds !== undefined
        ? { type: 'Timestamp', value: { seconds: entity.seconds } }
        : { type: 'Timestamp' };
    case 'custom_emoji':
      return { type: 'CustomEmoji', value: { document_id: entity.documentId ?? 0 } };
  }
}

export function toWireMessageEntity(entity: MessageEntity): WireMessageEntity {
  return {
    offset: entity.offset,
    length: entity.length,
    entity_type: entity.entity_type ?? toWireMessageEntityType(entity),
  };
}

function toSafeInt(value: unknown, fallback = 0): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.trunc(num);
}

const VALID_ENTITY_KINDS = new Set<MessageEntityKind>([
  'bold',
  'italic',
  'underline',
  'strikethrough',
  'spoiler',
  'code',
  'pre',
  'blockquote',
  'expandable_blockquote',
  'url',
  'text_url',
  'mention',
  'hashtag',
  'cashtag',
  'bot_command',
  'timestamp',
  'custom_emoji',
]);

export function fromWireMessageEntity(
  raw: WireMessageEntity | MessageEntity | Record<string, unknown>,
): MessageEntity {
  if (!raw || typeof raw !== 'object') {
    return makeEntity(0, 0, 'bold');
  }
  const rec = raw as Record<string, unknown>;
  const safeOffset = Math.max(0, toSafeInt(rec.offset, 0));
  const safeLength = Math.max(0, toSafeInt(rec.length, 0));

  if ('type' in rec && typeof rec.type === 'string') {
    if (!VALID_ENTITY_KINDS.has(rec.type as MessageEntityKind)) {
      return makeEntity(safeOffset, 0, 'bold');
    }
    const kind = rec.type as MessageEntityKind;
    const normalized: MessageEntity = {
      offset: safeOffset,
      length: safeLength,
      type: kind,
      language: typeof rec.language === 'string' ? rec.language : undefined,
      url: typeof rec.url === 'string' ? rec.url : undefined,
      documentId: rec.documentId !== undefined ? toSafeInt(rec.documentId, 0) : undefined,
      collapsed:
        rec.collapsed !== undefined
          ? Boolean(rec.collapsed)
          : kind === 'expandable_blockquote'
            ? true
            : undefined,
      seconds: rec.seconds !== undefined ? toSafeInt(rec.seconds, 0) : undefined,
    };
    normalized.entity_type = toWireMessageEntityType(normalized);
    return normalized;
  }

  const etRaw = rec.entity_type;
  if (!etRaw || typeof etRaw !== 'object' || typeof (etRaw as { type?: unknown }).type !== 'string') {
    return makeEntity(safeOffset, 0, 'bold');
  }

  const et = etRaw as WireMessageEntityType;
  const val = (et as { value?: Record<string, unknown> }).value;

  switch (et.type) {
    case 'Bold':
      return makeEntity(safeOffset, safeLength, 'bold');
    case 'Italic':
      return makeEntity(safeOffset, safeLength, 'italic');
    case 'Underline':
      return makeEntity(safeOffset, safeLength, 'underline');
    case 'Strikethrough':
      return makeEntity(safeOffset, safeLength, 'strikethrough');
    case 'Spoiler':
      return makeEntity(safeOffset, safeLength, 'spoiler');
    case 'Code':
      return makeEntity(safeOffset, safeLength, 'code');
    case 'Pre':
      return makeEntity(safeOffset, safeLength, 'pre', {
        language: typeof val?.language === 'string' ? val.language : undefined,
      });
    case 'Blockquote':
      return makeEntity(safeOffset, safeLength, 'blockquote', {
        collapsed: val?.collapsed !== undefined ? Boolean(val.collapsed) : undefined,
      });
    case 'ExpandableBlockquote':
      return makeEntity(safeOffset, safeLength, 'expandable_blockquote', {
        collapsed: val?.collapsed !== undefined ? Boolean(val.collapsed) : true,
      });
    case 'Url':
      return makeEntity(safeOffset, safeLength, 'url');
    case 'TextUrl':
      return makeEntity(safeOffset, safeLength, 'text_url', {
        url: typeof val?.url === 'string' ? val.url : '',
      });
    case 'Mention':
      return makeEntity(safeOffset, safeLength, 'mention');
    case 'Hashtag':
      return makeEntity(safeOffset, safeLength, 'hashtag');
    case 'Cashtag':
      return makeEntity(safeOffset, safeLength, 'cashtag');
    case 'BotCommand':
      return makeEntity(safeOffset, safeLength, 'bot_command');
    case 'Timestamp':
      return makeEntity(safeOffset, safeLength, 'timestamp', {
        seconds: val?.seconds !== undefined ? toSafeInt(val.seconds, 0) : undefined,
      });
    case 'CustomEmoji':
      return makeEntity(safeOffset, safeLength, 'custom_emoji', {
        documentId: toSafeInt(val?.document_id, 0),
      });
    default:
      return makeEntity(safeOffset, 0, 'bold');
  }
}

export function makeEntity(
  offset: number,
  length: number,
  type: MessageEntityKind,
  extra: Omit<MessageEntity, 'offset' | 'length' | 'type' | 'entity_type'> = {},
): MessageEntity {
  const base: MessageEntity = {
    offset,
    length,
    type,
    ...extra,
  };
  base.entity_type = toWireMessageEntityType(base);
  return base;
}

function isAsciiWordChar(ch: string | undefined): boolean {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

interface InlineParseState {
  out: string;
  entities: MessageEntity[];
}

function parseInlineRange(src: string, start: number, end: number, state: InlineParseState): void {
  let i = start;
  while (i < end) {
    // 1. Fenced code block ```lang\n...\n``` or ```...```
    if (src.startsWith('```', i)) {
      const closeIdx = src.indexOf('```', i + 3);
      if (closeIdx !== -1 && closeIdx + 3 <= end) {
        const inner = src.slice(i + 3, closeIdx);
        let language: string | undefined;
        let codeBody = inner;
        const firstNewline = inner.indexOf('\n');
        if (firstNewline !== -1) {
          const langCandidate = inner.slice(0, firstNewline).trim();
          if (/^[A-Za-z0-9_+#.-]*$/.test(langCandidate)) {
            language = langCandidate || undefined;
            codeBody = inner.slice(firstNewline + 1);
          }
        }
        if (codeBody.endsWith('\n')) {
          codeBody = codeBody.slice(0, -1);
        }
        if (codeBody.length > 0) {
          const offset = state.out.length;
          state.out += codeBody;
          state.entities.push(makeEntity(offset, codeBody.length, 'pre', { language }));
        }
        i = closeIdx + 3;
        continue;
      }
    }

    // 2. Inline code `...`
    if (src[i] === '`') {
      const closeIdx = src.indexOf('`', i + 1);
      if (closeIdx !== -1 && closeIdx < end && !src.slice(i + 1, closeIdx).includes('\n')) {
        const codeText = src.slice(i + 1, closeIdx);
        if (codeText.length > 0) {
          const offset = state.out.length;
          state.out += codeText;
          state.entities.push(makeEntity(offset, codeText.length, 'code'));
          i = closeIdx + 1;
          continue;
        }
      }
    }

    // 3. Markdown link [label](url)
    if (src[i] === '[') {
      const closeBracket = findClosingBracket(src, i + 1, end);
      if (closeBracket !== -1 && src[closeBracket + 1] === '(') {
        const closeParen = findClosingParen(src, closeBracket + 2, end);
        if (closeParen !== -1) {
          const labelSrc = src.slice(i + 1, closeBracket);
          const rawUrl = src.slice(closeBracket + 2, closeParen).trim();
          if (labelSrc.length > 0 && isSafeEntityUrl(rawUrl)) {
            const offset = state.out.length;
            parseInlineRange(src, i + 1, closeBracket, state);
            const len = state.out.length - offset;
            if (len > 0) {
              state.entities.push(makeEntity(offset, len, 'text_url', { url: rawUrl }));
            }
            i = closeParen + 1;
            continue;
          }
        }
      }
    }

    // 3b. Three-character combined bold+italic delimiter: ***...***
    if (src.startsWith('***', i) && src[i + 3] !== '*') {
      const closeIdx = findPairedDelimiter(src, '***', i + 3, end);
      if (closeIdx !== -1 && closeIdx > i + 3) {
        const offset = state.out.length;
        parseInlineRange(src, i + 3, closeIdx, state);
        const len = state.out.length - offset;
        if (len > 0) {
          state.entities.push(makeEntity(offset, len, 'bold'));
          state.entities.push(makeEntity(offset, len, 'italic'));
        }
        i = closeIdx + 3;
        continue;
      }
    }

    // 4. Two-character paired delimiters: **, __, ~~, ||
    const twoChar = src.slice(i, i + 2);
    if (twoChar === '**' || twoChar === '__' || twoChar === '~~' || twoChar === '||') {
      let canOpen = true;
      if (twoChar === '__') {
        const prevChar = i > 0 ? src[i - 1] : undefined;
        const nextChar = i + 2 < end ? src[i + 2] : undefined;
        canOpen =
          nextChar !== undefined &&
          nextChar !== '_' &&
          !/\s/.test(nextChar) &&
          !isAsciiWordChar(prevChar) &&
          prevChar !== '.' &&
          prevChar !== '_';
      }
      if (canOpen) {
        const closeIdx = findPairedDelimiter(src, twoChar, i + 2, end);
        if (closeIdx !== -1 && closeIdx > i + 2) {
          const kind: MessageEntityKind =
            twoChar === '**'
              ? 'bold'
              : twoChar === '__'
                ? 'underline'
                : twoChar === '~~'
                  ? 'strikethrough'
                  : 'spoiler';
          const offset = state.out.length;
          parseInlineRange(src, i + 2, closeIdx, state);
          const len = state.out.length - offset;
          if (len > 0) {
            state.entities.push(makeEntity(offset, len, kind));
          }
          i = closeIdx + 2;
          continue;
        }
      }
    }

    // 5. Single-character italic delimiters: *...* or _..._ (avoiding intra-word snake_case)
    const oneChar = src[i];
    if (oneChar === '*' || oneChar === '_') {
      const prevChar = i > 0 ? src[i - 1] : undefined;
      const nextChar = i + 1 < end ? src[i + 1] : undefined;
      const validOpen =
        nextChar !== undefined &&
        nextChar !== oneChar &&
        !/\s/.test(nextChar) &&
        !(oneChar === '_' && (isAsciiWordChar(prevChar) || prevChar === '_'));

      if (validOpen) {
        const closeIdx = findSingleItalicClose(src, oneChar, i + 1, end);
        if (closeIdx !== -1 && closeIdx > i + 1) {
          const offset = state.out.length;
          parseInlineRange(src, i + 1, closeIdx, state);
          const len = state.out.length - offset;
          if (len > 0) {
            state.entities.push(makeEntity(offset, len, 'italic'));
          }
          i = closeIdx + 1;
          continue;
        }
      }
    }

    // Default: append UTF-16 code unit (or full surrogate pair) verbatim
    const code = src.charCodeAt(i);
    if (isHighSurrogate(code) && i + 1 < end && isLowSurrogate(src.charCodeAt(i + 1))) {
      state.out += src.slice(i, i + 2);
      i += 2;
    } else {
      state.out += src[i]!;
      i += 1;
    }
  }
}

function findClosingBracket(src: string, from: number, end: number): number {
  let depth = 1;
  for (let i = from; i < end; i++) {
    if (src[i] === '`') {
      const nextTick = src.indexOf('`', i + 1);
      if (nextTick !== -1 && nextTick < end) {
        i = nextTick;
        continue;
      }
    }
    if (src[i] === '[') depth++;
    else if (src[i] === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findClosingParen(src: string, from: number, end: number): number {
  let depth = 1;
  for (let i = from; i < end; i++) {
    if (src[i] === '\n') return -1;
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findPairedDelimiter(src: string, delim: string, from: number, end: number): number {
  for (let i = from; i <= end - delim.length; i++) {
    if (src[i] === '`') {
      const nextTick = src.indexOf('`', i + 1);
      if (nextTick !== -1 && nextTick < end) {
        i = nextTick;
        continue;
      }
    }
    if (src.slice(i, i + delim.length) === delim) {
      if (delim === '__') {
        const prev = i > from ? src[i - 1] : undefined;
        const after = i + 2 < end ? src[i + 2] : undefined;
        if (!prev || /\s/.test(prev) || prev === '_' || isAsciiWordChar(after)) {
          continue;
        }
      }
      return i;
    }
  }
  return -1;
}

function findSingleItalicClose(src: string, ch: '*' | '_', from: number, end: number): number {
  for (let i = from; i < end; i++) {
    if (src[i] === '\n') return -1;
    if (src[i] === '`') {
      const nextTick = src.indexOf('`', i + 1);
      if (nextTick !== -1 && nextTick < end) {
        i = nextTick;
        continue;
      }
    }
    // Skip multi-character delimiters ** / *** / __ inside single delimiter search
    if (src[i] === ch && src[i + 1] === ch) {
      while (i + 1 < end && src[i + 1] === ch) {
        i += 1;
      }
      continue;
    }
    if (src[i] === ch) {
      const prev = src[i - 1];
      const after = i + 1 < end ? src[i + 1] : undefined;
      if (prev && !/\s/.test(prev) && !(ch === '_' && isAsciiWordChar(after))) {
        return i;
      }
    }
  }
  return -1;
}

function parseTimestampSeconds(ts: string): number {
  const parts = ts.split(':').map((p) => Number.parseInt(p, 10));
  if (parts.length === 2) {
    return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
  }
  if (parts.length === 3) {
    return (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
  }
  return 0;
}

function detectAutoEntities(plainText: string, existing: MessageEntity[]): MessageEntity[] {
  const codeOrLinkRanges = existing.filter(
    (e) => e.type === 'code' || e.type === 'pre' || e.type === 'text_url' || e.type === 'url',
  );

  const overlapsExcluded = (offset: number, length: number, extraExcluded: MessageEntity[] = []): boolean => {
    const end = offset + length;
    for (const r of codeOrLinkRanges) {
      if (offset < r.offset + r.length && end > r.offset) return true;
    }
    for (const r of extraExcluded) {
      if (offset < r.offset + r.length && end > r.offset) return true;
    }
    return false;
  };

  const detected: MessageEntity[] = [];

  // 1. Bare URLs
  const urlRegex = /https?:\/\/[^\s<>()]+(?:\([^\s<>()]*\)[^\s<>()]*)*/gi;
  for (const match of plainText.matchAll(urlRegex)) {
    let raw = match[0];
    const offset = match.index ?? 0;
    while (raw.length > 0 && /[.,!?;:'"\]}]$/.test(raw)) {
      raw = raw.slice(0, -1);
    }
    if (raw.length > 0 && isSafeEntityUrl(raw) && !overlapsExcluded(offset, raw.length, detected)) {
      detected.push(makeEntity(offset, raw.length, 'url', { url: raw }));
    }
  }

  // 2. Bot commands (/start, /newbot, /help@HermesAssistantBot)
  const cmdRegex = /(?:^|(?<=[\s(]))\/[A-Za-z][A-Za-z0-9_-]{0,63}(?:@[A-Za-z][A-Za-z0-9_]{2,31})?(?=\s|$|[.,!?;:)])/g;
  for (const match of plainText.matchAll(cmdRegex)) {
    const raw = match[0];
    const offset = match.index ?? 0;
    if (!overlapsExcluded(offset, raw.length, detected)) {
      detected.push(makeEntity(offset, raw.length, 'bot_command'));
    }
  }

  // 3. Mentions (@alice, @BotFather)
  const mentionRegex = /(?<![A-Za-z0-9_])@[A-Za-z][A-Za-z0-9_]{2,31}\b/g;
  for (const match of plainText.matchAll(mentionRegex)) {
    const raw = match[0];
    const offset = match.index ?? 0;
    if (!overlapsExcluded(offset, raw.length, detected)) {
      detected.push(makeEntity(offset, raw.length, 'mention'));
    }
  }

  // 4. Hashtags (#Telegram, #法布施)
  const hashtagRegex = /(?<![A-Za-z0-9_&])#[\p{L}\p{N}_]{1,64}/gu;
  for (const match of plainText.matchAll(hashtagRegex)) {
    const raw = match[0];
    const offset = match.index ?? 0;
    if (!overlapsExcluded(offset, raw.length, detected)) {
      detected.push(makeEntity(offset, raw.length, 'hashtag'));
    }
  }

  // 5. Cashtags ($TON, $BTC)
  const cashtagRegex = /(?<![A-Za-z0-9_])\$[A-Z]{2,10}\b/g;
  for (const match of plainText.matchAll(cashtagRegex)) {
    const raw = match[0];
    const offset = match.index ?? 0;
    if (!overlapsExcluded(offset, raw.length, detected)) {
      detected.push(makeEntity(offset, raw.length, 'cashtag'));
    }
  }

  // 6. Media Timestamps (01:24, 1:02:30)
  const tsRegex = /\b(?:\d{1,2}:)?[0-5]?\d:[0-5]\d\b/g;
  for (const match of plainText.matchAll(tsRegex)) {
    const raw = match[0];
    const offset = match.index ?? 0;
    if (!overlapsExcluded(offset, raw.length, detected)) {
      detected.push(
        makeEntity(offset, raw.length, 'timestamp', {
          seconds: parseTimestampSeconds(raw),
        }),
      );
    }
  }

  return detected;
}

export function sortEntitiesCanonical(entities: MessageEntity[]): MessageEntity[] {
  return [...entities].sort((a, b) => {
    if (a.offset !== b.offset) return a.offset - b.offset;
    if (b.length !== a.length) return b.length - a.length;
    return entityWrapperPriority(a.type) - entityWrapperPriority(b.type);
  });
}

/**
 * Parses Markdown into plain display text + canonical UTF-16 `MessageEntity[]`.
 * Handles fenced ```lang code blocks, > blockquotes, inline formatting, links, mentions,
 * hashtags (including CJK), cashtags, bot commands, URLs, and timestamps.
 */
export function parseMarkdownEntities(markdown: string): ParsedMarkdownResult {
  if (!markdown) {
    return { text: '', entities: [] };
  }

  const normalized = markdown.replace(/\r\n/g, '\n');
  const state: InlineParseState = { out: '', entities: [] };

  // Split around top-level fenced code blocks first so `> ` inside code blocks is never treated as a blockquote!
  let cursor = 0;
  while (cursor < normalized.length) {
    const fenceIdx = normalized.indexOf('```', cursor);
    if (fenceIdx === -1) {
      parseBlocksOutsideFences(normalized.slice(cursor), state);
      break;
    }

    const closeFence = normalized.indexOf('```', fenceIdx + 3);
    if (closeFence === -1) {
      parseBlocksOutsideFences(normalized.slice(cursor), state);
      break;
    }

    if (fenceIdx > cursor) {
      parseBlocksOutsideFences(normalized.slice(cursor, fenceIdx), state);
    }

    parseInlineRange(normalized, fenceIdx, closeFence + 3, state);
    cursor = closeFence + 3;
  }

  const autoEntities = detectAutoEntities(state.out, state.entities);
  const allEntities = sortEntitiesCanonical([...state.entities, ...autoEntities]);
  return {
    text: state.out,
    entities: allEntities,
  };
}

function parseBlocksOutsideFences(chunk: string, state: InlineParseState): void {
  if (!chunk) return;
  const lines = chunk.split('\n');
  let idx = 0;

  while (idx < lines.length) {
    const line = lines[idx]!;
    if (/^>>?\s?/.test(line)) {
      const quoteLines: string[] = [];
      const isExpandable = /^>>/.test(line);
      while (
        idx < lines.length &&
        (isExpandable ? /^>>/.test(lines[idx]!) : /^>(?!>)/.test(lines[idx]!))
      ) {
        const stripped = isExpandable
          ? lines[idx]!.replace(/^>>\s?/, '')
          : lines[idx]!.replace(/^>\s?/, '');
        quoteLines.push(stripped);
        idx++;
      }

      const quoteOffset = state.out.length;
      const joinedQuote = quoteLines.join('\n');
      parseInlineRange(joinedQuote, 0, joinedQuote.length, state);
      const quoteLen = state.out.length - quoteOffset;
      if (quoteLen > 0) {
        if (isExpandable) {
          state.entities.push(
            makeEntity(quoteOffset, quoteLen, 'expandable_blockquote', { collapsed: true }),
          );
        } else {
          state.entities.push(
            makeEntity(quoteOffset, quoteLen, 'blockquote', { collapsed: quoteLines.length > 4 }),
          );
        }
      }
      if (idx < lines.length) {
        state.out += '\n';
      }
    } else {
      parseInlineRange(line, 0, line.length, state);
      if (idx < lines.length - 1) {
        state.out += '\n';
      }
      idx++;
    }
  }
}

function entityWrapperPriority(type: MessageEntityKind): number {
  switch (type) {
    case 'pre':
      return 0;
    case 'text_url':
      return 1;
    case 'bold':
      return 2;
    case 'underline':
      return 3;
    case 'strikethrough':
      return 4;
    case 'spoiler':
      return 5;
    case 'italic':
      return 6;
    case 'code':
      return 7;
    default:
      return 8;
  }
}

interface IndexedEntity {
  ent: MessageEntity;
  priority: number;
  idx: number;
  italicDelim: '*' | '_';
}

/**
 * Serializes plain UTF-16 `text` + `MessageEntity[]` back into canonical Markdown.
 * Clamps offsets to valid UTF-16 code-point boundaries (never splitting surrogate pairs)
 * and guarantees strict LIFO nesting on co-extensive spans.
 */
export function serializeEntitiesToMarkdown(
  text: string,
  rawEntities: ReadonlyArray<MessageEntity | WireMessageEntity>,
): string {
  if (!text || rawEntities.length === 0) {
    return text;
  }

  const clampedEntities = sortEntitiesCanonical(
    rawEntities
      .map((e) => {
        const parsed = fromWireMessageEntity(e);
        const start = clampUtf16Boundary(text, parsed.offset);
        const end = clampUtf16Boundary(text, parsed.offset + parsed.length);
        return {
          ...parsed,
          offset: start,
          length: Math.max(0, end - start),
        };
      })
      .filter((e) => e.length > 0 && e.offset >= 0 && e.offset + e.length <= text.length),
  );

  const boldStartSet = new Set<number>();
  const boldEndSet = new Set<number>();
  for (const ent of clampedEntities) {
    if (ent.type === 'bold') {
      boldStartSet.add(ent.offset);
      boldEndSet.add(ent.offset + ent.length);
    }
  }

  const openEvents = new Map<number, IndexedEntity[]>();
  const closeEvents = new Map<number, IndexedEntity[]>();
  const blockquoteRanges: Array<{ start: number; end: number; collapsed: boolean }> = [];

  clampedEntities.forEach((ent, idx) => {
    if (ent.type === 'blockquote' || ent.type === 'expandable_blockquote') {
      blockquoteRanges.push({
        start: ent.offset,
        end: ent.offset + ent.length,
        collapsed: ent.type === 'expandable_blockquote' ? (ent.collapsed ?? true) : Boolean(ent.collapsed),
      });
      return;
    }
    if (
      ent.type === 'url' ||
      ent.type === 'mention' ||
      ent.type === 'hashtag' ||
      ent.type === 'cashtag' ||
      ent.type === 'bot_command' ||
      ent.type === 'timestamp' ||
      ent.type === 'custom_emoji'
    ) {
      return;
    }

    const endPos = ent.offset + ent.length;
    let italicDelim: '*' | '_' = '*';
    if (ent.type === 'italic' && (boldStartSet.has(ent.offset) || boldEndSet.has(endPos))) {
      const prevCh = ent.offset > 0 ? text[ent.offset - 1] : undefined;
      const nextCh = endPos < text.length ? text[endPos] : undefined;
      if (!isAsciiWordChar(prevCh) && !isAsciiWordChar(nextCh)) {
        italicDelim = '_';
      }
    }

    const wrapped: IndexedEntity = {
      ent,
      priority: entityWrapperPriority(ent.type),
      idx,
      italicDelim,
    };

    const startList = openEvents.get(ent.offset) ?? [];
    startList.push(wrapped);
    openEvents.set(ent.offset, startList);

    const endList = closeEvents.get(endPos) ?? [];
    endList.push(wrapped);
    closeEvents.set(endPos, endList);
  });

  // Sort openings outer-first (longest first, then outer wrapper priority, then index)
  for (const list of openEvents.values()) {
    list.sort((a, b) => {
      if (b.ent.length !== a.ent.length) return b.ent.length - a.ent.length;
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.idx - b.idx;
    });
  }

  // Sort closings in strict LIFO reverse of openings (later-opened / shorter / higher priority closes FIRST)
  for (const list of closeEvents.values()) {
    list.sort((a, b) => {
      if (a.ent.offset !== b.ent.offset) return b.ent.offset - a.ent.offset;
      if (a.ent.length !== b.ent.length) return a.ent.length - b.ent.length;
      if (a.priority !== b.priority) return b.priority - a.priority;
      return b.idx - a.idx;
    });
  }

  const findBlockquoteAt = (pos: number): { collapsed: boolean } | undefined => {
    const hit = blockquoteRanges.find((r) => pos >= r.start && pos < r.end);
    return hit ? { collapsed: hit.collapsed } : undefined;
  };

  let out = '';
  for (let pos = 0; pos <= text.length; pos++) {
    const closings = closeEvents.get(pos);
    if (closings) {
      for (const item of closings) {
        out += closingTokenForEntity(item);
      }
    }

    if (pos === text.length) break;

    if (pos === 0 || text[pos - 1] === '\n') {
      const bq = findBlockquoteAt(pos);
      if (bq) {
        out += bq.collapsed ? '>> ' : '> ';
      }
    }

    const openings = openEvents.get(pos);
    if (openings) {
      for (const item of openings) {
        out += openingTokenForEntity(item);
      }
    }

    out += text[pos]!;
  }

  return out;
}

function openingTokenForEntity(item: IndexedEntity): string {
  const { ent } = item;
  switch (ent.type) {
    case 'bold':
      return '**';
    case 'italic':
      return item.italicDelim;
    case 'underline':
      return '__';
    case 'strikethrough':
      return '~~';
    case 'spoiler':
      return '||';
    case 'code':
      return '`';
    case 'pre':
      return ent.language ? `\`\`\`${ent.language}\n` : '```\n';
    case 'text_url':
      return '[';
    default:
      return '';
  }
}

function closingTokenForEntity(item: IndexedEntity): string {
  const { ent } = item;
  switch (ent.type) {
    case 'bold':
      return '**';
    case 'italic':
      return item.italicDelim;
    case 'underline':
      return '__';
    case 'strikethrough':
      return '~~';
    case 'spoiler':
      return '||';
    case 'code':
      return '`';
    case 'pre':
      return '\n```';
    case 'text_url':
      return `](${ent.url ?? ''})`;
    default:
      return '';
  }
}

/**
 * Splits `text` at every UTF-16 entity boundary for clean React / HTML rendering.
 */
export function renderEntitiesSegments(
  text: string,
  rawEntities: ReadonlyArray<MessageEntity | WireMessageEntity>,
): EntitySegment[] {
  if (!text) return [];
  const clampedEntities: Array<{ ent: MessageEntity; start: number; end: number }> = [];
  for (const raw of rawEntities) {
    const ent = fromWireMessageEntity(raw);
    if (ent.length <= 0 || ent.offset < 0 || ent.offset + ent.length > text.length) {
      continue;
    }
    const start = clampUtf16Boundary(text, ent.offset);
    const end = clampUtf16Boundary(text, ent.offset + ent.length);
    if (end <= start) {
      continue;
    }
    clampedEntities.push({
      ent:
        start === ent.offset && end - start === ent.length
          ? ent
          : { ...ent, offset: start, length: end - start },
      start,
      end,
    });
  }

  if (clampedEntities.length === 0) {
    return [{ text, offset: 0, length: text.length, activeEntities: [] }];
  }

  const boundaries = new Set<number>([0, text.length]);
  for (const item of clampedEntities) {
    boundaries.add(item.start);
    boundaries.add(item.end);
  }

  const sortedPoints = Array.from(boundaries).sort((a, b) => a - b);
  const segments: EntitySegment[] = [];

  for (let i = 0; i < sortedPoints.length - 1; i++) {
    const start = sortedPoints[i]!;
    const end = sortedPoints[i + 1]!;
    if (end <= start) continue;
    const active = clampedEntities
      .filter((item) => item.start <= start && item.end >= end)
      .map((item) => item.ent);
    segments.push({
      text: text.slice(start, end),
      offset: start,
      length: end - start,
      activeEntities: active,
    });
  }

  return segments;
}

/**
 * Renders `text` + `entities` into XSS-safe HTML (useful for HTML chat export and rich previews).
 */
export function renderEntitiesToSafeHtml(
  text: string,
  rawEntities: ReadonlyArray<MessageEntity | WireMessageEntity>,
): string {
  if (!text) return '';
  const segments = renderEntitiesSegments(text, rawEntities);
  return segments
    .map((seg) => {
      let html = escapeHtml(seg.text);
      for (const ent of [...seg.activeEntities].reverse()) {
        switch (ent.type) {
          case 'bold':
            html = `<strong>${html}</strong>`;
            break;
          case 'italic':
            html = `<em>${html}</em>`;
            break;
          case 'underline':
            html = `<u>${html}</u>`;
            break;
          case 'strikethrough':
            html = `<s>${html}</s>`;
            break;
          case 'spoiler':
            html = `<span class="tg-spoiler" data-spoiler="true">${html}</span>`;
            break;
          case 'code':
            html = `<code>${html}</code>`;
            break;
          case 'pre': {
            const langAttr = ent.language ? ` data-language="${escapeHtml(ent.language)}"` : '';
            html = `<pre${langAttr}><code>${html}</code></pre>`;
            break;
          }
          case 'blockquote':
            html = ent.collapsed
              ? `<blockquote data-expandable="true" data-collapsed="true">${html}</blockquote>`
              : `<blockquote>${html}</blockquote>`;
            break;
          case 'expandable_blockquote': {
            const isCollapsed = ent.collapsed === false ? 'false' : 'true';
            html = `<blockquote data-expandable="true" data-collapsed="${isCollapsed}">${html}</blockquote>`;
            break;
          }
          case 'text_url':
          case 'url': {
            const candidate = ent.url ?? seg.text;
            if (isSafeEntityUrl(candidate)) {
              html = `<a href="${escapeHtml(candidate)}" target="_blank" rel="noopener noreferrer">${html}</a>`;
            }
            break;
          }
          case 'mention':
            html = `<span class="tg-mention">${html}</span>`;
            break;
          case 'hashtag':
            html = `<span class="tg-hashtag">${html}</span>`;
            break;
          case 'cashtag':
            html = `<span class="tg-cashtag">${html}</span>`;
            break;
          case 'bot_command':
            html = `<span class="tg-bot-command">${html}</span>`;
            break;
          case 'timestamp':
            html = `<span class="tg-timestamp" data-seconds="${escapeHtml(String(toSafeInt(ent.seconds, 0)))}">${html}</span>`;
            break;
          case 'custom_emoji':
            html = `<span class="tg-custom-emoji" data-document-id="${escapeHtml(String(toSafeInt(ent.documentId, 0)))}">${html}</span>`;
            break;
        }
      }
      return html;
    })
    .join('');
}

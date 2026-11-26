/**
 * Canonical `tg://apple/*` Deep-Link Parser & Formatter (`v1.7.0`).
 *
 * Format: `tg://apple/<books|music|games|appstore|creations>[/<id>][?tab=&action=]`
 */

export const APPLE_DEEP_LINK_SECTIONS = [
  'books',
  'music',
  'games',
  'appstore',
  'creations',
] as const;

export type AppleDeepLinkSection = (typeof APPLE_DEEP_LINK_SECTIONS)[number];

const APPLE_SECTION_SET = new Set<string>(APPLE_DEEP_LINK_SECTIONS);
const SAFE_APPLE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_QUERY_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED_PARAM_KEYS = new Set<string>([
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
]);

export interface AppleDeepLink {
  section: AppleDeepLinkSection;
  id?: string;
  tab?: string;
  action?: string;
  params?: Record<string, string>;
}

/**
 * Strictly parses `tg://apple/<section>[/<id>][?tab=...&action=...]`.
 * Rejects non-`tg:` schemes, wrong hosts, unknown sections, path traversal (`..`),
 * whitespace/control chars, empty segments, and unsafe IDs.
 */
export function parseAppleDeepLink(raw: string): AppleDeepLink | null {
  if (typeof raw !== 'string') return null;
  if (/[\u0000-\u001F\u007F]/.test(raw)) {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed || /[\u0000-\u001F\u007F\s]/.test(trimmed)) {
    return null;
  }

  // Must start strictly with tg://apple/ (case-insensitive scheme+host)
  const prefixMatch = /^tg:\/\/apple(\/|$|\?|#)/i.exec(trimmed);
  if (!prefixMatch) {
    return null;
  }

  // Strip fragment first
  const withoutHash = trimmed.split('#', 1)[0] ?? '';
  const afterHost = withoutHash.slice('tg://apple'.length);
  if (!afterHost.startsWith('/')) {
    return null;
  }

  const qIdx = afterHost.indexOf('?');
  const rawPath = qIdx === -1 ? afterHost.slice(1) : afterHost.slice(1, qIdx);
  const rawQuery = qIdx === -1 ? '' : afterHost.slice(qIdx + 1);

  if (!rawPath || rawPath.includes('..') || rawPath.includes('\\')) {
    return null;
  }

  const segments = rawPath.split('/');
  // Allow optional trailing slash only when path is `<section>/`
  const cleanSegments =
    segments.length === 2 && segments[1] === '' ? [segments[0]!] : segments;

  if (cleanSegments.length < 1 || cleanSegments.length > 2) {
    return null;
  }

  const rawSection = cleanSegments[0]!.toLowerCase();
  if (!APPLE_SECTION_SET.has(rawSection)) {
    return null;
  }

  let id: string | undefined;
  if (cleanSegments.length === 2) {
    const rawId = cleanSegments[1]!;
    if (!rawId || !SAFE_APPLE_ID_RE.test(rawId) || rawId.includes('..')) {
      return null;
    }
    id = rawId;
  }

  const result: AppleDeepLink = {
    section: rawSection as AppleDeepLinkSection,
  };
  if (id !== undefined) {
    result.id = id;
  }

  if (rawQuery.length > 0) {
    const searchParams = new URLSearchParams(rawQuery);
    const extraParams: Record<string, string> = Object.create(null) as Record<string, string>;
    let hasExtra = false;
    for (const [k, v] of searchParams.entries()) {
      if (!SAFE_QUERY_KEY_RE.test(k) || RESERVED_PARAM_KEYS.has(k)) continue;
      if (/[\u0000-\u001F\u007F]/.test(v)) return null;
      if (k === 'tab') {
        if (v.length > 0) result.tab = v;
      } else if (k === 'action') {
        if (v.length > 0) result.action = v;
      } else {
        extraParams[k] = v;
        hasExtra = true;
      }
    }
    if (hasExtra) {
      result.params = Object.assign({}, extraParams);
    }
  }

  return result;
}

/**
 * Formats an `AppleDeepLink` into canonical deterministic `tg://apple/<section>[/<id>][?tab=...&action=...]`.
 */
export function formatAppleDeepLink(link: AppleDeepLink): string {
  if (!APPLE_SECTION_SET.has(link.section)) {
    throw new Error(`Invalid Apple deep-link section: ${String(link.section)}`);
  }

  let base = `tg://apple/${link.section}`;
  if (link.id !== undefined && link.id !== '') {
    if (!SAFE_APPLE_ID_RE.test(link.id)) {
      throw new Error(`Invalid Apple deep-link id: ${link.id}`);
    }
    base += `/${link.id}`;
  }

  const sp = new URLSearchParams();
  if (link.tab !== undefined && link.tab !== '') {
    sp.set('tab', link.tab);
  }
  if (link.action !== undefined && link.action !== '') {
    sp.set('action', link.action);
  }
  if (link.params) {
    for (const key of Object.keys(link.params).sort()) {
      if (
        key === 'tab' ||
        key === 'action' ||
        RESERVED_PARAM_KEYS.has(key) ||
        !SAFE_QUERY_KEY_RE.test(key)
      ) {
        continue;
      }
      const val = link.params[key];
      if (val !== undefined) {
        sp.set(key, val);
      }
    }
  }

  const query = sp.toString();
  return query ? `${base}?${query}` : base;
}

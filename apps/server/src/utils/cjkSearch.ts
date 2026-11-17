import { escapeHtml } from '@gpui-telegram/protocol';

/**
 * Escapes `%`, `_`, and `\` so user input can be safely passed into parameterized
 * `LIKE ? ESCAPE '\'` SQLite queries without wildcard injection or SQL syntax errors.
 */
export function escapeSqlLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export interface ParsedSearchQuery {
  rawQuery: string;
  cleanQuery: string;
  terms: string[];
  fromUsername?: string;
}

/**
 * Parses inline `from:@username` or `from:username` prefixes and splits search terms
 * cleanly across both whitespace-separated Latin words and unsegmented CJK phrases!
 */
export function parseSearchQuery(raw: string): ParsedSearchQuery {
  let working = raw.trim();
  let fromUsername: string | undefined;

  const fromMatch = /(?:^|\s)from:@?([A-Za-z0-9_]+)(?=\s|$)/i.exec(working);
  if (fromMatch) {
    fromUsername = fromMatch[1]!.toLowerCase();
    working = (
      working.slice(0, fromMatch.index) + working.slice(fromMatch.index + fromMatch[0].length)
    ).trim();
  }

  const terms = working
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  return {
    rawQuery: raw,
    cleanQuery: working,
    terms,
    fromUsername,
  };
}

/**
 * Builds an XSS-safe `<mark>...</mark>` highlighted snippet around the first occurrence
 * of any search term (supports 1-char, 2-char, and full phrase CJK + case-insensitive Latin).
 * Every non-tag character is HTML-escaped BEFORE `<mark>` tags are inserted, so `<script>` in
 * message text is always escaped to `&lt;script&gt;`.
 */
export function buildHighlightedSnippet(
  fullText: string,
  terms: string[],
  maxWindowChars = 140,
): string {
  if (!fullText) return '';
  const validTerms = terms.filter((t) => t.length > 0);
  if (validTerms.length === 0) {
    const truncated =
      fullText.length > maxWindowChars ? `${fullText.slice(0, maxWindowChars)}…` : fullText;
    return escapeHtml(truncated);
  }

  const lowerFull = fullText.toLowerCase();
  let firstMatchIdx = -1;
  for (const term of validTerms) {
    const idx = lowerFull.indexOf(term.toLowerCase());
    if (idx !== -1 && (firstMatchIdx === -1 || idx < firstMatchIdx)) {
      firstMatchIdx = idx;
    }
  }

  let sliceStart = 0;
  let sliceEnd = fullText.length;
  if (fullText.length > maxWindowChars && firstMatchIdx !== -1) {
    sliceStart = Math.max(0, firstMatchIdx - 40);
    sliceEnd = Math.min(fullText.length, sliceStart + maxWindowChars);
  } else if (fullText.length > maxWindowChars) {
    sliceEnd = maxWindowChars;
  }

  const prefixEllipsis = sliceStart > 0 ? '…' : '';
  const suffixEllipsis = sliceEnd < fullText.length ? '…' : '';
  const windowText = fullText.slice(sliceStart, sliceEnd);

  // Find non-overlapping match intervals inside windowText
  const lowerWindow = windowText.toLowerCase();
  const intervals: Array<{ start: number; end: number }> = [];
  const sortedTerms = [...validTerms].sort((a, b) => b.length - a.length);

  let pos = 0;
  while (pos < windowText.length) {
    let bestStart = -1;
    let bestLen = 0;
    for (const term of sortedTerms) {
      const idx = lowerWindow.indexOf(term.toLowerCase(), pos);
      if (idx !== -1 && (bestStart === -1 || idx < bestStart || (idx === bestStart && term.length > bestLen))) {
        bestStart = idx;
        bestLen = term.length;
      }
    }
    if (bestStart === -1 || bestLen === 0) {
      break;
    }
    intervals.push({ start: bestStart, end: bestStart + bestLen });
    pos = bestStart + bestLen;
  }

  if (intervals.length === 0) {
    return `${prefixEllipsis}${escapeHtml(windowText)}${suffixEllipsis}`;
  }

  let out = prefixEllipsis;
  let cursor = 0;
  for (const iv of intervals) {
    if (iv.start > cursor) {
      out += escapeHtml(windowText.slice(cursor, iv.start));
    }
    out += `<mark>${escapeHtml(windowText.slice(iv.start, iv.end))}</mark>`;
    cursor = iv.end;
  }
  if (cursor < windowText.length) {
    out += escapeHtml(windowText.slice(cursor));
  }
  out += suffixEllipsis;
  return out;
}

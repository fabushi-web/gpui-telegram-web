import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ALGO_PRESETS,
  APPLE_DEEP_LINK_SECTIONS,
  BOT_AGENTS,
  BOT_AGENT_METADATA,
  BOT_AVATAR_OUTFITS,
  BOT_IMPORT_SOURCES,
  BOT_LEGACY_READABLE_AGENTS,
  BOT_MASCOT_IDS,
  BOT_MEMORY_INDEX_LINE_CAP,
  BOT_MEMORY_PROTECTED_PREFIXES,
  BOT_PACKAGE_SCHEMA_VERSION,
  BOT_PICKABLE_MASCOT_IDS,
  BOT_REQUEST_POLICY_PRECEDENCE,
  BOT_RETIRED_AGENT_MIGRATIONS,
  BOT_TEMPLATE_CATEGORIES,
  COMMUNITY_ALGO_PRESET_WEIGHTS,
  COMMUNITY_NOTIFICATION_KINDS,
  CONTENT_HUB_ACCENTS,
  CREATION_KINDS,
  CREATION_REVIEW_DECISIONS,
  CREATION_REVIEW_STATUSES,
  CREATION_VISIBILITIES,
  CREATOR_STUDIO_BOT_DISPLAY_NAME,
  CREATOR_STUDIO_BOT_USER_ID,
  CREATOR_STUDIO_BOT_USERNAME,
  DEFAULT_ALGO_PREFERENCES,
  DOM_IDS,
  E2EE_V2_KEY_SCHEDULE_BYTES,
  FABUSHI_PROTOCOL_VERSION,
  FEED_SORTS,
  FEED_TAB_KINDS,
  NATIVE_CHAT_BOT_CARD_KINDS,
  NOTIFICATION_CATEGORY_TABS,
  ORCA_BOT_AVATAR_COLORS,
  ORCA_BOT_ERROR_CODES,
  ORCA_BOT_ERROR_HTTP_STATUS,
  ORCA_BOT_TEMPLATES,
  ORCA_BUNDLED_SKILLS,
  ORCA_EVENT_TRIGGERS,
  ORCA_HIBERNATION_BLOCKERS,
  ORCA_IDE_ERROR_CODES,
  ORCA_IDE_ERROR_HTTP_STATUS,
  ORCA_MAILBOX_MESSAGE_TYPES,
  ORCA_PLUGIN_CONTRIBUTION_POINTS,
  ORCA_PLUGIN_TIERS,
  ORCA_RUNTIME_PROTOCOL_VERSION,
  ORCA_SECRET_SCAN_CLASSES,
  ORCA_TAB_COLORS,
  ORCA_TAB_CONTENT_TYPES,
  ORCA_TIDY_UP_ERROR_CODES,
  ORCA_TIDY_UP_ERROR_HTTP_STATUS,
  ORCA_USAGE_PROVIDERS_9,
  ORCA_WAKE_CLOSE_OVERSIZE,
  ORCA_WAKE_CLOSE_SUPERSEDED,
  ORCA_WAKE_MAX_FRAME_BYTES,
  ORCA_WAKE_MAX_INBOUND_FRAME_BYTES,
  ORCA_WEBHOOK_ADAPTERS,
  POST_FORMATS,
  READD_GUARD_DAYS,
  SECURITY_MODAL_KINDS,
  SECURITY_SURFACE_PALETTE,
  WEBHOOK_ACCOUNT_HOURLY_CAP,
  WEBHOOK_CALL_STATES,
  WEBHOOK_HOOK_HOURLY_CAP,
  buildBotRecommendationMessage,
  canTransitionCreationReviewStatus,
  containsObscuredXssPattern,
  creationKindToPath,
  formatAppleDeepLink,
  formatCreationDeepLink,
  fromWireMessageEntity,
  isInvisibleFormatChar,
  isOrcaSystemShortcutBlocked,
  matchesNotificationCategoryTab,
  normalizeBookmarkFolder,
  parseAppleDeepLink,
  parseCreationDeepLink,
  parseCreationKind,
  parseMarkdownEntities,
  renderEntitiesSegments,
  renderEntitiesToSafeHtml,
  sanitizeAlgoPrefs,
  sanitizeRecommendationReason,
  scanOrcaBotTextForSecrets,
  serializeEntitiesToMarkdown,
  toWireMessageEntity,
  validateCreationPublishInput,
  validateCreationReviewTransition,
  visibleCharCount,
  type BrowserDesignModeClientPort,
  type CommunityClientPort,
  type ContentFreeWakeFrame,
  type CreationKind,
  type CreationsClientPort,
  type OrcaBotsClientPort,
  type OrcaIdeClientPort,
  type OrcaWakeFrame,
  type TelegramClientPort,
  type UpdateEvent,
} from '@gpui-telegram/protocol';
import { DEFAULT_APP_VERSION } from '../../../apps/server/src/config.js';
import { shouldProxyWebSocketPathname } from '../../../apps/server/src/proxy.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../../..');

/**
 * Converts a `#RRGGBB` hex swatch into HSL `(h in [0, 360), s in [0, 1], l in [0, 1])`.
 */
function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const clean = hex.replace(/^#/, '');
  const r = Number.parseInt(clean.slice(0, 2), 16) / 255;
  const g = Number.parseInt(clean.slice(2, 4), 16) / 255;
  const b = Number.parseInt(clean.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) {
    return { h: 0, s: 0, l };
  }
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  switch (max) {
    case r:
      h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
      break;
    case g:
      h = ((b - r) / d + 2) * 60;
      break;
    default:
      h = ((r - g) / d + 4) * 60;
      break;
  }
  return { h, s, l };
}

function assertNotDarkPurpleHue(hex: string, label: string): void {
  const { h, s } = hexToHsl(hex);
  if (s >= 0.08) {
    const inForbiddenPurpleBand = h >= 235 && h <= 315;
    expect(
      inForbiddenPurpleBand,
      `${label} (${hex}) falls inside forbidden purple hue band [235°, 315°] (H=${h.toFixed(1)}°)`,
    ).toBe(false);
  }
}

describe('Fabushi v1.7.0 Workspace Manifests, Shell & Canonical DOM_IDS Freeze', () => {
  it('aligns protocol, server, all 4 workspace manifests, test:e2e script, index.html, manifest.webmanifest, and sw.js', () => {
    expect(FABUSHI_PROTOCOL_VERSION).toBe('1.7.0');
    expect(DEFAULT_APP_VERSION).toBe('1.7.0');

    const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      version: string;
      scripts: Record<string, string>;
    };
    const protoPkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'packages/protocol/package.json'), 'utf8'),
    ) as { version: string };
    const serverPkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'apps/server/package.json'), 'utf8'),
    ) as { version: string };
    const webPkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'apps/web/package.json'), 'utf8'),
    ) as { version: string };

    expect(rootPkg.version).toBe('1.7.0');
    expect(protoPkg.version).toBe('1.7.0');
    expect(serverPkg.version).toBe('1.7.0');
    expect(webPkg.version).toBe('1.7.0');
    expect(rootPkg.scripts['test:e2e']).toBe('npm --prefix e2e run test');

    const indexHtml = fs.readFileSync(path.join(repoRoot, 'apps/web/index.html'), 'utf8');
    expect(indexHtml).toContain('v1.7.0');

    const swJs = fs.readFileSync(path.join(repoRoot, 'apps/web/public/sw.js'), 'utf8');
    expect(swJs).toContain('v1.7.0');
    expect(swJs).toContain("const CACHE_NAME = 'fabushi-web-v6'");

    const webManifest = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'apps/web/public/manifest.webmanifest'), 'utf8'),
    ) as { name: string; description: string };
    expect(webManifest.name).toContain('1.7.0');
    expect(webManifest.description).toContain('1.7.0');
  });

  it('freezes all 37 new canonical DOM_IDS (187 unique kebab-case IDs total)', () => {
    const expectedNewIds = [
      'apple-sidebar',
      'btn-toggle-apple-sidebar',
      'apple-nav-chats',
      'apple-nav-community',
      'apple-nav-books',
      'apple-nav-music',
      'apple-nav-games',
      'apple-nav-appstore',
      'apple-nav-creations',
      'quick-creations-drawer',
      'btn-toggle-quick-creations',
      'content-hub-workspace',
      'publish-review-modal',
      'music-synth-player',
      'mini-game-canvas',
      'nav-dest-community',
      'community-workspace',
      'community-feed',
      'community-composer-modal',
      'community-mod-queue',
      'community-bot-studio',
      'community-lists-view',
      'community-algo-tuner',
      'nav-dest-orca-bots',
      'nav-dest-orca-ide',
      'orca-bots-workspace',
      'orca-needs-you-inbox',
      'orca-ide-workspace',
      'orca-split-layout',
      'orca-jump-palette',
      'orca-kanban-board',
      'orca-diff-panel',
      'orca-usage-popover',
      'orca-vault-panel',
      'orca-plugins-panel',
      'orca-security-surface-modal',
      'browser-design-mode-overlay',
    ];

    expect(expectedNewIds.length).toBe(37);
    const values = Object.values(DOM_IDS);
    expect(values.length).toBe(187);
    expect(new Set(values).size).toBe(187);

    for (const id of expectedNewIds) {
      expect(values).toContain(id);
      expect(id).toMatch(/^[a-z0-9-]+$/);
    }
  });
});

describe('Creation Studio & Public Catalog Contracts (`creations.ts`)', () => {
  it('enforces constants, enums, review FSM transitions, deep links, XSS/invisible guards, and dark-safe non-purple accents', () => {
    expect(CREATOR_STUDIO_BOT_USERNAME).toBe('creator_studio_bot');
    expect(CREATOR_STUDIO_BOT_USER_ID).toBe(777_100);
    expect(CREATOR_STUDIO_BOT_DISPLAY_NAME).toBe('CreatorStudioBot');
    expect(CREATION_KINDS).toEqual(['book', 'music', 'game', 'app']);
    expect(CREATION_VISIBILITIES).toEqual(['private', 'unlisted', 'public']);
    expect(CREATION_REVIEW_STATUSES).toEqual([
      'draft',
      'pending_review',
      'approved',
      'rejected',
      'removed',
    ]);
    expect(CREATION_REVIEW_DECISIONS).toEqual(['approve', 'reject', 'remove']);

    // Verify ALL Content Hub accents avoid forbidden dark-purple hue [235°, 315°]
    for (const [key, hex] of Object.entries(CONTENT_HUB_ACCENTS)) {
      assertNotDarkPurpleHue(hex, `CONTENT_HUB_ACCENTS.${key}`);
    }

    // Review FSM transition matrix
    expect(canTransitionCreationReviewStatus('draft', 'pending_review')).toBe(true);
    expect(canTransitionCreationReviewStatus('draft', 'approved')).toBe(false);
    expect(canTransitionCreationReviewStatus('pending_review', 'approved')).toBe(true);
    expect(canTransitionCreationReviewStatus('approved', 'removed')).toBe(true);
    expect(canTransitionCreationReviewStatus('rejected', 'approved')).toBe(false);

    expect(validateCreationReviewTransition('pending_review', 'approved', false)).toMatchObject({
      ok: false,
      code: 'admin_required',
      httpStatus: 403,
    });
    expect(validateCreationReviewTransition('pending_review', 'rejected', true, '   \u200B  ')).toMatchObject({
      ok: false,
      code: 'reason_required',
      httpStatus: 400,
    });
    expect(validateCreationReviewTransition('pending_review', 'rejected', true, 'Copyright mismatch')).toEqual({
      ok: true,
    });
    expect(validateCreationReviewTransition('approved', 'removed', true, 'Policy violation')).toEqual({
      ok: true,
    });

    // Deep-link parse & format round-trips
    expect(creationKindToPath('book')).toBe('books');
    expect(creationKindToPath('app')).toBe('appstore');
    expect(parseCreationKind('miniapp')).toBe('app');
    const nativeLink = formatCreationDeepLink('book', 'cr_abc123');
    expect(nativeLink).toBe('fabushi://catalog/books/cr_abc123');
    expect(parseCreationDeepLink(nativeLink)).toEqual({ kind: 'book', creationId: 'cr_abc123' });
    expect(
      parseCreationDeepLink('https://fabushi.app/catalog/games/g_42?ref=chat#top'),
    ).toEqual({ kind: 'game', creationId: 'g_42' });
    expect(parseCreationDeepLink('fabushi://catalog/books/../secret')).toBeNull();
    expect(parseCreationDeepLink('javascript:alert(1)')).toBeNull();

    // Invisible char & obscured XSS guards
    expect(isInvisibleFormatChar('\u200B')).toBe(true);
    expect(visibleCharCount('\u200B\uFEFF  \u3000')).toBe(0);
    expect(visibleCharCount('Hello世界')).toBe(7);
    expect(containsObscuredXssPattern('<scr\u200Bipt>alert(1)</script>')).toBe(true);
    expect(containsObscuredXssPattern('&#106;avascript:alert(1)')).toBe(true);
    expect(containsObscuredXssPattern('<img src=x onerror=alert(1)>')).toBe(true);
    expect(containsObscuredXssPattern('data:text/html,<svg onload=alert(1)>')).toBe(true);
    expect(containsObscuredXssPattern('Normal book summary about Rust & TypeScript')).toBe(false);

    expect(
      validateCreationPublishInput({ title: '\u200B\u200C   ', summary: 'Valid summary' }),
    ).toMatchObject({ ok: false, code: 'invalid_title' });
    expect(
      validateCreationPublishInput({ title: 'Good Title', summary: '<script>evil()</script>' }),
    ).toMatchObject({ ok: false, code: 'xss_rejected' });
    expect(
      validateCreationPublishInput({
        title: 'Clean Guide',
        summary: 'Practical guide to SQLite WAL.',
        genres: ['tech'],
        tags: ['sqlite'],
        payload_json: JSON.stringify({ chapters: [] }),
      }),
    ).toEqual({ ok: true });

    // Zero-leak reason sanitizer & bot recommendation message builder
    expect(sanitizeRecommendationReason('Contains pending_review draft info')).toBe(
      '来自公开精选目录',
    );
    expect(sanitizeRecommendationReason('热门高分科幻作品')).toBe('热门高分科幻作品');
    const recMsg = buildBotRecommendationMessage([
      {
        creation_id: 'cr_1',
        kind: 'book',
        title: 'Dune Notes',
        subtitle: 'Annotated',
        summary: 'Deep dive',
        author_display_name: 'Alice',
        genres: ['scifi'],
        cover: { accent_hex: CONTENT_HUB_ACCENTS.books },
        rating_avg: 4.9,
        rating_count: 12,
        score: 99,
        reason: 'draft leak attempt',
        deep_link: 'fabushi://catalog/books/cr_1',
      },
    ]);
    expect(recMsg).toContain('Dune Notes');
    expect(recMsg).toContain('来自公开精选目录');
    expect(recMsg).not.toContain('draft leak attempt');
  });
});

describe('Apple Deep Link Contracts (`appleDeepLink.ts`)', () => {
  it('round-trips valid tg://apple/* URLs and rejects traversal or invalid schemes/sections', () => {
    expect(APPLE_DEEP_LINK_SECTIONS).toEqual([
      'books',
      'music',
      'games',
      'appstore',
      'creations',
    ]);

    const parsed = parseAppleDeepLink(
      'tg://apple/music/track_99?tab=lyrics&action=play#section-1',
    );
    expect(parsed).toEqual({
      section: 'music',
      id: 'track_99',
      tab: 'lyrics',
      action: 'play',
    });
    expect(formatAppleDeepLink(parsed!)).toBe('tg://apple/music/track_99?tab=lyrics&action=play');

    expect(parseAppleDeepLink('tg://apple/creations?tab=pending')).toEqual({
      section: 'creations',
      tab: 'pending',
    });
    expect(formatAppleDeepLink({ section: 'books' })).toBe('tg://apple/books');

    // Invalid links must fail closed
    expect(parseAppleDeepLink('https://apple.com/books/1')).toBeNull();
    expect(parseAppleDeepLink('tg://other/books/1')).toBeNull();
    expect(parseAppleDeepLink('tg://apple/unknown/1')).toBeNull();
    expect(parseAppleDeepLink('tg://apple/books/../admin')).toBeNull();
    expect(parseAppleDeepLink('tg://apple/books/id with space')).toBeNull();
    expect(parseAppleDeepLink('tg://apple/books/a/b/c')).toBeNull();
  });
});

describe('Community Platform Contracts (`community.ts`)', () => {
  it('covers 8 post formats, 8 feed tabs, 7 sorts, 7 algo presets, 8 notification tabs, and sanitizes NaN/Infinity weights', () => {
    expect(POST_FORMATS.length).toBe(8);
    expect(FEED_TAB_KINDS.length).toBe(8);
    expect(FEED_SORTS.length).toBe(7);
    expect(ALGO_PRESETS.length).toBe(7);
    expect(NOTIFICATION_CATEGORY_TABS.length).toBe(8);
    expect(COMMUNITY_NOTIFICATION_KINDS.length).toBe(13);

    // Every notification kind must match `all` and at least one specific category tab
    const specificTabs = NOTIFICATION_CATEGORY_TABS.filter((t) => t !== 'all');
    for (const kind of COMMUNITY_NOTIFICATION_KINDS) {
      expect(matchesNotificationCategoryTab('all', kind)).toBe(true);
      const matched = specificTabs.filter((tab) => matchesNotificationCategoryTab(tab, kind));
      expect(matched.length).toBe(1);
    }

    expect(normalizeBookmarkFolder('')).toBe('All');
    expect(normalizeBookmarkFolder('Unsorted')).toBe('All');
    expect(normalizeBookmarkFolder('all')).toBe('All');
    expect(normalizeBookmarkFolder('Saved Reading')).toBe('Saved Reading');

    expect(COMMUNITY_ALGO_PRESET_WEIGHTS.chronological.recency_weight).toBe(1);
    expect(COMMUNITY_ALGO_PRESET_WEIGHTS.human_focused.bot_content_ratio).toBe(0.1);
    expect(COMMUNITY_ALGO_PRESET_WEIGHTS.bot_heavy.bot_content_ratio).toBe(0.85);

    const sanitized = sanitizeAlgoPrefs({
      preset: 'balanced',
      recency_weight: Number.NaN,
      affinity_weight: Number.POSITIVE_INFINITY,
      quality_weight: Number.NEGATIVE_INFINITY,
      discovery_ratio: -0.5,
      bot_content_ratio: 4.2,
    });
    expect(sanitized.recency_weight).toBe(DEFAULT_ALGO_PREFERENCES.recency_weight);
    expect(sanitized.affinity_weight).toBe(DEFAULT_ALGO_PREFERENCES.affinity_weight);
    expect(sanitized.quality_weight).toBe(DEFAULT_ALGO_PREFERENCES.quality_weight);
    expect(sanitized.discovery_ratio).toBe(0);
    expect(sanitized.bot_content_ratio).toBe(1);
  });
});

describe('Orca Bot OS, Agent IDE, SecuritySurface & Wake WS Contracts (`orca.ts` + `sync.ts`)', () => {
  it('enforces exact error catalogs, 22 agents, 20 mascots x 9 outfits, 24 templates, 13 skills, 31 triggers, 6 adapters, and non-purple palettes', () => {
    expect(ORCA_BOT_ERROR_CODES.length).toBe(29);
    expect(new Set(ORCA_BOT_ERROR_CODES).size).toBe(29);
    for (const code of ORCA_BOT_ERROR_CODES) {
      expect(ORCA_BOT_ERROR_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
    }

    expect(ORCA_IDE_ERROR_CODES.length).toBe(17);
    expect(new Set(ORCA_IDE_ERROR_CODES).size).toBe(17);
    for (const code of ORCA_IDE_ERROR_CODES) {
      expect(ORCA_IDE_ERROR_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
    }

    expect(ORCA_TIDY_UP_ERROR_CODES.length).toBe(16);
    expect(BOT_AGENTS.length).toBe(22);
    expect(BOT_LEGACY_READABLE_AGENTS.length).toBe(7);
    expect(BOT_RETIRED_AGENT_MIGRATIONS.gemini).toBe('antigravity');
    expect(Object.keys(BOT_AGENT_METADATA).length).toBe(22);

    expect(BOT_MASCOT_IDS.length).toBe(20);
    expect(BOT_PICKABLE_MASCOT_IDS.length).toBe(19);
    expect(BOT_PICKABLE_MASCOT_IDS).not.toContain('S2');
    expect(BOT_AVATAR_OUTFITS.length).toBe(9);
    expect(ORCA_BOT_AVATAR_COLORS.length).toBe(11);
    for (const hex of ORCA_BOT_AVATAR_COLORS) {
      assertNotDarkPurpleHue(hex, 'ORCA_BOT_AVATAR_COLORS');
    }

    expect(BOT_MEMORY_INDEX_LINE_CAP).toBe(200);
    expect(BOT_MEMORY_PROTECTED_PREFIXES).toEqual(['Rule:', 'Prefers:', 'Decided:']);
    expect(READD_GUARD_DAYS).toBe(14);
    expect(BOT_REQUEST_POLICY_PRECEDENCE.length).toBe(7);

    expect(BOT_TEMPLATE_CATEGORIES.length).toBe(6);
    expect(ORCA_BOT_TEMPLATES.length).toBe(24);
    for (const tpl of ORCA_BOT_TEMPLATES) {
      expect(tpl.look_around_enabled).toBe(false);
    }
    expect(ORCA_BUNDLED_SKILLS.length).toBe(13);
    expect(BOT_PACKAGE_SCHEMA_VERSION).toBe(1);
    expect(BOT_IMPORT_SOURCES.length).toBe(5);
    expect(NATIVE_CHAT_BOT_CARD_KINDS.length).toBe(10);

    expect(ORCA_EVENT_TRIGGERS.length).toBe(31);
    expect(ORCA_WEBHOOK_ADAPTERS.length).toBe(6);
    expect(WEBHOOK_HOOK_HOURLY_CAP).toBe(200);
    expect(WEBHOOK_ACCOUNT_HOURLY_CAP).toBe(300);
    expect(WEBHOOK_CALL_STATES.length).toBe(14);

    expect(ORCA_MAILBOX_MESSAGE_TYPES.length).toBe(9);
    expect(ORCA_HIBERNATION_BLOCKERS.length).toBe(8);
    expect(ORCA_USAGE_PROVIDERS_9.length).toBe(9);
    expect(ORCA_PLUGIN_TIERS.length).toBe(4);
    expect(ORCA_PLUGIN_CONTRIBUTION_POINTS.length).toBe(16);
    expect(ORCA_RUNTIME_PROTOCOL_VERSION).toBe(3);
    expect(E2EE_V2_KEY_SCHEDULE_BYTES).toBe(96);

    expect(ORCA_TAB_CONTENT_TYPES.length).toBe(10);
    for (const tabType of ORCA_TAB_CONTENT_TYPES) {
      assertNotDarkPurpleHue(ORCA_TAB_COLORS[tabType], `ORCA_TAB_COLORS.${tabType}`);
    }

    // OS shortcut guard
    expect(isOrcaSystemShortcutBlocked('Cmd+Q')).toBe(true);
    expect(isOrcaSystemShortcutBlocked('Ctrl+Alt+Delete')).toBe(true);
    expect(isOrcaSystemShortcutBlocked('Cmd+J')).toBe(false);

    // Exact 10 immutable WCAG-AAA SecuritySurface hex codes + backdrop
    expect(SECURITY_MODAL_KINDS).toEqual([
      'PluginApproval',
      'BotAccessApproval',
      'E2eeVerification',
      'OrcaYamlTrustApproval',
    ]);
    expect(SECURITY_SURFACE_PALETTE).toEqual({
      backdropRgba: 'rgba(5, 7, 12, 0.902)',
      surfaceBg: '#0B0F19',
      headerBg: '#161D2E',
      cardBg: '#111827',
      border: '#F59E0B',
      fgPrimary: '#F8FAFC',
      fgMuted: '#CBD5E1',
      approveBg: '#16A34A',
      denyBg: '#DC2626',
      badgeBg: '#78350F',
      badgeFg: '#FEF3C7',
    });

    // Wake WS constants & proxy allowlist
    expect(ORCA_WAKE_CLOSE_SUPERSEDED).toBe(4409);
    expect(ORCA_WAKE_CLOSE_OVERSIZE).toBe(1009);
    expect(ORCA_WAKE_MAX_FRAME_BYTES).toBe(16384);
    expect(ORCA_WAKE_MAX_INBOUND_FRAME_BYTES).toBe(4096);
    expect(shouldProxyWebSocketPathname('/api/v1/orca/wake')).toBe(true);
    expect(shouldProxyWebSocketPathname('/api/v1/orca/wake?token=abc')).toBe(true);
  });

  it('detects all 5 Orca secret scanner classes and blocks API keys, PEM keys, password assignments, and credential URLs', () => {
    expect(ORCA_SECRET_SCAN_CLASSES.length).toBe(5);

    const apiKeyScan = scanOrcaBotTextForSecrets('token = sk-ant-api03-1234567890abcdefghijklmnop');
    expect(apiKeyScan.blocked).toBe(true);
    expect(apiKeyScan.error_code).toBe('secret_blocked');
    expect(apiKeyScan.findings.some((f) => f.scan_class === 'api_key_or_token')).toBe(true);

    const pemScan = scanOrcaBotTextForSecrets('-----BEGIN OPENSSH PRIVATE KEY-----\nabc');
    expect(pemScan.blocked).toBe(true);
    expect(pemScan.error_code).toBe('secret_blocked');
    expect(pemScan.findings.some((f) => f.scan_class === 'private_key_or_pem')).toBe(true);

    const pwdScan = scanOrcaBotTextForSecrets('db_password = "SuperSecretValue123"');
    expect(pwdScan.blocked).toBe(true);
    expect(pwdScan.findings.some((f) => f.scan_class === 'password_or_secret_assignment')).toBe(true);

    const urlScan = scanOrcaBotTextForSecrets('postgres://admin:topsecret@db.internal:5432/prod');
    expect(urlScan.blocked).toBe(true);
    expect(urlScan.findings.some((f) => f.scan_class === 'sensitive_url_or_path')).toBe(true);

    const piiScan = scanOrcaBotTextForSecrets('Contact alice@example.com for onboarding');
    expect(piiScan.blocked).toBe(false);
    expect(piiScan.clean).toBe(false);
    expect(piiScan.findings.some((f) => f.scan_class === 'personal_identifier')).toBe(true);

    const cleanScan = scanOrcaBotTextForSecrets('Prefer small PRs with unit tests.');
    expect(cleanScan.clean).toBe(true);
    expect(cleanScan.blocked).toBe(false);
  });
});

describe('Rich Entities (`expandable_blockquote`), Sync Events & v1.7.0 Sub-Ports', () => {
  it('round-trips blockquote and expandable_blockquote through wire, markdown, and XSS-safe HTML', () => {
    const parsed = parseMarkdownEntities('>> Collapsible **note** <script>alert(1)</script>');
    const expEntity = parsed.entities.find((e) => e.type === 'expandable_blockquote');
    expect(expEntity).toBeDefined();
    expect(expEntity?.collapsed).toBe(true);

    const wire = toWireMessageEntity(expEntity!);
    expect(wire.entity_type).toEqual({
      type: 'ExpandableBlockquote',
      value: { collapsed: true },
    });
    const roundTripped = fromWireMessageEntity(wire);
    expect(roundTripped.type).toBe('expandable_blockquote');
    expect(roundTripped.collapsed).toBe(true);

    const serialized = serializeEntitiesToMarkdown(parsed.text, parsed.entities);
    expect(serialized.startsWith('>> ')).toBe(true);
    const reparsed = parseMarkdownEntities(serialized);
    expect(reparsed.text).toBe(parsed.text);
    expect(reparsed.entities).toEqual(parsed.entities);

    const html = renderEntitiesToSafeHtml(parsed.text, parsed.entities);
    expect(html).toContain('<blockquote data-expandable="true" data-collapsed="true">');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('supports all 3 new UpdateEvent variants, Orca wake frames, and compiles all 5 v1.7.0 sub-ports', () => {
    const events: UpdateEvent[] = [
      {
        type: 'UserCreationChanged',
        creation_id: 'cr_1',
        revision: 2,
        status: 'pending_review',
        action: 'review_changed',
      },
      {
        type: 'UserCreationChanged',
        data: {
          creation_id: 'cr_1',
          owner_user_id: 1001,
          kind: 'book',
          review_status: 'approved',
          cloud_revision: 3,
        },
      },
      {
        type: 'PublicCatalogChanged',
        entry_id: 'cr_1',
        kind: 'book',
        action: 'published',
      },
      {
        type: 'PublicCatalogChanged',
        data: {
          creation_id: 'cr_1',
          kind: 'book',
          action: 'published',
        },
      },
      {
        type: 'community_event',
        event_kind: 'post_created',
        community_id: 'c_tech',
        post_id: 'p_1',
        actor_id: 'a_1',
        payload: { score: 1 },
      },
      {
        type: 'community_event',
        data: {
          event_kind: 'post_created',
          community_id: 'c_tech',
          post_id: 'p_1',
          payload_json: '{"score":1}',
          timestamp_ms: Date.now(),
        },
      },
    ];
    expect(events.length).toBe(6);

    const wakeFrame: OrcaWakeFrame = {
      type: 'wake',
      scope: 'bot_items',
      entity_id: 'bot_1',
      revision: 4,
      ts_ms: Date.now(),
    };
    const contentFreeFrame: ContentFreeWakeFrame = {
      hostId: 'local',
      kind: 'webhook_call',
      sequence: 7,
      timestampMs: Date.now(),
    };
    expect(wakeFrame.type).toBe('wake');
    expect(contentFreeFrame.kind).toBe('webhook_call');

    // Compile-time verification for sub-port interfaces and optional TelegramClientPort methods
    type VerifySubPorts = [
      CreationsClientPort['listMyCreations'],
      CommunityClientPort['getFeed'],
      OrcaBotsClientPort['listBots'],
      OrcaIdeClientPort['invokeRpc'],
      BrowserDesignModeClientPort['captureDesignMode'],
      TelegramClientPort['queryBotInline'],
      TelegramClientPort['listScheduledMessages'],
      TelegramClientPort['translateMessage'],
      TelegramClientPort['listAdminLog'],
      TelegramClientPort['listCallsHistory'],
    ];
    const portCount: VerifySubPorts['length'] = 10;
    expect(portCount).toBe(10);
  });
});

describe('M1A Iteration 2 Protocol Hardening Regressions (Fixes 1–7)', () => {
  it('blocks tab/CR/LF/HTML-entity XSS bypasses, validates creationId formatting, rejects pre-trim control chars, and strips zero-width leak markers', () => {
    // Defect #1: tab/CR/LF/entity-split scheme bypasses
    const xssVectors = [
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'java\rscript:alert(1)',
      'java&#x09;script:alert(1)',
      'java&#09;script:alert(1)',
      'java&#10;script:alert(1)',
      'java&#13;script:alert(1)',
      'java&#x0a;script:alert(1)',
      'java&#x0d;script:alert(1)',
      'da\tta:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'vb\tscript:msgbox(1)',
    ];
    for (const payload of xssVectors) {
      expect(containsObscuredXssPattern(payload), `XSS must be detected: ${JSON.stringify(payload)}`).toBe(
        true,
      );
      expect(validateCreationPublishInput({ title: payload })).toMatchObject({
        ok: false,
        code: 'xss_rejected',
      });
    }
    // Zero false positives on benign titles/prose
    expect(containsObscuredXssPattern('TypeScript & JavaScript Handbook')).toBe(false);
    expect(validateCreationPublishInput({ title: 'TypeScript & JavaScript Handbook' })).toEqual({
      ok: true,
    });

    // formatCreationDeepLink validates creationId against SAFE_CREATION_ID_RE
    expect(() => formatCreationDeepLink('book', '../secret')).toThrow();
    expect(() => formatCreationDeepLink('book', 'cr 1')).toThrow();
    expect(() => formatCreationDeepLink('book', 'cr_1\r\n')).toThrow();
    expect(() => formatCreationDeepLink('book', '')).toThrow();

    // parseCreationDeepLink rejects control chars BEFORE trimming
    expect(parseCreationDeepLink('fabushi://catalog/books/cr_1\r\n')).toBeNull();
    expect(parseCreationDeepLink('\tfabushi://catalog/books/cr_1')).toBeNull();
    expect(parseCreationDeepLink('fabushi://catalog/books/cr_1\0')).toBeNull();

    // Defect #2: zero-width / tab-obfuscated leak markers in sanitizeRecommendationReason
    const leakReasons = [
      'd\u200Braft',
      'pending_\u200Breview',
      '草\u200B稿',
      '未\u200D审核',
      'user_\uFEFFcreations',
      'java\tscript:alert(1)',
    ];
    for (const reason of leakReasons) {
      expect(sanitizeRecommendationReason(reason)).toBe('来自公开精选目录');
    }
  });

  it('rejects pre-trim control chars and reserved prototype keys in appleDeepLink, and guards non-finite updated_at_ms in community', () => {
    // Defect #6: pre-trim control-char rejection + prototype-safe params
    expect(parseAppleDeepLink('tg://apple/books/cr_1\r\n')).toBeNull();
    expect(parseAppleDeepLink('\ntg://apple/books/cr_1')).toBeNull();

    const onlyReserved = parseAppleDeepLink(
      'tg://apple/books/foo?__proto__=polluted&constructor=evil&prototype=bad&toString=evil&valueOf=1&hasOwnProperty=2',
    );
    expect(onlyReserved).toEqual({ section: 'books', id: 'foo' });
    expect(onlyReserved?.params).toBeUndefined();

    const mixedParams = parseAppleDeepLink(
      'tg://apple/books/foo?__proto__=polluted&constructor=evil&toString=evil&ref=home',
    );
    expect(mixedParams?.params).toEqual({ ref: 'home' });
    expect(Object.prototype.hasOwnProperty.call(mixedParams!.params!, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(mixedParams!.params!, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(mixedParams!.params!, 'prototype')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(mixedParams!.params!, 'toString')).toBe(false);

    // Defect #5: Number.isFinite guard on updated_at_ms
    expect(sanitizeAlgoPrefs({ updated_at_ms: Number.NaN }).updated_at_ms).toBeUndefined();
    expect(
      sanitizeAlgoPrefs({ updated_at_ms: Number.POSITIVE_INFINITY }).updated_at_ms,
    ).toBeUndefined();
    expect(
      sanitizeAlgoPrefs({ updated_at_ms: Number.NEGATIVE_INFINITY }).updated_at_ms,
    ).toBeUndefined();
    expect(sanitizeAlgoPrefs({ updated_at_ms: 1_700_000_000_000 }).updated_at_ms).toBe(
      1_700_000_000_000,
    );
  });

  it('canonicalizes Orca system shortcuts, fixes .env/multi-match/Class 4 secret scanner, exports ORCA_TIDY_UP_ERROR_HTTP_STATUS, and hardens entities', () => {
    // Defect #3: canonical modifier sorting
    const blockedChords = [
      'Alt+Ctrl+Delete',
      'Ctrl+Alt+Delete',
      'Cmd+Ctrl+Q',
      'Ctrl+Cmd+Q',
      'Alt+Cmd+Escape',
      'Option+Command+Esc',
      'Super+L',
      'Win+L',
      'Alt+F4',
      'Cmd+Q',
    ];
    for (const chord of blockedChords) {
      expect(isOrcaSystemShortcutBlocked(chord), `Expected blocked: ${chord}`).toBe(true);
    }
    for (const safeChord of ['Cmd+J', 'Cmd+Shift+J', 'Cmd+K']) {
      expect(isOrcaSystemShortcutBlocked(safeChord), `Expected allowed: ${safeChord}`).toBe(false);
    }

    // Defect #4 + Tidy-Up HTTP status map
    expect(Object.keys(ORCA_TIDY_UP_ERROR_HTTP_STATUS).length).toBe(16);
    for (const code of ORCA_TIDY_UP_ERROR_CODES) {
      expect(ORCA_TIDY_UP_ERROR_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
    expect(ORCA_TIDY_UP_ERROR_HTTP_STATUS.too_many_removed).toBe(422);
    expect(ORCA_TIDY_UP_ERROR_HTTP_STATUS.protected_line_modified).toBe(422);
    expect(ORCA_TIDY_UP_ERROR_HTTP_STATUS.changed).toBe(409);
    expect(ORCA_TIDY_UP_ERROR_HTTP_STATUS.timed_out).toBe(408);

    const sensitivePathInputs = [
      '.env',
      'Do not commit .env',
      'Do not commit .env.local',
      '/app/.env',
      '~/.ssh/id_rsa',
      '~/.aws/credentials',
      '/etc/shadow',
      '.pem',
      '.key',
    ];
    for (const sample of sensitivePathInputs) {
      const scan = scanOrcaBotTextForSecrets(sample);
      expect(scan.clean, `Expected warning for: ${sample}`).toBe(false);
      expect(scan.blocked, `Expected non-blocking for: ${sample}`).toBe(false);
      expect(scan.findings.some((f) => f.scan_class === 'sensitive_url_or_path')).toBe(true);
    }

    // Multi-match PASSWORD_ASSIGNMENT_RE after redacted placeholder on same line
    const multiPwd = scanOrcaBotTextForSecrets('password=[REDACTED:x] api_secret=realSecret123');
    expect(multiPwd.blocked).toBe(true);
    expect(multiPwd.error_code).toBe('secret_blocked');
    expect(multiPwd.findings.some((f) => f.scan_class === 'password_or_secret_assignment')).toBe(
      true,
    );

    // Class 4 Luhn credit card + structured phone number warnings (zero FP on non-Luhn/timestamps/versions)
    const ccScan = scanOrcaBotTextForSecrets('Card 4532-0151-1283-0366');
    expect(ccScan.clean).toBe(false);
    expect(ccScan.blocked).toBe(false);
    expect(
      ccScan.findings.some(
        (f) => f.scan_class === 'personal_identifier' && f.matched_label === 'credit_card',
      ),
    ).toBe(true);

    const badLuhn = scanOrcaBotTextForSecrets('Invalid card 4532-0151-1283-0367');
    expect(badLuhn.clean).toBe(true);

    const phoneScan = scanOrcaBotTextForSecrets('Phone +1-415-555-0199');
    expect(phoneScan.clean).toBe(false);
    expect(phoneScan.blocked).toBe(false);
    expect(
      phoneScan.findings.some(
        (f) => f.scan_class === 'personal_identifier' && f.matched_label === 'phone_number',
      ),
    ).toBe(true);

    for (const benign of [
      'process.env.NODE_ENV',
      'Object.keys(map)',
      'Released v1.7.0 at 1732615679000 on 2026-11-26',
    ]) {
      expect(scanOrcaBotTextForSecrets(benign).clean, `Unexpected FP on: ${benign}`).toBe(true);
    }

    // Defect #7: adjacent > and >> blockquotes stay separate & mid-surrogate clamping attaches cleanly
    const splitBq = parseMarkdownEntities('> normal line\n>> expandable line');
    expect(splitBq.text).toBe('normal line\nexpandable line');
    expect(splitBq.entities).toEqual([
      expect.objectContaining({ type: 'blockquote', offset: 0, length: 11, collapsed: false }),
      expect.objectContaining({
        type: 'expandable_blockquote',
        offset: 12,
        length: 15,
        collapsed: true,
      }),
    ]);
    const splitRoundTrip = parseMarkdownEntities(
      serializeEntitiesToMarkdown(splitBq.text, splitBq.entities),
    );
    expect(splitRoundTrip.text).toBe(splitBq.text);
    expect(splitRoundTrip.entities).toEqual(splitBq.entities);

    const clampedSegments = renderEntitiesSegments('😀🚀', [
      { offset: 1, length: 2, type: 'expandable_blockquote', collapsed: true },
    ]);
    expect(clampedSegments).toHaveLength(2);
    expect(clampedSegments[0]?.text).toBe('😀');
    expect(clampedSegments[0]?.activeEntities).toHaveLength(1);
    expect(clampedSegments[0]?.activeEntities[0]?.type).toBe('expandable_blockquote');
    expect(clampedSegments[1]?.text).toBe('🚀');
    expect(clampedSegments[1]?.activeEntities).toHaveLength(0);
  });
});

describe('M1A Iteration 3 Protocol Hardening Regressions (Fixes 1–5)', () => {
  it('blocks multiline/tab-preceded split URL schemes, HTML5 &sol;/&equals;/&lpar;/&rpar; entities, and RFC 8259 JSON-escaped XSS payloads with zero false positives', () => {
    // Fix 1: multiline/tab-preceded split URL schemes & HTML5 entities
    const multilineAndEntityVectors = [
      'Click below\njava\tscript:alert(1)',
      'Open\tjava\tscript:alert(1)',
      'Hello\r\njava\nscript:alert(1)',
      'Open\nda\tta:text/html;base64,PHNjcmlwdD4=',
      'Run\nvb\tscript:msgbox(1)',
      'data:text&sol;html;base64,PHNjcmlwdD4=',
      '<img src=x onerror&equals;alert&lpar;1&rpar;>',
    ];
    for (const payload of multilineAndEntityVectors) {
      expect(containsObscuredXssPattern(payload), `Expected XSS hit: ${JSON.stringify(payload)}`).toBe(
        true,
      );
      expect(validateCreationPublishInput({ title: 'Book', summary: payload })).toMatchObject({
        ok: false,
        code: 'xss_rejected',
      });
    }
    expect(sanitizeRecommendationReason('Click below\njava\tscript:alert(1)')).toBe(
      '来自公开精选目录',
    );

    // Benign titles & summaries stay strictly 0-FP
    for (const benign of [
      'TypeScript & JavaScript Handbook',
      'Data Engineering: Text & HTML Guide',
    ]) {
      expect(containsObscuredXssPattern(benign), `Unexpected FP: ${benign}`).toBe(false);
      expect(validateCreationPublishInput({ title: benign, summary: benign })).toEqual({
        ok: true,
      });
    }

    // Fix 2A: RFC 8259 JSON-escaped XSS in payload_json (values & keys)
    const jsonEscapedPayloads = [
      JSON.stringify({ url: 'java\tscript:alert(1)' }),
      JSON.stringify({ url: 'java\nscript:alert(1)' }),
      '{"html":"\\u003cscript\\u003ealert(1)\\u003c/script\\u003e"}',
      '{"url":"\\u006aavascript:alert(1)"}',
      '{"chapters":[{"body":"\\u003cimg src=x onerror=alert(1)\\u003e"}]}',
      '{"url":"java\\u200bscript:alert(1)"}',
      '{"\\u003cscript\\u003e":"safe"}',
    ];
    for (const payloadJson of jsonEscapedPayloads) {
      expect(
        validateCreationPublishInput({ title: 'Book', payload_json: payloadJson }),
        `Expected JSON-escaped XSS rejection: ${payloadJson}`,
      ).toMatchObject({
        ok: false,
        code: 'xss_rejected',
      });
    }
    expect(
      validateCreationPublishInput({
        title: 'Book',
        payload_json: JSON.stringify({
          chapters: [
            {
              title: 'TypeScript & JavaScript Handbook',
              body: 'Data Engineering: Text & HTML Guide',
            },
          ],
        }),
      }),
    ).toEqual({ ok: true });

    // Fix 2B: formatCreationDeepLink runtime kind validation
    expect(() => formatCreationDeepLink('../evil' as CreationKind, 'cr_1')).toThrow();
    expect(() => formatCreationDeepLink('toString' as CreationKind, 'cr_1')).toThrow();
    expect(() => formatCreationDeepLink('__proto__' as CreationKind, 'cr_1')).toThrow();
    expect(() => formatCreationDeepLink(undefined as unknown as CreationKind, 'cr_1')).toThrow();
  });

  it('normalizes Unicode whitespace in sanitizeRecommendationReason, strips all Object.prototype keys in appleDeepLink, and hardens Orca sensitive path & alias lookups', () => {
    // Fix 3: Unicode whitespace normalization before invisible stripping
    for (const leaked of [
      'pending\u3000review',
      'pending\u00A0review',
      'pending\u2009review',
      'pen\uFEFFding\u3000re\u200Bview',
    ]) {
      expect(sanitizeRecommendationReason(leaked), `Expected sanitized: ${JSON.stringify(leaked)}`).toBe(
        '来自公开精选目录',
      );
    }
    expect(sanitizeRecommendationReason('编辑精选 · 值得深入阅读')).toBe('编辑精选 · 值得深入阅读');

    // Fix 4: Full Object.prototype reserved key exclusion in appleDeepLink
    const allReservedKeys = [
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
    ];
    const reservedQuery = allReservedKeys.map((k) => `${k}=evil`).join('&');
    const strippedOnly = parseAppleDeepLink(`tg://apple/books/foo?${reservedQuery}`);
    expect(strippedOnly).toEqual({ section: 'books', id: 'foo' });
    expect(strippedOnly?.params).toBeUndefined();

    const withSafeParam = parseAppleDeepLink(`tg://apple/books/foo?${reservedQuery}&sort=top`);
    expect(withSafeParam?.params).toEqual({ sort: 'top' });
    for (const k of allReservedKeys) {
      expect(Object.prototype.hasOwnProperty.call(withSafeParam!.params!, k)).toBe(false);
    }

    // Fix 5A: = and : delimiters in SENSITIVE_PATH_RE with zero FP on process.env / Object.keys
    for (const assignedPath of [
      'ENV_FILE=.env',
      'ENV_FILE=.env.local',
      'CERT_FILE=my.pem',
      'TLS_KEY=server.key',
      '--key=server.key',
      'cert:my.pem',
    ]) {
      const scan = scanOrcaBotTextForSecrets(assignedPath);
      expect(scan.clean, `Expected warning for: ${assignedPath}`).toBe(false);
      expect(scan.blocked, `Expected non-blocking for: ${assignedPath}`).toBe(false);
      expect(scan.findings.some((f) => f.scan_class === 'sensitive_url_or_path')).toBe(true);
    }
    for (const benign of [
      'process.env.NODE_ENV',
      'const env = process.env.NODE_ENV',
      'Object.keys(obj)',
    ]) {
      expect(scanOrcaBotTextForSecrets(benign).clean, `Unexpected FP on: ${benign}`).toBe(true);
    }

    // Fix 5B: Object.hasOwn guards on MODIFIER_ALIASES & KEY_ALIASES
    for (const protoChord of [
      'Cmd+toString',
      'toString+Q',
      'Cmd+toString+Q',
      'Cmd+constructor',
      'valueOf+Alt+Delete',
    ]) {
      expect(isOrcaSystemShortcutBlocked(protoChord), `Unexpected block on: ${protoChord}`).toBe(
        false,
      );
    }
  });
});



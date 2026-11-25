import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import {
  AUTOMATION_APP_LIMITS,
  AUTOMATION_APP_SCHEMA_VERSION_V1,
  scanJsonForSecretLeaks,
  validateAutomationAppId,
  type AutomationAppParam,
  type AutomationScriptApp,
  type BrowserActionKind,
  type BrowserActionTrace,
  type BrowserAuditLogEntry,
  type BrowserCommandRequest,
  type BrowserCommandResult,
  type BrowserControlMode,
  type BrowserControlRevokeResponse,
  type BrowserRegisterPayload,
  type BrowserSnapshotDto,
  type BrowserStateReportPayload,
  type BrowserTargetDescriptor,
  type DesktopPairingTicketDto,
  type HeadlessBrowserSessionDto,
  type McpCallToolResultDto,
  type McpContentItem,
  type McpJsonRpcRequest,
  type McpJsonRpcResponse,
  type McpToolDto,
  type McpToolSchemaDto,
  type RecordedBrowserAction,
  type ScriptAppMetadata,
  type ScriptReplayReport,
  type ScriptStep,
  type SemanticLocator,
  type StepTimingMetric,
  type WsServerFrame,
} from '@gpui-telegram/protocol';
import { sha256Hex } from '../utils/crypto.js';
import {
  ApiError,
  authenticateToken,
  extractBearerToken,
  readJsonBody,
  requireAuth,
  sendJson,
  type HttpRouter,
  type RequestContext,
} from '../utils/http.js';
import type { IncomingMessage } from 'node:http';

function isExecutableFile(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveChromiumBinaryPath(): string | null {
  // 1. Explicit env override takes precedence and fails closed if pointing to non-existent binary
  const explicit =
    process.env.CHROME_EXECUTABLE?.trim() ||
    process.env.CHROMIUM_PATH?.trim() ||
    process.env.PLAYWRIGHT_CHROME_PATH?.trim();
  if (explicit) {
    return isExecutableFile(explicit) ? explicit : null;
  }

  // 2. System Google Chrome
  for (const sysChrome of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']) {
    if (isExecutableFile(sysChrome)) return sysChrome;
  }

  // 3. Playwright bundled Chromium cache (sorted descending by revision)
  const pwRoot = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim() || '/opt/ms-playwright';
  try {
    if (fs.existsSync(pwRoot)) {
      const dirs = fs
        .readdirSync(pwRoot)
        .filter((name) => /^chromium-\d+$/.test(name))
        .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
      for (const dir of dirs) {
        for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
          const full = path.join(pwRoot, dir, sub);
          if (isExecutableFile(full)) return full;
        }
      }
    }
  } catch {
    // Ignore unreadable Playwright dir
  }

  // 4. System Chromium
  for (const sysChromium of [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/lib/chromium/chromium',
  ]) {
    if (isExecutableFile(sysChromium)) return sysChromium;
  }

  return null;
}

export const CHROMIUM_BINARY_PATH =
  resolveChromiumBinaryPath() ?? '/usr/bin/google-chrome';

export function isChromiumBinaryAvailable(): boolean {
  return resolveChromiumBinaryPath() !== null;
}

const activeBridges = new Set<BrowserControlBridge>();
const liveCdpDrivers = new Set<ChromiumCdpDriver>();

process.once('exit', () => {
  for (const driver of Array.from(liveCdpDrivers)) {
    try {
      driver.killFastSync();
    } catch {
      // Ignore exit cleanup error
    }
  }
});

function terminateProcessGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && typeof proc.pid === 'number' && proc.pid > 0) {
    try {
      process.kill(-proc.pid, signal);
    } catch {
      // Ignore ESRCH if process group already exited
    }
  }
  try {
    proc.kill(signal);
  } catch {
    // Ignore if already exited
  }
}

/**
 * Closes all active headless browser sessions across all server instances,
 * ensuring zero leaked Chromium child processes or temporary directories.
 */
export async function closeAllHeadlessSessions(): Promise<void> {
  const tasks: Promise<void>[] = [];
  for (const bridge of activeBridges) {
    tasks.push(bridge.closeAllHeadlessSessions());
  }
  await Promise.allSettled(tasks);
}

export const BROWSER_MCP_TOOL_SCHEMAS: McpToolSchemaDto[] = [
  {
    name: 'browser_list_targets',
    description:
      'List all live web browser tabs and headless browser automation sessions available for the user.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'browser_tab_command',
    description:
      'Execute a structured browser command (snapshot, click, fill, press, hover, scroll, select, navigate, screenshot, evaluate_query, app_action) on a live paired web tab.',
    inputSchema: {
      type: 'object',
      properties: {
        target_id: { type: 'string', description: 'Optional target_id from browser_list_targets' },
        action: {
          type: 'string',
          enum: [
            'snapshot',
            'click',
            'fill',
            'press',
            'hover',
            'scroll',
            'select',
            'navigate',
            'screenshot',
            'evaluate_query',
            'app_action',
          ],
        },
        ref: { type: 'string', description: 'Element reference such as e1, e2' },
        selector: { type: 'string', description: 'CSS selector fallback' },
        text: { type: 'string', description: 'Text to fill, option value, or JS query expression' },
        key: { type: 'string', description: 'Keyboard key to press (e.g. Enter, Escape, Tab)' },
        url: { type: 'string', description: 'URL or route to navigate to' },
        delta_y: { type: 'number', description: 'Vertical scroll delta in pixels' },
        app_action: { type: 'string', description: 'High-level app action identifier' },
        app_payload: { type: 'object', description: 'Payload for app_action' },
        timeout_ms: { type: 'number', description: 'Command timeout in milliseconds (default 8000)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_headless_open',
    description:
      'Launch an isolated real headless Chromium CDP browser session and optionally navigate to an initial URL.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Initial URL (http://, https://, data:, or about:blank)' },
        width: { type: 'number', description: 'Viewport width (default 1280)' },
        height: { type: 'number', description: 'Viewport height (default 800)' },
      },
    },
  },
  {
    name: 'browser_headless_action',
    description:
      'Perform DOM inspection or interaction (snapshot, navigate/goto, click, fill, press, hover, scroll, select, evaluate_query, screenshot) in an open headless Chromium CDP session.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Headless session_id from browser_headless_open' },
        action: {
          type: 'string',
          enum: [
            'snapshot',
            'click',
            'fill',
            'press',
            'hover',
            'scroll',
            'select',
            'navigate',
            'goto',
            'screenshot',
            'evaluate_query',
            'evaluate',
          ],
        },
        ref: { type: 'string', description: 'Element ref from snapshot (e.g. e1)' },
        selector: { type: 'string', description: 'CSS selector fallback' },
        text: { type: 'string', description: 'Input text, select value, or JS expression' },
        key: { type: 'string', description: 'Keyboard key name (e.g. Enter)' },
        url: { type: 'string', description: 'Destination URL for navigate/goto' },
        delta_y: { type: 'number', description: 'Scroll delta Y in pixels' },
      },
      required: ['session_id', 'action'],
    },
  },
  {
    name: 'browser_headless_screenshot',
    description: 'Capture a real PNG screenshot via Chromium CDP of a headless browser session.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Headless session_id' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'browser_snapshot',
    description:
      'Capture an accessibility/DOM ref snapshot (e1, e2, ...) from a live paired web tab or headless session.',
    inputSchema: {
      type: 'object',
      properties: {
        target_id: { type: 'string', description: 'Optional live tab or headless target_id' },
        session_id: { type: 'string', description: 'Optional headless session_id' },
      },
    },
  },
  {
    name: 'browser_act',
    description:
      'Execute an interactive action (click, fill, press, hover, scroll, select, navigate, screenshot, evaluate_query, app_action) on a live paired web tab or headless session.',
    inputSchema: {
      type: 'object',
      properties: {
        target_id: { type: 'string', description: 'Optional target_id from browser_list_targets' },
        session_id: { type: 'string', description: 'Optional headless session_id' },
        action: {
          type: 'string',
          enum: [
            'snapshot',
            'click',
            'fill',
            'press',
            'hover',
            'scroll',
            'select',
            'navigate',
            'screenshot',
            'evaluate_query',
            'app_action',
          ],
        },
        ref: { type: 'string', description: 'Element reference such as e1, e2' },
        selector: { type: 'string', description: 'CSS selector fallback' },
        text: { type: 'string', description: 'Text to fill, option value, or JS query expression' },
        key: { type: 'string', description: 'Keyboard key to press (e.g. Enter, Escape, Tab)' },
        url: { type: 'string', description: 'URL or route to navigate to' },
        delta_y: { type: 'number', description: 'Vertical scroll delta in pixels' },
        app_action: { type: 'string', description: 'High-level app action identifier' },
        app_payload: { type: 'object', description: 'Payload for app_action' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_open_headless',
    description:
      'Alias for browser_headless_open: launch an isolated server-managed headless Chromium session and navigate to an initial URL.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Initial URL (http://, https://, data:, or about:blank)' },
        width: { type: 'number', description: 'Viewport width (default 1280)' },
        height: { type: 'number', description: 'Viewport height (default 800)' },
      },
    },
  },
  {
    name: 'browser_headless_close',
    description: 'Close a headless browser session and release its underlying process/resources.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Headless session_id' },
      },
      required: ['session_id'],
    },
  },
];

export const BROWSER_MCP_DOCK_TOOLS: McpToolDto[] = [
  {
    tool_id: 'bctrl_list_targets',
    server_id: 'mcp_browser_bridge',
    name: 'browser_list_targets',
    description: 'List paired live web tabs and headless browser sessions',
    risk_level: 'read_only',
    requires_approval: false,
  },
  {
    tool_id: 'bctrl_tab_command',
    server_id: 'mcp_browser_bridge',
    name: 'browser_tab_command',
    description: 'Run DOM/UI command against a live paired Telegram Web tab',
    risk_level: 'medium',
    requires_approval: false,
  },
  {
    tool_id: 'bctrl_headless_open',
    server_id: 'mcp_browser_bridge',
    name: 'browser_headless_open',
    description: 'Open isolated headless Chromium CDP browser session',
    risk_level: 'low',
    requires_approval: false,
  },
  {
    tool_id: 'bctrl_headless_action',
    server_id: 'mcp_browser_bridge',
    name: 'browser_headless_action',
    description: 'Interact with or snapshot an open headless browser session',
    risk_level: 'low',
    requires_approval: false,
  },
  {
    tool_id: 'bctrl_headless_screenshot',
    server_id: 'mcp_browser_bridge',
    name: 'browser_headless_screenshot',
    description: 'Capture viewport screenshot from a headless browser session',
    risk_level: 'read_only',
    requires_approval: false,
  },
  {
    tool_id: 'bctrl_headless_close',
    server_id: 'mcp_browser_bridge',
    name: 'browser_headless_close',
    description: 'Close an open headless browser session',
    risk_level: 'low',
    requires_approval: false,
  },
];

// ============================================================================
// URL Safety & Helpers
// ============================================================================

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function optionalTrimmedString(val: unknown, fieldName: string, maxLen = 2048): string | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'string') {
    throw new ApiError(400, 'invalid_parameter', `${fieldName} must be a string`);
  }
  const trimmed = val.trim();
  if (trimmed.length > maxLen) {
    throw new ApiError(400, 'invalid_parameter', `${fieldName} exceeds maximum length of ${maxLen}`);
  }
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalFiniteNumber(val: unknown, fieldName: string): number | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new ApiError(400, 'invalid_parameter', `${fieldName} must be a finite number`);
  }
  return val;
}

function optionalBoolean(val: unknown, fieldName: string): boolean | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'boolean') {
    throw new ApiError(400, 'invalid_parameter', `${fieldName} must be a boolean`);
  }
  return val;
}

function parseViewport(
  rawViewport: unknown,
  fallbackWidth = 1280,
  fallbackHeight = 800,
): { width: number; height: number } {
  if (rawViewport === undefined || rawViewport === null) {
    return {
      width: Math.max(320, Math.min(3840, Math.floor(fallbackWidth))),
      height: Math.max(240, Math.min(2160, Math.floor(fallbackHeight))),
    };
  }
  if (!isPlainObject(rawViewport)) {
    throw new ApiError(400, 'invalid_viewport', 'viewport must be a JSON object');
  }
  let width = fallbackWidth;
  if (rawViewport.width !== undefined) {
    if (typeof rawViewport.width !== 'number' || !Number.isFinite(rawViewport.width)) {
      throw new ApiError(400, 'invalid_viewport', 'viewport.width must be a finite number');
    }
    width = rawViewport.width;
  }
  let height = fallbackHeight;
  if (rawViewport.height !== undefined) {
    if (typeof rawViewport.height !== 'number' || !Number.isFinite(rawViewport.height)) {
      throw new ApiError(400, 'invalid_viewport', 'viewport.height must be a finite number');
    }
    height = rawViewport.height;
  }
  return {
    width: Math.max(320, Math.min(3840, Math.floor(width))),
    height: Math.max(240, Math.min(2160, Math.floor(height))),
  };
}

function parseIpv6Groups(rawHost: string): number[] | null {
  const bare = rawHost.split('%')[0]!;
  if (!bare.includes(':')) return null;
  let normalized = bare;
  const lastColon = bare.lastIndexOf(':');
  const tail = bare.slice(lastColon + 1);
  if (tail.includes('.')) {
    const octets = tail.split('.').map((p) => Number(p));
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
      return null;
    }
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
    normalized = `${bare.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - (left.length + right.length);
  if (halves.length === 1 && missing !== 0) return null;
  if (halves.length === 2 && missing < 1) return null;
  const full = [...left, ...Array<string>(Math.max(0, missing)).fill('0'), ...right];
  if (full.length !== 8) return null;
  const groups: number[] = [];
  for (const part of full) {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
    groups.push(parseInt(part, 16));
  }
  return groups;
}

function isBlockedMetadataOrLinkLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return false;
  if (
    host === '169.254.169.254' ||
    host.startsWith('169.254.') ||
    host === '100.100.100.200' ||
    host === 'metadata.google.internal' ||
    host.endsWith('.metadata.google.internal') ||
    host === 'metadata.goog' ||
    host === 'metadata'
  ) {
    return true;
  }
  const v6 = parseIpv6Groups(host);
  if (v6) {
    // Link-local fe80::/10 (fe80..febf)
    if ((v6[0]! & 0xffc0) === 0xfe80) return true;
    // AWS IPv6 IMDS fd00:ec2::254
    if (
      v6[0] === 0xfd00 &&
      v6[1] === 0x0ec2 &&
      v6[2] === 0 &&
      v6[3] === 0 &&
      v6[4] === 0 &&
      v6[5] === 0 &&
      v6[6] === 0 &&
      v6[7] === 0x0254
    ) {
      return true;
    }
    // IPv4-mapped ::ffff:0:0/96 or IPv4-compatible ::/96 targeting 169.254.0.0/16 or 100.100.100.200
    const allZeroPrefix = v6[0] === 0 && v6[1] === 0 && v6[2] === 0 && v6[3] === 0 && v6[4] === 0;
    if (allZeroPrefix && (v6[5] === 0xffff || v6[5] === 0)) {
      const a = (v6[6]! >> 8) & 0xff;
      const b = v6[6]! & 0xff;
      const c = (v6[7]! >> 8) & 0xff;
      const d = v6[7]! & 0xff;
      if ((a === 169 && b === 254) || (a === 100 && b === 100 && c === 100 && d === 200)) {
        return true;
      }
    }
  }
  return false;
}

function validateHeadlessUrl(rawUrl: unknown): string {
  if (typeof rawUrl !== 'string') {
    throw new ApiError(400, 'invalid_browser_url', 'URL must be a string');
  }
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed === 'about:blank') {
    return 'about:blank';
  }
  if (/^data:text\/html/i.test(trimmed) || /^data:image\//i.test(trimmed) || /^data:text\/plain/i.test(trimmed)) {
    return trimmed;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ApiError(400, 'invalid_browser_url', `Invalid URL: ${trimmed}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ApiError(
      400,
      'unsafe_browser_url',
      `Disallowed browser URL protocol "${parsed.protocol}" (only http:, https:, data:text/html, and about:blank are allowed)`,
    );
  }
  if (isBlockedMetadataOrLinkLocalHost(parsed.hostname)) {
    throw new ApiError(
      400,
      'unsafe_browser_url',
      `Blocked cloud metadata or link-local SSRF host: ${parsed.hostname}`,
    );
  }
  return parsed.toString();
}

function normalizeActionKind(rawAction: unknown): BrowserActionKind {
  if (typeof rawAction !== 'string') {
    throw new ApiError(400, 'invalid_browser_action', 'action must be a string');
  }
  if (rawAction === 'goto') return 'navigate';
  if (rawAction === 'evaluate') return 'evaluate_query';
  const valid: Set<BrowserActionKind> = new Set([
    'snapshot',
    'click',
    'fill',
    'press',
    'hover',
    'scroll',
    'select',
    'navigate',
    'screenshot',
    'evaluate_query',
    'app_action',
  ]);
  if (!valid.has(rawAction as BrowserActionKind)) {
    throw new ApiError(400, 'invalid_browser_action', `Unsupported browser action "${rawAction}"`);
  }
  return rawAction as BrowserActionKind;
}

function httpGetDirectBuffer(urlObj: URL, timeoutMs = 5000): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        hostname: urlObj.hostname,
        port: urlObj.port ? Number(urlObj.port) : 80,
        path: `${urlObj.pathname}${urlObj.search}`,
        agent: false,
        timeout: timeoutMs,
        headers: {
          Accept: 'text/html,application/xhtml+xml,text/plain,*/*',
          'User-Agent': 'Fabushi-Web-HeadlessBridge/1.6.11',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 200,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`HTTP GET timed out after ${timeoutMs}ms`));
    });
    req.once('error', reject);
  });
}

// ============================================================================
// Headless Driver Interface (Real Chromium CDP ONLY — ZERO SVG fallback!)
// ============================================================================

interface HeadlessDriver {
  readonly backend: 'chromium_cdp';
  getUrl(): string;
  getTitle(): string;
  getViewport(): { width: number; height: number };
  goto(url: string): Promise<BrowserSnapshotDto>;
  snapshot(): Promise<BrowserSnapshotDto>;
  performAction(req: BrowserCommandRequest): Promise<{
    snapshot: BrowserSnapshotDto;
    screenshotDataUrl?: string;
    data?: Record<string, unknown>;
  }>;
  evaluateJs<T = unknown>(expression: string): Promise<T>;
  screenshot(): Promise<{ dataUrl: string; mimeType: string }>;
  close(): Promise<void>;
  killFastSync(): void;
}

// ============================================================================
// Real Chromium Headless CDP Driver (CI / Container Hardened)
// ============================================================================

const CDP_SNAPSHOT_EXPRESSION = `(function(targetId) {
  const selectorList = 'a, button, input, textarea, select, [role="button"], [role="tab"], [role="link"], [role="checkbox"], [role="menuitem"], [data-testid], [contenteditable="true"]';
  const nodes = Array.from(document.querySelectorAll(selectorList)).slice(0, 150);
  const elements = nodes.map((el, i) => {
    const ref = 'e' + (i + 1);
    el.setAttribute('data-bctrl-ref', ref);
    const r = el.getBoundingClientRect();
    const id = el.id || undefined;
    const testId = el.getAttribute('data-testid') || undefined;
    const role = el.getAttribute('role') || undefined;
    const tag = el.tagName.toLowerCase();
    const rawText = (el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder') || ('value' in el ? String(el.value || '') : '') || '').replace(/\\s+/g, ' ').trim();
    const val = ('value' in el && typeof el.value === 'string') ? el.value.slice(0, 200) : undefined;
    const disabled = Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true');
    let selector = '[data-bctrl-ref="' + ref + '"]';
    if (id && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(id)) {
      selector = '#' + id;
    } else if (testId) {
      selector = '[data-testid="' + testId.replace(/"/g, '\\\\"') + '"]';
    }
    return {
      ref,
      selector,
      tag,
      role,
      text: rawText.slice(0, 160),
      id,
      testId,
      value: val,
      disabled,
      rect: {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      },
    };
  });
  const bodyText = (document.body ? (document.body.innerText || document.body.textContent || '') : '').replace(/\\s+/g, ' ').trim().slice(0, 1400);
  const theme = document.documentElement ? (document.documentElement.getAttribute('data-theme') || undefined) : undefined;
  return {
    target_id: targetId,
    url: String(location.href || 'about:blank'),
    title: String(document.title || ''),
    timestamp_ms: Date.now(),
    viewport: {
      width: Number(window.innerWidth || 1280),
      height: Number(window.innerHeight || 800),
    },
    theme,
    text_excerpt: bodyText,
    elements,
  };
})`;

class ChromiumCdpDriver implements HeadlessDriver {
  readonly backend = 'chromium_cdp' as const;
  private proc: ChildProcess | null = null;
  private cdpWs: WebSocket | null = null;
  private userDataDir: string | null = null;
  private nextCdpId = 1;
  private readonly pendingCdp = new Map<
    number,
    { resolve: (val: any) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly loadListeners = new Set<() => void>();
  private currentUrl = 'about:blank';
  private currentTitle = '';
  private closed = false;
  private closePromise: Promise<void> | null = null;

  private constructor(
    private readonly sessionId: string,
    private readonly viewport: { width: number; height: number },
    private readonly profileRoot: string,
  ) {}

  static async launch(
    sessionId: string,
    viewport: { width: number; height: number },
    profileRoot: string,
  ): Promise<ChromiumCdpDriver> {
    const driver = new ChromiumCdpDriver(sessionId, viewport, profileRoot);
    try {
      await driver.initProcessAndConnect();
      return driver;
    } catch (err) {
      await driver.close();
      throw err;
    }
  }

  private async initProcessAndConnect(): Promise<void> {
    const binPath = resolveChromiumBinaryPath();
    if (!binPath) {
      throw new ApiError(503, 'browser_unavailable', 'Chromium/Chrome executable not found on this host');
    }

    // Short profile directory under dataDir/p/<hex> to stay well under Linux 107B AF_UNIX limit!
    const profilesParent = path.join(this.profileRoot, 'p');
    fs.mkdirSync(profilesParent, { recursive: true });
    const userDataDir = path.join(profilesParent, crypto.randomBytes(4).toString('hex'));
    fs.mkdirSync(userDataDir, { recursive: true });
    this.userDataDir = userDataDir;

    const rawLaunchTimeout = Number(process.env.BROWSER_CDP_LAUNCH_TIMEOUT_MS ?? 30_000);
    const launchTimeoutMs = Number.isFinite(rawLaunchTimeout)
      ? Math.max(5000, Math.min(60_000, Math.floor(rawLaunchTimeout)))
      : 30_000;

    const existingNoProxy = process.env.NO_PROXY || process.env.no_proxy || '';
    const mergedNoProxy = Array.from(
      new Set(['127.0.0.1', 'localhost', '::1', ...existingNoProxy.split(',').map((s) => s.trim()).filter(Boolean)]),
    ).join(',');

    const proc = spawn(
      binPath,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-crash-reporter',
        '--disable-breakpad',
        '--password-store=basic',
        '--use-mock-keychain',
        '--disable-extensions',
        '--disable-component-extensions-with-background-pages',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-translate',
        '--mute-audio',
        '--proxy-bypass-list=<-loopback>,127.0.0.1,localhost',
        `--user-data-dir=${userDataDir}`,
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
        '--remote-allow-origins=*',
        `--window-size=${this.viewport.width},${this.viewport.height}`,
        'about:blank',
      ],
      {
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
          ...process.env,
          DBUS_SESSION_BUS_ADDRESS: '',
          NO_PROXY: mergedNoProxy,
          no_proxy: mergedNoProxy,
        },
      },
    );
    this.proc = proc;
    liveCdpDrivers.add(this);

    // Dual port discovery: race stderr regex AND DevToolsActivePort file polling!
    const debugPort = await new Promise<number>((resolve, reject) => {
      let settled = false;
      let stderrBuf = '';
      const activePortFile = path.join(userDataDir, 'DevToolsActivePort');

      const cleanup = () => {
        clearTimeout(timer);
        clearInterval(portPoll);
        proc.stderr?.off('data', onData);
        proc.off('error', onError);
        proc.off('exit', onExit);
      };

      const finishOk = (port: number) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(port);
      };

      const finishErr = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const timer = setTimeout(() => {
        finishErr(
          new Error(`Timed out after ${launchTimeoutMs}ms waiting for Chromium DevTools port. Stderr: ${stderrBuf.slice(-300)}`),
        );
      }, launchTimeoutMs);
      timer.unref?.();

      const portPoll = setInterval(() => {
        try {
          if (fs.existsSync(activePortFile)) {
            const firstLine = fs.readFileSync(activePortFile, 'utf8').split(/\r?\n/)[0]?.trim() ?? '';
            const portNum = Number(firstLine);
            if (Number.isInteger(portNum) && portNum > 0 && portNum <= 65535) {
              finishOk(portNum);
            }
          }
        } catch {
          // Retry on next tick
        }
      }, 100);
      portPoll.unref?.();

      const onData = (chunk: Buffer) => {
        stderrBuf += chunk.toString('utf8');
        if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-4096);
        const m = /DevTools listening on ws:\/\/(?:\[::1\]|127\.0\.0\.1|localhost):(\d+)\//.exec(stderrBuf);
        if (m) {
          finishOk(Number(m[1]));
        }
      };

      const onError = (err: Error) => finishErr(err);
      const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
        finishErr(
          new Error(
            `Chromium exited prematurely (code=${code}, signal=${signal}): ${stderrBuf.slice(-300)}`,
          ),
        );

      proc.stderr?.on('data', onData);
      proc.once('error', onError);
      proc.once('exit', onExit);
    });

    // Discover the primary 'page' target from /json/list over direct loopback HTTP (up to 40 attempts)
    let pageWsUrl: string | null = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const listRes = await httpGetDirectBuffer(
          new URL(`http://127.0.0.1:${debugPort}/json/list`),
          2000,
        );
        const targets = JSON.parse(listRes.body) as Array<{
          type?: string;
          url?: string;
          webSocketDebuggerUrl?: string;
        }>;
        const pageTarget = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (pageTarget?.webSocketDebuggerUrl) {
          pageWsUrl = pageTarget.webSocketDebuggerUrl;
          break;
        }
        // Fallback: open a fresh about:blank page if none initialized yet
        if (attempt === 10 || attempt === 25) {
          try {
            const newRes = await httpGetDirectBuffer(
              new URL(`http://127.0.0.1:${debugPort}/json/new?about:blank`),
              2000,
            );
            const created = JSON.parse(newRes.body) as { webSocketDebuggerUrl?: string };
            if (created.webSocketDebuggerUrl) {
              pageWsUrl = created.webSocketDebuggerUrl;
              break;
            }
          } catch {
            // Continue retrying /json/list
          }
        }
      } catch {
        // Retry briefly while DevTools target initializes
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    if (!pageWsUrl) {
      throw new Error('Failed to locate page webSocketDebuggerUrl from Chromium /json/list');
    }

    // Normalize WS URL host to 127.0.0.1 (avoids IPv6/localhost proxy mismatches)
    const normalizedWsUrl = new URL(pageWsUrl);
    normalizedWsUrl.hostname = '127.0.0.1';

    const ws = new WebSocket(normalizedWsUrl.toString());
    this.cdpWs = ws;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting to CDP WebSocket')), 10_000);
      timer.unref?.();
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString('utf8')) as {
          id?: number;
          method?: string;
          result?: unknown;
          error?: { message?: string };
        };
        if (typeof msg.id === 'number') {
          const pending = this.pendingCdp.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingCdp.delete(msg.id);
            if (msg.error) {
              pending.reject(new Error(msg.error.message ?? 'CDP error'));
            } else {
              pending.resolve(msg.result);
            }
          }
        } else if (msg.method === 'Page.loadEventFired') {
          for (const cb of this.loadListeners) {
            cb();
          }
          this.loadListeners.clear();
        }
      } catch {
        // Ignore malformed CDP event
      }
    });

    ws.on('close', () => {
      for (const [, pending] of this.pendingCdp) {
        clearTimeout(pending.timer);
        pending.reject(new Error('CDP WebSocket closed'));
      }
      this.pendingCdp.clear();
    });

    await this.sendCdp('Page.enable');
    await this.sendCdp('Runtime.enable');
    await this.sendCdp('Emulation.setDeviceMetricsOverride', {
      width: this.viewport.width,
      height: this.viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  private sendCdp<T = any>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 8000,
  ): Promise<T> {
    if (this.closed || !this.cdpWs || this.cdpWs.readyState !== WebSocket.OPEN) {
      return Promise.reject(new ApiError(410, 'headless_session_closed', 'CDP connection is closed'));
    }
    const id = this.nextCdpId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCdp.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingCdp.set(id, { resolve, reject, timer });
      this.cdpWs!.send(JSON.stringify({ id, method, params }));
    });
  }

  getUrl(): string {
    return this.currentUrl;
  }

  getTitle(): string {
    return this.currentTitle;
  }

  getViewport(): { width: number; height: number } {
    return this.viewport;
  }

  async goto(url: string): Promise<BrowserSnapshotDto> {
    const safeUrl = validateHeadlessUrl(url);

    let onLoadRef: (() => void) | null = null;
    let loadTimer: NodeJS.Timeout | null = null;
    const cleanupLoadListener = (): void => {
      if (loadTimer) {
        clearTimeout(loadTimer);
        loadTimer = null;
      }
      if (onLoadRef) {
        this.loadListeners.delete(onLoadRef);
        onLoadRef = null;
      }
    };

    const loadFiredPromise = new Promise<void>((resolve) => {
      const onLoad = () => resolve();
      onLoadRef = onLoad;
      this.loadListeners.add(onLoad);
      loadTimer = setTimeout(() => {
        this.loadListeners.delete(onLoad);
        resolve();
      }, 3500);
      loadTimer.unref?.();
    });

    const navRes = await this.sendCdp<{ frameId?: string; errorText?: string }>('Page.navigate', {
      url: safeUrl,
    });
    if (navRes?.errorText) {
      cleanupLoadListener();
      throw new ApiError(
        502,
        'navigation_failed',
        `Navigation to ${safeUrl} failed: ${navRes.errorText}`,
      );
    }

    await loadFiredPromise;
    cleanupLoadListener();

    // Ensure document.readyState reaches interactive/complete + brief microtask settle
    for (let i = 0; i < 12; i++) {
      const stateEval = await this.sendCdp('Runtime.evaluate', {
        expression: 'document.readyState',
        returnByValue: true,
      });
      const rs = stateEval?.result?.value;
      if (rs === 'complete' || rs === 'interactive') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 30));

    return await this.snapshot();
  }

  async snapshot(): Promise<BrowserSnapshotDto> {
    const evalRes = await this.sendCdp('Runtime.evaluate', {
      expression: `${CDP_SNAPSHOT_EXPRESSION}(${JSON.stringify(this.sessionId)})`,
      returnByValue: true,
    });
    const snap = evalRes?.result?.value as BrowserSnapshotDto | undefined;
    if (!snap) {
      throw new ApiError(500, 'snapshot_failed', 'Failed to evaluate DOM snapshot via CDP');
    }
    this.currentUrl = snap.url;
    this.currentTitle = snap.title;
    return snap;
  }

  async performAction(req: BrowserCommandRequest): Promise<{
    snapshot: BrowserSnapshotDto;
    screenshotDataUrl?: string;
    data?: Record<string, unknown>;
  }> {
    const action = normalizeActionKind(req.action);

    switch (action) {
      case 'snapshot':
        return { snapshot: await this.snapshot() };

      case 'navigate': {
        if (!req.url) throw new ApiError(400, 'missing_url', 'Action "navigate" requires url');
        return { snapshot: await this.goto(req.url) };
      }

      case 'click': {
        const cleanRef = req.ref ? req.ref.replace(/^@/, '') : '';
        const clickExpr = `(function(ref, sel) {
          const el = (ref ? document.querySelector('[data-bctrl-ref=' + JSON.stringify(ref) + ']') : null)
            || (sel ? document.querySelector(sel) : null);
          if (!el) return { found: false };
          el.scrollIntoView({ block: 'center', inline: 'center' });
          if (typeof el.focus === 'function') el.focus();
          el.click();
          return { found: true, tag: el.tagName.toLowerCase(), id: el.id || undefined };
        })(${JSON.stringify(cleanRef)}, ${JSON.stringify(req.selector ?? '')})`;
        const res = await this.sendCdp('Runtime.evaluate', {
          expression: clickExpr,
          returnByValue: true,
        });
        const info = res?.result?.value as { found: boolean; tag?: string; id?: string } | undefined;
        if (!info?.found) {
          throw new ApiError(
            404,
            'element_not_found',
            `Element ${req.ref ?? req.selector ?? ''} not found in headless DOM`,
          );
        }
        await new Promise((r) => setTimeout(r, 60));
        return { snapshot: await this.snapshot(), data: info as unknown as Record<string, unknown> };
      }

      case 'fill':
      case 'select': {
        const cleanRef = req.ref ? req.ref.replace(/^@/, '') : '';
        const textVal = req.text ?? '';
        const fillExpr = `(function(ref, sel, val) {
          const el = (ref ? document.querySelector('[data-bctrl-ref=' + JSON.stringify(ref) + ']') : null)
            || (sel ? document.querySelector(sel) : null);
          if (!el) return { found: false };
          if (typeof el.focus === 'function') el.focus();
          const tag = el.tagName.toLowerCase();
          if (tag === 'input') {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (setter) setter.call(el, val); else el.value = val;
          } else if (tag === 'textarea') {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
            if (setter) setter.call(el, val); else el.value = val;
          } else if (tag === 'select') {
            const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
            if (setter) setter.call(el, val); else el.value = val;
          } else if (el.isContentEditable) {
            el.textContent = val;
          } else {
            el.value = val;
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { found: true, tag, value: val };
        })(${JSON.stringify(cleanRef)}, ${JSON.stringify(req.selector ?? '')}, ${JSON.stringify(textVal)})`;
        const res = await this.sendCdp('Runtime.evaluate', {
          expression: fillExpr,
          returnByValue: true,
        });
        const info = res?.result?.value as { found: boolean } | undefined;
        if (!info?.found) {
          throw new ApiError(
            404,
            'element_not_found',
            `Element ${req.ref ?? req.selector ?? ''} not found in headless DOM`,
          );
        }
        await new Promise((r) => setTimeout(r, 40));
        return { snapshot: await this.snapshot(), data: info as unknown as Record<string, unknown> };
      }

      case 'press': {
        const key = req.key ?? 'Enter';
        if (req.ref || req.selector) {
          const cleanRef = req.ref ? req.ref.replace(/^@/, '') : '';
          await this.sendCdp('Runtime.evaluate', {
            expression: `(function(ref, sel) {
              const el = (ref ? document.querySelector('[data-bctrl-ref=' + JSON.stringify(ref) + ']') : null)
                || (sel ? document.querySelector(sel) : null);
              if (el && typeof el.focus === 'function') el.focus();
            })(${JSON.stringify(cleanRef)}, ${JSON.stringify(req.selector ?? '')})`,
            returnByValue: true,
          });
        }
        const vkMap: Record<string, number> = {
          Enter: 13,
          Tab: 9,
          Escape: 27,
          Backspace: 8,
          ArrowUp: 38,
          ArrowDown: 40,
          ArrowLeft: 37,
          ArrowRight: 39,
        };
        const vk = vkMap[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
        await this.sendCdp('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key,
          text: key.length === 1 ? key : undefined,
          windowsVirtualKeyCode: vk,
          nativeVirtualKeyCode: vk,
        });
        await this.sendCdp('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key,
          windowsVirtualKeyCode: vk,
          nativeVirtualKeyCode: vk,
        });
        await new Promise((r) => setTimeout(r, 50));
        return { snapshot: await this.snapshot(), data: { key } };
      }

      case 'hover': {
        const cleanRef = req.ref ? req.ref.replace(/^@/, '') : '';
        const boxRes = await this.sendCdp('Runtime.evaluate', {
          expression: `(function(ref, sel) {
            const el = (ref ? document.querySelector('[data-bctrl-ref=' + JSON.stringify(ref) + ']') : null)
              || (sel ? document.querySelector(sel) : null);
            if (!el) return { found: false };
            const r = el.getBoundingClientRect();
            el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            return { found: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
          })(${JSON.stringify(cleanRef)}, ${JSON.stringify(req.selector ?? '')})`,
          returnByValue: true,
        });
        const info = boxRes?.result?.value as { found: boolean; x?: number; y?: number } | undefined;
        if (!info?.found) {
          throw new ApiError(404, 'element_not_found', 'Hover target element not found');
        }
        await this.sendCdp('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: info.x ?? 10,
          y: info.y ?? 10,
        });
        return { snapshot: await this.snapshot(), data: info as unknown as Record<string, unknown> };
      }

      case 'scroll': {
        const deltaY = req.delta_y ?? 320;
        const cleanRef = req.ref ? req.ref.replace(/^@/, '') : '';
        const scrollRes = await this.sendCdp('Runtime.evaluate', {
          expression: `(function(ref, sel, dy) {
            const el = (ref ? document.querySelector('[data-bctrl-ref=' + JSON.stringify(ref) + ']') : null)
              || (sel ? document.querySelector(sel) : null);
            if (el) { el.scrollTop += dy; return { scroll_y: el.scrollTop }; }
            window.scrollBy(0, dy);
            return { scroll_y: window.scrollY };
          })(${JSON.stringify(cleanRef)}, ${JSON.stringify(req.selector ?? '')}, ${Number(deltaY)})`,
          returnByValue: true,
        });
        return {
          snapshot: await this.snapshot(),
          data: (scrollRes?.result?.value ?? { scroll_y: deltaY }) as Record<string, unknown>,
        };
      }

      case 'evaluate_query': {
        const expr = req.text || req.app_action || 'document.title';
        const evalRes = await this.sendCdp('Runtime.evaluate', {
          expression: expr,
          returnByValue: true,
          awaitPromise: true,
        });
        if (evalRes?.exceptionDetails) {
          throw new ApiError(
            400,
            'evaluate_exception',
            evalRes.exceptionDetails.text ?? 'Runtime.evaluate threw exception',
          );
        }
        return {
          snapshot: await this.snapshot(),
          data: { value: evalRes?.result?.value },
        };
      }

      case 'screenshot': {
        const shot = await this.screenshot();
        return {
          snapshot: await this.snapshot(),
          screenshotDataUrl: shot.dataUrl,
          data: { mime_type: shot.mimeType },
        };
      }

      case 'app_action':
        throw new ApiError(
          400,
          'unsupported_headless_action',
          'app_action is only supported on live web tabs, not headless Chromium CDP sessions',
        );
    }
  }

  async evaluateJs<T = unknown>(expression: string): Promise<T> {
    const res = await this.sendCdp('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res?.exceptionDetails) {
      throw new ApiError(
        400,
        'evaluate_exception',
        res.exceptionDetails.text ?? 'Runtime.evaluate threw exception',
      );
    }
    return res?.result?.value as T;
  }

  async screenshot(): Promise<{ dataUrl: string; mimeType: string }> {
    const shotRes = await this.sendCdp<{ data: string }>('Page.captureScreenshot', {
      format: 'png',
    });
    if (!shotRes?.data) {
      throw new ApiError(500, 'screenshot_failed', 'CDP Page.captureScreenshot returned empty data');
    }
    return {
      dataUrl: `data:image/png;base64,${shotRes.data}`,
      mimeType: 'image/png',
    };
  }

  killFastSync(): void {
    this.closed = true;
    liveCdpDrivers.delete(this);
    for (const [, pending] of this.pendingCdp) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Headless session terminated'));
    }
    this.pendingCdp.clear();
    const wsRef = this.cdpWs;
    this.cdpWs = null;
    if (wsRef) {
      try {
        wsRef.terminate();
      } catch {
        // Ignore
      }
    }
    const proc = this.proc;
    this.proc = null;
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      terminateProcessGroup(proc, 'SIGKILL');
    }
    const dir = this.userDataDir;
    this.userDataDir = null;
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup race
      }
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      this.closed = true;
      liveCdpDrivers.delete(this);

      for (const [, pending] of this.pendingCdp) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Headless session closed'));
      }
      this.pendingCdp.clear();

      if (this.cdpWs && this.cdpWs.readyState === WebSocket.OPEN) {
        try {
          this.cdpWs.send(JSON.stringify({ id: 999999, method: 'Browser.close', params: {} }));
        } catch {
          // Ignore
        }
      }

      const proc = this.proc;
      this.proc = null;
      if (proc && proc.exitCode === null && proc.signalCode === null) {
        await new Promise<void>((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(termTimer);
            resolve();
          };
          proc.once('exit', finish);
          const termTimer = setTimeout(() => {
            terminateProcessGroup(proc, 'SIGKILL');
            setTimeout(finish, 200).unref?.();
          }, 1500);
          termTimer.unref?.();
          terminateProcessGroup(proc, 'SIGTERM');
        });
      }

      if (this.cdpWs) {
        try {
          this.cdpWs.terminate();
        } catch {
          // Ignore
        }
        this.cdpWs = null;
      }

      const dir = this.userDataDir;
      this.userDataDir = null;
      if (dir) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // Ignore cleanup race
        }
      }
    })();
    return this.closePromise;
  }
}

// ============================================================================
// BrowserControlBridge — Central Coordinator for Pairing, Live Tabs, Headless & MCP
// ============================================================================

export interface BrowserCallerAuth {
  userId: number;
  callerKind: 'user_session' | 'desktop_controller';
  callerLabel: string;
  rawToken: string;
  generation: number;
}

interface DesktopTokenRecord {
  desktopToken: string;
  userId: number;
  label: string;
  issuedGeneration: number;
  expiresAtMs: number;
  revoked: boolean;
  createdAtMs: number;
}

interface PairingTicketRecord {
  pairCode: string;
  desktopToken: string;
  userId: number;
  label: string;
  expiresAtMs: number;
  claimed: boolean;
  httpBaseUrl: string;
  wsBridgeUrl: string;
  mcpRpcUrl: string;
}

interface LiveTabRecord {
  descriptor: BrowserTargetDescriptor;
  ws: WebSocket | null;
  latestSnapshot?: BrowserSnapshotDto;
  queuedCommands: Array<BrowserCommandRequest & { command_id: string; target_id: string; generation: number }>;
  pollWaiter?: (cmd: BrowserCommandRequest & { command_id: string; target_id: string; generation: number }) => void;
}

interface PendingBrowserCommand {
  commandId: string;
  userId: number;
  targetId: string;
  generation: number;
  action: BrowserActionKind;
  callerLabel: string;
  startedAtPerf: number;
  timer: NodeJS.Timeout;
  resolve: (res: BrowserCommandResult) => void;
  reject: (err: Error) => void;
}

interface ManagedHeadlessSession {
  userId: number;
  dto: HeadlessBrowserSessionDto;
  driver: HeadlessDriver;
  latestSnapshot?: BrowserSnapshotDto;
}

interface ControllerWsClient {
  ws: WebSocket;
  userId: number;
  desktopToken?: string;
}

const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomPairCode(len = 6): string {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) {
    out += PAIR_ALPHABET[bytes[i]! % PAIR_ALPHABET.length];
  }
  return out;
}

export class BrowserControlBridge {
  private readonly liveTabs = new Map<string, LiveTabRecord>();
  private readonly socketToTargetIds = new Map<WebSocket, Set<string>>();
  private readonly controllerSockets = new Set<ControllerWsClient>();
  private readonly pendingCommands = new Map<string, PendingBrowserCommand>();
  private readonly headlessSessions = new Map<string, ManagedHeadlessSession>();
  private readonly controlModes = new Map<number, BrowserControlMode>();
  private readonly profileRoot: string;

  constructor(private readonly db: DatabaseSync, dataDir?: string) {
    this.profileRoot = dataDir && dataDir.trim() ? dataDir.trim() : path.join(process.cwd(), 'data');
    activeBridges.add(this);
  }

  getGeneration(userId: number): number {
    const row = this.db
      .prepare(`SELECT control_generation FROM browser_control_generations WHERE user_id = ?`)
      .get(userId) as { control_generation: number } | undefined;
    if (row) return Number(row.control_generation);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO browser_control_generations (user_id, control_generation, updated_at_ms) VALUES (?, 1, ?)`,
      )
      .run(userId, Date.now());
    return 1;
  }

  getControlMode(userId: number): BrowserControlMode {
    return this.controlModes.get(userId) ?? { mode: 'idle' };
  }

  setControlMode(userId: number, mode: BrowserControlMode): BrowserControlMode {
    this.controlModes.set(userId, mode);
    return mode;
  }

  hasActiveControlForUser(userId: number): boolean {
    for (const [, tab] of this.liveTabs) {
      if (tab.descriptor.user_id === userId) return true;
    }
    for (const [, hs] of this.headlessSessions) {
      if (hs.userId === userId) return true;
    }
    for (const ctrl of this.controllerSockets) {
      if (ctrl.userId === userId) return true;
    }
    const tokenRow = this.db
      .prepare(
        `SELECT 1 FROM browser_desktop_tokens WHERE user_id = ? AND revoked = 0 AND expires_at_ms > ? LIMIT 1`,
      )
      .get(userId, Date.now());
    return Boolean(tokenRow);
  }

  recordAudit(
    userId: number,
    entry: Omit<BrowserAuditLogEntry, 'audit_id' | 'timestamp_ms'>,
  ): BrowserAuditLogEntry {
    const full: BrowserAuditLogEntry = {
      audit_id: `baud_${crypto.randomBytes(6).toString('hex')}`,
      timestamp_ms: Date.now(),
      ...entry,
    };
    this.db
      .prepare(`
        INSERT INTO browser_audit_logs (
          audit_id, user_id, target_id, caller, action, status, summary, latency_ms, timestamp_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        full.audit_id,
        userId,
        full.target_id,
        full.caller,
        full.action,
        full.status,
        full.summary,
        full.latency_ms,
        full.timestamp_ms,
      );
    return full;
  }

  listAuditLogs(userId: number, limit = 50): BrowserAuditLogEntry[] {
    const clamped = Math.max(1, Math.min(200, Math.floor(limit)));
    const rows = this.db
      .prepare(
        `SELECT audit_id, target_id, caller, action, status, summary, latency_ms, timestamp_ms
         FROM browser_audit_logs
         WHERE user_id = ?
         ORDER BY timestamp_ms DESC
         LIMIT ?`,
      )
      .all(userId, clamped) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      audit_id: String(r.audit_id),
      target_id: String(r.target_id),
      caller: String(r.caller),
      action: String(r.action),
      status: String(r.status) as BrowserAuditLogEntry['status'],
      summary: String(r.summary),
      latency_ms: Number(r.latency_ms),
      timestamp_ms: Number(r.timestamp_ms),
    }));
  }

  extractRequestToken(req: IncomingMessage, query?: URLSearchParams): string | null {
    const desktopHeader = req.headers['x-desktop-browser-token'];
    if (typeof desktopHeader === 'string' && desktopHeader.trim()) {
      return desktopHeader.trim();
    }
    const bearer = extractBearerToken(req, query);
    if (bearer) return bearer;
    const dtQuery = query?.get('desktop_token');
    if (dtQuery && dtQuery.trim()) return dtQuery.trim();
    return null;
  }

  authenticateTokenString(rawToken: string | null): BrowserCallerAuth | null {
    if (!rawToken) return null;

    if (rawToken.startsWith('bctrl_')) {
      const tokenHash = sha256Hex(rawToken);
      const row = this.db
        .prepare(
          `SELECT user_id, label, issued_generation, expires_at_ms, revoked
           FROM browser_desktop_tokens WHERE token_hash = ?`,
        )
        .get(tokenHash) as
        | {
            user_id: number;
            label: string;
            issued_generation: number;
            expires_at_ms: number;
            revoked: number;
          }
        | undefined;
      if (!row || Number(row.revoked) !== 0 || Number(row.expires_at_ms) <= Date.now()) {
        return null;
      }
      const userId = Number(row.user_id);
      const curGen = this.getGeneration(userId);
      if (Number(row.issued_generation) < curGen) {
        return null;
      }
      return {
        userId,
        callerKind: 'desktop_controller',
        callerLabel: row.label,
        rawToken,
        generation: curGen,
      };
    }

    const session = authenticateToken(this.db, rawToken);
    if (!session) return null;
    return {
      userId: session.userId,
      callerKind: 'user_session',
      callerLabel: `Web (@${session.username})`,
      rawToken,
      generation: this.getGeneration(session.userId),
    };
  }

  requireBrowserAuth(ctx: RequestContext): BrowserCallerAuth {
    const token = this.extractRequestToken(ctx.req, ctx.query);
    const auth = this.authenticateTokenString(token);
    if (!auth) {
      throw new ApiError(
        401,
        'unauthorized',
        'Missing, invalid, expired, or revoked authentication/desktop token',
      );
    }
    return auth;
  }

  // ==========================================================================
  // SQLite-Persisted Desktop Pairing (`pair/create` & `pair/claim`)
  // ==========================================================================

  createPairingTicket(
    userId: number,
    baseUrl: string,
    opts: { label?: unknown; ttlSecs?: unknown } = {},
  ): DesktopPairingTicketDto & { pairing_code: string; code: string; control_token: string; token: string } {
    const validatedLabel = optionalTrimmedString(opts.label, 'label', 120);
    const validatedTtl = optionalFiniteNumber(opts.ttlSecs, 'ttl_secs');
    const ttlMs = Math.max(10_000, Math.min(86_400_000, Math.floor((validatedTtl ?? 600) * 1000)));
    const now = Date.now();
    const expiresAtMs = now + ttlMs;
    const desktopToken = `bctrl_${crypto.randomBytes(20).toString('hex')}`;
    const tokenHash = sha256Hex(desktopToken);
    const label = validatedLabel || 'Fabushi Desktop Bridge';
    const gen = this.getGeneration(userId);
    const wsBase = baseUrl.replace(/^http/i, 'ws');
    const wsBridgeUrl = `${wsBase}/api/v1/browser/ws`;
    const mcpRpcUrl = `${baseUrl}/api/v1/mcp/rpc`;
    let pairCode = randomPairCode(6);

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      for (let i = 0; i < 10; i++) {
        const exists = this.db
          .prepare(`SELECT 1 FROM browser_pairing_tickets WHERE pair_code = ?`)
          .get(pairCode);
        if (!exists) break;
        pairCode = randomPairCode(6);
      }

      this.db
        .prepare(`
          INSERT INTO browser_pairing_tickets (
            pair_code, desktop_token_hash, desktop_token, user_id, label,
            expires_at_ms, claimed, http_base_url, ws_bridge_url, mcp_rpc_url, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
        `)
        .run(
          pairCode,
          tokenHash,
          desktopToken,
          userId,
          label,
          expiresAtMs,
          baseUrl,
          wsBridgeUrl,
          mcpRpcUrl,
          now,
        );

      this.db
        .prepare(`
          INSERT INTO browser_desktop_tokens (
            token_hash, desktop_token, user_id, label, issued_generation,
            expires_at_ms, revoked, created_at_ms, revoked_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL)
        `)
        .run(tokenHash, desktopToken, userId, label, gen, now + 30 * 86_400_000, now);

      this.db.exec('COMMIT;');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // Already rolled back
      }
      throw err;
    }

    this.recordAudit(userId, {
      target_id: 'pairing',
      caller: `user:${userId}`,
      action: 'pair_create',
      status: 'ok',
      summary: `Issued desktop pairing code ${pairCode}`,
      latency_ms: 0,
    });

    return {
      pair_code: pairCode,
      pairing_code: pairCode,
      code: pairCode,
      desktop_token: desktopToken,
      control_token: desktopToken,
      token: desktopToken,
      expires_at_ms: expiresAtMs,
      http_base_url: baseUrl,
      ws_bridge_url: wsBridgeUrl,
      mcp_rpc_url: mcpRpcUrl,
    };
  }

  claimPairingTicket(
    rawPairCode: unknown,
    controllerLabel?: unknown,
    overrideBaseUrl?: string,
  ): DesktopPairingTicketDto & { pairing_code: string; code: string; control_token: string; token: string } {
    if (rawPairCode === undefined || rawPairCode === null) {
      throw new ApiError(400, 'missing_pair_code', 'pair_code is required');
    }
    if (typeof rawPairCode !== 'string') {
      throw new ApiError(400, 'invalid_parameter', 'pair_code must be a string');
    }
    const code = rawPairCode.trim().toUpperCase();
    if (!code) {
      throw new ApiError(400, 'missing_pair_code', 'pair_code is required');
    }
    const cleanControllerLabel = optionalTrimmedString(controllerLabel, 'controller_label', 120);

    const now = Date.now();
    let claimedRow: Record<string, unknown>;
    let tokenRow: Record<string, unknown>;
    let finalLabel: string;
    const extendedExpiry = now + 30 * 86_400_000;

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const ticket = this.db
        .prepare(`SELECT * FROM browser_pairing_tickets WHERE pair_code = ?`)
        .get(code) as Record<string, unknown> | undefined;
      if (!ticket) {
        this.db.exec('ROLLBACK;');
        throw new ApiError(404, 'invalid_pair_code', 'Invalid or unknown desktop pairing code');
      }
      if (Number(ticket.expires_at_ms) <= now) {
        this.db.prepare(`DELETE FROM browser_pairing_tickets WHERE pair_code = ?`).run(code);
        this.db.exec('COMMIT;');
        throw new ApiError(410, 'pair_code_expired', 'Desktop pairing code has expired');
      }
      if (Number(ticket.claimed) !== 0) {
        this.db.exec('ROLLBACK;');
        throw new ApiError(409, 'pair_code_already_claimed', 'Desktop pairing code has already been claimed');
      }

      const tok = this.db
        .prepare(`SELECT * FROM browser_desktop_tokens WHERE token_hash = ?`)
        .get(String(ticket.desktop_token_hash)) as Record<string, unknown> | undefined;
      if (!tok || Number(tok.revoked) !== 0) {
        this.db.exec('ROLLBACK;');
        throw new ApiError(401, 'pairing_revoked', 'Desktop pairing ticket was revoked by user');
      }

      finalLabel = cleanControllerLabel || String(ticket.label);
      this.db
        .prepare(`UPDATE browser_pairing_tickets SET claimed = 1, label = ? WHERE pair_code = ?`)
        .run(finalLabel, code);
      this.db
        .prepare(`UPDATE browser_desktop_tokens SET label = ?, expires_at_ms = ? WHERE token_hash = ?`)
        .run(finalLabel, extendedExpiry, String(ticket.desktop_token_hash));
      this.db.exec('COMMIT;');

      claimedRow = ticket;
      tokenRow = tok;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // Already committed/rolled back
      }
      throw err;
    }

    const userId = Number(claimedRow.user_id);
    const desktopToken = String(tokenRow.desktop_token);

    for (const [, tab] of this.liveTabs) {
      if (tab.descriptor.user_id === userId && tab.descriptor.allow_remote_control) {
        tab.descriptor.active_controller = finalLabel;
      }
    }

    this.recordAudit(userId, {
      target_id: 'pairing',
      caller: finalLabel,
      action: 'pair_claim',
      status: 'ok',
      summary: `Desktop controller "${finalLabel}" claimed pairing code ${code}`,
      latency_ms: 0,
    });
    this.broadcastTargetsUpdated(userId);

    const httpBase = overrideBaseUrl ?? String(claimedRow.http_base_url);
    const wsBase = httpBase.replace(/^http/i, 'ws');
    return {
      pair_code: code,
      pairing_code: code,
      code,
      desktop_token: desktopToken,
      control_token: desktopToken,
      token: desktopToken,
      expires_at_ms: extendedExpiry,
      http_base_url: httpBase,
      ws_bridge_url: `${wsBase}/api/v1/browser/ws`,
      mcp_rpc_url: `${httpBase}/api/v1/mcp/rpc`,
    };
  }

  // ==========================================================================
  // Live WebSocket & REST Tab Registration + Controller Sockets
  // ==========================================================================

  registerControllerSocket(ws: WebSocket, userId: number, desktopToken?: string): void {
    this.controllerSockets.add({ ws, userId, desktopToken });
    this.sendWsFrame(ws, {
      type: 'BrowserTargetsUpdated',
      payload: {
        targets: this.listTargets(userId),
        control_generation: this.getGeneration(userId),
      },
    });
  }

  unregisterSocket(ws: WebSocket): void {
    for (const ctrl of this.controllerSockets) {
      if (ctrl.ws === ws) {
        this.controllerSockets.delete(ctrl);
      }
    }

    const targetIds = this.socketToTargetIds.get(ws);
    if (!targetIds) return;
    this.socketToTargetIds.delete(ws);

    const affectedUsers = new Set<number>();
    for (const tid of targetIds) {
      const rec = this.liveTabs.get(tid);
      if (rec && rec.ws === ws) {
        affectedUsers.add(rec.descriptor.user_id);
        this.liveTabs.delete(tid);
        // Reject any in-flight command waiting on this closed tab immediately
        for (const [cmdId, pending] of this.pendingCommands) {
          if (pending.targetId === tid) {
            clearTimeout(pending.timer);
            this.pendingCommands.delete(cmdId);
            pending.reject(
              new ApiError(503, 'browser_tab_disconnected', `Browser tab ${tid} disconnected`),
            );
          }
        }
      }
    }

    for (const uid of affectedUsers) {
      this.broadcastTargetsUpdated(uid);
    }
  }

  registerLiveTab(
    userId: number,
    payload: BrowserRegisterPayload,
    ws: WebSocket | null = null,
  ): BrowserTargetDescriptor {
    if (!isPlainObject(payload)) {
      throw new ApiError(400, 'invalid_parameter', 'Tab registration payload must be a JSON object');
    }
    const rawTargetId = optionalTrimmedString(payload.target_id, 'target_id', 128);
    const titleInput = optionalTrimmedString(payload.title, 'title', 512);
    const urlInput = optionalTrimmedString(payload.url, 'url', 4096);
    const themeInput = optionalTrimmedString(payload.theme, 'theme', 64);
    const navDestInput = optionalTrimmedString(payload.active_nav_dest, 'active_nav_dest', 64);
    const allowRemoteInput = optionalBoolean(payload.allow_remote_control, 'allow_remote_control');
    let activeChatId: number | null | undefined;
    if (payload.active_chat_id !== undefined) {
      if (payload.active_chat_id === null) {
        activeChatId = null;
      } else {
        activeChatId = optionalFiniteNumber(payload.active_chat_id, 'active_chat_id');
      }
    }

    const now = Date.now();
    const targetId = rawTargetId || `tab_${userId}_${crypto.randomBytes(4).toString('hex')}`;
    const existing = this.liveTabs.get(targetId);
    if (existing && existing.descriptor.user_id !== userId) {
      throw new ApiError(403, 'forbidden_target', 'Target ID belongs to a different user');
    }

    const viewport =
      payload.viewport !== undefined
        ? parseViewport(payload.viewport)
        : (existing?.descriptor.viewport ?? { width: 1280, height: 800 });

    const gen = this.getGeneration(userId);
    const descriptor: BrowserTargetDescriptor = {
      target_id: targetId,
      user_id: userId,
      kind: 'live_web_tab',
      title: titleInput || existing?.descriptor.title || 'GPUI Telegram Web',
      url: urlInput || existing?.descriptor.url || 'http://localhost/',
      viewport,
      theme: themeInput ?? existing?.descriptor.theme,
      active_chat_id:
        activeChatId !== undefined
          ? activeChatId
          : (existing?.descriptor.active_chat_id ?? null),
      active_nav_dest: navDestInput ?? existing?.descriptor.active_nav_dest,
      connected_at_ms: existing?.descriptor.connected_at_ms ?? now,
      last_heartbeat_ms: now,
      allow_remote_control:
        allowRemoteInput !== undefined
          ? allowRemoteInput
          : (existing?.descriptor.allow_remote_control ?? true),
      active_controller: existing?.descriptor.active_controller ?? null,
      control_generation: gen,
    };

    this.liveTabs.set(targetId, {
      descriptor,
      ws: ws ?? existing?.ws ?? null,
      latestSnapshot: payload.snapshot ?? existing?.latestSnapshot,
      queuedCommands: existing?.queuedCommands ?? [],
      pollWaiter: existing?.pollWaiter,
    });

    if (ws) {
      let set = this.socketToTargetIds.get(ws);
      if (!set) {
        set = new Set<string>();
        this.socketToTargetIds.set(ws, set);
      }
      set.add(targetId);
    }

    this.broadcastTargetsUpdated(userId);
    return descriptor;
  }

  reportTabState(userId: number, payload: BrowserStateReportPayload): BrowserTargetDescriptor {
    if (!isPlainObject(payload)) {
      throw new ApiError(400, 'invalid_parameter', 'State report payload must be a JSON object');
    }
    const targetId = optionalTrimmedString(payload.target_id, 'target_id', 128);
    if (!targetId) {
      throw new ApiError(400, 'invalid_parameter', 'target_id is required');
    }
    const titleInput = optionalTrimmedString(payload.title, 'title', 512);
    const urlInput = optionalTrimmedString(payload.url, 'url', 4096);
    const themeInput = optionalTrimmedString(payload.theme, 'theme', 64);
    const navDestInput = optionalTrimmedString(payload.active_nav_dest, 'active_nav_dest', 64);
    const allowRemoteInput = optionalBoolean(payload.allow_remote_control, 'allow_remote_control');
    const viewportInput =
      payload.viewport !== undefined ? parseViewport(payload.viewport) : undefined;
    let activeChatId: number | null | undefined;
    if (payload.active_chat_id !== undefined) {
      if (payload.active_chat_id === null) {
        activeChatId = null;
      } else {
        activeChatId = optionalFiniteNumber(payload.active_chat_id, 'active_chat_id');
      }
    }

    const rec = this.liveTabs.get(targetId);
    if (!rec || rec.descriptor.user_id !== userId) {
      throw new ApiError(404, 'browser_target_not_found', `Browser tab "${targetId}" not found`);
    }

    const d = rec.descriptor;
    if (titleInput !== undefined) d.title = titleInput;
    if (urlInput !== undefined) d.url = urlInput;
    if (viewportInput !== undefined) d.viewport = viewportInput;
    if (themeInput !== undefined) d.theme = themeInput;
    if (activeChatId !== undefined) d.active_chat_id = activeChatId;
    if (navDestInput !== undefined) d.active_nav_dest = navDestInput;
    if (allowRemoteInput !== undefined) {
      d.allow_remote_control = allowRemoteInput;
    }
    d.last_heartbeat_ms = Date.now();
    d.control_generation = this.getGeneration(userId);
    if (payload.snapshot) {
      rec.latestSnapshot = payload.snapshot;
    }

    this.broadcastTargetsUpdated(userId);
    return d;
  }

  listTargets(userId: number): BrowserTargetDescriptor[] {
    const gen = this.getGeneration(userId);
    const out: BrowserTargetDescriptor[] = [];

    for (const [, tab] of this.liveTabs) {
      if (tab.descriptor.user_id === userId) {
        tab.descriptor.control_generation = gen;
        out.push({ ...tab.descriptor });
      }
    }

    for (const [, hs] of this.headlessSessions) {
      if (hs.userId === userId && hs.dto.status === 'ready') {
        out.push({
          target_id: hs.dto.session_id,
          user_id: userId,
          kind: 'headless_chromium',
          title: hs.dto.title,
          url: hs.dto.url,
          viewport: { ...hs.dto.viewport },
          connected_at_ms: hs.dto.created_at_ms,
          last_heartbeat_ms: hs.dto.updated_at_ms,
          allow_remote_control: true,
          active_controller: null,
          control_generation: gen,
        });
      }
    }

    out.sort((a, b) => b.last_heartbeat_ms - a.last_heartbeat_ms);
    return out;
  }

  private sendWsFrame(ws: WebSocket | null | undefined, frame: WsServerFrame): boolean {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
      return true;
    }
    return false;
  }

  private broadcastToUserBrowserPeers(userId: number, frame: WsServerFrame): void {
    const sent = new Set<WebSocket>();
    for (const [, tab] of this.liveTabs) {
      if (tab.descriptor.user_id === userId && tab.ws && !sent.has(tab.ws)) {
        sent.add(tab.ws);
        this.sendWsFrame(tab.ws, frame);
      }
    }
    for (const ctrl of this.controllerSockets) {
      if (ctrl.userId === userId && !sent.has(ctrl.ws)) {
        sent.add(ctrl.ws);
        this.sendWsFrame(ctrl.ws, frame);
      }
    }
  }

  private broadcastTargetsUpdated(userId: number): void {
    const frame: WsServerFrame = {
      type: 'BrowserTargetsUpdated',
      payload: {
        targets: this.listTargets(userId),
        control_generation: this.getGeneration(userId),
      },
    };
    for (const ctrl of this.controllerSockets) {
      if (ctrl.userId === userId) {
        this.sendWsFrame(ctrl.ws, frame);
      }
    }
  }

  // ==========================================================================
  // Command Routing, Correlation & Generation Fencing
  // ==========================================================================

  async dispatchCommand(
    auth: BrowserCallerAuth,
    rawReq: BrowserCommandRequest,
  ): Promise<BrowserCommandResult> {
    if (!isPlainObject(rawReq)) {
      throw new ApiError(400, 'invalid_parameter', 'Command request must be a JSON object');
    }
    const userId = auth.userId;
    const action = normalizeActionKind(rawReq.action);
    const reqTargetId = optionalTrimmedString(rawReq.target_id, 'target_id', 128);
    const callerLabel = optionalTrimmedString(rawReq.caller_label, 'caller_label', 128) || auth.callerLabel;
    const reqCommandId = optionalTrimmedString(rawReq.command_id, 'command_id', 128);
    const expectedGeneration = optionalFiniteNumber(rawReq.expected_generation, 'expected_generation');
    const reqTimeoutMs = optionalFiniteNumber(rawReq.timeout_ms, 'timeout_ms');
    const reqRef = optionalTrimmedString(rawReq.ref, 'ref', 128);
    const reqSelector = optionalTrimmedString(rawReq.selector, 'selector', 1024);
    const reqText =
      rawReq.text === undefined || rawReq.text === null
        ? undefined
        : typeof rawReq.text === 'string'
          ? rawReq.text
          : (() => {
              throw new ApiError(400, 'invalid_parameter', 'text must be a string');
            })();
    const reqKey = optionalTrimmedString(rawReq.key, 'key', 64);
    const reqUrl = optionalTrimmedString(rawReq.url, 'url', 4096);
    const reqAppAction = optionalTrimmedString(rawReq.app_action, 'app_action', 128);
    const reqDeltaY = optionalFiniteNumber(rawReq.delta_y, 'delta_y');
    const startGen = this.getGeneration(userId);
    const t0 = performance.now();

    if (expectedGeneration !== undefined && expectedGeneration !== startGen) {
      this.recordAudit(userId, {
        target_id: reqTargetId ?? 'unknown',
        caller: callerLabel,
        action,
        status: 'revoked',
        summary: `Rejected stale command generation ${expectedGeneration} (current ${startGen})`,
        latency_ms: 0,
      });
      throw new ApiError(
        409,
        'control_generation_mismatch',
        `Expected control_generation ${expectedGeneration}, current is ${startGen}`,
      );
    }

    // Resolve target: explicit target_id -> live tab OR headless session; omitted -> most recent live tab OR headless
    let liveTab: LiveTabRecord | undefined;
    let headless: ManagedHeadlessSession | undefined;

    if (reqTargetId) {
      const lt = this.liveTabs.get(reqTargetId);
      if (lt) {
        if (lt.descriptor.user_id !== userId) {
          throw new ApiError(403, 'forbidden_target', 'Browser target belongs to another user');
        }
        liveTab = lt;
      } else {
        const hs = this.headlessSessions.get(reqTargetId);
        if (hs && hs.dto.status === 'ready') {
          if (hs.userId !== userId) {
            throw new ApiError(403, 'forbidden_target', 'Headless session belongs to another user');
          }
          headless = hs;
        }
      }
    } else {
      // Pick most recently active live tab for userId (preferring WS-connected tab)
      const userTabs = Array.from(this.liveTabs.values())
        .filter((t) => t.descriptor.user_id === userId)
        .sort((a, b) => {
          const aOpen = a.ws?.readyState === WebSocket.OPEN ? 1 : 0;
          const bOpen = b.ws?.readyState === WebSocket.OPEN ? 1 : 0;
          if (aOpen !== bOpen) return bOpen - aOpen;
          return b.descriptor.last_heartbeat_ms - a.descriptor.last_heartbeat_ms;
        });
      if (userTabs.length > 0) {
        liveTab = userTabs[0];
      } else {
        const userHeadless = Array.from(this.headlessSessions.values())
          .filter((h) => h.userId === userId && h.dto.status === 'ready')
          .sort((a, b) => b.dto.updated_at_ms - a.dto.updated_at_ms);
        if (userHeadless.length > 0) {
          headless = userHeadless[0];
        }
      }
    }

    if (headless) {
      return await this.executeHeadlessAction(auth, headless.dto.session_id, {
        ...rawReq,
        action,
        command_id: reqCommandId,
        ref: reqRef,
        selector: reqSelector,
        text: reqText,
        key: reqKey,
        url: reqUrl,
        delta_y: reqDeltaY,
        caller_label: callerLabel,
      });
    }

    if (!liveTab) {
      throw new ApiError(
        404,
        'browser_target_not_found',
        reqTargetId
          ? `Browser target "${reqTargetId}" not found`
          : 'No active live browser tab or headless session registered for this user',
      );
    }

    const targetId = liveTab.descriptor.target_id;
    if (!liveTab.descriptor.allow_remote_control) {
      this.recordAudit(userId, {
        target_id: targetId,
        caller: callerLabel,
        action,
        status: 'rejected',
        summary: `Rejected "${action}" because allow_remote_control is false on ${targetId}`,
        latency_ms: Math.round(performance.now() - t0),
      });
      throw new ApiError(
        403,
        'remote_control_disabled',
        'Remote browser control is disabled on this tab',
      );
    }

    const commandId = reqCommandId || `bcmd_${crypto.randomBytes(6).toString('hex')}`;
    const timeoutMs = Math.max(100, Math.min(30_000, Math.floor(reqTimeoutMs ?? 8000)));

    liveTab.descriptor.active_controller = callerLabel;
    liveTab.descriptor.control_generation = startGen;

    const commandPayload = {
      ...rawReq,
      action,
      command_id: commandId,
      target_id: targetId,
      generation: startGen,
      caller_label: callerLabel,
      ref: reqRef,
      selector: reqSelector,
      text: reqText,
      key: reqKey,
      url: reqUrl,
      app_action: reqAppAction,
      delta_y: reqDeltaY,
    };

    const resultPromise = new Promise<BrowserCommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(commandId);
        this.recordAudit(userId, {
          target_id: targetId,
          caller: callerLabel,
          action,
          status: 'error',
          summary: `Timed out after ${timeoutMs}ms waiting for BrowserCommandResult`,
          latency_ms: timeoutMs,
        });
        reject(
          new ApiError(
            504,
            'browser_command_timeout',
            `Browser tab ${targetId} did not respond within ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      this.pendingCommands.set(commandId, {
        commandId,
        userId,
        targetId,
        generation: startGen,
        action,
        callerLabel,
        startedAtPerf: t0,
        timer,
        resolve,
        reject,
      });
    });

    const deliveredViaWs = this.sendWsFrame(liveTab.ws, {
      type: 'BrowserCommand',
      payload: commandPayload,
    });

    if (!deliveredViaWs) {
      if (liveTab.pollWaiter) {
        const waiter = liveTab.pollWaiter;
        liveTab.pollWaiter = undefined;
        waiter(commandPayload);
      } else {
        liveTab.queuedCommands.push(commandPayload);
      }
    }

    return await resultPromise;
  }

  resolveTabCommandResult(userId: number, incoming: BrowserCommandResult): boolean {
    if (!isPlainObject(incoming)) {
      throw new ApiError(400, 'invalid_parameter', 'Command result payload must be a JSON object');
    }
    const incomingCmdId = optionalTrimmedString(incoming.command_id, 'command_id', 128);
    if (!incomingCmdId) {
      throw new ApiError(400, 'invalid_parameter', 'command_id must be a non-empty string');
    }
    optionalTrimmedString(incoming.target_id, 'target_id', 128);
    const incomingAction = optionalTrimmedString(incoming.action, 'action', 64);
    const incomingError = optionalTrimmedString(incoming.error, 'error', 2048);
    const incomingLatency = optionalFiniteNumber(incoming.latency_ms, 'latency_ms');
    const incomingGeneration = optionalFiniteNumber(incoming.generation, 'generation');

    const pending = this.pendingCommands.get(incomingCmdId);
    if (!pending || pending.userId !== userId) {
      return false;
    }

    clearTimeout(pending.timer);
    this.pendingCommands.delete(incomingCmdId);

    const currentGen = this.getGeneration(userId);
    if (
      currentGen !== pending.generation ||
      (incomingGeneration !== undefined && incomingGeneration !== pending.generation)
    ) {
      this.recordAudit(userId, {
        target_id: pending.targetId,
        caller: pending.callerLabel,
        action: pending.action,
        status: 'revoked',
        summary: `Fenced stale BrowserCommandResult (cmd gen ${incomingGeneration ?? pending.generation} vs current ${currentGen})`,
        latency_ms: Math.max(0, Math.round(performance.now() - pending.startedAtPerf)),
      });
      pending.reject(
        new ApiError(
          409,
          'control_revoked_by_user',
          'Browser command result fenced by newer control_generation',
        ),
      );
      return true;
    }

    const tab = this.liveTabs.get(pending.targetId);
    if (tab) {
      tab.descriptor.last_heartbeat_ms = Date.now();
      if (incoming.snapshot) {
        tab.latestSnapshot = incoming.snapshot;
        if (incoming.snapshot.title) tab.descriptor.title = incoming.snapshot.title;
        if (incoming.snapshot.url) tab.descriptor.url = incoming.snapshot.url;
        if (incoming.snapshot.active_chat_id !== undefined) {
          tab.descriptor.active_chat_id = incoming.snapshot.active_chat_id;
        }
        if (incoming.snapshot.active_nav_dest !== undefined) {
          tab.descriptor.active_nav_dest = incoming.snapshot.active_nav_dest;
        }
      }
    }

    const latencyMs = Math.max(0, Math.round(performance.now() - pending.startedAtPerf));
    const normalized: BrowserCommandResult = {
      ok: Boolean(incoming.ok),
      command_id: pending.commandId,
      target_id: pending.targetId,
      generation: pending.generation,
      action: (incomingAction as BrowserActionKind | undefined) ?? pending.action,
      snapshot: incoming.snapshot,
      screenshot_data_url:
        typeof incoming.screenshot_data_url === 'string' ? incoming.screenshot_data_url : undefined,
      data: incoming.data,
      error: incomingError,
      latency_ms: incomingLatency !== undefined && incomingLatency >= 0 ? incomingLatency : latencyMs,
    };

    this.recordAudit(userId, {
      target_id: pending.targetId,
      caller: pending.callerLabel,
      action: normalized.action,
      status: normalized.ok ? 'ok' : 'error',
      summary: normalized.ok
        ? `Completed ${normalized.action} on ${pending.targetId}`
        : `Error in ${normalized.action}: ${normalized.error ?? 'unknown'}`,
      latency_ms: normalized.latency_ms,
    });

    for (const ctrl of this.controllerSockets) {
      if (ctrl.userId === userId) {
        this.sendWsFrame(ctrl.ws, {
          type: 'BrowserCommandResult',
          payload: normalized,
        });
      }
    }

    pending.resolve(normalized);
    return true;
  }

  pollNextTabCommand(
    userId: number,
    targetId: string,
    waitMs = 0,
  ): Promise<(BrowserCommandRequest & { command_id: string; target_id: string; generation: number }) | null> {
    const tab = this.liveTabs.get(targetId);
    if (!tab || tab.descriptor.user_id !== userId) {
      throw new ApiError(404, 'browser_target_not_found', `Browser tab "${targetId}" not found`);
    }
    tab.descriptor.last_heartbeat_ms = Date.now();
    const immediate = tab.queuedCommands.shift();
    if (immediate) return Promise.resolve(immediate);
    if (waitMs <= 0) return Promise.resolve(null);

    const clampedWait = Math.min(10_000, waitMs);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (tab.pollWaiter === onCmd) {
          tab.pollWaiter = undefined;
        }
        resolve(null);
      }, clampedWait);
      const onCmd = (cmd: BrowserCommandRequest & { command_id: string; target_id: string; generation: number }) => {
        clearTimeout(timer);
        resolve(cmd);
      };
      tab.pollWaiter = onCmd;
    });
  }

  // ==========================================================================
  // `<10ms` Atomic Emergency Control Revoke / Takeover
  // ==========================================================================

  revokeControl(
    userId: number,
    opts: {
      targetId?: unknown;
      revokeTokens?: unknown;
      disableRemoteControl?: unknown;
      reason?: unknown;
    } = {},
  ): BrowserControlRevokeResponse & { latency_sub_10ms: boolean } {
    // Strictly validate ALL inputs BEFORE any SQLite or in-memory mutation!
    const targetId = optionalTrimmedString(opts.targetId, 'target_id', 128);
    const reason = optionalTrimmedString(opts.reason, 'reason', 256);
    const revokeTokens = optionalBoolean(opts.revokeTokens, 'revoke_tokens');
    const disableRemoteControl = optionalBoolean(opts.disableRemoteControl, 'disable_remote_control');

    const startHr = process.hrtime.bigint();
    const now = Date.now();
    let nextGen = 0;
    let revokedTokensCount = 0;

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      nextGen = this.getGeneration(userId) + 1;
      this.db
        .prepare(`
          INSERT INTO browser_control_generations (user_id, control_generation, updated_at_ms)
          VALUES (?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET control_generation = excluded.control_generation, updated_at_ms = excluded.updated_at_ms
        `)
        .run(userId, nextGen, now);

      if (revokeTokens !== false) {
        const tokRes = this.db
          .prepare(
            `UPDATE browser_desktop_tokens SET revoked = 1, revoked_at_ms = ?
             WHERE user_id = ? AND revoked = 0`,
          )
          .run(now, userId);
        revokedTokensCount = Number(tokRes.changes ?? 0);
        this.db.prepare(`DELETE FROM browser_pairing_tickets WHERE user_id = ?`).run(userId);
      }
      this.db.exec('COMMIT;');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // Already rolled back
      }
      throw err;
    }

    this.controlModes.set(userId, { mode: 'user_takeover', paused_at_step: 0 });

    for (const [, tab] of this.liveTabs) {
      if (tab.descriptor.user_id === userId && (!targetId || tab.descriptor.target_id === targetId)) {
        tab.descriptor.control_generation = nextGen;
        tab.descriptor.active_controller = null;
        tab.queuedCommands.length = 0;
        if (disableRemoteControl) {
          tab.descriptor.allow_remote_control = false;
        }
      }
    }

    let abortedCommandsCount = 0;
    for (const [cmdId, pending] of this.pendingCommands) {
      if (pending.userId === userId && (!targetId || pending.targetId === targetId)) {
        clearTimeout(pending.timer);
        this.pendingCommands.delete(cmdId);
        abortedCommandsCount += 1;
        this.recordAudit(userId, {
          target_id: pending.targetId,
          caller: pending.callerLabel,
          action: pending.action,
          status: 'revoked',
          summary: `Aborted in-flight "${pending.action}" via emergency user revoke (gen #${nextGen})`,
          latency_ms: Math.max(0, Math.round(performance.now() - pending.startedAtPerf)),
        });
        pending.reject(
          new ApiError(
            409,
            'control_revoked_by_user',
            'Browser control was immediately revoked by user',
            { control_generation: nextGen },
          ),
        );
      }
    }

    const revokedFrame: WsServerFrame = {
      type: 'BrowserControlRevoked',
      payload: {
        user_id: userId,
        target_id: targetId,
        control_generation: nextGen,
        reason: reason ?? 'control_revoked_by_user',
        timestamp_ms: now,
      },
    };
    this.broadcastToUserBrowserPeers(userId, revokedFrame);

    if (revokeTokens !== false) {
      for (const ctrl of this.controllerSockets) {
        if (ctrl.userId === userId && ctrl.desktopToken) {
          this.controllerSockets.delete(ctrl);
          try {
            ctrl.ws.close(4003, 'Desktop browser control revoked');
          } catch {
            // Ignore
          }
        }
      }
    }

    const elapsedUs = Number((process.hrtime.bigint() - startHr) / 1000n);
    const sub10ms = elapsedUs < 10_000;

    this.recordAudit(userId, {
      target_id: targetId ?? 'all_targets',
      caller: `user:${userId}`,
      action: 'revoke_control',
      status: 'revoked',
      summary: `Revoked remote browser control -> generation #${nextGen} (${revokedTokensCount} tokens revoked, ${abortedCommandsCount} in-flight commands aborted in ${elapsedUs}us)`,
      latency_ms: Math.floor(elapsedUs / 1000),
    });

    return {
      ok: true,
      control_generation: nextGen,
      revoked_tokens_count: revokedTokensCount,
      aborted_commands_count: abortedCommandsCount,
      elapsed_us: elapsedUs,
      latency_sub10ms: sub10ms,
      latency_sub_10ms: sub10ms,
    };
  }

  // ==========================================================================
  // Real Chromium CDP Headless Automation Engine (ZERO SVG fallback!)
  // ==========================================================================

  async openHeadlessSession(
    auth: BrowserCallerAuth,
    opts: {
      url?: unknown;
      viewport?: unknown;
      preferFallback?: unknown;
      backend?: unknown;
    } = {},
  ): Promise<{ session: HeadlessBrowserSessionDto; snapshot: BrowserSnapshotDto }> {
    const t0 = performance.now();

    const preferFallback = optionalBoolean(opts.preferFallback, 'prefer_fallback');
    const backend = optionalTrimmedString(opts.backend, 'backend', 64);

    if (preferFallback === true || (backend !== undefined && backend !== 'chromium_cdp')) {
      throw new ApiError(
        400,
        'unsupported_backend',
        'Fallback SVG driver has been removed; real Chromium CDP is required',
      );
    }

    const { width, height } = parseViewport(opts.viewport, 1280, 800);
    const initialUrl =
      opts.url !== undefined && opts.url !== null ? validateHeadlessUrl(opts.url) : 'about:blank';

    if (!isChromiumBinaryAvailable()) {
      throw new ApiError(
        503,
        'browser_unavailable',
        'Chromium/Chrome executable not found on this host',
      );
    }

    const sessionId = `hbs_${crypto.randomBytes(6).toString('hex')}`;

    let driver: HeadlessDriver;
    try {
      driver = await ChromiumCdpDriver.launch(sessionId, { width, height }, this.profileRoot);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(
        503,
        'browser_unavailable',
        err instanceof Error ? err.message : 'Failed to launch real headless Chromium CDP session',
      );
    }

    let snapshot: BrowserSnapshotDto;
    try {
      snapshot = initialUrl !== 'about:blank' ? await driver.goto(initialUrl) : await driver.snapshot();
    } catch (err) {
      await driver.close();
      throw err;
    }

    const now = Date.now();
    const dto: HeadlessBrowserSessionDto = {
      session_id: sessionId,
      backend: driver.backend,
      url: snapshot.url,
      title: snapshot.title,
      viewport: { width, height },
      created_at_ms: now,
      updated_at_ms: now,
      status: 'ready',
    };

    this.headlessSessions.set(sessionId, {
      userId: auth.userId,
      dto,
      driver,
      latestSnapshot: snapshot,
    });

    this.recordAudit(auth.userId, {
      target_id: sessionId,
      caller: auth.callerLabel,
      action: 'headless_open',
      status: 'ok',
      summary: `Opened ${driver.backend} headless session (${initialUrl})`,
      latency_ms: Math.round(performance.now() - t0),
    });

    this.broadcastTargetsUpdated(auth.userId);
    return { session: { ...dto }, snapshot };
  }

  listHeadlessSessions(userId: number): HeadlessBrowserSessionDto[] {
    const out: HeadlessBrowserSessionDto[] = [];
    for (const [, s] of this.headlessSessions) {
      if (s.userId === userId) {
        out.push({ ...s.dto });
      }
    }
    out.sort((a, b) => b.updated_at_ms - a.updated_at_ms);
    return out;
  }

  private requireHeadlessSession(userId: number, sessionId: string): ManagedHeadlessSession {
    const managed = this.headlessSessions.get(sessionId);
    if (!managed || managed.userId !== userId) {
      throw new ApiError(404, 'headless_session_not_found', `Headless session "${sessionId}" not found`);
    }
    if (managed.dto.status === 'closed') {
      throw new ApiError(410, 'headless_session_closed', `Headless session "${sessionId}" is already closed`);
    }
    return managed;
  }

  async executeHeadlessAction(
    auth: BrowserCallerAuth,
    sessionId: string,
    rawReq: BrowserCommandRequest,
  ): Promise<BrowserCommandResult> {
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new ApiError(400, 'missing_session_id', 'session_id is required');
    }
    if (!isPlainObject(rawReq)) {
      throw new ApiError(400, 'invalid_parameter', 'Headless action request must be a JSON object');
    }
    const action = normalizeActionKind(rawReq.action);
    const reqCommandId = optionalTrimmedString(rawReq.command_id, 'command_id', 128);
    const callerLabel = optionalTrimmedString(rawReq.caller_label, 'caller_label', 128) || auth.callerLabel;
    const reqRef = optionalTrimmedString(rawReq.ref, 'ref', 128);
    const reqSelector = optionalTrimmedString(rawReq.selector, 'selector', 1024);
    const reqKey = optionalTrimmedString(rawReq.key, 'key', 64);
    const reqUrl = optionalTrimmedString(rawReq.url, 'url', 4096);
    const reqDeltaY = optionalFiniteNumber(rawReq.delta_y, 'delta_y');
    if (rawReq.text !== undefined && rawReq.text !== null && typeof rawReq.text !== 'string') {
      throw new ApiError(400, 'invalid_parameter', 'text must be a string');
    }
    const reqText = typeof rawReq.text === 'string' ? rawReq.text : undefined;

    const managed = this.requireHeadlessSession(auth.userId, sessionId.trim());
    const t0 = performance.now();
    const commandId = reqCommandId || `hcmd_${crypto.randomBytes(6).toString('hex')}`;
    const gen = this.getGeneration(auth.userId);

    try {
      const outcome = await managed.driver.performAction({
        ...rawReq,
        action,
        ref: reqRef,
        selector: reqSelector,
        text: reqText,
        key: reqKey,
        url: reqUrl,
        delta_y: reqDeltaY,
      });
      managed.latestSnapshot = outcome.snapshot;
      managed.dto.url = outcome.snapshot.url;
      managed.dto.title = outcome.snapshot.title;
      managed.dto.updated_at_ms = Date.now();

      const latencyMs = Math.max(0, Math.round(performance.now() - t0));
      const res: BrowserCommandResult = {
        ok: true,
        command_id: commandId,
        target_id: sessionId.trim(),
        generation: gen,
        action,
        snapshot: outcome.snapshot,
        screenshot_data_url: outcome.screenshotDataUrl,
        data: outcome.data,
        latency_ms: latencyMs,
      };

      this.recordAudit(auth.userId, {
        target_id: sessionId.trim(),
        caller: callerLabel,
        action: `headless_${action}`,
        status: 'ok',
        summary: `Executed ${action} on ${sessionId.trim()} (${managed.dto.backend})`,
        latency_ms: latencyMs,
      });

      return res;
    } catch (err) {
      const latencyMs = Math.max(0, Math.round(performance.now() - t0));
      this.recordAudit(auth.userId, {
        target_id: sessionId.trim(),
        caller: callerLabel,
        action: `headless_${action}`,
        status: 'error',
        summary: err instanceof Error ? err.message : 'Headless action failed',
        latency_ms: latencyMs,
      });
      throw err;
    }
  }

  async captureHeadlessScreenshot(
    auth: BrowserCallerAuth,
    sessionId: string,
  ): Promise<{
    ok: true;
    session_id: string;
    backend: HeadlessBrowserSessionDto['backend'];
    mime_type: string;
    screenshot_data_url: string;
    latency_ms: number;
  }> {
    const managed = this.requireHeadlessSession(auth.userId, sessionId);
    const t0 = performance.now();
    const shot = await managed.driver.screenshot();
    managed.dto.updated_at_ms = Date.now();
    const latencyMs = Math.max(0, Math.round(performance.now() - t0));

    this.recordAudit(auth.userId, {
      target_id: sessionId,
      caller: auth.callerLabel,
      action: 'headless_screenshot',
      status: 'ok',
      summary: `Captured ${shot.mimeType} screenshot from ${sessionId}`,
      latency_ms: latencyMs,
    });

    return {
      ok: true,
      session_id: sessionId,
      backend: managed.dto.backend,
      mime_type: shot.mimeType,
      screenshot_data_url: shot.dataUrl,
      latency_ms: latencyMs,
    };
  }

  async closeHeadlessSession(
    auth: BrowserCallerAuth,
    sessionId: string,
  ): Promise<{ ok: true; session_id: string }> {
    const managed = this.headlessSessions.get(sessionId);
    if (!managed || managed.userId !== auth.userId) {
      throw new ApiError(404, 'headless_session_not_found', `Headless session "${sessionId}" not found`);
    }
    managed.dto.status = 'closed';
    managed.dto.updated_at_ms = Date.now();
    await managed.driver.close();
    this.headlessSessions.delete(sessionId);

    this.recordAudit(auth.userId, {
      target_id: sessionId,
      caller: auth.callerLabel,
      action: 'headless_close',
      status: 'ok',
      summary: `Closed headless session ${sessionId}`,
      latency_ms: 0,
    });
    this.broadcastTargetsUpdated(auth.userId);
    return { ok: true, session_id: sessionId };
  }

  // ==========================================================================
  // MCP Tool Execution & JSON-RPC 2.0 Handler
  // ==========================================================================

  async executeMcpTool(
    auth: BrowserCallerAuth,
    toolName: string,
    args: Record<string, unknown> = {},
  ): Promise<{ result: Record<string, unknown>; screenshotDataUrl?: string }> {
    switch (toolName) {
      case 'browser_list_targets': {
        return {
          result: {
            targets: this.listTargets(auth.userId),
            headless_sessions: this.listHeadlessSessions(auth.userId),
            control_generation: this.getGeneration(auth.userId),
          },
        };
      }

      case 'browser_snapshot': {
        const sessionId = typeof args.session_id === 'string' && args.session_id ? args.session_id : undefined;
        if (sessionId) {
          const snapRes = await this.executeHeadlessAction(auth, sessionId, {
            action: 'snapshot',
            caller_label: `MCP:${auth.callerLabel}`,
          });
          return { result: snapRes as unknown as Record<string, unknown> };
        }
        const cmdRes = await this.dispatchCommand(auth, {
          target_id: typeof args.target_id === 'string' ? args.target_id : undefined,
          action: 'snapshot',
          caller_label: `MCP:${auth.callerLabel}`,
        });
        return { result: cmdRes as unknown as Record<string, unknown> };
      }

      case 'browser_act':
      case 'browser_tab_command': {
        const sessionId = typeof args.session_id === 'string' && args.session_id ? args.session_id : undefined;
        const targetId =
          typeof args.target_id === 'string' && args.target_id ? args.target_id : sessionId;
        const cmdRes = await this.dispatchCommand(auth, {
          target_id: targetId,
          action: String(args.action ?? 'snapshot') as BrowserActionKind,
          ref: typeof args.ref === 'string' ? args.ref : undefined,
          selector: typeof args.selector === 'string' ? args.selector : undefined,
          text: typeof args.text === 'string' ? args.text : undefined,
          key: typeof args.key === 'string' ? args.key : undefined,
          url: typeof args.url === 'string' ? args.url : undefined,
          delta_y: typeof args.delta_y === 'number' ? args.delta_y : undefined,
          app_action: typeof args.app_action === 'string' ? args.app_action : undefined,
          app_payload:
            args.app_payload && typeof args.app_payload === 'object'
              ? (args.app_payload as Record<string, unknown>)
              : undefined,
          timeout_ms: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
          caller_label: `MCP:${auth.callerLabel}`,
        });
        return {
          result: cmdRes as unknown as Record<string, unknown>,
          screenshotDataUrl: cmdRes.screenshot_data_url,
        };
      }

      case 'browser_open_headless':
      case 'browser_headless_open': {
        const opened = await this.openHeadlessSession(auth, {
          url: args.url,
          viewport: {
            ...(args.width !== undefined ? { width: args.width } : {}),
            ...(args.height !== undefined ? { height: args.height } : {}),
          },
          preferFallback: args.prefer_fallback,
          backend: args.backend,
        });
        return { result: opened as unknown as Record<string, unknown> };
      }

      case 'browser_headless_action': {
        const sessionId = typeof args.session_id === 'string' ? args.session_id.trim() : '';
        if (!sessionId) {
          throw new ApiError(400, 'missing_session_id', 'session_id is required');
        }
        const actRes = await this.executeHeadlessAction(auth, sessionId, {
          action: (args.action ?? 'snapshot') as BrowserActionKind,
          ref: args.ref as string | undefined,
          selector: args.selector as string | undefined,
          text: args.text as string | undefined,
          key: args.key as string | undefined,
          url: args.url as string | undefined,
          delta_y: args.delta_y as number | undefined,
          caller_label: `MCP:${auth.callerLabel}`,
        });
        return {
          result: actRes as unknown as Record<string, unknown>,
          screenshotDataUrl: actRes.screenshot_data_url,
        };
      }

      case 'browser_headless_screenshot': {
        const sessionId = typeof args.session_id === 'string' ? args.session_id.trim() : '';
        if (!sessionId) {
          throw new ApiError(400, 'missing_session_id', 'session_id is required');
        }
        const shot = await this.captureHeadlessScreenshot(auth, sessionId);
        return {
          result: shot as unknown as Record<string, unknown>,
          screenshotDataUrl: shot.screenshot_data_url,
        };
      }

      case 'browser_headless_close': {
        const sessionId = typeof args.session_id === 'string' ? args.session_id.trim() : '';
        if (!sessionId) {
          throw new ApiError(400, 'missing_session_id', 'session_id is required');
        }
        const closed = await this.closeHeadlessSession(auth, sessionId);
        return { result: closed };
      }

      default:
        throw new ApiError(404, 'unknown_mcp_tool', `Unknown MCP browser tool "${toolName}"`);
    }
  }

  async handleMcpJsonRpc(
    auth: BrowserCallerAuth,
    rpc: McpJsonRpcRequest,
  ): Promise<McpJsonRpcResponse> {
    const id = rpc.id ?? null;
    if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request' },
      };
    }

    switch (rpc.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: {
              name: 'gpui-telegram-web-browser-bridge',
              version: '1.6.11',
            },
          },
        };

      case 'notifications/initialized':
      case 'ping':
        return {
          jsonrpc: '2.0',
          id,
          result: {},
        };

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: BROWSER_MCP_TOOL_SCHEMAS,
          },
        };

      case 'tools/call': {
        const params = isPlainObject(rpc.params) ? rpc.params : {};
        const name = typeof params.name === 'string' ? params.name : '';
        const toolArgs = isPlainObject(params.arguments) ? params.arguments : {};
        if (!name) {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: 'Missing tool "name" in tools/call params' },
          };
        }

        try {
          const { result, screenshotDataUrl } = await this.executeMcpTool(auth, name, toolArgs);
          const content: McpContentItem[] = [
            { type: 'text', text: JSON.stringify(result) },
          ];
          if (screenshotDataUrl) {
            const m = /^data:([^;]+);base64,(.+)$/.exec(screenshotDataUrl);
            if (m) {
              content.push({
                type: 'image',
                mimeType: m[1]!,
                data: m[2]!,
              });
            }
          }
          const callRes: McpCallToolResultDto = {
            content,
            isError: false,
          };
          return {
            jsonrpc: '2.0',
            id,
            result: callRes,
          };
        } catch (err) {
          const errPayload = {
            ok: false,
            error: err instanceof ApiError ? err.code : 'tool_execution_failed',
            message: err instanceof Error ? err.message : 'Tool execution failed',
          };
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(errPayload) }],
              isError: true,
            } satisfies McpCallToolResultDto,
          };
        }
      }

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${rpc.method}` },
        };
    }
  }

  // ==========================================================================
  // Zero-LLM Deterministic Replay of `AutomationScriptApp` on Real Chromium CDP
  // ==========================================================================

  async replayScriptApp(
    auth: BrowserCallerAuth,
    manifest: AutomationScriptApp,
    paramsInput: Record<string, string> = {},
    sessionIdInput?: string,
  ): Promise<ScriptReplayReport> {
    if (!isPlainObject(manifest) || !Array.isArray(manifest.steps)) {
      throw new ApiError(400, 'invalid_manifest', 'manifest with steps array is required');
    }
    if (manifest.steps.length > AUTOMATION_APP_LIMITS.maxStepsCount) {
      throw new ApiError(
        400,
        'too_many_steps',
        `manifest.steps exceeds maximum of ${AUTOMATION_APP_LIMITS.maxStepsCount} steps`,
      );
    }
    for (let i = 0; i < manifest.steps.length; i++) {
      const s = manifest.steps[i];
      if (!isPlainObject(s) || typeof s.kind !== 'string') {
        throw new ApiError(400, 'invalid_step', `Step #${i} must be an object with a string kind`);
      }
      const sRec = s as Record<string, unknown>;
      if (
        sRec.timeout_ms !== undefined &&
        (typeof sRec.timeout_ms !== 'number' || !Number.isFinite(sRec.timeout_ms))
      ) {
        throw new ApiError(400, 'invalid_parameter', `Step #${i} timeout_ms must be a finite number`);
      }
    }
    const startMs = Date.now();
    const extractedOutputs: Record<string, string> = {};
    const stepTimings: StepTimingMetric[] = [];
    let stepsExecuted = 0;

    // Resolve template placeholders `{{param}}`
    const paramValues = new Map<string, string>();
    const rawParams = Array.isArray(manifest.parameters) ? manifest.parameters : [];
    for (const p of rawParams) {
      if (paramsInput[p.name] !== undefined) {
        paramValues.set(p.name, String(paramsInput[p.name]));
      } else if (typeof p.default_value === 'string') {
        paramValues.set(p.name, p.default_value);
      } else if (p.required !== false) {
        throw new ApiError(400, 'missing_parameter', `Missing required script parameter: ${p.name}`);
      }
    }
    for (const [k, v] of Object.entries(paramsInput)) {
      paramValues.set(k, String(v));
    }

    const interpolate = (tpl: string): string =>
      tpl.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_m, key: string) => paramValues.get(key) ?? '');

    let ownsSession = false;
    let managed: ManagedHeadlessSession;
    if (sessionIdInput) {
      managed = this.requireHeadlessSession(auth.userId, sessionIdInput);
    } else {
      const opened = await this.openHeadlessSession(auth, { url: 'about:blank' });
      managed = this.requireHeadlessSession(auth.userId, opened.session.session_id);
      ownsSession = true;
    }

    const resolveLocatorJs = (loc: SemanticLocator): string => `(function(loc) {
      if (loc.test_id) {
        const byTid = document.querySelector('[data-testid=' + JSON.stringify(loc.test_id) + ']');
        if (byTid) return byTid;
      }
      if (loc.aria_label) {
        const byAria = document.querySelector('[aria-label=' + JSON.stringify(loc.aria_label) + ']');
        if (byAria) return byAria;
      }
      if (loc.name_attr) {
        const byName = document.querySelector('[name=' + JSON.stringify(loc.name_attr) + ']');
        if (byName) return byName;
      }
      if (loc.css_selector) {
        try {
          const byCss = document.querySelector(loc.css_selector);
          if (byCss) return byCss;
        } catch (_) {}
      }
      if (loc.role || loc.text_anchor) {
        const pool = Array.from(document.querySelectorAll(loc.role ? ('[role=' + JSON.stringify(loc.role) + '], button, a, input, label, [data-testid]') : '*'));
        for (const el of pool) {
          const txt = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
          if (loc.text_anchor && txt.indexOf(loc.text_anchor) !== -1) return el;
        }
      }
      return null;
    })(${JSON.stringify(loc)})`;

    try {
      for (let i = 0; i < manifest.steps.length; i++) {
        const step = manifest.steps[i]!;
        const stepStart = Date.now();
        this.controlModes.set(auth.userId, {
          mode: 'ai_controlling',
          active_step: i,
          status_text: `Running step ${i + 1}/${manifest.steps.length}: ${step.kind}`,
        });

        try {
          switch (step.kind) {
            case 'navigate': {
              const url = interpolate(step.url_template);
              await managed.driver.goto(url);
              break;
            }
            case 'wait_for': {
              const deadline = Date.now() + Math.max(100, Math.min(30_000, Number(step.timeout_ms || 5000)));
              let found = false;
              while (Date.now() < deadline) {
                found = await managed.driver.evaluateJs<boolean>(`Boolean(${resolveLocatorJs(step.locator)})`);
                if (found) break;
                await new Promise((r) => setTimeout(r, 100));
              }
              if (!found) {
                throw new Error(`wait_for timed out for locator ${JSON.stringify(step.locator)}`);
              }
              break;
            }
            case 'click': {
              const ok = await managed.driver.evaluateJs<boolean>(
                `(function(){ const el = ${resolveLocatorJs(step.locator)}; if (!el) return false; el.scrollIntoView({block:'center'}); el.click(); return true; })()`,
              );
              if (!ok) throw new Error(`click target not found: ${JSON.stringify(step.locator)}`);
              break;
            }
            case 'fill': {
              const val = interpolate(step.value_template);
              const ok = await managed.driver.evaluateJs<boolean>(
                `(function(v){ const el = ${resolveLocatorJs(step.locator)}; if (!el) return false; if (typeof el.focus === 'function') el.focus(); const tag = el.tagName.toLowerCase(); if (tag === 'input' || tag === 'textarea' || tag === 'select') { el.value = v; } else { el.textContent = v; } el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); return true; })(${JSON.stringify(val)})`,
              );
              if (!ok) throw new Error(`fill target not found: ${JSON.stringify(step.locator)}`);
              break;
            }
            case 'press_key': {
              await managed.driver.performAction({ action: 'press', key: step.key });
              break;
            }
            case 'scroll': {
              await managed.driver.performAction({ action: 'scroll', delta_y: step.delta_y });
              break;
            }
            case 'extract_text': {
              const res = await managed.driver.evaluateJs<{ found: boolean; text: string }>(
                `(function(){ const el = ${resolveLocatorJs(step.locator)}; if (!el) return { found: false, text: '' }; return { found: true, text: (el.innerText || el.textContent || el.value || '').trim() }; })()`,
              );
              if (!res?.found) {
                throw new Error(`extract_text target not found: ${JSON.stringify(step.locator)}`);
              }
              extractedOutputs[step.output_key] = res.text;
              break;
            }
            case 'assert_visible': {
              const visible = await managed.driver.evaluateJs<boolean>(
                `(function(){ const el = ${resolveLocatorJs(step.locator)}; if (!el) return false; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; })()`,
              );
              if (!visible) {
                throw new Error(`assert_visible failed: ${JSON.stringify(step.locator)}`);
              }
              break;
            }
            case 'assert_text_contains': {
              const expected = interpolate(step.expected_template);
              const actual = await managed.driver.evaluateJs<string | null>(
                `(function(){ const el = ${resolveLocatorJs(step.locator)}; if (!el) return null; return (el.innerText || el.textContent || el.value || '').trim(); })()`,
              );
              if (actual === null || !actual.includes(expected)) {
                throw new Error(`assert_text_contains failed: expected "${expected}" in "${String(actual)}"`);
              }
              break;
            }
            case 'human_checkpoint': {
              this.controlModes.set(auth.userId, {
                mode: 'waiting_for_takeover',
                reason: step.reason,
              });
              stepTimings.push({
                step_index: i,
                operation: step.kind,
                backend: 'chrome_cdp',
                duration_ms: Date.now() - stepStart,
                success: true,
                detail: step.reason,
              });
              stepsExecuted += 1;
              return {
                app_id: manifest.app_id,
                version: manifest.version,
                success: false,
                steps_executed: stepsExecuted,
                extracted_outputs: extractedOutputs,
                step_timings: stepTimings,
                total_duration_ms: Date.now() - startMs,
                used_llm: false,
                final_url: managed.driver.getUrl(),
                error: `human_checkpoint: ${step.reason}`,
              };
            }
          }

          stepsExecuted += 1;
          stepTimings.push({
            step_index: i,
            operation: step.kind,
            backend: 'chrome_cdp',
            duration_ms: Date.now() - stepStart,
            success: true,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          stepTimings.push({
            step_index: i,
            operation: step.kind,
            backend: 'chrome_cdp',
            duration_ms: Date.now() - stepStart,
            success: false,
            detail: errMsg,
          });
          return {
            app_id: manifest.app_id,
            version: manifest.version,
            success: false,
            steps_executed: stepsExecuted,
            extracted_outputs: extractedOutputs,
            step_timings: stepTimings,
            total_duration_ms: Date.now() - startMs,
            used_llm: false,
            final_url: managed.driver.getUrl(),
            error: errMsg,
          };
        }
      }

      this.controlModes.set(auth.userId, { mode: 'idle' });
      return {
        app_id: manifest.app_id,
        version: manifest.version,
        success: true,
        steps_executed: stepsExecuted,
        extracted_outputs: extractedOutputs,
        step_timings: stepTimings,
        total_duration_ms: Date.now() - startMs,
        used_llm: false,
        final_url: managed.driver.getUrl(),
        error: null,
      };
    } finally {
      if (ownsSession) {
        await this.closeHeadlessSession(auth, managed.dto.session_id).catch(() => {});
      }
    }
  }

  // ==========================================================================
  // Fast Test Reset & Clean Server Shutdown (Await Chromium Close FIRST!)
  // ==========================================================================

  resetFastSync(): void {
    for (const [, pending] of this.pendingCommands) {
      clearTimeout(pending.timer);
      pending.reject(new ApiError(503, 'server_reset', 'Server reset in progress'));
    }
    this.pendingCommands.clear();

    for (const [, managed] of this.headlessSessions) {
      managed.driver.killFastSync();
    }
    this.headlessSessions.clear();

    for (const ctrl of this.controllerSockets) {
      try {
        ctrl.ws.close(1012, 'Server reset');
      } catch {
        // Ignore
      }
    }
    this.controllerSockets.clear();
    this.socketToTargetIds.clear();
    this.liveTabs.clear();
    this.controlModes.clear();
  }

  async closeAllHeadlessSessions(): Promise<void> {
    const entries = Array.from(this.headlessSessions.values());
    this.headlessSessions.clear();
    await Promise.allSettled(entries.map((e) => e.driver.close()));
  }

  async dispose(): Promise<void> {
    // Gracefully close headless Chromium processes FIRST so zero zombies survive!
    await this.closeAllHeadlessSessions();
    this.resetFastSync();
    activeBridges.delete(this);
  }
}

// ============================================================================
// Script Distillation Engine (`BrowserActionTrace -> AutomationScriptApp`)
// ============================================================================

const SENSITIVE_FIELD_RE =
  /pass(word|code)?|secret|token|api[_-]?key|otp|pin|cvv|ssn|credential|auth|bearer/i;

function hasAnySemanticLocator(loc: SemanticLocator | undefined | null): loc is SemanticLocator {
  if (!loc || typeof loc !== 'object') return false;
  return Boolean(
    (typeof loc.test_id === 'string' && loc.test_id.trim()) ||
      (typeof loc.aria_label === 'string' && loc.aria_label.trim()) ||
      (typeof loc.role === 'string' && loc.role.trim()) ||
      (typeof loc.text_anchor === 'string' && loc.text_anchor.trim()) ||
      (typeof loc.css_selector === 'string' && loc.css_selector.trim()) ||
      (typeof loc.name_attr === 'string' && loc.name_attr.trim()),
  );
}

function slugifyName(raw: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'automation-script'
  );
}

function extractSafeDomain(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (isBlockedMetadataOrLinkLocalHost(host)) {
      throw new ApiError(400, 'unsafe_browser_url', `Blocked metadata host in trace URL: ${host}`);
    }
    return host || null;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    return null;
  }
}

const SENSITIVE_URL_PARAM_RE =
  /^(?:token|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|api[_-]?key|apikey|password|passwd|pwd|secret|client[_-]?secret|session[_-]?id|auth|authorization|bearer|key|signature|sig|otp)$/i;

function scrubSensitiveUrlForDistillation(
  safeUrl: string,
  paramsMap: Map<string, AutomationAppParam>,
  parameterizeText: (literal: string) => string,
  stepIdx: number,
): string {
  if (!/^https?:\/\//i.test(safeUrl)) {
    return parameterizeText(safeUrl);
  }
  let u: URL;
  try {
    u = new URL(safeUrl);
  } catch {
    return parameterizeText(safeUrl);
  }

  const placeholders: Array<{ sentinel: string; paramName: string }> = [];
  const registerSecretParam = (rawKey: string, desc: string): string => {
    const base =
      rawKey
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')
        .replace(/^_+|_+$/g, '') || `url_secret_${stepIdx + 1}`;
    let paramName = base;
    const existing = paramsMap.get(paramName);
    if (existing && !existing.is_secret) {
      paramName = `${base}_secret`;
    }
    paramsMap.set(paramName, {
      name: paramName,
      description: desc,
      required: true,
      default_value: null,
      is_secret: true,
    });
    const sentinel = `__FABUSHI_DISTILL_PH_${placeholders.length}__`;
    placeholders.push({ sentinel, paramName });
    return sentinel;
  };

  // 1. URL embedded basic-auth password (`https://user:pass@host/...`)
  if (u.password) {
    u.password = registerSecretParam('url_password', `Secret password for ${u.hostname}`);
  }

  // 2. Sensitive query parameters (`?token=...`, `?api_key=...`, `?access_token=...`, `?password=...`, or leaky value)
  const entries = Array.from(u.searchParams.entries());
  if (entries.length > 0) {
    let queryMutated = false;
    const nextParams = new URLSearchParams();
    for (const [k, v] of entries) {
      const parameterized = parameterizeText(v);
      const alreadyTemplated = /^\{\{\s*[A-Za-z0-9_.-]+\s*\}\}$/.test(parameterized.trim());
      const isSensitive =
        !alreadyTemplated &&
        v.trim().length > 0 &&
        (SENSITIVE_URL_PARAM_RE.test(k) || !scanJsonForSecretLeaks(v).safe);
      if (isSensitive) {
        queryMutated = true;
        nextParams.append(k, registerSecretParam(k, `Secret URL parameter ${k}`));
      } else {
        nextParams.append(k, v);
      }
    }
    if (queryMutated) {
      u.search = nextParams.toString();
    }
  }

  // 3. Sensitive fragment/hash parameters (`#access_token=...&state=ok` or raw secret in hash)
  if (u.hash.length > 1) {
    const rawHash = u.hash.slice(1);
    if (rawHash.includes('=')) {
      let hashMutated = false;
      const nextParts = rawHash.split('&').map((part) => {
        const eq = part.indexOf('=');
        if (eq <= 0) return part;
        const k = part.slice(0, eq);
        const v = part.slice(eq + 1);
        let decodedVal = v;
        try {
          decodedVal = decodeURIComponent(v);
        } catch {
          // keep raw
        }
        const parameterized = parameterizeText(decodedVal);
        const alreadyTemplated = /^\{\{\s*[A-Za-z0-9_.-]+\s*\}\}$/.test(parameterized.trim());
        if (
          !alreadyTemplated &&
          decodedVal.trim().length > 0 &&
          (SENSITIVE_URL_PARAM_RE.test(k) || !scanJsonForSecretLeaks(decodedVal).safe)
        ) {
          hashMutated = true;
          return `${k}=${registerSecretParam(k, `Secret URL fragment parameter ${k}`)}`;
        }
        return part;
      });
      if (hashMutated) {
        u.hash = `#${nextParts.join('&')}`;
      }
    } else if (!scanJsonForSecretLeaks(rawHash).safe) {
      u.hash = `#${registerSecretParam('url_fragment_secret', 'Secret URL fragment')}`;
    }
  }

  let result = parameterizeText(u.toString());
  for (const { sentinel, paramName } of placeholders) {
    result = result.split(sentinel).join(`{{${paramName}}}`);
  }
  return result;
}

export function distillBrowserActionTrace(
  trace: BrowserActionTrace,
  meta: ScriptAppMetadata,
  authorUserId: number,
): AutomationScriptApp {
  if (!isPlainObject(trace) || !Array.isArray(trace.actions) || trace.actions.length === 0) {
    throw new ApiError(400, 'empty_trace', 'trace.actions must contain at least one recorded action');
  }
  if (!isPlainObject(meta)) {
    throw new ApiError(400, 'invalid_metadata', 'metadata must be a JSON object');
  }
  if (trace.actions.length > AUTOMATION_APP_LIMITS.maxStepsCount) {
    throw new ApiError(
      400,
      'too_many_steps',
      `trace.actions exceeds maximum of ${AUTOMATION_APP_LIMITS.maxStepsCount} steps`,
    );
  }
  const name = typeof meta.name === 'string' ? meta.name.trim() : '';
  if (!name || name.length > AUTOMATION_APP_LIMITS.maxNameLen) {
    throw new ApiError(400, 'invalid_metadata', 'metadata.name is required (1..160 chars)');
  }

  if (
    trace.parameter_bindings !== undefined &&
    trace.parameter_bindings !== null &&
    !Array.isArray(trace.parameter_bindings)
  ) {
    throw new ApiError(400, 'invalid_parameter', 'trace.parameter_bindings must be an array');
  }
  if (
    meta.parameter_overrides !== undefined &&
    meta.parameter_overrides !== null &&
    !Array.isArray(meta.parameter_overrides)
  ) {
    throw new ApiError(400, 'invalid_parameter', 'metadata.parameter_overrides must be an array');
  }
  if (
    meta.target_domains !== undefined &&
    meta.target_domains !== null &&
    !Array.isArray(meta.target_domains)
  ) {
    throw new ApiError(400, 'invalid_parameter', 'metadata.target_domains must be an array');
  }
  if (
    meta.required_capabilities !== undefined &&
    meta.required_capabilities !== null &&
    !Array.isArray(meta.required_capabilities)
  ) {
    throw new ApiError(400, 'invalid_parameter', 'metadata.required_capabilities must be an array');
  }

  for (let i = 0; i < trace.actions.length; i++) {
    if (!isPlainObject(trace.actions[i])) {
      throw new ApiError(400, 'invalid_action', `Action #${i} must be a JSON object`);
    }
  }

  const sortedActions: RecordedBrowserAction[] = [...trace.actions].sort(
    (a, b) => (Number.isFinite(Number(a.seq)) ? Number(a.seq) : 0) - (Number.isFinite(Number(b.seq)) ? Number(b.seq) : 0),
  );

  const bindings = Array.isArray(trace.parameter_bindings)
    ? trace.parameter_bindings.filter((b) => isPlainObject(b))
    : [];
  const paramsMap = new Map<string, AutomationAppParam>();
  for (const ov of Array.isArray(meta.parameter_overrides) ? meta.parameter_overrides : []) {
    if (isPlainObject(ov) && typeof ov.name === 'string' && ov.name.trim()) {
      paramsMap.set(ov.name.trim(), {
        name: ov.name.trim(),
        description: typeof ov.description === 'string' ? ov.description : '',
        required: ov.required !== undefined ? Boolean(ov.required) : true,
        default_value: typeof ov.default_value === 'string' ? ov.default_value : null,
        is_secret: Boolean(ov.is_secret),
      });
    }
  }
  for (const b of bindings) {
    if (typeof b.param_name === 'string' && b.param_name.trim() && !paramsMap.has(b.param_name.trim())) {
      paramsMap.set(b.param_name.trim(), {
        name: b.param_name.trim(),
        description: typeof b.description === 'string' ? b.description : '',
        required: b.required !== undefined ? Boolean(b.required) : true,
        default_value: null,
        is_secret: Boolean(b.is_secret),
      });
    }
  }

  const parameterizeText = (literal: string): string => {
    let out = literal;
    for (const b of bindings) {
      if (
        typeof b.literal_value === 'string' &&
        b.literal_value.length > 0 &&
        typeof b.param_name === 'string' &&
        b.param_name.trim() &&
        out.includes(b.literal_value)
      ) {
        out = out.split(b.literal_value).join(`{{${b.param_name.trim()}}}`);
      }
    }
    return out;
  };

  const domainsSet = new Set<string>(
    (Array.isArray(meta.target_domains) ? meta.target_domains : [])
      .filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
      .map((d) => d.trim().toLowerCase()),
  );
  if (typeof trace.initial_url === 'string' && trace.initial_url.trim()) {
    const dom = extractSafeDomain(trace.initial_url.trim());
    if (dom) domainsSet.add(dom);
  }

  const steps: ScriptStep[] = [];
  const capabilities = new Set<string>(
    (Array.isArray(meta.required_capabilities) ? meta.required_capabilities : []).filter(
      (c): c is string => typeof c === 'string' && c.trim().length > 0,
    ),
  );
  capabilities.add('browser.cdp');

  for (let i = 0; i < sortedActions.length; i++) {
    const rec = sortedActions[i]!;
    if (typeof rec.page_url === 'string' && rec.page_url.trim()) {
      const dom = extractSafeDomain(rec.page_url.trim());
      if (dom) domainsSet.add(dom);
    }
    const act = rec.action;
    if (!isPlainObject(act) || typeof act.kind !== 'string') {
      throw new ApiError(400, 'invalid_action', `Action #${i} is missing valid action.kind`);
    }

    switch (act.kind) {
      case 'navigate': {
        if (typeof act.url !== 'string' || !act.url.trim()) {
          throw new ApiError(400, 'invalid_browser_url', `Action #${i} (navigate) requires a non-empty string url`);
        }
        const safeUrl = validateHeadlessUrl(act.url);
        const dom = extractSafeDomain(safeUrl);
        if (dom) domainsSet.add(dom);
        const urlTemplate = scrubSensitiveUrlForDistillation(safeUrl, paramsMap, parameterizeText, i);
        steps.push({ kind: 'navigate', url_template: urlTemplate });
        break;
      }
      case 'wait_for': {
        if (!hasAnySemanticLocator(act.locator)) {
          throw new ApiError(400, 'invalid_locator', `Action #${i} (wait_for) requires a non-empty SemanticLocator`);
        }
        const rawTimeout = act.timeout_ms !== undefined ? optionalFiniteNumber(act.timeout_ms, 'timeout_ms') : 5000;
        steps.push({
          kind: 'wait_for',
          locator: act.locator,
          timeout_ms: Math.max(100, Math.min(30_000, Math.floor(rawTimeout ?? 5000))),
        });
        break;
      }
      case 'click': {
        if (!hasAnySemanticLocator(act.locator)) {
          throw new ApiError(400, 'invalid_locator', `Action #${i} (click) requires a non-empty SemanticLocator`);
        }
        steps.push({ kind: 'click', locator: act.locator });
        break;
      }
      case 'fill': {
        if (!hasAnySemanticLocator(act.locator)) {
          throw new ApiError(400, 'invalid_locator', `Action #${i} (fill) requires a non-empty SemanticLocator`);
        }
        const vaultKeyHint =
          typeof act.vault_key_hint === 'string' && act.vault_key_hint.trim()
            ? act.vault_key_hint.trim()
            : undefined;
        const paramNameHint =
          typeof act.parameter_name_hint === 'string' && act.parameter_name_hint.trim()
            ? act.parameter_name_hint.trim()
            : undefined;
        const locatorText = [
          act.locator.test_id,
          act.locator.aria_label,
          act.locator.name_attr,
          act.locator.css_selector,
          act.locator.text_anchor,
          paramNameHint,
          vaultKeyHint,
        ]
          .filter((v): v is string => typeof v === 'string' && v.length > 0)
          .join(' ');
        const rawFillValue =
          typeof act.value === 'string'
            ? act.value
            : act.value === undefined || act.value === null
              ? ''
              : String(act.value);
        const matchedBinding = bindings.find(
          (b) => typeof b.literal_value === 'string' && b.literal_value.length > 0 && rawFillValue === b.literal_value,
        );
        const valueLooksSecret =
          rawFillValue.trim().length > 0 && !scanJsonForSecretLeaks(rawFillValue).safe;
        const isSecret =
          Boolean(act.is_secret) ||
          Boolean(matchedBinding?.is_secret) ||
          Boolean(vaultKeyHint) ||
          SENSITIVE_FIELD_RE.test(locatorText) ||
          valueLooksSecret;

        if (isSecret) {
          const paramName =
            paramNameHint ||
            (typeof matchedBinding?.param_name === 'string' && matchedBinding.param_name.trim()) ||
            (vaultKeyHint && vaultKeyHint.replace(/[^A-Za-z0-9_]/g, '_')) ||
            (typeof act.locator.name_attr === 'string' && act.locator.name_attr.trim().replace(/[^A-Za-z0-9_]/g, '_')) ||
            `secret_input_${i + 1}`;
          paramsMap.set(paramName, {
            name: paramName,
            description: `Secret credential for ${act.locator.name_attr || act.locator.aria_label || paramName}`,
            required: true,
            default_value: null,
            is_secret: true,
          });
          steps.push({
            kind: 'fill',
            locator: act.locator,
            value_template: `{{${paramName}}}`,
            secret_vault_key: vaultKeyHint ?? paramName,
          });
        } else if (paramNameHint) {
          if (!paramsMap.has(paramNameHint)) {
            paramsMap.set(paramNameHint, {
              name: paramNameHint,
              description: `Input parameter ${paramNameHint}`,
              required: true,
              default_value: null,
              is_secret: false,
            });
          }
          steps.push({
            kind: 'fill',
            locator: act.locator,
            value_template: `{{${paramNameHint}}}`,
            secret_vault_key: null,
          });
        } else {
          steps.push({
            kind: 'fill',
            locator: act.locator,
            value_template: parameterizeText(rawFillValue),
            secret_vault_key: null,
          });
        }
        break;
      }
      case 'press_key': {
        const keyStr = typeof act.key === 'string' && act.key.trim() ? act.key.trim() : 'Enter';
        steps.push({ kind: 'press_key', key: keyStr });
        break;
      }
      case 'scroll': {
        const dx = act.delta_x !== undefined ? optionalFiniteNumber(act.delta_x, 'delta_x') : 0;
        const dy = act.delta_y !== undefined ? optionalFiniteNumber(act.delta_y, 'delta_y') : 320;
        steps.push({
          kind: 'scroll',
          delta_x: dx ?? 0,
          delta_y: dy ?? 320,
        });
        break;
      }
      case 'extract_text': {
        if (!hasAnySemanticLocator(act.locator)) {
          throw new ApiError(400, 'invalid_locator', `Action #${i} (extract_text) requires a non-empty SemanticLocator`);
        }
        const outKey =
          typeof act.output_key === 'string' && act.output_key.trim()
            ? act.output_key.trim()
            : `output_${i + 1}`;
        steps.push({
          kind: 'extract_text',
          locator: act.locator,
          output_key: outKey,
        });
        break;
      }
      case 'assert_visible': {
        if (!hasAnySemanticLocator(act.locator)) {
          throw new ApiError(400, 'invalid_locator', `Action #${i} (assert_visible) requires a non-empty SemanticLocator`);
        }
        steps.push({ kind: 'assert_visible', locator: act.locator });
        break;
      }
      case 'assert_text_contains': {
        if (!hasAnySemanticLocator(act.locator)) {
          throw new ApiError(400, 'invalid_locator', `Action #${i} (assert_text_contains) requires a non-empty SemanticLocator`);
        }
        const expectedStr = typeof act.expected === 'string' ? act.expected : String(act.expected ?? '');
        steps.push({
          kind: 'assert_text_contains',
          locator: act.locator,
          expected_template: parameterizeText(expectedStr),
        });
        break;
      }
      case 'human_checkpoint': {
        const reasonStr =
          typeof act.reason === 'string' && act.reason.trim()
            ? act.reason.trim()
            : 'Human review required';
        steps.push({ kind: 'human_checkpoint', reason: reasonStr });
        break;
      }
      default:
        throw new ApiError(400, 'invalid_action', `Unsupported recorded action kind`);
    }
  }

  const slug =
    typeof meta.slug === 'string' && meta.slug.trim()
      ? slugifyName(meta.slug)
      : slugifyName(name);
  const appId =
    typeof meta.app_id === 'string' && meta.app_id.trim()
      ? meta.app_id.trim()
      : `${slug}-${crypto.randomBytes(4).toString('hex')}`;
  const appIdCheck = validateAutomationAppId(appId);
  if (!appIdCheck.valid) {
    throw new ApiError(400, 'invalid_app_id', appIdCheck.error);
  }

  const manifest: AutomationScriptApp = {
    schema_version: AUTOMATION_APP_SCHEMA_VERSION_V1,
    app_id: appIdCheck.normalized,
    slug,
    name,
    version: typeof meta.version === 'string' && meta.version.trim() ? meta.version.trim() : '1.0.0',
    description: typeof meta.description === 'string' ? meta.description.trim() : '',
    category: typeof meta.category === 'string' && meta.category.trim() ? meta.category.trim() : 'automation',
    target_domains: Array.from(domainsSet).slice(0, AUTOMATION_APP_LIMITS.maxDomainsCount),
    parameters: Array.from(paramsMap.values()).slice(0, AUTOMATION_APP_LIMITS.maxParametersCount),
    steps,
    required_capabilities: Array.from(capabilities),
    author_id: String(authorUserId),
    source_trace_summary: `Distilled ${steps.length} deterministic step(s) from trace ${typeof trace.trace_id === 'string' && trace.trace_id.trim() ? trace.trace_id.trim() : 'recording'}`,
  };

  // Defense-in-depth secret leak scan on distilled manifest!
  const leakScan = scanJsonForSecretLeaks(manifest, {
    context: 'app',
    parameters: manifest.parameters,
  });
  if (!leakScan.safe) {
    const first = leakScan.findings[0];
    throw new ApiError(
      422,
      'secret_leak_detected',
      `Distilled script contains unredacted secret (${first?.reason ?? 'secret_pattern'} at ${first?.path ?? '$'})`,
      { findings: leakScan.findings },
    );
  }

  return manifest;
}

// ============================================================================
// HTTP Route Registration (`/api/v1/browser/*` & `/api/v1/mcp/*`)
// ============================================================================

export function registerBrowserControlRoutes(
  router: HttpRouter,
  db: DatabaseSync,
  bridge: BrowserControlBridge,
): void {
  const resolveBaseUrl = (ctx: RequestContext): string => {
    const proto =
      typeof ctx.req.headers['x-forwarded-proto'] === 'string'
        ? ctx.req.headers['x-forwarded-proto'].split(',')[0]!.trim()
        : 'http';
    const host = ctx.req.headers.host ?? '127.0.0.1';
    return `${proto}://${host}`;
  };

  // 1. Desktop Pairing (`pair/create` & `pair/claim`)
  router.post('/api/v1/browser/pair/create', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{ label?: unknown; ttl_secs?: unknown }>(ctx.req);
    const label = optionalTrimmedString(body.label, 'label', 120);
    const ttlSecs = optionalFiniteNumber(body.ttl_secs, 'ttl_secs');
    const ticket = bridge.createPairingTicket(auth.userId, resolveBaseUrl(ctx), {
      label,
      ttlSecs,
    });
    sendJson(ctx.res, 200, ticket);
  });

  router.post('/api/v1/browser/pair/claim', async (ctx) => {
    const body = await readJsonBody<{
      pair_code?: unknown;
      pairing_code?: unknown;
      code?: unknown;
      controller_label?: unknown;
      device_name?: unknown;
    }>(ctx.req);
    const rawCode = body.pair_code ?? body.pairing_code ?? body.code;
    if (rawCode === undefined || rawCode === null) {
      throw new ApiError(400, 'missing_pair_code', 'pair_code is required');
    }
    if (typeof rawCode !== 'string') {
      throw new ApiError(400, 'invalid_parameter', 'pair_code must be a string');
    }
    const controllerLabel =
      body.controller_label !== undefined
        ? optionalTrimmedString(body.controller_label, 'controller_label', 120)
        : optionalTrimmedString(body.device_name, 'device_name', 120);
    const ticket = bridge.claimPairingTicket(rawCode, controllerLabel, resolveBaseUrl(ctx));
    sendJson(ctx.res, 200, ticket);
  });

  // 2. Live Browser Targets, State Polling & Command Execution
  router.get('/api/v1/browser/targets', (ctx) => {
    const auth = bridge.requireBrowserAuth(ctx);
    sendJson(ctx.res, 200, {
      targets: bridge.listTargets(auth.userId),
      headless_sessions: bridge.listHeadlessSessions(auth.userId),
      control_generation: bridge.getGeneration(auth.userId),
    });
  });

  router.post('/api/v1/browser/targets/register', async (ctx) => {
    const auth = bridge.requireBrowserAuth(ctx);
    const body = await readJsonBody<BrowserRegisterPayload>(ctx.req);
    const descriptor = bridge.registerLiveTab(auth.userId, body, null);
    sendJson(ctx.res, 200, descriptor);
  });

  router.post('/api/v1/browser/targets/:targetId/state', async (ctx) => {
    const auth = bridge.requireBrowserAuth(ctx);
    const body = await readJsonBody<Omit<BrowserStateReportPayload, 'target_id'>>(ctx.req);
    const descriptor = bridge.reportTabState(auth.userId, {
      ...body,
      target_id: ctx.params.targetId!,
    });
    sendJson(ctx.res, 200, descriptor);
  });

  router.get('/api/v1/browser/targets/:targetId/poll', async (ctx) => {
    const auth = bridge.requireBrowserAuth(ctx);
    const waitMsRaw = Number(ctx.query.get('wait_ms') ?? 0);
    const waitMs = Number.isFinite(waitMsRaw) ? Math.max(0, waitMsRaw) : 0;
    const cmd = await bridge.pollNextTabCommand(auth.userId, ctx.params.targetId!, waitMs);
    sendJson(ctx.res, 200, { command: cmd });
  });

  router.post('/api/v1/browser/targets/:targetId/result', async (ctx) => {
    const auth = bridge.requireBrowserAuth(ctx);
    const body = await readJsonBody<BrowserCommandResult>(ctx.req);
    const resolved = bridge.resolveTabCommandResult(auth.userId, {
      ...body,
      target_id: body.target_id !== undefined ? body.target_id : ctx.params.targetId!,
    });
    sendJson(ctx.res, 200, { ok: resolved });
  });

  router.post('/api/v1/browser/command', async (ctx) => {
    const auth = bridge.requireBrowserAuth(ctx);
    const body = await readJsonBody<BrowserCommandRequest>(ctx.req);
    const result = await bridge.dispatchCommand(auth, body);
    sendJson(ctx.res, 200, result);
  });

  // 3. `<10ms` Atomic Emergency Control Revoke / Takeover & Audit Trail
  const handleRevoke = async (ctx: RequestContext): Promise<void> => {
    const auth = bridge.requireBrowserAuth(ctx);
    const body = await readJsonBody<{
      target_id?: unknown;
      revoke_tokens?: unknown;
      disable_remote_control?: unknown;
      reason?: unknown;
    }>(ctx.req);
    const targetId = optionalTrimmedString(body.target_id, 'target_id', 128);
    const revokeTokens = optionalBoolean(body.revoke_tokens, 'revoke_tokens');
    const disableRemoteControl = optionalBoolean(body.disable_remote_control, 'disable_remote_control');
    const reason = optionalTrimmedString(body.reason, 'reason', 256);
    const res = bridge.revokeControl(auth.userId, {
      targetId,
      revokeTokens,
      disableRemoteControl,
      reason,
    });
    sendJson(ctx.res, 200, res);
  };
  router.post('/api/v1/browser/revoke', handleRevoke);
  router.post('/api/v1/browser/takeover', handleRevoke);

  router.get('/api/v1/browser/audit', (ctx) => {
    const auth = bridge.requireBrowserAuth(ctx);
    const limit = Number(ctx.query.get('limit') ?? 50);
    sendJson(ctx.res, 200, {
      entries: bridge.listAuditLogs(auth.userId, Number.isFinite(limit) ? limit : 50),
    });
  });

  // 4. Headless Browser Automation Endpoints (`/api/v1/browser/headless/*`)
  const handleHeadlessOpen = async (ctx: RequestContext): Promise<void> => {
    const auth = bridge.requireBrowserAuth(ctx);
    const body = await readJsonBody<{
      url?: unknown;
      viewport?: unknown;
      width?: unknown;
      height?: unknown;
      prefer_fallback?: unknown;
      backend?: unknown;
    }>(ctx.req);

    if (body.width !== undefined && (typeof body.width !== 'number' || !Number.isFinite(body.width))) {
      throw new ApiError(400, 'invalid_viewport', 'width must be a finite number');
    }
    if (body.height !== undefined && (typeof body.height !== 'number' || !Number.isFinite(body.height))) {
      throw new ApiError(400, 'invalid_viewport', 'height must be a finite number');
    }
    const viewportInput =
      body.viewport !== undefined
        ? body.viewport
        : body.width !== undefined || body.height !== undefined
          ? {
              ...(body.width !== undefined ? { width: body.width } : {}),
              ...(body.height !== undefined ? { height: body.height } : {}),
            }
          : undefined;

    const opened = await bridge.openHeadlessSession(auth, {
      url: body.url,
      viewport: viewportInput,
      preferFallback: body.prefer_fallback,
      backend: body.backend,
    });
    sendJson(ctx.res, 200, {
      ok: true,
      ...opened,
    });
  };
  router.post('/api/v1/browser/headless/open', handleHeadlessOpen);
  router.post('/api/v1/browser/headless/sessions', handleHeadlessOpen);

  router.get('/api/v1/browser/headless/sessions', (ctx) => {
    const auth = bridge.requireBrowserAuth(ctx);
    sendJson(ctx.res, 200, {
      chromium_available: isChromiumBinaryAvailable(),
      sessions: bridge.listHeadlessSessions(auth.userId),
    });
  });

  router.get('/api/v1/browser/headless/:sessionId/snapshot', async (ctx) => {
    const auth = bridge.requireBrowserAuth(ctx);
    const res = await bridge.executeHeadlessAction(auth, ctx.params.sessionId!, {
      action: 'snapshot',
    });
    sendJson(ctx.res, 200, res);
  });

  const handleHeadlessAction = async (ctx: RequestContext): Promise<void> => {
    const auth = bridge.requireBrowserAuth(ctx);
    const body = await readJsonBody<
      BrowserCommandRequest & { session_id?: unknown; expression?: unknown; value?: unknown }
    >(ctx.req);
    const rawSid = ctx.params.sessionId ?? body.session_id;
    if (typeof rawSid !== 'string' || !rawSid.trim()) {
      throw new ApiError(400, 'missing_session_id', 'session_id is required');
    }
    const rawText = body.text ?? body.value ?? body.expression;
    if (rawText !== undefined && rawText !== null && typeof rawText !== 'string') {
      throw new ApiError(400, 'invalid_parameter', 'text/value/expression must be a string');
    }
    const res = await bridge.executeHeadlessAction(auth, rawSid.trim(), {
      ...body,
      text: typeof rawText === 'string' ? rawText : undefined,
    });
    sendJson(ctx.res, 200, res);
  };
  router.post('/api/v1/browser/headless/:sessionId/action', handleHeadlessAction);
  router.post('/api/v1/browser/headless/action', handleHeadlessAction);

  const handleHeadlessScreenshot = async (ctx: RequestContext): Promise<void> => {
    const auth = bridge.requireBrowserAuth(ctx);
    const body =
      ctx.method === 'POST' ? await readJsonBody<{ session_id?: unknown }>(ctx.req) : {};
    const rawSid = ctx.params.sessionId ?? body.session_id;
    if (typeof rawSid !== 'string' || !rawSid.trim()) {
      throw new ApiError(400, 'missing_session_id', 'session_id is required');
    }
    const shot = await bridge.captureHeadlessScreenshot(auth, rawSid.trim());
    sendJson(ctx.res, 200, shot);
  };
  router.get('/api/v1/browser/headless/:sessionId/screenshot', handleHeadlessScreenshot);
  router.post('/api/v1/browser/headless/:sessionId/screenshot', handleHeadlessScreenshot);
  router.post('/api/v1/browser/headless/screenshot', handleHeadlessScreenshot);

  const handleHeadlessClose = async (ctx: RequestContext): Promise<void> => {
    const auth = bridge.requireBrowserAuth(ctx);
    const body =
      ctx.method === 'POST' ? await readJsonBody<{ session_id?: unknown }>(ctx.req) : {};
    const rawSid = ctx.params.sessionId ?? body.session_id;
    if (typeof rawSid !== 'string' || !rawSid.trim()) {
      throw new ApiError(400, 'missing_session_id', 'session_id is required');
    }
    const closed = await bridge.closeHeadlessSession(auth, rawSid.trim());
    sendJson(ctx.res, 200, closed);
  };
  router.post('/api/v1/browser/headless/:sessionId/close', handleHeadlessClose);
  router.delete('/api/v1/browser/headless/:sessionId', handleHeadlessClose);
  router.post('/api/v1/browser/headless/close', handleHeadlessClose);

  // 5. Script Distillation, Zero-LLM CDP Replay & Control Mode (`v1.6.11`)
  router.post('/api/v1/browser/scripts/distill', async (ctx) => {
    const auth = bridge.requireBrowserAuth(ctx);
    const body = await readJsonBody<{
      trace?: unknown;
      metadata?: unknown;
    }>(ctx.req);
    if (!isPlainObject(body.trace) || !isPlainObject(body.metadata)) {
      throw new ApiError(400, 'invalid_request', 'trace and metadata JSON objects are required');
    }
    const manifest = distillBrowserActionTrace(
      body.trace as unknown as BrowserActionTrace,
      body.metadata as unknown as ScriptAppMetadata,
      auth.userId,
    );
    sendJson(ctx.res, 200, { ok: true, manifest, app: manifest });
  });

  router.post('/api/v1/browser/scripts/replay', async (ctx) => {
    const auth = bridge.requireBrowserAuth(ctx);
    const body = await readJsonBody<{
      manifest?: unknown;
      app?: unknown;
      params?: unknown;
      session_id?: unknown;
    }>(ctx.req);
    const rawManifest = body.manifest ?? body.app;
    if (!isPlainObject(rawManifest) || !Array.isArray(rawManifest.steps)) {
      throw new ApiError(400, 'invalid_manifest', 'manifest with steps array is required');
    }
    if (body.params !== undefined && body.params !== null && !isPlainObject(body.params)) {
      throw new ApiError(400, 'invalid_parameter', 'params must be a JSON object');
    }
    const sessionId = optionalTrimmedString(body.session_id, 'session_id', 128);
    const safeParams: Record<string, string> = {};
    if (isPlainObject(body.params)) {
      for (const [k, v] of Object.entries(body.params)) {
        safeParams[k] = typeof v === 'string' ? v : String(v ?? '');
      }
    }
    const report = await bridge.replayScriptApp(
      auth,
      rawManifest as unknown as AutomationScriptApp,
      safeParams,
      sessionId,
    );
    sendJson(ctx.res, 200, { ok: report.success, report, ...report });
  });

  router.get('/api/v1/browser/control-mode', (ctx) => {
    const auth = bridge.requireBrowserAuth(ctx);
    sendJson(ctx.res, 200, {
      ok: true,
      control_mode: bridge.getControlMode(auth.userId),
      control_generation: bridge.getGeneration(auth.userId),
    });
  });

  const VALID_CONTROL_MODE_ACTIONS = new Set(['takeover', 'resume', 'cancel', 'request_takeover']);
  router.post('/api/v1/browser/control-mode', async (ctx) => {
    const auth = bridge.requireBrowserAuth(ctx);
    const body = await readJsonBody<{
      action?: unknown;
      reason?: unknown;
      paused_at_step?: unknown;
      active_step?: unknown;
      status_text?: unknown;
    }>(ctx.req);
    const rawAction = body.action === undefined ? 'takeover' : body.action;
    if (typeof rawAction !== 'string' || !VALID_CONTROL_MODE_ACTIONS.has(rawAction)) {
      throw new ApiError(
        400,
        'invalid_parameter',
        'action must be one of: takeover, resume, cancel, request_takeover',
      );
    }
    const reason = optionalTrimmedString(body.reason, 'reason', 256);
    const statusText = optionalTrimmedString(body.status_text, 'status_text', 256);
    const pausedAtStep = optionalFiniteNumber(body.paused_at_step, 'paused_at_step') ?? 0;
    const activeStep = optionalFiniteNumber(body.active_step, 'active_step') ?? 0;

    let nextMode: BrowserControlMode;
    if (rawAction === 'takeover') {
      bridge.revokeControl(auth.userId, { revokeTokens: false, reason: reason ?? 'user_takeover' });
      nextMode = { mode: 'user_takeover', paused_at_step: Math.max(0, Math.floor(pausedAtStep)) };
    } else if (rawAction === 'request_takeover') {
      nextMode = { mode: 'waiting_for_takeover', reason: reason ?? 'Human input requested' };
    } else if (rawAction === 'resume') {
      nextMode = {
        mode: 'ai_controlling',
        active_step: Math.max(0, Math.floor(activeStep)),
        status_text: statusText ?? 'Resumed automation',
      };
    } else {
      nextMode = { mode: 'idle' };
    }
    bridge.setControlMode(auth.userId, nextMode);
    sendJson(ctx.res, 200, {
      ok: true,
      control_mode: nextMode,
      control_generation: bridge.getGeneration(auth.userId),
    });
  });

  // 6. MCP JSON-RPC 2.0 Server (`/api/v1/mcp/manifest` & `/api/v1/mcp/rpc`)
  router.get('/api/v1/mcp/manifest', (ctx) => {
    const baseUrl = resolveBaseUrl(ctx);
    sendJson(ctx.res, 200, {
      name: 'gpui-telegram-web-browser-bridge',
      version: '1.6.11',
      protocolVersion: '2025-11-25',
      rpc_endpoint: `${baseUrl}/api/v1/mcp/rpc`,
      ws_bridge_endpoint: `${baseUrl.replace(/^http/i, 'ws')}/api/v1/browser/ws`,
      chromium_cdp_available: isChromiumBinaryAvailable(),
      tools: BROWSER_MCP_TOOL_SCHEMAS,
    });
  });

  router.post('/api/v1/mcp/rpc', async (ctx) => {
    const auth = bridge.requireBrowserAuth(ctx);
    const body = await readJsonBody<McpJsonRpcRequest>(ctx.req);
    const rpcRes = await bridge.handleMcpJsonRpc(auth, body);
    sendJson(ctx.res, 200, rpcRes);
  });
}

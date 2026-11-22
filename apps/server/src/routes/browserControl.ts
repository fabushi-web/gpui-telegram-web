import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import type {
  BrowserActionKind,
  BrowserAuditLogEntry,
  BrowserCommandRequest,
  BrowserCommandResult,
  BrowserControlRevokeResponse,
  BrowserElementRef,
  BrowserRegisterPayload,
  BrowserSnapshotDto,
  BrowserStateReportPayload,
  BrowserTargetDescriptor,
  DesktopPairingTicketDto,
  HeadlessBrowserSessionDto,
  McpCallToolResultDto,
  McpContentItem,
  McpJsonRpcRequest,
  McpJsonRpcResponse,
  McpToolDto,
  McpToolSchemaDto,
  WsServerFrame,
} from '@gpui-telegram/protocol';
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

const CHROMIUM_CANDIDATE_PATHS = [
  process.env.CHROMIUM_PATH,
  '/usr/lib/chromium/chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
].filter((p): p is string => Boolean(p && p.trim()));

export function resolveChromiumBinaryPath(): string | null {
  for (const candidate of CHROMIUM_CANDIDATE_PATHS) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export const CHROMIUM_BINARY_PATH =
  resolveChromiumBinaryPath() ?? '/usr/lib/chromium/chromium';

export function isChromiumBinaryAvailable(): boolean {
  return (
    process.env.BROWSER_HEADLESS_MODE !== 'fallback' &&
    resolveChromiumBinaryPath() !== null
  );
}

const activeBridges = new Set<BrowserControlBridge>();

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
      'Launch an isolated headless browser session (real Chromium CDP when available, or deterministic HTTP DOM fallback) and optionally navigate to an initial URL.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Initial URL (http://, https://, data:, or about:blank)' },
        width: { type: 'number', description: 'Viewport width (default 1280)' },
        height: { type: 'number', description: 'Viewport height (default 800)' },
        prefer_fallback: {
          type: 'boolean',
          description: 'Use lightweight HTTP DOM fallback instead of Chromium CDP',
        },
      },
    },
  },
  {
    name: 'browser_headless_action',
    description:
      'Perform DOM inspection or interaction (snapshot, navigate/goto, click, fill, press, hover, scroll, select, evaluate_query, screenshot) in an open headless browser session.',
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
    description: 'Capture a PNG (Chromium CDP) or SVG (fallback) screenshot of a headless browser session.',
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
        prefer_fallback: { type: 'boolean', description: 'Use lightweight HTTP DOM fallback' },
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
    description: 'Open isolated headless Chromium CDP / fallback browser session',
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

function validateHeadlessUrl(rawUrl: string): string {
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
  return parsed.toString();
}

function normalizeActionKind(rawAction: string): BrowserActionKind {
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

function decodeBasicHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
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
          'User-Agent': 'GPUI-Telegram-HeadlessBridge/1.2',
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
// Headless Driver Interface + Implementations (Chromium CDP & HTTP DOM Fallback)
// ============================================================================

interface HeadlessDriver {
  readonly backend: 'chromium_cdp' | 'http_dom_fallback';
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
  screenshot(): Promise<{ dataUrl: string; mimeType: string }>;
  close(): Promise<void>;
  killFastSync(): void;
}

interface FallbackElementState extends BrowserElementRef {
  href?: string;
  checked?: boolean;
  clickCount: number;
}

class HttpDomFallbackDriver implements HeadlessDriver {
  readonly backend = 'http_dom_fallback' as const;
  private currentUrl = 'about:blank';
  private currentTitle = 'about:blank';
  private textExcerpt = '';
  private elements: FallbackElementState[] = [];
  private scrollY = 0;
  private lastKeyPressed: string | null = null;
  private lastClickedRef: string | null = null;
  private closed = false;

  constructor(
    private readonly sessionId: string,
    private readonly viewport: { width: number; height: number },
  ) {}

  getUrl(): string {
    return this.currentUrl;
  }

  getTitle(): string {
    return this.currentTitle;
  }

  getViewport(): { width: number; height: number } {
    return this.viewport;
  }

  private async fetchHtml(targetUrl: string): Promise<string> {
    const safeUrl = validateHeadlessUrl(targetUrl);
    this.currentUrl = safeUrl;
    this.scrollY = 0;

    if (safeUrl === 'about:blank') {
      return '<!doctype html><html><head><title>about:blank</title></head><body></body></html>';
    }

    if (/^data:/i.test(safeUrl)) {
      const commaIdx = safeUrl.indexOf(',');
      if (commaIdx === -1) return '';
      const meta = safeUrl.slice(5, commaIdx);
      const rawData = safeUrl.slice(commaIdx + 1);
      if (/;base64/i.test(meta)) {
        return Buffer.from(rawData, 'base64').toString('utf8');
      }
      try {
        return decodeURIComponent(rawData);
      } catch {
        return rawData;
      }
    }

    const parsed = new URL(safeUrl);
    const isLoopback =
      parsed.protocol === 'http:' &&
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1');

    if (isLoopback) {
      const res = await httpGetDirectBuffer(parsed, 6000);
      return res.body;
    }

    const resp = await fetch(safeUrl, {
      signal: AbortSignal.timeout(6000),
      headers: {
        Accept: 'text/html,application/xhtml+xml,text/plain,*/*',
      },
    });
    return await resp.text();
  }

  private parseHtmlIntoState(html: string): void {
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    this.currentTitle = titleMatch
      ? decodeBasicHtmlEntities(titleMatch[1]!.replace(/\s+/g, ' ').trim())
      : this.currentUrl;

    const withoutScripts = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ');

    this.textExcerpt = decodeBasicHtmlEntities(withoutScripts.replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1400);

    const parsedElements: FallbackElementState[] = [];
    const tagRegex = /<(a|button|input|textarea|select|div|span)\b([^>]*)>([\s\S]*?)<\/\1>|<(input)\b([^>]*?)\/?>/gi;
    let match: RegExpExecArray | null;
    let idx = 0;

    const readAttr = (attrs: string, name: string): string | undefined => {
      const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
      const m = re.exec(attrs);
      const val = m?.[1] ?? m?.[2] ?? m?.[3];
      return val !== undefined ? decodeBasicHtmlEntities(val) : undefined;
    };

    while ((match = tagRegex.exec(withoutScripts)) !== null && idx < 150) {
      const tag = (match[1] ?? match[4] ?? '').toLowerCase();
      const attrs = match[2] ?? match[5] ?? '';
      const innerHtml = match[3] ?? '';

      const role = readAttr(attrs, 'role');
      const testId = readAttr(attrs, 'data-testid');
      const id = readAttr(attrs, 'id');
      const isInteractiveGeneric =
        (tag === 'div' || tag === 'span') &&
        (role === 'button' || role === 'tab' || role === 'link' || Boolean(testId));

      if ((tag === 'div' || tag === 'span') && !isInteractiveGeneric) {
        continue;
      }

      idx += 1;
      const ref = `e${idx}`;
      const innerText = decodeBasicHtmlEntities(innerHtml.replace(/<[^>]+>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim();
      const ariaLabel = readAttr(attrs, 'aria-label');
      const placeholder = readAttr(attrs, 'placeholder');
      const attrValue = readAttr(attrs, 'value');
      const value = tag === 'textarea' ? innerText : attrValue;
      const disabled = /\bdisabled\b/i.test(attrs);
      const href = tag === 'a' ? readAttr(attrs, 'href') : undefined;

      const selector = id
        ? `#${id}`
        : testId
          ? `[data-testid="${testId}"]`
          : `[data-bctrl-ref="${ref}"]`;

      parsedElements.push({
        ref,
        selector,
        tag,
        role,
        text: (innerText || ariaLabel || placeholder || value || tag).slice(0, 160),
        id,
        testId,
        value,
        disabled,
        href,
        clickCount: 0,
        rect: {
          x: 24,
          y: 48 + (idx - 1) * 36,
          width: 260,
          height: 30,
        },
      });
    }

    this.elements = parsedElements;
  }

  private buildSnapshot(): BrowserSnapshotDto {
    return {
      target_id: this.sessionId,
      url: this.currentUrl,
      title: this.currentTitle,
      timestamp_ms: Date.now(),
      viewport: { ...this.viewport },
      text_excerpt: this.textExcerpt,
      elements: this.elements.map(({ href: _h, checked: _c, clickCount: _k, ...el }) => ({
        ...el,
      })),
    };
  }

  private findElement(ref?: string, selector?: string): FallbackElementState | undefined {
    if (ref) {
      const cleanRef = ref.replace(/^@/, '');
      const byRef = this.elements.find((e) => e.ref === cleanRef);
      if (byRef) return byRef;
    }
    if (selector) {
      const idMatch = /^#([A-Za-z0-9_-]+)$/.exec(selector.trim());
      if (idMatch) {
        return this.elements.find((e) => e.id === idMatch[1]);
      }
      const testIdMatch = /^\[data-testid=["']?([^"'\]]+)["']?\]$/.exec(selector.trim());
      if (testIdMatch) {
        return this.elements.find((e) => e.testId === testIdMatch[1]);
      }
      const refMatch = /^\[data-bctrl-ref=["']?([^"'\]]+)["']?\]$/.exec(selector.trim());
      if (refMatch) {
        return this.elements.find((e) => e.ref === refMatch[1]);
      }
      return this.elements.find((e) => e.selector === selector || e.tag === selector.trim().toLowerCase());
    }
    return undefined;
  }

  async goto(url: string): Promise<BrowserSnapshotDto> {
    if (this.closed) throw new ApiError(410, 'headless_session_closed', 'Headless session is closed');
    try {
      const html = await this.fetchHtml(url);
      this.parseHtmlIntoState(html);
      return this.buildSnapshot();
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(
        502,
        'navigation_failed',
        err instanceof Error ? err.message : `Failed to load ${url}`,
      );
    }
  }

  async snapshot(): Promise<BrowserSnapshotDto> {
    if (this.closed) throw new ApiError(410, 'headless_session_closed', 'Headless session is closed');
    return this.buildSnapshot();
  }

  async performAction(req: BrowserCommandRequest): Promise<{
    snapshot: BrowserSnapshotDto;
    screenshotDataUrl?: string;
    data?: Record<string, unknown>;
  }> {
    if (this.closed) throw new ApiError(410, 'headless_session_closed', 'Headless session is closed');
    const action = normalizeActionKind(req.action);

    switch (action) {
      case 'snapshot':
        return { snapshot: this.buildSnapshot() };

      case 'navigate': {
        if (!req.url) throw new ApiError(400, 'missing_url', 'Action "navigate" requires url');
        const snap = await this.goto(req.url);
        return { snapshot: snap };
      }

      case 'click': {
        const el = this.findElement(req.ref, req.selector);
        if (!el) {
          throw new ApiError(404, 'element_not_found', `Element ${req.ref ?? req.selector ?? ''} not found`);
        }
        el.clickCount += 1;
        this.lastClickedRef = el.ref;
        if (el.href && !el.href.startsWith('#') && !el.href.startsWith('javascript:')) {
          try {
            const resolved = new URL(el.href, this.currentUrl).toString();
            const snap = await this.goto(resolved);
            return { snapshot: snap, data: { clicked_ref: el.ref, navigated_to: resolved } };
          } catch {
            // Keep current page if relative resolution fails on data:/about: URLs
          }
        }
        return {
          snapshot: this.buildSnapshot(),
          data: { clicked_ref: el.ref, click_count: el.clickCount },
        };
      }

      case 'fill':
      case 'select': {
        const el = this.findElement(req.ref, req.selector);
        if (!el) {
          throw new ApiError(404, 'element_not_found', `Element ${req.ref ?? req.selector ?? ''} not found`);
        }
        const val = req.text ?? '';
        el.value = val;
        if (el.tag === 'select') {
          el.text = val;
        }
        return {
          snapshot: this.buildSnapshot(),
          data: { updated_ref: el.ref, value: val },
        };
      }

      case 'press': {
        this.lastKeyPressed = req.key ?? 'Enter';
        return {
          snapshot: this.buildSnapshot(),
          data: { key: this.lastKeyPressed },
        };
      }

      case 'hover': {
        const el = this.findElement(req.ref, req.selector);
        if (!el) {
          throw new ApiError(404, 'element_not_found', `Element ${req.ref ?? req.selector ?? ''} not found`);
        }
        return {
          snapshot: this.buildSnapshot(),
          data: { hovered_ref: el.ref },
        };
      }

      case 'scroll': {
        this.scrollY = Math.max(0, this.scrollY + (req.delta_y ?? 320));
        return {
          snapshot: this.buildSnapshot(),
          data: { scroll_y: this.scrollY },
        };
      }

      case 'evaluate_query': {
        const expr = (req.text ?? '').trim();
        let value: unknown = this.currentTitle;
        if (expr === 'document.title') value = this.currentTitle;
        else if (expr === 'location.href' || expr === 'window.location.href') value = this.currentUrl;
        else if (expr === 'window.scrollY') value = this.scrollY;
        else if (expr === 'document.body.innerText') value = this.textExcerpt;
        else {
          value = {
            title: this.currentTitle,
            url: this.currentUrl,
            elements_count: this.elements.length,
            scroll_y: this.scrollY,
            last_clicked_ref: this.lastClickedRef,
            last_key: this.lastKeyPressed,
          };
        }
        return {
          snapshot: this.buildSnapshot(),
          data: { expression: expr, value },
        };
      }

      case 'screenshot': {
        const shot = await this.screenshot();
        return {
          snapshot: this.buildSnapshot(),
          screenshotDataUrl: shot.dataUrl,
          data: { mime_type: shot.mimeType },
        };
      }

      case 'app_action': {
        return {
          snapshot: this.buildSnapshot(),
          data: { app_action: req.app_action ?? 'noop', ok: true },
        };
      }
    }
  }

  async screenshot(): Promise<{ dataUrl: string; mimeType: string }> {
    if (this.closed) throw new ApiError(410, 'headless_session_closed', 'Headless session is closed');
    const w = this.viewport.width;
    const h = this.viewport.height;
    const elemRows = this.elements
      .slice(0, 8)
      .map((el, i) => {
        const y = 152 + i * 40;
        const label = `[${el.ref}] <${el.tag}> ${el.text || ''}${el.value ? ` = "${el.value}"` : ''}`;
        return `<g transform="translate(28, ${y})">
          <rect width="${Math.min(w - 56, 680)}" height="30" rx="6" fill="#1e293b" stroke="#334155" />
          <text x="12" y="20" fill="#e2e8f0" font-family="monospace" font-size="13">${escapeXml(label.slice(0, 88))}</text>
        </g>`;
      })
      .join('\n');

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <rect width="${w}" height="${h}" fill="#0f172a" />
      <rect width="${w}" height="44" fill="#1e293b" />
      <circle cx="20" cy="22" r="6" fill="#ef4444" />
      <circle cx="40" cy="22" r="6" fill="#f59e0b" />
      <circle cx="60" cy="22" r="6" fill="#10b981" />
      <rect x="84" y="9" width="${Math.max(200, w - 110)}" height="26" rx="6" fill="#0f172a" />
      <text x="96" y="27" fill="#94a3b8" font-family="monospace" font-size="12">${escapeXml(this.currentUrl.slice(0, 110))}</text>
      <text x="28" y="84" fill="#f8fafc" font-family="sans-serif" font-size="22" font-weight="bold">${escapeXml(this.currentTitle.slice(0, 80))}</text>
      <text x="28" y="116" fill="#94a3b8" font-family="sans-serif" font-size="14">${escapeXml(this.textExcerpt.slice(0, 115))}</text>
      ${elemRows}
    </svg>`;

    return {
      dataUrl: `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`,
      mimeType: 'image/svg+xml',
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  killFastSync(): void {
    this.closed = true;
  }
}

// ============================================================================
// Real Chromium Headless CDP Driver (`/usr/lib/chromium/chromium`)
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

  private constructor(
    private readonly sessionId: string,
    private readonly viewport: { width: number; height: number },
  ) {}

  static async launch(
    sessionId: string,
    viewport: { width: number; height: number },
  ): Promise<ChromiumCdpDriver> {
    const driver = new ChromiumCdpDriver(sessionId, viewport);
    await driver.initProcessAndConnect();
    return driver;
  }

  private async initProcessAndConnect(): Promise<void> {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpui-bctrl-cdp-'));
    this.userDataDir = userDataDir;

    const proc = spawn(
      CHROMIUM_BINARY_PATH,
      [
        '--headless',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
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
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.proc = proc;

    const debugPort = await new Promise<number>((resolve, reject) => {
      let stderrBuf = '';
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for Chromium DevTools port. Stderr: ${stderrBuf.slice(-300)}`));
      }, 15000);

      const onData = (chunk: Buffer) => {
        stderrBuf += chunk.toString('utf8');
        const m = /DevTools listening on ws:\/\/(?:\[::1\]|127\.0\.0\.1|localhost):(\d+)\//.exec(stderrBuf);
        if (m) {
          clearTimeout(timer);
          proc.stderr?.off('data', onData);
          resolve(Number(m[1]));
        }
      };

      proc.stderr?.on('data', onData);
      proc.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Chromium exited prematurely with code ${code}: ${stderrBuf.slice(-300)}`));
      });
    });

    // Discover the primary 'page' target from /json/list over direct loopback HTTP
    let pageWsUrl: string | null = null;
    for (let attempt = 0; attempt < 15; attempt++) {
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
      } catch {
        // Retry briefly while DevTools target initializes
      }
      await new Promise((r) => setTimeout(r, 75));
    }

    if (!pageWsUrl) {
      await this.close();
      throw new Error('Failed to locate page webSocketDebuggerUrl from Chromium /json/list');
    }

    const ws = new WebSocket(pageWsUrl);
    this.cdpWs = ws;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting to CDP WebSocket')), 4000);
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

      case 'app_action': {
        return {
          snapshot: await this.snapshot(),
          data: { app_action: req.app_action ?? 'noop', ok: true },
        };
      }
    }
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
    for (const [, pending] of this.pendingCdp) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Headless session terminated'));
    }
    this.pendingCdp.clear();
    if (this.cdpWs && this.cdpWs.readyState === WebSocket.OPEN) {
      try {
        this.cdpWs.send(JSON.stringify({ id: 999999, method: 'Browser.close', params: {} }));
      } catch {
        // Ignore
      }
    }
    const wsRef = this.cdpWs;
    this.cdpWs = null;
    const proc = this.proc;
    this.proc = null;
    const dir = this.userDataDir;
    this.userDataDir = null;

    if (proc) {
      try {
        proc.kill('SIGTERM');
      } catch {
        // Ignore
      }
      const fallbackKill = setTimeout(() => {
        try {
          wsRef?.terminate();
        } catch {
          // Ignore
        }
        if (proc.exitCode === null && proc.signalCode === null) {
          try {
            proc.kill('SIGKILL');
          } catch {
            // Ignore
          }
        }
        if (dir) {
          void fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      }, 350);
      fallbackKill.unref?.();
      proc.once('exit', () => {
        clearTimeout(fallbackKill);
        try {
          wsRef?.close();
        } catch {
          // Ignore
        }
        if (dir) {
          void fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      });
    } else if (dir) {
      void fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

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
        const killTimer = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            // Ignore
          }
          resolve();
        }, 700);
        killTimer.unref?.();
        proc.once('exit', () => {
          clearTimeout(killTimer);
          resolve();
        });
        try {
          proc.kill('SIGTERM');
        } catch {
          clearTimeout(killTimer);
          resolve();
        }
      });
    }

    if (this.cdpWs) {
      try {
        this.cdpWs.close();
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
  private readonly userGenerations = new Map<number, number>();
  private readonly desktopTokens = new Map<string, DesktopTokenRecord>();
  private readonly pairingTickets = new Map<string, PairingTicketRecord>();
  private readonly liveTabs = new Map<string, LiveTabRecord>();
  private readonly socketToTargetIds = new Map<WebSocket, Set<string>>();
  private readonly controllerSockets = new Set<ControllerWsClient>();
  private readonly pendingCommands = new Map<string, PendingBrowserCommand>();
  private readonly headlessSessions = new Map<string, ManagedHeadlessSession>();
  private readonly auditLogsByUser = new Map<number, BrowserAuditLogEntry[]>();

  constructor(private readonly db: DatabaseSync) {
    activeBridges.add(this);
  }

  getGeneration(userId: number): number {
    const cur = this.userGenerations.get(userId);
    if (cur !== undefined) return cur;
    this.userGenerations.set(userId, 1);
    return 1;
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
    let list = this.auditLogsByUser.get(userId);
    if (!list) {
      list = [];
      this.auditLogsByUser.set(userId, list);
    }
    list.unshift(full);
    if (list.length > 250) {
      list.length = 250;
    }
    return full;
  }

  listAuditLogs(userId: number, limit = 50): BrowserAuditLogEntry[] {
    const clamped = Math.max(1, Math.min(200, limit));
    return (this.auditLogsByUser.get(userId) ?? []).slice(0, clamped);
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
      const rec = this.desktopTokens.get(rawToken);
      if (!rec || rec.revoked || rec.expiresAtMs <= Date.now()) {
        return null;
      }
      return {
        userId: rec.userId,
        callerKind: 'desktop_controller',
        callerLabel: rec.label,
        rawToken,
        generation: this.getGeneration(rec.userId),
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
  // Desktop Pairing (`pair/create` & `pair/claim`)
  // ==========================================================================

  createPairingTicket(
    userId: number,
    baseUrl: string,
    opts: { label?: string; ttlSecs?: number } = {},
  ): DesktopPairingTicketDto {
    const ttlMs = Math.max(10_000, Math.min(86_400_000, (opts.ttlSecs ?? 600) * 1000));
    const now = Date.now();
    const expiresAtMs = now + ttlMs;
    let pairCode = randomPairCode(6);
    while (this.pairingTickets.has(pairCode)) {
      pairCode = randomPairCode(6);
    }
    const desktopToken = `bctrl_${crypto.randomBytes(20).toString('hex')}`;
    const label = opts.label?.trim() || 'GPUI Desktop Bridge';
    const gen = this.getGeneration(userId);

    const wsBase = baseUrl.replace(/^http/i, 'ws');
    const ticket: PairingTicketRecord = {
      pairCode,
      desktopToken,
      userId,
      label,
      expiresAtMs,
      claimed: false,
      httpBaseUrl: baseUrl,
      wsBridgeUrl: `${wsBase}/api/v1/browser/ws`,
      mcpRpcUrl: `${baseUrl}/api/v1/mcp/rpc`,
    };
    this.pairingTickets.set(pairCode, ticket);

    // Activate token bound to current userId + control_generation
    this.desktopTokens.set(desktopToken, {
      desktopToken,
      userId,
      label,
      issuedGeneration: gen,
      expiresAtMs: now + 30 * 86_400_000,
      revoked: false,
      createdAtMs: now,
    });

    this.recordAudit(userId, {
      target_id: 'pairing',
      caller: `user:${userId}`,
      action: 'pair_create',
      status: 'ok',
      summary: `Issued desktop pairing code ${pairCode}`,
      latency_ms: 0,
    });

    return {
      pair_code: ticket.pairCode,
      desktop_token: ticket.desktopToken,
      expires_at_ms: ticket.expiresAtMs,
      http_base_url: ticket.httpBaseUrl,
      ws_bridge_url: ticket.wsBridgeUrl,
      mcp_rpc_url: ticket.mcpRpcUrl,
    };
  }

  claimPairingTicket(
    rawPairCode: string,
    controllerLabel?: string,
    overrideBaseUrl?: string,
  ): DesktopPairingTicketDto {
    const code = rawPairCode.trim().toUpperCase();
    if (!code) {
      throw new ApiError(400, 'missing_pair_code', 'pair_code is required');
    }
    const ticket = this.pairingTickets.get(code);
    if (!ticket) {
      throw new ApiError(404, 'invalid_pair_code', 'Invalid or unknown desktop pairing code');
    }
    const now = Date.now();
    if (ticket.expiresAtMs <= now) {
      this.pairingTickets.delete(code);
      throw new ApiError(410, 'pair_code_expired', 'Desktop pairing code has expired');
    }
    if (ticket.claimed) {
      throw new ApiError(409, 'pair_code_already_claimed', 'Desktop pairing code has already been claimed');
    }

    const tokenRec = this.desktopTokens.get(ticket.desktopToken);
    if (!tokenRec || tokenRec.revoked) {
      throw new ApiError(401, 'pairing_revoked', 'Desktop pairing ticket was revoked by user');
    }

    ticket.claimed = true;
    if (controllerLabel?.trim()) {
      ticket.label = controllerLabel.trim();
      tokenRec.label = controllerLabel.trim();
    }
    tokenRec.expiresAtMs = now + 30 * 86_400_000;

    // Update active_controller hint on user's live tabs
    for (const [, tab] of this.liveTabs) {
      if (tab.descriptor.user_id === ticket.userId && tab.descriptor.allow_remote_control) {
        tab.descriptor.active_controller = tokenRec.label;
      }
    }

    this.recordAudit(ticket.userId, {
      target_id: 'pairing',
      caller: tokenRec.label,
      action: 'pair_claim',
      status: 'ok',
      summary: `Desktop controller "${tokenRec.label}" claimed pairing code ${code}`,
      latency_ms: 0,
    });
    this.broadcastTargetsUpdated(ticket.userId);

    const httpBase = overrideBaseUrl ?? ticket.httpBaseUrl;
    const wsBase = httpBase.replace(/^http/i, 'ws');
    return {
      pair_code: ticket.pairCode,
      desktop_token: ticket.desktopToken,
      expires_at_ms: tokenRec.expiresAtMs,
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
    const now = Date.now();
    const targetId =
      payload.target_id?.trim() || `tab_${userId}_${crypto.randomBytes(4).toString('hex')}`;
    const existing = this.liveTabs.get(targetId);
    if (existing && existing.descriptor.user_id !== userId) {
      throw new ApiError(403, 'forbidden_target', 'Target ID belongs to a different user');
    }

    const gen = this.getGeneration(userId);
    const descriptor: BrowserTargetDescriptor = {
      target_id: targetId,
      user_id: userId,
      kind: 'live_web_tab',
      title: payload.title || existing?.descriptor.title || 'GPUI Telegram Web',
      url: payload.url || existing?.descriptor.url || 'http://localhost/',
      viewport: payload.viewport ?? existing?.descriptor.viewport ?? { width: 1280, height: 800 },
      theme: payload.theme ?? existing?.descriptor.theme,
      active_chat_id:
        payload.active_chat_id !== undefined
          ? payload.active_chat_id
          : existing?.descriptor.active_chat_id ?? null,
      active_nav_dest: payload.active_nav_dest ?? existing?.descriptor.active_nav_dest,
      connected_at_ms: existing?.descriptor.connected_at_ms ?? now,
      last_heartbeat_ms: now,
      allow_remote_control:
        payload.allow_remote_control !== undefined
          ? Boolean(payload.allow_remote_control)
          : existing?.descriptor.allow_remote_control ?? true,
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
    const rec = this.liveTabs.get(payload.target_id);
    if (!rec || rec.descriptor.user_id !== userId) {
      throw new ApiError(404, 'browser_target_not_found', `Browser tab "${payload.target_id}" not found`);
    }

    const d = rec.descriptor;
    if (payload.title !== undefined) d.title = payload.title;
    if (payload.url !== undefined) d.url = payload.url;
    if (payload.viewport !== undefined) d.viewport = payload.viewport;
    if (payload.theme !== undefined) d.theme = payload.theme;
    if (payload.active_chat_id !== undefined) d.active_chat_id = payload.active_chat_id;
    if (payload.active_nav_dest !== undefined) d.active_nav_dest = payload.active_nav_dest;
    if (payload.allow_remote_control !== undefined) {
      d.allow_remote_control = Boolean(payload.allow_remote_control);
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
    const userId = auth.userId;
    const action = normalizeActionKind(rawReq.action);
    const callerLabel = rawReq.caller_label?.trim() || auth.callerLabel;
    const startGen = this.getGeneration(userId);
    const t0 = performance.now();

    if (rawReq.expected_generation !== undefined && rawReq.expected_generation !== startGen) {
      this.recordAudit(userId, {
        target_id: rawReq.target_id ?? 'unknown',
        caller: callerLabel,
        action,
        status: 'revoked',
        summary: `Rejected stale command generation ${rawReq.expected_generation} (current ${startGen})`,
        latency_ms: 0,
      });
      throw new ApiError(
        409,
        'control_generation_mismatch',
        `Expected control_generation ${rawReq.expected_generation}, current is ${startGen}`,
      );
    }

    // Resolve target: explicit target_id -> live tab OR headless session; omitted -> most recent live tab OR headless
    let liveTab: LiveTabRecord | undefined;
    let headless: ManagedHeadlessSession | undefined;

    if (rawReq.target_id) {
      const lt = this.liveTabs.get(rawReq.target_id);
      if (lt) {
        if (lt.descriptor.user_id !== userId) {
          throw new ApiError(403, 'forbidden_target', 'Browser target belongs to another user');
        }
        liveTab = lt;
      } else {
        const hs = this.headlessSessions.get(rawReq.target_id);
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
        caller_label: callerLabel,
      });
    }

    if (!liveTab) {
      throw new ApiError(
        404,
        'browser_target_not_found',
        rawReq.target_id
          ? `Browser target "${rawReq.target_id}" not found`
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

    const commandId = rawReq.command_id?.trim() || `bcmd_${crypto.randomBytes(6).toString('hex')}`;
    const timeoutMs = Math.max(100, Math.min(30_000, rawReq.timeout_ms ?? 8000));

    liveTab.descriptor.active_controller = callerLabel;
    liveTab.descriptor.control_generation = startGen;

    const commandPayload = {
      ...rawReq,
      action,
      command_id: commandId,
      target_id: targetId,
      generation: startGen,
      caller_label: callerLabel,
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
    const pending = this.pendingCommands.get(incoming.command_id);
    if (!pending || pending.userId !== userId) {
      return false;
    }

    clearTimeout(pending.timer);
    this.pendingCommands.delete(incoming.command_id);

    const currentGen = this.getGeneration(userId);
    if (
      currentGen !== pending.generation ||
      (typeof incoming.generation === 'number' && incoming.generation !== pending.generation)
    ) {
      this.recordAudit(userId, {
        target_id: pending.targetId,
        caller: pending.callerLabel,
        action: pending.action,
        status: 'revoked',
        summary: `Fenced stale BrowserCommandResult (cmd gen ${incoming.generation ?? pending.generation} vs current ${currentGen})`,
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
      action: incoming.action ?? pending.action,
      snapshot: incoming.snapshot,
      screenshot_data_url: incoming.screenshot_data_url,
      data: incoming.data,
      error: incoming.error,
      latency_ms: typeof incoming.latency_ms === 'number' && incoming.latency_ms >= 0 ? incoming.latency_ms : latencyMs,
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
      targetId?: string;
      revokeTokens?: boolean;
      disableRemoteControl?: boolean;
      reason?: string;
    } = {},
  ): BrowserControlRevokeResponse & { latency_sub_10ms: boolean } {
    const startHr = process.hrtime.bigint();
    const nextGen = this.getGeneration(userId) + 1;
    this.userGenerations.set(userId, nextGen);

    let revokedTokensCount = 0;
    if (opts.revokeTokens !== false) {
      for (const [, rec] of this.desktopTokens) {
        if (rec.userId === userId && !rec.revoked) {
          rec.revoked = true;
          revokedTokensCount += 1;
        }
      }
      for (const [, ticket] of this.pairingTickets) {
        if (ticket.userId === userId) {
          this.pairingTickets.delete(ticket.pairCode);
        }
      }
    }

    for (const [, tab] of this.liveTabs) {
      if (tab.descriptor.user_id === userId && (!opts.targetId || tab.descriptor.target_id === opts.targetId)) {
        tab.descriptor.control_generation = nextGen;
        tab.descriptor.active_controller = null;
        tab.queuedCommands.length = 0;
        if (opts.disableRemoteControl) {
          tab.descriptor.allow_remote_control = false;
        }
      }
    }

    let abortedCommandsCount = 0;
    for (const [cmdId, pending] of this.pendingCommands) {
      if (pending.userId === userId && (!opts.targetId || pending.targetId === opts.targetId)) {
        clearTimeout(pending.timer);
        this.pendingCommands.delete(cmdId);
        abortedCommandsCount += 1;
        this.recordAudit(userId, {
          target_id: pending.targetId,
          caller: pending.callerLabel,
          action: pending.action,
          status: 'revoked',
          summary: `Aborted in-flight "${pending.action}" via <10ms emergency user revoke (gen #${nextGen})`,
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
        target_id: opts.targetId,
        control_generation: nextGen,
        reason: opts.reason ?? 'control_revoked_by_user',
        timestamp_ms: Date.now(),
      },
    };
    this.broadcastToUserBrowserPeers(userId, revokedFrame);

    if (opts.revokeTokens !== false) {
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
      target_id: opts.targetId ?? 'all_targets',
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
  // Headless Browser Automation Engine (`chromium_cdp` + `http_dom_fallback`)
  // ==========================================================================

  async openHeadlessSession(
    auth: BrowserCallerAuth,
    opts: {
      url?: string;
      viewport?: { width?: number; height?: number };
      preferFallback?: boolean;
      backend?: 'chromium_cdp' | 'http_dom_fallback';
    } = {},
  ): Promise<{ session: HeadlessBrowserSessionDto; snapshot: BrowserSnapshotDto }> {
    const t0 = performance.now();
    const width = Math.max(320, Math.min(3840, Number(opts.viewport?.width ?? 1280)));
    const height = Math.max(240, Math.min(2160, Number(opts.viewport?.height ?? 800)));
    const initialUrl = opts.url ? validateHeadlessUrl(opts.url) : 'about:blank';
    const sessionId = `hbs_${crypto.randomBytes(6).toString('hex')}`;

    const useCdp =
      !opts.preferFallback &&
      opts.backend !== 'http_dom_fallback' &&
      isChromiumBinaryAvailable();

    let driver: HeadlessDriver;
    if (useCdp) {
      try {
        driver = await ChromiumCdpDriver.launch(sessionId, { width, height });
      } catch (err) {
        if (opts.backend === 'chromium_cdp') {
          throw new ApiError(
            500,
            'chromium_launch_failed',
            err instanceof Error ? err.message : 'Failed to launch headless Chromium',
          );
        }
        driver = new HttpDomFallbackDriver(sessionId, { width, height });
      }
    } else {
      driver = new HttpDomFallbackDriver(sessionId, { width, height });
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
    const managed = this.requireHeadlessSession(auth.userId, sessionId);
    const t0 = performance.now();
    const action = normalizeActionKind(rawReq.action);
    const commandId = rawReq.command_id?.trim() || `hcmd_${crypto.randomBytes(6).toString('hex')}`;
    const gen = this.getGeneration(auth.userId);

    try {
      const outcome = await managed.driver.performAction({ ...rawReq, action });
      managed.latestSnapshot = outcome.snapshot;
      managed.dto.url = outcome.snapshot.url;
      managed.dto.title = outcome.snapshot.title;
      managed.dto.updated_at_ms = Date.now();

      const latencyMs = Math.max(0, Math.round(performance.now() - t0));
      const res: BrowserCommandResult = {
        ok: true,
        command_id: commandId,
        target_id: sessionId,
        generation: gen,
        action,
        snapshot: outcome.snapshot,
        screenshot_data_url: outcome.screenshotDataUrl,
        data: outcome.data,
        latency_ms: latencyMs,
      };

      this.recordAudit(auth.userId, {
        target_id: sessionId,
        caller: rawReq.caller_label || auth.callerLabel,
        action: `headless_${action}`,
        status: 'ok',
        summary: `Executed ${action} on ${sessionId} (${managed.dto.backend})`,
        latency_ms: latencyMs,
      });

      return res;
    } catch (err) {
      const latencyMs = Math.max(0, Math.round(performance.now() - t0));
      this.recordAudit(auth.userId, {
        target_id: sessionId,
        caller: rawReq.caller_label || auth.callerLabel,
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
          url: typeof args.url === 'string' ? args.url : undefined,
          viewport: {
            width: typeof args.width === 'number' ? args.width : undefined,
            height: typeof args.height === 'number' ? args.height : undefined,
          },
          preferFallback: Boolean(args.prefer_fallback),
        });
        return { result: opened as unknown as Record<string, unknown> };
      }

      case 'browser_headless_action': {
        const sessionId = String(args.session_id ?? '');
        if (!sessionId) {
          throw new ApiError(400, 'missing_session_id', 'session_id is required');
        }
        const actRes = await this.executeHeadlessAction(auth, sessionId, {
          action: String(args.action ?? 'snapshot') as BrowserActionKind,
          ref: typeof args.ref === 'string' ? args.ref : undefined,
          selector: typeof args.selector === 'string' ? args.selector : undefined,
          text: typeof args.text === 'string' ? args.text : undefined,
          key: typeof args.key === 'string' ? args.key : undefined,
          url: typeof args.url === 'string' ? args.url : undefined,
          delta_y: typeof args.delta_y === 'number' ? args.delta_y : undefined,
          caller_label: `MCP:${auth.callerLabel}`,
        });
        return {
          result: actRes as unknown as Record<string, unknown>,
          screenshotDataUrl: actRes.screenshot_data_url,
        };
      }

      case 'browser_headless_screenshot': {
        const sessionId = String(args.session_id ?? '');
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
        const sessionId = String(args.session_id ?? '');
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
              version: '1.2.0',
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
        const params = rpc.params ?? {};
        const name = typeof params.name === 'string' ? params.name : '';
        const toolArgs =
          params.arguments && typeof params.arguments === 'object'
            ? (params.arguments as Record<string, unknown>)
            : {};
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
  // Fast Test Reset & Clean Server Shutdown
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
    this.desktopTokens.clear();
    this.pairingTickets.clear();
    this.userGenerations.clear();
    this.auditLogsByUser.clear();
  }

  async closeAllHeadlessSessions(): Promise<void> {
    const entries = Array.from(this.headlessSessions.values());
    this.headlessSessions.clear();
    await Promise.allSettled(entries.map((e) => e.driver.close()));
  }

  async dispose(): Promise<void> {
    this.resetFastSync();
    await this.closeAllHeadlessSessions();
    activeBridges.delete(this);
  }
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
    const body = await readJsonBody<{ label?: string; ttl_secs?: number }>(ctx.req);
    const ticket = bridge.createPairingTicket(auth.userId, resolveBaseUrl(ctx), {
      label: body.label,
      ttlSecs: body.ttl_secs,
    });
    sendJson(ctx.res, 200, ticket);
  });

  router.post('/api/v1/browser/pair/claim', async (ctx) => {
    const body = await readJsonBody<{
      pair_code?: string;
      controller_label?: string;
      device_name?: string;
    }>(ctx.req);
    const ticket = bridge.claimPairingTicket(
      body.pair_code ?? '',
      body.controller_label ?? body.device_name,
      resolveBaseUrl(ctx),
    );
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
    const waitMs = Number(ctx.query.get('wait_ms') ?? 0);
    const cmd = await bridge.pollNextTabCommand(auth.userId, ctx.params.targetId!, waitMs);
    sendJson(ctx.res, 200, { command: cmd });
  });

  router.post('/api/v1/browser/targets/:targetId/result', async (ctx) => {
    const auth = bridge.requireBrowserAuth(ctx);
    const body = await readJsonBody<BrowserCommandResult>(ctx.req);
    const resolved = bridge.resolveTabCommandResult(auth.userId, {
      ...body,
      target_id: body.target_id ?? ctx.params.targetId!,
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
      target_id?: string;
      revoke_tokens?: boolean;
      disable_remote_control?: boolean;
      reason?: string;
    }>(ctx.req);
    const res = bridge.revokeControl(auth.userId, {
      targetId: body.target_id,
      revokeTokens: body.revoke_tokens,
      disableRemoteControl: body.disable_remote_control,
      reason: body.reason,
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
      url?: string;
      viewport?: { width?: number; height?: number };
      width?: number;
      height?: number;
      prefer_fallback?: boolean;
      backend?: 'chromium_cdp' | 'http_dom_fallback';
    }>(ctx.req);
    const opened = await bridge.openHeadlessSession(auth, {
      url: body.url,
      viewport: body.viewport ?? { width: body.width, height: body.height },
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
      BrowserCommandRequest & { session_id?: string; expression?: string; value?: string }
    >(ctx.req);
    const sessionId = ctx.params.sessionId ?? body.session_id ?? '';
    if (!sessionId) {
      throw new ApiError(400, 'missing_session_id', 'session_id is required');
    }
    const res = await bridge.executeHeadlessAction(auth, sessionId, {
      ...body,
      text: body.text ?? body.value ?? body.expression,
    });
    sendJson(ctx.res, 200, res);
  };
  router.post('/api/v1/browser/headless/:sessionId/action', handleHeadlessAction);
  router.post('/api/v1/browser/headless/action', handleHeadlessAction);

  const handleHeadlessScreenshot = async (ctx: RequestContext): Promise<void> => {
    const auth = bridge.requireBrowserAuth(ctx);
    const body =
      ctx.method === 'POST' ? await readJsonBody<{ session_id?: string }>(ctx.req) : {};
    const sessionId = ctx.params.sessionId ?? body.session_id ?? '';
    if (!sessionId) {
      throw new ApiError(400, 'missing_session_id', 'session_id is required');
    }
    const shot = await bridge.captureHeadlessScreenshot(auth, sessionId);
    sendJson(ctx.res, 200, shot);
  };
  router.get('/api/v1/browser/headless/:sessionId/screenshot', handleHeadlessScreenshot);
  router.post('/api/v1/browser/headless/:sessionId/screenshot', handleHeadlessScreenshot);
  router.post('/api/v1/browser/headless/screenshot', handleHeadlessScreenshot);

  const handleHeadlessClose = async (ctx: RequestContext): Promise<void> => {
    const auth = bridge.requireBrowserAuth(ctx);
    const body =
      ctx.method === 'POST' ? await readJsonBody<{ session_id?: string }>(ctx.req) : {};
    const sessionId = ctx.params.sessionId ?? body.session_id ?? '';
    if (!sessionId) {
      throw new ApiError(400, 'missing_session_id', 'session_id is required');
    }
    const closed = await bridge.closeHeadlessSession(auth, sessionId);
    sendJson(ctx.res, 200, closed);
  };
  router.post('/api/v1/browser/headless/:sessionId/close', handleHeadlessClose);
  router.delete('/api/v1/browser/headless/:sessionId', handleHeadlessClose);
  router.post('/api/v1/browser/headless/close', handleHeadlessClose);

  // 5. MCP JSON-RPC 2.0 Server (`/api/v1/mcp/manifest` & `/api/v1/mcp/rpc`)
  router.get('/api/v1/mcp/manifest', (ctx) => {
    const baseUrl = resolveBaseUrl(ctx);
    sendJson(ctx.res, 200, {
      name: 'gpui-telegram-web-browser-bridge',
      version: '1.2.0',
      protocolVersion: '2024-11-05',
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

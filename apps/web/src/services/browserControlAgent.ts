import type {
  BrowserActionKind,
  BrowserCommandRequest,
  BrowserCommandResult,
  BrowserElementRef,
  BrowserRegisterPayload,
  BrowserSnapshotDto,
  BrowserStateReportPayload,
} from '@gpui-telegram/protocol';

export const BROWSER_CONTROL_CHANNEL_NAME = 'gpui-telegram-browser-control';

export type BrowserCommandInput = Partial<BrowserCommandRequest> & {
  action: BrowserActionKind;
  commandId?: string;
  targetId?: string;
  value?: string;
  deltaX?: number;
  deltaY?: number;
  appAction?: string;
  payload?: Record<string, unknown>;
  expectedGeneration?: number;
};

export interface LocalBrowserAuditEntry {
  id: string;
  timestampMs: number;
  source: 'window' | 'broadcast' | 'ws' | 'ui' | 'takeover';
  action: string;
  target: string;
  ok: boolean;
  durationMs: number;
  detail?: string;
}

export type BrowserAppActionHandler = (
  appAction: string,
  payload?: Record<string, unknown>,
) => Promise<Record<string, unknown> | unknown> | Record<string, unknown> | unknown;

export interface BrowserBridgePublicApi {
  readonly version: '1.0.0';
  readonly targetId: string;
  captureSnapshot(): BrowserSnapshotDto;
  executeCommand(
    cmd: BrowserCommandInput,
    source?: LocalBrowserAuditEntry['source'],
  ): Promise<BrowserCommandResult>;
  emergencyTakeover(reason?: string): {
    revoked: true;
    controlGeneration: number;
    elapsedMs: number;
  };
  setAllowDesktopControl(allowed: boolean): void;
  getState(): {
    targetId: string;
    allowDesktopControl: boolean;
    controlGeneration: number;
    isRemoteActive: boolean;
    auditLogs: LocalBrowserAuditEntry[];
  };
  subscribe(listener: () => void): () => void;
}

declare global {
  interface Window {
    __GPUI_TELEGRAM_BROWSER_BRIDGE__?: BrowserBridgePublicApi;
  }
}

const INTERACTIVE_QUERY = [
  'button',
  'a[href]',
  'input',
  'textarea',
  'select',
  '[role="button"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[data-testid="chat-row"]',
  '[data-testid="message-bubble"]',
].join(', ');

/**
 * Sets value on `<input>` / `<textarea>` / `<select>` via native HTML prototype descriptor
 * so React 19 internal `_valueTracker` detects the change on `'input'` / `'change'` events!
 */
export function setReactCompatibleFormValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  nextValue: string,
): void {
  const proto =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;

  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (descriptor && typeof descriptor.set === 'function') {
    descriptor.set.call(element, nextValue);
  } else {
    element.value = nextValue;
  }

  element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
}

function escapeXml(str: string): string {
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

class BrowserControlAgentService {
  private targetId = `tab_${Math.random().toString(36).slice(2, 10)}`;
  private allowDesktopControl = true;
  private isRemoteActive = false;
  private controlGeneration = 1;
  private auditLogs: LocalBrowserAuditEntry[] = [];
  private listeners = new Set<() => void>();
  private channel: BroadcastChannel | null = null;
  private wsReplySender: ((result: BrowserCommandResult) => void) | null = null;
  private appActionHandler: BrowserAppActionHandler | null = null;
  private contextProvider: (() => {
    activeChatId: number | null;
    activeNavDest: string | undefined;
  }) | null = null;
  private initialized = false;

  public getTargetId(): string {
    return this.targetId;
  }

  public setTargetId(nextId: string): void {
    if (nextId) {
      this.targetId = nextId;
    }
  }

  public setControlGeneration(gen: number): void {
    if (Number.isFinite(gen) && gen > this.controlGeneration) {
      this.controlGeneration = gen;
      this.isRemoteActive = false;
      this.notify();
    }
  }

  public initialize(): BrowserBridgePublicApi {
    if (this.initialized && typeof window !== 'undefined' && window.__GPUI_TELEGRAM_BROWSER_BRIDGE__) {
      return window.__GPUI_TELEGRAM_BROWSER_BRIDGE__;
    }
    this.initialized = true;

    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.channel = new BroadcastChannel(BROWSER_CONTROL_CHANNEL_NAME);
        this.channel.onmessage = (ev: MessageEvent) => {
          const msg = ev.data as {
            type?: string;
            command?: BrowserCommandInput;
            payload?: BrowserCommandInput;
          } | null;
          const cmd = msg?.command ?? msg?.payload;
          if (msg && msg.type === 'BrowserCommand' && cmd) {
            void this.executeCommand(cmd, 'broadcast').then((result) => {
              try {
                this.channel?.postMessage({
                  type: 'BrowserCommandResult',
                  result,
                  payload: result,
                });
              } catch {
                // Ignore closed channel
              }
            });
          }
        };
      } catch {
        this.channel = null;
      }
    }

    if (typeof window !== 'undefined') {
      window.addEventListener(
        'keydown',
        (ev: KeyboardEvent) => {
          if (ev.key === 'Escape' && this.isRemoteActive) {
            this.emergencyTakeover('escape_hotkey');
          }
        },
        { capture: true },
      );
    }

    const publicApi: BrowserBridgePublicApi = {
      version: '1.0.0',
      get targetId() {
        return browserControlAgent.getTargetId();
      },
      captureSnapshot: () => this.captureSnapshot(),
      executeCommand: (cmd, source = 'window') => this.executeCommand(cmd, source),
      emergencyTakeover: (reason) => this.emergencyTakeover(reason),
      setAllowDesktopControl: (allowed) => this.setAllowDesktopControl(allowed),
      getState: () => this.getState(),
      subscribe: (listener) => this.subscribe(listener),
    };

    if (typeof window !== 'undefined') {
      window.__GPUI_TELEGRAM_BROWSER_BRIDGE__ = publicApi;
    }

    return publicApi;
  }

  public setAppActionHandler(handler: BrowserAppActionHandler | null): void {
    this.appActionHandler = handler;
  }

  public setContextProvider(
    provider: (() => { activeChatId: number | null; activeNavDest: string | undefined }) | null,
  ): void {
    this.contextProvider = provider;
  }

  public setWsReplySender(sender: ((result: BrowserCommandResult) => void) | null): void {
    this.wsReplySender = sender;
  }

  public buildRegisterPayload(): BrowserRegisterPayload {
    const snap = this.captureSnapshot();
    return {
      target_id: this.targetId,
      title: snap.title || 'GPUI Telegram Web',
      url: snap.url || 'http://localhost/',
      viewport: snap.viewport,
      theme: snap.theme,
      active_chat_id: snap.active_chat_id,
      active_nav_dest: snap.active_nav_dest,
      allow_remote_control: this.allowDesktopControl,
      snapshot: snap,
    };
  }

  public buildStateReportPayload(): BrowserStateReportPayload {
    const snap = this.captureSnapshot();
    return {
      target_id: this.targetId,
      title: snap.title,
      url: snap.url,
      viewport: snap.viewport,
      theme: snap.theme,
      active_chat_id: snap.active_chat_id,
      active_nav_dest: snap.active_nav_dest,
      allow_remote_control: this.allowDesktopControl,
      snapshot: snap,
    };
  }

  public async handleIncomingWsCommand(rawPayload: unknown): Promise<BrowserCommandResult | null> {
    if (!rawPayload || typeof rawPayload !== 'object') return null;
    const cmd = rawPayload as BrowserCommandInput & { generation?: number };
    if (!cmd.action) return null;
    if (typeof cmd.generation === 'number' && cmd.generation > this.controlGeneration) {
      this.controlGeneration = cmd.generation;
    }
    const result = await this.executeCommand(cmd, 'ws');
    this.wsReplySender?.(result);
    return result;
  }

  public setAllowDesktopControl(allowed: boolean): void {
    this.allowDesktopControl = allowed;
    if (!allowed) {
      this.isRemoteActive = false;
      this.controlGeneration += 1;
    }
    this.notify();
  }

  public getState(): {
    targetId: string;
    allowDesktopControl: boolean;
    controlGeneration: number;
    isRemoteActive: boolean;
    auditLogs: LocalBrowserAuditEntry[];
  } {
    return {
      targetId: this.targetId,
      allowDesktopControl: this.allowDesktopControl,
      controlGeneration: this.controlGeneration,
      isRemoteActive: this.isRemoteActive,
      auditLogs: [...this.auditLogs],
    };
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        // Ignore subscriber error
      }
    }
  }

  private appendAudit(entry: Omit<LocalBrowserAuditEntry, 'id' | 'timestampMs'>): void {
    this.auditLogs.unshift({
      id: `bctrl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestampMs: Date.now(),
      ...entry,
    });
    if (this.auditLogs.length > 100) {
      this.auditLogs.length = 100;
    }
    this.notify();
  }

  public emergencyTakeover(reason = 'manual_takeover'): {
    revoked: true;
    controlGeneration: number;
    elapsedMs: number;
  } {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.controlGeneration += 1;
    this.isRemoteActive = false;
    const elapsedMs = Number(
      ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0).toFixed(2),
    );
    this.appendAudit({
      source: 'takeover',
      action: 'emergency_takeover',
      target: reason,
      ok: true,
      durationMs: elapsedMs,
      detail: `Control generation fenced to #${this.controlGeneration}`,
    });
    try {
      this.channel?.postMessage({
        type: 'BrowserTakeover',
        controlGeneration: this.controlGeneration,
        reason,
      });
    } catch {
      // Ignore
    }
    return {
      revoked: true,
      controlGeneration: this.controlGeneration,
      elapsedMs,
    };
  }

  public captureSnapshot(): BrowserSnapshotDto {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      return {
        target_id: this.targetId,
        url: '',
        title: '',
        timestamp_ms: Date.now(),
        viewport: { width: 1280, height: 720 },
        theme: 'night',
        active_chat_id: null,
        active_nav_dest: undefined,
        text_excerpt: '',
        elements: [],
      };
    }

    const candidates = Array.from(document.querySelectorAll(INTERACTIVE_QUERY));
    const elements: BrowserElementRef[] = [];
    let refCounter = 0;

    for (const node of candidates) {
      if (!(node instanceof HTMLElement)) continue;
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
        continue;
      }
      const rect = node.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;

      refCounter += 1;
      const ref = `e${refCounter}`;
      node.setAttribute('data-bctrl-ref', ref);

      const isInput =
        node instanceof HTMLInputElement ||
        node instanceof HTMLTextAreaElement ||
        node instanceof HTMLSelectElement;

      const rawText = (
        node.getAttribute('aria-label') ||
        node.innerText ||
        node.textContent ||
        ''
      )
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);

      const selector = node.id
        ? `#${node.id}`
        : node.getAttribute('data-testid')
          ? `[data-testid="${node.getAttribute('data-testid')}"]`
          : `[data-bctrl-ref="${ref}"]`;

      elements.push({
        ref,
        selector,
        tag: node.tagName.toLowerCase(),
        role: node.getAttribute('role') || node.tagName.toLowerCase(),
        text: rawText,
        id: node.id || undefined,
        testId: node.getAttribute('data-testid') || undefined,
        value: isInput
          ? node instanceof HTMLInputElement && node.type === 'password'
            ? '••••••'
            : node.value.slice(0, 120)
          : undefined,
        disabled: 'disabled' in node ? Boolean((node as HTMLButtonElement).disabled) : false,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      });

      if (elements.length >= 250) break;
    }

    const domChatAttr = document
      .querySelector('[data-testid="chat-row"][aria-selected="true"]')
      ?.getAttribute('data-chat-id');
    const fallbackChatId =
      domChatAttr && Number.isFinite(Number(domChatAttr)) ? Number(domChatAttr) : null;

    const ctxInfo = this.contextProvider?.() ?? {
      activeChatId: fallbackChatId,
      activeNavDest:
        document.querySelector('#nav-rail [aria-selected="true"]')?.getAttribute('id') ?? undefined,
    };

    const bodyExcerpt = (document.body?.innerText || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 480);

    return {
      target_id: this.targetId,
      url: window.location.href,
      title: document.title,
      timestamp_ms: Date.now(),
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      theme: document.documentElement.getAttribute('data-theme') || 'night',
      active_chat_id: ctxInfo.activeChatId,
      active_nav_dest: ctxInfo.activeNavDest,
      text_excerpt: bodyExcerpt,
      elements,
    };
  }

  private resolveTargetElement(cmd: BrowserCommandInput): HTMLElement | null {
    if (typeof document === 'undefined') return null;
    if (cmd.ref) {
      const byRef = document.querySelector(`[data-bctrl-ref="${CSS.escape(cmd.ref)}"]`);
      if (byRef instanceof HTMLElement) return byRef;
    }
    if (cmd.selector) {
      const bySel = document.querySelector(cmd.selector);
      if (bySel instanceof HTMLElement) return bySel;
    }
    return null;
  }

  private renderViewportScreenshotDataUrl(snap: BrowserSnapshotDto): string {
    const w = Math.max(320, Math.min(1440, snap.viewport.width || 1280));
    const h = Math.max(240, Math.min(900, snap.viewport.height || 720));
    const isDark = snap.theme === 'night' || snap.theme === 'tinted';
    const bg = isDark ? '#0E1621' : '#F1F3F5';
    const surface = isDark ? '#17212B' : '#FFFFFF';
    const border = isDark ? '#242F3D' : '#CBD5E1';
    const fg = isDark ? '#F5F5F5' : '#111827';

    const boxesSvg = snap.elements
      .slice(0, 48)
      .map((el) => {
        const rect = el.rect ?? { x: 0, y: 0, width: 60, height: 24 };
        const rx = Math.max(0, Math.min(w - 4, rect.x));
        const ry = Math.max(0, Math.min(h - 4, rect.y));
        const rw = Math.max(8, Math.min(w - rx, rect.width));
        const rh = Math.max(8, Math.min(h - ry, rect.height));
        const safeChars = Array.from(el.text || el.id || el.ref).slice(0, 26).join('');
        const label = escapeXml(safeChars);
        return `<g>
          <rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" rx="6" fill="${surface}" stroke="${border}" stroke-width="1" />
          <text x="${rx + 6}" y="${ry + Math.min(16, rh - 3)}" fill="#3390EC" font-family="monospace" font-size="10">[${escapeXml(el.ref)}] ${label}</text>
        </g>`;
      })
      .join('');

    const rawSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <rect width="100%" height="100%" fill="${bg}" />
      ${boxesSvg}
      <rect x="12" y="${h - 34}" width="${Math.min(540, w - 24)}" height="24" rx="6" fill="${surface}" stroke="#3390EC" />
      <text x="20" y="${h - 18}" fill="${fg}" font-family="sans-serif" font-size="11">GPUI Browser Snapshot · Theme=${escapeXml(snap.theme || 'night')} · Refs=${snap.elements.length}</text>
    </svg>`;

    const wellFormedSvg = rawSvg.replace(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
      '\uFFFD',
    );
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(wellFormedSvg)}`;
  }

  public async executeCommand(
    cmd: BrowserCommandInput,
    source: LocalBrowserAuditEntry['source'] = 'window',
  ): Promise<BrowserCommandResult> {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const commandId = cmd.command_id || cmd.commandId || `cmd_${Date.now()}`;
    const targetId = cmd.target_id || cmd.targetId || this.targetId;
    const expectedGen = cmd.expected_generation ?? cmd.expectedGeneration;

    if ((source === 'ws' || source === 'broadcast') && !this.allowDesktopControl) {
      return {
        ok: false,
        command_id: commandId,
        target_id: targetId,
        generation: this.controlGeneration,
        action: cmd.action,
        error: 'Remote browser control is disabled by local operator.',
        latency_ms: 0,
      };
    }

    if (expectedGen !== undefined && expectedGen !== this.controlGeneration) {
      return {
        ok: false,
        command_id: commandId,
        target_id: targetId,
        generation: this.controlGeneration,
        action: cmd.action,
        error: `Stale control generation ${expectedGen} (current: ${this.controlGeneration})`,
        latency_ms: 0,
      };
    }

    if (source === 'ws' || source === 'broadcast') {
      this.isRemoteActive = true;
    }

    try {
      let data: Record<string, unknown> | undefined;
      let screenshotDataUrl: string | undefined;

      switch (cmd.action) {
        case 'snapshot': {
          const snapshot = this.captureSnapshot();
          const latencyMs = Number(
            ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0).toFixed(2),
          );
          this.appendAudit({
            source,
            action: 'snapshot',
            target: `${snapshot.elements.length} refs`,
            ok: true,
            durationMs: latencyMs,
          });
          return {
            ok: true,
            command_id: commandId,
            target_id: targetId,
            generation: this.controlGeneration,
            action: 'snapshot',
            snapshot,
            latency_ms: latencyMs,
          };
        }

        case 'click': {
          const el = this.resolveTargetElement(cmd);
          if (!el) throw new Error(`Target element not found (${cmd.ref || cmd.selector || 'none'})`);
          el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
          el.click();
          data = { clicked: cmd.ref || cmd.selector || el.id };
          break;
        }

        case 'fill': {
          const el = this.resolveTargetElement(cmd);
          const fillText = cmd.text ?? cmd.value ?? '';
          if (
            !(
              el instanceof HTMLInputElement ||
              el instanceof HTMLTextAreaElement ||
              el instanceof HTMLSelectElement
            )
          ) {
            throw new Error(`Target is not a fillable form control (${cmd.ref || cmd.selector || 'none'})`);
          }
          el.focus();
          setReactCompatibleFormValue(el, fillText);
          data = { filled: cmd.ref || cmd.selector || el.id, length: fillText.length };
          break;
        }

        case 'press': {
          const el =
            this.resolveTargetElement(cmd) ||
            (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null);
          const key = cmd.key || 'Enter';
          if (el) {
            el.dispatchEvent(
              new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }),
            );
            el.dispatchEvent(
              new KeyboardEvent('keyup', { key, code: key, bubbles: true, cancelable: true }),
            );
          } else if (typeof window !== 'undefined') {
            window.dispatchEvent(
              new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }),
            );
          }
          data = { pressed: key };
          break;
        }

        case 'hover': {
          const el = this.resolveTargetElement(cmd);
          if (!el) throw new Error(`Hover target not found (${cmd.ref || cmd.selector || 'none'})`);
          el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
          data = { hovered: cmd.ref || cmd.selector || el.id };
          break;
        }

        case 'scroll': {
          const el =
            this.resolveTargetElement(cmd) ||
            (typeof document !== 'undefined'
              ? (document.querySelector('#message-list') as HTMLElement | null) ||
                document.documentElement
              : null);
          const dy = cmd.delta_y ?? cmd.deltaY ?? 320;
          if (el) {
            el.scrollBy({
              left: cmd.deltaX ?? 0,
              top: dy,
              behavior: 'instant' as ScrollBehavior,
            });
          }
          data = { scrolledByY: dy };
          break;
        }

        case 'select': {
          const el = this.resolveTargetElement(cmd);
          const selVal = cmd.text ?? cmd.value ?? '';
          if (!(el instanceof HTMLSelectElement)) {
            throw new Error(`Target is not a <select> element (${cmd.ref || cmd.selector || 'none'})`);
          }
          setReactCompatibleFormValue(el, selVal);
          data = { selected: selVal };
          break;
        }

        case 'navigate': {
          if (cmd.url && typeof window !== 'undefined') {
            if (cmd.url.startsWith('#') || cmd.url.startsWith('/')) {
              window.history.pushState({}, '', cmd.url);
              window.dispatchEvent(new PopStateEvent('popstate'));
            }
          }
          data = { navigatedTo: cmd.url ?? '' };
          break;
        }

        case 'screenshot': {
          const snap = this.captureSnapshot();
          screenshotDataUrl = this.renderViewportScreenshotDataUrl(snap);
          data = { width: snap.viewport.width, height: snap.viewport.height };
          break;
        }

        case 'evaluate_query': {
          const sel = cmd.selector || 'body';
          const matches =
            typeof document !== 'undefined' ? document.querySelectorAll(sel).length : 0;
          data = { selector: sel, count: matches };
          break;
        }

        case 'app_action': {
          if (!this.appActionHandler) {
            throw new Error('No app_action handler registered yet');
          }
          const actionName = cmd.app_action || cmd.appAction || '';
          const actionPayload = cmd.app_payload || cmd.payload;
          const rawRes = await this.appActionHandler(actionName, actionPayload);
          data =
            rawRes && typeof rawRes === 'object'
              ? (rawRes as Record<string, unknown>)
              : { result: rawRes };
          break;
        }
      }

      const snapshot = this.captureSnapshot();
      const latencyMs = Number(
        ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0).toFixed(2),
      );
      this.appendAudit({
        source,
        action: cmd.action,
        target: cmd.ref || cmd.selector || cmd.app_action || cmd.appAction || cmd.url || '-',
        ok: true,
        durationMs: latencyMs,
      });

      return {
        ok: true,
        command_id: commandId,
        target_id: targetId,
        generation: this.controlGeneration,
        action: cmd.action,
        snapshot,
        screenshot_data_url: screenshotDataUrl,
        data,
        latency_ms: latencyMs,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const latencyMs = Number(
        ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0).toFixed(2),
      );
      this.appendAudit({
        source,
        action: cmd.action,
        target: cmd.ref || cmd.selector || cmd.app_action || cmd.appAction || '-',
        ok: false,
        durationMs: latencyMs,
        detail: message,
      });
      return {
        ok: false,
        command_id: commandId,
        target_id: targetId,
        generation: this.controlGeneration,
        action: cmd.action,
        error: message,
        latency_ms: latencyMs,
      };
    }
  }
}

export const browserControlAgent = new BrowserControlAgentService();
if (typeof window !== 'undefined') {
  browserControlAgent.initialize();
}

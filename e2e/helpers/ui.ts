import { expect, type Locator, type Page } from '@playwright/test';
import {
  chatRowById,
  DOM,
  escapeCssAttrValue,
  messageBubbleById,
  NAV_DESTS,
  type NavDestKey,
} from './selectors';

export type NavDestination = NavDestKey;

const NAV_DESTINATION_MAP: Record<
  NavDestination,
  { trigger: string; target: string }
> = {
  chats: { trigger: NAV_DESTS.chats, target: DOM.chatList },
  tasks: { trigger: NAV_DESTS.tasks, target: DOM.taskCenterWorkspace },
  mcp: { trigger: NAV_DESTS.mcp, target: DOM.mcpToolsDock },
  talk: { trigger: NAV_DESTS.talk, target: DOM.talkModeOrb },
  computer: { trigger: NAV_DESTS.computer, target: DOM.computerWorkbench },
  hermes: { trigger: NAV_DESTS.hermes, target: DOM.hermesStudioPanel },
  browser: { trigger: NAV_DESTS.browser, target: DOM.browserControlWorkspace },
  settings: { trigger: NAV_DESTS.settings, target: DOM.settingsPanel },
};

export const BILINGUAL_PATTERNS = {
  send: /send|发送|傳送/i,
  cancel: /cancel|close|取消|关闭/i,
  confirm: /confirm|ok|save|apply|done|create|submit|确认|确定|保存|应用|完成|创建|提交/i,
  create: /create|new|add|创建|新建|添加/i,
  delete: /delete|remove|删除|移除/i,
  deleteForEveryone: /everyone|all|both|所有人|双方|大家/i,
  deleteForMe: /for me|just me|only me|仅自己|只为我/i,
  edit: /edit|编辑|修改/i,
  reply: /reply|回复/i,
  quote: /quote|引用/i,
  forward: /forward|转发/i,
  pin: /\bpin\b|pin message|置顶/i,
  unpin: /unpin|取消置顶/i,
  mute: /\bmute\b|静音|免打扰/i,
  unmute: /unmute|取消静音|开启通知/i,
  archive: /\barchive\b|归档/i,
  unarchive: /unarchive|取消归档|移出归档/i,
  markRead: /mark.*read|标为已读|标记已读/i,
  markUnread: /mark.*unread|标为未读|标记未读/i,
  select: /select|选择|多选/i,
  copy: /copy|复制/i,
  search: /search|搜索|查找/i,
  settings: /settings|设置/i,
  savedMessages: /saved messages|收藏夹|已保存消息/i,
  contacts: /contacts|联系人|通讯录/i,
  newGroup: /new group|create group|新建群组|创建群组/i,
  newChannel: /new channel|create channel|新建频道|创建频道/i,
  nightMode: /night mode|dark mode|夜间模式|深色模式/i,
  language: /language|语言|中文|english/i,
  wallet: /wallet|stars|钱包|星币/i,
  logout: /log\s*out|sign\s*out|退出登录|注销/i,
  poll: /poll|quiz|投票|测验/i,
  todo: /todo|checklist|待办|清单/i,
  retractVote: /retract|withdraw|撤销投票|取消投票/i,
  stopPoll: /stop poll|close poll|结束投票|关闭投票/i,
  back: /back|返回/i,
  next: /next|continue|下一步|继续/i,
  approve: /approve|allow|accept|批准|允许|同意/i,
  reject: /reject|deny|decline|拒绝|拦截/i,
  takeover: /take\s*over|接管/i,
} as const;

export type BilingualActionKey = keyof typeof BILINGUAL_PATTERNS;

export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface HslColor {
  h: number;
  s: number;
  l: number;
}

export interface PurpleColorViolation {
  selector: string;
  property: string;
  rawValue: string;
  rgba: RgbaColor;
  hsl: HslColor;
}

export interface CjkImeSimulationOptions {
  /**
   * When true, also dispatches a same-frame trailing keydown('Enter', { keyCode: 229, isComposing: false })
   * immediately after compositionend (before the 2-rAF settle) to verify the 3rd state ('Committed')
   * 1-frame post-composition guard on Safari/macOS IME engines.
   */
  simulateTrailingPostCompositionEnter?: boolean;
}

function resolvePattern(actionOrPattern: BilingualActionKey | RegExp): RegExp {
  return actionOrPattern instanceof RegExp
    ? actionOrPattern
    : BILINGUAL_PATTERNS[actionOrPattern];
}

export function bilingualRegex(
  enPattern: string,
  zhPattern: string,
  flags = 'i',
): RegExp {
  return new RegExp(`(?:${enPattern}|${zhPattern})`, flags);
}

export function scopedButton(
  container: Page | Locator,
  actionOrPattern: BilingualActionKey | RegExp,
): Locator {
  const pattern = resolvePattern(actionOrPattern);
  return container.getByRole('button', { name: pattern });
}

export function scopedMenuItem(
  container: Page | Locator,
  actionOrPattern: BilingualActionKey | RegExp,
): Locator {
  const pattern = resolvePattern(actionOrPattern);
  return container
    .getByRole('menuitem', { name: pattern })
    .or(container.getByRole('menuitemcheckbox', { name: pattern }))
    .or(container.getByRole('option', { name: pattern }))
    .or(container.getByRole('button', { name: pattern }));
}

export function scopedTab(
  container: Page | Locator,
  actionOrPattern: BilingualActionKey | RegExp,
): Locator {
  const pattern = resolvePattern(actionOrPattern);
  return container
    .getByRole('tab', { name: pattern })
    .or(container.getByRole('button', { name: pattern }));
}

export function scopedTextbox(
  container: Page | Locator,
  labelOrPlaceholder: BilingualActionKey | RegExp,
): Locator {
  const pattern = resolvePattern(labelOrPlaceholder);
  return container
    .getByRole('textbox', { name: pattern })
    .or(container.getByPlaceholder(pattern));
}

export async function openContextMenuAndClick(
  page: Page,
  target: Locator,
  actionOrPattern: BilingualActionKey | RegExp,
): Promise<void> {
  await expect(target).toBeVisible();
  await target.click({ button: 'right' });
  const menuContainer = page
    .locator('[role="menu"], [data-testid="context-menu"]')
    .first();
  await expect(menuContainer).toBeVisible();
  const item = scopedMenuItem(menuContainer, actionOrPattern).first();
  await expect(item).toBeVisible();
  await item.click();
}

/**
 * Navigates to `/` if the page has not navigated yet, awaits `#auth-screen` or `#app-shell`,
 * clicks `#btn-demo-login` when `#auth-screen` is shown, and strictly asserts `#app-shell`
 * and `#chat-list` become visible (fail-closed against empty/dummy servers).
 */
export async function loginViaDemo(page: Page): Promise<void> {
  const currentUrl = page.url();
  if (!currentUrl || currentUrl === 'about:blank' || !currentUrl.startsWith('http')) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
  }

  const authScreen = page.locator(DOM.authScreen);
  const appShell = page.locator(DOM.appShell);
  const chatList = page.locator(DOM.chatList);

  await expect(authScreen.or(appShell).first()).toBeVisible();

  if (await authScreen.isVisible()) {
    const demoBtn = page.locator(DOM.btnDemoLogin);
    await expect(demoBtn).toBeVisible();
    await expect(demoBtn).toBeEnabled();
    await demoBtn.click();
  }

  await expect(appShell).toBeVisible();
  await expect(authScreen).toBeHidden();

  // On narrow mobile/tablet viewports (<= 925px), if a default chat auto-opened MiddleColumn,
  // step back to LeftColumn so #chat-list is guaranteed visible upon return.
  if (!(await chatList.isVisible())) {
    const backBtn = page.locator(DOM.btnBackToChats);
    if (await backBtn.isVisible()) {
      await backBtn.click();
    }
  }

  await expect(chatList).toBeVisible();
}

/**
 * Selects a chat row inside `#chat-list [data-testid="chat-row"]` by 0-based index,
 * exact `data-chat-id` / substring text, or RegExp, clicks it, and asserts
 * `#middle-column` and `#chat-header` become visible.
 */
export async function selectChat(
  page: Page,
  matcher: string | RegExp | number = 0,
): Promise<Locator> {
  const chatList = page.locator(DOM.chatList);

  if (!(await chatList.isVisible())) {
    const backBtn = page.locator(DOM.btnBackToChats);
    if (await backBtn.isVisible()) {
      await backBtn.click();
    }
  }
  await expect(chatList).toBeVisible();

  const rows = chatList.locator(DOM.chatRow);
  let targetRow: Locator;

  if (typeof matcher === 'number') {
    if (!Number.isInteger(matcher) || matcher < 0) {
      throw new RangeError(`selectChat index must be a non-negative integer, got ${matcher}`);
    }
    targetRow = rows.nth(matcher);
  } else if (typeof matcher === 'string') {
    const byText = rows.filter({ hasText: matcher });
    if (matcher.length > 0) {
      const byId = chatList.locator(chatRowById(matcher));
      targetRow = byId.or(byText).first();
    } else {
      targetRow = byText.first();
    }
  } else {
    targetRow = rows.filter({ hasText: matcher }).first();
  }

  // Handle @tanstack/react-virtual offscreen rows when searching by string/RegExp
  if (typeof matcher !== 'number' && (await targetRow.count()) === 0) {
    for (let step = 0; step < 12; step++) {
      const didScroll = await chatList.evaluate((el) => {
        if (el.scrollHeight <= el.clientHeight) return false;
        const prev = el.scrollTop;
        el.scrollTop = Math.min(
          el.scrollHeight - el.clientHeight,
          el.scrollTop + Math.max(120, Math.floor(el.clientHeight * 0.8)),
        );
        return el.scrollTop > prev;
      });
      if (!didScroll || (await targetRow.count()) > 0) break;
    }
  }

  await expect(targetRow).toBeVisible();
  const chatIdAttr = await targetRow.getAttribute('data-chat-id');
  await targetRow.click();

  await expect(page.locator(DOM.middleColumn)).toBeVisible();
  await expect(page.locator(DOM.chatHeader)).toBeVisible();
  await expect(page.locator(DOM.chatHeaderTitle)).not.toBeEmpty();

  if (chatIdAttr && chatIdAttr.length > 0) {
    return chatList.locator(chatRowById(chatIdAttr)).first();
  }
  return targetRow;
}

/**
 * Reads current composer text transparently across `<textarea>`, `<input>`,
 * and `[contenteditable="true"]` implementations.
 */
export async function readComposerText(input: Locator): Promise<string> {
  await expect(input).toBeVisible();
  return input.evaluate((el) => {
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      return el.value;
    }
    return el.textContent ?? '';
  });
}

/**
 * Fills `#message-composer-input`, sends via `#btn-send-message` (or `Enter` fallback),
 * awaits a newly appended `[data-testid="message-bubble"]` containing `text` in `#message-list`,
 * and returns a stable Locator to that new bubble.
 */
export async function sendTextMessage(page: Page, text: string): Promise<Locator> {
  const composer = page.locator(DOM.messageComposerInput);
  const messageList = page.locator(DOM.messageList);
  await expect(composer).toBeVisible();
  await expect(composer).toBeEditable();
  await expect(messageList).toBeVisible();

  const matchingBubbles = messageList
    .locator(DOM.messageBubble)
    .filter({ hasText: text });

  const countBefore = await matchingBubbles.count();
  const lastIdBefore =
    countBefore > 0
      ? await matchingBubbles.last().getAttribute('data-message-id')
      : null;

  await composer.click();
  await composer.fill(text);

  const sendBtn = page.locator(DOM.btnSendMessage);
  if ((await sendBtn.isVisible()) && (await sendBtn.isEnabled())) {
    await sendBtn.click();
  } else {
    await composer.press('Enter');
  }

  await expect
    .poll(
      async () => {
        const countNow = await matchingBubbles.count();
        if (countNow > countBefore) return true;
        if (countNow > 0 && lastIdBefore !== null) {
          const lastIdNow = await matchingBubbles
            .last()
            .getAttribute('data-message-id');
          return lastIdNow !== null && lastIdNow !== lastIdBefore;
        }
        return false;
      },
      {
        message: `Expected a new message bubble containing "${text}" inside #message-list`,
        timeout: 10_000,
      },
    )
    .toBe(true);

  const newestBubble = matchingBubbles.last();
  await expect(newestBubble).toBeVisible();

  const msgId = await newestBubble.getAttribute('data-message-id');
  if (msgId && msgId.length > 0) {
    return messageList.locator(messageBubbleById(msgId)).first();
  }
  return newestBubble;
}

/**
 * Simulates realistic CJK IME composition:
 *   Idle -> compositionstart -> compositionupdate(pinyin) -> input(isComposing: true)
 *   -> keydown('Enter', { isComposing: true, keyCode: 229 }) [candidate commit — MUST NOT SEND]
 *   -> compositionupdate(committedText) -> input -> compositionend(committedText)
 *   -> (optional same-frame trailing Enter) -> keyup('Enter') -> 2x requestAnimationFrame settle.
 *
 * Supports both `<textarea>`/`<input>` (via React native prototype value setter)
 * and `[contenteditable="true"]` elements while preserving any existing prefix/suffix text.
 */
export async function simulateCjkImeComposition(
  input: Locator,
  pinyin: string,
  committedText: string,
  options: CjkImeSimulationOptions = {},
): Promise<void> {
  await expect(input).toBeVisible();
  await expect(input).toBeEditable();
  await input.focus();

  const simulateTrailingEnter = Boolean(
    options.simulateTrailingPostCompositionEnter,
  );

  await input.evaluate(
    async (el, { rawPinyin, finalCommitted, trailingEnter }) => {
      const setReactNativeValue = (
        target: HTMLInputElement | HTMLTextAreaElement,
        value: string,
      ): void => {
        const proto =
          target instanceof HTMLTextAreaElement
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
        if (descriptor?.set) {
          descriptor.set.call(target, value);
        } else {
          target.value = value;
        }
      };

      const placeContentEditableCaretAtEnd = (target: HTMLElement): void => {
        const selection = window.getSelection();
        if (!selection) return;
        const range = document.createRange();
        range.selectNodeContents(target);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      };

      if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? el.value.length;
        const prefix = el.value.slice(0, start);
        const suffix = el.value.slice(end);

        el.dispatchEvent(
          new CompositionEvent('compositionstart', {
            bubbles: true,
            cancelable: true,
            data: '',
          }),
        );
        el.dispatchEvent(
          new CompositionEvent('compositionupdate', {
            bubbles: true,
            cancelable: false,
            data: rawPinyin,
          }),
        );

        const composingValue = `${prefix}${rawPinyin}${suffix}`;
        setReactNativeValue(el, composingValue);
        const composingCaret = prefix.length + rawPinyin.length;
        el.setSelectionRange(composingCaret, composingCaret);
        el.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            cancelable: false,
            data: rawPinyin,
            inputType: 'insertCompositionText',
            isComposing: true,
          }),
        );

        // Candidate-commit Enter during active IME composition (keyCode 229, isComposing: true)
        el.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 229,
            which: 229,
            isComposing: true,
            bubbles: true,
            cancelable: true,
          }),
        );

        el.dispatchEvent(
          new CompositionEvent('compositionupdate', {
            bubbles: true,
            cancelable: false,
            data: finalCommitted,
          }),
        );

        const finalValue = `${prefix}${finalCommitted}${suffix}`;
        setReactNativeValue(el, finalValue);
        const finalCaret = prefix.length + finalCommitted.length;
        el.setSelectionRange(finalCaret, finalCaret);
        el.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            cancelable: false,
            data: finalCommitted,
            inputType: 'insertCompositionText',
            isComposing: true,
          }),
        );

        el.dispatchEvent(
          new CompositionEvent('compositionend', {
            bubbles: true,
            cancelable: false,
            data: finalCommitted,
          }),
        );
      } else if (el instanceof HTMLElement && el.isContentEditable) {
        const prefix = el.textContent ?? '';

        el.dispatchEvent(
          new CompositionEvent('compositionstart', {
            bubbles: true,
            cancelable: true,
            data: '',
          }),
        );
        el.dispatchEvent(
          new CompositionEvent('compositionupdate', {
            bubbles: true,
            cancelable: false,
            data: rawPinyin,
          }),
        );
        el.textContent = `${prefix}${rawPinyin}`;
        placeContentEditableCaretAtEnd(el);
        el.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            cancelable: false,
            data: rawPinyin,
            inputType: 'insertCompositionText',
            isComposing: true,
          }),
        );

        el.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 229,
            which: 229,
            isComposing: true,
            bubbles: true,
            cancelable: true,
          }),
        );

        el.dispatchEvent(
          new CompositionEvent('compositionupdate', {
            bubbles: true,
            cancelable: false,
            data: finalCommitted,
          }),
        );
        el.textContent = `${prefix}${finalCommitted}`;
        placeContentEditableCaretAtEnd(el);
        el.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            cancelable: false,
            data: finalCommitted,
            inputType: 'insertFromComposition',
            isComposing: false,
          }),
        );

        el.dispatchEvent(
          new CompositionEvent('compositionend', {
            bubbles: true,
            cancelable: false,
            data: finalCommitted,
          }),
        );
      } else {
        throw new Error(
          `simulateCjkImeComposition expected <textarea>, <input>, or [contenteditable], got <${el.tagName.toLowerCase()}>`,
        );
      }

      if (trailingEnter) {
        el.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 229,
            which: 229,
            isComposing: false,
            bubbles: true,
            cancelable: true,
          }),
        );
      }

      el.dispatchEvent(
        new KeyboardEvent('keyup', {
          key: 'Enter',
          code: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      );

      // Settle past the 1-frame Committed -> Idle guard so subsequent Idle Enter works reliably
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    },
    {
      rawPinyin: pinyin,
      finalCommitted: committedText,
      trailingEnter: simulateTrailingEnter,
    },
  );
}

/**
 * Opens `#main-menu-drawer` via `#btn-main-menu` (idempotent if already open)
 * and returns its Locator.
 */
export async function openBurgerMenu(page: Page): Promise<Locator> {
  const drawer = page.locator(DOM.mainMenuDrawer);
  if (await drawer.isVisible()) {
    return drawer;
  }

  const btnMainMenu = page.locator(DOM.btnMainMenu);
  if (!(await btnMainMenu.isVisible())) {
    const backBtn = page.locator(DOM.btnBackToChats);
    if (await backBtn.isVisible()) {
      await backBtn.click();
    }
  }

  await expect(btnMainMenu).toBeVisible();
  await btnMainMenu.click();
  await expect(drawer).toBeVisible();
  return drawer;
}

/**
 * Opens `#settings-panel` idempotently via `#menu-item-settings` inside `#main-menu-drawer`
 * (or `#nav-dest-settings` fallback) and returns the `#settings-panel` Locator.
 */
export async function openSettings(page: Page): Promise<Locator> {
  const settingsPanel = page.locator(DOM.settingsPanel);
  if (await settingsPanel.isVisible()) {
    return settingsPanel;
  }

  const menuSettings = page.locator(DOM.menuItemSettings);
  if (await menuSettings.isVisible()) {
    await menuSettings.click();
    await expect(settingsPanel).toBeVisible();
    return settingsPanel;
  }

  const navSettings = page.locator(NAV_DESTINATION_MAP.settings.trigger);
  const btnMainMenu = page.locator(DOM.btnMainMenu);

  if (await btnMainMenu.isVisible()) {
    await openBurgerMenu(page);
    await expect(menuSettings).toBeVisible();
    await menuSettings.click();
  } else if (await navSettings.isVisible()) {
    await navSettings.click();
  } else {
    await openBurgerMenu(page);
    await expect(menuSettings).toBeVisible();
    await menuSettings.click();
  }

  await expect(settingsPanel).toBeVisible();
  return settingsPanel;
}

/**
 * Opens `#settings-panel` and navigates into `[data-settings-section="<sectionId>"]`.
 */
export async function openSettingsSection(
  page: Page,
  sectionId: string,
): Promise<Locator> {
  const panel = await openSettings(page);
  const trigger = panel.locator(
    `[data-settings-section="${escapeCssAttrValue(sectionId)}"]`,
  );
  await expect(trigger.first()).toBeVisible();
  await trigger.first().click();
  return panel;
}

/**
 * Ensures `#right-column` is open (idempotent on >= 1276px 3-column layout where it may
 * already be docked) via `#btn-toggle-right-column` and returns `#right-column`.
 */
export async function openRightInspector(page: Page): Promise<Locator> {
  const rightCol = page.locator(DOM.rightColumn);
  if (await rightCol.isVisible()) {
    return rightCol;
  }

  const toggleBtn = page.locator(DOM.btnToggleRightColumn);
  await expect(toggleBtn).toBeVisible();
  await toggleBtn.click();
  await expect(rightCol).toBeVisible();
  return rightCol;
}

/**
 * Ensures `#right-column` is hidden/closed if currently open.
 */
export async function closeRightInspector(page: Page): Promise<void> {
  const rightCol = page.locator(DOM.rightColumn);
  if (!(await rightCol.isVisible())) {
    return;
  }
  const toggleBtn = page.locator(DOM.btnToggleRightColumn);
  if (await toggleBtn.isVisible()) {
    await toggleBtn.click();
  } else {
    await page.keyboard.press('Escape');
  }
  await expect(rightCol).toBeHidden();
}

/**
 * Clicks `#nav-dest-<dest>` on `#nav-rail` and awaits the canonical workspace/panel Locator.
 */
export async function openNavDestination(
  page: Page,
  dest: NavDestination,
): Promise<Locator> {
  const { trigger, target } = NAV_DESTINATION_MAP[dest];
  const triggerLoc = page.locator(trigger);
  const targetLoc = page.locator(target);

  if (!(await triggerLoc.isVisible())) {
    const backBtn = page.locator(DOM.btnBackToChats);
    if (await backBtn.isVisible()) {
      await backBtn.click();
    }
  }

  if (dest === 'settings' && !(await triggerLoc.isVisible())) {
    return openSettings(page);
  }

  await expect(triggerLoc).toBeVisible();
  await triggerLoc.click();
  await expect(targetLoc).toBeVisible();
  return targetLoc;
}

export function parseCssRgba(cssColor: string): RgbaColor | null {
  if (!cssColor) return null;
  const trimmed = cssColor.trim().toLowerCase();
  if (trimmed === '' || trimmed === 'transparent' || trimmed === 'none') {
    return null;
  }
  const match = trimmed.match(
    /^rgba?\(\s*([0-9.]+)(?:\s*,\s*|\s+)([0-9.]+)(?:\s*,\s*|\s+)([0-9.]+)(?:\s*[,/]\s*([0-9.]+%?))?\s*\)$/,
  );
  if (!match) return null;

  const r = Math.round(Number(match[1]));
  const g = Math.round(Number(match[2]));
  const b = Math.round(Number(match[3]));
  let a = 1;
  if (match[4] !== undefined) {
    a = match[4].endsWith('%')
      ? parseFloat(match[4]) / 100
      : Number(match[4]);
  }
  if ([r, g, b, a].some((n) => Number.isNaN(n))) return null;
  return {
    r: Math.max(0, Math.min(255, r)),
    g: Math.max(0, Math.min(255, g)),
    b: Math.max(0, Math.min(255, b)),
    a: Math.max(0, Math.min(1, a)),
  };
}

export function rgbToHsl(r: number, g: number, b: number): HslColor {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const l = (max + min) / 2;

  if (delta === 0) {
    return { h: 0, s: 0, l };
  }

  const s = delta / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (max === rn) {
    h = 60 * (((gn - bn) / delta) % 6);
  } else if (max === gn) {
    h = 60 * ((bn - rn) / delta + 2);
  } else {
    h = 60 * ((rn - gn) / delta + 4);
  }
  if (h < 0) h += 360;

  return { h, s, l };
}

/**
 * Mathematically verified dark-mode purple/violet detector:
 * - Catches #8774E1 (R-G = 19, H = 250.5°), #766AC8 (R-G = 12, H = 247.7°),
 *   Tailwind Indigo/Violet/Purple/Fuchsia (#6366F1..#D946EF), dark violet surfaces (#2E1065),
 *   CSS named `purple` (#800080, H = 300°), and semi-transparent purple pills (alpha >= 0.08).
 * - Passes Telegram Blues (#3390EC, #1084FE, #1687FF, #2B5278, #182533, #17212B, #0E1621, #0E1013
 *   with H in 209°..216°), royal/sky/cyan blues, greens, ambers, reds/pinks, whites, and neutral grays.
 */
export function isPurpleOrVioletRgba(rgba: RgbaColor): boolean {
  if (rgba.a < 0.08) return false;
  const max = Math.max(rgba.r, rgba.g, rgba.b);
  const min = Math.min(rgba.r, rgba.g, rgba.b);
  if (max - min < 24) return false;

  const { h, s, l } = rgbToHsl(rgba.r, rgba.g, rgba.b);
  if (s < 0.22 || l < 0.10 || l > 0.92) return false;

  return h >= 238 && h <= 312;
}

/**
 * Samples computed colors across `#app-shell`, columns, headers, drawers, settings, dialogs,
 * buttons, tabs, links, inputs, and message bubbles on dark themes (`night` / `tinted`) and
 * asserts zero purple/violet hues exist. Strictly fails closed if `#app-shell` is missing,
 * hidden, or rendered under a light theme (`day` / `classic`).
 */
export async function assertNoPurpleOnDark(page: Page): Promise<void> {
  const appShell = page.locator(DOM.appShell);
  await expect(appShell).toBeVisible();

  const audit = await page.evaluate(() => {
    const shell = document.querySelector('#app-shell');
    if (!(shell instanceof HTMLElement)) {
      return {
        hasShell: false,
        themeAttr: null as string | null,
        shellBgLuminance: 1,
        sampledCount: 0,
        violations: [] as Array<{
          selector: string;
          property: string;
          rawValue: string;
          rgba: { r: number; g: number; b: number; a: number };
          hsl: { h: number; s: number; l: number };
        }>,
      };
    }

    const themeAttr =
      document.documentElement.getAttribute('data-theme') ||
      document.body.getAttribute('data-theme') ||
      shell.getAttribute('data-theme');

    const colorCache = new Map<
      string,
      { r: number; g: number; b: number; a: number } | null
    >();
    const probeCanvas = document.createElement('canvas');
    probeCanvas.width = 1;
    probeCanvas.height = 1;
    const probeCtx = probeCanvas.getContext('2d', { willReadFrequently: true });

    const parseColorInBrowser = (
      raw: string,
    ): { r: number; g: number; b: number; a: number } | null => {
      if (!raw) return null;
      const key = raw.trim();
      if (
        key === '' ||
        key === 'transparent' ||
        key === 'none' ||
        key === 'rgba(0, 0, 0, 0)'
      ) {
        return null;
      }
      if (colorCache.has(key)) {
        return colorCache.get(key) ?? null;
      }

      let parsed: { r: number; g: number; b: number; a: number } | null = null;
      const m = key
        .toLowerCase()
        .match(
          /^rgba?\(\s*([0-9.]+)(?:\s*,\s*|\s+)([0-9.]+)(?:\s*,\s*|\s+)([0-9.]+)(?:\s*[,/]\s*([0-9.]+%?))?\s*\)$/,
        );
      if (m) {
        const r = Math.round(Number(m[1]));
        const g = Math.round(Number(m[2]));
        const b = Math.round(Number(m[3]));
        const a =
          m[4] === undefined
            ? 1
            : m[4].endsWith('%')
              ? parseFloat(m[4]) / 100
              : Number(m[4]);
        parsed = { r, g, b, a };
      } else if (probeCtx) {
        probeCtx.clearRect(0, 0, 1, 1);
        probeCtx.fillStyle = 'rgba(0, 0, 0, 0)';
        probeCtx.fillStyle = key;
        probeCtx.fillRect(0, 0, 1, 1);
        const px = probeCtx.getImageData(0, 0, 1, 1).data;
        parsed = { r: px[0], g: px[1], b: px[2], a: px[3] / 255 };
      }

      colorCache.set(key, parsed);
      return parsed;
    };

    const toHsl = (r: number, g: number, b: number) => {
      const rn = r / 255;
      const gn = g / 255;
      const bn = b / 255;
      const max = Math.max(rn, gn, bn);
      const min = Math.min(rn, gn, bn);
      const delta = max - min;
      const l = (max + min) / 2;
      if (delta === 0) return { h: 0, s: 0, l };
      const s = delta / (1 - Math.abs(2 * l - 1));
      let h = 0;
      if (max === rn) h = 60 * (((gn - bn) / delta) % 6);
      else if (max === gn) h = 60 * ((bn - rn) / delta + 2);
      else h = 60 * ((rn - gn) / delta + 4);
      if (h < 0) h += 360;
      return { h, s, l };
    };

    const isPurple = (c: { r: number; g: number; b: number; a: number }) => {
      if (c.a < 0.08) return false;
      const max = Math.max(c.r, c.g, c.b);
      const min = Math.min(c.r, c.g, c.b);
      if (max - min < 24) return false;
      const { h, s, l } = toHsl(c.r, c.g, c.b);
      if (s < 0.22 || l < 0.10 || l > 0.92) return false;
      return h >= 238 && h <= 312;
    };

    const describeEl = (el: Element): string => {
      const tag = el.tagName.toLowerCase();
      if (el.id) return `${tag}#${el.id}`;
      const testId = el.getAttribute('data-testid');
      if (testId) return `${tag}[data-testid="${testId}"]`;
      const cls =
        typeof el.className === 'string' && el.className.trim()
          ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
          : '';
      return `${tag}${cls}`;
    };

    const isExcludedAvatarOrSwatch = (el: Element): boolean => {
      return el.matches(
        'img, video, canvas, [data-avatar], [data-peer-avatar], [data-accent-swatch], [class*="avatar" i], [data-testid*="avatar" i]',
      );
    };

    // Determine effective root/shell dark background lightness
    let shellBgLuminance = 0.09;
    for (const bgCandidate of [shell, document.body, document.documentElement]) {
      const bg = parseColorInBrowser(
        window.getComputedStyle(bgCandidate).backgroundColor,
      );
      if (bg && bg.a >= 0.5) {
        shellBgLuminance = toHsl(bg.r, bg.g, bg.b).l;
        break;
      }
    }

    const selectorQuery = [
      'html',
      'body',
      '#app-shell',
      '#app-shell > *',
      '#left-column',
      '#middle-column',
      '#right-column',
      '#chat-header',
      '#nav-rail',
      '#chat-folder-tabs',
      '#main-menu-drawer',
      '#settings-panel',
      '#pinned-message-banner',
      '#selection-toolbar',
      '#top-audio-player-bar',
      '#top-call-bar',
      '#connection-status-banner',
      '[role="dialog"]',
      '#miniapp-modal',
      '#call-overlay',
      '#lightbox-viewer',
      '#instant-view-modal',
      '#modal-media-editor',
      '#wallet-stars-modal',
      '#hermes-studio-panel',
      '#magpie-gateway-panel',
      '#task-center-workspace',
      '#mcp-tools-dock',
      '#computer-workbench',
      'header',
      'nav',
      'aside',
      'main',
      'button',
      '[role="button"]',
      '[role="tab"]',
      '[role="menuitem"]',
      'a',
      'input',
      'textarea',
      '[data-testid="message-bubble"]',
      '[data-testid="chat-row"]',
    ].join(', ');

    const candidates = Array.from(document.querySelectorAll(selectorQuery));
    // Also sample up to 300 visible descendants inside #app-shell to catch arbitrary styled divs/spans
    for (const descendant of Array.from(shell.querySelectorAll('*')).slice(0, 300)) {
      candidates.push(descendant);
    }

    const uniqueElements = Array.from(new Set(candidates));
    const violations: Array<{
      selector: string;
      property: string;
      rawValue: string;
      rgba: { r: number; g: number; b: number; a: number };
      hsl: { h: number; s: number; l: number };
    }> = [];
    let sampledCount = 0;

    for (const el of uniqueElements) {
      if (isExcludedAvatarOrSwatch(el)) continue;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
        continue;
      }

      sampledCount++;
      const propsToCheck: Array<[string, string]> = [
        ['backgroundColor', style.backgroundColor],
        ['color', style.color],
      ];

      if (parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== 'none') {
        propsToCheck.push(['borderTopColor', style.borderTopColor]);
      }
      if (parseFloat(style.borderBottomWidth) > 0 && style.borderBottomStyle !== 'none') {
        propsToCheck.push(['borderBottomColor', style.borderBottomColor]);
      }
      if (parseFloat(style.borderLeftWidth) > 0 && style.borderLeftStyle !== 'none') {
        propsToCheck.push(['borderLeftColor', style.borderLeftColor]);
      }
      if (parseFloat(style.borderRightWidth) > 0 && style.borderRightStyle !== 'none') {
        propsToCheck.push(['borderRightColor', style.borderRightColor]);
      }
      if (parseFloat(style.outlineWidth) > 0 && style.outlineStyle !== 'none') {
        propsToCheck.push(['outlineColor', style.outlineColor]);
      }

      if (style.backgroundImage && style.backgroundImage.includes('gradient')) {
        const stopMatches = style.backgroundImage.match(/rgba?\([^)]+\)/gi) ?? [];
        for (const stop of stopMatches) {
          propsToCheck.push(['backgroundImage', stop]);
        }
      }

      for (const [propName, rawVal] of propsToCheck) {
        const rgba = parseColorInBrowser(rawVal);
        if (rgba && isPurple(rgba)) {
          violations.push({
            selector: describeEl(el),
            property: propName,
            rawValue: rawVal,
            rgba,
            hsl: toHsl(rgba.r, rgba.g, rgba.b),
          });
        }
      }
    }

    return {
      hasShell: true,
      themeAttr,
      shellBgLuminance,
      sampledCount,
      violations,
    };
  });

  expect(audit.hasShell, 'Expected #app-shell to exist').toBe(true);
  expect(
    audit.sampledCount,
    'Expected assertNoPurpleOnDark to sample at least 1 visible element',
  ).toBeGreaterThan(0);

  if (audit.themeAttr !== null && audit.themeAttr !== '') {
    expect(
      ['night', 'tinted', 'dark'].includes(audit.themeAttr.toLowerCase()),
      `assertNoPurpleOnDark requires a dark data-theme ("night" or "tinted"), got "${audit.themeAttr}"`,
    ).toBe(true);
  } else if (audit.violations.length === 0) {
    expect(
      audit.shellBgLuminance,
      `Expected dark shell background luminance <= 0.35 when data-theme is unset, got L=${audit.shellBgLuminance.toFixed(3)}`,
    ).toBeLessThanOrEqual(0.35);
  }

  expect(
    audit.violations,
    `Detected forbidden purple/violet colors on dark theme:\n${audit.violations
      .slice(0, 8)
      .map(
        (v) =>
          `  - ${v.selector} [${v.property}: ${v.rawValue}] -> H=${v.hsl.h.toFixed(1)}° S=${(v.hsl.s * 100).toFixed(1)}% L=${(v.hsl.l * 100).toFixed(1)}%`,
      )
      .join('\n')}`,
  ).toEqual([]);
}

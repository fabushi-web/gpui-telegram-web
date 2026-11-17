/**
 * 3-State CJK Input Method Editor (IME) Safety State Machine (`Idle -> Composing -> Committed`).
 *
 * Mirrors `crates/gpui_telegram_desktop/src/views/composer/ime_machine.rs` while reconciling
 * cross-browser DOM composition ordering across Chromium (`keydown(Enter, isComposing=true)`
 * BEFORE `compositionend`) and Safari/WebKit (`compositionend` BEFORE trailing `keydown(Enter)`).
 */

export type ImeStateKind = 'Idle' | 'Composing' | 'Committed';

export type ImeState =
  | { readonly kind: 'Idle' }
  | { readonly kind: 'Composing'; readonly preeditText: string; readonly cursorPos: number }
  | { readonly kind: 'Committed'; readonly committedText: string };

export type KeyAction =
  | 'SendMessage'
  | 'InsertNewline'
  | 'ImeCandidateChosen'
  | 'DefaultEdit'
  | 'None';

export interface ImeKeyEventInput {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  which?: number;
}

export interface ImeSafetyOptions {
  sendByEnter?: boolean;
}

export interface HandleKeyContext {
  text?: string;
  hasAttachment?: boolean;
  sendByEnter?: boolean;
}

export class ImeSafetyFsm {
  private state: ImeState = { kind: 'Idle' };
  private justCommitted = false;
  private enterSuppressedDuringComposition = false;
  private sendByEnter: boolean;

  constructor(options: ImeSafetyOptions = {}) {
    this.sendByEnter = options.sendByEnter ?? true;
  }

  getState(): ImeState {
    return this.state;
  }

  getStateKind(): ImeStateKind {
    return this.state.kind;
  }

  isJustCommitted(): boolean {
    return this.justCommitted;
  }

  isComposing(): boolean {
    return this.state.kind === 'Composing';
  }

  isComposingOrCommitted(): boolean {
    return this.state.kind === 'Composing' || (this.state.kind === 'Committed' && this.justCommitted);
  }

  setSendByEnter(sendByEnter: boolean): void {
    this.sendByEnter = sendByEnter;
  }

  getSendByEnter(): boolean {
    return this.sendByEnter;
  }

  /**
   * Handles `compositionstart` (`on_ime_start` in upstream).
   */
  onCompositionStart(initialPreedit = ''): ImeState {
    this.justCommitted = false;
    this.enterSuppressedDuringComposition = false;
    this.state = {
      kind: 'Composing',
      preeditText: initialPreedit,
      cursorPos: initialPreedit.length,
    };
    return this.state;
  }

  /**
   * Handles `compositionupdate` (`on_ime_update` in upstream).
   */
  onCompositionUpdate(preeditText: string, cursorPos = preeditText.length): ImeState {
    this.justCommitted = false;
    this.state = {
      kind: 'Composing',
      preeditText,
      cursorPos: Math.max(0, Math.min(cursorPos, preeditText.length)),
    };
    return this.state;
  }

  /**
   * Handles `compositionend` (`on_ime_commit` / `on_ime_cancel` in upstream).
   *
   * - If `committedText` is empty AND no preedit existed, cancels cleanly to `Idle`.
   * - Otherwise transitions to `Committed`.
   * - If `Enter` was ALREADY suppressed during this `Composing` session (Chromium sequence),
   *   `justCommitted` is NOT left armed for a non-existent trailing Enter, so the user's
   *   very next deliberate `Enter` in `Idle`/`Committed` sends immediately.
   * - If `Enter` was NOT yet seen before `compositionend` (Safari/WebKit sequence or synchronous
   *   unit test), `justCommitted = true` fences a single trailing synchronous `Enter` keydown.
   */
  onCompositionEnd(committedText = ''): ImeState {
    if (committedText.length === 0 && this.state.kind !== 'Composing') {
      return this.onCompositionCancel();
    }
    if (committedText.length === 0) {
      this.justCommitted = false;
      this.enterSuppressedDuringComposition = false;
      this.state = { kind: 'Idle' };
      return this.state;
    }

    const hadPriorEnterInComposition = this.enterSuppressedDuringComposition;
    this.enterSuppressedDuringComposition = false;
    this.state = {
      kind: 'Committed',
      committedText,
    };
    this.justCommitted = !hadPriorEnterInComposition;
    return this.state;
  }

  /**
   * Cancels composition (`Esc` or empty abort) and returns directly to `Idle`.
   */
  onCompositionCancel(): ImeState {
    this.justCommitted = false;
    this.enterSuppressedDuringComposition = false;
    this.state = { kind: 'Idle' };
    return this.state;
  }

  /**
   * Clears the post-commit fence (called on normal character edit or next macrotask tick
   * after `compositionend` in DOM event handlers).
   */
  resetCommitFence(): ImeState {
    this.justCommitted = false;
    this.enterSuppressedDuringComposition = false;
    if (this.state.kind === 'Committed') {
      this.state = { kind: 'Idle' };
    }
    return this.state;
  }

  /**
   * Evaluates a `keydown` event and returns the deterministic `KeyAction`.
   */
  handleKeyDown(event: ImeKeyEventInput, context: HandleKeyContext = {}): KeyAction {
    const keyCode = event.keyCode ?? event.which ?? 0;
    const nativeComposing = Boolean(event.isComposing) || keyCode === 229;

    // 1. Active IME composition or IME process key (`keyCode === 229`) NEVER sends!
    if (this.state.kind === 'Composing' || nativeComposing) {
      if (event.key === 'Enter' || keyCode === 13) {
        this.enterSuppressedDuringComposition = true;
        return 'ImeCandidateChosen';
      }
      if (event.key === 'Escape') {
        this.onCompositionCancel();
        return 'ImeCandidateChosen';
      }
      if (keyCode === 229) {
        return 'ImeCandidateChosen';
      }
      return 'DefaultEdit';
    }

    // 2. Non-Enter keys clear any lingering Committed state to Idle and allow normal editing.
    if (event.key !== 'Enter') {
      if (this.state.kind === 'Committed') {
        this.justCommitted = false;
        this.state = { kind: 'Idle' };
      }
      return 'DefaultEdit';
    }

    // 3. `Committed` state with active commit fence absorbs a trailing UNMODIFIED `Enter` from IME commit,
    // while allowing deliberate `Shift+Enter` (newline) or `Ctrl/Cmd+Enter` to proceed!
    if (this.state.kind === 'Committed' && this.justCommitted) {
      this.justCommitted = false;
      this.state = { kind: 'Idle' };
      if (!event.shiftKey && !event.ctrlKey && !event.metaKey) {
        return 'ImeCandidateChosen';
      }
    }

    // Transition Committed (unfenced) -> Idle before evaluating deliberate Enter action.
    if (this.state.kind === 'Committed') {
      this.state = { kind: 'Idle' };
    }

    const effectiveSendByEnter = context.sendByEnter ?? this.sendByEnter;
    const hasModifierSend = Boolean(event.ctrlKey || event.metaKey);
    const shiftKey = Boolean(event.shiftKey);

    const hasSendableContent =
      Boolean(context.hasAttachment) ||
      (context.text === undefined ? true : context.text.trim().length > 0);

    if (effectiveSendByEnter) {
      // Shift+Enter (without Ctrl/Cmd) inserts a newline.
      if (shiftKey && !hasModifierSend) {
        return 'InsertNewline';
      }
      if (!hasSendableContent) {
        return 'None';
      }
      return 'SendMessage';
    }

    // When `sendByEnter === false`, only `Ctrl+Enter` or `Cmd+Enter` sends; plain `Enter` inserts newline.
    if (hasModifierSend) {
      return hasSendableContent ? 'SendMessage' : 'None';
    }
    return 'InsertNewline';
  }
}

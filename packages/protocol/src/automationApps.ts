/**
 * Built-in Interactive Browser Script Distillation, Automation Script App Store &
 * Defense-in-Depth Secret Leak Scanner Contracts aligned with desktop
 * `bhrumom/gpui-telegram` v1.6.11 (`automation_apps.rs`, `bot-browser/src/script_app.rs`).
 *
 * Pure ES2023 + DOM isomorphic module (zero `node:*` imports or Node globals).
 */

export const AUTOMATION_APP_SCHEMA_VERSION_V1 = 1 as const;

export const AUTOMATION_APP_LIMITS = {
  maxPublishPayloadBytes: 512 * 1024,
  maxAppIdLen: 128,
  maxStepsCount: 200,
  maxParametersCount: 64,
  maxDomainsCount: 32,
  maxNameLen: 160,
  maxVersionLen: 64,
  maxCategoryLen: 64,
} as const;

export const SCRIPT_STEP_KINDS = [
  'navigate',
  'wait_for',
  'click',
  'fill',
  'press_key',
  'scroll',
  'extract_text',
  'assert_visible',
  'assert_text_contains',
  'human_checkpoint',
] as const;

export const SECRET_SCAN_MAX_JSON_DEPTH = 16;

export type BrowserBackendKind = 'wk_web_view' | 'obscura_cdp' | 'chrome_cdp' | 'mock_cdp';

export interface SemanticLocator {
  test_id?: string | null;
  aria_label?: string | null;
  role?: string | null;
  text_anchor?: string | null;
  css_selector?: string | null;
  name_attr?: string | null;
}

export interface StepTimingMetric {
  step_index?: number | null;
  operation: string;
  label?: string;
  backend?: BrowserBackendKind | null;
  duration_ms: number;
  success: boolean;
  timestamp_ms?: number;
  detail?: string | null;
}

export type ScriptStepKind = (typeof SCRIPT_STEP_KINDS)[number];

/** `#[serde(tag = "kind", rename_all = "snake_case")]` — all 10 upstream step variants */
export type ScriptStep =
  | { kind: 'navigate'; url_template: string }
  | { kind: 'wait_for'; locator: SemanticLocator; timeout_ms: number }
  | { kind: 'click'; locator: SemanticLocator }
  | {
      kind: 'fill';
      locator: SemanticLocator;
      value_template: string;
      secret_vault_key?: string | null;
    }
  | { kind: 'press_key'; key: string }
  | { kind: 'scroll'; delta_x: number; delta_y: number }
  | { kind: 'extract_text'; locator: SemanticLocator; output_key: string }
  | { kind: 'assert_visible'; locator: SemanticLocator }
  | { kind: 'assert_text_contains'; locator: SemanticLocator; expected_template: string }
  | { kind: 'human_checkpoint'; reason: string };

/** Mirrors `ScriptParameter` & `AutomationAppParameterDto` */
export interface AutomationAppParam {
  name: string;
  description?: string;
  required?: boolean;
  default_value?: string | null;
  is_secret?: boolean;
}
export type ScriptParameter = AutomationAppParam;
export type AutomationAppParameterDto = AutomationAppParam;

export interface AutomationScriptApp {
  schema_version: number;
  app_id: string;
  slug: string;
  name: string;
  version: string;
  description: string;
  category: string;
  target_domains: string[];
  parameters: AutomationAppParam[];
  steps: ScriptStep[];
  required_capabilities: string[];
  author_id?: string | null;
  source_trace_summary?: string | null;
}

export type RecordedActionKind =
  | { kind: 'navigate'; url: string }
  | { kind: 'wait_for'; locator: SemanticLocator; timeout_ms: number }
  | { kind: 'click'; locator: SemanticLocator }
  | {
      kind: 'fill';
      locator: SemanticLocator;
      value: string;
      is_secret?: boolean;
      vault_key_hint?: string | null;
      parameter_name_hint?: string | null;
    }
  | { kind: 'press_key'; key: string }
  | { kind: 'scroll'; delta_x: number; delta_y: number }
  | { kind: 'extract_text'; locator: SemanticLocator; output_key: string }
  | { kind: 'assert_visible'; locator: SemanticLocator }
  | { kind: 'assert_text_contains'; locator: SemanticLocator; expected: string }
  | { kind: 'human_checkpoint'; reason: string };

export interface RecordedBrowserAction {
  seq: number;
  timestamp_ms: number;
  page_url?: string | null;
  action: RecordedActionKind;
  duration_ms?: number | null;
}

export interface TraceParameterBinding {
  param_name: string;
  literal_value: string;
  description?: string;
  required?: boolean;
  is_secret?: boolean;
}

export interface BrowserActionTrace {
  trace_id: string;
  session_id: string;
  started_at_ms: number;
  completed_at_ms?: number | null;
  initial_url?: string | null;
  actions: RecordedBrowserAction[];
  parameter_bindings?: TraceParameterBinding[];
}

export interface ScriptAppMetadata {
  app_id?: string | null;
  slug?: string | null;
  name: string;
  version?: string;
  description?: string;
  category?: string;
  target_domains?: string[];
  required_capabilities?: string[];
  author_id?: string | null;
  parameter_overrides?: AutomationAppParam[];
}

export interface ScriptReplayReport {
  app_id: string;
  version: string;
  success: boolean;
  steps_executed: number;
  extracted_outputs: Record<string, string>;
  step_timings: StepTimingMetric[];
  total_duration_ms: number;
  used_llm: boolean;
  final_url?: string | null;
  error?: string | null;
}

/** `#[serde(tag = "mode", rename_all = "snake_case")]` (`script_app.rs:410-423`) */
export type BrowserControlMode =
  | { mode: 'idle' }
  | { mode: 'ai_controlling'; active_step: number; status_text: string }
  | { mode: 'waiting_for_takeover'; reason: string }
  | { mode: 'user_takeover'; paused_at_step: number };

/** `#[serde(tag = "type", rename_all = "snake_case")]` (`browser_session.rs:43-88`) */
export type BrowserAutomationEvent =
  | {
      type: 'step_started';
      session_id: string;
      step_index: number;
      operation: string;
      locator?: SemanticLocator | null;
      url?: string | null;
    }
  | {
      type: 'step_completed';
      session_id: string;
      step_index: number;
      operation: string;
      duration_ms: number;
      locator?: SemanticLocator | null;
      url?: string | null;
    }
  | {
      type: 'step_failed';
      session_id: string;
      step_index: number;
      operation: string;
      duration_ms: number;
      error: string;
    }
  | {
      type: 'takeover_requested';
      session_id: string;
      reason: string;
      paused_at_step: number;
    }
  | { type: 'control_mode_changed'; session_id: string; mode: BrowserControlMode }
  | { type: 'trace_completed'; session_id: string; trace: BrowserActionTrace }
  | { type: 'script_distilled'; session_id: string; app: AutomationScriptApp };

export interface PublishAutomationAppRequest {
  manifest: AutomationScriptApp | Record<string, unknown>;
  is_published?: boolean;
  changelog?: string | null;
}

export interface AutomationAppSummary {
  app_id: string;
  slug: string;
  author_user_id: number;
  author_username?: string | null;
  name: string;
  description: string;
  category: string;
  target_domains: string[];
  latest_version: string;
  required_capabilities: string[];
  step_count: number;
  parameters: AutomationAppParam[];
  install_count: number;
  run_count: number;
  is_published: boolean;
  is_installed: boolean;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface AutomationAppDetail {
  app_id: string;
  slug: string;
  author_user_id: number;
  author_username?: string | null;
  name: string;
  description: string;
  category: string;
  target_domains: string[];
  latest_version: string;
  versions: string[];
  manifest: AutomationScriptApp | Record<string, unknown>;
  content_sha256: string;
  install_count: number;
  run_count: number;
  is_published: boolean;
  is_installed: boolean;
  installed_version?: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface ListAutomationAppsQuery {
  q?: string;
  category?: string;
  domain?: string;
  limit?: number;
  offset?: number;
}

export interface ListAutomationAppsResponse {
  apps: AutomationAppSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface InstalledAutomationApp {
  app_id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  target_domains: string[];
  installed_version: string;
  latest_version: string;
  manifest: AutomationScriptApp | Record<string, unknown>;
  content_sha256: string;
  installed_at_ms: number;
  last_run_at_ms?: number | null;
  local_run_count: number;
}

export interface ListInstalledAutomationAppsResponse {
  apps: InstalledAutomationApp[];
  total: number;
}

export interface InstallAutomationAppResponse {
  ok: boolean;
  app: InstalledAutomationApp;
  install_count: number;
  newly_installed: boolean;
}

export interface UninstallAutomationAppResponse {
  ok: boolean;
  app_id: string;
  removed: boolean;
}

export interface RecordAutomationRunRequest {
  version?: string | null;
  success: boolean;
  steps_executed: number;
  total_duration_ms: number;
  used_llm: boolean;
  error?: string | null;
}

export interface RecordAutomationRunResponse {
  ok: boolean;
  app_id: string;
  run_count: number;
  last_run_at_ms: number;
}

// ============================================================================
// App ID Validation (`routes/automation_apps.rs:36-52`)
// ============================================================================

export type ValidateAutomationAppIdResult =
  | { valid: true; normalized: string }
  | { valid: false; error: string };

const INVALID_APP_ID_ERROR =
  "app_id must be 1..=128 characters of [a-zA-Z0-9_-] and cannot be 'installed'";

export function validateAutomationAppId(raw: string): ValidateAutomationAppIdResult {
  const trimmed = raw.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > AUTOMATION_APP_LIMITS.maxAppIdLen ||
    trimmed.toLowerCase() === 'installed' ||
    !/^[a-zA-Z0-9_-]+$/.test(trimmed)
  ) {
    return { valid: false, error: INVALID_APP_ID_ERROR };
  }
  return { valid: true, normalized: trimmed };
}

export function isValidAutomationAppId(raw: string): boolean {
  return validateAutomationAppId(raw).valid;
}

// ============================================================================
// Defense-in-Depth Secret Leak Scanner (`bot-browser/src/script_app.rs`)
// ============================================================================

export interface SecretLeakFinding {
  path: string;
  reason: string;
}

export interface SecretLeakScanOptions {
  context?: string;
  parameters?: readonly AutomationAppParam[];
  maxDepth?: number;
}

export interface SecretLeakScanResult {
  safe: boolean;
  findings: SecretLeakFinding[];
}

const SENSITIVE_KV_KEYS: readonly string[] = [
  'auth_token',
  'auth-token',
  'ct0',
  'password',
  'passwd',
  'passcode',
  'pwd',
  'api_key',
  'api-key',
  'apikey',
  'x-api-key',
  'x_api_key',
  'access_token',
  'refresh_token',
  'id_token',
  'session_id',
  'set-cookie',
  'cookie',
  'authorization',
  'token',
  'secret',
];

const SENSITIVE_SINGLE_SEGMENTS = new Set<string>([
  'ct0',
  'password',
  'passwd',
  'passcode',
  'pwd',
  'apikey',
  'authorization',
  'token',
  'secret',
  'cookie',
]);

const SENSITIVE_PAIR_SEGMENTS = new Set<string>([
  'ct:0',
  'auth:token',
  'api:key',
  'access:token',
  'refresh:token',
  'id:token',
  'session:id',
  'set:cookie',
  'private:key',
  'pass:word',
  'pass:wd',
  'pass:code',
]);

const PAIR_FIRST_SEGMENTS = new Set<string>([
  'ct',
  'auth',
  'api',
  'access',
  'refresh',
  'id',
  'session',
  'set',
  'private',
  'pass',
]);

const MAX_SECRET_SCAN_FINDINGS = 64;
const LONG_SPAN_MEMO_THRESHOLD = 128;
const SHARED_FATAL_TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });

/** Exact 18 upstream Bearer prose nouns (`script_app.rs:7619-7638`) */
const ALLOWED_BEARER_PROSE_NOUNS = new Set<string>([
  'authenticating',
  'authentication',
  'authorization',
  'credential',
  'credentials',
  'certification',
  'implementation',
  'configuration',
  'documentation',
  'verification',
  'specification',
  'integration',
  'management',
  'middleware',
  'protocol',
  'mechanism',
  'framework',
  'architecture',
]);

const PEM_PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

const B64_TABLE = (() => {
  const table = new Int16Array(128).fill(-1);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < alphabet.length; i++) {
    table[alphabet.charCodeAt(i)] = i;
  }
  return table;
})();

function tryDecodeBase64Utf8(raw: string): string | null {
  const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
  if (normalized.length === 0 || normalized.length % 4 === 1) return null;
  const padded =
    normalized.length % 4 === 0
      ? normalized
      : normalized + '='.repeat(4 - (normalized.length % 4));
  let padLen = 0;
  if (padded.endsWith('==')) padLen = 2;
  else if (padded.endsWith('=')) padLen = 1;

  const out = new Uint8Array((padded.length / 4) * 3 - padLen);
  let outIdx = 0;
  for (let i = 0; i < padded.length; i += 4) {
    const c0 = padded.charCodeAt(i);
    const c1 = padded.charCodeAt(i + 1);
    const c2 = padded.charCodeAt(i + 2);
    const c3 = padded.charCodeAt(i + 3);
    const v0 = c0 < 128 ? B64_TABLE[c0]! : -1;
    const v1 = c1 < 128 ? B64_TABLE[c1]! : -1;
    const isPad2 = c2 === 61 && i + 4 === padded.length && padLen === 2;
    const isPad3 = c3 === 61 && i + 4 === padded.length && padLen >= 1;
    const v2 = isPad2 ? 0 : c2 < 128 ? B64_TABLE[c2]! : -1;
    const v3 = isPad3 ? 0 : c3 < 128 ? B64_TABLE[c3]! : -1;
    if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0) return null;
    const triple = (v0 << 18) | (v1 << 12) | (v2 << 6) | v3;
    if (outIdx < out.length) out[outIdx++] = (triple >>> 16) & 0xff;
    if (outIdx < out.length) out[outIdx++] = (triple >>> 8) & 0xff;
    if (outIdx < out.length) out[outIdx++] = triple & 0xff;
  }
  try {
    return SHARED_FATAL_TEXT_DECODER.decode(out);
  } catch {
    return null;
  }
}

function isAsciiUpper(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return c >= 65 && c <= 90;
}

function isAsciiLower(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return c >= 97 && c <= 122;
}

function isAsciiDigit(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return c >= 48 && c <= 57;
}

function isAsciiAlpha(ch: string): boolean {
  return isAsciiUpper(ch) || isAsciiLower(ch);
}

function isAsciiAlnum(ch: string): boolean {
  return isAsciiAlpha(ch) || isAsciiDigit(ch);
}

function isAsciiGraphic(code: number): boolean {
  return code >= 33 && code <= 126;
}

function isAsciiPunct(code: number): boolean {
  return (
    (code >= 33 && code <= 47) ||
    (code >= 58 && code <= 64) ||
    (code >= 91 && code <= 96) ||
    (code >= 123 && code <= 126)
  );
}

function isAsciiUpperCode(c: number): boolean {
  return c >= 65 && c <= 90;
}

function isAsciiLowerCode(c: number): boolean {
  return c >= 97 && c <= 122;
}

function isAsciiDigitCode(c: number): boolean {
  return c >= 48 && c <= 57;
}

function isAsciiAlphaCode(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isAsciiAlnumCode(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
}

function splitKeySegments(rawKey: string): string[] {
  const s = rawKey.trim();
  const segments: string[] = [];
  let cur = '';
  for (let idx = 0; idx < s.length; idx++) {
    const code = s.charCodeAt(idx);
    if (!isAsciiAlnumCode(code)) {
      if (cur.length > 0) {
        segments.push(cur);
        cur = '';
      }
      continue;
    }
    if (cur.length > 0) {
      const prev = s.charCodeAt(idx - 1);
      if (isAsciiUpperCode(code)) {
        const nextIsLower = idx + 1 < s.length && isAsciiLowerCode(s.charCodeAt(idx + 1));
        if (
          isAsciiLowerCode(prev) ||
          isAsciiDigitCode(prev) ||
          (isAsciiUpperCode(prev) && nextIsLower)
        ) {
          segments.push(cur);
          cur = '';
        }
      } else if (
        (isAsciiDigitCode(code) && isAsciiAlphaCode(prev)) ||
        (isAsciiLowerCode(code) && isAsciiDigitCode(prev))
      ) {
        segments.push(cur);
        cur = '';
      }
    }
    cur += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : s[idx]!;
  }
  if (cur.length > 0) {
    segments.push(cur);
  }
  return segments;
}

function isSensitiveJsonKeyWithSegments(rawKey: string, segments: readonly string[]): boolean {
  for (const seg of segments) {
    if (SENSITIVE_SINGLE_SEGMENTS.has(seg)) {
      return true;
    }
  }
  for (let i = 0; i + 1 < segments.length; i++) {
    if (SENSITIVE_PAIR_SEGMENTS.has(`${segments[i]!}:${segments[i + 1]!}`)) {
      return true;
    }
  }
  if (rawKey.includes('_') || rawKey.includes('-')) {
    const lower = rawKey.trim().toLowerCase();
    for (const key of SENSITIVE_KV_KEYS) {
      if (lower === key) return true;
      if (lower.endsWith(key)) {
        const prefixChar = lower[lower.length - key.length - 1];
        if (prefixChar === '_' || prefixChar === '-') return true;
      }
      if (lower.startsWith(key)) {
        const suffixChar = lower[key.length];
        if (suffixChar === '_' || suffixChar === '-') return true;
      }
    }
  }
  return false;
}

function isSensitiveParamName(name: string): boolean {
  const segments = splitKeySegments(name);
  if (isSensitiveJsonKeyWithSegments(name, segments)) {
    return true;
  }
  for (const seg of segments) {
    if (seg === 'bearer' || seg === 'basic' || seg === 'pin' || seg === 'otp' || seg === 'totp') {
      return true;
    }
  }
  const lower = name.trim().toLowerCase();
  return (
    lower.includes('password') ||
    lower.includes('passwd') ||
    lower.includes('passcode') ||
    lower.includes('secret') ||
    lower.includes('totp') ||
    lower.includes('apikey')
  );
}

function extractPurePlaceholder(template: string): string | null {
  const trimmed = template.trim();
  if (!trimmed.startsWith('{{') || !trimmed.endsWith('}}')) {
    return null;
  }
  const inner = trimmed.slice(2, -2).trim();
  if (!inner || inner.includes('{{') || inner.includes('}}')) {
    return null;
  }
  return inner;
}

interface ParamLookup {
  /** First-occurrence secret params with no default_value (exact parity with `params.find()`). */
  readonly secretNames: ReadonlySet<string>;
  /** Any param with `!p.is_secret || !p.default_value` (exact parity with `params.some()`). */
  readonly validUrlNames: ReadonlySet<string>;
}

function buildParamLookup(params: readonly AutomationAppParam[]): ParamLookup {
  const seenNames = new Set<string>();
  const secretNames = new Set<string>();
  const validUrlNames = new Set<string>();
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    const trimmedName = p.name.trim();
    if (!trimmedName) continue;
    if (!seenNames.has(trimmedName)) {
      seenNames.add(trimmedName);
      if (p.is_secret === true && !p.default_value) {
        secretNames.add(trimmedName);
      }
    }
    if (!p.is_secret || !p.default_value) {
      validUrlNames.add(trimmedName);
    }
  }
  return { secretNames, validUrlNames };
}

function isProtectedPlaceholder(val: string, paramLookup: ParamLookup): boolean {
  const name = extractPurePlaceholder(val);
  return name !== null && paramLookup.secretNames.has(name);
}

// --- Zero-ReDoS O(N) outer/trailing char trimmers (replace 4 unanchored `[...]+$` regexes) ---

function isBraceTokOuterTrimCode(c: number): boolean {
  // Exact match for /[()[\]<>"',;.!?]/
  return (
    c === 40 ||
    c === 41 ||
    c === 91 ||
    c === 93 ||
    c === 60 ||
    c === 62 ||
    c === 34 ||
    c === 39 ||
    c === 44 ||
    c === 59 ||
    c === 46 ||
    c === 33 ||
    c === 63
  );
}

function isBearerCoreOuterTrimCode(c: number): boolean {
  // Exact match for /[()[\]{}<>"',;.!?:=]/
  return (
    c === 40 ||
    c === 41 ||
    c === 91 ||
    c === 93 ||
    c === 123 ||
    c === 125 ||
    c === 60 ||
    c === 62 ||
    c === 34 ||
    c === 39 ||
    c === 44 ||
    c === 59 ||
    c === 46 ||
    c === 33 ||
    c === 63 ||
    c === 58 ||
    c === 61
  );
}

function isEnclosingQuoteTrailPunctCode(c: number): boolean {
  // Exact match for /[.,;!?)\]}]/
  return (
    c === 46 ||
    c === 44 ||
    c === 59 ||
    c === 33 ||
    c === 63 ||
    c === 41 ||
    c === 93 ||
    c === 125
  );
}

function isAuthTrailPunctCode(c: number): boolean {
  // Exact match for /[.!?,;]/
  return c === 46 || c === 33 || c === 63 || c === 44 || c === 59;
}

function trimOuterChars(s: string, pred: (c: number) => boolean): string {
  let start = 0;
  let end = s.length;
  while (start < end && pred(s.charCodeAt(start))) start++;
  while (end > start && pred(s.charCodeAt(end - 1))) end--;
  return start === 0 && end === s.length ? s : s.slice(start, end);
}

function trimTrailingChars(s: string, pred: (c: number) => boolean): string {
  let end = s.length;
  while (end > 0 && pred(s.charCodeAt(end - 1))) end--;
  return end === s.length ? s : s.slice(0, end);
}

function trimTrailingEndIdx(
  text: string,
  start: number,
  end: number,
  pred: (c: number) => boolean,
): number {
  let e = end;
  while (e > start && pred(text.charCodeAt(e - 1))) e--;
  return e;
}

function unwrapCleanQuotePair(s: string): string | null {
  const t = s.trim();
  if (t.length < 2) return null;
  const q = t[0];
  if ((q === '"' || q === "'") && t[t.length - 1] === q) {
    const inside = t.slice(1, -1);
    if (!inside.includes('"') && !inside.includes("'")) {
      return inside.trim();
    }
  }
  return null;
}

function unwrapBalancedEnclosure(s: string): string | null {
  const t = s.trim();
  if (t.length < 2) return null;
  const first = t[0];
  const last = t[t.length - 1];
  const pairOk =
    (first === '(' && last === ')') ||
    (first === '[' && last === ']') ||
    (first === '<' && last === '>') ||
    (first === '{' && last === '}' && !t.startsWith('{{'));
  if (!pairOk) return null;
  return t.slice(1, -1).trim();
}

function isProtectedAuthHeaderValue(val: string, paramLookup: ParamLookup): boolean {
  const trimmed = val.trim();
  if (!trimmed) return true;
  const c0 = trimmed.charCodeAt(0);
  if (c0 === 123) {
    return isProtectedPlaceholder(trimmed, paramLookup);
  }
  if (c0 !== 66 && c0 !== 98) {
    return false;
  }
  let schemeLen = 0;
  if (matchesAsciiIgnoreCaseAt(trimmed, 0, 'bearer')) schemeLen = 6;
  else if (matchesAsciiIgnoreCaseAt(trimmed, 0, 'basic')) schemeLen = 5;
  if (schemeLen === 0 || trimmed.length <= schemeLen) return false;

  const afterScheme = trimmed.slice(schemeLen);
  const firstCh = afterScheme[0]!;
  if (!isWsCode(afterScheme.charCodeAt(0)) && !':="\'"([{<'.includes(firstCh)) {
    return false;
  }
  let afterAssign = afterScheme.trimStart();
  if (afterAssign.startsWith(':') || afterAssign.startsWith('=')) {
    afterAssign = afterAssign.slice(1).trimStart();
  }
  if (!afterAssign || isProtectedPlaceholder(afterAssign, paramLookup)) {
    return true;
  }
  const enc = unwrapBalancedEnclosure(afterAssign);
  if (enc !== null) {
    if (isProtectedPlaceholder(enc, paramLookup)) return true;
    const q = unwrapCleanQuotePair(enc);
    if (q !== null && isProtectedPlaceholder(q, paramLookup)) return true;
  }
  const quoted = unwrapCleanQuotePair(afterAssign);
  if (quoted !== null) {
    if (isProtectedPlaceholder(quoted, paramLookup)) return true;
    const b = unwrapBalancedEnclosure(quoted);
    if (b !== null && isProtectedPlaceholder(b, paramLookup)) return true;
  }
  return false;
}

function isAllowedBearerProseNoun(tok: string): boolean {
  const word = tok.endsWith('.') && !tok.slice(0, -1).includes('.') ? tok.slice(0, -1) : tok;
  if (word.length === 0) return false;
  for (let i = 0; i < word.length; i++) {
    const ch = word[i]!;
    if (!isAsciiAlpha(ch)) return false;
    if (i > 0 && !isAsciiLower(ch)) return false;
  }
  return ALLOWED_BEARER_PROSE_NOUNS.has(word.toLowerCase());
}

// --- Zero-regex Basic credential detector (range-based, zero-slice fast path) ---

function isBasicCredCharCode(c: number): boolean {
  // Exact match for [A-Za-z0-9+/=_-]
  return (
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    (c >= 48 && c <= 57) ||
    c === 43 ||
    c === 47 ||
    c === 61 ||
    c === 95 ||
    c === 45
  );
}

function looksLikeBasicCredentialRange(text: string, start: number, end: number): boolean {
  const len = end - start;
  if (len < 8) return false;
  let hasDigit = false;
  let hasB64Sym = false;
  let hasUpper = false;
  let hasHyphen = false;
  for (let i = start; i < end; i++) {
    const c = text.charCodeAt(i);
    if (c >= 48 && c <= 57) {
      hasDigit = true;
    } else if (c >= 65 && c <= 90) {
      hasUpper = true;
    } else if (c >= 97 && c <= 122) {
      // lowercase ASCII
    } else if (c === 43 || c === 47 || c === 61 || c === 95) {
      hasB64Sym = true;
    } else if (c === 45) {
      hasHyphen = true;
    } else {
      return false;
    }
  }
  // Fast zero-allocation accept (identical disjunction to upstream script_app.rs:4355-4361)
  if (hasDigit || hasB64Sym || (hasHyphen && hasUpper)) {
    return true;
  }
  if (len % 4 !== 1) {
    const decoded = tryDecodeBase64Utf8(
      start === 0 && end === text.length ? text : text.slice(start, end),
    );
    if (decoded !== null) {
      let hasControl = false;
      for (let i = 0; i < decoded.length; i++) {
        const c = decoded.charCodeAt(i);
        if (c < 0x20 || c === 0x7f) {
          hasControl = true;
          break;
        }
      }
      if (!hasControl) {
        const colonIdx = decoded.indexOf(':');
        if (colonIdx > 0 && colonIdx < decoded.length - 1) {
          return true;
        }
      }
    }
  }
  return false;
}

function containsBasicCredentialToken(s: string): boolean {
  let i = 0;
  while (i < s.length) {
    if (isBasicCredCharCode(s.charCodeAt(i))) {
      const start = i;
      while (i < s.length && isBasicCredCharCode(s.charCodeAt(i))) {
        i++;
      }
      if (i - start >= 8 && looksLikeBasicCredentialRange(s, start, i)) {
        return true;
      }
    } else {
      i++;
    }
  }
  return false;
}

function isJwtLike(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [h, p, s] = parts as [string, string, string];
  const b64UrlRe = /^[A-Za-z0-9_-]+$/;
  return (
    h.length >= 10 &&
    p.length >= 10 &&
    s.length >= 6 &&
    b64UrlRe.test(h) &&
    b64UrlRe.test(p) &&
    b64UrlRe.test(s)
  );
}

const SHARED_TEXT_ENCODER = new TextEncoder();
const SHARED_TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });
const SLACK_TOKEN_RE = /^(?:xox[bpasr]-|xapp-\d-)[A-Za-z0-9-]{16,}$/;
const LOSSLESS_JSON_KIND = Symbol('losslessJsonKind');

interface LosslessJsonObject {
  readonly [LOSSLESS_JSON_KIND]: 'object';
  readonly entries: Array<readonly [string, LosslessJsonValue]>;
}

interface LosslessJsonArray {
  readonly [LOSSLESS_JSON_KIND]: 'array';
  readonly items: LosslessJsonValue[];
}

type LosslessJsonValue =
  | string
  | number
  | boolean
  | null
  | LosslessJsonObject
  | LosslessJsonArray;

interface LosslessJsonParseResult {
  valid: boolean;
  /** Number of UTF-16 code units scanned from `start` (to `endPos` on success or `failPos` on failure). */
  consumed: number;
  /** Exclusive end index in `input` of the parsed container (`pos` on success, `failPos` on failure). */
  endPos: number;
  /** Absolute failure index in `input` (`-1` when `valid === true`). */
  failPos: number;
  depthExceeded: boolean;
  root: LosslessJsonObject | LosslessJsonArray | null;
}

function isLosslessJsonObject(val: unknown): val is LosslessJsonObject {
  return (
    val !== null &&
    typeof val === 'object' &&
    (val as { [LOSSLESS_JSON_KIND]?: unknown })[LOSSLESS_JSON_KIND] === 'object'
  );
}

function isLosslessJsonArray(val: unknown): val is LosslessJsonArray {
  return (
    val !== null &&
    typeof val === 'object' &&
    (val as { [LOSSLESS_JSON_KIND]?: unknown })[LOSSLESS_JSON_KIND] === 'array'
  );
}

function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function hexNibble(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  if (code >= 97 && code <= 102) return code - 87;
  return -1;
}

function isUnicodeWsCode(code: number): boolean {
  return (
    code === 0x00a0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

function isWsCode(code: number): boolean {
  return (
    code === 32 ||
    code === 9 ||
    code === 10 ||
    code === 13 ||
    code === 12 ||
    code === 11 ||
    (code >= 0x80 && isUnicodeWsCode(code))
  );
}

function isHorizWsCode(code: number): boolean {
  return code === 32 || code === 9;
}

/** Matches upstream `is_kv_ident_char` (`script_app.rs:4530-4534`). */
function isKvIdentCharCode(code: number): boolean {
  if (code < 0x80) {
    return (
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 95 || // '_'
      code === 45 // '-'
    );
  }
  // Exclude C1 controls (0x80-0x9f) and Unicode whitespace
  return code >= 0xa0 && !isUnicodeWsCode(code);
}

function isValidBeforeContCode(code: number): boolean {
  return (
    code === 93 || // ']'
    code === 34 || // '"'
    code === 39 || // '\''
    code === 91 || // '['
    code === 46 || // '.'
    isKvIdentCharCode(code)
  );
}

/** Zero-allocation ASCII case-insensitive prefix match against an all-lowercase literal. */
function matchesAsciiIgnoreCaseAt(text: string, offset: number, lowerLit: string): boolean {
  if (offset < 0 || offset + lowerLit.length > text.length) return false;
  for (let i = 0; i < lowerLit.length; i++) {
    let c = text.charCodeAt(offset + i);
    if (c >= 65 && c <= 90) c += 32;
    if (c !== lowerLit.charCodeAt(i)) return false;
  }
  return true;
}

/** Exact delimiter set of Step 5 `/[\s"'`<>,;()[\]{}=:?&#/]/`. */
function isStep5TokenDelimCode(code: number): boolean {
  if (isWsCode(code)) return true;
  switch (code) {
    case 34: // '"'
    case 39: // '\''
    case 96: // '`'
    case 60: // '<'
    case 62: // '>'
    case 44: // ','
    case 59: // ';'
    case 40: // '('
    case 41: // ')'
    case 91: // '['
    case 93: // ']'
    case 123: // '{'
    case 125: // '}'
    case 61: // '='
    case 58: // ':'
    case 63: // '?'
    case 38: // '&'
    case 35: // '#'
    case 47: // '/'
      return true;
    default:
      return false;
  }
}

function isStep5TrailingStripCode(code: number): boolean {
  // Matches `/[.!?,;)]+$/`
  return code === 46 || code === 33 || code === 63 || code === 44 || code === 59 || code === 41;
}

const STEP5_PREFIX_RE = /(?:sk-|gh[pou]_|github_pat_|xox[bpasr]-|xapp-\d-|AKIA|AIza|eyJ)/g;

function percentDecodeForScan(input: string): string {
  let search = 0;
  let firstValidPct = -1;
  while (true) {
    const idx = input.indexOf('%', search);
    if (idx < 0 || idx + 2 >= input.length) break;
    if (hexNibble(input.charCodeAt(idx + 1)) >= 0 && hexNibble(input.charCodeAt(idx + 2)) >= 0) {
      firstValidPct = idx;
      break;
    }
    search = idx + 1;
  }
  if (firstValidPct < 0) return input;

  let lastValidPct = firstValidPct;
  let backSearch = input.length - 3;
  while (backSearch > firstValidPct) {
    const idx = input.lastIndexOf('%', backSearch);
    if (idx <= firstValidPct) break;
    if (hexNibble(input.charCodeAt(idx + 1)) >= 0 && hexNibble(input.charCodeAt(idx + 2)) >= 0) {
      lastValidPct = idx;
      break;
    }
    backSearch = idx - 1;
  }
  const decodeEnd = lastValidPct + 3;
  let buf = new Uint8Array(Math.max(16, decodeEnd - firstValidPct));
  let outLen = 0;
  const ensureCap = (extra: number): void => {
    if (outLen + extra <= buf.length) return;
    let nextLen = buf.length * 2;
    while (nextLen < outLen + extra) nextLen *= 2;
    const grown = new Uint8Array(nextLen);
    grown.set(buf.subarray(0, outLen));
    buf = grown;
  };

  let i = firstValidPct;
  while (i < decodeEnd) {
    const code = input.charCodeAt(i);
    if (code === 37 && i + 2 < decodeEnd) {
      const hi = hexNibble(input.charCodeAt(i + 1));
      const lo = hexNibble(input.charCodeAt(i + 2));
      if (hi >= 0 && lo >= 0) {
        ensureCap(1);
        buf[outLen++] = (hi << 4) | lo;
        i += 3;
        continue;
      }
    }
    if (code < 0x80) {
      ensureCap(1);
      buf[outLen++] = code;
      i += 1;
      continue;
    }
    const cp = input.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const encoded = SHARED_TEXT_ENCODER.encode(ch);
    ensureCap(encoded.length);
    buf.set(encoded, outLen);
    outLen += encoded.length;
    i += ch.length;
  }
  const decoded = SHARED_TEXT_DECODER.decode(buf.subarray(0, outLen));
  if (firstValidPct === 0 && i >= input.length) {
    return decoded;
  }
  return (
    (firstValidPct > 0 ? input.slice(0, firstValidPct) : '') +
    decoded +
    (i < input.length ? input.slice(i) : '')
  );
}

function unescapeJsonForScan(input: string): string {
  let i = input.indexOf('\\');
  if (i < 0) return input;
  let out = '';
  let chunkStart = 0;
  while (i >= 0 && i + 1 < input.length) {
    const next = input[i + 1]!;
    let replacement: string | null = null;
    let advance = 2;
    switch (next) {
      case '"':
        replacement = '"';
        break;
      case '\\':
        replacement = '\\';
        break;
      case '/':
        replacement = '/';
        break;
      case 'b':
        replacement = '\b';
        break;
      case 'f':
        replacement = '\f';
        break;
      case 'n':
        replacement = '\n';
        break;
      case 'r':
        replacement = '\r';
        break;
      case 't':
        replacement = '\t';
        break;
      case 'u': {
        if (i + 5 < input.length) {
          const h0 = hexNibble(input.charCodeAt(i + 2));
          const h1 = hexNibble(input.charCodeAt(i + 3));
          const h2 = hexNibble(input.charCodeAt(i + 4));
          const h3 = hexNibble(input.charCodeAt(i + 5));
          if (h0 >= 0 && h1 >= 0 && h2 >= 0 && h3 >= 0) {
            replacement = String.fromCharCode((h0 << 12) | (h1 << 8) | (h2 << 4) | h3);
            advance = 6;
          }
        }
        break;
      }
      default:
        break;
    }
    if (replacement !== null) {
      if (i > chunkStart) {
        out += input.slice(chunkStart, i);
      }
      out += replacement;
      i += advance;
      chunkStart = i;
      i = input.indexOf('\\', i);
      continue;
    }
    i = input.indexOf('\\', i + 1);
  }
  if (chunkStart === 0) return input;
  if (chunkStart < input.length) {
    out += input.slice(chunkStart);
  }
  return out;
}

function skipJsonWs(input: string, pos: number, end: number): number {
  while (pos < end) {
    const c = input.charCodeAt(pos);
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      pos++;
    } else {
      break;
    }
  }
  return pos;
}

type ParsedRfc8259String =
  | { ok: true; value: string; nextPos: number }
  | { ok: false; failPos: number };

type ParsedRfc8259Number =
  | { ok: true; nextPos: number }
  | { ok: false; failPos: number };

function parseRfc8259String(
  input: string,
  startPos: number,
  end: number,
): ParsedRfc8259String {
  if (startPos >= end || input.charCodeAt(startPos) !== 34) {
    return { ok: false, failPos: startPos };
  }
  let pos = startPos + 1;
  let chunkStart = pos;
  let out = '';
  let hasEscape = false;

  while (pos < end) {
    const code = input.charCodeAt(pos);
    if (code < 0x20) return { ok: false, failPos: pos };
    if (code === 34) {
      const value = hasEscape ? out + input.slice(chunkStart, pos) : input.slice(chunkStart, pos);
      return { ok: true, value, nextPos: pos + 1 };
    }
    if (code === 92) {
      hasEscape = true;
      if (pos > chunkStart) {
        out += input.slice(chunkStart, pos);
      }
      pos++;
      if (pos >= end) return { ok: false, failPos: end };
      const esc = input.charCodeAt(pos);
      switch (esc) {
        case 34:
          out += '"';
          pos++;
          break;
        case 92:
          out += '\\';
          pos++;
          break;
        case 47:
          out += '/';
          pos++;
          break;
        case 98:
          out += '\b';
          pos++;
          break;
        case 102:
          out += '\f';
          pos++;
          break;
        case 110:
          out += '\n';
          pos++;
          break;
        case 114:
          out += '\r';
          pos++;
          break;
        case 116:
          out += '\t';
          pos++;
          break;
        case 117: {
          if (pos + 4 >= end) return { ok: false, failPos: end };
          const h0 = hexNibble(input.charCodeAt(pos + 1));
          const h1 = hexNibble(input.charCodeAt(pos + 2));
          const h2 = hexNibble(input.charCodeAt(pos + 3));
          const h3 = hexNibble(input.charCodeAt(pos + 4));
          if (h0 < 0 || h1 < 0 || h2 < 0 || h3 < 0) {
            return { ok: false, failPos: pos + 1 };
          }
          out += String.fromCharCode((h0 << 12) | (h1 << 8) | (h2 << 4) | h3);
          pos += 5;
          break;
        }
        default:
          return { ok: false, failPos: pos };
      }
      chunkStart = pos;
      continue;
    }
    pos++;
  }
  return { ok: false, failPos: end };
}

function parseRfc8259Number(
  input: string,
  startPos: number,
  end: number,
): ParsedRfc8259Number {
  let pos = startPos;
  if (pos < end && input.charCodeAt(pos) === 45) pos++;
  if (pos >= end) return { ok: false, failPos: pos };
  const first = input.charCodeAt(pos);
  if (first === 48) {
    pos++;
  } else if (first >= 49 && first <= 57) {
    pos++;
    while (pos < end) {
      const c = input.charCodeAt(pos);
      if (c >= 48 && c <= 57) pos++;
      else break;
    }
  } else {
    return { ok: false, failPos: pos };
  }
  if (pos < end && input.charCodeAt(pos) === 46) {
    pos++;
    if (pos >= end) return { ok: false, failPos: pos };
    const d = input.charCodeAt(pos);
    if (d < 48 || d > 57) return { ok: false, failPos: pos };
    pos++;
    while (pos < end) {
      const c = input.charCodeAt(pos);
      if (c >= 48 && c <= 57) pos++;
      else break;
    }
  }
  if (pos < end && (input.charCodeAt(pos) === 101 || input.charCodeAt(pos) === 69)) {
    pos++;
    if (pos < end && (input.charCodeAt(pos) === 43 || input.charCodeAt(pos) === 45)) {
      pos++;
    }
    if (pos >= end) return { ok: false, failPos: pos };
    const d = input.charCodeAt(pos);
    if (d < 48 || d > 57) return { ok: false, failPos: pos };
    pos++;
    while (pos < end) {
      const c = input.charCodeAt(pos);
      if (c >= 48 && c <= 57) pos++;
      else break;
    }
  }
  return { ok: true, nextPos: pos };
}

type LosslessParserFrame =
  | {
      kind: 'object';
      state: 'keyOrEnd' | 'key' | 'colon' | 'value' | 'commaOrEnd';
      node: LosslessJsonObject | null;
      pendingKey: string | null;
    }
  | {
      kind: 'array';
      state: 'valueOrEnd' | 'value' | 'commaOrEnd';
      node: LosslessJsonArray | null;
    };

function attachLosslessJsonValue(parent: LosslessParserFrame, val: LosslessJsonValue): void {
  if (parent.kind === 'object') {
    if (parent.node !== null && parent.pendingKey !== null) {
      parent.node.entries.push([parent.pendingKey, val]);
    }
    parent.pendingKey = null;
    parent.state = 'commaOrEnd';
  } else {
    if (parent.node !== null) {
      parent.node.items.push(val);
    }
    parent.state = 'commaOrEnd';
  }
}

function makeFailedJsonResult(start: number, failPos: number): LosslessJsonParseResult {
  return {
    valid: false,
    consumed: Math.max(0, failPos - start),
    endPos: failPos,
    failPos,
    depthExceeded: false,
    root: null,
  };
}

/**
 * Iterative, linear O(N) RFC 8259 JSON container parser that preserves EVERY duplicate object
 * key in order (never applying JS `JSON.parse()` last-key-wins collapsing) and never recurses
 * on the JS call stack even for 512 KiB of deeply nested containers.
 *
 * When `prefixMode === true`, returns immediately once the root container closes without
 * rejecting trailing bytes (streaming prefix recovery for stray-quote embedded containers).
 */
function parseLosslessJsonContainer(
  input: string,
  start: number,
  end: number,
  baseDepth: number,
  maxDepth: number,
  prefixMode = false,
): LosslessJsonParseResult {
  let pos = skipJsonWs(input, start, end);
  if (pos >= end) return makeFailedJsonResult(start, pos);
  const firstCode = input.charCodeAt(pos);
  if (firstCode !== 123 && firstCode !== 91) return makeFailedJsonResult(start, pos);

  let depthExceeded = baseDepth > maxDepth;
  let root: LosslessJsonObject | LosslessJsonArray | null = null;
  const stack: LosslessParserFrame[] = [];

  if (firstCode === 123) {
    const objNode: LosslessJsonObject | null = depthExceeded
      ? null
      : { [LOSSLESS_JSON_KIND]: 'object', entries: [] };
    root = objNode;
    stack.push({ kind: 'object', state: 'keyOrEnd', node: objNode, pendingKey: null });
  } else {
    const arrNode: LosslessJsonArray | null = depthExceeded
      ? null
      : { [LOSSLESS_JSON_KIND]: 'array', items: [] };
    root = arrNode;
    stack.push({ kind: 'array', state: 'valueOrEnd', node: arrNode });
  }
  pos++;

  while (stack.length > 0) {
    pos = skipJsonWs(input, pos, end);
    if (pos >= end) return makeFailedJsonResult(start, pos);
    const top = stack[stack.length - 1]!;
    const ch = input.charCodeAt(pos);

    if (top.kind === 'object') {
      if (top.state === 'keyOrEnd' || top.state === 'key') {
        if (top.state === 'keyOrEnd' && ch === 125) {
          pos++;
          stack.pop();
          continue;
        }
        if (ch !== 34) return makeFailedJsonResult(start, pos);
        const parsedKey = parseRfc8259String(input, pos, end);
        if (!parsedKey.ok) return makeFailedJsonResult(start, parsedKey.failPos);
        if (top.node !== null) {
          top.pendingKey = parsedKey.value;
        }
        pos = parsedKey.nextPos;
        top.state = 'colon';
        continue;
      }
      if (top.state === 'colon') {
        if (ch !== 58) return makeFailedJsonResult(start, pos);
        pos++;
        top.state = 'value';
        continue;
      }
      if (top.state === 'commaOrEnd') {
        if (ch === 125) {
          pos++;
          stack.pop();
          continue;
        }
        if (ch === 44) {
          pos++;
          top.state = 'key';
          continue;
        }
        return makeFailedJsonResult(start, pos);
      }
    } else {
      if (top.state === 'valueOrEnd' && ch === 93) {
        pos++;
        stack.pop();
        continue;
      }
      if (top.state === 'commaOrEnd') {
        if (ch === 93) {
          pos++;
          stack.pop();
          continue;
        }
        if (ch === 44) {
          pos++;
          top.state = 'value';
          continue;
        }
        return makeFailedJsonResult(start, pos);
      }
    }

    // Expecting a JSON value
    const valDepth = baseDepth + stack.length;
    if (valDepth > maxDepth) {
      depthExceeded = true;
    }

    if (ch === 123) {
      const childNode: LosslessJsonObject | null =
        valDepth <= maxDepth && top.node !== null
          ? { [LOSSLESS_JSON_KIND]: 'object', entries: [] }
          : null;
      if (childNode !== null) {
        attachLosslessJsonValue(top, childNode);
      } else {
        if (top.kind === 'object') top.pendingKey = null;
        top.state = 'commaOrEnd';
      }
      pos++;
      stack.push({ kind: 'object', state: 'keyOrEnd', node: childNode, pendingKey: null });
    } else if (ch === 91) {
      const childNode: LosslessJsonArray | null =
        valDepth <= maxDepth && top.node !== null
          ? { [LOSSLESS_JSON_KIND]: 'array', items: [] }
          : null;
      if (childNode !== null) {
        attachLosslessJsonValue(top, childNode);
      } else {
        if (top.kind === 'object') top.pendingKey = null;
        top.state = 'commaOrEnd';
      }
      pos++;
      stack.push({ kind: 'array', state: 'valueOrEnd', node: childNode });
    } else if (ch === 34) {
      const parsedStr = parseRfc8259String(input, pos, end);
      if (!parsedStr.ok) return makeFailedJsonResult(start, parsedStr.failPos);
      attachLosslessJsonValue(top, parsedStr.value);
      pos = parsedStr.nextPos;
    } else if (ch === 116 && pos + 4 <= end && input.startsWith('true', pos)) {
      attachLosslessJsonValue(top, true);
      pos += 4;
    } else if (ch === 102 && pos + 5 <= end && input.startsWith('false', pos)) {
      attachLosslessJsonValue(top, false);
      pos += 5;
    } else if (ch === 110 && pos + 4 <= end && input.startsWith('null', pos)) {
      attachLosslessJsonValue(top, null);
      pos += 4;
    } else if (ch === 45 || (ch >= 48 && ch <= 57)) {
      const parsedNum = parseRfc8259Number(input, pos, end);
      if (!parsedNum.ok) return makeFailedJsonResult(start, parsedNum.failPos);
      attachLosslessJsonValue(top, 0);
      pos = parsedNum.nextPos;
    } else {
      return makeFailedJsonResult(start, pos);
    }
  }

  if (prefixMode) {
    return {
      valid: true,
      consumed: pos - start,
      endPos: pos,
      failPos: -1,
      depthExceeded,
      root,
    };
  }

  pos = skipJsonWs(input, pos, end);
  if (pos !== end) return makeFailedJsonResult(start, pos);
  return {
    valid: true,
    consumed: pos - start,
    endPos: pos,
    failPos: -1,
    depthExceeded,
    root,
  };
}

function isArrayElementContext(context: string, prefix: string): boolean {
  if (!context.startsWith(prefix) || !context.endsWith(']')) {
    return false;
  }
  const idx = context.slice(prefix.length, -1);
  return idx.length > 0 && /^\d+$/.test(idx);
}

function isCanonicalParamIsSecret(
  context: string,
  rootContext: string,
  rawKey: string,
  val: unknown,
): boolean {
  if (rawKey !== 'is_secret' || typeof val !== 'boolean') return false;
  return (
    isArrayElementContext(context, `${rootContext}.parameters[`) ||
    isArrayElementContext(context, `${rootContext}.manifest.parameters[`) ||
    isArrayElementContext(context, 'app.parameters[') ||
    isArrayElementContext(context, 'request.manifest.parameters[')
  );
}

function isCanonicalStepSecretVaultKey(
  context: string,
  rootContext: string,
  rawKey: string,
): boolean {
  if (rawKey !== 'secret_vault_key') return false;
  return (
    isArrayElementContext(context, `${rootContext}.steps[`) ||
    isArrayElementContext(context, `${rootContext}.manifest.steps[`) ||
    isArrayElementContext(context, 'app.steps[') ||
    isArrayElementContext(context, 'request.manifest.steps[')
  );
}

function isCanonicalParamElement(context: string, rootContext: string): boolean {
  return (
    isArrayElementContext(context, `${rootContext}.parameters[`) ||
    isArrayElementContext(context, `${rootContext}.manifest.parameters[`) ||
    isArrayElementContext(context, 'app.parameters[') ||
    isArrayElementContext(context, 'request.manifest.parameters[')
  );
}

function isSafeBearerOrBasicTokenWithBraces(tok: string, paramLookup: ParamLookup): boolean {
  if (isProtectedPlaceholder(tok, paramLookup)) return true;
  const trimmed = trimOuterChars(tok, isBraceTokOuterTrimCode);
  if (isProtectedPlaceholder(trimmed, paramLookup)) return true;
  const sepIdx = trimmed.search(/[:=]/);
  if (sepIdx > 0) {
    const lhs = trimmed.slice(0, sepIdx);
    const rhs = trimmed.slice(sepIdx + 1);
    if (!/[{}"']/.test(lhs) && rhs.length > 0 && isProtectedPlaceholder(rhs, paramLookup)) {
      return true;
    }
  }
  return false;
}

function isSafeBearerOrBasicValue(
  s: string,
  isBearer: boolean,
  isBasic: boolean,
  paramLookup: ParamLookup,
  strictBearerEnclosure = false,
): boolean {
  const trimmed = s.trim();
  if (!trimmed || isProtectedPlaceholder(trimmed, paramLookup)) {
    return true;
  }
  for (const rawTok of trimmed.split(/\s+/)) {
    if (rawTok.includes('{{') || rawTok.includes('}}')) {
      if (!isSafeBearerOrBasicTokenWithBraces(rawTok, paramLookup)) {
        return false;
      }
      continue;
    }
    if (isBasic && containsBasicCredentialToken(rawTok)) {
      return false;
    }
    if (isBearer) {
      const core = trimOuterChars(rawTok, isBearerCoreOuterTrimCode);
      if (!core) continue;
      let asciiNonWs = 0;
      let hasDigitOrPunct = false;
      for (let i = 0; i < core.length; i++) {
        const code = core.charCodeAt(i);
        if (isAsciiGraphic(code)) asciiNonWs++;
        if ((code >= 48 && code <= 57) || isAsciiPunct(code)) {
          hasDigitOrPunct = true;
        }
      }
      const bearerThresholdHit = strictBearerEnclosure
        ? asciiNonWs >= 6 || (asciiNonWs >= 4 && hasDigitOrPunct)
        : (asciiNonWs >= 6 && hasDigitOrPunct) || asciiNonWs >= 12;
      if (!isAllowedBearerProseNoun(core) && bearerThresholdHit) {
        return false;
      }
    }
  }
  return true;
}

function countAsciiGraphicAndDigitOrPunct(s: string): {
  asciiNonWs: number;
  hasDigitOrPunct: boolean;
} {
  let asciiNonWs = 0;
  let hasDigitOrPunct = false;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (isAsciiGraphic(code)) asciiNonWs++;
    if ((code >= 48 && code <= 57) || isAsciiPunct(code)) {
      hasDigitOrPunct = true;
    }
  }
  return { asciiNonWs, hasDigitOrPunct };
}

function extractAutoParameters(value: unknown): AutomationAppParam[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }
  const obj = value as Record<string, unknown>;
  const rawParams = Array.isArray(obj.parameters)
    ? obj.parameters
    : obj.manifest &&
        typeof obj.manifest === 'object' &&
        !Array.isArray(obj.manifest) &&
        Array.isArray((obj.manifest as Record<string, unknown>).parameters)
      ? ((obj.manifest as Record<string, unknown>).parameters as unknown[])
      : [];
  const out: AutomationAppParam[] = [];
  for (const item of rawParams) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.name !== 'string') continue;
    out.push({
      name: rec.name,
      description: typeof rec.description === 'string' ? rec.description : undefined,
      required: typeof rec.required === 'boolean' ? rec.required : undefined,
      default_value: typeof rec.default_value === 'string' ? rec.default_value : null,
      is_secret: typeof rec.is_secret === 'boolean' ? rec.is_secret : undefined,
    });
  }
  return out;
}

interface ContainerBraceMap {
  /** Maps open index -> exclusive close end index (`closeIdx + 1`). */
  matched: Map<number, number>;
  /** Open indices pushed onto stack and left unclosed at `\n`/`\r` inside a string or EOF. */
  unclosed: Set<number>;
}

function isPlausibleJsonObjectStart(text: string, openIdx: number): boolean {
  if (openIdx + 1 >= text.length) return false;
  if (text.charCodeAt(openIdx + 1) === 123) return false; // skip '{{' outer mustache opener
  const nextNonWs = skipJsonWs(text, openIdx + 1, text.length);
  if (nextNonWs >= text.length) return false;
  const nextCode = text.charCodeAt(nextNonWs);
  return nextCode === 34 || nextCode === 125; // '"' or '}'
}

function isPlausibleJsonArrayStart(text: string, openIdx: number): boolean {
  const nextNonWs = skipJsonWs(text, openIdx + 1, text.length);
  if (nextNonWs >= text.length) return false;
  const c = text.charCodeAt(nextNonWs);
  if (
    c === 34 || // '"'
    c === 91 || // '['
    c === 93 || // ']'
    c === 123 || // '{'
    c === 45 || // '-'
    (c >= 48 && c <= 57) // '0'..'9'
  ) {
    return true;
  }
  if (c === 116) return text.startsWith('true', nextNonWs);
  if (c === 102) return text.startsWith('false', nextNonWs);
  if (c === 110) return text.startsWith('null', nextNonWs);
  return false;
}

/**
 * Upstream `scan_json_object_brace_map` (`script_app.rs:3214-3309`) parity:
 * Never pushes top-level `[` or flips `inString` outside an open `{...}` object,
 * and flushes open frames to `unclosed` on raw `\n`/`\r` inside a string.
 */
function scanJsonObjectBraceMap(text: string): ContainerBraceMap {
  const matched = new Map<number, number>();
  const unclosed = new Set<number>();
  const stack: number[] = []; // >= 0: '{' open index, -1: nested '[' sentinel
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (code === 92) {
        escaped = true;
      } else if (code === 34) {
        inString = false;
      } else if (code === 10 || code === 13) {
        inString = false;
        for (let s = 0; s < stack.length; s++) {
          const openIdx = stack[s]!;
          if (openIdx >= 0) unclosed.add(openIdx);
        }
        stack.length = 0;
      }
      continue;
    }

    if (stack.length === 0) {
      if (code === 123 && isPlausibleJsonObjectStart(text, i)) {
        stack.push(i);
      }
      continue;
    }

    if (code === 34) {
      inString = true;
      escaped = false;
    } else if (code === 123) {
      stack.push(i);
    } else if (code === 91) {
      stack.push(-1);
    } else if (code === 93) {
      if (stack.length > 0 && stack[stack.length - 1] === -1) {
        stack.pop();
      }
    } else if (code === 125) {
      while (stack.length > 0 && stack[stack.length - 1] === -1) {
        stack.pop();
      }
      if (stack.length > 0) {
        const openIdx = stack.pop()!;
        matched.set(openIdx, i + 1);
      }
    }
  }

  for (let s = 0; s < stack.length; s++) {
    const openIdx = stack[s]!;
    if (openIdx >= 0) unclosed.add(openIdx);
  }
  return { matched, unclosed };
}

/**
 * Symmetric single-pass O(N) bracket matcher for embedded top-level `[...]` JSON arrays.
 * Isolated from `scanJsonObjectBraceMap` so prose `[` and `{` never cross-poison each other.
 */
function scanJsonArrayBracketMap(text: string): ContainerBraceMap {
  const matched = new Map<number, number>();
  const unclosed = new Set<number>();
  const stack: number[] = []; // >= 0: '[' open index, -1: nested '{' sentinel
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (code === 92) {
        escaped = true;
      } else if (code === 34) {
        inString = false;
      } else if (code === 10 || code === 13) {
        inString = false;
        for (let s = 0; s < stack.length; s++) {
          const openIdx = stack[s]!;
          if (openIdx >= 0) unclosed.add(openIdx);
        }
        stack.length = 0;
      }
      continue;
    }

    if (stack.length === 0) {
      if (code === 91 && isPlausibleJsonArrayStart(text, i)) {
        stack.push(i);
      }
      continue;
    }

    if (code === 34) {
      inString = true;
      escaped = false;
    } else if (code === 91) {
      stack.push(i);
    } else if (code === 123) {
      stack.push(-1);
    } else if (code === 125) {
      if (stack.length > 0 && stack[stack.length - 1] === -1) {
        stack.pop();
      }
    } else if (code === 93) {
      while (stack.length > 0 && stack[stack.length - 1] === -1) {
        stack.pop();
      }
      if (stack.length > 0) {
        const openIdx = stack.pop()!;
        matched.set(openIdx, i + 1);
      }
    }
  }

  for (let s = 0; s < stack.length; s++) {
    const openIdx = stack[s]!;
    if (openIdx >= 0) unclosed.add(openIdx);
  }
  return { matched, unclosed };
}

/**
 * Upstream `mark_unclosed_braces_before_fail` (`script_app.rs:3345-3386`), generalized
 * to track both `{` and `[` across the validated RFC 8259 prefix `[start, failAbs)`.
 */
function markUnclosedContainersBeforeFail(
  text: string,
  start: number,
  failAbs: number,
  failSkippedOpens: Set<number>,
): void {
  const end = Math.min(failAbs, text.length);
  if (start >= end) return;

  const openPosStack: number[] = [];
  const openCodeStack: number[] = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < end; i++) {
    const code = text.charCodeAt(i);
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (code === 92) {
        escaped = true;
      } else if (code === 34) {
        inString = false;
      } else if (code === 10 || code === 13) {
        inString = false;
      }
      continue;
    }
    if (code === 34) {
      inString = true;
      escaped = false;
    } else if (code === 123 || code === 91) {
      openPosStack.push(i);
      openCodeStack.push(code);
    } else if (code === 125) {
      if (openCodeStack.length > 0 && openCodeStack[openCodeStack.length - 1] === 123) {
        openPosStack.pop();
        openCodeStack.pop();
      }
    } else if (code === 93) {
      if (openCodeStack.length > 0 && openCodeStack[openCodeStack.length - 1] === 91) {
        openPosStack.pop();
        openCodeStack.pop();
      }
    }
  }

  for (let s = 0; s < openPosStack.length; s++) {
    failSkippedOpens.add(openPosStack[s]!);
  }
}

function hasFailPointInside(failPoints: readonly number[], start: number, end: number): boolean {
  const len = failPoints.length;
  if (len === 0 || failPoints[len - 1]! <= start) {
    return false;
  }
  let lo = 0;
  let hi = len;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (failPoints[mid]! <= start) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo < len && failPoints[lo]! < end;
}

function insertFailPointSorted(failPoints: number[], fp: number): void {
  const len = failPoints.length;
  if (len === 0 || fp > failPoints[len - 1]!) {
    failPoints.push(fp);
    return;
  }
  if (fp === failPoints[len - 1]!) return;
  let lo = 0;
  let hi = len;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (failPoints[mid]! < fp) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  if (lo >= len || failPoints[lo] !== fp) {
    failPoints.splice(lo, 0, fp);
  }
}

function isKvOuterBoundaryAt(text: string, idx: number, inUrlQuery: boolean): boolean {
  if (idx >= text.length) return true;
  const code = text.charCodeAt(idx);
  if (isWsCode(code)) return true;
  if (inUrlQuery && (code === 38 || code === 59 || code === 35)) {
    // '&' | ';' | '#'
    return true;
  }
  if (code === 44) {
    // ',' followed by EOF or whitespace
    return idx + 1 >= text.length || isWsCode(text.charCodeAt(idx + 1));
  }
  if (code === 41 || code === 93 || code === 125) {
    // ')' | ']' | '}'
    if (idx + 1 >= text.length) return true;
    const nextCode = text.charCodeAt(idx + 1);
    return (
      isWsCode(nextCode) ||
      nextCode === 44 ||
      (inUrlQuery && (nextCode === 38 || nextCode === 59 || nextCode === 35))
    );
  }
  return false;
}

const LONG_CACHE_SHIFT = 6; // block size = 64 (2^6)
const LONG_CACHE_THRESHOLD = 1 << LONG_CACHE_SHIFT; // 64

interface LongRunEntry {
  start: number;
  end: number;
  extra: number;
}

/**
 * Thrash-proof O(1) worst-case lookup cache for pairwise-disjoint maximal runs of length >= 64.
 * Every 64-index block `[64*b, 64*b + 63]` can intersect at most 2 disjoint intervals of length >= 64,
 * so `primary` + lazy `secondary` guarantee zero eviction, O(1) lookup for any arbitrary index inside
 * `[start, end)` / `[start, end]`, O(runLen / 64) insert, and O(N / 64) memory.
 */
interface LongRunCache {
  primary: Map<number, LongRunEntry>;
  secondary: Map<number, LongRunEntry> | null;
}

function createLongRunCache(): LongRunCache {
  return {
    primary: new Map(),
    secondary: null,
  };
}

function lookupHalfOpenLongRun(cache: LongRunCache, pos: number): LongRunEntry | undefined {
  const b = pos >>> LONG_CACHE_SHIFT;
  const p = cache.primary.get(b);
  if (p !== undefined && pos >= p.start && pos < p.end) {
    return p;
  }
  if (cache.secondary !== null) {
    const s = cache.secondary.get(b);
    if (s !== undefined && pos >= s.start && pos < s.end) {
      return s;
    }
  }
  return undefined;
}

function insertHalfOpenLongRun(cache: LongRunCache, entry: LongRunEntry): void {
  if (entry.end <= entry.start) return;
  const bStart = entry.start >>> LONG_CACHE_SHIFT;
  const bEnd = (entry.end - 1) >>> LONG_CACHE_SHIFT;
  for (let b = bStart; b <= bEnd; b++) {
    if (!cache.primary.has(b)) {
      cache.primary.set(b, entry);
    } else {
      if (cache.secondary === null) {
        cache.secondary = new Map();
      }
      cache.secondary.set(b, entry);
    }
  }
}

function lookupClosedLongRun(cache: LongRunCache, pos: number): LongRunEntry | undefined {
  const b = pos >>> LONG_CACHE_SHIFT;
  const p = cache.primary.get(b);
  if (p !== undefined && pos >= p.start && pos <= p.end) {
    return p;
  }
  if (cache.secondary !== null) {
    const s = cache.secondary.get(b);
    if (s !== undefined && pos >= s.start && pos <= s.end) {
      return s;
    }
  }
  return undefined;
}

function insertClosedLongRun(cache: LongRunCache, entry: LongRunEntry): void {
  if (entry.end < entry.start) return;
  const bStart = entry.start >>> LONG_CACHE_SHIFT;
  const bEnd = entry.end >>> LONG_CACHE_SHIFT;
  for (let b = bStart; b <= bEnd; b++) {
    if (!cache.primary.has(b)) {
      cache.primary.set(b, entry);
    } else {
      if (cache.secondary === null) {
        cache.secondary = new Map();
      }
      cache.secondary.set(b, entry);
    }
  }
}

function isQuoteTrailPunctOrHorizWsCode(c: number): boolean {
  return (
    isHorizWsCode(c) ||
    c === 46 || // '.'
    c === 44 || // ','
    c === 59 || // ';'
    c === 33 || // '!'
    c === 63 || // '?'
    c === 41 || // ')'
    c === 93 || // ']'
    c === 125 // '}'
  );
}

type FirstTokBraceKind = 'none' | 'placeholder' | 'kv_placeholder';

interface SameLineMemo {
  safeStart: number;
  safeEnd: number;
  safeStartFirstTokBraceKind: FirstTokBraceKind;
  failedLineStart: number;
  failedLineEnd: number;
  cachedLineStart: number;
  cachedLineEnd: number;
  longLineCache: LongRunCache | null;
  wsSkipStart: number;
  wsSkipEnd: number;
  longWsSkipCache: LongRunCache | null;
  quotePunctSkipStart: number;
  quotePunctSkipEnd: number;
  longQuotePunctSkipCache: LongRunCache | null;
}

function createSameLineMemo(): SameLineMemo {
  return {
    safeStart: 0,
    safeEnd: -1,
    safeStartFirstTokBraceKind: 'none',
    failedLineStart: 0,
    failedLineEnd: -1,
    cachedLineStart: 0,
    cachedLineEnd: -1,
    longLineCache: null,
    wsSkipStart: -1,
    wsSkipEnd: -1,
    longWsSkipCache: null,
    quotePunctSkipStart: -1,
    quotePunctSkipEnd: -1,
    longQuotePunctSkipCache: null,
  };
}

function selectModeMemo(
  isBearer: boolean,
  isBasic: boolean,
  bearerMemo: SameLineMemo,
  basicMemo: SameLineMemo,
  bothMemo: SameLineMemo,
): SameLineMemo {
  if (isBearer && !isBasic) return bearerMemo;
  if (isBasic && !isBearer) return basicMemo;
  return bothMemo;
}

function findLineStart(text: string, pos: number): number {
  let idx = pos;
  while (idx > 0) {
    const c = text.charCodeAt(idx - 1);
    if (c === 10 || c === 13) break;
    idx--;
  }
  return idx;
}

function findLineEnd(text: string, from: number): number {
  let idx = from;
  while (idx < text.length) {
    const c = text.charCodeAt(idx);
    if (c === 10 || c === 13) break;
    idx++;
  }
  return idx;
}

interface SegQueryResult {
  isSensitive: boolean;
  hasBearer: boolean;
  hasBasic: boolean;
}

interface SegRangeArrays {
  // Interleaved [start0, end0, start1, end1, ...] sorted by start ascending
  singleSensitive: number[];
  pairSensitive: number[];
  bearerSegs: number[];
  basicSegs: number[];
}

interface LineSegIndex extends SegRangeArrays {
  lineStart: number;
  lineEnd: number;
  // Interleaved [escStart0, escEnd0, ...] of valid RFC 8259 escapes within [lineStart, lineEnd)
  validEscapeSpans: number[];
  // Lazily populated ONLY if !cleanStart || !cleanEnd ever occurs
  allSegBounds: number[] | null;
}

interface UnescapedLineSegIndex extends SegRangeArrays {
  lineStart: number;
  lineEnd: number;
  // Unescaped UTF-16 code units of text.slice(lineStart, lineEnd)
  uChars: Uint16Array;
  uLen: number;
  // Strictly increasing raw offsets: rawStart[u]..rawStart[u+1] is raw span of uChars[u]; rawStart[uLen] = lineEnd
  rawStart: Int32Array;
  // Lazily populated ONLY if a straddling escape or mid-segment boundary occurs
  uSegBounds: number[] | null;
}

function validJsonEscapeLenAt(text: string, pos: number, end: number): number {
  if (pos + 1 >= end || text.charCodeAt(pos) !== 92) return 0;
  const next = text.charCodeAt(pos + 1);
  switch (next) {
    case 34: // '"'
    case 92: // '\\'
    case 47: // '/'
    case 98: // 'b'
    case 102: // 'f'
    case 110: // 'n'
    case 114: // 'r'
    case 116: // 't'
      return 2;
    case 117: // 'u'
      if (
        pos + 5 < end &&
        hexNibble(text.charCodeAt(pos + 2)) >= 0 &&
        hexNibble(text.charCodeAt(pos + 3)) >= 0 &&
        hexNibble(text.charCodeAt(pos + 4)) >= 0 &&
        hexNibble(text.charCodeAt(pos + 5)) >= 0
      ) {
        return 6;
      }
      return 0;
    default:
      return 0;
  }
}

function decodeJsonEscapeAt(
  text: string,
  pos: number,
  end: number,
): { code: number; len: number } | null {
  if (pos + 1 >= end || text.charCodeAt(pos) !== 92) return null;
  const next = text.charCodeAt(pos + 1);
  switch (next) {
    case 34:
      return { code: 34, len: 2 };
    case 92:
      return { code: 92, len: 2 };
    case 47:
      return { code: 47, len: 2 };
    case 98:
      return { code: 8, len: 2 };
    case 102:
      return { code: 12, len: 2 };
    case 110:
      return { code: 10, len: 2 };
    case 114:
      return { code: 13, len: 2 };
    case 116:
      return { code: 9, len: 2 };
    case 117:
      if (pos + 5 < end) {
        const h0 = hexNibble(text.charCodeAt(pos + 2));
        const h1 = hexNibble(text.charCodeAt(pos + 3));
        const h2 = hexNibble(text.charCodeAt(pos + 4));
        const h3 = hexNibble(text.charCodeAt(pos + 5));
        if (h0 >= 0 && h1 >= 0 && h2 >= 0 && h3 >= 0) {
          return { code: (h0 << 12) | (h1 << 8) | (h2 << 4) | h3, len: 6 };
        }
      }
      return null;
    default:
      return null;
  }
}

function buildLineSegIndex(text: string, lineStart: number, lineEnd: number): LineSegIndex {
  const singleSensitive: number[] = [];
  const pairSensitive: number[] = [];
  const bearerSegs: number[] = [];
  const basicSegs: number[] = [];

  let cur = '';
  let curStart = lineStart;
  let prevSeg = '';
  let prevStart = lineStart;
  let hasPrev = false;

  const flushSeg = (segEnd: number): void => {
    if (cur.length === 0) return;
    if (SENSITIVE_SINGLE_SEGMENTS.has(cur)) {
      singleSensitive.push(curStart, segEnd);
    }
    if (cur === 'bearer') {
      bearerSegs.push(curStart, segEnd);
    } else if (cur === 'basic') {
      basicSegs.push(curStart, segEnd);
    }
    if (hasPrev && SENSITIVE_PAIR_SEGMENTS.has(`${prevSeg}:${cur}`)) {
      pairSensitive.push(prevStart, segEnd);
    }
    prevSeg = cur;
    prevStart = curStart;
    hasPrev = true;
    cur = '';
  };

  for (let i = lineStart; i < lineEnd; i++) {
    const code = text.charCodeAt(i);
    if (!isAsciiAlnumCode(code)) {
      flushSeg(i);
      continue;
    }
    if (cur.length > 0) {
      const prev = text.charCodeAt(i - 1);
      if (isAsciiUpperCode(code)) {
        const nextIsLower = i + 1 < lineEnd && isAsciiLowerCode(text.charCodeAt(i + 1));
        if (
          isAsciiLowerCode(prev) ||
          isAsciiDigitCode(prev) ||
          (isAsciiUpperCode(prev) && nextIsLower)
        ) {
          flushSeg(i);
          curStart = i;
        }
      } else if (
        (isAsciiDigitCode(code) && isAsciiAlphaCode(prev)) ||
        (isAsciiLowerCode(code) && isAsciiDigitCode(prev))
      ) {
        flushSeg(i);
        curStart = i;
      }
    } else {
      curStart = i;
    }
    cur += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : text[i]!;
  }
  flushSeg(lineEnd);

  const validEscapeSpans: number[] = [];
  let escPos = text.indexOf('\\', lineStart);
  while (escPos >= 0 && escPos < lineEnd) {
    const escLen = validJsonEscapeLenAt(text, escPos, lineEnd);
    if (escLen > 0) {
      validEscapeSpans.push(escPos, escPos + escLen);
      escPos = text.indexOf('\\', escPos + escLen);
    } else {
      escPos = text.indexOf('\\', escPos + 1);
    }
  }

  return {
    lineStart,
    lineEnd,
    singleSensitive,
    pairSensitive,
    bearerSegs,
    basicSegs,
    validEscapeSpans,
    allSegBounds: null,
  };
}

function buildUnescapedLineSegIndex(
  text: string,
  lineStart: number,
  lineEnd: number,
): UnescapedLineSegIndex {
  const maxLen = lineEnd - lineStart;
  const uChars = new Uint16Array(maxLen);
  const rawStart = new Int32Array(maxLen + 1);
  let uLen = 0;
  let p = lineStart;
  while (p < lineEnd) {
    if (text.charCodeAt(p) === 92) {
      const esc = decodeJsonEscapeAt(text, p, lineEnd);
      if (esc !== null) {
        rawStart[uLen] = p;
        uChars[uLen++] = esc.code;
        p += esc.len;
        continue;
      }
    }
    rawStart[uLen] = p;
    uChars[uLen++] = text.charCodeAt(p);
    p++;
  }
  rawStart[uLen] = lineEnd;

  const singleSensitive: number[] = [];
  const pairSensitive: number[] = [];
  const bearerSegs: number[] = [];
  const basicSegs: number[] = [];

  let cur = '';
  let curStartU = 0;
  let prevSeg = '';
  let prevStartU = 0;
  let hasPrev = false;

  const flushSeg = (segEndU: number): void => {
    if (cur.length === 0) return;
    const rs = rawStart[curStartU]!;
    const re = rawStart[segEndU]!;
    if (SENSITIVE_SINGLE_SEGMENTS.has(cur)) {
      singleSensitive.push(rs, re);
    }
    if (cur === 'bearer') {
      bearerSegs.push(rs, re);
    } else if (cur === 'basic') {
      basicSegs.push(rs, re);
    }
    if (hasPrev && SENSITIVE_PAIR_SEGMENTS.has(`${prevSeg}:${cur}`)) {
      pairSensitive.push(rawStart[prevStartU]!, re);
    }
    prevSeg = cur;
    prevStartU = curStartU;
    hasPrev = true;
    cur = '';
  };

  for (let i = 0; i < uLen; i++) {
    const code = uChars[i]!;
    if (!isAsciiAlnumCode(code)) {
      flushSeg(i);
      continue;
    }
    if (cur.length > 0) {
      const prev = uChars[i - 1]!;
      if (isAsciiUpperCode(code)) {
        const nextIsLower = i + 1 < uLen && isAsciiLowerCode(uChars[i + 1]!);
        if (
          isAsciiLowerCode(prev) ||
          isAsciiDigitCode(prev) ||
          (isAsciiUpperCode(prev) && nextIsLower)
        ) {
          flushSeg(i);
          curStartU = i;
        }
      } else if (
        (isAsciiDigitCode(code) && isAsciiAlphaCode(prev)) ||
        (isAsciiLowerCode(code) && isAsciiDigitCode(prev))
      ) {
        flushSeg(i);
        curStartU = i;
      }
    } else {
      curStartU = i;
    }
    cur += String.fromCharCode(code >= 65 && code <= 90 ? code + 32 : code);
  }
  flushSeg(uLen);

  return {
    lineStart,
    lineEnd,
    uChars,
    uLen,
    rawStart,
    singleSensitive,
    pairSensitive,
    bearerSegs,
    basicSegs,
    uSegBounds: null,
  };
}

function lineSegContainsRange(
  ranges: readonly number[],
  keyStart: number,
  keyEnd: number,
): boolean {
  let lo = 0;
  let hi = ranges.length >>> 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ranges[mid << 1]! < keyStart) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const idx = lo << 1;
  return idx < ranges.length && ranges[idx]! >= keyStart && ranges[idx + 1]! <= keyEnd;
}

function queryLineSegIndex(idx: SegRangeArrays, keyStart: number, keyEnd: number): SegQueryResult {
  return {
    isSensitive:
      lineSegContainsRange(idx.singleSensitive, keyStart, keyEnd) ||
      lineSegContainsRange(idx.pairSensitive, keyStart, keyEnd),
    hasBearer: lineSegContainsRange(idx.bearerSegs, keyStart, keyEnd),
    hasBasic: lineSegContainsRange(idx.basicSegs, keyStart, keyEnd),
  };
}

function buildSegBoundsFromCodes(len: number, codeAt: (i: number) => number): number[] {
  const bounds: number[] = [];
  let inSeg = false;
  let curStart = 0;
  for (let i = 0; i < len; i++) {
    const code = codeAt(i);
    if (!isAsciiAlnumCode(code)) {
      if (inSeg) {
        bounds.push(curStart, i);
        inSeg = false;
      }
      continue;
    }
    if (inSeg) {
      const prev = codeAt(i - 1);
      if (isAsciiUpperCode(code)) {
        const nextIsLower = i + 1 < len && isAsciiLowerCode(codeAt(i + 1));
        if (
          isAsciiLowerCode(prev) ||
          isAsciiDigitCode(prev) ||
          (isAsciiUpperCode(prev) && nextIsLower)
        ) {
          bounds.push(curStart, i);
          curStart = i;
        }
      } else if (
        (isAsciiDigitCode(code) && isAsciiAlphaCode(prev)) ||
        (isAsciiLowerCode(code) && isAsciiDigitCode(prev))
      ) {
        bounds.push(curStart, i);
        curStart = i;
      }
    } else {
      curStart = i;
      inSeg = true;
    }
  }
  if (inSeg) {
    bounds.push(curStart, len);
  }
  return bounds;
}

function findFirstSegEndingAfter(bounds: readonly number[], pos: number): number {
  let lo = 0;
  let hi = bounds.length >>> 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bounds[(mid << 1) + 1]! <= pos) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function findLastSegStartingBefore(bounds: readonly number[], pos: number): number {
  let lo = 0;
  let hi = bounds.length >>> 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bounds[mid << 1]! < pos) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo - 1;
}

function lowerBoundInt32(arr: Int32Array, len: number, target: number): number {
  let lo = 0;
  let hi = len;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! < target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function readRawSliceFromCodes(codeAt: (i: number) => number, start: number, end: number): string {
  let out = '';
  for (let i = start; i < end; i++) {
    out += String.fromCharCode(codeAt(i));
  }
  return out;
}

function readLowerSliceFromCodes(codeAt: (i: number) => number, start: number, end: number): string {
  let out = '';
  for (let i = start; i < end; i++) {
    const c = codeAt(i);
    out += String.fromCharCode(c >= 65 && c <= 90 ? c + 32 : c);
  }
  return out;
}

function classifySmallSegmentsInto(segs: readonly string[], acc: SegQueryResult): void {
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    if (SENSITIVE_SINGLE_SEGMENTS.has(seg)) acc.isSensitive = true;
    if (seg === 'bearer') acc.hasBearer = true;
    else if (seg === 'basic') acc.hasBasic = true;
    if (i > 0 && SENSITIVE_PAIR_SEGMENTS.has(`${segs[i - 1]!}:${seg}`)) {
      acc.isSensitive = true;
    }
  }
}

function querySegIndexWithBoundary(
  idx: SegRangeArrays,
  seqLen: number,
  codeAt: (i: number) => number,
  bounds: readonly number[],
  toRaw: (u: number) => number,
  qStart: number,
  qEnd: number,
  cleanStart: boolean,
  cleanEnd: boolean,
  headPrefix: string,
): SegQueryResult {
  const acc: SegQueryResult = { isSensitive: false, hasBearer: false, hasBasic: false };
  if (qStart >= qEnd) {
    if (headPrefix.length > 0) {
      classifySmallSegmentsInto(splitKeySegments(headPrefix), acc);
    }
    return acc;
  }
  if (qEnd - qStart <= 32) {
    classifySmallSegmentsInto(
      splitKeySegments(headPrefix + readRawSliceFromCodes(codeAt, qStart, qEnd)),
      acc,
    );
    return acc;
  }

  const segCount = bounds.length >>> 1;
  let innerStart = qStart;
  let innerEnd = qEnd;
  let leftSegs: string[] = [];
  let leftNextIdx = -1;
  let rightSegs: string[] = [];
  let rightPrevIdx = -1;

  if (!cleanStart || headPrefix.length > 0) {
    const k = findFirstSegEndingAfter(bounds, qStart);
    if (k < segCount) {
      const sk = bounds[k << 1]!;
      const ek = bounds[(k << 1) + 1]!;
      if (sk <= qStart && sk < qEnd) {
        const leftEnd = Math.min(ek, qEnd);
        if (leftEnd - qStart <= 16) {
          leftSegs = splitKeySegments(headPrefix + readRawSliceFromCodes(codeAt, qStart, leftEnd));
          classifySmallSegmentsInto(leftSegs, acc);
        }
        leftNextIdx = k + 1;
        innerStart = leftEnd;
      } else if (headPrefix.length > 0) {
        leftSegs = splitKeySegments(headPrefix);
        classifySmallSegmentsInto(leftSegs, acc);
        leftNextIdx = k;
      }
    } else if (headPrefix.length > 0) {
      leftSegs = splitKeySegments(headPrefix);
      classifySmallSegmentsInto(leftSegs, acc);
    }
  }

  if (!cleanEnd && innerStart < qEnd) {
    const m = findLastSegStartingBefore(bounds, qEnd);
    if (m >= 0) {
      const sm = bounds[m << 1]!;
      const em = bounds[(m << 1) + 1]!;
      const mergesWithPrevUpper =
        m > 0 &&
        qEnd === sm + 1 &&
        bounds[((m - 1) << 1) + 1] === sm &&
        bounds[(m - 1) << 1]! >= innerStart &&
        isAsciiUpperCode(codeAt(sm)) &&
        qEnd < seqLen &&
        isAsciiLowerCode(codeAt(qEnd));
      if (em > qEnd || mergesWithPrevUpper) {
        const rightStart = mergesWithPrevUpper
          ? bounds[(m - 1) << 1]!
          : Math.max(sm, innerStart);
        rightPrevIdx = mergesWithPrevUpper ? m - 2 : m - 1;
        if (qEnd - rightStart <= 16) {
          rightSegs = splitKeySegments(readRawSliceFromCodes(codeAt, rightStart, qEnd));
          classifySmallSegmentsInto(rightSegs, acc);
        }
        innerEnd = rightStart;
      }
    }
  }

  // Cross-boundary pair: left -> first interior segment (or right boundary if no interior segment)
  if (!acc.isSensitive && leftSegs.length > 0) {
    const leftLast = leftSegs[leftSegs.length - 1]!;
    if (PAIR_FIRST_SEGMENTS.has(leftLast)) {
      if (leftNextIdx >= 0 && leftNextIdx < segCount && bounds[leftNextIdx << 1]! < innerEnd) {
        const ns = bounds[leftNextIdx << 1]!;
        const ne = bounds[(leftNextIdx << 1) + 1]!;
        if (ne <= innerEnd && ne - ns <= 7) {
          if (SENSITIVE_PAIR_SEGMENTS.has(`${leftLast}:${readLowerSliceFromCodes(codeAt, ns, ne)}`)) {
            acc.isSensitive = true;
          }
        }
      } else if (rightSegs.length > 0) {
        if (SENSITIVE_PAIR_SEGMENTS.has(`${leftLast}:${rightSegs[0]!}`)) {
          acc.isSensitive = true;
        }
      }
    }
  }

  // Cross-boundary pair: last interior segment -> right boundary
  if (!acc.isSensitive && rightSegs.length > 0 && rightPrevIdx >= 0 && rightPrevIdx < segCount) {
    const ps = bounds[rightPrevIdx << 1]!;
    const pe = bounds[(rightPrevIdx << 1) + 1]!;
    if (ps >= innerStart && pe <= innerEnd && pe - ps <= 7) {
      if (SENSITIVE_PAIR_SEGMENTS.has(`${readLowerSliceFromCodes(codeAt, ps, pe)}:${rightSegs[0]!}`)) {
        acc.isSensitive = true;
      }
    }
  }

  // Interior O(log L) query
  if (innerStart < innerEnd) {
    const q = queryLineSegIndex(idx, toRaw(innerStart), toRaw(innerEnd));
    if (q.isSensitive) acc.isSensitive = true;
    if (q.hasBearer) acc.hasBearer = true;
    if (q.hasBasic) acc.hasBasic = true;
  }
  return acc;
}

function isSpanTrimmedBearerOrBasic(text: string, start: number, end: number): boolean {
  let s = start;
  while (s < end && isWsCode(text.charCodeAt(s))) s++;
  let e = end;
  while (e > s && isWsCode(text.charCodeAt(e - 1))) e--;
  const len = e - s;
  if (len === 6) return matchesAsciiIgnoreCaseAt(text, s, 'bearer');
  if (len === 5) return matchesAsciiIgnoreCaseAt(text, s, 'basic');
  return false;
}

function isUnescapedSpanTrimmedBearerOrBasic(
  uIdx: UnescapedLineSegIndex,
  uStart: number,
  uEnd: number,
): boolean {
  const { uChars } = uIdx;
  let s = uStart;
  while (s < uEnd && isWsCode(uChars[s]!)) s++;
  let e = uEnd;
  while (e > s && isWsCode(uChars[e - 1]!)) e--;
  const len = e - s;
  if (len !== 5 && len !== 6) return false;
  const target = len === 6 ? 'bearer' : 'basic';
  for (let i = 0; i < len; i++) {
    let c = uChars[s + i]!;
    if (c >= 65 && c <= 90) c += 32;
    if (c !== target.charCodeAt(i)) return false;
  }
  return true;
}

function queryRawLineSegIndex(
  text: string,
  idx: LineSegIndex,
  sliceStart: number,
  sliceEnd: number,
): SegQueryResult {
  const { lineStart, lineEnd } = idx;
  const cleanStart =
    sliceStart === lineStart ||
    !isAsciiAlnumCode(text.charCodeAt(sliceStart - 1)) ||
    !isAsciiAlnumCode(text.charCodeAt(sliceStart));
  const cleanEnd =
    sliceEnd === lineEnd ||
    !isAsciiAlnumCode(text.charCodeAt(sliceEnd - 1)) ||
    !isAsciiAlnumCode(text.charCodeAt(sliceEnd));
  if (cleanStart && cleanEnd) {
    return queryLineSegIndex(idx, sliceStart, sliceEnd);
  }
  const seqLen = lineEnd - lineStart;
  const codeAt = (i: number): number => text.charCodeAt(lineStart + i);
  if (idx.allSegBounds === null) {
    idx.allSegBounds = buildSegBoundsFromCodes(seqLen, codeAt);
  }
  return querySegIndexWithBoundary(
    idx,
    seqLen,
    codeAt,
    idx.allSegBounds,
    (u) => lineStart + u,
    sliceStart - lineStart,
    sliceEnd - lineStart,
    cleanStart,
    cleanEnd,
    '',
  );
}

function queryUnescapedLineSegIndex(
  text: string,
  uIdx: UnescapedLineSegIndex,
  sliceStart: number,
  sliceEnd: number,
): { query: SegQueryResult; isBareBearerOrBasic: boolean } {
  const uStart = lowerBoundInt32(uIdx.rawStart, uIdx.uLen + 1, sliceStart);
  const uEnd = lowerBoundInt32(uIdx.rawStart, uIdx.uLen + 1, sliceEnd);
  const exactStart = uStart < uIdx.uLen && uIdx.rawStart[uStart] === sliceStart;
  const exactEnd = uEnd <= uIdx.uLen && uIdx.rawStart[uEnd] === sliceEnd;
  const uCleanStart =
    exactStart &&
    (uStart === 0 ||
      !isAsciiAlnumCode(uIdx.uChars[uStart - 1]!) ||
      !isAsciiAlnumCode(uIdx.uChars[uStart]!));
  const uCleanEnd =
    exactEnd &&
    (uEnd === uIdx.uLen ||
      !isAsciiAlnumCode(uIdx.uChars[uEnd - 1]!) ||
      !isAsciiAlnumCode(uIdx.uChars[uEnd]!));

  let query: SegQueryResult;
  if (uCleanStart && uCleanEnd) {
    query = queryLineSegIndex(uIdx, sliceStart, sliceEnd);
  } else {
    const codeAt = (i: number): number => uIdx.uChars[i]!;
    if (uIdx.uSegBounds === null) {
      uIdx.uSegBounds = buildSegBoundsFromCodes(uIdx.uLen, codeAt);
    }
    const headPrefix = !exactStart
      ? text.slice(sliceStart, Math.min(uIdx.rawStart[uStart]!, sliceEnd))
      : '';
    const adjUEnd = !exactEnd && uEnd > 0 ? uEnd - 1 : uEnd;
    query = querySegIndexWithBoundary(
      uIdx,
      uIdx.uLen,
      codeAt,
      uIdx.uSegBounds,
      (u) => uIdx.rawStart[u]!,
      uStart,
      adjUEnd,
      uCleanStart,
      uCleanEnd,
      headPrefix,
    );
  }
  const isBareBearerOrBasic =
    exactStart &&
    exactEnd &&
    !query.isSensitive &&
    (query.hasBearer || query.hasBasic) &&
    isUnescapedSpanTrimmedBearerOrBasic(uIdx, uStart, uEnd);
  return { query, isBareBearerOrBasic };
}

interface QuoteCheckpoint {
  quoteCode: number;
  subOrDotsLen: number;
  tightSubOrDotsLen: number;
  chainBreaksLen: number;
  proseBreaksLen: number;
  lbracksLen: number;
  quotesLen: number;
}

interface KvLineScanMemo {
  lineStart: number;
  scannedTo: number;
  consecutiveBackslashes: number;
  quoteStack: QuoteCheckpoint[];
  dquotes: number[];
  squotes: number[];
  // Upstream memoized backward findOpenBracket tables (`script_app.rs:4565-4569`)
  matchedRbrackJump: Map<number, number>;
  unmatchedRbrack: Set<number>;
  endedInQuoteRbrack: Set<number>;
  matchedRbrackJumpNoQuote: Map<number, number>;
  unmatchedRbrackNoQuote: Set<number>;
  rbrackWorkStack: number[];
  // Run collapser for contiguous '[' runs (`script_app.rs:4570-4571`)
  curLbrackRunStart: number;
  lbrackRuns: number[]; // interleaved [start, end, ...]
  subRootCache: Map<number, number>; // ck -> (cursor * 2 + (allowRootBracket ? 1 : 0))
  lineSubOrDots: number[];
  lineTightSubOrDots: number[];
  lineChainBreaks: number[];
  lineProseBreaks: number[];
  lineLbracks: number[];
  lineAllLbracks: number[]; // quote-immune '[' positions on current line for isAuthHeaderSpan
  lineQuotes: number[];
  lastAuthSliceStart: number;
  lastAuthBaseEnd: number;
  lastAuthResult: boolean;
  longAuthTrimCache: LongRunCache | null;
  longHorizWsCache: LongRunCache | null;
  lineHasUrlScheme: boolean;
  lineSegIndex: LineSegIndex | null;
  unescapedLineSegIndex: UnescapedLineSegIndex | null;
}

function createKvLineScanMemo(): KvLineScanMemo {
  return {
    lineStart: 0,
    scannedTo: 0,
    consecutiveBackslashes: 0,
    quoteStack: [],
    dquotes: [],
    squotes: [],
    matchedRbrackJump: new Map(),
    unmatchedRbrack: new Set(),
    endedInQuoteRbrack: new Set(),
    matchedRbrackJumpNoQuote: new Map(),
    unmatchedRbrackNoQuote: new Set(),
    rbrackWorkStack: [],
    curLbrackRunStart: -1,
    lbrackRuns: [],
    subRootCache: new Map(),
    lineSubOrDots: [],
    lineTightSubOrDots: [],
    lineChainBreaks: [],
    lineProseBreaks: [],
    lineLbracks: [],
    lineAllLbracks: [],
    lineQuotes: [],
    lastAuthSliceStart: -1,
    lastAuthBaseEnd: -1,
    lastAuthResult: false,
    longAuthTrimCache: null,
    longHorizWsCache: null,
    lineHasUrlScheme: false,
    lineSegIndex: null,
    unescapedLineSegIndex: null,
  };
}

function lastBeforeSorted(sorted: readonly number[], pos: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < pos) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo > 0 ? sorted[lo - 1]! : -1;
}

function firstAtOrAfterSorted(sorted: readonly number[], pos: number): number {
  const len = sorted.length;
  if (len === 0 || sorted[len - 1]! < pos) return -1;
  let lo = 0;
  let hi = len;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < pos) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo < len ? sorted[lo]! : -1;
}

function runFirstInList(curStart: number, runs: readonly number[], pos: number): number {
  if (curStart >= 0 && pos >= curStart) return curStart;
  let lo = 0;
  let hi = runs.length >>> 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (runs[mid << 1]! <= pos) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  if (lo > 0) {
    const base = (lo - 1) << 1;
    const s = runs[base]!;
    const e = runs[base + 1]!;
    if (pos < e) return s;
  }
  return -1;
}

function advanceKvLineMemo(memo: KvLineScanMemo, text: string, target: number): void {
  const limit = Math.min(target, text.length);
  while (memo.scannedTo < limit) {
    const i = memo.scannedTo;
    const c = text.charCodeAt(i);
    if (c === 10 || c === 13) {
      memo.lineStart = i + 1;
      memo.consecutiveBackslashes = 0;
      memo.quoteStack.length = 0;
      memo.dquotes.length = 0;
      memo.squotes.length = 0;
      memo.matchedRbrackJump.clear();
      memo.unmatchedRbrack.clear();
      memo.endedInQuoteRbrack.clear();
      memo.matchedRbrackJumpNoQuote.clear();
      memo.unmatchedRbrackNoQuote.clear();
      memo.rbrackWorkStack.length = 0;
      memo.curLbrackRunStart = -1;
      memo.lbrackRuns.length = 0;
      memo.subRootCache.clear();
      memo.lineSubOrDots.length = 0;
      memo.lineTightSubOrDots.length = 0;
      memo.lineChainBreaks.length = 0;
      memo.lineProseBreaks.length = 0;
      memo.lineLbracks.length = 0;
      memo.lineAllLbracks.length = 0;
      memo.lineQuotes.length = 0;
      memo.lastAuthSliceStart = -1;
      memo.lastAuthBaseEnd = -1;
      memo.lastAuthResult = false;
      memo.longAuthTrimCache = null;
      memo.longHorizWsCache = null;
      memo.lineHasUrlScheme = false;
      memo.lineSegIndex = null;
      memo.unescapedLineSegIndex = null;
      memo.scannedTo = i + 1;
      continue;
    }

    const isUnescaped = (memo.consecutiveBackslashes & 1) === 0;
    if (c === 92) {
      memo.consecutiveBackslashes++;
    } else {
      memo.consecutiveBackslashes = 0;
    }

    // Track '[' runs (`script_app.rs:4611-4622`) + quote-immune lineAllLbracks
    if (c === 91) {
      if (memo.curLbrackRunStart < 0) memo.curLbrackRunStart = i;
      memo.lineLbracks.push(i);
      memo.lineAllLbracks.push(i);
    } else if (c !== 32 && c !== 9) {
      if (memo.curLbrackRunStart >= 0) {
        if (i - memo.curLbrackRunStart >= 8) {
          memo.lbrackRuns.push(memo.curLbrackRunStart, i);
        }
        memo.curLbrackRunStart = -1;
      }
    }

    // Quote checkpoint stack & chain markers (exact upstream script_app.rs:4623-4700)
    if ((c === 34 || c === 39) && isUnescaped) {
      if (c === 34) memo.dquotes.push(i);
      else memo.squotes.push(i);

      let matchIdx = -1;
      for (let k = memo.quoteStack.length - 1; k >= 0; k--) {
        if (memo.quoteStack[k]!.quoteCode === c) {
          matchIdx = k;
          break;
        }
      }
      if (matchIdx >= 0) {
        const cp = memo.quoteStack[matchIdx]!;
        memo.quoteStack.length = matchIdx;
        memo.lineSubOrDots.length = cp.subOrDotsLen;
        memo.lineTightSubOrDots.length = cp.tightSubOrDotsLen;
        memo.lineChainBreaks.length = cp.chainBreaksLen;
        memo.lineProseBreaks.length = cp.proseBreaksLen;
        memo.lineLbracks.length = cp.lbracksLen;
        memo.lineQuotes.length = cp.quotesLen;
        memo.lineQuotes.push(i);
        if (i + 1 < text.length) {
          const nc = text.charCodeAt(i + 1);
          if (isKvIdentCharCode(nc) || nc === 91) {
            memo.lineSubOrDots.push(i);
            memo.lineTightSubOrDots.push(i);
          }
        }
      } else {
        if (i > memo.lineStart) {
          const pc = text.charCodeAt(i - 1);
          if (
            isKvIdentCharCode(pc) ||
            pc === 93 ||
            pc === 46 ||
            pc === 91 ||
            pc === 34 ||
            pc === 39
          ) {
            memo.lineSubOrDots.push(i);
            memo.lineTightSubOrDots.push(i);
          }
        }
        memo.quoteStack.push({
          quoteCode: c,
          subOrDotsLen: memo.lineSubOrDots.length,
          tightSubOrDotsLen: memo.lineTightSubOrDots.length,
          chainBreaksLen: memo.lineChainBreaks.length,
          proseBreaksLen: memo.lineProseBreaks.length,
          lbracksLen: memo.lineLbracks.length,
          quotesLen: memo.lineQuotes.length,
        });
      }
    } else if (c === 93) {
      memo.lineSubOrDots.push(i);
      memo.lineTightSubOrDots.push(i);
    } else if (c === 46) {
      const nextIsWs =
        i + 1 < text.length && (text.charCodeAt(i + 1) === 32 || text.charCodeAt(i + 1) === 9);
      memo.lineSubOrDots.push(i);
      if (nextIsWs) {
        memo.lineProseBreaks.push(i);
      } else {
        memo.lineTightSubOrDots.push(i);
      }
    } else if (
      c === 61 || // '='
      c === 58 || // ':'
      c === 44 || // ','
      c === 59 || // ';'
      c === 38 || // '&'
      c === 63 || // '?'
      c === 35 || // '#'
      c === 47 // '/'
    ) {
      memo.lineChainBreaks.push(i);
      if (
        c === 47 &&
        !memo.lineHasUrlScheme &&
        i > memo.lineStart &&
        text.charCodeAt(i - 1) === 47
      ) {
        const prefLen = i + 1 - memo.lineStart;
        if (
          (prefLen >= 7 && matchesAsciiIgnoreCaseAt(text, i - 6, 'http://')) ||
          (prefLen >= 8 && matchesAsciiIgnoreCaseAt(text, i - 7, 'https://'))
        ) {
          memo.lineHasUrlScheme = true;
        }
      }
    }

    memo.scannedTo = i + 1;
  }
}

function hasSubOrDotInCurChain(memo: KvLineScanMemo, pos: number): boolean {
  const m = lastBeforeSorted(memo.lineSubOrDots, pos);
  if (m < 0) return false;
  const b = lastBeforeSorted(memo.lineChainBreaks, pos);
  return b < 0 || m > b;
}

function hasTightSubOrDotInCurChain(memo: KvLineScanMemo, pos: number): boolean {
  const m = lastBeforeSorted(memo.lineTightSubOrDots, pos);
  if (m < 0) return false;
  const b = Math.max(
    lastBeforeSorted(memo.lineChainBreaks, pos),
    lastBeforeSorted(memo.lineProseBreaks, pos),
  );
  return b < 0 || m > b;
}

function hasQuoteLbrackOrProseDotInCurChain(memo: KvLineScanMemo, pos: number): boolean {
  const m = Math.max(
    lastBeforeSorted(memo.lineQuotes, pos),
    lastBeforeSorted(memo.lineLbracks, pos),
    lastBeforeSorted(memo.lineProseBreaks, pos),
  );
  if (m < 0) return false;
  const b = lastBeforeSorted(memo.lineChainBreaks, pos);
  return b < 0 || m > b;
}

interface ExtractedKvKeySpan {
  keyStart: number; // Start of full key expression (including opening quote if quoted) for URL/host checks
  sliceStart: number; // Start of key text for sensitivity classification
  sliceEnd: number; // End of key text for sensitivity classification
}

function trimHorizWsEnd(text: string, minPos: number, endPos: number): number {
  let e = endPos;
  while (e > minPos && isHorizWsCode(text.charCodeAt(e - 1))) {
    e--;
  }
  return e;
}

function isSafeH4ProseRhsAt(
  text: string,
  afterSepStart: number,
  trimmedLineEnd: number,
): boolean {
  let s = afterSepStart;
  while (s < trimmedLineEnd && isHorizWsCode(text.charCodeAt(s))) s++;
  let e = trimmedLineEnd;
  if (s >= e) return false;
  if (text.charCodeAt(e - 1) === 46) e--;
  const len = e - s;
  if (len === 0 || len > 3) return false;
  for (let i = s; i < e; i++) {
    if (!isAsciiAlphaCode(text.charCodeAt(i))) return false;
  }
  return true;
}

const BRACKET_UNMATCHED = -1;
const BRACKET_ENDED_IN_QUOTE = -2;
const QUOTE_ESCAPED = -2;

/**
 * Looks up `quotePos` in sorted unescaped quote list `qList` (current line only).
 * Returns:
 * - `QUOTE_ESCAPED` (`-2`) if `quotePos` is escaped (not in `qList`)
 * - `-1` if `quotePos` is the first unescaped quote of its kind on the line (`qList[0]`)
 * - `qList[found - 1]` (`>= 0`) otherwise
 */
function findPrevUnescapedQuoteInList(qList: readonly number[], quotePos: number): number {
  let lo = 0;
  let hi = qList.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = qList[mid]!;
    if (v === quotePos) {
      return mid > 0 ? qList[mid - 1]! : -1;
    }
    if (v < quotePos) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return QUOTE_ESCAPED;
}

function isKnownUnmatchedRbrack(memo: KvLineScanMemo, pos: number): boolean {
  return (
    memo.unmatchedRbrack.has(pos) ||
    (memo.endedInQuoteRbrack.has(pos) && memo.unmatchedRbrackNoQuote.has(pos))
  );
}

/**
 * Memoized backward bracket matcher matching upstream `script_app.rs:4820-4895` (`find_open_bracket`)
 * with exact intermediate `]` stack memoization + direct quote jumps for strict O(N) total time
 * across an entire line.
 */
function findOpenBracket(
  text: string,
  closePos: number,
  respectQuotes: boolean,
  memo: KvLineScanMemo,
): number {
  if (respectQuotes) {
    const cached = memo.matchedRbrackJump.get(closePos);
    if (cached !== undefined) return cached;
    if (memo.unmatchedRbrack.has(closePos)) return BRACKET_UNMATCHED;
    if (memo.endedInQuoteRbrack.has(closePos)) return BRACKET_ENDED_IN_QUOTE;
  } else {
    const cached = memo.matchedRbrackJumpNoQuote.get(closePos);
    if (cached !== undefined) return cached;
    if (memo.unmatchedRbrackNoQuote.has(closePos)) return BRACKET_UNMATCHED;
  }

  const lineStart = memo.lineStart;
  const matchedMap = respectQuotes ? memo.matchedRbrackJump : memo.matchedRbrackJumpNoQuote;
  const unmatchedSet = respectQuotes ? memo.unmatchedRbrack : memo.unmatchedRbrackNoQuote;
  const stack = memo.rbrackWorkStack;
  stack.length = 0;
  stack.push(closePos);

  let dqHi = memo.dquotes.length - 1;
  let sqHi = memo.squotes.length - 1;
  let idx = closePos;

  while (idx > lineStart) {
    const absIdx = idx - 1;
    const c = text.charCodeAt(absIdx);

    if (respectQuotes && (c === 34 || c === 39)) {
      const isDouble = c === 34;
      const qList = isDouble ? memo.dquotes : memo.squotes;
      let hi = isDouble ? dqHi : sqHi;
      let found = -1;
      if (hi >= 0 && qList[hi]! === absIdx) {
        found = hi;
      } else {
        let lo = 0;
        while (lo <= hi) {
          const mid = (lo + hi) >>> 1;
          const v = qList[mid]!;
          if (v === absIdx) {
            found = mid;
            break;
          }
          if (v < absIdx) {
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
        if (found < 0) {
          // Escaped quote — treat as ordinary char and prune upper bound
          if (isDouble) dqHi = lo - 1;
          else sqHi = lo - 1;
          idx = absIdx;
          continue;
        }
      }
      if (found === 0) {
        // No earlier unescaped matching quote on this line -> scan reaches lineStart in_quote
        for (let k = 0; k < stack.length; k++) {
          memo.endedInQuoteRbrack.add(stack[k]!);
        }
        stack.length = 0;
        return BRACKET_ENDED_IN_QUOTE;
      }
      const prevQ = qList[found - 1]!;
      if (isDouble) dqHi = found - 2;
      else sqHi = found - 2;
      idx = prevQ;
      continue;
    }

    if (c === 93) {
      const jumpOpen = matchedMap.get(absIdx);
      if (jumpOpen !== undefined) {
        idx = jumpOpen;
        continue;
      }
      if (unmatchedSet.has(absIdx)) {
        for (let k = 0; k < stack.length; k++) {
          unmatchedSet.add(stack[k]!);
        }
        stack.length = 0;
        return BRACKET_UNMATCHED;
      }
      if (respectQuotes && memo.endedInQuoteRbrack.has(absIdx)) {
        for (let k = 0; k < stack.length; k++) {
          memo.endedInQuoteRbrack.add(stack[k]!);
        }
        stack.length = 0;
        return BRACKET_ENDED_IN_QUOTE;
      }
      stack.push(absIdx);
      idx = absIdx;
      continue;
    }

    if (c === 91) {
      const matchedClose = stack.pop()!;
      matchedMap.set(matchedClose, absIdx);
      if (stack.length === 0) {
        return absIdx;
      }
      idx = absIdx;
      continue;
    }

    idx = absIdx;
  }

  for (let k = 0; k < stack.length; k++) {
    unmatchedSet.add(stack[k]!);
  }
  stack.length = 0;
  return BRACKET_UNMATCHED;
}

function trimHorizWsEndCached(
  text: string,
  minStart: number,
  end: number,
  memo: KvLineScanMemo,
): number {
  if (end <= minStart || !isHorizWsCode(text.charCodeAt(end - 1))) {
    return end;
  }
  if (memo.longHorizWsCache !== null) {
    const hit = lookupHalfOpenLongRun(memo.longHorizWsCache, end - 1);
    if (hit !== undefined) {
      return hit.start > minStart ? hit.start : minStart;
    }
  }
  let pos = end;
  while (pos > minStart && isHorizWsCode(text.charCodeAt(pos - 1))) {
    pos--;
  }
  if (end - pos >= LONG_CACHE_THRESHOLD) {
    let runStart = pos;
    while (runStart > memo.lineStart && isHorizWsCode(text.charCodeAt(runStart - 1))) {
      runStart--;
    }
    let runEnd = end;
    while (runEnd < text.length && isHorizWsCode(text.charCodeAt(runEnd))) {
      runEnd++;
    }
    if (memo.longHorizWsCache === null) {
      memo.longHorizWsCache = createLongRunCache();
    }
    insertHalfOpenLongRun(memo.longHorizWsCache, {
      start: runStart,
      end: runEnd,
      extra: 0,
    });
  }
  return pos;
}

function extractKvKeyBeforeSepWithMemo(
  text: string,
  sepIdx: number,
  sepCode: number,
  trimmedLineEnd: number,
  memo: KvLineScanMemo,
): ExtractedKvKeySpan | null {
  // Trim only horizontal whitespace before sepIdx so beforeTrimEnd >= memo.lineStart always holds
  const beforeTrimEnd = trimHorizWsEnd(text, 0, sepIdx);
  if (beforeTrimEnd === 0) return null;
  advanceKvLineMemo(memo, text, beforeTrimEnd);
  if (beforeTrimEnd <= memo.lineStart) return null;

  const lineStart = memo.lineStart;
  const isSepEq = sepCode === 61;
  const hasWsAfterSep = sepIdx + 1 < text.length && isWsCode(text.charCodeAt(sepIdx + 1));

  let cursor = beforeTrimEnd;
  let sawSubOrDot = false;
  let sawNonQuotePrefix = false;
  let sawStructuralChain = false;
  let allowRootBracket = false;
  let firstTailSpan: ExtractedKvKeySpan | null = null;
  const cacheCheckpoints: number[] = [];
  let loopSteps = 0;

  while (cursor > lineStart) {
    loopSteps++;
    if (sawSubOrDot && sawNonQuotePrefix) {
      const ck =
        cursor * 8 +
        (sawStructuralChain ? 4 : 0) +
        (isSepEq ? 2 : 0) +
        (hasWsAfterSep ? 1 : 0);
      const cached = memo.subRootCache.get(ck);
      if (cached !== undefined) {
        cursor = Math.floor(cached / 2);
        allowRootBracket = (cached & 1) === 1;
        break;
      }
      if (loopSteps >= 3) {
        cacheCheckpoints.push(ck);
      }
    }

    const lastCode = text.charCodeAt(cursor - 1);

    // 1. Closing bracket ']' — upstream memoized backward findOpenBracket (`script_app.rs:4818-4934`)
    if (lastCode === 93) {
      const closePos = cursor - 1;
      let op = findOpenBracket(text, closePos, true, memo);
      if (op === BRACKET_ENDED_IN_QUOTE) {
        op = findOpenBracket(text, closePos, false, memo);
      }
      if (op < 0) {
        // Glide across contiguous already-known unmatched ']' runs (separated only by ' ' / '\t')
        // while preserving exact upstream `cursor` at exit and caching long-run entry in `subRootCache`.
        const entryCursor = cursor;
        let jumpPos = closePos;
        let trimmedBeforeEnd = trimHorizWsEndCached(text, lineStart, jumpPos, memo);
        let skippedUnmatched = 0;
        while (
          trimmedBeforeEnd > lineStart &&
          text.charCodeAt(trimmedBeforeEnd - 1) === 93 &&
          isKnownUnmatchedRbrack(memo, trimmedBeforeEnd - 1)
        ) {
          cursor = trimmedBeforeEnd;
          sawSubOrDot = true;
          sawNonQuotePrefix = true;
          sawStructuralChain = true;
          jumpPos = trimmedBeforeEnd - 1;
          trimmedBeforeEnd = trimHorizWsEndCached(text, lineStart, jumpPos, memo);
          skippedUnmatched++;
        }
        if (skippedUnmatched >= 4) {
          const flags = (isSepEq ? 2 : 0) + (hasWsAfterSep ? 1 : 0);
          cacheCheckpoints.push(entryCursor * 8 + 4 + flags);
          cacheCheckpoints.push(entryCursor * 8 + flags);
        }
        if (
          trimmedBeforeEnd > lineStart &&
          isValidBeforeContCode(text.charCodeAt(trimmedBeforeEnd - 1))
        ) {
          cursor = trimmedBeforeEnd;
          sawSubOrDot = true;
          sawNonQuotePrefix = true;
          sawStructuralChain = true;
          continue;
        }
        break;
      }
      const trimmedBeforeEnd = trimHorizWsEndCached(text, lineStart, op, memo);
      if (
        trimmedBeforeEnd <= lineStart ||
        !isValidBeforeContCode(text.charCodeAt(trimmedBeforeEnd - 1))
      ) {
        if (op + 1 < cursor) {
          cursor = op;
          allowRootBracket = true;
        }
        break;
      }
      cursor = trimmedBeforeEnd;
      sawSubOrDot = true;
      sawNonQuotePrefix = true;
      sawStructuralChain = true;
      continue;
    }

    // 2. Quoted segment ("..." or '...') — matches upstream script_app.rs:4936-5108
    if (lastCode === 34 || lastCode === 39) {
      const innerEnd = cursor - 1;
      const qPositions = lastCode === 34 ? memo.dquotes : memo.squotes;
      const quoteStart = findPrevUnescapedQuoteInList(qPositions, innerEnd);
      if (quoteStart === QUOTE_ESCAPED) {
        break;
      }
      if (quoteStart < lineStart) {
        if (sawSubOrDot) cursor = innerEnd;
        break;
      }
      if (firstTailSpan === null && cursor === beforeTrimEnd && quoteStart + 1 < innerEnd) {
        firstTailSpan = { keyStart: quoteStart, sliceStart: quoteStart + 1, sliceEnd: innerEnd };
      }
      const trimmedBeforeEnd = trimHorizWsEndCached(text, lineStart, quoteStart, memo);
      if (trimmedBeforeEnd > lineStart) {
        const prevCode = text.charCodeAt(trimmedBeforeEnd - 1);
        if (prevCode === 93) {
          cursor = trimmedBeforeEnd;
          sawSubOrDot = true;
          sawNonQuotePrefix = true;
          sawStructuralChain = true;
          continue;
        }
        if (prevCode === 34 || prevCode === 39) {
          if (trimmedBeforeEnd === quoteStart) sawStructuralChain = true;
          cursor = trimmedBeforeEnd;
          sawSubOrDot = true;
          continue;
        }
        if (prevCode === 46) {
          const sepPos = trimmedBeforeEnd - 1;
          const beforeDotEnd = trimHorizWsEndCached(text, lineStart, sepPos, memo);
          const noSpaceAfterDot = trimmedBeforeEnd === quoteStart;
          const spaceBeforeDot = beforeDotEnd < sepPos;
          const bdc = beforeDotEnd > lineStart ? text.charCodeAt(beforeDotEnd - 1) : -1;
          const rbrackBeforeDot = bdc === 93;
          const quoteBeforeDot = bdc === 34 || bdc === 39;
          if (
            (noSpaceAfterDot ||
              sawSubOrDot ||
              isSepEq ||
              !hasWsAfterSep ||
              spaceBeforeDot ||
              rbrackBeforeDot ||
              quoteBeforeDot) &&
            bdc >= 0 &&
            isValidBeforeContCode(bdc)
          ) {
            cursor = beforeDotEnd;
            sawSubOrDot = true;
            sawNonQuotePrefix = true;
            sawStructuralChain = true;
            continue;
          }
        }
        if (prevCode === 91) {
          const sepPos = trimmedBeforeEnd - 1;
          const beforeLbrackEnd = trimHorizWsEndCached(text, lineStart, sepPos, memo);
          const noSpaceAfterLbrack = trimmedBeforeEnd === quoteStart;
          const blc = beforeLbrackEnd > lineStart ? text.charCodeAt(beforeLbrackEnd - 1) : -1;
          let canCross = false;
          if (blc >= 0 && isValidBeforeContCode(blc)) {
            if (beforeLbrackEnd < sepPos) {
              const prevIsSubOrQ = blc === 93 || blc === 34 || blc === 39 || blc === 91;
              canCross =
                prevIsSubOrQ ||
                hasTightSubOrDotInCurChain(memo, sepPos) ||
                ((noSpaceAfterLbrack || sawSubOrDot || isSepEq || !hasWsAfterSep) &&
                  (isSepEq || !hasWsAfterSep || sawSubOrDot));
            } else {
              canCross = noSpaceAfterLbrack || sawSubOrDot || isSepEq || !hasWsAfterSep;
            }
          }
          if (canCross) {
            cursor = beforeLbrackEnd;
            sawSubOrDot = true;
            sawNonQuotePrefix = true;
            sawStructuralChain = true;
            continue;
          }
        }
        if (quoteStart > lineStart && isKvIdentCharCode(text.charCodeAt(quoteStart - 1))) {
          cursor = quoteStart;
          sawSubOrDot = true;
          sawNonQuotePrefix = true;
          sawStructuralChain = true;
          continue;
        }
        // H4 prose guard (`Use "auth_token" "Note": ok` -> return "Note")
        if (
          sawSubOrDot &&
          !sawStructuralChain &&
          sepCode === 58 &&
          hasWsAfterSep &&
          !memo.lineHasUrlScheme &&
          isSafeH4ProseRhsAt(text, sepIdx + 1, trimmedLineEnd)
        ) {
          const identEnd = trimmedBeforeEnd;
          let identStart = identEnd;
          while (identStart > lineStart && isKvIdentCharCode(text.charCodeAt(identStart - 1))) {
            identStart--;
          }
          if (identStart < identEnd) {
            const beforeIdentEnd = trimHorizWsEndCached(text, lineStart, identStart, memo);
            const bic = beforeIdentEnd > lineStart ? text.charCodeAt(beforeIdentEnd - 1) : -1;
            const continuesChain =
              bic === 46 ||
              bic === 91 ||
              bic === 93 ||
              bic === 34 ||
              bic === 39 ||
              bic === 63 ||
              bic === 38 ||
              bic === 61 ||
              bic === 47 ||
              bic === 58 ||
              bic === 59 ||
              bic === 44;
            const ident = text.slice(identStart, identEnd);
            const identSegs = splitKeySegments(ident);
            const identSensitive =
              isSensitiveJsonKeyWithSegments(ident, identSegs) ||
              identSegs.includes('bearer') ||
              identSegs.includes('basic');
            const identCapitalized = isAsciiUpperCode(text.charCodeAt(identStart));
            if (!continuesChain && !identSensitive && identCapitalized) {
              return firstTailSpan && firstTailSpan.sliceStart < firstTailSpan.sliceEnd
                ? firstTailSpan
                : null;
            }
          }
        }
        if (isKvIdentCharCode(prevCode)) {
          cursor = trimmedBeforeEnd;
          sawSubOrDot = true;
          sawNonQuotePrefix = true;
          continue;
        }
      }
      if (sawSubOrDot) {
        cursor = quoteStart;
        break;
      }
      const start = quoteStart + 1;
      if (start === innerEnd) return null;
      return { keyStart: quoteStart, sliceStart: start, sliceEnd: innerEnd };
    }

    // 3. Identifier segment (`[A-Za-z0-9_-]` + non-ASCII non-ws) — no start-char gate (I2-A)
    let segStart = cursor;
    while (segStart > lineStart && isKvIdentCharCode(text.charCodeAt(segStart - 1))) {
      segStart--;
    }
    if (segStart < cursor) {
      if (firstTailSpan === null && cursor === beforeTrimEnd) {
        firstTailSpan = { keyStart: segStart, sliceStart: segStart, sliceEnd: cursor };
      }
      cursor = segStart;
      sawNonQuotePrefix = true;
      if (cursor > lineStart) {
        const trimmedBeforeEnd = trimHorizWsEndCached(text, lineStart, cursor, memo);
        if (trimmedBeforeEnd > lineStart) {
          const prevCode = text.charCodeAt(trimmedBeforeEnd - 1);
          if (prevCode === 46) {
            const sepPos = trimmedBeforeEnd - 1;
            const beforeDotEnd = trimHorizWsEndCached(text, lineStart, sepPos, memo);
            const noSpaceAfterDot = trimmedBeforeEnd === cursor;
            const spaceBeforeDot = beforeDotEnd < sepPos;
            const bdc = beforeDotEnd > lineStart ? text.charCodeAt(beforeDotEnd - 1) : -1;
            const quoteBeforeDot = bdc === 34 || bdc === 39;
            if (
              (noSpaceAfterDot ||
                sawSubOrDot ||
                isSepEq ||
                !hasWsAfterSep ||
                spaceBeforeDot ||
                quoteBeforeDot) &&
              bdc >= 0 &&
              isValidBeforeContCode(bdc)
            ) {
              cursor = beforeDotEnd;
              sawSubOrDot = true;
              if (!quoteBeforeDot) sawStructuralChain = true;
              continue;
            }
          } else if (prevCode === 91) {
            const sepPos = trimmedBeforeEnd - 1;
            const beforeLbrackEnd = trimHorizWsEndCached(text, lineStart, sepPos, memo);
            const noSpaceAfterLbrack = trimmedBeforeEnd === cursor;
            const blc = beforeLbrackEnd > lineStart ? text.charCodeAt(beforeLbrackEnd - 1) : -1;
            let canCross = false;
            if (blc >= 0 && isValidBeforeContCode(blc)) {
              if (beforeLbrackEnd < sepPos) {
                const prevIsSubOrQ = blc === 93 || blc === 34 || blc === 39 || blc === 91;
                canCross =
                  prevIsSubOrQ ||
                  hasTightSubOrDotInCurChain(memo, sepPos) ||
                  ((noSpaceAfterLbrack || sawSubOrDot || isSepEq || !hasWsAfterSep) &&
                    (isSepEq || !hasWsAfterSep || sawSubOrDot));
              } else {
                canCross = noSpaceAfterLbrack || sawSubOrDot || isSepEq || !hasWsAfterSep;
              }
            }
            if (canCross) {
              cursor = beforeLbrackEnd;
              sawSubOrDot = true;
              sawStructuralChain = true;
              continue;
            }
          } else if (prevCode === 93) {
            cursor = trimmedBeforeEnd;
            sawSubOrDot = true;
            sawStructuralChain = true;
            continue;
          } else if (prevCode === 34 || prevCode === 39) {
            if (trimmedBeforeEnd === cursor || hasTightSubOrDotInCurChain(memo, cursor)) {
              sawStructuralChain = true;
            }
            cursor = trimmedBeforeEnd;
            sawSubOrDot = true;
            continue;
          } else if (
            isKvIdentCharCode(prevCode) &&
            (((isSepEq || !hasWsAfterSep) && hasSubOrDotInCurChain(memo, cursor)) ||
              hasTightSubOrDotInCurChain(memo, cursor) ||
              hasQuoteLbrackOrProseDotInCurChain(memo, trimmedBeforeEnd))
          ) {
            cursor = trimmedBeforeEnd;
            sawSubOrDot = true;
            sawStructuralChain = true;
            continue;
          }
        }
      }
      break;
    }

    // 4. Bare '.' or '[' continuation (handles `auth_token..prod`, `auth_token[[0]`, `auth_token[0].=`)
    let rbrackBeforeBareDot = false;
    if (lastCode === 46 && !(sawSubOrDot || isSepEq || !hasWsAfterSep)) {
      const te = trimHorizWsEndCached(text, lineStart, cursor - 1, memo);
      rbrackBeforeBareDot = te > lineStart && text.charCodeAt(te - 1) === 93;
    }
    if (
      (lastCode === 46 || lastCode === 91) &&
      (sawSubOrDot || isSepEq || !hasWsAfterSep || rbrackBeforeBareDot)
    ) {
      let sepPos = cursor - 1;
      if (lastCode === 91) {
        const rf = runFirstInList(memo.curLbrackRunStart, memo.lbrackRuns, sepPos);
        if (rf >= 0) sepPos = rf;
      }
      const trimmedBeforeEnd = trimHorizWsEndCached(text, lineStart, sepPos, memo);
      const tbc = trimmedBeforeEnd > lineStart ? text.charCodeAt(trimmedBeforeEnd - 1) : -1;
      let canCross = false;
      if (tbc >= 0 && isValidBeforeContCode(tbc)) {
        if (lastCode === 46) {
          canCross = true;
        } else if (trimmedBeforeEnd < sepPos) {
          const prevIsSubOrQ = tbc === 93 || tbc === 34 || tbc === 39 || tbc === 91;
          canCross =
            isSepEq ||
            !hasWsAfterSep ||
            sawSubOrDot ||
            hasTightSubOrDotInCurChain(memo, sepPos) ||
            prevIsSubOrQ;
        } else {
          canCross = true;
        }
      }
      if (canCross) {
        cursor = trimmedBeforeEnd;
        sawSubOrDot = true;
        sawNonQuotePrefix = true;
        sawStructuralChain = true;
        continue;
      }
    }

    break;
  }

  // Strip stray leading '.' BEFORE caching so subRootCache hits skip '.' runs in O(1)
  while (cursor < beforeTrimEnd && text.charCodeAt(cursor) === 46) {
    cursor++;
  }

  const encodedResult = cursor * 2 + (allowRootBracket ? 1 : 0);
  for (let i = 0; i < cacheCheckpoints.length; i++) {
    memo.subRootCache.set(cacheCheckpoints[i]!, encodedResult);
  }

  if (cursor >= beforeTrimEnd || (text.charCodeAt(cursor) === 91 && !allowRootBracket)) {
    return null;
  }
  return { keyStart: cursor, sliceStart: cursor, sliceEnd: beforeTrimEnd };
}

function isAuthTrimCode(c: number): boolean {
  return isWsCode(c) || c === 34 || c === 39;
}

function isAuthHeaderSpan(
  text: string,
  sliceStart: number,
  sliceEnd: number,
  memo: KvLineScanMemo,
): boolean {
  let baseEnd = firstAtOrAfterSorted(memo.lineAllLbracks, sliceStart);
  if (baseEnd < 0 || baseEnd > sliceEnd) baseEnd = sliceEnd;
  if (sliceStart === memo.lastAuthSliceStart && baseEnd === memo.lastAuthBaseEnd) {
    return memo.lastAuthResult;
  }
  const cacheBaseEnd = baseEnd;
  let s = sliceStart;
  if (s < baseEnd && isAuthTrimCode(text.charCodeAt(s))) {
    const hit =
      memo.longAuthTrimCache !== null ? lookupHalfOpenLongRun(memo.longAuthTrimCache, s) : undefined;
    if (hit !== undefined) {
      s = hit.end < baseEnd ? hit.end : baseEnd;
    } else {
      const f0 = s;
      while (s < baseEnd && isAuthTrimCode(text.charCodeAt(s))) {
        s++;
      }
      if (s - f0 >= LONG_CACHE_THRESHOLD) {
        let runStart = f0;
        while (runStart > memo.lineStart && isAuthTrimCode(text.charCodeAt(runStart - 1))) {
          runStart--;
        }
        let runEnd = s;
        while (runEnd < text.length) {
          const rc = text.charCodeAt(runEnd);
          if (rc === 10 || rc === 13 || !isAuthTrimCode(rc)) break;
          runEnd++;
        }
        if (memo.longAuthTrimCache === null) {
          memo.longAuthTrimCache = createLongRunCache();
        }
        insertHalfOpenLongRun(memo.longAuthTrimCache, {
          start: runStart,
          end: runEnd,
          extra: 0,
        });
      }
    }
  }
  if (baseEnd > s && isAuthTrimCode(text.charCodeAt(baseEnd - 1))) {
    const hit =
      memo.longAuthTrimCache !== null
        ? lookupHalfOpenLongRun(memo.longAuthTrimCache, baseEnd - 1)
        : undefined;
    if (hit !== undefined) {
      baseEnd = hit.start > s ? hit.start : s;
    } else {
      const b0 = baseEnd;
      while (baseEnd > s && isAuthTrimCode(text.charCodeAt(baseEnd - 1))) {
        baseEnd--;
      }
      if (b0 - baseEnd >= LONG_CACHE_THRESHOLD) {
        let runStart = baseEnd;
        while (runStart > memo.lineStart && isAuthTrimCode(text.charCodeAt(runStart - 1))) {
          runStart--;
        }
        let runEnd = b0;
        while (runEnd < text.length) {
          const rc = text.charCodeAt(runEnd);
          if (rc === 10 || rc === 13 || !isAuthTrimCode(rc)) break;
          runEnd++;
        }
        if (memo.longAuthTrimCache === null) {
          memo.longAuthTrimCache = createLongRunCache();
        }
        insertHalfOpenLongRun(memo.longAuthTrimCache, {
          start: runStart,
          end: runEnd,
          extra: 0,
        });
      }
    }
  }
  let res = false;
  const len = baseEnd - s;
  if (len === 13) {
    res = matchesAsciiIgnoreCaseAt(text, s, 'authorization');
  } else if (len >= 14) {
    const sep = text.charCodeAt(baseEnd - 14);
    if (sep === 45 || sep === 95) {
      res = matchesAsciiIgnoreCaseAt(text, baseEnd - 13, 'authorization');
    }
  }
  memo.lastAuthSliceStart = sliceStart;
  memo.lastAuthBaseEnd = cacheBaseEnd;
  memo.lastAuthResult = res;
  return res;
}

interface BackwardUrlCtxIndex {
  // Interleaved [pos0, state0 (0|1), pos1, state1, ...]
  changes: number[];
}

function buildBackwardUrlCtxIndex(text: string): BackwardUrlCtxIndex {
  const changes: number[] = [0, 0];
  let lastUrlPrefixStart = 0;
  let urlHasScheme = false;
  let urlHasQmark = false;
  let urlStartsWithQmark = false;
  let urlHasSlash = false;
  let curInUq = false;
  let nextDbrace = 0;
  let nextNl = 0;
  let i = 0;

  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 123 && i + 1 < text.length && text.charCodeAt(i + 1) === 123) {
      const searchFrom = i + 2;
      if (nextDbrace < searchFrom) {
        const found = text.indexOf('}}', searchFrom);
        nextDbrace = found < 0 ? text.length + 1 : found;
      }
      if (nextNl < searchFrom) {
        const nl = findLineEnd(text, searchFrom);
        nextNl = nl >= text.length ? text.length + 1 : nl;
      }
      if (nextDbrace <= text.length && nextDbrace < nextNl) {
        i = nextDbrace + 2;
        continue;
      }
      i += 2;
      continue;
    }
    if (c === 91 && i > 0) {
      const prev = text.charCodeAt(i - 1);
      if (isAsciiAlnumCode(prev) || prev === 95 || prev === 93 || prev === 37) {
        i++;
        continue;
      }
    }
    if (isWsCode(c) || c === 34 || c === 39 || c === 60 || c === 40 || c === 91 || c === 123) {
      lastUrlPrefixStart = i + 1;
      urlHasScheme = false;
      urlHasQmark = false;
      urlStartsWithQmark = false;
      urlHasSlash = false;
      if (curInUq) {
        curInUq = false;
        changes.push(i + 1, 0);
      }
    } else if (c === 63) {
      urlHasQmark = true;
      if (i === lastUrlPrefixStart) {
        urlStartsWithQmark = true;
      }
      const newInUq = urlHasScheme || urlHasSlash || urlStartsWithQmark;
      if (newInUq !== curInUq) {
        curInUq = newInUq;
        changes.push(i + 1, newInUq ? 1 : 0);
      }
    } else if (c === 47) {
      urlHasSlash = true;
      if (!urlHasScheme && i > lastUrlPrefixStart && text.charCodeAt(i - 1) === 47) {
        const prefLen = i + 1 - lastUrlPrefixStart;
        if (
          (prefLen >= 7 && matchesAsciiIgnoreCaseAt(text, i - 6, 'http://')) ||
          (prefLen >= 8 && matchesAsciiIgnoreCaseAt(text, i - 7, 'https://'))
        ) {
          urlHasScheme = true;
        }
      }
      const newInUq = urlHasScheme || urlHasQmark;
      if (newInUq !== curInUq) {
        curInUq = newInUq;
        changes.push(i + 1, newInUq ? 1 : 0);
      }
    }
    i++;
  }
  return { changes };
}

function queryBackwardUrlCtx(idx: BackwardUrlCtxIndex, pos: number): boolean {
  const arr = idx.changes;
  let lo = 0;
  let hi = arr.length >>> 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid << 1]! <= pos) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return arr[((lo - 1) << 1) + 1] === 1;
}

interface KvBoundarySpanSummary {
  spanStart: number;
  spanEnd: number;
  lastBracePos: number;
  lastBasicCredStart: number;
}

interface KvValueMemo {
  nextCloseBrace: number; // -2 = uninit, -1 = none remaining, >= 0 = next '}}'
  nextBoundaryNoUrl: number;
  nextBoundaryInUrl: number;
  spanSummaryNoUrl: KvBoundarySpanSummary | null;
  spanSummaryInUrl: KvBoundarySpanSummary | null;
  trailWsSkipStart: number;
  trailWsSkipEnd: number;
  longTrailWsCache: LongRunCache | null;
}

function createKvValueMemo(): KvValueMemo {
  return {
    nextCloseBrace: -2,
    nextBoundaryNoUrl: -1,
    nextBoundaryInUrl: -1,
    spanSummaryNoUrl: null,
    spanSummaryInUrl: null,
    trailWsSkipStart: -1,
    trailWsSkipEnd: -1,
    longTrailWsCache: null,
  };
}

function findKvOuterBoundaryCached(
  memo: KvValueMemo,
  text: string,
  valStart: number,
  inUrlQuery: boolean,
): number {
  const cached = inUrlQuery ? memo.nextBoundaryInUrl : memo.nextBoundaryNoUrl;
  if (cached >= valStart) {
    return cached;
  }
  let end = valStart;
  while (end < text.length && !isKvOuterBoundaryAt(text, end, inUrlQuery)) {
    end++;
  }
  if (inUrlQuery) {
    memo.nextBoundaryInUrl = end;
  } else {
    memo.nextBoundaryNoUrl = end;
  }
  return end;
}

function getOrBuildKvSpanSummary(
  memo: KvValueMemo,
  text: string,
  valStart: number,
  spanEnd: number,
  inUrlQuery: boolean,
): KvBoundarySpanSummary {
  const existing = inUrlQuery ? memo.spanSummaryInUrl : memo.spanSummaryNoUrl;
  if (existing !== null && existing.spanEnd === spanEnd && valStart >= existing.spanStart) {
    return existing;
  }
  let lastBracePos = -1;
  let lastBasicCredStart = -1;
  let i = valStart;
  while (i < spanEnd) {
    const c = text.charCodeAt(i);
    if ((c === 123 || c === 125) && i + 1 < spanEnd && text.charCodeAt(i + 1) === c) {
      lastBracePos = i;
      i++;
      continue;
    }
    if (isBasicCredCharCode(c)) {
      const runStart = i;
      while (i < spanEnd && isBasicCredCharCode(text.charCodeAt(i))) {
        i++;
      }
      if (i - runStart >= 8 && looksLikeBasicCredentialRange(text, runStart, i)) {
        lastBasicCredStart = runStart;
      }
      continue;
    }
    i++;
  }
  const summary: KvBoundarySpanSummary = {
    spanStart: valStart,
    spanEnd,
    lastBracePos,
    lastBasicCredStart,
  };
  if (inUrlQuery) {
    memo.spanSummaryInUrl = summary;
  } else {
    memo.spanSummaryNoUrl = summary;
  }
  return summary;
}

function hasBasicCredInKvDeferredSpan(
  text: string,
  summary: KvBoundarySpanSummary,
  valStart: number,
  end: number,
): boolean {
  const splitsRun =
    valStart > summary.spanStart &&
    isBasicCredCharCode(text.charCodeAt(valStart - 1)) &&
    isBasicCredCharCode(text.charCodeAt(valStart));
  if (!splitsRun) {
    return summary.lastBasicCredStart >= valStart;
  }
  let runEnd = valStart;
  while (runEnd < end && isBasicCredCharCode(text.charCodeAt(runEnd))) {
    runEnd++;
  }
  if (runEnd - valStart >= 8 && looksLikeBasicCredentialRange(text, valStart, runEnd)) {
    return true;
  }
  return summary.lastBasicCredStart >= runEnd;
}

function skipHorizWsToLineEndCached(
  text: string,
  pos: number,
  lineEnd: number,
  trimmedLineEnd: number,
  memo: KvValueMemo,
): number {
  if (pos >= trimmedLineEnd) return lineEnd;
  if (pos >= memo.trailWsSkipStart && pos < memo.trailWsSkipEnd) {
    return memo.trailWsSkipEnd < lineEnd ? memo.trailWsSkipEnd : lineEnd;
  }
  if (memo.longTrailWsCache !== null) {
    const hit = lookupHalfOpenLongRun(memo.longTrailWsCache, pos);
    if (hit !== undefined) {
      memo.trailWsSkipStart = hit.start;
      memo.trailWsSkipEnd = hit.end;
      return hit.end < lineEnd ? hit.end : lineEnd;
    }
  }
  const start = pos;
  while (pos < lineEnd && isHorizWsCode(text.charCodeAt(pos))) {
    pos++;
  }
  let storeStart = start;
  if (pos - start >= LONG_CACHE_THRESHOLD) {
    while (storeStart > 0 && isHorizWsCode(text.charCodeAt(storeStart - 1))) {
      storeStart--;
    }
    let runEnd = pos;
    while (runEnd < text.length && isHorizWsCode(text.charCodeAt(runEnd))) {
      runEnd++;
    }
    if (memo.longTrailWsCache === null) {
      memo.longTrailWsCache = createLongRunCache();
    }
    insertHalfOpenLongRun(memo.longTrailWsCache, {
      start: storeStart,
      end: runEnd,
      extra: 0,
    });
    memo.trailWsSkipStart = storeStart;
    memo.trailWsSkipEnd = runEnd;
  } else if (pos > start) {
    memo.trailWsSkipStart = start;
    memo.trailWsSkipEnd = pos;
  }
  return pos;
}

interface ExtractedKvValue {
  token: string;
  tokenEnd: number;
  wasQuoted: boolean;
  hasBrokenQuote: boolean;
  deferredNonPlaceholder?: boolean;
  deferredBasicSpan?: { summary: KvBoundarySpanSummary; valStart: number; end: number };
}

function extractKvValueBounded(
  text: string,
  valStart: number,
  lineEnd: number,
  inUrlQuery: boolean,
  kvValMemo: KvValueMemo,
  deferMode: 'none' | 'non_placeholder' | 'basic_only',
): ExtractedKvValue {
  const firstCode = text.charCodeAt(valStart);

  // 1. Quoted value: `"..."` or `'...'` with clean outer boundary check
  if (firstCode === 34 || firstCode === 39) {
    let pos = valStart + 1;
    while (pos < text.length) {
      const c = text.charCodeAt(pos);
      if (c === 10 || c === 13) break;
      if (c === firstCode) {
        if (isKvOuterBoundaryAt(text, pos + 1, inUrlQuery)) {
          return {
            token: text.slice(valStart + 1, pos).trim(),
            tokenEnd: pos + 1,
            wasQuoted: true,
            hasBrokenQuote: false,
          };
        }
        break;
      }
      pos++;
    }
    const end = findKvOuterBoundaryCached(kvValMemo, text, valStart, inUrlQuery);
    if (end - valStart > LONG_SPAN_MEMO_THRESHOLD) {
      if (deferMode === 'non_placeholder') {
        return {
          token: '',
          tokenEnd: end,
          wasQuoted: false,
          hasBrokenQuote: true,
          deferredNonPlaceholder: true,
        };
      }
      if (deferMode === 'basic_only') {
        const summary = getOrBuildKvSpanSummary(kvValMemo, text, valStart, end, inUrlQuery);
        if (summary.lastBracePos < valStart) {
          return {
            token: '',
            tokenEnd: end,
            wasQuoted: false,
            hasBrokenQuote: true,
            deferredBasicSpan: { summary, valStart, end },
          };
        }
      }
    }
    return {
      token: text.slice(valStart, end).trim(),
      tokenEnd: end,
      wasQuoted: false,
      hasBrokenQuote: true,
    };
  }

  // 2. Mustache placeholder `{{...}}` using monotonic nextCloseBrace cursor (O(1) amortized)
  if (
    firstCode === 123 &&
    valStart + 1 < text.length &&
    text.charCodeAt(valStart + 1) === 123
  ) {
    const searchFrom = valStart + 2;
    if (
      kvValMemo.nextCloseBrace === -2 ||
      (kvValMemo.nextCloseBrace >= 0 && kvValMemo.nextCloseBrace < searchFrom)
    ) {
      kvValMemo.nextCloseBrace = text.indexOf('}}', searchFrom);
    }
    const closeIdx =
      kvValMemo.nextCloseBrace >= 0 && kvValMemo.nextCloseBrace < lineEnd
        ? kvValMemo.nextCloseBrace
        : -1;
    if (closeIdx >= 0 && isKvOuterBoundaryAt(text, closeIdx + 2, inUrlQuery)) {
      return {
        token: text.slice(valStart, closeIdx + 2).trim(),
        tokenEnd: closeIdx + 2,
        wasQuoted: false,
        hasBrokenQuote: false,
      };
    }
  }

  // 3. Unquoted value up to outer boundary using monotonic cursor (O(1) amortized)
  const end = findKvOuterBoundaryCached(kvValMemo, text, valStart, inUrlQuery);
  if (end - valStart > LONG_SPAN_MEMO_THRESHOLD) {
    if (deferMode === 'non_placeholder') {
      // Branch 2 already captured any valid clean `{{...}}` placeholder ending at an outer boundary.
      return {
        token: '',
        tokenEnd: end,
        wasQuoted: false,
        hasBrokenQuote: false,
        deferredNonPlaceholder: true,
      };
    }
    if (deferMode === 'basic_only') {
      const summary = getOrBuildKvSpanSummary(kvValMemo, text, valStart, end, inUrlQuery);
      if (summary.lastBracePos < valStart) {
        return {
          token: '',
          tokenEnd: end,
          wasQuoted: false,
          hasBrokenQuote: false,
          deferredBasicSpan: { summary, valStart, end },
        };
      }
    }
  }
  const raw = text.slice(valStart, end).trim();
  return {
    token: raw,
    tokenEnd: end,
    wasQuoted: false,
    hasBrokenQuote: raw.includes('"') || raw.includes("'"),
  };
}

function checkUrlTailSegmentsSafe(
  tail: string,
  paramLookup: ParamLookup,
): { safe: boolean; postUrlTail: string } {
  let urlEnd = tail.length;
  let i = 0;
  let nextCloseBrace = -2; // -2 = uninitialized, -1 = none remaining
  let nextNl = -2;
  while (i < tail.length) {
    if (tail.charCodeAt(i) === 123 && i + 1 < tail.length && tail.charCodeAt(i + 1) === 123) {
      const from = i + 2;
      if (nextCloseBrace === -2 || (nextCloseBrace >= 0 && nextCloseBrace < from)) {
        nextCloseBrace = tail.indexOf('}}', from);
      }
      if (nextCloseBrace >= 0) {
        if (nextNl === -2 || (nextNl >= 0 && nextNl < from)) {
          const nlPos = findLineEnd(tail, from);
          nextNl = nlPos < tail.length ? nlPos : -1;
        }
        if (nextNl < 0 || nextCloseBrace < nextNl) {
          i = nextCloseBrace + 2;
          continue;
        }
      }
    }
    if (isWsCode(tail.charCodeAt(i))) {
      urlEnd = i;
      break;
    }
    i++;
  }
  const urlTail = tail.slice(0, urlEnd);
  const postUrlTail = tail.slice(urlEnd).trimStart();

  const checkSeg = (rawSeg: string): boolean => {
    const seg = rawSeg.replace(/^[&;#]+/, '');
    if (!seg) return true;
    let eqIdx = -1;
    let p = 0;
    let segNextClose = -2;
    while (p < seg.length) {
      if (seg.charCodeAt(p) === 123 && p + 1 < seg.length && seg.charCodeAt(p + 1) === 123) {
        if (segNextClose === -2 || (segNextClose >= 0 && segNextClose < p + 2)) {
          segNextClose = seg.indexOf('}}', p + 2);
        }
        if (segNextClose >= 0) {
          p = segNextClose + 2;
          continue;
        }
      }
      if (seg.charCodeAt(p) === 61) {
        eqIdx = p;
        break;
      }
      p++;
    }
    if (eqIdx > 0) {
      const lhs = seg.slice(0, eqIdx);
      if (!lhs.includes('{{') && !lhs.includes('}}')) {
        // Key-value query param; checked by the main KV scanner on its own '='
        return true;
      }
    }
    const target = eqIdx === 0 ? seg.slice(1) : seg;
    if (target.includes('{{') || target.includes('}}')) {
      let cursor = 0;
      let literalOnly = '';
      while (true) {
        const open = target.indexOf('{{', cursor);
        if (open < 0) break;
        literalOnly += target.slice(cursor, open) + ' ';
        const close = target.indexOf('}}', open + 2);
        if (close < 0) return false;
        const name = target.slice(open + 2, close).trim();
        const valid =
          name.length > 0 && !name.includes('{{') && paramLookup.validUrlNames.has(name);
        if (!valid) return false;
        cursor = close + 2;
      }
      if (target.indexOf('}}', cursor) >= 0) return false;
      literalOnly += target.slice(cursor);
      return isSafeBearerOrBasicValue(literalOnly, true, true, paramLookup);
    }
    return isSafeBearerOrBasicValue(target, true, true, paramLookup);
  };

  let segStart = 0;
  let pos = 0;
  let tailNextClose = -2;
  while (pos < urlTail.length) {
    if (
      urlTail.charCodeAt(pos) === 123 &&
      pos + 1 < urlTail.length &&
      urlTail.charCodeAt(pos + 1) === 123
    ) {
      if (tailNextClose === -2 || (tailNextClose >= 0 && tailNextClose < pos + 2)) {
        tailNextClose = urlTail.indexOf('}}', pos + 2);
      }
      if (tailNextClose >= 0) {
        pos = tailNextClose + 2;
        continue;
      }
    }
    const c = urlTail.charCodeAt(pos);
    if (c === 38 || c === 59 || c === 35) {
      if (!checkSeg(urlTail.slice(segStart, pos))) {
        return { safe: false, postUrlTail: '' };
      }
      segStart = pos + 1;
    }
    pos++;
  }
  if (!checkSeg(urlTail.slice(segStart))) {
    return { safe: false, postUrlTail: '' };
  }
  return { safe: true, postUrlTail };
}

function checkUrlSameLineTrailingSafe(
  text: string,
  trailPos: number,
  lineEnd: number,
  isBearer: boolean,
  isBasic: boolean,
  paramLookup: ParamLookup,
  urlMemo: SameLineMemo,
): boolean {
  if (trailPos >= lineEnd) return true;
  if (urlMemo.safeEnd >= 0 && trailPos >= urlMemo.safeStart && trailPos <= urlMemo.safeEnd) {
    return true;
  }
  if (
    urlMemo.failedLineEnd >= 0 &&
    trailPos >= urlMemo.failedLineStart &&
    trailPos <= urlMemo.failedLineEnd
  ) {
    return true;
  }
  const trailingRaw = text.slice(trailPos, lineEnd);
  const urlCheck = checkUrlTailSegmentsSafe(trailingRaw, paramLookup);
  const ok =
    urlCheck.safe &&
    (!urlCheck.postUrlTail ||
      isSafeBearerOrBasicValue(urlCheck.postUrlTail, isBearer, isBasic, paramLookup));
  if (!ok) {
    urlMemo.failedLineStart = trailPos;
    urlMemo.failedLineEnd = lineEnd;
    return false;
  }
  urlMemo.safeStart =
    urlMemo.safeEnd === lineEnd ? Math.min(urlMemo.safeStart, trailPos) : trailPos;
  urlMemo.safeEnd = lineEnd;
  return true;
}

type AuthPayloadKind = 'unquoted' | 'quoted' | 'bracketed';

interface NonWsSpanSummary {
  spanStart: number;
  spanEnd: number;
  afterHorizWs: number;
  lastBracePos: number;
  prevQuotePos: number;
  lastQuotePos: number;
  lastBasicCredStart: number;
  lastBasicCredStartNoTrailEq: number;
}

interface DeferredBasicSpan {
  summary: NonWsSpanSummary;
  pos: number;
  wsEnd: number;
  stripTrailEq: boolean;
}

interface AuthPayload {
  unwrapped: string;
  kind: AuthPayloadKind;
  hasBrokenQuote: boolean;
  followedByKvSep: boolean;
  restAfterKvSepStart: number;
  consumedEnd: number;
  enclosureOverflow: boolean;
  deferredBasicSpan?: DeferredBasicSpan;
}

const MAX_AUTH_BRACKET_FAST_SCAN = 64;
const MAX_AUTH_BRACKET_SPAN = 1024;
const MAX_BASIC_LEVELS = 8; // Matches upstream `for level in 0..8` (`script_app.rs:7401`)

interface AuthBracketMemo {
  lastCloseComputed: boolean;
  lastClose: [number, number, number, number]; // 0:')', 1:']', 2:'}', 3:'>'
  kindScanned: [boolean, boolean, boolean, boolean];
  matchedClose: [
    Map<number, number> | null,
    Map<number, number> | null,
    Map<number, number> | null,
    Map<number, number> | null,
  ];
  matchedCloseNoQuote: [
    Map<number, number> | null,
    Map<number, number> | null,
    Map<number, number> | null,
    Map<number, number> | null,
  ];
  // 2-slot MRU cache + permanent block-indexed Map for contiguous non-ws spans (len >= 64)
  wsStart0: number;
  wsEnd0: number;
  wsAfterHoriz0: number;
  wsStart1: number;
  wsEnd1: number;
  wsAfterHoriz1: number;
  longNonWsCache: LongRunCache | null;
  // 1-slot + permanent block-indexed Map for whitespace skips (isWsCode, len >= 64)
  skipWsStart: number;
  skipWsEnd: number;
  longWsCache: LongRunCache | null;
  // 1-slot + permanent block-indexed Map for horizontal whitespace skips (isHorizWsCode, len >= 64)
  skipHorizWsStart: number;
  skipHorizWsEnd: number;
  longHorizWsCache: LongRunCache | null;
  // Per-quote-kind 1-slot + permanent block-indexed Map for same-line closing quote search (len >= 64)
  dqScanStart: number;
  dqScanEnd: number;
  dqClosePos: number;
  longDqCache: LongRunCache | null;
  sqScanStart: number;
  sqScanEnd: number;
  sqClosePos: number;
  longSqCache: LongRunCache | null;
  // Lazy O(N) summary cache keyed by spanEnd ONLY for long non-ws spans (> 128 chars)
  longSpans: Map<number, NonWsSpanSummary>;
}

function createAuthBracketMemo(): AuthBracketMemo {
  return {
    lastCloseComputed: false,
    lastClose: [-1, -1, -1, -1],
    kindScanned: [false, false, false, false],
    matchedClose: [null, null, null, null],
    matchedCloseNoQuote: [null, null, null, null],
    wsStart0: -1,
    wsEnd0: -1,
    wsAfterHoriz0: -1,
    wsStart1: -1,
    wsEnd1: -1,
    wsAfterHoriz1: -1,
    longNonWsCache: null,
    skipWsStart: -1,
    skipWsEnd: -1,
    longWsCache: null,
    skipHorizWsStart: -1,
    skipHorizWsEnd: -1,
    longHorizWsCache: null,
    dqScanStart: -1,
    dqScanEnd: -1,
    dqClosePos: -1,
    longDqCache: null,
    sqScanStart: -1,
    sqScanEnd: -1,
    sqClosePos: -1,
    longSqCache: null,
    longSpans: new Map(),
  };
}

function skipWsCached(memo: AuthBracketMemo, text: string, pos: number): number {
  if (pos >= memo.skipWsStart && pos < memo.skipWsEnd) {
    return memo.skipWsEnd;
  }
  if (memo.longWsCache !== null) {
    const hit = lookupHalfOpenLongRun(memo.longWsCache, pos);
    if (hit !== undefined) {
      memo.skipWsStart = hit.start;
      memo.skipWsEnd = hit.end;
      return hit.end;
    }
  }
  const start = pos;
  while (pos < text.length && isWsCode(text.charCodeAt(pos))) {
    pos++;
  }
  if (pos > start) {
    let storeStart = start;
    if (pos - start >= LONG_CACHE_THRESHOLD) {
      while (storeStart > 0 && isWsCode(text.charCodeAt(storeStart - 1))) {
        storeStart--;
      }
      if (memo.longWsCache === null) {
        memo.longWsCache = createLongRunCache();
      }
      insertHalfOpenLongRun(memo.longWsCache, {
        start: storeStart,
        end: pos,
        extra: 0,
      });
    }
    memo.skipWsStart = storeStart;
    memo.skipWsEnd = pos;
  }
  return pos;
}

function skipHorizWsCached(memo: AuthBracketMemo, text: string, pos: number): number {
  if (pos >= memo.skipHorizWsStart && pos < memo.skipHorizWsEnd) {
    return memo.skipHorizWsEnd;
  }
  if (memo.longHorizWsCache !== null) {
    const hit = lookupHalfOpenLongRun(memo.longHorizWsCache, pos);
    if (hit !== undefined) {
      memo.skipHorizWsStart = hit.start;
      memo.skipHorizWsEnd = hit.end;
      return hit.end;
    }
  }
  const start = pos;
  while (pos < text.length && isHorizWsCode(text.charCodeAt(pos))) {
    pos++;
  }
  if (pos > start) {
    let storeStart = start;
    if (pos - start >= LONG_CACHE_THRESHOLD) {
      while (storeStart > 0 && isHorizWsCode(text.charCodeAt(storeStart - 1))) {
        storeStart--;
      }
      if (memo.longHorizWsCache === null) {
        memo.longHorizWsCache = createLongRunCache();
      }
      insertHalfOpenLongRun(memo.longHorizWsCache, {
        start: storeStart,
        end: pos,
        extra: 0,
      });
    }
    memo.skipHorizWsStart = storeStart;
    memo.skipHorizWsEnd = pos;
  }
  return pos;
}

function findCloseQuoteSameLineCached(
  memo: AuthBracketMemo,
  text: string,
  from: number,
  quoteCode: number,
): number {
  const isDouble = quoteCode === 34;
  const scanStart = isDouble ? memo.dqScanStart : memo.sqScanStart;
  const scanEnd = isDouble ? memo.dqScanEnd : memo.sqScanEnd;
  const cachedClose = isDouble ? memo.dqClosePos : memo.sqClosePos;
  if (scanStart >= 0 && from >= scanStart && from <= scanEnd) {
    if (cachedClose < 0) return -1;
    if (from <= cachedClose) return cachedClose;
  }
  const longCache = isDouble ? memo.longDqCache : memo.longSqCache;
  if (longCache !== null) {
    const hit = lookupHalfOpenLongRun(longCache, from);
    if (hit !== undefined) {
      if (isDouble) {
        memo.dqScanStart = hit.start;
        memo.dqScanEnd = hit.end;
        memo.dqClosePos = hit.extra;
      } else {
        memo.sqScanStart = hit.start;
        memo.sqScanEnd = hit.end;
        memo.sqClosePos = hit.extra;
      }
      return hit.extra;
    }
  }
  let closeQ = -1;
  let i = from;
  for (; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10 || c === 13) break;
    if (c === quoteCode) {
      closeQ = i;
      break;
    }
  }
  const end = closeQ >= 0 ? closeQ : i;
  let storeStart = from;
  if (end - from >= LONG_CACHE_THRESHOLD) {
    while (storeStart > 0) {
      const pc = text.charCodeAt(storeStart - 1);
      if (pc === 10 || pc === 13 || pc === quoteCode) break;
      storeStart--;
    }
    let targetCache = isDouble ? memo.longDqCache : memo.longSqCache;
    if (targetCache === null) {
      targetCache = createLongRunCache();
      if (isDouble) memo.longDqCache = targetCache;
      else memo.longSqCache = targetCache;
    }
    insertHalfOpenLongRun(targetCache, {
      start: storeStart,
      end,
      extra: closeQ,
    });
  }
  if (isDouble) {
    memo.dqScanStart = storeStart;
    memo.dqScanEnd = end;
    memo.dqClosePos = closeQ;
  } else {
    memo.sqScanStart = storeStart;
    memo.sqScanEnd = end;
    memo.sqClosePos = closeQ;
  }
  return closeQ;
}

function findNonWsSpanCached(
  memo: AuthBracketMemo,
  text: string,
  pos: number,
): { wsEnd: number; afterHorizWs: number } {
  if (pos >= memo.wsStart0 && pos <= memo.wsEnd0) {
    return { wsEnd: memo.wsEnd0, afterHorizWs: memo.wsAfterHoriz0 };
  }
  if (pos >= memo.wsStart1 && pos <= memo.wsEnd1) {
    const s = memo.wsStart1;
    const e = memo.wsEnd1;
    const a = memo.wsAfterHoriz1;
    memo.wsStart1 = memo.wsStart0;
    memo.wsEnd1 = memo.wsEnd0;
    memo.wsAfterHoriz1 = memo.wsAfterHoriz0;
    memo.wsStart0 = s;
    memo.wsEnd0 = e;
    memo.wsAfterHoriz0 = a;
    return { wsEnd: e, afterHorizWs: a };
  }
  if (memo.longNonWsCache !== null) {
    const hit = lookupClosedLongRun(memo.longNonWsCache, pos);
    if (hit !== undefined) {
      memo.wsStart1 = memo.wsStart0;
      memo.wsEnd1 = memo.wsEnd0;
      memo.wsAfterHoriz1 = memo.wsAfterHoriz0;
      memo.wsStart0 = hit.start;
      memo.wsEnd0 = hit.end;
      memo.wsAfterHoriz0 = hit.extra;
      return { wsEnd: hit.end, afterHorizWs: hit.extra };
    }
  }
  let end = pos;
  while (end < text.length && !isWsCode(text.charCodeAt(end))) {
    end++;
  }
  const afterHoriz = skipHorizWsCached(memo, text, end);
  let storeStart = pos;
  if (end - pos >= LONG_CACHE_THRESHOLD) {
    while (storeStart > 0 && !isWsCode(text.charCodeAt(storeStart - 1))) {
      storeStart--;
    }
    if (memo.longNonWsCache === null) {
      memo.longNonWsCache = createLongRunCache();
    }
    insertClosedLongRun(memo.longNonWsCache, {
      start: storeStart,
      end,
      extra: afterHoriz,
    });
  }
  memo.wsStart1 = memo.wsStart0;
  memo.wsEnd1 = memo.wsEnd0;
  memo.wsAfterHoriz1 = memo.wsAfterHoriz0;
  memo.wsStart0 = storeStart;
  memo.wsEnd0 = end;
  memo.wsAfterHoriz0 = afterHoriz;
  return { wsEnd: end, afterHorizWs: afterHoriz };
}

function getOrBuildLongSpanSummary(
  memo: AuthBracketMemo,
  text: string,
  pos: number,
  wsEnd: number,
  afterHorizWs: number,
): NonWsSpanSummary {
  const existing = memo.longSpans.get(wsEnd);
  if (existing !== undefined) {
    return existing;
  }
  let spanStart = pos;
  while (spanStart > 0 && !isWsCode(text.charCodeAt(spanStart - 1))) {
    spanStart--;
  }
  let lastBracePos = -1;
  let prevQuotePos = -1;
  let lastQuotePos = -1;
  let lastBasicCredStart = -1;
  let lastBasicCredStartNoTrailEq = -1;

  let i = spanStart;
  while (i < wsEnd) {
    const c = text.charCodeAt(i);
    if (c === 34 || c === 39) {
      prevQuotePos = lastQuotePos;
      lastQuotePos = i;
      i++;
      continue;
    }
    if ((c === 123 || c === 125) && i + 1 < wsEnd && text.charCodeAt(i + 1) === c) {
      lastBracePos = i;
      i++;
      continue;
    }
    if (isBasicCredCharCode(c)) {
      const runStart = i;
      while (i < wsEnd && isBasicCredCharCode(text.charCodeAt(i))) {
        i++;
      }
      const runLen = i - runStart;
      if (runLen >= 8 && looksLikeBasicCredentialRange(text, runStart, i)) {
        lastBasicCredStart = runStart;
        if (i < wsEnd || text.charCodeAt(wsEnd - 1) !== 61) {
          lastBasicCredStartNoTrailEq = runStart;
        } else if (runLen - 1 >= 8 && looksLikeBasicCredentialRange(text, runStart, i - 1)) {
          lastBasicCredStartNoTrailEq = runStart;
        }
      }
      continue;
    }
    i++;
  }

  const summary: NonWsSpanSummary = {
    spanStart,
    spanEnd: wsEnd,
    afterHorizWs,
    lastBracePos,
    prevQuotePos,
    lastQuotePos,
    lastBasicCredStart,
    lastBasicCredStartNoTrailEq,
  };
  memo.longSpans.set(wsEnd, summary);
  return summary;
}

function hasBasicCredInDeferredSpan(text: string, def: DeferredBasicSpan): boolean {
  const { summary, pos, wsEnd, stripTrailEq } = def;
  const endBound = stripTrailEq ? wsEnd - 1 : wsEnd;
  if (pos >= endBound) return false;
  const splitsRun =
    pos > summary.spanStart &&
    isBasicCredCharCode(text.charCodeAt(pos - 1)) &&
    isBasicCredCharCode(text.charCodeAt(pos));
  if (!splitsRun) {
    return (
      (stripTrailEq ? summary.lastBasicCredStartNoTrailEq : summary.lastBasicCredStart) >= pos
    );
  }
  let runEnd = pos;
  while (runEnd < endBound && isBasicCredCharCode(text.charCodeAt(runEnd))) {
    runEnd++;
  }
  if (runEnd - pos >= 8 && looksLikeBasicCredentialRange(text, pos, runEnd)) {
    return true;
  }
  return (
    (stripTrailEq ? summary.lastBasicCredStartNoTrailEq : summary.lastBasicCredStart) >= runEnd
  );
}

function ensureAuthLastClose(memo: AuthBracketMemo, text: string): void {
  if (memo.lastCloseComputed) return;
  memo.lastCloseComputed = true;
  const lc = memo.lastClose;
  let found = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    const c = text.charCodeAt(i);
    if (c === 41 && lc[0] < 0) {
      lc[0] = i;
      found++;
    } else if (c === 93 && lc[1] < 0) {
      lc[1] = i;
      found++;
    } else if (c === 125 && lc[2] < 0) {
      lc[2] = i;
      found++;
    } else if (c === 62 && lc[3] < 0) {
      lc[3] = i;
      found++;
    }
    if (found === 4) break;
  }
}

function ensureAuthKindMaps(
  memo: AuthBracketMemo,
  text: string,
  kind: 0 | 1 | 2 | 3,
  openCode: number,
  closeCode: number,
): void {
  if (memo.kindScanned[kind]) return;
  memo.kindScanned[kind] = true;
  const map = new Map<number, number>();
  const mapNoQ = new Map<number, number>();
  const stack: number[] = [];
  const stackNoQ: number[] = [];
  let inQ = 0;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10 || c === 13) {
      stack.length = 0;
      stackNoQ.length = 0;
      inQ = 0;
      escaped = false;
      continue;
    }
    // Quote-agnostic stack (handles stray unclosed quote earlier on same line)
    if (c === openCode) {
      stackNoQ.push(i);
    } else if (c === closeCode && stackNoQ.length > 0) {
      mapNoQ.set(stackNoQ.pop()!, i);
    }
    // Quote-aware stack
    if (inQ !== 0) {
      if (escaped) escaped = false;
      else if (c === 92) escaped = true;
      else if (c === inQ) inQ = 0;
      continue;
    }
    if (c === 34 || c === 39) {
      inQ = c;
      continue;
    }
    if (c === openCode) {
      stack.push(i);
    } else if (c === closeCode && stack.length > 0) {
      map.set(stack.pop()!, i);
    }
  }
  memo.matchedClose[kind] = map;
  memo.matchedCloseNoQuote[kind] = mapNoQ;
}

function isCleanAuthEnclosureBoundaryAt(
  text: string,
  idx: number,
  enclosingQuote: string | null,
): boolean {
  if (idx >= text.length) return true;
  const code = text.charCodeAt(idx);
  if (isWsCode(code)) return true;
  if (enclosingQuote && text[idx] === enclosingQuote) return true;
  // ',' | ';' | ')' | ']' | '}' | '&' | '#'
  if (
    code === 44 ||
    code === 59 ||
    code === 41 ||
    code === 93 ||
    code === 125 ||
    code === 38 ||
    code === 35
  ) {
    return true;
  }
  // Sentence-ending '.' | '!' | '?' only if followed by EOF/ws/closing punct/enclosing quote
  if (code === 46 || code === 33 || code === 63) {
    if (idx + 1 >= text.length) return true;
    const nextCode = text.charCodeAt(idx + 1);
    return (
      isWsCode(nextCode) ||
      nextCode === 41 ||
      nextCode === 93 ||
      nextCode === 125 ||
      nextCode === 44 ||
      nextCode === 59 ||
      (enclosingQuote !== null && text[idx + 1] === enclosingQuote)
    );
  }
  return false;
}

type AuthDeferredSpanMode = 'none' | 'basic' | 'bearer_kv';

function extractAuthPayload(
  text: string,
  startIdx: number,
  enclosingQuote: string | null,
  bracketMemo: AuthBracketMemo,
  deferMode: AuthDeferredSpanMode = 'none',
): AuthPayload {
  const pos = skipWsCached(bracketMemo, text, startIdx);
  if (pos >= text.length) {
    return {
      unwrapped: '',
      kind: 'unquoted',
      hasBrokenQuote: false,
      followedByKvSep: false,
      restAfterKvSepStart: pos,
      consumedEnd: pos,
      enclosureOverflow: false,
    };
  }

  const first = text[pos]!;

  // 1. Quoted payload (`"..."` or `'...'`)
  if (first === '"' || first === "'") {
    const closeQ = findCloseQuoteSameLineCached(
      bracketMemo,
      text,
      pos + 1,
      first === '"' ? 34 : 39,
    );
    if (closeQ > pos) {
      if (isCleanAuthEnclosureBoundaryAt(text, closeQ + 1, enclosingQuote)) {
        const inner = text.slice(pos + 1, closeQ).trim();
        return {
          unwrapped: inner,
          kind: 'quoted',
          hasBrokenQuote: false,
          followedByKvSep: false,
          restAfterKvSepStart: closeQ + 1,
          consumedEnd: closeQ + 1,
          enclosureOverflow: false,
        };
      }
      // Check `Bearer "key": value`
      let afterClose = closeQ + 1;
      while (afterClose < text.length && isHorizWsCode(text.charCodeAt(afterClose))) {
        afterClose++;
      }
      if (
        afterClose < text.length &&
        (text[afterClose] === ':' || text[afterClose] === '=')
      ) {
        const inner = text.slice(pos + 1, closeQ).trim();
        if (!inner.includes('{{')) {
          return {
            unwrapped: inner,
            kind: 'quoted',
            hasBrokenQuote: false,
            followedByKvSep: true,
            restAfterKvSepStart: afterClose + 1,
            consumedEnd: closeQ + 1,
            enclosureOverflow: false,
          };
        }
      }
    }
    const { wsEnd, afterHorizWs } = findNonWsSpanCached(bracketMemo, text, pos);
    if (deferMode === 'basic' && wsEnd - pos > LONG_SPAN_MEMO_THRESHOLD) {
      const summary = getOrBuildLongSpanSummary(bracketMemo, text, pos, wsEnd, afterHorizWs);
      if (summary.lastBracePos < pos) {
        return {
          unwrapped: '',
          kind: 'unquoted',
          hasBrokenQuote: true,
          followedByKvSep: false,
          restAfterKvSepStart: wsEnd,
          consumedEnd: wsEnd,
          enclosureOverflow: false,
          deferredBasicSpan: { summary, pos, wsEnd, stripTrailEq: false },
        };
      }
    }
    return {
      unwrapped: text.slice(pos, wsEnd),
      kind: 'unquoted',
      hasBrokenQuote: true,
      followedByKvSep: false,
      restAfterKvSepStart: wsEnd,
      consumedEnd: wsEnd,
      enclosureOverflow: false,
    };
  }

  // 2. Bracketed payload (`(...)`, `[...]`, `<...>`, or `{...}` excluding `{{`)
  if (
    first === '(' ||
    first === '[' ||
    first === '<' ||
    (first === '{' && text[pos + 1] !== '{')
  ) {
    const kind: 0 | 1 | 2 | 3 =
      first === '(' ? 0 : first === '[' ? 1 : first === '{' ? 2 : 3;
    const openCode = text.charCodeAt(pos);
    const closeCode = kind === 0 ? 41 : kind === 1 ? 93 : kind === 2 ? 125 : 62;

    ensureAuthLastClose(bracketMemo, text);
    let matchedEnd = -1;
    let resolvedSmall = false;

    if (bracketMemo.lastClose[kind] > pos) {
      // Fast O(1) local scan for <= 64 chars (exact local quote state, unaffected by earlier line quotes)
      if (!bracketMemo.kindScanned[kind]) {
        let depth = 1;
        let inQ = 0;
        let escaped = false;
        const fastLimit = Math.min(text.length, pos + 1 + MAX_AUTH_BRACKET_FAST_SCAN);
        for (let i = pos + 1; i < fastLimit; i++) {
          const c = text.charCodeAt(i);
          if (c === 10 || c === 13) {
            resolvedSmall = true;
            break;
          }
          if (inQ !== 0) {
            if (escaped) escaped = false;
            else if (c === 92) escaped = true;
            else if (c === inQ) inQ = 0;
            continue;
          }
          if (c === 34 || c === 39) {
            inQ = c;
            continue;
          }
          if (c === openCode) {
            depth++;
          } else if (c === closeCode) {
            depth--;
            if (depth === 0) {
              matchedEnd = i;
              resolvedSmall = true;
              break;
            }
          }
        }
        if (!resolvedSmall && fastLimit === text.length) {
          resolvedSmall = true;
        }
      }
      // If not resolved within 64 chars, build single-pass O(N) map ONCE for this bracket kind
      if (!resolvedSmall) {
        ensureAuthKindMaps(bracketMemo, text, kind, openCode, closeCode);
        const qMatch = bracketMemo.matchedClose[kind]!.get(pos);
        const noQMatch = bracketMemo.matchedCloseNoQuote[kind]!.get(pos);
        const candidate = qMatch !== undefined ? qMatch : (noQMatch ?? -1);
        if (candidate > pos && candidate - pos <= MAX_AUTH_BRACKET_SPAN) {
          matchedEnd = candidate;
        }
      }
    }

    if (
      matchedEnd > pos &&
      matchedEnd - pos <= MAX_AUTH_BRACKET_SPAN &&
      isCleanAuthEnclosureBoundaryAt(text, matchedEnd + 1, enclosingQuote)
    ) {
      const inner = text.slice(pos + 1, matchedEnd).trim();
      const qInner = unwrapCleanQuotePair(inner);
      const effective = qInner ?? inner;
      return {
        unwrapped: effective,
        kind: 'bracketed',
        hasBrokenQuote: qInner === null && (inner.includes('"') || inner.includes("'")),
        followedByKvSep: false,
        restAfterKvSepStart: matchedEnd + 1,
        consumedEnd: matchedEnd + 1,
        enclosureOverflow: false,
      };
    }

    // Unclosed, oversized (> 1024 chars), or dirty-boundary enclosure: O(1) overflow return (I3C-1)
    return {
      unwrapped: '',
      kind: 'unquoted',
      hasBrokenQuote: false,
      followedByKvSep: false,
      restAfterKvSepStart: pos + 1,
      consumedEnd: pos + 1, // start trailing check right after opening bracket
      enclosureOverflow: true,
    };
  }

  // 3. Unquoted mustache placeholder `{{...}}` ONLY when followed by a clean outer boundary
  if (first === '{' && text[pos + 1] === '{') {
    let closePh = -1;
    const limit = Math.min(text.length, pos + 256);
    for (let i = pos + 2; i + 1 < limit; i++) {
      const c = text.charCodeAt(i);
      if (c === 10 || c === 13) break;
      if (c === 125 && text.charCodeAt(i + 1) === 125) {
        closePh = i;
        break;
      }
    }
    if (closePh >= 0 && isCleanAuthEnclosureBoundaryAt(text, closePh + 2, enclosingQuote)) {
      const phEnd = closePh + 2;
      const afterWs = skipWsCached(bracketMemo, text, phEnd);
      const followedByKvSep =
        afterWs < text.length &&
        (text.charCodeAt(afterWs) === 58 || text.charCodeAt(afterWs) === 61);
      return {
        unwrapped: text.slice(pos, phEnd).trim(),
        kind: 'unquoted',
        hasBrokenQuote: false,
        followedByKvSep,
        restAfterKvSepStart: followedByKvSep ? afterWs + 1 : phEnd,
        consumedEnd: phEnd,
        enclosureOverflow: false,
      };
    }
  }

  // 4. General unquoted token up to whitespace (cached wsEnd/afterHorizWs + deferred long span)
  const { wsEnd, afterHorizWs } = findNonWsSpanCached(bracketMemo, text, pos);
  if (deferMode !== 'none' && wsEnd - pos > LONG_SPAN_MEMO_THRESHOLD) {
    const summary = getOrBuildLongSpanSummary(bracketMemo, text, pos, wsEnd, afterHorizWs);
    if (summary.lastBracePos < pos) {
      const hasQuoteInRange = summary.lastQuotePos >= pos;
      let followedByKvSep = false;
      let restAfterKvSepStart = wsEnd;
      let stripTrailEq = false;
      let strippedEnclosing = false;

      if (enclosingQuote !== null) {
        const strippedEnd = trimTrailingEndIdx(
          text,
          pos,
          wsEnd,
          isEnclosingQuoteTrailPunctCode,
        );
        if (
          strippedEnd > pos &&
          text.charCodeAt(strippedEnd - 1) === enclosingQuote.charCodeAt(0) &&
          summary.lastQuotePos === strippedEnd - 1 &&
          summary.prevQuotePos < pos
        ) {
          strippedEnclosing = true;
        }
      }

      if (!strippedEnclosing) {
        const lastCode = text.charCodeAt(wsEnd - 1);
        if (!hasQuoteInRange && (lastCode === 58 || lastCode === 61)) {
          followedByKvSep = true;
          restAfterKvSepStart = wsEnd;
          stripTrailEq = lastCode === 61;
        } else if (
          afterHorizWs < text.length &&
          (text.charCodeAt(afterHorizWs) === 58 || text.charCodeAt(afterHorizWs) === 61)
        ) {
          followedByKvSep = true;
          restAfterKvSepStart = afterHorizWs + 1;
        }
      }

      if (deferMode === 'basic' || followedByKvSep) {
        return {
          unwrapped: '',
          kind: 'unquoted',
          hasBrokenQuote: !strippedEnclosing && hasQuoteInRange,
          followedByKvSep,
          restAfterKvSepStart,
          consumedEnd: wsEnd,
          enclosureOverflow: false,
          deferredBasicSpan: { summary, pos, wsEnd, stripTrailEq },
        };
      }
    }
  }

  const wsSpan = text.slice(pos, wsEnd);

  // Strip clean closing enclosingQuote if `Bearer` itself began right after `"` / `'`
  if (enclosingQuote !== null) {
    const strippedPunct = trimTrailingChars(wsSpan, isEnclosingQuoteTrailPunctCode);
    if (strippedPunct.endsWith(enclosingQuote)) {
      const withoutClose = strippedPunct.slice(0, -1);
      if (!withoutClose.includes('"') && !withoutClose.includes("'")) {
        return {
          unwrapped: withoutClose,
          kind: 'unquoted',
          hasBrokenQuote: false,
          followedByKvSep: false,
          restAfterKvSepStart: wsEnd,
          consumedEnd: wsEnd,
          enclosureOverflow: false,
        };
      }
    }
  }

  let lhsRaw = wsSpan;
  let followedByKvSep = false;
  let restAfterKvSepStart = wsEnd;
  if (
    !wsSpan.includes('{{') &&
    !wsSpan.includes('"') &&
    !wsSpan.includes("'") &&
    (wsSpan.endsWith(':') || wsSpan.endsWith('='))
  ) {
    lhsRaw = wsSpan.slice(0, -1);
    followedByKvSep = true;
    restAfterKvSepStart = wsEnd;
  } else if (
    afterHorizWs < text.length &&
    (text.charCodeAt(afterHorizWs) === 58 || text.charCodeAt(afterHorizWs) === 61)
  ) {
    followedByKvSep = true;
    restAfterKvSepStart = afterHorizWs + 1;
  }

  const cleaned =
    !lhsRaw.includes('{{') && !lhsRaw.includes('"') && !lhsRaw.includes("'")
      ? trimTrailingChars(lhsRaw, isAuthTrailPunctCode)
      : lhsRaw;

  const encInner = unwrapBalancedEnclosure(cleaned);
  if (encInner !== null) {
    const qInner = unwrapCleanQuotePair(encInner);
    return {
      unwrapped: qInner ?? encInner,
      kind: 'bracketed',
      hasBrokenQuote: qInner === null && (encInner.includes('"') || encInner.includes("'")),
      followedByKvSep,
      restAfterKvSepStart,
      consumedEnd: wsEnd,
      enclosureOverflow: false,
    };
  }

  return {
    unwrapped: cleaned,
    kind: 'unquoted',
    hasBrokenQuote: cleaned.includes('"') || cleaned.includes("'"),
    followedByKvSep,
    restAfterKvSepStart,
    consumedEnd: wsEnd,
    enclosureOverflow: false,
  };
}

function isProtectedAuthHeaderAt(
  text: string,
  valStart: number,
  trimmedLineEnd: number,
  paramLookup: ParamLookup,
  bracketMemo: AuthBracketMemo,
): boolean {
  if (valStart >= trimmedLineEnd) return true;
  const firstCode = text.charCodeAt(valStart);
  if (firstCode === 123) {
    if (trimmedLineEnd - valStart > 256) return false;
    return isProtectedPlaceholder(text.slice(valStart, trimmedLineEnd), paramLookup);
  }
  if (firstCode !== 66 && firstCode !== 98) {
    return false;
  }
  let schemeLen = 0;
  if (valStart + 6 < trimmedLineEnd && matchesAsciiIgnoreCaseAt(text, valStart, 'bearer')) {
    schemeLen = 6;
  } else if (valStart + 5 < trimmedLineEnd && matchesAsciiIgnoreCaseAt(text, valStart, 'basic')) {
    schemeLen = 5;
  } else {
    return false;
  }
  const afterSchemeIdx = valStart + schemeLen;
  const sepChCode = text.charCodeAt(afterSchemeIdx);
  if (
    !isWsCode(sepChCode) &&
    sepChCode !== 58 &&
    sepChCode !== 61 &&
    sepChCode !== 34 &&
    sepChCode !== 39 &&
    sepChCode !== 40 &&
    sepChCode !== 91 &&
    sepChCode !== 123 &&
    sepChCode !== 60
  ) {
    return false;
  }
  let s1 = afterSchemeIdx;
  while (s1 < trimmedLineEnd && isHorizWsCode(text.charCodeAt(s1))) s1++;
  if (s1 < trimmedLineEnd && (text.charCodeAt(s1) === 58 || text.charCodeAt(s1) === 61)) {
    s1++;
    while (s1 < trimmedLineEnd && isHorizWsCode(text.charCodeAt(s1))) s1++;
  }
  if (s1 >= trimmedLineEnd) return true;

  const payload = extractAuthPayload(text, s1, null, bracketMemo);
  if (
    payload.enclosureOverflow ||
    payload.hasBrokenQuote ||
    (payload.followedByKvSep && payload.restAfterKvSepStart <= trimmedLineEnd)
  ) {
    return false;
  }
  if (payload.unwrapped.length > 0) {
    let ok = isProtectedPlaceholder(payload.unwrapped, paramLookup);
    if (!ok) {
      const inner = unwrapBalancedEnclosure(payload.unwrapped);
      if (inner !== null) ok = isProtectedPlaceholder(inner, paramLookup);
    }
    if (!ok) return false;
  }
  let tailPos = payload.consumedEnd;
  while (tailPos < trimmedLineEnd && isHorizWsCode(text.charCodeAt(tailPos))) tailPos++;
  const rem = trimmedLineEnd - tailPos;
  if (rem === 0) return true;
  if (rem === 1) {
    const c = text.charCodeAt(tailPos);
    return c === 46 || c === 41 || c === 93 || c === 125;
  }
  return false;
}

/**
 * Classifies a verified-safe, whitespace-free token `text[tokStart..tokEnd)` into:
 * - `'none'`: contains neither `'{{'` nor `'}}'` (single `'{'` / `'}'` stays `'none'`).
 * - `'kv_placeholder'`: contains `'{{'`/`'}}'`, leading `isBraceTokOuterTrimCode` prefix has
 *   NO `"` or `'`, and outer-trimmed body does not start with `'{{'` (so it passed
 *   `isSafeBearerOrBasicTokenWithBraces` via `lhs[:=]{{secret}}`).
 * - `'placeholder'`: contains `'{{'`/`'}}'` and is NOT a quote-free `'kv_placeholder'`.
 */
function classifySafeTokenBraceKind(
  text: string,
  tokStart: number,
  tokEnd: number,
  bracketMemo: AuthBracketMemo,
): FirstTokBraceKind {
  if (tokStart >= tokEnd) return 'none';

  let hasDoubleBrace = false;
  const existing =
    tokEnd - tokStart > LONG_SPAN_MEMO_THRESHOLD ? bracketMemo.longSpans.get(tokEnd) : undefined;
  if (existing !== undefined && existing.spanStart <= tokStart) {
    hasDoubleBrace = existing.lastBracePos >= tokStart;
  } else {
    for (let i = tokStart; i + 1 < tokEnd; i++) {
      const c = text.charCodeAt(i);
      if ((c === 123 || c === 125) && text.charCodeAt(i + 1) === c) {
        hasDoubleBrace = true;
        break;
      }
    }
  }
  if (!hasDoubleBrace) return 'none';

  let tStart = tokStart;
  let leadHadQuote = false;
  while (tStart < tokEnd) {
    const c = text.charCodeAt(tStart);
    if (!isBraceTokOuterTrimCode(c)) break;
    if (c === 34 || c === 39) leadHadQuote = true;
    tStart++;
  }
  if (leadHadQuote || tStart >= tokEnd) {
    return 'placeholder';
  }
  if (
    tStart + 1 < tokEnd &&
    text.charCodeAt(tStart) === 123 &&
    text.charCodeAt(tStart + 1) === 123
  ) {
    return 'placeholder';
  }
  return 'kv_placeholder';
}

function classifySafeFirstTokBraceKindFresh(
  text: string,
  pos: number,
  lineEnd: number,
  bracketMemo: AuthBracketMemo,
): FirstTokBraceKind {
  let tokStart = pos;
  while (tokStart < lineEnd && isWsCode(text.charCodeAt(tokStart))) {
    tokStart++;
  }
  if (tokStart >= lineEnd) return 'none';
  const { wsEnd } = findNonWsSpanCached(bracketMemo, text, tokStart);
  const tokEnd = wsEnd < lineEnd ? wsEnd : lineEnd;
  return classifySafeTokenBraceKind(text, tokStart, tokEnd, bracketMemo);
}

function checkSameLineTrailingSafe(
  text: string,
  tailStart: number,
  enclosingQuote: string | null,
  isBearer: boolean,
  isBasic: boolean,
  paramLookup: ParamLookup,
  memo: SameLineMemo,
  bracketMemo: AuthBracketMemo,
  strictBearerEnclosure = false,
): boolean {
  // 1. Leading horizontal ws & optional closing enclosingQuote + punct skip (thrash-proof)
  let pos = tailStart;
  if (pos >= memo.wsSkipStart && pos < memo.wsSkipEnd) {
    pos = memo.wsSkipEnd;
  } else {
    const hit =
      memo.longWsSkipCache !== null ? lookupHalfOpenLongRun(memo.longWsSkipCache, pos) : undefined;
    if (hit !== undefined) {
      memo.wsSkipStart = hit.start;
      memo.wsSkipEnd = hit.end;
      pos = hit.end;
    } else {
      const ws0 = pos;
      while (pos < text.length && isHorizWsCode(text.charCodeAt(pos))) {
        pos++;
      }
      if (pos > ws0) {
        let storeStart = ws0;
        if (pos - ws0 >= LONG_CACHE_THRESHOLD) {
          while (storeStart > 0 && isHorizWsCode(text.charCodeAt(storeStart - 1))) {
            storeStart--;
          }
          if (memo.longWsSkipCache === null) {
            memo.longWsSkipCache = createLongRunCache();
          }
          insertHalfOpenLongRun(memo.longWsSkipCache, {
            start: storeStart,
            end: pos,
            extra: 0,
          });
        }
        memo.wsSkipStart = storeStart;
        memo.wsSkipEnd = pos;
      }
    }
  }

  if (enclosingQuote !== null && pos < text.length && text[pos] === enclosingQuote) {
    pos++;
    if (pos >= memo.quotePunctSkipStart && pos < memo.quotePunctSkipEnd) {
      pos = memo.quotePunctSkipEnd;
    } else {
      const hit =
        memo.longQuotePunctSkipCache !== null
          ? lookupHalfOpenLongRun(memo.longQuotePunctSkipCache, pos)
          : undefined;
      if (hit !== undefined) {
        memo.quotePunctSkipStart = hit.start;
        memo.quotePunctSkipEnd = hit.end;
        pos = hit.end;
      } else {
        const qp0 = pos;
        while (pos < text.length && isQuoteTrailPunctOrHorizWsCode(text.charCodeAt(pos))) {
          pos++;
        }
        if (pos > qp0) {
          let storeStart = qp0;
          if (pos - qp0 >= LONG_CACHE_THRESHOLD) {
            while (
              storeStart > 0 &&
              isQuoteTrailPunctOrHorizWsCode(text.charCodeAt(storeStart - 1))
            ) {
              storeStart--;
            }
            if (memo.longQuotePunctSkipCache === null) {
              memo.longQuotePunctSkipCache = createLongRunCache();
            }
            insertHalfOpenLongRun(memo.longQuotePunctSkipCache, {
              start: storeStart,
              end: pos,
              extra: 0,
            });
          }
          memo.quotePunctSkipStart = storeStart;
          memo.quotePunctSkipEnd = pos;
        }
      }
    }
  }
  if (pos >= text.length) return true;
  const firstCode = text.charCodeAt(pos);
  if (firstCode === 10 || firstCode === 13) return true;

  if (memo.safeEnd >= 0 && pos >= memo.safeStart && pos <= memo.safeEnd) {
    return true;
  }
  if (memo.failedLineEnd >= 0 && pos >= memo.failedLineStart && pos <= memo.failedLineEnd) {
    return true;
  }

  // O(1) thrash-proof cached line bounds (avoids O(N^2) findLineStart/findLineEnd on alternating lines)
  let lineEnd: number;
  if (memo.cachedLineEnd >= 0 && pos >= memo.cachedLineStart && pos <= memo.cachedLineEnd) {
    lineEnd = memo.cachedLineEnd;
  } else {
    const lineHit =
      memo.longLineCache !== null ? lookupHalfOpenLongRun(memo.longLineCache, pos) : undefined;
    if (lineHit !== undefined) {
      memo.cachedLineStart = lineHit.start;
      memo.cachedLineEnd = lineHit.end;
      lineEnd = lineHit.end;
    } else {
      const ls = findLineStart(text, pos);
      lineEnd = findLineEnd(text, pos);
      memo.cachedLineStart = ls;
      memo.cachedLineEnd = lineEnd;
      if (lineEnd - ls >= LONG_CACHE_THRESHOLD) {
        if (memo.longLineCache === null) {
          memo.longLineCache = createLongRunCache();
        }
        insertHalfOpenLongRun(memo.longLineCache, {
          start: ls,
          end: lineEnd,
          extra: 0,
        });
      }
    }
  }

  // 2. Fresh line (`memo.safeEnd !== lineEnd`)
  if (memo.safeEnd !== lineEnd) {
    // O(1) reuse when extractAuthPayload already summarized this exact single-token Basic-only line tail
    if (!isBearer && lineEnd - pos > LONG_SPAN_MEMO_THRESHOLD && !isWsCode(text.charCodeAt(pos))) {
      const existingSummary = bracketMemo.longSpans.get(lineEnd);
      if (
        existingSummary !== undefined &&
        existingSummary.spanStart <= pos &&
        existingSummary.lastBracePos < pos
      ) {
        if (
          isBasic &&
          hasBasicCredInDeferredSpan(text, {
            summary: existingSummary,
            pos,
            wsEnd: lineEnd,
            stripTrailEq: false,
          })
        ) {
          memo.failedLineStart = pos;
          memo.failedLineEnd = lineEnd;
          return false;
        }
        memo.safeStart = pos;
        memo.safeEnd = lineEnd;
        memo.safeStartFirstTokBraceKind = 'none';
        return true;
      }
    }

    const tailSlice = text.slice(pos, lineEnd);
    if (
      !isSafeBearerOrBasicValue(tailSlice, isBearer, isBasic, paramLookup, strictBearerEnclosure)
    ) {
      memo.failedLineStart = pos;
      memo.failedLineEnd = lineEnd;
      return false;
    }
    memo.safeStart = pos;
    memo.safeEnd = lineEnd;
    memo.safeStartFirstTokBraceKind = classifySafeFirstTokBraceKindFresh(
      text,
      pos,
      lineEnd,
      bracketMemo,
    );
    return true;
  }

  // 3. Incremental left-extension (`memo.safeEnd === lineEnd && pos < memo.safeStart`)
  const prevSafeStart = memo.safeStart;
  const prevKind = memo.safeStartFirstTokBraceKind;
  const prevCh = text.charCodeAt(prevSafeStart - 1);
  const atCh = prevSafeStart < lineEnd ? text.charCodeAt(prevSafeStart) : 10;

  // Case 1: Whitespace boundary at `prevSafeStart` — tokens in [pos, prevSafeStart) are completely disjoint from T.
  if (isWsCode(prevCh) || isWsCode(atCh)) {
    const tailSlice = text.slice(pos, prevSafeStart);
    if (
      !isSafeBearerOrBasicValue(tailSlice, isBearer, isBasic, paramLookup, strictBearerEnclosure)
    ) {
      memo.failedLineStart = pos;
      memo.failedLineEnd = lineEnd;
      return false;
    }
    memo.safeStart = pos;
    let firstTokStart = pos;
    while (firstTokStart < prevSafeStart && isWsCode(text.charCodeAt(firstTokStart))) {
      firstTokStart++;
    }
    if (firstTokStart >= prevSafeStart) {
      memo.safeStartFirstTokBraceKind = isWsCode(atCh) ? 'none' : prevKind;
    } else {
      let firstTokEnd = firstTokStart;
      while (firstTokEnd < prevSafeStart && !isWsCode(text.charCodeAt(firstTokEnd))) {
        firstTokEnd++;
      }
      memo.safeStartFirstTokBraceKind = classifySafeTokenBraceKind(
        text,
        firstTokStart,
        firstTokEnd,
        bracketMemo,
      );
    }
    return true;
  }

  // Case 2: Non-whitespace seam (`!isWsCode(prevCh) && !isWsCode(atCh)`).
  // Decompose `[pos, prevSafeStart)` into:
  //   A = [pos, seamPrefStart)           — separate whitespace-delimited tokens strictly before the seam token
  //   P = [seamPrefStart, prevSafeStart) — non-empty whitespace-free prefix spliced onto T = [prevSafeStart, boundary)
  let seamPrefStart = prevSafeStart - 1;
  while (seamPrefStart > pos && !isWsCode(text.charCodeAt(seamPrefStart - 1))) {
    seamPrefStart--;
  }

  // Single O(|P|) pass over P collecting exact double-brace, outer-trim, and kv-hazard facts
  let pTrimStart = seamPrefStart;
  let leadHadQuoteInP = false;
  while (pTrimStart < prevSafeStart) {
    const c = text.charCodeAt(pTrimStart);
    if (!isBraceTokOuterTrimCode(c)) break;
    if (c === 34 || c === 39) leadHadQuoteInP = true;
    pTrimStart++;
  }
  const allBraceOuterTrimInP = pTrimStart === prevSafeStart;

  let allBearerCoreOuterTrimInP = true;
  let pHasDoubleBrace = false;
  let pLtrimHasKvHazard = false; // any `{`, `}`, `"`, `'`, `:`, `=` inside [pTrimStart, prevSafeStart)
  for (let k = seamPrefStart; k < prevSafeStart; k++) {
    const c = text.charCodeAt(k);
    if (allBearerCoreOuterTrimInP && !isBearerCoreOuterTrimCode(c)) {
      allBearerCoreOuterTrimInP = false;
    }
    if ((c === 123 || c === 125) && k + 1 < prevSafeStart && text.charCodeAt(k + 1) === c) {
      pHasDoubleBrace = true;
    }
    if (
      k >= pTrimStart &&
      (c === 123 || c === 125 || c === 34 || c === 39 || c === 58 || c === 61)
    ) {
      pLtrimHasKvHazard = true;
    }
  }
  const createsDoubleBrace =
    pHasDoubleBrace ||
    (prevCh === 123 && atCh === 123) ||
    (prevCh === 125 && atCh === 125);

  const commitLeftExt = (newSeamKind: FirstTokBraceKind): true => {
    memo.safeStart = pos;
    if (seamPrefStart > pos) {
      let firstTokStart = pos;
      while (firstTokStart < seamPrefStart && isWsCode(text.charCodeAt(firstTokStart))) {
        firstTokStart++;
      }
      let firstTokEnd = firstTokStart;
      while (firstTokEnd < seamPrefStart && !isWsCode(text.charCodeAt(firstTokEnd))) {
        firstTokEnd++;
      }
      memo.safeStartFirstTokBraceKind = classifySafeTokenBraceKind(
        text,
        firstTokStart,
        firstTokEnd,
        bracketMemo,
      );
    } else {
      memo.safeStartFirstTokBraceKind = newSeamKind;
    }
    return true;
  };

  // Subcase 2A: `prevKind === 'kv_placeholder'` — 100% exact O(|P|) decision, NEVER touches T
  if (prevKind === 'kv_placeholder') {
    if (!allBraceOuterTrimInP && pLtrimHasKvHazard) {
      memo.failedLineStart = pos;
      memo.failedLineEnd = lineEnd;
      return false;
    }
    if (
      seamPrefStart > pos &&
      !isSafeBearerOrBasicValue(
        text.slice(pos, seamPrefStart),
        isBearer,
        isBasic,
        paramLookup,
        strictBearerEnclosure,
      )
    ) {
      memo.failedLineStart = pos;
      memo.failedLineEnd = lineEnd;
      return false;
    }
    return commitLeftExt(leadHadQuoteInP ? 'placeholder' : 'kv_placeholder');
  }

  // Subcase 2B: `prevKind === 'placeholder'` with pure outer-trim prefix P
  if (prevKind === 'placeholder' && allBraceOuterTrimInP) {
    if (
      seamPrefStart > pos &&
      !isSafeBearerOrBasicValue(
        text.slice(pos, seamPrefStart),
        isBearer,
        isBasic,
        paramLookup,
        strictBearerEnclosure,
      )
    ) {
      memo.failedLineStart = pos;
      memo.failedLineEnd = lineEnd;
      return false;
    }
    return commitLeftExt('placeholder');
  }

  // Subcase 2C: `prevKind === 'none'` with no `{{`/`}}` created and sound Bearer/Basic seam
  if (
    prevKind === 'none' &&
    !createsDoubleBrace &&
    (!isBearer || allBearerCoreOuterTrimInP) &&
    (!isBasic || !(isBasicCredCharCode(prevCh) && isBasicCredCharCode(atCh)))
  ) {
    if (
      !isSafeBearerOrBasicValue(
        text.slice(pos, prevSafeStart),
        isBearer,
        isBasic,
        paramLookup,
        strictBearerEnclosure,
      )
    ) {
      memo.failedLineStart = pos;
      memo.failedLineEnd = lineEnd;
      return false;
    }
    return commitLeftExt('none');
  }

  // Subcase 2D (`else` fallback): resolve seam token `P + T = [seamPrefStart, boundary)`
  const { wsEnd, afterHorizWs } = findNonWsSpanCached(bracketMemo, text, prevSafeStart);
  const boundary = wsEnd < lineEnd ? wsEnd : lineEnd;

  // Deferred O(1)-amortized Basic-only fallback for long seam tokens (`!isBearer && boundary - seamPrefStart > 128`)
  if (!isBearer && boundary - seamPrefStart > LONG_SPAN_MEMO_THRESHOLD) {
    const summary = getOrBuildLongSpanSummary(
      bracketMemo,
      text,
      seamPrefStart,
      boundary,
      afterHorizWs,
    );
    if (summary.lastBracePos < seamPrefStart) {
      if (
        seamPrefStart > pos &&
        !isSafeBearerOrBasicValue(
          text.slice(pos, seamPrefStart),
          false,
          isBasic,
          paramLookup,
          strictBearerEnclosure,
        )
      ) {
        memo.failedLineStart = pos;
        memo.failedLineEnd = lineEnd;
        return false;
      }
      if (
        isBasic &&
        hasBasicCredInDeferredSpan(text, {
          summary,
          pos: seamPrefStart,
          wsEnd: boundary,
          stripTrailEq: false,
        })
      ) {
        memo.failedLineStart = pos;
        memo.failedLineEnd = lineEnd;
        return false;
      }
      return commitLeftExt('none');
    }
  }

  const tailSlice = text.slice(pos, boundary);
  if (!isSafeBearerOrBasicValue(tailSlice, isBearer, isBasic, paramLookup, strictBearerEnclosure)) {
    memo.failedLineStart = pos;
    memo.failedLineEnd = lineEnd;
    return false;
  }

  let newSeamKind: FirstTokBraceKind;
  if (prevKind === 'none' && !createsDoubleBrace) {
    newSeamKind = 'none';
  } else if (allBraceOuterTrimInP) {
    newSeamKind = 'placeholder';
  } else if (
    !leadHadQuoteInP &&
    !(
      pTrimStart + 1 < boundary &&
      text.charCodeAt(pTrimStart) === 123 &&
      text.charCodeAt(pTrimStart + 1) === 123
    )
  ) {
    newSeamKind = 'kv_placeholder';
  } else {
    newSeamKind = 'placeholder';
  }
  return commitLeftExt(newSeamKind);
}

/**
 * Recursively scans an arbitrary JSON value (manifest, request payload, changelog, etc.)
 * for leaked credentials, API keys, JWTs, PEM keys, Bearer/Basic headers, sensitive KV pairs,
 * nested JSON strings (preserving duplicate keys), percent/escape/form-encoded secrets,
 * and excessive nesting depth (`> 16`).
 *
 * Returns `{ safe: true, findings: [] }` when clean, or `{ safe: false, findings: [...] }`
 * with actionable paths and reasons for HTTP `422 secret_leak_detected` and UI validation.
 */
export function scanJsonForSecretLeaks(
  value: unknown,
  options?: SecretLeakScanOptions,
): SecretLeakScanResult {
  const rootContext = options?.context?.trim() || 'app';
  const maxDepth = options?.maxDepth ?? SECRET_SCAN_MAX_JSON_DEPTH;
  const params = options?.parameters ?? extractAutoParameters(value);
  const paramLookup = buildParamLookup(params);
  const findings: SecretLeakFinding[] = [];

  const isAborted = (stopAfter: number): boolean =>
    findings.length > stopAfter || findings.length >= MAX_SECRET_SCAN_FINDINGS;

  const recordFinding = (path: string, reason: string): void => {
    if (findings.length < MAX_SECRET_SCAN_FINDINGS) {
      findings.push({ path, reason });
    }
  };

  const validateSecretVaultKey = (
    vk: string,
    path: string,
    depth: number,
    outerStopAfter: number,
  ): void => {
    if (isAborted(outerStopAfter)) return;
    if (vk.includes('=')) {
      recordFinding(path, `plaintext '=' assignment detected in ${path}`);
      return;
    }
    const trimmed = vk.trim();
    const lower = asciiLowercase(trimmed);
    const basicIdx = lower.indexOf('basic ');
    if (basicIdx >= 0) {
      const validBoundary = basicIdx === 0 || !isAsciiAlnum(lower[basicIdx - 1]!);
      if (validBoundary) {
        const tok = trimmed.slice(basicIdx + 6).split(/\s+/)[0] ?? '';
        if (
          tok.length >= 8 &&
          /^[A-Za-z0-9+/=_:-]+$/.test(tok) &&
          /[A-Z0-9]/.test(tok)
        ) {
          recordFinding(path, `plaintext Basic credential detected in ${path}`);
          return;
        }
      }
    }
    let scanTarget = trimmed;
    if (scanTarget.endsWith(':password')) scanTarget = scanTarget.slice(0, -':password'.length);
    else if (scanTarget.endsWith(':username')) scanTarget = scanTarget.slice(0, -':username'.length);
    else if (scanTarget.endsWith(':totp')) scanTarget = scanTarget.slice(0, -':totp'.length);

    scanText(scanTarget, path, depth, outerStopAfter);
  };

  const scanParsedContainer = (
    res: LosslessJsonParseResult,
    path: string,
    depth: number,
    pathStop: number,
  ): void => {
    if (isAborted(pathStop)) return;
    if (res.depthExceeded) {
      recordFinding(path, `maximum JSON nesting depth (${maxDepth}) exceeded in ${path}`);
      return;
    }
    if (res.root !== null) {
      scanValue(res.root, `${path}<json>`, depth + 1, pathStop);
    }
  };

  const scanEmbeddedJsonContainers = (
    text: string,
    path: string,
    depth: number,
    fullParsedFailPos: number,
    pathStop: number,
  ): void => {
    if (isAborted(pathStop)) return;
    const lastCloseObj = text.lastIndexOf('}');
    const firstOpenObj = lastCloseObj > 0 ? text.indexOf('{') : -1;
    const hasObjCandidate = firstOpenObj >= 0 && firstOpenObj < lastCloseObj;

    const lastCloseArr = text.lastIndexOf(']');
    const firstOpenArr = lastCloseArr > 0 ? text.indexOf('[') : -1;
    const hasArrCandidate = firstOpenArr >= 0 && firstOpenArr < lastCloseArr;

    if (!hasObjCandidate && !hasArrCandidate) return;

    const objMap = hasObjCandidate ? scanJsonObjectBraceMap(text) : null;
    const arrMap = hasArrCandidate ? scanJsonArrayBracketMap(text) : null;

    const objectFailPoints: number[] = [];
    const arrayFailPoints: number[] = [];
    if (fullParsedFailPos > 0 && fullParsedFailPos < text.length) {
      if (objMap && objMap.matched.get(0) === text.length) {
        objectFailPoints.push(fullParsedFailPos);
      } else if (arrMap && arrMap.matched.get(0) === text.length) {
        arrayFailPoints.push(fullParsedFailPos);
      }
    }

    const failSkippedOpens = new Set<number>();
    let skipUntil = 0;
    let failedBytesBudget = Math.max(text.length * 4, 262_144);
    const maxOpenIdx = Math.max(
      hasObjCandidate ? lastCloseObj : 0,
      hasArrCandidate ? lastCloseArr : 0,
    );

    for (let idx = 0; idx < maxOpenIdx; idx++) {
      if (isAborted(pathStop)) return;
      if (idx < skipUntil) continue;
      const code = text.charCodeAt(idx);
      if (code !== 123 && code !== 91) continue;

      const isObj = code === 123;
      if (isObj) {
        if (!hasObjCandidate || idx >= lastCloseObj) continue;
        if (idx + 1 < text.length && text.charCodeAt(idx + 1) === 123) continue; // skip '{{'
      } else {
        if (!hasArrCandidate || idx >= lastCloseArr) continue;
      }

      const map = isObj ? objMap! : arrMap!;
      if (map.unclosed.has(idx)) continue;

      const matchedEnd = map.matched.get(idx);
      if (matchedEnd !== undefined) {
        if (idx === 0 && matchedEnd === text.length) continue;
        if (matchedEnd - idx < 2) continue;
        const failPoints = isObj ? objectFailPoints : arrayFailPoints;
        if (hasFailPointInside(failPoints, idx, matchedEnd)) continue;

        const parsed = parseLosslessJsonContainer(
          text,
          idx,
          matchedEnd,
          depth + 1,
          maxDepth,
          false,
        );
        if (parsed.valid) {
          scanParsedContainer(parsed, path, depth, pathStop);
          if (isAborted(pathStop)) return;
          skipUntil = parsed.endPos;
        } else {
          const consumed = Math.max(1, parsed.consumed);
          failedBytesBudget -= consumed;
          const failAbs = Math.min(matchedEnd - 1, idx + consumed);
          insertFailPointSorted(failPoints, Math.max(idx + 1, failAbs));
        }
      } else {
        // Streaming prefix-parse recovery for openers hidden under stray quotes / broken outer openers
        if (isObj) {
          if (!isPlausibleJsonObjectStart(text, idx)) continue;
        } else {
          if (!isPlausibleJsonArrayStart(text, idx)) continue;
        }
        if (failSkippedOpens.has(idx) || failedBytesBudget <= 0) continue;

        const parsed = parseLosslessJsonContainer(
          text,
          idx,
          text.length,
          depth + 1,
          maxDepth,
          true,
        );
        if (parsed.valid) {
          scanParsedContainer(parsed, path, depth, pathStop);
          if (isAborted(pathStop)) return;
          skipUntil = parsed.endPos;
        } else {
          const consumed = Math.max(1, parsed.consumed);
          failedBytesBudget -= consumed;
          const failAbs = Math.min(text.length, idx + consumed);
          markUnclosedContainersBeforeFail(text, idx, failAbs, failSkippedOpens);
        }
      }
    }
  };

  const scanTextSingleVariant = (
    text: string,
    path: string,
    depth: number,
    pathStop: number,
  ): void => {
    if (!text || isAborted(pathStop)) return;

    // 0. PEM private key block
    if (text.includes('PRIVATE KEY') && PEM_PRIVATE_KEY_RE.test(text)) {
      recordFinding(path, `PEM private key block detected in ${path}`);
      return;
    }

    // 1. Nested JSON object/array parsing (lossless duplicate-key preserving; falls through on failure)
    if (text.includes('{') || text.includes('[')) {
      const trimmed = text.trim();
      let fullParsedFailPos = -1;
      if (
        (trimmed.startsWith('{') && trimmed.endsWith('}') && !trimmed.startsWith('{{')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))
      ) {
        const fullParsed = parseLosslessJsonContainer(
          trimmed,
          0,
          trimmed.length,
          depth + 1,
          maxDepth,
          false,
        );
        if (fullParsed.valid) {
          scanParsedContainer(fullParsed, path, depth, pathStop);
          return;
        }
        fullParsedFailPos = fullParsed.failPos;
      }

      scanEmbeddedJsonContainers(trimmed, path, depth, fullParsedFailPos, pathStop);
      if (isAborted(pathStop)) return;
    }

    const authBracketMemo = createAuthBracketMemo();

    // 2. Inline KV assignments (`key=value` / `key: value`, checking key sensitivity FIRST)
    if (text.includes('=') || text.includes(':')) {
      // 3 isolated KV memos + 3 isolated URL tail memos prevent cross-mode cache poisoning (I2-C)
      const bearerKvLineMemo = createSameLineMemo();
      const basicKvLineMemo = createSameLineMemo();
      const bothKvLineMemo = createSameLineMemo();
      const bearerUrlLineMemo = createSameLineMemo();
      const basicUrlLineMemo = createSameLineMemo();
      const bothUrlLineMemo = createSameLineMemo();
      const kvLineMemo = createKvLineScanMemo();
      const kvValMemo = createKvValueMemo();

      type KeyCacheEntry = {
        key: string;
        isSensitive: boolean;
        hasBearer: boolean;
        hasBasic: boolean;
        isBearerOrBasicKey: boolean;
      };
      const keyCache: Array<KeyCacheEntry | null> = [
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ];
      let keyCacheNext = 0;

      let kvCachedLineStart = 0;
      let kvCachedLineEnd = -1;
      let kvCachedTrimmedLineEnd = -1;
      const getKvLineBounds = (pos: number): { lineEnd: number; trimmedLineEnd: number } => {
        if (kvCachedLineEnd >= 0 && pos >= kvCachedLineStart && pos <= kvCachedLineEnd) {
          return { lineEnd: kvCachedLineEnd, trimmedLineEnd: kvCachedTrimmedLineEnd };
        }
        kvCachedLineStart = pos;
        kvCachedLineEnd = findLineEnd(text, pos);
        let te = kvCachedLineEnd;
        while (te > 0 && isHorizWsCode(text.charCodeAt(te - 1))) {
          te--;
        }
        kvCachedTrimmedLineEnd = te;
        return { lineEnd: kvCachedLineEnd, trimmedLineEnd: kvCachedTrimmedLineEnd };
      };

      // Forward O(N) URL-context cursor + lazy backward index (I2-E)
      let urlDelimCursor = 0;
      let lastUrlPrefixStart = 0;
      let urlHasScheme = false;
      let urlHasQmark = false;
      let urlHasSlash = false;
      let fwdNextDbrace = 0;
      let fwdNextNl = 0;
      let backwardUrlCtx: BackwardUrlCtxIndex | null = null;

      const isInUrlQueryAtPos = (target: number): boolean => {
        if (target < urlDelimCursor) {
          if (backwardUrlCtx === null) {
            backwardUrlCtx = buildBackwardUrlCtxIndex(text);
          }
          return queryBackwardUrlCtx(backwardUrlCtx, target);
        }
        let i = urlDelimCursor;
        while (i < target) {
          const c = text.charCodeAt(i);
          if (c === 123 && i + 1 < text.length && text.charCodeAt(i + 1) === 123) {
            const searchFrom = i + 2;
            if (fwdNextDbrace < searchFrom) {
              const found = text.indexOf('}}', searchFrom);
              fwdNextDbrace = found < 0 ? text.length + 1 : found;
            }
            if (fwdNextNl < searchFrom) {
              const nl = findLineEnd(text, searchFrom);
              fwdNextNl = nl >= text.length ? text.length + 1 : nl;
            }
            if (fwdNextDbrace < target && fwdNextDbrace < fwdNextNl) {
              i = fwdNextDbrace + 2;
              continue;
            }
            i += 2;
            continue;
          }
          if (c === 91 && i > 0) {
            const prev = text.charCodeAt(i - 1);
            if (isAsciiAlnumCode(prev) || prev === 95 || prev === 93 || prev === 37) {
              i++;
              continue;
            }
          }
          if (
            isWsCode(c) ||
            c === 34 ||
            c === 39 ||
            c === 60 ||
            c === 40 ||
            c === 91 ||
            c === 123
          ) {
            lastUrlPrefixStart = i + 1;
            urlHasScheme = false;
            urlHasQmark = false;
            urlHasSlash = false;
          } else if (c === 63) {
            urlHasQmark = true;
          } else if (c === 47) {
            urlHasSlash = true;
            if (!urlHasScheme && i > lastUrlPrefixStart && text.charCodeAt(i - 1) === 47) {
              const prefLen = i + 1 - lastUrlPrefixStart;
              if (
                (prefLen >= 7 && matchesAsciiIgnoreCaseAt(text, i - 6, 'http://')) ||
                (prefLen >= 8 && matchesAsciiIgnoreCaseAt(text, i - 7, 'https://'))
              ) {
                urlHasScheme = true;
              }
            }
          }
          i++;
        }
        urlDelimCursor = target;
        return (
          urlHasScheme ||
          (urlHasQmark &&
            (urlHasSlash ||
              (lastUrlPrefixStart < target && text.charCodeAt(lastUrlPrefixStart) === 63)))
        );
      };

      for (let sepIdx = 0; sepIdx < text.length; sepIdx++) {
        const sepCode = text.charCodeAt(sepIdx);
        if (sepCode !== 61 && sepCode !== 58) continue;

        const sepLineBounds = getKvLineBounds(sepIdx);
        const sepLineEnd = sepLineBounds.lineEnd;
        const keySpan = extractKvKeyBeforeSepWithMemo(
          text,
          sepIdx,
          sepCode,
          sepLineBounds.trimmedLineEnd,
          kvLineMemo,
        );
        if (!keySpan) continue;

        const { keyStart, sliceStart, sliceEnd } = keySpan;
        const keyLen = sliceEnd - sliceStart;
        if (keyLen <= 0) continue;

        // Skip URL host:port like `https://token.example.com:8443/api` BEFORE key classification (bounded <= 255 loop)
        if (
          sepCode === 58 &&
          keyStart >= 3 &&
          keyLen <= 255 &&
          text.charCodeAt(keyStart - 3) === 58 &&
          text.charCodeAt(keyStart - 2) === 47 &&
          text.charCodeAt(keyStart - 1) === 47
        ) {
          let hasDot = false;
          for (let d = sliceStart; d < sliceEnd; d++) {
            if (text.charCodeAt(d) === 46) {
              hasDot = true;
              break;
            }
          }
          if (hasDot) {
            let portStart = sepIdx + 1;
            while (portStart < text.length && isWsCode(text.charCodeAt(portStart))) {
              portStart++;
            }
            let portEnd = portStart;
            while (portEnd < text.length) {
              const c = text.charCodeAt(portEnd);
              if (c >= 48 && c <= 57) {
                portEnd++;
              } else {
                break;
              }
            }
            if (
              portEnd > portStart &&
              (portEnd >= text.length ||
                isWsCode(text.charCodeAt(portEnd)) ||
                text.charCodeAt(portEnd) === 47 ||
                text.charCodeAt(portEnd) === 63 ||
                text.charCodeAt(portEnd) === 35)
            ) {
              continue;
            }
          }
        }

        let isSensitive = false;
        let hasBearerSeg = false;
        let hasBasicSeg = false;
        let isBearerOrBasicKey = false;

        // Always-on LineSegIndex for keyLen > 128 + lazy per-line UnescapedLineSegIndex (I3-B)
        if (keyLen > 128) {
          if (kvLineMemo.lineSegIndex === null) {
            kvLineMemo.lineSegIndex = buildLineSegIndex(text, kvLineMemo.lineStart, sepLineEnd);
          }
          const segIdx = kvLineMemo.lineSegIndex;
          const q = queryRawLineSegIndex(text, segIdx, sliceStart, sliceEnd);
          isSensitive = q.isSensitive;
          hasBearerSeg = q.hasBearer;
          hasBasicSeg = q.hasBasic;
          let isBareUnescBearerOrBasic = false;
          if (
            !isSensitive &&
            segIdx.validEscapeSpans.length > 0 &&
            lineSegContainsRange(segIdx.validEscapeSpans, sliceStart, sliceEnd)
          ) {
            if (kvLineMemo.unescapedLineSegIndex === null) {
              kvLineMemo.unescapedLineSegIndex = buildUnescapedLineSegIndex(
                text,
                kvLineMemo.lineStart,
                sepLineEnd,
              );
            }
            const uRes = queryUnescapedLineSegIndex(
              text,
              kvLineMemo.unescapedLineSegIndex,
              sliceStart,
              sliceEnd,
            );
            if (uRes.query.isSensitive) isSensitive = true;
            if (uRes.query.hasBearer) hasBearerSeg = true;
            if (uRes.query.hasBasic) hasBasicSeg = true;
            isBareUnescBearerOrBasic = uRes.isBareBearerOrBasic;
          }
          isBearerOrBasicKey =
            !isSensitive &&
            (hasBearerSeg || hasBasicSeg) &&
            !isBareUnescBearerOrBasic &&
            !isSpanTrimmedBearerOrBasic(text, sliceStart, sliceEnd);
        } else {
          const key = text.slice(sliceStart, sliceEnd);
          let cached: KeyCacheEntry | null = null;
          for (let k = 0; k < 8; k++) {
            const entry = keyCache[k];
            if (entry !== null && entry.key === key) {
              cached = entry;
              break;
            }
          }
          if (cached !== null) {
            isSensitive = cached.isSensitive;
            hasBearerSeg = cached.hasBearer;
            hasBasicSeg = cached.hasBasic;
            isBearerOrBasicKey = cached.isBearerOrBasicKey;
          } else {
            const keySegments = splitKeySegments(key);
            const keyTrimLower = asciiLowercase(key.trim());
            let unescTrimLower = keyTrimLower;
            isSensitive = isSensitiveJsonKeyWithSegments(key, keySegments);
            let hasBearerFromUnesc = false;
            let hasBasicFromUnesc = false;
            if (!isSensitive && key.includes('\\')) {
              const unescKey = unescapeJsonForScan(key);
              if (unescKey !== key) {
                const unescSegs = splitKeySegments(unescKey);
                isSensitive = isSensitiveJsonKeyWithSegments(unescKey, unescSegs);
                hasBearerFromUnesc = unescSegs.includes('bearer');
                hasBasicFromUnesc = unescSegs.includes('basic');
                unescTrimLower = asciiLowercase(unescKey.trim());
              }
            }
            hasBearerSeg =
              keyTrimLower === 'bearer' || keySegments.includes('bearer') || hasBearerFromUnesc;
            hasBasicSeg =
              keyTrimLower === 'basic' || keySegments.includes('basic') || hasBasicFromUnesc;
            isBearerOrBasicKey =
              !isSensitive &&
              (hasBearerSeg || hasBasicSeg) &&
              keyTrimLower !== 'bearer' &&
              keyTrimLower !== 'basic' &&
              unescTrimLower !== 'bearer' &&
              unescTrimLower !== 'basic';
            keyCache[keyCacheNext] = {
              key,
              isSensitive,
              hasBearer: hasBearerSeg,
              hasBasic: hasBasicSeg,
              isBearerOrBasicKey,
            };
            keyCacheNext = (keyCacheNext + 1) & 7;
          }
        }

        if (!isSensitive && !isBearerOrBasicKey) {
          continue;
        }

        let valStart = sepIdx + 1;
        while (valStart < text.length && isWsCode(text.charCodeAt(valStart))) {
          valStart++;
        }
        if (valStart >= text.length) continue;

        const { lineEnd, trimmedLineEnd } = getKvLineBounds(valStart);
        const inUrlQuery = isInUrlQueryAtPos(keyStart);
        const deferMode: 'none' | 'non_placeholder' | 'basic_only' = isBearerOrBasicKey
          ? hasBearerSeg
            ? 'none'
            : 'basic_only'
          : 'non_placeholder';
        const extracted = extractKvValueBounded(
          text,
          valStart,
          lineEnd,
          inUrlQuery,
          kvValMemo,
          deferMode,
        );
        const unquoted = extracted.token;
        if (!unquoted && !extracted.deferredNonPlaceholder && !extracted.deferredBasicSpan) {
          continue;
        }

        const displayKey =
          keyLen <= 64
            ? text.slice(sliceStart, sliceEnd)
            : `${text.slice(sliceStart, sliceStart + 64)}...`;

        if (isBearerOrBasicKey) {
          let safe = true;
          if (extracted.deferredBasicSpan) {
            const { summary, valStart: ds, end: de } = extracted.deferredBasicSpan;
            if (hasBasicCredInKvDeferredSpan(text, summary, ds, de)) {
              safe = false;
            }
          } else if (unquoted.includes('{{') || unquoted.includes('}}')) {
            safe =
              !extracted.hasBrokenQuote &&
              isSafeBearerOrBasicTokenWithBraces(unquoted, paramLookup);
          } else {
            if (hasBasicSeg && containsBasicCredentialToken(unquoted)) {
              safe = false;
            }
            if (safe && hasBearerSeg) {
              const { asciiNonWs, hasDigitOrPunct } = countAsciiGraphicAndDigitOrPunct(unquoted);
              if (
                !isSafeBearerOrBasicValue(unquoted, true, false, paramLookup) ||
                asciiNonWs >= 6 ||
                (asciiNonWs >= 4 && hasDigitOrPunct)
              ) {
                safe = false;
              }
            }
          }
          if (safe) {
            const trailPos = skipHorizWsToLineEndCached(
              text,
              extracted.tokenEnd,
              lineEnd,
              trimmedLineEnd,
              kvValMemo,
            );
            const trailCode = trailPos < lineEnd ? text.charCodeAt(trailPos) : -1;
            if (inUrlQuery && (trailCode === 38 || trailCode === 59 || trailCode === 35)) {
              const urlMemo = selectModeMemo(
                hasBearerSeg,
                hasBasicSeg,
                bearerUrlLineMemo,
                basicUrlLineMemo,
                bothUrlLineMemo,
              );
              if (
                !checkUrlSameLineTrailingSafe(
                  text,
                  trailPos,
                  lineEnd,
                  hasBearerSeg,
                  hasBasicSeg,
                  paramLookup,
                  urlMemo,
                )
              ) {
                safe = false;
              }
            } else {
              const kvMemo = selectModeMemo(
                hasBearerSeg,
                hasBasicSeg,
                bearerKvLineMemo,
                basicKvLineMemo,
                bothKvLineMemo,
              );
              if (
                !checkSameLineTrailingSafe(
                  text,
                  extracted.tokenEnd,
                  null,
                  hasBearerSeg,
                  hasBasicSeg,
                  paramLookup,
                  kvMemo,
                  authBracketMemo,
                )
              ) {
                safe = false;
              }
            }
          }
          if (!safe) {
            recordFinding(path, `sensitive key-value assignment '${displayKey}' detected in ${path}`);
            return;
          }
          continue;
        }

        const isAuthHeader = isAuthHeaderSpan(text, sliceStart, sliceEnd, kvLineMemo);

        let isSafe = false;
        if (
          isAuthHeader &&
          isProtectedAuthHeaderAt(text, valStart, trimmedLineEnd, paramLookup, authBracketMemo)
        ) {
          isSafe = true;
        } else if (
          isAuthHeader &&
          extracted.wasQuoted &&
          isProtectedAuthHeaderValue(unquoted, paramLookup)
        ) {
          isSafe = checkSameLineTrailingSafe(
            text,
            extracted.tokenEnd,
            null,
            true,
            true,
            paramLookup,
            bothKvLineMemo,
            authBracketMemo,
          );
        } else if (!extracted.deferredNonPlaceholder && isProtectedPlaceholder(unquoted, paramLookup)) {
          const trailPos = skipHorizWsToLineEndCached(
            text,
            extracted.tokenEnd,
            lineEnd,
            trimmedLineEnd,
            kvValMemo,
          );
          const trailCode = trailPos < lineEnd ? text.charCodeAt(trailPos) : -1;
          if (inUrlQuery && (trailCode === 38 || trailCode === 59 || trailCode === 35)) {
            isSafe = checkUrlSameLineTrailingSafe(
              text,
              trailPos,
              lineEnd,
              true,
              true,
              paramLookup,
              bothUrlLineMemo,
            );
          } else {
            isSafe = checkSameLineTrailingSafe(
              text,
              extracted.tokenEnd,
              null,
              true,
              true,
              paramLookup,
              bothKvLineMemo,
              authBracketMemo,
            );
          }
        }

        if (!isSafe) {
          recordFinding(path, `sensitive key-value assignment '${displayKey}' detected in ${path}`);
          return;
        }
      }
    }

    const hasBearer = /bearer/i.test(text);
    const hasBasic = /basic/i.test(text);
    const lower = hasBearer || hasBasic ? asciiLowercase(text) : '';

    // 3. `Bearer <token>` pattern (linear indexOf scan + memoized same-line trailing + deferred KV span)
    if (hasBearer) {
      const bearerLineMemo = createSameLineMemo();
      const overflowBearerLineMemo = createSameLineMemo();
      const verifiedBearerRhsStart = new Set<number>();
      let searchFrom = 0;
      while (true) {
        const absIdx = lower.indexOf('bearer', searchFrom);
        if (absIdx < 0) break;
        searchFrom = absIdx + 6;
        if (absIdx > 0 && isAsciiAlnum(lower[absIdx - 1]!)) continue;
        const afterIdx = absIdx + 6;
        if (afterIdx >= text.length) continue;
        const afterCh = text[afterIdx]!;
        if (!isWsCode(text.charCodeAt(afterIdx)) && !':="\'"([{<'.includes(afterCh)) continue;

        const enclosingQuote =
          absIdx > 0 && (text[absIdx - 1] === '"' || text[absIdx - 1] === "'")
            ? text[absIdx - 1]!
            : null;

        const s1 = skipWsCached(authBracketMemo, text, afterIdx);
        const hadAssignSep = s1 < text.length && (text[s1] === ':' || text[s1] === '=');
        const afterAssignIdx = hadAssignSep ? s1 + 1 : s1;

        let payload = extractAuthPayload(
          text,
          afterAssignIdx,
          enclosingQuote,
          authBracketMemo,
          'bearer_kv',
        );

        if (payload.enclosureOverflow) {
          if (
            !checkSameLineTrailingSafe(
              text,
              payload.consumedEnd,
              enclosingQuote,
              true,
              false,
              paramLookup,
              overflowBearerLineMemo,
              authBracketMemo,
              true,
            )
          ) {
            recordFinding(path, `plaintext Bearer token detected in ${path}`);
            return;
          }
          continue;
        }

        if (
          !checkSameLineTrailingSafe(
            text,
            payload.consumedEnd,
            enclosingQuote,
            true,
            false,
            paramLookup,
            bearerLineMemo,
            authBracketMemo,
          )
        ) {
          recordFinding(path, `plaintext Bearer token detected in ${path}`);
          return;
        }

        if (!payload.deferredBasicSpan) {
          if (!payload.unwrapped) continue;

          if (payload.unwrapped.includes('{{') || payload.unwrapped.includes('}}')) {
            if (
              payload.hasBrokenQuote ||
              !isSafeBearerOrBasicTokenWithBraces(payload.unwrapped, paramLookup)
            ) {
              recordFinding(path, `unprotected Bearer auth placeholder detected in ${path}`);
              return;
            }
            continue;
          }
        }

        if (payload.followedByKvSep) {
          if (verifiedBearerRhsStart.has(payload.restAfterKvSepStart)) {
            continue;
          }
          const rhs = extractAuthPayload(text, payload.restAfterKvSepStart, null, authBracketMemo);
          if (rhs.enclosureOverflow) {
            if (
              !checkSameLineTrailingSafe(
                text,
                rhs.consumedEnd,
                null,
                true,
                false,
                paramLookup,
                overflowBearerLineMemo,
                authBracketMemo,
                true,
              )
            ) {
              recordFinding(path, `plaintext Bearer token detected in ${path}`);
              return;
            }
            verifiedBearerRhsStart.add(payload.restAfterKvSepStart);
            continue;
          }
          if (
            !checkSameLineTrailingSafe(
              text,
              rhs.consumedEnd,
              null,
              true,
              false,
              paramLookup,
              bearerLineMemo,
              authBracketMemo,
            )
          ) {
            recordFinding(path, `plaintext Bearer token detected in ${path}`);
            return;
          }
          if (rhs.unwrapped.includes('{{') || rhs.unwrapped.includes('}}')) {
            if (
              rhs.hasBrokenQuote ||
              rhs.followedByKvSep ||
              !isProtectedPlaceholder(rhs.unwrapped, paramLookup)
            ) {
              recordFinding(path, `plaintext Bearer token detected in ${path}`);
              return;
            }
            verifiedBearerRhsStart.add(payload.restAfterKvSepStart);
            continue;
          }
          if (rhs.hasBrokenQuote) {
            recordFinding(path, `plaintext Bearer token detected in ${path}`);
            return;
          }
          if (rhs.unwrapped) {
            if (rhs.followedByKvSep || !isProtectedPlaceholder(rhs.unwrapped, paramLookup)) {
              recordFinding(path, `plaintext Bearer token detected in ${path}`);
              return;
            }
            verifiedBearerRhsStart.add(payload.restAfterKvSepStart);
            continue;
          }
          if (payload.deferredBasicSpan) {
            payload = extractAuthPayload(
              text,
              afterAssignIdx,
              enclosingQuote,
              authBracketMemo,
              'none',
            );
            if (!payload.unwrapped) continue;
          }
          if (
            isProtectedPlaceholder(payload.unwrapped, paramLookup) ||
            isAllowedBearerProseNoun(payload.unwrapped)
          ) {
            continue;
          }
        }

        const inlineKvIdx = payload.unwrapped.search(/[:=]/);
        if (inlineKvIdx >= 0) {
          const rhs = payload.unwrapped.slice(inlineKvIdx + 1);
          if (rhs.length > 0 && !isProtectedPlaceholder(rhs, paramLookup)) {
            recordFinding(path, `plaintext Bearer token detected in ${path}`);
            return;
          }
        }

        const { asciiNonWs, hasDigitOrPunct } = countAsciiGraphicAndDigitOrPunct(payload.unwrapped);
        const strictMode =
          hadAssignSep ||
          payload.followedByKvSep ||
          payload.hasBrokenQuote ||
          payload.kind === 'quoted' ||
          payload.kind === 'bracketed';

        if (strictMode) {
          if (asciiNonWs >= 6 || (asciiNonWs >= 4 && hasDigitOrPunct)) {
            recordFinding(path, `plaintext Bearer token detected in ${path}`);
            return;
          }
        } else if (asciiNonWs >= 12 && !isAllowedBearerProseNoun(payload.unwrapped)) {
          recordFinding(path, `plaintext Bearer token detected in ${path}`);
          return;
        }
      }
    }

    // 4. `Basic <cred>` pattern (linear indexOf scan + memoized same-line trailing + deferred long span + chained-hop memo)
    if (hasBasic) {
      const basicLineMemo = createSameLineMemo();
      // Maps `curBase -> minVerifiedLevel` for `level >= 1` (`curEnclosing === null`).
      // Once `(curBase, lv)` completes cleanly, any future arrival at `(curBase, level >= lv)`
      // has `MAX_BASIC_LEVELS - level <= MAX_BASIC_LEVELS - lv` hops remaining and is proven leak-free.
      const verifiedBasicRestLevel = new Map<number, number>();
      const visitedHopBases: number[] = [];
      const visitedHopLevels: number[] = [];

      let searchFrom = 0;
      while (true) {
        const absIdx = lower.indexOf('basic', searchFrom);
        if (absIdx < 0) break;
        searchFrom = absIdx + 5;
        if (absIdx > 0 && isAsciiAlnum(lower[absIdx - 1]!)) continue;
        const afterIdx = absIdx + 5;
        if (afterIdx >= text.length) continue;
        const afterCh = text[afterIdx]!;
        if (!isWsCode(text.charCodeAt(afterIdx)) && !':="\'"([{<'.includes(afterCh)) continue;

        const enclosingQuote =
          absIdx > 0 && (text[absIdx - 1] === '"' || text[absIdx - 1] === "'")
            ? text[absIdx - 1]!
            : null;

        const s1 = skipWsCached(authBracketMemo, text, afterIdx);
        const hadAssignSep = s1 < text.length && (text[s1] === ':' || text[s1] === '=');
        let curBase = hadAssignSep ? s1 + 1 : s1;

        visitedHopBases.length = 0;
        visitedHopLevels.length = 0;

        for (let level = 0; level < MAX_BASIC_LEVELS; level++) {
          if (level >= 1) {
            if ((verifiedBasicRestLevel.get(curBase) ?? 99) <= level) {
              break;
            }
            visitedHopBases.push(curBase);
            visitedHopLevels.push(level);
          }

          const curEnclosing = level === 0 ? enclosingQuote : null;
          const payload = extractAuthPayload(
            text,
            curBase,
            curEnclosing,
            authBracketMemo,
            'basic',
          );

          if (
            !checkSameLineTrailingSafe(
              text,
              payload.consumedEnd,
              curEnclosing,
              false,
              true,
              paramLookup,
              basicLineMemo,
              authBracketMemo,
            )
          ) {
            recordFinding(path, `plaintext Basic credential detected in ${path}`);
            return;
          }

          if (payload.enclosureOverflow) break;

          if (payload.deferredBasicSpan) {
            if (hasBasicCredInDeferredSpan(text, payload.deferredBasicSpan)) {
              recordFinding(path, `plaintext Basic credential detected in ${path}`);
              return;
            }
            if (payload.followedByKvSep) {
              curBase = payload.restAfterKvSepStart;
              continue;
            }
            break;
          }

          if (!payload.unwrapped) break;

          if (payload.unwrapped.includes('{{') || payload.unwrapped.includes('}}')) {
            if (
              payload.hasBrokenQuote ||
              !isSafeBearerOrBasicTokenWithBraces(payload.unwrapped, paramLookup)
            ) {
              recordFinding(path, `unprotected Basic auth placeholder detected in ${path}`);
              return;
            }
            break;
          }

          if (containsBasicCredentialToken(payload.unwrapped)) {
            recordFinding(path, `plaintext Basic credential detected in ${path}`);
            return;
          }

          if (payload.followedByKvSep) {
            curBase = payload.restAfterKvSepStart;
          } else {
            break;
          }
        }

        // Clean exit (every leak executes `return;` above): commit visited `level >= 1` hops.
        for (let h = 0; h < visitedHopBases.length; h++) {
          const b = visitedHopBases[h]!;
          const lv = visitedHopLevels[h]!;
          const prev = verifiedBasicRestLevel.get(b) ?? 99;
          if (lv < prev) {
            verifiedBasicRestLevel.set(b, lv);
          }
        }
      }
    }

    // 5. Well-known API key prefixes, Slack tokens, and JWTs (zero-split O(N) prefix scan)
    STEP5_PREFIX_RE.lastIndex = 0;
    let prefixMatch: RegExpExecArray | null;
    while ((prefixMatch = STEP5_PREFIX_RE.exec(text)) !== null) {
      const start = prefixMatch.index;
      if (start > 0 && !isStep5TokenDelimCode(text.charCodeAt(start - 1))) {
        continue;
      }
      let end = start + prefixMatch[0].length;
      while (end < text.length && !isStep5TokenDelimCode(text.charCodeAt(end))) {
        end++;
      }
      // Advance regex past this entire token (strictly O(N) even on `'sk-'.repeat(100_000)`)
      STEP5_PREFIX_RE.lastIndex = end;

      let cleanEnd = end;
      while (cleanEnd > start && isStep5TrailingStripCode(text.charCodeAt(cleanEnd - 1))) {
        cleanEnd--;
      }
      if (cleanEnd <= start) continue;
      const token = text.slice(start, cleanEnd);

      if (token.startsWith('sk-ant-') && token.length >= 20) {
        recordFinding(path, `Anthropic API key pattern detected in ${path}`);
        return;
      } else if (token.startsWith('sk-proj-') && token.length >= 20) {
        recordFinding(path, `OpenAI project key pattern detected in ${path}`);
        return;
      } else if (
        token.startsWith('sk-') &&
        token.length >= 19 &&
        /^[A-Za-z0-9_-]+$/.test(token.slice(3))
      ) {
        recordFinding(path, `API key 'sk-...' pattern detected in ${path}`);
        return;
      } else if (
        (token.startsWith('ghp_') ||
          token.startsWith('gho_') ||
          token.startsWith('ghu_') ||
          token.startsWith('github_pat_')) &&
        token.length >= 24
      ) {
        recordFinding(path, `GitHub token pattern detected in ${path}`);
        return;
      } else if (SLACK_TOKEN_RE.test(token)) {
        recordFinding(path, `Slack token pattern detected in ${path}`);
        return;
      } else if (
        token.startsWith('AKIA') &&
        token.length === 20 &&
        /^[A-Z0-9]{16}$/.test(token.slice(4))
      ) {
        recordFinding(path, `AWS access key pattern detected in ${path}`);
        return;
      } else if (
        token.startsWith('AIza') &&
        token.length >= 35 &&
        /^[0-9A-Za-z_-]+$/.test(token.slice(4))
      ) {
        recordFinding(path, `Google API key pattern detected in ${path}`);
        return;
      } else if (token.startsWith('eyJ') && isJwtLike(token)) {
        recordFinding(path, `plaintext JWT detected in ${path}`);
        return;
      }
    }
  };

  const scanText = (text: string, path: string, depth: number, outerStopAfter: number): void => {
    if (isAborted(outerStopAfter)) return;
    if (depth > maxDepth) {
      recordFinding(path, `maximum JSON nesting depth (${maxDepth}) exceeded in ${path}`);
      return;
    }
    if (!text) return;

    const pathStop = Math.min(outerStopAfter, findings.length);

    // Pass 0: scan raw text first before allocating any decoded BFS variants
    scanTextSingleVariant(text, path, depth, pathStop);
    if (isAborted(pathStop)) return;

    if (!text.includes('%') && !text.includes('+') && !text.includes('\\')) {
      return;
    }

    const MAX_DECODE_PASSES = 5;
    const MAX_VARIANTS = 64;
    const seen = new Set<string>([text]);
    let variantCount = 1;
    let frontier: string[] = [text];

    const tryScanVariant = (s: string, nextFrontier?: string[]): boolean => {
      if (variantCount >= MAX_VARIANTS || seen.has(s)) {
        return false;
      }
      seen.add(s);
      variantCount++;
      scanTextSingleVariant(s, path, depth, pathStop);
      if (isAborted(pathStop)) {
        return true;
      }
      if (nextFrontier) {
        nextFrontier.push(s);
      }
      return false;
    };

    // Lazy BFS frontier decode passes for percent-encoded, form-urlencoded (`+`), and JSON-escaped bypasses
    for (let pass = 0; pass < MAX_DECODE_PASSES; pass++) {
      if (frontier.length === 0 || variantCount >= MAX_VARIANTS) {
        break;
      }
      const nextFrontier: string[] = [];
      for (const cur of frontier) {
        if (variantCount >= MAX_VARIANTS) break;
        if (cur.includes('%')) {
          const pct = percentDecodeForScan(cur);
          if (pct.includes('+')) {
            if (tryScanVariant(pct.replace(/\+/g, ' '))) return;
          }
          if (tryScanVariant(pct, nextFrontier)) return;
          if (pct.includes('\\')) {
            const pctUnesc = unescapeJsonForScan(pct);
            if (pctUnesc.includes('+')) {
              if (tryScanVariant(pctUnesc.replace(/\+/g, ' '))) return;
            }
            if (tryScanVariant(pctUnesc, nextFrontier)) return;
          }
        } else if (cur.includes('+')) {
          if (tryScanVariant(cur.replace(/\+/g, ' '))) return;
        }
        if (cur.includes('\\')) {
          const unesc = unescapeJsonForScan(cur);
          if (tryScanVariant(unesc, nextFrontier)) return;
        }
      }
      frontier = nextFrontier;
    }
  };

  const scanObjectEntries = (
    entries: ReadonlyArray<readonly [string, unknown]>,
    path: string,
    depth: number,
    outerStopAfter: number,
  ): void => {
    if (isAborted(outerStopAfter)) return;

    // Validate canonical parameter declarations (`parameters[i]`) for secret default_value leaks
    if (isCanonicalParamElement(path, rootContext)) {
      let pname: string | null = null;
      let isSecret = false;
      let hasDefault = false;
      for (const [k, v] of entries) {
        if (k === 'name' && typeof v === 'string') {
          pname = v.trim();
        } else if (k === 'is_secret' && v === true) {
          isSecret = true;
        } else if (k === 'default_value' && typeof v === 'string' && v.length > 0) {
          hasDefault = true;
        }
      }
      if (pname !== null) {
        if (isSecret && hasDefault) {
          recordFinding(
            `${path}.default_value`,
            `secret parameter '${pname}' must not carry a default_value`,
          );
        } else if (isSensitiveParamName(pname) && (!isSecret || hasDefault)) {
          recordFinding(
            path,
            `sensitive parameter '${pname}' must be marked is_secret=true with no default_value`,
          );
        }
      }
      if (isAborted(outerStopAfter)) return;
    }

    for (const [k, v] of entries) {
      if (isAborted(outerStopAfter)) return;
      scanText(k, `${path}.<key>`, depth, outerStopAfter);
      if (isAborted(outerStopAfter)) return;

      if (isCanonicalParamIsSecret(path, rootContext, k, v)) {
        continue;
      }
      if (isCanonicalStepSecretVaultKey(path, rootContext, k)) {
        const vkPath = `${path}.${k}`;
        if (v === null || v === undefined) {
          continue;
        }
        if (typeof v === 'string') {
          validateSecretVaultKey(v, vkPath, depth + 1, outerStopAfter);
        } else {
          recordFinding(vkPath, `invalid non-string secret_vault_key detected in ${path}`);
        }
        continue;
      }

      const valBefore = findings.length;
      const kLower = asciiLowercase(k.trim());
      const keySegments = splitKeySegments(k);
      const hasBearerSeg = kLower === 'bearer' || keySegments.includes('bearer');
      const hasBasicSeg = kLower === 'basic' || keySegments.includes('basic');

      if (hasBearerSeg || hasBasicSeg) {
        let safe = false;
        let recordedBySubscan = false;
        if (v === null || v === undefined) {
          safe = true;
        } else if (typeof v === 'string') {
          safe = isSafeBearerOrBasicValue(v, hasBearerSeg, hasBasicSeg, paramLookup);
          if (safe) {
            const beforeCount = findings.length;
            if (hasBearerSeg) {
              scanText(`Bearer ${v}`, `${path}.${k}`, depth + 1, outerStopAfter);
            }
            if (hasBasicSeg && findings.length === beforeCount && !isAborted(outerStopAfter)) {
              scanText(`Basic ${v}`, `${path}.${k}`, depth + 1, outerStopAfter);
            }
            if (findings.length > beforeCount) {
              safe = false;
              recordedBySubscan = true;
            }
          }
        }
        if (!safe && !recordedBySubscan) {
          recordFinding(
            `${path}.${k}`,
            `sensitive JSON key '${k}' with non-placeholder value detected in ${path}`,
          );
        }
      }

      if (findings.length === valBefore && isSensitiveJsonKeyWithSegments(k, keySegments)) {
        let safe = false;
        if (v === null || v === undefined) {
          safe = true;
        } else if (typeof v === 'string') {
          const isAuthKey =
            kLower === 'authorization' ||
            kLower.endsWith('-authorization') ||
            kLower.endsWith('_authorization');
          safe =
            v.trim().length === 0 ||
            isProtectedPlaceholder(v, paramLookup) ||
            (isAuthKey && isProtectedAuthHeaderValue(v, paramLookup));
        }
        if (!safe) {
          recordFinding(
            `${path}.${k}`,
            `sensitive JSON key '${k}' with non-placeholder value detected in ${path}`,
          );
        }
      }

      if (findings.length === valBefore && !isAborted(outerStopAfter)) {
        scanValue(v, `${path}.${k}`, depth + 1, outerStopAfter);
      }
    }
  };

  const scanValue = (val: unknown, path: string, depth: number, outerStopAfter: number): void => {
    if (isAborted(outerStopAfter)) return;
    if (depth > maxDepth) {
      recordFinding(path, `maximum JSON nesting depth (${maxDepth}) exceeded in ${path}`);
      return;
    }
    if (typeof val === 'string') {
      scanText(val, path, depth, outerStopAfter);
      return;
    }
    if (isLosslessJsonArray(val)) {
      for (let idx = 0; idx < val.items.length; idx++) {
        if (isAborted(outerStopAfter)) return;
        scanValue(val.items[idx], `${path}[${idx}]`, depth + 1, outerStopAfter);
      }
      return;
    }
    if (isLosslessJsonObject(val)) {
      scanObjectEntries(val.entries, path, depth, outerStopAfter);
      return;
    }
    if (Array.isArray(val)) {
      for (let idx = 0; idx < val.length; idx++) {
        if (isAborted(outerStopAfter)) return;
        scanValue(val[idx], `${path}[${idx}]`, depth + 1, outerStopAfter);
      }
      return;
    }
    if (val !== null && typeof val === 'object') {
      scanObjectEntries(
        Object.entries(val as Record<string, unknown>),
        path,
        depth,
        outerStopAfter,
      );
    }
  };

  scanValue(value, rootContext, 0, MAX_SECRET_SCAN_FINDINGS);

  return {
    safe: findings.length === 0,
    findings,
  };
}

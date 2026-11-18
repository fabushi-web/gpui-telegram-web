/**
 * F17: Desktop-to-Browser Control Bridge, Headless Browser Automation Engine,
 * Desktop Pairing & `<10ms` Emergency Revoke Fencing, and MCP JSON-RPC 2.0 Contracts.
 */

export interface BrowserElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserElementRef {
  ref: string;
  selector: string;
  tag: string;
  role?: string;
  text: string;
  id?: string;
  testId?: string;
  value?: string;
  disabled?: boolean;
  rect?: BrowserElementRect;
}

export interface BrowserSnapshotDto {
  target_id: string;
  url: string;
  title: string;
  timestamp_ms: number;
  viewport: { width: number; height: number };
  theme?: string;
  active_chat_id?: number | null;
  active_nav_dest?: string;
  text_excerpt: string;
  elements: BrowserElementRef[];
}

export type BrowserActionKind =
  | 'snapshot'
  | 'click'
  | 'fill'
  | 'press'
  | 'hover'
  | 'scroll'
  | 'select'
  | 'navigate'
  | 'screenshot'
  | 'evaluate_query'
  | 'app_action';

export interface BrowserCommandRequest {
  command_id?: string;
  target_id?: string;
  action: BrowserActionKind;
  ref?: string;
  selector?: string;
  text?: string;
  key?: string;
  url?: string;
  delta_y?: number;
  app_action?: string;
  app_payload?: Record<string, unknown>;
  timeout_ms?: number;
  caller_label?: string;
  expected_generation?: number;
}

export interface BrowserCommandResult {
  ok: boolean;
  command_id: string;
  target_id: string;
  generation: number;
  action: BrowserActionKind;
  snapshot?: BrowserSnapshotDto;
  screenshot_data_url?: string;
  data?: Record<string, unknown>;
  error?: string;
  latency_ms: number;
}

export interface BrowserTargetDescriptor {
  target_id: string;
  user_id: number;
  kind: 'live_web_tab' | 'headless_chromium';
  title: string;
  url: string;
  viewport: { width: number; height: number };
  theme?: string;
  active_chat_id?: number | null;
  active_nav_dest?: string;
  connected_at_ms: number;
  last_heartbeat_ms: number;
  allow_remote_control: boolean;
  active_controller?: string | null;
  control_generation: number;
}

export interface DesktopPairingTicketDto {
  pair_code: string;
  desktop_token: string;
  expires_at_ms: number;
  http_base_url: string;
  ws_bridge_url: string;
  mcp_rpc_url: string;
}

export interface HeadlessBrowserSessionDto {
  session_id: string;
  backend: 'chromium_cdp' | 'http_dom_fallback';
  url: string;
  title: string;
  viewport: { width: number; height: number };
  created_at_ms: number;
  updated_at_ms: number;
  status: 'ready' | 'closed';
}

export interface BrowserAuditLogEntry {
  audit_id: string;
  timestamp_ms: number;
  target_id: string;
  caller: string;
  action: string;
  status: 'ok' | 'rejected' | 'error' | 'revoked';
  summary: string;
  latency_ms: number;
}

export interface BrowserRegisterPayload {
  target_id?: string;
  title: string;
  url: string;
  viewport: { width: number; height: number };
  theme?: string;
  active_chat_id?: number | null;
  active_nav_dest?: string;
  allow_remote_control?: boolean;
  snapshot?: BrowserSnapshotDto;
}

export interface BrowserStateReportPayload {
  target_id: string;
  title?: string;
  url?: string;
  viewport?: { width: number; height: number };
  theme?: string;
  active_chat_id?: number | null;
  active_nav_dest?: string;
  allow_remote_control?: boolean;
  snapshot?: BrowserSnapshotDto;
}

export interface BrowserControlRevokedPayload {
  user_id: number;
  target_id?: string;
  control_generation: number;
  reason: string;
  timestamp_ms: number;
}

export interface BrowserControlRevokeResponse {
  ok: boolean;
  control_generation: number;
  revoked_tokens_count: number;
  aborted_commands_count: number;
  elapsed_us: number;
  latency_sub10ms: boolean;
}

// ============================================================================
// MCP JSON-RPC 2.0 Contracts (`/api/v1/mcp/rpc` & `/api/v1/mcp/manifest`)
// ============================================================================

export interface McpJsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface McpJsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpJsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: T;
  error?: McpJsonRpcError;
}

export type McpContentItem =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface McpToolSchemaDto {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpCallToolResultDto {
  content: McpContentItem[];
  isError: boolean;
}

// ============================================================================
// Hexagonal Client Port for Desktop & Web Browser Control Consumers
// ============================================================================

export interface BrowserControlClientPort {
  createDesktopPairingTicket(opts?: {
    label?: string;
    ttlSecs?: number;
  }): Promise<DesktopPairingTicketDto>;
  claimDesktopPairingTicket(
    pairCode: string,
    controllerLabel?: string,
  ): Promise<DesktopPairingTicketDto>;
  listBrowserTargets(): Promise<{
    targets: BrowserTargetDescriptor[];
    control_generation: number;
  }>;
  registerBrowserTarget(payload: BrowserRegisterPayload): Promise<BrowserTargetDescriptor>;
  reportBrowserState(payload: BrowserStateReportPayload): Promise<BrowserTargetDescriptor>;
  sendBrowserCommand(req: BrowserCommandRequest): Promise<BrowserCommandResult>;
  revokeBrowserControl(opts?: {
    targetId?: string;
    revokeTokens?: boolean;
  }): Promise<BrowserControlRevokeResponse>;
  listBrowserAuditLogs(limit?: number): Promise<{ entries: BrowserAuditLogEntry[] }>;
  openHeadlessSession(req?: {
    url?: string;
    viewport?: { width: number; height: number };
    preferFallback?: boolean;
  }): Promise<{ session: HeadlessBrowserSessionDto; snapshot: BrowserSnapshotDto }>;
  listHeadlessSessions(): Promise<{ sessions: HeadlessBrowserSessionDto[] }>;
  executeHeadlessAction(
    sessionId: string,
    req: Omit<BrowserCommandRequest, 'target_id'>,
  ): Promise<BrowserCommandResult>;
  captureHeadlessScreenshot(sessionId: string): Promise<{
    session_id: string;
    screenshot_data_url: string;
    mime_type: string;
    backend: HeadlessBrowserSessionDto['backend'];
  }>;
  closeHeadlessSession(sessionId: string): Promise<{ ok: boolean; session_id: string }>;
  invokeMcpRpc(req: McpJsonRpcRequest): Promise<McpJsonRpcResponse>;
}

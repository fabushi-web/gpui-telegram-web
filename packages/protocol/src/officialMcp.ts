/**
 * Official OAuth 2.1 Remote MCP Server (`/mcp`, RFC 9728 / RFC 8414 / RFC 7591,
 * Streamable HTTP + SSE, PKCE S256, Grants & Audit) Protocol Contracts aligned with
 * desktop `bhrumom/gpui-telegram` v1.6.11 (`routes/mcp_oauth.rs`, `routes/official_mcp.rs`).
 *
 * Pure ES2023 + DOM isomorphic module (zero `node:*` imports or Node globals).
 */

export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
export type McpProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number];
export const DEFAULT_MCP_PROTOCOL_VERSION: McpProtocolVersion = '2025-11-25';

/** Exact 14 upstream OAuth 2.1 scopes (`routes/mcp_oauth.rs:27-42`) */
export const MCP_OAUTH_SCOPES = [
  'devices:read',
  'devices:connect',
  'screen:view',
  'input:control',
  'terminal:exec',
  'files:read',
  'files:write',
  'assist:manage',
  'power:control',
  'messaging:read',
  'messaging:write',
  'chats:read',
  'miniapp:control',
  'tasks:manage',
] as const;

export type McpOAuthScope = (typeof MCP_OAUTH_SCOPES)[number];

export const MCP_ALLOWED_REDIRECT_SCHEMES = [
  'https',
  'http', // loopback only: localhost | 127.0.0.1 | [::1]
  'cursor',
  'vscode',
  'antigravity',
  'claude',
] as const;

/** RFC 9728: `GET /.well-known/oauth-protected-resource` & `/.well-known/oauth-protected-resource/mcp` */
export interface OAuthProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  scopes_supported: string[];
  resource_name?: string;
  resource_documentation?: string;
}

/** RFC 8414 / OIDC Discovery: `GET /.well-known/oauth-authorization-server` & `/.well-known/openid-configuration` */
export interface OAuthAuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  scopes_supported: string[];
  response_types_supported: string[];
  response_modes_supported?: string[];
  grant_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  code_challenge_methods_supported: string[];
  client_id_metadata_document_supported?: boolean;
}

/** RFC 7591: `POST /oauth/register` request & response */
export interface OAuthDynamicClientRegisterRequest {
  client_name?: string;
  redirect_uris: string[];
  token_endpoint_auth_method?: 'none' | 'client_secret_post';
}

export interface OAuthDynamicClientRegisterResponse {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: 'none' | 'client_secret_post' | string;
  grant_types: string[];
  response_types: string[];
  client_id_issued_at: number;
  client_secret?: string;
  client_secret_expires_at?: number;
}

export interface OAuthTokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

export interface OAuthErrorResponse {
  error: string;
  error_description?: string;
}

/** `GET /api/v1/mcp/grants` (`remote_control_contracts.rs:570-587`) */
export interface OAuthGrantSummary {
  family_id: string;
  client_id: string;
  client_name: string;
  scopes: string[];
  allowed_node_ids: string[];
  created_at_ms: number;
  last_used_ms?: number | null;
  expires_at_ms: number;
}
export type McpOAuthGrantSummaryDto = OAuthGrantSummary;

export interface OAuthGrantsResponse {
  grants: OAuthGrantSummary[];
}
export type McpOAuthGrantsResponse = OAuthGrantsResponse;

/** `GET /api/v1/mcp/audit` (`db/mcp_oauth_store.rs:207-220`) */
export interface McpAuditEntry {
  audit_id: string;
  user_id: number;
  client_id: string;
  family_id: string;
  session_id: string;
  tool_name: string;
  target_node_id?: string | null;
  args_summary: string;
  ok: boolean;
  error_code?: string | null;
  duration_ms: number;
  created_at_ms: number;
}
export type McpToolAuditRecord = McpAuditEntry;

export interface McpAuditListResponse {
  entries: McpAuditEntry[];
  total: number;
}

export function isSupportedMcpScope(scope: string): scope is McpOAuthScope {
  return (MCP_OAUTH_SCOPES as readonly string[]).includes(scope);
}

export function isSupportedMcpProtocolVersion(version: string): version is McpProtocolVersion {
  return (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(version);
}

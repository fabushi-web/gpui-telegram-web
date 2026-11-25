/**
 * UU-Parity Remote Assist, Real Remote Computer Control & Extended `RemoteComputerOp`
 * Protocol Contracts aligned with desktop `bhrumom/gpui-telegram` v1.6.11
 * (`remote_control_contracts.rs`, `computer_contracts.rs`, `signaling/frames.rs`).
 *
 * Pure ES2023 + DOM isomorphic module (zero `node:*` imports or Node globals).
 */

import type { ComputerRunPolicy } from './aiContracts.js';

export type TailnetRelayMode = 'direct_udp' | 'derp_relay' | 'http_fallback' | 'offline';
export type RemoteControllerKind = 'own_device' | 'assist_guest' | 'ai_mcp' | 'cli';
export type RemoteControlMode = 'desktop' | 'terminal' | 'file_transfer' | 'ai_control';
export type AssistCodeMode = 'temporary' | 'custom';
export type StreamCodec = 'auto' | 'h264' | 'h265' | 'vp8' | 'jpeg_fallback';
/** Rust `StreamQuality::Ultra4K` under `#[serde(rename_all = "snake_case")]` serializes as `'ultra4_k'`. */
export type StreamQuality = 'auto' | 'smooth' | 'hd' | 'ultra4_k' | 'original';
export type ColorSubsampling = 'yuv420' | 'true_color444';
export type FileConflictPolicy = 'overwrite' | 'skip' | 'rename' | 'apply_all';
export type FileTransferDirection = 'upload' | 'download';
export type FileTransferStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type ComputerNodeKind = 'local_device' | 'cloud_server' | 'cloud_sandbox';
export type CloudAuthMethod = 'ssh_password' | 'ssh_private_key' | 'agent_http_token';
export type AuthorizedControllerKind = 'device' | 'bot' | 'account_all_bots';

export interface RemoteAssistConfigDto {
  /** Permanent 9-digit device assist ID */
  assist_id: string;
  allow_assist: boolean;
  code_mode: AssistCodeMode;
  current_code?: string | null;
  expires_at_ms?: number | null;
}

export interface AssistStartRequest {
  assist_id: string;
  access_code: string;
  requester_device_id?: string | null;
  requester_name?: string | null;
  requester_platform?: string | null;
  mode: RemoteControlMode;
}

export interface AssistStartResponse {
  session_id: string;
  target_node_id: string;
  target_device_id: string;
  temp_relay_token: string;
  requires_host_confirm: boolean;
  expires_at_ms?: number | null;
}

export interface AssistAllowRequest {
  allow_assist: boolean;
}

export interface AssistSetCodeRequest {
  code: string;
}

export interface RemoteSessionDisconnectRequest {
  session_id: string;
}

export interface RemoteSessionDto {
  session_id: string;
  controller_kind: RemoteControllerKind;
  controller_name: string;
  controller_platform: string;
  controller_id: string;
  target_node_id: string;
  target_device_id: string;
  mode: RemoteControlMode;
  started_at_ms: number;
  last_activity_ms: number;
  active_tool?: string | null;
  relay_mode: TailnetRelayMode;
  rtt_ms?: number | null;
  fps?: number | null;
}

export interface RemoteSessionsResponse {
  sessions: RemoteSessionDto[];
}

/** Rust `SignalingFrame` uses default externally-tagged serde (`signaling/frames.rs:4-36`). */
export type RemoteSignalingFrame =
  | { Invite: { call_id: string; from_user: number; to_user: number; is_video: boolean } }
  | { Ringing: { call_id: string } }
  | { Accept: { call_id: string } }
  | { Offer: { call_id: string; sdp: string } }
  | { Answer: { call_id: string; sdp: string } }
  | {
      IceCandidate: {
        call_id: string;
        candidate: string;
        sdp_mid?: string | null;
        sdp_mline_index?: number | null;
      };
    }
  | { Hangup: { call_id: string; reason: string } };

/** Rust name in `routes/remote_assist.rs`: `DeviceWebRtcSignalRequest` */
export interface RemoteWebRtcSignalRequest {
  sender_device_id: string;
  target_device_id?: string | null;
  session_id?: string | null;
  frame: RemoteSignalingFrame;
}
export type DeviceWebRtcSignalRequest = RemoteWebRtcSignalRequest;

export interface RemoteStreamSettingsDto {
  codec: StreamCodec;
  target_fps: number;
  quality: StreamQuality;
  color_mode: ColorSubsampling;
  hdr: boolean;
  audio_enabled: boolean;
  mute_remote_speaker: boolean;
  mic_passthrough: boolean;
  privacy_screen: boolean;
  relative_mouse: boolean;
  lock_cursor_in_window: boolean;
  macos_hotkey_mapping: boolean;
  display_index: number;
}

export interface DisplayInfoDto {
  display_id: number;
  name: string;
  width: number;
  height: number;
  scale_factor_x100: number;
  is_primary: boolean;
  is_virtual: boolean;
  refresh_hz: number;
}

export interface TerminalSessionDto {
  session_id: string;
  name: string;
  shell: string;
  cols: number;
  rows: number;
  attached_clients: number;
  created_at_ms: number;
  last_activity_ms: number;
  alive: boolean;
  cwd?: string | null;
}

export interface TerminalExecResultDto {
  session_id: string;
  exit_code: number;
  output: string;
  timed_out: boolean;
}

export interface FileTransferTaskDto {
  transfer_id: string;
  direction: FileTransferDirection;
  local_path: string;
  remote_path: string;
  total_bytes: number;
  transferred_bytes: number;
  chunk_size: number;
  sha256?: string | null;
  status: FileTransferStatus;
  conflict_policy: FileConflictPolicy;
  error?: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

/** `#[serde(tag = "kind", rename_all = "snake_case")]` (`remote_control_contracts.rs:366-380`) */
export type PowerActionKind =
  | { kind: 'lock' }
  | { kind: 'sleep' }
  | { kind: 'reboot' }
  | { kind: 'shutdown' }
  | { kind: 'schedule_shutdown'; delay_minutes: number }
  | { kind: 'wake_on_lan'; mac_address: string; broadcast_ip?: string | null };

export interface ClipboardPayloadDto {
  mime_type: string;
  text?: string | null;
  image_b64?: string | null;
  origin_id: string;
  seq: number;
}

export interface AccessibilityNodeDto {
  element_id: string;
  role: string;
  name?: string | null;
  value?: string | null;
  bounds?: [number, number, number, number] | null;
  actions: string[];
  children: AccessibilityNodeDto[];
}

export interface AuthorizedControllerEntry {
  controller_id: string;
  kind: AuthorizedControllerKind;
  display_name: string;
  added_at_ms: number;
}

/**
 * `#[serde(tag = "op", rename_all = "snake_case")]` — ALL 19 upstream variants (`computer_contracts.rs:252-383`).
 * Wire field parity:
 * - `terminal_op` variant uses field `terminal_op` (serde alias `sub_op`)
 * - `file_chunk_op` variant uses field `chunk_op` (serde alias `sub_op`)
 */
export type RemoteComputerOp =
  | { op: 'shell_exec'; command: string; cwd?: string | null; timeout_ms?: number | null }
  | { op: 'read_file'; path: string; max_bytes?: number | null }
  | { op: 'write_file'; path: string; content: string; create_dirs?: boolean }
  | { op: 'list_dir'; path: string }
  | { op: 'capture_screen' }
  | {
      op: 'gui_input';
      action: string;
      x?: number | null;
      y?: number | null;
      text?: string | null;
      key?: string | null;
    }
  | {
      op: 'mouse_action';
      action: string;
      x?: number | null;
      y?: number | null;
      dx?: number | null;
      dy?: number | null;
      button?: string | null;
      clicks?: number | null;
      scroll_x?: number | null;
      scroll_y?: number | null;
      relative?: boolean;
    }
  | {
      op: 'keyboard_action';
      action: string;
      text?: string | null;
      key?: string | null;
      modifiers?: string[];
    }
  | { op: 'clipboard_get' }
  | { op: 'clipboard_set'; text?: string | null; image_b64?: string | null; mime_type?: string | null }
  | { op: 'power_action'; action: PowerActionKind }
  | { op: 'display_list' }
  | { op: 'display_switch'; display_index: number }
  | { op: 'privacy_screen_toggle'; enabled: boolean; message?: string | null }
  | {
      op: 'terminal_op';
      terminal_op: string;
      sub_op?: string;
      session_name?: string | null;
      shell?: string | null;
      input?: string | null;
      command?: string | null;
      cols?: number | null;
      rows?: number | null;
      timeout_ms?: number | null;
      new_name?: string | null;
    }
  | { op: 'accessibility_tree'; max_depth?: number | null }
  | { op: 'semantic_action'; element_id: string; action: string; value?: string | null }
  | {
      op: 'file_chunk_op';
      chunk_op: string;
      sub_op?: string;
      transfer_id: string;
      path: string;
      offset: number;
      data_b64?: string | null;
      sha256?: string | null;
      total_size?: number | null;
    }
  | { op: 'test_connection' };

/** Mirrors `RemoteComputerOp::is_read_only()` (`computer_contracts.rs:387-399`) */
export function isReadOnlyRemoteComputerOp(operation: RemoteComputerOp): boolean {
  switch (operation.op) {
    case 'read_file':
    case 'list_dir':
    case 'capture_screen':
    case 'test_connection':
    case 'clipboard_get':
    case 'display_list':
    case 'accessibility_tree':
      return true;
    case 'terminal_op': {
      const sub = operation.terminal_op ?? operation.sub_op;
      return sub === 'ls' || sub === 'has' || sub === 'read';
    }
    default:
      return false;
  }
}

/** Rust name: `RegisterLocalComputerRequest` (`computer_contracts.rs:172-178`) */
export interface LocalComputerRegisterRequest {
  device_id: string;
  display_name: string;
  ip_address: string;
  os_name: string;
  resolution: string;
}
export type RegisterLocalComputerRequest = LocalComputerRegisterRequest;

/** Rust name: `RemoteComputerCommandResult` (`computer_contracts.rs:443-455`) */
export interface LocalComputerCommandResult {
  command_id: string;
  node_id: string;
  ok: boolean;
  exit_code: number;
  stdout: string;
  stderr: string;
  entries: string[];
  frame_data_url?: string | null;
  executed_by: string;
  duration_ms: number;
}
export type RemoteComputerCommandResult = LocalComputerCommandResult;

export interface RemoteComputerCommandRequest {
  node_id: string;
  caller_device_id?: string | null;
  caller_bot_id?: number | null;
  caller_label: string;
  operation: RemoteComputerOp;
}

export interface UpsertCloudComputerRequest {
  node_id?: string | null;
  display_name: string;
  host: string;
  port: number;
  username: string;
  auth_method: CloudAuthMethod;
  secret?: string | null;
  agent_endpoint_url?: string | null;
  workdir?: string | null;
  bind_bot_id?: number | null;
  verify_connection: boolean;
}

export interface UpdateComputerPolicyRequest {
  run_policy?: ComputerRunPolicy;
  add_controller?: AuthorizedControllerEntry;
  remove_controller_id?: string;
  display_name?: string;
}

export interface BotComputerProfileDto {
  bot_id: number;
  bound_node_id?: string | null;
  persona_prompt: string;
  preferred_model: string;
  approval_mode: ComputerRunPolicy;
  allow_cross_device_control: boolean;
  allow_cloud_self_config: boolean;
  updated_at_ms: number;
}

export interface UpdateBotComputerRequest {
  bound_node_id?: string | null;
  clear_bound_node?: boolean;
  persona_prompt?: string;
  preferred_model?: string;
  approval_mode?: ComputerRunPolicy;
  allow_cross_device_control?: boolean;
  allow_cloud_self_config?: boolean;
}

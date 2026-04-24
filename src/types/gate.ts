import type { V2Severity } from './alerts.js';
import type { ListingEvent } from './probes.js';

// ─── V2 Event Types ──────────────────────────────────────────

export type SecClawEventModule =
  | 'yieldclaw_probe' | 'mm_probe' | 'guardian_probe'
  | 'otterclaw_probe' | 'growth_probe' | 'listing_watchdog'
  | 'correlator' | 'drift_detector' | 'integrity_scanner'
  | 'dependency_attestor' | 'signer_health'
  | 'contract_verification' | 'mcp_tool_attestor'
  | 'oracle_token_verifier'
  | 'supply_chain_worm' | 'hook_sandbox' | 'lockfile_attestation'
  | 'workstation_probe' | 'process_probe' | 'network_probe' | 'filesystem_probe'
  | 'github_probe'
  | 'credential_radius' | 'workflow_drift'
  | 'otterclaw_receiver'
  | 'deploy_pause' | 'token_revoke' | 'signer_rotate' | 'quarantine_builder'
  | 'gate' | 'slippage_guard'
  | 'skill_hash_verifier';

export type SecClawEventAction = 'pass' | 'block' | 'alert' | 'escalate';

export interface SecClawEventExecutionContext {
  tool_name?: string;
  contract_address?: string;
  function_selector?: string;
  calldata_hash?: string;
  mcp_server?: string;
  gas_estimate?: number;
  value_usd?: number;
}

export interface SecClawEvent {
  id: string;
  version: '2.0';
  timestamp: string;
  source: 'daemon' | 'gate';
  agent_id: string;
  module: SecClawEventModule;
  action: SecClawEventAction;
  severity: V2Severity;
  check: string;
  details: {
    expected: unknown;
    actual: unknown;
    policy_rule: string;
    message: string;
  };
  execution_context?: SecClawEventExecutionContext;
  trace_id: string;
  session_id?: string;
}

// ─── Gate Types ──────────────────────────────────────────────

export type GateActionType = 'sign' | 'call' | 'register_tool' | 'invoke_tool';

export interface GateRequest {
  agent_id: string;
  action_type: GateActionType;
  payload: {
    to?: string;
    data?: string;
    value?: string;
    gas_limit?: number;
    gas_price?: string;
    tool_name?: string;
    tool_schema?: object;
    tool_endpoint?: string;
    tool_params?: object;
    nonce?: number;
    session_id?: string;
    value_usd?: number;
    wallet_address?: string;
  };
}

export type GateCheckResult = 'pass' | 'block' | 'skip';

export interface GateCheckEntry {
  module: string;
  check: string;
  result: GateCheckResult;
  latency_ms: number;
}

export interface GateResponse {
  allowed: boolean;
  event: SecClawEvent;
  reason?: string;
  checks_performed: GateCheckEntry[];
}

// ─── Signer Modification Types ──────────────────────────────

export type ModificationStatus =
  | 'pending' | 'approved' | 'queued' | 'active'
  | 'expired' | 'cancelled' | 'rejected' | 'reverted';

export interface ModificationRequest {
  request_id: string;
  tier: 2 | 3;
  parameter: string;
  current_value: number;
  requested_value: number;
  justification: string;
  requested_by: 'agent' | 'operator';
  status: ModificationStatus;
  requested_at: string;
  approved_by?: string;
  activated_at?: string;
  expires_at?: string;
  reverted_to?: number;
  duration_sec?: number;
  session_id?: string;
}

// ─── Shared Gate State ──────────────────────────────────────

export interface GateSharedState {
  activeCriticalAlerts: Record<string, true>;
  activeModifications: Record<string, ModificationRequest>;
  pendingModifications: Record<string, ModificationRequest>;
  recentListings: ListingEvent[];
  signerRotationTriggeredAt: number | null;
}

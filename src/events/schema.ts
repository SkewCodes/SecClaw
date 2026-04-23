import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type {
  SecClawEvent,
  SecClawEventModule,
  SecClawEventAction,
  SecClawEventExecutionContext,
  V2Severity,
} from '../types.js';

const SecClawEventModuleEnum = z.enum([
  'yieldclaw_probe', 'mm_probe', 'guardian_probe',
  'otterclaw_probe', 'growth_probe', 'listing_watchdog',
  'correlator', 'drift_detector', 'integrity_scanner',
  'dependency_attestor', 'signer_health',
  'contract_verification', 'mcp_tool_attestor',
  'oracle_token_verifier',
  'supply_chain_worm', 'hook_sandbox', 'lockfile_attestation',
  'workstation_probe', 'process_probe', 'network_probe', 'filesystem_probe',
  'github_probe',
  'credential_radius', 'workflow_drift',
  'otterclaw_receiver',
  'deploy_pause', 'token_revoke', 'signer_rotate', 'quarantine_builder',
]);

const SecClawEventActionEnum = z.enum(['pass', 'block', 'alert', 'escalate']);

const SeverityEnum = z.enum(['info', 'warning', 'critical']);

const ExecutionContextSchema = z.object({
  tool_name: z.string().optional(),
  contract_address: z.string().optional(),
  function_selector: z.string().optional(),
  calldata_hash: z.string().optional(),
  mcp_server: z.string().optional(),
  gas_estimate: z.number().optional(),
  value_usd: z.number().optional(),
}).strict();

export const SecClawEventSchema = z.object({
  id: z.string().uuid(),
  version: z.literal('2.0'),
  timestamp: z.string().datetime(),
  source: z.enum(['daemon', 'gate']),
  agent_id: z.string().min(1),
  module: SecClawEventModuleEnum,
  action: SecClawEventActionEnum,
  severity: SeverityEnum,
  check: z.string().min(1),
  details: z.object({
    expected: z.unknown(),
    actual: z.unknown(),
    policy_rule: z.string(),
    message: z.string(),
  }),
  execution_context: ExecutionContextSchema.optional(),
  trace_id: z.string().uuid(),
  session_id: z.string().optional(),
}).strict();

export function validateSecClawEvent(event: unknown): SecClawEvent {
  return SecClawEventSchema.parse(event) as SecClawEvent;
}

export interface CreateEventParams {
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
  trace_id?: string;
  session_id?: string;
}

export function createSecClawEvent(params: CreateEventParams): SecClawEvent {
  return {
    id: randomUUID(),
    version: '2.0',
    timestamp: new Date().toISOString(),
    source: params.source,
    agent_id: params.agent_id,
    module: params.module,
    action: params.action,
    severity: params.severity,
    check: params.check,
    details: params.details,
    execution_context: params.execution_context,
    trace_id: params.trace_id ?? randomUUID(),
    session_id: params.session_id,
  };
}

import { createSecClawEvent } from '../events/schema.js';
import { SecClawEventEmitter, secClawEventToAlert } from '../events/emitter.js';
import { checkDependencyAttestation } from './dependency-attestor.js';
import { checkListingCooldown } from './listing-cooldown.js';
import { checkContractVerification } from './contract-verification.js';
import { checkOracleTokenVerification } from './oracle-token-verifier.js';
import { checkSlippageProtection } from './slippage-guard.js';
import { GateRequestSchema } from './request-schema.js';
import { containsPrivateKeyMaterial } from './private-key-guard.js';
import type {
  GateRequest,
  GateResponse,
  GateCheckEntry,
  GateSharedState,
  PolicyManifest,
  SecClawConfig,
  SecClawEvent,
} from '../types.js';
import type { AlertBus } from '../alerts/bus.js';

const ROTATION_LOCKOUT_MS = 60_000;

export interface GateContext {
  manifest: PolicyManifest;
  config: SecClawConfig;
  sharedState: GateSharedState;
  emitter: SecClawEventEmitter;
  alertBus: AlertBus;
  signerHealthCheck?: (
    request: GateRequest,
    manifest: PolicyManifest,
    sharedState: GateSharedState,
  ) => { entries: GateCheckEntry[]; events: SecClawEvent[] };
}

type GateModule = (
  request: GateRequest,
  manifest: PolicyManifest,
  sharedState: GateSharedState,
) => { entries: GateCheckEntry[]; events: SecClawEvent[] };

export async function gate(
  request: GateRequest,
  ctx: GateContext,
): Promise<GateResponse> {
  const { manifest, config, emitter, alertBus } = ctx;
  const allChecks: GateCheckEntry[] = [];
  const allEvents: SecClawEvent[] = [];
  let blocked = false;
  let blockReason: string | undefined;

  // Hardcoded invariant #10: GateRequest schema validation is always enforced
  const parsed = GateRequestSchema.safeParse(request);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    const blockEvent = createSecClawEvent({
      source: 'gate',
      agent_id: request.agent_id ?? 'unknown',
      module: 'gate',
      action: 'block',
      severity: 'critical',
      check: 'request_schema_validation',
      details: {
        expected: 'valid GateRequest',
        actual: issues,
        policy_rule: 'gate.request_schema',
        message: `GateRequest schema validation failed: ${issues}`,
      },
    });
    emitter.emitAll([blockEvent]);
    const v1Alerts = [blockEvent].filter((e) => e.action === 'block').map(secClawEventToAlert);
    if (v1Alerts.length > 0) await alertBus.emitAll(v1Alerts);
    return {
      allowed: false,
      event: blockEvent,
      reason: `GateRequest schema validation failed: ${issues}`,
      checks_performed: [{ module: 'gate', check: 'request_schema_validation', result: 'block', latency_ms: 0 }],
    };
  }

  // Hardcoded invariant #6: Gate requests containing private key material are ALWAYS blocked
  if (containsPrivateKeyMaterial(request.payload)) {
    const blockEvent = createSecClawEvent({
      source: 'gate',
      agent_id: request.agent_id,
      module: 'gate',
      action: 'block',
      severity: 'critical',
      check: 'private_key_material_detected',
      details: {
        expected: 'no private key material',
        actual: 'private key material detected in payload',
        policy_rule: 'gate.private_key_guard',
        message: 'Gate request blocked: potential private key material detected in payload',
      },
    });
    emitter.emitAll([blockEvent]);
    const v1Alerts = [blockEvent].filter((e) => e.action === 'block').map(secClawEventToAlert);
    if (v1Alerts.length > 0) await alertBus.emitAll(v1Alerts);
    return {
      allowed: false,
      event: blockEvent,
      reason: 'Gate request blocked: potential private key material detected in payload',
      checks_performed: [{ module: 'gate', check: 'private_key_material_detected', result: 'block', latency_ms: 0 }],
    };
  }

  // Hardcoded invariant #7: All signing is blocked during signer rotation lockout
  if (ctx.sharedState.signerRotationTriggeredAt) {
    const elapsed = Date.now() - ctx.sharedState.signerRotationTriggeredAt;
    if (elapsed < ROTATION_LOCKOUT_MS && (request.action_type === 'sign' || request.action_type === 'call')) {
      const remaining = Math.ceil((ROTATION_LOCKOUT_MS - elapsed) / 1000);
      const blockEvent = createSecClawEvent({
        source: 'gate',
        agent_id: request.agent_id,
        module: 'signer_health',
        action: 'block',
        severity: 'critical',
        check: 'signer_rotation_lockout',
        details: {
          expected: 'rotation complete',
          actual: `${remaining}s remaining`,
          policy_rule: 'gate.signer_rotation_lockout',
          message: `Signer rotation in progress — ${remaining}s remaining`,
        },
      });
      emitter.emitAll([blockEvent]);
      const v1Alerts = [blockEvent].filter((e) => e.action === 'block').map(secClawEventToAlert);
      if (v1Alerts.length > 0) await alertBus.emitAll(v1Alerts);
      return {
        allowed: false,
        event: blockEvent,
        reason: `Signer rotation in progress — ${remaining}s remaining`,
        checks_performed: [{ module: 'signer_health', check: 'signer_rotation_lockout', result: 'block', latency_ms: 0 }],
      };
    }
  }

  const modules: Array<{ name: string; run: GateModule }> = [
    {
      name: 'dependency_attestor',
      run: (req, m) => checkDependencyAttestation(req, m),
    },
    {
      name: 'listing_cooldown',
      run: (req, m, ss) => checkListingCooldown(req, m, ss),
    },
    {
      name: 'contract_verification',
      run: (req, m, ss) => checkContractVerification(req, m, ss),
    },
    {
      name: 'oracle_token_verifier',
      run: (req, m, ss) => checkOracleTokenVerification(req, m, ss),
    },
    {
      name: 'slippage_guard',
      run: (req, m) => checkSlippageProtection(req, m),
    },
  ];

  // TODO(tier-3): MCP tool attestation -- blocked until N > 5 builders

  if (ctx.signerHealthCheck) {
    modules.push({
      name: 'signer_health',
      run: ctx.signerHealthCheck,
    });
  }

  for (const mod of modules) {
    const { entries, events } = mod.run(request, manifest, ctx.sharedState);
    allChecks.push(...entries);
    allEvents.push(...events);

    const blockEntry = entries.find((e) => e.result === 'block');
    if (blockEntry && !blocked) {
      blocked = true;
      const blockEvent = events.find((e) => e.action === 'block');
      blockReason = blockEvent?.details.message ?? `Blocked by ${mod.name}/${blockEntry.check}`;
      if (!config.auditMode) break;
    }
  }

  const allowed = config.auditMode ? true : !blocked;
  const action = blocked ? (config.auditMode ? 'alert' : 'block') : 'pass';

  const gateEvent = createSecClawEvent({
    source: 'gate',
    agent_id: request.agent_id,
    module: blocked
      ? (allChecks.find((c) => c.result === 'block')?.module as SecClawEvent['module']) ?? 'dependency_attestor'
      : (allChecks[0]?.module as SecClawEvent['module']) ?? 'dependency_attestor',
    action,
    severity: blocked ? 'critical' : 'info',
    check: 'gate_decision',
    details: {
      expected: 'allowed',
      actual: allowed ? 'allowed' : 'blocked',
      policy_rule: 'gate',
      message: allowed
        ? `Gate passed: ${allChecks.length} checks performed`
        : `Gate blocked: ${blockReason}`,
    },
    execution_context: {
      contract_address: request.payload.to,
      function_selector: request.payload.data?.slice(0, 10),
      gas_estimate: request.payload.gas_limit,
      tool_name: request.payload.tool_name,
    },
  });

  allEvents.push(gateEvent);
  emitter.emitAll(allEvents);

  const v1Alerts = allEvents
    .filter((e) => e.action === 'block')
    .map(secClawEventToAlert);

  if (v1Alerts.length > 0) {
    await alertBus.emitAll(v1Alerts);
  }

  return {
    allowed,
    event: gateEvent,
    reason: blocked ? blockReason : undefined,
    checks_performed: allChecks,
  };
}

export function createGateSharedState(): GateSharedState {
  return {
    activeCriticalAlerts: {},
    activeModifications: {},
    pendingModifications: {},
    recentListings: [],
    signerRotationTriggeredAt: null,
  };
}

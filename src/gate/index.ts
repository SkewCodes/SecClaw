import { createSecClawEvent } from '../events/schema.js';
import { SecClawEventEmitter, secClawEventToAlert } from '../events/emitter.js';
import { checkDependencyAttestation } from './dependency-attestor.js';
import { checkListingCooldown } from './listing-cooldown.js';
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

  const modules: Array<{ name: string; run: GateModule }> = [
    {
      name: 'dependency_attestor',
      run: (req, m) => checkDependencyAttestation(req, m),
    },
    {
      name: 'listing_cooldown',
      run: (req, m, ss) => checkListingCooldown(req, m, ss),
    },
  ];

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
    activeCriticalAlerts: new Set(),
    activeModifications: new Map(),
    pendingModifications: new Map(),
    recentListings: [],
  };
}

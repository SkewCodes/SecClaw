import { keccak256, encodeAbiParameters } from 'viem';
import { createSecClawEvent } from '../events/schema.js';
import type {
  GateRequest,
  GateCheckEntry,
  GateSharedState,
  PolicyManifest,
  SecClawEvent,
  GovernancePolicy,
} from '../types.js';

/**
 * Pre-execution gate module: blocks builder governance actions that would
 * cross the firewall. Mirrors the on-chain GovernanceSecOversight.checkAction
 * but runs *before* the tx is signed — so a compromised UI cannot even
 * submit the proposal.
 *
 * The action context is encoded in the GateRequest payload:
 *   - tool_name: 'governance.queue' | 'governance.execute' | 'governance.propose'
 *   - tool_params.governor: BuilderGovernor address
 *   - tool_params.target: target contract
 *   - tool_params.data: calldata (hex)
 *   - tool_params.value: wei (string)
 */
export function checkGovernanceAction(
  request: GateRequest,
  manifest: PolicyManifest,
  sharedState: GateSharedState,
): { entries: GateCheckEntry[]; events: SecClawEvent[] } {
  const entries: GateCheckEntry[] = [];
  const events: SecClawEvent[] = [];
  const start = Date.now();

  const policy = manifest.governance;
  if (!policy?.enabled) {
    entries.push({
      module: 'governance_action',
      check: 'governance_action_firewall',
      result: 'skip',
      latency_ms: Date.now() - start,
    });
    return { entries, events };
  }

  const params = (request.payload.tool_params ?? {}) as Record<string, unknown>;
  const governor = (params['governor'] as string | undefined)?.toLowerCase();
  const target = (params['target'] as string | undefined)?.toLowerCase();
  const data = params['data'] as string | undefined;
  const valueRaw = params['value'] as string | number | undefined;

  // Only enforce on governance.* tool calls.
  const toolName = request.payload.tool_name ?? '';
  const isGovernanceCall = toolName.startsWith('governance.');
  if (!isGovernanceCall || !governor || !target || !data) {
    entries.push({
      module: 'governance_action',
      check: 'governance_action_firewall',
      result: 'skip',
      latency_ms: Date.now() - start,
    });
    return { entries, events };
  }

  // ── 1. Governor frozen? (Per-product kill switch.)
  if (sharedState.frozenGovernors?.has(governor)) {
    return blockResult(
      'governor_frozen',
      `governor ${governor} is frozen by SecClaw`,
      `governor ${governor} is frozen — all actions rejected`,
      request, sharedState, policy, governor, target, data, start, entries, events,
    );
  }

  // ── 2. Target globally protected? (ORDER, vault, CLOB, etc.)
  const protectedTargets = new Set(
    policy.orderly_protected_targets.map((s) => s.toLowerCase()),
  );
  if (protectedTargets.has(target)) {
    return blockResult(
      'target_orderly_protected',
      `target ${target} is on the Orderly-protected list`,
      `${target} is an Orderly-protected target — never callable from builder governance`,
      request, sharedState, policy, governor, target, data, start, entries, events,
    );
  }

  // ── 3. Forbidden selector globally? (delegate, upgradeTo, mint, ...)
  const selector = data.length >= 10 ? data.slice(0, 10).toLowerCase() : '';
  const forbiddenSet = new Set(
    policy.forbidden_selectors_global.map((s) => s.toLowerCase()),
  );
  if (selector && forbiddenSet.has(selector)) {
    return blockResult(
      'selector_globally_forbidden',
      `selector ${selector} is globally forbidden`,
      `selector ${selector} forbidden across all governance — known takeover vector`,
      request, sharedState, policy, governor, target, data, start, entries, events,
    );
  }

  // ── 4. Per-product action blocklist (action-hash level).
  const actionHash = computeActionHash(governor, target, selector, data);
  const blocklist = new Set(
    policy.action_blocklist.map((s) => s.toLowerCase()),
  );
  if (blocklist.has(`${governor}:${actionHash.toLowerCase()}`)) {
    return blockResult(
      'action_hash_blocked',
      `action hash ${actionHash} blocked for ${governor}`,
      `this specific governance action was flagged and blocked by Council`,
      request, sharedState, policy, governor, target, data, start, entries, events,
    );
  }

  // ── 5. Value cap.
  let value = 0n;
  try {
    value = typeof valueRaw === 'number' ? BigInt(valueRaw) : BigInt(valueRaw ?? 0);
  } catch { value = 0n; }
  if (value > 0n) {
    const cap = sharedState.governorValueCaps?.get(governor) ?? 0n;
    if (value > cap) {
      return blockResult(
        'value_exceeds_cap',
        `value ${value} > cap ${cap} for ${governor}`,
        `governance action native-value transfer ${value} exceeds per-governor cap ${cap}`,
        request, sharedState, policy, governor, target, data, start, entries, events,
      );
    }
  }

  // All checks passed.
  entries.push({
    module: 'governance_action',
    check: 'governance_action_firewall',
    result: 'pass',
    latency_ms: Date.now() - start,
  });
  return { entries, events };
}

function computeActionHash(
  governor: string,
  target: string,
  selector: string,
  data: string,
): string {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'bytes4' },
        { type: 'bytes' },
      ],
      [
        governor as `0x${string}`,
        target as `0x${string}`,
        (selector || '0x00000000') as `0x${string}`,
        (data || '0x') as `0x${string}`,
      ],
    ),
  );
}

function blockResult(
  check: string,
  expected: string,
  message: string,
  request: GateRequest,
  _sharedState: GateSharedState,
  policy: GovernancePolicy,
  governor: string,
  target: string,
  data: string,
  start: number,
  entries: GateCheckEntry[],
  events: SecClawEvent[],
): { entries: GateCheckEntry[]; events: SecClawEvent[] } {
  entries.push({
    module: 'governance_action',
    check,
    result: 'block',
    latency_ms: Date.now() - start,
  });
  events.push(createSecClawEvent({
    source: 'gate',
    agent_id: request.agent_id,
    module: 'governance_action',
    action: 'block',
    severity: 'critical',
    check,
    details: {
      expected,
      actual: { governor, target, selector: data.slice(0, 10) },
      policy_rule: 'governance.firewall',
      message,
    },
    execution_context: {
      contract_address: target,
      function_selector: data.slice(0, 10),
      tool_name: request.payload.tool_name,
    },
  }));
  void policy; // referenced for future per-policy diagnostics
  return { entries, events };
}

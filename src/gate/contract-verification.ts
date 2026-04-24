import { createSecClawEvent } from '../events/schema.js';
import type {
  GateCheckEntry,
  GateRequest,
  GateSharedState,
  PolicyManifest,
  SecClawEvent,
  ContractVerificationPolicy,
} from '../types.js';

export function checkContractVerification(
  request: GateRequest,
  manifest: PolicyManifest,
  _sharedState: GateSharedState,
): { entries: GateCheckEntry[]; events: SecClawEvent[] } {
  const entries: GateCheckEntry[] = [];
  const events: SecClawEvent[] = [];
  const policy = manifest.contracts;

  if (!policy || policy.mode === 'disabled') {
    entries.push({ module: 'contract_verification', check: 'contract_allowlist', result: 'skip', latency_ms: 0 });
    return { entries, events };
  }

  if (request.action_type !== 'sign' && request.action_type !== 'call') {
    entries.push({ module: 'contract_verification', check: 'contract_allowlist', result: 'skip', latency_ms: 0 });
    return { entries, events };
  }

  const start = performance.now();
  const target = request.payload.to?.toLowerCase();

  if (!target) {
    const latency = Math.round(performance.now() - start);
    entries.push({ module: 'contract_verification', check: 'contract_target', result: 'block', latency_ms: latency });
    events.push(makeEvent(request, 'block', 'critical', 'contract_target_missing', {
      expected: 'contract address',
      actual: null,
      policy_rule: 'contracts.allowed_interactions',
      message: 'Transaction has no target address',
    }));
    return { entries, events };
  }

  if (isBlocked(target, policy)) {
    const latency = Math.round(performance.now() - start);
    entries.push({ module: 'contract_verification', check: 'blocked_address', result: 'block', latency_ms: latency });
    events.push(makeEvent(request, 'block', 'critical', 'blocked_address', {
      expected: 'not in blocked list',
      actual: target,
      policy_rule: 'contracts.blocked_addresses',
      message: `Contract address is explicitly blocked: ${target}`,
    }));
    return { entries, events };
  }

  const interaction = policy.allowed_interactions.find(
    (i) => i.address.toLowerCase() === target,
  );

  if (!interaction) {
    const action = policy.unknown_contract_action;
    const latency = Math.round(performance.now() - start);
    entries.push({
      module: 'contract_verification',
      check: 'unknown_contract',
      result: action === 'block' ? 'block' : 'pass',
      latency_ms: latency,
    });
    events.push(makeEvent(
      request,
      action === 'block' ? 'block' : 'alert',
      'critical',
      'unknown_contract',
      {
        expected: 'registered contract',
        actual: target,
        policy_rule: 'contracts.unknown_contract_action',
        message: `Contract ${target} not in allowlist — action: ${action}`,
      },
    ));
    return { entries, events };
  }

  const selector = request.payload.data?.slice(0, 10)?.toLowerCase();
  if (selector) {
    const allowedFn = interaction.functions.find(
      (f) => f.selector.toLowerCase() === selector,
    );

    if (!allowedFn) {
      const latency = Math.round(performance.now() - start);
      entries.push({ module: 'contract_verification', check: 'selector_mismatch', result: 'block', latency_ms: latency });
      events.push(makeEvent(request, 'block', 'critical', 'selector_mismatch', {
        expected: interaction.functions.map((f) => f.selector).join(', '),
        actual: selector,
        policy_rule: 'contracts.allowed_interactions.functions',
        message: `Function selector ${selector} not allowed for contract ${target}`,
      }));
      return { entries, events };
    }

    // Calldata length validation (Item 8): only validate when data is long enough
    // to plausibly contain encoded parameters (> selector-only length)
    if (request.payload.data && request.payload.data.length > 10 && allowedFn.params) {
      const expectedParams = Object.keys(allowedFn.params).length;
      if (expectedParams > 0 && !validateCalldataLength(request.payload.data, expectedParams)) {
        const latency = Math.round(performance.now() - start);
        entries.push({ module: 'contract_verification', check: 'calldata_length', result: 'block', latency_ms: latency });
        events.push(makeEvent(request, 'block', 'critical', 'calldata_length_invalid', {
          expected: `>= ${4 + expectedParams * 32} bytes`,
          actual: `${(request.payload.data.length - 2) / 2} bytes`,
          policy_rule: 'contracts.allowed_interactions.functions',
          message: `Calldata length mismatch for ${selector} on ${target} — expected at least ${expectedParams} ABI-encoded params`,
        }));
        return { entries, events };
      }
    }

    const boundsResult = checkParamBounds(request, allowedFn.params, selector, target);
    if (boundsResult) {
      const latency = Math.round(performance.now() - start);
      entries.push({ module: 'contract_verification', check: 'param_bounds', result: 'block', latency_ms: latency });
      events.push(boundsResult);
      return { entries, events };
    }
  }

  const latency = Math.round(performance.now() - start);
  entries.push({ module: 'contract_verification', check: 'contract_allowlist', result: 'pass', latency_ms: latency });
  events.push(makeEvent(request, 'pass', 'info', 'contract_verified', {
    expected: 'allowed',
    actual: 'allowed',
    policy_rule: 'contracts',
    message: `Contract ${target} verified against allowlist`,
  }));

  return { entries, events };
}

function isBlocked(target: string, policy: ContractVerificationPolicy): boolean {
  return policy.blocked_addresses.some((a) => a.toLowerCase() === target);
}

function checkParamBounds(
  request: GateRequest,
  params: Record<string, { max?: number; min?: number }> | undefined,
  selector: string,
  target: string,
): SecClawEvent | null {
  if (!params) return null;

  const toolParams = request.payload.tool_params as Record<string, unknown> | undefined;
  if (!toolParams) return null;

  for (const [name, bounds] of Object.entries(params)) {
    const value = toolParams[name];
    if (typeof value !== 'number') continue;

    if (bounds.max !== undefined && value > bounds.max) {
      return makeEvent(request, 'block', 'critical', 'param_bounds_exceeded', {
        expected: `${name} <= ${bounds.max}`,
        actual: value,
        policy_rule: `contracts.allowed_interactions.functions.params.${name}`,
        message: `Parameter ${name}=${value} exceeds max ${bounds.max} for ${selector} on ${target}`,
      });
    }

    if (bounds.min !== undefined && value < bounds.min) {
      return makeEvent(request, 'block', 'critical', 'param_bounds_exceeded', {
        expected: `${name} >= ${bounds.min}`,
        actual: value,
        policy_rule: `contracts.allowed_interactions.functions.params.${name}`,
        message: `Parameter ${name}=${value} below min ${bounds.min} for ${selector} on ${target}`,
      });
    }
  }

  return null;
}

export function validateCalldataLength(data: string, expectedParams: number): boolean {
  const expectedMinLength = 4 + (expectedParams * 32);
  const actualLength = (data.length - 2) / 2;
  return actualLength >= expectedMinLength;
}

function makeEvent(
  request: GateRequest,
  action: 'pass' | 'block' | 'alert',
  severity: 'info' | 'warning' | 'critical',
  check: string,
  details: { expected: unknown; actual: unknown; policy_rule: string; message: string },
): SecClawEvent {
  return createSecClawEvent({
    source: 'gate',
    agent_id: request.agent_id,
    module: 'contract_verification',
    action,
    severity,
    check,
    details,
    execution_context: {
      contract_address: request.payload.to,
      function_selector: request.payload.data?.slice(0, 10),
      gas_estimate: request.payload.gas_limit,
    },
  });
}

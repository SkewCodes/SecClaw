import { createSecClawEvent } from '../events/schema.js';
import type { GateCheckEntry, GateRequest, PolicyManifest, SecClawEvent } from '../types.js';

export function checkSlippageProtection(
  request: GateRequest,
  manifest: PolicyManifest,
): { entries: GateCheckEntry[]; events: SecClawEvent[] } {
  const entries: GateCheckEntry[] = [];
  const events: SecClawEvent[] = [];

  const config = manifest.payment_layer?.swaps;
  if (!config) {
    entries.push({ module: 'slippage_guard', check: 'slippage_guard', result: 'skip', latency_ms: 0 });
    return { entries, events };
  }

  if (request.action_type !== 'sign' && request.action_type !== 'call') {
    entries.push({ module: 'slippage_guard', check: 'slippage_guard', result: 'skip', latency_ms: 0 });
    return { entries, events };
  }

  const start = performance.now();
  const params = request.payload.tool_params as Record<string, unknown> | undefined;
  if (!params) {
    entries.push({ module: 'slippage_guard', check: 'slippage_guard', result: 'skip', latency_ms: 0 });
    return { entries, events };
  }

  const minOutput = params['min_output'] ?? params['amountOutMin'];
  const expectedOutput = params['expected_output'] ?? params['amountOut'];
  const isSwap = params['action'] === 'swap' || params['swap'] === true || minOutput !== undefined || expectedOutput !== undefined;

  if (!isSwap) {
    entries.push({ module: 'slippage_guard', check: 'slippage_guard', result: 'skip', latency_ms: 0 });
    return { entries, events };
  }

  if (!minOutput) {
    const latency = Math.round(performance.now() - start);
    entries.push({ module: 'slippage_guard', check: 'slippage_guard', result: 'block', latency_ms: latency });
    events.push(createSecClawEvent({
      source: 'gate',
      agent_id: request.agent_id,
      module: 'slippage_guard',
      action: 'block',
      severity: 'critical',
      check: 'slippage_missing_min_output',
      details: {
        expected: 'min_output parameter present',
        actual: 'missing',
        policy_rule: 'payment_layer.swaps.max_slippage_pct',
        message: 'Swap transaction missing min_output parameter — vulnerable to sandwich attack',
      },
    }));
    return { entries, events };
  }

  if (minOutput && expectedOutput) {
    const minNum = Number(minOutput);
    const expNum = Number(expectedOutput);
    if (expNum > 0) {
      const slippage = 1 - (minNum / expNum);
      if (slippage > config.max_slippage_pct / 100) {
        const latency = Math.round(performance.now() - start);
        entries.push({ module: 'slippage_guard', check: 'slippage_guard', result: 'block', latency_ms: latency });
        events.push(createSecClawEvent({
          source: 'gate',
          agent_id: request.agent_id,
          module: 'slippage_guard',
          action: 'block',
          severity: 'critical',
          check: 'slippage_exceeded',
          details: {
            expected: `<= ${config.max_slippage_pct}%`,
            actual: `${(slippage * 100).toFixed(2)}%`,
            policy_rule: 'payment_layer.swaps.max_slippage_pct',
            message: `Slippage tolerance ${(slippage * 100).toFixed(2)}% exceeds max ${config.max_slippage_pct}%`,
          },
        }));
        return { entries, events };
      }
    }
  }

  const latency = Math.round(performance.now() - start);
  entries.push({ module: 'slippage_guard', check: 'slippage_guard', result: 'pass', latency_ms: latency });
  return { entries, events };
}

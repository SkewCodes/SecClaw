import { createSecClawEvent } from '../../events/schema.js';
import { TransactionDeduplicator } from '../transaction-dedup.js';
import { GasPriceMonitor } from '../gas-monitor.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';
import { NonceTracker } from './nonce-tracker.js';
import { CumulativeExposureTracker } from './exposure-tracker.js';
import { CooldownTracker } from './cooldown-tracker.js';
import { AccelerationDetector } from './acceleration.js';
import { TargetSwitchDetector } from './target-switch.js';
import { SignerModificationManager } from './modification-mgr.js';
import { refreshSignerBalances as refreshBalances } from './balance.js';
import type { SignerHealthContext } from './context.js';
import type {
  GateCheckEntry,
  GateRequest,
  GateSharedState,
  PolicyManifest,
  SecClawEvent,
  SignerPolicy,
} from '../../types.js';

export type { SignerHealthContext } from './context.js';
export { TokenBucketRateLimiter } from './rate-limiter.js';
export { NonceTracker } from './nonce-tracker.js';
export { CumulativeExposureTracker, parseWindowToMs } from './exposure-tracker.js';
export { CooldownTracker } from './cooldown-tracker.js';
export { AccelerationDetector } from './acceleration.js';
export { TargetSwitchDetector } from './target-switch.js';
export { SignerModificationManager } from './modification-mgr.js';

const defaultRegistry = new Map<string, SignerHealthContext>();

export function getOrCreateSignerContext(
  agentId: string,
  signerPolicy: SignerPolicy,
  onEvent: (event: SecClawEvent) => void,
  registry: Map<string, SignerHealthContext> = defaultRegistry,
): SignerHealthContext {
  let ctx = registry.get(agentId);
  if (ctx) return ctx;

  ctx = {
    rateLimiter: new TokenBucketRateLimiter(
      signerPolicy.rate_limits.per_minute,
      signerPolicy.rate_limits.per_hour,
      signerPolicy.rate_limits.per_day,
    ),
    nonceTracker: new NonceTracker(signerPolicy.immutable.nonce_persistence_path),
    exposureTracker: new CumulativeExposureTracker(
      signerPolicy.cumulative_exposure.window,
      signerPolicy.cumulative_exposure.max_usd,
    ),
    cooldownTracker: new CooldownTracker(),
    accelerationDetector: new AccelerationDetector(),
    targetSwitchDetector: new TargetSwitchDetector(),
    modificationManager: new SignerModificationManager(
      signerPolicy.immutable,
      signerPolicy,
      agentId,
      onEvent,
    ),
    transactionDedup: new TransactionDeduplicator(),
    gasPriceMonitor: new GasPriceMonitor(),
    cachedBalanceEth: null,
    balanceCacheUpdatedAt: 0,
    walletAddress: null,
  };
  ctx.modificationManager.setContext(ctx);
  registry.set(agentId, ctx);
  return ctx;
}

export function resetSignerContexts(
  registry: Map<string, SignerHealthContext> = defaultRegistry,
): void {
  for (const ctx of registry.values()) {
    ctx.modificationManager.destroy();
  }
  registry.clear();
}

export async function refreshSignerBalances(network: string): Promise<void> {
  return refreshBalances(network, defaultRegistry);
}

export function checkSignerHealth(
  request: GateRequest,
  manifest: PolicyManifest,
  sharedState: GateSharedState,
): { entries: GateCheckEntry[]; events: SecClawEvent[] } {
  const entries: GateCheckEntry[] = [];
  const events: SecClawEvent[] = [];
  const signer = manifest.signer;

  if (!signer) {
    entries.push({ module: 'signer_health', check: 'signer_policy', result: 'skip', latency_ms: 0 });
    return { entries, events };
  }

  if (request.action_type !== 'sign' && request.action_type !== 'call') {
    entries.push({ module: 'signer_health', check: 'action_type', result: 'skip', latency_ms: 0 });
    return { entries, events };
  }

  const start = performance.now();
  const collectedEvents: SecClawEvent[] = [];
  const ctx = getOrCreateSignerContext(request.agent_id, signer, (e) => collectedEvents.push(e));
  const mgr = ctx.modificationManager;

  if (request.payload.wallet_address && !ctx.walletAddress) {
    ctx.walletAddress = request.payload.wallet_address;
  }

  const hasBlock = () => entries.some((e) => e.result === 'block');
  const finalize = () => {
    events.push(...collectedEvents);
    const latency = performance.now() - start;
    for (const entry of entries) {
      if (entry.latency_ms === 0) entry.latency_ms = Math.round(latency);
    }
    return { entries, events };
  };

  checkTransactionReplay(request, ctx, entries, events);
  if (hasBlock()) return finalize();

  checkGasBounds(request, signer, mgr, ctx, entries, events);
  if (hasBlock()) return finalize();

  checkRateLimit(request, ctx, mgr, entries, events);
  if (hasBlock()) return finalize();

  checkCooldown(request, ctx, signer, mgr, entries, events);
  if (hasBlock()) return finalize();

  checkNonce(request, signer, ctx, entries, events);
  if (hasBlock()) return finalize();

  checkBalance(request, signer, ctx, entries, events);
  if (hasBlock()) return finalize();

  checkExposure(request, ctx, mgr, entries, events);
  if (hasBlock()) return finalize();

  checkAcceleration(request, signer, ctx, entries, events);
  if (hasBlock()) return finalize();

  checkTargetSwitch(request, signer, ctx, entries, events);

  return finalize();
}

// ─── Individual Checks ──────────────────────────────────────

function checkTransactionReplay(
  request: GateRequest,
  ctx: SignerHealthContext,
  entries: GateCheckEntry[],
  events: SecClawEvent[],
): void {
  const { to, data, value, gas_limit, nonce } = request.payload;
  if (!to && !data) {
    entries.push({ module: 'signer_health', check: 'transaction_replay', result: 'skip', latency_ms: 0 });
    return;
  }

  if (ctx.transactionDedup.isDuplicate(to, data, value, gas_limit, nonce)) {
    entries.push({ module: 'signer_health', check: 'transaction_replay', result: 'block', latency_ms: 0 });
    events.push(createSecClawEvent({
      source: 'gate',
      agent_id: request.agent_id,
      module: 'signer_health',
      action: 'block',
      severity: 'critical',
      check: 'transaction_replay_detected',
      details: {
        expected: 'unique transaction',
        actual: 'duplicate transaction hash detected',
        policy_rule: 'signer.transaction_replay_protection',
        message: 'Transaction replay detected — identical transaction was recently submitted',
      },
    }));
    return;
  }

  entries.push({ module: 'signer_health', check: 'transaction_replay', result: 'pass', latency_ms: 0 });
}

function checkGasBounds(
  request: GateRequest,
  signer: SignerPolicy,
  mgr: SignerModificationManager,
  ctx: SignerHealthContext,
  entries: GateCheckEntry[],
  events: SecClawEvent[],
): void {
  const gasPrice = request.payload.gas_price ? Number(request.payload.gas_price) / 1e9 : undefined;
  const gasLimit = request.payload.gas_limit;
  const effectiveMaxGwei = mgr.getEffectiveValue('gas.max_price_gwei') ?? signer.gas.max_price_gwei;
  const effectiveMaxLimit = mgr.getEffectiveValue('gas.max_limit') ?? signer.gas.max_limit;

  if (gasPrice !== undefined && gasPrice > effectiveMaxGwei) {
    entries.push({ module: 'signer_health', check: 'gas_price', result: 'block', latency_ms: 0 });
    events.push(createSecClawEvent({
      source: 'gate',
      agent_id: request.agent_id,
      module: 'signer_health',
      action: 'block',
      severity: 'critical',
      check: 'gas_price_exceeded',
      details: {
        expected: effectiveMaxGwei,
        actual: gasPrice,
        policy_rule: 'signer.gas.max_price_gwei',
        message: `Gas price ${gasPrice} gwei exceeds limit ${effectiveMaxGwei} gwei`,
      },
    }));
    return;
  }

  if (gasLimit !== undefined && gasLimit > effectiveMaxLimit) {
    entries.push({ module: 'signer_health', check: 'gas_limit', result: 'block', latency_ms: 0 });
    events.push(createSecClawEvent({
      source: 'gate',
      agent_id: request.agent_id,
      module: 'signer_health',
      action: 'block',
      severity: 'critical',
      check: 'gas_limit_exceeded',
      details: {
        expected: effectiveMaxLimit,
        actual: gasLimit,
        policy_rule: 'signer.gas.max_limit',
        message: `Gas limit ${gasLimit} exceeds maximum ${effectiveMaxLimit}`,
      },
    }));
    return;
  }

  if (gasPrice !== undefined) {
    ctx.gasPriceMonitor.record(gasPrice);
    const anomaly = ctx.gasPriceMonitor.detectAnomaly(gasPrice, effectiveMaxGwei);
    if (anomaly.anomalous) {
      events.push(createSecClawEvent({
        source: 'gate',
        agent_id: request.agent_id,
        module: 'signer_health',
        action: 'alert',
        severity: 'warning',
        check: 'gas_price_anomaly',
        details: {
          expected: 'normal gas pricing pattern',
          actual: anomaly.reason,
          policy_rule: 'signer.gas.price_mode',
          message: `Gas price anomaly: ${anomaly.reason}`,
        },
      }));
    }
  }

  entries.push({ module: 'signer_health', check: 'gas_bounds', result: 'pass', latency_ms: 0 });
}

function checkRateLimit(
  request: GateRequest,
  ctx: SignerHealthContext,
  _mgr: SignerModificationManager,
  entries: GateCheckEntry[],
  events: SecClawEvent[],
): void {
  const result = ctx.rateLimiter.tryConsume();

  if (!result.allowed) {
    entries.push({ module: 'signer_health', check: 'rate_limit', result: 'block', latency_ms: 0 });
    events.push(createSecClawEvent({
      source: 'gate',
      agent_id: request.agent_id,
      module: 'signer_health',
      action: 'block',
      severity: 'critical',
      check: 'rate_limit_exceeded',
      details: {
        expected: `within ${result.exhaustedWindow} limit`,
        actual: `${result.exhaustedWindow} bucket exhausted`,
        policy_rule: `signer.rate_limits.${result.exhaustedWindow}`,
        message: `Rate limit exceeded: ${result.exhaustedWindow} bucket exhausted`,
      },
    }));
    return;
  }

  entries.push({ module: 'signer_health', check: 'rate_limit', result: 'pass', latency_ms: 0 });
}

function checkCooldown(
  request: GateRequest,
  ctx: SignerHealthContext,
  signer: SignerPolicy,
  mgr: SignerModificationManager,
  entries: GateCheckEntry[],
  events: SecClawEvent[],
): void {
  const effectiveCooldown = mgr.getEffectiveValue('cooldown_ms') ?? signer.cooldown_ms;
  const result = ctx.cooldownTracker.check(effectiveCooldown);

  if (!result.allowed) {
    entries.push({ module: 'signer_health', check: 'cooldown', result: 'block', latency_ms: 0 });
    events.push(createSecClawEvent({
      source: 'gate',
      agent_id: request.agent_id,
      module: 'signer_health',
      action: 'block',
      severity: 'warning',
      check: 'cooldown_active',
      details: {
        expected: `>= ${effectiveCooldown}ms between signatures`,
        actual: `${result.remainingMs}ms remaining`,
        policy_rule: 'signer.cooldown_ms',
        message: `Cooldown active: ${result.remainingMs}ms remaining before next signature allowed`,
      },
    }));
    return;
  }

  ctx.cooldownTracker.record();
  entries.push({ module: 'signer_health', check: 'cooldown', result: 'pass', latency_ms: 0 });
}

function checkNonce(
  request: GateRequest,
  signer: SignerPolicy,
  ctx: SignerHealthContext,
  entries: GateCheckEntry[],
  events: SecClawEvent[],
): void {
  if (signer.immutable.nonce_mode !== 'strict') {
    entries.push({ module: 'signer_health', check: 'nonce', result: 'skip', latency_ms: 0 });
    return;
  }

  const nonce = request.payload.nonce;
  const result = ctx.nonceTracker.validate(nonce);

  if (!result.valid) {
    entries.push({ module: 'signer_health', check: 'nonce', result: 'block', latency_ms: 0 });
    events.push(createSecClawEvent({
      source: 'gate',
      agent_id: request.agent_id,
      module: 'signer_health',
      action: 'block',
      severity: 'critical',
      check: 'nonce_mismatch',
      details: {
        expected: result.expected,
        actual: result.actual,
        policy_rule: 'signer.immutable.nonce_mode',
        message: `Nonce mismatch: expected ${result.expected}, got ${result.actual}`,
      },
    }));
    return;
  }

  entries.push({ module: 'signer_health', check: 'nonce', result: 'pass', latency_ms: 0 });
}

function checkBalance(
  request: GateRequest,
  signer: SignerPolicy,
  ctx: SignerHealthContext,
  entries: GateCheckEntry[],
  events: SecClawEvent[],
): void {
  if (ctx.cachedBalanceEth === null) {
    entries.push({ module: 'signer_health', check: 'balance', result: 'skip', latency_ms: 0 });
    return;
  }

  const minBalance = signer.immutable.balance_minimum_eth;
  if (ctx.cachedBalanceEth < minBalance) {
    entries.push({ module: 'signer_health', check: 'balance', result: 'block', latency_ms: 0 });
    events.push(createSecClawEvent({
      source: 'gate',
      agent_id: request.agent_id,
      module: 'signer_health',
      action: 'block',
      severity: 'critical',
      check: 'balance_below_minimum',
      details: {
        expected: minBalance,
        actual: ctx.cachedBalanceEth,
        policy_rule: 'signer.immutable.balance_minimum_eth',
        message: `Wallet balance ${ctx.cachedBalanceEth} ETH below minimum ${minBalance} ETH`,
      },
    }));
    return;
  }

  entries.push({ module: 'signer_health', check: 'balance', result: 'pass', latency_ms: 0 });
}

function checkExposure(
  request: GateRequest,
  ctx: SignerHealthContext,
  _mgr: SignerModificationManager,
  entries: GateCheckEntry[],
  events: SecClawEvent[],
): void {
  const valueUsd = request.payload.value_usd;

  if (valueUsd === undefined || valueUsd === 0) {
    entries.push({ module: 'signer_health', check: 'cumulative_exposure', result: 'skip', latency_ms: 0 });
    return;
  }

  const result = ctx.exposureTracker.check(valueUsd);

  if (!result.allowed) {
    entries.push({ module: 'signer_health', check: 'cumulative_exposure', result: 'block', latency_ms: 0 });
    events.push(createSecClawEvent({
      source: 'gate',
      agent_id: request.agent_id,
      module: 'signer_health',
      action: 'block',
      severity: 'critical',
      check: 'cumulative_exposure_exceeded',
      details: {
        expected: result.maxUsd,
        actual: result.currentUsd + valueUsd,
        policy_rule: 'signer.cumulative_exposure.max_usd',
        message: `Cumulative exposure $${result.currentUsd + valueUsd} would exceed limit $${result.maxUsd}`,
      },
    }));
    return;
  }

  ctx.exposureTracker.record(valueUsd);
  entries.push({ module: 'signer_health', check: 'cumulative_exposure', result: 'pass', latency_ms: 0 });
}

function checkAcceleration(
  request: GateRequest,
  signer: SignerPolicy,
  ctx: SignerHealthContext,
  entries: GateCheckEntry[],
  events: SecClawEvent[],
): void {
  if (!signer.acceleration_detection) {
    entries.push({ module: 'signer_health', check: 'acceleration', result: 'skip', latency_ms: 0 });
    return;
  }

  ctx.accelerationDetector.record();
  const result = ctx.accelerationDetector.detect();

  if (result.accelerating) {
    entries.push({ module: 'signer_health', check: 'acceleration', result: 'pass', latency_ms: 0 });
    events.push(createSecClawEvent({
      source: 'gate',
      agent_id: request.agent_id,
      module: 'signer_health',
      action: 'alert',
      severity: 'warning',
      check: 'signing_acceleration_detected',
      details: {
        expected: 'stable signing frequency',
        actual: `acceleration gradient: ${result.gradient}`,
        policy_rule: 'signer.acceleration_detection',
        message: `Signing frequency acceleration detected (gradient: ${result.gradient})`,
      },
    }));
    return;
  }

  entries.push({ module: 'signer_health', check: 'acceleration', result: 'pass', latency_ms: 0 });
}

function checkTargetSwitch(
  request: GateRequest,
  signer: SignerPolicy,
  ctx: SignerHealthContext,
  entries: GateCheckEntry[],
  events: SecClawEvent[],
): void {
  if (!signer.target_switch_detection) {
    entries.push({ module: 'signer_health', check: 'target_switch', result: 'skip', latency_ms: 0 });
    return;
  }

  const result = ctx.targetSwitchDetector.check(
    request.payload.to,
    request.payload.session_id,
  );

  if (result.newTarget) {
    entries.push({ module: 'signer_health', check: 'target_switch', result: 'pass', latency_ms: 0 });
    events.push(createSecClawEvent({
      source: 'gate',
      agent_id: request.agent_id,
      module: 'signer_health',
      action: 'alert',
      severity: 'warning',
      check: 'target_switch_detected',
      details: {
        expected: 'known contract targets',
        actual: result.target,
        policy_rule: 'signer.target_switch_detection',
        message: `New contract target detected mid-session: ${result.target}`,
      },
    }));
    return;
  }

  entries.push({ module: 'signer_health', check: 'target_switch', result: 'pass', latency_ms: 0 });
}

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPublicClient, http, formatEther, type PublicClient, type Address } from 'viem';
import { arbitrum, arbitrumSepolia } from 'viem/chains';
import { createSecClawEvent } from '../events/schema.js';
import type {
  GateCheckEntry,
  GateRequest,
  GateSharedState,
  PolicyManifest,
  SecClawEvent,
  SignerPolicy,
  SignerImmutablePolicy,
  ModificationRequest,
} from '../types.js';

// ─── Token Bucket Rate Limiter ──────────────────────────────

interface BucketConfig {
  capacity: number;
  refillPerMs: number;
}

class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(private config: BucketConfig) {
    this.tokens = config.capacity;
    this.lastRefill = Date.now();
  }

  canConsume(): boolean {
    this.refill();
    return this.tokens >= 1;
  }

  consume(): void {
    this.refill();
    this.tokens -= 1;
  }

  remaining(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(
      this.config.capacity,
      this.tokens + elapsed * this.config.refillPerMs,
    );
    this.lastRefill = now;
  }
}

export class TokenBucketRateLimiter {
  private perMinute: TokenBucket;
  private perHour: TokenBucket;
  private perDay: TokenBucket;

  constructor(perMinute: number, perHour: number, perDay: number) {
    this.perMinute = new TokenBucket({
      capacity: perMinute,
      refillPerMs: perMinute / 60_000,
    });
    this.perHour = new TokenBucket({
      capacity: perHour,
      refillPerMs: perHour / 3_600_000,
    });
    this.perDay = new TokenBucket({
      capacity: perDay,
      refillPerMs: perDay / 86_400_000,
    });
  }

  tryConsume(): { allowed: boolean; exhaustedWindow?: string } {
    if (!this.perMinute.canConsume()) return { allowed: false, exhaustedWindow: 'per_minute' };
    if (!this.perHour.canConsume()) return { allowed: false, exhaustedWindow: 'per_hour' };
    if (!this.perDay.canConsume()) return { allowed: false, exhaustedWindow: 'per_day' };
    this.perMinute.consume();
    this.perHour.consume();
    this.perDay.consume();
    return { allowed: true };
  }

  remaining(): { per_minute: number; per_hour: number; per_day: number } {
    return {
      per_minute: this.perMinute.remaining(),
      per_hour: this.perHour.remaining(),
      per_day: this.perDay.remaining(),
    };
  }

  updateLimits(perMinute: number, perHour: number, perDay: number): void {
    this.perMinute = new TokenBucket({
      capacity: perMinute,
      refillPerMs: perMinute / 60_000,
    });
    this.perHour = new TokenBucket({
      capacity: perHour,
      refillPerMs: perHour / 3_600_000,
    });
    this.perDay = new TokenBucket({
      capacity: perDay,
      refillPerMs: perDay / 86_400_000,
    });
  }
}

// ─── Nonce Tracker ──────────────────────────────────────────

interface NonceState {
  expected_nonce: number;
  last_confirmed_nonce: number;
  last_updated: string;
}

export class NonceTracker {
  private state: NonceState;
  private persistPath: string;

  constructor(persistPath: string) {
    this.persistPath = persistPath;
    this.state = this.load();
  }

  validate(nonce: number | undefined): { valid: boolean; expected: number; actual: number | undefined } {
    if (nonce === undefined) {
      return { valid: true, expected: this.state.expected_nonce, actual: undefined };
    }
    return {
      valid: nonce === this.state.expected_nonce,
      expected: this.state.expected_nonce,
      actual: nonce,
    };
  }

  confirmTransaction(nonce: number): void {
    this.state.last_confirmed_nonce = nonce;
    this.state.expected_nonce = nonce + 1;
    this.state.last_updated = new Date().toISOString();
    this.persist();
  }

  syncWithOnChain(onChainNonce: number): void {
    if (onChainNonce > this.state.expected_nonce) {
      this.state.expected_nonce = onChainNonce;
      this.state.last_updated = new Date().toISOString();
      this.persist();
    }
  }

  getExpectedNonce(): number {
    return this.state.expected_nonce;
  }

  private load(): NonceState {
    if (existsSync(this.persistPath)) {
      try {
        const content = readFileSync(this.persistPath, 'utf-8');
        return JSON.parse(content) as NonceState;
      } catch {
        // Corrupted file, start fresh
      }
    }
    return { expected_nonce: 0, last_confirmed_nonce: -1, last_updated: new Date().toISOString() };
  }

  private persist(): void {
    const dir = dirname(this.persistPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.persistPath, JSON.stringify(this.state, null, 2), 'utf-8');
  }
}

// ─── Cumulative Exposure Tracker ────────────────────────────

interface ExposureEntry {
  amount_usd: number;
  timestamp: number;
}

export class CumulativeExposureTracker {
  private entries: ExposureEntry[] = [];
  private windowMs: number;
  private maxUsd: number;

  constructor(window: string, maxUsd: number) {
    this.windowMs = parseWindowToMs(window);
    this.maxUsd = maxUsd;
  }

  check(additionalUsd: number): { allowed: boolean; currentUsd: number; maxUsd: number } {
    this.prune();
    const currentUsd = this.entries.reduce((sum, e) => sum + e.amount_usd, 0);
    return {
      allowed: currentUsd + additionalUsd <= this.maxUsd,
      currentUsd,
      maxUsd: this.maxUsd,
    };
  }

  record(amountUsd: number): void {
    this.entries.push({ amount_usd: amountUsd, timestamp: Date.now() });
  }

  updateLimits(maxUsd: number, window?: string): void {
    this.maxUsd = maxUsd;
    if (window) this.windowMs = parseWindowToMs(window);
  }

  currentTotal(): number {
    this.prune();
    return this.entries.reduce((sum, e) => sum + e.amount_usd, 0);
  }

  private prune(): void {
    const cutoff = Date.now() - this.windowMs;
    this.entries = this.entries.filter((e) => e.timestamp > cutoff);
  }
}

function parseWindowToMs(window: string): number {
  const match = window.match(/^(\d+)(h|m|s)$/);
  if (!match) return 3_600_000; // default 1h
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case 'h': return value * 3_600_000;
    case 'm': return value * 60_000;
    case 's': return value * 1_000;
    default: return 3_600_000;
  }
}

// ─── Cooldown Tracker ───────────────────────────────────────

export class CooldownTracker {
  private lastSignatureAt = 0;

  check(cooldownMs: number): { allowed: boolean; remainingMs: number } {
    const now = Date.now();
    const elapsed = now - this.lastSignatureAt;
    if (elapsed < cooldownMs) {
      return { allowed: false, remainingMs: cooldownMs - elapsed };
    }
    return { allowed: true, remainingMs: 0 };
  }

  record(): void {
    this.lastSignatureAt = Date.now();
  }
}

// ─── Acceleration Detector ──────────────────────────────────

export class AccelerationDetector {
  private timestamps: number[] = [];
  private readonly windowMs = 300_000; // 5-minute analysis window
  private readonly bucketMs = 30_000;  // 30-second buckets

  record(): void {
    this.timestamps.push(Date.now());
    this.prune();
  }

  detect(): { accelerating: boolean; gradient: number } {
    this.prune();
    if (this.timestamps.length < 3) {
      return { accelerating: false, gradient: 0 };
    }

    const now = Date.now();
    const bucketCount = Math.ceil(this.windowMs / this.bucketMs);
    const buckets = new Array<number>(bucketCount).fill(0);

    for (const ts of this.timestamps) {
      const bucketIdx = Math.floor((now - ts) / this.bucketMs);
      if (bucketIdx >= 0 && bucketIdx < bucketCount) {
        buckets[bucketCount - 1 - bucketIdx]++;
      }
    }

    const recentBuckets = buckets.slice(-3);
    if (recentBuckets.length < 3) return { accelerating: false, gradient: 0 };

    const gradient = recentBuckets[2] - recentBuckets[0];
    return {
      accelerating: gradient > 2,
      gradient,
    };
  }

  private prune(): void {
    const cutoff = Date.now() - this.windowMs;
    this.timestamps = this.timestamps.filter((ts) => ts > cutoff);
  }
}

// ─── Target Switch Detector ─────────────────────────────────

export class TargetSwitchDetector {
  private knownTargets = new Set<string>();
  private sessionId: string | null = null;

  check(target: string | undefined, sessionId: string | undefined): { newTarget: boolean; target?: string } {
    if (!target) return { newTarget: false };

    if (sessionId && sessionId !== this.sessionId) {
      this.knownTargets.clear();
      this.sessionId = sessionId;
    }

    if (this.knownTargets.has(target)) {
      return { newTarget: false };
    }

    const isFirst = this.knownTargets.size === 0;
    this.knownTargets.add(target);

    return {
      newTarget: !isFirst,
      target: !isFirst ? target : undefined,
    };
  }

  reset(): void {
    this.knownTargets.clear();
    this.sessionId = null;
  }
}

// ─── Signer Modification Manager (Tier 1 + Tier 2) ─────────

export class SignerModificationManager {
  private immutable: Readonly<SignerImmutablePolicy>;
  private signerPolicy: SignerPolicy;
  private effectiveValues: Map<string, number> = new Map();
  private modificationTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private onEvent: (event: SecClawEvent) => void;
  private agentId: string;
  private ctx: SignerHealthContext | null = null;

  constructor(
    immutablePolicy: SignerImmutablePolicy,
    signerPolicy: SignerPolicy,
    agentId: string,
    onEvent: (event: SecClawEvent) => void,
  ) {
    this.immutable = Object.freeze({ ...immutablePolicy });
    this.signerPolicy = signerPolicy;
    this.agentId = agentId;
    this.onEvent = onEvent;
    this.initEffectiveValues(signerPolicy);
  }

  setContext(ctx: SignerHealthContext): void {
    this.ctx = ctx;
  }

  private initEffectiveValues(policy: SignerPolicy): void {
    this.effectiveValues.set('rate_limits.per_minute', policy.rate_limits.per_minute);
    this.effectiveValues.set('rate_limits.per_hour', policy.rate_limits.per_hour);
    this.effectiveValues.set('rate_limits.per_day', policy.rate_limits.per_day);
    this.effectiveValues.set('cooldown_ms', policy.cooldown_ms);
    this.effectiveValues.set('cumulative_exposure.max_usd', policy.cumulative_exposure.max_usd);
    this.effectiveValues.set('gas.max_price_gwei', policy.gas.max_price_gwei);
    this.effectiveValues.set('gas.max_limit', policy.gas.max_limit);
  }

  getEffectiveValue(parameter: string): number | undefined {
    return this.effectiveValues.get(parameter);
  }

  getImmutable(): Readonly<SignerImmutablePolicy> {
    return this.immutable;
  }

  validateAgainstCeiling(parameter: string, value: number): { valid: boolean; ceiling?: number } {
    const ceilingMap: Record<string, number> = {
      'rate_limits.per_minute': this.immutable.rate_limits_ceiling.per_minute,
      'rate_limits.per_day': this.immutable.rate_limits_ceiling.per_day,
      'cooldown_ms': this.immutable.min_cooldown_ms,
      'cumulative_exposure.max_usd': this.immutable.cumulative_exposure_ceiling_usd,
      'gas.max_price_gwei': this.immutable.gas_ceiling_gwei,
      'gas.max_limit': this.immutable.gas_limit_ceiling,
    };

    const ceiling = ceilingMap[parameter];
    if (ceiling === undefined) return { valid: true };

    if (parameter === 'cooldown_ms') {
      return { valid: value >= ceiling, ceiling };
    }

    return { valid: value <= ceiling, ceiling };
  }

  requestModification(
    parameter: string,
    requestedValue: number,
    justification: string,
    requestedBy: 'agent' | 'operator',
    sharedState: GateSharedState,
  ): ModificationRequest {
    const request: ModificationRequest = {
      request_id: randomUUID(),
      tier: requestedBy === 'agent' ? 3 : 2,
      parameter,
      current_value: this.effectiveValues.get(parameter) ?? 0,
      requested_value: requestedValue,
      justification,
      requested_by: requestedBy,
      status: 'pending',
      requested_at: new Date().toISOString(),
    };

    const ceilingCheck = this.validateAgainstCeiling(parameter, requestedValue);
    if (!ceilingCheck.valid) {
      request.status = 'rejected';
      this.onEvent(createSecClawEvent({
        source: 'gate',
        agent_id: this.agentId,
        module: 'signer_health',
        action: 'block',
        severity: 'warning',
        check: 'modification_rejected',
        details: {
          expected: ceilingCheck.ceiling,
          actual: requestedValue,
          policy_rule: `signer.immutable (Tier 1 ceiling for ${parameter})`,
          message: `Modification rejected: ${parameter}=${requestedValue} exceeds Tier 1 ceiling ${ceilingCheck.ceiling}`,
        },
      }));
      return request;
    }

    sharedState.pendingModifications.set(request.request_id, request);

    this.onEvent(createSecClawEvent({
      source: 'gate',
      agent_id: this.agentId,
      module: 'signer_health',
      action: 'alert',
      severity: 'info',
      check: 'modification_requested',
      details: {
        expected: request.current_value,
        actual: requestedValue,
        policy_rule: `signer.${parameter}`,
        message: `Modification requested: ${parameter} ${request.current_value} -> ${requestedValue} (${justification})`,
      },
    }));

    return request;
  }

  approveModification(
    requestId: string,
    approvedBy: string,
    sharedState: GateSharedState,
  ): boolean {
    const request = sharedState.pendingModifications.get(requestId);
    if (!request || request.status !== 'pending') return false;

    const currentValue = this.effectiveValues.get(request.parameter) ?? 0;
    const isLoosening = this.isLoosening(request.parameter, request.requested_value, currentValue);

    if (isLoosening && this.immutable.critical_alert_lock && sharedState.activeCriticalAlerts.size > 0) {
      this.onEvent(createSecClawEvent({
        source: 'gate',
        agent_id: this.agentId,
        module: 'signer_health',
        action: 'block',
        severity: 'warning',
        check: 'modification_locked',
        details: {
          expected: 'no critical alerts',
          actual: `${sharedState.activeCriticalAlerts.size} active critical alerts`,
          policy_rule: 'signer.immutable.critical_alert_lock',
          message: `Modification locked: cannot loosen ${request.parameter} during active critical alerts`,
        },
      }));
      return false;
    }

    request.approved_by = approvedBy;

    if (isLoosening) {
      const delay = this.getDelayForParameter(request.parameter);
      request.status = 'queued';
      const activatesAt = new Date(Date.now() + delay * 1000).toISOString();

      this.onEvent(createSecClawEvent({
        source: 'gate',
        agent_id: this.agentId,
        module: 'signer_health',
        action: 'alert',
        severity: 'info',
        check: 'modification_approved',
        details: {
          expected: request.current_value,
          actual: request.requested_value,
          policy_rule: `signer.${request.parameter}`,
          message: `Modification approved by ${approvedBy}, activates at ${activatesAt} (${delay}s delay)`,
        },
      }));

      const timer = setTimeout(() => {
        this.activateModification(requestId, sharedState);
      }, delay * 1000);
      this.modificationTimers.set(requestId, timer);
    } else {
      this.activateModification(requestId, sharedState);
    }

    return true;
  }

  cancelModification(requestId: string, sharedState: GateSharedState): boolean {
    const request = sharedState.pendingModifications.get(requestId)
      ?? sharedState.activeModifications.get(requestId);
    if (!request) return false;

    const wasActive = request.status === 'active';
    request.status = 'cancelled';

    const timer = this.modificationTimers.get(requestId);
    if (timer) {
      clearTimeout(timer);
      this.modificationTimers.delete(requestId);
    }

    if (wasActive && request.reverted_to !== undefined) {
      this.effectiveValues.set(request.parameter, request.reverted_to);
      this.propagateEffectiveValues(request.parameter);
    }

    sharedState.pendingModifications.delete(requestId);
    sharedState.activeModifications.delete(requestId);

    this.onEvent(createSecClawEvent({
      source: 'gate',
      agent_id: this.agentId,
      module: 'signer_health',
      action: 'alert',
      severity: 'info',
      check: 'modification_cancelled',
      details: {
        expected: request.requested_value,
        actual: this.effectiveValues.get(request.parameter),
        policy_rule: `signer.${request.parameter}`,
        message: `Modification cancelled: ${request.parameter} reverted to ${this.effectiveValues.get(request.parameter)}`,
      },
    }));

    return true;
  }

  revertModification(requestId: string, sharedState: GateSharedState): boolean {
    const request = sharedState.activeModifications.get(requestId);
    if (!request || request.status !== 'active') return false;

    if (request.reverted_to !== undefined) {
      this.effectiveValues.set(request.parameter, request.reverted_to);
      this.propagateEffectiveValues(request.parameter);
    }

    request.status = 'reverted';
    sharedState.activeModifications.delete(requestId);

    this.onEvent(createSecClawEvent({
      source: 'gate',
      agent_id: this.agentId,
      module: 'signer_health',
      action: 'alert',
      severity: 'info',
      check: 'modification_reverted',
      details: {
        expected: request.requested_value,
        actual: request.reverted_to,
        policy_rule: `signer.${request.parameter}`,
        message: `Modification reverted: ${request.parameter} restored to ${request.reverted_to}`,
      },
    }));

    return true;
  }

  destroy(): void {
    for (const timer of this.modificationTimers.values()) {
      clearTimeout(timer);
    }
    this.modificationTimers.clear();
  }

  private activateModification(requestId: string, sharedState: GateSharedState): void {
    const request = sharedState.pendingModifications.get(requestId);
    if (!request) return;

    const previousValue = this.effectiveValues.get(request.parameter);
    request.reverted_to = previousValue;
    request.status = 'active';
    request.activated_at = new Date().toISOString();

    this.effectiveValues.set(request.parameter, request.requested_value);
    sharedState.pendingModifications.delete(requestId);
    sharedState.activeModifications.set(requestId, request);
    this.modificationTimers.delete(requestId);

    this.propagateEffectiveValues(request.parameter);

    this.onEvent(createSecClawEvent({
      source: 'gate',
      agent_id: this.agentId,
      module: 'signer_health',
      action: 'alert',
      severity: 'info',
      check: 'modification_activated',
      details: {
        expected: previousValue,
        actual: request.requested_value,
        policy_rule: `signer.${request.parameter}`,
        message: `Modification activated: ${request.parameter} changed from ${previousValue} to ${request.requested_value}`,
      },
    }));
  }

  private isLoosening(parameter: string, newValue: number, currentValue: number): boolean {
    if (parameter === 'cooldown_ms') {
      return newValue < currentValue;
    }
    return newValue > currentValue;
  }

  private getDelayForParameter(parameter: string): number {
    const globalDelay = this.immutable.modification_delay_sec;

    if (parameter === 'cumulative_exposure.max_usd' || parameter.startsWith('cumulative_exposure.')) {
      const override = this.signerPolicy.cumulative_exposure.delay_override_sec;
      if (override !== undefined && override > globalDelay) return override;
    }

    return globalDelay;
  }

  private propagateEffectiveValues(changedParameter: string): void {
    if (!this.ctx) return;

    if (changedParameter.startsWith('rate_limits.')) {
      const pm = this.effectiveValues.get('rate_limits.per_minute');
      const ph = this.effectiveValues.get('rate_limits.per_hour');
      const pd = this.effectiveValues.get('rate_limits.per_day');
      if (pm !== undefined && ph !== undefined && pd !== undefined) {
        this.ctx.rateLimiter.updateLimits(pm, ph, pd);
      }
    }

    if (changedParameter === 'cumulative_exposure.max_usd') {
      const maxUsd = this.effectiveValues.get('cumulative_exposure.max_usd');
      if (maxUsd !== undefined) {
        this.ctx.exposureTracker.updateLimits(maxUsd);
      }
    }
  }
}

// ─── Signer Health State (per-agent) ────────────────────────

export interface SignerHealthContext {
  rateLimiter: TokenBucketRateLimiter;
  nonceTracker: NonceTracker;
  exposureTracker: CumulativeExposureTracker;
  cooldownTracker: CooldownTracker;
  accelerationDetector: AccelerationDetector;
  targetSwitchDetector: TargetSwitchDetector;
  modificationManager: SignerModificationManager;
  cachedBalanceEth: number | null;
  balanceCacheUpdatedAt: number;
  walletAddress: string | null;
}

const agentContexts = new Map<string, SignerHealthContext>();

export function getOrCreateSignerContext(
  agentId: string,
  signerPolicy: SignerPolicy,
  onEvent: (event: SecClawEvent) => void,
): SignerHealthContext {
  let ctx = agentContexts.get(agentId);
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
    cachedBalanceEth: null,
    balanceCacheUpdatedAt: 0,
    walletAddress: null,
  };
  ctx.modificationManager.setContext(ctx);
  agentContexts.set(agentId, ctx);
  return ctx;
}

export function resetSignerContexts(): void {
  for (const ctx of agentContexts.values()) {
    ctx.modificationManager.destroy();
  }
  agentContexts.clear();
}

// ─── Balance Refresh (viem) ─────────────────────────────────

let balanceClient: PublicClient | null = null;
let balanceClientNetwork: string | null = null;

function getBalanceClient(network: string): PublicClient {
  if (balanceClient && balanceClientNetwork === network) return balanceClient;
  const chain = network === 'mainnet' ? arbitrum : arbitrumSepolia;
  const rpcUrl = process.env.SECCLAW_RPC_URL;
  balanceClient = createPublicClient({
    chain,
    transport: http(rpcUrl || undefined),
  });
  balanceClientNetwork = network;
  return balanceClient;
}

export async function refreshSignerBalances(network: string): Promise<void> {
  const client = getBalanceClient(network);
  for (const [, ctx] of agentContexts) {
    if (!ctx.walletAddress) continue;
    try {
      const raw = await client.getBalance({ address: ctx.walletAddress as Address });
      ctx.cachedBalanceEth = parseFloat(formatEther(raw));
      ctx.balanceCacheUpdatedAt = Date.now();
    } catch {
      // Non-fatal: balance cache remains stale; check will skip if null
    }
  }
}

// ─── Main Check Function ────────────────────────────────────

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

  // Gas bounds
  checkGasBounds(request, signer, mgr, entries, events);

  // Rate limit
  checkRateLimit(request, ctx, mgr, entries, events);

  // Cooldown
  checkCooldown(request, ctx, signer, mgr, entries, events);

  // Nonce
  checkNonce(request, signer, ctx, entries, events);

  // Balance threshold
  checkBalance(request, signer, ctx, entries, events);

  // Cumulative exposure
  checkExposure(request, ctx, mgr, entries, events);

  // Acceleration detection
  checkAcceleration(request, signer, ctx, entries, events);

  // Target switching
  checkTargetSwitch(request, signer, ctx, entries, events);

  events.push(...collectedEvents);

  const latency = performance.now() - start;
  for (const entry of entries) {
    if (entry.latency_ms === 0) entry.latency_ms = Math.round(latency);
  }

  return { entries, events };
}

// ─── Individual Checks ──────────────────────────────────────

function checkGasBounds(
  request: GateRequest,
  signer: SignerPolicy,
  mgr: SignerModificationManager,
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

  entries.push({ module: 'signer_health', check: 'gas_bounds', result: 'pass', latency_ms: 0 });
}

function checkRateLimit(
  request: GateRequest,
  ctx: SignerHealthContext,
  mgr: SignerModificationManager,
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
  mgr: SignerModificationManager,
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

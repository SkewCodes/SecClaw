import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  TokenBucketRateLimiter,
  NonceTracker,
  CumulativeExposureTracker,
  CooldownTracker,
  AccelerationDetector,
  TargetSwitchDetector,
  SignerModificationManager,
  checkSignerHealth,
  resetSignerContexts,
} from '../src/gate/signer-health.js';
import { createGateSharedState } from '../src/gate/index.js';
import { existsSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  GateRequest,
  PolicyManifest,
  SignerPolicy,
  GateSharedState,
  SecClawEvent,
} from '../src/types.js';

const TEST_NONCE_DIR = './.secclaw-test-nonce';
const TEST_NONCE_PATH = join(TEST_NONCE_DIR, 'nonce-state.json');

function makeSignerPolicy(overrides?: Partial<SignerPolicy>): SignerPolicy {
  return {
    immutable: {
      cumulative_exposure_ceiling_usd: 100000,
      balance_minimum_eth: 0.01,
      nonce_mode: 'strict',
      nonce_persistence_path: TEST_NONCE_PATH,
      rate_limits_ceiling: { per_minute: 50, per_day: 2000 },
      min_cooldown_ms: 100,
      gas_ceiling_gwei: 500,
      gas_limit_ceiling: 1000000,
      modification_delay_sec: 300,
      critical_alert_lock: true,
      max_override_duration_sec: 3600,
      multi_approval_threshold_pct: 50,
      multi_approval_operators: 2,
      ceiling_to_default_max_ratio: 10,
    },
    rate_limits: { per_minute: 10, per_hour: 100, per_day: 500 },
    cooldown_ms: 500,
    cumulative_exposure: { window: '1h', max_window: '4h', max_usd: 50000 },
    gas: { max_price_gwei: 100, max_limit: 500000, price_mode: 'dynamic' },
    acceleration_detection: true,
    target_switch_detection: true,
    agent_overridable: [],
    profiles: {},
    conditional_auto_approvals: [],
    approval: {
      channels: [],
      auto_reject_after_sec: 300,
      require_auth: true,
      auth_method: 'api_key',
    },
    ...overrides,
  };
}

function makeManifest(signer?: SignerPolicy): PolicyManifest {
  return {
    version: '2.0',
    last_updated: '2026-04-01T00:00:00Z',
    updated_by: 'test',
    global: { network: 'testnet', aggregate_exposure_limit_usd: 50000, authorized_wallets: [], known_agent_addresses: [] },
    yieldclaw: { vault_ids: [], hard_limits: { max_drawdown_pct: 5, max_daily_loss_pct: 3, max_leverage: 3, max_position_size_pct: 25, max_concurrent_positions: 1, max_order_frequency_per_min: 10, data_staleness_max_sec: 60 }, withdrawal: { max_per_request_usd: 10000, daily_limit_usd: 50000, cooldown_sec: 300 }, share_price: { max_hourly_change_pct: 5, max_daily_change_pct: 15 }, nav_drift_tolerance_pct: 0.5 },
    payment_layer: { trading: { allowed_symbols: [], max_leverage: 10, max_position_size_usd: 5000, max_open_positions: 3, max_daily_loss_usd: 500, allowed_order_types: ['market', 'limit'], require_approval_above_usd: 2000 }, swaps: { allowed_tokens: ['USDC'], max_swap_amount_usd: 1000, max_slippage_pct: 0.02 }, vaults: { allowed_vault_ids: [], max_deposit_per_tx_usd: 5000, max_withdraw_per_tx_usd: 1000, daily_withdraw_limit_usd: 3000, cooldown_after_deposit_hours: 24 }, spending: { max_per_request_usd: 1, hourly_limit_usd: 10, daily_limit_usd: 50 }, session: { max_ttl_seconds: 86400, max_consecutive_violations: 5 } },
    otterclaw: { skill_hashes: {}, schema_hash: '', validator_hash: '', cli_binary_hash: '', url_allowlist: [] },
    agentic_mm: { risk_presets: {}, safety: { max_drawdown_pct: 5, volatility_pause_multiplier: 3, funding_guard_threshold_pct: 1, cascade_same_side_fills: 5, cascade_window_sec: 3 }, auto_tuner: { warmup_hours: 2, max_changes_per_24h: 3 }, fill_monitor: { max_poll_age_ms: 2000 } },
    growth_agent: { max_playbooks_per_cycle: 2, allowed_playbooks: [], fee_change_max_bps: 2, builder_tier_floor: 'PUBLIC', watchdog_enforcement_enabled: false, max_fee_changes_per_day: 5, max_campaigns_per_day: 3 },
    signer,
  } as PolicyManifest;
}

function makeRequest(overrides?: Partial<GateRequest>): GateRequest {
  return {
    agent_id: 'test-agent',
    action_type: 'sign',
    payload: {
      to: '0x1234567890abcdef1234567890abcdef12345678',
      data: '0xabcdef00',
      value: '100',
      gas_limit: 200000,
      gas_price: '50000000000',
    },
    ...overrides,
  };
}

describe('TokenBucketRateLimiter', () => {
  it('allows requests within rate limits', () => {
    const limiter = new TokenBucketRateLimiter(10, 100, 500);

    for (let i = 0; i < 10; i++) {
      const result = limiter.tryConsume();
      expect(result.allowed).toBe(true);
    }
  });

  it('blocks when per_minute bucket exhausted', () => {
    const limiter = new TokenBucketRateLimiter(3, 100, 500);

    limiter.tryConsume();
    limiter.tryConsume();
    limiter.tryConsume();
    const result = limiter.tryConsume();

    expect(result.allowed).toBe(false);
    expect(result.exhaustedWindow).toBe('per_minute');
  });

  it('reports remaining tokens', () => {
    const limiter = new TokenBucketRateLimiter(10, 100, 500);
    limiter.tryConsume();
    limiter.tryConsume();

    const remaining = limiter.remaining();
    expect(remaining.per_minute).toBeLessThanOrEqual(8);
  });
});

describe('NonceTracker', () => {
  beforeEach(() => {
    if (!existsSync(TEST_NONCE_DIR)) mkdirSync(TEST_NONCE_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_NONCE_DIR)) rmSync(TEST_NONCE_DIR, { recursive: true, force: true });
  });

  it('starts with expected nonce 0', () => {
    const tracker = new NonceTracker(TEST_NONCE_PATH);
    expect(tracker.getExpectedNonce()).toBe(0);
  });

  it('validates correct nonce', () => {
    const tracker = new NonceTracker(TEST_NONCE_PATH);
    const result = tracker.validate(0);
    expect(result.valid).toBe(true);
  });

  it('rejects incorrect nonce', () => {
    const tracker = new NonceTracker(TEST_NONCE_PATH);
    const result = tracker.validate(5);
    expect(result.valid).toBe(false);
    expect(result.expected).toBe(0);
    expect(result.actual).toBe(5);
  });

  it('increments after confirmation and persists to disk', () => {
    const tracker = new NonceTracker(TEST_NONCE_PATH);
    tracker.confirmTransaction(0);
    expect(tracker.getExpectedNonce()).toBe(1);

    expect(existsSync(TEST_NONCE_PATH)).toBe(true);

    const tracker2 = new NonceTracker(TEST_NONCE_PATH);
    expect(tracker2.getExpectedNonce()).toBe(1);
  });

  it('syncs with on-chain nonce when ahead', () => {
    const tracker = new NonceTracker(TEST_NONCE_PATH);
    tracker.syncWithOnChain(10);
    expect(tracker.getExpectedNonce()).toBe(10);
  });

  it('ignores on-chain nonce when behind', () => {
    const tracker = new NonceTracker(TEST_NONCE_PATH);
    tracker.confirmTransaction(0);
    tracker.confirmTransaction(1);
    tracker.confirmTransaction(2);
    tracker.syncWithOnChain(1);
    expect(tracker.getExpectedNonce()).toBe(3);
  });

  it('passes undefined nonce (optional field)', () => {
    const tracker = new NonceTracker(TEST_NONCE_PATH);
    const result = tracker.validate(undefined);
    expect(result.valid).toBe(true);
  });
});

describe('CumulativeExposureTracker', () => {
  it('allows exposure within limits', () => {
    const tracker = new CumulativeExposureTracker('1h', 50000);
    const result = tracker.check(10000);
    expect(result.allowed).toBe(true);
    expect(result.currentUsd).toBe(0);
  });

  it('tracks cumulative exposure', () => {
    const tracker = new CumulativeExposureTracker('1h', 50000);
    tracker.record(20000);
    tracker.record(15000);

    const result = tracker.check(20000);
    expect(result.allowed).toBe(false);
    expect(result.currentUsd).toBe(35000);
  });

  it('blocks when exposure would exceed limit', () => {
    const tracker = new CumulativeExposureTracker('1h', 50000);
    tracker.record(40000);

    const result = tracker.check(15000);
    expect(result.allowed).toBe(false);
  });
});

describe('CooldownTracker', () => {
  it('allows first request', () => {
    const tracker = new CooldownTracker();
    const result = tracker.check(500);
    expect(result.allowed).toBe(true);
  });

  it('blocks during cooldown', () => {
    const tracker = new CooldownTracker();
    tracker.record();
    const result = tracker.check(500);
    expect(result.allowed).toBe(false);
    expect(result.remainingMs).toBeGreaterThan(0);
  });
});

describe('AccelerationDetector', () => {
  it('does not flag with few samples', () => {
    const detector = new AccelerationDetector();
    detector.record();
    const result = detector.detect();
    expect(result.accelerating).toBe(false);
  });
});

describe('TargetSwitchDetector', () => {
  it('does not flag first target', () => {
    const detector = new TargetSwitchDetector();
    const result = detector.check('0xABC', undefined);
    expect(result.newTarget).toBe(false);
  });

  it('flags new target mid-session', () => {
    const detector = new TargetSwitchDetector();
    detector.check('0xABC', undefined);
    const result = detector.check('0xDEF', undefined);
    expect(result.newTarget).toBe(true);
    expect(result.target).toBe('0xDEF');
  });

  it('does not flag repeated target', () => {
    const detector = new TargetSwitchDetector();
    detector.check('0xABC', undefined);
    const result = detector.check('0xABC', undefined);
    expect(result.newTarget).toBe(false);
  });

  it('resets on new session', () => {
    const detector = new TargetSwitchDetector();
    detector.check('0xABC', 'session-1');
    const result = detector.check('0xDEF', 'session-2');
    expect(result.newTarget).toBe(false);
  });
});

describe('SignerModificationManager', () => {
  let events: SecClawEvent[];
  let mgr: SignerModificationManager;
  let sharedState: GateSharedState;
  const signerPolicy = makeSignerPolicy();

  beforeEach(() => {
    events = [];
    sharedState = createGateSharedState();
    mgr = new SignerModificationManager(
      signerPolicy.immutable,
      signerPolicy,
      'test-agent',
      (e) => events.push(e),
    );
  });

  afterEach(() => {
    mgr.destroy();
  });

  it('initializes with manifest default values', () => {
    expect(mgr.getEffectiveValue('rate_limits.per_minute')).toBe(10);
    expect(mgr.getEffectiveValue('gas.max_price_gwei')).toBe(100);
  });

  it('freezes Tier 1 immutable values', () => {
    const immutable = mgr.getImmutable();
    expect(Object.isFrozen(immutable)).toBe(true);
    expect(immutable.cumulative_exposure_ceiling_usd).toBe(100000);
    expect(immutable.modification_delay_sec).toBe(300);
  });

  it('rejects modifications that exceed Tier 1 ceiling', () => {
    const request = mgr.requestModification(
      'rate_limits.per_minute',
      60, // ceiling is 50
      'test',
      'operator',
      sharedState,
    );

    expect(request.status).toBe('rejected');
    expect(events.some((e) => e.check === 'modification_rejected')).toBe(true);
  });

  it('accepts modification within Tier 1 ceiling', () => {
    const request = mgr.requestModification(
      'rate_limits.per_minute',
      25,
      'rebalance needed',
      'operator',
      sharedState,
    );

    expect(request.status).toBe('pending');
    expect(sharedState.pendingModifications.has(request.request_id)).toBe(true);
    expect(events.some((e) => e.check === 'modification_requested')).toBe(true);
  });

  it('blocks loosening during active critical alerts', () => {
    sharedState.activeCriticalAlerts.add('alert-1');

    const request = mgr.requestModification(
      'rate_limits.per_minute',
      25,
      'test',
      'operator',
      sharedState,
    );

    const approved = mgr.approveModification(request.request_id, 'op-1', sharedState);
    expect(approved).toBe(false);
    expect(events.some((e) => e.check === 'modification_locked')).toBe(true);
  });

  it('allows tightening instantly (no delay)', () => {
    const request = mgr.requestModification(
      'rate_limits.per_minute',
      5, // tightening from 10 to 5
      'reduce risk',
      'operator',
      sharedState,
    );

    mgr.approveModification(request.request_id, 'op-1', sharedState);

    expect(mgr.getEffectiveValue('rate_limits.per_minute')).toBe(5);
    expect(sharedState.activeModifications.has(request.request_id)).toBe(true);
    expect(events.some((e) => e.check === 'modification_activated')).toBe(true);
  });

  it('queues loosening with delay', () => {
    const request = mgr.requestModification(
      'rate_limits.per_minute',
      25, // loosening from 10 to 25
      'more headroom',
      'operator',
      sharedState,
    );

    mgr.approveModification(request.request_id, 'op-1', sharedState);

    // Should be queued, not immediately activated
    expect(mgr.getEffectiveValue('rate_limits.per_minute')).toBe(10);
    expect(request.status).toBe('queued');
    expect(events.some((e) => e.check === 'modification_approved')).toBe(true);
  });

  it('cancels pending modification', () => {
    const request = mgr.requestModification(
      'rate_limits.per_minute',
      25,
      'test',
      'operator',
      sharedState,
    );

    const cancelled = mgr.cancelModification(request.request_id, sharedState);
    expect(cancelled).toBe(true);
    expect(request.status).toBe('cancelled');
    expect(sharedState.pendingModifications.has(request.request_id)).toBe(false);
  });

  it('reverts active modification', () => {
    const request = mgr.requestModification(
      'rate_limits.per_minute',
      5,
      'reduce risk',
      'operator',
      sharedState,
    );
    mgr.approveModification(request.request_id, 'op-1', sharedState);
    expect(mgr.getEffectiveValue('rate_limits.per_minute')).toBe(5);

    const reverted = mgr.revertModification(request.request_id, sharedState);
    expect(reverted).toBe(true);
    expect(mgr.getEffectiveValue('rate_limits.per_minute')).toBe(10);
    expect(events.some((e) => e.check === 'modification_reverted')).toBe(true);
  });

  it('validates cooldown_ms against min_cooldown_ms floor', () => {
    const check = mgr.validateAgainstCeiling('cooldown_ms', 50);
    expect(check.valid).toBe(false);
    expect(check.ceiling).toBe(100);

    const checkValid = mgr.validateAgainstCeiling('cooldown_ms', 200);
    expect(checkValid.valid).toBe(true);
  });
});

describe('checkSignerHealth (integrated)', () => {
  beforeEach(() => {
    resetSignerContexts();
    if (!existsSync(TEST_NONCE_DIR)) mkdirSync(TEST_NONCE_DIR, { recursive: true });
  });

  afterEach(() => {
    resetSignerContexts();
    if (existsSync(TEST_NONCE_DIR)) rmSync(TEST_NONCE_DIR, { recursive: true, force: true });
  });

  it('skips all checks when no signer policy is configured', () => {
    const manifest = makeManifest(undefined);
    const sharedState = createGateSharedState();
    const result = checkSignerHealth(makeRequest(), manifest, sharedState);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].result).toBe('skip');
  });

  it('skips for non-sign action types', () => {
    const manifest = makeManifest(makeSignerPolicy());
    const sharedState = createGateSharedState();
    const result = checkSignerHealth(
      makeRequest({ action_type: 'register_tool' }),
      manifest,
      sharedState,
    );

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].result).toBe('skip');
  });

  it('runs all checks for a sign request with signer policy', () => {
    const manifest = makeManifest(makeSignerPolicy());
    const sharedState = createGateSharedState();
    const result = checkSignerHealth(makeRequest(), manifest, sharedState);

    const moduleChecks = result.entries.map((e) => e.check);
    expect(moduleChecks).toContain('gas_bounds');
    expect(moduleChecks).toContain('rate_limit');
    expect(moduleChecks).toContain('cooldown');
    expect(moduleChecks).toContain('nonce');
  });

  it('blocks when gas price exceeds limit', () => {
    const manifest = makeManifest(makeSignerPolicy());
    const sharedState = createGateSharedState();
    const result = checkSignerHealth(
      makeRequest({
        payload: {
          ...makeRequest().payload,
          gas_price: '200000000000', // 200 gwei, limit is 100
        },
      }),
      manifest,
      sharedState,
    );

    const gasCheck = result.entries.find((e) => e.check === 'gas_price');
    expect(gasCheck?.result).toBe('block');
  });

  it('blocks when gas limit exceeds maximum', () => {
    const manifest = makeManifest(makeSignerPolicy());
    const sharedState = createGateSharedState();
    const result = checkSignerHealth(
      makeRequest({
        payload: {
          ...makeRequest().payload,
          gas_limit: 600000, // exceeds 500000
        },
      }),
      manifest,
      sharedState,
    );

    const gasCheck = result.entries.find((e) => e.check === 'gas_limit');
    expect(gasCheck?.result).toBe('block');
  });

  it('detects target switching mid-session', () => {
    const manifest = makeManifest(makeSignerPolicy());
    const sharedState = createGateSharedState();

    checkSignerHealth(
      makeRequest({ payload: { ...makeRequest().payload, to: '0xAAA' } }),
      manifest,
      sharedState,
    );

    const result = checkSignerHealth(
      makeRequest({ payload: { ...makeRequest().payload, to: '0xBBB' } }),
      manifest,
      sharedState,
    );

    const switchEvent = result.events.find((e) => e.check === 'target_switch_detected');
    expect(switchEvent).toBeTruthy();
    expect(switchEvent?.severity).toBe('warning');
  });
});

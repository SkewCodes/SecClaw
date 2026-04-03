import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TokenBucketRateLimiter,
  CumulativeExposureTracker,
  AccelerationDetector,
  SignerModificationManager,
  checkSignerHealth,
  resetSignerContexts,
  getOrCreateSignerContext,
} from '../src/gate/signer-health.js';
import { createGateSharedState } from '../src/gate/index.js';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  GateRequest,
  PolicyManifest,
  SignerPolicy,
  GateSharedState,
  SecClawEvent,
  SignerHealthContext,
} from '../src/types.js';

const TEST_NONCE_DIR = './.secclaw-test-advanced';
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

// ── 1. Rate limiter atomicity ──────────────────────────────────

describe('TokenBucketRateLimiter (atomicity)', () => {
  it('does not leak tokens from coarser windows when a finer window rejects', () => {
    const limiter = new TokenBucketRateLimiter(2, 100, 500);
    limiter.tryConsume();
    limiter.tryConsume();

    const remainBefore = limiter.remaining();
    const perDayBefore = remainBefore.per_day;
    const perHourBefore = remainBefore.per_hour;

    const result = limiter.tryConsume();
    expect(result.allowed).toBe(false);
    expect(result.exhaustedWindow).toBe('per_minute');

    const remainAfter = limiter.remaining();
    expect(remainAfter.per_day).toBe(perDayBefore);
    expect(remainAfter.per_hour).toBe(perHourBefore);
  });

  it('consumes all three windows atomically on success', () => {
    const limiter = new TokenBucketRateLimiter(5, 100, 500);

    const beforeRemain = limiter.remaining();
    const result = limiter.tryConsume();
    expect(result.allowed).toBe(true);

    const afterRemain = limiter.remaining();
    expect(afterRemain.per_minute).toBeLessThan(beforeRemain.per_minute);
    expect(afterRemain.per_hour).toBeLessThan(beforeRemain.per_hour);
    expect(afterRemain.per_day).toBeLessThan(beforeRemain.per_day);
  });

  it('does not leak per_hour tokens when per_day is exhausted', () => {
    const limiter = new TokenBucketRateLimiter(100, 100, 2);

    limiter.tryConsume();
    limiter.tryConsume();

    const remainBefore = limiter.remaining();
    const perHourBefore = remainBefore.per_hour;

    const result = limiter.tryConsume();
    expect(result.allowed).toBe(false);
    expect(result.exhaustedWindow).toBe('per_day');

    const remainAfter = limiter.remaining();
    expect(remainAfter.per_hour).toBe(perHourBefore);
  });
});

// ── 2. Balance enforcement ─────────────────────────────────────

describe('checkSignerHealth (balance enforcement)', () => {
  beforeEach(() => {
    resetSignerContexts();
    if (!existsSync(TEST_NONCE_DIR)) mkdirSync(TEST_NONCE_DIR, { recursive: true });
  });

  afterEach(() => {
    resetSignerContexts();
    if (existsSync(TEST_NONCE_DIR)) rmSync(TEST_NONCE_DIR, { recursive: true, force: true });
  });

  it('blocks when wallet balance is below minimum', () => {
    const policy = makeSignerPolicy();
    const manifest = makeManifest(policy);
    const sharedState = createGateSharedState();
    const events: SecClawEvent[] = [];
    const ctx = getOrCreateSignerContext('balance-test', policy, (e) => events.push(e));

    ctx.cachedBalanceEth = 0.005; // below 0.01 minimum
    ctx.balanceCacheUpdatedAt = Date.now();

    const result = checkSignerHealth(
      makeRequest({ agent_id: 'balance-test' }),
      manifest,
      sharedState,
    );

    const balanceCheck = result.entries.find((e) => e.check === 'balance');
    expect(balanceCheck?.result).toBe('block');

    const blockEvent = result.events.find((e) => e.check === 'balance_below_minimum');
    expect(blockEvent).toBeTruthy();
    expect(blockEvent?.action).toBe('block');
  });

  it('passes when wallet balance is above minimum', () => {
    const policy = makeSignerPolicy();
    const manifest = makeManifest(policy);
    const sharedState = createGateSharedState();
    const events: SecClawEvent[] = [];
    const ctx = getOrCreateSignerContext('balance-ok', policy, (e) => events.push(e));

    ctx.cachedBalanceEth = 1.0; // well above 0.01 minimum
    ctx.balanceCacheUpdatedAt = Date.now();

    const result = checkSignerHealth(
      makeRequest({ agent_id: 'balance-ok' }),
      manifest,
      sharedState,
    );

    const balanceCheck = result.entries.find((e) => e.check === 'balance');
    expect(balanceCheck?.result).toBe('pass');
  });

  it('skips balance check when cachedBalanceEth is null', () => {
    const policy = makeSignerPolicy();
    const manifest = makeManifest(policy);
    const sharedState = createGateSharedState();

    const result = checkSignerHealth(makeRequest(), manifest, sharedState);

    const balanceCheck = result.entries.find((e) => e.check === 'balance');
    expect(balanceCheck?.result).toBe('skip');
  });
});

// ── 3. Exposure window pruning ─────────────────────────────────

describe('CumulativeExposureTracker (pruning)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('evicts expired entries after the window passes', () => {
    const tracker = new CumulativeExposureTracker('1h', 50000);

    tracker.record(30000);
    expect(tracker.currentTotal()).toBe(30000);

    const check1 = tracker.check(25000);
    expect(check1.allowed).toBe(false);

    vi.advanceTimersByTime(3_600_001);

    expect(tracker.currentTotal()).toBe(0);

    const check2 = tracker.check(25000);
    expect(check2.allowed).toBe(true);
  });

  it('keeps entries that are within the window', () => {
    const tracker = new CumulativeExposureTracker('1h', 50000);

    tracker.record(10000);
    vi.advanceTimersByTime(1_800_000); // 30 min
    tracker.record(15000);
    vi.advanceTimersByTime(1_800_001); // another 30 min — first entry is just past 1h

    expect(tracker.currentTotal()).toBe(15000);
  });
});

// ── 4. Acceleration detection trigger ──────────────────────────

describe('AccelerationDetector (trigger)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('detects acceleration with rapid recent activity', () => {
    const detector = new AccelerationDetector();

    // Bucket 0 (oldest, 4–5 min ago): 1 event
    detector.record();
    vi.advanceTimersByTime(120_000); // +2 min

    // Bucket ~2 min ago: 2 events
    detector.record();
    detector.record();
    vi.advanceTimersByTime(120_000); // +2 more min

    // Most recent bucket (last 30s): 10 events — big spike
    for (let i = 0; i < 10; i++) {
      detector.record();
    }

    const result = detector.detect();
    expect(result.accelerating).toBe(true);
    expect(result.gradient).toBeGreaterThan(2);
  });

  it('does not flag stable signing frequency', () => {
    const detector = new AccelerationDetector();

    for (let i = 0; i < 5; i++) {
      detector.record();
      vi.advanceTimersByTime(60_000);
    }

    const result = detector.detect();
    expect(result.accelerating).toBe(false);
  });
});

// ── 5. Tier 2 modification delay with fake timers ──────────────

describe('SignerModificationManager (delayed activation)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('activates queued loosening after delay expires', () => {
    const events: SecClawEvent[] = [];
    const policy = makeSignerPolicy();
    const sharedState = createGateSharedState();
    const mgr = new SignerModificationManager(
      policy.immutable,
      policy,
      'test-agent',
      (e) => events.push(e),
    );

    const request = mgr.requestModification(
      'rate_limits.per_minute',
      25,
      'more headroom',
      'operator',
      sharedState,
    );

    mgr.approveModification(request.request_id, 'op-1', sharedState);
    expect(request.status).toBe('queued');
    expect(mgr.getEffectiveValue('rate_limits.per_minute')).toBe(10);

    vi.advanceTimersByTime(300_000); // 300s delay

    expect(mgr.getEffectiveValue('rate_limits.per_minute')).toBe(25);
    expect(sharedState.activeModifications.has(request.request_id)).toBe(true);
    expect(events.some((e) => e.check === 'modification_activated')).toBe(true);

    mgr.destroy();
  });

  it('reads delay_override_sec from policy for cumulative_exposure', () => {
    const events: SecClawEvent[] = [];
    const policy = makeSignerPolicy({
      cumulative_exposure: { window: '1h', max_window: '4h', max_usd: 50000, delay_override_sec: 600 },
    });
    const sharedState = createGateSharedState();
    const mgr = new SignerModificationManager(
      policy.immutable,
      policy,
      'test-agent',
      (e) => events.push(e),
    );

    const request = mgr.requestModification(
      'cumulative_exposure.max_usd',
      75000, // loosening (below 100k ceiling)
      'need more room',
      'operator',
      sharedState,
    );

    mgr.approveModification(request.request_id, 'op-1', sharedState);
    expect(request.status).toBe('queued');

    // After 300s (global delay), should NOT be activated yet because override is 600s
    vi.advanceTimersByTime(300_000);
    expect(mgr.getEffectiveValue('cumulative_exposure.max_usd')).toBe(50000);

    // After another 300s (total 600s), should be activated
    vi.advanceTimersByTime(300_000);
    expect(mgr.getEffectiveValue('cumulative_exposure.max_usd')).toBe(75000);

    mgr.destroy();
  });
});

// ── 6. Tier 2 rate limit propagation ───────────────────────────

describe('SignerModificationManager (propagation to rate limiter)', () => {
  beforeEach(() => {
    resetSignerContexts();
    if (!existsSync(TEST_NONCE_DIR)) mkdirSync(TEST_NONCE_DIR, { recursive: true });
  });

  afterEach(() => {
    resetSignerContexts();
    if (existsSync(TEST_NONCE_DIR)) rmSync(TEST_NONCE_DIR, { recursive: true, force: true });
  });

  it('propagates tightened rate limits to the actual rate limiter', () => {
    const policy = makeSignerPolicy();
    const events: SecClawEvent[] = [];
    const ctx = getOrCreateSignerContext('prop-test', policy, (e) => events.push(e));
    const sharedState = createGateSharedState();

    const remaining0 = ctx.rateLimiter.remaining();
    expect(remaining0.per_minute).toBe(10);

    const request = ctx.modificationManager.requestModification(
      'rate_limits.per_minute',
      5, // tightening
      'reduce risk',
      'operator',
      sharedState,
    );
    ctx.modificationManager.approveModification(request.request_id, 'op-1', sharedState);

    const remaining1 = ctx.rateLimiter.remaining();
    expect(remaining1.per_minute).toBe(5);
  });

  it('propagates exposure limit changes to the actual tracker', () => {
    const policy = makeSignerPolicy();
    const events: SecClawEvent[] = [];
    const ctx = getOrCreateSignerContext('exp-prop', policy, (e) => events.push(e));
    const sharedState = createGateSharedState();

    ctx.exposureTracker.record(40000);
    const check1 = ctx.exposureTracker.check(15000);
    expect(check1.allowed).toBe(false);

    const request = ctx.modificationManager.requestModification(
      'cumulative_exposure.max_usd',
      30000, // tightening from 50000 to 30000
      'reduce exposure',
      'operator',
      sharedState,
    );
    ctx.modificationManager.approveModification(request.request_id, 'op-1', sharedState);

    const check2 = ctx.exposureTracker.check(1);
    expect(check2.maxUsd).toBe(30000);
  });

  it('restores rate limiter on revert', () => {
    const policy = makeSignerPolicy();
    const events: SecClawEvent[] = [];
    const ctx = getOrCreateSignerContext('revert-test', policy, (e) => events.push(e));
    const sharedState = createGateSharedState();

    const request = ctx.modificationManager.requestModification(
      'rate_limits.per_minute',
      5,
      'reduce',
      'operator',
      sharedState,
    );
    ctx.modificationManager.approveModification(request.request_id, 'op-1', sharedState);
    expect(ctx.rateLimiter.remaining().per_minute).toBe(5);

    ctx.modificationManager.revertModification(request.request_id, sharedState);
    expect(ctx.rateLimiter.remaining().per_minute).toBe(10);
  });
});

// ── 7. value_usd explicit field ────────────────────────────────

describe('checkSignerHealth (value_usd field)', () => {
  beforeEach(() => {
    resetSignerContexts();
    if (!existsSync(TEST_NONCE_DIR)) mkdirSync(TEST_NONCE_DIR, { recursive: true });
  });

  afterEach(() => {
    resetSignerContexts();
    if (existsSync(TEST_NONCE_DIR)) rmSync(TEST_NONCE_DIR, { recursive: true, force: true });
  });

  it('uses value_usd from payload for exposure tracking', () => {
    const policy = makeSignerPolicy();
    const manifest = makeManifest(policy);
    const sharedState = createGateSharedState();

    const result = checkSignerHealth(
      makeRequest({
        payload: {
          ...makeRequest().payload,
          value_usd: 60000, // exceeds 50000 limit
        },
      }),
      manifest,
      sharedState,
    );

    const exposureCheck = result.entries.find((e) => e.check === 'cumulative_exposure');
    expect(exposureCheck?.result).toBe('block');
  });

  it('skips exposure check when value_usd is absent (does not parse value as USD)', () => {
    const policy = makeSignerPolicy();
    const manifest = makeManifest(policy);
    const sharedState = createGateSharedState();

    const result = checkSignerHealth(
      makeRequest({
        payload: {
          to: '0x1234567890abcdef1234567890abcdef12345678',
          data: '0xabcdef00',
          value: '99999', // large ETH value — should NOT be parsed as USD
          gas_limit: 200000,
          gas_price: '50000000000',
        },
      }),
      manifest,
      sharedState,
    );

    const exposureCheck = result.entries.find((e) => e.check === 'cumulative_exposure');
    expect(exposureCheck?.result).toBe('skip');
  });

  it('records exposure and blocks on second request exceeding limit', () => {
    const policy = makeSignerPolicy();
    const manifest = makeManifest(policy);
    const sharedState = createGateSharedState();

    checkSignerHealth(
      makeRequest({
        payload: { ...makeRequest().payload, value_usd: 30000 },
      }),
      manifest,
      sharedState,
    );

    const result = checkSignerHealth(
      makeRequest({
        payload: { ...makeRequest().payload, value_usd: 25000 },
      }),
      manifest,
      sharedState,
    );

    const exposureCheck = result.entries.find((e) => e.check === 'cumulative_exposure');
    expect(exposureCheck?.result).toBe('block');
  });
});

import { describe, it, expect } from 'vitest';
import { runAssertions } from '../src/policy/assertion.js';
import { loadManifest } from '../src/policy/manifest.js';
import { join } from 'node:path';
import type { SystemSnapshot, YieldClawSnapshot, MMSnapshot, GuardianSnapshot, OtterClawSnapshot, GrowthAgentSnapshot } from '../src/types.js';

const manifest = loadManifest(join(import.meta.dirname, 'fixtures/test-manifest.yaml'));

function makeSnapshot(overrides?: {
  yieldclaw?: Partial<YieldClawSnapshot>;
  mm?: Partial<MMSnapshot>;
  guardian?: Partial<GuardianSnapshot>;
  otterclaw?: Partial<OtterClawSnapshot>;
  growthAgent?: Partial<GrowthAgentSnapshot>;
}): SystemSnapshot {
  return {
    timestamp: Date.now(),
    yieldclaw: {
      ok: true,
      latencyMs: 50,
      data: {
        status: {
          vault: { id: 'vault-001', state: 'ACTIVE', nav: 48000, peakNav: 50000, dailyPnl: -200, drawdownPct: 4, startedAt: '', lastCycleAt: null },
          strategy: { name: 'test', version: '1.0.0', symbols: ['PERP_ETH_USDC'] },
          circuitBreaker: { level: 'YELLOW', triggeredAt: null, reason: null, cooldownUntil: null },
          provider: 'guardian',
          running: true,
          uptime: 1000,
        },
        risk: {
          circuitBreaker: { level: 'YELLOW', triggeredAt: null, reason: null, cooldownUntil: null },
          drawdownPct: 4,
          dailyPnl: -200,
          currentNav: 48000,
          peakNav: 50000,
          openPositions: 1,
          totalExposure: 12000,
        },
        positions: [],
        strategy: { name: 'test', version: '1.0.0', description: '', universe: { symbols: ['PERP_ETH_USDC'], maxConcurrentPositions: 1 }, allocation: { maxCapitalPct: 25, maxLeverage: 3, rebalanceIntervalSec: 30 } },
        sharePrice: { vault_id: 'vault-001', share_price: 1.05, total_shares: 45000, nav: 48000, aum: 48000, timestamp: Date.now() },
        guardianPolicy: null,
        ...overrides?.yieldclaw,
      },
    },
    mm: {
      ok: true,
      latencyMs: 100,
      data: {
        balance: { totalCollateral: 25000, freeCollateral: 18000, totalPnl: -300 },
        positions: [],
        safety: null,
        quality: null,
        autoTuner: null,
        riskPreset: null,
        pair: null,
        ...overrides?.mm,
      },
    },
    guardian: {
      ok: true,
      latencyMs: 10,
      data: {
        recentIntents: [],
        spendingPerRequest: 0,
        spendingHourly: 0,
        spendingDaily: 0,
        logFileSize: 1000,
        previousLogFileSize: 1000,
        ...overrides?.guardian,
      },
    },
    otterclaw: {
      ok: true,
      latencyMs: 20,
      data: {
        skills: [],
        ...overrides?.otterclaw,
      },
    },
    growthAgent: {
      ok: true,
      latencyMs: 15,
      data: {
        lastCycleAt: null,
        cycleCount: 0,
        dryRun: true,
        builderTier: 'PUBLIC',
        playbooksExecuted: [],
        watchdogFlags: [],
        feeChanges: [],
        referralCodesCreated: 0,
        campaignsDeployed: 0,
        auditLogSize: 0,
        previousAuditLogSize: 0,
        ...overrides?.growthAgent,
      },
    },
    listing: {
      ok: true,
      latencyMs: 10,
      data: { recentListings: [], recentTrades: [], auditLogSize: 0, previousAuditLogSize: 0 },
    },
  };
}

describe('YieldClaw assertions', () => {
  it('alerts on drawdown exceeding hard limit', () => {
    const snapshot = makeSnapshot({
      yieldclaw: {
        risk: {
          circuitBreaker: { level: 'RED', triggeredAt: Date.now(), reason: 'drawdown', cooldownUntil: null },
          drawdownPct: 6,
          dailyPnl: -3000,
          currentNav: 47000,
          peakNav: 50000,
          openPositions: 1,
          totalExposure: 12000,
        },
        status: {
          vault: { id: 'vault-001', state: 'HALTED', nav: 47000, peakNav: 50000, dailyPnl: -3000, drawdownPct: 6, startedAt: '', lastCycleAt: null },
          strategy: { name: 'test', version: '1.0.0', symbols: ['PERP_ETH_USDC'] },
          circuitBreaker: { level: 'RED', triggeredAt: Date.now(), reason: 'drawdown', cooldownUntil: null },
          provider: 'guardian',
          running: false,
          uptime: 1000,
        },
      },
    });

    const alerts = runAssertions(snapshot, manifest);
    const drawdownAlert = alerts.find((a) => a.check === 'drawdown_exceeded');
    expect(drawdownAlert).toBeDefined();
    expect(drawdownAlert!.severity).toBe('critical');
  });

  it('alerts on approaching drawdown limit', () => {
    const snapshot = makeSnapshot({
      yieldclaw: {
        risk: {
          circuitBreaker: { level: 'ORANGE', triggeredAt: null, reason: null, cooldownUntil: null },
          drawdownPct: 4.2, // 84% of 5 limit, triggers approaching warning
          dailyPnl: -200,
          currentNav: 47900,
          peakNav: 50000,
          openPositions: 1,
          totalExposure: 12000,
        },
        status: {
          vault: { id: 'vault-001', state: 'ACTIVE', nav: 47900, peakNav: 50000, dailyPnl: -200, drawdownPct: 4.2, startedAt: '', lastCycleAt: null },
          strategy: { name: 'test', version: '1.0.0', symbols: ['PERP_ETH_USDC'] },
          circuitBreaker: { level: 'ORANGE', triggeredAt: null, reason: null, cooldownUntil: null },
          provider: 'guardian',
          running: true,
          uptime: 1000,
        },
      },
    });
    const alerts = runAssertions(snapshot, manifest);
    const approaching = alerts.find((a) => a.check === 'drawdown_approaching');
    expect(approaching).toBeDefined();
    expect(approaching!.severity).toBe('warning');
  });

  it('alerts on circuit breaker mismatch', () => {
    const snapshot = makeSnapshot({
      yieldclaw: {
        risk: {
          circuitBreaker: { level: 'GREEN', triggeredAt: null, reason: null, cooldownUntil: null },
          drawdownPct: 4, // Should be YELLOW at 80% of 5
          dailyPnl: -200,
          currentNav: 48000,
          peakNav: 50000,
          openPositions: 1,
          totalExposure: 12000,
        },
      },
    });

    const alerts = runAssertions(snapshot, manifest);
    const cbMismatch = alerts.find((a) => a.check === 'circuit_breaker_mismatch');
    expect(cbMismatch).toBeDefined();
    expect(cbMismatch!.severity).toBe('critical');
  });

  it('alerts on position count exceeding limit', () => {
    const snapshot = makeSnapshot({
      yieldclaw: {
        positions: [
          { symbol: 'PERP_ETH_USDC', position_qty: 1, cost_position: 3000, average_open_price: 3000, unsettled_pnl: 0, mark_price: 3100, est_liq_price: 2500, leverage: 3, timestamp: Date.now() },
          { symbol: 'PERP_BTC_USDC', position_qty: 0.1, cost_position: 6000, average_open_price: 60000, unsettled_pnl: 0, mark_price: 61000, est_liq_price: 50000, leverage: 3, timestamp: Date.now() },
        ],
      },
    });

    const alerts = runAssertions(snapshot, manifest);
    const posCount = alerts.find((a) => a.check === 'position_count_exceeded');
    expect(posCount).toBeDefined();
    expect(posCount!.severity).toBe('high');
  });

  it('alerts on leverage exceeding hard limit', () => {
    const snapshot = makeSnapshot({
      yieldclaw: {
        strategy: {
          name: 'test', version: '1.0.0', description: '',
          universe: { symbols: ['PERP_ETH_USDC'], maxConcurrentPositions: 1 },
          allocation: { maxCapitalPct: 25, maxLeverage: 5, rebalanceIntervalSec: 30 },
        },
      },
    });

    const alerts = runAssertions(snapshot, manifest);
    const leverage = alerts.find((a) => a.check === 'leverage_exceeded');
    expect(leverage).toBeDefined();
  });

  it('no alerts when all within bounds', () => {
    const snapshot = makeSnapshot({
      yieldclaw: {
        risk: {
          circuitBreaker: { level: 'GREEN', triggeredAt: null, reason: null, cooldownUntil: null },
          drawdownPct: 1,
          dailyPnl: -50,
          currentNav: 49500,
          peakNav: 50000,
          openPositions: 0,
          totalExposure: 0,
        },
        status: {
          vault: { id: 'vault-001', state: 'ACTIVE', nav: 49500, peakNav: 50000, dailyPnl: -50, drawdownPct: 1, startedAt: '', lastCycleAt: null },
          strategy: { name: 'test', version: '1.0.0', symbols: ['PERP_ETH_USDC'] },
          circuitBreaker: { level: 'GREEN', triggeredAt: null, reason: null, cooldownUntil: null },
          provider: 'guardian',
          running: true,
          uptime: 1000,
        },
        positions: [],
        strategy: { name: 'test', version: '1.0.0', description: '', universe: { symbols: ['PERP_ETH_USDC'], maxConcurrentPositions: 1 }, allocation: { maxCapitalPct: 25, maxLeverage: 3, rebalanceIntervalSec: 30 } },
        sharePrice: null,
      },
    });

    const alerts = runAssertions(snapshot, manifest);
    const ycAlerts = alerts.filter((a) => a.source === 'yieldclaw');
    expect(ycAlerts).toHaveLength(0);
  });
});

describe('Guardian assertions', () => {
  it('alerts on approved intent with violations', () => {
    const snapshot = makeSnapshot({
      guardian: {
        recentIntents: [{
          intentId: 'int-bad',
          action: 'place_order',
          status: 'executed',
          tier: 'session',
          policyResult: 'approved',
          policyViolations: ['leverage_exceeded'],
        }],
      },
    });

    const alerts = runAssertions(snapshot, manifest);
    const violation = alerts.find((a) => a.check === 'approved_with_violations');
    expect(violation).toBeDefined();
    expect(violation!.severity).toBe('critical');
  });

  it('alerts on audit log truncation', () => {
    const snapshot = makeSnapshot({
      guardian: {
        logFileSize: 500,
        previousLogFileSize: 1000,
      },
    });

    const alerts = runAssertions(snapshot, manifest);
    const truncated = alerts.find((a) => a.check === 'audit_log_truncated');
    expect(truncated).toBeDefined();
    expect(truncated!.severity).toBe('critical');
  });
});

describe('OtterClaw assertions', () => {
  it('alerts on skill hash mismatch', () => {
    const snapshot = makeSnapshot({
      otterclaw: {
        skills: [{
          path: '/skills/orderly-trader/SKILL.md',
          relativePath: 'orderly-trader/SKILL.md',
          hash: 'different_hash',
          frontmatter: { name: 'orderly-trader' },
          modifiedAt: Date.now(),
        }],
      },
    });

    const alerts = runAssertions(snapshot, manifest);
    const hashMismatch = alerts.find((a) => a.check === 'skill_hash_mismatch');
    expect(hashMismatch).toBeDefined();
    expect(hashMismatch!.severity).toBe('critical');
  });
});

describe('Growth Agent assertions', () => {
  it('alerts on excessive playbooks per cycle', () => {
    const snapshot = makeSnapshot({
      growthAgent: {
        playbooksExecuted: [
          { playbook: 'TIER_PUSH', cycle: 1, timestamp: Date.now(), actions: ['fee_cut'], dryRun: false },
          { playbook: 'VOLUME_RECOVERY', cycle: 1, timestamp: Date.now(), actions: ['comeback_code'], dryRun: false },
          { playbook: 'FEE_OPTIMIZATION', cycle: 1, timestamp: Date.now(), actions: ['retier'], dryRun: false },
        ],
      },
    });

    const alerts = runAssertions(snapshot, manifest);
    const pbAlert = alerts.find((a) => a.check === 'playbooks_per_cycle_exceeded');
    expect(pbAlert).toBeDefined();
    expect(pbAlert!.severity).toBe('high');
  });

  it('alerts on disallowed playbook', () => {
    const snapshot = makeSnapshot({
      growthAgent: {
        playbooksExecuted: [
          { playbook: 'UNKNOWN_PLAYBOOK', cycle: 1, timestamp: Date.now(), actions: [], dryRun: false },
        ],
      },
    });

    const alerts = runAssertions(snapshot, manifest);
    const disallowed = alerts.find((a) => a.check === 'disallowed_playbook');
    expect(disallowed).toBeDefined();
    expect(disallowed!.severity).toBe('critical');
  });

  it('alerts on excessive fee change', () => {
    const snapshot = makeSnapshot({
      growthAgent: {
        feeChanges: [
          { symbol: 'PERP_ETH_USDC', oldBps: 5, newBps: 1, timestamp: Date.now() },
        ],
      },
    });

    const alerts = runAssertions(snapshot, manifest);
    const feeAlert = alerts.find((a) => a.check === 'fee_change_excessive');
    expect(feeAlert).toBeDefined();
    expect(feeAlert!.severity).toBe('critical');
  });

  it('alerts on watchdog enforcement when disabled in manifest', () => {
    const snapshot = makeSnapshot({
      growthAgent: {
        watchdogFlags: [
          { accountId: '0xabc', detector: 'wash_trading', riskScore: 75, tier: 'PENALIZE', enforcementAction: 'fee_reverted', timestamp: Date.now() },
        ],
      },
    });

    const alerts = runAssertions(snapshot, manifest);
    const enforcement = alerts.find((a) => a.check === 'watchdog_enforcement_unexpected');
    expect(enforcement).toBeDefined();
    expect(enforcement!.severity).toBe('critical');
  });

  it('alerts on ESCALATE watchdog flags', () => {
    const snapshot = makeSnapshot({
      growthAgent: {
        watchdogFlags: [
          { accountId: '0xesc', detector: 'sybil', riskScore: 90, tier: 'ESCALATE', timestamp: Date.now() },
        ],
      },
    });

    const alerts = runAssertions(snapshot, manifest);
    const escalation = alerts.find((a) => a.check === 'watchdog_escalation');
    expect(escalation).toBeDefined();
    expect(escalation!.severity).toBe('critical');
  });

  it('no alerts when growth agent is idle in dry-run', () => {
    const snapshot = makeSnapshot();
    const alerts = runAssertions(snapshot, manifest);
    const gaAlerts = alerts.filter((a) => a.source === 'growth_agent');
    expect(gaAlerts).toHaveLength(0);
  });
});

describe('Guardian swap/vault assertions', () => {
  it('alerts on swap amount exceeding limit', () => {
    const snapshot = makeSnapshot({
      guardian: {
        recentIntents: [{
          intentId: 'swap-1',
          action: 'swap_tokens',
          status: 'executed',
          tier: 'wallet',
          policyResult: 'approved',
          policyViolations: [],
          receipt: { orderPrice: 3000, orderQuantity: 1, executedAt: Date.now() },
        }],
      },
    });

    const alerts = runAssertions(snapshot, manifest);
    const swapAlert = alerts.find((a) => a.check === 'swap_amount_exceeded');
    expect(swapAlert).toBeDefined();
    expect(swapAlert!.severity).toBe('high');
  });

  it('alerts on vault withdrawal exceeding per-tx limit', () => {
    const snapshot = makeSnapshot({
      guardian: {
        recentIntents: [{
          intentId: 'vw-1',
          action: 'vault_withdraw',
          status: 'executed',
          tier: 'elevated',
          policyResult: 'approved',
          policyViolations: [],
          receipt: { orderPrice: 1, orderQuantity: 2000, executedAt: Date.now() },
        }],
      },
    });

    const alerts = runAssertions(snapshot, manifest);
    const vwAlert = alerts.find((a) => a.check === 'vault_withdraw_exceeded');
    expect(vwAlert).toBeDefined();
  });

  it('alerts on large order at session tier', () => {
    const snapshot = makeSnapshot({
      guardian: {
        recentIntents: [{
          intentId: 'big-order-1',
          action: 'place_order',
          status: 'executed',
          tier: 'session',
          policyResult: 'approved',
          policyViolations: [],
          receipt: { orderId: 1, orderPrice: 3000, orderQuantity: 1, orderStatus: 'FILLED', executedAt: Date.now() },
        }],
      },
    });

    const alerts = runAssertions(snapshot, manifest);
    const orderAlert = alerts.find((a) => a.check === 'large_order_session_tier');
    expect(orderAlert).toBeDefined();
  });
});

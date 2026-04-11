import { describe, it, expect } from 'vitest';
import { checkAggregateExposure } from '../src/audit/rules/aggregate-exposure.js';
import { checkSymbolConflict } from '../src/audit/rules/symbol-conflict.js';
import { checkCorrelatedStress } from '../src/audit/rules/correlated-stress.js';
import { checkDirectionalCoherence } from '../src/audit/rules/directional-coherence.js';
import { loadManifest } from '../src/policy/manifest.js';
import { join } from 'node:path';
import type { SystemSnapshot } from '../src/types.js';

const manifest = loadManifest(join(import.meta.dirname, 'fixtures/test-manifest.yaml'));

function baseSnapshot(): SystemSnapshot {
  return {
    timestamp: Date.now(),
    yieldclaw: {
      ok: true, latencyMs: 50,
      data: {
        status: null,
        risk: { circuitBreaker: { level: 'GREEN', triggeredAt: null, reason: null, cooldownUntil: null }, drawdownPct: 1, dailyPnl: -50, currentNav: 49500, peakNav: 50000, openPositions: 1, totalExposure: 15000 },
        positions: [{ symbol: 'PERP_ETH_USDC', position_qty: 5, cost_position: 15000, average_open_price: 3000, unsettled_pnl: 200, mark_price: 3040, est_liq_price: 2500, leverage: 3, timestamp: Date.now() }],
        strategy: null,
        sharePrice: null,
        guardianPolicy: null,
      },
    },
    mm: {
      ok: true, latencyMs: 100,
      data: {
        balance: { totalCollateral: 25000, freeCollateral: 18000, totalPnl: -300 },
        positions: [{ symbol: 'PERP_ETH_USDC', size: -2, avgEntryPrice: 3100, unrealisedPnl: -80, markPrice: 3040 }],
        safety: null, quality: null, autoTuner: null, riskPreset: null, pair: null,
      },
    },
    guardian: {
      ok: true, latencyMs: 10,
      data: {
        recentIntents: [{ intentId: 'int-1', action: 'place_order', status: 'executed', tier: 'session', policyResult: 'approved', policyViolations: [], receipt: { orderId: 1, orderPrice: 3000, orderQuantity: 1, orderStatus: 'FILLED', executedAt: Date.now() } }],
        spendingPerRequest: 0, spendingHourly: 0, spendingDaily: 0, logFileSize: 1000, previousLogFileSize: 1000,
      },
    },
    otterclaw: { ok: true, latencyMs: 20, data: { skills: [] } },
    growthAgent: {
      ok: true, latencyMs: 15,
      data: {
        lastCycleAt: null, cycleCount: 0, dryRun: true, builderTier: 'PUBLIC',
        playbooksExecuted: [], watchdogFlags: [], feeChanges: [],
        referralCodesCreated: 0, campaignsDeployed: 0, auditLogSize: 0, previousAuditLogSize: 0,
      },
    },
    listing: { ok: true, latencyMs: 10, data: { recentListings: [], recentTrades: [], auditLogSize: 0, previousAuditLogSize: 0 } },
  };
}

describe('aggregate exposure', () => {
  it('alerts when total exposure exceeds limit', () => {
    const snapshot = baseSnapshot();
    // YC: 15000, MM: 2*3040 = 6080, Guardian: 1*3000 = 3000 => ~24080 (under 50k)
    // Increase YC exposure to push over
    snapshot.yieldclaw.data!.risk!.totalExposure = 40000;
    const mmPos = snapshot.mm.data!.positions[0];
    mmPos.size = -5;
    // MM: 5*3040 = 15200, Guardian: 3000, Total: 40000+15200+3000 = 58200

    const alerts = checkAggregateExposure(snapshot, manifest);
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0].severity).toBe('critical');
  });

  it('warns when approaching limit', () => {
    const snapshot = baseSnapshot();
    snapshot.yieldclaw.data!.risk!.totalExposure = 35000;
    // MM: 2*3040 = 6080, Guardian: 3000 => 44080 = 88% of 50k

    const alerts = checkAggregateExposure(snapshot, manifest);
    const warning = alerts.find((a) => a.severity === 'warning');
    expect(warning).toBeDefined();
  });

  it('no alert when well under limit', () => {
    const snapshot = baseSnapshot();
    snapshot.yieldclaw.data!.risk!.totalExposure = 5000;

    const alerts = checkAggregateExposure(snapshot, manifest);
    expect(alerts).toHaveLength(0);
  });
});

describe('symbol conflict', () => {
  it('detects vault long vs MM short on same symbol', () => {
    const snapshot = baseSnapshot();
    // YC: long ETH (position_qty > 0), MM: short ETH (size < 0)
    const alerts = checkSymbolConflict(snapshot);
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0].check).toBe('symbol_conflict');
  });

  it('no conflict when same direction', () => {
    const snapshot = baseSnapshot();
    snapshot.mm.data!.positions[0].size = 2; // both long
    const alerts = checkSymbolConflict(snapshot);
    expect(alerts).toHaveLength(0);
  });
});

describe('correlated stress', () => {
  it('detects both systems under stress', () => {
    const snapshot = baseSnapshot();
    snapshot.yieldclaw.data!.risk!.circuitBreaker.level = 'ORANGE';
    snapshot.mm.data!.balance!.totalPnl = -2000; // 8% loss on 25k capital

    const alerts = checkCorrelatedStress(snapshot);
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0].severity).toBe('critical');
  });

  it('no alert when only one system stressed', () => {
    const snapshot = baseSnapshot();
    snapshot.yieldclaw.data!.risk!.circuitBreaker.level = 'ORANGE';
    // MM PnL is fine (-300/25000 = 1.2%)

    const alerts = checkCorrelatedStress(snapshot);
    expect(alerts).toHaveLength(0);
  });
});

describe('directional coherence', () => {
  it('detects same-direction amplification', () => {
    const snapshot = baseSnapshot();
    // Make MM also long
    snapshot.mm.data!.positions[0].size = 2;

    const alerts = checkDirectionalCoherence(snapshot);
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0].check).toBe('directional_coherence');
  });

  it('no alert when opposite directions', () => {
    const snapshot = baseSnapshot();
    // YC long, MM short — this is expected hedging
    const alerts = checkDirectionalCoherence(snapshot);
    expect(alerts).toHaveLength(0);
  });
});

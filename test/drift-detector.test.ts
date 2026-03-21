import { describe, it, expect } from 'vitest';
import { DriftDetector } from '../src/policy/drift-detector.js';
import { loadManifest } from '../src/policy/manifest.js';
import { join } from 'node:path';
import type { SystemSnapshot } from '../src/types.js';

const manifest = loadManifest(join(import.meta.dirname, 'fixtures/test-manifest.yaml'));

function makeSnap(overrides?: {
  sharePrice?: number;
  cbLevel?: string;
  drawdownPct?: number;
  timestamp?: number;
}): SystemSnapshot {
  return {
    timestamp: overrides?.timestamp ?? Date.now(),
    yieldclaw: {
      ok: true, latencyMs: 50,
      data: {
        status: null,
        risk: {
          circuitBreaker: { level: (overrides?.cbLevel ?? 'GREEN') as 'GREEN', triggeredAt: null, reason: null, cooldownUntil: null },
          drawdownPct: overrides?.drawdownPct ?? 1,
          dailyPnl: -50,
          currentNav: 49500,
          peakNav: 50000,
          openPositions: 0,
          totalExposure: 0,
        },
        positions: [],
        strategy: null,
        sharePrice: overrides?.sharePrice !== undefined ? {
          vault_id: 'v1', share_price: overrides.sharePrice, total_shares: 1000, nav: 50000, aum: 50000, timestamp: Date.now(),
        } : null,
        guardianPolicy: null,
      },
    },
    mm: { ok: true, latencyMs: 50, data: { balance: null, positions: [], safety: null, quality: null, autoTuner: null, riskPreset: null, pair: null } },
    guardian: { ok: true, latencyMs: 10, data: { recentIntents: [], spendingPerRequest: 0, spendingHourly: 0, spendingDaily: 0, logFileSize: 0, previousLogFileSize: 0 } },
    otterclaw: { ok: true, latencyMs: 10, data: { skills: [] } },
    growthAgent: { ok: true, latencyMs: 10, data: { lastCycleAt: null, cycleCount: 0, dryRun: true, builderTier: 'PUBLIC', playbooksExecuted: [], watchdogFlags: [], feeChanges: [], referralCodesCreated: 0, campaignsDeployed: 0, auditLogSize: 0, previousAuditLogSize: 0 } },
  };
}

describe('DriftDetector', () => {
  it('detects share price rate of change exceeding limit', () => {
    const detector = new DriftDetector();
    const now = Date.now();

    // Record two points 10 minutes apart with 10% change (=> 60%/hr extrapolated)
    const snap1 = makeSnap({ sharePrice: 1.00, timestamp: now - 600_000 });
    const snap2 = makeSnap({ sharePrice: 1.10, timestamp: now });

    detector.record(snap1);
    detector.record(snap2);

    const alerts = detector.detect(manifest);
    const rateAlert = alerts.find((a) => a.check === 'share_price_rate');
    expect(rateAlert).toBeDefined();
    expect(rateAlert!.severity).toBe('critical');
  });

  it('no alert on stable share price', () => {
    const detector = new DriftDetector();
    const now = Date.now();

    const snap1 = makeSnap({ sharePrice: 1.00, timestamp: now - 600_000 });
    const snap2 = makeSnap({ sharePrice: 1.001, timestamp: now });

    detector.record(snap1);
    detector.record(snap2);

    const alerts = detector.detect(manifest);
    expect(alerts.filter((a) => a.check === 'share_price_rate')).toHaveLength(0);
  });

  it('detects circuit breaker flapping', () => {
    const detector = new DriftDetector();

    const levels = ['GREEN', 'YELLOW', 'GREEN', 'YELLOW', 'ORANGE'];
    for (const level of levels) {
      const snap = makeSnap({ cbLevel: level });
      detector.record(snap);
    }

    const alerts = detector.detect(manifest);
    const flapping = alerts.find((a) => a.check === 'circuit_breaker_flapping');
    expect(flapping).toBeDefined();
    expect(flapping!.severity).toBe('high');
  });

  it('detects drawdown trending toward limit', () => {
    const detector = new DriftDetector();

    // Steadily increasing drawdown approaching 5% limit
    for (const dd of [3.0, 3.5, 4.0, 4.1, 4.2]) {
      detector.record(makeSnap({ drawdownPct: dd }));
    }

    const alerts = detector.detect(manifest);
    const trending = alerts.find((a) => a.check === 'drawdown_trending');
    expect(trending).toBeDefined();
    expect(trending!.severity).toBe('warning');
  });

  it('no drawdown trending alert when flat', () => {
    const detector = new DriftDetector();

    for (const dd of [2.0, 2.0, 2.0, 2.0, 2.0]) {
      detector.record(makeSnap({ drawdownPct: dd }));
    }

    const alerts = detector.detect(manifest);
    expect(alerts.filter((a) => a.check === 'drawdown_trending')).toHaveLength(0);
  });

  it('needs at least 2 snapshots to produce alerts', () => {
    const detector = new DriftDetector();
    detector.record(makeSnap());
    const alerts = detector.detect(manifest);
    expect(alerts).toHaveLength(0);
  });
});

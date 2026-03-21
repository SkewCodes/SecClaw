import { describe, it, expect } from 'vitest';
import { verifyOnChainState } from '../src/integrity/onchain-verifier.js';
import { loadManifest } from '../src/policy/manifest.js';
import { join } from 'node:path';
import type { SystemSnapshot, YieldClawSnapshot, GuardianPolicy } from '../src/types.js';

const manifest = loadManifest(join(import.meta.dirname, 'fixtures/test-manifest.yaml'));

function makeSnapshot(overrides?: Partial<YieldClawSnapshot>): SystemSnapshot {
  return {
    timestamp: Date.now(),
    yieldclaw: {
      ok: true, latencyMs: 50,
      data: {
        status: null,
        risk: null,
        positions: [],
        strategy: null,
        sharePrice: { vault_id: 'v1', share_price: 1.0, total_shares: 10000, nav: 10000, aum: 10000, timestamp: Date.now() },
        guardianPolicy: null,
        ...overrides,
      },
    },
    mm: { ok: true, latencyMs: 50, data: { balance: null, positions: [], safety: null, quality: null, autoTuner: null, riskPreset: null, pair: null } },
    guardian: { ok: true, latencyMs: 10, data: { recentIntents: [], spendingPerRequest: 0, spendingHourly: 0, spendingDaily: 0, logFileSize: 0, previousLogFileSize: 0 } },
    otterclaw: { ok: true, latencyMs: 20, data: { skills: [] } },
    growthAgent: { ok: true, latencyMs: 15, data: { lastCycleAt: null, cycleCount: 0, dryRun: true, builderTier: 'PUBLIC', playbooksExecuted: [], watchdogFlags: [], feeChanges: [], referralCodesCreated: 0, campaignsDeployed: 0, auditLogSize: 0, previousAuditLogSize: 0 } },
  };
}

describe('On-chain verifier (self-consistency checks)', () => {
  it('no alerts for consistent share price data', async () => {
    const snap = makeSnapshot({
      sharePrice: { vault_id: 'v1', share_price: 1.0, total_shares: 10000, nav: 10000, aum: 10000, timestamp: Date.now() },
    });
    const alerts = await verifyOnChainState(snap, manifest);
    expect(alerts).toHaveLength(0);
  });

  it('alerts on share price / AUM inconsistency', async () => {
    const snap = makeSnapshot({
      sharePrice: { vault_id: 'v1', share_price: 1.2, total_shares: 10000, nav: 10000, aum: 10000, timestamp: Date.now() },
    });
    // aum/shares = 1.0, but reported = 1.2 → 20% drift
    const alerts = await verifyOnChainState(snap, manifest);
    const inconsistency = alerts.find((a) => a.check === 'share_price_internal_inconsistency');
    expect(inconsistency).toBeDefined();
    expect(inconsistency!.severity).toBe('critical');
  });

  it('alerts on NAV vs AUM divergence', async () => {
    const snap = makeSnapshot({
      sharePrice: { vault_id: 'v1', share_price: 1.0, total_shares: 10000, nav: 10600, aum: 10000, timestamp: Date.now() },
    });
    const alerts = await verifyOnChainState(snap, manifest);
    const divergence = alerts.find((a) => a.check === 'nav_aum_divergence');
    expect(divergence).toBeDefined();
  });

  it('no NAV/AUM alert when divergence is small', async () => {
    const snap = makeSnapshot({
      sharePrice: { vault_id: 'v1', share_price: 1.0, total_shares: 10000, nav: 10050, aum: 10000, timestamp: Date.now() },
    });
    const alerts = await verifyOnChainState(snap, manifest);
    const divergence = alerts.find((a) => a.check === 'nav_aum_divergence');
    expect(divergence).toBeUndefined();
  });

  it('alerts when guardian leverage is more permissive than manifest', async () => {
    const gp: GuardianPolicy = {
      trading: { allowedSymbols: ['PERP_ETH_USDC'], maxLeverage: 20, maxPositionSizeUSD: 5000, maxOpenPositions: 3, maxDailyLossUSD: 500, allowedOrderTypes: ['market', 'limit'] },
      vaults: { allowedVaultIds: [], maxDepositPerTxUSD: 5000, maxWithdrawPerTxUSD: 1000, dailyWithdrawLimitUSD: 3000, cooldownAfterDepositHours: 24 },
      spending: { maxPerRequestUSD: 1, hourlyLimitUSD: 10, dailyLimitUSD: 50 },
      session: { maxTTLSeconds: 86400, autoRevokeOnPolicyViolation: true, maxConsecutiveViolations: 5 },
    };
    const snap = makeSnapshot({ guardianPolicy: gp, sharePrice: null });
    const alerts = await verifyOnChainState(snap, manifest);
    const leverageAlert = alerts.find((a) => a.check === 'guardian_leverage_permissive');
    expect(leverageAlert).toBeDefined();
  });

  it('alerts when guardian allows symbol not in manifest', async () => {
    const gp: GuardianPolicy = {
      trading: { allowedSymbols: ['PERP_ETH_USDC', 'PERP_DOGE_USDC'], maxLeverage: 5, maxPositionSizeUSD: 5000, maxOpenPositions: 3, maxDailyLossUSD: 500, allowedOrderTypes: ['market'] },
      vaults: { allowedVaultIds: [], maxDepositPerTxUSD: 5000, maxWithdrawPerTxUSD: 1000, dailyWithdrawLimitUSD: 3000, cooldownAfterDepositHours: 24 },
      spending: { maxPerRequestUSD: 1, hourlyLimitUSD: 10, dailyLimitUSD: 50 },
      session: { maxTTLSeconds: 86400, autoRevokeOnPolicyViolation: true, maxConsecutiveViolations: 5 },
    };
    const snap = makeSnapshot({ guardianPolicy: gp, sharePrice: null });
    const alerts = await verifyOnChainState(snap, manifest);
    const symbolAlert = alerts.find((a) => a.check === 'guardian_symbol_not_in_manifest');
    expect(symbolAlert).toBeDefined();
    expect(symbolAlert!.data!['symbol']).toBe('PERP_DOGE_USDC');
  });
});

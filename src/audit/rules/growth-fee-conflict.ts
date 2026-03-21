import { createAlert } from '../../alerts/bus.js';
import type { Alert, SystemSnapshot, PolicyManifest } from '../../types.js';

export function checkGrowthFeeConflict(snapshot: SystemSnapshot, manifest: PolicyManifest): Alert[] {
  const alerts: Alert[] = [];

  const ga = snapshot.growthAgent;
  const mm = snapshot.mm;

  if (!ga.ok || !ga.data || !mm.ok || !mm.data) return alerts;

  // Fee cuts combined with tight MM spreads = margin compression risk
  const recentFeeCuts = ga.data.feeChanges.filter((fc) => fc.newBps < fc.oldBps);

  if (recentFeeCuts.length > 0 && mm.data.positions.length > 0) {
    const presets = manifest.agentic_mm.risk_presets;
    const tightest = Math.min(
      ...Object.values(presets).map((p) => p.spread_bps),
    );

    for (const fc of recentFeeCuts) {
      if (fc.newBps <= tightest) {
        alerts.push(createAlert('cross_system', 'fee_spread_margin_compression', 'warning',
          `Growth agent cut fees to ${fc.newBps} bps on ${fc.symbol} while MM spread is ${tightest} bps — margin compression risk`,
          { symbol: fc.symbol, newFeeBps: fc.newBps, mmSpreadBps: tightest },
        ));
      }
    }
  }

  // Growth agent deploying campaigns while system is under stress
  if (ga.data.campaignsDeployed > 0 && snapshot.yieldclaw.ok && snapshot.yieldclaw.data?.risk) {
    const cbLevel = snapshot.yieldclaw.data.risk.circuitBreaker.level;
    if (cbLevel === 'ORANGE' || cbLevel === 'RED') {
      alerts.push(createAlert('cross_system', 'campaign_during_stress', 'high',
        `Growth agent deployed ${ga.data.campaignsDeployed} campaign(s) while YieldClaw circuit breaker is ${cbLevel}`,
        { campaigns: ga.data.campaignsDeployed, cbLevel },
      ));
    }
  }

  // Watchdog flagging accounts that also appear as active traders
  if (ga.data.watchdogFlags.length > 0 && snapshot.guardian.ok && snapshot.guardian.data) {
    const flaggedAccounts = new Set(ga.data.watchdogFlags
      .filter((f) => f.tier !== 'CLEAN')
      .map((f) => f.accountId));

    const activeTraders = new Set<string>();
    for (const intent of snapshot.guardian.data.recentIntents) {
      if (intent.status === 'executed') {
        const addrMatch = intent.intentId.match(/^(0x[a-f0-9]+)/i);
        if (addrMatch) activeTraders.add(addrMatch[1]);
      }
    }

    const overlap = [...flaggedAccounts].filter((a) => activeTraders.has(a));
    if (overlap.length > 0) {
      alerts.push(createAlert('cross_system', 'flagged_accounts_still_trading', 'high',
        `${overlap.length} watchdog-flagged account(s) still actively trading via Guardian`,
        { accounts: overlap },
      ));
    }
  }

  return alerts;
}

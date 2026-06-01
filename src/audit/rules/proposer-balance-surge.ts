import { createAlert } from '../../alerts/bus.js';
import type { Alert, SystemSnapshot, PolicyManifest } from '../../types.js';

/**
 * Flag proposers whose builder-token balance grew significantly in the 24h
 * before propose() — flash-loan or buy-vote-sell signal. Proposer balance
 * pre-snapshot is captured by the gate module's bookkeeping; absent that,
 * this rule degrades silently (no false positives).
 */
export function checkProposerBalanceSurge(
  snapshot: SystemSnapshot,
  manifest: PolicyManifest,
): Alert[] {
  const alerts: Alert[] = [];
  if (!snapshot.governance?.ok || !snapshot.governance.data) return alerts;
  const policy = manifest.governance;
  if (!policy?.enabled) return alerts;
  const surgePctThreshold = policy.proposal_heuristics.proposer_balance_surge_pct;

  for (const p of snapshot.governance.data.recentProposals) {
    const before = BigInt(p.proposerBalanceBefore || '0');
    const atPropose = BigInt(p.proposerBalanceAtPropose || '0');
    if (before === 0n || atPropose === 0n) continue; // unknown — skip
    if (atPropose <= before) continue;
    const growthBps = Number(((atPropose - before) * 10_000n) / before);
    const growthPct = growthBps / 100;
    if (growthPct < surgePctThreshold) continue;
    alerts.push(createAlert(
      'governance',
      'proposer_balance_surge',
      'critical',
      `Proposer ${p.proposer.slice(0, 10)} balance grew ${growthPct.toFixed(1)}% in 24h pre-propose (threshold ${surgePctThreshold}%)`,
      {
        governor: p.governor,
        proposalId: p.proposalId,
        proposer: p.proposer,
        balanceBefore: p.proposerBalanceBefore,
        balanceAtPropose: p.proposerBalanceAtPropose,
        growthPct,
      },
    ));
  }
  return alerts;
}

import { createAlert } from '../../alerts/bus.js';
import type { Alert, SystemSnapshot, PolicyManifest } from '../../types.js';

/**
 * Flag proposals where a single voter contributes a dominant share of
 * forVotes — capture or coordinated attack signal.
 */
export function checkProposalWhaleDominance(
  snapshot: SystemSnapshot,
  manifest: PolicyManifest,
): Alert[] {
  const alerts: Alert[] = [];
  if (!snapshot.governance?.ok || !snapshot.governance.data) return alerts;
  const policy = manifest.governance;
  if (!policy?.enabled) return alerts;
  const threshold = policy.proposal_heuristics.whale_dominance_threshold_bps;

  for (const p of snapshot.governance.data.recentProposals) {
    if (p.state === 'Defeated' || p.state === 'Cancelled') continue;
    if (p.topVoterShareBps <= threshold) continue;
    alerts.push(createAlert(
      'governance',
      'proposal_whale_dominance',
      p.topVoterShareBps > threshold * 1.5 ? 'critical' : 'warning',
      `Proposal ${p.proposalId.slice(0, 10)} — top voter ${(p.topVoterShareBps / 100).toFixed(1)}% of forVotes (threshold ${(threshold / 100).toFixed(1)}%)`,
      {
        governor: p.governor,
        proposalId: p.proposalId,
        topVoterShareBps: p.topVoterShareBps,
        threshold,
        target: p.target,
        selector: p.selector,
      },
    ));
  }
  return alerts;
}

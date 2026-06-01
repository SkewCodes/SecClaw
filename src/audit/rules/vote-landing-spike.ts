import { createAlert } from '../../alerts/bus.js';
import type { Alert, SystemSnapshot, PolicyManifest } from '../../types.js';

/**
 * Flag proposals where ≥50% of forVotes weight landed within a tiny block
 * window — sybil / coordinated-bot signal.
 */
export function checkVoteLandingSpike(
  snapshot: SystemSnapshot,
  manifest: PolicyManifest,
): Alert[] {
  const alerts: Alert[] = [];
  if (!snapshot.governance?.ok || !snapshot.governance.data) return alerts;
  const policy = manifest.governance;
  if (!policy?.enabled) return alerts;
  const maxWindow = policy.proposal_heuristics.vote_spike_window_blocks;

  for (const p of snapshot.governance.data.recentProposals) {
    if (p.voteSpikeWindowBlocks === 0) continue;
    if (p.voteSpikeWindowBlocks > maxWindow) continue;
    alerts.push(createAlert(
      'governance',
      'vote_landing_spike',
      'warning',
      `Proposal ${p.proposalId.slice(0, 10)} — 50%+ of forVotes within ${p.voteSpikeWindowBlocks} blocks (threshold ${maxWindow})`,
      {
        governor: p.governor,
        proposalId: p.proposalId,
        spikeWindowBlocks: p.voteSpikeWindowBlocks,
        threshold: maxWindow,
      },
    ));
  }
  return alerts;
}

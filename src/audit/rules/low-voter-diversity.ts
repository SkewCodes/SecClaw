import { createAlert } from '../../alerts/bus.js';
import type { Alert, SystemSnapshot, PolicyManifest } from '../../types.js';

/**
 * Flag passing proposals decided by very few unique voters.
 */
export function checkLowVoterDiversity(
  snapshot: SystemSnapshot,
  manifest: PolicyManifest,
): Alert[] {
  const alerts: Alert[] = [];
  if (!snapshot.governance?.ok || !snapshot.governance.data) return alerts;
  const policy = manifest.governance;
  if (!policy?.enabled) return alerts;
  const minVoters = policy.proposal_heuristics.low_voter_diversity_threshold;

  for (const p of snapshot.governance.data.recentProposals) {
    if (p.state !== 'Succeeded' && p.state !== 'Queued' && p.state !== 'Active') continue;
    const forVoteCount = p.votes.filter((v) => v.support === 'For').length;
    if (forVoteCount === 0 || forVoteCount >= minVoters) continue;
    alerts.push(createAlert(
      'governance',
      'low_voter_diversity',
      'warning',
      `Proposal ${p.proposalId.slice(0, 10)} — only ${forVoteCount} unique For voters (threshold ${minVoters})`,
      {
        governor: p.governor,
        proposalId: p.proposalId,
        forVoteCount,
        threshold: minVoters,
      },
    ));
  }
  return alerts;
}

import { createAlert } from '../../alerts/bus.js';
import type { Alert, SystemSnapshot, PolicyManifest } from '../../types.js';

/**
 * Flag proposals that barely cleared quorum — signal for last-minute
 * just-enough-to-pass voting (manipulation or precision-targeted whale).
 *
 * Quorum heuristic uses 4% of snapshotTotalSupply as a default reference,
 * since per-governor quorum is set at deploy time and not reachable via the
 * probe. The on-chain governor still enforces its own quorum independently.
 */
export function checkQuorumEdgePassage(
  snapshot: SystemSnapshot,
  manifest: PolicyManifest,
): Alert[] {
  const alerts: Alert[] = [];
  if (!snapshot.governance?.ok || !snapshot.governance.data) return alerts;
  const policy = manifest.governance;
  if (!policy?.enabled) return alerts;
  const bandPct = policy.proposal_heuristics.quorum_edge_band_pct;

  for (const p of snapshot.governance.data.recentProposals) {
    if (p.state !== 'Succeeded' && p.state !== 'Queued') continue;
    const supply = BigInt(p.snapshotTotalSupply);
    if (supply === 0n) continue;
    const totalCast =
      BigInt(p.forVotes) + BigInt(p.againstVotes) + BigInt(p.abstainVotes);
    if (totalCast === 0n) continue;
    const quorumRef = (supply * 400n) / 10_000n; // 4% reference
    if (totalCast < quorumRef) continue;
    const upperBand = (quorumRef * BigInt(100 + bandPct)) / 100n;
    if (totalCast > upperBand) continue;
    alerts.push(createAlert(
      'governance',
      'quorum_edge_passage',
      'warning',
      `Proposal ${p.proposalId.slice(0, 10)} cleared quorum within ${bandPct}% — manipulation signal`,
      {
        governor: p.governor,
        proposalId: p.proposalId,
        totalCast: totalCast.toString(),
        quorumRef: quorumRef.toString(),
        bandPct,
      },
    ));
  }
  return alerts;
}

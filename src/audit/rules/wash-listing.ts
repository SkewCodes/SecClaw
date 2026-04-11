import { createAlert } from '../../alerts/bus.js';
import type { Alert, SystemSnapshot, PolicyManifest } from '../../types.js';

/**
 * Correlates LIST events with subsequent trades from the same agent identity.
 * Flags when self-volume on an agent-listed market crosses maxSelfVolumePct.
 */
export function checkWashListing(snapshot: SystemSnapshot, manifest: PolicyManifest): Alert[] {
  const alerts: Alert[] = [];
  const policy = manifest.listing;

  if (!policy?.enabled) return alerts;
  if (!snapshot.listing.ok || !snapshot.listing.data) return alerts;

  const { recentListings, recentTrades } = snapshot.listing.data;

  for (const listing of recentListings) {
    const tradesOnMarket = recentTrades.filter((t) => t.marketId === listing.marketId);

    if (tradesOnMarket.length === 0) continue;

    const totalVolume = tradesOnMarket.reduce((sum, t) => sum + t.volumeUSD, 0);
    const selfVolume = tradesOnMarket
      .filter((t) => t.agentId === listing.agentId)
      .reduce((sum, t) => sum + t.volumeUSD, 0);

    if (totalVolume === 0) continue;

    const selfPct = selfVolume / totalVolume;

    if (selfPct > policy.maxSelfVolumePct) {
      alerts.push(createAlert('listing', 'wash_listing_suspected', 'critical',
        `Agent ${listing.agentId} self-volume ${(selfPct * 100).toFixed(1)}% on self-listed market ${listing.marketId} exceeds ${(policy.maxSelfVolumePct * 100).toFixed(0)}% limit`,
        {
          agentId: listing.agentId,
          marketId: listing.marketId,
          selfVolume,
          totalVolume,
          selfPct,
          limit: policy.maxSelfVolumePct,
        },
      ));
    }
  }

  return alerts;
}

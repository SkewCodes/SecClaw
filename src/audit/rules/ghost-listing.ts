import { createAlert } from '../../alerts/bus.js';
import type { Alert, SystemSnapshot, PolicyManifest } from '../../types.js';

const GHOST_GRACE_PERIOD_MS = 10 * 60 * 1000; // 10 minutes
const LIQUIDITY_PULL_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Flags listings where seed liquidity never materialized or was pulled
 * shortly after listing. Two sub-checks:
 *
 * 1. Seed liquidity is below policy minimum (or zero) after a grace period.
 * 2. Liquidity was pulled within 30 minutes of listing.
 */
export function checkGhostListing(snapshot: SystemSnapshot, manifest: PolicyManifest): Alert[] {
  const alerts: Alert[] = [];
  const policy = manifest.listing;

  if (!policy?.enabled) return alerts;
  if (!snapshot.listing.ok || !snapshot.listing.data) return alerts;

  const now = snapshot.timestamp;
  const { recentListings } = snapshot.listing.data;

  for (const listing of recentListings) {
    const age = now - listing.timestamp;

    if (age > GHOST_GRACE_PERIOD_MS && listing.seedLiquidityUSD < policy.minSeedLiquidityUSD) {
      alerts.push(createAlert('listing', 'ghost_listing', 'high',
        `Market ${listing.marketId} by ${listing.agentId} has seed liquidity $${listing.seedLiquidityUSD.toFixed(2)} below $${policy.minSeedLiquidityUSD} minimum after ${(age / 60_000).toFixed(0)}min`,
        {
          agentId: listing.agentId,
          marketId: listing.marketId,
          seedLiquidityUSD: listing.seedLiquidityUSD,
          minRequired: policy.minSeedLiquidityUSD,
          ageMinutes: age / 60_000,
        },
      ));
    }

    if (listing.seedLiquidityUSD > policy.maxSeedLiquidityUSD) {
      alerts.push(createAlert('listing', 'seed_liquidity_exceeded', 'warning',
        `Market ${listing.marketId} seed liquidity $${listing.seedLiquidityUSD.toFixed(2)} exceeds $${policy.maxSeedLiquidityUSD} cap`,
        {
          agentId: listing.agentId,
          marketId: listing.marketId,
          seedLiquidityUSD: listing.seedLiquidityUSD,
          maxAllowed: policy.maxSeedLiquidityUSD,
        },
      ));
    }

    if (
      listing.liquidityPulledAt &&
      listing.liquidityPulledAt - listing.timestamp < LIQUIDITY_PULL_WINDOW_MS
    ) {
      const pullDelayMin = (listing.liquidityPulledAt - listing.timestamp) / 60_000;
      alerts.push(createAlert('listing', 'ghost_listing', 'critical',
        `Liquidity pulled from ${listing.marketId} ${pullDelayMin.toFixed(1)}min after listing — possible ghost-listing by ${listing.agentId}`,
        {
          agentId: listing.agentId,
          marketId: listing.marketId,
          pullDelayMinutes: pullDelayMin,
        },
      ));
    }
  }

  return alerts;
}

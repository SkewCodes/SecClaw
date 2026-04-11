import { createAlert } from '../../alerts/bus.js';
import type { Alert, SystemSnapshot, PolicyManifest } from '../../types.js';

/**
 * Detects trades placed on agent-listed markets within the cooldown window.
 * Daemon-side retrospective check — the gate module blocks prospectively.
 */
export function checkCooldownViolation(snapshot: SystemSnapshot, manifest: PolicyManifest): Alert[] {
  const alerts: Alert[] = [];
  const policy = manifest.listing;

  if (!policy?.enabled) return alerts;
  if (!snapshot.listing.ok || !snapshot.listing.data) return alerts;

  const cooldownMs = policy.minCooldownAfterListSeconds * 1000;
  const { recentListings, recentTrades } = snapshot.listing.data;

  for (const listing of recentListings) {
    const cooldownEnd = listing.timestamp + cooldownMs;

    const violatingTrades = recentTrades.filter(
      (t) =>
        t.agentId === listing.agentId &&
        t.marketId === listing.marketId &&
        t.timestamp > listing.timestamp &&
        t.timestamp < cooldownEnd,
    );

    if (violatingTrades.length > 0) {
      const earliest = violatingTrades.reduce(
        (min, t) => (t.timestamp < min ? t.timestamp : min),
        Infinity,
      );
      const gapSec = (earliest - listing.timestamp) / 1000;

      alerts.push(createAlert('listing', 'listing_cooldown_violation', 'high',
        `Agent ${listing.agentId} traded on self-listed market ${listing.marketId} ${gapSec.toFixed(0)}s after listing (min ${policy.minCooldownAfterListSeconds}s)`,
        {
          agentId: listing.agentId,
          marketId: listing.marketId,
          gapSec,
          requiredSec: policy.minCooldownAfterListSeconds,
          violatingTradeCount: violatingTrades.length,
        },
      ));
    }
  }

  return alerts;
}

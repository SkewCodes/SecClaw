import { createAlert } from '../../alerts/bus.js';
import type { Alert, SystemSnapshot, PolicyManifest } from '../../types.js';

export function checkListingManipulation(
  snapshot: SystemSnapshot,
  manifest: PolicyManifest,
): Alert[] {
  const alerts: Alert[] = [];
  const policy = manifest.listing;
  if (!policy?.enabled) return alerts;
  if (!snapshot.listing.ok || !snapshot.listing.data) return alerts;

  const { recentListings, recentTrades } = snapshot.listing.data;

  for (const listing of recentListings) {
    const marketTrades = recentTrades.filter((t) => t.marketId === listing.marketId);
    if (marketTrades.length === 0) continue;

    const totalVolume = marketTrades.reduce((sum, t) => sum + t.volumeUSD, 0);

    // Pump-and-dump pattern: volume spike + liquidity pulled
    if (totalVolume > listing.seedLiquidityUSD * 3 && listing.liquidityPulledAt) {
      alerts.push(createAlert('listing', 'pump_and_dump_pattern', 'critical',
        `Market ${listing.marketId}: $${totalVolume.toFixed(0)} volume on $${listing.seedLiquidityUSD.toFixed(0)} seed, liquidity since pulled`,
        { marketId: listing.marketId, volume: totalVolume, seed: listing.seedLiquidityUSD },
      ));
    }

    // Instant trading after listing — possible manipulation
    const listingTimestamp = listing.timestamp;
    const earlyTrades = marketTrades.filter(
      (t) => t.timestamp - listingTimestamp < 60_000,
    );
    if (earlyTrades.length > 0) {
      const earlyVolume = earlyTrades.reduce((sum, t) => sum + t.volumeUSD, 0);
      alerts.push(createAlert('listing', 'early_trading_detected', 'high',
        `Market ${listing.marketId}: $${earlyVolume.toFixed(0)} traded within 60s of listing`,
        { marketId: listing.marketId, earlyVolume, tradeCount: earlyTrades.length },
      ));
    }

    // Volume concentration: single agent dominates trading
    const agentVolume = new Map<string, number>();
    for (const trade of marketTrades) {
      agentVolume.set(trade.agentId, (agentVolume.get(trade.agentId) ?? 0) + trade.volumeUSD);
    }

    if (totalVolume > 0) {
      for (const [agentId, vol] of agentVolume) {
        const pct = vol / totalVolume;
        if (pct > 0.8 && agentId === listing.agentId) {
          alerts.push(createAlert('listing', 'listing_self_trading', 'high',
            `Market ${listing.marketId}: listing agent controls ${(pct * 100).toFixed(0)}% of volume`,
            { marketId: listing.marketId, agentId, volumePct: pct },
          ));
        }
      }
    }
  }

  return alerts;
}

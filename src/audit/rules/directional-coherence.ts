import { createAlert } from '../../alerts/bus.js';
import type { Alert, SystemSnapshot } from '../../types.js';

export function checkDirectionalCoherence(snapshot: SystemSnapshot): Alert[] {
  const alerts: Alert[] = [];

  if (!snapshot.yieldclaw.ok || !snapshot.yieldclaw.data ||
      !snapshot.mm.ok || !snapshot.mm.data) {
    return alerts;
  }

  const ycPositions = snapshot.yieldclaw.data.positions;
  const mmPositions = snapshot.mm.data.positions;

  // Check if both vault and MM have same-direction positions on the same symbol
  for (const ycPos of ycPositions) {
    if (ycPos.position_qty === 0) continue;

    const ycDirection = ycPos.position_qty > 0 ? 'long' : 'short';

    for (const mmPos of mmPositions) {
      if (mmPos.size === 0) continue;

      // Normalize symbol comparison (YC uses PERP_ETH_USDC, MM might use different format)
      if (!symbolsMatch(ycPos.symbol, mmPos.symbol)) continue;

      const mmDirection = mmPos.size > 0 ? 'long' : 'short';

      // Same direction = amplification risk
      if (ycDirection === mmDirection) {
        const ycNotional = Math.abs(ycPos.position_qty * ycPos.mark_price);
        const mmNotional = Math.abs(mmPos.size * mmPos.markPrice);
        const combinedNotional = ycNotional + mmNotional;

        alerts.push(createAlert('cross_system', 'directional_coherence', 'warning',
          `${ycPos.symbol}: Both vault and MM are ${ycDirection} — amplification risk. Combined: $${combinedNotional.toFixed(2)}`,
          {
            symbol: ycPos.symbol,
            direction: ycDirection,
            yieldclaw_notional: ycNotional,
            mm_notional: mmNotional,
            combined_notional: combinedNotional,
          },
        ));
      }
    }
  }

  return alerts;
}

function symbolsMatch(a: string, b: string): boolean {
  // Normalize: both should resolve to the base pair
  const normalize = (s: string) => s.replace(/^PERP_/, '').replace(/_USDC$/, '').toUpperCase();
  return normalize(a) === normalize(b);
}

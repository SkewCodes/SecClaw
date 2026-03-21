import { createAlert } from '../../alerts/bus.js';
import type { Alert, SystemSnapshot } from '../../types.js';

type Direction = 'long' | 'short' | 'flat';

export function checkSymbolConflict(snapshot: SystemSnapshot): Alert[] {
  const alerts: Alert[] = [];

  const ycPositions = new Map<string, { direction: Direction; size: number }>();
  const mmPositions = new Map<string, { direction: Direction; size: number }>();

  // YieldClaw positions
  if (snapshot.yieldclaw.ok && snapshot.yieldclaw.data) {
    for (const pos of snapshot.yieldclaw.data.positions) {
      if (pos.position_qty !== 0) {
        ycPositions.set(pos.symbol, {
          direction: pos.position_qty > 0 ? 'long' : 'short',
          size: Math.abs(pos.position_qty),
        });
      }
    }
  }

  // MM positions
  if (snapshot.mm.ok && snapshot.mm.data) {
    for (const pos of snapshot.mm.data.positions) {
      if (pos.size !== 0) {
        mmPositions.set(pos.symbol, {
          direction: pos.size > 0 ? 'long' : 'short',
          size: Math.abs(pos.size),
        });
      }
    }
  }

  // Check for directional conflicts
  const allSymbols = new Set([...ycPositions.keys(), ...mmPositions.keys()]);

  for (const symbol of allSymbols) {
    const yc = ycPositions.get(symbol);
    const mm = mmPositions.get(symbol);

    if (yc && mm && yc.direction !== mm.direction) {
      alerts.push(createAlert('cross_system', 'symbol_conflict', 'warning',
        `${symbol}: YieldClaw ${yc.direction} (${yc.size}) vs MM ${mm.direction} (${mm.size})`,
        {
          symbol,
          yieldclaw: { direction: yc.direction, size: yc.size },
          mm: { direction: mm.direction, size: mm.size },
        },
      ));
    }
  }

  return alerts;
}

import { createAlert } from '../../alerts/bus.js';
import type { Alert, SystemSnapshot } from '../../types.js';

/**
 * Surface every BuilderBond status transition as an alert. Council uses
 * these for the slashing review queue (7-day veto window).
 */
export function checkBondStatusChange(snapshot: SystemSnapshot): Alert[] {
  const alerts: Alert[] = [];
  if (!snapshot.governance?.ok || !snapshot.governance.data) return alerts;

  for (const b of snapshot.governance.data.bonds) {
    if (b.status === 'SlashingProposed') {
      const remainingMs = Math.max(0, b.vetoExecutableAt * 1000 - Date.now());
      const remainingHours = Math.floor(remainingMs / 3_600_000);
      alerts.push(createAlert(
        'governance',
        'bond_slashing_proposed',
        'critical',
        `Bond slashing proposed for product ${b.productId.slice(0, 10)} — ${remainingHours}h until veto window closes`,
        {
          bondAddress: b.bondAddress,
          productId: b.productId,
          builder: b.builder,
          slashingReasonHash: b.slashingReasonHash,
          vetoExecutableAt: b.vetoExecutableAt,
          remainingHours,
        },
      ));
    } else if (b.status === 'Slashed') {
      alerts.push(createAlert(
        'governance',
        'bond_slashed',
        'critical',
        `Bond for product ${b.productId.slice(0, 10)} executed slashing`,
        {
          bondAddress: b.bondAddress,
          productId: b.productId,
          builder: b.builder,
        },
      ));
    }
  }
  return alerts;
}

import { createAlert } from '../../alerts/bus.js';
import type { Alert, SystemSnapshot } from '../../types.js';

export function checkSandwichPattern(snapshot: SystemSnapshot): Alert[] {
  const alerts: Alert[] = [];
  if (!snapshot.mm.ok || !snapshot.mm.data) return alerts;

  const quality = snapshot.mm.data.quality;
  if (!quality) return alerts;

  if (quality.adverseSelectionBps > 10 && quality.fillRate < 0.3) {
    alerts.push(createAlert('agentic_mm', 'potential_sandwich_pattern', 'warning',
      `MM showing high adverse selection (${quality.adverseSelectionBps.toFixed(1)} bps) with low fill rate (${(quality.fillRate * 100).toFixed(1)}%) — possible sandwich attack pattern`,
      { adverseSelectionBps: quality.adverseSelectionBps, fillRate: quality.fillRate },
    ));
  }

  return alerts;
}

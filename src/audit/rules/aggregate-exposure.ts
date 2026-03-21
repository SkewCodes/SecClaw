import { createAlert } from '../../alerts/bus.js';
import type { Alert, SystemSnapshot, PolicyManifest } from '../../types.js';

export function checkAggregateExposure(snapshot: SystemSnapshot, manifest: PolicyManifest): Alert[] {
  const alerts: Alert[] = [];
  const limit = manifest.global.aggregate_exposure_limit_usd;

  let ycExposure = 0;
  let mmExposure = 0;
  let guardianPending = 0;

  // YieldClaw net position value
  if (snapshot.yieldclaw.ok && snapshot.yieldclaw.data?.risk) {
    ycExposure = snapshot.yieldclaw.data.risk.totalExposure;
  }

  // MM net position value
  if (snapshot.mm.ok && snapshot.mm.data) {
    for (const pos of snapshot.mm.data.positions) {
      mmExposure += Math.abs(pos.size * pos.markPrice);
    }
  }

  // Guardian pending intents (estimate from recent executed intents)
  if (snapshot.guardian.ok && snapshot.guardian.data) {
    for (const intent of snapshot.guardian.data.recentIntents) {
      if (intent.status === 'executed' && intent.receipt) {
        guardianPending += (intent.receipt.orderQuantity ?? 0) * (intent.receipt.orderPrice ?? 0);
      }
    }
  }

  const totalExposure = ycExposure + mmExposure + guardianPending;

  if (totalExposure > limit) {
    alerts.push(createAlert('cross_system', 'aggregate_exposure_exceeded', 'critical',
      `Aggregate exposure $${totalExposure.toFixed(2)} exceeds limit $${limit}`,
      { ycExposure, mmExposure, guardianPending, totalExposure, limit },
    ));
  } else if (totalExposure > limit * 0.8) {
    alerts.push(createAlert('cross_system', 'aggregate_exposure_approaching', 'warning',
      `Aggregate exposure $${totalExposure.toFixed(2)} at ${((totalExposure / limit) * 100).toFixed(1)}% of $${limit} limit`,
      { ycExposure, mmExposure, guardianPending, totalExposure, limit },
    ));
  }

  return alerts;
}

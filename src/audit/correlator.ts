import type { Alert, SystemSnapshot, PolicyManifest } from '../types.js';
import { checkAggregateExposure } from './rules/aggregate-exposure.js';
import { checkSymbolConflict } from './rules/symbol-conflict.js';
import { checkCorrelatedStress } from './rules/correlated-stress.js';
import { checkSessionLifecycle } from './rules/session-lifecycle.js';
import { checkDirectionalCoherence } from './rules/directional-coherence.js';
import { checkGrowthFeeConflict } from './rules/growth-fee-conflict.js';
import { checkWashListing } from './rules/wash-listing.js';
import { checkCooldownViolation } from './rules/cooldown-violation.js';
import { checkGhostListing } from './rules/ghost-listing.js';

const MAX_WINDOW = 10;

export class AuditCorrelator {
  private window: SystemSnapshot[] = [];

  record(snapshot: SystemSnapshot): void {
    this.window.push(snapshot);
    if (this.window.length > MAX_WINDOW) {
      this.window.shift();
    }
  }

  getWindow(): readonly SystemSnapshot[] {
    return this.window;
  }

  correlate(snapshot: SystemSnapshot, manifest: PolicyManifest): Alert[] {
    const alerts: Alert[] = [];

    alerts.push(...checkAggregateExposure(snapshot, manifest));
    alerts.push(...checkSymbolConflict(snapshot));
    alerts.push(...checkCorrelatedStress(snapshot, this.window));
    alerts.push(...checkSessionLifecycle(snapshot, manifest));
    alerts.push(...checkDirectionalCoherence(snapshot));
    alerts.push(...checkGrowthFeeConflict(snapshot, manifest));
    alerts.push(...checkWashListing(snapshot, manifest));
    alerts.push(...checkCooldownViolation(snapshot, manifest));
    alerts.push(...checkGhostListing(snapshot, manifest));

    return alerts;
  }
}

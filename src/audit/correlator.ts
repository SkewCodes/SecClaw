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
import { checkSupplyChainWorm } from './rules/supply-chain-worm.js';
import { checkSkillCliBypass } from './rules/skill-cli-bypass.js';
import { checkCredentialRadius } from './rules/credential-radius.js';
import { WorkflowDriftDetector } from './rules/workflow-drift.js';
import { checkSandwichPattern } from './rules/sandwich-detection.js';
import { checkFundingRateExploitation } from './rules/funding-exploitation.js';
import { WithdrawalVelocityMonitor, checkWithdrawalVelocity } from './rules/withdrawal-velocity.js';
import { checkSessionOwnership } from './rules/session-hijack.js';
import { checkListingManipulation } from './rules/listing-manipulation.js';

const MAX_WINDOW = 10;

export class AuditCorrelator {
  private window: SystemSnapshot[] = [];
  private workflowDrift = new WorkflowDriftDetector();
  private withdrawalMonitor = new WithdrawalVelocityMonitor();

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

    // Always run aggregate exposure
    alerts.push(...checkAggregateExposure(snapshot, manifest));

    // Cross-product rules: require both YieldClaw and MM data (Item 25)
    if (snapshot.yieldclaw.ok && snapshot.mm.ok) {
      alerts.push(...checkSymbolConflict(snapshot));
      alerts.push(...checkDirectionalCoherence(snapshot));
    }

    // Correlated stress uses the rolling window — run when either is available
    if (snapshot.yieldclaw.ok || snapshot.mm.ok) {
      alerts.push(...checkCorrelatedStress(snapshot, this.window));
    }

    // Guardian-dependent rules
    if (snapshot.guardian.ok) {
      alerts.push(...checkSessionLifecycle(snapshot, manifest));
      alerts.push(...checkSessionOwnership(snapshot, manifest));
      alerts.push(...checkWithdrawalVelocity(snapshot, manifest, this.withdrawalMonitor));
    }

    // Growth agent rules
    if (snapshot.growthAgent.ok) {
      alerts.push(...checkGrowthFeeConflict(snapshot, manifest));
    }

    // Listing rules
    if (snapshot.listing.ok) {
      alerts.push(...checkWashListing(snapshot, manifest));
      alerts.push(...checkCooldownViolation(snapshot, manifest));
      alerts.push(...checkGhostListing(snapshot, manifest));
      alerts.push(...checkListingManipulation(snapshot, manifest));
    }

    // Supply chain rules — each has its own internal probe-availability guards
    alerts.push(...checkSupplyChainWorm(snapshot, manifest));
    alerts.push(...checkCredentialRadius(snapshot));
    alerts.push(...this.workflowDrift.check(snapshot));

    // OtterClaw event rules
    if (snapshot.otterclawEvents && snapshot.otterclawEvents.length > 0) {
      alerts.push(...checkSkillCliBypass(snapshot));
    }

    // MM-specific crypto monitoring (Items 10, 20)
    if (snapshot.mm.ok) {
      alerts.push(...checkSandwichPattern(snapshot));
      alerts.push(...checkFundingRateExploitation(snapshot, manifest));
    }

    return alerts;
  }
}

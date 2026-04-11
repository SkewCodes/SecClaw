import { createSecClawEvent } from '../events/schema.js';
import type {
  GateRequest,
  GateCheckEntry,
  GateSharedState,
  PolicyManifest,
  SecClawEvent,
} from '../types.js';

/**
 * Pre-execution gate module: blocks place_order intents on markets that
 * the requesting agent listed within the cooldown window.
 */
export function checkListingCooldown(
  request: GateRequest,
  manifest: PolicyManifest,
  sharedState: GateSharedState,
): { entries: GateCheckEntry[]; events: SecClawEvent[] } {
  const entries: GateCheckEntry[] = [];
  const events: SecClawEvent[] = [];
  const start = Date.now();

  const policy = manifest.listing;

  if (!policy?.enabled) {
    entries.push({
      module: 'listing_watchdog',
      check: 'listing_cooldown',
      result: 'skip',
      latency_ms: Date.now() - start,
    });
    return { entries, events };
  }

  const marketId = request.payload.tool_params
    ? (request.payload.tool_params as Record<string, unknown>)['market_id'] as string | undefined
    : undefined;

  if (!marketId) {
    entries.push({
      module: 'listing_watchdog',
      check: 'listing_cooldown',
      result: 'skip',
      latency_ms: Date.now() - start,
    });
    return { entries, events };
  }

  const now = Date.now();
  const cooldownMs = policy.minCooldownAfterListSeconds * 1000;

  const violatingListing = sharedState.recentListings.find(
    (l) =>
      l.agentId === request.agent_id &&
      l.marketId === marketId &&
      now - l.timestamp < cooldownMs,
  );

  if (violatingListing) {
    const elapsed = now - violatingListing.timestamp;
    const remainingSec = (cooldownMs - elapsed) / 1000;

    entries.push({
      module: 'listing_watchdog',
      check: 'listing_cooldown',
      result: 'block',
      latency_ms: Date.now() - start,
    });

    events.push(createSecClawEvent({
      source: 'gate',
      agent_id: request.agent_id,
      module: 'listing_watchdog',
      action: 'block',
      severity: 'critical',
      check: 'listing_cooldown',
      details: {
        expected: `>= ${policy.minCooldownAfterListSeconds}s after listing`,
        actual: `${(elapsed / 1000).toFixed(0)}s after listing`,
        policy_rule: 'listing.minCooldownAfterListSeconds',
        message: `Trade on self-listed market ${marketId} blocked — ${remainingSec.toFixed(0)}s remaining in cooldown`,
      },
      execution_context: {
        tool_name: request.payload.tool_name,
      },
    }));
  } else {
    entries.push({
      module: 'listing_watchdog',
      check: 'listing_cooldown',
      result: 'pass',
      latency_ms: Date.now() - start,
    });
  }

  return { entries, events };
}

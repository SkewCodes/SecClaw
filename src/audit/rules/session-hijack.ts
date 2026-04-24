import { createAlert } from '../../alerts/bus.js';
import type { Alert, SystemSnapshot, PolicyManifest } from '../../types.js';

export function checkSessionOwnership(
  snapshot: SystemSnapshot,
  _manifest: PolicyManifest,
): Alert[] {
  const alerts: Alert[] = [];
  if (!snapshot.guardian.ok || !snapshot.guardian.data) return alerts;

  const sessionOwners = new Map<string, string>();

  for (const intent of snapshot.guardian.data.recentIntents) {
    const sessionId = intent.intentId.split('-')[0];
    const agentId = intent.intentId.match(/^(0x[a-f0-9]+)/i)?.[1];
    if (!agentId || !sessionId) continue;

    const knownOwner = sessionOwners.get(sessionId);
    if (knownOwner && knownOwner !== agentId) {
      alerts.push(createAlert('payment_layer', 'session_hijack_attempt', 'critical',
        `Session ${sessionId.slice(0, 10)}... used by ${agentId} but owned by ${knownOwner}`,
        { sessionId, claimedBy: agentId, ownedBy: knownOwner },
      ));
    } else {
      sessionOwners.set(sessionId, agentId);
    }
  }

  return alerts;
}

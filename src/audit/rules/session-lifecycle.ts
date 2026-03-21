import { createAlert } from '../../alerts/bus.js';
import type { Alert, SystemSnapshot, PolicyManifest } from '../../types.js';

export function checkSessionLifecycle(snapshot: SystemSnapshot, manifest: PolicyManifest): Alert[] {
  const alerts: Alert[] = [];

  if (!snapshot.guardian.ok || !snapshot.guardian.data) return alerts;

  const maxTTLSec = manifest.payment_layer.session.max_ttl_seconds;
  const intents = snapshot.guardian.data.recentIntents;

  const ONE_HOUR_MS = 60 * 60 * 1000;
  const now = Date.now();

  let rapidCreations = 0;

  // Track sessions by intentId prefix and detect long-lived sessions
  const sessionFirstSeen = new Map<string, number>();
  const sessionLastSeen = new Map<string, number>();

  for (const intent of intents) {
    const sessionId = intent.intentId.split('-')[0] ?? intent.intentId;
    const intentTs = (intent as unknown as { _ts?: number })._ts ?? now;

    if (!sessionFirstSeen.has(sessionId) || intentTs < sessionFirstSeen.get(sessionId)!) {
      sessionFirstSeen.set(sessionId, intentTs);
    }
    if (!sessionLastSeen.has(sessionId) || intentTs > sessionLastSeen.get(sessionId)!) {
      sessionLastSeen.set(sessionId, intentTs);
    }

    if (now - intentTs < ONE_HOUR_MS) {
      rapidCreations++;
    }
  }

  // Detect sessions that have been active longer than maxTTL
  const maxTTLMs = maxTTLSec * 1000;
  for (const [sessionId, firstSeen] of sessionFirstSeen) {
    const lastSeen = sessionLastSeen.get(sessionId)!;
    const sessionDuration = lastSeen - firstSeen;

    if (sessionDuration > maxTTLMs) {
      alerts.push(createAlert('payment_layer', 'session_ttl_exceeded', 'high',
        `Session ${sessionId.slice(0, 10)}... active for ${Math.round(sessionDuration / 1000)}s — exceeds max TTL ${maxTTLSec}s`,
        { sessionId, durationSec: Math.round(sessionDuration / 1000), maxTTLSec },
      ));
    }
  }

  if (rapidCreations > 50) {
    alerts.push(createAlert('payment_layer', 'high_intent_rate', 'warning',
      `${rapidCreations} intents in the last hour — unusual activity rate`,
      { count: rapidCreations },
    ));
  }

  const deniedIntents = intents.filter((i) => i.policyResult === 'denied');
  if (deniedIntents.length > 10) {
    alerts.push(createAlert('payment_layer', 'excessive_denials', 'high',
      `${deniedIntents.length} denied intents in recent window — possible session or policy issue`,
      { deniedCount: deniedIntents.length },
    ));
  }

  return alerts;
}

import type { Alert, AlertSeverity, AlertEscalationEntry } from '../types.js';
import { createAlert } from './bus.js';

const SEVERITY_ORDER: AlertSeverity[] = ['info', 'warning', 'high', 'critical'];

function nextSeverity(current: AlertSeverity): AlertSeverity | null {
  const idx = SEVERITY_ORDER.indexOf(current);
  if (idx < 0 || idx >= SEVERITY_ORDER.length - 1) return null;
  return SEVERITY_ORDER[idx + 1];
}

export class AlertEscalator {
  private tracker = new Map<string, AlertEscalationEntry>();
  private cyclesForEscalation: number;
  private maxAge: number;

  constructor(cyclesForEscalation = 6, maxAgeMs = 30 * 60 * 1000) {
    this.cyclesForEscalation = cyclesForEscalation;
    this.maxAge = maxAgeMs;
  }

  /**
   * Feed alerts from a cycle. Returns escalation alerts for anything
   * that has persisted for N+ consecutive cycles.
   */
  process(alerts: Alert[]): Alert[] {
    const escalations: Alert[] = [];
    const now = Date.now();
    const seenKeys = new Set<string>();

    for (const alert of alerts) {
      if (isSupplyChainSource(alert.source)) {
        continue;
      }

      const key = `${alert.source}:${alert.check}`;
      seenKeys.add(key);

      const entry = this.tracker.get(key);
      if (entry) {
        entry.count++;
        if (entry.count >= this.cyclesForEscalation) {
          const next = nextSeverity(alert.severity);
          if (next) {
            escalations.push(createAlert(
              alert.source,
              `${alert.check}_escalated`,
              next,
              `Escalated from ${alert.severity}: persisted for ${entry.count} cycles — ${alert.message}`,
              { originalSeverity: alert.severity, cycleCount: entry.count, ...alert.data },
            ));
          }
          entry.count = 0;
        }
      } else {
        this.tracker.set(key, {
          key,
          firstSeen: now,
          count: 1,
          severity: alert.severity,
        });
      }
    }

    // Clear entries not seen this cycle or expired
    for (const [key, entry] of this.tracker) {
      if (!seenKeys.has(key) || now - entry.firstSeen > this.maxAge) {
        this.tracker.delete(key);
      }
    }

    return escalations;
  }
}

export function isSupplyChainSource(source: string): boolean {
  return source.startsWith('supply-chain');
}

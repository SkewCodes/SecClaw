import type { Alert, AlertHandler } from '../types.js';
import { generateAlertId } from '../utils.js';

const DEDUP_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

export class AlertBus {
  private handlers: AlertHandler[] = [];
  private recentAlerts = new Map<string, number>();

  register(handler: AlertHandler): void {
    this.handlers.push(handler);
  }

  async emit(alert: Alert): Promise<void> {
    const bypassDedup = alert.severity === 'critical'
      && alert.source.startsWith('supply-chain');

    if (!bypassDedup) {
      const key = dedupKey(alert);
      const now = Date.now();
      const lastEmitted = this.recentAlerts.get(key);

      if (lastEmitted && now - lastEmitted < DEDUP_COOLDOWN_MS) {
        return;
      }

      this.recentAlerts.set(key, now);
      this.pruneOldEntries(now);
    }

    await Promise.allSettled(
      this.handlers.map((h) => h.handle(alert)),
    );
  }

  /**
   * Emit all alerts. The JSONL logger runs inline; slow handlers
   * (Telegram, Webhook) manage their own internal queues so
   * Promise.allSettled inside emit() won't block on them.
   */
  async emitAll(alerts: Alert[]): Promise<void> {
    await Promise.allSettled(alerts.map((a) => this.emit(a)));
  }

  private pruneOldEntries(now: number): void {
    for (const [key, ts] of this.recentAlerts) {
      if (now - ts > DEDUP_COOLDOWN_MS * 2) {
        this.recentAlerts.delete(key);
      }
    }
  }
}

/**
 * Build a dedup key that includes a discriminator from alert data
 * so same-check-different-symbol alerts aren't swallowed.
 */
function dedupKey(alert: Alert): string {
  let discriminator = '';
  if (alert.data) {
    const d = alert.data['symbol'] ?? alert.data['intentId'] ?? alert.data['path'] ?? alert.data['accountId'];
    if (d !== undefined) {
      discriminator = `:${String(d)}`;
    }
  }
  return `${alert.source}:${alert.check}:${alert.severity}${discriminator}`;
}

export function createAlert(
  source: string,
  check: string,
  severity: Alert['severity'],
  message: string,
  data?: Record<string, unknown>,
): Alert {
  return {
    id: generateAlertId(),
    source,
    check,
    severity,
    message,
    timestamp: Date.now(),
    data,
  };
}

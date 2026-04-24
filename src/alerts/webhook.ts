import type { Alert, AlertHandler, AlertSeverity } from '../types.js';

const MIN_INTERVAL_MS = 1000;
const MAX_QUEUE_SIZE = 1000;

export class WebhookHandler implements AlertHandler {
  private lastSentAt = 0;
  private queue: Alert[] = [];
  private drainPromise: Promise<void> | null = null;
  private _overflowEmitted = false;

  constructor(
    private url: string,
    private minSeverity: AlertSeverity = 'warning',
  ) {}

  async handle(alert: Alert): Promise<void> {
    if (!this.shouldSend(alert.severity)) return;

    if (this.queue.length >= MAX_QUEUE_SIZE) {
      this.queue.shift();
      if (!this._overflowEmitted) {
        this._overflowEmitted = true;
        console.error('[secclaw] Webhook alert queue overflow — dropping oldest alerts');
      }
    }

    this.queue.push(alert);
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainPromise) return;
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = null;
      if (this.queue.length > 0) {
        this.scheduleDrain();
      }
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const now = Date.now();
      const wait = MIN_INTERVAL_MS - (now - this.lastSentAt);
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait));
      }

      const alert = this.queue.shift();
      if (!alert) break;
      await this.send(alert);
      this.lastSentAt = Date.now();
    }
  }

  private async send(alert: Alert): Promise<void> {
    try {
      await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'secclaw',
          alert: {
            id: alert.id,
            source: alert.source,
            check: alert.check,
            severity: alert.severity,
            message: alert.message,
            timestamp: new Date(alert.timestamp).toISOString(),
            data: alert.data,
          },
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      console.error('[secclaw] Webhook send failed:', (err as Error).message);
    }
  }

  private shouldSend(severity: AlertSeverity): boolean {
    const levels: AlertSeverity[] = ['info', 'warning', 'high', 'critical'];
    return levels.indexOf(severity) >= levels.indexOf(this.minSeverity);
  }
}

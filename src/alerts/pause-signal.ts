import type { Alert, AlertHandler } from '../types.js';

export class PauseSignalBroadcaster implements AlertHandler {
  constructor(private port: number) {}

  async handle(alert: Alert): Promise<void> {
    if (alert.severity !== 'critical') return;

    const payload = {
      source: 'secclaw',
      severity: alert.severity,
      system: alert.source,
      invariant: alert.check,
      timestamp: alert.timestamp,
      message: alert.message,
    };

    try {
      await fetch(`http://localhost:${this.port}/api/v1/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // Pause signal is advisory — target may not be listening
    }
  }
}

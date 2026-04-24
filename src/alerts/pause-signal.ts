import type { Alert, AlertHandler } from '../types.js';
import { signPayload } from './pause-signal-verifier.js';

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

    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    // Hardcoded invariant #9: Pause signals carry HMAC when secret is configured
    const secret = process.env.SECCLAW_PAUSE_SECRET;
    if (secret) {
      headers['X-SecClaw-Signature'] = signPayload(body, secret);
    }

    try {
      await fetch(`http://localhost:${this.port}/api/v1/pause`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // Pause signal is advisory — target may not be listening
    }
  }
}

import type { Alert, AlertHandler } from '../types.js';
import { signPayload } from '../alerts/pause-signal-verifier.js';

export class DeployPauseHandler implements AlertHandler {
  constructor(
    private pausePort: number,
    private deployRunnerPort?: number,
  ) {}

  async handle(alert: Alert): Promise<void> {
    if (alert.severity !== 'critical') return;
    if (!alert.source.startsWith('supply-chain')) return;

    const payload = {
      source: 'secclaw',
      module: 'deploy_pause',
      severity: alert.severity,
      system: alert.source,
      invariant: alert.check,
      timestamp: alert.timestamp,
      message: alert.message,
      action: 'halt_deploy',
    };

    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    const secret = process.env.SECCLAW_PAUSE_SECRET;
    if (secret) {
      headers['X-SecClaw-Signature'] = signPayload(body, secret);
    }

    const targets = [this.pausePort];
    if (this.deployRunnerPort) {
      targets.push(this.deployRunnerPort);
    }

    await Promise.allSettled(
      targets.map((port) =>
        fetch(`http://localhost:${port}/api/v1/pause`, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(3000),
        }).catch(() => { /* advisory */ }),
      ),
    );
  }
}

import type { Alert, AlertHandler } from '../types.js';

/**
 * Extends PauseSignalBroadcaster to halt the Starchild deploy runner
 * on critical supply-chain alerts. Sends pause to both the standard
 * pause port and the deploy-runner-specific port.
 */
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

    const targets = [this.pausePort];
    if (this.deployRunnerPort) {
      targets.push(this.deployRunnerPort);
    }

    await Promise.allSettled(
      targets.map((port) =>
        fetch(`http://localhost:${port}/api/v1/pause`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(3000),
        }).catch(() => { /* advisory */ }),
      ),
    );
  }
}

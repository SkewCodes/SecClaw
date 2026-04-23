import type { Alert, AlertHandler } from '../types.js';

export interface QuarantineConfig {
  pausePort: number;
  onQuarantine?: (builderId: string, alert: Alert) => void;
}

/**
 * Isolates a compromised builder from the deploy pipeline by sending
 * a targeted pause signal. Uses the pause signal infrastructure.
 */
export class QuarantineBuilderHandler implements AlertHandler {
  private quarantinedBuilders = new Set<string>();

  constructor(private config: QuarantineConfig) {}

  isQuarantined(builderId: string): boolean {
    return this.quarantinedBuilders.has(builderId);
  }

  getQuarantinedBuilders(): string[] {
    return [...this.quarantinedBuilders];
  }

  releaseBuilder(builderId: string): boolean {
    return this.quarantinedBuilders.delete(builderId);
  }

  async handle(alert: Alert): Promise<void> {
    if (alert.severity !== 'critical') return;
    if (!alert.source.startsWith('supply-chain')) return;

    const builderId = alert.data?.['builderId'] as string | undefined;
    if (!builderId) return;

    if (this.quarantinedBuilders.has(builderId)) return;

    this.quarantinedBuilders.add(builderId);
    console.log(`[secclaw] Builder ${builderId} quarantined due to: ${alert.check}`);

    const payload = {
      source: 'secclaw',
      module: 'quarantine_builder',
      action: 'quarantine',
      builderId,
      severity: alert.severity,
      reason: alert.check,
      message: alert.message,
      timestamp: alert.timestamp,
    };

    try {
      await fetch(`http://localhost:${this.config.pausePort}/api/v1/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // advisory — target may not be listening
    }

    this.config.onQuarantine?.(builderId, alert);
  }
}

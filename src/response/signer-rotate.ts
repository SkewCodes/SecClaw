import type { Alert, AlertHandler } from '../types.js';

export interface SignerRotateConfig {
  rotationEndpoint?: string;
  onRotate?: (alert: Alert) => void;
}

/**
 * Triggers ephemeral signer rotation when a critical supply-chain
 * alert indicates potential key compromise.
 */
export class SignerRotateHandler implements AlertHandler {
  constructor(private config: SignerRotateConfig = {}) {}

  async handle(alert: Alert): Promise<void> {
    if (alert.severity !== 'critical') return;
    if (!alert.source.startsWith('supply-chain')) return;

    const requiresRotation =
      alert.check === 'credential_radius' ||
      alert.check === 'worm_propagation' ||
      alert.check === 'lockfile_tampered';

    if (!requiresRotation) return;

    if (this.config.rotationEndpoint) {
      try {
        const res = await fetch(this.config.rotationEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: 'secclaw',
            module: 'signer_rotate',
            reason: alert.check,
            message: alert.message,
            timestamp: alert.timestamp,
          }),
          signal: AbortSignal.timeout(10_000),
        });

        if (res.ok) {
          console.log('[secclaw] Signer rotation triggered successfully');
          this.config.onRotate?.(alert);
        } else {
          console.error(`[secclaw] Signer rotation returned ${res.status}`);
        }
      } catch (err) {
        console.error('[secclaw] Signer rotation failed:', (err as Error).message);
      }
    } else {
      console.log('[secclaw] Signer rotation triggered (no endpoint configured — signal only)');
      this.config.onRotate?.(alert);
    }
  }
}

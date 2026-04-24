import type { Alert, AlertHandler, GateSharedState } from '../types.js';
import { signPayload } from '../alerts/pause-signal-verifier.js';

export interface SignerRotateConfig {
  rotationEndpoint?: string;
  onRotate?: (alert: Alert) => void;
  sharedState?: GateSharedState;
}

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

    // Hardcoded invariant #7: trigger rotation lockout on gate shared state
    if (this.config.sharedState) {
      this.config.sharedState.signerRotationTriggeredAt = Date.now();
    }

    if (this.config.rotationEndpoint) {
      try {
        const payload = {
          source: 'secclaw',
          module: 'signer_rotate',
          reason: alert.check,
          message: alert.message,
          timestamp: alert.timestamp,
        };
        const body = JSON.stringify(payload);
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };

        const secret = process.env.SECCLAW_PAUSE_SECRET;
        if (secret) {
          headers['X-SecClaw-Signature'] = signPayload(body, secret);
        }

        const res = await fetch(this.config.rotationEndpoint, {
          method: 'POST',
          headers,
          body,
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

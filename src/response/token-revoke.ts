import type { Alert, AlertHandler } from '../types.js';

export interface TokenRevokeConfig {
  githubToken?: string;
  npmToken?: string;
  onRevoke?: (tokenType: string, alert: Alert) => void;
}

/**
 * Revokes compromised tokens (GitHub PATs, npm tokens) via their
 * respective APIs when a critical supply-chain alert fires.
 */
export class TokenRevokeHandler implements AlertHandler {
  constructor(private config: TokenRevokeConfig = {}) {}

  async handle(alert: Alert): Promise<void> {
    if (alert.severity !== 'critical') return;
    if (!alert.source.startsWith('supply-chain')) return;

    const isCredentialAlert =
      alert.check === 'credential_radius' ||
      alert.check === 'worm_propagation' ||
      alert.check === 'sensitive_path_access';

    if (!isCredentialAlert) return;

    const revocations: Promise<void>[] = [];

    if (this.config.githubToken) {
      revocations.push(this.revokeGitHubToken(alert));
    }

    if (this.config.npmToken) {
      revocations.push(this.revokeNpmToken(alert));
    }

    await Promise.allSettled(revocations);
  }

  private async revokeGitHubToken(alert: Alert): Promise<void> {
    try {
      const res = await fetch('https://api.github.com/installation/token', {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${this.config.githubToken}`,
          Accept: 'application/vnd.github+json',
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (res.ok || res.status === 204) {
        console.log('[secclaw] GitHub token revoked successfully');
        this.config.onRevoke?.('github', alert);
      } else {
        console.error(`[secclaw] GitHub token revocation returned ${res.status}`);
      }
    } catch (err) {
      console.error('[secclaw] GitHub token revocation failed:', (err as Error).message);
    }
  }

  private async revokeNpmToken(alert: Alert): Promise<void> {
    try {
      const res = await fetch('https://registry.npmjs.org/-/tokens', {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${this.config.npmToken}`,
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (res.ok || res.status === 204) {
        console.log('[secclaw] npm token revoked successfully');
        this.config.onRevoke?.('npm', alert);
      } else {
        console.error(`[secclaw] npm token revocation returned ${res.status}`);
      }
    } catch (err) {
      console.error('[secclaw] npm token revocation failed:', (err as Error).message);
    }
  }
}

import type {
  ProbeResult,
  YieldClawSnapshot,
  YCStatus,
  YCRisk,
  YCPosition,
  YCStrategy,
  YCSharePrice,
  GuardianPolicy,
} from '../types.js';
import { fulfilled } from '../utils.js';

export class YieldClawProbe {
  constructor(
    private baseUrl: string,
    private healthToken: string,
  ) {}

  async probe(): Promise<ProbeResult<YieldClawSnapshot>> {
    const start = Date.now();

    try {
      const [status, risk, positions, strategy, sharePrice, guardianPolicy] =
        await Promise.allSettled([
          this.get<YCStatus>('/api/v1/status'),
          this.get<YCRisk>('/api/v1/risk'),
          this.get<{ positions: YCPosition[]; count: number }>('/api/v1/positions'),
          this.get<{ strategy: YCStrategy }>('/api/v1/strategy'),
          this.get<{ sharePrice: YCSharePrice }>('/api/v1/vault/share-price'),
          this.get<{ policy: GuardianPolicy }>('/api/v1/guardian-policy'),
        ]);

      const snapshot: YieldClawSnapshot = {
        status: fulfilled(status),
        risk: fulfilled(risk),
        positions: fulfilled(positions)?.positions ?? [],
        strategy: fulfilled(strategy)?.strategy ?? null,
        sharePrice: fulfilled(sharePrice)?.sharePrice ?? null,
        guardianPolicy: fulfilled(guardianPolicy)?.policy ?? null,
      };

      return {
        ok: true,
        data: snapshot,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        ok: false,
        error: (err as Error).message,
        latencyMs: Date.now() - start,
      };
    }
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.healthToken}`,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      throw new Error(`YieldClaw ${path}: HTTP ${res.status}`);
    }

    return res.json() as Promise<T>;
  }
}


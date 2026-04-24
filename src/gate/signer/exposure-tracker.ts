interface ExposureEntry {
  amount_usd: number;
  timestamp: number;
}

export class CumulativeExposureTracker {
  private entries: ExposureEntry[] = [];
  private windowMs: number;
  private maxUsd: number;

  constructor(window: string, maxUsd: number) {
    this.windowMs = parseWindowToMs(window);
    this.maxUsd = maxUsd;
  }

  check(additionalUsd: number): { allowed: boolean; currentUsd: number; maxUsd: number } {
    this.prune();
    const currentUsd = this.entries.reduce((sum, e) => sum + e.amount_usd, 0);
    return {
      allowed: currentUsd + additionalUsd <= this.maxUsd,
      currentUsd,
      maxUsd: this.maxUsd,
    };
  }

  record(amountUsd: number): void {
    this.entries.push({ amount_usd: amountUsd, timestamp: Date.now() });
  }

  updateLimits(maxUsd: number, window?: string): void {
    this.maxUsd = maxUsd;
    if (window) this.windowMs = parseWindowToMs(window);
  }

  currentTotal(): number {
    this.prune();
    return this.entries.reduce((sum, e) => sum + e.amount_usd, 0);
  }

  private prune(): void {
    const cutoff = Date.now() - this.windowMs;
    this.entries = this.entries.filter((e) => e.timestamp > cutoff);
  }
}

export function parseWindowToMs(window: string): number {
  const match = window.match(/^(\d+)(h|m|s)$/);
  if (!match) return 3_600_000;
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case 'h': return value * 3_600_000;
    case 'm': return value * 60_000;
    case 's': return value * 1_000;
    default: return 3_600_000;
  }
}

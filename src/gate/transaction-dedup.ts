import { createHash } from 'node:crypto';

export class TransactionDeduplicator {
  private seen = new Map<string, number>();
  private maxAge: number;

  constructor(maxAgeMs = 3_600_000) {
    this.maxAge = maxAgeMs;
  }

  isDuplicate(to: string | undefined, data: string | undefined, value: string | undefined, gasLimit: number | undefined, nonce: number | undefined): boolean {
    this.prune();
    const hash = this.computeHash(to, data, value, gasLimit, nonce);
    if (this.seen.has(hash)) return true;
    this.seen.set(hash, Date.now());
    return false;
  }

  private computeHash(to: string | undefined, data: string | undefined, value: string | undefined, gasLimit: number | undefined, nonce: number | undefined): string {
    const h = createHash('sha256');
    h.update(`to:${to ?? ''}`);
    h.update(`data:${data ?? ''}`);
    h.update(`value:${value ?? ''}`);
    h.update(`gas:${gasLimit ?? ''}`);
    h.update(`nonce:${nonce ?? ''}`);
    return h.digest('hex');
  }

  private prune(): void {
    const cutoff = Date.now() - this.maxAge;
    for (const [hash, ts] of this.seen) {
      if (ts < cutoff) this.seen.delete(hash);
    }
  }
}

export class TimeBoundedBuffer<T extends { _ts: number }> {
  private entries: T[] = [];
  private maxAgeMs: number;

  constructor(maxAgeMs: number) {
    this.maxAgeMs = maxAgeMs;
  }

  push(entry: T): void {
    this.entries.push(entry);
  }

  prune(): void {
    const cutoff = Date.now() - this.maxAgeMs;
    let lo = 0;
    let hi = this.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.entries[mid]._ts <= cutoff) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) this.entries = this.entries.slice(lo);
  }

  getAll(): T[] {
    this.prune();
    return this.entries;
  }

  get length(): number {
    return this.entries.length;
  }

  reduce<U>(fn: (acc: U, entry: T) => U, initial: U): U {
    this.prune();
    return this.entries.reduce(fn, initial);
  }
}

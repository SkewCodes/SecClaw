export class AccelerationDetector {
  private timestamps: number[] = [];
  private readonly windowMs = 300_000; // 5-minute analysis window
  private readonly bucketMs = 30_000;  // 30-second buckets

  record(): void {
    this.timestamps.push(Date.now());
    this.prune();
  }

  detect(): { accelerating: boolean; gradient: number } {
    this.prune();
    if (this.timestamps.length < 3) {
      return { accelerating: false, gradient: 0 };
    }

    const now = Date.now();
    const bucketCount = Math.ceil(this.windowMs / this.bucketMs);
    const buckets = new Array<number>(bucketCount).fill(0);

    for (const ts of this.timestamps) {
      const bucketIdx = Math.floor((now - ts) / this.bucketMs);
      if (bucketIdx >= 0 && bucketIdx < bucketCount) {
        buckets[bucketCount - 1 - bucketIdx]++;
      }
    }

    const recentBuckets = buckets.slice(-3);
    if (recentBuckets.length < 3) return { accelerating: false, gradient: 0 };

    const gradient = recentBuckets[2] - recentBuckets[0];
    return {
      accelerating: gradient > 2,
      gradient,
    };
  }

  private prune(): void {
    const cutoff = Date.now() - this.windowMs;
    this.timestamps = this.timestamps.filter((ts) => ts > cutoff);
  }
}

interface BucketConfig {
  capacity: number;
  refillPerMs: number;
}

class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(private config: BucketConfig) {
    this.tokens = config.capacity;
    this.lastRefill = Date.now();
  }

  canConsume(): boolean {
    this.refill();
    return this.tokens >= 1;
  }

  consume(): void {
    this.refill();
    this.tokens -= 1;
  }

  remaining(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(
      this.config.capacity,
      this.tokens + elapsed * this.config.refillPerMs,
    );
    this.lastRefill = now;
  }
}

export class TokenBucketRateLimiter {
  private perMinute: TokenBucket;
  private perHour: TokenBucket;
  private perDay: TokenBucket;

  constructor(perMinute: number, perHour: number, perDay: number) {
    this.perMinute = new TokenBucket({
      capacity: perMinute,
      refillPerMs: perMinute / 60_000,
    });
    this.perHour = new TokenBucket({
      capacity: perHour,
      refillPerMs: perHour / 3_600_000,
    });
    this.perDay = new TokenBucket({
      capacity: perDay,
      refillPerMs: perDay / 86_400_000,
    });
  }

  tryConsume(): { allowed: boolean; exhaustedWindow?: string } {
    if (!this.perMinute.canConsume()) return { allowed: false, exhaustedWindow: 'per_minute' };
    if (!this.perHour.canConsume()) return { allowed: false, exhaustedWindow: 'per_hour' };
    if (!this.perDay.canConsume()) return { allowed: false, exhaustedWindow: 'per_day' };
    this.perMinute.consume();
    this.perHour.consume();
    this.perDay.consume();
    return { allowed: true };
  }

  remaining(): { per_minute: number; per_hour: number; per_day: number } {
    return {
      per_minute: this.perMinute.remaining(),
      per_hour: this.perHour.remaining(),
      per_day: this.perDay.remaining(),
    };
  }

  updateLimits(perMinute: number, perHour: number, perDay: number): void {
    this.perMinute = new TokenBucket({
      capacity: perMinute,
      refillPerMs: perMinute / 60_000,
    });
    this.perHour = new TokenBucket({
      capacity: perHour,
      refillPerMs: perHour / 3_600_000,
    });
    this.perDay = new TokenBucket({
      capacity: perDay,
      refillPerMs: perDay / 86_400_000,
    });
  }
}

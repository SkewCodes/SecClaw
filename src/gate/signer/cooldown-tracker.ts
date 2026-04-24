export class CooldownTracker {
  private lastSignatureAt = 0;

  check(cooldownMs: number): { allowed: boolean; remainingMs: number } {
    const now = Date.now();
    const elapsed = now - this.lastSignatureAt;
    if (elapsed < cooldownMs) {
      return { allowed: false, remainingMs: cooldownMs - elapsed };
    }
    return { allowed: true, remainingMs: 0 };
  }

  record(): void {
    this.lastSignatureAt = Date.now();
  }
}

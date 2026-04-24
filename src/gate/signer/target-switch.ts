export class TargetSwitchDetector {
  private knownTargets = new Set<string>();
  private sessionId: string | null = null;

  check(target: string | undefined, sessionId: string | undefined): { newTarget: boolean; target?: string } {
    if (!target) return { newTarget: false };

    if (sessionId && sessionId !== this.sessionId) {
      this.knownTargets.clear();
      this.sessionId = sessionId;
    }

    if (this.knownTargets.has(target)) {
      return { newTarget: false };
    }

    const isFirst = this.knownTargets.size === 0;
    this.knownTargets.add(target);

    return {
      newTarget: !isFirst,
      target: !isFirst ? target : undefined,
    };
  }

  reset(): void {
    this.knownTargets.clear();
    this.sessionId = null;
  }
}

import type { Alert, AlertHandler, SystemSnapshot, AlertSeverity } from '../types.js';
import { createAlert } from '../alerts/bus.js';

interface DigestBucket {
  alerts: Alert[];
  snapshots: SystemSnapshot[];
  startedAt: number;
}

export class DigestReporter {
  private bucket: DigestBucket = { alerts: [], snapshots: [], startedAt: Date.now() };
  private intervalMs: number;
  private onReport: (report: string) => void;
  private alertHandlers: AlertHandler[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(intervalMs: number, onReport: (report: string) => void) {
    this.intervalMs = intervalMs;
    this.onReport = onReport;
  }

  /**
   * Register alert handlers that will receive the digest as an alert.
   * This pushes the digest through Telegram, webhooks, etc.
   */
  registerAlertHandler(handler: AlertHandler): void {
    this.alertHandlers.push(handler);
  }

  start(): void {
    this.bucket = { alerts: [], snapshots: [], startedAt: Date.now() };
    this.timer = setInterval(() => this.flush(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.flush();
  }

  record(alerts: Alert[], snapshot: SystemSnapshot): void {
    this.bucket.alerts.push(...alerts);
    this.bucket.snapshots.push(snapshot);
  }

  private flush(): void {
    if (this.bucket.snapshots.length === 0) return;

    const bucket = this.bucket;
    this.bucket = { alerts: [], snapshots: [], startedAt: Date.now() };

    const report = this.render(bucket);
    this.onReport(report);

    // Push a summary alert through all registered handlers
    const summary = this.buildSummaryAlert(bucket);
    for (const handler of this.alertHandlers) {
      handler.handle(summary).catch((err) => {
        console.error('[secclaw] Digest alert handler failed:', (err as Error).message);
      });
    }
  }

  private buildSummaryAlert(bucket: DigestBucket): Alert {
    const cycles = bucket.snapshots.length;
    const bySeverity: Record<AlertSeverity, number> = { critical: 0, high: 0, warning: 0, info: 0 };
    for (const a of bucket.alerts) bySeverity[a.severity]++;

    const grade = this.computeGrade(bySeverity, cycles);
    const period = `${new Date(bucket.startedAt).toISOString().slice(0, 16)} — ${new Date().toISOString().slice(0, 16)}`;

    let message = `Daily Digest | Grade: ${grade} | ${cycles} cycles\n`;
    message += `${period}\n`;
    message += `Critical: ${bySeverity.critical} | High: ${bySeverity.high} | Warning: ${bySeverity.warning} | Info: ${bySeverity.info}`;

    if (bucket.snapshots.length > 0) {
      const last = bucket.snapshots[bucket.snapshots.length - 1];
      const probeOk = [last.yieldclaw.ok, last.mm.ok, last.guardian.ok, last.otterclaw.ok, last.growthAgent.ok];
      const failCount = probeOk.filter((ok) => !ok).length;
      if (failCount > 0) {
        message += `\nProbe failures: ${failCount}/5`;
      }
    }

    return createAlert('secclaw', 'daily_digest', bySeverity.critical > 0 ? 'high' : 'info', message, {
      grade,
      cycles,
      ...bySeverity,
    });
  }

  private render(bucket: DigestBucket): string {
    const now = new Date();
    const start = new Date(bucket.startedAt);
    const cycles = bucket.snapshots.length;

    const bySeverity: Record<AlertSeverity, number> = { critical: 0, high: 0, warning: 0, info: 0 };
    const bySource = new Map<string, number>();
    const byCheck = new Map<string, number>();

    for (const a of bucket.alerts) {
      bySeverity[a.severity]++;
      bySource.set(a.source, (bySource.get(a.source) ?? 0) + 1);
      byCheck.set(`${a.source}/${a.check}`, (byCheck.get(`${a.source}/${a.check}`) ?? 0) + 1);
    }

    const latestSnap = bucket.snapshots[bucket.snapshots.length - 1];

    let md = `# SecClaw Digest\n\n`;
    md += `Period: ${start.toISOString()} — ${now.toISOString()}\n`;
    md += `Cycles: ${cycles}\n`;
    md += `Total alerts: ${bucket.alerts.length}\n\n`;

    md += `## Alert Summary\n\n`;
    md += `| Severity | Count |\n|----------|-------|\n`;
    for (const s of ['critical', 'high', 'warning', 'info'] as AlertSeverity[]) {
      md += `| ${s} | ${bySeverity[s]} |\n`;
    }

    if (byCheck.size > 0) {
      md += `\n## Top Alerts\n\n`;
      const sorted = [...byCheck.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
      md += `| Check | Count |\n|-------|-------|\n`;
      for (const [check, count] of sorted) {
        md += `| ${check} | ${count} |\n`;
      }
    }

    md += `\n## System Status (latest)\n\n`;
    md += `| System | Status | Latency |\n|--------|--------|---------|\n`;
    md += `| YieldClaw | ${latestSnap.yieldclaw.ok ? 'OK' : 'FAIL'} | ${latestSnap.yieldclaw.latencyMs}ms |\n`;
    md += `| Agentic MM | ${latestSnap.mm.ok ? 'OK' : 'FAIL'} | ${latestSnap.mm.latencyMs}ms |\n`;
    md += `| Guardian | ${latestSnap.guardian.ok ? 'OK' : 'FAIL'} | ${latestSnap.guardian.latencyMs}ms |\n`;
    md += `| OtterClaw | ${latestSnap.otterclaw.ok ? 'OK' : 'FAIL'} | ${latestSnap.otterclaw.latencyMs}ms |\n`;
    md += `| Growth Agent | ${latestSnap.growthAgent.ok ? 'OK' : 'FAIL'} | ${latestSnap.growthAgent.latencyMs}ms |\n`;

    if (latestSnap.yieldclaw.ok && latestSnap.yieldclaw.data?.risk) {
      const risk = latestSnap.yieldclaw.data.risk;
      md += `\n### YieldClaw\n`;
      md += `- Circuit Breaker: ${risk.circuitBreaker.level}\n`;
      md += `- Drawdown: ${risk.drawdownPct.toFixed(2)}%\n`;
      md += `- NAV: $${risk.currentNav.toFixed(2)}\n`;
      md += `- Exposure: $${risk.totalExposure.toFixed(2)}\n`;
    }

    if (latestSnap.growthAgent.ok && latestSnap.growthAgent.data) {
      const ga = latestSnap.growthAgent.data;
      md += `\n### Growth Agent\n`;
      md += `- Builder Tier: ${ga.builderTier}\n`;
      md += `- Dry Run: ${ga.dryRun}\n`;
      md += `- Playbooks (24h): ${ga.playbooksExecuted.length}\n`;
      md += `- Fee Changes (24h): ${ga.feeChanges.length}\n`;
      md += `- Watchdog Flags: ${ga.watchdogFlags.length}\n`;
    }

    const grade = this.computeGrade(bySeverity, cycles);
    md += `\n## Health Grade: ${grade}\n`;

    return md;
  }

  private computeGrade(bySeverity: Record<AlertSeverity, number>, cycles: number): string {
    if (cycles === 0) return 'N/A';
    const score = bySeverity.critical * 10 + bySeverity.high * 4 + bySeverity.warning * 1;
    const perCycle = score / cycles;
    if (perCycle === 0) return 'A';
    if (perCycle < 1) return 'B';
    if (perCycle < 3) return 'C';
    if (perCycle < 6) return 'D';
    return 'F';
  }
}

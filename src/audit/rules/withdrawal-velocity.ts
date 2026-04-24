import { createAlert } from '../../alerts/bus.js';
import type { Alert, SystemSnapshot, PolicyManifest } from '../../types.js';

export class WithdrawalVelocityMonitor {
  private withdrawals: Array<{ amount: number; timestamp: number }> = [];
  private seen = new Set<string>();

  recordIfNew(intentId: string, amount: number): void {
    if (this.seen.has(intentId)) return;
    this.seen.add(intentId);
    this.withdrawals.push({ amount, timestamp: Date.now() });
    this.prune();
  }

  detect(): { anomalous: boolean; reason?: string } {
    this.prune();
    const last10Min = this.withdrawals.filter((w) =>
      Date.now() - w.timestamp < 600_000,
    );

    if (last10Min.length > 5) {
      return {
        anomalous: true,
        reason: `${last10Min.length} withdrawals in 10 minutes — possible drain pattern`,
      };
    }

    if (last10Min.length >= 3) {
      const amounts = last10Min.map((w) => w.amount);
      const increasing = amounts.every((a, i) => i === 0 || a >= amounts[i - 1]);
      if (increasing && amounts[amounts.length - 1] > amounts[0] * 2) {
        return {
          anomalous: true,
          reason: 'Withdrawal amounts accelerating — amounts doubled within window',
        };
      }
    }

    return { anomalous: false };
  }

  private prune(): void {
    const cutoff = Date.now() - 3_600_000;
    this.withdrawals = this.withdrawals.filter((w) => w.timestamp > cutoff);
    if (this.seen.size > 10_000) {
      this.seen.clear();
    }
  }
}

export function checkWithdrawalVelocity(
  snapshot: SystemSnapshot,
  manifest: PolicyManifest,
  monitor: WithdrawalVelocityMonitor,
): Alert[] {
  const alerts: Alert[] = [];
  if (!snapshot.guardian.ok || !snapshot.guardian.data) return alerts;

  const withdrawals = snapshot.guardian.data.recentIntents.filter(
    (i) => i.action === 'vault_withdraw' && i.status === 'executed',
  );

  for (const w of withdrawals) {
    const amount = (w.receipt?.orderQuantity ?? 0) * (w.receipt?.orderPrice ?? 1);
    if (amount > 0) monitor.recordIfNew(w.intentId, amount);
  }

  const result = monitor.detect();
  if (result.anomalous) {
    alerts.push(createAlert('payment_layer', 'withdrawal_velocity_anomaly', 'critical',
      result.reason ?? 'Withdrawal velocity anomaly detected',
      { reason: result.reason },
    ));
  }

  return alerts;
}

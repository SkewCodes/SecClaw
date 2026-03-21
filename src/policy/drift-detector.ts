import { createAlert } from '../alerts/bus.js';
import type { Alert, SystemSnapshot, PolicyManifest } from '../types.js';

const MAX_HISTORY = 10;

interface MetricPoint {
  timestamp: number;
  value: number;
}

export class DriftDetector {
  private history: SystemSnapshot[] = [];
  private sharePriceHistory: MetricPoint[] = [];

  record(snapshot: SystemSnapshot): void {
    this.history.push(snapshot);
    if (this.history.length > MAX_HISTORY) {
      this.history.shift();
    }

    // Track share price over time
    const sp = snapshot.yieldclaw.data?.sharePrice;
    if (sp) {
      this.sharePriceHistory.push({ timestamp: snapshot.timestamp, value: sp.share_price });
      // Keep 1 hour of data at 30s intervals = 120 points
      if (this.sharePriceHistory.length > 120) {
        this.sharePriceHistory.shift();
      }
    }
  }

  detect(manifest: PolicyManifest): Alert[] {
    const alerts: Alert[] = [];

    if (this.history.length < 2) return alerts;

    // Share price rate of change over 1 hour
    if (this.sharePriceHistory.length >= 2) {
      const oldest = this.sharePriceHistory[0];
      const newest = this.sharePriceHistory[this.sharePriceHistory.length - 1];
      const elapsedMs = newest.timestamp - oldest.timestamp;
      const ONE_HOUR_MS = 60 * 60 * 1000;

      if (elapsedMs > 0 && oldest.value > 0) {
        const changePct = Math.abs(newest.value - oldest.value) / oldest.value * 100;
        const hourlyRate = changePct * (ONE_HOUR_MS / elapsedMs);

        if (hourlyRate > manifest.yieldclaw.share_price.max_hourly_change_pct) {
          alerts.push(createAlert('yieldclaw', 'share_price_rate', 'critical',
            `Share price changing at ${hourlyRate.toFixed(2)}%/hr exceeds ${manifest.yieldclaw.share_price.max_hourly_change_pct}% limit`,
            { hourlyRate, current: newest.value, oldest: oldest.value },
          ));
        }
      }
    }

    // Circuit breaker flapping detection
    const cbLevels = this.history
      .map((s) => s.yieldclaw.data?.risk?.circuitBreaker.level)
      .filter(Boolean);

    if (cbLevels.length >= 4) {
      let transitions = 0;
      for (let i = 1; i < cbLevels.length; i++) {
        if (cbLevels[i] !== cbLevels[i - 1]) transitions++;
      }
      if (transitions >= 3) {
        alerts.push(createAlert('yieldclaw', 'circuit_breaker_flapping', 'high',
          `Circuit breaker flapping: ${transitions} transitions in ${cbLevels.length} cycles`,
          { transitions, levels: cbLevels },
        ));
      }
    }

    // Drawdown trending toward limit
    const latest = this.history[this.history.length - 1];
    const drawdownPct = latest.yieldclaw.data?.risk?.drawdownPct;
    if (drawdownPct !== undefined) {
      const limit = manifest.yieldclaw.hard_limits.max_drawdown_pct;
      const ratio = drawdownPct / limit;
      if (ratio > 0.8 && ratio < 1.0) {
        // Check if trending upward
        const prevDrawdowns = this.history
          .slice(-5)
          .map((s) => s.yieldclaw.data?.risk?.drawdownPct)
          .filter((d): d is number => d !== undefined);

        if (prevDrawdowns.length >= 3) {
          const isIncreasing = prevDrawdowns.every((d, i) =>
            i === 0 || d >= prevDrawdowns[i - 1],
          );
          if (isIncreasing) {
            alerts.push(createAlert('yieldclaw', 'drawdown_trending', 'warning',
              `Drawdown trending upward at ${drawdownPct.toFixed(2)}% (${(ratio * 100).toFixed(0)}% of limit)`,
              { drawdownPct, limit, trend: prevDrawdowns },
            ));
          }
        }
      }
    }

    return alerts;
  }
}

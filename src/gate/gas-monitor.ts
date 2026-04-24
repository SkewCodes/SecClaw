export class GasPriceMonitor {
  private history: Array<{ gwei: number; timestamp: number }> = [];
  private maxEntries = 100;

  record(gwei: number): void {
    this.history.push({ gwei, timestamp: Date.now() });
    if (this.history.length > this.maxEntries) this.history.shift();
  }

  detectAnomaly(currentGwei: number, ceilingGwei: number, networkMedianGwei?: number): {
    anomalous: boolean;
    reason?: string;
  } {
    const recentNearCeiling = this.history
      .slice(-10)
      .filter((h) => h.gwei > ceilingGwei * 0.9).length;

    if (recentNearCeiling > 7) {
      return { anomalous: true, reason: 'gas_ceiling_probing' };
    }

    if (networkMedianGwei && networkMedianGwei > 0 && currentGwei > networkMedianGwei * 5) {
      return { anomalous: true, reason: 'gas_overpay' };
    }

    return { anomalous: false };
  }
}

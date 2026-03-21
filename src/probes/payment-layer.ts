import { statSync, openSync, readSync, closeSync } from 'node:fs';
import type { ProbeResult, GuardianSnapshot, IntentReceipt } from '../types.js';

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

export class PaymentLayerProbe {
  private lastByteOffset = 0;
  private previousLogFileSize = 0;
  private allIntents: Array<IntentReceipt & { _ts: number }> = [];

  constructor(private auditLogPath: string) {}

  async probe(): Promise<ProbeResult<GuardianSnapshot>> {
    const start = Date.now();

    try {
      const stat = statSync(this.auditLogPath);
      const currentSize = stat.size;

      const previousSize = this.previousLogFileSize;

      // Detect truncation (append-only violation)
      if (currentSize < this.lastByteOffset) {
        this.lastByteOffset = 0;
        this.allIntents = [];
      }

      if (currentSize > this.lastByteOffset) {
        const bytesToRead = currentSize - this.lastByteOffset;
        const buf = Buffer.alloc(bytesToRead);
        const fd = openSync(this.auditLogPath, 'r');
        try {
          readSync(fd, buf, 0, bytesToRead, this.lastByteOffset);
        } finally {
          closeSync(fd);
        }

        const newContent = buf.toString('utf-8');
        const lines = newContent.split('\n').filter((l) => l.trim());

        for (const line of lines) {
          try {
            const entry = JSON.parse(line) as IntentReceipt & { _ts?: number; timestamp?: number };
            this.allIntents.push({
              ...entry,
              _ts: entry._ts ?? entry.timestamp ?? Date.now(),
            });
          } catch {
            // Skip malformed lines
          }
        }

        this.lastByteOffset = currentSize;
      }

      this.previousLogFileSize = currentSize;

      const now = Date.now();
      const hourAgo = now - ONE_HOUR_MS;
      const dayAgo = now - ONE_DAY_MS;

      const recentIntents = this.allIntents.filter((i) => i._ts > dayAgo);
      const hourlyIntents = recentIntents.filter((i) => i._ts > hourAgo);

      const spendingPerRequest = Math.max(
        ...recentIntents
          .filter((i) => i.status === 'executed')
          .map((i) => i.receipt?.orderQuantity ?? 0),
        0,
      );

      const spendingHourly = hourlyIntents
        .filter((i) => i.status === 'executed')
        .reduce((sum, i) => sum + (i.receipt?.orderQuantity ?? 0) * (i.receipt?.orderPrice ?? 0), 0);

      const spendingDaily = recentIntents
        .filter((i) => i.status === 'executed')
        .reduce((sum, i) => sum + (i.receipt?.orderQuantity ?? 0) * (i.receipt?.orderPrice ?? 0), 0);

      // Prune old intents from memory
      this.allIntents = this.allIntents.filter((i) => i._ts > dayAgo);

      const snapshot: GuardianSnapshot = {
        recentIntents: recentIntents.slice(-100),
        spendingPerRequest,
        spendingHourly,
        spendingDaily,
        logFileSize: currentSize,
        previousLogFileSize: previousSize,
      };

      return {
        ok: true,
        data: snapshot,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        return {
          ok: true,
          data: {
            recentIntents: [],
            spendingPerRequest: 0,
            spendingHourly: 0,
            spendingDaily: 0,
            logFileSize: 0,
            previousLogFileSize: 0,
          },
          latencyMs: Date.now() - start,
        };
      }

      return {
        ok: false,
        error: error.message,
        latencyMs: Date.now() - start,
      };
    }
  }
}

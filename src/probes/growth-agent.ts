import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import type {
  ProbeResult,
  GrowthAgentSnapshot,
  GrowthPlaybookRun,
  GrowthWatchdogFlag,
} from '../types.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

interface AuditEntry {
  entryId?: string;
  timestamp?: number;
  phase?: string;
  playbook?: string;
  actions?: string[];
  dryRun?: boolean;
  detector?: string;
  accountId?: string;
  riskScore?: number;
  tier?: string;
  enforcementAction?: string;
  feeChange?: { symbol: string; oldBps: number; newBps: number };
  referralCodeCreated?: boolean;
  campaignDeployed?: boolean;
}

interface StateFile {
  cycleCount?: number;
  lastCycleAt?: number;
  builderTier?: string;
  dryRun?: boolean;
}

export class GrowthAgentProbe {
  private lastByteOffset = 0;
  private previousAuditLogSize = 0;
  private allEntries: Array<AuditEntry & { _ts: number }> = [];

  constructor(
    private auditLogPath: string,
    private statePath: string,
  ) {}

  async probe(): Promise<ProbeResult<GrowthAgentSnapshot>> {
    const start = Date.now();

    try {
      const state = this.readState();
      const logSize = this.readNewEntries();

      const now = Date.now();
      const dayAgo = now - ONE_DAY_MS;

      // Prune entries older than 24h
      this.allEntries = this.allEntries.filter((e) => e._ts > dayAgo);
      const recentEntries = this.allEntries;

      const playbooksExecuted: GrowthPlaybookRun[] = recentEntries
        .filter((e) => e.phase === 'ACT' && e.playbook)
        .map((e) => ({
          playbook: e.playbook!,
          cycle: state.cycleCount ?? 0,
          timestamp: e._ts,
          actions: e.actions ?? [],
          dryRun: e.dryRun ?? true,
        }));

      const watchdogFlags: GrowthWatchdogFlag[] = recentEntries
        .filter((e) => e.phase === 'WATCHDOG' && e.accountId)
        .map((e) => ({
          accountId: e.accountId!,
          detector: e.detector ?? 'unknown',
          riskScore: e.riskScore ?? 0,
          tier: (e.tier as GrowthWatchdogFlag['tier']) ?? 'CLEAN',
          enforcementAction: e.enforcementAction,
          timestamp: e._ts,
        }));

      const feeChanges = recentEntries
        .filter((e) => e.feeChange)
        .map((e) => ({
          ...e.feeChange!,
          timestamp: e._ts,
        }));

      const referralCodesCreated = recentEntries.filter((e) => e.referralCodeCreated).length;
      const campaignsDeployed = recentEntries.filter((e) => e.campaignDeployed).length;

      const previousSize = this.previousAuditLogSize;
      this.previousAuditLogSize = logSize;

      const snapshot: GrowthAgentSnapshot = {
        lastCycleAt: state.lastCycleAt ?? null,
        cycleCount: state.cycleCount ?? 0,
        dryRun: state.dryRun ?? true,
        builderTier: state.builderTier ?? 'PUBLIC',
        playbooksExecuted,
        watchdogFlags,
        feeChanges,
        referralCodesCreated,
        campaignsDeployed,
        auditLogSize: logSize,
        previousAuditLogSize: previousSize,
      };

      return { ok: true, data: snapshot, latencyMs: Date.now() - start };
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        return {
          ok: true,
          data: {
            lastCycleAt: null,
            cycleCount: 0,
            dryRun: true,
            builderTier: 'PUBLIC',
            playbooksExecuted: [],
            watchdogFlags: [],
            feeChanges: [],
            referralCodesCreated: 0,
            campaignsDeployed: 0,
            auditLogSize: 0,
            previousAuditLogSize: 0,
          },
          latencyMs: Date.now() - start,
        };
      }
      return { ok: false, error: error.message, latencyMs: Date.now() - start };
    }
  }

  private readState(): StateFile {
    try {
      const content = readFileSync(this.statePath, 'utf-8');
      return JSON.parse(content) as StateFile;
    } catch {
      return {};
    }
  }

  /**
   * Reads only new bytes from the audit log since the last probe,
   * matching the incremental pattern used by PaymentLayerProbe.
   */
  private readNewEntries(): number {
    const stat = statSync(this.auditLogPath);
    const currentSize = stat.size;

    // Detect truncation — reset offset
    if (currentSize < this.lastByteOffset) {
      this.lastByteOffset = 0;
      this.allEntries = [];
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
          const entry = JSON.parse(line) as AuditEntry;
          this.allEntries.push({
            ...entry,
            _ts: entry.timestamp ?? Date.now(),
          });
        } catch {
          // skip malformed
        }
      }

      this.lastByteOffset = currentSize;
    }

    return currentSize;
  }
}

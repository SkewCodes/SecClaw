import { statSync, openSync, readSync, closeSync } from 'node:fs';
import type { ProbeResult, ListingSnapshot, ListingEvent, ListingTradeEvent } from '../types.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

interface RawListingLogEntry {
  type: 'list' | 'trade' | 'liquidity_pull';
  eventId?: string;
  agentId?: string;
  marketId?: string;
  baseAsset?: string;
  oracleSource?: string;
  seedLiquidityUSD?: number;
  volumeUSD?: number;
  timestamp?: number;
}

export class ListingProbe {
  private lastByteOffset = 0;
  private previousLogFileSize = 0;
  private listings: (ListingEvent & { _ts: number })[] = [];
  private trades: (ListingTradeEvent & { _ts: number })[] = [];

  constructor(private auditLogPath: string) {}

  async probe(): Promise<ProbeResult<ListingSnapshot>> {
    const start = Date.now();

    try {
      const stat = statSync(this.auditLogPath);
      const currentSize = stat.size;
      const previousSize = this.previousLogFileSize;

      if (currentSize < this.lastByteOffset) {
        this.lastByteOffset = 0;
        this.listings = [];
        this.trades = [];
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
            const entry = JSON.parse(line) as RawListingLogEntry;
            const ts = entry.timestamp ?? Date.now();

            if (entry.type === 'list' && entry.agentId && entry.marketId) {
              this.listings.push({
                eventId: entry.eventId ?? '',
                agentId: entry.agentId,
                marketId: entry.marketId,
                baseAsset: entry.baseAsset ?? '',
                oracleSource: entry.oracleSource ?? '',
                seedLiquidityUSD: entry.seedLiquidityUSD ?? 0,
                timestamp: ts,
                _ts: ts,
              });
            } else if (entry.type === 'trade' && entry.agentId && entry.marketId) {
              this.trades.push({
                agentId: entry.agentId,
                marketId: entry.marketId,
                volumeUSD: entry.volumeUSD ?? 0,
                timestamp: ts,
                _ts: ts,
              });
            } else if (entry.type === 'liquidity_pull' && entry.marketId) {
              const listing = this.listings.find(
                (l) => l.marketId === entry.marketId && !l.liquidityPulledAt,
              );
              if (listing) {
                listing.liquidityPulledAt = ts;
              }
            }
          } catch {
            // Skip malformed lines
          }
        }

        this.lastByteOffset = currentSize;
      }

      this.previousLogFileSize = currentSize;

      const now = Date.now();
      const dayAgo = now - ONE_DAY_MS;

      this.listings = this.listings.filter((l) => l._ts > dayAgo);
      this.trades = this.trades.filter((t) => t._ts > dayAgo);

      const snapshot: ListingSnapshot = {
        recentListings: this.listings.map(({ _ts, ...rest }) => rest),
        recentTrades: this.trades.map(({ _ts, ...rest }) => rest),
        auditLogSize: currentSize,
        previousAuditLogSize: previousSize,
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
            recentListings: [],
            recentTrades: [],
            auditLogSize: 0,
            previousAuditLogSize: 0,
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

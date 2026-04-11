import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ListingProbe } from '../src/probes/listing.js';
import { checkWashListing } from '../src/audit/rules/wash-listing.js';
import { checkCooldownViolation } from '../src/audit/rules/cooldown-violation.js';
import { checkGhostListing } from '../src/audit/rules/ghost-listing.js';
import { loadManifest } from '../src/policy/manifest.js';
import { writeFileSync, mkdirSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SystemSnapshot, PolicyManifest, ListingSnapshot } from '../src/types.js';

let tmpDir: string;

const manifest = loadManifest(join(import.meta.dirname, 'fixtures/test-manifest.yaml'));

beforeEach(() => {
  tmpDir = join(tmpdir(), `secclaw-listing-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeSnapshot(listingData: Partial<ListingSnapshot> = {}): SystemSnapshot {
  return {
    timestamp: Date.now(),
    yieldclaw: { ok: true, latencyMs: 10, data: { status: null, risk: null, positions: [], strategy: null, sharePrice: null, guardianPolicy: null } },
    mm: { ok: true, latencyMs: 10, data: { balance: null, positions: [], safety: null, quality: null, autoTuner: null, riskPreset: null, pair: null } },
    guardian: { ok: true, latencyMs: 10, data: { recentIntents: [], spendingPerRequest: 0, spendingHourly: 0, spendingDaily: 0, logFileSize: 0, previousLogFileSize: 0 } },
    otterclaw: { ok: true, latencyMs: 10, data: { skills: [] } },
    growthAgent: { ok: true, latencyMs: 10, data: { lastCycleAt: null, cycleCount: 0, dryRun: true, builderTier: 'PUBLIC', playbooksExecuted: [], watchdogFlags: [], feeChanges: [], referralCodesCreated: 0, campaignsDeployed: 0, auditLogSize: 0, previousAuditLogSize: 0 } },
    listing: {
      ok: true,
      latencyMs: 10,
      data: {
        recentListings: [],
        recentTrades: [],
        auditLogSize: 0,
        previousAuditLogSize: 0,
        ...listingData,
      },
    },
  };
}

// ─── ListingProbe ───────────────────────────────────────────

describe('ListingProbe', () => {
  it('returns empty data when log file does not exist', async () => {
    const probe = new ListingProbe(join(tmpDir, 'nonexistent.jsonl'));
    const result = await probe.probe();
    expect(result.ok).toBe(true);
    expect(result.data!.recentListings).toHaveLength(0);
    expect(result.data!.recentTrades).toHaveLength(0);
  });

  it('reads listing events from log file', async () => {
    const logPath = join(tmpDir, 'listing.jsonl');
    const entry = {
      type: 'list',
      eventId: 'evt-001',
      agentId: 'agent-1',
      marketId: 'PERP_DOGE_USDC',
      baseAsset: 'DOGE',
      oracleSource: 'pyth',
      seedLiquidityUSD: 5000,
      timestamp: Date.now(),
    };
    writeFileSync(logPath, JSON.stringify(entry) + '\n');

    const probe = new ListingProbe(logPath);
    const result = await probe.probe();
    expect(result.ok).toBe(true);
    expect(result.data!.recentListings).toHaveLength(1);
    expect(result.data!.recentListings[0].marketId).toBe('PERP_DOGE_USDC');
    expect(result.data!.recentListings[0].agentId).toBe('agent-1');
  });

  it('reads trade events from log file', async () => {
    const logPath = join(tmpDir, 'listing.jsonl');
    const entry = {
      type: 'trade',
      agentId: 'agent-1',
      marketId: 'PERP_DOGE_USDC',
      volumeUSD: 1500,
      timestamp: Date.now(),
    };
    writeFileSync(logPath, JSON.stringify(entry) + '\n');

    const probe = new ListingProbe(logPath);
    const result = await probe.probe();
    expect(result.ok).toBe(true);
    expect(result.data!.recentTrades).toHaveLength(1);
    expect(result.data!.recentTrades[0].volumeUSD).toBe(1500);
  });

  it('tracks liquidity pull events', async () => {
    const logPath = join(tmpDir, 'listing.jsonl');
    const now = Date.now();

    const listing = JSON.stringify({
      type: 'list', eventId: 'evt-1', agentId: 'agent-1', marketId: 'PERP_XYZ_USDC',
      baseAsset: 'XYZ', oracleSource: 'pyth', seedLiquidityUSD: 2000, timestamp: now,
    });
    const pull = JSON.stringify({
      type: 'liquidity_pull', marketId: 'PERP_XYZ_USDC', timestamp: now + 60_000,
    });

    writeFileSync(logPath, listing + '\n' + pull + '\n');

    const probe = new ListingProbe(logPath);
    const result = await probe.probe();
    expect(result.data!.recentListings[0].liquidityPulledAt).toBe(now + 60_000);
  });

  it('reads incrementally on subsequent probes', async () => {
    const logPath = join(tmpDir, 'listing.jsonl');
    const mkEntry = (id: string) => JSON.stringify({
      type: 'list', eventId: id, agentId: 'agent-1', marketId: `M-${id}`,
      baseAsset: 'X', oracleSource: 'pyth', seedLiquidityUSD: 1000, timestamp: Date.now(),
    });

    writeFileSync(logPath, mkEntry('1') + '\n');
    const probe = new ListingProbe(logPath);
    const r1 = await probe.probe();
    expect(r1.data!.recentListings).toHaveLength(1);

    appendFileSync(logPath, mkEntry('2') + '\n');
    const r2 = await probe.probe();
    expect(r2.data!.recentListings).toHaveLength(2);
  });

  it('detects log truncation and resets', async () => {
    const logPath = join(tmpDir, 'listing.jsonl');
    const mkEntry = (id: string) => JSON.stringify({
      type: 'list', eventId: id, agentId: 'agent-1', marketId: `M-${id}`,
      baseAsset: 'X', oracleSource: 'pyth', seedLiquidityUSD: 1000, timestamp: Date.now(),
    });

    writeFileSync(logPath, mkEntry('1') + '\n' + mkEntry('2') + '\n');
    const probe = new ListingProbe(logPath);
    await probe.probe();

    writeFileSync(logPath, mkEntry('3') + '\n');
    const r2 = await probe.probe();
    expect(r2.ok).toBe(true);
    expect(r2.data!.recentListings.some((l) => l.eventId === '3')).toBe(true);
  });
});

// ─── Wash Listing Rule ──────────────────────────────────────

describe('checkWashListing', () => {
  it('flags when self-volume exceeds threshold', () => {
    const now = Date.now();
    const snapshot = makeSnapshot({
      recentListings: [{
        eventId: 'evt-1', agentId: 'agent-1', marketId: 'PERP_DOGE_USDC',
        baseAsset: 'DOGE', oracleSource: 'pyth', seedLiquidityUSD: 5000, timestamp: now - 60_000,
      }],
      recentTrades: [
        { agentId: 'agent-1', marketId: 'PERP_DOGE_USDC', volumeUSD: 6000, timestamp: now },
        { agentId: 'agent-2', marketId: 'PERP_DOGE_USDC', volumeUSD: 4000, timestamp: now },
      ],
    });

    const alerts = checkWashListing(snapshot, manifest);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].check).toBe('wash_listing_suspected');
    expect(alerts[0].severity).toBe('critical');
  });

  it('no alert when self-volume is under threshold', () => {
    const now = Date.now();
    const snapshot = makeSnapshot({
      recentListings: [{
        eventId: 'evt-1', agentId: 'agent-1', marketId: 'PERP_DOGE_USDC',
        baseAsset: 'DOGE', oracleSource: 'pyth', seedLiquidityUSD: 5000, timestamp: now - 60_000,
      }],
      recentTrades: [
        { agentId: 'agent-1', marketId: 'PERP_DOGE_USDC', volumeUSD: 2000, timestamp: now },
        { agentId: 'agent-2', marketId: 'PERP_DOGE_USDC', volumeUSD: 8000, timestamp: now },
      ],
    });

    const alerts = checkWashListing(snapshot, manifest);
    expect(alerts).toHaveLength(0);
  });

  it('no alert when listing policy is disabled', () => {
    const disabledManifest = { ...manifest, listing: { ...manifest.listing!, enabled: false } } as PolicyManifest;
    const snapshot = makeSnapshot({
      recentListings: [{
        eventId: 'evt-1', agentId: 'agent-1', marketId: 'M1',
        baseAsset: 'X', oracleSource: 'pyth', seedLiquidityUSD: 1000, timestamp: Date.now(),
      }],
      recentTrades: [
        { agentId: 'agent-1', marketId: 'M1', volumeUSD: 10000, timestamp: Date.now() },
      ],
    });

    const alerts = checkWashListing(snapshot, disabledManifest);
    expect(alerts).toHaveLength(0);
  });
});

// ─── Cooldown Violation Rule ────────────────────────────────

describe('checkCooldownViolation', () => {
  it('flags trades inside the cooldown window', () => {
    const now = Date.now();
    const listTime = now - 100_000; // 100s ago (cooldown is 300s)
    const snapshot = makeSnapshot({
      recentListings: [{
        eventId: 'evt-1', agentId: 'agent-1', marketId: 'PERP_DOGE_USDC',
        baseAsset: 'DOGE', oracleSource: 'pyth', seedLiquidityUSD: 5000, timestamp: listTime,
      }],
      recentTrades: [
        { agentId: 'agent-1', marketId: 'PERP_DOGE_USDC', volumeUSD: 1000, timestamp: listTime + 60_000 },
      ],
    });

    const alerts = checkCooldownViolation(snapshot, manifest);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].check).toBe('listing_cooldown_violation');
    expect(alerts[0].severity).toBe('high');
  });

  it('no alert when trade is after cooldown', () => {
    const now = Date.now();
    const listTime = now - 600_000; // 600s ago (well past 300s cooldown)
    const snapshot = makeSnapshot({
      recentListings: [{
        eventId: 'evt-1', agentId: 'agent-1', marketId: 'PERP_DOGE_USDC',
        baseAsset: 'DOGE', oracleSource: 'pyth', seedLiquidityUSD: 5000, timestamp: listTime,
      }],
      recentTrades: [
        { agentId: 'agent-1', marketId: 'PERP_DOGE_USDC', volumeUSD: 1000, timestamp: listTime + 400_000 },
      ],
    });

    const alerts = checkCooldownViolation(snapshot, manifest);
    expect(alerts).toHaveLength(0);
  });

  it('only flags the listing agent, not other traders', () => {
    const now = Date.now();
    const listTime = now - 100_000;
    const snapshot = makeSnapshot({
      recentListings: [{
        eventId: 'evt-1', agentId: 'agent-1', marketId: 'PERP_DOGE_USDC',
        baseAsset: 'DOGE', oracleSource: 'pyth', seedLiquidityUSD: 5000, timestamp: listTime,
      }],
      recentTrades: [
        { agentId: 'agent-2', marketId: 'PERP_DOGE_USDC', volumeUSD: 1000, timestamp: listTime + 60_000 },
      ],
    });

    const alerts = checkCooldownViolation(snapshot, manifest);
    expect(alerts).toHaveLength(0);
  });
});

// ─── Ghost Listing Rule ─────────────────────────────────────

describe('checkGhostListing', () => {
  it('flags listing with insufficient seed liquidity after grace period', () => {
    const now = Date.now();
    const snapshot = makeSnapshot({
      recentListings: [{
        eventId: 'evt-1', agentId: 'agent-1', marketId: 'PERP_GHOST_USDC',
        baseAsset: 'GHOST', oracleSource: 'pyth',
        seedLiquidityUSD: 100, // below 1000 minimum
        timestamp: now - 15 * 60 * 1000, // 15 min ago (past 10min grace)
      }],
    });
    snapshot.timestamp = now;

    const alerts = checkGhostListing(snapshot, manifest);
    const ghost = alerts.find((a) => a.check === 'ghost_listing');
    expect(ghost).toBeDefined();
    expect(ghost!.severity).toBe('high');
  });

  it('no alert for listing still within grace period', () => {
    const now = Date.now();
    const snapshot = makeSnapshot({
      recentListings: [{
        eventId: 'evt-1', agentId: 'agent-1', marketId: 'PERP_GHOST_USDC',
        baseAsset: 'GHOST', oracleSource: 'pyth',
        seedLiquidityUSD: 0,
        timestamp: now - 5 * 60 * 1000, // 5 min ago (within 10min grace)
      }],
    });
    snapshot.timestamp = now;

    const alerts = checkGhostListing(snapshot, manifest);
    const ghost = alerts.find((a) => a.check === 'ghost_listing');
    expect(ghost).toBeUndefined();
  });

  it('flags listing where liquidity was pulled quickly', () => {
    const now = Date.now();
    const listTime = now - 60 * 60 * 1000;
    const snapshot = makeSnapshot({
      recentListings: [{
        eventId: 'evt-1', agentId: 'agent-1', marketId: 'PERP_RUG_USDC',
        baseAsset: 'RUG', oracleSource: 'pyth',
        seedLiquidityUSD: 5000,
        timestamp: listTime,
        liquidityPulledAt: listTime + 5 * 60 * 1000, // pulled 5min after listing
      }],
    });
    snapshot.timestamp = now;

    const alerts = checkGhostListing(snapshot, manifest);
    const pullAlert = alerts.find((a) => a.check === 'ghost_listing' && a.severity === 'critical');
    expect(pullAlert).toBeDefined();
  });

  it('flags seed liquidity exceeding max cap', () => {
    const now = Date.now();
    const snapshot = makeSnapshot({
      recentListings: [{
        eventId: 'evt-1', agentId: 'agent-1', marketId: 'PERP_BIG_USDC',
        baseAsset: 'BIG', oracleSource: 'pyth',
        seedLiquidityUSD: 100_000, // exceeds 50k cap
        timestamp: now - 60_000,
      }],
    });
    snapshot.timestamp = now;

    const alerts = checkGhostListing(snapshot, manifest);
    const capAlert = alerts.find((a) => a.check === 'seed_liquidity_exceeded');
    expect(capAlert).toBeDefined();
    expect(capAlert!.severity).toBe('warning');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { gate, createGateSharedState, type GateContext } from '../src/gate/index.js';
import { checkListingCooldown } from '../src/gate/listing-cooldown.js';
import { SecClawEventEmitter } from '../src/events/emitter.js';
import { AlertBus } from '../src/alerts/bus.js';
import { resetAttestationState } from '../src/gate/dependency-attestor.js';
import { existsSync, unlinkSync } from 'node:fs';
import type { GateRequest, GateSharedState, PolicyManifest, SecClawConfig, ListingEvent } from '../src/types.js';
import { loadManifest } from '../src/policy/manifest.js';
import { join } from 'node:path';

const testLogPath = './test-listing-gate-v2.jsonl';

function makeConfig(overrides?: Partial<SecClawConfig>): SecClawConfig {
  return {
    manifestPath: './policy-manifest.yaml',
    once: false,
    dryRun: false,
    verbose: false,
    auditMode: false,
    pollIntervalSec: 30,
    logPath: './test.jsonl',
    yieldclaw: { baseUrl: '', healthToken: '', adminToken: '' },
    mm: { accountId: '', network: 'testnet', statusUrl: '' },
    otterclaw: { skillsPath: '', partnerSkillsPath: '' },
    guardian: { auditLogPath: '' },
    telegram: { botToken: '', chatId: '' },
    pauseSignal: { enabled: false, port: 9999 },
    growthAgent: { auditLogPath: '', statePath: '' },
    listing: { auditLogPath: '' },
    webhook: { url: '' },
    healthPort: 9090,
    healthToken: '',
    vaultDecimals: 6,
    ...overrides,
  } as SecClawConfig;
}

function makeRequest(overrides?: Partial<GateRequest>): GateRequest {
  return {
    agent_id: 'test-agent',
    action_type: 'sign',
    payload: {
      to: '0x1234567890abcdef1234567890abcdef12345678',
      data: '0xabcdef00',
      value: '1000',
      gas_limit: 200000,
      gas_price: '100000000000',
      tool_name: 'place_order',
      tool_params: { market_id: 'PERP_DOGE_USDC' },
    },
    ...overrides,
  };
}

function makeListing(overrides?: Partial<ListingEvent>): ListingEvent {
  return {
    eventId: 'evt-1',
    agentId: 'test-agent',
    marketId: 'PERP_DOGE_USDC',
    baseAsset: 'DOGE',
    oracleSource: 'pyth',
    seedLiquidityUSD: 5000,
    timestamp: Date.now() - 60_000, // 60s ago (within 300s cooldown)
    ...overrides,
  };
}

describe('Listing Cooldown Gate Module', () => {
  let manifest: PolicyManifest;

  beforeEach(() => {
    manifest = loadManifest(join(import.meta.dirname, 'fixtures/test-manifest.yaml'));
  });

  it('skips when listing policy is not configured', () => {
    const noListingManifest = { ...manifest } as PolicyManifest;
    delete (noListingManifest as Record<string, unknown>)['listing'];

    const sharedState = createGateSharedState();
    const result = checkListingCooldown(makeRequest(), noListingManifest, sharedState);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].result).toBe('skip');
  });

  it('skips when request has no market_id', () => {
    const sharedState = createGateSharedState();
    const request = makeRequest({ payload: { to: '0x123', value: '100' } });
    const result = checkListingCooldown(request, manifest, sharedState);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].result).toBe('skip');
  });

  it('blocks trade on self-listed market within cooldown', () => {
    const sharedState = createGateSharedState();
    sharedState.recentListings = [makeListing()];

    const result = checkListingCooldown(makeRequest(), manifest, sharedState);

    const blockEntry = result.entries.find((e) => e.result === 'block');
    expect(blockEntry).toBeDefined();
    expect(blockEntry!.module).toBe('listing_watchdog');

    const blockEvent = result.events.find((e) => e.action === 'block');
    expect(blockEvent).toBeDefined();
    expect(blockEvent!.severity).toBe('critical');
  });

  it('passes when cooldown has elapsed', () => {
    const sharedState = createGateSharedState();
    sharedState.recentListings = [makeListing({
      timestamp: Date.now() - 400_000, // 400s ago (past 300s cooldown)
    })];

    const result = checkListingCooldown(makeRequest(), manifest, sharedState);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].result).toBe('pass');
  });

  it('passes when a different agent listed the market', () => {
    const sharedState = createGateSharedState();
    sharedState.recentListings = [makeListing({ agentId: 'other-agent' })];

    const result = checkListingCooldown(makeRequest(), manifest, sharedState);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].result).toBe('pass');
  });

  it('passes when the agent listed a different market', () => {
    const sharedState = createGateSharedState();
    sharedState.recentListings = [makeListing({ marketId: 'PERP_OTHER_USDC' })];

    const result = checkListingCooldown(makeRequest(), manifest, sharedState);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].result).toBe('pass');
  });
});

describe('Listing Cooldown in Full Gate Pipeline', () => {
  let manifest: PolicyManifest;
  let ctx: GateContext;

  beforeEach(() => {
    manifest = loadManifest(join(import.meta.dirname, 'fixtures/test-manifest.yaml'));
    resetAttestationState();

    ctx = {
      manifest,
      config: makeConfig(),
      sharedState: createGateSharedState(),
      emitter: new SecClawEventEmitter(testLogPath),
      alertBus: new AlertBus(),
    };
  });

  afterEach(() => {
    if (existsSync(testLogPath)) unlinkSync(testLogPath);
  });

  it('blocks via full gate when cooldown is active', async () => {
    ctx.sharedState.recentListings = [makeListing()];

    const response = await gate(makeRequest(), ctx);

    expect(response.allowed).toBe(false);
    expect(response.reason).toContain('cooldown');
    const cooldownCheck = response.checks_performed.find(
      (c) => c.module === 'listing_watchdog' && c.check === 'listing_cooldown',
    );
    expect(cooldownCheck).toBeDefined();
    expect(cooldownCheck!.result).toBe('block');
  });

  it('passes via full gate when no listings in shared state', async () => {
    const response = await gate(makeRequest(), ctx);
    expect(response.allowed).toBe(true);
  });

  it('audit mode allows through even with cooldown violation', async () => {
    ctx.config = makeConfig({ auditMode: true });
    ctx.sharedState.recentListings = [makeListing()];

    const response = await gate(makeRequest(), ctx);

    expect(response.allowed).toBe(true);
    expect(response.event.action).toBe('alert');
  });
});

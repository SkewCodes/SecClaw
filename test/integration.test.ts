import { describe, it, expect, afterEach } from 'vitest';
import { loadManifest } from '../src/policy/manifest.js';
import { gate, createGateSharedState, type GateContext } from '../src/gate/index.js';
import { SecClawEventEmitter } from '../src/events/emitter.js';
import { AlertBus } from '../src/alerts/bus.js';
import { checkSignerHealth, resetSignerContexts } from '../src/gate/signer-health.js';
import { resetAttestationState } from '../src/gate/dependency-attestor.js';
import { existsSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GateRequest, SecClawConfig, AlertHandler, Alert } from '../src/types.js';

const testV2LogPath = './test-integration-v2.jsonl';

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

describe('Backward Compatibility', () => {
  it('loads V1 manifest (version 1.0) without any V2 sections', () => {
    const manifest = loadManifest(join(import.meta.dirname, 'fixtures/test-manifest.yaml'));

    expect(manifest.version).toBe('1.0');
    expect(manifest.yieldclaw).toBeTruthy();
    expect(manifest.payment_layer).toBeTruthy();
    expect(manifest.otterclaw).toBeTruthy();
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.signer).toBeUndefined();
    expect(manifest.contracts).toBeUndefined();
    expect(manifest.oracle).toBeUndefined();
    expect(manifest.mcp_tools).toBeUndefined();
  });

  it('loads V1 manifest and gate defaults to skip all V2 checks', async () => {
    const manifest = loadManifest(join(import.meta.dirname, 'fixtures/test-manifest.yaml'));
    resetAttestationState();

    const ctx: GateContext = {
      manifest,
      config: makeConfig(),
      sharedState: createGateSharedState(),
      emitter: new SecClawEventEmitter(testV2LogPath),
      alertBus: new AlertBus(),
    };

    const request: GateRequest = {
      agent_id: 'test',
      action_type: 'sign',
      payload: { to: '0x123', value: '100' },
    };

    const response = await gate(request, ctx);

    expect(response.allowed).toBe(true);
    const skipped = response.checks_performed.filter((c) => c.result === 'skip');
    expect(skipped.length).toBeGreaterThan(0);
  });

  afterEach(() => {
    resetAttestationState();
    resetSignerContexts();
    if (existsSync(testV2LogPath)) unlinkSync(testV2LogPath);
  });
});

describe('Daemon + Gate Integration', () => {
  class CollectorHandler implements AlertHandler {
    received: Alert[] = [];
    async handle(alert: Alert): Promise<void> {
      this.received.push(alert);
    }
  }

  afterEach(() => {
    resetAttestationState();
    resetSignerContexts();
    if (existsSync(testV2LogPath)) unlinkSync(testV2LogPath);
  });

  it('gate events flow through AlertBus to handlers', async () => {
    const manifest = loadManifest(join(import.meta.dirname, 'fixtures/test-manifest.yaml'));
    const bus = new AlertBus();
    const collector = new CollectorHandler();
    bus.register(collector);

    const manifestWithDeps = {
      ...manifest,
      dependencies: {
        attestation: 'strict' as const,
        attestation_path: './nonexistent.json',
        blocked_packages: [],
        drift_action: 'block' as const,
      },
    };

    resetAttestationState();
    const ctx: GateContext = {
      manifest: manifestWithDeps,
      config: makeConfig(),
      sharedState: createGateSharedState(),
      emitter: new SecClawEventEmitter(testV2LogPath),
      alertBus: bus,
    };

    const request: GateRequest = {
      agent_id: 'test',
      action_type: 'sign',
      payload: { to: '0x123', value: '100' },
    };

    const response = await gate(request, ctx);

    expect(response.allowed).toBe(false);
    expect(collector.received.length).toBeGreaterThan(0);
    expect(collector.received.some((a) => a.source.startsWith('v2:'))).toBe(true);
  });

  it('V2 events write to dedicated JSONL file', async () => {
    const manifest = loadManifest(join(import.meta.dirname, 'fixtures/test-manifest.yaml'));
    resetAttestationState();

    const ctx: GateContext = {
      manifest,
      config: makeConfig(),
      sharedState: createGateSharedState(),
      emitter: new SecClawEventEmitter(testV2LogPath),
      alertBus: new AlertBus(),
    };

    const request: GateRequest = {
      agent_id: 'test',
      action_type: 'sign',
      payload: { to: '0x123', value: '100' },
    };

    await gate(request, ctx);

    expect(existsSync(testV2LogPath)).toBe(true);
    const content = readFileSync(testV2LogPath, 'utf-8').trim();
    const lines = content.split('\n');
    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      const event = JSON.parse(line);
      expect(event.version).toBe('2.0');
      expect(event.agent_id).toBe('test');
    }
  });

  it('gate with signer health runs all checks end-to-end', async () => {
    const manifest = loadManifest(join(import.meta.dirname, 'fixtures/test-manifest.yaml'));
    resetAttestationState();

    const signerPolicy = {
      immutable: {
        cumulative_exposure_ceiling_usd: 100000,
        balance_minimum_eth: 0.01,
        nonce_mode: 'warn' as const,
        nonce_persistence_path: './.secclaw-test-integ/nonce.json',
        rate_limits_ceiling: { per_minute: 50, per_day: 2000 },
        min_cooldown_ms: 0,
        gas_ceiling_gwei: 500,
        gas_limit_ceiling: 1000000,
        modification_delay_sec: 300,
        critical_alert_lock: true,
        max_override_duration_sec: 3600,
        multi_approval_threshold_pct: 50,
        multi_approval_operators: 2,
        ceiling_to_default_max_ratio: 10,
      },
      rate_limits: { per_minute: 10, per_hour: 100, per_day: 500 },
      cooldown_ms: 0,
      cumulative_exposure: { window: '1h', max_window: '4h', max_usd: 50000 },
      gas: { max_price_gwei: 100, max_limit: 500000, price_mode: 'dynamic' as const },
      acceleration_detection: false,
      target_switch_detection: false,
      agent_overridable: [],
      profiles: {},
      conditional_auto_approvals: [],
      approval: {
        channels: [],
        auto_reject_after_sec: 300,
        require_auth: true,
        auth_method: 'api_key' as const,
      },
    };

    const fullManifest = { ...manifest, signer: signerPolicy };

    const ctx: GateContext = {
      manifest: fullManifest,
      config: makeConfig(),
      sharedState: createGateSharedState(),
      emitter: new SecClawEventEmitter(testV2LogPath),
      alertBus: new AlertBus(),
      signerHealthCheck: checkSignerHealth,
    };

    const request: GateRequest = {
      agent_id: 'integ-test',
      action_type: 'sign',
      payload: {
        to: '0x1234567890abcdef1234567890abcdef12345678',
        data: '0xabcdef00',
        value: '100',
        gas_limit: 200000,
        gas_price: '50000000000',
      },
    };

    const response = await gate(request, ctx);

    expect(response.allowed).toBe(true);
    expect(response.checks_performed.length).toBeGreaterThanOrEqual(4);

    const modules = response.checks_performed.map((c) => c.module);
    expect(modules).toContain('dependency_attestor');
    expect(modules).toContain('signer_health');
  });

  it('shared state propagates critical alerts from daemon to gate', async () => {
    const manifest = loadManifest(join(import.meta.dirname, 'fixtures/test-manifest.yaml'));
    resetAttestationState();

    const sharedState = createGateSharedState();
    sharedState.activeCriticalAlerts.add('daemon-alert-001');
    sharedState.activeCriticalAlerts.add('daemon-alert-002');

    expect(sharedState.activeCriticalAlerts.size).toBe(2);

    const ctx: GateContext = {
      manifest,
      config: makeConfig(),
      sharedState,
      emitter: new SecClawEventEmitter(testV2LogPath),
      alertBus: new AlertBus(),
    };

    const request: GateRequest = {
      agent_id: 'test',
      action_type: 'sign',
      payload: { to: '0x123', value: '100' },
    };

    const response = await gate(request, ctx);
    expect(response.allowed).toBe(true);
    expect(ctx.sharedState.activeCriticalAlerts.size).toBe(2);
  });
});

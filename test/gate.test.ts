import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { gate, createGateSharedState, type GateContext } from '../src/gate/index.js';
import { SecClawEventEmitter } from '../src/events/emitter.js';
import { AlertBus } from '../src/alerts/bus.js';
import { resetAttestationState } from '../src/gate/dependency-attestor.js';
import { existsSync, unlinkSync } from 'node:fs';
import type { GateRequest, PolicyManifest, SecClawConfig } from '../src/types.js';
import { loadManifest } from '../src/policy/manifest.js';
import { join } from 'node:path';

const testLogPath = './test-gate-v2.jsonl';

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
    },
    ...overrides,
  };
}

describe('Gate Orchestrator', () => {
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

  it('passes when no V2 policies are configured (V1 manifest)', async () => {
    const response = await gate(makeRequest(), ctx);

    expect(response.allowed).toBe(true);
    expect(response.event.action).toBe('pass');
    expect(response.checks_performed.length).toBeGreaterThan(0);
    expect(response.checks_performed.every((c) => c.result === 'skip' || c.result === 'pass')).toBe(true);
  });

  it('returns checks_performed with module and latency', async () => {
    const response = await gate(makeRequest(), ctx);

    for (const check of response.checks_performed) {
      expect(check.module).toBeTruthy();
      expect(check.check).toBeTruthy();
      expect(typeof check.latency_ms).toBe('number');
    }
  });

  it('emits V2 events to the emitter', async () => {
    await gate(makeRequest(), ctx);
    await ctx.emitter.flush();

    const content = existsSync(testLogPath)
      ? require('node:fs').readFileSync(testLogPath, 'utf-8').trim()
      : '';
    expect(content.length).toBeGreaterThan(0);

    const lines = content.split('\n');
    for (const line of lines) {
      const event = JSON.parse(line);
      expect(event.version).toBe('2.0');
    }
  });

  describe('audit mode', () => {
    it('returns allowed=true even when gate would block', async () => {
      ctx.config = makeConfig({ auditMode: true });
      ctx.signerHealthCheck = () => ({
        entries: [{
          module: 'signer_health',
          check: 'rate_limit',
          result: 'block',
          latency_ms: 1,
        }],
        events: [],
      });

      const response = await gate(makeRequest(), ctx);

      expect(response.allowed).toBe(true);
      expect(response.event.action).toBe('alert');
    });

    it('still emits events in audit mode', async () => {
      ctx.config = makeConfig({ auditMode: true });

      const response = await gate(makeRequest(), ctx);

      expect(response.event).toBeTruthy();
      expect(response.event.version).toBe('2.0');
    });
  });

  describe('module short-circuiting', () => {
    it('short-circuits on first block when not in audit mode', async () => {
      let secondModuleCalled = false;

      ctx.signerHealthCheck = () => {
        secondModuleCalled = true;
        return { entries: [], events: [] };
      };

      // Override dep attestor to block by providing a policy with strict attestation
      // that points to non-existent file
      const manifestWithDeps = {
        ...manifest,
        dependencies: {
          attestation: 'strict' as const,
          attestation_path: './nonexistent-attestation.json',
          blocked_packages: [],
          drift_action: 'block' as const,
        },
      };
      ctx.manifest = manifestWithDeps;

      const response = await gate(makeRequest(), ctx);

      expect(response.allowed).toBe(false);
      expect(secondModuleCalled).toBe(false);
    });

    it('continues through all modules in audit mode even on block', async () => {
      let secondModuleCalled = false;

      ctx.config = makeConfig({ auditMode: true });
      ctx.signerHealthCheck = () => {
        secondModuleCalled = true;
        return {
          entries: [{ module: 'signer_health', check: 'test', result: 'pass', latency_ms: 0 }],
          events: [],
        };
      };

      const manifestWithDeps = {
        ...manifest,
        dependencies: {
          attestation: 'strict' as const,
          attestation_path: './nonexistent-attestation.json',
          blocked_packages: [],
          drift_action: 'block' as const,
        },
      };
      ctx.manifest = manifestWithDeps;

      await gate(makeRequest(), ctx);

      expect(secondModuleCalled).toBe(true);
    });
  });
});

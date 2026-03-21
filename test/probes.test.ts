import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PaymentLayerProbe } from '../src/probes/payment-layer.js';
import { GrowthAgentProbe } from '../src/probes/growth-agent.js';
import { writeFileSync, mkdirSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `secclaw-probe-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('PaymentLayerProbe', () => {
  it('returns empty data when log file does not exist', async () => {
    const probe = new PaymentLayerProbe(join(tmpDir, 'nonexistent.jsonl'));
    const result = await probe.probe();
    expect(result.ok).toBe(true);
    expect(result.data!.recentIntents).toHaveLength(0);
    expect(result.data!.logFileSize).toBe(0);
  });

  it('reads intents from log file', async () => {
    const logPath = join(tmpDir, 'guardian.jsonl');
    const intent = {
      intentId: 'int-001',
      action: 'place_order',
      status: 'executed',
      tier: 'session',
      policyResult: 'approved',
      timestamp: Date.now(),
      receipt: { orderId: 1, orderPrice: 3000, orderQuantity: 2, executedAt: Date.now() },
    };
    writeFileSync(logPath, JSON.stringify(intent) + '\n');

    const probe = new PaymentLayerProbe(logPath);
    const result = await probe.probe();
    expect(result.ok).toBe(true);
    expect(result.data!.recentIntents).toHaveLength(1);
    expect(result.data!.recentIntents[0].intentId).toBe('int-001');
  });

  it('reads incrementally on subsequent probes', async () => {
    const logPath = join(tmpDir, 'guardian.jsonl');
    const makeIntent = (id: string) => JSON.stringify({
      intentId: id, action: 'place_order', status: 'executed', tier: 'session',
      timestamp: Date.now(), receipt: { orderPrice: 100, orderQuantity: 1, executedAt: Date.now() },
    });

    writeFileSync(logPath, makeIntent('int-1') + '\n');

    const probe = new PaymentLayerProbe(logPath);
    const r1 = await probe.probe();
    expect(r1.data!.recentIntents).toHaveLength(1);

    appendFileSync(logPath, makeIntent('int-2') + '\n');
    const r2 = await probe.probe();
    expect(r2.data!.recentIntents).toHaveLength(2);
  });

  it('detects log truncation and resets', async () => {
    const logPath = join(tmpDir, 'guardian.jsonl');
    const makeIntent = (id: string) => JSON.stringify({
      intentId: id, action: 'place_order', status: 'executed', tier: 'session',
      timestamp: Date.now(), receipt: { orderPrice: 100, orderQuantity: 1, executedAt: Date.now() },
    });

    writeFileSync(logPath, makeIntent('int-1') + '\n' + makeIntent('int-2') + '\n');
    const probe = new PaymentLayerProbe(logPath);
    await probe.probe();

    // Truncate
    writeFileSync(logPath, makeIntent('int-3') + '\n');
    const r2 = await probe.probe();
    expect(r2.ok).toBe(true);
    expect(r2.data!.recentIntents.some((i) => i.intentId === 'int-3')).toBe(true);
  });
});

describe('GrowthAgentProbe', () => {
  it('returns empty data when files do not exist', async () => {
    const probe = new GrowthAgentProbe(join(tmpDir, 'nope.jsonl'), join(tmpDir, 'nope.json'));
    const result = await probe.probe();
    expect(result.ok).toBe(true);
    expect(result.data!.playbooksExecuted).toHaveLength(0);
    expect(result.data!.cycleCount).toBe(0);
  });

  it('reads playbooks from audit log', async () => {
    const auditPath = join(tmpDir, 'audit.jsonl');
    const statePath = join(tmpDir, 'state.json');
    writeFileSync(statePath, JSON.stringify({ cycleCount: 5, lastCycleAt: Date.now(), dryRun: false, builderTier: 'GOLD' }));
    writeFileSync(auditPath, JSON.stringify({
      phase: 'ACT', playbook: 'TIER_PUSH', actions: ['set_fee'], dryRun: false, timestamp: Date.now(),
    }) + '\n');

    const probe = new GrowthAgentProbe(auditPath, statePath);
    const result = await probe.probe();
    expect(result.ok).toBe(true);
    expect(result.data!.playbooksExecuted).toHaveLength(1);
    expect(result.data!.playbooksExecuted[0].playbook).toBe('TIER_PUSH');
    expect(result.data!.builderTier).toBe('GOLD');
    expect(result.data!.cycleCount).toBe(5);
  });

  it('reads watchdog flags', async () => {
    const auditPath = join(tmpDir, 'audit.jsonl');
    const statePath = join(tmpDir, 'state.json');
    writeFileSync(statePath, '{}');
    writeFileSync(auditPath, JSON.stringify({
      phase: 'WATCHDOG', accountId: '0xabc', detector: 'volume_anomaly', riskScore: 85,
      tier: 'RESTRICT', enforcementAction: 'fee_penalize', timestamp: Date.now(),
    }) + '\n');

    const probe = new GrowthAgentProbe(auditPath, statePath);
    const result = await probe.probe();
    expect(result.data!.watchdogFlags).toHaveLength(1);
    expect(result.data!.watchdogFlags[0].tier).toBe('RESTRICT');
  });

  it('reads incrementally on subsequent probes', async () => {
    const auditPath = join(tmpDir, 'audit.jsonl');
    const statePath = join(tmpDir, 'state.json');
    writeFileSync(statePath, '{}');
    writeFileSync(auditPath, JSON.stringify({ phase: 'ACT', playbook: 'P1', timestamp: Date.now() }) + '\n');

    const probe = new GrowthAgentProbe(auditPath, statePath);
    await probe.probe();

    appendFileSync(auditPath, JSON.stringify({ phase: 'ACT', playbook: 'P2', timestamp: Date.now() }) + '\n');
    const r2 = await probe.probe();
    expect(r2.data!.playbooksExecuted).toHaveLength(2);
  });
});

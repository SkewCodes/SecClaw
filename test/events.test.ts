import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSecClawEvent, validateSecClawEvent, SecClawEventSchema } from '../src/events/schema.js';
import { SecClawEventEmitter, secClawEventToAlert, deriveV2LogPath } from '../src/events/emitter.js';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import type { SecClawEvent } from '../src/types.js';

describe('SecClawEvent Schema', () => {
  it('creates a valid V2 event with factory', () => {
    const event = createSecClawEvent({
      source: 'gate',
      agent_id: 'agent-001',
      module: 'dependency_attestor',
      action: 'pass',
      severity: 'info',
      check: 'attestation_verified',
      details: {
        expected: 10,
        actual: 10,
        policy_rule: 'dependencies.attestation',
        message: 'All packages verified',
      },
    });

    expect(event.version).toBe('2.0');
    expect(event.source).toBe('gate');
    expect(event.agent_id).toBe('agent-001');
    expect(event.module).toBe('dependency_attestor');
    expect(event.action).toBe('pass');
    expect(event.severity).toBe('info');
    expect(event.id).toBeTruthy();
    expect(event.trace_id).toBeTruthy();
    expect(event.timestamp).toBeTruthy();
  });

  it('preserves trace_id when provided', () => {
    const traceId = '12345678-1234-1234-1234-123456789012';
    const event = createSecClawEvent({
      source: 'daemon',
      agent_id: 'agent-001',
      module: 'correlator',
      action: 'alert',
      severity: 'warning',
      check: 'test',
      details: { expected: 1, actual: 2, policy_rule: 'test', message: 'test' },
      trace_id: traceId,
    });

    expect(event.trace_id).toBe(traceId);
  });

  it('includes optional execution_context for gate events', () => {
    const event = createSecClawEvent({
      source: 'gate',
      agent_id: 'agent-001',
      module: 'signer_health',
      action: 'block',
      severity: 'critical',
      check: 'gas_limit_exceeded',
      details: { expected: 500000, actual: 1000000, policy_rule: 'signer.gas.max_limit', message: 'test' },
      execution_context: {
        contract_address: '0xABC',
        gas_estimate: 1000000,
      },
    });

    expect(event.execution_context?.contract_address).toBe('0xABC');
    expect(event.execution_context?.gas_estimate).toBe(1000000);
  });

  it('validates events against Zod schema', () => {
    const event = createSecClawEvent({
      source: 'gate',
      agent_id: 'agent-001',
      module: 'dependency_attestor',
      action: 'pass',
      severity: 'info',
      check: 'test',
      details: { expected: 1, actual: 1, policy_rule: 'test', message: 'test' },
    });

    const validated = validateSecClawEvent(event);
    expect(validated.id).toBe(event.id);
  });

  it('rejects invalid events in Zod schema', () => {
    const invalid = { version: '1.0', source: 'unknown' };
    expect(() => validateSecClawEvent(invalid)).toThrow();
  });
});

describe('SecClawEventEmitter', () => {
  const testLogPath = './test-v2-events.jsonl';

  beforeEach(() => {
    if (existsSync(testLogPath)) unlinkSync(testLogPath);
  });

  afterEach(() => {
    if (existsSync(testLogPath)) unlinkSync(testLogPath);
  });

  it('writes V2 events to JSONL file', async () => {
    const emitter = new SecClawEventEmitter(testLogPath);
    const event = createSecClawEvent({
      source: 'gate',
      agent_id: 'agent-001',
      module: 'dependency_attestor',
      action: 'pass',
      severity: 'info',
      check: 'test',
      details: { expected: 1, actual: 1, policy_rule: 'test', message: 'test' },
    });

    emitter.emit(event);
    await emitter.flush();

    const content = readFileSync(testLogPath, 'utf-8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.id).toBe(event.id);
    expect(parsed.version).toBe('2.0');
  });

  it('writes multiple events as separate lines', async () => {
    const emitter = new SecClawEventEmitter(testLogPath);
    const events = [
      createSecClawEvent({
        source: 'gate', agent_id: 'a', module: 'dependency_attestor',
        action: 'pass', severity: 'info', check: 'c1',
        details: { expected: 1, actual: 1, policy_rule: 'r', message: 'm' },
      }),
      createSecClawEvent({
        source: 'gate', agent_id: 'a', module: 'signer_health',
        action: 'block', severity: 'critical', check: 'c2',
        details: { expected: 2, actual: 3, policy_rule: 'r', message: 'm' },
      }),
    ];

    emitter.emitAll(events);
    await emitter.flush();

    const lines = readFileSync(testLogPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).check).toBe('c1');
    expect(JSON.parse(lines[1]).check).toBe('c2');
  });
});

describe('Event Bridge', () => {
  it('converts V2 event to V1 alert', () => {
    const event = createSecClawEvent({
      source: 'gate',
      agent_id: 'agent-001',
      module: 'signer_health',
      action: 'block',
      severity: 'critical',
      check: 'rate_limit_exceeded',
      details: {
        expected: 'within per_minute limit',
        actual: 'exhausted',
        policy_rule: 'signer.rate_limits.per_minute',
        message: 'Rate limit exceeded: per_minute bucket exhausted',
      },
    });

    const alert = secClawEventToAlert(event);

    expect(alert.source).toBe('v2:signer_health');
    expect(alert.check).toBe('rate_limit_exceeded');
    expect(alert.severity).toBe('critical');
    expect(alert.message).toBe('Rate limit exceeded: per_minute bucket exhausted');
    expect(alert.data?.v2_event_id).toBe(event.id);
    expect(alert.data?.agent_id).toBe('agent-001');
  });
});

describe('deriveV2LogPath', () => {
  it('converts .jsonl path to -v2.jsonl', () => {
    expect(deriveV2LogPath('./secclaw-audit.jsonl')).toBe('./secclaw-audit-v2.jsonl');
  });

  it('handles path without .jsonl extension', () => {
    expect(deriveV2LogPath('./log')).toBe('./log');
  });
});

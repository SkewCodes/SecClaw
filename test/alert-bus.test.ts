import { describe, it, expect, vi } from 'vitest';
import { AlertBus, createAlert } from '../src/alerts/bus.js';
import { AlertEscalator } from '../src/alerts/escalation.js';
import type { Alert, AlertHandler } from '../src/types.js';

class MockHandler implements AlertHandler {
  received: Alert[] = [];
  async handle(alert: Alert): Promise<void> {
    this.received.push(alert);
  }
}

describe('AlertBus', () => {
  it('routes alerts to registered handlers', async () => {
    const bus = new AlertBus();
    const handler = new MockHandler();
    bus.register(handler);

    const alert = createAlert('test', 'check1', 'warning', 'test message');
    await bus.emit(alert);

    expect(handler.received).toHaveLength(1);
    expect(handler.received[0].message).toBe('test message');
  });

  it('deduplicates alerts within cooldown window', async () => {
    const bus = new AlertBus();
    const handler = new MockHandler();
    bus.register(handler);

    const a1 = createAlert('test', 'check1', 'warning', 'msg');
    const a2 = createAlert('test', 'check1', 'warning', 'msg');

    await bus.emit(a1);
    await bus.emit(a2);

    expect(handler.received).toHaveLength(1);
  });

  it('deduplicates same-check same-symbol alerts', async () => {
    const bus = new AlertBus();
    const handler = new MockHandler();
    bus.register(handler);

    await bus.emit(createAlert('mm', 'position_exceeded', 'high', 'ETH exceeded', { symbol: 'ETH' }));
    await bus.emit(createAlert('mm', 'position_exceeded', 'high', 'ETH exceeded again', { symbol: 'ETH' }));

    expect(handler.received).toHaveLength(1);
  });

  it('allows same-check different-symbol alerts through', async () => {
    const bus = new AlertBus();
    const handler = new MockHandler();
    bus.register(handler);

    await bus.emit(createAlert('mm', 'position_exceeded', 'high', 'ETH exceeded', { symbol: 'ETH' }));
    await bus.emit(createAlert('mm', 'position_exceeded', 'high', 'BTC exceeded', { symbol: 'BTC' }));

    expect(handler.received).toHaveLength(2);
  });

  it('allows different check names through', async () => {
    const bus = new AlertBus();
    const handler = new MockHandler();
    bus.register(handler);

    await bus.emit(createAlert('test', 'check1', 'warning', 'msg1'));
    await bus.emit(createAlert('test', 'check2', 'warning', 'msg2'));

    expect(handler.received).toHaveLength(2);
  });

  it('emitAll sends multiple alerts', async () => {
    const bus = new AlertBus();
    const handler = new MockHandler();
    bus.register(handler);

    await bus.emitAll([
      createAlert('a', 'c1', 'info', 'one'),
      createAlert('b', 'c2', 'warning', 'two'),
      createAlert('c', 'c3', 'high', 'three'),
    ]);

    expect(handler.received).toHaveLength(3);
  });

  it('handles handler errors gracefully', async () => {
    const bus = new AlertBus();
    const failHandler: AlertHandler = {
      async handle() { throw new Error('fail'); },
    };
    const goodHandler = new MockHandler();
    bus.register(failHandler);
    bus.register(goodHandler);

    const alert = createAlert('test', 'c1', 'info', 'msg');
    await bus.emit(alert);

    expect(goodHandler.received).toHaveLength(1);
  });
});

describe('createAlert', () => {
  it('generates unique IDs', () => {
    const a1 = createAlert('src', 'check', 'info', 'msg');
    const a2 = createAlert('src', 'check', 'info', 'msg');
    expect(a1.id).not.toBe(a2.id);
  });

  it('includes all required fields', () => {
    const alert = createAlert('mysource', 'mycheck', 'critical', 'message', { extra: 1 });
    expect(alert.source).toBe('mysource');
    expect(alert.check).toBe('mycheck');
    expect(alert.severity).toBe('critical');
    expect(alert.message).toBe('message');
    expect(alert.data).toEqual({ extra: 1 });
    expect(alert.timestamp).toBeGreaterThan(0);
  });
});

describe('AlertEscalator', () => {
  it('escalates after N consecutive cycles', () => {
    const escalator = new AlertEscalator(3);

    const makeAlerts = () => [createAlert('test', 'check1', 'warning', 'persistent issue')];

    // Cycle 1, 2: no escalation
    expect(escalator.process(makeAlerts())).toHaveLength(0);
    expect(escalator.process(makeAlerts())).toHaveLength(0);

    // Cycle 3: escalation triggers
    const escalations = escalator.process(makeAlerts());
    expect(escalations).toHaveLength(1);
    expect(escalations[0].severity).toBe('high');
    expect(escalations[0].check).toBe('check1_escalated');
  });

  it('resets counter when alert disappears', () => {
    const escalator = new AlertEscalator(3);

    const alert = () => [createAlert('test', 'check1', 'warning', 'msg')];

    escalator.process(alert());
    escalator.process(alert());
    escalator.process([]); // alert disappears
    escalator.process(alert()); // restart count

    // Should not escalate yet (only 1 since reset)
    const result = escalator.process(alert());
    expect(result).toHaveLength(0);
  });

  it('does not escalate already-critical alerts', () => {
    const escalator = new AlertEscalator(2);

    const alert = () => [createAlert('test', 'check1', 'critical', 'msg')];

    escalator.process(alert());
    const result = escalator.process(alert());
    expect(result).toHaveLength(0);
  });
});

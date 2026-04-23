import { describe, it, expect } from 'vitest';
import { AlertBus, createAlert } from '../src/alerts/bus.js';
import { AlertEscalator, isSupplyChainSource } from '../src/alerts/escalation.js';
import type { Alert, AlertHandler } from '../src/types.js';

class MockHandler implements AlertHandler {
  received: Alert[] = [];
  async handle(alert: Alert): Promise<void> {
    this.received.push(alert);
  }
}

describe('Supply chain alert escalation rework', () => {
  describe('isSupplyChainSource', () => {
    it('identifies supply-chain sources', () => {
      expect(isSupplyChainSource('supply-chain')).toBe(true);
      expect(isSupplyChainSource('supply-chain.worm')).toBe(true);
      expect(isSupplyChainSource('supply-chain.hook')).toBe(true);
    });

    it('does not match non-supply-chain sources', () => {
      expect(isSupplyChainSource('yieldclaw')).toBe(false);
      expect(isSupplyChainSource('cross_system')).toBe(false);
      expect(isSupplyChainSource('mm')).toBe(false);
    });
  });

  describe('AlertEscalator — supply chain bypass', () => {
    it('does not cycle-escalate supply-chain alerts', () => {
      const escalator = new AlertEscalator(2);
      const scAlert = () => [createAlert('supply-chain', 'worm_propagation', 'high', 'worm detected')];

      escalator.process(scAlert());
      const result = escalator.process(scAlert());
      expect(result).toHaveLength(0);
    });

    it('still cycle-escalates non-supply-chain alerts', () => {
      const escalator = new AlertEscalator(2);
      const tradingAlert = () => [createAlert('yieldclaw', 'drawdown', 'warning', 'drawdown high')];

      escalator.process(tradingAlert());
      const result = escalator.process(tradingAlert());
      expect(result).toHaveLength(1);
      expect(result[0].severity).toBe('high');
    });

    it('supply-chain alerts emit at final severity on first detection', () => {
      const alert = createAlert('supply-chain', 'worm_propagation', 'critical', 'worm detected');
      expect(alert.severity).toBe('critical');
    });
  });

  describe('AlertBus — supply chain dedup bypass', () => {
    it('bypasses dedup for critical supply-chain alerts', async () => {
      const bus = new AlertBus();
      const handler = new MockHandler();
      bus.register(handler);

      const a1 = createAlert('supply-chain', 'worm_propagation', 'critical', 'first detection');
      const a2 = createAlert('supply-chain', 'worm_propagation', 'critical', 'second detection');

      await bus.emit(a1);
      await bus.emit(a2);

      expect(handler.received).toHaveLength(2);
    });

    it('still deduplicates non-supply-chain critical alerts', async () => {
      const bus = new AlertBus();
      const handler = new MockHandler();
      bus.register(handler);

      const a1 = createAlert('yieldclaw', 'vault_halt', 'critical', 'vault halted');
      const a2 = createAlert('yieldclaw', 'vault_halt', 'critical', 'vault halted again');

      await bus.emit(a1);
      await bus.emit(a2);

      expect(handler.received).toHaveLength(1);
    });

    it('still deduplicates non-critical supply-chain alerts', async () => {
      const bus = new AlertBus();
      const handler = new MockHandler();
      bus.register(handler);

      const a1 = createAlert('supply-chain', 'new_network_endpoints', 'high', 'network detected');
      const a2 = createAlert('supply-chain', 'new_network_endpoints', 'high', 'network detected again');

      await bus.emit(a1);
      await bus.emit(a2);

      expect(handler.received).toHaveLength(1);
    });
  });
});

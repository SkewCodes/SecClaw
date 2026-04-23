import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createOtterClawReceiver } from '../../src/events/otterclaw-receiver.js';
import { checkSkillCliBypass } from '../../src/audit/rules/skill-cli-bypass.js';
import { AlertBus, createAlert } from '../../src/alerts/bus.js';
import { AuditCorrelator } from '../../src/audit/correlator.js';
import type { Alert, AlertHandler, SystemSnapshot, PolicyManifest, OtterClawBridgeEvent } from '../../src/types.js';
import type { Server } from 'node:http';

const TEST_SECRET = 'test-otterclaw-secret-42';
let server: Server;
let port: number;

class CollectorHandler implements AlertHandler {
  received: Alert[] = [];
  async handle(alert: Alert): Promise<void> {
    this.received.push(alert);
  }
}

function makeBridgeEvent(
  overrides: Partial<OtterClawBridgeEvent> = {},
): OtterClawBridgeEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    type: 'skill.cli.blocked',
    skill_id: 'test-skill',
    timestamp: new Date().toISOString(),
    severity: 'warning',
    details: { command: 'npm install evil-pkg' },
    ...overrides,
  };
}

function makeSnapshot(
  otterclawEvents?: OtterClawBridgeEvent[],
  filesystemAccesses?: Array<{ path: string; operation: 'read'; pid: number; process: string; timestamp: number }>,
): SystemSnapshot {
  const base: SystemSnapshot = {
    timestamp: Date.now(),
    yieldclaw: { ok: true, latencyMs: 10 },
    mm: { ok: true, latencyMs: 10 },
    guardian: { ok: true, latencyMs: 10 },
    otterclaw: { ok: true, latencyMs: 10, data: { skills: [] } },
    growthAgent: { ok: true, latencyMs: 10 },
    listing: { ok: true, latencyMs: 10 },
    otterclawEvents,
  };

  if (filesystemAccesses) {
    base.filesystem = {
      ok: true,
      latencyMs: 5,
      data: {
        sensitivePathAccesses: filesystemAccesses,
        modifiedFiles: [],
      },
    };
  }

  return base;
}

async function postEvents(
  events: unknown,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`http://localhost:${port}/events`, {
    method: 'POST',
    headers,
    body: typeof events === 'string' ? events : JSON.stringify(events),
  });

  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('OtterClaw Bridge Integration', () => {
  let collector: CollectorHandler;
  let receivedEvents: OtterClawBridgeEvent[];

  beforeEach(async () => {
    collector = new CollectorHandler();
    receivedEvents = [];

    await new Promise<void>((resolve) => {
      server = createOtterClawReceiver(0, TEST_SECRET, (events) => {
        receivedEvents.push(...events);
      });
      server.once('listening', () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // ─── Auth Validation ───────────────────────────────────────

  describe('Auth validation', () => {
    it('rejects POST without token', async () => {
      const { status, body } = await postEvents([makeBridgeEvent()]);
      expect(status).toBe(401);
      expect(body.error).toBe('Unauthorized');
    });

    it('rejects POST with wrong token', async () => {
      const { status, body } = await postEvents([makeBridgeEvent()], 'wrong-token');
      expect(status).toBe(401);
      expect(body.error).toBe('Unauthorized');
    });

    it('accepts POST with correct token', async () => {
      const { status, body } = await postEvents([makeBridgeEvent()], TEST_SECRET);
      expect(status).toBe(200);
      expect(body.accepted).toBe(1);
    });
  });

  // ─── Batch Ingestion ───────────────────────────────────────

  describe('Batch ingestion', () => {
    it('ingests multiple events in a single batch', async () => {
      const events = [
        makeBridgeEvent({ type: 'skill.cli.blocked', skill_id: 'skill-a' }),
        makeBridgeEvent({ type: 'skill.exec.start', skill_id: 'skill-b', severity: 'info' }),
        makeBridgeEvent({ type: 'skill.capability.violation', skill_id: 'skill-c', severity: 'critical' }),
      ];

      const { status, body } = await postEvents(events, TEST_SECRET);
      expect(status).toBe(200);
      expect(body.accepted).toBe(3);
      expect(receivedEvents).toHaveLength(3);
      expect(receivedEvents.map((e) => e.skill_id)).toEqual(['skill-a', 'skill-b', 'skill-c']);
    });

    it('health check returns 200', async () => {
      const res = await fetch(`http://localhost:${port}/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ status: 'ok' });
    });
  });

  // ─── Malformed Payload Rejection ───────────────────────────

  describe('Malformed payload rejection', () => {
    it('rejects invalid JSON', async () => {
      const { status, body } = await postEvents('not json{{', TEST_SECRET);
      expect(status).toBe(400);
      expect(body.error).toBe('Invalid JSON');
    });

    it('rejects events with missing required fields', async () => {
      const { status, body } = await postEvents([{ id: 'x' }], TEST_SECRET);
      expect(status).toBe(400);
      expect(body.error).toBe('Validation failed');
    });

    it('rejects empty array', async () => {
      const { status, body } = await postEvents([], TEST_SECRET);
      expect(status).toBe(400);
      expect(body.error).toBe('Validation failed');
    });

    it('rejects non-array payloads', async () => {
      const { status, body } = await postEvents({ type: 'skill.cli.blocked' }, TEST_SECRET);
      expect(status).toBe(400);
      expect(body.error).toBe('Validation failed');
    });
  });

  // ─── Correlation Pipeline ──────────────────────────────────

  describe('Correlation pipeline — skill-cli-bypass rule', () => {
    it('skill.cli.blocked yields High alert', () => {
      const snapshot = makeSnapshot([
        makeBridgeEvent({ type: 'skill.cli.blocked', skill_id: 'bad-skill' }),
      ]);

      const alerts = checkSkillCliBypass(snapshot);
      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe('high');
      expect(alerts[0].check).toBe('skill_cli_blocked');
      expect(alerts[0].source).toBe('otterclaw');
    });

    it('skill.capability.violation yields Critical alert', () => {
      const snapshot = makeSnapshot([
        makeBridgeEvent({ type: 'skill.capability.violation', skill_id: 'rogue-skill', severity: 'critical' }),
      ]);

      const alerts = checkSkillCliBypass(snapshot);
      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe('critical');
      expect(alerts[0].check).toBe('skill_capability_violation');
    });

    it('skill.cli.blocked + credential path access escalates to Critical', () => {
      const snapshot = makeSnapshot(
        [makeBridgeEvent({ type: 'skill.cli.blocked', skill_id: 'exfil-skill' })],
        [{ path: '/home/user/.ssh/id_rsa', operation: 'read', pid: 1234, process: 'node', timestamp: Date.now() }],
      );

      const alerts = checkSkillCliBypass(snapshot);
      const escalation = alerts.find((a) => a.check === 'skill_cli_credential_escalation');
      expect(escalation).toBeDefined();
      expect(escalation!.severity).toBe('critical');
    });

    it('no OtterClaw events produces no alerts', () => {
      const snapshot = makeSnapshot(undefined);
      const alerts = checkSkillCliBypass(snapshot);
      expect(alerts).toHaveLength(0);
    });

    it('correlator includes skill-cli-bypass rule', () => {
      const correlator = new AuditCorrelator();
      const snapshot = makeSnapshot([
        makeBridgeEvent({ type: 'skill.capability.violation', skill_id: 'test', severity: 'critical' }),
      ]);

      const manifest = {
        version: '2.0', last_updated: '2026-04-01', updated_by: 'test',
        global: { network: 'testnet', aggregate_exposure_limit_usd: 50000, authorized_wallets: [], known_agent_addresses: [] },
        yieldclaw: { vault_ids: [], hard_limits: { max_drawdown_pct: 5, max_daily_loss_pct: 3, max_leverage: 3, max_position_size_pct: 25, max_concurrent_positions: 1, max_order_frequency_per_min: 10, data_staleness_max_sec: 60 }, withdrawal: { max_per_request_usd: 10000, daily_limit_usd: 50000, cooldown_sec: 300 }, share_price: { max_hourly_change_pct: 5, max_daily_change_pct: 15 }, nav_drift_tolerance_pct: 0.5 },
        payment_layer: { trading: { allowed_symbols: [], max_leverage: 10, max_position_size_usd: 5000, max_open_positions: 3, max_daily_loss_usd: 500, allowed_order_types: ['market'], require_approval_above_usd: 2000 }, swaps: { allowed_tokens: ['USDC'], max_swap_amount_usd: 1000, max_slippage_pct: 0.02 }, vaults: { allowed_vault_ids: [], max_deposit_per_tx_usd: 5000, max_withdraw_per_tx_usd: 1000, daily_withdraw_limit_usd: 3000, cooldown_after_deposit_hours: 24 }, spending: { max_per_request_usd: 1, hourly_limit_usd: 10, daily_limit_usd: 50 }, session: { max_ttl_seconds: 86400, max_consecutive_violations: 5 } },
        otterclaw: { skill_hashes: {}, schema_hash: '', validator_hash: '', cli_binary_hash: '', url_allowlist: [] },
        agentic_mm: { risk_presets: {}, safety: { max_drawdown_pct: 5, volatility_pause_multiplier: 3, funding_guard_threshold_pct: 1, cascade_same_side_fills: 5, cascade_window_sec: 3 }, auto_tuner: { warmup_hours: 2, max_changes_per_24h: 3 }, fill_monitor: { max_poll_age_ms: 2000 } },
        growth_agent: { max_playbooks_per_cycle: 2, allowed_playbooks: [], fee_change_max_bps: 2, builder_tier_floor: 'PUBLIC', watchdog_enforcement_enabled: false, max_fee_changes_per_day: 5, max_campaigns_per_day: 3 },
      } as PolicyManifest;

      const alerts = correlator.correlate(snapshot, manifest);
      const violation = alerts.find((a) => a.check === 'skill_capability_violation');
      expect(violation).toBeDefined();
      expect(violation!.severity).toBe('critical');
    });
  });

  // ─── Full Pipeline (receiver → bus → handler) ─────────────

  describe('Full pipeline — receiver to AlertBus', () => {
    it('receiver bridges security events to AlertBus handlers', async () => {
      const bus = new AlertBus();
      const handler = new CollectorHandler();
      bus.register(handler);

      const bridgedAlerts: Alert[] = [];
      const pipelineServer = createOtterClawReceiver(0, TEST_SECRET, (events) => {
        for (const e of events) {
          if (['skill.cli.blocked', 'skill.capability.violation', 'skill.sandbox.escape'].includes(e.type)) {
            bridgedAlerts.push(createAlert(
              'otterclaw',
              e.type.replace(/\./g, '_'),
              e.severity === 'critical' ? 'critical' : 'high',
              `OtterClaw: ${e.type} for skill ${e.skill_id}`,
              { skill_id: e.skill_id },
            ));
          }
        }
      });

      const pipelinePort = await new Promise<number>((resolve) => {
        pipelineServer.once('listening', () => {
          const addr = pipelineServer.address();
          resolve(typeof addr === 'object' && addr ? addr.port : 0);
        });
      });

      try {
        const events = [
          makeBridgeEvent({ type: 'skill.capability.violation', skill_id: 'rogue', severity: 'critical' }),
          makeBridgeEvent({ type: 'skill.exec.start', skill_id: 'safe', severity: 'info' }),
        ];

        const res = await fetch(`http://localhost:${pipelinePort}/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TEST_SECRET}` },
          body: JSON.stringify(events),
        });
        expect(res.status).toBe(200);

        expect(bridgedAlerts).toHaveLength(1);
        expect(bridgedAlerts[0].check).toBe('skill_capability_violation');
        expect(bridgedAlerts[0].severity).toBe('critical');
      } finally {
        await new Promise<void>((resolve) => pipelineServer.close(() => resolve()));
      }
    });
  });
});

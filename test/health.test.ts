import { describe, it, expect, afterEach } from 'vitest';
import { createHealthServer, type HealthState } from '../src/health.js';
import type { Server } from 'node:http';

function makeHealthState(overrides?: Partial<HealthState>): HealthState {
  return {
    startedAt: Date.now() - 60_000,
    lastTickAt: Date.now() - 5_000,
    lastTickDurationMs: 234,
    tickCount: 10,
    lastAlertCounts: { critical: 0, high: 0, warning: 0, info: 0 },
    lastSnapshot: null,
    pollIntervalSec: 30,
    lastSkillHashes: {},
    lastSkillHashScanAt: null,
    ...overrides,
  };
}

let server: Server | null = null;

function startServer(state: HealthState, token?: string): Promise<number> {
  return new Promise((resolve) => {
    server = createHealthServer(state, 0, token);
    server.on('listening', () => {
      const addr = server!.address();
      if (addr && typeof addr !== 'string') {
        resolve(addr.port);
      }
    });
  });
}

afterEach(() => {
  if (server) {
    server.close();
    server = null;
  }
});

describe('Health Server', () => {
  it('returns 200 with healthy status when ticks have occurred', async () => {
    const state = makeHealthState();
    const p = await startServer(state);
    const res = await fetch(`http://localhost:${p}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('healthy');
    expect(body.version).toBe('2.0.0');
    expect(body.tick_count).toBe(10);
    expect(body.stale).toBe(false);
  });

  it('returns 503 when no ticks have happened', async () => {
    const state = makeHealthState({ tickCount: 0, lastTickAt: null });
    const p = await startServer(state);
    const res = await fetch(`http://localhost:${p}/health`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe('unhealthy');
  });

  it('returns 503 when last tick is stale', async () => {
    const state = makeHealthState({
      lastTickAt: Date.now() - 300_000,
      pollIntervalSec: 30,
    });
    const p = await startServer(state);
    const res = await fetch(`http://localhost:${p}/health`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.stale).toBe(true);
  });

  it('returns 404 for unknown paths', async () => {
    const state = makeHealthState();
    const p = await startServer(state);
    const res = await fetch(`http://localhost:${p}/unknown`);
    expect(res.status).toBe(404);
  });

  it('returns 503 on /status when no snapshot yet', async () => {
    const state = makeHealthState({ lastSnapshot: null });
    const p = await startServer(state);
    const res = await fetch(`http://localhost:${p}/status`);
    expect(res.status).toBe(503);
  });

  it('returns alert counts in health response', async () => {
    const state = makeHealthState({
      lastAlertCounts: { critical: 2, high: 5, warning: 3, info: 1 },
    });
    const p = await startServer(state);
    const res = await fetch(`http://localhost:${p}/health`);
    const body = await res.json();
    expect(body.last_alert_counts.critical).toBe(2);
    expect(body.last_alert_counts.high).toBe(5);
  });

  it('blocks /status when token is configured but not provided', async () => {
    const state = makeHealthState();
    const p = await startServer(state, 'secret-token');
    const res = await fetch(`http://localhost:${p}/status`);
    expect(res.status).toBe(401);
  });

  it('allows /status with Bearer token', async () => {
    const state = makeHealthState();
    const p = await startServer(state, 'secret-token');
    const res = await fetch(`http://localhost:${p}/status`, {
      headers: { Authorization: 'Bearer secret-token' },
    });
    expect(res.status).toBe(503); // 503 because lastSnapshot is null, but not 401
  });

  it('allows /status with query param token', async () => {
    const state = makeHealthState();
    const p = await startServer(state, 'secret-token');
    const res = await fetch(`http://localhost:${p}/status?token=secret-token`);
    expect(res.status).toBe(503); // not 401
  });

  it('allows /status without token when no token is configured', async () => {
    const state = makeHealthState();
    const p = await startServer(state);
    const res = await fetch(`http://localhost:${p}/status`);
    expect(res.status).toBe(503); // not 401
  });
});

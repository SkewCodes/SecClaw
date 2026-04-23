import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { SystemSnapshot, AlertSeverity } from './types.js';

export interface HealthState {
  startedAt: number;
  lastTickAt: number | null;
  lastTickDurationMs: number | null;
  tickCount: number;
  lastAlertCounts: Record<AlertSeverity, number>;
  lastSnapshot: SystemSnapshot | null;
  pollIntervalSec: number;
}

export function createHealthServer(
  state: HealthState,
  port: number,
  statusToken?: string,
): Server {
  const server = createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    if (req.url === '/health' || req.url === '/') {
      handleHealth(state, res);
      return;
    }

    if (req.url === '/status' || req.url?.startsWith('/status?')) {
      if (statusToken && !checkAuth(req, statusToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized — provide Bearer token or ?token= query param' }));
        return;
      }
      handleStatus(state, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(port, () => {
    console.log(`[secclaw] Health endpoint listening on http://localhost:${port}/health`);
  });

  return server;
}

function checkAuth(req: IncomingMessage, token: string): boolean {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ') && authHeader.slice(7) === token) {
    return true;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.searchParams.get('token') === token) {
    return true;
  }

  return false;
}

function handleHealth(state: HealthState, res: ServerResponse): void {
  const now = Date.now();
  const uptimeMs = now - state.startedAt;
  const staleSec = state.lastTickAt ? (now - state.lastTickAt) / 1000 : null;
  const maxStaleSec = state.pollIntervalSec * 3;
  const isStale = staleSec !== null && staleSec > maxStaleSec;

  const probeStatus = state.lastSnapshot ? {
    yieldclaw: state.lastSnapshot.yieldclaw.ok,
    agentic_mm: state.lastSnapshot.mm.ok,
    guardian: state.lastSnapshot.guardian.ok,
    otterclaw: state.lastSnapshot.otterclaw.ok,
    growth_agent: state.lastSnapshot.growthAgent.ok,
  } : null;

  const healthy = !isStale && state.tickCount > 0;
  const statusCode = healthy ? 200 : 503;

  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: healthy ? 'healthy' : 'unhealthy',
    version: '2.0.0',
    uptime_ms: uptimeMs,
    tick_count: state.tickCount,
    last_tick_at: state.lastTickAt ? new Date(state.lastTickAt).toISOString() : null,
    last_tick_duration_ms: state.lastTickDurationMs,
    stale: isStale,
    stale_seconds: staleSec !== null ? Math.round(staleSec) : null,
    poll_interval_sec: state.pollIntervalSec,
    last_alert_counts: state.lastAlertCounts,
    probes: probeStatus,
  }));
}

function handleStatus(state: HealthState, res: ServerResponse): void {
  if (!state.lastSnapshot) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No data yet — waiting for first tick' }));
    return;
  }

  const snap = state.lastSnapshot;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    timestamp: new Date(snap.timestamp).toISOString(),
    yieldclaw: summarizeProbe(snap.yieldclaw),
    agentic_mm: summarizeProbe(snap.mm),
    guardian: summarizeProbe(snap.guardian),
    otterclaw: summarizeProbe(snap.otterclaw),
    growth_agent: summarizeProbe(snap.growthAgent),
    alert_counts: state.lastAlertCounts,
  }));
}

function summarizeProbe(probe: { ok: boolean; error?: string; latencyMs: number }) {
  return {
    ok: probe.ok,
    error: probe.error ?? null,
    latency_ms: probe.latencyMs,
  };
}

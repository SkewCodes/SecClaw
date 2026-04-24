import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import type { OtterClawBridgeEvent } from '../types.js';

const OtterClawBridgeEventSchema = z.object({
  id: z.string().min(1),
  type: z.enum([
    'skill.cli.blocked', 'skill.capability.violation',
    'skill.exec.start', 'skill.exec.end',
    'skill.install.blocked', 'skill.sandbox.escape',
    'skill.network.blocked',
  ]),
  skill_id: z.string().min(1),
  timestamp: z.string().min(1),
  severity: z.enum(['info', 'warning', 'critical']),
  details: z.record(z.unknown()),
});

const BatchSchema = z.array(OtterClawBridgeEventSchema).min(1).max(500);

const MAX_BODY_BYTES = 1_048_576; // 1MB
const MAX_REQUESTS_PER_MINUTE = 60;
const requestCounts = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = requestCounts.get(ip);
  if (!entry || now > entry.resetAt) {
    requestCounts.set(ip, { count: 1, resetAt: now + 60_000 });
    pruneRateLimitMap(now);
    return true;
  }
  entry.count++;
  return entry.count <= MAX_REQUESTS_PER_MINUTE;
}

let lastPruneAt = 0;
function pruneRateLimitMap(now: number): void {
  if (now - lastPruneAt < 60_000) return;
  lastPruneAt = now;
  for (const [ip, entry] of requestCounts) {
    if (now > entry.resetAt) requestCounts.delete(ip);
  }
}

export type OnEventsCallback = (events: OtterClawBridgeEvent[]) => void;

export function createOtterClawReceiver(
  port: number,
  secret: string,
  onEvents: OnEventsCallback,
): Server {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (req.method === 'POST' && req.url === '/events') {
      const ip = req.socket.remoteAddress ?? 'unknown';

      if (!checkRateLimit(ip)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Rate limited' }));
        return;
      }

      if (!checkAuth(req, secret)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      readBody(req, MAX_BODY_BYTES)
        .then((body) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
            return;
          }

          const result = BatchSchema.safeParse(parsed);
          if (!result.success) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: 'Validation failed',
              issues: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
            }));
            return;
          }

          onEvents(result.data as OtterClawBridgeEvent[]);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accepted: result.data.length }));
        })
        .catch(() => {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to read request body' }));
        });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(port, () => {
    console.log(`[secclaw] OtterClaw receiver listening on http://localhost:${port}/events`);
  });

  return server;
}

function checkAuth(req: IncomingMessage, secret: string): boolean {
  const auth = req.headers.authorization;
  return auth === `Bearer ${secret}`;
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

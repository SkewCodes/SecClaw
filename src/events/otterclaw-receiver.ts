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
      if (!checkAuth(req, secret)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      readBody(req)
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

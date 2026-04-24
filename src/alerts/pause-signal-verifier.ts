import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export function signPayload(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export function verifyPauseSignal(req: IncomingMessage, body: string, secret: string): boolean {
  const sig = req.headers['x-secclaw-signature'];
  if (!sig || typeof sig !== 'string') return false;
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  if (sig.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

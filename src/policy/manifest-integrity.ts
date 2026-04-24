import { createHmac, timingSafeEqual } from 'node:crypto';

export function computeManifestHMAC(content: string, key: string): string {
  return createHmac('sha256', key).update(content).digest('hex');
}

export function verifyManifestIntegrity(
  content: string,
  expectedHmac: string,
  key: string,
): boolean {
  const actual = computeManifestHMAC(content, key);
  if (actual.length !== expectedHmac.length) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expectedHmac));
}

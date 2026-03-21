import { randomUUID } from 'node:crypto';

export function fulfilled<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === 'fulfilled' ? result.value : null;
}

export function generateAlertId(): string {
  return `sc-${randomUUID().slice(0, 12)}`;
}

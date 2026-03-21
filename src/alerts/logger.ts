import { appendFileSync } from 'node:fs';
import type { Alert, AlertHandler } from '../types.js';

export class JsonlLogger implements AlertHandler {
  constructor(private logPath: string) {}

  async handle(alert: Alert): Promise<void> {
    const entry = JSON.stringify({
      ...alert,
      logged_at: new Date().toISOString(),
    });
    appendFileSync(this.logPath, entry + '\n', 'utf-8');
  }
}

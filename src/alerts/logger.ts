import { createWriteStream, type WriteStream } from 'node:fs';
import type { Alert, AlertHandler } from '../types.js';

export class JsonlLogger implements AlertHandler {
  private stream: WriteStream;

  constructor(logPath: string) {
    this.stream = createWriteStream(logPath, { flags: 'a' });
  }

  async handle(alert: Alert): Promise<void> {
    const entry = JSON.stringify({
      ...alert,
      logged_at: new Date().toISOString(),
    });
    return new Promise((resolve, reject) => {
      this.stream.write(entry + '\n', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  flush(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stream.end((err: Error | null | undefined) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

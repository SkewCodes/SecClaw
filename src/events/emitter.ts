import { createWriteStream, type WriteStream } from 'node:fs';
import type { Alert, SecClawEvent } from '../types.js';
import { generateAlertId } from '../utils.js';
import { sanitizePayloadForLogging } from '../gate/private-key-guard.js';

export class SecClawEventEmitter {
  private stream: WriteStream;

  constructor(logPath: string) {
    this.stream = createWriteStream(logPath, { flags: 'a' });
  }

  emit(event: SecClawEvent): void {
    const actual = event.details.actual;
    const needsSanitize = actual !== null && actual !== undefined
      && typeof actual !== 'number' && typeof actual !== 'boolean';
    const safe = needsSanitize
      ? { ...event, details: { ...event.details, actual: sanitizePayloadForLogging(actual) } }
      : event;
    const entry = JSON.stringify(safe);
    this.stream.write(entry + '\n');
  }

  emitAll(events: SecClawEvent[]): void {
    for (const event of events) {
      this.emit(event);
    }
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

/**
 * Bridge adapter that converts V2 SecClawEvents into V1 Alerts,
 * allowing V2 gate events to flow through the existing AlertBus
 * (Telegram, webhook, pause-signal) without modifying those handlers.
 */
export function secClawEventToAlert(event: SecClawEvent): Alert {
  const severityMap: Record<string, Alert['severity']> = {
    info: 'info',
    warning: 'warning',
    critical: 'critical',
  };

  return {
    id: generateAlertId(),
    source: `v2:${event.module}`,
    check: event.check,
    severity: severityMap[event.severity] ?? 'warning',
    message: event.details.message,
    timestamp: new Date(event.timestamp).getTime(),
    data: {
      v2_event_id: event.id,
      action: event.action,
      policy_rule: event.details.policy_rule,
      agent_id: event.agent_id,
      ...(event.execution_context ?? {}),
    },
  };
}

/**
 * Derive the V2 JSONL log path from the V1 log path.
 * e.g. "./secclaw-audit.jsonl" -> "./secclaw-audit-v2.jsonl"
 */
export function deriveV2LogPath(v1LogPath: string): string {
  return v1LogPath.replace(/\.jsonl$/, '-v2.jsonl');
}

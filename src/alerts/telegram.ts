import type { Alert, AlertHandler, AlertSeverity } from '../types.js';

const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
  critical: '\u{1F534}',
  high: '\u{1F7E0}',
  warning: '\u{1F7E1}',
  info: '\u{1F535}',
};

const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  critical: 'CRITICAL',
  high: 'HIGH',
  warning: 'WARNING',
  info: 'INFO',
};

const MAX_MESSAGE_LENGTH = 4096;
const MIN_INTERVAL_MS = 3000;

export class TelegramHandler implements AlertHandler {
  private lastSentAt = 0;
  private queue: Alert[] = [];
  private drainPromise: Promise<void> | null = null;
  private builderTopicIds = new Map<string, number>();

  constructor(
    private botToken: string,
    private chatId: string,
    private minSeverity: AlertSeverity = 'warning',
    private supplyChainTopicId?: number,
  ) {}

  setBuilderTopicId(builderId: string, topicId: number): void {
    this.builderTopicIds.set(builderId, topicId);
  }

  async handle(alert: Alert): Promise<void> {
    if (!this.shouldSend(alert.severity)) return;

    this.queue.push(alert);
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainPromise) return;
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = null;
      if (this.queue.length > 0) {
        this.scheduleDrain();
      }
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const now = Date.now();
      const wait = MIN_INTERVAL_MS - (now - this.lastSentAt);
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait));
      }

      const alert = this.queue.shift();
      if (!alert) break;
      await this.send(alert);
      this.lastSentAt = Date.now();
    }
  }

  private async send(alert: Alert): Promise<void> {
    const emoji = SEVERITY_EMOJI[alert.severity];
    const label = SEVERITY_LABEL[alert.severity];

    let text = `${emoji} ${label} — ${alert.source}\n\n`;
    text += `Check: ${alert.check}\n`;
    text += `${alert.message}\n`;

    if (alert.data) {
      for (const [key, value] of Object.entries(alert.data)) {
        text += `${key}: ${JSON.stringify(value)}\n`;
      }
    }

    text += `\nTimestamp: ${new Date(alert.timestamp).toISOString()}`;

    if (text.length > MAX_MESSAGE_LENGTH) {
      text = text.slice(0, MAX_MESSAGE_LENGTH - 3) + '...';
    }

    let messageThreadId: number | undefined;
    if (alert.source.startsWith('supply-chain')) {
      const builderId = alert.data?.['builderId'] as string | undefined;
      if (builderId) {
        messageThreadId = this.builderTopicIds.get(builderId);
      }
      messageThreadId ??= this.supplyChainTopicId;
    }

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const payload: Record<string, unknown> = {
        chat_id: this.chatId,
        text,
      };
      if (messageThreadId) {
        payload.message_thread_id = messageThreadId;
      }
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      console.error('[secclaw] Telegram send failed:', (err as Error).message);
    }
  }

  private shouldSend(severity: AlertSeverity): boolean {
    const levels: AlertSeverity[] = ['info', 'warning', 'high', 'critical'];
    return levels.indexOf(severity) >= levels.indexOf(this.minSeverity);
  }
}

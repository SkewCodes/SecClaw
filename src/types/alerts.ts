// ─── Alert Types ───────────────────────────────────────────────

export type AlertSeverity = 'critical' | 'high' | 'warning' | 'info';

export type V2Severity = 'info' | 'warning' | 'critical';

export interface Alert {
  id: string;
  source: string;
  check: string;
  severity: AlertSeverity;
  message: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

export interface AlertHandler {
  handle(alert: Alert): Promise<void>;
}

export interface AlertEscalationEntry {
  key: string;
  firstSeen: number;
  count: number;
  severity: AlertSeverity;
}

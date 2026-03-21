// ─── Alert Types ───────────────────────────────────────────────

export type AlertSeverity = 'critical' | 'high' | 'warning' | 'info';

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

// ─── Probe Types ──────────────────────────────────────────────

export interface ProbeResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  latencyMs: number;
}

// ─── YieldClaw Snapshot ───────────────────────────────────────

export type CircuitBreakerLevel = 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED';
export type VaultState = 'CREATED' | 'ACTIVE' | 'PAUSED' | 'STOPPED' | 'HALTED' | 'RECOVERY';

export interface CircuitBreakerState {
  level: CircuitBreakerLevel;
  triggeredAt: number | null;
  reason: string | null;
  cooldownUntil: number | null;
}

export interface YCPosition {
  symbol: string;
  position_qty: number;
  cost_position: number;
  average_open_price: number;
  unsettled_pnl: number;
  mark_price: number;
  est_liq_price: number;
  leverage: number;
  timestamp: number;
}

export interface YCSharePrice {
  vault_id: string;
  share_price: number;
  total_shares: number;
  nav: number;
  aum: number;
  timestamp: number;
}

export interface YCStatus {
  vault: {
    id: string;
    state: VaultState;
    nav: number;
    peakNav: number;
    dailyPnl: number;
    drawdownPct: number;
    startedAt: string;
    lastCycleAt: string | null;
  };
  strategy: {
    name: string;
    version: string;
    symbols: string[];
  };
  circuitBreaker: CircuitBreakerState;
  provider: string;
  running: boolean;
  uptime: number;
}

export interface YCRisk {
  circuitBreaker: CircuitBreakerState;
  drawdownPct: number;
  dailyPnl: number;
  currentNav: number;
  peakNav: number;
  openPositions: number;
  totalExposure: number;
}

export interface YCStrategy {
  name: string;
  version: string;
  description: string;
  universe: {
    symbols: string[];
    maxConcurrentPositions: number;
  };
  allocation: {
    maxCapitalPct: number;
    maxLeverage: number;
    rebalanceIntervalSec: number;
  };
}

export interface GuardianPolicy {
  trading: {
    allowedSymbols: string[];
    maxLeverage: number;
    maxPositionSizeUSD: number;
    maxOpenPositions: number;
    maxDailyLossUSD: number;
    allowedOrderTypes: string[];
    requireApprovalAboveUSD?: number;
  };
  vaults: {
    allowedVaultIds: string[];
    maxDepositPerTxUSD: number;
    maxWithdrawPerTxUSD: number;
    dailyWithdrawLimitUSD: number;
    cooldownAfterDepositHours: number;
  };
  spending: {
    maxPerRequestUSD: number;
    hourlyLimitUSD: number;
    dailyLimitUSD: number;
  };
  session: {
    maxTTLSeconds: number;
    autoRevokeOnPolicyViolation: boolean;
    maxConsecutiveViolations: number;
  };
}

export interface YieldClawSnapshot {
  status: YCStatus | null;
  risk: YCRisk | null;
  positions: YCPosition[];
  strategy: YCStrategy | null;
  sharePrice: YCSharePrice | null;
  guardianPolicy: GuardianPolicy | null;
}

// ─── MM Snapshot ──────────────────────────────────────────────

export interface MMBalance {
  totalCollateral: number;
  freeCollateral: number;
  totalPnl: number;
}

export interface MMPosition {
  symbol: string;
  size: number;
  avgEntryPrice: number;
  unrealisedPnl: number;
  markPrice: number;
}

export type MMCircuitBreakerLevel = 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED';

export interface MMSafetyState {
  circuitBreaker: MMCircuitBreakerLevel;
  volatilityPaused: boolean;
  fundingGuardActive: boolean;
  cascadeDetected: boolean;
  trendDetected: boolean;
}

export interface MMQuality {
  uptimeMs: number;
  fillRate: number;
  adverseSelectionBps: number;
  grade: string;
}

export interface MMAutoTunerState {
  changesLast24h: number;
  lastChangeAt: number | null;
  warmupComplete: boolean;
}

export interface MMSnapshot {
  balance: MMBalance | null;
  positions: MMPosition[];
  safety: MMSafetyState | null;
  quality: MMQuality | null;
  autoTuner: MMAutoTunerState | null;
  riskPreset: string | null;
  pair: string | null;
}

// ─── Guardian Snapshot ────────────────────────────────────────

export interface IntentReceipt {
  intentId: string;
  action: string;
  status: 'executed' | 'rejected' | 'failed';
  tier: 'session' | 'wallet' | 'elevated';
  policyResult?: 'approved' | 'denied';
  policyViolations?: string[];
  receipt?: {
    orderId?: number;
    orderPrice?: number;
    orderQuantity?: number;
    orderStatus?: string;
    executedAt: number;
  };
  error?: string;
}

export interface GuardianSnapshot {
  recentIntents: IntentReceipt[];
  spendingPerRequest: number;
  spendingHourly: number;
  spendingDaily: number;
  logFileSize: number;
  previousLogFileSize: number;
}

// ─── OtterClaw Snapshot ───────────────────────────────────────

export interface SkillFileInfo {
  path: string;
  relativePath: string;
  hash: string;
  frontmatter: Record<string, unknown> | null;
  modifiedAt: number;
}

export interface OtterClawSnapshot {
  skills: SkillFileInfo[];
}

// ─── Growth Agent Snapshot ────────────────────────────────────

export interface GrowthPlaybookRun {
  playbook: string;
  cycle: number;
  timestamp: number;
  actions: string[];
  dryRun: boolean;
}

export interface GrowthWatchdogFlag {
  accountId: string;
  detector: string;
  riskScore: number;
  tier: 'CLEAN' | 'MONITOR' | 'RESTRICT' | 'PENALIZE' | 'ESCALATE';
  enforcementAction?: string;
  timestamp: number;
}

export interface GrowthAgentSnapshot {
  lastCycleAt: number | null;
  cycleCount: number;
  dryRun: boolean;
  builderTier: string;
  playbooksExecuted: GrowthPlaybookRun[];
  watchdogFlags: GrowthWatchdogFlag[];
  feeChanges: Array<{ symbol: string; oldBps: number; newBps: number; timestamp: number }>;
  referralCodesCreated: number;
  campaignsDeployed: number;
  auditLogSize: number;
  previousAuditLogSize: number;
}

// ─── Combined System Snapshot ─────────────────────────────────

export interface SystemSnapshot {
  timestamp: number;
  yieldclaw: ProbeResult<YieldClawSnapshot>;
  mm: ProbeResult<MMSnapshot>;
  guardian: ProbeResult<GuardianSnapshot>;
  otterclaw: ProbeResult<OtterClawSnapshot>;
  growthAgent: ProbeResult<GrowthAgentSnapshot>;
}

// ─── Policy Manifest Types ────────────────────────────────────

export interface PolicyManifest {
  version: string;
  last_updated: string;
  updated_by: string;
  global: {
    network: string;
    aggregate_exposure_limit_usd: number;
    authorized_wallets: string[];
    known_agent_addresses: string[];
  };
  yieldclaw: {
    vault_ids: string[];
    hard_limits: {
      max_drawdown_pct: number;
      max_daily_loss_pct: number;
      max_leverage: number;
      max_position_size_pct: number;
      max_concurrent_positions: number;
      max_order_frequency_per_min: number;
      data_staleness_max_sec: number;
    };
    withdrawal: {
      max_per_request_usd: number;
      daily_limit_usd: number;
      cooldown_sec: number;
    };
    share_price: {
      max_hourly_change_pct: number;
      max_daily_change_pct: number;
    };
    nav_drift_tolerance_pct: number;
  };
  payment_layer: {
    trading: {
      allowed_symbols: string[];
      max_leverage: number;
      max_position_size_usd: number;
      max_open_positions: number;
      max_daily_loss_usd: number;
      allowed_order_types: string[];
      require_approval_above_usd: number;
    };
    swaps: {
      allowed_tokens: string[];
      max_swap_amount_usd: number;
      max_slippage_pct: number;
    };
    vaults: {
      allowed_vault_ids: string[];
      max_deposit_per_tx_usd: number;
      max_withdraw_per_tx_usd: number;
      daily_withdraw_limit_usd: number;
      cooldown_after_deposit_hours: number;
    };
    spending: {
      max_per_request_usd: number;
      hourly_limit_usd: number;
      daily_limit_usd: number;
    };
    session: {
      max_ttl_seconds: number;
      max_consecutive_violations: number;
    };
  };
  otterclaw: {
    skill_hashes: Record<string, string>;
    schema_hash: string;
    validator_hash: string;
    cli_binary_hash: string;
    url_allowlist: string[];
  };
  agentic_mm: {
    risk_presets: Record<string, {
      spread_bps: number;
      max_position_pct: number;
      refresh_sec: number;
      grid_levels: number;
    }>;
    safety: {
      max_drawdown_pct: number;
      volatility_pause_multiplier: number;
      funding_guard_threshold_pct: number;
      cascade_same_side_fills: number;
      cascade_window_sec: number;
    };
    auto_tuner: {
      warmup_hours: number;
      max_changes_per_24h: number;
    };
    fill_monitor: {
      max_poll_age_ms: number;
    };
  };
  growth_agent: {
    max_playbooks_per_cycle: number;
    allowed_playbooks: string[];
    fee_change_max_bps: number;
    builder_tier_floor: string;
    watchdog_enforcement_enabled: boolean;
    max_fee_changes_per_day: number;
    max_campaigns_per_day: number;
  };
}

// ─── Config Types ─────────────────────────────────────────────

export interface SecClawConfig {
  manifestPath: string;
  once: boolean;
  dryRun: boolean;
  verbose: boolean;
  pollIntervalSec: number;
  logPath: string;
  yieldclaw: {
    baseUrl: string;
    healthToken: string;
    adminToken: string;
  };
  mm: {
    accountId: string;
    network: string;
    statusUrl: string;
  };
  otterclaw: {
    skillsPath: string;
    partnerSkillsPath: string;
  };
  guardian: {
    auditLogPath: string;
  };
  telegram: {
    botToken: string;
    chatId: string;
  };
  pauseSignal: {
    enabled: boolean;
    port: number;
  };
  growthAgent: {
    auditLogPath: string;
    statePath: string;
  };
  webhook: {
    url: string;
  };
  healthPort: number;
  healthToken: string;
  vaultDecimals: number;
}

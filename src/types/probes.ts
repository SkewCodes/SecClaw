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

// ─── OtterClaw Bridge Events (from OtterClaw SecClawBridge) ──

export type OtterClawBridgeEventType =
  | 'skill.cli.blocked' | 'skill.capability.violation'
  | 'skill.exec.start' | 'skill.exec.end'
  | 'skill.install.blocked' | 'skill.sandbox.escape'
  | 'skill.network.blocked';

export interface OtterClawBridgeEvent {
  id: string;
  type: OtterClawBridgeEventType;
  skill_id: string;
  timestamp: string;
  severity: 'info' | 'warning' | 'critical';
  details: Record<string, unknown>;
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

// ─── Listing Snapshot ────────────────────────────────────────

export interface ListingEvent {
  eventId: string;
  agentId: string;
  marketId: string;
  baseAsset: string;
  oracleSource: string;
  seedLiquidityUSD: number;
  timestamp: number;
  liquidityPulledAt?: number;
}

export interface ListingTradeEvent {
  agentId: string;
  marketId: string;
  volumeUSD: number;
  timestamp: number;
}

export interface ListingSnapshot {
  recentListings: ListingEvent[];
  recentTrades: ListingTradeEvent[];
  auditLogSize: number;
  previousAuditLogSize: number;
}

// ─── Workstation Probe Snapshots ─────────────────────────────

export interface ProcessInfo {
  pid: number;
  name: string;
  command: string;
  ppid: number;
  user?: string;
  startedAt?: number;
}

export interface WorkstationSnapshot {
  processes: ProcessInfo[];
  openPorts: number[];
  cliVersions: Record<string, string>;
  hostname: string;
  platform: string;
}

export interface GitHubWebhookEvent {
  eventType: string;
  repo: string;
  actor: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

export interface GitHubSnapshot {
  recentEvents: GitHubWebhookEvent[];
  workflowFiles: Array<{ path: string; hash: string; modifiedAt: number }>;
}

export interface ProcessSnapshot {
  processes: ProcessInfo[];
  suspiciousChildren: ProcessInfo[];
  nodeProcessCount: number;
}

export interface NetworkConnection {
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  state: string;
  pid?: number;
  process?: string;
}

export interface NetworkSnapshot {
  connections: NetworkConnection[];
  nonAllowlistedOutbound: NetworkConnection[];
}

export interface FileAccessEvent {
  path: string;
  operation: 'read' | 'write' | 'delete' | 'create';
  pid?: number;
  process?: string;
  timestamp: number;
}

export interface FilesystemSnapshot {
  sensitivePathAccesses: FileAccessEvent[];
  modifiedFiles: Array<{ path: string; hash: string; modifiedAt: number }>;
}

// ─── Combined System Snapshot ─────────────────────────────────

export interface SystemSnapshot {
  timestamp: number;
  yieldclaw: ProbeResult<YieldClawSnapshot>;
  mm: ProbeResult<MMSnapshot>;
  guardian: ProbeResult<GuardianSnapshot>;
  otterclaw: ProbeResult<OtterClawSnapshot>;
  growthAgent: ProbeResult<GrowthAgentSnapshot>;
  listing: ProbeResult<ListingSnapshot>;
  workstation?: ProbeResult<WorkstationSnapshot>;
  github?: ProbeResult<GitHubSnapshot>;
  process?: ProbeResult<ProcessSnapshot>;
  network?: ProbeResult<NetworkSnapshot>;
  filesystem?: ProbeResult<FilesystemSnapshot>;
  otterclawEvents?: OtterClawBridgeEvent[];
}

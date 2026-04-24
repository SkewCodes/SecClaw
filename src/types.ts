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
  listing?: ListingPolicy;
  dependencies?: DependencyPolicy;
  signer?: SignerPolicy;
  supplyChain?: SupplyChainPolicy;
  contracts?: ContractVerificationPolicy;
  oracle?: OracleTokenPolicy;
  mcp_tools?: Record<string, unknown>;
}

// ─── Listing Policy ─────────────────────────────────────────

export interface ListingPolicy {
  enabled: boolean;
  allowedBaseAssets: string[];
  deniedBaseAssets: string[];
  maxMarketsPerWindow: {
    count: number;
    windowHours: number;
  };
  minCooldownAfterListSeconds: number;
  maxSelfVolumePct: number;
  maxConcurrentSelfListedMarkets: number;
  requireOracleSource: string[];
  minSeedLiquidityUSD: number;
  maxSeedLiquidityUSD: number;
}

// ─── V2 Event Types ──────────────────────────────────────────

export type SecClawEventModule =
  | 'yieldclaw_probe' | 'mm_probe' | 'guardian_probe'
  | 'otterclaw_probe' | 'growth_probe' | 'listing_watchdog'
  | 'correlator' | 'drift_detector' | 'integrity_scanner'
  | 'dependency_attestor' | 'signer_health'
  | 'contract_verification' | 'mcp_tool_attestor'
  | 'oracle_token_verifier'
  | 'supply_chain_worm' | 'hook_sandbox' | 'lockfile_attestation'
  | 'workstation_probe' | 'process_probe' | 'network_probe' | 'filesystem_probe'
  | 'github_probe'
  | 'credential_radius' | 'workflow_drift'
  | 'otterclaw_receiver'
  | 'deploy_pause' | 'token_revoke' | 'signer_rotate' | 'quarantine_builder'
  | 'gate' | 'slippage_guard';

export type SecClawEventAction = 'pass' | 'block' | 'alert' | 'escalate';

export interface SecClawEventExecutionContext {
  tool_name?: string;
  contract_address?: string;
  function_selector?: string;
  calldata_hash?: string;
  mcp_server?: string;
  gas_estimate?: number;
  value_usd?: number;
}

export interface SecClawEvent {
  id: string;
  version: '2.0';
  timestamp: string;
  source: 'daemon' | 'gate';
  agent_id: string;
  module: SecClawEventModule;
  action: SecClawEventAction;
  severity: V2Severity;
  check: string;
  details: {
    expected: unknown;
    actual: unknown;
    policy_rule: string;
    message: string;
  };
  execution_context?: SecClawEventExecutionContext;
  trace_id: string;
  session_id?: string;
}

// ─── Gate Types ──────────────────────────────────────────────

export type GateActionType = 'sign' | 'call' | 'register_tool' | 'invoke_tool';

export interface GateRequest {
  agent_id: string;
  action_type: GateActionType;
  payload: {
    to?: string;
    data?: string;
    value?: string;
    gas_limit?: number;
    gas_price?: string;
    tool_name?: string;
    tool_schema?: object;
    tool_endpoint?: string;
    tool_params?: object;
    nonce?: number;
    session_id?: string;
    value_usd?: number;
    wallet_address?: string;
  };
}

export type GateCheckResult = 'pass' | 'block' | 'skip';

export interface GateCheckEntry {
  module: string;
  check: string;
  result: GateCheckResult;
  latency_ms: number;
}

export interface GateResponse {
  allowed: boolean;
  event: SecClawEvent;
  reason?: string;
  checks_performed: GateCheckEntry[];
}

// ─── V2 Policy Manifest Extensions ──────────────────────────

export interface DependencyPolicy {
  attestation: 'strict' | 'warn' | 'disabled';
  attestation_path: string;
  advisory_severity_threshold?: string;
  blocked_packages: string[];
  drift_action: 'block' | 'alert';
}

// ─── Supply Chain Policy ────────────────────────────────────

export interface SupplyChainBehavioralDiff {
  enabled: boolean;
  newEndpointBlockThreshold: number;
  sensitivePathBlocklist: string[];
}

export interface SupplyChainLockfileAttestation {
  required: boolean;
  algorithm: string;
}

export interface SupplyChainPolicy {
  quarantineWindowHours: number;
  preinstallHookPolicy: 'allowlist' | 'blocklist' | 'sandbox';
  preinstallHookAllowlist: string[];
  behavioralDiff: SupplyChainBehavioralDiff;
  exfilDomainBlocklist: string[];
  trustedPublishers: string[];
  lockfileAttestation: SupplyChainLockfileAttestation;
}

// ─── Contract Verification Policy ───────────────────────────

export interface ContractFunctionParam {
  max?: number;
  min?: number;
}

export interface ContractFunction {
  selector: string;
  params?: Record<string, ContractFunctionParam>;
}

export interface ContractInteraction {
  address: string;
  functions: ContractFunction[];
}

export interface ContractVerificationPolicy {
  mode: 'allowlist' | 'disabled';
  simulation: 'disabled';
  allowed_interactions: ContractInteraction[];
  blocked_addresses: string[];
  unknown_contract_action: 'block' | 'alert';
}

// ─── Oracle / Token Verification Policy ─────────────────────

export interface TokenLegitimacyPolicy {
  min_liquidity_usd: number;
  min_age_hours: number;
  min_holders: number;
}

export interface OracleTokenPolicy {
  min_sources: number;
  max_deviation_pct: number;
  cache_ttl_sec: number;
  token_legitimacy: TokenLegitimacyPolicy;
  blocked_tokens: string[];
}

// ─── Oracle Adapter Types ───────────────────────────────────

export interface OraclePriceResult {
  source: string;
  price: number;
  confidence: number;
  timestamp: number;
}

export interface TokenMetadata {
  address: string;
  liquidity_usd: number;
  age_hours: number;
  holders: number;
}

export interface OracleAdapter {
  name: string;
  fetchPrice(token: string): Promise<OraclePriceResult>;
  fetchTokenMetadata?(token: string): Promise<TokenMetadata>;
}

export interface SignerImmutablePolicy {
  cumulative_exposure_ceiling_usd: number;
  balance_minimum_eth: number;
  nonce_mode: 'strict' | 'warn';
  nonce_persistence_path: string;
  rate_limits_ceiling: {
    per_minute: number;
    per_day: number;
  };
  min_cooldown_ms: number;
  gas_ceiling_gwei: number;
  gas_limit_ceiling: number;
  modification_delay_sec: number;
  critical_alert_lock: boolean;
  max_override_duration_sec: number;
  multi_approval_threshold_pct: number;
  multi_approval_operators: number;
  ceiling_to_default_max_ratio: number;
}

export interface SignerRateLimits {
  per_minute: number;
  per_hour: number;
  per_day: number;
}

export interface SignerCumulativeExposure {
  window: string;
  max_window: string;
  max_usd: number;
  delay_override_sec?: number;
}

export interface SignerGasPolicy {
  max_price_gwei: number;
  max_limit: number;
  price_mode: 'dynamic' | 'fixed';
}

export interface SignerOverridableParam {
  parameter: string;
  max_duration_sec: number;
}

export interface SignerProfileCondition {
  type: string;
  threshold_pct?: number;
  threshold_gwei?: number;
}

export interface SignerProfile {
  description: string;
  overrides: Record<string, number>;
  max_duration_sec: number;
  activation_conditions: SignerProfileCondition[];
  require_operator_approval: boolean;
}

export interface SignerConditionalAutoApproval {
  parameter: string;
  max_value: number;
  max_duration_sec: number;
  condition: {
    type: string;
    min_gwei?: number;
    min_count?: number;
  };
  verification: 'daemon';
}

export interface SignerApprovalChannel {
  type: string;
  chat_id?: string;
  inline_buttons?: boolean;
  dashboard?: boolean;
  enabled?: boolean;
}

export interface SignerApprovalConfig {
  channels: SignerApprovalChannel[];
  auto_reject_after_sec: number;
  require_auth: boolean;
  auth_method: 'api_key' | 'siwx';
}

export interface SignerPolicy {
  immutable: SignerImmutablePolicy;
  rate_limits: SignerRateLimits;
  cooldown_ms: number;
  cumulative_exposure: SignerCumulativeExposure;
  gas: SignerGasPolicy;
  acceleration_detection: boolean;
  target_switch_detection: boolean;
  agent_overridable: SignerOverridableParam[];
  profiles: Record<string, SignerProfile>;
  conditional_auto_approvals: SignerConditionalAutoApproval[];
  approval: SignerApprovalConfig;
}

// ─── Signer Modification Types ──────────────────────────────

export type ModificationStatus =
  | 'pending' | 'approved' | 'queued' | 'active'
  | 'expired' | 'cancelled' | 'rejected' | 'reverted';

export interface ModificationRequest {
  request_id: string;
  tier: 2 | 3;
  parameter: string;
  current_value: number;
  requested_value: number;
  justification: string;
  requested_by: 'agent' | 'operator';
  status: ModificationStatus;
  requested_at: string;
  approved_by?: string;
  activated_at?: string;
  expires_at?: string;
  reverted_to?: number;
  duration_sec?: number;
  session_id?: string;
}

// ─── Shared Gate State ──────────────────────────────────────

export interface GateSharedState {
  activeCriticalAlerts: Set<string>;
  activeModifications: Map<string, ModificationRequest>;
  pendingModifications: Map<string, ModificationRequest>;
  recentListings: ListingEvent[];
  signerRotationTriggeredAt: number | null;
}

// ─── Config Types ─────────────────────────────────────────────

export interface SecClawConfig {
  manifestPath: string;
  once: boolean;
  dryRun: boolean;
  verbose: boolean;
  auditMode: boolean;
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
  listing: {
    auditLogPath: string;
  };
  webhook: {
    url: string;
  };
  healthPort: number;
  healthToken: string;
  vaultDecimals: number;
  supplyChain: {
    githubToken: string;
    githubRepos: string[];
    deployRunnerPort: number;
    signerRotateEndpoint: string;
    tokenRevoke: {
      githubToken: string;
      npmToken: string;
    };
  };
  otterclawReceiver: {
    port: number;
    secret: string;
  };
}

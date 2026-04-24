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
  mcp_tools?: Record<string, {
    endpoint_url: string;
    expected_hash: string;
    allowlisted_servers: string[];
  }>;
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

// ─── Signer Policy Types ────────────────────────────────────

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

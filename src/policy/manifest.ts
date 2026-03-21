import { readFileSync, watchFile, unwatchFile } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { PolicyManifest } from '../types.js';

const RiskPresetSchema = z.object({
  spread_bps: z.number().positive(),
  max_position_pct: z.number().positive().max(100),
  refresh_sec: z.number().positive(),
  grid_levels: z.number().int().positive(),
});

const ManifestSchema = z.object({
  version: z.string(),
  last_updated: z.string(),
  updated_by: z.string(),
  global: z.object({
    network: z.enum(['mainnet', 'testnet']),
    aggregate_exposure_limit_usd: z.number().positive(),
    authorized_wallets: z.array(z.string()),
    known_agent_addresses: z.array(z.string()),
  }),
  yieldclaw: z.object({
    vault_ids: z.array(z.string()),
    hard_limits: z.object({
      max_drawdown_pct: z.number().positive().max(100),
      max_daily_loss_pct: z.number().positive().max(100),
      max_leverage: z.number().positive(),
      max_position_size_pct: z.number().positive().max(100),
      max_concurrent_positions: z.number().int().positive(),
      max_order_frequency_per_min: z.number().int().positive(),
      data_staleness_max_sec: z.number().positive(),
    }),
    withdrawal: z.object({
      max_per_request_usd: z.number().nonnegative(),
      daily_limit_usd: z.number().nonnegative(),
      cooldown_sec: z.number().nonnegative(),
    }),
    share_price: z.object({
      max_hourly_change_pct: z.number().positive(),
      max_daily_change_pct: z.number().positive(),
    }),
    nav_drift_tolerance_pct: z.number().positive(),
  }),
  payment_layer: z.object({
    trading: z.object({
      allowed_symbols: z.array(z.string()),
      max_leverage: z.number().positive(),
      max_position_size_usd: z.number().positive(),
      max_open_positions: z.number().int().positive(),
      max_daily_loss_usd: z.number().positive(),
      allowed_order_types: z.array(z.string()),
      require_approval_above_usd: z.number().positive(),
    }),
    swaps: z.object({
      allowed_tokens: z.array(z.string()),
      max_swap_amount_usd: z.number().positive(),
      max_slippage_pct: z.number().positive().max(1),
    }),
    vaults: z.object({
      allowed_vault_ids: z.array(z.string()),
      max_deposit_per_tx_usd: z.number().nonnegative(),
      max_withdraw_per_tx_usd: z.number().nonnegative(),
      daily_withdraw_limit_usd: z.number().nonnegative(),
      cooldown_after_deposit_hours: z.number().nonnegative(),
    }),
    spending: z.object({
      max_per_request_usd: z.number().nonnegative(),
      hourly_limit_usd: z.number().nonnegative(),
      daily_limit_usd: z.number().nonnegative(),
    }),
    session: z.object({
      max_ttl_seconds: z.number().positive(),
      max_consecutive_violations: z.number().int().positive(),
    }),
  }),
  otterclaw: z.object({
    skill_hashes: z.record(z.string()),
    schema_hash: z.string(),
    validator_hash: z.string(),
    cli_binary_hash: z.string(),
    url_allowlist: z.array(z.string()),
  }),
  agentic_mm: z.object({
    risk_presets: z.record(RiskPresetSchema),
    safety: z.object({
      max_drawdown_pct: z.number().positive().max(100),
      volatility_pause_multiplier: z.number().positive(),
      funding_guard_threshold_pct: z.number().positive(),
      cascade_same_side_fills: z.number().int().positive(),
      cascade_window_sec: z.number().positive(),
    }),
    auto_tuner: z.object({
      warmup_hours: z.number().nonnegative(),
      max_changes_per_24h: z.number().int().nonnegative(),
    }),
    fill_monitor: z.object({
      max_poll_age_ms: z.number().positive(),
    }),
  }),
  growth_agent: z.object({
    max_playbooks_per_cycle: z.number().int().positive().max(5),
    allowed_playbooks: z.array(z.string()),
    fee_change_max_bps: z.number().positive(),
    builder_tier_floor: z.string(),
    watchdog_enforcement_enabled: z.boolean(),
    max_fee_changes_per_day: z.number().int().nonnegative(),
    max_campaigns_per_day: z.number().int().nonnegative(),
  }),
});

export function loadManifest(path: string): PolicyManifest {
  const content = readFileSync(path, 'utf-8');
  const parsed = parseYaml(content);
  const result = ManifestSchema.safeParse(parsed);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Policy manifest validation failed:\n${issues}`);
  }

  return Object.freeze(result.data) as PolicyManifest;
}

/**
 * Watch manifest file for changes and reload on modification.
 * Returns a cleanup function to stop watching.
 */
export function watchManifest(
  path: string,
  onReload: (manifest: PolicyManifest) => void,
  onError: (err: Error) => void,
): () => void {
  const handler = () => {
    try {
      const manifest = loadManifest(path);
      onReload(manifest);
    } catch (err) {
      onError(err as Error);
    }
  };

  watchFile(path, { interval: 5000 }, handler);
  return () => unwatchFile(path, handler);
}

import { describe, it, expect } from 'vitest';
import { checkOracleTokenVerification } from '../src/gate/oracle-token-verifier.js';
import type {
  GateRequest,
  GateSharedState,
  PolicyManifest,
  OracleTokenPolicy,
} from '../src/types.js';

function makePolicy(overrides: Partial<OracleTokenPolicy> = {}): OracleTokenPolicy {
  return {
    min_sources: 2,
    max_deviation_pct: 5,
    cache_ttl_sec: 300,
    token_legitimacy: {
      min_liquidity_usd: 50000,
      min_age_hours: 72,
      min_holders: 100,
    },
    blocked_tokens: ['0xscamtoken0000000000000000000000000000000'],
    ...overrides,
  };
}

function makeManifest(oracle?: OracleTokenPolicy): PolicyManifest {
  return {
    version: '2.0', last_updated: '2026-04-01', updated_by: 'test',
    global: { network: 'testnet', aggregate_exposure_limit_usd: 50000, authorized_wallets: [], known_agent_addresses: [] },
    yieldclaw: { vault_ids: [], hard_limits: { max_drawdown_pct: 5, max_daily_loss_pct: 3, max_leverage: 3, max_position_size_pct: 25, max_concurrent_positions: 1, max_order_frequency_per_min: 10, data_staleness_max_sec: 60 }, withdrawal: { max_per_request_usd: 10000, daily_limit_usd: 50000, cooldown_sec: 300 }, share_price: { max_hourly_change_pct: 5, max_daily_change_pct: 15 }, nav_drift_tolerance_pct: 0.5 },
    payment_layer: { trading: { allowed_symbols: [], max_leverage: 10, max_position_size_usd: 5000, max_open_positions: 3, max_daily_loss_usd: 500, allowed_order_types: ['market'], require_approval_above_usd: 2000 }, swaps: { allowed_tokens: ['USDC'], max_swap_amount_usd: 1000, max_slippage_pct: 0.02 }, vaults: { allowed_vault_ids: [], max_deposit_per_tx_usd: 5000, max_withdraw_per_tx_usd: 1000, daily_withdraw_limit_usd: 3000, cooldown_after_deposit_hours: 24 }, spending: { max_per_request_usd: 1, hourly_limit_usd: 10, daily_limit_usd: 50 }, session: { max_ttl_seconds: 86400, max_consecutive_violations: 5 } },
    otterclaw: { skill_hashes: {}, schema_hash: '', validator_hash: '', cli_binary_hash: '', url_allowlist: [] },
    agentic_mm: { risk_presets: {}, safety: { max_drawdown_pct: 5, volatility_pause_multiplier: 3, funding_guard_threshold_pct: 1, cascade_same_side_fills: 5, cascade_window_sec: 3 }, auto_tuner: { warmup_hours: 2, max_changes_per_24h: 3 }, fill_monitor: { max_poll_age_ms: 2000 } },
    growth_agent: { max_playbooks_per_cycle: 2, allowed_playbooks: [], fee_change_max_bps: 2, builder_tier_floor: 'PUBLIC', watchdog_enforcement_enabled: false, max_fee_changes_per_day: 5, max_campaigns_per_day: 3 },
    oracle,
  } as PolicyManifest;
}

function makeRequest(overrides: Partial<GateRequest> & { payload?: Partial<GateRequest['payload']> } = {}): GateRequest {
  const { payload, ...rest } = overrides;
  return {
    agent_id: 'test-agent',
    action_type: 'call',
    payload: {
      to: '0xlegittoken00000000000000000000000000000',
      ...payload,
    },
    ...rest,
  };
}

function makeSharedState(): GateSharedState {
  return {
    activeCriticalAlerts: {},
    activeModifications: {},
    pendingModifications: {},
    recentListings: [],
    signerRotationTriggeredAt: null,
  };
}

describe('Oracle / Token Verifier Gate Module', () => {
  const ss = makeSharedState();

  it('skips when oracle policy is absent', () => {
    const { entries } = checkOracleTokenVerification(
      makeRequest(), makeManifest(undefined), ss,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toBe('skip');
  });

  it('skips when action_type is not sign or call', () => {
    const { entries } = checkOracleTokenVerification(
      makeRequest({ action_type: 'register_tool' }),
      makeManifest(makePolicy()),
      ss,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toBe('skip');
  });

  it('blocks explicitly blocked token', () => {
    const { entries, events } = checkOracleTokenVerification(
      makeRequest({ payload: { to: '0xscamtoken0000000000000000000000000000000' } }),
      makeManifest(makePolicy()),
      ss,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toBe('block');
    expect(entries[0].check).toBe('blocked_token');
    expect(events[0].action).toBe('block');
  });

  it('blocks token below min liquidity', () => {
    const { entries, events } = checkOracleTokenVerification(
      makeRequest({
        payload: {
          to: '0xsometoken',
          tool_params: {
            token_metadata: {
              address: '0xsometoken',
              liquidity_usd: 1000,
              age_hours: 200,
              holders: 500,
            },
          },
        },
      }),
      makeManifest(makePolicy()),
      ss,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toBe('block');
    expect(entries[0].check).toBe('token_liquidity');
    expect(events[0].check).toBe('token_low_liquidity');
  });

  it('blocks token below min age', () => {
    const { entries, events } = checkOracleTokenVerification(
      makeRequest({
        payload: {
          to: '0xnewtoken',
          tool_params: {
            token_metadata: {
              address: '0xnewtoken',
              liquidity_usd: 100000,
              age_hours: 12,
              holders: 500,
            },
          },
        },
      }),
      makeManifest(makePolicy()),
      ss,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toBe('block');
    expect(entries[0].check).toBe('token_age');
    expect(events[0].check).toBe('token_too_new');
  });

  it('blocks token below min holders', () => {
    const { entries, events } = checkOracleTokenVerification(
      makeRequest({
        payload: {
          to: '0xlowholders',
          tool_params: {
            token_metadata: {
              address: '0xlowholders',
              liquidity_usd: 100000,
              age_hours: 200,
              holders: 10,
            },
          },
        },
      }),
      makeManifest(makePolicy()),
      ss,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toBe('block');
    expect(entries[0].check).toBe('token_holders');
    expect(events[0].check).toBe('token_low_holders');
  });

  it('blocks when oracle price deviation exceeds threshold', () => {
    const { entries, events } = checkOracleTokenVerification(
      makeRequest({
        payload: {
          to: '0xtoken',
          tool_params: {
            oracle_prices: [
              { source: 'pyth', price: 100.0, confidence: 0.99, timestamp: Date.now() },
              { source: 'chainlink', price: 115.0, confidence: 0.98, timestamp: Date.now() },
            ],
          },
        },
      }),
      makeManifest(makePolicy({ max_deviation_pct: 5 })),
      ss,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toBe('block');
    expect(entries[0].check).toBe('oracle_deviation');
    expect(events[0].check).toBe('oracle_deviation_exceeded');
  });

  it('blocks when insufficient oracle sources', () => {
    const { entries, events } = checkOracleTokenVerification(
      makeRequest({
        payload: {
          to: '0xtoken',
          tool_params: {
            oracle_prices: [
              { source: 'pyth', price: 100.0, confidence: 0.99, timestamp: Date.now() },
            ],
          },
        },
      }),
      makeManifest(makePolicy({ min_sources: 2 })),
      ss,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toBe('block');
    expect(entries[0].check).toBe('insufficient_sources');
  });

  it('passes when all checks satisfied', () => {
    const { entries, events } = checkOracleTokenVerification(
      makeRequest({
        payload: {
          to: '0xgoodtoken',
          tool_params: {
            token_metadata: {
              address: '0xgoodtoken',
              liquidity_usd: 200000,
              age_hours: 500,
              holders: 5000,
            },
            oracle_prices: [
              { source: 'pyth', price: 100.0, confidence: 0.99, timestamp: Date.now() },
              { source: 'chainlink', price: 101.0, confidence: 0.98, timestamp: Date.now() },
            ],
          },
        },
      }),
      makeManifest(makePolicy()),
      ss,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toBe('pass');
    expect(entries[0].check).toBe('oracle_verified');
    expect(events[0].action).toBe('pass');
  });

  it('passes when no token metadata or prices (cannot verify, allows through)', () => {
    const { entries } = checkOracleTokenVerification(
      makeRequest({ payload: { to: '0xsometoken' } }),
      makeManifest(makePolicy()),
      ss,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toBe('pass');
    expect(entries[0].check).toBe('oracle_verified');
  });

  it('blocked token check is case-insensitive', () => {
    const { entries } = checkOracleTokenVerification(
      makeRequest({ payload: { to: '0xSCAMTOKEN0000000000000000000000000000000' } }),
      makeManifest(makePolicy()),
      ss,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toBe('block');
    expect(entries[0].check).toBe('blocked_token');
  });

  it('blocks on zero price from oracle', () => {
    const { entries, events } = checkOracleTokenVerification(
      makeRequest({
        payload: {
          to: '0xtoken',
          tool_params: {
            oracle_prices: [
              { source: 'pyth', price: 100.0, confidence: 0.99, timestamp: Date.now() },
              { source: 'chainlink', price: 0, confidence: 0, timestamp: Date.now() },
            ],
          },
        },
      }),
      makeManifest(makePolicy()),
      ss,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toBe('block');
    expect(events[0].check).toBe('oracle_zero_price');
  });

  it('extracts token from tool_params.token field', () => {
    const { entries } = checkOracleTokenVerification(
      makeRequest({
        payload: {
          to: '0xrouter',
          tool_params: { token: '0xscamtoken0000000000000000000000000000000' },
        },
      }),
      makeManifest(makePolicy()),
      ss,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toBe('block');
    expect(entries[0].check).toBe('blocked_token');
  });
});

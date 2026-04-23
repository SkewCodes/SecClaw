import { describe, it, expect } from 'vitest';
import { checkContractVerification } from '../src/gate/contract-verification.js';
import type {
  GateRequest,
  GateSharedState,
  PolicyManifest,
  ContractVerificationPolicy,
} from '../src/types.js';

function makePolicy(overrides: Partial<ContractVerificationPolicy> = {}): ContractVerificationPolicy {
  return {
    mode: 'allowlist',
    simulation: 'disabled',
    allowed_interactions: [
      {
        address: '0xabcdef1234567890abcdef1234567890abcdef12',
        functions: [
          { selector: '0xa9059cbb', params: { amount: { max: 10000 } } },
          { selector: '0x095ea7b3' },
        ],
      },
    ],
    blocked_addresses: ['0xdeadbeef00000000000000000000000000000000'],
    unknown_contract_action: 'block',
    ...overrides,
  };
}

function makeManifest(contracts?: ContractVerificationPolicy): PolicyManifest {
  return {
    version: '2.0', last_updated: '2026-04-01', updated_by: 'test',
    global: { network: 'testnet', aggregate_exposure_limit_usd: 50000, authorized_wallets: [], known_agent_addresses: [] },
    yieldclaw: { vault_ids: [], hard_limits: { max_drawdown_pct: 5, max_daily_loss_pct: 3, max_leverage: 3, max_position_size_pct: 25, max_concurrent_positions: 1, max_order_frequency_per_min: 10, data_staleness_max_sec: 60 }, withdrawal: { max_per_request_usd: 10000, daily_limit_usd: 50000, cooldown_sec: 300 }, share_price: { max_hourly_change_pct: 5, max_daily_change_pct: 15 }, nav_drift_tolerance_pct: 0.5 },
    payment_layer: { trading: { allowed_symbols: [], max_leverage: 10, max_position_size_usd: 5000, max_open_positions: 3, max_daily_loss_usd: 500, allowed_order_types: ['market'], require_approval_above_usd: 2000 }, swaps: { allowed_tokens: ['USDC'], max_swap_amount_usd: 1000, max_slippage_pct: 0.02 }, vaults: { allowed_vault_ids: [], max_deposit_per_tx_usd: 5000, max_withdraw_per_tx_usd: 1000, daily_withdraw_limit_usd: 3000, cooldown_after_deposit_hours: 24 }, spending: { max_per_request_usd: 1, hourly_limit_usd: 10, daily_limit_usd: 50 }, session: { max_ttl_seconds: 86400, max_consecutive_violations: 5 } },
    otterclaw: { skill_hashes: {}, schema_hash: '', validator_hash: '', cli_binary_hash: '', url_allowlist: [] },
    agentic_mm: { risk_presets: {}, safety: { max_drawdown_pct: 5, volatility_pause_multiplier: 3, funding_guard_threshold_pct: 1, cascade_same_side_fills: 5, cascade_window_sec: 3 }, auto_tuner: { warmup_hours: 2, max_changes_per_24h: 3 }, fill_monitor: { max_poll_age_ms: 2000 } },
    growth_agent: { max_playbooks_per_cycle: 2, allowed_playbooks: [], fee_change_max_bps: 2, builder_tier_floor: 'PUBLIC', watchdog_enforcement_enabled: false, max_fee_changes_per_day: 5, max_campaigns_per_day: 3 },
    contracts,
  } as PolicyManifest;
}

function makeRequest(overrides: Partial<GateRequest> = {}): GateRequest {
  return {
    agent_id: 'test-agent',
    action_type: 'call',
    payload: {
      to: '0xabcdef1234567890abcdef1234567890abcdef12',
      data: '0xa9059cbb000000000000000000000000',
    },
    ...overrides,
  };
}

function makeSharedState(): GateSharedState {
  return {
    activeCriticalAlerts: new Set(),
    activeModifications: new Map(),
    pendingModifications: new Map(),
    recentListings: [],
  };
}

describe('Contract Verification Gate Module', () => {
  const ss = makeSharedState();

  it('skips when contracts policy is absent', () => {
    const { entries } = checkContractVerification(
      makeRequest(), makeManifest(undefined), ss,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toBe('skip');
  });

  it('skips when mode is disabled', () => {
    const { entries } = checkContractVerification(
      makeRequest(), makeManifest(makePolicy({ mode: 'disabled' })), ss,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toBe('skip');
  });

  it('skips when action_type is not sign or call', () => {
    const { entries } = checkContractVerification(
      makeRequest({ action_type: 'register_tool' }),
      makeManifest(makePolicy()),
      ss,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toBe('skip');
  });

  it('passes known address + known selector', () => {
    const { entries } = checkContractVerification(
      makeRequest(), makeManifest(makePolicy()), ss,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toBe('pass');
    expect(entries[0].check).toBe('contract_allowlist');
  });

  it('blocks explicitly blocked address', () => {
    const { entries, events } = checkContractVerification(
      makeRequest({
        payload: { to: '0xdeadbeef00000000000000000000000000000000', data: '0xa9059cbb' },
      }),
      makeManifest(makePolicy()),
      ss,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toBe('block');
    expect(entries[0].check).toBe('blocked_address');
    expect(events[0].action).toBe('block');
  });

  it('blocks unknown contract when unknown_contract_action=block', () => {
    const { entries, events } = checkContractVerification(
      makeRequest({
        payload: { to: '0x1111111111111111111111111111111111111111', data: '0xa9059cbb' },
      }),
      makeManifest(makePolicy({ unknown_contract_action: 'block' })),
      ss,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toBe('block');
    expect(entries[0].check).toBe('unknown_contract');
    expect(events[0].action).toBe('block');
  });

  it('alerts but passes unknown contract when unknown_contract_action=alert', () => {
    const { entries, events } = checkContractVerification(
      makeRequest({
        payload: { to: '0x1111111111111111111111111111111111111111', data: '0xa9059cbb' },
      }),
      makeManifest(makePolicy({ unknown_contract_action: 'alert' })),
      ss,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toBe('pass');
    expect(entries[0].check).toBe('unknown_contract');
    expect(events[0].action).toBe('alert');
  });

  it('blocks selector mismatch on known contract', () => {
    const { entries, events } = checkContractVerification(
      makeRequest({
        payload: {
          to: '0xabcdef1234567890abcdef1234567890abcdef12',
          data: '0xdeadbeef000000000000000000000000',
        },
      }),
      makeManifest(makePolicy()),
      ss,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toBe('block');
    expect(entries[0].check).toBe('selector_mismatch');
    expect(events[0].check).toBe('selector_mismatch');
  });

  it('blocks when param bounds exceeded', () => {
    const { entries, events } = checkContractVerification(
      makeRequest({
        payload: {
          to: '0xabcdef1234567890abcdef1234567890abcdef12',
          data: '0xa9059cbb000000000000000000000000',
          tool_params: { amount: 99999 },
        },
      }),
      makeManifest(makePolicy()),
      ss,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toBe('block');
    expect(entries[0].check).toBe('param_bounds');
    expect(events[0].check).toBe('param_bounds_exceeded');
  });

  it('passes when param is within bounds', () => {
    const { entries } = checkContractVerification(
      makeRequest({
        payload: {
          to: '0xabcdef1234567890abcdef1234567890abcdef12',
          data: '0xa9059cbb000000000000000000000000',
          tool_params: { amount: 5000 },
        },
      }),
      makeManifest(makePolicy()),
      ss,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toBe('pass');
  });

  it('blocks when no target address provided', () => {
    const { entries } = checkContractVerification(
      makeRequest({ payload: {} }),
      makeManifest(makePolicy()),
      ss,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toBe('block');
    expect(entries[0].check).toBe('contract_target');
  });

  it('case-insensitive address matching', () => {
    const { entries } = checkContractVerification(
      makeRequest({
        payload: {
          to: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
          data: '0xa9059cbb000000000000000000000000',
        },
      }),
      makeManifest(makePolicy()),
      ss,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toBe('pass');
  });
});

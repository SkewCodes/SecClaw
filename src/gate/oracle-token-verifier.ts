import { createSecClawEvent } from '../events/schema.js';
import type {
  GateCheckEntry,
  GateRequest,
  GateSharedState,
  PolicyManifest,
  SecClawEvent,
  OracleTokenPolicy,
  OracleAdapter,
  OraclePriceResult,
  TokenMetadata,
} from '../types.js';

let adapters: OracleAdapter[] = [];

export function registerOracleAdapters(newAdapters: OracleAdapter[]): void {
  adapters = newAdapters;
}

export function getRegisteredAdapters(): readonly OracleAdapter[] {
  return adapters;
}

export function checkOracleTokenVerification(
  request: GateRequest,
  manifest: PolicyManifest,
  _sharedState: GateSharedState,
): { entries: GateCheckEntry[]; events: SecClawEvent[] } {
  const entries: GateCheckEntry[] = [];
  const events: SecClawEvent[] = [];
  const policy = manifest.oracle;

  if (!policy) {
    entries.push({ module: 'oracle_token_verifier', check: 'oracle_policy', result: 'skip', latency_ms: 0 });
    return { entries, events };
  }

  if (request.action_type !== 'sign' && request.action_type !== 'call') {
    entries.push({ module: 'oracle_token_verifier', check: 'oracle_policy', result: 'skip', latency_ms: 0 });
    return { entries, events };
  }

  const start = performance.now();
  const token = extractToken(request);

  if (!token) {
    entries.push({ module: 'oracle_token_verifier', check: 'oracle_policy', result: 'skip', latency_ms: 0 });
    return { entries, events };
  }

  if (isBlocked(token, policy)) {
    const latency = Math.round(performance.now() - start);
    entries.push({ module: 'oracle_token_verifier', check: 'blocked_token', result: 'block', latency_ms: latency });
    events.push(makeEvent(request, 'block', 'critical', 'blocked_token', {
      expected: 'not in blocked list',
      actual: token,
      policy_rule: 'oracle.blocked_tokens',
      message: `Token ${token} is explicitly blocked`,
    }));
    return { entries, events };
  }

  const tokenMeta = extractTokenMetadata(request);
  if (tokenMeta) {
    const legitimacy = checkTokenLegitimacy(request, tokenMeta, policy);
    if (legitimacy) {
      const latency = Math.round(performance.now() - start);
      entries.push({ module: 'oracle_token_verifier', check: legitimacy.check, result: 'block', latency_ms: latency });
      events.push(legitimacy.event);
      return { entries, events };
    }
  }

  const prices = extractOraclePrices(request);
  if (prices && prices.length > 0) {
    const deviation = checkMultiSourceDeviation(request, prices, policy);
    if (deviation) {
      const latency = Math.round(performance.now() - start);
      entries.push({ module: 'oracle_token_verifier', check: 'oracle_deviation', result: 'block', latency_ms: latency });
      events.push(deviation);
      return { entries, events };
    }

    if (prices.length < policy.min_sources) {
      const latency = Math.round(performance.now() - start);
      entries.push({ module: 'oracle_token_verifier', check: 'insufficient_sources', result: 'block', latency_ms: latency });
      events.push(makeEvent(request, 'block', 'critical', 'insufficient_oracle_sources', {
        expected: `>= ${policy.min_sources} sources`,
        actual: prices.length,
        policy_rule: 'oracle.min_sources',
        message: `Only ${prices.length} oracle source(s) available, need ${policy.min_sources}`,
      }));
      return { entries, events };
    }
  }

  const latency = Math.round(performance.now() - start);
  entries.push({ module: 'oracle_token_verifier', check: 'oracle_verified', result: 'pass', latency_ms: latency });
  events.push(makeEvent(request, 'pass', 'info', 'oracle_verified', {
    expected: 'verified',
    actual: 'verified',
    policy_rule: 'oracle',
    message: `Token ${token} passed oracle verification`,
  }));

  return { entries, events };
}

function extractToken(request: GateRequest): string | null {
  const params = request.payload.tool_params as Record<string, unknown> | undefined;
  if (params?.token && typeof params.token === 'string') return params.token;
  if (params?.token_address && typeof params.token_address === 'string') return params.token_address;
  return request.payload.to ?? null;
}

function isBlocked(token: string, policy: OracleTokenPolicy): boolean {
  const lower = token.toLowerCase();
  return policy.blocked_tokens.some((b) => b.toLowerCase() === lower);
}

function extractTokenMetadata(request: GateRequest): TokenMetadata | null {
  const params = request.payload.tool_params as Record<string, unknown> | undefined;
  if (!params?.token_metadata) return null;
  const meta = params.token_metadata as Record<string, unknown>;
  if (
    typeof meta.address === 'string' &&
    typeof meta.liquidity_usd === 'number' &&
    typeof meta.age_hours === 'number' &&
    typeof meta.holders === 'number'
  ) {
    return meta as unknown as TokenMetadata;
  }
  return null;
}

function extractOraclePrices(request: GateRequest): OraclePriceResult[] | null {
  const params = request.payload.tool_params as Record<string, unknown> | undefined;
  if (!params?.oracle_prices || !Array.isArray(params.oracle_prices)) return null;
  return params.oracle_prices as OraclePriceResult[];
}

function checkTokenLegitimacy(
  request: GateRequest,
  meta: TokenMetadata,
  policy: OracleTokenPolicy,
): { check: string; event: SecClawEvent } | null {
  const leg = policy.token_legitimacy;

  if (meta.liquidity_usd < leg.min_liquidity_usd) {
    return {
      check: 'token_liquidity',
      event: makeEvent(request, 'block', 'critical', 'token_low_liquidity', {
        expected: `>= $${leg.min_liquidity_usd}`,
        actual: meta.liquidity_usd,
        policy_rule: 'oracle.token_legitimacy.min_liquidity_usd',
        message: `Token liquidity $${meta.liquidity_usd} below minimum $${leg.min_liquidity_usd}`,
      }),
    };
  }

  if (meta.age_hours < leg.min_age_hours) {
    return {
      check: 'token_age',
      event: makeEvent(request, 'block', 'critical', 'token_too_new', {
        expected: `>= ${leg.min_age_hours}h`,
        actual: `${meta.age_hours}h`,
        policy_rule: 'oracle.token_legitimacy.min_age_hours',
        message: `Token age ${meta.age_hours}h below minimum ${leg.min_age_hours}h`,
      }),
    };
  }

  if (meta.holders < leg.min_holders) {
    return {
      check: 'token_holders',
      event: makeEvent(request, 'block', 'critical', 'token_low_holders', {
        expected: `>= ${leg.min_holders}`,
        actual: meta.holders,
        policy_rule: 'oracle.token_legitimacy.min_holders',
        message: `Token has ${meta.holders} holders, below minimum ${leg.min_holders}`,
      }),
    };
  }

  return null;
}

function checkMultiSourceDeviation(
  request: GateRequest,
  prices: OraclePriceResult[],
  policy: OracleTokenPolicy,
): SecClawEvent | null {
  if (prices.length < 2) return null;

  const values = prices.map((p) => p.price);
  const min = Math.min(...values);
  const max = Math.max(...values);

  if (min === 0) {
    return makeEvent(request, 'block', 'critical', 'oracle_zero_price', {
      expected: 'non-zero prices',
      actual: values,
      policy_rule: 'oracle.max_deviation_pct',
      message: 'Oracle source reported zero price',
    });
  }

  const deviationPct = ((max - min) / min) * 100;

  if (deviationPct > policy.max_deviation_pct) {
    return makeEvent(request, 'block', 'critical', 'oracle_deviation_exceeded', {
      expected: `<= ${policy.max_deviation_pct}%`,
      actual: `${deviationPct.toFixed(2)}%`,
      policy_rule: 'oracle.max_deviation_pct',
      message: `Oracle price deviation ${deviationPct.toFixed(2)}% exceeds max ${policy.max_deviation_pct}% (sources: ${prices.map((p) => `${p.source}=$${p.price}`).join(', ')})`,
    });
  }

  return null;
}

function makeEvent(
  request: GateRequest,
  action: 'pass' | 'block' | 'alert',
  severity: 'info' | 'warning' | 'critical',
  check: string,
  details: { expected: unknown; actual: unknown; policy_rule: string; message: string },
): SecClawEvent {
  return createSecClawEvent({
    source: 'gate',
    agent_id: request.agent_id,
    module: 'oracle_token_verifier',
    action,
    severity,
    check,
    details,
    execution_context: {
      contract_address: request.payload.to,
    },
  });
}

# SecClaw

Security, oversight, and integrity layer for autonomous trading agents on [Orderly Network](https://orderly.network).

SecClaw is a watchdog daemon and pre-execution gate that continuously monitors five autonomous agents — YieldClaw, Orderly Agentic MM, the Orderly Agent Payment Layer (Guardian), OtterClaw, and the Orderly Growth Agent — enforcing policy limits, detecting cross-system risks, gating agent actions before execution, and alerting operators before problems escalate.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        SecClaw v2 Process                                │
│                                                                          │
│  ┌────────────────────────── V1 Daemon ───────────────────────────────┐  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────┐ │  │
│  │  │ YieldClaw│ │ Agentic  │ │ Guardian │ │ OtterClaw│ │ Growth  │ │  │
│  │  │  Probe   │ │ MM Probe │ │  Probe   │ │  Probe   │ │ Probe   │ │  │
│  │  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬────┘ │  │
│  │       └──────┬──────┴──────┬─────┴──────┬──────┘            │      │  │
│  │         Assertions   Drift   Correlator   Integrity         │      │  │
│  └─────────────────────────────┬──────────────────────────────────────┘  │
│                                │                                         │
│                         Shared State                                     │
│                         (critical alerts)                                │
│                                │                                         │
│  ┌──────────────────── V2 Gate ┴──────────────────────────────────────┐  │
│  │  Agent ──▶ Gate Orchestrator ──▶ Dependency Attestor              │  │
│  │                    │              ──▶ Signer Health               │  │
│  │                    │              ──▶ (future: contracts, MCP)    │  │
│  │                    ▼                                               │  │
│  │              GateResponse (allow/block)                            │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                │                                         │
│  ┌────────────── V2 Event System ─────────────────────────────────────┐  │
│  │  SecClawEvent (Zod schema) ──▶ V2 JSONL log                      │  │
│  │                             ──▶ V1 AlertBus bridge (Telegram/WH)  │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  ┌─────── Alert Pipeline ─────────────────────────────────────────────┐  │
│  │  JSONL Logger │ Telegram │ Webhook │ Pause Signal │ 24h Digest    │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

## V2 Gate

V2 introduces a **synchronous gate function** that agents call before executing any action. The gate runs in the same process as the V1 daemon, sharing state (e.g., active critical alerts block policy loosening).

Agents import and call the gate directly — no HTTP server required:

```typescript
import { callGate } from '@orderly/secclaw';

const response = await callGate({
  agent_id: 'yieldclaw',
  action_type: 'sign',
  payload: {
    to: '0x...',
    data: '0x...',
    value_usd: 5000,
    gas_limit: 200000,
    gas_price: '50000000000',
    wallet_address: '0x...',
  },
});

if (!response.allowed) {
  console.log(`Blocked: ${response.reason}`);
}
```

### Dependency Attestor

Supply-chain integrity verification for `node_modules`:

- **Build-time**: `npm run secclaw:attest` walks `node_modules`, computes SHA-256 hashes of every package, and writes `.secclaw/attestation.json`
- **Runtime**: First gate call verifies live packages against the manifest. Hash mismatch blocks all subsequent calls until re-attested
- Checks against `dependencies.blocked_packages` list in the policy manifest
- Configurable mode: `strict` (block on mismatch), `warn` (alert only), `disabled`

### Signer Health

Comprehensive pre-execution checks for transaction signing, all in-memory with <10ms target latency:

| Check | Description |
|-------|-------------|
| **Nonce Sequencing** | Strict-mode nonce validation with disk persistence (`.secclaw/nonce-state.json`) |
| **Balance Threshold** | Blocks if wallet balance falls below `signer.immutable.balance_minimum_eth` (refreshed via viem each tick) |
| **Gas Bounds** | Enforces `gas.max_price_gwei` and `gas.max_limit` from policy |
| **Rate Limiter** | Token-bucket rate limiter (per-minute / per-hour / per-day) with atomic check-then-consume |
| **Cooldown** | Minimum time between signatures |
| **Cumulative Exposure** | Rolling-window USD exposure tracking with configurable window and ceiling |
| **Acceleration Detection** | Flags rapid increases in signing frequency (gradient-based) |
| **Target Switch Detection** | Flags new contract addresses appearing mid-session |

### Tiered Mutability Model

Policy parameters are organized into enforcement tiers:

- **Tier 1 (Immutable)**: Set at deploy-time, frozen in memory. All Tier 2 adjustments are validated against Tier 1 ceilings. Includes `cumulative_exposure_ceiling_usd`, `balance_minimum_eth`, `gas_ceiling_gwei`, `rate_limits_ceiling`, `min_cooldown_ms`, `critical_alert_lock`.

- **Tier 2 (Operator-adjustable)**: Operators can adjust parameters within Tier 1 bounds via the `SignerModificationManager`. Tightening is instant; loosening is delayed by `modification_delay_sec` (with per-parameter overrides like `delay_override_sec`). Active critical alerts block all loosening when `critical_alert_lock` is enabled. Changes propagate to live rate limiters and exposure trackers.

### Audit Mode

The `--audit-mode` flag runs all gate checks but never blocks — events are emitted with `action: "alert"` instead of `"block"`. This allows gradual rollout: agents integrate the gate, observe what would be blocked, then enable enforcement.

## What It Monitors (V1 Daemon)

| Agent | Data Source | Key Checks |
|-------|-----------|------------|
| **YieldClaw** | HTTP API | Drawdown limits, circuit breaker determinism, NAV drift, share price rate-of-change, leverage, position count |
| **Agentic MM** | CLI + HTTP API | PnL drawdown, free collateral ratio, position sizing, implied leverage, circuit breaker consistency, auto-tuner rate limits, quality grade |
| **Guardian** | Audit log (JSONL) | Policy bypass detection, spending limits, swap/vault enforcement, session TTL, audit log tampering |
| **OtterClaw** | Filesystem scan | Skill hash integrity, frontmatter validation, injection/credential/shell pattern scanning, URL allowlist |
| **Growth Agent** | Audit log + state file | Playbook allowlist, fee change bounds, campaign limits, watchdog enforcement, builder tier floor |

### Cross-System Correlation Rules

- **Aggregate Exposure** — Total exposure across all agents vs global limit
- **Symbol Conflict** — YieldClaw and MM holding opposing positions on the same pair
- **Directional Coherence** — Both agents amplifying the same directional bet
- **Correlated Stress** — Multiple systems in protective state simultaneously (market event)
- **Prolonged Stress** — Adverse conditions persisting across consecutive cycles
- **Growth/Fee Conflict** — Fee cuts compressing MM spreads, campaigns during circuit breaker events
- **Session Lifecycle** — Rapid intent creation, excessive denials, TTL violations
- **Flagged Account Leakage** — Watchdog-flagged accounts still trading via Guardian

### On-Chain Verification

When `SECCLAW_VAULT_CONTRACT` and `SECCLAW_RPC_URL` are configured, SecClaw reads `totalSupply()` and `totalAssets()` directly from the vault contract on Arbitrum and compares against reported values — trust-minimized NAV verification via [viem](https://viem.sh).

## Quick Start

```bash
# Install
npm install

# Generate dependency attestation manifest
npm run secclaw:attest

# Run single check
npm run check -- --config ./policy-manifest.yaml --verbose

# Run as daemon
npm start -- --verbose

# Run as daemon with gate in audit mode
npm start -- --verbose --audit-mode

# Run tests
npm test

# Type check
npm run typecheck

# Build for production
npm run build
```

## Configuration

SecClaw is configured through a combination of **CLI flags**, **environment variables**, and a **policy manifest** YAML file.

### CLI Flags

| Flag | Description | Default |
|------|------------|---------|
| `--config <path>` | Path to policy-manifest.yaml | `./policy-manifest.yaml` |
| `--once` | Run one check cycle and exit (exit code 1 if alerts) | `false` |
| `--dry-run` | Run checks but suppress external alerts | `false` |
| `--verbose` | Enable detailed logging | `false` |
| `--audit-mode` | Gate runs all checks but never blocks (log-only) | `false` |

### Environment Variables

| Variable | Description | Default |
|----------|------------|---------|
| `POLL_INTERVAL_SEC` | Seconds between check cycles | `30` |
| `LOG_PATH` | Path to JSONL audit log | `./secclaw-audit.jsonl` |
| `YIELDCLAW_URL` | YieldClaw API base URL | `http://localhost:8080` |
| `YIELDCLAW_HEALTH_TOKEN` | Bearer token for YieldClaw API | |
| `MM_ACCOUNT_ID` | Orderly account ID for MM CLI queries | |
| `MM_NETWORK` | Network for MM CLI (`mainnet` / `testnet`) | `testnet` |
| `MM_STATUS_URL` | Optional HTTP status API URL for richer MM data | |
| `GUARDIAN_LOG_PATH` | Path to Guardian audit JSONL | `./guardian-audit.jsonl` |
| `OTTERCLAW_SKILLS_PATH` | Path to OtterClaw skills directory | `../OtterClaw/skills` |
| `GROWTH_AGENT_AUDIT_PATH` | Path to Growth Agent audit JSONL | `~/.orderly/growth-agent/audit.jsonl` |
| `GROWTH_AGENT_STATE_PATH` | Path to Growth Agent state JSON | `~/.orderly/growth-agent/state.json` |
| `SECCLAW_TG_BOT_TOKEN` | Telegram bot token for alerts | |
| `SECCLAW_TG_CHAT_ID` | Telegram chat ID for alerts | |
| `SECCLAW_WEBHOOK_URL` | Generic webhook URL for alerts | |
| `PAUSE_PORT` | Port for pause signal broadcast (enables if set) | `9999` |
| `SECCLAW_HEALTH_PORT` | HTTP health endpoint port | `9090` |
| `SECCLAW_HEALTH_TOKEN` | Bearer token to protect `/status` endpoint | |
| `SECCLAW_VAULT_CONTRACT` | Vault contract address for on-chain verification | |
| `SECCLAW_RPC_URL` | Arbitrum RPC URL for on-chain reads + balance refresh | |
| `SECCLAW_VAULT_DECIMALS` | Token decimals for on-chain math | `6` |

### Policy Manifest

The `policy-manifest.yaml` defines every limit, allowlist, and threshold. It is Zod-validated on load and supports **hot-reload** — edit the file while the daemon is running and changes take effect on the next cycle.

V2 adds optional sections for the gate (backward-compatible with v1.0 manifests):

```yaml
# V2 sections (all optional — V1 manifests load unchanged)
dependencies:
  attestation: strict          # strict | warn | disabled
  attestation_path: ./.secclaw/attestation.json
  blocked_packages: []
  drift_action: block          # block | alert

signer:
  immutable:
    cumulative_exposure_ceiling_usd: 100000
    balance_minimum_eth: 0.01
    nonce_mode: strict
    rate_limits_ceiling: { per_minute: 50, per_day: 2000 }
    min_cooldown_ms: 100
    gas_ceiling_gwei: 500
    modification_delay_sec: 300
    critical_alert_lock: true
  rate_limits: { per_minute: 10, per_hour: 100, per_day: 500 }
  cooldown_ms: 500
  cumulative_exposure:
    window: 1h
    max_usd: 50000
    delay_override_sec: 600    # longer delay for loosening this parameter
  gas: { max_price_gwei: 100, max_limit: 500000 }
  acceleration_detection: true
  target_switch_detection: true
```

See [`policy-manifest.yaml`](./policy-manifest.yaml) for the full schema with testnet defaults.

## Health Endpoint

SecClaw exposes an HTTP health server (default port `9090`):

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /health` | None | Returns `200` (healthy) or `503` (unhealthy/stale). Use for container orchestrator health checks. |
| `GET /status` | Token (if configured) | Detailed system status: per-probe health, alert counts, latencies. |

```bash
# Health check
curl http://localhost:9090/health

# Detailed status (with token)
curl -H "Authorization: Bearer $SECCLAW_HEALTH_TOKEN" http://localhost:9090/status
```

## Alert Pipeline

1. **Dedup** — Same source/check/severity/discriminator suppressed for 5 minutes
2. **Escalation** — Alerts persisting 6+ consecutive cycles are promoted one severity level
3. **Routing** — Alerts dispatched in parallel to all registered handlers:
   - **JSONL Logger** — Append-only local audit log (V1 format)
   - **V2 JSONL Logger** — Parallel stream with structured `SecClawEvent` schema for downstream consumption
   - **Telegram** — Rate-limited (3s interval), severity-filtered, emoji-coded
   - **Webhook** — JSON POST to any URL, rate-limited (1s interval)
   - **Pause Signal** — Critical-only HTTP POST to agent pause endpoints
4. **V1/V2 Bridge** — Gate block events are converted to V1 alerts and routed through Telegram/Webhook/Pause Signal
5. **Digest** — Every 24h, a Markdown summary with health grade (A–F) is written to disk and pushed through Telegram/Webhook

## V2 Event System

All V2 events follow a unified, Zod-validated schema:

```typescript
interface SecClawEvent {
  id: string;                 // UUID v4
  version: "2.0";
  timestamp: string;          // ISO 8601
  source: "daemon" | "gate";
  agent_id: string;
  module: string;             // e.g. "signer_health", "dependency_attestor"
  action: "pass" | "block" | "alert" | "escalate";
  severity: "info" | "warning" | "critical";
  check: string;
  details: {
    expected: unknown;
    actual: unknown;
    policy_rule: string;
    message: string;
  };
  execution_context?: {       // gate events only
    contract_address?: string;
    function_selector?: string;
    gas_estimate?: number;
    value_usd?: number;
    tool_name?: string;
  };
  trace_id: string;
  session_id?: string;
}
```

V2 events are written to a dedicated JSONL file (`*-v2.jsonl`) alongside the V1 audit log. Block events are bridged to the V1 AlertBus so existing Telegram/webhook integrations continue working without changes.

## Docker

```bash
# Build
docker build -t secclaw .

# Run
docker run -d \
  -e YIELDCLAW_URL=http://yieldclaw:8080 \
  -e MM_ACCOUNT_ID=0x... \
  -e SECCLAW_TG_BOT_TOKEN=... \
  -e SECCLAW_TG_CHAT_ID=... \
  -e SECCLAW_RPC_URL=https://arb1.arbitrum.io/rpc \
  -p 9090:9090 \
  secclaw
```

The Dockerfile includes a built-in `HEALTHCHECK` instruction.

## Project Structure

```
src/
├── daemon.ts              # Entry point, tick loop, orchestration, gate wiring
├── config.ts              # CLI + env var configuration (incl. --audit-mode)
├── types.ts               # All TypeScript interfaces (V1 + V2)
├── utils.ts               # Shared helpers
├── health.ts              # HTTP health/status server
├── gate/                  # V2 Gate (new)
│   ├── index.ts           # Gate orchestrator (audit-mode, module sequencing)
│   ├── dependency-attestor.ts  # Build-time + runtime attestation
│   └── signer-health.ts  # Nonce, balance, gas, rate limit, exposure, mods
├── events/                # V2 Event System (new)
│   ├── schema.ts          # SecClawEvent Zod schema + factory
│   └── emitter.ts         # V2 JSONL writer + V1 AlertBus bridge
├── probes/
│   ├── yieldclaw.ts       # HTTP API probe
│   ├── mm.ts              # CLI + HTTP dual-mode probe
│   ├── payment-layer.ts   # Incremental JSONL reader
│   ├── otterclaw.ts       # Filesystem skill scanner
│   └── growth-agent.ts    # Incremental JSONL + state reader
├── policy/
│   ├── manifest.ts        # Zod-validated YAML loader + hot-reload (V2 extended)
│   ├── assertion.ts       # Per-system policy checks
│   └── drift-detector.ts  # Time-series trend analysis
├── audit/
│   ├── correlator.ts      # Cross-system rule orchestrator
│   └── rules/
│       ├── aggregate-exposure.ts
│       ├── symbol-conflict.ts
│       ├── correlated-stress.ts
│       ├── directional-coherence.ts
│       ├── session-lifecycle.ts
│       └── growth-fee-conflict.ts
├── integrity/
│   ├── skill-scanner.ts   # Injection/credential/shell pattern detection
│   ├── schema-validator.ts # Skill frontmatter validation
│   └── onchain-verifier.ts # On-chain contract reads via viem
├── alerts/
│   ├── bus.ts             # Dedup + parallel dispatch
│   ├── escalation.ts      # Persistence-based severity promotion
│   ├── logger.ts          # JSONL append-only logger
│   ├── telegram.ts        # Telegram bot handler
│   ├── webhook.ts         # Generic webhook handler
│   └── pause-signal.ts    # Critical-only pause broadcaster
└── reports/
    └── digest.ts          # 24h summary report generator

scripts/
└── attest.ts              # Build-time dependency attestation (npm run secclaw:attest)

.secclaw/                  # Runtime artifacts (gitignored)
├── attestation.json       # Dependency attestation manifest
└── nonce-state.json       # Persisted nonce tracker
```

## Testing

```bash
npm test              # Run all 166 tests
npm run test:watch    # Watch mode
```

Tests cover V1 assertions, correlation rules, drift detection, alert bus dedup/escalation, health server auth, probe incremental reading, on-chain verifier logic, V2 event schema/emitter, gate orchestrator, dependency attestor (build + runtime), signer health (all checks), rate limiter atomicity, balance enforcement, exposure window pruning, acceleration detection, Tier 2 modification lifecycle with delay propagation, and full daemon+gate integration.

## License

MIT

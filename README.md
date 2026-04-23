# SecClaw

Security, oversight, and integrity layer for autonomous trading agents on [Orderly Network](https://orderly.network).

SecClaw is a watchdog daemon, pre-execution gate, and supply chain defense system that continuously monitors six autonomous agents — YieldClaw, Orderly Agentic MM, the Orderly Agent Payment Layer (Guardian), OtterClaw, the Orderly Growth Agent, and the Listing Agent — enforcing policy limits, detecting cross-system risks, gating agent actions before execution, blocking malicious packages before they install, and alerting operators before problems escalate.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          SecClaw v2 Process                                │
│                                                                            │
│  ┌──────────────────────────── Daemon ──────────────────────────────────┐  │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌──────┐ ┌─────┐ │  │
│  │  │YieldClaw│ │Agentic  │ │Guardian │ │OtterClaw│ │Growth│ │List-│ │  │
│  │  │ Probe   │ │MM Probe │ │ Probe   │ │ Probe   │ │Probe │ │ ing │ │  │
│  │  └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘ └──┬───┘ └──┬──┘ │  │
│  │       └─────┬─────┴─────┬─────┴─────┬─────┘         │        │    │  │
│  │        Assertions  Drift  Correlator  Integrity       │        │    │  │
│  └────────────────────────────┬──────────────────────────────────────┘  │
│                               │                                         │
│  ┌──── Supply Chain Telemetry ┴─────────────────────────────────────┐  │
│  │  ┌───────────┐ ┌──────┐ ┌───────┐ ┌───────┐ ┌──────────┐       │  │
│  │  │Workstation│ │GitHub│ │Process│ │Network│ │Filesystem│       │  │
│  │  │  Probe    │ │Probe │ │Probe  │ │Probe  │ │  Probe   │       │  │
│  │  └─────┬─────┘ └──┬───┘ └──┬────┘ └──┬────┘ └────┬─────┘       │  │
│  │        └────┬──────┴────┬───┘         │           │             │  │
│  │     Worm Correlator  Credential    Workflow                     │  │
│  │     (Shai-Hulud)     Radius        Drift                        │  │
│  └──────────────────────────┬───────────────────────────────────────┘  │
│                              │                                         │
│                       Shared State                                     │
│                       (critical alerts)                                │
│                              │                                         │
│  ┌───────────────── V2 Gate ─┴──────────────────────────────────────┐  │
│  │  Agent ──▶ Gate Orchestrator ──▶ Dependency Attestor            │  │
│  │                    │              ──▶ Signer Health             │  │
│  │                    │              ──▶ Listing Cooldown          │  │
│  │                    ▼                                             │  │
│  │              GateResponse (allow/block)                          │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                              │                                         │
│  ┌─── Pre-Install Gate (CLI) ───────────────────────────────────────┐  │
│  │  secclaw-preinstall ──▶ Hook Sandbox                            │  │
│  │                       ──▶ Quarantine Window (npm registry)      │  │
│  │                       ──▶ Behavioral Diff (exfil/cred scan)     │  │
│  │                       ──▶ Lockfile Attestation                  │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                              │                                         │
│  ┌──── Automated Response ──┴───────────────────────────────────────┐  │
│  │  Deploy Pause │ Token Revoke │ Signer Rotate │ Builder Quarantine│  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                              │                                         │
│  ┌─────── Alert Pipeline ───┴───────────────────────────────────────┐  │
│  │  JSONL Logger │ Telegram │ Webhook │ Pause Signal │ 24h Digest  │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                              │                                         │
│  ┌────────── V2 Event System ───────────────────────────────────────┐  │
│  │  SecClawEvent (Zod schema) ──▶ V2 JSONL log                    │  │
│  │                             ──▶ V1 AlertBus bridge (TG/WH)      │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

## Supply Chain Defense

SecClaw includes a multi-layered supply chain defense system designed to block attacks like the [Bitwarden Shai-Hulud compromise](https://www.checkmarx.com/blog) before they reach builder workstations.

### Pre-Install Gate (CLI)

Run `npm run secclaw:preinstall` (or `npx secclaw-preinstall`) before `npm install` to enforce four synchronous checks:

| Gate | What It Does |
|------|-------------|
| **Hook Sandbox** | Blocks packages with `preinstall`/`postinstall` lifecycle hooks unless explicitly allowlisted |
| **Quarantine Window** | Blocks packages published within the last N hours (default 24h). Queries the npm registry for publish dates. Trusted publishers do **not** bypass quarantine |
| **Behavioral Diff** | Static analysis of package source for exfil domains, sensitive path access (`~/.ssh`, `~/.aws`, `.env`, AI tool configs), and network call sites |
| **Lockfile Attestation** | Verifies `package-lock.json` SHA-256 hash against a signed attestation. Detects tampering between `attest` and `install` |

```bash
# Generate lockfile attestation
npm run secclaw:attest

# Run pre-install gate (fetches publish dates from npm registry)
npm run secclaw:preinstall

# Run without registry lookups (offline mode)
npm run secclaw:preinstall -- --skip-registry

# Output as JSON
npm run secclaw:preinstall -- --json
```

### Workstation Telemetry Probes

Five probes run every tick in daemon mode, feeding the correlator with builder workstation signals:

| Probe | Data Collected |
|-------|---------------|
| **WorkstationProbe** | Running processes, open ports, CLI tool versions (node, npm, bw, gh, git, docker) |
| **GitHubProbe** | Workflow file hashes, webhook events (push, collaborator changes) |
| **ProcessProbe** | Suspicious child processes (`curl \| bash`, `git push`, `npm publish`, etc.) |
| **NetworkProbe** | Active TCP connections, outbound traffic to non-allowlisted domains |
| **FilesystemProbe** | Changes to `~/.ssh`, `~/.aws`, `.env`, AI tool configs (`.claude`, `.cursor`, `.codex`, `.aider`) |

Probe allowlists are updated automatically on manifest hot-reload.

### Correlator Rules

| Rule | Detection Pattern | Severity |
|------|------------------|----------|
| **SupplyChainWormRule** | Shai-Hulud pattern: exfil endpoint + credential read + git push + workflow injection (2+ indicators) | Critical |
| **CredentialRadiusRule** | Suspicious process correlated with sensitive file access in the same snapshot | Critical |
| **WorkflowDriftDetector** | New or modified workflow files, collaborator changes via GitHub webhooks | Critical |

### Automated Response

When a critical `supply-chain.*` alert fires, registered response modules act automatically:

| Module | Action |
|--------|--------|
| **DeployPauseHandler** | Sends HTTP pause signal to halt deploy runners |
| **TokenRevokeHandler** | Revokes GitHub PATs and npm tokens via their APIs |
| **SignerRotateHandler** | Triggers ephemeral signer key rotation via configured endpoint |
| **QuarantineBuilderHandler** | Isolates the compromised builder from the deploy pipeline |

### Hardcoded Invariants

These safety rules are not policy-configurable:

- Trusted publisher status **never** bypasses quarantine or behavioral diff
- Signature validity is **never** sufficient on its own
- Critical `supply-chain.*` alerts **bypass** the 5-minute dedup cooldown
- Supply chain alerts **skip** cycle-based severity escalation (they fire at final severity immediately)

### Policy Configuration

```yaml
supplyChain:
  quarantineWindowHours: 24
  preinstallHookPolicy: blocklist       # blocklist | allowlist | sandbox
  preinstallHookAllowlist: []
  behavioralDiff:
    enabled: true
    newEndpointBlockThreshold: 1
    sensitivePathBlocklist:
      - "~/.ssh/**"
      - "~/.aws/**"
      - "**/.env"
      - "~/.claude/**"
      - "~/.cursor/**"
      - "~/.codex/**"
      - "~/.aider/**"
  exfilDomainBlocklist:
    - "audit.checkmarx.cx"
  trustedPublishers:
    - "@bitwarden"
    - "@orderly-network"
  lockfileAttestation:
    required: true
    algorithm: "sha256"
```

## V2 Gate

V2 introduces a **synchronous gate function** that agents call before executing any action. The gate runs in the same process as the daemon, sharing state (e.g., active critical alerts block policy loosening).

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

## What It Monitors (Daemon)

| Agent | Data Source | Key Checks |
|-------|-----------|------------|
| **YieldClaw** | HTTP API | Drawdown limits, circuit breaker determinism, NAV drift, share price rate-of-change, leverage, position count |
| **Agentic MM** | CLI + HTTP API | PnL drawdown, free collateral ratio, position sizing, implied leverage, circuit breaker consistency, auto-tuner rate limits, quality grade |
| **Guardian** | Audit log (JSONL) | Policy bypass detection, spending limits, swap/vault enforcement, session TTL, audit log tampering |
| **OtterClaw** | Filesystem scan | Skill hash integrity, frontmatter validation, injection/credential/shell pattern scanning, URL allowlist |
| **Growth Agent** | Audit log + state file | Playbook allowlist, fee change bounds, campaign limits, watchdog enforcement, builder tier floor |
| **Listing Agent** | Audit log | Self-listing cooldowns, max markets per window, seed liquidity bounds, oracle source requirements, wash trading detection |

### Cross-System Correlation Rules

- **Aggregate Exposure** — Total exposure across all agents vs global limit
- **Symbol Conflict** — YieldClaw and MM holding opposing positions on the same pair
- **Directional Coherence** — Both agents amplifying the same directional bet
- **Correlated Stress** — Multiple systems in protective state simultaneously (market event)
- **Prolonged Stress** — Adverse conditions persisting across consecutive cycles
- **Growth/Fee Conflict** — Fee cuts compressing MM spreads, campaigns during circuit breaker events
- **Session Lifecycle** — Rapid intent creation, excessive denials, TTL violations
- **Flagged Account Leakage** — Watchdog-flagged accounts still trading via Guardian
- **Wash Listing** — Self-trading patterns on newly listed markets
- **Ghost Listing** — Markets listed without oracle backing
- **Supply Chain Worm** — Shai-Hulud multi-stage propagation pattern
- **Credential Radius** — Suspicious processes correlated with credential file access
- **Workflow Drift** — Unauthorized changes to GitHub Actions workflows

### On-Chain Verification

When `SECCLAW_VAULT_CONTRACT` and `SECCLAW_RPC_URL` are configured, SecClaw reads `totalSupply()` and `totalAssets()` directly from the vault contract on Arbitrum and compares against reported values — trust-minimized NAV verification via [viem](https://viem.sh).

## Quick Start

```bash
# Install
npm install

# Generate dependency attestation manifest
npm run secclaw:attest

# Run pre-install supply chain gate
npm run secclaw:preinstall

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
| `LISTING_AUDIT_LOG_PATH` | Path to Listing Agent audit JSONL | `./listing-audit.jsonl` |
| `SECCLAW_TG_BOT_TOKEN` | Telegram bot token for alerts | |
| `SECCLAW_TG_CHAT_ID` | Telegram chat ID for alerts | |
| `SECCLAW_WEBHOOK_URL` | Generic webhook URL for alerts | |
| `PAUSE_PORT` | Port for pause signal broadcast (enables if set) | `9999` |
| `SECCLAW_HEALTH_PORT` | HTTP health endpoint port | `9090` |
| `SECCLAW_HEALTH_TOKEN` | Bearer token to protect `/status` endpoint | |
| `SECCLAW_VAULT_CONTRACT` | Vault contract address for on-chain verification | |
| `SECCLAW_RPC_URL` | Arbitrum RPC URL for on-chain reads + balance refresh | |
| `SECCLAW_VAULT_DECIMALS` | Token decimals for on-chain math | `6` |
| `SECCLAW_GITHUB_TOKEN` | GitHub PAT for workflow file monitoring | |
| `SECCLAW_GITHUB_REPOS` | Comma-separated list of `owner/repo` to monitor | |
| `SECCLAW_DEPLOY_RUNNER_PORT` | Port for deploy runner pause signal | |
| `SECCLAW_SIGNER_ROTATE_ENDPOINT` | URL to trigger signer key rotation | |
| `SECCLAW_REVOKE_GITHUB_TOKEN` | GitHub token to revoke on compromise | |
| `SECCLAW_REVOKE_NPM_TOKEN` | npm token to revoke on compromise | |

### Policy Manifest

The `policy-manifest.yaml` defines every limit, allowlist, and threshold. It is Zod-validated on load and supports **hot-reload** — edit the file while the daemon is running and changes take effect on the next cycle. Supply chain probe allowlists (network domains, filesystem paths) are also updated on reload.

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

1. **Dedup** — Same source/check/severity/discriminator suppressed for 5 minutes. Critical `supply-chain.*` alerts **bypass** dedup entirely
2. **Escalation** — Alerts persisting 6+ consecutive cycles are promoted one severity level. Supply chain alerts **skip** escalation (they fire at final severity immediately)
3. **Routing** — Alerts dispatched in parallel to all registered handlers:
   - **JSONL Logger** — Append-only local audit log (V1 format)
   - **V2 JSONL Logger** — Parallel stream with structured `SecClawEvent` schema for downstream consumption
   - **Telegram** — Rate-limited (3s interval), severity-filtered, emoji-coded, with per-builder topic routing for supply chain alerts
   - **Webhook** — JSON POST to any URL, rate-limited (1s interval)
   - **Pause Signal** — Critical-only HTTP POST to agent pause endpoints
4. **Automated Response** — Critical supply chain alerts trigger deploy pause, token revocation, signer rotation, and builder quarantine
5. **V1/V2 Bridge** — Gate block events are converted to V1 alerts and routed through Telegram/Webhook/Pause Signal
6. **Digest** — Every 24h, a Markdown summary with health grade (A-F) is written to disk and pushed through Telegram/Webhook

## V2 Event System

All V2 events follow a unified, Zod-validated schema:

```typescript
interface SecClawEvent {
  id: string;                 // UUID v4
  version: "2.0";
  timestamp: string;          // ISO 8601
  source: "daemon" | "gate";
  agent_id: string;
  module: string;             // e.g. "signer_health", "supply_chain_worm"
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
  -e SECCLAW_GITHUB_TOKEN=ghp_... \
  -e SECCLAW_GITHUB_REPOS=SkewCodes/SecClaw,SkewCodes/OtterClaw \
  -p 9090:9090 \
  secclaw
```

The Dockerfile includes a built-in `HEALTHCHECK` instruction.

## Project Structure

```
src/
├── daemon.ts              # Entry point, tick loop, orchestration, probe/response wiring
├── config.ts              # CLI + env var configuration (incl. --audit-mode)
├── types.ts               # All TypeScript interfaces (V1 + V2 + supply chain)
├── utils.ts               # Shared helpers
├── health.ts              # HTTP health/status server
├── gate/                  # V2 Gate
│   ├── index.ts           # Gate orchestrator (audit-mode, module sequencing)
│   ├── dependency-attestor.ts  # Build-time + runtime hash attestation
│   ├── listing-cooldown.ts     # Listing gate cooldown enforcement
│   └── signer-health.ts  # Nonce, balance, gas, rate limit, exposure, mods
├── supply-chain/          # Pre-install supply chain gates
│   ├── dependency-attestor.ts  # Quarantine window, behavioral diff, exfil scan
│   ├── hook-sandbox.ts    # Lifecycle hook policy enforcement
│   ├── binary-verifier.ts # Tier 3 stub: CLI binary integrity
│   └── mcp-tool-attestor.ts   # Tier 3 stub: MCP tool attestation
├── cli/
│   └── preinstall.ts      # CLI entry point for pre-install gate
├── hardening/
│   └── lockfile-attestation.ts  # SHA-256 lockfile generate + verify
├── response/              # Automated response modules
│   ├── deploy-pause.ts    # Halt deploy runners on critical alerts
│   ├── token-revoke.ts    # Revoke GitHub/npm tokens via API
│   ├── signer-rotate.ts   # Trigger ephemeral signer key rotation
│   └── quarantine-builder.ts   # Isolate compromised builders
├── events/                # V2 Event System
│   ├── schema.ts          # SecClawEvent Zod schema + factory
│   └── emitter.ts         # V2 JSONL writer + V1 AlertBus bridge
├── probes/
│   ├── yieldclaw.ts       # HTTP API probe
│   ├── mm.ts              # CLI + HTTP dual-mode probe
│   ├── payment-layer.ts   # Incremental JSONL reader
│   ├── otterclaw.ts       # Filesystem skill scanner
│   ├── growth-agent.ts    # Incremental JSONL + state reader
│   ├── listing.ts         # Listing audit log reader
│   ├── process-list.ts    # Shared OS process enumeration
│   ├── workstation.ts     # Builder workstation telemetry
│   ├── github.ts          # GitHub webhook + workflow monitor
│   ├── process.ts         # Suspicious process detector
│   ├── network.ts         # Outbound connection monitor
│   └── filesystem.ts      # Sensitive path change detector
├── policy/
│   ├── manifest.ts        # Zod-validated YAML loader + hot-reload
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
│       ├── growth-fee-conflict.ts
│       ├── cooldown-violation.ts
│       ├── ghost-listing.ts
│       ├── wash-listing.ts
│       ├── supply-chain-worm.ts    # Shai-Hulud worm pattern detector
│       ├── credential-radius.ts    # Credential theft correlator
│       └── workflow-drift.ts       # GitHub workflow integrity monitor
├── integrity/
│   ├── skill-scanner.ts   # Injection/credential/shell pattern detection
│   ├── schema-validator.ts # Skill frontmatter validation
│   └── onchain-verifier.ts # On-chain contract reads via viem
├── alerts/
│   ├── bus.ts             # Dedup + parallel dispatch (supply-chain bypass)
│   ├── escalation.ts      # Persistence-based severity promotion (supply-chain skip)
│   ├── logger.ts          # JSONL append-only logger
│   ├── telegram.ts        # Telegram bot handler (per-builder topic routing)
│   ├── webhook.ts         # Generic webhook handler
│   └── pause-signal.ts    # Critical-only pause broadcaster
└── reports/
    └── digest.ts          # 24h summary report generator

scripts/
└── attest.ts              # Build-time dependency attestation (npm run secclaw:attest)

test/
├── *.test.ts              # 26 test files, 299 tests
├── integration/
│   └── supply-chain-e2e.test.ts  # Full Shai-Hulud attack simulation
└── fixtures/
    └── supply-chain/      # Malicious + safe package fixtures

.secclaw/                  # Runtime artifacts (gitignored)
├── attestation.json       # Dependency attestation manifest
├── lockfile-attest.json   # Lockfile attestation record
└── nonce-state.json       # Persisted nonce tracker
```

## Testing

```bash
npm test              # Run all 299 tests
npm run test:watch    # Watch mode
```

Tests cover V1 assertions, correlation rules (including Shai-Hulud worm, credential radius, workflow drift), drift detection, alert bus dedup/escalation (with supply chain bypass verification), health server, probe incremental reading, on-chain verifier logic, V2 event schema/emitter, gate orchestrator, dependency attestor (build + runtime + pre-install), signer health (all checks), rate limiter atomicity, balance enforcement, exposure window pruning, acceleration detection, Tier 2 modification lifecycle with delay propagation, hook sandbox policy enforcement, lockfile attestation (generate + verify + tamper detection), automated response modules (deploy pause, token revoke, signer rotate, builder quarantine), pre-install CLI gate logic, listing gate/cooldown, and a full end-to-end Bitwarden Shai-Hulud attack simulation.

## License

MIT

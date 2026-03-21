# SecClaw

Security, oversight, and integrity layer for autonomous trading agents on [Orderly Network](https://orderly.network).

SecClaw is a watchdog daemon that continuously monitors five autonomous agents — YieldClaw, Orderly Agentic MM, the Orderly Agent Payment Layer (Guardian), OtterClaw, and the Orderly Growth Agent — enforcing policy limits, detecting cross-system risks, and alerting operators before problems escalate.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     SecClaw Daemon                          │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ YieldClaw│  │ Agentic  │  │ Guardian │  │ OtterClaw│   │
│  │  Probe   │  │ MM Probe │  │  Probe   │  │  Probe   │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
│       │              │              │              │         │
│  ┌────┴──────────────┴──────────────┴──────────────┴─────┐  │
│  │                  SystemSnapshot                       │  │
│  └───────────────────────┬───────────────────────────────┘  │
│                          │                                  │
│  ┌───────────┬───────────┼───────────┬──────────────┐       │
│  │ Policy    │ Drift     │ Cross-Sys │ Integrity    │       │
│  │Assertions │ Detector  │ Correlator│ Scanner      │       │
│  └─────┬─────┴─────┬─────┴─────┬─────┴──────┬──────┘       │
│        │           │           │            │               │
│  ┌─────┴───────────┴───────────┴────────────┴────────┐      │
│  │              Alert Bus (dedup + escalation)       │      │
│  └──┬──────────┬──────────┬──────────┬───────────────┘      │
│     │          │          │          │                       │
│  ┌──┴───┐  ┌──┴───┐  ┌──┴───┐  ┌──┴─────────┐             │
│  │ JSONL│  │Telegr.│  │Webhk.│  │Pause Signal│             │
│  │Logger│  │Handler│  │Handlr│  │Broadcaster │             │
│  └──────┘  └──────┘  └──────┘  └────────────┘             │
└─────────────────────────────────────────────────────────────┘
```

## What It Monitors

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

# Run single check
npm run check -- --config ./policy-manifest.yaml --verbose

# Run as daemon
npm start -- --verbose

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
| `SECCLAW_RPC_URL` | Arbitrum RPC URL for on-chain reads | |
| `SECCLAW_VAULT_DECIMALS` | Token decimals for on-chain math | `6` |

### Policy Manifest

The `policy-manifest.yaml` defines every limit, allowlist, and threshold. It is Zod-validated on load and supports **hot-reload** — edit the file while the daemon is running and changes take effect on the next cycle.

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
   - **JSONL Logger** — Append-only local audit log
   - **Telegram** — Rate-limited (3s interval), severity-filtered, emoji-coded
   - **Webhook** — JSON POST to any URL, rate-limited (1s interval)
   - **Pause Signal** — Critical-only HTTP POST to agent pause endpoints
4. **Digest** — Every 24h, a Markdown summary with health grade (A–F) is written to disk and pushed through Telegram/Webhook

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
  -p 9090:9090 \
  secclaw
```

The Dockerfile includes a built-in `HEALTHCHECK` instruction.

## Project Structure

```
src/
├── daemon.ts              # Entry point, tick loop, orchestration
├── config.ts              # CLI + env var configuration
├── types.ts               # All TypeScript interfaces
├── utils.ts               # Shared helpers
├── health.ts              # HTTP health/status server
├── probes/
│   ├── yieldclaw.ts       # HTTP API probe
│   ├── mm.ts              # CLI + HTTP dual-mode probe
│   ├── payment-layer.ts   # Incremental JSONL reader
│   ├── otterclaw.ts       # Filesystem skill scanner
│   └── growth-agent.ts    # Incremental JSONL + state reader
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
```

## Testing

```bash
npm test              # Run all 79 tests
npm run test:watch    # Watch mode
```

Tests cover assertions, correlation rules, drift detection, alert bus dedup/escalation, health server auth, probe incremental reading, and on-chain verifier logic.

## License

MIT

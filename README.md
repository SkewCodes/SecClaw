# SecClaw

Security, oversight, and integrity layer for autonomous trading agents on [Orderly Network](https://orderly.network).

Watchdog daemon, pre-execution gate, and supply chain defense system. Monitors six agents (YieldClaw, Agentic MM, Guardian, OtterClaw, Growth Agent, Listing Agent), enforces policy limits, gates actions before execution, blocks malicious packages before install, and auto-responds to compromise.

## Architecture

```
                          ┌─────────────────────────┐
                          │    SecClaw v2 Process    │
                          └────────────┬────────────┘
                                       │
          ┌────────────────────────────┼────────────────────────────┐
          │                            │                            │
    ┌─────▼──────┐            ┌────────▼────────┐          ┌───────▼───────┐
    │   Daemon   │            │    V2 Gate      │          │  Pre-Install  │
    │  Tick Loop │            │  (sync, <10ms)  │          │  CLI Gate     │
    └─────┬──────┘            └────────┬────────┘          └───────┬───────┘
          │                            │                           │
  ┌───────┼───────┐          ┌─────────┼────────┐        ┌────────┼────────┐
  │ Agent │ SC    │          │ Dep     │ Signer │        │ Hooks  │ Quaran │
  │ Probes│ Probes│          │ Attestor│ Health │        │ Sandbox│ -tine  │
  │ (6)   │ (5)   │          │         │        │        │        │ Window │
  └───┬───┴───┬───┘          └─────────┴────────┘        │ Behav. │ Lock-  │
      │       │                                          │ Diff   │ file   │
      ▼       ▼                                          └────────┴────────┘
  ┌───────────────┐
  │  Correlator   │──── 13 rules (incl. Shai-Hulud worm, credential radius)
  └───────┬───────┘
          │
  ┌───────▼───────────────────────────────────────────────────────────┐
  │  Alert Pipeline                                                   │
  │  Dedup ──▶ Escalation ──▶ JSONL / Telegram / Webhook / Pause     │
  │                          ──▶ Automated Response (4 modules)       │
  │                          ──▶ 24h Digest                           │
  └───────────────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
npm install
npm run secclaw:attest              # generate dependency attestation
npm run secclaw:preinstall          # pre-install supply chain gate
npm run check -- --verbose          # single check cycle
npm start -- --verbose              # daemon mode
npm start -- --verbose --audit-mode # gate logs but never blocks
npm test                            # 299 tests
```

## Supply Chain Defense

Multi-layered defense designed to block attacks like the [Bitwarden Shai-Hulud compromise](https://www.checkmarx.com/blog) before they reach builder workstations.

### Pre-Install Gate

Run `npm run secclaw:preinstall` before `npm install`. Four synchronous checks:

- **Hook Sandbox** -- blocks packages with lifecycle hooks unless allowlisted
- **Quarantine Window** -- blocks packages published within N hours (default 24h); queries npm registry for publish dates; trusted publishers do *not* bypass quarantine
- **Behavioral Diff** -- scans package source for exfil domains, sensitive path access (`~/.ssh`, `~/.aws`, `.env`, AI tool configs), and network call sites
- **Lockfile Attestation** -- verifies `package-lock.json` SHA-256 against a signed attestation

Options: `--skip-registry` (offline), `--json` (machine-readable output).

### Workstation Telemetry

Five probes run every daemon tick, feeding the correlator:

- **Workstation** -- running processes, open ports, CLI versions
- **GitHub** -- workflow file hashes, webhook events (push, collaborator changes)
- **Process** -- suspicious child processes (`curl | bash`, `git push`, `npm publish`)
- **Network** -- outbound connections to non-allowlisted domains
- **Filesystem** -- changes to `~/.ssh`, `~/.aws`, `.env`, AI tool configs

Probe allowlists update automatically on manifest hot-reload.

### Supply Chain Correlator Rules

| Rule | Pattern | Severity |
|------|---------|----------|
| **Worm Propagation** | Shai-Hulud: exfil + credential read + git push + workflow injection (2+ indicators) | Critical |
| **Credential Radius** | Suspicious process + sensitive file access in same snapshot | Critical |
| **Workflow Drift** | New/modified workflow files or collaborator changes | Critical |

### Automated Response

On critical `supply-chain.*` alerts, four response modules fire automatically:

- **Deploy Pause** -- halts deploy runners via HTTP pause signal
- **Token Revoke** -- revokes GitHub PATs and npm tokens via their APIs
- **Signer Rotate** -- triggers ephemeral signer key rotation
- **Builder Quarantine** -- isolates the compromised builder

### Hardcoded Invariants

- Trusted publishers *never* bypass quarantine or behavioral diff
- Critical supply-chain alerts *bypass* 5-minute dedup cooldown
- Supply chain alerts *skip* cycle-based escalation (fire at final severity immediately)

## V2 Gate

Synchronous gate function agents call before executing any action. Runs in-process with the daemon, sharing state.

```typescript
import { callGate } from '@orderly/secclaw';

const response = await callGate({
  agent_id: 'yieldclaw',
  action_type: 'sign',
  payload: { to: '0x...', data: '0x...', value_usd: 5000, gas_limit: 200000 },
});

if (!response.allowed) {
  console.log(`Blocked: ${response.reason}`);
}
```

**Gate modules:**

- **Dependency Attestor** -- build-time SHA-256 hashes of `node_modules`, runtime verification, blocked package list
- **Signer Health** -- nonce sequencing, balance threshold, gas bounds, rate limiting, cooldown, cumulative exposure, acceleration/target-switch detection
- **Listing Cooldown** -- enforces self-listing cooldown windows

**Tiered mutability:** Tier 1 parameters are immutable at deploy-time. Tier 2 parameters are operator-adjustable within Tier 1 ceilings, with delayed loosening and critical-alert lock.

**Audit mode:** `--audit-mode` runs all checks but never blocks.

## Daemon Monitoring

| Agent | Source | Key Checks |
|-------|--------|------------|
| **YieldClaw** | HTTP API | Drawdown, circuit breaker, NAV drift, share price, leverage |
| **Agentic MM** | CLI + HTTP | PnL drawdown, collateral, position sizing, auto-tuner limits |
| **Guardian** | JSONL log | Policy bypass, spending limits, session TTL, log tampering |
| **OtterClaw** | Filesystem | Skill hashes, frontmatter, injection/credential scanning |
| **Growth Agent** | JSONL + state | Playbook allowlist, fee bounds, campaign limits |
| **Listing Agent** | JSONL log | Cooldowns, market limits, seed liquidity, wash trading |

### Correlation Rules

Aggregate exposure, symbol conflict, directional coherence, correlated/prolonged stress, growth/fee conflict, session lifecycle, flagged account leakage, wash listing, ghost listing, supply chain worm, credential radius, workflow drift.

### On-Chain Verification

Reads `totalSupply()` and `totalAssets()` from the vault contract on Arbitrum via [viem](https://viem.sh) for trust-minimized NAV verification.

## Alert Pipeline

1. **Dedup** -- 5-minute cooldown per source/check/severity (supply-chain critical bypasses)
2. **Escalation** -- 6+ consecutive cycles promotes severity (supply-chain skips)
3. **Routing** -- JSONL logger, V2 JSONL, Telegram (per-builder topics), webhook, pause signal
4. **Automated Response** -- deploy pause, token revoke, signer rotate, builder quarantine
5. **V1/V2 Bridge** -- gate blocks convert to V1 alerts for existing integrations
6. **Digest** -- 24h Markdown summary with A-F health grade

## Configuration

### CLI Flags

`--config <path>`, `--once`, `--dry-run`, `--verbose`, `--audit-mode`

### Environment Variables

**Core:**

| Variable | Description | Default |
|----------|-------------|---------|
| `POLL_INTERVAL_SEC` | Seconds between check cycles | `30` |
| `LOG_PATH` | JSONL audit log path | `./secclaw-audit.jsonl` |
| `SECCLAW_HEALTH_PORT` | Health endpoint port | `9090` |
| `SECCLAW_HEALTH_TOKEN` | Bearer token for `/status` | |

**Agent probes:**

| Variable | Description |
|----------|-------------|
| `YIELDCLAW_URL` | YieldClaw API base URL |
| `YIELDCLAW_HEALTH_TOKEN` | Bearer token for YieldClaw |
| `MM_ACCOUNT_ID` | Orderly account ID for MM |
| `MM_NETWORK` | `mainnet` or `testnet` |
| `MM_STATUS_URL` | Optional MM HTTP status API |
| `GUARDIAN_LOG_PATH` | Guardian audit JSONL path |
| `OTTERCLAW_SKILLS_PATH` | OtterClaw skills directory |
| `GROWTH_AGENT_AUDIT_PATH` | Growth Agent audit path |
| `LISTING_AUDIT_LOG_PATH` | Listing Agent audit path |

**Alerting:**

| Variable | Description |
|----------|-------------|
| `SECCLAW_TG_BOT_TOKEN` | Telegram bot token |
| `SECCLAW_TG_CHAT_ID` | Telegram chat ID |
| `SECCLAW_WEBHOOK_URL` | Webhook URL |
| `PAUSE_PORT` | Pause signal port |

**Supply chain:**

| Variable | Description |
|----------|-------------|
| `SECCLAW_GITHUB_TOKEN` | GitHub PAT for workflow monitoring |
| `SECCLAW_GITHUB_REPOS` | Comma-separated `owner/repo` list |
| `SECCLAW_DEPLOY_RUNNER_PORT` | Deploy runner pause port |
| `SECCLAW_SIGNER_ROTATE_ENDPOINT` | Signer rotation URL |
| `SECCLAW_REVOKE_GITHUB_TOKEN` | GitHub token to revoke on compromise |
| `SECCLAW_REVOKE_NPM_TOKEN` | npm token to revoke on compromise |

**On-chain:**

| Variable | Description |
|----------|-------------|
| `SECCLAW_VAULT_CONTRACT` | Vault contract address |
| `SECCLAW_RPC_URL` | Arbitrum RPC URL |
| `SECCLAW_VAULT_DECIMALS` | Token decimals (default `6`) |

### Policy Manifest

`policy-manifest.yaml` is Zod-validated, supports hot-reload, and defines all limits, allowlists, and thresholds. See [`policy-manifest.yaml`](./policy-manifest.yaml) for the full schema.

Supply chain policy block:

```yaml
supplyChain:
  quarantineWindowHours: 24
  preinstallHookPolicy: blocklist
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

## V2 Event System

Unified, Zod-validated schema written to `*-v2.jsonl`. Block events bridge to V1 AlertBus for existing integrations.

```typescript
interface SecClawEvent {
  id: string;              // UUID v4
  version: "2.0";
  timestamp: string;       // ISO 8601
  source: "daemon" | "gate";
  agent_id: string;
  module: string;
  action: "pass" | "block" | "alert" | "escalate";
  severity: "info" | "warning" | "critical";
  check: string;
  details: { expected: unknown; actual: unknown; policy_rule: string; message: string };
  execution_context?: { contract_address?: string; function_selector?: string; gas_estimate?: number; value_usd?: number; tool_name?: string };
  trace_id: string;
  session_id?: string;
}
```

## Health Endpoint

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /health` | None | `200` healthy, `503` unhealthy/stale |
| `GET /status` | Token | Per-probe health, alert counts, latencies |

## Docker

```bash
docker build -t secclaw .
docker run -d \
  -e YIELDCLAW_URL=http://yieldclaw:8080 \
  -e MM_ACCOUNT_ID=0x... \
  -e SECCLAW_TG_BOT_TOKEN=... \
  -e SECCLAW_TG_CHAT_ID=... \
  -e SECCLAW_RPC_URL=https://arb1.arbitrum.io/rpc \
  -e SECCLAW_GITHUB_TOKEN=ghp_... \
  -e SECCLAW_GITHUB_REPOS=SkewCodes/SecClaw \
  -p 9090:9090 \
  secclaw
```

## Project Structure

```
src/
  daemon.ts                 Entry point, tick loop, probe/response wiring
  config.ts                 CLI + env var configuration
  types.ts                  All TypeScript interfaces
  health.ts                 HTTP health/status server
  gate/                     V2 synchronous gate
    index.ts                Gate orchestrator
    dependency-attestor.ts  Build-time + runtime hash verification
    listing-cooldown.ts     Listing cooldown enforcement
    signer-health.ts        Nonce, balance, gas, rate limit, exposure
  supply-chain/             Pre-install gates
    dependency-attestor.ts  Quarantine, behavioral diff, exfil scan
    hook-sandbox.ts         Lifecycle hook enforcement
    binary-verifier.ts      Tier 3 stub
    mcp-tool-attestor.ts    Tier 3 stub
  cli/preinstall.ts         CLI entry point for pre-install gate
  hardening/                Lockfile attestation (generate + verify)
  response/                 Deploy pause, token revoke, signer rotate, quarantine
  events/                   V2 event schema + JSONL emitter
  probes/                   11 probes (6 agent + 5 supply chain)
  policy/                   Manifest loader, assertions, drift detector
  audit/                    Correlator + 13 rules
  integrity/                Skill scanner, schema validator, on-chain verifier
  alerts/                   Bus, escalation, JSONL, Telegram, webhook, pause
  reports/                  24h digest

test/                       26 test files, 299 tests
  integration/              Shai-Hulud E2E attack simulation
  fixtures/supply-chain/    Malicious + safe package fixtures
```

## Testing

```bash
npm test              # 299 tests
npm run test:watch    # watch mode
```

## License

MIT

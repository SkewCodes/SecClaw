/**
 * Throwaway audit driver: runs SecClaw's real security modules against the
 * Orderly Zero monorepo. Safe to delete.
 *
 *   tsx scripts/audit-orderly-zero.ts "<path-to-orderly-zero>"
 *
 * Phases:
 *   1. Gate enforcement validation  — fire adversarial GateRequests through src/gate
 *   2. Source secret scan           — hardcoded keys / secrets in OZ source + .env.local
 *   3. Skill/doc injection scan     — prompt-injection / shell / base64 in curated docs
 *   4. Supply-chain scan            — exfil-domain + sensitive-path hits in direct deps
 */
import { resolve, join, relative, sep, basename } from 'node:path';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { loadManifest } from '../src/policy/manifest.js';
import { gate, createGateSharedState, type GateContext } from '../src/gate/index.js';
import { SecClawEventEmitter } from '../src/events/emitter.js';
import { AlertBus } from '../src/alerts/bus.js';
import { scanSkillContent } from '../src/integrity/skill-scanner.js';
import { scanPackageContent } from '../src/supply-chain/dependency-attestor.js';
import type { GateRequest } from '../src/types.js';

const OZ = resolve(process.argv[2] ?? 'C:/Users/olive/OneDrive/Documents/Orderly Zero');
const SECCLAW = process.cwd();

type Sev = 'critical' | 'high' | 'medium' | 'info';
interface Finding { sev: Sev; phase: string; title: string; detail: string }
const findings: Finding[] = [];
const add = (sev: Sev, phase: string, title: string, detail: string) =>
  findings.push({ sev, phase, title, detail });

const hr = (s: string) => { console.log('\n' + '='.repeat(72)); console.log(s); console.log('='.repeat(72)); };

// ─────────────────────────────────────────────────────────────────────────
// Shared FS walker (excludes vendor/build dirs + .claude worktrees)
// ─────────────────────────────────────────────────────────────────────────
const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '.next', '.turbo', '.vercel', 'dist', 'out',
  'cache', 'target', 'coverage', '.claude',
]);

function walk(dir: string, exts: RegExp, out: string[], budget = { files: 200_000 }): void {
  if (out.length >= budget.files) return;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (EXCLUDE_DIRS.has(e)) continue;
    const full = join(dir, e);
    const rel = relative(OZ, full);
    // foundry vendored solidity lives in contracts/lib
    if (rel === join('contracts', 'lib') || rel.startsWith(join('contracts', 'lib') + sep)) continue;
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, exts, out, budget);
    else if (exts.test(e)) out.push(full);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// PHASE 1 — Gate enforcement validation
// ─────────────────────────────────────────────────────────────────────────
async function phaseGate(): Promise<void> {
  hr('PHASE 1 — Gate enforcement validation (SecClaw policy-manifest.yaml, blocking mode)');
  let manifest;
  try {
    manifest = loadManifest(join(SECCLAW, 'policy-manifest.yaml'));
  } catch (err) {
    add('high', 'gate', 'Manifest failed to load', (err as Error).message);
    console.log('  manifest load FAILED:', (err as Error).message);
    return;
  }

  const emitter = new SecClawEventEmitter(join(tmpdir(), `secclaw-audit-${Date.now()}.jsonl`));
  const sharedState = createGateSharedState();
  // Seed a recent self-listing so the cooldown scenario has something to trip on.
  sharedState.recentListings.push({
    eventId: 'evt-audit', agentId: 'listing-agent', marketId: 'PERP_SCAM_USDC',
    baseAsset: 'SCAM', oracleSource: 'pyth', seedLiquidityUSD: 1000, timestamp: Date.now(),
  });

  const ctx: GateContext = {
    manifest,
    config: { auditMode: false } as never,
    sharedState,
    emitter,
    alertBus: new AlertBus(),
  };

  const A = (n: number) => '0x' + String(n).padStart(40, '0').slice(0, 40);
  const scenarios: Array<{ name: string; expect: 'block' | 'allow'; req: GateRequest }> = [
    {
      name: 'Private-key material smuggled in tx payload',
      expect: 'block',
      req: { agent_id: 'yieldclaw', action_type: 'sign', payload: { to: A(1), value: '0x' + 'a'.repeat(64) } },
    },
    {
      name: 'Malformed request (illegal agent_id)',
      expect: 'block',
      req: { agent_id: 'Bad Agent!!', action_type: 'sign', payload: {} } as unknown as GateRequest,
    },
    {
      name: 'Governance proposal calling forbidden mint() selector',
      expect: 'block',
      req: {
        agent_id: 'broker-agent', action_type: 'invoke_tool',
        payload: { tool_name: 'governance.execute', tool_params: { governor: A(2), target: A(3), data: '0x40c10f19' + '0'.repeat(128), value: '0' } },
      },
    },
    {
      name: 'Governance proposal targeting Orderly-protected ORDER token',
      expect: 'block',
      req: {
        agent_id: 'broker-agent', action_type: 'invoke_tool',
        payload: { tool_name: 'governance.queue', tool_params: { governor: A(2), target: '0xabd4c63d2616a5201454168269031355f4764337', data: '0x12345678', value: '0' } },
      },
    },
    {
      name: 'Trade on self-listed market inside cooldown window',
      expect: 'block',
      req: { agent_id: 'listing-agent', action_type: 'invoke_tool', payload: { tool_name: 'place_order', tool_params: { market_id: 'PERP_SCAM_USDC' } } },
    },
    {
      name: 'Benign place_order on established market',
      expect: 'allow',
      req: { agent_id: 'yieldclaw', action_type: 'invoke_tool', payload: { tool_name: 'place_order', tool_params: { symbol: 'PERP_ETH_USDC' } } },
    },
  ];

  for (const s of scenarios) {
    let allowed: boolean, reason: string | undefined;
    try {
      const r = await gate(s.req, ctx);
      allowed = r.allowed; reason = r.reason;
    } catch (err) {
      console.log(`  [ERROR] ${s.name}: ${(err as Error).message}`);
      add('high', 'gate', 'Gate threw on a request', `${s.name}: ${(err as Error).message}`);
      continue;
    }
    const got = allowed ? 'allow' : 'block';
    const ok = got === s.expect;
    console.log(`  [${ok ? 'OK ' : 'XX '}] expect=${s.expect.padEnd(5)} got=${got.padEnd(5)} | ${s.name}`);
    if (reason) console.log(`         reason: ${reason}`);
    if (!ok) {
      add(s.expect === 'block' ? 'critical' : 'medium', 'gate',
        `Gate did not enforce as expected: ${s.name}`,
        `expected ${s.expect}, got ${got}${reason ? ` (${reason})` : ''}`);
    }
  }
  await emitter.flush().catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────
// PHASE 2 — Source secret scan
// ─────────────────────────────────────────────────────────────────────────
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'hex_private_key', re: /\b0x[a-fA-F0-9]{64}\b/g },
  { name: 'pem_private_key', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g },
  { name: 'mnemonic/key assignment', re: /\b(?:mnemonic|seed_phrase|private_key|secret_key|priv_key)\s*[:=]\s*['"][^'"\s]{8,}['"]/gi },
  { name: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/g },
];

function isPlaceholderSecret(v: string): boolean {
  const s = v.replace(/^['"]|['"]$/g, '').trim();
  if (s.length < 8) return true;
  if (/^(your|example|changeme|placeholder|xxx+|test|dummy|sample|todo|fixme|none|null|undefined|abc|foo|bar)/i.test(s)) return true;
  if (/^0x0+$/.test(s)) return true;
  if (/^(.)\1{7,}$/.test(s)) return true;                 // single char repeated
  if (/^\$\{?[A-Za-z_]+\}?$/.test(s)) return true;        // ${VAR}
  if (/^<.*>$/.test(s)) return true;
  if (/process\.env|import\.meta\.env/.test(s)) return true;
  const distinct = new Set(s.toLowerCase().replace(/[^a-z0-9]/g, '')).size;
  return distinct < 6;                                    // low entropy
}

function redact(s: string): string {
  const c = s.replace(/^['"]|['"]$/g, '');
  if (c.length <= 8) return `***(${c.length} chars)`;
  return `${c.slice(0, 3)}…${c.slice(-2)} (${c.length} chars)`;
}

function phaseSecrets(): void {
  hr('PHASE 2 — Hardcoded secret scan (OZ source + committed env files)');

  // 2a. committed .env files
  for (const envName of ['.env.local', '.env', '.env.mainnet', '.env.production']) {
    const p = join(OZ, envName);
    if (!existsSync(p)) continue;
    let txt: string;
    try { txt = readFileSync(p, 'utf-8'); } catch { continue; }
    const committed = envName === '.env.local' || envName === '.env';
    let real = 0;
    const keys: string[] = [];
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.+)\s*$/);
      if (!m) continue;
      const [, key, val] = m;
      if (!isPlaceholderSecret(val)) { real++; keys.push(`${key}=${redact(val)}`); }
    }
    console.log(`  ${envName}: ${real} non-placeholder value(s)`);
    keys.slice(0, 20).forEach((k) => console.log(`      ${k}`));
    if (real > 0 && committed) {
      add('critical', 'secrets', `Real-looking secrets in committed ${envName}`,
        `${real} value(s) appear to be live secrets, not placeholders: ${keys.slice(0, 8).join(', ')}`);
    } else if (real > 0) {
      add('medium', 'secrets', `Populated ${envName}`, `${real} non-placeholder value(s) present`);
    }
  }

  // 2b. source files
  const files: string[] = [];
  walk(OZ, /\.(ts|tsx|js|jsx|mjs|cjs|sol|rs|json|md|ya?ml|sh|toml)$/, files);
  console.log(`  scanning ${files.length} source/doc files…`);
  let hits = 0;
  const perPattern: Record<string, number> = {};
  for (const f of files) {
    let content: string;
    try { content = readFileSync(f, 'utf-8'); } catch { continue; }
    if (content.length > 3_000_000) continue;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const { name, re } of SECRET_PATTERNS) {
        re.lastIndex = 0;
        const m = re.exec(line);
        if (!m) continue;
        const matched = m[0];
        if (name === 'hex_private_key' && isPlaceholderSecret(matched)) continue;
        if (name === 'mnemonic/key assignment') {
          const vm = line.match(/['"][^'"\s]{8,}['"]/);
          if (vm && isPlaceholderSecret(vm[0])) continue;
        }
        hits++; perPattern[name] = (perPattern[name] ?? 0) + 1;
        const rel = relative(OZ, f);
        const shown = name === 'hex_private_key' ? redact(matched) : matched.slice(0, 40);
        if (hits <= 40) console.log(`      [${name}] ${rel}:${i + 1}  ${shown}`);
        add(name === 'pem_private_key' || name === 'hex_private_key' ? 'critical' : 'high',
          'secrets', `Possible ${name} in source`, `${rel}:${i + 1} — ${shown}`);
      }
    }
  }
  console.log(`  total source secret hits: ${hits} ${JSON.stringify(perPattern)}`);
  if (hits === 0) console.log('  no hardcoded keys/secrets matched in source.');
}

// ─────────────────────────────────────────────────────────────────────────
// PHASE 3 — Skill / doc injection scan
// ─────────────────────────────────────────────────────────────────────────
function phaseInjection(): void {
  hr('PHASE 3 — Prompt-injection / shell / encoded-payload scan (curated docs & skills)');
  const all: string[] = [];
  walk(OZ, /\.(md|mdx)$/, all);
  // Drop the giant generated build-dumps — pure noise for injection heuristics.
  const SKIP = /orderly-zero-(complete-build|wiring)/;
  const docs = all.filter((f) => !SKIP.test(basename(f)));
  console.log(`  scanning ${docs.length} markdown/skill files (skipped ${all.length - docs.length} build-dumps)…`);

  const urlAllow = ['orderly.network', 'github.com', 'npmjs.com', 'otterclaw.xyz'];
  let injection = 0, shell = 0, b64 = 0, cred = 0, urlOff = 0;
  for (const f of docs) {
    let content: string;
    try { content = readFileSync(f, 'utf-8'); } catch { continue; }
    const findingsForFile = scanSkillContent(content, urlAllow);
    const rel = relative(OZ, f);
    for (const fd of findingsForFile) {
      if (fd.pattern.startsWith('injection:')) {
        injection++;
        if (injection <= 25) console.log(`      [INJECT] ${rel}:${fd.line}  ${fd.pattern}  ${fd.match.slice(0, 80)}`);
        add('high', 'injection', `Injection-style phrasing in ${rel}`, `${fd.pattern} @ line ${fd.line}: ${fd.match.slice(0, 100)}`);
      } else if (fd.pattern.startsWith('shell:')) {
        shell++;
        if (shell <= 15) console.log(`      [SHELL ] ${rel}:${fd.line}  ${fd.pattern}`);
        add('medium', 'injection', `Shell-exec construct in ${rel}`, `${fd.pattern} @ line ${fd.line}`);
      } else if (fd.pattern === 'encoded:base64_block') {
        b64++;
        add('medium', 'injection', `Base64 blob in ${rel}`, `@ line ${fd.line}`);
      } else if (fd.pattern.startsWith('credential:')) {
        cred++;
      } else if (fd.pattern === 'url:not_in_allowlist') {
        urlOff++;
      }
    }
  }
  console.log(`  injection=${injection} shell=${shell} base64=${b64} credential=${cred} url_not_allowlisted=${urlOff}`);
  if (injection === 0 && shell === 0 && b64 === 0)
    console.log('  no injection/shell/base64 constructs in curated docs.');
}

// ─────────────────────────────────────────────────────────────────────────
// PHASE 4 — Supply-chain scan (direct deps only)
// ─────────────────────────────────────────────────────────────────────────
function collectDirectDeps(): Set<string> {
  const names = new Set<string>();
  const pkgs: string[] = [];
  walk(OZ, /^package\.json$/, pkgs);
  for (const p of pkgs) {
    try {
      const j = JSON.parse(readFileSync(p, 'utf-8'));
      for (const f of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        if (j[f]) for (const n of Object.keys(j[f])) names.add(n);
      }
    } catch { /* skip */ }
  }
  return names;
}

function resolvePkgDir(name: string): string | null {
  const direct = join(OZ, 'node_modules', ...name.split('/'));
  if (existsSync(direct)) return direct;
  const pnpmRoot = join(OZ, 'node_modules', '.pnpm');
  if (!existsSync(pnpmRoot)) return null;
  const flat = name.replace(/\//g, '+');
  let entries: string[];
  try { entries = readdirSync(pnpmRoot); } catch { return null; }
  const hit = entries.find((e) => e.startsWith(flat + '@'));
  if (!hit) return null;
  const inner = join(pnpmRoot, hit, 'node_modules', ...name.split('/'));
  return existsSync(inner) ? inner : null;
}

function phaseSupplyChain(): void {
  hr('PHASE 4 — Supply-chain scan (exfil domains + sensitive-path access, direct deps)');

  // 4a. lockfile attestation baseline
  const attest = join(OZ, '.secclaw', 'lockfile-attest.json');
  if (existsSync(attest)) console.log('  lockfile attestation: present');
  else {
    console.log('  lockfile attestation: MISSING (.secclaw/lockfile-attest.json)');
    add('medium', 'supply-chain', 'No signed lockfile attestation',
      'OZ has no .secclaw/lockfile-attest.json — no integrity baseline to detect lockfile tampering.');
  }

  const policy = {
    exfilDomainBlocklist: ['audit.checkmarx.cx'],
    behavioralDiff: {
      enabled: true,
      newEndpointBlockThreshold: 1,
      sensitivePathBlocklist: ['~/.ssh/**', '~/.aws/**', '**/.env', '~/.claude/**', '~/.cursor/**', '~/.codex/**', '~/.aider/**'],
    },
    trustedPublishers: [],
  } as never;

  const deps = [...collectDirectDeps()];
  console.log(`  ${deps.length} unique direct dependencies declared across workspace package.json files`);

  const start = Date.now();
  const BUDGET_MS = 90_000;
  let scanned = 0, unresolved = 0, exfil = 0, sensitive = 0;
  for (const name of deps) {
    if (Date.now() - start > BUDGET_MS) {
      console.log(`  [budget] stopped after ${scanned} packages (${Math.round((Date.now() - start) / 1000)}s)`);
      break;
    }
    const dir = resolvePkgDir(name);
    if (!dir) { unresolved++; continue; }
    scanned++;
    let scan;
    try { scan = scanPackageContent(dir, policy); } catch { continue; }
    if (scan.domains.length) {
      exfil++;
      console.log(`      [EXFIL] ${name}: ${scan.domains.join(', ')}`);
      add('critical', 'supply-chain', `Dependency contacts blocklisted domain: ${name}`, scan.domains.join(', '));
    }
    if (scan.sensitiveAccess.length) {
      sensitive++;
      console.log(`      [PATH ] ${name}: ${scan.sensitiveAccess.slice(0, 4).join(', ')}`);
      add('high', 'supply-chain', `Dependency references sensitive paths: ${name}`,
        scan.sensitiveAccess.slice(0, 6).join(', '));
    }
  }
  console.log(`  scanned=${scanned} unresolved=${unresolved} exfil_hits=${exfil} sensitive_path_hits=${sensitive} (${Math.round((Date.now() - start) / 1000)}s)`);
  if (exfil === 0 && sensitive === 0) console.log('  no exfil-domain or sensitive-path hits in scanned direct deps.');
}

// ─────────────────────────────────────────────────────────────────────────
function summary(): void {
  hr('SUMMARY');
  const order: Sev[] = ['critical', 'high', 'medium', 'info'];
  const counts: Record<Sev, number> = { critical: 0, high: 0, medium: 0, info: 0 };
  for (const f of findings) counts[f.sev]++;
  console.log(`  Findings: ${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.info} info`);
  for (const sev of order) {
    const group = findings.filter((f) => f.sev === sev);
    if (!group.length) continue;
    console.log(`\n  ── ${sev.toUpperCase()} ──`);
    const seen = new Set<string>();
    for (const f of group) {
      const k = f.phase + '|' + f.title;
      if (seen.has(k)) continue; seen.add(k);
      const dupes = group.filter((g) => g.phase + '|' + g.title === k).length;
      console.log(`  • [${f.phase}] ${f.title}${dupes > 1 ? ` (×${dupes})` : ''}`);
      console.log(`      ${f.detail}`);
    }
  }
}

async function main(): Promise<void> {
  console.log(`SecClaw audit → target: ${OZ}`);
  if (!existsSync(OZ)) { console.error('Target not found:', OZ); process.exit(2); }
  await phaseGate();
  phaseSecrets();
  phaseInjection();
  phaseSupplyChain();
  summary();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });

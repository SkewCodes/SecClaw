#!/usr/bin/env node
import { Command } from 'commander';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { preInstallScan, type PackageMeta } from '../supply-chain/dependency-attestor.js';
import { checkLifecycleHooks } from '../supply-chain/hook-sandbox.js';
import { verifyLockfileAttestation } from '../hardening/lockfile-attestation.js';
import { loadManifest } from '../policy/manifest.js';

const program = new Command()
  .name('secclaw-preinstall')
  .description('Pre-install gate — run before npm install to block malicious packages')
  .option('--manifest <path>', 'Path to policy-manifest.yaml', './policy-manifest.yaml')
  .option('--lockfile <path>', 'Path to package-lock.json', './package-lock.json')
  .option('--attest <path>', 'Path to lockfile attestation file', './.secclaw/lockfile-attest.json')
  .option('--node-modules <path>', 'Path to node_modules', './node_modules')
  .option('--packages <names>', 'Comma-separated package names to scan (default: all from lockfile)')
  .option('--skip-registry', 'Skip npm registry lookups for publish dates', false)
  .option('--json', 'Output results as JSON', false);

program.parse();
const opts = program.opts();

const manifestPath = resolve(opts.manifest as string);
const lockfilePath = resolve(opts.lockfile as string);
const attestPath = resolve(opts.attest as string);
const nodeModulesPath = resolve(opts.nodeModules as string);
const skipRegistry = opts.skipRegistry as boolean;
const outputJson = opts.json as boolean;

async function main(): Promise<void> {
  const manifest = loadManifest(manifestPath);
  const policy = manifest.supplyChain;

  if (!policy) {
    console.log('[secclaw-preinstall] No supplyChain policy found in manifest — skipping');
    process.exit(0);
  }

  const allAlerts: Array<{ source: string; check: string; severity: string; message: string }> = [];
  let blocked = false;

  if (policy.lockfileAttestation.required && existsSync(attestPath)) {
    const lockResult = verifyLockfileAttestation(lockfilePath, attestPath, policy);
    if (!lockResult.valid) {
      blocked = true;
      for (const a of lockResult.alerts) {
        allAlerts.push({ source: a.source, check: a.check, severity: a.severity, message: a.message });
      }
    }
  }

  const packages = resolvePackages(opts.packages as string | undefined, lockfilePath);
  if (packages.length > 0) {
    const hookResult = checkLifecycleHooks(nodeModulesPath, packages, policy);
    if (!hookResult.allowed) blocked = true;
    for (const a of hookResult.alerts) {
      allAlerts.push({ source: a.source, check: a.check, severity: a.severity, message: a.message });
    }

    let packageMetas: PackageMeta[];
    if (skipRegistry) {
      packageMetas = packages.map((p) => ({
        name: p.name,
        version: p.version ?? 'unknown',
      }));
    } else {
      packageMetas = await enrichWithRegistryDates(packages);
    }

    const scanResult = preInstallScan(packageMetas, policy, nodeModulesPath);
    if (!scanResult.allowed) blocked = true;
    for (const a of scanResult.alerts) {
      allAlerts.push({ source: a.source, check: a.check, severity: a.severity, message: a.message });
    }
  }

  if (outputJson) {
    console.log(JSON.stringify({ blocked, alerts: allAlerts }, null, 2));
  } else {
    if (allAlerts.length === 0) {
      console.log('[secclaw-preinstall] All clear — no supply chain issues detected');
    } else {
      for (const a of allAlerts) {
        console.log(`[${a.severity.toUpperCase()}] ${a.source}/${a.check}: ${a.message}`);
      }
    }
    if (blocked) {
      console.error('[secclaw-preinstall] BLOCKED — supply chain gate failed');
    }
  }

  process.exit(blocked ? 1 : 0);
}

async function fetchPublishDate(name: string, version: string): Promise<string | undefined> {
  try {
    const url = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { time?: Record<string, string> };
    return data.time?.[version];
  } catch {
    return undefined;
  }
}

async function enrichWithRegistryDates(
  packages: Array<{ name: string; version?: string }>,
): Promise<PackageMeta[]> {
  const BATCH_SIZE = 10;
  const results: PackageMeta[] = [];

  for (let i = 0; i < packages.length; i += BATCH_SIZE) {
    const batch = packages.slice(i, i + BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map(async (p) => {
        const version = p.version ?? 'unknown';
        const publishedAt = p.version
          ? await fetchPublishDate(p.name, p.version)
          : undefined;
        return { name: p.name, version, publishedAt };
      }),
    );
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        results.push(r.value);
      }
    }
  }

  return results;
}

function resolvePackages(
  explicit: string | undefined,
  lockfile: string,
): Array<{ name: string; version?: string }> {
  if (explicit) {
    return explicit.split(',').map((s) => {
      const trimmed = s.trim();
      const at = trimmed.lastIndexOf('@');
      if (at > 0) {
        return { name: trimmed.slice(0, at), version: trimmed.slice(at + 1) };
      }
      return { name: trimmed };
    });
  }

  if (!existsSync(lockfile)) return [];

  try {
    const lock = JSON.parse(readFileSync(lockfile, 'utf-8'));
    const packages: Array<{ name: string; version?: string }> = [];

    if (lock.packages && typeof lock.packages === 'object') {
      for (const [key, value] of Object.entries(lock.packages)) {
        if (!key || key === '') continue;
        const name = key.replace(/^node_modules\//, '');
        const ver = (value as Record<string, unknown>).version as string | undefined;
        packages.push({ name, version: ver });
      }
    }

    return packages;
  } catch {
    return [];
  }
}

main().catch((err) => {
  console.error('[secclaw-preinstall] Fatal error:', err);
  process.exit(1);
});

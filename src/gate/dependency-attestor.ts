import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createSecClawEvent } from '../events/schema.js';
import type {
  GateCheckEntry,
  GateRequest,
  PolicyManifest,
  SecClawEvent,
} from '../types.js';

interface AttestationEntry {
  name: string;
  version: string;
  hash: string;
}

interface AttestationManifest {
  generated_at: string;
  node_modules_path: string;
  packages: AttestationEntry[];
  total_packages: number;
}

interface AttestationState {
  verified: boolean;
  failed: boolean;
  failureReason?: string;
  checkedAt?: number;
}

const state: AttestationState = {
  verified: false,
  failed: false,
};

function hashDirectory(dirPath: string): string {
  const hash = createHash('sha256');
  const entries = readdirSync(dirPath).sort();

  for (const entry of entries) {
    const fullPath = join(dirPath, entry);
    const stat = statSync(fullPath);

    if (stat.isFile()) {
      hash.update(entry);
      hash.update(readFileSync(fullPath));
    } else if (stat.isDirectory() && entry !== 'node_modules') {
      hash.update(entry);
      hash.update(hashDirectory(fullPath));
    }
  }

  return hash.digest('hex');
}

function loadAttestationManifest(path: string): AttestationManifest | null {
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, 'utf-8');
    return JSON.parse(content) as AttestationManifest;
  } catch {
    return null;
  }
}

function verifyPackage(
  nodeModulesPath: string,
  entry: AttestationEntry,
): { match: boolean; actualHash?: string } {
  const pkgPath = join(nodeModulesPath, entry.name);
  if (!existsSync(pkgPath)) {
    return { match: false };
  }

  const actualHash = hashDirectory(pkgPath);
  return {
    match: actualHash === entry.hash,
    actualHash,
  };
}

export function resetAttestationState(): void {
  state.verified = false;
  state.failed = false;
  state.failureReason = undefined;
  state.checkedAt = undefined;
}

export function checkDependencyAttestation(
  request: GateRequest,
  manifest: PolicyManifest,
): { entries: GateCheckEntry[]; events: SecClawEvent[] } {
  const depPolicy = manifest.dependencies;
  const entries: GateCheckEntry[] = [];
  const events: SecClawEvent[] = [];

  if (!depPolicy || depPolicy.attestation === 'disabled') {
    entries.push({
      module: 'dependency_attestor',
      check: 'attestation',
      result: 'skip',
      latency_ms: 0,
    });
    return { entries, events };
  }

  const start = performance.now();

  if (state.failed) {
    const latency = performance.now() - start;
    entries.push({
      module: 'dependency_attestor',
      check: 'attestation',
      result: depPolicy.attestation === 'strict' ? 'block' : 'pass',
      latency_ms: Math.round(latency),
    });
    events.push(createSecClawEvent({
      source: 'gate',
      agent_id: request.agent_id,
      module: 'dependency_attestor',
      action: depPolicy.attestation === 'strict' ? 'block' : 'alert',
      severity: 'critical',
      check: 'attestation_cached_failure',
      details: {
        expected: 'verified',
        actual: 'failed',
        policy_rule: 'dependencies.attestation',
        message: `Dependency attestation previously failed: ${state.failureReason}`,
      },
    }));
    return { entries, events };
  }

  if (state.verified) {
    const blockedResult = checkBlockedPackages(request, depPolicy.blocked_packages);
    entries.push({
      module: 'dependency_attestor',
      check: 'attestation',
      result: 'pass',
      latency_ms: Math.round(performance.now() - start),
    });
    if (blockedResult) {
      entries.push(blockedResult.entry);
      events.push(blockedResult.event);
    }
    return { entries, events };
  }

  const attestPath = depPolicy.attestation_path;
  const attestManifest = loadAttestationManifest(attestPath);

  if (!attestManifest) {
    state.failed = true;
    state.failureReason = `Attestation manifest not found at ${attestPath}`;
    state.checkedAt = Date.now();

    const latency = performance.now() - start;
    entries.push({
      module: 'dependency_attestor',
      check: 'attestation',
      result: depPolicy.attestation === 'strict' ? 'block' : 'pass',
      latency_ms: Math.round(latency),
    });
    events.push(createSecClawEvent({
      source: 'gate',
      agent_id: request.agent_id,
      module: 'dependency_attestor',
      action: depPolicy.attestation === 'strict' ? 'block' : 'alert',
      severity: 'critical',
      check: 'attestation_manifest_missing',
      details: {
        expected: attestPath,
        actual: null,
        policy_rule: 'dependencies.attestation_path',
        message: `Attestation manifest not found at ${attestPath}`,
      },
    }));
    return { entries, events };
  }

  const nodeModulesPath = join(process.cwd(), 'node_modules');
  let mismatchedPackage: string | null = null;

  for (const pkg of attestManifest.packages) {
    const result = verifyPackage(nodeModulesPath, pkg);
    if (!result.match) {
      mismatchedPackage = pkg.name;
      state.failed = true;
      state.failureReason = `Hash mismatch for package: ${pkg.name}`;
      state.checkedAt = Date.now();

      events.push(createSecClawEvent({
        source: 'gate',
        agent_id: request.agent_id,
        module: 'dependency_attestor',
        action: depPolicy.attestation === 'strict' ? 'block' : 'alert',
        severity: 'critical',
        check: 'hash_mismatch',
        details: {
          expected: pkg.hash,
          actual: result.actualHash ?? 'missing',
          policy_rule: 'dependencies.attestation',
          message: `Dependency hash mismatch: ${pkg.name}@${pkg.version}`,
        },
      }));
      break;
    }
  }

  if (!mismatchedPackage) {
    state.verified = true;
    state.checkedAt = Date.now();
  }

  const latency = performance.now() - start;
  entries.push({
    module: 'dependency_attestor',
    check: 'attestation',
    result: mismatchedPackage && depPolicy.attestation === 'strict' ? 'block' : 'pass',
    latency_ms: Math.round(latency),
  });

  if (!mismatchedPackage) {
    events.push(createSecClawEvent({
      source: 'gate',
      agent_id: request.agent_id,
      module: 'dependency_attestor',
      action: 'pass',
      severity: 'info',
      check: 'attestation_verified',
      details: {
        expected: attestManifest.total_packages,
        actual: attestManifest.total_packages,
        policy_rule: 'dependencies.attestation',
        message: `All ${attestManifest.total_packages} packages verified against attestation manifest`,
      },
    }));
  }

  const blockedResult = checkBlockedPackages(request, depPolicy.blocked_packages);
  if (blockedResult) {
    entries.push(blockedResult.entry);
    events.push(blockedResult.event);
  }

  return { entries, events };
}

function checkBlockedPackages(
  request: GateRequest,
  blockedPackages: string[],
): { entry: GateCheckEntry; event: SecClawEvent } | null {
  if (blockedPackages.length === 0) return null;

  const nodeModulesPath = join(process.cwd(), 'node_modules');

  for (const pkg of blockedPackages) {
    if (existsSync(join(nodeModulesPath, pkg))) {
      return {
        entry: {
          module: 'dependency_attestor',
          check: 'blocked_package',
          result: 'block',
          latency_ms: 0,
        },
        event: createSecClawEvent({
          source: 'gate',
          agent_id: request.agent_id,
          module: 'dependency_attestor',
          action: 'block',
          severity: 'critical',
          check: 'blocked_package_detected',
          details: {
            expected: 'not installed',
            actual: 'installed',
            policy_rule: 'dependencies.blocked_packages',
            message: `Blocked package detected in node_modules: ${pkg}`,
          },
        }),
      };
    }
  }

  return null;
}

/**
 * Build-time: generate the attestation manifest by scanning node_modules.
 * Used by the `npm run secclaw:attest` script.
 */
export function generateAttestationManifest(nodeModulesPath: string): AttestationManifest {
  const packages: AttestationEntry[] = [];

  if (!existsSync(nodeModulesPath)) {
    throw new Error(`node_modules not found at ${nodeModulesPath}`);
  }

  const topLevel = readdirSync(nodeModulesPath).sort();

  for (const entry of topLevel) {
    if (entry.startsWith('.')) continue;
    const entryPath = join(nodeModulesPath, entry);
    const stat = statSync(entryPath);

    if (entry.startsWith('@') && stat.isDirectory()) {
      const scoped = readdirSync(entryPath).sort();
      for (const scopedEntry of scoped) {
        const scopedPath = join(entryPath, scopedEntry);
        if (!statSync(scopedPath).isDirectory()) continue;
        const pkgName = `${entry}/${scopedEntry}`;
        const pkg = readPackageInfo(scopedPath, pkgName);
        if (pkg) packages.push(pkg);
      }
    } else if (stat.isDirectory()) {
      const pkg = readPackageInfo(entryPath, entry);
      if (pkg) packages.push(pkg);
    }
  }

  return {
    generated_at: new Date().toISOString(),
    node_modules_path: nodeModulesPath,
    packages,
    total_packages: packages.length,
  };
}

function readPackageInfo(pkgPath: string, name: string): AttestationEntry | null {
  const pkgJsonPath = join(pkgPath, 'package.json');
  if (!existsSync(pkgJsonPath)) return null;

  try {
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    const hash = hashDirectory(pkgPath);
    return {
      name,
      version: pkgJson.version ?? 'unknown',
      hash,
    };
  } catch {
    return null;
  }
}

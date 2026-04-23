import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createAlert } from '../alerts/bus.js';
import type { Alert, SupplyChainPolicy } from '../types.js';

export interface PackageMeta {
  name: string;
  version: string;
  publishedAt?: string;
  scripts?: Record<string, string>;
}

export interface PreInstallScanResult {
  allowed: boolean;
  alerts: Alert[];
  blockedPackages: string[];
}

const URL_PATTERN = /https?:\/\/[^\s)>"']+/g;

const SENSITIVE_PATH_PATTERNS = [
  /~\/\.ssh\b/,
  /~\/\.aws\b/,
  /\.env\b/,
  /~\/\.claude\b/,
  /~\/\.cursor\b/,
  /~\/\.codex\b/,
  /~\/\.aider\b/,
  /process\.env\b/,
  /\$HOME\/\.ssh/,
  /\$HOME\/\.aws/,
];

const NETWORK_CALL_PATTERNS = [
  /\bfetch\s*\(/,
  /\bhttp\.request\s*\(/,
  /\bhttps\.request\s*\(/,
  /\baxios\b/,
  /\bgot\s*\(/,
  /\bnode-fetch\b/,
  /\bchild_process\b.*\b(?:curl|wget|nc)\b/,
  /\bexecSync\s*\(\s*['"`](?:curl|wget)/,
  /\bspawnSync\s*\(\s*['"`](?:curl|wget)/,
  /new\s+WebSocket\s*\(/,
  /\.createConnection\s*\(/,
  /dns\.resolve/,
];

/**
 * Scan a package directory for behavioral signals before allowing install.
 * Adapted from skill-scanner.ts pattern matching.
 */
export function scanPackageContent(
  packageDir: string,
  policy: SupplyChainPolicy,
): { domains: string[]; sensitiveAccess: string[]; networkCalls: string[] } {
  const domains: string[] = [];
  const sensitiveAccess: string[] = [];
  const networkCalls: string[] = [];

  const files = collectJsFiles(packageDir, 3);

  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const urlMatches = line.match(URL_PATTERN);
      if (urlMatches) {
        for (const url of urlMatches) {
          try {
            const hostname = new URL(url).hostname;
            if (policy.exfilDomainBlocklist.some((d) => hostname.includes(d))) {
              domains.push(url);
            }
          } catch { /* malformed URL */ }
        }
      }

      for (const pat of SENSITIVE_PATH_PATTERNS) {
        if (pat.test(line)) {
          sensitiveAccess.push(`${basename(file)}:${i + 1}`);
          break;
        }
      }

      for (const pat of NETWORK_CALL_PATTERNS) {
        if (pat.test(line)) {
          networkCalls.push(`${basename(file)}:${i + 1}`);
          break;
        }
      }
    }
  }

  return { domains, sensitiveAccess, networkCalls };
}

function collectJsFiles(dir: string, maxDepth: number, depth = 0): string[] {
  if (depth > maxDepth || !existsSync(dir)) return [];
  const files: string[] = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isFile() && /\.(js|mjs|cjs|ts|sh)$/.test(entry)) {
        files.push(full);
      } else if (stat.isDirectory()) {
        files.push(...collectJsFiles(full, maxDepth, depth + 1));
      }
    }
  } catch { /* permission denied or similar */ }
  return files;
}

/**
 * Check if a package is within the quarantine window.
 */
export function isInQuarantineWindow(
  publishedAt: string | undefined,
  windowHours: number,
): boolean {
  if (!publishedAt) return true;
  const publishTime = new Date(publishedAt).getTime();
  if (isNaN(publishTime)) return true;
  const ageMs = Date.now() - publishTime;
  return ageMs < windowHours * 60 * 60 * 1000;
}

/**
 * Pre-install gate: scan packages before npm install completes.
 * Returns alerts and whether install should be blocked.
 *
 * HARDCODED INVARIANTS (not policy-configurable):
 *  - Trusted publisher status never skips quarantine or behavioral diff
 *  - Signature validity is never sufficient on its own
 */
export function preInstallScan(
  packages: PackageMeta[],
  policy: SupplyChainPolicy,
  nodeModulesPath: string,
): PreInstallScanResult {
  const alerts: Alert[] = [];
  const blockedPackages: string[] = [];

  for (const pkg of packages) {
    const isTrusted = policy.trustedPublishers.some(
      (p) => pkg.name === p || pkg.name.startsWith(`${p}/`),
    );

    if (isInQuarantineWindow(pkg.publishedAt, policy.quarantineWindowHours)) {
      alerts.push(createAlert(
        'supply-chain',
        'quarantine_window',
        'critical',
        `Package ${pkg.name}@${pkg.version} is within ${policy.quarantineWindowHours}h quarantine window${isTrusted ? ' (trusted publisher — does NOT bypass quarantine)' : ''}`,
        { package: pkg.name, version: pkg.version, publishedAt: pkg.publishedAt, trusted: isTrusted },
      ));
      blockedPackages.push(pkg.name);
      continue;
    }

    if (policy.behavioralDiff.enabled) {
      const pkgDir = join(nodeModulesPath, pkg.name);
      if (existsSync(pkgDir)) {
        const scan = scanPackageContent(pkgDir, policy);

        if (scan.domains.length > 0) {
          alerts.push(createAlert(
            'supply-chain',
            'exfil_domain_blocked',
            'critical',
            `Package ${pkg.name}@${pkg.version} contacts blocklisted domain(s): ${scan.domains.join(', ')}`,
            { package: pkg.name, version: pkg.version, domains: scan.domains },
          ));
          blockedPackages.push(pkg.name);
        }

        if (scan.sensitiveAccess.length > 0) {
          alerts.push(createAlert(
            'supply-chain',
            'sensitive_path_access',
            'critical',
            `Package ${pkg.name}@${pkg.version} accesses sensitive paths: ${scan.sensitiveAccess.slice(0, 5).join(', ')}`,
            { package: pkg.name, version: pkg.version, locations: scan.sensitiveAccess },
          ));
          blockedPackages.push(pkg.name);
        }

        if (scan.networkCalls.length >= policy.behavioralDiff.newEndpointBlockThreshold) {
          alerts.push(createAlert(
            'supply-chain',
            'new_network_endpoints',
            'high',
            `Package ${pkg.name}@${pkg.version} has ${scan.networkCalls.length} network call site(s)`,
            { package: pkg.name, version: pkg.version, locations: scan.networkCalls },
          ));
          blockedPackages.push(pkg.name);
        }
      }
    }
  }

  return {
    allowed: blockedPackages.length === 0,
    alerts,
    blockedPackages: [...new Set(blockedPackages)],
  };
}

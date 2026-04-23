import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createAlert } from '../alerts/bus.js';
import type { Alert, SupplyChainPolicy } from '../types.js';

export interface HookCheckResult {
  allowed: boolean;
  alerts: Alert[];
  blockedPackages: string[];
}

const LIFECYCLE_HOOKS = ['preinstall', 'install', 'postinstall', 'preuninstall', 'postuninstall'] as const;

/**
 * Extract lifecycle hook scripts from a package.json.
 */
export function extractLifecycleHooks(
  packageJsonPath: string,
): { name: string; hooks: Record<string, string> } | null {
  if (!existsSync(packageJsonPath)) return null;
  try {
    const content = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const hooks: Record<string, string> = {};
    const scripts = content.scripts as Record<string, string> | undefined;
    if (!scripts) return { name: content.name ?? 'unknown', hooks };

    for (const hook of LIFECYCLE_HOOKS) {
      if (scripts[hook]) {
        hooks[hook] = scripts[hook];
      }
    }
    return { name: content.name ?? 'unknown', hooks };
  } catch {
    return null;
  }
}

/**
 * Normalize an allowlist entry (package@version or just package name) to a package name.
 */
function matchesAllowlist(
  pkgName: string,
  version: string | undefined,
  allowlist: string[],
): boolean {
  for (const entry of allowlist) {
    if (entry.includes('@') && !entry.startsWith('@')) {
      const [name, ver] = entry.split('@');
      if (name === pkgName && ver === version) return true;
    } else if (entry.includes('@') && entry.startsWith('@')) {
      const atIdx = entry.lastIndexOf('@');
      if (atIdx > 0) {
        const name = entry.slice(0, atIdx);
        const ver = entry.slice(atIdx + 1);
        if (name === pkgName && ver === version) return true;
      }
      if (entry === pkgName) return true;
    } else {
      if (entry === pkgName) return true;
    }
  }
  return false;
}

/**
 * Check packages for lifecycle hooks and enforce the preinstallHookPolicy.
 *
 * - blocklist: block any package with hooks UNLESS it's in the allowlist
 * - allowlist: block any package with hooks UNLESS it's in the allowlist
 * - sandbox: stub (Tier 3) — currently falls through to blocklist behavior
 */
export function checkLifecycleHooks(
  nodeModulesPath: string,
  packageNames: Array<{ name: string; version?: string }>,
  policy: SupplyChainPolicy,
): HookCheckResult {
  const alerts: Alert[] = [];
  const blockedPackages: string[] = [];
  const mode = policy.preinstallHookPolicy;

  if (mode === 'sandbox') {
    alerts.push(createAlert(
      'supply-chain',
      'hook_sandbox_stub',
      'warning',
      'Sandbox mode for lifecycle hooks is not yet implemented — falling back to blocklist behavior',
      {},
    ));
  }

  for (const pkg of packageNames) {
    const pkgJsonPath = join(nodeModulesPath, pkg.name, 'package.json');
    const result = extractLifecycleHooks(pkgJsonPath);
    if (!result) continue;

    const hookNames = Object.keys(result.hooks);
    if (hookNames.length === 0) continue;

    const isAllowed = matchesAllowlist(
      pkg.name,
      pkg.version,
      policy.preinstallHookAllowlist,
    );

    if (isAllowed) {
      alerts.push(createAlert(
        'supply-chain',
        'hook_allowlisted',
        'info',
        `Package ${pkg.name} has lifecycle hooks [${hookNames.join(', ')}] — explicitly allowlisted`,
        { package: pkg.name, hooks: result.hooks },
      ));
      continue;
    }

    alerts.push(createAlert(
      'supply-chain',
      'lifecycle_hook_blocked',
      'critical',
      `Package ${pkg.name} has lifecycle hooks [${hookNames.join(', ')}] — blocked by ${mode} policy`,
      { package: pkg.name, hooks: result.hooks, hookNames, policy: mode },
    ));
    blockedPackages.push(pkg.name);
  }

  return {
    allowed: blockedPackages.length === 0,
    alerts,
    blockedPackages,
  };
}

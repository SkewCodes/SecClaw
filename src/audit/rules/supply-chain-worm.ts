import { createAlert } from '../../alerts/bus.js';
import type { Alert, SystemSnapshot, PolicyManifest } from '../../types.js';

/**
 * Detect Shai-Hulud worm propagation pattern:
 *  install -> exfil (outbound to non-allowlisted) -> git push -> workflow injection
 *
 * Requires network + filesystem + process probe signals.
 * Emits at Critical severity immediately (no cycle-based escalation).
 */
export function checkSupplyChainWorm(
  snapshot: SystemSnapshot,
  manifest: PolicyManifest,
): Alert[] {
  const alerts: Alert[] = [];
  const policy = manifest.supplyChain;
  if (!policy) return alerts;

  const hasNetworkSignals = snapshot.network?.ok && snapshot.network.data;
  const hasFilesystemSignals = snapshot.filesystem?.ok && snapshot.filesystem.data;
  const hasProcessSignals = snapshot.process?.ok && snapshot.process.data;

  if (!hasNetworkSignals && !hasFilesystemSignals && !hasProcessSignals) {
    return alerts;
  }

  const wormIndicators: string[] = [];

  if (hasNetworkSignals) {
    const nonAllowlisted = snapshot.network!.data!.nonAllowlistedOutbound;
    if (nonAllowlisted.length > 0) {
      const blocklisted = nonAllowlisted.filter((conn) =>
        policy.exfilDomainBlocklist.some((d) => conn.remoteAddress.includes(d)),
      );
      if (blocklisted.length > 0) {
        wormIndicators.push(
          `exfil_endpoint:${blocklisted.map((c) => `${c.remoteAddress}:${c.remotePort}`).join(',')}`,
        );
      }
    }
  }

  if (hasFilesystemSignals) {
    const sensitiveAccess = snapshot.filesystem!.data!.sensitivePathAccesses;
    const credentialAccess = sensitiveAccess.filter((a) =>
      policy.behavioralDiff.sensitivePathBlocklist.some((pattern) => {
        const regex = globToRegex(pattern);
        return regex.test(a.path);
      }),
    );
    if (credentialAccess.length > 0) {
      wormIndicators.push(
        `sensitive_read:${credentialAccess.map((a) => a.path).slice(0, 3).join(',')}`,
      );
    }
  }

  if (hasProcessSignals) {
    const suspicious = snapshot.process!.data!.suspiciousChildren;
    const gitPushes = suspicious.filter((p) =>
      p.command.includes('git push') || p.command.includes('git remote add'),
    );
    const workflowWrites = suspicious.filter((p) =>
      p.command.includes('.github/workflows'),
    );
    if (gitPushes.length > 0) {
      wormIndicators.push(`git_propagation:${gitPushes.length}_push(es)`);
    }
    if (workflowWrites.length > 0) {
      wormIndicators.push(`workflow_injection:${workflowWrites.length}_file(s)`);
    }
  }

  if (wormIndicators.length >= 2) {
    alerts.push(createAlert(
      'supply-chain',
      'worm_propagation',
      'critical',
      `Shai-Hulud worm pattern detected: ${wormIndicators.join(' + ')}`,
      { indicators: wormIndicators, indicatorCount: wormIndicators.length },
    ));
  } else if (wormIndicators.length === 1) {
    alerts.push(createAlert(
      'supply-chain',
      'worm_indicator',
      'high',
      `Supply chain attack indicator: ${wormIndicators[0]}`,
      { indicators: wormIndicators, indicatorCount: 1 },
    ));
  }

  return alerts;
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    .replace(/^~/, '(?:~|\\$HOME|' + escapeRegex(process.env.HOME ?? '') + ')');
  return new RegExp(escaped);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

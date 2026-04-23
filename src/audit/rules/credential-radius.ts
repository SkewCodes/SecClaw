import { createAlert } from '../../alerts/bus.js';
import type { Alert, SystemSnapshot } from '../../types.js';

/**
 * Cross-references ProcessProbe + FilesystemProbe signals to detect
 * credential access by non-allowlisted processes.
 *
 * Fires when: suspicious child process detected AND sensitive paths accessed
 * in the same snapshot window.
 */
export function checkCredentialRadius(
  snapshot: SystemSnapshot,
): Alert[] {
  const alerts: Alert[] = [];

  const hasProcess = snapshot.process?.ok && snapshot.process.data;
  const hasFilesystem = snapshot.filesystem?.ok && snapshot.filesystem.data;

  if (!hasProcess || !hasFilesystem) return alerts;

  const suspicious = snapshot.process!.data!.suspiciousChildren;
  const sensitiveAccess = snapshot.filesystem!.data!.sensitivePathAccesses;

  if (suspicious.length === 0 || sensitiveAccess.length === 0) return alerts;

  const credPaths = sensitiveAccess.filter((a) =>
    a.path.includes('.ssh') ||
    a.path.includes('.aws') ||
    a.path.includes('.gnupg') ||
    a.path.includes('.env'),
  );

  if (credPaths.length > 0 && suspicious.length > 0) {
    alerts.push(createAlert(
      'supply-chain',
      'credential_radius',
      'critical',
      `Credential access correlated with suspicious processes: ${suspicious.length} suspicious process(es), ${credPaths.length} credential path(s) accessed`,
      {
        suspiciousProcesses: suspicious.map((p) => ({
          pid: p.pid,
          name: p.name,
          command: p.command.slice(0, 200),
        })),
        accessedPaths: credPaths.map((a) => a.path),
      },
    ));
  }

  const aiToolAccess = sensitiveAccess.filter((a) =>
    a.path.includes('.claude') ||
    a.path.includes('.cursor') ||
    a.path.includes('.codex') ||
    a.path.includes('.aider'),
  );

  if (aiToolAccess.length > 0 && suspicious.length > 0) {
    alerts.push(createAlert(
      'supply-chain',
      'ai_tool_config_access',
      'high',
      `AI tool config accessed during suspicious activity: ${aiToolAccess.map((a) => a.path).join(', ')}`,
      {
        paths: aiToolAccess.map((a) => a.path),
        suspiciousCount: suspicious.length,
      },
    ));
  }

  return alerts;
}

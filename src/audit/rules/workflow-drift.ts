import { createAlert } from '../../alerts/bus.js';
import type { Alert, SystemSnapshot, GitHubSnapshot } from '../../types.js';

/**
 * Cross-references GitHubProbe signals to detect unexpected workflow
 * file modifications or new workflow additions.
 *
 * Tracks known workflow hashes and alerts on changes.
 */
export class WorkflowDriftDetector {
  private knownWorkflows = new Map<string, string>();

  /**
   * Check for workflow drift. Returns alerts for any new or modified
   * workflow files detected since last probe.
   */
  check(snapshot: SystemSnapshot): Alert[] {
    const alerts: Alert[] = [];

    if (!snapshot.github?.ok || !snapshot.github.data) return alerts;

    const ghData = snapshot.github.data;

    for (const wf of ghData.workflowFiles) {
      const knownHash = this.knownWorkflows.get(wf.path);

      if (knownHash === undefined) {
        if (this.knownWorkflows.size > 0) {
          alerts.push(createAlert(
            'supply-chain',
            'workflow_added',
            'critical',
            `New workflow file detected: ${wf.path}`,
            { path: wf.path, hash: wf.hash },
          ));
        }
        this.knownWorkflows.set(wf.path, wf.hash);
      } else if (knownHash !== wf.hash) {
        alerts.push(createAlert(
          'supply-chain',
          'workflow_modified',
          'critical',
          `Workflow file modified: ${wf.path} (hash changed from ${knownHash.slice(0, 12)}... to ${wf.hash.slice(0, 12)}...)`,
          {
            path: wf.path,
            previousHash: knownHash,
            currentHash: wf.hash,
          },
        ));
        this.knownWorkflows.set(wf.path, wf.hash);
      }
    }

    const webhookDrift = checkWebhookForDrift(ghData);
    alerts.push(...webhookDrift);

    return alerts;
  }

  reset(): void {
    this.knownWorkflows.clear();
  }
}

function checkWebhookForDrift(ghData: GitHubSnapshot): Alert[] {
  const alerts: Alert[] = [];

  for (const event of ghData.recentEvents) {
    if (event.eventType === 'push' && typeof event.payload.modified_files === 'object') {
      const modified = event.payload.modified_files as string[];
      const workflowChanges = modified.filter((f) =>
        f.startsWith('.github/workflows/'),
      );
      if (workflowChanges.length > 0) {
        alerts.push(createAlert(
          'supply-chain',
          'workflow_push_detected',
          'high',
          `Push event modified workflow files: ${workflowChanges.join(', ')} by ${event.actor}`,
          {
            repo: event.repo,
            actor: event.actor,
            files: workflowChanges,
          },
        ));
      }
    }

    if (event.eventType === 'member' || event.eventType === 'collaborator') {
      alerts.push(createAlert(
        'supply-chain',
        'collaborator_change',
        'high',
        `Collaborator change detected in ${event.repo} by ${event.actor}`,
        { repo: event.repo, actor: event.actor, payload: event.payload },
      ));
    }
  }

  return alerts;
}

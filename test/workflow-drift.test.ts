import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowDriftDetector } from '../src/audit/rules/workflow-drift.js';
import type { SystemSnapshot } from '../src/types.js';

function baseSnapshot(): SystemSnapshot {
  return {
    timestamp: Date.now(),
    yieldclaw: { ok: false, error: 'n/a', latencyMs: 0 },
    mm: { ok: false, error: 'n/a', latencyMs: 0 },
    guardian: { ok: false, error: 'n/a', latencyMs: 0 },
    otterclaw: { ok: false, error: 'n/a', latencyMs: 0 },
    growthAgent: { ok: false, error: 'n/a', latencyMs: 0 },
    listing: { ok: false, error: 'n/a', latencyMs: 0 },
  };
}

describe('WorkflowDriftDetector', () => {
  let detector: WorkflowDriftDetector;

  beforeEach(() => {
    detector = new WorkflowDriftDetector();
  });

  it('returns empty without github probe data', () => {
    expect(detector.check(baseSnapshot())).toHaveLength(0);
  });

  it('records initial workflows without alerting', () => {
    const snapshot: SystemSnapshot = {
      ...baseSnapshot(),
      github: {
        ok: true, latencyMs: 10,
        data: {
          recentEvents: [],
          workflowFiles: [
            { path: '.github/workflows/ci.yml', hash: 'abc123', modifiedAt: Date.now() },
          ],
        },
      },
    };

    const alerts = detector.check(snapshot);
    expect(alerts).toHaveLength(0);
  });

  it('detects new workflow files after initial seed', () => {
    const initial: SystemSnapshot = {
      ...baseSnapshot(),
      github: {
        ok: true, latencyMs: 10,
        data: {
          recentEvents: [],
          workflowFiles: [
            { path: '.github/workflows/ci.yml', hash: 'abc123', modifiedAt: Date.now() },
          ],
        },
      },
    };
    detector.check(initial);

    const withNew: SystemSnapshot = {
      ...baseSnapshot(),
      github: {
        ok: true, latencyMs: 10,
        data: {
          recentEvents: [],
          workflowFiles: [
            { path: '.github/workflows/ci.yml', hash: 'abc123', modifiedAt: Date.now() },
            { path: '.github/workflows/worm.yml', hash: 'evil456', modifiedAt: Date.now() },
          ],
        },
      },
    };

    const alerts = detector.check(withNew);
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    const addedAlert = alerts.find(a => a.check === 'workflow_added');
    expect(addedAlert).toBeDefined();
    expect(addedAlert!.severity).toBe('critical');
  });

  it('detects modified workflow files', () => {
    const initial: SystemSnapshot = {
      ...baseSnapshot(),
      github: {
        ok: true, latencyMs: 10,
        data: {
          recentEvents: [],
          workflowFiles: [
            { path: '.github/workflows/ci.yml', hash: 'original_hash', modifiedAt: Date.now() },
          ],
        },
      },
    };
    detector.check(initial);

    const modified: SystemSnapshot = {
      ...baseSnapshot(),
      github: {
        ok: true, latencyMs: 10,
        data: {
          recentEvents: [],
          workflowFiles: [
            { path: '.github/workflows/ci.yml', hash: 'tampered_hash', modifiedAt: Date.now() },
          ],
        },
      },
    };

    const alerts = detector.check(modified);
    const modAlert = alerts.find(a => a.check === 'workflow_modified');
    expect(modAlert).toBeDefined();
    expect(modAlert!.severity).toBe('critical');
    expect(modAlert!.source).toBe('supply-chain');
  });

  it('does not alert on unchanged workflows', () => {
    const snapshot: SystemSnapshot = {
      ...baseSnapshot(),
      github: {
        ok: true, latencyMs: 10,
        data: {
          recentEvents: [],
          workflowFiles: [
            { path: '.github/workflows/ci.yml', hash: 'stable_hash', modifiedAt: Date.now() },
          ],
        },
      },
    };

    detector.check(snapshot);
    const alerts = detector.check(snapshot);
    expect(alerts).toHaveLength(0);
  });

  it('detects workflow changes in push webhook events', () => {
    const snapshot: SystemSnapshot = {
      ...baseSnapshot(),
      github: {
        ok: true, latencyMs: 10,
        data: {
          recentEvents: [{
            eventType: 'push',
            repo: 'org/repo',
            actor: 'attacker',
            timestamp: Date.now(),
            payload: {
              modified_files: ['.github/workflows/ci.yml', 'src/index.ts'],
            },
          }],
          workflowFiles: [],
        },
      },
    };

    const alerts = detector.check(snapshot);
    const pushAlert = alerts.find(a => a.check === 'workflow_push_detected');
    expect(pushAlert).toBeDefined();
    expect(pushAlert!.severity).toBe('high');
  });

  it('detects collaborator changes', () => {
    const snapshot: SystemSnapshot = {
      ...baseSnapshot(),
      github: {
        ok: true, latencyMs: 10,
        data: {
          recentEvents: [{
            eventType: 'member',
            repo: 'org/repo',
            actor: 'unknown-user',
            timestamp: Date.now(),
            payload: { action: 'added' },
          }],
          workflowFiles: [],
        },
      },
    };

    const alerts = detector.check(snapshot);
    const collabAlert = alerts.find(a => a.check === 'collaborator_change');
    expect(collabAlert).toBeDefined();
    expect(collabAlert!.severity).toBe('high');
  });

  it('reset clears known workflows', () => {
    const initial: SystemSnapshot = {
      ...baseSnapshot(),
      github: {
        ok: true, latencyMs: 10,
        data: {
          recentEvents: [],
          workflowFiles: [
            { path: '.github/workflows/ci.yml', hash: 'abc', modifiedAt: Date.now() },
          ],
        },
      },
    };
    detector.check(initial);
    detector.reset();

    // After reset, same workflow is treated as initial (no alert)
    const alerts = detector.check(initial);
    expect(alerts).toHaveLength(0);
  });
});

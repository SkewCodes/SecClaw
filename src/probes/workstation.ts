import { execSync } from 'node:child_process';
import { hostname, platform } from 'node:os';
import { listSystemProcesses } from './process-list.js';
import type { ProbeResult, WorkstationSnapshot } from '../types.js';

const CLI_BINARIES = ['node', 'npm', 'npx', 'bw', 'gh', 'git', 'docker'];

export class WorkstationProbe {
  async probe(): Promise<ProbeResult<WorkstationSnapshot>> {
    const start = Date.now();

    try {
      const processes = listSystemProcesses();
      const openPorts = listOpenPorts();
      const cliVersions = getCliVersions();

      return {
        ok: true,
        data: {
          processes,
          openPorts,
          cliVersions,
          hostname: hostname(),
          platform: platform(),
        },
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        ok: false,
        error: (err as Error).message,
        latencyMs: Date.now() - start,
      };
    }
  }
}

function listOpenPorts(): number[] {
  try {
    const isWin = platform() === 'win32';
    const cmd = isWin
      ? 'netstat -an -p TCP'
      : 'ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null';

    const output = execSync(cmd, { timeout: 5000, encoding: 'utf-8' });
    const ports = new Set<number>();

    for (const line of output.split('\n')) {
      const match = line.match(/:(\d+)\s/);
      if (match) {
        const port = parseInt(match[1], 10);
        if (port > 0 && port < 65536) ports.add(port);
      }
    }

    return [...ports].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

function getCliVersions(): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const bin of CLI_BINARIES) {
    try {
      const output = execSync(`${bin} --version`, {
        timeout: 3000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      versions[bin] = output.trim().split('\n')[0];
    } catch {
      versions[bin] = 'not found';
    }
  }
  return versions;
}

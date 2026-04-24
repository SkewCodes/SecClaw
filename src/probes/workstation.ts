import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { hostname, platform } from 'node:os';
import { listSystemProcesses } from './process-list.js';
import type { ProbeResult, WorkstationSnapshot } from '../types.js';

const execFileAsync = promisify(execFile);

const CLI_BINARIES = ['node', 'npm', 'npx', 'bw', 'gh', 'git', 'docker'];

const KNOWN_BIN_PATHS: Record<string, string[]> = {
  node: ['/usr/local/bin/node', '/usr/bin/node', 'C:\\Program Files\\nodejs\\node.exe'],
  npm: ['/usr/local/bin/npm', '/usr/bin/npm', 'C:\\Program Files\\nodejs\\npm.cmd'],
  npx: ['/usr/local/bin/npx', '/usr/bin/npx', 'C:\\Program Files\\nodejs\\npx.cmd'],
  bw: ['/usr/local/bin/bw', '/usr/bin/bw'],
  gh: ['/usr/local/bin/gh', '/usr/bin/gh'],
  git: ['/usr/bin/git', '/usr/local/bin/git', 'C:\\Program Files\\Git\\bin\\git.exe'],
  docker: ['/usr/bin/docker', '/usr/local/bin/docker', 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'],
};

function resolveSecureBinPath(bin: string): string | null {
  const candidates = KNOWN_BIN_PATHS[bin] ?? [];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export class WorkstationProbe {
  async probe(): Promise<ProbeResult<WorkstationSnapshot>> {
    const start = Date.now();

    try {
      const [processes, openPorts, cliVersions] = await Promise.all([
        listSystemProcesses(),
        listOpenPorts(),
        getCliVersions(),
      ]);

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

async function listOpenPorts(): Promise<number[]> {
  try {
    const isWin = platform() === 'win32';
    let output: string;

    if (isWin) {
      const { stdout } = await execFileAsync('netstat', ['-an', '-p', 'TCP'], { timeout: 5000 });
      output = stdout;
    } else {
      try {
        const { stdout } = await execFileAsync('/usr/sbin/ss', ['-tlnp'], { timeout: 5000 });
        output = stdout;
      } catch {
        const { stdout } = await execFileAsync('/bin/netstat', ['-tlnp'], { timeout: 5000 });
        output = stdout;
      }
    }

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

async function getCliVersions(): Promise<Record<string, string>> {
  const versions: Record<string, string> = {};
  const results = await Promise.allSettled(
    CLI_BINARIES.map(async (bin) => {
      const path = resolveSecureBinPath(bin);
      if (!path) return { bin, version: 'not found' };
      try {
        const { stdout } = await execFileAsync(path, ['--version'], { timeout: 3000 });
        return { bin, version: stdout.trim().split('\n')[0] };
      } catch {
        return { bin, version: 'error' };
      }
    }),
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      versions[result.value.bin] = result.value.version;
    }
  }

  return versions;
}

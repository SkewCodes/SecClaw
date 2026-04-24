import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform } from 'node:os';
import type { ProbeResult, NetworkSnapshot, NetworkConnection } from '../types.js';

const execFileAsync = promisify(execFile);

export class NetworkProbe {
  constructor(
    private domainAllowlist: string[] = [],
  ) {}

  setAllowlist(domains: string[]): void {
    this.domainAllowlist = domains;
  }

  async probe(): Promise<ProbeResult<NetworkSnapshot>> {
    const start = Date.now();

    try {
      const connections = await getConnections();
      const nonAllowlistedOutbound = connections.filter((conn) => {
        if (isLocalAddress(conn.remoteAddress)) return false;
        return !this.domainAllowlist.some((domain) =>
          conn.remoteAddress.includes(domain),
        );
      });

      return {
        ok: true,
        data: { connections, nonAllowlistedOutbound },
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

function isLocalAddress(addr: string): boolean {
  return addr === '127.0.0.1'
    || addr === '::1'
    || addr === '0.0.0.0'
    || addr.startsWith('192.168.')
    || addr.startsWith('10.')
    || addr.startsWith('172.');
}

async function getConnections(): Promise<NetworkConnection[]> {
  try {
    const isWin = platform() === 'win32';
    let output: string;

    if (isWin) {
      const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'TCP'], { timeout: 5000 });
      output = stdout;
    } else {
      try {
        const { stdout } = await execFileAsync('/usr/sbin/ss', ['-tnp'], { timeout: 5000 });
        output = stdout;
      } catch {
        const { stdout } = await execFileAsync('/bin/netstat', ['-tnp'], { timeout: 5000 });
        output = stdout;
      }
    }

    const connections: NetworkConnection[] = [];
    for (const line of output.split('\n')) {
      const conn = parseLine(line, isWin);
      if (conn) connections.push(conn);
    }

    return connections;
  } catch {
    return [];
  }
}

function parseLine(line: string, isWin: boolean): NetworkConnection | null {
  try {
    if (isWin) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5 || parts[0] !== 'TCP') return null;
      const local = parseAddress(parts[1]);
      const remote = parseAddress(parts[2]);
      if (!local || !remote) return null;
      return {
        localAddress: local.address,
        localPort: local.port,
        remoteAddress: remote.address,
        remotePort: remote.port,
        state: parts[3],
        pid: parseInt(parts[4], 10) || undefined,
      };
    } else {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) return null;
      const state = parts[0];
      if (!['ESTAB', 'ESTABLISHED', 'SYN_SENT', 'CLOSE_WAIT'].includes(state.toUpperCase())) return null;
      const local = parseAddress(parts[3]);
      const remote = parseAddress(parts[4]);
      if (!local || !remote) return null;
      return {
        localAddress: local.address,
        localPort: local.port,
        remoteAddress: remote.address,
        remotePort: remote.port,
        state,
      };
    }
  } catch {
    return null;
  }
}

function parseAddress(addr: string): { address: string; port: number } | null {
  const lastColon = addr.lastIndexOf(':');
  if (lastColon < 0) return null;
  const address = addr.slice(0, lastColon);
  const port = parseInt(addr.slice(lastColon + 1), 10);
  if (isNaN(port)) return null;
  return { address, port };
}

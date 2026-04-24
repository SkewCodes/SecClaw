import { listSystemProcesses } from './process-list.js';
import type { ProbeResult, ProcessSnapshot, ProcessInfo } from '../types.js';

const SUSPICIOUS_COMMANDS = [
  /\bcurl\b.*\|\s*bash/,
  /\bwget\b.*\|\s*bash/,
  /\bnc\b.*\d+/,
  /\bbase64\b.*--decode/,
  /\beval\b/,
  /git\s+push\b/,
  /git\s+remote\s+add\b/,
  /\.github\/workflows/,
  /\bnpm\s+publish\b/,
  /\bcrypto/,
];

const NODE_PROCESS_NAMES = ['node', 'npm', 'npx', 'tsx', 'ts-node'];

export class ProcessProbe {
  private allowedParentPids = new Set<number>();

  setAllowedParentPids(pids: number[]): void {
    this.allowedParentPids = new Set(pids);
  }

  async probe(): Promise<ProbeResult<ProcessSnapshot>> {
    const start = Date.now();

    try {
      const processes = await listSystemProcesses();
      const nodeProcesses = processes.filter((p) =>
        NODE_PROCESS_NAMES.some((n) => p.name.toLowerCase().includes(n)),
      );
      const nodeProcessCount = nodeProcesses.length;

      const suspiciousChildren: ProcessInfo[] = [];
      for (const proc of processes) {
        if (this.allowedParentPids.size > 0 && this.allowedParentPids.has(proc.ppid)) {
          continue;
        }
        for (const pattern of SUSPICIOUS_COMMANDS) {
          if (pattern.test(proc.command)) {
            suspiciousChildren.push(proc);
            break;
          }
        }
      }

      return {
        ok: true,
        data: { processes, suspiciousChildren, nodeProcessCount },
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

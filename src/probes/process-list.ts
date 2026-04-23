import { execSync } from 'node:child_process';
import { platform } from 'node:os';
import type { ProcessInfo } from '../types.js';

export function listSystemProcesses(): ProcessInfo[] {
  try {
    const isWin = platform() === 'win32';
    const cmd = isWin
      ? 'wmic process get ProcessId,Name,CommandLine,ParentProcessId /format:csv'
      : 'ps -eo pid,ppid,user,comm,args --no-headers';

    const output = execSync(cmd, { timeout: 5000, encoding: 'utf-8' });
    const lines = output.trim().split('\n').filter(Boolean);
    const processes: ProcessInfo[] = [];

    if (isWin) {
      for (const line of lines.slice(1)) {
        const parts = line.split(',');
        if (parts.length < 4) continue;
        processes.push({
          pid: parseInt(parts[parts.length - 1], 10) || 0,
          name: parts[parts.length - 2] || '',
          command: parts[1] || '',
          ppid: parseInt(parts[parts.length - 3], 10) || 0,
        });
      }
    } else {
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;
        processes.push({
          pid: parseInt(parts[0], 10),
          ppid: parseInt(parts[1], 10),
          user: parts[2],
          name: parts[3],
          command: parts.slice(4).join(' '),
        });
      }
    }

    return processes;
  } catch {
    return [];
  }
}

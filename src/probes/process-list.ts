import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform } from 'node:os';
import type { ProcessInfo } from '../types.js';

const execFileAsync = promisify(execFile);

export async function listSystemProcesses(): Promise<ProcessInfo[]> {
  try {
    const isWin = platform() === 'win32';
    let output: string;

    if (isWin) {
      const { stdout } = await execFileAsync('wmic', [
        'process', 'get', 'ProcessId,Name,CommandLine,ParentProcessId', '/format:csv',
      ], { timeout: 5000 });
      output = stdout;
    } else {
      const { stdout } = await execFileAsync('/bin/ps', [
        '-eo', 'pid,ppid,user,comm,args', '--no-headers',
      ], { timeout: 5000 });
      output = stdout;
    }

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

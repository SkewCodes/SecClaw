import { readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { ProbeResult, FilesystemSnapshot, FileAccessEvent } from '../types.js';

const DEFAULT_SENSITIVE_PATHS = [
  '~/.ssh',
  '~/.aws',
  '~/.gnupg',
  '~/.claude',
  '~/.cursor',
  '~/.codex',
  '~/.aider',
];

export class FilesystemProbe {
  private sensitivePaths: string[];
  private lastModTimes = new Map<string, number>();
  private lastHashes = new Map<string, string>();

  constructor(sensitivePaths?: string[]) {
    this.sensitivePaths = deduplicatePaths(
      (sensitivePaths ?? DEFAULT_SENSITIVE_PATHS)
        .map(policyGlobToDir)
        .filter(Boolean) as string[],
    );
  }

  updatePaths(sensitivePaths: string[]): void {
    this.sensitivePaths = deduplicatePaths(
      sensitivePaths.map(policyGlobToDir).filter(Boolean) as string[],
    );
  }

  async probe(): Promise<ProbeResult<FilesystemSnapshot>> {
    const start = Date.now();

    try {
      const sensitivePathAccesses: FileAccessEvent[] = [];
      const modifiedFiles: FilesystemSnapshot['modifiedFiles'] = [];

      for (const dir of this.sensitivePaths) {
        const resolved = resolve(dir);
        if (!existsSync(resolved)) continue;

        try {
          const stat = statSync(resolved);
          if (stat.isDirectory()) {
            const files = scanDir(resolved, 2);
            for (const file of files) {
              const fileStat = statSync(file);
              const prevMod = this.lastModTimes.get(file);
              const currentMod = fileStat.mtimeMs;

              if (prevMod !== undefined && currentMod > prevMod) {
                const hash = hashFile(file);
                const prevHash = this.lastHashes.get(file);

                if (prevHash && hash !== prevHash) {
                  sensitivePathAccesses.push({
                    path: file,
                    operation: 'write',
                    timestamp: currentMod,
                  });
                  modifiedFiles.push({ path: file, hash, modifiedAt: currentMod });
                }

                this.lastHashes.set(file, hash);
              } else if (prevMod === undefined) {
                const hash = hashFile(file);
                this.lastHashes.set(file, hash);
              }

              this.lastModTimes.set(file, currentMod);
            }
          }
        } catch {
          // permission denied or deleted between stat calls
        }
      }

      // Check .env files in cwd
      for (const envFile of ['.env', '.env.local', '.env.production']) {
        const envPath = resolve(envFile);
        if (!existsSync(envPath)) continue;
        try {
          const stat = statSync(envPath);
          const prevMod = this.lastModTimes.get(envPath);
          if (prevMod !== undefined && stat.mtimeMs > prevMod) {
            sensitivePathAccesses.push({
              path: envPath,
              operation: 'write',
              timestamp: stat.mtimeMs,
            });
          }
          this.lastModTimes.set(envPath, stat.mtimeMs);
        } catch { /* skip */ }
      }

      return {
        ok: true,
        data: { sensitivePathAccesses, modifiedFiles },
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

function scanDir(dir: string, maxDepth: number, depth = 0): string[] {
  if (depth > maxDepth) return [];
  const files: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isFile()) {
        files.push(full);
      } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
        files.push(...scanDir(full, maxDepth, depth + 1));
      }
    }
  } catch { /* permission denied */ }
  return files;
}

function hashFile(path: string): string {
  try {
    const content = readFileSync(path);
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return '';
  }
}

// Converts a policy glob pattern into a concrete directory path for fs monitoring.
// Strips trailing glob suffixes (/**) and expands ~ to homedir.
// Returns null for pure-glob patterns (starting with **) since those are
// handled by the .env watcher in probe().
function policyGlobToDir(pattern: string): string | null {
  if (pattern.startsWith('**/')) return null;
  const stripped = pattern
    .replace(/\/\*\*$/, '')
    .replace(/\/\*$/, '')
    .replace(/\.\*$/, '')
    .replace(/^~/, homedir());
  return stripped || null;
}

function deduplicatePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

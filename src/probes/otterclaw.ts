import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ProbeResult, OtterClawSnapshot, SkillFileInfo } from '../types.js';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

export class OtterClawProbe {
  constructor(
    private skillsDirs: string[],
  ) {}

  async probe(): Promise<ProbeResult<OtterClawSnapshot>> {
    const start = Date.now();

    try {
      const skills: SkillFileInfo[] = [];

      for (const dir of this.skillsDirs) {
        try {
          const found = this.scanDirectory(dir, dir);
          skills.push(...found);
        } catch (err) {
          const error = err as NodeJS.ErrnoException;
          if (error.code !== 'ENOENT') throw error;
          // Directory doesn't exist — skip
        }
      }

      return {
        ok: true,
        data: { skills },
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

  private scanDirectory(dir: string, baseDir: string): SkillFileInfo[] {
    const results: SkillFileInfo[] = [];
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        results.push(...this.scanDirectory(fullPath, baseDir));
      } else if (entry.name === 'SKILL.md') {
        const content = readFileSync(fullPath, 'utf-8');
        const stat = statSync(fullPath);

        const hash = createHash('sha256').update(content).digest('hex');

        let frontmatter: Record<string, unknown> | null = null;
        const match = content.match(FRONTMATTER_RE);
        if (match) {
          try {
            frontmatter = parseYaml(match[1]) as Record<string, unknown>;
          } catch {
            frontmatter = null;
          }
        }

        results.push({
          path: fullPath,
          relativePath: relative(baseDir, fullPath),
          hash,
          frontmatter,
          modifiedAt: stat.mtimeMs,
        });
      }
    }

    return results;
  }
}

import type { ProbeResult, GitHubSnapshot, GitHubWebhookEvent } from '../types.js';

export class GitHubProbe {
  private recentEvents: GitHubWebhookEvent[] = [];
  private maxEvents = 100;

  constructor(
    private apiBaseUrl: string = 'https://api.github.com',
    private token?: string,
    private repos: string[] = [],
  ) {}

  ingestWebhook(event: GitHubWebhookEvent): void {
    this.recentEvents.push(event);
    if (this.recentEvents.length > this.maxEvents) {
      this.recentEvents.shift();
    }
  }

  async probe(): Promise<ProbeResult<GitHubSnapshot>> {
    const start = Date.now();

    try {
      const workflowFiles: GitHubSnapshot['workflowFiles'] = [];

      for (const repo of this.repos) {
        try {
          const files = await this.fetchWorkflowFiles(repo);
          workflowFiles.push(...files);
        } catch {
          // individual repo failure doesn't fail the whole probe
        }
      }

      return {
        ok: true,
        data: {
          recentEvents: [...this.recentEvents],
          workflowFiles,
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

  private async fetchWorkflowFiles(
    repo: string,
  ): Promise<Array<{ path: string; hash: string; modifiedAt: number }>> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    const url = `${this.apiBaseUrl}/repos/${repo}/contents/.github/workflows`;
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return [];

    const files = (await res.json()) as Array<{
      name: string;
      path: string;
      sha: string;
    }>;

    return files.map((f) => ({
      path: f.path,
      hash: f.sha,
      modifiedAt: Date.now(),
    }));
  }
}

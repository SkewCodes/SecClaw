import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  ProbeResult,
  MMSnapshot,
  MMBalance,
  MMPosition,
  MMSafetyState,
  MMQuality,
  MMAutoTunerState,
} from '../types.js';
import { fulfilled } from '../utils.js';

const execFileAsync = promisify(execFile);

interface MMStatusResponse {
  safety?: MMSafetyState;
  quality?: MMQuality;
  autoTuner?: MMAutoTunerState;
  riskPreset?: string;
  pair?: string;
  balance?: MMBalance;
  positions?: MMPosition[];
}

export class MMProbe {
  constructor(
    private accountId: string,
    private network: string,
    private statusUrl?: string,
  ) {}

  async probe(): Promise<ProbeResult<MMSnapshot>> {
    if (!this.accountId && !this.statusUrl) {
      return { ok: false, error: 'Neither MM_ACCOUNT_ID nor MM_STATUS_URL configured', latencyMs: 0 };
    }

    const start = Date.now();

    try {
      // If MM exposes a status API, use it for richer data
      if (this.statusUrl) {
        return await this.probeViaHttp(start);
      }

      // Fallback: CLI-only probe
      return await this.probeViaCli(start);
    } catch (err) {
      return {
        ok: false,
        error: (err as Error).message,
        latencyMs: Date.now() - start,
      };
    }
  }

  private async probeViaHttp(start: number): Promise<ProbeResult<MMSnapshot>> {
    const [statusRes, balanceRes, positionsRes] = await Promise.allSettled([
      this.httpGet<MMStatusResponse>('/api/v1/status'),
      this.httpGet<MMBalance>('/api/v1/balance'),
      this.httpGet<{ positions: MMPosition[] }>('/api/v1/positions'),
    ]);

    const status = fulfilled(statusRes);
    const balance = fulfilled(balanceRes);
    const positions = fulfilled(positionsRes);

    const snapshot: MMSnapshot = {
      balance: status?.balance ?? balance ?? null,
      positions: status?.positions ?? positions?.positions ?? [],
      safety: status?.safety ?? null,
      quality: status?.quality ?? null,
      autoTuner: status?.autoTuner ?? null,
      riskPreset: status?.riskPreset ?? null,
      pair: status?.pair ?? null,
    };

    return { ok: true, data: snapshot, latencyMs: Date.now() - start };
  }

  private async probeViaCli(start: number): Promise<ProbeResult<MMSnapshot>> {
    if (!this.accountId) {
      return { ok: false, error: 'MM_ACCOUNT_ID not configured', latencyMs: 0 };
    }

    const [balance, positions] = await Promise.allSettled([
      this.execCli<MMBalance>(['balance', '--account', this.accountId]),
      this.execCli<MMPosition[]>(['positions-list', '--account', this.accountId]),
    ]);

    const snapshot: MMSnapshot = {
      balance: fulfilled(balance) ?? null,
      positions: fulfilled(positions) ?? [],
      safety: null,
      quality: null,
      autoTuner: null,
      riskPreset: null,
      pair: null,
    };

    return { ok: true, data: snapshot, latencyMs: Date.now() - start };
  }

  private async httpGet<T>(path: string): Promise<T> {
    const res = await fetch(`${this.statusUrl}${path}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      throw new Error(`MM ${path}: HTTP ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  private async execCli<T>(args: string[]): Promise<T> {
    const fullArgs = [...args, '--network', this.network];

    const { stdout, stderr } = await execFileAsync('orderly', fullArgs, {
      timeout: 5_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    if (stderr && stderr.trim() && !stdout.trim()) {
      throw new Error(`orderly ${args[0]}: ${stderr.slice(0, 200)}`);
    }

    return parseCliJson<T>(stdout);
  }
}

function parseCliJson<T>(stdout: string): T {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error('Empty CLI output');
  }

  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const jsonMatch = trimmed.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]) as T;
    }
    throw new Error(`Failed to parse CLI output: ${trimmed.slice(0, 200)}`);
  }
}


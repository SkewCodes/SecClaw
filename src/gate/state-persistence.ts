import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GateSharedState } from '../types.js';

export function persistGateState(state: GateSharedState, path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = path + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
  renameSync(tmpPath, path);
}

export function loadGateState(path: string): GateSharedState | null {
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(content) as GateSharedState;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Array.isArray(parsed.recentListings)) parsed.recentListings = [];
    if (!parsed.activeCriticalAlerts || typeof parsed.activeCriticalAlerts !== 'object') {
      parsed.activeCriticalAlerts = {};
    }
    if (!parsed.activeModifications || typeof parsed.activeModifications !== 'object') {
      parsed.activeModifications = {};
    }
    if (!parsed.pendingModifications || typeof parsed.pendingModifications !== 'object') {
      parsed.pendingModifications = {};
    }
    if (parsed.signerRotationTriggeredAt !== null && typeof parsed.signerRotationTriggeredAt !== 'number') {
      parsed.signerRotationTriggeredAt = null;
    }
    return parsed;
  } catch {
    return null;
  }
}

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createAlert } from '../alerts/bus.js';
import type { Alert, SupplyChainPolicy } from '../types.js';

export interface LockfileAttestationRecord {
  lockfilePath: string;
  hash: string;
  algorithm: string;
  attestedAt: string;
  attestedBy: string;
}

export interface LockfileAttestationResult {
  valid: boolean;
  alerts: Alert[];
}

/**
 * Generate a SHA-256 (or configured algorithm) attestation of a lockfile.
 */
export function generateLockfileAttestation(
  lockfilePath: string,
  attestationOutputPath: string,
  algorithm = 'sha256',
  attestedBy = 'secclaw',
): LockfileAttestationRecord {
  if (!existsSync(lockfilePath)) {
    throw new Error(`Lockfile not found: ${lockfilePath}`);
  }

  const content = readFileSync(lockfilePath);
  const hash = createHash(algorithm).update(content).digest('hex');

  const record: LockfileAttestationRecord = {
    lockfilePath,
    hash,
    algorithm,
    attestedAt: new Date().toISOString(),
    attestedBy,
  };

  const dir = dirname(attestationOutputPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(attestationOutputPath, JSON.stringify(record, null, 2), 'utf-8');

  return record;
}

/**
 * Verify a lockfile against its attestation record.
 * Required for all Orderly Zero deploys when lockfileAttestation.required is true.
 */
export function verifyLockfileAttestation(
  lockfilePath: string,
  attestationPath: string,
  policy?: SupplyChainPolicy,
): LockfileAttestationResult {
  const alerts: Alert[] = [];

  const required = policy?.lockfileAttestation.required ?? true;
  const algorithm = policy?.lockfileAttestation.algorithm ?? 'sha256';

  if (!existsSync(attestationPath)) {
    if (required) {
      alerts.push(createAlert(
        'supply-chain',
        'lockfile_attestation_missing',
        'critical',
        `Lockfile attestation not found at ${attestationPath} — required for deploy`,
        { attestationPath, required },
      ));
      return { valid: false, alerts };
    }
    return { valid: true, alerts };
  }

  if (!existsSync(lockfilePath)) {
    alerts.push(createAlert(
      'supply-chain',
      'lockfile_missing',
      'critical',
      `Lockfile not found at ${lockfilePath}`,
      { lockfilePath },
    ));
    return { valid: false, alerts };
  }

  let record: LockfileAttestationRecord;
  try {
    record = JSON.parse(readFileSync(attestationPath, 'utf-8'));
  } catch {
    alerts.push(createAlert(
      'supply-chain',
      'lockfile_attestation_corrupt',
      'critical',
      `Lockfile attestation is corrupt or unreadable: ${attestationPath}`,
      { attestationPath },
    ));
    return { valid: false, alerts };
  }

  const content = readFileSync(lockfilePath);
  const actualHash = createHash(algorithm).update(content).digest('hex');

  if (actualHash !== record.hash) {
    alerts.push(createAlert(
      'supply-chain',
      'lockfile_tampered',
      'critical',
      `Lockfile hash mismatch: expected ${record.hash.slice(0, 16)}... got ${actualHash.slice(0, 16)}... — lockfile modified since attestation at ${record.attestedAt}`,
      {
        lockfilePath,
        expectedHash: record.hash,
        actualHash,
        attestedAt: record.attestedAt,
        algorithm,
      },
    ));
    return { valid: false, alerts };
  }

  return { valid: true, alerts };
}

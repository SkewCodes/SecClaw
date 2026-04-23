import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  generateLockfileAttestation,
  verifyLockfileAttestation,
} from '../src/hardening/lockfile-attestation.js';
import type { SupplyChainPolicy } from '../src/types.js';

const FIXTURE_DIR = './test-lockfile-fixtures';
const LOCKFILE = join(FIXTURE_DIR, 'package-lock.json');
const ATTEST = join(FIXTURE_DIR, '.secclaw', 'lockfile-attestation.json');

function makePolicy(overrides?: Partial<SupplyChainPolicy>): SupplyChainPolicy {
  return {
    quarantineWindowHours: 24,
    preinstallHookPolicy: 'blocklist',
    preinstallHookAllowlist: [],
    behavioralDiff: { enabled: true, newEndpointBlockThreshold: 1, sensitivePathBlocklist: [] },
    exfilDomainBlocklist: [],
    trustedPublishers: [],
    lockfileAttestation: { required: true, algorithm: 'sha256' },
    ...overrides,
  };
}

describe('LockfileAttestation', () => {
  beforeEach(() => {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(LOCKFILE, JSON.stringify({
      name: 'test-project',
      lockfileVersion: 3,
      packages: { 'node_modules/zod': { version: '3.24.0' } },
    }));
  });

  afterEach(() => {
    if (existsSync(FIXTURE_DIR)) rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  describe('generateLockfileAttestation', () => {
    it('creates an attestation record', () => {
      const record = generateLockfileAttestation(LOCKFILE, ATTEST);
      expect(record.hash).toBeDefined();
      expect(record.algorithm).toBe('sha256');
      expect(record.lockfilePath).toBe(LOCKFILE);
      expect(record.attestedBy).toBe('secclaw');
    });

    it('writes attestation file to disk', () => {
      generateLockfileAttestation(LOCKFILE, ATTEST);
      expect(existsSync(ATTEST)).toBe(true);
      const stored = JSON.parse(readFileSync(ATTEST, 'utf-8'));
      expect(stored.hash).toBeDefined();
      expect(stored.algorithm).toBe('sha256');
    });

    it('throws for missing lockfile', () => {
      expect(() => generateLockfileAttestation('/nonexistent/lock', ATTEST)).toThrow();
    });

    it('supports custom attestedBy', () => {
      const record = generateLockfileAttestation(LOCKFILE, ATTEST, 'sha256', 'ci-runner');
      expect(record.attestedBy).toBe('ci-runner');
    });
  });

  describe('verifyLockfileAttestation', () => {
    it('passes for unmodified lockfile', () => {
      generateLockfileAttestation(LOCKFILE, ATTEST);
      const result = verifyLockfileAttestation(LOCKFILE, ATTEST, makePolicy());
      expect(result.valid).toBe(true);
      expect(result.alerts).toHaveLength(0);
    });

    it('fails for modified lockfile', () => {
      generateLockfileAttestation(LOCKFILE, ATTEST);
      writeFileSync(LOCKFILE, JSON.stringify({ tampered: true }));

      const result = verifyLockfileAttestation(LOCKFILE, ATTEST, makePolicy());
      expect(result.valid).toBe(false);
      expect(result.alerts.length).toBeGreaterThan(0);
      expect(result.alerts[0].check).toBe('lockfile_tampered');
      expect(result.alerts[0].severity).toBe('critical');
    });

    it('fails when attestation file is missing and required', () => {
      const result = verifyLockfileAttestation(LOCKFILE, '/nonexistent/attest.json', makePolicy());
      expect(result.valid).toBe(false);
      expect(result.alerts[0].check).toBe('lockfile_attestation_missing');
    });

    it('passes when attestation is missing and not required', () => {
      const policy = makePolicy({ lockfileAttestation: { required: false, algorithm: 'sha256' } });
      const result = verifyLockfileAttestation(LOCKFILE, '/nonexistent/attest.json', policy);
      expect(result.valid).toBe(true);
    });

    it('fails when lockfile is missing', () => {
      generateLockfileAttestation(LOCKFILE, ATTEST);
      rmSync(LOCKFILE);

      const result = verifyLockfileAttestation(LOCKFILE, ATTEST, makePolicy());
      expect(result.valid).toBe(false);
      expect(result.alerts[0].check).toBe('lockfile_missing');
    });

    it('fails for corrupt attestation file', () => {
      mkdirSync(join(FIXTURE_DIR, '.secclaw'), { recursive: true });
      writeFileSync(ATTEST, 'not json');

      const result = verifyLockfileAttestation(LOCKFILE, ATTEST, makePolicy());
      expect(result.valid).toBe(false);
      expect(result.alerts[0].check).toBe('lockfile_attestation_corrupt');
    });

    it('emits supply-chain source alerts', () => {
      generateLockfileAttestation(LOCKFILE, ATTEST);
      writeFileSync(LOCKFILE, 'tampered');

      const result = verifyLockfileAttestation(LOCKFILE, ATTEST, makePolicy());
      for (const alert of result.alerts) {
        expect(alert.source).toBe('supply-chain');
      }
    });
  });
});

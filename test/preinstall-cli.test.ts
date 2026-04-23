import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { preInstallScan, isInQuarantineWindow, type PackageMeta } from '../src/supply-chain/dependency-attestor.js';
import { checkLifecycleHooks } from '../src/supply-chain/hook-sandbox.js';
import { generateLockfileAttestation, verifyLockfileAttestation } from '../src/hardening/lockfile-attestation.js';
import type { SupplyChainPolicy } from '../src/types.js';

const FIXTURE_DIR = './test-preinstall-fixtures';
const NODE_MODULES = join(FIXTURE_DIR, 'node_modules');

function makePolicy(overrides?: Partial<SupplyChainPolicy>): SupplyChainPolicy {
  return {
    quarantineWindowHours: 24,
    preinstallHookPolicy: 'blocklist',
    preinstallHookAllowlist: [],
    behavioralDiff: {
      enabled: true,
      newEndpointBlockThreshold: 1,
      sensitivePathBlocklist: ['~/.ssh/**', '~/.aws/**', '**/.env'],
    },
    exfilDomainBlocklist: ['audit.checkmarx.cx'],
    trustedPublishers: ['@bitwarden', '@orderly-network'],
    lockfileAttestation: { required: true, algorithm: 'sha256' },
    ...overrides,
  };
}

describe('CLI preinstall gate logic', () => {
  beforeEach(() => {
    mkdirSync(NODE_MODULES, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(FIXTURE_DIR)) rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  describe('quarantine window with publishedAt', () => {
    it('blocks packages within quarantine window when publishedAt is provided', () => {
      const policy = makePolicy();
      const recentPublish = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const packages: PackageMeta[] = [{
        name: 'some-pkg',
        version: '1.0.0',
        publishedAt: recentPublish,
      }];

      const result = preInstallScan(packages, policy, NODE_MODULES);
      expect(result.allowed).toBe(false);
      expect(result.alerts.some(a => a.check === 'quarantine_window')).toBe(true);
    });

    it('passes packages outside quarantine window when publishedAt is provided', () => {
      const policy = makePolicy();
      const oldPublish = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      const packages: PackageMeta[] = [{
        name: 'some-pkg',
        version: '1.0.0',
        publishedAt: oldPublish,
      }];

      const result = preInstallScan(packages, policy, NODE_MODULES);
      expect(result.alerts.some(a => a.check === 'quarantine_window')).toBe(false);
    });

    it('blocks when publishedAt is undefined (unknown age)', () => {
      const policy = makePolicy();
      const packages: PackageMeta[] = [{
        name: 'some-pkg',
        version: '1.0.0',
        publishedAt: undefined,
      }];

      const result = preInstallScan(packages, policy, NODE_MODULES);
      expect(result.allowed).toBe(false);
      expect(result.alerts.some(a => a.check === 'quarantine_window')).toBe(true);
    });
  });

  describe('isInQuarantineWindow', () => {
    it('returns true when publishedAt is undefined', () => {
      expect(isInQuarantineWindow(undefined, 24)).toBe(true);
    });

    it('returns true for recent publish', () => {
      const recent = new Date(Date.now() - 1000).toISOString();
      expect(isInQuarantineWindow(recent, 24)).toBe(true);
    });

    it('returns false for old publish', () => {
      const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      expect(isInQuarantineWindow(old, 24)).toBe(false);
    });

    it('returns true for invalid date string', () => {
      expect(isInQuarantineWindow('not-a-date', 24)).toBe(true);
    });
  });

  describe('lockfile attestation integration', () => {
    it('passes when lockfile matches attestation', () => {
      const lockPath = join(FIXTURE_DIR, 'package-lock.json');
      const attestPath = join(FIXTURE_DIR, '.secclaw', 'lockfile-attest.json');
      const policy = makePolicy();

      writeFileSync(lockPath, JSON.stringify({ lockfileVersion: 3, packages: {} }));
      generateLockfileAttestation(lockPath, attestPath);

      const result = verifyLockfileAttestation(lockPath, attestPath, policy);
      expect(result.valid).toBe(true);
      expect(result.alerts).toHaveLength(0);
    });

    it('fails when lockfile is tampered', () => {
      const lockPath = join(FIXTURE_DIR, 'package-lock.json');
      const attestPath = join(FIXTURE_DIR, '.secclaw', 'lockfile-attest.json');
      const policy = makePolicy();

      writeFileSync(lockPath, JSON.stringify({ lockfileVersion: 3, packages: {} }));
      generateLockfileAttestation(lockPath, attestPath);
      writeFileSync(lockPath, JSON.stringify({ lockfileVersion: 3, packages: { tampered: true } }));

      const result = verifyLockfileAttestation(lockPath, attestPath, policy);
      expect(result.valid).toBe(false);
      expect(result.alerts[0].check).toBe('lockfile_tampered');
    });
  });

  describe('hook sandbox integration', () => {
    it('blocks packages with preinstall hooks under blocklist policy', () => {
      const policy = makePolicy({ preinstallHookPolicy: 'blocklist' });
      const pkgDir = join(NODE_MODULES, 'evil-pkg');
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
        name: 'evil-pkg',
        version: '1.0.0',
        scripts: { preinstall: 'node hack.js' },
      }));

      const result = checkLifecycleHooks(
        NODE_MODULES,
        [{ name: 'evil-pkg', version: '1.0.0' }],
        policy,
      );
      expect(result.allowed).toBe(false);
      expect(result.blockedPackages).toContain('evil-pkg');
    });

    it('allows packages with no hooks', () => {
      const policy = makePolicy();
      const pkgDir = join(NODE_MODULES, 'safe-pkg');
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
        name: 'safe-pkg',
        version: '1.0.0',
      }));

      const result = checkLifecycleHooks(
        NODE_MODULES,
        [{ name: 'safe-pkg', version: '1.0.0' }],
        policy,
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe('new_network_endpoints severity', () => {
    it('emits high severity for network endpoints (not critical)', () => {
      const policy = makePolicy();
      const pkgDir = join(NODE_MODULES, 'net-pkg');
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
        name: 'net-pkg', version: '1.0.0',
      }));
      writeFileSync(join(pkgDir, 'index.js'), 'const r = fetch("https://example.com/api");');

      const packages: PackageMeta[] = [{
        name: 'net-pkg',
        version: '1.0.0',
        publishedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      }];

      const result = preInstallScan(packages, policy, NODE_MODULES);
      const netAlert = result.alerts.find(a => a.check === 'new_network_endpoints');
      expect(netAlert).toBeDefined();
      expect(netAlert!.severity).toBe('high');
      expect(result.allowed).toBe(false);
    });
  });

  describe('full pipeline: safe package passes all gates', () => {
    it('passes a clean package through all checks', () => {
      const policy = makePolicy();
      const pkgDir = join(NODE_MODULES, 'clean-lib');
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
        name: 'clean-lib',
        version: '2.0.0',
      }));
      writeFileSync(join(pkgDir, 'index.js'), 'module.exports = { add: (a, b) => a + b };');

      const hookResult = checkLifecycleHooks(
        NODE_MODULES,
        [{ name: 'clean-lib', version: '2.0.0' }],
        policy,
      );
      expect(hookResult.allowed).toBe(true);

      const packages: PackageMeta[] = [{
        name: 'clean-lib',
        version: '2.0.0',
        publishedAt: new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(),
      }];
      const scanResult = preInstallScan(packages, policy, NODE_MODULES);
      expect(scanResult.allowed).toBe(true);
    });
  });
});

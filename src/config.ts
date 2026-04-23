import { Command } from 'commander';
import type { SecClawConfig } from './types.js';

function env(key: string, fallback = ''): string {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  return v ? parseInt(v, 10) : fallback;
}

export function loadConfig(argv?: string[]): SecClawConfig {
  const program = new Command()
    .name('secclaw')
    .description('Security monitoring daemon for Orderly Network trading agents')
    .option('--config <path>', 'Path to policy-manifest.yaml', './policy-manifest.yaml')
    .option('--once', 'Run one check cycle and exit', false)
    .option('--dry-run', 'Run checks but suppress alerts', false)
    .option('--verbose', 'Enable verbose logging', false)
    .option('--audit-mode', 'Gate logs all decisions but blocks nothing', false)
    .parse(argv ?? process.argv);

  const opts = program.opts();

  return Object.freeze({
    manifestPath: opts.config as string,
    once: opts.once as boolean,
    dryRun: opts.dryRun as boolean,
    verbose: opts.verbose as boolean,
    auditMode: opts.auditMode as boolean,
    pollIntervalSec: envInt('POLL_INTERVAL_SEC', 30),
    logPath: env('LOG_PATH', './secclaw-audit.jsonl'),
    yieldclaw: {
      baseUrl: env('YIELDCLAW_URL', 'http://localhost:8080'),
      healthToken: env('YIELDCLAW_HEALTH_TOKEN'),
      adminToken: env('YIELDCLAW_ADMIN_TOKEN'),
    },
    mm: {
      accountId: env('MM_ACCOUNT_ID'),
      network: env('MM_NETWORK', 'testnet'),
      statusUrl: env('MM_STATUS_URL'),
    },
    otterclaw: {
      skillsPath: env('OTTERCLAW_SKILLS_PATH', '../OtterClaw/skills'),
      partnerSkillsPath: env('OTTERCLAW_PARTNER_SKILLS_PATH', '../OtterClaw/partner-skills'),
    },
    guardian: {
      auditLogPath: env('GUARDIAN_LOG_PATH', './guardian-audit.jsonl'),
    },
    telegram: {
      botToken: env('SECCLAW_TG_BOT_TOKEN'),
      chatId: env('SECCLAW_TG_CHAT_ID'),
    },
    pauseSignal: {
      enabled: env('PAUSE_PORT') !== '',
      port: envInt('PAUSE_PORT', 9999),
    },
    growthAgent: {
      auditLogPath: env('GROWTH_AGENT_AUDIT_PATH', '~/.orderly/growth-agent/audit.jsonl').replace('~', process.env.HOME ?? process.env.USERPROFILE ?? '.'),
      statePath: env('GROWTH_AGENT_STATE_PATH', '~/.orderly/growth-agent/state.json').replace('~', process.env.HOME ?? process.env.USERPROFILE ?? '.'),
    },
    listing: {
      auditLogPath: env('LISTING_AUDIT_LOG_PATH', './listing-audit.jsonl'),
    },
    webhook: {
      url: env('SECCLAW_WEBHOOK_URL'),
    },
    healthPort: envInt('SECCLAW_HEALTH_PORT', 9090),
    healthToken: env('SECCLAW_HEALTH_TOKEN'),
    vaultDecimals: envInt('SECCLAW_VAULT_DECIMALS', 6),
    supplyChain: {
      githubToken: env('SECCLAW_GITHUB_TOKEN'),
      githubRepos: env('SECCLAW_GITHUB_REPOS').split(',').filter(Boolean),
      deployRunnerPort: envInt('SECCLAW_DEPLOY_RUNNER_PORT', 0),
      signerRotateEndpoint: env('SECCLAW_SIGNER_ROTATE_ENDPOINT'),
      tokenRevoke: {
        githubToken: env('SECCLAW_REVOKE_GITHUB_TOKEN'),
        npmToken: env('SECCLAW_REVOKE_NPM_TOKEN'),
      },
    },
  });
}

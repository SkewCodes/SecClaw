// ─── Config Types ─────────────────────────────────────────────

export interface SecClawConfig {
  manifestPath: string;
  once: boolean;
  dryRun: boolean;
  verbose: boolean;
  auditMode: boolean;
  pollIntervalSec: number;
  logPath: string;
  yieldclaw: {
    baseUrl: string;
    healthToken: string;
    adminToken: string;
  };
  mm: {
    accountId: string;
    network: string;
    statusUrl: string;
  };
  otterclaw: {
    skillsPath: string;
    partnerSkillsPath: string;
  };
  guardian: {
    auditLogPath: string;
  };
  telegram: {
    botToken: string;
    chatId: string;
  };
  pauseSignal: {
    enabled: boolean;
    port: number;
  };
  growthAgent: {
    auditLogPath: string;
    statePath: string;
  };
  listing: {
    auditLogPath: string;
  };
  webhook: {
    url: string;
  };
  healthPort: number;
  healthToken: string;
  vaultDecimals: number;
  supplyChain: {
    githubToken: string;
    githubRepos: string[];
    deployRunnerPort: number;
    signerRotateEndpoint: string;
    tokenRevoke: {
      githubToken: string;
      npmToken: string;
    };
  };
  otterclawReceiver: {
    port: number;
    secret: string;
  };
}

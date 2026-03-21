import { loadConfig } from './config.js';
import { loadManifest, watchManifest } from './policy/manifest.js';
import { AlertBus, createAlert } from './alerts/bus.js';
import { JsonlLogger } from './alerts/logger.js';
import { TelegramHandler } from './alerts/telegram.js';
import { PauseSignalBroadcaster } from './alerts/pause-signal.js';
import { WebhookHandler } from './alerts/webhook.js';
import { AlertEscalator } from './alerts/escalation.js';
import { YieldClawProbe } from './probes/yieldclaw.js';
import { MMProbe } from './probes/mm.js';
import { PaymentLayerProbe } from './probes/payment-layer.js';
import { OtterClawProbe } from './probes/otterclaw.js';
import { GrowthAgentProbe } from './probes/growth-agent.js';
import { runAssertions } from './policy/assertion.js';
import { DriftDetector } from './policy/drift-detector.js';
import { AuditCorrelator } from './audit/correlator.js';
import { scanSkills } from './integrity/skill-scanner.js';
import { validateAllSkills } from './integrity/schema-validator.js';
import { verifyOnChainState } from './integrity/onchain-verifier.js';
import { DigestReporter } from './reports/digest.js';
import { createHealthServer, type HealthState } from './health.js';
import { fulfilled } from './utils.js';
import { appendFileSync } from 'node:fs';
import type { SecClawConfig, SystemSnapshot, PolicyManifest, AlertSeverity, AlertHandler } from './types.js';

const VERSION = '1.3.0';

async function main(): Promise<void> {
  const config = loadConfig();
  let manifest = loadManifest(config.manifestPath);

  console.log(`[secclaw] SecClaw v${VERSION} starting`);
  console.log(`[secclaw] Network: ${manifest.global.network}`);
  console.log(`[secclaw] Poll interval: ${config.pollIntervalSec}s`);
  console.log(`[secclaw] Mode: ${config.once ? 'single check' : 'daemon'}${config.dryRun ? ' (dry-run)' : ''}`);

  const bus = new AlertBus();
  bus.register(new JsonlLogger(config.logPath));

  const pushHandlers: AlertHandler[] = [];

  if (!config.dryRun && config.telegram.botToken && config.telegram.chatId) {
    const tgHandler = new TelegramHandler(config.telegram.botToken, config.telegram.chatId);
    bus.register(tgHandler);
    pushHandlers.push(tgHandler);
    console.log('[secclaw] Telegram alerts enabled');
  }

  if (!config.dryRun && config.pauseSignal.enabled) {
    bus.register(new PauseSignalBroadcaster(config.pauseSignal.port));
    console.log(`[secclaw] Pause signal enabled on port ${config.pauseSignal.port}`);
  }

  if (!config.dryRun && config.webhook.url) {
    const whHandler = new WebhookHandler(config.webhook.url);
    bus.register(whHandler);
    pushHandlers.push(whHandler);
    console.log('[secclaw] Webhook alerts enabled');
  }

  const ycProbe = new YieldClawProbe(config.yieldclaw.baseUrl, config.yieldclaw.healthToken);
  const mmProbe = new MMProbe(config.mm.accountId, config.mm.network, config.mm.statusUrl || undefined);
  const guardianProbe = new PaymentLayerProbe(config.guardian.auditLogPath);
  const ocProbe = new OtterClawProbe([config.otterclaw.skillsPath, config.otterclaw.partnerSkillsPath]);
  const gaProbe = new GrowthAgentProbe(config.growthAgent.auditLogPath, config.growthAgent.statePath);

  const driftDetector = new DriftDetector();
  const correlator = new AuditCorrelator();
  const escalator = new AlertEscalator();

  const healthState: HealthState = {
    startedAt: Date.now(),
    lastTickAt: null,
    lastTickDurationMs: null,
    tickCount: 0,
    lastAlertCounts: { critical: 0, high: 0, warning: 0, info: 0 },
    lastSnapshot: null,
    pollIntervalSec: config.pollIntervalSec,
  };

  const digest = new DigestReporter(24 * 60 * 60 * 1000, (report) => {
    const reportPath = config.logPath.replace(/\.jsonl$/, '-digest.md');
    try {
      appendFileSync(reportPath, `\n---\n${report}\n`, 'utf-8');
      console.log(`[secclaw] Digest written to ${reportPath}`);
    } catch (err) {
      console.error('[secclaw] Failed to write digest:', (err as Error).message);
    }
  });

  for (const handler of pushHandlers) {
    digest.registerAlertHandler(handler);
  }

  let stopWatching: (() => void) | null = null;
  if (!config.once) {
    stopWatching = watchManifest(
      config.manifestPath,
      (newManifest) => {
        manifest = newManifest;
        console.log('[secclaw] Policy manifest reloaded');
      },
      (err) => {
        console.error('[secclaw] Manifest reload failed (keeping current):', err.message);
      },
    );
    console.log('[secclaw] Manifest hot-reload enabled');
    digest.start();
  }

  const doTick = () => tick({
    bus, ycProbe, mmProbe, guardianProbe, ocProbe, gaProbe,
    driftDetector, correlator, escalator, digest, healthState,
    manifest, config,
  });

  if (config.once) {
    const hasAlerts = await doTick();
    process.exit(hasAlerts ? 1 : 0);
  } else {
    const healthServer = createHealthServer(healthState, config.healthPort, config.healthToken || undefined);

    await doTick();

    const interval = setInterval(doTick, config.pollIntervalSec * 1000);

    const shutdown = () => {
      console.log('\n[secclaw] Shutting down...');
      clearInterval(interval);
      digest.stop();
      healthServer.close();
      if (stopWatching) stopWatching();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    console.log(`[secclaw] Daemon running. Press Ctrl+C to stop.`);
  }
}

interface TickContext {
  bus: AlertBus;
  ycProbe: YieldClawProbe;
  mmProbe: MMProbe;
  guardianProbe: PaymentLayerProbe;
  ocProbe: OtterClawProbe;
  gaProbe: GrowthAgentProbe;
  driftDetector: DriftDetector;
  correlator: AuditCorrelator;
  escalator: AlertEscalator;
  digest: DigestReporter;
  healthState: HealthState;
  manifest: PolicyManifest;
  config: SecClawConfig;
}

async function tick(ctx: TickContext): Promise<boolean> {
  const { bus, ycProbe, mmProbe, guardianProbe, ocProbe, gaProbe,
    driftDetector, correlator, escalator, digest, healthState,
    manifest, config } = ctx;

  const cycleStart = Date.now();

  if (config.verbose) console.log(`[secclaw] Tick starting at ${new Date().toISOString()}`);

  const [ycResult, mmResult, guardianResult, ocResult, gaResult] = await Promise.allSettled([
    ycProbe.probe(),
    mmProbe.probe(),
    guardianProbe.probe(),
    ocProbe.probe(),
    gaProbe.probe(),
  ]);

  const snapshot: SystemSnapshot = {
    timestamp: Date.now(),
    yieldclaw: fulfilled(ycResult) ?? { ok: false, error: 'Probe failed', latencyMs: 0 },
    mm: fulfilled(mmResult) ?? { ok: false, error: 'Probe failed', latencyMs: 0 },
    guardian: fulfilled(guardianResult) ?? { ok: false, error: 'Probe failed', latencyMs: 0 },
    otterclaw: fulfilled(ocResult) ?? { ok: false, error: 'Probe failed', latencyMs: 0 },
    growthAgent: fulfilled(gaResult) ?? { ok: false, error: 'Probe failed', latencyMs: 0 },
  };

  if (config.verbose) {
    console.log(`[secclaw] Probes completed in ${Date.now() - cycleStart}ms`);
    console.log(`[secclaw]   YieldClaw: ${snapshot.yieldclaw.ok ? 'OK' : snapshot.yieldclaw.error} (${snapshot.yieldclaw.latencyMs}ms)`);
    console.log(`[secclaw]   MM: ${snapshot.mm.ok ? 'OK' : snapshot.mm.error} (${snapshot.mm.latencyMs}ms)`);
    console.log(`[secclaw]   Guardian: ${snapshot.guardian.ok ? 'OK' : snapshot.guardian.error} (${snapshot.guardian.latencyMs}ms)`);
    console.log(`[secclaw]   OtterClaw: ${snapshot.otterclaw.ok ? 'OK' : snapshot.otterclaw.error} (${snapshot.otterclaw.latencyMs}ms)`);
    console.log(`[secclaw]   Growth Agent: ${snapshot.growthAgent.ok ? 'OK' : snapshot.growthAgent.error} (${snapshot.growthAgent.latencyMs}ms)`);
  }

  const probeFailureAlerts = checkProbeFailures(snapshot);

  const alerts = [
    ...probeFailureAlerts,
    ...runAssertions(snapshot, manifest),
    ...driftDetector.detect(manifest),
    ...correlator.correlate(snapshot, manifest),
    ...await verifyOnChainState(snapshot, manifest, config.vaultDecimals),
    ...(snapshot.otterclaw.ok && snapshot.otterclaw.data
      ? scanSkills(snapshot.otterclaw.data.skills, manifest.otterclaw.url_allowlist)
      : []),
    ...(snapshot.otterclaw.ok && snapshot.otterclaw.data
      ? validateAllSkills(snapshot.otterclaw.data.skills)
      : []),
  ];

  const escalations = escalator.process(alerts);
  alerts.push(...escalations);

  driftDetector.record(snapshot);
  correlator.record(snapshot);
  digest.record(alerts, snapshot);

  const elapsed = Date.now() - cycleStart;
  healthState.lastTickAt = Date.now();
  healthState.lastTickDurationMs = elapsed;
  healthState.tickCount++;
  healthState.lastSnapshot = snapshot;
  healthState.lastAlertCounts = { critical: 0, high: 0, warning: 0, info: 0 };
  for (const a of alerts) healthState.lastAlertCounts[a.severity]++;

  if (alerts.length > 0) {
    if (config.verbose) {
      console.log(`[secclaw] ${alerts.length} alert(s):`);
      for (const a of alerts) {
        console.log(`[secclaw]   [${a.severity.toUpperCase()}] ${a.source}/${a.check}: ${a.message}`);
      }
    }
    await bus.emitAll(alerts);
  } else if (config.verbose) {
    console.log('[secclaw] All clear');
  }

  if (config.verbose) console.log(`[secclaw] Tick completed in ${elapsed}ms`);

  return alerts.length > 0;
}

function checkProbeFailures(snapshot: SystemSnapshot) {
  const alerts = [];
  const probes = [
    { name: 'yieldclaw', result: snapshot.yieldclaw },
    { name: 'agentic_mm', result: snapshot.mm },
    { name: 'payment_layer', result: snapshot.guardian },
    { name: 'otterclaw', result: snapshot.otterclaw },
    { name: 'growth_agent', result: snapshot.growthAgent },
  ] as const;

  for (const p of probes) {
    if (!p.result.ok) {
      alerts.push(createAlert(p.name, 'probe_failure', 'high',
        `Probe failed: ${p.result.error ?? 'unknown error'} — system is unmonitored`,
        { error: p.result.error, latencyMs: p.result.latencyMs },
      ));
    }
  }

  return alerts;
}

main().catch((err) => {
  console.error('[secclaw] Fatal error:', err);
  process.exit(1);
});

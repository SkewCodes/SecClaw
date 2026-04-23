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
import { ListingProbe } from './probes/listing.js';
import { WorkstationProbe } from './probes/workstation.js';
import { GitHubProbe } from './probes/github.js';
import { ProcessProbe } from './probes/process.js';
import { NetworkProbe } from './probes/network.js';
import { FilesystemProbe } from './probes/filesystem.js';
import { DeployPauseHandler } from './response/deploy-pause.js';
import { TokenRevokeHandler } from './response/token-revoke.js';
import { SignerRotateHandler } from './response/signer-rotate.js';
import { QuarantineBuilderHandler } from './response/quarantine-builder.js';
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
import { SecClawEventEmitter, deriveV2LogPath } from './events/emitter.js';
import { createOtterClawReceiver } from './events/otterclaw-receiver.js';
import { gate as gateFunction, createGateSharedState, type GateContext } from './gate/index.js';
import { checkSignerHealth, refreshSignerBalances } from './gate/signer-health.js';
import type {
  SecClawConfig, SystemSnapshot, PolicyManifest,
  AlertSeverity, AlertHandler, GateRequest, GateResponse, GateSharedState,
  OtterClawBridgeEvent,
} from './types.js';

const VERSION = '2.0.0';

async function main(): Promise<void> {
  const config = loadConfig();
  let manifest = loadManifest(config.manifestPath);

  console.log(`[secclaw] SecClaw v${VERSION} starting`);
  console.log(`[secclaw] Network: ${manifest.global.network}`);
  console.log(`[secclaw] Poll interval: ${config.pollIntervalSec}s`);
  console.log(`[secclaw] Mode: ${config.once ? 'single check' : 'daemon'}${config.dryRun ? ' (dry-run)' : ''}${config.auditMode ? ' (audit-mode)' : ''}`);

  if (manifest.supplyChain) {
    console.log(`[secclaw] Supply chain defense: quarantine=${manifest.supplyChain.quarantineWindowHours}h, hooks=${manifest.supplyChain.preinstallHookPolicy}, behavioral_diff=${manifest.supplyChain.behavioralDiff.enabled}`);
    console.log(`[secclaw] Lockfile attestation: required=${manifest.supplyChain.lockfileAttestation.required}, algorithm=${manifest.supplyChain.lockfileAttestation.algorithm}`);
  }

  const bus = new AlertBus();

  const v2LogPath = deriveV2LogPath(config.logPath);
  const v2Emitter = new SecClawEventEmitter(v2LogPath);
  const gateSharedState = createGateSharedState();
  console.log(`[secclaw] V2 events logging to ${v2LogPath}`);
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

  if (!config.dryRun && config.pauseSignal.enabled) {
    const deployPause = new DeployPauseHandler(
      config.pauseSignal.port,
      config.supplyChain.deployRunnerPort || undefined,
    );
    bus.register(deployPause);
    console.log('[secclaw] Deploy pause response enabled');
  }

  if (!config.dryRun && (config.supplyChain.tokenRevoke.githubToken || config.supplyChain.tokenRevoke.npmToken)) {
    const tokenRevoke = new TokenRevokeHandler({
      githubToken: config.supplyChain.tokenRevoke.githubToken || undefined,
      npmToken: config.supplyChain.tokenRevoke.npmToken || undefined,
    });
    bus.register(tokenRevoke);
    console.log('[secclaw] Token revoke response enabled');
  }

  if (!config.dryRun && config.supplyChain.signerRotateEndpoint) {
    const signerRotate = new SignerRotateHandler({
      rotationEndpoint: config.supplyChain.signerRotateEndpoint,
    });
    bus.register(signerRotate);
    console.log('[secclaw] Signer rotate response enabled');
  }

  if (!config.dryRun && config.pauseSignal.enabled) {
    const quarantine = new QuarantineBuilderHandler({
      pausePort: config.pauseSignal.port,
    });
    bus.register(quarantine);
    console.log('[secclaw] Builder quarantine response enabled');
  }

  const ycProbe = new YieldClawProbe(config.yieldclaw.baseUrl, config.yieldclaw.healthToken);
  const mmProbe = new MMProbe(config.mm.accountId, config.mm.network, config.mm.statusUrl || undefined);
  const guardianProbe = new PaymentLayerProbe(config.guardian.auditLogPath);
  const ocProbe = new OtterClawProbe([config.otterclaw.skillsPath, config.otterclaw.partnerSkillsPath]);
  const gaProbe = new GrowthAgentProbe(config.growthAgent.auditLogPath, config.growthAgent.statePath);
  const listingProbe = new ListingProbe(config.listing.auditLogPath);

  const workstationProbe = new WorkstationProbe();
  const githubProbe = new GitHubProbe(
    'https://api.github.com',
    config.supplyChain.githubToken || undefined,
    config.supplyChain.githubRepos,
  );
  const processProbe = new ProcessProbe();
  const networkProbe = new NetworkProbe(
    manifest.supplyChain?.exfilDomainBlocklist ?? [],
  );
  const filesystemProbe = new FilesystemProbe(
    manifest.supplyChain?.behavioralDiff.sensitivePathBlocklist,
  );

  const driftDetector = new DriftDetector();
  const correlator = new AuditCorrelator();
  const escalator = new AlertEscalator();

  const MAX_OTTERCLAW_EVENT_BUFFER = 100;
  const otterclawEventBuffer: OtterClawBridgeEvent[] = [];

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
        gateCtx.manifest = newManifest;
        if (newManifest.supplyChain) {
          networkProbe.setAllowlist(newManifest.supplyChain.exfilDomainBlocklist);
          filesystemProbe.updatePaths(newManifest.supplyChain.behavioralDiff.sensitivePathBlocklist);
        }
        console.log('[secclaw] Policy manifest reloaded');
      },
      (err) => {
        console.error('[secclaw] Manifest reload failed (keeping current):', err.message);
      },
    );
    console.log('[secclaw] Manifest hot-reload enabled');
    digest.start();
  }

  const gateCtx: GateContext = {
    manifest,
    config,
    sharedState: gateSharedState,
    emitter: v2Emitter,
    alertBus: bus,
    signerHealthCheck: checkSignerHealth,
  };
  _gateCtx = gateCtx;

  const doTick = () => tick({
    bus, ycProbe, mmProbe, guardianProbe, ocProbe, gaProbe, listingProbe,
    workstationProbe, githubProbe, processProbe, networkProbe, filesystemProbe,
    driftDetector, correlator, escalator, digest, healthState,
    manifest, config, gateSharedState, otterclawEventBuffer,
  });

  if (config.once) {
    const hasAlerts = await doTick();
    process.exit(hasAlerts ? 1 : 0);
  } else {
    const healthServer = createHealthServer(healthState, config.healthPort, config.healthToken || undefined);

    let receiverServer: ReturnType<typeof createOtterClawReceiver> | null = null;
    if (config.otterclawReceiver.secret) {
      receiverServer = createOtterClawReceiver(
        config.otterclawReceiver.port,
        config.otterclawReceiver.secret,
        (events) => {
          for (const ev of events) {
            otterclawEventBuffer.push(ev);
          }
          while (otterclawEventBuffer.length > MAX_OTTERCLAW_EVENT_BUFFER) {
            otterclawEventBuffer.shift();
          }
          const bridgedAlerts = events
            .filter((e) =>
              e.type === 'skill.cli.blocked' ||
              e.type === 'skill.capability.violation' ||
              e.type === 'skill.install.blocked' ||
              e.type === 'skill.sandbox.escape' ||
              e.type === 'skill.network.blocked')
            .map((e) => createAlert(
              'otterclaw',
              e.type.replace(/\./g, '_'),
              e.severity === 'critical' ? 'critical' : e.severity === 'warning' ? 'high' : 'warning',
              `OtterClaw: ${e.type} for skill ${e.skill_id}`,
              { skill_id: e.skill_id, event_id: e.id, ...e.details },
            ));
          if (bridgedAlerts.length > 0) {
            bus.emitAll(bridgedAlerts).catch((err) => {
              console.error('[secclaw] Failed to emit OtterClaw bridged alerts:', (err as Error).message);
            });
          }
        },
      );
      console.log(`[secclaw] OtterClaw receiver enabled on port ${config.otterclawReceiver.port}`);
    }

    await doTick();

    const interval = setInterval(doTick, config.pollIntervalSec * 1000);

    const shutdown = () => {
      console.log('\n[secclaw] Shutting down...');
      clearInterval(interval);
      digest.stop();
      healthServer.close();
      if (receiverServer) receiverServer.close();
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
  listingProbe: ListingProbe;
  workstationProbe: WorkstationProbe;
  githubProbe: GitHubProbe;
  processProbe: ProcessProbe;
  networkProbe: NetworkProbe;
  filesystemProbe: FilesystemProbe;
  driftDetector: DriftDetector;
  correlator: AuditCorrelator;
  escalator: AlertEscalator;
  digest: DigestReporter;
  healthState: HealthState;
  manifest: PolicyManifest;
  config: SecClawConfig;
  gateSharedState: GateSharedState;
  otterclawEventBuffer: OtterClawBridgeEvent[];
}

async function tick(ctx: TickContext): Promise<boolean> {
  const { bus, ycProbe, mmProbe, guardianProbe, ocProbe, gaProbe, listingProbe,
    workstationProbe, githubProbe, processProbe, networkProbe, filesystemProbe,
    driftDetector, correlator, escalator, digest, healthState,
    manifest, config, gateSharedState, otterclawEventBuffer } = ctx;

  const cycleStart = Date.now();

  if (config.verbose) console.log(`[secclaw] Tick starting at ${new Date().toISOString()}`);

  const [ycResult, mmResult, guardianResult, ocResult, gaResult, listingResult,
    wsResult, ghResult, procResult, netResult, fsResult] = await Promise.allSettled([
    ycProbe.probe(),
    mmProbe.probe(),
    guardianProbe.probe(),
    ocProbe.probe(),
    gaProbe.probe(),
    listingProbe.probe(),
    workstationProbe.probe(),
    githubProbe.probe(),
    processProbe.probe(),
    networkProbe.probe(),
    filesystemProbe.probe(),
  ]);

  const snapshot: SystemSnapshot = {
    timestamp: Date.now(),
    yieldclaw: fulfilled(ycResult) ?? { ok: false, error: 'Probe failed', latencyMs: 0 },
    mm: fulfilled(mmResult) ?? { ok: false, error: 'Probe failed', latencyMs: 0 },
    guardian: fulfilled(guardianResult) ?? { ok: false, error: 'Probe failed', latencyMs: 0 },
    otterclaw: fulfilled(ocResult) ?? { ok: false, error: 'Probe failed', latencyMs: 0 },
    growthAgent: fulfilled(gaResult) ?? { ok: false, error: 'Probe failed', latencyMs: 0 },
    listing: fulfilled(listingResult) ?? { ok: false, error: 'Probe failed', latencyMs: 0 },
    workstation: fulfilled(wsResult) ?? undefined,
    github: fulfilled(ghResult) ?? undefined,
    process: fulfilled(procResult) ?? undefined,
    network: fulfilled(netResult) ?? undefined,
    filesystem: fulfilled(fsResult) ?? undefined,
    otterclawEvents: otterclawEventBuffer.length > 0
      ? otterclawEventBuffer.splice(0, otterclawEventBuffer.length)
      : undefined,
  };

  if (config.verbose) {
    console.log(`[secclaw] Probes completed in ${Date.now() - cycleStart}ms`);
    console.log(`[secclaw]   YieldClaw: ${snapshot.yieldclaw.ok ? 'OK' : snapshot.yieldclaw.error} (${snapshot.yieldclaw.latencyMs}ms)`);
    console.log(`[secclaw]   MM: ${snapshot.mm.ok ? 'OK' : snapshot.mm.error} (${snapshot.mm.latencyMs}ms)`);
    console.log(`[secclaw]   Guardian: ${snapshot.guardian.ok ? 'OK' : snapshot.guardian.error} (${snapshot.guardian.latencyMs}ms)`);
    console.log(`[secclaw]   OtterClaw: ${snapshot.otterclaw.ok ? 'OK' : snapshot.otterclaw.error} (${snapshot.otterclaw.latencyMs}ms)`);
    console.log(`[secclaw]   Growth Agent: ${snapshot.growthAgent.ok ? 'OK' : snapshot.growthAgent.error} (${snapshot.growthAgent.latencyMs}ms)`);
    console.log(`[secclaw]   Listing: ${snapshot.listing.ok ? 'OK' : snapshot.listing.error} (${snapshot.listing.latencyMs}ms)`);
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

  gateSharedState.activeCriticalAlerts.clear();
  for (const a of alerts) {
    if (a.severity === 'critical') {
      gateSharedState.activeCriticalAlerts.add(a.id);
    }
  }

  if (snapshot.listing.ok && snapshot.listing.data) {
    gateSharedState.recentListings = snapshot.listing.data.recentListings;
  }

  if (manifest.signer) {
    try {
      await refreshSignerBalances(manifest.global.network);
    } catch (err) {
      if (config.verbose) {
        console.error('[secclaw] Balance refresh failed:', (err as Error).message);
      }
    }
  }

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
    { name: 'listing', result: snapshot.listing },
  ] as const;

  for (const p of probes) {
    if (!p.result.ok) {
      alerts.push(createAlert(p.name, 'probe_failure', 'high',
        `Probe failed: ${p.result.error ?? 'unknown error'} — system is unmonitored`,
        { error: p.result.error, latencyMs: p.result.latencyMs },
      ));
    }
  }

  const scProbes = [
    { name: 'workstation', result: snapshot.workstation },
    { name: 'github', result: snapshot.github },
    { name: 'process', result: snapshot.process },
    { name: 'network', result: snapshot.network },
    { name: 'filesystem', result: snapshot.filesystem },
  ] as const;

  for (const p of scProbes) {
    if (p.result && !p.result.ok) {
      alerts.push(createAlert(`supply-chain`, 'probe_failure', 'high',
        `Supply chain probe ${p.name} failed: ${p.result.error ?? 'unknown error'}`,
        { probe: p.name, error: p.result.error, latencyMs: p.result.latencyMs },
      ));
    }
  }

  return alerts;
}

/**
 * Exported gate API for agents to import and call directly.
 * Must be called after main() has started (daemon or single-check mode).
 */
let _gateCtx: GateContext | null = null;

export function getGateContext(): GateContext {
  if (!_gateCtx) {
    throw new Error('Gate not initialized — daemon must be running');
  }
  return _gateCtx;
}

export async function callGate(request: GateRequest): Promise<GateResponse> {
  return gateFunction(request, getGateContext());
}

main().catch((err) => {
  console.error('[secclaw] Fatal error:', err);
  process.exit(1);
});

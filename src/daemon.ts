import { loadConfig } from './config.js';
import { bootstrap } from './bootstrap.js';
import { gate as gateFunction, type GateContext } from './gate/index.js';
import type { GateRequest, GateResponse } from './types.js';

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

async function main(): Promise<void> {
  const config = loadConfig();
  const { tick, shutdown, gateCtx } = await bootstrap(config);
  _gateCtx = gateCtx;

  if (config.once) {
    const hasAlerts = await tick();
    process.exit(hasAlerts ? 1 : 0);
  }

  await tick();

  const interval = setInterval(tick, config.pollIntervalSec * 1000);

  const onSignal = async () => {
    clearInterval(interval);
    await shutdown();
    process.exit(0);
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  console.log(`[secclaw] Daemon running. Press Ctrl+C to stop.`);
}

main().catch((err) => {
  console.error('[secclaw] Fatal error:', err);
  process.exit(1);
});

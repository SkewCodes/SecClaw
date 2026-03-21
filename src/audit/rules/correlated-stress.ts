import { createAlert } from '../../alerts/bus.js';
import type { Alert, SystemSnapshot } from '../../types.js';

export function checkCorrelatedStress(
  snapshot: SystemSnapshot,
  window: readonly SystemSnapshot[] = [],
): Alert[] {
  const alerts: Alert[] = [];

  const ycStressed = snapshot.yieldclaw.ok &&
    snapshot.yieldclaw.data?.risk?.circuitBreaker.level !== undefined &&
    ['ORANGE', 'RED'].includes(snapshot.yieldclaw.data.risk.circuitBreaker.level);

  const mmBalance = snapshot.mm.ok ? snapshot.mm.data?.balance : null;
  const mmStressed = mmBalance != null &&
    mmBalance.totalPnl < 0 &&
    mmBalance.totalCollateral > 0 &&
    (Math.abs(mmBalance.totalPnl) / mmBalance.totalCollateral) > 0.03;

  if (ycStressed && mmStressed) {
    const ycLevel = snapshot.yieldclaw.data!.risk!.circuitBreaker.level;
    const mmDrawdown = snapshot.mm.data!.balance!.totalPnl;

    alerts.push(createAlert('cross_system', 'correlated_stress', 'critical',
      `Multiple systems in protective state — likely market event. YieldClaw CB: ${ycLevel}, MM PnL: $${mmDrawdown.toFixed(2)}`,
      {
        yieldclaw_cb: ycLevel,
        yieldclaw_drawdown: snapshot.yieldclaw.data!.risk!.drawdownPct,
        mm_pnl: mmDrawdown,
        mm_collateral: snapshot.mm.data!.balance!.totalCollateral,
      },
    ));
  }

  // Detect prolonged stress across the window
  if (window.length >= 3) {
    const recentStressed = window.slice(-3).filter((s) => {
      const ycBad = s.yieldclaw.ok &&
        s.yieldclaw.data?.risk?.circuitBreaker.level !== undefined &&
        ['ORANGE', 'RED'].includes(s.yieldclaw.data.risk.circuitBreaker.level);
      const mmBal = s.mm.ok ? s.mm.data?.balance : null;
      const mmBad = mmBal != null && mmBal.totalPnl < 0 &&
        mmBal.totalCollateral > 0 &&
        (Math.abs(mmBal.totalPnl) / mmBal.totalCollateral) > 0.03;
      return ycBad || mmBad;
    });

    if (recentStressed.length >= 3) {
      alerts.push(createAlert('cross_system', 'prolonged_stress', 'critical',
        `Stress detected across ${recentStressed.length} consecutive cycles — sustained adverse market conditions`,
        { consecutiveCycles: recentStressed.length },
      ));
    }
  }

  return alerts;
}

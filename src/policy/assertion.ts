import { createAlert } from '../alerts/bus.js';
import type {
  Alert,
  PolicyManifest,
  YieldClawSnapshot,
  MMSnapshot,
  GuardianSnapshot,
  OtterClawSnapshot,
  GrowthAgentSnapshot,
  SystemSnapshot,
} from '../types.js';

export function runAssertions(snapshot: SystemSnapshot, manifest: PolicyManifest): Alert[] {
  const alerts: Alert[] = [];

  if (snapshot.yieldclaw.ok && snapshot.yieldclaw.data) {
    alerts.push(...assertYieldClaw(snapshot.yieldclaw.data, manifest));
  }

  if (snapshot.mm.ok && snapshot.mm.data) {
    alerts.push(...assertMM(snapshot.mm.data, manifest));
  }

  if (snapshot.guardian.ok && snapshot.guardian.data) {
    alerts.push(...assertGuardian(snapshot.guardian.data, manifest));
  }

  if (snapshot.otterclaw.ok && snapshot.otterclaw.data) {
    alerts.push(...assertOtterClaw(snapshot.otterclaw.data, manifest));
  }

  if (snapshot.growthAgent.ok && snapshot.growthAgent.data) {
    alerts.push(...assertGrowthAgent(snapshot.growthAgent.data, manifest));
  }

  return alerts;
}

// ─── YieldClaw Assertions ─────────────────────────────────────

function assertYieldClaw(data: YieldClawSnapshot, manifest: PolicyManifest): Alert[] {
  const alerts: Alert[] = [];
  const hl = manifest.yieldclaw.hard_limits;

  // NAV drift check
  if (data.risk && data.sharePrice) {
    const reportedNav = data.risk.currentNav;
    const onchainNav = data.sharePrice.nav;
    if (onchainNav > 0) {
      const driftPct = Math.abs(reportedNav - onchainNav) / onchainNav * 100;
      if (driftPct > manifest.yieldclaw.nav_drift_tolerance_pct) {
        alerts.push(createAlert('yieldclaw', 'nav_drift', 'critical',
          `NAV drift ${driftPct.toFixed(2)}% exceeds ${manifest.yieldclaw.nav_drift_tolerance_pct}% tolerance`,
          { reportedNav, onchainNav, driftPct },
        ));
      }
    }
  }

  // Circuit breaker determinism
  if (data.risk && data.status) {
    const { drawdownPct } = data.risk;
    const cbLevel = data.risk.circuitBreaker.level;
    const expectedLevel = expectedCBLevel(drawdownPct, hl);

    if (cbLevel !== expectedLevel) {
      alerts.push(createAlert('yieldclaw', 'circuit_breaker_mismatch', 'critical',
        `Circuit breaker at ${cbLevel} but expected ${expectedLevel} given ${drawdownPct.toFixed(2)}% drawdown`,
        { cbLevel, expectedLevel, drawdownPct },
      ));
    }

    if (cbLevel === 'RED' && data.status.vault.state === 'ACTIVE') {
      alerts.push(createAlert('yieldclaw', 'circuit_breaker_state_mismatch', 'critical',
        'Circuit breaker RED but vault still ACTIVE',
        { cbLevel, vaultState: data.status.vault.state },
      ));
    }
  }

  // Drawdown limit
  if (data.risk) {
    if (data.risk.drawdownPct > hl.max_drawdown_pct) {
      alerts.push(createAlert('yieldclaw', 'drawdown_exceeded', 'critical',
        `Drawdown ${data.risk.drawdownPct.toFixed(2)}% exceeds limit ${hl.max_drawdown_pct}%`,
        { drawdownPct: data.risk.drawdownPct, limit: hl.max_drawdown_pct },
      ));
    } else if (data.risk.drawdownPct > hl.max_drawdown_pct * 0.8) {
      alerts.push(createAlert('yieldclaw', 'drawdown_approaching', 'warning',
        `Drawdown ${data.risk.drawdownPct.toFixed(2)}% approaching limit ${hl.max_drawdown_pct}%`,
        { drawdownPct: data.risk.drawdownPct, limit: hl.max_drawdown_pct },
      ));
    }
  }

  // Position count
  if (data.positions.length > hl.max_concurrent_positions) {
    alerts.push(createAlert('yieldclaw', 'position_count_exceeded', 'high',
      `${data.positions.length} positions exceeds limit ${hl.max_concurrent_positions}`,
      { count: data.positions.length, limit: hl.max_concurrent_positions },
    ));
  }

  // Leverage check
  if (data.strategy) {
    if (data.strategy.allocation.maxLeverage > hl.max_leverage) {
      alerts.push(createAlert('yieldclaw', 'leverage_exceeded', 'high',
        `Strategy maxLeverage ${data.strategy.allocation.maxLeverage}x exceeds hard limit ${hl.max_leverage}x`,
        { strategyLeverage: data.strategy.allocation.maxLeverage, limit: hl.max_leverage },
      ));
    }
  }

  // Per-position leverage check
  for (const pos of data.positions) {
    if (pos.leverage > hl.max_leverage) {
      alerts.push(createAlert('yieldclaw', 'position_leverage_exceeded', 'high',
        `${pos.symbol} leverage ${pos.leverage}x exceeds limit ${hl.max_leverage}x`,
        { symbol: pos.symbol, leverage: pos.leverage, limit: hl.max_leverage },
      ));
    }
  }

  // Share price sanity
  if (data.sharePrice) {
    if (data.sharePrice.share_price <= 0) {
      alerts.push(createAlert('yieldclaw', 'share_price_zero', 'critical',
        'Share price is zero or negative',
        { sharePrice: data.sharePrice.share_price },
      ));
    }
  }

  return alerts;
}

function expectedCBLevel(drawdownPct: number, limits: PolicyManifest['yieldclaw']['hard_limits']): string {
  const maxDD = limits.max_drawdown_pct;
  if (drawdownPct >= maxDD) return 'RED';
  if (drawdownPct >= maxDD * 0.75) return 'ORANGE';
  if (drawdownPct >= maxDD * 0.5) return 'YELLOW';
  return 'GREEN';
}

// ─── MM Assertions ────────────────────────────────────────────

function assertMM(data: MMSnapshot, manifest: PolicyManifest): Alert[] {
  const alerts: Alert[] = [];
  const safety = manifest.agentic_mm.safety;

  if (data.balance) {
    const capital = data.balance.totalCollateral;

    // PnL vs max drawdown
    if (capital > 0 && data.balance.totalPnl < 0) {
      const drawdownPct = Math.abs(data.balance.totalPnl) / capital * 100;
      if (drawdownPct > safety.max_drawdown_pct) {
        alerts.push(createAlert('agentic_mm', 'mm_drawdown_exceeded', 'critical',
          `MM drawdown ${drawdownPct.toFixed(2)}% exceeds limit ${safety.max_drawdown_pct}%`,
          { drawdownPct, totalPnl: data.balance.totalPnl, capital },
        ));
      } else if (drawdownPct > safety.max_drawdown_pct * 0.8) {
        alerts.push(createAlert('agentic_mm', 'mm_drawdown_approaching', 'warning',
          `MM drawdown ${drawdownPct.toFixed(2)}% approaching limit ${safety.max_drawdown_pct}%`,
          { drawdownPct, limit: safety.max_drawdown_pct },
        ));
      }
    }

    // Free collateral ratio — if below 10% of total, risk of liquidation
    if (capital > 0) {
      const freeRatio = data.balance.freeCollateral / capital;
      if (freeRatio < 0.1) {
        alerts.push(createAlert('agentic_mm', 'mm_low_free_collateral', 'high',
          `MM free collateral ${(freeRatio * 100).toFixed(1)}% of total — liquidation risk`,
          { freeCollateral: data.balance.freeCollateral, totalCollateral: capital, ratio: freeRatio },
        ));
      }
    }

    // Position size limits
    const maxPositionPct = Math.max(
      ...Object.values(manifest.agentic_mm.risk_presets).map((p) => p.max_position_pct),
    );

    for (const pos of data.positions) {
      const positionValue = Math.abs(pos.size * pos.markPrice);
      const positionPct = (positionValue / capital) * 100;

      if (positionPct > maxPositionPct) {
        alerts.push(createAlert('agentic_mm', 'mm_position_exceeded', 'high',
          `MM ${pos.symbol} position ${positionPct.toFixed(1)}% of capital exceeds max preset ${maxPositionPct}%`,
          { symbol: pos.symbol, positionPct, limit: maxPositionPct, positionValue },
        ));
      }
    }

    // Aggregate MM exposure vs capital with leverage
    const totalExposure = data.positions.reduce(
      (sum, p) => sum + Math.abs(p.size * p.markPrice), 0,
    );
    if (capital > 0 && totalExposure > 0) {
      const impliedLeverage = totalExposure / capital;
      const maxLevForPreset = safety.max_drawdown_pct > 0 ? 100 / safety.max_drawdown_pct : 20;
      if (impliedLeverage > maxLevForPreset) {
        alerts.push(createAlert('agentic_mm', 'mm_implied_leverage_high', 'high',
          `MM implied leverage ${impliedLeverage.toFixed(1)}x exceeds safe bound for ${safety.max_drawdown_pct}% drawdown limit`,
          { impliedLeverage, totalExposure, capital },
        ));
      }
    }
  }

  // ─── Deep safety layer checks (available when MM exposes status API) ──

  if (data.safety) {
    // Circuit breaker vs drawdown consistency
    if (data.balance && data.balance.totalCollateral > 0 && data.balance.totalPnl < 0) {
      const ddPct = Math.abs(data.balance.totalPnl) / data.balance.totalCollateral * 100;
      if (ddPct >= safety.max_drawdown_pct && data.safety.circuitBreaker !== 'RED') {
        alerts.push(createAlert('agentic_mm', 'mm_circuit_breaker_mismatch', 'critical',
          `MM drawdown ${ddPct.toFixed(2)}% >= limit but circuit breaker is ${data.safety.circuitBreaker}, expected RED`,
          { drawdownPct: ddPct, cbLevel: data.safety.circuitBreaker },
        ));
      }
    }

    if (data.safety.volatilityPaused) {
      alerts.push(createAlert('agentic_mm', 'mm_volatility_paused', 'warning',
        'MM quoting paused due to high volatility',
        { safety: data.safety },
      ));
    }

    if (data.safety.fundingGuardActive) {
      alerts.push(createAlert('agentic_mm', 'mm_funding_guard_active', 'warning',
        `MM funding guard triggered — funding rate exceeds ${safety.funding_guard_threshold_pct}%`,
        { threshold: safety.funding_guard_threshold_pct },
      ));
    }

    if (data.safety.cascadeDetected) {
      alerts.push(createAlert('agentic_mm', 'mm_cascade_detected', 'high',
        `MM cascade detection triggered — ${safety.cascade_same_side_fills}+ same-side fills in ${safety.cascade_window_sec}s`,
        { safety: data.safety },
      ));
    }

    if (data.safety.trendDetected) {
      alerts.push(createAlert('agentic_mm', 'mm_trend_detected', 'info',
        'MM trend detection active — spread widened, one-sided quoting',
        {},
      ));
    }
  }

  // Auto-tuner checks
  if (data.autoTuner) {
    const tunerLimits = manifest.agentic_mm.auto_tuner;
    if (data.autoTuner.changesLast24h > tunerLimits.max_changes_per_24h) {
      alerts.push(createAlert('agentic_mm', 'mm_auto_tuner_excessive', 'high',
        `MM auto-tuner made ${data.autoTuner.changesLast24h} changes in 24h — limit is ${tunerLimits.max_changes_per_24h}`,
        { changes: data.autoTuner.changesLast24h, limit: tunerLimits.max_changes_per_24h },
      ));
    }

    if (!data.autoTuner.warmupComplete) {
      alerts.push(createAlert('agentic_mm', 'mm_auto_tuner_warmup', 'info',
        `MM auto-tuner still in warmup (${tunerLimits.warmup_hours}h required)`,
        {},
      ));
    }
  }

  // Quality grade check
  if (data.quality) {
    const badGrades = ['D', 'F'];
    if (badGrades.includes(data.quality.grade)) {
      alerts.push(createAlert('agentic_mm', 'mm_quality_poor', 'warning',
        `MM quality grade ${data.quality.grade} — fill rate: ${(data.quality.fillRate * 100).toFixed(1)}%, adverse selection: ${data.quality.adverseSelectionBps.toFixed(1)} bps`,
        { grade: data.quality.grade, fillRate: data.quality.fillRate, adverseSelectionBps: data.quality.adverseSelectionBps },
      ));
    }
  }

  return alerts;
}

// ─── Guardian Assertions ──────────────────────────────────────

function assertGuardian(data: GuardianSnapshot, manifest: PolicyManifest): Alert[] {
  const alerts: Alert[] = [];
  const sp = manifest.payment_layer.spending;
  const sess = manifest.payment_layer.session;
  const swapLimits = manifest.payment_layer.swaps;
  const vaultLimits = manifest.payment_layer.vaults;
  const tradingLimits = manifest.payment_layer.trading;

  // Approved with violations
  for (const intent of data.recentIntents) {
    if (intent.policyResult === 'approved' &&
        intent.policyViolations &&
        intent.policyViolations.length > 0) {
      alerts.push(createAlert('payment_layer', 'approved_with_violations', 'critical',
        `Intent ${intent.intentId} approved despite ${intent.policyViolations.length} policy violations`,
        { intentId: intent.intentId, violations: intent.policyViolations },
      ));
    }

    // Intent without policy evaluation
    if (intent.policyResult === undefined) {
      alerts.push(createAlert('payment_layer', 'unevaluated_intent', 'critical',
        `Intent ${intent.intentId} has no policy evaluation result`,
        { intentId: intent.intentId, action: intent.action },
      ));
    }
  }

  // ─── Swap intent enforcement ─────────────────────────────────
  const swapIntents = data.recentIntents.filter((i) => i.action === 'swap_tokens');
  for (const intent of swapIntents) {
    if (intent.status === 'executed' && intent.receipt) {
      const amount = (intent.receipt.orderQuantity ?? 0) * (intent.receipt.orderPrice ?? 0);
      if (amount > swapLimits.max_swap_amount_usd) {
        alerts.push(createAlert('payment_layer', 'swap_amount_exceeded', 'high',
          `Swap $${amount.toFixed(2)} exceeds limit $${swapLimits.max_swap_amount_usd}`,
          { intentId: intent.intentId, amount, limit: swapLimits.max_swap_amount_usd },
        ));
      }
    }
  }

  // ─── Vault intent enforcement ────────────────────────────────
  const vaultDeposits = data.recentIntents.filter((i) => i.action === 'vault_deposit');
  const vaultWithdrawals = data.recentIntents.filter((i) => i.action === 'vault_withdraw');

  for (const intent of vaultDeposits) {
    if (intent.status === 'executed' && intent.receipt) {
      const amount = (intent.receipt.orderQuantity ?? 0) * (intent.receipt.orderPrice ?? 1);
      if (amount > vaultLimits.max_deposit_per_tx_usd) {
        alerts.push(createAlert('payment_layer', 'vault_deposit_exceeded', 'high',
          `Vault deposit $${amount.toFixed(2)} exceeds per-tx limit $${vaultLimits.max_deposit_per_tx_usd}`,
          { intentId: intent.intentId, amount, limit: vaultLimits.max_deposit_per_tx_usd },
        ));
      }
    }
  }

  for (const intent of vaultWithdrawals) {
    if (intent.status === 'executed' && intent.receipt) {
      const amount = (intent.receipt.orderQuantity ?? 0) * (intent.receipt.orderPrice ?? 1);
      if (amount > vaultLimits.max_withdraw_per_tx_usd) {
        alerts.push(createAlert('payment_layer', 'vault_withdraw_exceeded', 'high',
          `Vault withdrawal $${amount.toFixed(2)} exceeds per-tx limit $${vaultLimits.max_withdraw_per_tx_usd}`,
          { intentId: intent.intentId, amount, limit: vaultLimits.max_withdraw_per_tx_usd },
        ));
      }
    }
  }

  const dailyWithdrawTotal = vaultWithdrawals
    .filter((i) => i.status === 'executed' && i.receipt)
    .reduce((sum, i) => sum + ((i.receipt?.orderQuantity ?? 0) * (i.receipt?.orderPrice ?? 1)), 0);

  if (dailyWithdrawTotal > vaultLimits.daily_withdraw_limit_usd) {
    alerts.push(createAlert('payment_layer', 'vault_daily_withdraw_exceeded', 'critical',
      `Daily vault withdrawals $${dailyWithdrawTotal.toFixed(2)} exceed limit $${vaultLimits.daily_withdraw_limit_usd}`,
      { total: dailyWithdrawTotal, limit: vaultLimits.daily_withdraw_limit_usd },
    ));
  }

  // ─── Trading intent enforcement (symbol + order type allowlist) ──
  const tradingIntents = data.recentIntents.filter(
    (i) => i.action === 'place_order' && i.status === 'executed',
  );

  for (const intent of tradingIntents) {
    if (intent.receipt) {
      const amount = (intent.receipt.orderQuantity ?? 0) * (intent.receipt.orderPrice ?? 0);
      if (amount > tradingLimits.require_approval_above_usd && intent.tier === 'session') {
        alerts.push(createAlert('payment_layer', 'large_order_session_tier', 'high',
          `Order $${amount.toFixed(2)} above $${tradingLimits.require_approval_above_usd} approval threshold executed at session tier`,
          { intentId: intent.intentId, amount, threshold: tradingLimits.require_approval_above_usd },
        ));
      }
    }
  }

  // Spending limits
  if (data.spendingHourly > sp.hourly_limit_usd) {
    alerts.push(createAlert('payment_layer', 'hourly_spending_exceeded', 'high',
      `Hourly spending $${data.spendingHourly.toFixed(2)} exceeds limit $${sp.hourly_limit_usd}`,
      { spendingHourly: data.spendingHourly, limit: sp.hourly_limit_usd },
    ));
  }

  if (data.spendingDaily > sp.daily_limit_usd) {
    alerts.push(createAlert('payment_layer', 'daily_spending_exceeded', 'high',
      `Daily spending $${data.spendingDaily.toFixed(2)} exceeds limit $${sp.daily_limit_usd}`,
      { spendingDaily: data.spendingDaily, limit: sp.daily_limit_usd },
    ));
  }

  // Audit log append-only check
  if (data.previousLogFileSize > 0 && data.logFileSize < data.previousLogFileSize) {
    alerts.push(createAlert('payment_layer', 'audit_log_truncated', 'critical',
      `Audit log shrunk from ${data.previousLogFileSize} to ${data.logFileSize} bytes — possible tampering`,
      { previousSize: data.previousLogFileSize, currentSize: data.logFileSize },
    ));
  }

  // Consecutive violations
  const recentViolations = data.recentIntents.filter(
    (i) => i.policyResult === 'denied' || (i.policyViolations && i.policyViolations.length > 0),
  );
  if (recentViolations.length >= sess.max_consecutive_violations) {
    alerts.push(createAlert('payment_layer', 'excessive_violations', 'high',
      `${recentViolations.length} policy violations in recent window (threshold: ${sess.max_consecutive_violations})`,
      { violationCount: recentViolations.length, threshold: sess.max_consecutive_violations },
    ));
  }

  // Session-tier signing distribution anomaly
  const totalIntents = data.recentIntents.length;
  if (totalIntents > 10) {
    const elevatedCount = data.recentIntents.filter((i) => i.tier === 'elevated').length;
    const walletCount = data.recentIntents.filter((i) => i.tier === 'wallet').length;
    const highTierRatio = (elevatedCount + walletCount) / totalIntents;

    if (highTierRatio > 0.5) {
      alerts.push(createAlert('payment_layer', 'high_tier_signing_ratio', 'warning',
        `${(highTierRatio * 100).toFixed(0)}% of intents require wallet/elevated signing — session may be ineffective`,
        { elevatedCount, walletCount, totalIntents, ratio: highTierRatio },
      ));
    }
  }

  return alerts;
}

// ─── OtterClaw Assertions ─────────────────────────────────────

function assertOtterClaw(data: OtterClawSnapshot, manifest: PolicyManifest): Alert[] {
  const alerts: Alert[] = [];
  const pinnedHashes = manifest.otterclaw.skill_hashes;

  for (const skill of data.skills) {
    const pinnedHash = pinnedHashes[skill.relativePath];
    if (pinnedHash && skill.hash !== pinnedHash) {
      alerts.push(createAlert('otterclaw', 'skill_hash_mismatch', 'critical',
        `Skill ${skill.relativePath} hash changed outside tagged release`,
        {
          path: skill.relativePath,
          expected: pinnedHash,
          actual: skill.hash,
        },
      ));
    }

    if (!skill.frontmatter) {
      alerts.push(createAlert('otterclaw', 'skill_no_frontmatter', 'high',
        `Skill ${skill.relativePath} has missing or malformed frontmatter`,
        { path: skill.relativePath },
      ));
    }
  }

  return alerts;
}

// ─── Growth Agent Assertions ──────────────────────────────────

function assertGrowthAgent(data: GrowthAgentSnapshot, manifest: PolicyManifest): Alert[] {
  const alerts: Alert[] = [];
  const ga = manifest.growth_agent;

  // Playbook count per cycle
  if (data.playbooksExecuted.length > ga.max_playbooks_per_cycle) {
    alerts.push(createAlert('growth_agent', 'playbooks_per_cycle_exceeded', 'high',
      `${data.playbooksExecuted.length} playbooks executed — limit is ${ga.max_playbooks_per_cycle}`,
      { count: data.playbooksExecuted.length, limit: ga.max_playbooks_per_cycle },
    ));
  }

  // Disallowed playbook
  for (const run of data.playbooksExecuted) {
    if (ga.allowed_playbooks.length > 0 && !ga.allowed_playbooks.includes(run.playbook)) {
      alerts.push(createAlert('growth_agent', 'disallowed_playbook', 'critical',
        `Playbook "${run.playbook}" is not in the allowed list`,
        { playbook: run.playbook, allowed: ga.allowed_playbooks },
      ));
    }
  }

  // Live playbook execution when operator expects dry-run
  for (const run of data.playbooksExecuted) {
    if (!run.dryRun) {
      alerts.push(createAlert('growth_agent', 'live_playbook_execution', 'info',
        `Playbook "${run.playbook}" executed in LIVE mode`,
        { playbook: run.playbook, actions: run.actions },
      ));
    }
  }

  // Fee change bounds
  for (const fc of data.feeChanges) {
    const changeBps = Math.abs(fc.newBps - fc.oldBps);
    if (changeBps > ga.fee_change_max_bps) {
      alerts.push(createAlert('growth_agent', 'fee_change_excessive', 'critical',
        `Fee change on ${fc.symbol}: ${fc.oldBps} → ${fc.newBps} bps (delta ${changeBps} exceeds max ${ga.fee_change_max_bps})`,
        { symbol: fc.symbol, oldBps: fc.oldBps, newBps: fc.newBps, changeBps, limit: ga.fee_change_max_bps },
      ));
    }
  }

  // Daily fee change count
  if (data.feeChanges.length > ga.max_fee_changes_per_day) {
    alerts.push(createAlert('growth_agent', 'fee_changes_per_day_exceeded', 'high',
      `${data.feeChanges.length} fee changes today — limit is ${ga.max_fee_changes_per_day}`,
      { count: data.feeChanges.length, limit: ga.max_fee_changes_per_day },
    ));
  }

  // Daily campaigns deployed
  if (data.campaignsDeployed > ga.max_campaigns_per_day) {
    alerts.push(createAlert('growth_agent', 'campaigns_per_day_exceeded', 'high',
      `${data.campaignsDeployed} campaigns deployed today — limit is ${ga.max_campaigns_per_day}`,
      { count: data.campaignsDeployed, limit: ga.max_campaigns_per_day },
    ));
  }

  // Watchdog enforcement when config says it should be off
  if (!ga.watchdog_enforcement_enabled) {
    const enforced = data.watchdogFlags.filter((f) => f.enforcementAction);
    if (enforced.length > 0) {
      alerts.push(createAlert('growth_agent', 'watchdog_enforcement_unexpected', 'critical',
        `Watchdog enforcement active but manifest says it should be disabled (${enforced.length} actions)`,
        { enforcedAccounts: enforced.map((f) => f.accountId) },
      ));
    }
  }

  // ESCALATE-tier watchdog flags always need attention
  const escalations = data.watchdogFlags.filter((f) => f.tier === 'ESCALATE');
  if (escalations.length > 0) {
    alerts.push(createAlert('growth_agent', 'watchdog_escalation', 'critical',
      `${escalations.length} account(s) flagged ESCALATE by watchdog — requires human review`,
      { accounts: escalations.map((f) => ({ id: f.accountId, detector: f.detector, score: f.riskScore })) },
    ));
  }

  // Builder tier floor
  const tierOrder = ['PUBLIC', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND'];
  const currentIdx = tierOrder.indexOf(data.builderTier);
  const floorIdx = tierOrder.indexOf(ga.builder_tier_floor);
  if (currentIdx >= 0 && floorIdx >= 0 && currentIdx < floorIdx) {
    alerts.push(createAlert('growth_agent', 'builder_tier_below_floor', 'warning',
      `Builder tier ${data.builderTier} is below configured floor ${ga.builder_tier_floor}`,
      { current: data.builderTier, floor: ga.builder_tier_floor },
    ));
  }

  // Audit log truncation
  if (data.previousAuditLogSize > 0 && data.auditLogSize < data.previousAuditLogSize) {
    alerts.push(createAlert('growth_agent', 'audit_log_truncated', 'critical',
      `Growth agent audit log shrunk from ${data.previousAuditLogSize} to ${data.auditLogSize} bytes`,
      { previousSize: data.previousAuditLogSize, currentSize: data.auditLogSize },
    ));
  }

  return alerts;
}

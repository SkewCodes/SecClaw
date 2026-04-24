import { randomUUID } from 'node:crypto';
import { createSecClawEvent } from '../../events/schema.js';
import type {
  GateSharedState,
  SecClawEvent,
  SignerPolicy,
  SignerImmutablePolicy,
  ModificationRequest,
} from '../../types.js';
import type { SignerHealthContext } from './context.js';

export class SignerModificationManager {
  private immutable: Readonly<SignerImmutablePolicy>;
  private signerPolicy: SignerPolicy;
  private effectiveValues: Map<string, number> = new Map();
  private modificationTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private onEvent: (event: SecClawEvent) => void;
  private agentId: string;
  private ctx: SignerHealthContext | null = null;

  constructor(
    immutablePolicy: SignerImmutablePolicy,
    signerPolicy: SignerPolicy,
    agentId: string,
    onEvent: (event: SecClawEvent) => void,
  ) {
    this.immutable = Object.freeze({ ...immutablePolicy });
    this.signerPolicy = signerPolicy;
    this.agentId = agentId;
    this.onEvent = onEvent;
    this.initEffectiveValues(signerPolicy);
  }

  setContext(ctx: SignerHealthContext): void {
    this.ctx = ctx;
  }

  private initEffectiveValues(policy: SignerPolicy): void {
    this.effectiveValues.set('rate_limits.per_minute', policy.rate_limits.per_minute);
    this.effectiveValues.set('rate_limits.per_hour', policy.rate_limits.per_hour);
    this.effectiveValues.set('rate_limits.per_day', policy.rate_limits.per_day);
    this.effectiveValues.set('cooldown_ms', policy.cooldown_ms);
    this.effectiveValues.set('cumulative_exposure.max_usd', policy.cumulative_exposure.max_usd);
    this.effectiveValues.set('gas.max_price_gwei', policy.gas.max_price_gwei);
    this.effectiveValues.set('gas.max_limit', policy.gas.max_limit);
  }

  getEffectiveValue(parameter: string): number | undefined {
    return this.effectiveValues.get(parameter);
  }

  getImmutable(): Readonly<SignerImmutablePolicy> {
    return this.immutable;
  }

  validateAgainstCeiling(parameter: string, value: number): { valid: boolean; ceiling?: number } {
    const ceilingMap: Record<string, number> = {
      'rate_limits.per_minute': this.immutable.rate_limits_ceiling.per_minute,
      'rate_limits.per_day': this.immutable.rate_limits_ceiling.per_day,
      'cooldown_ms': this.immutable.min_cooldown_ms,
      'cumulative_exposure.max_usd': this.immutable.cumulative_exposure_ceiling_usd,
      'gas.max_price_gwei': this.immutable.gas_ceiling_gwei,
      'gas.max_limit': this.immutable.gas_limit_ceiling,
    };

    const ceiling = ceilingMap[parameter];
    if (ceiling === undefined) return { valid: true };

    if (parameter === 'cooldown_ms') {
      return { valid: value >= ceiling, ceiling };
    }

    return { valid: value <= ceiling, ceiling };
  }

  requestModification(
    parameter: string,
    requestedValue: number,
    justification: string,
    requestedBy: 'agent' | 'operator',
    sharedState: GateSharedState,
  ): ModificationRequest {
    const request: ModificationRequest = {
      request_id: randomUUID(),
      tier: requestedBy === 'agent' ? 3 : 2,
      parameter,
      current_value: this.effectiveValues.get(parameter) ?? 0,
      requested_value: requestedValue,
      justification,
      requested_by: requestedBy,
      status: 'pending',
      requested_at: new Date().toISOString(),
    };

    const ceilingCheck = this.validateAgainstCeiling(parameter, requestedValue);
    if (!ceilingCheck.valid) {
      request.status = 'rejected';
      this.onEvent(createSecClawEvent({
        source: 'gate',
        agent_id: this.agentId,
        module: 'signer_health',
        action: 'block',
        severity: 'warning',
        check: 'modification_rejected',
        details: {
          expected: ceilingCheck.ceiling,
          actual: requestedValue,
          policy_rule: `signer.immutable (Tier 1 ceiling for ${parameter})`,
          message: `Modification rejected: ${parameter}=${requestedValue} exceeds Tier 1 ceiling ${ceilingCheck.ceiling}`,
        },
      }));
      return request;
    }

    sharedState.pendingModifications[request.request_id] = request;

    this.onEvent(createSecClawEvent({
      source: 'gate',
      agent_id: this.agentId,
      module: 'signer_health',
      action: 'alert',
      severity: 'info',
      check: 'modification_requested',
      details: {
        expected: request.current_value,
        actual: requestedValue,
        policy_rule: `signer.${parameter}`,
        message: `Modification requested: ${parameter} ${request.current_value} -> ${requestedValue} (${justification})`,
      },
    }));

    return request;
  }

  approveModification(
    requestId: string,
    approvedBy: string,
    sharedState: GateSharedState,
  ): boolean {
    const request = sharedState.pendingModifications[requestId];
    if (!request || request.status !== 'pending') return false;

    const currentValue = this.effectiveValues.get(request.parameter) ?? 0;
    const isLoosening = this.isLoosening(request.parameter, request.requested_value, currentValue);

    const alertCount = Object.keys(sharedState.activeCriticalAlerts).length;
    if (isLoosening && this.immutable.critical_alert_lock && alertCount > 0) {
      this.onEvent(createSecClawEvent({
        source: 'gate',
        agent_id: this.agentId,
        module: 'signer_health',
        action: 'block',
        severity: 'warning',
        check: 'modification_locked',
        details: {
          expected: 'no critical alerts',
          actual: `${alertCount} active critical alerts`,
          policy_rule: 'signer.immutable.critical_alert_lock',
          message: `Modification locked: cannot loosen ${request.parameter} during active critical alerts`,
        },
      }));
      return false;
    }

    request.approved_by = approvedBy;

    if (isLoosening) {
      const delay = this.getDelayForParameter(request.parameter);
      request.status = 'queued';
      const activatesAt = new Date(Date.now() + delay * 1000).toISOString();

      this.onEvent(createSecClawEvent({
        source: 'gate',
        agent_id: this.agentId,
        module: 'signer_health',
        action: 'alert',
        severity: 'info',
        check: 'modification_approved',
        details: {
          expected: request.current_value,
          actual: request.requested_value,
          policy_rule: `signer.${request.parameter}`,
          message: `Modification approved by ${approvedBy}, activates at ${activatesAt} (${delay}s delay)`,
        },
      }));

      const timer = setTimeout(() => {
        this.activateModification(requestId, sharedState);
      }, delay * 1000);
      this.modificationTimers.set(requestId, timer);
    } else {
      this.activateModification(requestId, sharedState);
    }

    return true;
  }

  cancelModification(requestId: string, sharedState: GateSharedState): boolean {
    const request = sharedState.pendingModifications[requestId]
      ?? sharedState.activeModifications[requestId];
    if (!request) return false;

    const wasActive = request.status === 'active';
    request.status = 'cancelled';

    const timer = this.modificationTimers.get(requestId);
    if (timer) {
      clearTimeout(timer);
      this.modificationTimers.delete(requestId);
    }

    if (wasActive && request.reverted_to !== undefined) {
      this.effectiveValues.set(request.parameter, request.reverted_to);
      this.propagateEffectiveValues(request.parameter);
    }

    delete sharedState.pendingModifications[requestId];
    delete sharedState.activeModifications[requestId];

    this.onEvent(createSecClawEvent({
      source: 'gate',
      agent_id: this.agentId,
      module: 'signer_health',
      action: 'alert',
      severity: 'info',
      check: 'modification_cancelled',
      details: {
        expected: request.requested_value,
        actual: this.effectiveValues.get(request.parameter),
        policy_rule: `signer.${request.parameter}`,
        message: `Modification cancelled: ${request.parameter} reverted to ${this.effectiveValues.get(request.parameter)}`,
      },
    }));

    return true;
  }

  revertModification(requestId: string, sharedState: GateSharedState): boolean {
    const request = sharedState.activeModifications[requestId];
    if (!request || request.status !== 'active') return false;

    if (request.reverted_to !== undefined) {
      this.effectiveValues.set(request.parameter, request.reverted_to);
      this.propagateEffectiveValues(request.parameter);
    }

    request.status = 'reverted';
    delete sharedState.activeModifications[requestId];

    this.onEvent(createSecClawEvent({
      source: 'gate',
      agent_id: this.agentId,
      module: 'signer_health',
      action: 'alert',
      severity: 'info',
      check: 'modification_reverted',
      details: {
        expected: request.requested_value,
        actual: request.reverted_to,
        policy_rule: `signer.${request.parameter}`,
        message: `Modification reverted: ${request.parameter} restored to ${request.reverted_to}`,
      },
    }));

    return true;
  }

  destroy(): void {
    for (const timer of this.modificationTimers.values()) {
      clearTimeout(timer);
    }
    this.modificationTimers.clear();
  }

  private activateModification(requestId: string, sharedState: GateSharedState): void {
    const request = sharedState.pendingModifications[requestId];
    if (!request) return;

    const previousValue = this.effectiveValues.get(request.parameter);
    request.reverted_to = previousValue;
    request.status = 'active';
    request.activated_at = new Date().toISOString();

    this.effectiveValues.set(request.parameter, request.requested_value);
    delete sharedState.pendingModifications[requestId];
    sharedState.activeModifications[requestId] = request;
    this.modificationTimers.delete(requestId);

    this.propagateEffectiveValues(request.parameter);

    this.onEvent(createSecClawEvent({
      source: 'gate',
      agent_id: this.agentId,
      module: 'signer_health',
      action: 'alert',
      severity: 'info',
      check: 'modification_activated',
      details: {
        expected: previousValue,
        actual: request.requested_value,
        policy_rule: `signer.${request.parameter}`,
        message: `Modification activated: ${request.parameter} changed from ${previousValue} to ${request.requested_value}`,
      },
    }));
  }

  private isLoosening(parameter: string, newValue: number, currentValue: number): boolean {
    if (parameter === 'cooldown_ms') {
      return newValue < currentValue;
    }
    return newValue > currentValue;
  }

  private getDelayForParameter(parameter: string): number {
    const globalDelay = this.immutable.modification_delay_sec;

    if (parameter === 'cumulative_exposure.max_usd' || parameter.startsWith('cumulative_exposure.')) {
      const override = this.signerPolicy.cumulative_exposure.delay_override_sec;
      if (override !== undefined && override > globalDelay) return override;
    }

    return globalDelay;
  }

  private propagateEffectiveValues(changedParameter: string): void {
    if (!this.ctx) return;

    if (changedParameter.startsWith('rate_limits.')) {
      const pm = this.effectiveValues.get('rate_limits.per_minute');
      const ph = this.effectiveValues.get('rate_limits.per_hour');
      const pd = this.effectiveValues.get('rate_limits.per_day');
      if (pm !== undefined && ph !== undefined && pd !== undefined) {
        this.ctx.rateLimiter.updateLimits(pm, ph, pd);
      }
    }

    if (changedParameter === 'cumulative_exposure.max_usd') {
      const maxUsd = this.effectiveValues.get('cumulative_exposure.max_usd');
      if (maxUsd !== undefined) {
        this.ctx.exposureTracker.updateLimits(maxUsd);
      }
    }
  }
}

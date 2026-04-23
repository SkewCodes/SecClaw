import { createAlert } from '../../alerts/bus.js';
import type { Alert, SystemSnapshot } from '../../types.js';

/**
 * Correlates OtterClaw bridge events for skill CLI bypasses and
 * capability violations. Cross-references with filesystem signals
 * to detect credential theft during blocked CLI invocations.
 */
export function checkSkillCliBypass(
  snapshot: SystemSnapshot,
): Alert[] {
  const alerts: Alert[] = [];
  const events = snapshot.otterclawEvents;
  if (!events || events.length === 0) return alerts;

  const blocked = events.filter((e) => e.type === 'skill.cli.blocked');
  const violations = events.filter((e) => e.type === 'skill.capability.violation');

  for (const ev of blocked) {
    alerts.push(createAlert(
      'otterclaw',
      'skill_cli_blocked',
      'high',
      `Skill CLI invocation blocked: skill=${ev.skill_id}`,
      { skill_id: ev.skill_id, event_id: ev.id, ...ev.details },
    ));
  }

  for (const ev of violations) {
    alerts.push(createAlert(
      'otterclaw',
      'skill_capability_violation',
      'critical',
      `Skill capability violation: skill=${ev.skill_id}`,
      { skill_id: ev.skill_id, event_id: ev.id, ...ev.details },
    ));
  }

  if (blocked.length > 0) {
    const hasCredentialAccess = snapshot.filesystem?.ok
      && snapshot.filesystem.data
      && snapshot.filesystem.data.sensitivePathAccesses.some((a) =>
        a.path.includes('.ssh') ||
        a.path.includes('.aws') ||
        a.path.includes('.gnupg') ||
        a.path.includes('.env'),
      );

    if (hasCredentialAccess) {
      alerts.push(createAlert(
        'otterclaw',
        'skill_cli_credential_escalation',
        'critical',
        `Skill CLI block correlated with credential path access: ${blocked.length} blocked invocation(s) + sensitive path access in same window`,
        {
          blocked_skills: blocked.map((e) => e.skill_id),
          blocked_count: blocked.length,
        },
      ));
    }
  }

  return alerts;
}

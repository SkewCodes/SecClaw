import { createAlert } from '../alerts/bus.js';
import type { Alert, SkillFileInfo } from '../types.js';
import { readFileSync } from 'node:fs';

interface ScanFinding {
  pattern: string;
  line: number;
  match: string;
}

const INJECTION_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'ignore_instructions', regex: /ignore\s+(previous|prior|all)\s+instructions/i },
  { name: 'role_assumption', regex: /you\s+are\s+now/i },
  { name: 'system_prompt', regex: /system\s+prompt/i },
  { name: 'act_as', regex: /act\s+as/i },
  { name: 'override', regex: /\boverride\b/i },
  { name: 'admin_mode', regex: /admin\s+mode/i },
  { name: 'execute_following', regex: /execute\s+the\s+following/i },
];

const CREDENTIAL_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'hex_private_key', regex: /0x[a-fA-F0-9]{64}/ },
  { name: 'env_var_ref', regex: /\$\{?\w*(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)\w*\}?/i },
  { name: 'process_env', regex: /process\.env\b/ },
  { name: 'dollar_env', regex: /\$ENV\b/ },
];

const SHELL_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'backtick_exec', regex: /`[^`]*(?:rm|curl|wget|nc|bash|sh|eval|exec)[^`]*`/ },
  { name: 'dollar_paren_exec', regex: /\$\([^)]*(?:rm|curl|wget|nc|bash|sh|eval|exec)[^)]*\)/ },
  { name: 'eval_call', regex: /\beval\s*\(/ },
];

const BASE64_PATTERN = /[A-Za-z0-9+/]{100,}={0,2}/;

export function scanSkillContent(content: string, urlAllowlist: string[]): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const lines = content.split('\n');

  // Skip code blocks for injection patterns (they're examples, not instructions)
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
    }

    // Injection patterns — scan outside code blocks
    if (!inCodeBlock) {
      for (const pat of INJECTION_PATTERNS) {
        if (pat.regex.test(line)) {
          findings.push({ pattern: `injection:${pat.name}`, line: lineNum, match: line.trim() });
        }
      }
    }

    // Credential patterns — scan everywhere
    for (const pat of CREDENTIAL_PATTERNS) {
      if (pat.regex.test(line)) {
        findings.push({ pattern: `credential:${pat.name}`, line: lineNum, match: line.trim() });
      }
    }

    // Shell patterns — scan everywhere
    for (const pat of SHELL_PATTERNS) {
      if (pat.regex.test(line)) {
        findings.push({ pattern: `shell:${pat.name}`, line: lineNum, match: line.trim() });
      }
    }

    // Base64 blocks
    if (BASE64_PATTERN.test(line)) {
      findings.push({ pattern: 'encoded:base64_block', line: lineNum, match: line.trim().slice(0, 80) + '...' });
    }

    // URL allowlist check
    const urlMatches = line.match(/https?:\/\/[^\s)>"']+/g);
    if (urlMatches) {
      for (const url of urlMatches) {
        const allowed = urlAllowlist.some((domain) => url.includes(domain));
        if (!allowed) {
          findings.push({ pattern: 'url:not_in_allowlist', line: lineNum, match: url });
        }
      }
    }
  }

  return findings;
}

const scanCache = new Map<string, ScanFinding[]>();

export function scanSkills(skills: SkillFileInfo[], urlAllowlist: string[]): Alert[] {
  const alerts: Alert[] = [];

  for (const skill of skills) {
    let findings = scanCache.get(skill.hash);

    if (!findings) {
      let content: string;
      try {
        content = readFileSync(skill.path, 'utf-8');
      } catch {
        continue;
      }
      findings = scanSkillContent(content, urlAllowlist);
      scanCache.set(skill.hash, findings);
    }

    for (const finding of findings) {
      const severity = finding.pattern.startsWith('injection:') ||
                       finding.pattern.startsWith('credential:')
        ? 'critical' as const
        : 'high' as const;

      alerts.push(createAlert('otterclaw', 'skill_content_scan', severity,
        `${skill.relativePath}:${finding.line} — ${finding.pattern}: ${finding.match.slice(0, 100)}`,
        { path: skill.relativePath, ...finding },
      ));
    }
  }

  return alerts;
}

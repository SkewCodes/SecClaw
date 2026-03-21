import { createAlert } from '../alerts/bus.js';
import type { Alert, SkillFileInfo } from '../types.js';

interface SkillFrontmatter {
  name?: string;
  description?: string;
  version?: string;
  author?: string;
  tags?: string[];
  requires?: {
    bins?: string[];
    install?: Array<{
      id?: string;
      kind?: string;
      command?: string;
      bins?: string[];
      label?: string;
    }>;
  };
  payment?: {
    scheme?: string;
    price?: string;
    currency?: string;
    per?: string;
    recipient?: string;
  };
}

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const TAG_RE = /^[a-z0-9-]+$/;

export function validateSkillFrontmatter(
  frontmatter: Record<string, unknown>,
  relativePath: string,
): string[] {
  const errors: string[] = [];
  const fm = frontmatter as SkillFrontmatter;

  // Required fields
  if (!fm.name || typeof fm.name !== 'string') {
    errors.push('missing or invalid "name"');
  } else if (!NAME_RE.test(fm.name)) {
    errors.push(`"name" must be lowercase hyphenated: ${fm.name}`);
  }

  if (!fm.description || typeof fm.description !== 'string') {
    errors.push('missing or invalid "description"');
  } else if (fm.description.length < 10) {
    errors.push('"description" must be at least 10 characters');
  }

  if (!fm.version || typeof fm.version !== 'string') {
    errors.push('missing or invalid "version"');
  } else if (!VERSION_RE.test(fm.version)) {
    errors.push(`"version" must be semver (x.y.z): ${fm.version}`);
  }

  if (!fm.author || typeof fm.author !== 'string') {
    errors.push('missing or invalid "author"');
  }

  if (!Array.isArray(fm.tags) || fm.tags.length < 1) {
    errors.push('"tags" must be a non-empty array');
  } else {
    for (const tag of fm.tags) {
      if (typeof tag !== 'string' || !TAG_RE.test(tag)) {
        errors.push(`invalid tag: ${tag}`);
      }
    }
  }

  // Requires
  if (!fm.requires || typeof fm.requires !== 'object') {
    errors.push('missing "requires" object');
  } else {
    if (!Array.isArray(fm.requires.bins) || fm.requires.bins.length < 1) {
      errors.push('"requires.bins" must be a non-empty array');
    }
    if (!Array.isArray(fm.requires.install) || fm.requires.install.length < 1) {
      errors.push('"requires.install" must be a non-empty array');
    } else {
      for (const step of fm.requires.install) {
        if (!step.id || !step.kind || !step.command || !step.label) {
          errors.push(`install step missing required fields: ${JSON.stringify(step)}`);
        }
      }
    }
  }

  // Payment (optional)
  if (fm.payment) {
    if (fm.payment.scheme !== 'orderly-ledger') {
      errors.push(`payment.scheme must be "orderly-ledger": ${fm.payment.scheme}`);
    }
    if (fm.payment.currency !== 'USDC') {
      errors.push(`payment.currency must be "USDC": ${fm.payment.currency}`);
    }
  }

  return errors;
}

export function validateAllSkills(skills: SkillFileInfo[]): Alert[] {
  const alerts: Alert[] = [];

  for (const skill of skills) {
    if (!skill.frontmatter) continue; // already flagged by assertion

    const errors = validateSkillFrontmatter(skill.frontmatter, skill.relativePath);
    for (const error of errors) {
      alerts.push(createAlert('otterclaw', 'skill_schema_violation', 'high',
        `${skill.relativePath}: ${error}`,
        { path: skill.relativePath, error },
      ));
    }
  }

  return alerts;
}

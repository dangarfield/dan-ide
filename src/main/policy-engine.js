/**
 * Policy engine for constraining agent behavior.
 *
 * Provides default safety policies plus project-specific custom policies
 * loaded from .dan-ide/policies.json. Generates prompt text that can be
 * injected into agent system prompts to enforce behavioral constraints.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_POLICIES = [
  {
    id: 'no_delete_git',
    description: 'Never delete .git directory or force push',
    severity: 'critical',
    patterns: ['rm.*\\.git', 'force push', 'push.*--force', 'push.*-f'],
  },
  {
    id: 'no_secrets',
    description: 'Never commit .env files or expose API keys',
    severity: 'critical',
    patterns: ['git add.*\\.env', 'commit.*\\.env', 'API_KEY', 'SECRET_KEY', 'PRIVATE_KEY'],
  },
  {
    id: 'no_production',
    description: 'Never modify production configurations without explicit approval',
    severity: 'high',
    patterns: ['production', 'prod\\.', 'deploy.*prod'],
  },
  {
    id: 'test_before_commit',
    description: 'Always run tests before committing changes',
    severity: 'medium',
    patterns: [],
  },
];

class PolicyEngine {
  constructor() {
    this._cache = new Map(); // projectPath -> { policies, mtime }
  }

  /**
   * Get the path to a project's policies.json file.
   */
  _policiesPath(projectPath) {
    return path.join(projectPath, '.dan-ide', 'policies.json');
  }

  /**
   * Load custom policies from the project's .dan-ide/policies.json.
   * Returns an empty array if the file doesn't exist or is invalid.
   */
  _loadCustomPolicies(projectPath) {
    const filePath = this._policiesPath(projectPath);
    try {
      const stat = fs.statSync(filePath);
      const cached = this._cache.get(projectPath);
      if (cached && cached.mtime >= stat.mtimeMs) {
        return cached.policies;
      }
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const policies = Array.isArray(data.rules) ? data.rules : [];
      this._cache.set(projectPath, { policies, mtime: stat.mtimeMs });
      return policies;
    } catch {
      return [];
    }
  }

  /**
   * Returns merged default + custom policies for a project.
   */
  getPolicies(projectPath) {
    const custom = this._loadCustomPolicies(projectPath);
    // Merge: custom policies can override defaults by matching id
    const merged = [...DEFAULT_POLICIES];
    for (const policy of custom) {
      const existingIdx = merged.findIndex((p) => p.id === policy.id);
      if (existingIdx >= 0) {
        merged[existingIdx] = { ...merged[existingIdx], ...policy };
      } else {
        merged.push(policy);
      }
    }
    return merged;
  }

  /**
   * Generate a text block suitable for inclusion in agent system prompts.
   */
  generatePolicyPrompt(projectPath) {
    const policies = this.getPolicies(projectPath);
    const lines = [
      '## Policy Constraints (MANDATORY)',
      '',
      'The following policies MUST be followed at all times. Violations of critical policies are strictly forbidden.',
      '',
    ];

    for (const policy of policies) {
      const severity = (policy.severity || 'medium').toUpperCase();
      lines.push(`- [${severity}] ${policy.description}`);
    }

    lines.push('');
    lines.push('If you are unsure whether an action violates a policy, ask for clarification before proceeding.');

    return lines.join('\n');
  }

  /**
   * Basic validation: checks if an action description matches any policy violation patterns.
   * Returns { allowed: true/false, violations: [] }
   */
  validateAction(action, projectPath) {
    if (!action || typeof action !== 'string') {
      return { allowed: true, violations: [] };
    }

    const policies = this.getPolicies(projectPath);
    const violations = [];

    for (const policy of policies) {
      const patterns = policy.patterns || [];
      for (const pattern of patterns) {
        try {
          const regex = new RegExp(pattern, 'i');
          if (regex.test(action)) {
            violations.push({
              policyId: policy.id,
              description: policy.description,
              severity: policy.severity || 'medium',
              matchedPattern: pattern,
            });
            break; // One match per policy is enough
          }
        } catch {
          // Invalid regex pattern, skip
        }
      }
    }

    return {
      allowed: violations.length === 0,
      violations,
    };
  }

  /**
   * Write custom policies to a project's .dan-ide/policies.json.
   */
  updatePolicies(projectPath, policies) {
    const filePath = this._policiesPath(projectPath);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const data = { rules: Array.isArray(policies) ? policies : [] };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    // Invalidate cache
    this._cache.delete(projectPath);
    return data;
  }
}

module.exports = { PolicyEngine };

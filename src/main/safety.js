/**
 * Safety layer for running CLI agents with full permissions.
 *
 * Strategy:
 * 1. Claude runs with --dangerously-skip-permissions but is told (via system prompt)
 *    to only operate within the project directory.
 * 2. The shared memory file includes safety rules that agents should follow.
 * 3. Session logs are captured so you can audit what happened.
 * 4. Future: filesystem watcher that alerts on writes outside project dir.
 *
 * This is "convention-based safety" — the agents are instructed to stay in bounds.
 * For hard sandboxing, you'd need containerization (Docker) which is a future enhancement.
 */

const fs = require('fs');
const path = require('path');
const { PolicyEngine } = require('./policy-engine');

function initProjectSafety(projectPath) {
  const memoryDir = path.join(projectPath, '.dan-ide', 'memory');
  const safetyFile = path.join(memoryDir, 'SAFETY_RULES.md');

  // Always regenerate to include current policy rules
  const policyEngine = new PolicyEngine();
  const policyBlock = policyEngine.generatePolicyPrompt(projectPath);

  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(safetyFile, `# Safety Rules for AI Agents

These rules apply to all AI agent sessions in this project.

## Boundaries
- Only modify files within this project directory: ${projectPath}
- Do NOT access, read, or modify files outside this project
- Do NOT make network requests to unfamiliar endpoints
- Do NOT install global packages or modify system configuration
- Do NOT delete the .dan-ide/ directory or its contents

## Shared Memory Protocol
- Read SHARED.md before starting any task
- Update SHARED.md when you complete work or learn something important
- Do not overwrite other agents' notes — append or update sections
- Use clear headings and timestamps for your entries

## Git Safety
- Do NOT force push
- Do NOT push to main/master without explicit instruction
- Create feature branches for new work
- Commit frequently with clear messages

${policyBlock}
`);

  return safetyFile;
}

module.exports = { initProjectSafety };

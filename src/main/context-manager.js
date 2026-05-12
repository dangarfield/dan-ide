/**
 * Cross-agent shared context manager.
 *
 * Maintains a unified context file that ALL agent types can access.
 * Ensures Claude, Kiro, Aider, and shell agents all share the same
 * project knowledge via their native configuration mechanisms.
 */

const fs = require('fs');
const path = require('path');
const { PolicyEngine } = require('./policy-engine');
class ContextManager {
  constructor() {
    this._watchers = new Map(); // projectPath -> FSWatcher
    this._policyEngine = new PolicyEngine();
  }

  /**
   * Initialize shared context infrastructure for a project.
   * Called when a project is added or when an agent starts.
   */
  initProject(projectPath) {
    const memoryDir = path.join(projectPath, '.dan-ide', 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });

    // Ensure SHARED.md exists
    const sharedPath = path.join(memoryDir, 'SHARED.md');
    if (!fs.existsSync(sharedPath)) {
      fs.writeFileSync(sharedPath, `# Shared Project Memory

This file is shared across all AI agent sessions in this project.
Agents should read this before starting work and update it with important findings.

## Project Notes

## Active Tasks

## Decisions Made
`);
    }

    // Create/update CLAUDE.md at project root (Claude Code reads this automatically)
    this._updateClaudeMd(projectPath);

    // Create/update .kiro/rules for Kiro CLI
    this._updateKiroRules(projectPath);

    // Create/update .aider.conf.yml for Aider
    this._updateAiderConf(projectPath);

    // Build the unified CONTEXT.md
    this.rebuildContext(projectPath);
  }

  /**
   * Rebuild the unified CONTEXT.md from all memory sources.
   * This is the file all agents should read for current state.
   */
  rebuildContext(projectPath, activeSessions = []) {
    const memoryDir = path.join(projectPath, '.dan-ide', 'memory');
    const contextPath = path.join(memoryDir, 'CONTEXT.md');

    let shared = '';
    const sharedPath = path.join(memoryDir, 'SHARED.md');
    if (fs.existsSync(sharedPath)) {
      shared = fs.readFileSync(sharedPath, 'utf8');
    }

    let messages = '';
    const messagesPath = path.join(memoryDir, 'MESSAGES.md');
    if (fs.existsSync(messagesPath)) {
      messages = fs.readFileSync(messagesPath, 'utf8');
    }

    // Build agent roster
    let agentList = '';
    if (activeSessions.length > 0) {
      agentList = activeSessions.map((s) =>
        `- **${s.name}** (${s.cliKey || s.cli}) — ${s.status}`
      ).join('\n');
    }

    // Build file structure summary
    const structureSummary = this._buildStructureSummary(projectPath);

    // Detect key files
    const keyFiles = this._detectKeyFiles(projectPath);

    const context = `# Project Context (Auto-generated)

> This file is automatically maintained by Dan IDE.
> All agents in this project share this context.
> Last updated: ${new Date().toISOString()}

## Active Agents
${agentList || '_No agents currently running_'}

## Project Structure
${structureSummary}

## Key Files
${keyFiles}

## How to Collaborate
- Read this file at the start of every task
- Write findings/decisions to \`.dan-ide/memory/SHARED.md\`
- Post messages for other agents in \`.dan-ide/memory/MESSAGES.md\`
- Do NOT edit this CONTEXT.md directly — it is auto-generated

## Shared Memory
${shared}

${messages ? `## Inter-Agent Messages\n${messages}` : ''}
`;

    fs.writeFileSync(contextPath, context);
    return contextPath;
  }

  /**
   * Post a message visible to all agents.
   */
  postMessage(projectPath, fromAgent, message) {
    const memoryDir = path.join(projectPath, '.dan-ide', 'memory');
    const messagesPath = path.join(memoryDir, 'MESSAGES.md');

    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const entry = `\n### [${timestamp}] ${fromAgent}\n${message}\n`;

    fs.appendFileSync(messagesPath, entry);
    this.rebuildContext(projectPath);
  }

  /**
   * Create/update CLAUDE.md at project root.
   * Claude Code automatically reads CLAUDE.md files.
   */
  _updateClaudeMd(projectPath) {
    const claudeMdPath = path.join(projectPath, 'CLAUDE.md');
    const danIdeClaudeMd = path.join(projectPath, '.dan-ide', 'CLAUDE.md');
    const memoryDir = path.join(projectPath, '.dan-ide', 'memory');

    // .dan-ide/CLAUDE.md — instructions for Claude when launched from Dan IDE
    const policyBlock = this._policyEngine.generatePolicyPrompt(projectPath);
    const content = `# Dan IDE Agent Instructions

You are running inside Dan IDE, a multi-agent development environment.
Multiple AI agents may be working on this project simultaneously.

## CRITICAL: Shared Context Protocol

Before starting ANY task:
1. Read \`.dan-ide/memory/CONTEXT.md\` for full project state and active agents
2. Read \`.dan-ide/memory/SHARED.md\` for project knowledge

After completing work or learning something important:
1. Update \`.dan-ide/memory/SHARED.md\` with your findings
   - Use clear section headings
   - Prefix entries with a timestamp
   - Do NOT overwrite other agents' notes — append or update sections
2. If you need to communicate with other agents, append to \`.dan-ide/memory/MESSAGES.md\`:
   \`\`\`
   ### [YYYY-MM-DD HH:MM:SS] YourAgentName
   Your message here
   \`\`\`

## Boundaries
- Only modify files within: ${projectPath}
- Do NOT force push or push to main without explicit instruction
- Do NOT delete .dan-ide/ directory contents
- Create feature branches for new work

${policyBlock}

## Memory Location
Shared memory directory: ${memoryDir}
`;

    fs.writeFileSync(danIdeClaudeMd, content);

    // Only create root CLAUDE.md if it doesn't exist (don't overwrite user's own CLAUDE.md)
    if (!fs.existsSync(claudeMdPath)) {
      fs.writeFileSync(claudeMdPath, `# Project Instructions

See \`.dan-ide/CLAUDE.md\` for Dan IDE multi-agent coordination instructions.
`);
    }
  }

  /**
   * Create/update .kiro/rules for Kiro CLI.
   * Kiro reads rule files from .kiro/rules/ directory.
   */
  _updateKiroRules(projectPath) {
    const kiroDir = path.join(projectPath, '.kiro', 'rules');
    fs.mkdirSync(kiroDir, { recursive: true });

    const memoryDir = path.join(projectPath, '.dan-ide', 'memory');
    const rulePath = path.join(kiroDir, 'dan-ide-context.md');

    const content = `---
trigger: always
---

# Dan IDE Multi-Agent Context

You are running inside Dan IDE, a multi-agent development environment.
Multiple AI agents may be working on this project simultaneously.

## Shared Context Protocol

Before starting ANY task:
1. Read the file at \`${memoryDir}/CONTEXT.md\` for full project state
2. Read the file at \`${memoryDir}/SHARED.md\` for project knowledge

After completing work:
1. Update \`${memoryDir}/SHARED.md\` with your findings
2. To communicate with other agents, append to \`${memoryDir}/MESSAGES.md\`

## Boundaries
- Only modify files within this project directory
- Do NOT force push or push to main without instruction
- Create feature branches for new work
`;

    fs.writeFileSync(rulePath, content);
  }

  /**
   * Create/update .aider.conf.yml for Aider.
   * Aider reads this config file for default settings.
   */
  _updateAiderConf(projectPath) {
    const memoryDir = path.join(projectPath, '.dan-ide', 'memory');
    const confPath = path.join(projectPath, '.aider.conf.yml');

    // Only create if it doesn't exist — don't overwrite user's aider config
    if (!fs.existsSync(confPath)) {
      const content = `# Aider configuration (created by Dan IDE)
read:
  - ${memoryDir}/CONTEXT.md
  - ${memoryDir}/SHARED.md
`;
      fs.writeFileSync(confPath, content);
    }
  }

  /**
   * Watch memory directory for changes and rebuild context.
   */
  watchProject(projectPath, activeSessions) {
    if (this._watchers.has(projectPath)) return;

    const memoryDir = path.join(projectPath, '.dan-ide', 'memory');
    if (!fs.existsSync(memoryDir)) return;

    let debounce = null;
    try {
      const watcher = fs.watch(memoryDir, { recursive: false }, (event, filename) => {
        // Don't react to CONTEXT.md changes (we write it)
        if (filename === 'CONTEXT.md') return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          this.rebuildContext(projectPath, activeSessions);
        }, 1000);
      });
      this._watchers.set(projectPath, watcher);
    } catch (e) {
      // fs.watch can fail on some systems; non-critical
    }
  }

  /**
   * Stop watching a project.
   */
  unwatchProject(projectPath) {
    const watcher = this._watchers.get(projectPath);
    if (watcher) {
      watcher.close();
      this._watchers.delete(projectPath);
    }
  }

  /**
   * Stop all watchers.
   */
  stopAll() {
    for (const watcher of this._watchers.values()) {
      watcher.close();
    }
    this._watchers.clear();
  }


  /**
   * Build a summary of the project's directory structure.
   * Shows top-level directories with file counts.
   */
  _buildStructureSummary(projectPath) {
    const ignoredDirs = new Set([
      'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
      '__pycache__', '.cache', 'coverage', 'venv', '.venv', '.dan-ide',
    ]);

    let entries;
    try {
      entries = fs.readdirSync(projectPath, { withFileTypes: true });
    } catch {
      return '_Unable to read project directory_';
    }

    const dirs = [];
    let rootFiles = 0;

    for (const entry of entries) {
      if (entry.name.startsWith('.') || ignoredDirs.has(entry.name)) continue;

      if (entry.isDirectory()) {
        const count = this._countFiles(path.join(projectPath, entry.name), ignoredDirs);
        dirs.push(`- \`${entry.name}/\` (${count} files)`);
      } else {
        rootFiles++;
      }
    }

    if (rootFiles > 0) {
      dirs.unshift(`- \`./\` (${rootFiles} root files)`);
    }

    return dirs.length > 0 ? dirs.join('\n') : '_Empty project_';
  }

  /**
   * Count files recursively in a directory.
   */
  _countFiles(dirPath, ignoredDirs, depth = 0) {
    if (depth > 5) return 0;
    let count = 0;
    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (ignoredDirs.has(entry.name)) continue;
      if (entry.isDirectory()) {
        count += this._countFiles(path.join(dirPath, entry.name), ignoredDirs, depth + 1);
      } else {
        count++;
      }
    }
    return count;
  }

  /**
   * Detect key project files (package.json, README, main entry points).
   */
  _detectKeyFiles(projectPath) {
    const keyFileNames = [
      'package.json', 'README.md', 'readme.md', 'README',
      'tsconfig.json', 'pyproject.toml', 'Cargo.toml',
      'Makefile', 'Dockerfile', 'docker-compose.yml',
      '.env.example', 'main.js', 'index.js', 'index.ts',
      'app.js', 'app.ts', 'src/index.js', 'src/index.ts',
      'src/main.js', 'src/main.ts', 'src/app.js', 'src/app.ts',
    ];

    const found = [];
    for (const name of keyFileNames) {
      const fullPath = path.join(projectPath, name);
      if (fs.existsSync(fullPath)) {
        found.push(`- \`${name}\``);
      }
    }

    // Try to detect main entry from package.json
    const pkgPath = path.join(projectPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.main && !found.includes(`- \`${pkg.main}\``)) {
          found.push(`- \`${pkg.main}\` (package main)`);
        }
      } catch { /* ignore parse errors */ }
    }

    return found.length > 0 ? found.join('\n') : '_No key files detected_';
  }
}

module.exports = { ContextManager };

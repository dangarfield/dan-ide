const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { PolicyEngine } = require('./policy-engine');

const GLOBAL_STATE_DIR = path.join(os.homedir(), '.dan-ide');
const SESSIONS_STATE_FILE = path.join(GLOBAL_STATE_DIR, 'sessions.json');

class Session {
  constructor({ id, name, projectId, projectPath, cli, cliKey, args, env, historyFile, claudeSessionId }) {
    this.id = id;
    this.name = name;
    this.projectId = projectId;
    this.projectPath = projectPath;
    this.cli = cli;
    this.cliKey = cliKey || cli; // original key like 'claude', 'kiro', 'aider'
    this.args = args || [];
    this.env = env || {};
    this.status = 'starting';
    this.historyFile = historyFile;
    this.claudeSessionId = claudeSessionId;
    this._dataCallbacks = [];
    this._exitCallbacks = [];
    this._historyStream = null;
    this._spawn();
  }

  _spawn() {
    const shell = this.cli;
    const args = this.args;

    // Ensure workspace dirs exist in global state
    const { workspaceMemoryDir, workspaceSessionsDir } = require('./paths');
    if (this.projectId) {
      fs.mkdirSync(workspaceMemoryDir(this.projectId), { recursive: true });
      fs.mkdirSync(workspaceSessionsDir(this.projectId), { recursive: true });
    }

    // Ensure .dan-ide dir exists in project (for agent rules)
    const danIdeDir = path.join(this.projectPath, '.dan-ide');
    fs.mkdirSync(danIdeDir, { recursive: true });

    const memDir = this.projectId ? workspaceMemoryDir(this.projectId) : danIdeDir;

    const env = {
      ...process.env,
      ...this.env,
      DAN_IDE_SESSION_ID: this.id,
      DAN_IDE_PROJECT_PATH: this.projectPath,
      DAN_IDE_MEMORY_PATH: memDir,
    };
    // Remove CLAUDECODE env var so Claude Code doesn't think it's nested
    delete env.CLAUDECODE;

    // Open history file for appending
    if (this.historyFile) {
      fs.mkdirSync(path.dirname(this.historyFile), { recursive: true });
      this._historyStream = fs.createWriteStream(this.historyFile, { flags: 'a' });
    }

    this.pty = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: this.projectPath,
      env,
    });

    this.status = 'running';
    this._trustAccepted = false;
    this._outputBuffer = '';

    this.pty.onData((data) => {
      // Auto-accept trust/permission dialogs
      if (!this._trustAccepted && (this.cliKey === 'claude' || this.cliKey === 'kiro')) {
        this._outputBuffer += data;
        // Strip ANSI/xterm escape sequences, replace cursor moves with space
        const stripped = this._outputBuffer
          .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ' ')
          .replace(/\[\d+[A-Z]/g, ' ');

        if (this.cliKey === 'claude' &&
            (stripped.includes('trust this folder') || stripped.includes('Trust this folder'))) {
          this._trustAccepted = true;
          this._outputBuffer = '';
          setTimeout(() => {
            if (this.pty && this.status === 'running') {
              this.pty.write('\r');
            }
          }, 500);
        } else if (this.cliKey === 'kiro' &&
            (stripped.includes('Yes, I accept') || stripped.includes('accept responsibility'))) {
          this._trustAccepted = true;
          this._outputBuffer = '';
          // Move down to "Yes, and don't ask again" then press Enter
          setTimeout(() => {
            if (this.pty && this.status === 'running') {
              this.pty.write('\x1b[B'); // down arrow
              setTimeout(() => {
                if (this.pty && this.status === 'running') {
                  this.pty.write('\r');
                }
              }, 200);
            }
          }, 500);
        }

        // Don't buffer indefinitely
        if (this._outputBuffer.length > 5000) {
          this._trustAccepted = true;
          this._outputBuffer = '';
        }
      }

      // Write to history file
      if (this._historyStream) {
        this._historyStream.write(data);
      }
      this._dataCallbacks.forEach((cb) => cb(data));
    });

    this.pty.onExit(({ exitCode }) => {
      this.status = 'stopped';
      if (this._historyStream) {
        this._historyStream.end();
        this._historyStream = null;
      }
      this._exitCallbacks.forEach((cb) => cb(exitCode));
    });
  }

  onData(cb) { this._dataCallbacks.push(cb); }
  onExit(cb) { this._exitCallbacks.push(cb); }

  write(data) {
    if (this.pty && this.status === 'running') {
      this.pty.write(data);
    }
  }

  resize(cols, rows) {
    if (this.pty && this.status === 'running') {
      this.pty.resize(cols, rows);
    }
  }

  stop() {
    if (this.pty && this.status === 'running') {
      this.pty.kill();
      this.status = 'stopped';
    }
    if (this._historyStream) {
      this._historyStream.end();
      this._historyStream = null;
    }
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      projectId: this.projectId,
      projectPath: this.projectPath,
      cli: this.cli,
      cliKey: this.cliKey,
      status: this.status,
      historyFile: this.historyFile,
      claudeSessionId: this.claudeSessionId,
    };
  }
}

class SessionManager {
  constructor() {
    this.sessions = new Map();
    this._policyEngine = new PolicyEngine();
    fs.mkdirSync(GLOBAL_STATE_DIR, { recursive: true });
  }

  create({ name, projectId, projectPath, cli, role, resume, claudeSessionId }) {
    const id = crypto.randomUUID();
    // Determine the canonical cliKey (handle case where cli is already a resolved path)
    const cliKey = this._toCliKey(cli);
    // For Claude, assign a stable session ID so we can resume the correct conversation
    let assignedClaudeSessionId = claudeSessionId;
    if (cliKey === 'claude' && !assignedClaudeSessionId) {
      assignedClaudeSessionId = crypto.randomUUID();
    }
    const { args, env } = this._buildCliArgs(cliKey, projectPath, projectId, role, resume, assignedClaudeSessionId);
    // Ensure shared memory files exist before spawning
    this._ensureSharedMemoryFiles(projectPath, projectId);
    const { workspaceSessionsDir } = require('./paths');
    const sessDir = projectId ? workspaceSessionsDir(projectId) : path.join(projectPath, '.dan-ide', 'sessions');
    fs.mkdirSync(sessDir, { recursive: true });
    const historyFile = path.join(sessDir, `${id}.log`);

    const session = new Session({
      id,
      name: name || `${cliKey}-${id.slice(0, 6)}`,
      projectId,
      projectPath,
      cli: this._resolveCliPath(cliKey),
      cliKey,
      args,
      env,
      historyFile,
      claudeSessionId: assignedClaudeSessionId,
    });

    this.sessions.set(id, session);
    this._saveState();
    return session;
  }

  // Convert a possibly-resolved path back to a canonical key
  _toCliKey(cli) {
    const knownKeys = ['claude', 'kiro', 'aider', 'cursor', 'shell'];
    if (knownKeys.includes(cli)) return cli;
    // If it's a resolved path like '/usr/local/bin/claude', extract the basename
    const basename = path.basename(cli);
    // Map kiro-cli back to kiro
    if (basename === 'kiro-cli') return 'kiro';
    if (knownKeys.includes(basename)) return basename;
    return cli;
  }

  _resolveCliPath(cli) {
    const map = {
      'claude': 'claude',
      'kiro': 'kiro-cli',
      'aider': 'aider',
      'cursor': 'cursor',
      'shell': process.env.SHELL || '/bin/zsh',
    };
    return map[cli] || cli;
  }

  _buildCliArgs(cli, projectPath, projectId, role, resume, claudeSessionId) {
    const { workspaceMemoryDir } = require('./paths');
    const memoryPath = projectId ? workspaceMemoryDir(projectId) : path.join(projectPath, '.dan-ide', 'memory');
    const contextFile = path.join(memoryPath, 'CONTEXT.md');
    const sharedFile = path.join(memoryPath, 'SHARED.md');
    let args = [];
    let env = {};
    let initialMessage = null; // Sent to PTY after spawn for agents that don't support system prompts

    // All agents get these env vars for programmatic access
    env.DAN_IDE_MEMORY_PATH = memoryPath;
    env.DAN_IDE_CONTEXT_FILE = contextFile;
    env.DAN_IDE_SHARED_FILE = sharedFile;

    // Build universal collaboration prompt
    const collaborationPrompt = this._buildCollaborationPrompt(memoryPath, contextFile, sharedFile, role);
    const policyPrompt = this._policyEngine.generatePolicyPrompt(projectPath);

    switch (cli) {
      case 'claude':
        args = ['--dangerously-skip-permissions'];
        if (claudeSessionId) {
          args.push('--session-id', claudeSessionId);
        }
        if (role) {
          args.push('--system-prompt', this._buildRolePrompt(role, memoryPath));
        }
        args.push('--append-system-prompt', collaborationPrompt + '\n\n' + policyPrompt);
        break;

      case 'kiro':
        args = ['chat', '--trust-all-tools'];
        // Write collaboration context to .kiro/rules/ so Kiro picks it up automatically
        this._ensureKiroRules(projectPath, collaborationPrompt, policyPrompt);
        break;

      case 'aider':
        args = [
          '--read', contextFile,
          '--read', sharedFile,
        ];
        // Write collaboration instructions to a file that aider reads
        this._ensureAiderContext(projectPath, projectId, collaborationPrompt, policyPrompt);
        args.push('--read', path.join(memoryPath, 'AGENT_INSTRUCTIONS.md'));
        break;

      default:
        // Shell gets env vars only
        break;
    }

    return { args, env, initialMessage };
  }

  _buildCollaborationPrompt(memoryPath, contextFile, sharedFile, role) {
    const roleDesc = role ? `Your role: ${this._buildRolePrompt(role, memoryPath)}\n\n` : '';
    return [
      `# Dan IDE — Multi-Agent Collaboration`,
      ``,
      `You are running inside Dan IDE, a multi-agent development environment. Multiple AI agents may be working on the same project simultaneously.`,
      ``,
      `## Your Capabilities in Dan IDE`,
      `- You are one of potentially several agents (Claude, Kiro, Aider, or Shell)`,
      `- You share a project workspace with other agents`,
      `- You can communicate with other agents via shared files`,
      `- A human architect oversees all agents and may send you tasks or questions about other agents' work`,
      ``,
      `## Shared Memory (READ THIS FIRST)`,
      `- **Context file**: \`${contextFile}\` — project state, active agents, current tasks`,
      `- **Shared findings**: \`${sharedFile}\` — results and discoveries from all agents`,
      `- **Messages**: \`${memoryPath}/MESSAGES.md\` — inter-agent communication log`,
      `- **Memory directory**: \`${memoryPath}/\` — all shared files live here`,
      ``,
      `## Communication Protocol`,
      `1. **BEFORE starting any task**: Read \`${contextFile}\` for project state and what other agents are doing`,
      `2. **AFTER completing work**: Update \`${sharedFile}\` with your findings, using a clear heading and timestamp`,
      `3. **To message other agents**: Append to \`${memoryPath}/MESSAGES.md\` with format:`,
      `   \`\`\``,
      `   ### [YYYY-MM-DD HH:MM] YourName`,
      `   Your message here`,
      `   \`\`\``,
      `4. **To see other agents' output**: Read \`${sharedFile}\` — other agents write their results there`,
      `5. **Do not overwrite** other agents' entries — append below them`,
      ``,
      `## When Asked About Other Agents' Work`,
      `If the human asks you about what another agent found, or asks you to compare/evaluate results:`,
      `1. Read \`${sharedFile}\` to see all agents' findings`,
      `2. Read \`${memoryPath}/MESSAGES.md\` for any inter-agent messages`,
      `3. Base your answer on what's written in shared memory`,
      ``,
      roleDesc,
    ].join('\n');
  }

  _ensureKiroRules(projectPath, collaborationPrompt, policyPrompt) {
    const kiroRulesDir = path.join(projectPath, '.kiro', 'rules');
    fs.mkdirSync(kiroRulesDir, { recursive: true });
    const rulesFile = path.join(kiroRulesDir, 'dan-ide-context.md');
    const content = collaborationPrompt + '\n\n## Policy Constraints\n\n' + policyPrompt;
    fs.writeFileSync(rulesFile, content);
  }

  _ensureAiderContext(projectPath, projectId, collaborationPrompt, policyPrompt) {
    const { workspaceMemoryDir } = require('./paths');
    const memoryPath = projectId ? workspaceMemoryDir(projectId) : path.join(projectPath, '.dan-ide', 'memory');
    fs.mkdirSync(memoryPath, { recursive: true });
    const instructionsFile = path.join(memoryPath, 'AGENT_INSTRUCTIONS.md');
    const content = collaborationPrompt + '\n\n## Policy Constraints\n\n' + policyPrompt;
    fs.writeFileSync(instructionsFile, content);
  }

  _buildRolePrompt(role, memoryPath) {
    const roles = {
      builder: 'You are a builder agent. Focus on implementing features and writing code. Check shared memory for context before starting.',
      reviewer: 'You are a code reviewer agent. Review recent changes, check for bugs, security issues, and style. Write findings to shared memory.',
      researcher: 'You are a research agent. Investigate questions, explore codebases, and document findings in shared memory.',
      coordinator: 'You are a coordinator agent. Plan work, break down tasks, and update shared memory with plans and status.',
    };
    return roles[role] || role;
  }

  _ensureSharedMemoryFiles(projectPath, projectId) {
    const { workspaceMemoryDir } = require('./paths');
    const memoryPath = projectId ? workspaceMemoryDir(projectId) : path.join(projectPath, '.dan-ide', 'memory');
    fs.mkdirSync(memoryPath, { recursive: true });

    const sharedFile = path.join(memoryPath, 'SHARED.md');
    if (!fs.existsSync(sharedFile)) {
      fs.writeFileSync(sharedFile, [
        '# Shared Findings',
        '',
        'Agents write their results and discoveries here.',
        'Do not overwrite other agents\' entries — append below.',
        '',
      ].join('\n'));
    }

    const contextFile = path.join(memoryPath, 'CONTEXT.md');
    if (!fs.existsSync(contextFile)) {
      fs.writeFileSync(contextFile, [
        '# Project Context',
        '',
        'This file contains project state and active agent information.',
        'Updated automatically by Dan IDE.',
        '',
      ].join('\n'));
    }

    const messagesFile = path.join(memoryPath, 'MESSAGES.md');
    if (!fs.existsSync(messagesFile)) {
      fs.writeFileSync(messagesFile, [
        '# Agent Messages',
        '',
        'Inter-agent communication log. Append messages below.',
        '',
      ].join('\n'));
    }
  }

  // Persist session metadata to disk
  _saveState() {
    const state = Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      name: s.name,
      projectId: s.projectId,
      projectPath: s.projectPath,
      cli: s.cli,
      cliKey: s.cliKey,
      status: s.status,
      historyFile: s.historyFile,
      claudeSessionId: s.claudeSessionId,
    }));
    fs.writeFileSync(SESSIONS_STATE_FILE, JSON.stringify(state, null, 2));
  }

  // Load saved session state (metadata only, no PTY restoration)
  loadState() {
    try {
      const data = fs.readFileSync(SESSIONS_STATE_FILE, 'utf8');
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  // Get history content for a session (for replaying into terminal)
  getHistory(sessionId) {
    const session = this.sessions.get(sessionId);
    const historyFile = session ? session.historyFile : null;
    if (!historyFile) {
      // Try loading from state file
      const state = this.loadState();
      const meta = state.find((s) => s.id === sessionId);
      if (meta && meta.historyFile && fs.existsSync(meta.historyFile)) {
        return fs.readFileSync(meta.historyFile, 'utf8');
      }
      return '';
    }
    if (fs.existsSync(historyFile)) {
      return fs.readFileSync(historyFile, 'utf8');
    }
    return '';
  }

  // Get history by direct file path
  getHistoryByPath(filePath) {
    if (filePath && fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf8');
    }
    return '';
  }

  // Rename a session
  rename(id, newName) {
    const session = this.sessions.get(id);
    if (session) {
      session.name = newName;
      this._saveState();
    }
  }

  listForProject(projectId) {
    return Array.from(this.sessions.values())
      .filter((s) => s.projectId === projectId)
      .map((s) => s.toJSON());
  }

  listAll() {
    return Array.from(this.sessions.values()).map((s) => s.toJSON());
  }

  write(id, data) {
    const session = this.sessions.get(id);
    if (session) session.write(data);
  }

  resize(id, cols, rows) {
    const session = this.sessions.get(id);
    if (session) session.resize(cols, rows);
  }

  stop(id) {
    const session = this.sessions.get(id);
    if (session) {
      session.stop();
      this._saveState();
    }
  }

  remove(id) {
    const session = this.sessions.get(id);
    if (session) session.stop();
    this.sessions.delete(id);
    this._saveState();
  }

  restart(id) {
    const session = this.sessions.get(id);
    if (!session) return null;
    session.stop();
    this.sessions.delete(id);
    const newSession = this.create({
      name: session.name,
      projectId: session.projectId,
      projectPath: session.projectPath,
      cli: session.cliKey,
      resume: true,
      claudeSessionId: session.claudeSessionId,
    });
    return newSession;
  }

  stopAll() {
    for (const session of this.sessions.values()) {
      session.stop();
    }
    this._saveState();
  }
}

module.exports = { SessionManager };

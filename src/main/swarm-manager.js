/**
 * Swarm Manager - Orchestrates coordinated groups of agents working toward a single goal.
 *
 * A swarm consists of:
 * - A coordinator agent that dispatches tasks and tracks progress
 * - One or more worker agents with assigned roles (builder, scout, reviewer)
 * - A shared mission prompt that defines the goal
 * - Inter-agent messaging via MESSAGES.md
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class SwarmManager {
  constructor(sessionManager, contextManager) {
    this.sessionManager = sessionManager;
    this.contextManager = contextManager;
    this.swarms = new Map(); // swarmId -> swarm metadata
  }

  /**
   * Create and launch a swarm.
   * @param {object} opts
   * @param {string} opts.projectId
   * @param {string} opts.projectPath
   * @param {string} opts.mission - The goal for this swarm
   * @param {Array} opts.agents - Array of { role, cli } objects
   *   Roles: 'coordinator', 'builder', 'scout', 'reviewer'
   *   CLI: 'claude', 'kiro', 'aider', 'shell'
   * @returns {object} swarm metadata with session IDs
   */
  create({ projectId, projectPath, mission, agents }) {
    const swarmId = crypto.randomUUID();
    const memoryDir = path.join(projectPath, '.dan-ide', 'memory');
    const swarmDir = path.join(projectPath, '.dan-ide', 'swarms', swarmId);
    fs.mkdirSync(swarmDir, { recursive: true });

    // Build agent roster for coordinator's knowledge
    const agentNames = agents.map((a, i) => {
      if (a.role === 'coordinator') return `Coordinator (${a.cli})`;
      return `${this._capitalize(a.role)}-${i} (${a.cli})`;
    });

    // Save swarm plan to disk
    const swarmPlan = {
      id: swarmId,
      mission,
      agents: agents.map((a, i) => ({
        ...a,
        name: agentNames[i],
      })),
      createdAt: new Date().toISOString(),
      status: 'active',
    };
    fs.writeFileSync(path.join(swarmDir, 'plan.json'), JSON.stringify(swarmPlan, null, 2));

    // Write the swarm mission file (all agents read this)
    const missionFile = path.join(swarmDir, 'MISSION.md');
    fs.writeFileSync(missionFile, `# Swarm Mission

${mission}

## Team
${agentNames.map((name) => `- ${name}`).join('\n')}

## Communication
- Post messages to \`.dan-ide/memory/MESSAGES.md\`
- Format: \`### [timestamp] AgentName\\nMessage\`
- Read MESSAGES.md regularly for updates from other agents
- The Coordinator dispatches tasks and tracks progress
`);

    // Initialize context so agents can discover each other
    this.contextManager.initProject(projectPath);

    // Spawn each agent
    const sessionIds = [];

    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i];
      const name = agentNames[i];
      const isCoordinator = agent.role === 'coordinator';

      const systemPrompt = isCoordinator
        ? this._buildCoordinatorPrompt(mission, agentNames, memoryDir, swarmDir)
        : this._buildWorkerPrompt(agent.role, name, mission, agentNames, memoryDir, swarmDir);

      const session = this.sessionManager.create({
        name: `[swarm] ${name}`,
        projectId,
        projectPath,
        cli: agent.cli,
        role: systemPrompt, // role field accepts custom prompt strings
      });

      sessionIds.push(session.id);

      // Send the kickoff prompt once Claude is ready for input.
      // Claude shows its input prompt after loading/updating.
      // We detect readiness by watching for the prompt indicator.
      if (agent.cli === 'claude') {
        const kickoff = isCoordinator
          ? this._getCoordinatorKickoff(mission, agentNames)
          : this._getWorkerKickoff(agent.role, name, mission);
        this._waitForReadyAndSend(session, kickoff);
      }
    }

    const swarmMeta = {
      id: swarmId,
      projectId,
      projectPath,
      mission,
      agents: swarmPlan.agents,
      sessionIds,
      status: 'active',
      createdAt: swarmPlan.createdAt,
    };

    this.swarms.set(swarmId, swarmMeta);

    // Rebuild context with new agents
    this.contextManager.rebuildContext(projectPath, this.sessionManager.listAll());

    // Start automatic completion detection polling
    this._startCompletionPolling(swarmId);

    return swarmMeta;
  }

  _buildCoordinatorPrompt(mission, agentNames, memoryDir, swarmDir) {
    const workers = agentNames.filter((n) => !n.startsWith('Coordinator'));
    const scouts = workers.filter((w) => w.includes('Scout'));
    const builders = workers.filter((w) => w.includes('Builder'));
    const reviewers = workers.filter((w) => w.includes('Reviewer'));
    return `You are the COORDINATOR of a multi-agent swarm. Your mission:

${mission}

## Your Team
${workers.map((w) => `- ${w}`).join('\n')}

## STRICT Workflow — Follow This Order
1. **Plan**: Break the mission into discrete tasks. Post your plan to MESSAGES.md.
2. **Research first**: ${scouts.length > 0 ? `Assign research/exploration tasks to ${scouts.join(', ')}. Wait for their report before proceeding.` : 'Review the codebase yourself to understand the current state.'}
3. **Assign builders**: After research is complete, assign SPECIFIC implementation tasks to EACH builder individually. Every builder must get a unique, non-overlapping task. Address them by name: "@Builder-1: [specific task]"
4. **Wait for completion**: Do NOT assign new tasks until a builder reports done.
5. **Review**: ${reviewers.length > 0 ? `Assign review tasks to ${reviewers.join(', ')} after builders complete.` : 'Verify the work yourself.'}
6. **Declare COMPLETE**: When all objectives are met, post "MISSION COMPLETE" to MESSAGES.md.

## Communication Protocol
- Post to: .dan-ide/memory/MESSAGES.md
- Format: "### [timestamp] Coordinator\\n@AgentName: [task description]"
- ALWAYS address agents by their exact name with @ prefix
- Give ONE task per agent at a time — never batch multiple tasks
- Wait for "DONE" or "COMPLETE" from an agent before assigning their next task

## CRITICAL RULES
- You are the ONLY one who assigns work. Workers CANNOT self-assign.
- NEVER praise preemptive work. If a worker acts without assignment, tell them to STOP and wait.
- Distribute work EVENLY — every agent on the team must contribute.
- Do NOT do implementation work yourself — delegate everything.
- If a scout exists, ALWAYS use them for research before assigning builders.
- Check MESSAGES.md every 30 seconds for worker updates.`;
  }

  _buildWorkerPrompt(role, name, mission, agentNames, memoryDir, swarmDir) {
    const roleInstructions = {
      builder: `You are a BUILDER agent named "${name}". Your ONLY job is to implement code as assigned by the Coordinator.

## CRITICAL RULES — FOLLOW EXACTLY
1. **DO NOT start any work until the Coordinator explicitly assigns you a task in MESSAGES.md**
2. **DO NOT take initiative** — even if you see what needs to be done, WAIT for assignment
3. **DO NOT duplicate another builder's work** — only do YOUR assigned task
4. Your task assignment will look like: "@${name}: [task description]"
5. If no task is assigned to you yet, read MESSAGES.md every 30 seconds and WAIT

## When You Receive a Task
1. Post to MESSAGES.md: "### [timestamp] ${name}\\nACKNOWLEDGED: Starting [task summary]"
2. Implement the task
3. Post to MESSAGES.md: "### [timestamp] ${name}\\nDONE: [summary of what was implemented]"
4. WAIT for next assignment — do not self-assign follow-up work`,

      scout: `You are a SCOUT agent named "${name}". Your ONLY job is to research and report findings as assigned by the Coordinator.

## CRITICAL RULES — FOLLOW EXACTLY
1. **DO NOT start any research until the Coordinator explicitly assigns you a task in MESSAGES.md**
2. **DO NOT implement code** — you only research and report
3. Your task assignment will look like: "@${name}: [research question]"
4. If no task is assigned to you yet, read MESSAGES.md every 30 seconds and WAIT

## When You Receive a Task
1. Post to MESSAGES.md: "### [timestamp] ${name}\\nACKNOWLEDGED: Researching [topic]"
2. Investigate thoroughly — explore files, read code, understand patterns
3. Post to MESSAGES.md: "### [timestamp] ${name}\\nFINDINGS:\\n[detailed report of what you found]"
4. WAIT for next assignment`,

      reviewer: `You are a REVIEWER agent named "${name}". Your ONLY job is to review code and report issues as assigned by the Coordinator.

## CRITICAL RULES — FOLLOW EXACTLY
1. **DO NOT start any review until the Coordinator explicitly assigns you a task in MESSAGES.md**
2. **DO NOT implement fixes** — only report issues for builders to fix
3. Your task assignment will look like: "@${name}: [review task]"
4. If no task is assigned to you yet, read MESSAGES.md every 30 seconds and WAIT

## When You Receive a Task
1. Post to MESSAGES.md: "### [timestamp] ${name}\\nACKNOWLEDGED: Reviewing [target]"
2. Review the specified code for bugs, security, correctness, style
3. Post to MESSAGES.md: "### [timestamp] ${name}\\nREVIEW COMPLETE:\\n[issues found or APPROVED]"
4. WAIT for next assignment`,
    };

    return `${roleInstructions[role] || roleInstructions.builder}

## Swarm Mission (context only — do NOT act on this without Coordinator assignment)
${mission}

## Team
${agentNames.map((n) => `- ${n}`).join('\n')}

## Communication
- Read .dan-ide/memory/MESSAGES.md for your task assignments
- Post updates: "### [timestamp] ${name}\\nYour message"
- Read ${swarmDir}/MISSION.md for full mission context
- REMEMBER: You must WAIT for @${name} mentions before acting`;
  }

  _getCoordinatorKickoff(mission, agentNames) {
    const workers = agentNames.filter((n) => !n.startsWith('Coordinator'));
    const scouts = workers.filter((w) => w.includes('Scout'));
    const builders = workers.filter((w) => w.includes('Builder'));
    return `You are the coordinator. Mission: "${mission}". Team: ${workers.join(', ')}. ` +
      `Follow the strict workflow: ` +
      (scouts.length > 0 ? `First assign ${scouts[0]} to research the codebase. Wait for their findings. ` : '') +
      (builders.length > 1 ? `Then assign EACH builder a UNIQUE sub-task — distribute work evenly. ` : '') +
      `Post your plan and assignments to .dan-ide/memory/MESSAGES.md now. Begin.`;
  }

  _getWorkerKickoff(role, name, mission) {
    return `You are ${name}. The swarm mission is: "${mission}". ` +
      `DO NOT start working yet. Read .dan-ide/memory/MESSAGES.md and WAIT for the Coordinator to assign you a task with "@${name}:". ` +
      `Check MESSAGES.md every 30 seconds. Do NOT act until you see your name mentioned with a specific task.`;
  }

  /**
   * Wait for a Claude session to be ready for input, then send the kickoff message.
   * Detects readiness by monitoring PTY output for the Claude input prompt.
   */
  _waitForReadyAndSend(session, message) {
    let sent = false;

    const doSend = () => {
      if (sent) return;
      sent = true;
      if (session.pty && session.status === 'running') {
        // Write message text, then Enter (\n and \r) after a brief delay
        // Claude Code's TUI needs text + Enter as separate writes
        session.pty.write(message);
        setTimeout(() => {
          if (session.pty && session.status === 'running') {
            session.pty.write('\n');
            setTimeout(() => {
              if (session.pty && session.status === 'running') {
                session.pty.write('\r');
              }
            }, 100);
          }
        }, 200);
      }
    };

    // Wait for Claude to fully load before sending.
    // Monitor output for prompt indicators, then wait for stability.
    let buffer = '';
    let promptSeen = false;
    let stableTimer = null;

    session.onData((data) => {
      if (sent) return;
      buffer += data;

      if (!promptSeen) {
        const stripped = buffer.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ' ').replace(/\[\d+[A-Z]/g, ' ');
        if (stripped.includes('tab') || stripped.includes('ctrl+g')) {
          promptSeen = true;
        }
      }

      // Reset stability timer on each new data
      if (promptSeen) {
        if (stableTimer) clearTimeout(stableTimer);
        // Wait 5s of no output after prompt is seen
        stableTimer = setTimeout(doSend, 5000);
      }
    });

    // Absolute fallback: send after 60s no matter what
    setTimeout(() => {
      if (!sent) doSend();
    }, 60000);
  }

  _capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  /**
   * Check progress of a swarm by parsing MESSAGES.md.
   * @param {string} swarmId
   * @returns {object} { totalTasks, acknowledged, completed, missionComplete, progressPercent }
   */
  checkProgress(swarmId) {
    const swarm = this.swarms.get(swarmId);
    if (!swarm) return null;

    const messagesFile = path.join(swarm.projectPath, '.dan-ide', 'memory', 'MESSAGES.md');
    let content = '';
    try {
      content = fs.readFileSync(messagesFile, 'utf8');
    } catch {
      return { totalTasks: 0, acknowledged: 0, completed: 0, missionComplete: false, progressPercent: 0 };
    }

    // Count tasks assigned by coordinator (messages with @AgentName:)
    const taskAssignments = (content.match(/@[\w-]+\s*:/g) || []).length;

    // Count acknowledged messages
    const acknowledged = (content.match(/\bACKNOWLEDGED\b/gi) || []).length;

    // Count completed messages (DONE, COMPLETE as standalone word, or FINDINGS)
    const doneMessages = (content.match(/\bDONE\b/gi) || []).length;
    const completeMessages = (content.match(/\bCOMPLETE\b/gi) || []).length;
    const findingsMessages = (content.match(/\bFINDINGS\b/gi) || []).length;
    // "MISSION COMPLETE" contains COMPLETE, so subtract those from completed count
    const missionCompleteCount = (content.match(/MISSION\s+COMPLETE/gi) || []).length;
    const completed = doneMessages + (completeMessages - missionCompleteCount) + findingsMessages;

    // Check for mission completion
    const missionComplete = /MISSION\s+COMPLETE/i.test(content);

    // Calculate progress percentage
    const totalTasks = taskAssignments;
    const progressPercent = totalTasks > 0 ? Math.round((completed / totalTasks) * 100) : 0;

    return { totalTasks, acknowledged, completed, missionComplete, progressPercent };
  }

  /**
   * Get the active swarm for a project.
   * @param {string} projectId
   * @returns {object|null} The active swarm or null
   */
  getActiveSwarmForProject(projectId) {
    for (const swarm of this.swarms.values()) {
      if (swarm.projectId === projectId && swarm.status === 'active') {
        return swarm;
      }
    }
    return null;
  }

  /**
   * Start polling for mission completion.
   * Checks MESSAGES.md every 10s for "MISSION COMPLETE".
   * @param {string} swarmId
   */
  _startCompletionPolling(swarmId) {
    const swarm = this.swarms.get(swarmId);
    if (!swarm) return;

    const interval = setInterval(() => {
      const currentSwarm = this.swarms.get(swarmId);
      if (!currentSwarm || currentSwarm.status !== 'active') {
        clearInterval(interval);
        return;
      }

      const messagesFile = path.join(currentSwarm.projectPath, '.dan-ide', 'memory', 'MESSAGES.md');
      try {
        const content = fs.readFileSync(messagesFile, 'utf8');
        if (/MISSION\s+COMPLETE/i.test(content)) {
          currentSwarm.status = 'completed';
          currentSwarm.completedAt = new Date().toISOString();
          clearInterval(interval);
        }
      } catch {
        // File doesn't exist yet, keep polling
      }
    }, 10000);

    // Store interval reference for cleanup
    swarm._completionInterval = interval;
  }

  get(swarmId) {
    return this.swarms.get(swarmId) || null;
  }

  list() {
    return Array.from(this.swarms.values());
  }

  listForProject(projectId) {
    return Array.from(this.swarms.values()).filter((s) => s.projectId === projectId);
  }

  stop(swarmId) {
    const swarm = this.swarms.get(swarmId);
    if (!swarm) return;
    if (swarm._completionInterval) {
      clearInterval(swarm._completionInterval);
      swarm._completionInterval = null;
    }
    for (const sessionId of swarm.sessionIds) {
      this.sessionManager.stop(sessionId);
    }
    swarm.status = 'stopped';
  }

  remove(swarmId) {
    const swarm = this.swarms.get(swarmId);
    if (!swarm) return;
    if (swarm._completionInterval) {
      clearInterval(swarm._completionInterval);
      swarm._completionInterval = null;
    }
    for (const sessionId of swarm.sessionIds) {
      this.sessionManager.remove(sessionId);
    }
    this.swarms.delete(swarmId);
  }
}

module.exports = { SwarmManager };

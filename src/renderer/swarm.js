// ========== Swarm Panel (Modal, Messages, Tasks, Canvas, Audit) ==========
// Depends on window.IDE (set by app.js before this script loads)

(function () {
  const IDE = window.IDE;

  // ========== Swarm Modal ==========
  const swarmModal = document.getElementById('swarm-modal');
  const swarmMission = document.getElementById('swarm-mission');
  const swarmAgentsList = document.getElementById('swarm-agents-list');
  const btnNewSwarm = document.getElementById('btn-new-swarm');
  const btnSwarmAddAgent = document.getElementById('swarm-add-agent');
  const btnSwarmCancel = document.getElementById('swarm-cancel');
  const btnSwarmLaunch = document.getElementById('swarm-launch');

  const DEFAULT_SWARM_AGENTS = [
    { role: 'coordinator', cli: 'claude' },
    { role: 'builder', cli: 'claude' },
    { role: 'scout', cli: 'claude' },
  ];

  let _swarmAgents = [];

  function openSwarmModal() {
    if (!IDE.state.activeProjectId) {
      IDE.showToast('Select a project first');
      IDE.openDrawer();
      return;
    }
    swarmModal.classList.remove('hidden');
    swarmMission.value = '';
    renderSwarmAgents(DEFAULT_SWARM_AGENTS.map((a) => ({ ...a })));
    setTimeout(() => swarmMission.focus(), 50);
  }

  function renderSwarmAgents(agents) {
    _swarmAgents = agents;
    swarmAgentsList.innerHTML = '';
    for (let i = 0; i < agents.length; i++) {
      const row = document.createElement('div');
      row.className = 'swarm-agent-row';
      row.innerHTML = `
        <select class="swarm-role" data-idx="${i}">
          <option value="coordinator"${agents[i].role === 'coordinator' ? ' selected' : ''}>Coordinator</option>
          <option value="builder"${agents[i].role === 'builder' ? ' selected' : ''}>Builder</option>
          <option value="scout"${agents[i].role === 'scout' ? ' selected' : ''}>Scout</option>
          <option value="reviewer"${agents[i].role === 'reviewer' ? ' selected' : ''}>Reviewer</option>
        </select>
        <select class="swarm-cli" data-idx="${i}">
          <option value="claude"${agents[i].cli === 'claude' ? ' selected' : ''}>Claude</option>
          <option value="kiro"${agents[i].cli === 'kiro' ? ' selected' : ''}>Kiro</option>
          <option value="aider"${agents[i].cli === 'aider' ? ' selected' : ''}>Aider</option>
          <option value="shell"${agents[i].cli === 'shell' ? ' selected' : ''}>Shell</option>
        </select>
        <button class="swarm-remove-agent" data-idx="${i}" title="Remove">&times;</button>
      `;
      swarmAgentsList.appendChild(row);
    }

    swarmAgentsList.querySelectorAll('.swarm-role').forEach((sel) => {
      sel.addEventListener('change', (e) => {
        _swarmAgents[parseInt(e.target.dataset.idx)].role = e.target.value;
      });
    });
    swarmAgentsList.querySelectorAll('.swarm-cli').forEach((sel) => {
      sel.addEventListener('change', (e) => {
        _swarmAgents[parseInt(e.target.dataset.idx)].cli = e.target.value;
      });
    });
    swarmAgentsList.querySelectorAll('.swarm-remove-agent').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.target.dataset.idx);
        _swarmAgents.splice(idx, 1);
        renderSwarmAgents(_swarmAgents);
      });
    });
  }

  btnNewSwarm.addEventListener('click', openSwarmModal);
  btnSwarmCancel.addEventListener('click', () => swarmModal.classList.add('hidden'));

  btnSwarmAddAgent.addEventListener('click', () => {
    _swarmAgents.push({ role: 'builder', cli: 'claude' });
    renderSwarmAgents(_swarmAgents);
  });

  btnSwarmLaunch.addEventListener('click', async () => {
    const mission = swarmMission.value.trim();
    if (!mission) {
      IDE.showToast('Enter a mission for the swarm');
      return;
    }
    if (_swarmAgents.length < 2) {
      IDE.showToast('A swarm needs at least 2 agents');
      return;
    }
    if (!_swarmAgents.some((a) => a.role === 'coordinator')) {
      IDE.showToast('A swarm needs a coordinator');
      return;
    }

    const project = IDE.state.projects.find((p) => p.id === IDE.state.activeProjectId);
    if (!project) {
      IDE.showToast('No project selected');
      return;
    }

    swarmModal.classList.add('hidden');
    IDE.showToast(`Launching swarm with ${_swarmAgents.length} agents...`);

    let swarm;
    try {
      swarm = await window.api.createSwarm({
        projectId: IDE.state.activeProjectId,
        projectPath: project.path,
        mission,
        agents: _swarmAgents,
      });
    } catch (e) {
      IDE.showToast(`Swarm failed: ${e.message}`);
      console.error('Swarm creation error:', e);
      return;
    }

    if (!swarm || !swarm.sessionIds || swarm.sessionIds.length === 0) {
      IDE.showToast('Swarm created but no sessions were spawned');
      return;
    }

    const allSessions = await window.api.listAllSessions();

    for (const sessionId of swarm.sessionIds) {
      const meta = allSessions.find((s) => s.id === sessionId);
      if (!meta) {
        console.warn('Swarm session not found in listAll:', sessionId);
        continue;
      }
      if (IDE.state.sessions.has(sessionId)) continue;

      const { terminal, fitAddon, paneEl } = await IDE.createTerminalPane(meta);

      try {
        const history = await window.api.getSessionHistory(sessionId);
        if (history) terminal.write(history);
      } catch (e) {}

      terminal.onData((data) => window.api.writeSession(sessionId, data));
      terminal.onResize(({ cols, rows }) => window.api.resizeSession(sessionId, cols, rows));

      const cleanupData = window.api.onSessionData(sessionId, (data) => terminal.write(data));
      const cleanupExit = window.api.onSessionExit(sessionId, (code) => {
        terminal.write(`\r\n\x1b[33m[Agent exited with code ${code}]\x1b[0m\r\n`);
        const s = IDE.state.sessions.get(sessionId);
        if (s) {
          s.meta.status = 'stopped';
          IDE.updatePaneStatus(s);
        }
        IDE.renderDrawer();
        IDE.renderTabs();
        IDE.updateStatusBar();
      });

      IDE.state.sessions.set(sessionId, {
        meta,
        terminal,
        fitAddon,
        paneEl,
        cleanup: () => { cleanupData(); cleanupExit(); },
      });
    }

    if (swarm.sessionIds.length > 0) {
      IDE.state.activeSessionId = swarm.sessionIds[0];
      document.getElementById('no-session-msg').style.display = 'none';
    }
    IDE.state.viewMode = 'project';
    document.getElementById('view-mode').value = 'project';
    IDE.saveSettings({ viewMode: 'project' });

    IDE.renderDrawer();
    IDE.renderTabs();
    IDE.applyViewMode();
    IDE.updateStatusBar();
    IDE.showToast(`Swarm launched: ${swarm.agents.length} agents working on mission`);
  });

  // ========== Swarm Panel (Messages, Tasks, Canvas, Audit) ==========
  const messagesTabsBar = document.getElementById('swarm-tabs-bar');
  const messagesContent = document.getElementById('messages-content');
  const tasksContent = document.getElementById('tasks-content');
  const messagesList = document.getElementById('messages-list');
  const tasksList = document.getElementById('tasks-list');
  let _messagesInterval = null;

  if (messagesTabsBar) {
    messagesTabsBar.addEventListener('click', (e) => {
      const tab = e.target.closest('.msg-tab');
      if (!tab || tab.id === 'swarm-clear-btn') return;
      messagesTabsBar.querySelectorAll('.msg-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      const swarmPanel = document.getElementById('panel-swarm');
      swarmPanel.querySelectorAll('.msg-tab-content').forEach((c) => c.classList.remove('active'));
      document.getElementById(`${target}-content`).classList.add('active');
      if (target === 'canvas-tab') {
        const canvas = document.getElementById('agent-canvas');
        if (canvas) { canvas.width = canvas.parentElement.clientWidth; canvas.height = canvas.parentElement.clientHeight; }
      }
    });
  }

  // Swarm clear button
  const swarmClearBtn = document.getElementById('swarm-clear-btn');
  if (swarmClearBtn) {
    swarmClearBtn.addEventListener('click', async () => {
      if (!IDE.state.activeProjectId) return;
      try { await window.api.clearMessages(IDE.state.activeProjectId); } catch {}
      if (messagesList) messagesList.innerHTML = '';
      if (tasksList) tasksList.innerHTML = '';
      const auditTimeline = document.getElementById('audit-timeline');
      if (auditTimeline) auditTimeline.innerHTML = '';
      IDE.showToast('Swarm panel cleared');
    });
  }

  function parseMessages(raw) {
    if (!raw || !raw.trim()) return [];
    const messages = [];
    const blocks = raw.split(/^### /m).filter((b) => b.trim());
    for (const block of blocks) {
      const lines = block.split('\n');
      const headerLine = lines[0] || '';
      const match = headerLine.match(/^\[([^\]]*)\]\s*(.+)/);
      let timestamp = '';
      let agent = 'Unknown';
      if (match) {
        timestamp = match[1];
        agent = match[2].trim();
      } else {
        agent = headerLine.trim();
      }
      const body = lines.slice(1).join('\n').trim();
      messages.push({ timestamp, agent, body });
    }
    return messages;
  }

  function detectRole(agentName) {
    const lower = agentName.toLowerCase();
    if (lower.includes('coordinator')) return 'coordinator';
    if (lower.includes('builder')) return 'builder';
    if (lower.includes('scout')) return 'scout';
    if (lower.includes('reviewer')) return 'reviewer';
    return '';
  }

  function extractTasks(messages) {
    const tasks = [];
    const taskMap = new Map();

    for (const msg of messages) {
      const role = detectRole(msg.agent);
      if (role === 'coordinator') {
        const assignments = msg.body.matchAll(/@([\w-]+):\s*(.+?)(?=\n@|\n###|$)/gs);
        for (const m of assignments) {
          const assignee = m[1];
          const desc = m[2].trim();
          taskMap.set(assignee, { assignee, description: desc, status: 'assigned', timestamp: msg.timestamp });
        }
      } else if (msg.body.match(/\bACKNOWLEDGED\b/i)) {
        const existing = taskMap.get(msg.agent) || taskMap.get(msg.agent.replace(/\s/g, '-'));
        if (existing) existing.status = 'in-progress';
        for (const [key, task] of taskMap) {
          if (msg.agent.includes(key) || key.includes(msg.agent.split(' ')[0])) {
            task.status = 'in-progress';
          }
        }
      } else if (msg.body.match(/\b(DONE|COMPLETE|FINDINGS|REVIEW COMPLETE)\b/i)) {
        for (const [key, task] of taskMap) {
          if (msg.agent.includes(key) || key.includes(msg.agent.split(' ')[0])) {
            task.status = 'done';
          }
        }
      }
    }

    return Array.from(taskMap.values());
  }

  function renderMessages(messages) {
    if (!messagesList) return;
    if (messages.length === 0) {
      messagesList.innerHTML = '<div class="messages-empty">No messages yet. Launch a swarm to see inter-agent communication.</div>';
      return;
    }
    messagesList.innerHTML = messages.map((msg) => {
      const role = detectRole(msg.agent);
      return `<div class="message-item ${role ? 'role-' + role : ''}">
        <div class="message-header">
          <span class="message-agent">${IDE.escapeHtml(msg.agent)}</span>
          <span class="message-time">${IDE.escapeHtml(msg.timestamp)}</span>
        </div>
        <div class="message-body">${IDE.escapeHtml(msg.body)}</div>
      </div>`;
    }).join('');
    const panel = messagesList.parentElement;
    if (panel) panel.scrollTop = panel.scrollHeight;
  }

  function renderTasks(tasks) {
    if (!tasksList) return;
    if (tasks.length === 0) {
      tasksList.innerHTML = '<div class="messages-empty">No tasks detected. Tasks appear when the Coordinator assigns work.</div>';
      return;
    }
    tasksList.innerHTML = tasks.map((task) => {
      const statusLabel = task.status === 'in-progress' ? 'IN PROGRESS' : task.status.toUpperCase();
      return `<div class="task-item">
        <span class="task-status ${task.status}">${statusLabel}</span>
        <div class="task-info">
          <div class="task-assignee">@${IDE.escapeHtml(task.assignee)}</div>
          <div class="task-description">${IDE.escapeHtml(task.description)}</div>
        </div>
      </div>`;
    }).join('');
  }

  async function refreshMessagesPanel() {
    if (!IDE.state.activeProjectId) return;

    const raw = await window.api.readMessages(IDE.state.activeProjectId);
    const messages = parseMessages(raw);
    renderMessages(messages);

    const tasks = extractTasks(messages);
    renderTasks(tasks);
  }

  function startMessagesPolling() {
    if (_messagesInterval) return;
    refreshMessagesPanel();
    _messagesInterval = setInterval(refreshMessagesPanel, 3000);
  }

  function stopMessagesPolling() {
    if (_messagesInterval) {
      clearInterval(_messagesInterval);
      _messagesInterval = null;
    }
  }

  // ========== Audit Timeline ==========
  const auditTimeline = document.getElementById("audit-timeline");
  let _auditInterval = null;

  const AUDIT_TYPE_ICONS = {
    session_start: "\u25B6",
    session_stop: "\u25A0",
    message_sent: "\u2709",
    task_assigned: "\u2192",
    task_completed: "\u2713",
    file_changed: "\u270E",
    swarm_created: "\u26A1",
    swarm_completed: "\u2605",
  };

  const AUDIT_TYPE_COLORS = {
    session_start: "#2ecc71",
    session_stop: "#e74c3c",
    message_sent: "#3498db",
    task_assigned: "#f39c12",
    task_completed: "#27ae60",
    file_changed: "#9b59b6",
    swarm_created: "#e67e22",
    swarm_completed: "#1abc9c",
  };

  function formatAuditTime(timestamp) {
    try {
      const d = new Date(timestamp);
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    } catch {
      return timestamp || "";
    }
  }

  function getAgentColor(name) {
    if (!name) return "#888";
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return IDE.COLORS[Math.abs(hash) % IDE.COLORS.length];
  }

  function renderAuditTimeline(events) {
    if (!auditTimeline) return;
    if (!events || events.length === 0) {
      auditTimeline.innerHTML = "<div class=\"messages-empty\">No audit events yet. Events appear when agents start, stop, or swarms are created.</div>";
      return;
    }
    auditTimeline.innerHTML = events.map((evt) => {
      const icon = AUDIT_TYPE_ICONS[evt.type] || "\u2022";
      const color = AUDIT_TYPE_COLORS[evt.type] || "#888";
      const agentColor = getAgentColor(evt.agentName);
      return `<div class="audit-event">
        <div class="audit-event-dot" style="background:${color}"></div>
        <div class="audit-event-line"></div>
        <div class="audit-event-body">
          <div class="audit-event-header">
            <span class="audit-event-icon" style="color:${color}">${icon}</span>
            <span class="audit-event-agent" style="color:${agentColor}">${IDE.escapeHtml(evt.agentName)}</span>
            <span class="audit-event-type">${IDE.escapeHtml(evt.type.replace(/_/g, " "))}</span>
            <span class="audit-event-time">${formatAuditTime(evt.timestamp)}</span>
          </div>
          <div class="audit-event-desc">${IDE.escapeHtml(evt.description)}</div>
        </div>
      </div>`;
    }).join("");
  }

  async function refreshAuditTimeline() {
    try {
      const events = await window.api.getAllAuditEvents(100);
      renderAuditTimeline(events);
    } catch { /* ignore */ }
  }

  function startAuditPolling() {
    if (_auditInterval) return;
    refreshAuditTimeline();
    _auditInterval = setInterval(refreshAuditTimeline, 5000);
  }

  function stopAuditPolling() {
    if (_auditInterval) {
      clearInterval(_auditInterval);
      _auditInterval = null;
    }
  }

  // Start audit polling
  startAuditPolling();

  // ========== Canvas Panel (Agent Graph Visualization) ==========
  let _canvasInterval = null;
  let _canvasPulsePhase = 0;

  function startCanvasRendering() {
    if (_canvasInterval) return;
    renderCanvasFrame();
    _canvasInterval = setInterval(renderCanvasFrame, 2000);
  }

  function stopCanvasRendering() {
    if (_canvasInterval) {
      clearInterval(_canvasInterval);
      _canvasInterval = null;
    }
  }

  function renderCanvasFrame() {
    const canvas = document.getElementById('agent-canvas');
    if (!canvas) return;
    const panel = document.getElementById('canvas-panel');
    if (!panel) return;

    const rect = panel.getBoundingClientRect();
    canvas.width = rect.width * window.devicePixelRatio;
    canvas.height = rect.height * window.devicePixelRatio;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    ctx.clearRect(0, 0, rect.width, rect.height);

    _canvasPulsePhase = (_canvasPulsePhase + 1) % 60;

    const projectSessions = [];
    IDE.state.sessions.forEach((s) => {
      if (IDE.state.activeProjectId && s.meta.projectId === IDE.state.activeProjectId) {
        projectSessions.push(s);
      }
    });

    if (projectSessions.length === 0) {
      ctx.fillStyle = '#666';
      ctx.font = '13px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No agents in current project', rect.width / 2, rect.height / 2);
      return;
    }

    const roleColors = {
      coordinator: '#e74c3c',
      builder: '#3498db',
      scout: '#2ecc71',
      researcher: '#2ecc71',
      reviewer: '#f39c12',
    };
    const defaultColor = '#9b59b6';

    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const radius = Math.min(rect.width, rect.height) * 0.3;
    const nodeRadius = 28;

    let coordinatorNode = null;
    const workerNodes = [];

    projectSessions.forEach((s) => {
      const role = s.meta.role || '';
      const node = {
        name: s.meta.name,
        role: role,
        status: s.meta.status,
        color: roleColors[role] || defaultColor,
        x: 0,
        y: 0,
      };
      if (role === 'coordinator') {
        coordinatorNode = node;
      } else {
        workerNodes.push(node);
      }
    });

    if (coordinatorNode) {
      coordinatorNode.x = centerX;
      coordinatorNode.y = centerY;
    }

    const allWorkers = coordinatorNode ? workerNodes : projectSessions.map((s) => {
      const role = s.meta.role || '';
      return {
        name: s.meta.name,
        role: role,
        status: s.meta.status,
        color: roleColors[role] || defaultColor,
        x: 0,
        y: 0,
      };
    });

    const nodesToLayout = coordinatorNode ? workerNodes : allWorkers;
    const count = nodesToLayout.length;
    nodesToLayout.forEach((node, i) => {
      const angle = (2 * Math.PI * i) / Math.max(count, 1) - Math.PI / 2;
      node.x = centerX + radius * Math.cos(angle);
      node.y = centerY + radius * Math.sin(angle);
    });

    if (coordinatorNode && workerNodes.length > 0) {
      workerNodes.forEach((worker) => {
        ctx.beginPath();
        ctx.moveTo(coordinatorNode.x, coordinatorNode.y);
        ctx.lineTo(worker.x, worker.y);
        ctx.strokeStyle = '#2a2a4a';
        ctx.lineWidth = 2;
        ctx.stroke();

        if (worker.status === 'running' && coordinatorNode.status === 'running') {
          const t = (_canvasPulsePhase % 60) / 60;
          const pulseX = coordinatorNode.x + (worker.x - coordinatorNode.x) * t;
          const pulseY = coordinatorNode.y + (worker.y - coordinatorNode.y) * t;
          ctx.beginPath();
          ctx.arc(pulseX, pulseY, 4, 0, Math.PI * 2);
          ctx.fillStyle = '#4ecdc4';
          ctx.globalAlpha = 0.8;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      });
    }

    const allNodes = coordinatorNode ? [coordinatorNode, ...workerNodes] : nodesToLayout;
    allNodes.forEach((node) => {
      ctx.beginPath();
      ctx.arc(node.x, node.y, nodeRadius, 0, Math.PI * 2);
      ctx.fillStyle = node.color + '33';
      ctx.fill();
      ctx.strokeStyle = node.color;
      ctx.lineWidth = 2.5;
      ctx.stroke();

      const dotColor = node.status === 'running' ? '#4ecdc4' : '#666';
      ctx.beginPath();
      ctx.arc(node.x + nodeRadius - 6, node.y - nodeRadius + 6, 5, 0, Math.PI * 2);
      ctx.fillStyle = dotColor;
      ctx.fill();

      ctx.fillStyle = '#e0e0e0';
      ctx.font = '11px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const displayName = node.name.length > 12 ? node.name.slice(0, 11) + '...' : node.name;
      ctx.fillText(displayName, node.x, node.y + 2);

      if (node.role) {
        ctx.fillStyle = '#888';
        ctx.font = '9px -apple-system, sans-serif';
        ctx.fillText(node.role, node.x, node.y + nodeRadius + 12);
      }
    });
  }

  // Expose for app.js
  window.IDE.swarm = {
    startMessagesPolling,
    stopMessagesPolling,
    startCanvasRendering,
    stopCanvasRendering,
    startAuditPolling,
    stopAuditPolling,
  };
})();

// xterm UMD globals
const Terminal = window.Terminal;
const FitAddon = window.FitAddon ? window.FitAddon.FitAddon : null;
const WebLinksAddon = window.WebLinksAddon ? window.WebLinksAddon.WebLinksAddon : null;

// Color palette for projects/sessions
const COLORS = [
  '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#1abc9c', '#3498db',
  '#9b59b6', '#e91e63', '#00bcd4', '#8bc34a', '#ff9800', '#795548',
];

// State
let projects = [];
let activeProjectId = null;
let sessions = new Map(); // id -> { meta, terminal, fitAddon, paneEl, cleanup, color }
let activeSessionId = null;
let viewMode = 'single'; // single, project, global

// ========== Persisted Settings (split: global + per-workspace) ==========
// Global (~/.dan-ide/settings.json): activeProjectId, global prefs
// Workspace (<project>/.dan-ide/settings.json): panels, viewMode, cli, browser, etc.
let _globalSettings = {};
let _workspaceSettings = {};

const WORKSPACE_KEYS = ['visiblePanels', 'panelSizes', 'cliSelect', 'roleSelect', 'browserUrl', 'activeSessionId'];

async function loadSettings() {
  _globalSettings = await window.api.loadSettings();
  return _globalSettings;
}

async function loadWorkspaceSettings() {
  if (!activeProjectId) { _workspaceSettings = {}; return; }
  _workspaceSettings = await window.api.loadWorkspaceSettings(activeProjectId);
}

function getSetting(key) {
  if (WORKSPACE_KEYS.includes(key)) {
    return _workspaceSettings[key] !== undefined ? _workspaceSettings[key] : _globalSettings[key];
  }
  return _globalSettings[key];
}

function saveSettings(patch) {
  const wsPatch = {};
  const globalPatch = {};
  for (const [k, v] of Object.entries(patch)) {
    if (WORKSPACE_KEYS.includes(k) && activeProjectId) {
      wsPatch[k] = v;
    } else {
      globalPatch[k] = v;
    }
  }

  // Save workspace settings to global workspace dir
  if (Object.keys(wsPatch).length > 0 && activeProjectId) {
    Object.assign(_workspaceSettings, wsPatch);
    window.api.saveWorkspaceSettings(activeProjectId, wsPatch);
  }

  // Save global settings
  if (Object.keys(globalPatch).length > 0) {
    Object.assign(_globalSettings, globalPatch);
    window.api.saveSettings(globalPatch);
  }
}

async function restoreSettings() {
  await loadSettings();
  if (_globalSettings.activeProjectId) {
    activeProjectId = _globalSettings.activeProjectId;
  }
  // Load workspace settings for the active project
  await loadWorkspaceSettings();
  restoreWorkspaceConfig();
}

function restoreWorkspaceConfig() {
  const vm = getSetting('viewMode');
  if (vm) {
    viewMode = vm;
    viewModeSelect.value = viewMode;
  }
  const sid = getSetting('activeSessionId');
  if (sid) {
    activeSessionId = sid;
  }
  const cli = getSetting('cliSelect');
  if (cli) {
    cliSelect.value = cli;
  }
  const role = getSetting('roleSelect');
  if (role) {
    roleSelect.value = role;
  }
  // Restore browser URL
  const bUrlVal = getSetting('browserUrl');
  if (bUrlVal && bUrlVal !== 'about:blank') {
    const bUrl = document.getElementById('browser-url');
    const bWebview = document.getElementById('browser-webview');
    if (bUrl) bUrl.value = bUrlVal;
    if (bWebview) bWebview.src = bUrlVal;
  }
  // Restore panel visibility
  const visiblePanels = getSetting('visiblePanels') || { agents: true, messages: false, files: false, browser: false };
  document.querySelectorAll('.panel-btn').forEach((btn) => {
    const panel = btn.dataset.panel;
    const visible = !!visiblePanels[panel];
    btn.classList.toggle('active', visible);
    const panelEl = document.getElementById(`panel-${panel}`);
    if (panelEl) {
      if (visible) {
        panelEl.classList.remove('hidden');
      } else {
        panelEl.classList.add('hidden');
        panelEl.style.flex = '';
        panelEl.style.width = '';
      }
    }
  });
  document.querySelectorAll('.panel:not(.hidden)').forEach((p) => {
    p.style.flex = '1';
    p.style.width = '';
  });
  updateResizeHandles();
}

// DOM refs
const drawer = document.getElementById('drawer');
const drawerOverlay = document.getElementById('drawer-overlay');
const projectListEl = document.getElementById('project-list');
const sessionListEl = document.getElementById('session-list');
const sessionTabsEl = document.getElementById('session-tabs');
const terminalContainerEl = document.getElementById('terminal-container');
const noSessionMsg = document.getElementById('no-session-msg');
const btnWorkspace = document.getElementById('btn-workspace');
const btnCloseDrawer = document.getElementById('btn-close-drawer');
const btnAddProject = document.getElementById('btn-add-project');
const btnNewSession = document.getElementById('btn-new-session');
const cliSelect = document.getElementById('cli-select');
const roleSelect = document.getElementById('role-select');
const viewModeSelect = document.getElementById('view-mode');

// Edit modal
const editModal = document.getElementById('edit-modal');
const editTitle = document.getElementById('edit-modal-title');
const editNameInput = document.getElementById('edit-name-input');
const editColorSwatches = document.getElementById('edit-color-swatches');
const editConfirm = document.getElementById('edit-confirm');
const editCancel = document.getElementById('edit-cancel');

let editCallback = null;
let editSelectedColor = null;

// ========== Init ==========
async function init() {
  // Wire up event listeners immediately (before async work that might fail)
  btnWorkspace.addEventListener('click', openDrawer);
  btnCloseDrawer.addEventListener('click', closeDrawer);
  drawerOverlay.addEventListener('click', closeDrawer);
  btnAddProject.addEventListener('click', addProject);
  btnNewSession.addEventListener('click', newSession);
  viewModeSelect.addEventListener('change', (e) => {
    viewMode = e.target.value;
    saveSettings({ viewMode });
    renderTabs();
    applyViewMode();
  });
  cliSelect.addEventListener('change', () => saveSettings({ cliSelect: cliSelect.value }));
  roleSelect.addEventListener('change', () => saveSettings({ roleSelect: roleSelect.value }));

  projects = await window.api.listProjects();

  // Restore view settings (view mode, active project, etc)
  await restoreSettings();

  // Restore previous sessions from saved state
  await restoreSessions();

  renderDrawer();
  renderTabs();
  applyViewMode();

  // Panel toggles (each panel independently togglable)
  document.getElementById('panel-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('.panel-btn');
    if (!btn) return;
    const panel = btn.dataset.panel;
    btn.classList.toggle('active');
    togglePanel(panel, btn.classList.contains('active'));
  });

  // Load file tree if files panel is visible on startup
  const visiblePanels = getSetting('visiblePanels') || { agents: true };
  if (visiblePanels.files && activeProjectId) {
    const project = projects.find((p) => p.id === activeProjectId);
    if (project && window.editorPanel) {
      window.editorPanel.loadFileTree(project.path);
    }
  }

  // Start messages/canvas polling if swarm panel is visible on startup
  if (visiblePanels.swarm && window.IDE.swarm) {
    window.IDE.swarm.startMessagesPolling();
    window.IDE.swarm.startCanvasRendering();
  }

  // Setup resize handles
  initResizeHandles();

  // Edit modal
  editCancel.addEventListener('click', () => { editModal.classList.add('hidden'); });
  editConfirm.addEventListener('click', () => {
    if (editCallback) editCallback(editNameInput.value, editSelectedColor);
    editModal.classList.add('hidden');
  });
  editNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') editConfirm.click();
    if (e.key === 'Escape') editCancel.click();
  });
  editColorSwatches.innerHTML = COLORS.map((c) =>
    `<div class="color-swatch" data-color="${c}" style="background:${c}"></div>`
  ).join('');
  editColorSwatches.addEventListener('click', (e) => {
    const swatch = e.target.closest('.color-swatch');
    if (swatch) {
      editSelectedColor = swatch.dataset.color;
      editColorSwatches.querySelectorAll('.color-swatch').forEach((s) => s.classList.remove('selected'));
      swatch.classList.add('selected');
    }
  });

  // Resize handler
  let resizeDebounce = null;
  window.addEventListener('resize', () => {
    fitAllVisible();
    if (resizeDebounce) clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(() => {
      applyViewMode();
    }, 100);
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', handleGlobalKeydown);

  // File watcher - watch active project
  if (activeProjectId) {
    const project = projects.find((p) => p.id === activeProjectId);
    if (project) startFileWatcher(project.path);
  }

  // Update status bar
  updateStatusBar();
}

// ========== Restore Sessions ==========
async function restoreSessions() {
  // First try live sessions from main process (survives page refresh)
  let savedState = await window.api.listAllSessions();
  let isLive = savedState && savedState.length > 0;

  // If no live sessions, try loading from disk (app restart case)
  if (!isLive) {
    savedState = await window.api.loadSessionState();
    if (savedState) {
      // Only restore sessions that were running when the app closed
      // (interrupted by shutdown). Skip sessions that had already stopped/crashed.
      savedState = savedState.filter((s) => s.status === 'running');
      savedState = savedState.map((s) => ({ ...s, status: 'stopped' }));
    }
  }
  if (!savedState || savedState.length === 0) return;

  for (const meta of savedState) {
    // Skip if already restored (prevent duplicates on reload)
    if (sessions.has(meta.id)) continue;

    if (meta.status === 'running' && isLive) {
      // Live session (page refresh) — reconnect to existing PTY
      await restoreLiveSession(meta);
    } else {
      // Dead session (app restart) — show history and auto-restart
      await restoreDeadSession(meta);
    }

    if (!activeProjectId && meta.projectId) {
      activeProjectId = meta.projectId;
    }
  }

  // Set active session to first available
  if (sessions.size > 0) {
    const firstId = sessions.keys().next().value;
    activeSessionId = firstId;
  }

  if (sessions.size > 0) {
    noSessionMsg.style.display = 'none';
  }
}

async function restoreLiveSession(meta) {
  const { terminal, fitAddon, paneEl } = await createTerminalPane(meta);

  // Replay history so far
  try {
    const history = await window.api.getSessionHistory(meta.id);
    if (history) terminal.write(history);
  } catch (e) {}

  // Wire live I/O
  terminal.onData((data) => window.api.writeSession(meta.id, data));
  terminal.onResize(({ cols, rows }) => window.api.resizeSession(meta.id, cols, rows));

  const cleanupData = window.api.onSessionData(meta.id, (data) => terminal.write(data));
  const cleanupExit = window.api.onSessionExit(meta.id, (code) => {
    terminal.write(`\r\n\x1b[33m[Agent exited with code ${code}]\x1b[0m\r\n`);
    const s = sessions.get(meta.id);
    if (s) {
      s.meta.status = 'stopped';
      updatePaneStatus(s);
    }
    renderDrawer();
    renderTabs();
    updateStatusBar();
    showToast(`Agent "${meta.name}" exited (code ${code})`);
  });

  sessions.set(meta.id, {
    meta,
    terminal,
    fitAddon,
    paneEl,
    cleanup: () => { cleanupData(); cleanupExit(); },
  });

  paneEl.classList.remove('visible');
}

async function restoreDeadSession(meta) {
  // Read history BEFORE creating new session (create overwrites state file)
  let history = '';
  if (meta.historyFile) {
    try {
      history = await window.api.getHistoryByPath(meta.historyFile);
    } catch (e) {}
  }

  // Re-create the session, resuming previous conversation if supported
  const newMeta = await window.api.createSession({
    name: meta.name,
    projectId: meta.projectId,
    projectPath: meta.projectPath,
    cli: meta.cliKey || meta.cli, // use original key, not resolved path
    role: undefined,
    resume: true,
    claudeSessionId: meta.claudeSessionId,
  });

  const { terminal, fitAddon, paneEl } = await createTerminalPane(newMeta);

  // Show previous history as context, then separator
  if (history) {
    terminal.write(history);
    terminal.write(`\r\n\x1b[90m${'─'.repeat(60)}\x1b[0m\r\n`);
    terminal.write(`\x1b[33m[Agent restored — new process started]\x1b[0m\r\n\r\n`);
  }

  // Wire live I/O to the NEW session
  terminal.onData((data) => window.api.writeSession(newMeta.id, data));
  terminal.onResize(({ cols, rows }) => window.api.resizeSession(newMeta.id, cols, rows));

  const cleanupData = window.api.onSessionData(newMeta.id, (data) => terminal.write(data));
  const cleanupExit = window.api.onSessionExit(newMeta.id, (code) => {
    terminal.write(`\r\n\x1b[33m[Agent exited with code ${code}]\x1b[0m\r\n`);
    const s = sessions.get(newMeta.id);
    if (s) {
      s.meta.status = 'stopped';
      updatePaneStatus(s);
    }
    renderDrawer();
    renderTabs();
    updateStatusBar();
    showToast(`Agent "${newMeta.name}" exited (code ${code})`);
  });

  sessions.set(newMeta.id, {
    meta: newMeta,
    terminal,
    fitAddon,
    paneEl,
    cleanup: () => { cleanupData(); cleanupExit(); },
  });

  paneEl.classList.remove('visible');
}

// Open a URL in the built-in browser panel
function _openUrlInBrowserPanel(url) {
  const browserPanel = document.getElementById('panel-browser');
  const browserUrlInput = document.getElementById('browser-url');
  const webview = document.getElementById('browser-webview');
  if (!webview) return;

  // Ensure browser panel is visible
  if (browserPanel && browserPanel.classList.contains('hidden')) {
    const btn = document.querySelector('.panel-btn[data-panel="browser"]');
    if (btn) {
      btn.classList.add('active');
      togglePanel('browser', true);
    }
  }

  // Navigate
  if (browserUrlInput) browserUrlInput.value = url;
  webview.src = url;
}

// Open a file in the files panel editor
function _openFileInEditor(filePath) {
  const filesPanel = document.getElementById('panel-files');

  // Ensure files panel is visible
  if (filesPanel && filesPanel.classList.contains('hidden')) {
    const btn = document.querySelector('.panel-btn[data-panel="files"]');
    if (btn) {
      btn.classList.add('active');
      togglePanel('files', true);
    }
  }

  if (window.editorPanel && window.editorPanel.openFile) {
    window.editorPanel.openFile(filePath);
  }
}

// Register file path links on a terminal
function _setupFileLinks(terminal, meta) {
  // xterm v5 registerLinkProvider expects { provideLinks(lineNumber, callback) }
  // The callback receives an array of ILink objects: { range, text, activate }
  terminal.registerLinkProvider({
    provideLinks(lineNumber, callback) {
      const buffer = terminal.buffer.active;
      const line = buffer.getLine(lineNumber - 1);
      if (!line) { callback(undefined); return; }
      const text = line.translateToString(true);
      const links = [];

      // Match absolute file paths (with optional :line:col)
      const absPathRe = /((?:\/[\w.\-@]+){2,}(?:\.\w+)?)(?::(\d+))?(?::(\d+))?/g;
      let match;
      while ((match = absPathRe.exec(text)) !== null) {
        const filePath = match[1];
        if (filePath.startsWith('/dev/') || filePath.startsWith('/proc/')) continue;
        if (!filePath.includes('.') && !filePath.endsWith('Makefile') && !filePath.endsWith('Dockerfile')) continue;
        links.push({
          range: {
            start: { x: match.index + 1, y: lineNumber },
            end: { x: match.index + match[0].length + 1, y: lineNumber },
          },
          text: match[0],
          activate() {
            _openFileInEditor(filePath);
          },
        });
      }

      // Match relative paths (./foo/bar.ext or src/foo.ext)
      const relPathRe = /(?:^|[\s"'`(])((?:\.\/|\w[\w.\-]*\/)[\w.\-@/]+(?:\.\w+))(?::(\d+))?(?::(\d+))?/g;
      while ((match = relPathRe.exec(text)) !== null) {
        const relPath = match[1];
        const project = projects.find(p => p.id === (meta.projectId || activeProjectId));
        if (!project) continue;
        const fullPath = project.path + '/' + relPath.replace(/^\.\//, '');
        const startX = match.index + (match[0].length - match[1].length - (match[2] ? match[2].length + 1 : 0) - (match[3] ? match[3].length + 1 : 0)) + 1;
        links.push({
          range: {
            start: { x: match.index + 1, y: lineNumber },
            end: { x: match.index + match[0].length + 1, y: lineNumber },
          },
          text: match[0],
          activate() {
            _openFileInEditor(fullPath);
          },
        });
      }

      callback(links.length > 0 ? links : undefined);
    },
  });
}

async function createTerminalPane(meta) {
  const terminal = new Terminal({
    theme: {
      background: '#1a1a2e',
      foreground: '#e0e0e0',
      cursor: '#4ecdc4',
      selectionBackground: '#2a4a6a',
      black: '#1a1a2e',
      red: '#e74c3c',
      green: '#4ecdc4',
      yellow: '#f39c12',
      blue: '#3498db',
      magenta: '#9b59b6',
      cyan: '#1abc9c',
      white: '#ecf0f1',
    },
    fontSize: 13,
    fontFamily: 'JetBrains Mono, Menlo, Monaco, Courier New, monospace',
    cursorBlink: true,
    scrollback: 10000,
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  if (WebLinksAddon) {
    terminal.loadAddon(new WebLinksAddon((event, url) => {
      event.preventDefault();
      _openUrlInBrowserPanel(url);
    }));
  }
  // Register file path link provider
  _setupFileLinks(terminal, meta);

  const color = getSessionColor(meta.id) || getProjectColor(meta.projectId);
  const cliLabel = meta.cliKey || meta.cli || '';
  const isRunning = meta.status !== 'stopped';
  const paneEl = document.createElement('div');
  paneEl.className = 'terminal-pane';
  paneEl.id = `terminal-${meta.id}`;
  paneEl.innerHTML = `
    <div class="pane-header">
      <div class="pane-color" style="background:${color}"></div>
      <span class="pane-status-dot${isRunning ? '' : ' stopped'}"></span>
      <span class="pane-cli-label">${escapeHtml(cliLabel)}</span>
      <span class="pane-name">${escapeHtml(meta.name)}</span>
    </div>
    <div class="pane-terminal"></div>
    <div class="pane-send-input">
      <input type="text" placeholder="Send to agent..." data-session-id="${meta.id}">
    </div>
  `;
  terminalContainerEl.appendChild(paneEl);

  // Send input handler
  const sendInput = paneEl.querySelector('.pane-send-input input');
  sendInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && sendInput.value) {
      window.api.writeSession(meta.id, sendInput.value + '\n');
      sendInput.value = '';
    }
  });

  // Right-click to copy selection, then clear it
  terminal.element = null; // will be set after open
  terminal.attachCustomKeyEventHandler(() => true); // default
  // We attach contextmenu after open below

  // Must be visible for xterm to measure properly
  paneEl.classList.add('visible');
  const termContainer = paneEl.querySelector('.pane-terminal');
  terminal.open(termContainer);

  // Right-click copies selection and clears it
  termContainer.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const selection = terminal.getSelection();
    if (selection) {
      navigator.clipboard.writeText(selection);
      terminal.clearSelection();
      showToast('Copied to clipboard');
    }
  });
  await new Promise((r) => setTimeout(r, 50));
  fitAddon.fit();

  // Clicking anywhere in the pane focuses this agent
  paneEl.addEventListener('mousedown', () => {
    if (activeSessionId !== meta.id) {
      activateSession(meta.id);
    }
  });

  // Click header to open edit modal for this agent
  paneEl.querySelector('.pane-header').addEventListener('click', () => {
    const s = sessions.get(meta.id);
    if (!s) return;
    const currentColor = getSessionColor(meta.id) || getProjectColor(meta.projectId);
    showEditModal('Edit Agent', s.meta.name, currentColor, (newName, newColor) => {
      if (newName) { s.meta.name = newName; window.api.renameSession(meta.id, newName); }
      if (newColor) saveSessionColor(meta.id, newColor);
      // Update this pane's header
      paneEl.querySelector('.pane-name').textContent = newName || s.meta.name;
      if (newColor) paneEl.querySelector('.pane-color').style.background = newColor;
      renderTabs();
      renderDrawer();
    });
  });

  return { terminal, fitAddon, paneEl };
}

// ========== Drawer ==========
function openDrawer() {
  drawer.classList.remove('closed');
  drawerOverlay.classList.remove('hidden');
}

function closeDrawer() {
  drawer.classList.add('closed');
  drawerOverlay.classList.add('hidden');
}

// ========== Projects ==========
async function addProject() {
  const folderPath = await window.api.openFolderDialog();
  if (!folderPath) return;
  const project = await window.api.addProject(folderPath);
  // Assign a color
  project.color = COLORS[projects.length % COLORS.length];
  projects = await window.api.listProjects();
  // Persist color locally
  saveProjectColor(project.id, project.color);
  renderDrawer();
  selectProject(project.id);
}

async function selectProject(id) {
  activeProjectId = id;
  saveSettings({ activeProjectId: id });

  // Load and restore workspace-specific layout and config
  await loadWorkspaceSettings();
  restoreWorkspaceConfig();

  // Switch activeSessionId to first agent in new project (or null)
  const projectSessions = getProjectSessions();
  if (projectSessions.length > 0) {
    activeSessionId = projectSessions[0].meta.id;
  } else {
    activeSessionId = null;
  }
  saveSettings({ activeSessionId });

  renderDrawer();
  renderTabs();
  applyViewMode();
  updateStatusBar();

  const project = projects.find((p) => p.id === id);
  if (project) {
    startFileWatcher(project.path);
    if (window.editorPanel) {
      window.editorPanel.loadFileTree(project.path);
    }
  }
}

function getProjectColor(id) {
  const colors = _globalSettings.projectColors || {};
  return colors[id] || '#3498db';
}

function saveProjectColor(id, color) {
  const colors = _globalSettings.projectColors || {};
  colors[id] = color;
  saveSettings({ projectColors: colors });
}

function getSessionColor(id) {
  const colors = _globalSettings.sessionColors || {};
  return colors[id] || null;
}

function saveSessionColor(id, color) {
  const colors = _globalSettings.sessionColors || {};
  colors[id] = color;
  saveSettings({ sessionColors: colors });
}

function renderDrawer() {
  // Projects
  projectListEl.innerHTML = '';
  for (const project of projects) {
    const color = getProjectColor(project.id);
    const el = document.createElement('div');
    el.className = `project-item${project.id === activeProjectId ? ' active' : ''}`;
    el.innerHTML = `
      <div class="color-dot" style="background:${color}" title="Change color"></div>
      <div class="project-info">
        <div class="project-name">${escapeHtml(project.name)}</div>
        <div class="project-path">${escapeHtml(shortenPath(project.path))}</div>
      </div>
      <div class="project-actions">
        <button class="btn-rename" title="Rename">&#9998;</button>
        <button class="btn-remove" title="Remove">&times;</button>
      </div>
    `;
    const openProjectEdit = (e) => {
      e.stopPropagation();
      showEditModal('Edit Project', project.name, getProjectColor(project.id), (newName, newColor) => {
        if (newName) project.name = newName;
        if (newColor) saveProjectColor(project.id, newColor);
        renderDrawer();
        renderTabs();
        applyViewMode();
      });
    };
    el.querySelector('.color-dot').addEventListener('click', openProjectEdit);
    el.querySelector('.btn-rename').addEventListener('click', openProjectEdit);
    el.querySelector('.btn-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      window.api.removeProject(project.id);
      projects = projects.filter((p) => p.id !== project.id);
      if (activeProjectId === project.id) activeProjectId = null;
      renderDrawer();
      renderTabs();
      applyViewMode();
    });
    el.addEventListener('click', () => { selectProject(project.id); closeDrawer(); });
    projectListEl.appendChild(el);
  }

  // Sessions
  sessionListEl.innerHTML = '';
  const allSessions = Array.from(sessions.values());
  const filteredSessions = activeProjectId
    ? allSessions.filter((s) => s.meta.projectId === activeProjectId)
    : allSessions;

  for (const s of filteredSessions) {
    const color = getSessionColor(s.meta.id) || getProjectColor(s.meta.projectId);
    const el = document.createElement('div');
    el.className = `session-drawer-item${s.meta.id === activeSessionId ? ' active' : ''}`;
    el.innerHTML = `
      <div class="color-dot" style="background:${color}" title="Change color"></div>
      <span class="status-dot ${s.meta.status === 'running' ? '' : 'stopped'}"></span>
      <div class="session-info">
        <div class="session-name">${escapeHtml(s.meta.name)}</div>
        <div class="session-meta">${escapeHtml(s.meta.cliKey || s.meta.cli)} ${s.meta.status}</div>
      </div>
      <div class="session-actions">
        <button class="btn-rename" title="Rename">&#9998;</button>
        <button class="btn-stop" title="Stop">&times;</button>
      </div>
    `;
    const openAgentEdit = (e) => {
      e.stopPropagation();
      const currentColor = getSessionColor(s.meta.id) || getProjectColor(s.meta.projectId);
      showEditModal('Edit Agent', s.meta.name, currentColor, (newName, newColor) => {
        if (newName) { s.meta.name = newName; window.api.renameSession(s.meta.id, newName); }
        if (newColor) saveSessionColor(s.meta.id, newColor);
        renderDrawer();
        renderTabs();
        applyViewMode();
      });
    };
    el.querySelector('.color-dot').addEventListener('click', openAgentEdit);
    el.querySelector('.btn-rename').addEventListener('click', openAgentEdit);
    el.querySelector('.btn-stop').addEventListener('click', (e) => {
      e.stopPropagation();
      stopSession(s.meta.id);
    });
    el.addEventListener('click', () => {
      activateSession(s.meta.id);
      closeDrawer();
    });
    sessionListEl.appendChild(el);
  }
}

// ========== Sessions ==========
async function newSession() {
  if (!activeProjectId) {
    openDrawer();
    return;
  }
  const project = projects.find((p) => p.id === activeProjectId);
  if (!project) return;

  const cli = cliSelect.value;
  const role = roleSelect.value || undefined;
  const name = `${cli}${role ? '-' + role : ''}-${Date.now().toString(36).slice(-4)}`;

  const meta = await window.api.createSession({
    name,
    projectId: activeProjectId,
    projectPath: project.path,
    cli,
    role,
  });

  const { terminal, fitAddon, paneEl } = await createTerminalPane(meta);

  // Wire I/O
  terminal.onData((data) => window.api.writeSession(meta.id, data));
  terminal.onResize(({ cols, rows }) => window.api.resizeSession(meta.id, cols, rows));

  const cleanupData = window.api.onSessionData(meta.id, (data) => terminal.write(data));
  const cleanupExit = window.api.onSessionExit(meta.id, (code) => {
    terminal.write(`\r\n\x1b[33m[Agent exited with code ${code}]\x1b[0m\r\n`);
    const s = sessions.get(meta.id);
    if (s) {
      s.meta.status = 'stopped';
      updatePaneStatus(s);
    }
    renderDrawer();
    renderTabs();
    updateStatusBar();
    showToast(`Agent "${meta.name}" exited (code ${code})`);
  });

  sessions.set(meta.id, {
    meta,
    terminal,
    fitAddon,
    paneEl,
    cleanup: () => { cleanupData(); cleanupExit(); },
  });

  activateSession(meta.id);
  renderDrawer();
  renderTabs();
  applyViewMode();
  updateStatusBar();
  noSessionMsg.style.display = 'none';

  // Refresh browser agent dropdown if visible
  if (window.IDE.browser) {
    window.IDE.browser.refreshAgentDropdown();
  }
}

function activateSession(id) {
  activeSessionId = id;
  saveSettings({ activeSessionId: id });
  // In single mode, only show the active one
  if (viewMode === 'single') {
    applyViewMode();
  }
  renderTabs();
  renderDrawer();

  // Highlight the focused agent pane
  document.querySelectorAll('.terminal-pane.focused').forEach(p => p.classList.remove('focused'));
  const active = sessions.get(id);
  if (active) {
    active.paneEl.classList.add('focused');
    setTimeout(() => {
      active.fitAddon.fit();
      active.terminal.focus();
    }, 20);
  }
}

async function stopSession(id) {
  await window.api.stopSession(id);
  await window.api.removeSession(id);
  const s = sessions.get(id);
  if (s) {
    s.paneEl.remove();
    s.cleanup();
    sessions.delete(id);
  }
  // Pick a new active session if we just closed the active one
  if (activeSessionId === id) {
    const first = sessions.keys().next().value;
    activeSessionId = first || null;
  }
  if (sessions.size === 0) {
    noSessionMsg.style.display = 'flex';
  }
  renderDrawer();
  renderTabs();
  applyViewMode();
  updateStatusBar();
}

// ========== Optimal Grid Layout ==========
/**
 * Compute the best rows x cols for N items in a container,
 * targeting a ~16:9 aspect ratio per cell (ideal terminal shape).
 * Returns { rows, cols } that minimizes wasted space and
 * keeps cells closest to the target aspect ratio.
 */
function computeOptimalGrid(container, n) {
  if (n <= 1) return { rows: 1, cols: 1 };

  const rect = container.getBoundingClientRect();
  const W = rect.width || 800;
  const H = rect.height || 600;
  // Target: portrait terminal cells (slightly taller than wide).
  // 2:3 ratio means cells flip to stacking when side-by-side would be too narrow.
  const targetAspect = 2 / 3; // width/height = 0.667

  let best = { rows: 1, cols: n, score: Infinity };

  for (let rows = 1; rows <= n; rows++) {
    const cols = Math.ceil(n / rows);
    // Cell dimensions given this layout
    const cellW = W / cols;
    const cellH = H / rows;
    const cellAspect = cellW / cellH;

    // How far from the ideal aspect ratio (log scale for symmetry)
    const aspectDiff = Math.abs(Math.log(cellAspect / targetAspect));
    // Penalty for wasted grid cells
    const emptyCells = (rows * cols) - n;
    const score = aspectDiff + (emptyCells * 0.4);

    if (score < best.score) {
      best = { rows, cols, score };
    }
  }

  return { rows: best.rows, cols: best.cols };
}

// ========== View Modes ==========
function applyViewMode() {
  // If activeSessionId doesn't exist in sessions, pick the first one from the current project
  if (activeSessionId && !sessions.has(activeSessionId)) {
    const projectSessions = getProjectSessions();
    activeSessionId = projectSessions.length > 0 ? projectSessions[0].meta.id : null;
  }

  // If activeProjectId doesn't match any project, pick from active session
  if (activeProjectId && !projects.find((p) => p.id === activeProjectId)) {
    const active = sessions.get(activeSessionId);
    if (active) activeProjectId = active.meta.projectId;
  }

  // Determine which sessions to show
  let visibleSessions = [];

  if (viewMode === 'single') {
    const active = sessions.get(activeSessionId);
    if (active) visibleSessions = [active];
  } else if (viewMode === 'project') {
    visibleSessions = getProjectSessions();
  } else if (viewMode === 'global') {
    visibleSessions = Array.from(sessions.values());
  }

  // Hide all panes
  for (const s of sessions.values()) {
    s.paneEl.classList.remove('visible');
  }

  // Show visible ones
  for (const s of visibleSessions) {
    s.paneEl.classList.add('visible');
  }

  // Calculate optimal grid layout based on container dimensions
  const count = visibleSessions.length;
  terminalContainerEl.className = '';
  terminalContainerEl.style.gridTemplateColumns = '';
  terminalContainerEl.style.gridTemplateRows = '';
  terminalContainerEl.style.gridTemplateAreas = '';

  // Reset any previous grid-area on panes
  for (const s of sessions.values()) {
    s.paneEl.style.gridArea = '';
  }

  if (count > 0) {
    const layout = computeOptimalGrid(terminalContainerEl, count);
    terminalContainerEl.style.gridTemplateColumns = `repeat(${layout.cols}, 1fr)`;
    terminalContainerEl.style.gridTemplateRows = `repeat(${layout.rows}, 1fr)`;

    // Assign grid positions; last item spans remaining columns if row not full
    let idx = 0;
    for (let r = 0; r < layout.rows; r++) {
      const itemsInRow = (r < layout.rows - 1)
        ? layout.cols
        : count - (layout.cols * (layout.rows - 1));
      for (let c = 0; c < itemsInRow; c++) {
        if (idx >= visibleSessions.length) break;
        const pane = visibleSessions[idx].paneEl;
        const rowStart = r + 1;
        const colStart = c + 1;
        // If this is the last item in the last row and doesn't fill it, span remaining
        if (r === layout.rows - 1 && itemsInRow < layout.cols && c === itemsInRow - 1) {
          const colEnd = layout.cols + 1;
          pane.style.gridArea = `${rowStart} / ${colStart} / ${rowStart + 1} / ${colEnd}`;
        } else if (r === layout.rows - 1 && itemsInRow < layout.cols) {
          // Distribute last row items evenly: each spans proportional cols
          const spanCols = Math.floor(layout.cols / itemsInRow);
          const extraCols = layout.cols % itemsInRow;
          let actualStart = 1;
          for (let i = 0; i < c; i++) {
            actualStart += spanCols + (i < extraCols ? 1 : 0);
          }
          const actualSpan = spanCols + (c < extraCols ? 1 : 0);
          pane.style.gridArea = `${rowStart} / ${actualStart} / ${rowStart + 1} / ${actualStart + actualSpan}`;
        } else {
          pane.style.gridArea = `${rowStart} / ${colStart} / ${rowStart + 1} / ${colStart + 1}`;
        }
        idx++;
      }
    }
  }

  // Show/hide no-session message
  if (visibleSessions.length === 0) {
    noSessionMsg.style.display = 'flex';
    noSessionMsg.textContent = 'No active agents';
  } else {
    noSessionMsg.style.display = 'none';
  }

  // Fit all visible terminals and focus active (after layout settles)
  requestAnimationFrame(() => {
    // Recalculate grid now that container has real dimensions
    if (count > 0) {
      const layout = computeOptimalGrid(terminalContainerEl, count);
      terminalContainerEl.style.gridTemplateColumns = `repeat(${layout.cols}, 1fr)`;
      terminalContainerEl.style.gridTemplateRows = `repeat(${layout.rows}, 1fr)`;

      let idx = 0;
      for (let r = 0; r < layout.rows; r++) {
        const itemsInRow = (r < layout.rows - 1)
          ? layout.cols
          : count - (layout.cols * (layout.rows - 1));
        for (let c = 0; c < itemsInRow; c++) {
          if (idx >= visibleSessions.length) break;
          const pane = visibleSessions[idx].paneEl;
          const rowStart = r + 1;
          if (r === layout.rows - 1 && itemsInRow < layout.cols) {
            const spanCols = Math.floor(layout.cols / itemsInRow);
            const extraCols = layout.cols % itemsInRow;
            let actualStart = 1;
            for (let i = 0; i < c; i++) {
              actualStart += spanCols + (i < extraCols ? 1 : 0);
            }
            const actualSpan = spanCols + (c < extraCols ? 1 : 0);
            pane.style.gridArea = `${rowStart} / ${actualStart} / ${rowStart + 1} / ${actualStart + actualSpan}`;
          } else {
            const colStart = c + 1;
            pane.style.gridArea = `${rowStart} / ${colStart} / ${rowStart + 1} / ${colStart + 1}`;
          }
          idx++;
        }
      }
    }

    fitAllVisible();
    const active = sessions.get(activeSessionId);
    if (active && active.paneEl.classList.contains('visible')) {
      active.terminal.focus();
    }
  });
}

function getProjectSessions() {
  return Array.from(sessions.values()).filter(
    (s) => s.meta.projectId === activeProjectId
  );
}

// ========== Context Menu ==========
function showContextMenu(x, y, items) {
  // Remove any existing menu
  const existing = document.getElementById('context-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.id = 'context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  for (const item of items) {
    const el = document.createElement('div');
    el.className = 'context-menu-item';
    el.textContent = item.label;
    el.addEventListener('click', () => {
      menu.remove();
      item.action();
    });
    menu.appendChild(el);
  }

  document.body.appendChild(menu);

  // Close on any click outside
  const closeMenu = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener('mousedown', closeMenu);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', closeMenu), 0);
}

// ========== Panel Visibility & Resizing ==========
function togglePanel(panelName, visible) {
  const panelEl = document.getElementById(`panel-${panelName}`);
  if (!panelEl) return;

  if (visible) {
    panelEl.classList.remove('hidden');
  } else {
    panelEl.classList.add('hidden');
    // Clear fixed width so it doesn't take space
    panelEl.style.flex = '';
    panelEl.style.width = '';
  }

  // Reset remaining visible panels to flex:1 so they fill available space
  document.querySelectorAll('.panel:not(.hidden)').forEach((p) => {
    p.style.flex = '1';
    p.style.width = '';
  });

  // If showing files panel, load the tree
  if (visible && panelName === 'files') {
    const project = projects.find((p) => p.id === activeProjectId);
    if (project && window.editorPanel) {
      window.editorPanel.loadFileTree(project.path);
    }
  }

  // Swarm panel (messages + canvas)
  if (panelName === 'swarm' && window.IDE.swarm) {
    if (visible) {
      window.IDE.swarm.startMessagesPolling();
      window.IDE.swarm.startCanvasRendering();
    } else {
      window.IDE.swarm.stopMessagesPolling();
      window.IDE.swarm.stopCanvasRendering();
    }
  }


  // Update resize handle visibility
  updateResizeHandles();

  // Save state
  const currentPanels = getSetting('visiblePanels') || { agents: true, files: true, browser: false };
  currentPanels[panelName] = visible;
  saveSettings({ visiblePanels: currentPanels });

  // Refit terminals
  setTimeout(fitAllVisible, 50);
}

function updateResizeHandles() {
  // Get visible panels in DOM order
  const allPanels = Array.from(document.querySelectorAll('#panels-container > .panel'));
  const visiblePanels = allPanels.filter(p => !p.classList.contains('hidden'));
  const handles = Array.from(document.querySelectorAll('.resize-handle'));

  // Hide all handles first
  handles.forEach(h => h.classList.add('hidden'));

  // Assign handles to actual visible adjacent pairs
  for (let i = 0; i < visiblePanels.length - 1 && i < handles.length; i++) {
    const left = visiblePanels[i].id.replace('panel-', '');
    const right = visiblePanels[i + 1].id.replace('panel-', '');
    handles[i].dataset.left = left;
    handles[i].dataset.right = right;
    handles[i].classList.remove('hidden');
  }
}

function initResizeHandles() {
  const handles = document.querySelectorAll('.resize-handle');
  handles.forEach((handle) => {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      handle.classList.add('dragging');
      document.body.classList.add('resizing');

      const leftPanel = document.getElementById(`panel-${handle.dataset.left}`);
      const rightPanel = document.getElementById(`panel-${handle.dataset.right}`);

      const startX = e.clientX;
      const leftStart = leftPanel.getBoundingClientRect().width;
      const rightStart = rightPanel.getBoundingClientRect().width;

      const onMouseMove = (e2) => {
        const dx = e2.clientX - startX;
        const newLeft = Math.max(150, leftStart + dx);
        const newRight = Math.max(150, rightStart - dx);

        leftPanel.style.flex = 'none';
        leftPanel.style.width = `${newLeft}px`;
        rightPanel.style.flex = 'none';
        rightPanel.style.width = `${newRight}px`;

        fitAllVisible();
      };

      const onMouseUp = () => {
        handle.classList.remove('dragging');
        document.body.classList.remove('resizing');
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);

        // Save panel sizes as percentages of container width
        const container = document.getElementById('panels-container');
        const containerWidth = container.getBoundingClientRect().width;
        const sizes = {};
        document.querySelectorAll('.panel:not(.hidden)').forEach((p) => {
          const name = p.id.replace('panel-', '');
          sizes[name] = p.getBoundingClientRect().width / containerWidth;
        });
        saveSettings({ panelSizes: sizes });
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  });

  // Restore saved sizes only if all saved panels are currently visible
  const sizes = getSetting('panelSizes');
  if (sizes) {
    const visibleNow = [];
    document.querySelectorAll('.panel:not(.hidden)').forEach((p) => {
      visibleNow.push(p.id.replace('panel-', ''));
    });
    const savedPanels = Object.keys(sizes);
    const sameLayout = visibleNow.length > 1 &&
      visibleNow.every((name) => savedPanels.includes(name));

    if (sameLayout) {
      const container = document.getElementById('panels-container');
      const containerWidth = container.getBoundingClientRect().width;
      if (containerWidth > 0) {
        visibleNow.forEach((name) => {
          const panel = document.getElementById(`panel-${name}`);
          if (panel && sizes[name]) {
            panel.style.flex = 'none';
            panel.style.width = `${Math.round(sizes[name] * containerWidth)}px`;
          }
        });
      }
    }
  }

  updateResizeHandles();
}

function fitAllVisible() {
  for (const s of sessions.values()) {
    if (s.paneEl.classList.contains('visible')) {
      try { s.fitAddon.fit(); } catch (e) {}
    }
  }
}

// Recalculate grid layout whenever terminal container is resized
let _relayoutDebounce = null;
const _terminalResizeObserver = new ResizeObserver(() => {
  if (_relayoutDebounce) clearTimeout(_relayoutDebounce);
  _relayoutDebounce = setTimeout(() => {
    relayoutGrid();
    fitAllVisible();
  }, 60);
});
_terminalResizeObserver.observe(terminalContainerEl);

/**
 * Recalculate and apply the grid layout based on current container size.
 * Called by ResizeObserver whenever the agents panel changes dimensions.
 */
function relayoutGrid() {
  const visible = Array.from(sessions.values()).filter(
    (s) => s.paneEl.classList.contains('visible')
  );
  const count = visible.length;
  if (count === 0) return;

  const layout = computeOptimalGrid(terminalContainerEl, count);
  terminalContainerEl.style.gridTemplateColumns = `repeat(${layout.cols}, 1fr)`;
  terminalContainerEl.style.gridTemplateRows = `repeat(${layout.rows}, 1fr)`;

  let idx = 0;
  for (let r = 0; r < layout.rows; r++) {
    const itemsInRow = (r < layout.rows - 1)
      ? layout.cols
      : count - (layout.cols * (layout.rows - 1));
    for (let c = 0; c < itemsInRow; c++) {
      if (idx >= visible.length) break;
      const pane = visible[idx].paneEl;
      const rowStart = r + 1;
      if (r === layout.rows - 1 && itemsInRow < layout.cols) {
        const spanCols = Math.floor(layout.cols / itemsInRow);
        const extraCols = layout.cols % itemsInRow;
        let actualStart = 1;
        for (let i = 0; i < c; i++) {
          actualStart += spanCols + (i < extraCols ? 1 : 0);
        }
        const actualSpan = spanCols + (c < extraCols ? 1 : 0);
        pane.style.gridArea = `${rowStart} / ${actualStart} / ${rowStart + 1} / ${actualStart + actualSpan}`;
      } else {
        const colStart = c + 1;
        pane.style.gridArea = `${rowStart} / ${colStart} / ${rowStart + 1} / ${colStart + 1}`;
      }
      idx++;
    }
  }
}

// ========== Tabs ==========
function renderTabs() {
  sessionTabsEl.innerHTML = '';
  // In global mode, show all agents; otherwise show project agents
  const tabSessions = (viewMode === 'global')
    ? Array.from(sessions.values())
    : (activeProjectId ? getProjectSessions() : Array.from(sessions.values()));

  for (const s of tabSessions) {
    const color = getSessionColor(s.meta.id) || getProjectColor(s.meta.projectId);
    const tab = document.createElement('div');
    tab.className = `tab${s.meta.id === activeSessionId ? ' active' : ''}`;
    tab.innerHTML = `
      <span class="tab-color" style="background:${color}"></span>
      ${escapeHtml(s.meta.name)}
    `;
    tab.addEventListener('click', () => activateSession(s.meta.id));
    // Middle-click closes the agent
    tab.addEventListener('mousedown', (e) => {
      if (e.button === 1) { e.preventDefault(); stopSession(s.meta.id); }
    });
    tab.addEventListener('dblclick', () => {
      const currentColor = getSessionColor(s.meta.id) || getProjectColor(s.meta.projectId);
      showEditModal('Edit Agent', s.meta.name, currentColor, (newName, newColor) => {
        if (newName) { s.meta.name = newName; window.api.renameSession(s.meta.id, newName); }
        if (newColor) saveSessionColor(s.meta.id, newColor);
        renderTabs();
        renderDrawer();
        applyViewMode();
      });
    });
    tab.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        { label: 'Edit Agent', action: () => {
          const currentColor = getSessionColor(s.meta.id) || getProjectColor(s.meta.projectId);
          showEditModal('Edit Agent', s.meta.name, currentColor, (newName, newColor) => {
            if (newName) { s.meta.name = newName; window.api.renameSession(s.meta.id, newName); }
            if (newColor) saveSessionColor(s.meta.id, newColor);
            renderTabs(); renderDrawer(); applyViewMode();
          });
        }},
        { label: 'Close Agent', action: () => stopSession(s.meta.id) },
      ]);
    });
    sessionTabsEl.appendChild(tab);
  }

  // Enable horizontal scroll with mouse wheel on session tabs
  setupHorizontalScroll(sessionTabsEl);

  // Refresh browser agent dropdown to match visible tabs
  if (window.IDE && window.IDE.browser) {
    window.IDE.browser.refreshAgentDropdown();
  }
}

// ========== Modals ==========
function showEditModal(title, currentName, currentColor, callback) {
  editTitle.textContent = title;
  editNameInput.value = currentName;
  editSelectedColor = currentColor;
  editCallback = callback;

  // Highlight current color
  editColorSwatches.querySelectorAll('.color-swatch').forEach((s) => {
    s.classList.toggle('selected', s.dataset.color === currentColor);
  });

  editModal.classList.remove('hidden');
  setTimeout(() => { editNameInput.focus(); editNameInput.select(); }, 50);
}

// ========== Helpers ==========
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function shortenPath(p) {
  const home = '/Users/Dan.Garfield';
  if (p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}

function setupHorizontalScroll(el) {
  if (el._hasHScroll) return;
  el._hasHScroll = true;
  el.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    }
  }, { passive: false });
}

// ========== Pane Status Update ==========
function updatePaneStatus(s) {
  const dot = s.paneEl.querySelector('.pane-status-dot');
  if (dot) {
    dot.classList.toggle('stopped', s.meta.status !== 'running');
  }
}

// ========== Keyboard Shortcuts ==========
function handleGlobalKeydown(e) {
  const isMeta = e.metaKey || e.ctrlKey;

  // Escape closes drawer, project switcher, or edit modal
  if (e.key === 'Escape') {
    if (!document.getElementById('project-switcher').classList.contains('hidden')) {
      document.getElementById('project-switcher').classList.add('hidden');
      return;
    }
    if (!editModal.classList.contains('hidden')) {
      editModal.classList.add('hidden');
      return;
    }
    if (!drawer.classList.contains('closed')) {
      closeDrawer();
      return;
    }
  }

  // Cmd+1/2/3 to switch between visible agents
  if (isMeta && e.key >= '1' && e.key <= '9') {
    e.preventDefault();
    const idx = parseInt(e.key) - 1;
    const projectSessions = activeProjectId ? getProjectSessions() : Array.from(sessions.values());
    if (projectSessions[idx]) {
      activateSession(projectSessions[idx].meta.id);
    }
    return;
  }

  // Cmd+N to create new agent
  if (isMeta && e.key === 'n' && !e.shiftKey) {
    e.preventDefault();
    newSession();
    return;
  }

  // Cmd+W to close active agent
  if (isMeta && e.key === 'w') {
    e.preventDefault();
    if (activeSessionId) stopSession(activeSessionId);
    return;
  }

  // Cmd+T to toggle files panel
  if (isMeta && e.key === 't') {
    e.preventDefault();
    const btn = document.querySelector('.panel-btn[data-panel="files"]');
    if (btn) {
      btn.classList.toggle('active');
      togglePanel('files', btn.classList.contains('active'));
    }
    return;
  }

  // Cmd+B to toggle browser panel
  if (isMeta && e.key === 'b') {
    e.preventDefault();
    const btn = document.querySelector('.panel-btn[data-panel="browser"]');
    if (btn) {
      btn.classList.toggle('active');
      togglePanel('browser', btn.classList.contains('active'));
    }
    return;
  }

  // Cmd+, to open drawer
  if (isMeta && e.key === ',') {
    e.preventDefault();
    openDrawer();
    return;
  }

  // Cmd+P to open project switcher
  if (isMeta && e.key === 'p') {
    e.preventDefault();
    openProjectSwitcher();
    return;
  }
}

// ========== Toast Notifications ==========
function showToast(message, duration = 4000) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('exit');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ========== Status Bar ==========
function updateStatusBar() {
  const statusProject = document.getElementById('status-project');
  const statusAgents = document.getElementById('status-agents');

  const project = projects.find((p) => p.id === activeProjectId);
  statusProject.textContent = project ? project.name : 'No project';
  if (project) {
    const color = getProjectColor(project.id);
    btnWorkspace.innerHTML = `<span class="workspace-dot" style="background:${color}"></span>${project.name}`;
  } else {
    btnWorkspace.innerHTML = 'No project';
  }

  const runningCount = Array.from(sessions.values()).filter((s) => s.meta.status === 'running').length;
  const totalCount = sessions.size;
  statusAgents.textContent = `${runningCount}/${totalCount} agents running`;
}

// ========== Project Switcher ==========
function openProjectSwitcher() {
  const switcher = document.getElementById('project-switcher');
  const input = document.getElementById('switcher-input');
  const list = document.getElementById('switcher-list');

  switcher.classList.remove('hidden');
  input.value = '';
  input.focus();
  renderSwitcherList('');

  const onInput = () => renderSwitcherList(input.value);
  const onKeydown = (e) => {
    if (e.key === 'Escape') {
      switcher.classList.add('hidden');
      cleanup();
    } else if (e.key === 'Enter') {
      const selected = list.querySelector('.switcher-item.selected') || list.querySelector('.switcher-item');
      if (selected) {
        selected.click();
      }
      cleanup();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = list.querySelectorAll('.switcher-item');
      let idx = Array.from(items).findIndex((el) => el.classList.contains('selected'));
      items.forEach((el) => el.classList.remove('selected'));
      if (e.key === 'ArrowDown') idx = Math.min(idx + 1, items.length - 1);
      else idx = Math.max(idx - 1, 0);
      if (items[idx]) items[idx].classList.add('selected');
    }
  };

  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKeydown);

  function cleanup() {
    input.removeEventListener('input', onInput);
    input.removeEventListener('keydown', onKeydown);
  }
}

function renderSwitcherList(query) {
  const list = document.getElementById('switcher-list');
  const lowerQuery = query.toLowerCase();
  const filtered = projects.filter((p) =>
    p.name.toLowerCase().includes(lowerQuery) || p.path.toLowerCase().includes(lowerQuery)
  );

  list.innerHTML = '';
  for (let i = 0; i < filtered.length; i++) {
    const p = filtered[i];
    const el = document.createElement('div');
    el.className = `switcher-item${i === 0 ? ' selected' : ''}`;
    el.innerHTML = `
      <div>${escapeHtml(p.name)}</div>
      <div class="switcher-path">${escapeHtml(shortenPath(p.path))}</div>
    `;
    el.addEventListener('click', () => {
      selectProject(p.id);
      document.getElementById('project-switcher').classList.add('hidden');
    });
    list.appendChild(el);
  }
}

// ========== File Watcher ==========
let fileWatcherCleanup = null;
let fileWatcherDebounce = null;

function startFileWatcher(projectPath) {
  if (fileWatcherCleanup) fileWatcherCleanup();
  window.api.watchProject(projectPath);
  fileWatcherCleanup = window.api.onFileChange(() => {
    // Debounce to avoid rapid reloads
    clearTimeout(fileWatcherDebounce);
    fileWatcherDebounce = setTimeout(() => {
      if (window.editorPanel) {
        window.editorPanel.loadFileTree(projectPath);
      }
    }, 500);
  });
}



// ========== Expose shared state/functions for modules (swarm.js, browser.js) ==========
window.IDE = {
  COLORS,
  state: { get projects() { return projects; }, get activeProjectId() { return activeProjectId; }, set activeProjectId(v) { activeProjectId = v; }, get sessions() { return sessions; }, get activeSessionId() { return activeSessionId; }, set activeSessionId(v) { activeSessionId = v; }, get viewMode() { return viewMode; }, set viewMode(v) { viewMode = v; } },
  // Direct accessors (used by browser.js)
  get projects() { return projects; },
  get activeProjectId() { return activeProjectId; },
  get sessions() { return sessions; },
  get activeSessionId() { return activeSessionId; },
  showToast,
  escapeHtml,
  openDrawer,
  saveSettings,
  renderDrawer,
  renderTabs,
  applyViewMode,
  updateStatusBar,
  createTerminalPane,
  updatePaneStatus,
};

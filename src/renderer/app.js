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
let viewMode = 'single'; // single, double, project, all

// ========== Persisted View Settings (file-based via main process) ==========
let _settingsCache = {};

// Keys stored per-workspace (under workspaces.<projectId>)
const WORKSPACE_KEYS = ['visiblePanels', 'panelSizes', 'viewMode', 'cliSelect', 'roleSelect', 'browserUrl', 'activeSessionId'];

async function loadSettings() {
  _settingsCache = await window.api.loadSettings();
  return _settingsCache;
}

function _getWorkspaceSettings() {
  if (!activeProjectId) return {};
  const ws = _settingsCache.workspaces || {};
  return ws[activeProjectId] || {};
}

function getSetting(key) {
  if (WORKSPACE_KEYS.includes(key) && activeProjectId) {
    const ws = _getWorkspaceSettings();
    return ws[key] !== undefined ? ws[key] : _settingsCache[key];
  }
  return _settingsCache[key];
}

function saveSettings(patch) {
  // Split into workspace-specific and global
  const wsPatch = {};
  const globalPatch = {};
  for (const [k, v] of Object.entries(patch)) {
    if (WORKSPACE_KEYS.includes(k) && activeProjectId) {
      wsPatch[k] = v;
    } else {
      globalPatch[k] = v;
    }
  }

  // Merge workspace settings
  if (Object.keys(wsPatch).length > 0 && activeProjectId) {
    if (!_settingsCache.workspaces) _settingsCache.workspaces = {};
    if (!_settingsCache.workspaces[activeProjectId]) _settingsCache.workspaces[activeProjectId] = {};
    Object.assign(_settingsCache.workspaces[activeProjectId], wsPatch);
    globalPatch.workspaces = _settingsCache.workspaces;
  }

  // Merge global
  Object.assign(_settingsCache, globalPatch);
  window.api.saveSettings(globalPatch);
}

async function restoreSettings() {
  const s = await loadSettings();
  if (s.activeProjectId) {
    activeProjectId = s.activeProjectId;
  }
  // Restore workspace-specific settings
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
  projects = await window.api.listProjects();

  // Restore view settings (view mode, active project, etc)
  await restoreSettings();

  // Restore previous sessions from saved state
  await restoreSessions();

  renderDrawer();
  renderTabs();
  applyViewMode();

  btnWorkspace.addEventListener('click', openDrawer);
  btnCloseDrawer.addEventListener('click', closeDrawer);
  drawerOverlay.addEventListener('click', closeDrawer);
  btnAddProject.addEventListener('click', addProject);
  btnNewSession.addEventListener('click', newSession);
  viewModeSelect.addEventListener('change', (e) => {
    viewMode = e.target.value;
    saveSettings({ viewMode });
    applyViewMode();
  });
  cliSelect.addEventListener('change', () => saveSettings({ cliSelect: cliSelect.value }));
  roleSelect.addEventListener('change', () => saveSettings({ roleSelect: roleSelect.value }));

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
  if (visiblePanels.swarm) {
    startMessagesPolling();
    startCanvasRendering();
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

function selectProject(id) {
  activeProjectId = id;
  saveSettings({ activeProjectId: id });

  // Restore workspace-specific layout and config
  restoreWorkspaceConfig();

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
  const colors = _settingsCache.projectColors || {};
  return colors[id] || '#3498db';
}

function saveProjectColor(id, color) {
  const colors = _settingsCache.projectColors || {};
  colors[id] = color;
  saveSettings({ projectColors: colors });
}

function getSessionColor(id) {
  const colors = _settingsCache.sessionColors || {};
  return colors[id] || null;
}

function saveSessionColor(id, color) {
  const colors = _settingsCache.sessionColors || {};
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
  if (browserAgentBar && !browserAgentBar.classList.contains('hidden')) {
    _refreshBrowserAgentDropdown();
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
  // If activeSessionId doesn't exist in sessions, pick the first one
  if (activeSessionId && !sessions.has(activeSessionId)) {
    const first = sessions.keys().next().value;
    if (first) activeSessionId = first;
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
  } else if (viewMode === 'double') {
    // Show active + the next one in the project
    let projectSessions = getProjectSessions();
    if (projectSessions.length === 0) projectSessions = Array.from(sessions.values());
    const activeIdx = projectSessions.findIndex((s) => s.meta.id === activeSessionId);
    if (activeIdx >= 0) {
      visibleSessions.push(projectSessions[activeIdx]);
      if (projectSessions[activeIdx + 1]) visibleSessions.push(projectSessions[activeIdx + 1]);
      else if (projectSessions[activeIdx - 1]) visibleSessions.push(projectSessions[activeIdx - 1]);
    } else {
      visibleSessions = projectSessions.slice(0, 2);
    }
  } else if (viewMode === 'project') {
    visibleSessions = getProjectSessions();
    if (visibleSessions.length === 0) visibleSessions = Array.from(sessions.values());
  } else if (viewMode === 'all') {
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
  if (sessions.size === 0) {
    noSessionMsg.style.display = 'flex';
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
  if (panelName === 'swarm') {
    if (visible) {
      startMessagesPolling();
      startCanvasRendering();
    } else {
      stopMessagesPolling();
      stopCanvasRendering();
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
  const projectSessions = activeProjectId ? getProjectSessions() : Array.from(sessions.values());

  for (const s of projectSessions) {
    const color = getSessionColor(s.meta.id) || getProjectColor(s.meta.projectId);
    const tab = document.createElement('div');
    tab.className = `tab${s.meta.id === activeSessionId ? ' active' : ''}`;
    tab.innerHTML = `
      <span class="tab-color" style="background:${color}"></span>
      ${escapeHtml(s.meta.name)}
    `;
    tab.addEventListener('click', () => activateSession(s.meta.id));
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

// ========== Swarm ==========
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

function openSwarmModal() {
  if (!activeProjectId) {
    showToast('Select a project first');
    openDrawer();
    return;
  }
  swarmModal.classList.remove('hidden');
  swarmMission.value = '';
  renderSwarmAgents(DEFAULT_SWARM_AGENTS.map((a) => ({ ...a })));
  setTimeout(() => swarmMission.focus(), 50);
}

let _swarmAgents = [];

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

  // Wire change handlers
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
    showToast('Enter a mission for the swarm');
    return;
  }
  if (_swarmAgents.length < 2) {
    showToast('A swarm needs at least 2 agents');
    return;
  }
  if (!_swarmAgents.some((a) => a.role === 'coordinator')) {
    showToast('A swarm needs a coordinator');
    return;
  }

  const project = projects.find((p) => p.id === activeProjectId);
  if (!project) {
    showToast('No project selected');
    return;
  }

  swarmModal.classList.add('hidden');
  showToast(`Launching swarm with ${_swarmAgents.length} agents...`);

  let swarm;
  try {
    swarm = await window.api.createSwarm({
      projectId: activeProjectId,
      projectPath: project.path,
      mission,
      agents: _swarmAgents,
    });
  } catch (e) {
    showToast(`Swarm failed: ${e.message}`);
    console.error('Swarm creation error:', e);
    return;
  }

  if (!swarm || !swarm.sessionIds || swarm.sessionIds.length === 0) {
    showToast('Swarm created but no sessions were spawned');
    return;
  }

  // Fetch all live sessions once
  const allSessions = await window.api.listAllSessions();

  // Register all swarm sessions in the UI
  for (const sessionId of swarm.sessionIds) {
    const meta = allSessions.find((s) => s.id === sessionId);
    if (!meta) {
      console.warn('Swarm session not found in listAll:', sessionId);
      continue;
    }
    if (sessions.has(sessionId)) continue;

    const { terminal, fitAddon, paneEl } = await createTerminalPane(meta);

    // Replay any existing history
    try {
      const history = await window.api.getSessionHistory(sessionId);
      if (history) terminal.write(history);
    } catch (e) {}

    terminal.onData((data) => window.api.writeSession(sessionId, data));
    terminal.onResize(({ cols, rows }) => window.api.resizeSession(sessionId, cols, rows));

    const cleanupData = window.api.onSessionData(sessionId, (data) => terminal.write(data));
    const cleanupExit = window.api.onSessionExit(sessionId, (code) => {
      terminal.write(`\r\n\x1b[33m[Agent exited with code ${code}]\x1b[0m\r\n`);
      const s = sessions.get(sessionId);
      if (s) {
        s.meta.status = 'stopped';
        updatePaneStatus(s);
      }
      renderDrawer();
      renderTabs();
      updateStatusBar();
    });

    sessions.set(sessionId, {
      meta,
      terminal,
      fitAddon,
      paneEl,
      cleanup: () => { cleanupData(); cleanupExit(); },
    });
  }

  // Activate first session and switch to project view
  if (swarm.sessionIds.length > 0) {
    activeSessionId = swarm.sessionIds[0];
    noSessionMsg.style.display = 'none';
  }
  viewMode = 'project';
  viewModeSelect.value = 'project';
  saveSettings({ viewMode });

  renderDrawer();
  renderTabs();
  applyViewMode();
  updateStatusBar();
  showToast(`Swarm launched: ${swarm.agents.length} agents working on mission`);
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
    // Resize canvas when switching to it
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
    const project = projects.find(p => p.id === activeProjectId);
    if (!project) return;
    // Clear messages file
    const messagesPath = project.path + '/.dan-ide/memory/MESSAGES.md';
    try { await window.api.writeFile(messagesPath, ''); } catch {}
    // Clear UI
    if (messagesList) messagesList.innerHTML = '';
    if (tasksList) tasksList.innerHTML = '';
    const auditTimeline = document.getElementById('audit-timeline');
    if (auditTimeline) auditTimeline.innerHTML = '';
    showToast('Swarm panel cleared');
  });
}

function parseMessages(raw) {
  if (!raw || !raw.trim()) return [];
  const messages = [];
  const blocks = raw.split(/^### /m).filter((b) => b.trim());
  for (const block of blocks) {
    const lines = block.split('\n');
    const headerLine = lines[0] || '';
    // Format: "[timestamp] AgentName"
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
  const taskMap = new Map(); // assignee -> latest task

  for (const msg of messages) {
    const role = detectRole(msg.agent);
    if (role === 'coordinator') {
      // Look for @AgentName: task pattern
      const assignments = msg.body.matchAll(/@([\w-]+):\s*(.+?)(?=\n@|\n###|$)/gs);
      for (const m of assignments) {
        const assignee = m[1];
        const desc = m[2].trim();
        const key = assignee;
        taskMap.set(key, { assignee, description: desc, status: 'assigned', timestamp: msg.timestamp });
      }
    } else if (msg.body.match(/\bACKNOWLEDGED\b/i)) {
      // Worker acknowledged — in progress
      const existing = taskMap.get(msg.agent) || taskMap.get(msg.agent.replace(/\s/g, '-'));
      if (existing) existing.status = 'in-progress';
      // Also try matching by partial name
      for (const [key, task] of taskMap) {
        if (msg.agent.includes(key) || key.includes(msg.agent.split(' ')[0])) {
          task.status = 'in-progress';
        }
      }
    } else if (msg.body.match(/\b(DONE|COMPLETE|FINDINGS|REVIEW COMPLETE)\b/i)) {
      // Worker finished
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
        <span class="message-agent">${escapeHtml(msg.agent)}</span>
        <span class="message-time">${escapeHtml(msg.timestamp)}</span>
      </div>
      <div class="message-body">${escapeHtml(msg.body)}</div>
    </div>`;
  }).join('');
  // Auto-scroll to bottom
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
        <div class="task-assignee">@${escapeHtml(task.assignee)}</div>
        <div class="task-description">${escapeHtml(task.description)}</div>
      </div>
    </div>`;
  }).join('');
}

async function refreshMessagesPanel() {
  if (!activeProjectId) return;
  const project = projects.find((p) => p.id === activeProjectId);
  if (!project) return;

  const raw = await window.api.readMessages(project.path);
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
          <span class="audit-event-agent" style="color:${agentColor}">${escapeHtml(evt.agentName)}</span>
          <span class="audit-event-type">${escapeHtml(evt.type.replace(/_/g, " "))}</span>
          <span class="audit-event-time">${formatAuditTime(evt.timestamp)}</span>
        </div>
        <div class="audit-event-desc">${escapeHtml(evt.description)}</div>
      </div>
    </div>`;
  }).join("");
}

function getAgentColor(name) {
  if (!name) return "#888";
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return COLORS[Math.abs(hash) % COLORS.length];
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

// Start audit polling alongside messages
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

  // Auto-size canvas to fill panel
  const rect = panel.getBoundingClientRect();
  canvas.width = rect.width * window.devicePixelRatio;
  canvas.height = rect.height * window.devicePixelRatio;
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  ctx.clearRect(0, 0, rect.width, rect.height);

  _canvasPulsePhase = (_canvasPulsePhase + 1) % 60;

  // Gather agent nodes from sessions
  const nodes = [];
  const projectSessions = [];
  sessions.forEach((s) => {
    if (activeProjectId && s.meta.projectId === activeProjectId) {
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

  // Role colors
  const roleColors = {
    coordinator: '#e74c3c',
    builder: '#3498db',
    scout: '#2ecc71',
    researcher: '#2ecc71',
    reviewer: '#f39c12',
  };
  const defaultColor = '#9b59b6';

  // Layout: coordinator in center, others in a circle around it
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

  // Position coordinator at center
  if (coordinatorNode) {
    coordinatorNode.x = centerX;
    coordinatorNode.y = centerY;
  }

  // Position workers in a circle
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

  // Draw connecting lines from coordinator to workers
  if (coordinatorNode && workerNodes.length > 0) {
    workerNodes.forEach((worker) => {
      ctx.beginPath();
      ctx.moveTo(coordinatorNode.x, coordinatorNode.y);
      ctx.lineTo(worker.x, worker.y);
      ctx.strokeStyle = '#2a2a4a';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Animate pulse along lines (only for running agents)
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

  // Draw nodes
  const allNodes = coordinatorNode ? [coordinatorNode, ...workerNodes] : nodesToLayout;
  allNodes.forEach((node) => {
    // Node circle
    ctx.beginPath();
    ctx.arc(node.x, node.y, nodeRadius, 0, Math.PI * 2);
    ctx.fillStyle = node.color + '33'; // semi-transparent fill
    ctx.fill();
    ctx.strokeStyle = node.color;
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Status indicator dot
    const dotColor = node.status === 'running' ? '#4ecdc4' : '#666';
    ctx.beginPath();
    ctx.arc(node.x + nodeRadius - 6, node.y - nodeRadius + 6, 5, 0, Math.PI * 2);
    ctx.fillStyle = dotColor;
    ctx.fill();

    // Label (name)
    ctx.fillStyle = '#e0e0e0';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const displayName = node.name.length > 12 ? node.name.slice(0, 11) + '...' : node.name;
    ctx.fillText(displayName, node.x, node.y + 2);

    // Role label below node
    if (node.role) {
      ctx.fillStyle = '#888';
      ctx.font = '9px -apple-system, sans-serif';
      ctx.fillText(node.role, node.x, node.y + nodeRadius + 12);
    }
  });
}

// ========== Test Runner ==========
const btnRunTests = document.getElementById('btn-run-tests');
const statusTests = document.getElementById('status-tests');

async function runProjectTests() {
  const project = projects.find((p) => p.id === activeProjectId);
  if (!project) {
    showToast('No project selected');
    return;
  }

  statusTests.textContent = 'Tests: running...';
  btnRunTests.disabled = true;

  try {
    const result = await window.api.runTests(project.path);
    if (result.error) {
      statusTests.textContent = '';
      showToast(`Tests: ${result.error}`);
    } else if (result.failed > 0) {
      statusTests.textContent = `Tests: ${result.failed} failed`;
      statusTests.style.color = '#e74c3c';
      const failMsg = result.failures.length > 0
        ? result.failures.map((f) => f.test).join(', ')
        : `${result.failed} failed`;
      showToast(`Tests: ${result.passed}/${result.total} passed, ${result.failed} failed (${failMsg})`);
    } else {
      statusTests.textContent = `Tests: ${result.passed}/${result.total} passed`;
      statusTests.style.color = '#2ecc71';
      showToast(`Tests: ${result.passed}/${result.total} passed (${result.duration}ms)`);
    }
  } catch (err) {
    statusTests.textContent = '';
    showToast(`Tests error: ${err.message}`);
  } finally {
    btnRunTests.disabled = false;
  }
}

btnRunTests.addEventListener('click', runProjectTests);

// ========== Browser Panel ==========
const browserWebview = document.getElementById('browser-webview');
const browserUrl = document.getElementById('browser-url');
const browserGo = document.getElementById('browser-go');
const browserBack = document.getElementById('browser-back');
const browserForward = document.getElementById('browser-forward');
const browserReload = document.getElementById('browser-reload');
const browserInspect = document.getElementById('browser-inspect');
const browserAnnotate = document.getElementById('browser-annotate');
const browserCapture = document.getElementById('browser-capture');
const browserClear = document.getElementById('browser-clear');
const browserOverlay = document.getElementById('browser-overlay');
const browserSelectionBox = document.getElementById('browser-selection-box');
const browserAgentBar = document.getElementById('browser-agent-bar');
const browserAgentPrompt = document.getElementById('browser-agent-prompt');
const browserAgentTarget = document.getElementById('browser-agent-target');
const browserAgentSend = document.getElementById('browser-agent-send');
const browserAgentCancel = document.getElementById('browser-agent-cancel');

// State
let _browserMode = 'browse'; // 'browse', 'inspect', 'annotate', 'capture'
let _browserScreenshotData = null;
let _selectedElementInfo = null; // { selector, outerHTML, text, rect }
let _selectStart = null;
let _annotations = [];

// ---- Navigation ----
function _navigateBrowser(input) {
  let url = input.trim();
  if (!url) return;
  if (!url.match(/^https?:\/\//)) {
    // Default to http:// for localhost, 127.0.0.1, and ports
    if (url.match(/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|(\d{1,3}\.){3}\d{1,3})(:\d+)?/)) {
      url = 'http://' + url;
    } else {
      url = 'https://' + url;
    }
  }
  browserWebview.src = url;
}

if (browserUrl) {
  browserUrl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      _navigateBrowser(browserUrl.value);
    }
  });
}
if (browserGo) {
  browserGo.addEventListener('click', () => _navigateBrowser(browserUrl.value));
}

if (browserWebview) {
  browserWebview.addEventListener('did-navigate', (e) => {
    browserUrl.value = e.url;
    saveSettings({ browserUrl: e.url });
  });
  browserWebview.addEventListener('did-navigate-in-page', (e) => {
    if (e.isMainFrame) {
      browserUrl.value = e.url;
      saveSettings({ browserUrl: e.url });
    }
  });

  // Show errors visually in the webview (connection refused, 404, etc.)
  browserWebview.addEventListener('did-fail-load', (e) => {
    if (e.errorCode === -3) return; // Aborted (user navigated away), ignore
    const errorPage = `
      <html><body style="font-family:-apple-system,sans-serif;background:#1a1a2e;color:#e0e0e0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
        <div style="text-align:center;max-width:500px;padding:40px;">
          <div style="font-size:48px;margin-bottom:16px;">&#x26A0;</div>
          <h2 style="color:#e74c3c;margin-bottom:8px;">Failed to load</h2>
          <p style="color:#bbb;margin-bottom:12px;">${e.validatedURL || ''}</p>
          <p style="color:#888;font-size:14px;">${e.errorDescription || 'Unknown error'} (code ${e.errorCode})</p>
        </div>
      </body></html>`;
    browserWebview.executeJavaScript(`document.open();document.write(${JSON.stringify(errorPage)});document.close();`).catch(() => {});
  });

  // Show HTTP errors (4xx, 5xx) as a banner overlay
  browserWebview.addEventListener('did-navigate', (e) => {
    if (!e.httpResponseCode) return;
    if (e.httpResponseCode >= 400) {
      browserWebview.executeJavaScript(`
        (function() {
          let banner = document.getElementById('__dan_ide_error_banner__');
          if (!banner) {
            banner = document.createElement('div');
            banner.id = '__dan_ide_error_banner__';
            banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#e74c3c;color:white;padding:6px 12px;font:13px -apple-system,sans-serif;z-index:2147483647;text-align:center;';
            document.body.prepend(banner);
          }
          banner.textContent = 'HTTP ${e.httpResponseCode} — ${e.httpStatusText || 'Error'}';
          setTimeout(() => banner.remove(), 8000);
        })();
      `).catch(() => {});
    }
  });
}

if (browserBack) browserBack.addEventListener('click', () => { if (browserWebview.canGoBack()) browserWebview.goBack(); });
if (browserForward) browserForward.addEventListener('click', () => { if (browserWebview.canGoForward()) browserWebview.goForward(); });
if (browserReload) browserReload.addEventListener('click', () => browserWebview.reload());

// ---- Mode Management ----
function _setActiveToolBtn(btn) {
  document.querySelectorAll('#browser-toolbar .browser-tool-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
}

function _exitBrowserMode() {
  _browserMode = 'browse';
  _setActiveToolBtn(null);
  browserOverlay.classList.add('hidden');
  browserOverlay.classList.remove('active', 'annotating');
  browserSelectionBox.classList.add('hidden');
  // Remove inspect highlight from webview
  if (browserWebview && browserWebview.src !== 'about:blank') {
    browserWebview.executeJavaScript(`
      (function() {
        const hl = document.getElementById('__dan_ide_highlight__');
        if (hl) hl.remove();
        document.removeEventListener('mousemove', window.__danIdeInspectMove);
        document.removeEventListener('click', window.__danIdeInspectClick, true);
        document.body.style.cursor = '';
      })();
    `).catch(() => {});
  }
}

// ---- Inspect (Select Element) ----
// Injects highlight overlay into the webview; on click, captures the element info
if (browserInspect) {
  browserInspect.addEventListener('click', () => {
    if (_browserMode === 'inspect') { _exitBrowserMode(); return; }
    _exitBrowserMode();
    _browserMode = 'inspect';
    _setActiveToolBtn(browserInspect);
    _selectedElementInfo = null;

    if (!browserWebview || browserWebview.src === 'about:blank') {
      showToast('Navigate to a page first');
      _exitBrowserMode();
      return;
    }

    // Inject inspect script into webview
    browserWebview.executeJavaScript(`
      (function() {
        // Create highlight overlay
        let hl = document.getElementById('__dan_ide_highlight__');
        if (!hl) {
          hl = document.createElement('div');
          hl.id = '__dan_ide_highlight__';
          hl.style.cssText = 'position:fixed;pointer-events:none;border:2px solid #3498db;background:rgba(52,152,219,0.1);z-index:2147483647;transition:all 0.05s;display:none;';
          document.body.appendChild(hl);
        }
        hl.style.display = 'none';
        document.body.style.cursor = 'crosshair';

        // Mousemove: highlight hovered element
        window.__danIdeInspectMove = function(e) {
          const el = document.elementFromPoint(e.clientX, e.clientY);
          if (!el || el === hl) return;
          const r = el.getBoundingClientRect();
          hl.style.display = 'block';
          hl.style.left = r.left + 'px';
          hl.style.top = r.top + 'px';
          hl.style.width = r.width + 'px';
          hl.style.height = r.height + 'px';
        };
        document.addEventListener('mousemove', window.__danIdeInspectMove);

        // Click: select element, return info
        window.__danIdeInspectClick = function(e) {
          e.preventDefault();
          e.stopPropagation();
          const el = document.elementFromPoint(e.clientX, e.clientY);
          if (!el || el.id === '__dan_ide_highlight__') return;

          // Build a CSS selector
          function getSelector(node) {
            if (node.id) return '#' + node.id;
            let path = node.tagName.toLowerCase();
            if (node.className && typeof node.className === 'string') {
              path += '.' + node.className.trim().split(/\\s+/).join('.');
            }
            return path;
          }

          const r = el.getBoundingClientRect();
          const info = {
            selector: getSelector(el),
            tagName: el.tagName.toLowerCase(),
            outerHTML: el.outerHTML.slice(0, 2000),
            text: (el.innerText || '').slice(0, 500),
            rect: { x: r.x, y: r.y, width: r.width, height: r.height },
          };

          // Cleanup
          hl.remove();
          document.removeEventListener('mousemove', window.__danIdeInspectMove);
          document.removeEventListener('click', window.__danIdeInspectClick, true);
          document.body.style.cursor = '';

          // Send back via IPC-style message
          window.__danIdeSelectedElement = info;
        };
        document.addEventListener('click', window.__danIdeInspectClick, true);
      })();
    `).catch(() => {});

    // Poll for selection result
    const pollId = setInterval(async () => {
      if (_browserMode !== 'inspect') { clearInterval(pollId); return; }
      try {
        const info = await browserWebview.executeJavaScript('window.__danIdeSelectedElement');
        if (info) {
          clearInterval(pollId);
          await browserWebview.executeJavaScript('delete window.__danIdeSelectedElement;');
          _selectedElementInfo = info;
          _browserMode = 'browse';
          _setActiveToolBtn(null);
          // Show agent bar with element info
          _showAgentBarWithElement(info);
        }
      } catch {}
    }, 200);
  });
}

function _refreshBrowserAgentDropdown() {
  if (!browserAgentTarget) return;
  const current = browserAgentTarget.value;
  browserAgentTarget.innerHTML = '';

  // Active agent first (pre-selected)
  if (activeSessionId) {
    const entry = sessions.get(activeSessionId);
    const name = entry && entry.meta ? entry.meta.name : activeSessionId;
    const activeOpt = document.createElement('option');
    activeOpt.value = activeSessionId;
    activeOpt.textContent = name;
    browserAgentTarget.appendChild(activeOpt);
  }
  // Other running sessions
  for (const [id, entry] of sessions) {
    if (id === activeSessionId) continue;
    const m = entry.meta || entry;
    if (m.status === 'stopped') continue;
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = m.name || id;
    browserAgentTarget.appendChild(opt);
  }

  if (browserAgentTarget.options.length === 0) {
    const noOpt = document.createElement('option');
    noOpt.value = '';
    noOpt.textContent = 'No agents running — start one first';
    noOpt.disabled = true;
    browserAgentTarget.appendChild(noOpt);
  }

  // Restore previous selection if still valid
  if (current && browserAgentTarget.querySelector(`option[value="${current}"]`)) {
    browserAgentTarget.value = current;
  }
}

function _showAgentBarWithElement(info) {
  _refreshBrowserAgentDropdown();
  browserAgentBar.classList.remove('hidden');
  const selectorEl = document.getElementById('browser-selected-selector');
  const previewEl = document.getElementById('browser-selected-preview');
  if (selectorEl) selectorEl.textContent = info.selector;
  if (previewEl) previewEl.textContent = info.outerHTML.slice(0, 400);
  document.getElementById('browser-selected-info').style.display = 'flex';
  document.getElementById('browser-selected-preview').style.display = 'block';
  browserAgentPrompt.placeholder = 'Describe what you want the agent to do with this element...';
  browserAgentPrompt.focus();
}

function _showAgentBarWithCapture() {
  _refreshBrowserAgentDropdown();
  browserAgentBar.classList.remove('hidden');
  document.getElementById('browser-selected-info').style.display = 'none';
  // Show capture thumbnail in the preview area
  const previewEl = document.getElementById('browser-selected-preview');
  if (previewEl && _browserScreenshotData) {
    previewEl.style.display = 'block';
    previewEl.innerHTML = `<img src="${_browserScreenshotData}" style="max-width:100%;max-height:120px;border-radius:4px;display:block;">`;
  } else if (previewEl) {
    previewEl.style.display = 'none';
  }
  browserAgentPrompt.placeholder = 'Describe what you want the agent to do with this capture...';
  browserAgentPrompt.focus();
}


// Copy selector button
const browserSelectedCopy = document.getElementById('browser-selected-copy');
if (browserSelectedCopy) {
  browserSelectedCopy.addEventListener('click', () => {
    const sel = document.getElementById('browser-selected-selector');
    if (sel && sel.textContent) {
      navigator.clipboard.writeText(sel.textContent);
      showToast('Selector copied');
    }
  });
}

// ---- Annotate Mode ----
if (browserAnnotate) {
  browserAnnotate.addEventListener('click', () => {
    if (_browserMode === 'annotate') { _exitBrowserMode(); return; }
    _exitBrowserMode();
    _browserMode = 'annotate';
    _setActiveToolBtn(browserAnnotate);
    browserOverlay.classList.remove('hidden');
    browserOverlay.classList.add('active', 'annotating');
    _resizeOverlay();
  });
}

// ---- Capture Mode (full page or drag region) ----
if (browserCapture) {
  browserCapture.addEventListener('click', () => {
    if (_browserMode === 'capture') { _exitBrowserMode(); return; }
    _exitBrowserMode();
    _browserMode = 'capture';
    _setActiveToolBtn(browserCapture);
    browserOverlay.classList.remove('hidden');
    browserOverlay.classList.add('active');
    browserOverlay.classList.remove('annotating');
    showToast('Drag to select a region, or click "→ Agent" for full page');
  });
}

// ---- Clear Button ----
if (browserClear) {
  browserClear.addEventListener('click', () => {
    _annotations = [];
    _browserScreenshotData = null;
    _selectedElementInfo = null;
    _selectStart = null;
    _clearOverlay();
    browserAgentBar.classList.add('hidden');
    browserAgentPrompt.value = '';
    browserSelectionBox.classList.add('hidden');
    browserSelectionBox.style.width = '0';
    browserSelectionBox.style.height = '0';
    _exitBrowserMode();
    showToast('Cleared');
  });
}

// ---- Overlay Helpers ----
function _resizeOverlay() {
  const content = document.getElementById('browser-content');
  if (!content || !browserOverlay) return;
  const rect = content.getBoundingClientRect();
  browserOverlay.width = rect.width * window.devicePixelRatio;
  browserOverlay.height = rect.height * window.devicePixelRatio;
  browserOverlay.style.width = rect.width + 'px';
  browserOverlay.style.height = rect.height + 'px';
}

function _clearOverlay() {
  _resizeOverlay();
  const ctx = browserOverlay.getContext('2d');
  if (ctx) ctx.clearRect(0, 0, browserOverlay.width, browserOverlay.height);
}

// ---- Overlay Mouse Events (capture region + annotate) ----
if (browserOverlay) {
  let _drawing = false;
  let _lastX = 0, _lastY = 0;

  browserOverlay.addEventListener('mousedown', (e) => {
    const rect = browserOverlay.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (_browserMode === 'capture') {
      _selectStart = { x: e.clientX, y: e.clientY };
      browserSelectionBox.classList.remove('hidden');
      browserSelectionBox.style.left = x + 'px';
      browserSelectionBox.style.top = y + 'px';
      browserSelectionBox.style.width = '0';
      browserSelectionBox.style.height = '0';
    } else if (_browserMode === 'annotate') {
      _drawing = true;
      _lastX = x;
      _lastY = y;
    }
  });

  browserOverlay.addEventListener('mousemove', (e) => {
    const rect = browserOverlay.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (_browserMode === 'capture' && _selectStart) {
      const sx = Math.min(_selectStart.x - rect.left, x);
      const sy = Math.min(_selectStart.y - rect.top, y);
      const sw = Math.abs(e.clientX - _selectStart.x);
      const sh = Math.abs(e.clientY - _selectStart.y);
      browserSelectionBox.style.left = sx + 'px';
      browserSelectionBox.style.top = sy + 'px';
      browserSelectionBox.style.width = sw + 'px';
      browserSelectionBox.style.height = sh + 'px';
    } else if (_browserMode === 'annotate' && _drawing) {
      const ctx = browserOverlay.getContext('2d');
      const dpr = window.devicePixelRatio;
      ctx.strokeStyle = '#e74c3c';
      ctx.lineWidth = 3 * dpr;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(_lastX * dpr, _lastY * dpr);
      ctx.lineTo(x * dpr, y * dpr);
      ctx.stroke();
      _annotations.push({ x1: _lastX, y1: _lastY, x2: x, y2: y });
      _lastX = x;
      _lastY = y;
    }
  });

  browserOverlay.addEventListener('mouseup', async (e) => {
    if (_browserMode === 'capture' && _selectStart) {
      const rect = browserOverlay.getBoundingClientRect();
      const sx = Math.min(_selectStart.x, e.clientX) - rect.left;
      const sy = Math.min(_selectStart.y, e.clientY) - rect.top;
      const sw = Math.abs(e.clientX - _selectStart.x);
      const sh = Math.abs(e.clientY - _selectStart.y);
      _selectStart = null;

      if (sw > 10 && sh > 10) {
        try {
          const img = await browserWebview.capturePage();
          const size = img.getSize();
          if (!size || size.width === 0) {
            _browserScreenshotData = img.toDataURL();
            if (_annotations.length > 0) {
              _browserScreenshotData = await _compositeAnnotations(_browserScreenshotData);
            }
            browserSelectionBox.classList.add('hidden');
            _exitBrowserMode();
            _showAgentBarWithCapture();
            return;
          }
          const fullDataUrl = img.toDataURL();
          // Use the webview element's CSS rect for DPR calculation (not overlay)
          const webviewRect = browserWebview.getBoundingClientRect();
          const dpr = size.width / webviewRect.width;
          // Crop: sx/sy are relative to the overlay which matches webview position
          const cropCanvas = document.createElement('canvas');
          cropCanvas.width = Math.round(sw * dpr);
          cropCanvas.height = Math.round(sh * dpr);
          const cropCtx = cropCanvas.getContext('2d');
          const tempImg = new Image();
          tempImg.onload = async () => {
            cropCtx.drawImage(tempImg, Math.round(sx * dpr), Math.round(sy * dpr), Math.round(sw * dpr), Math.round(sh * dpr), 0, 0, Math.round(sw * dpr), Math.round(sh * dpr));
            _browserScreenshotData = cropCanvas.toDataURL('image/png');
            // Composite any annotations onto the capture (with crop offset)
            if (_annotations.length > 0) {
              _browserScreenshotData = await _compositeAnnotations(_browserScreenshotData, { x: sx, y: sy, w: sw, h: sh });
            }
            browserSelectionBox.classList.add('hidden');
            _exitBrowserMode();
            _showAgentBarWithCapture();
          };
          tempImg.onerror = () => {
            _browserScreenshotData = fullDataUrl;
            browserSelectionBox.classList.add('hidden');
            _exitBrowserMode();
            _showAgentBarWithCapture();
          };
          tempImg.src = fullDataUrl;
          return;
        } catch (err) {
          showToast('Capture failed: ' + err.message);
        }
      }
      browserSelectionBox.classList.add('hidden');
      _exitBrowserMode();
    } else if (_browserMode === 'annotate') {
      _drawing = false;
    }
  });
}


function _compositeAnnotations(dataUrl, cropOffset) {
  // cropOffset: { x, y, w, h } in CSS pixels if this is a cropped region
  return new Promise((resolve) => {
    const tempImg = new Image();
    tempImg.onload = () => {
      const c = document.createElement('canvas');
      c.width = tempImg.width;
      c.height = tempImg.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(tempImg, 0, 0);
      ctx.strokeStyle = '#e74c3c';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';

      let scaleX, scaleY, offsetX = 0, offsetY = 0;
      if (cropOffset) {
        // Annotations are in overlay CSS pixels; scale to the crop image
        scaleX = tempImg.width / cropOffset.w;
        scaleY = tempImg.height / cropOffset.h;
        offsetX = cropOffset.x;
        offsetY = cropOffset.y;
      } else {
        const content = document.getElementById('browser-content');
        const rect = content.getBoundingClientRect();
        scaleX = tempImg.width / rect.width;
        scaleY = tempImg.height / rect.height;
      }

      for (const a of _annotations) {
        ctx.beginPath();
        ctx.moveTo((a.x1 - offsetX) * scaleX, (a.y1 - offsetY) * scaleY);
        ctx.lineTo((a.x2 - offsetX) * scaleX, (a.y2 - offsetY) * scaleY);
        ctx.stroke();
      }
      resolve(c.toDataURL('image/png'));
    };
    tempImg.src = dataUrl;
  });
}

// Ctrl+Enter in prompt triggers send
if (browserAgentPrompt) {
  browserAgentPrompt.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      if (browserAgentSend) browserAgentSend.click();
    }
  });
}

// ---- Agent Send Action ----
if (browserAgentSend) {
  browserAgentSend.addEventListener('click', async () => {
    const prompt = browserAgentPrompt.value.trim();
    if (!prompt) {
      showToast('Enter a prompt describing what to do');
      return;
    }

    const project = projects.find((p) => p.id === activeProjectId);
    if (!project) {
      showToast('No project selected');
      return;
    }

    // Save screenshot to disk if we have one (agents need a file path)
    let screenshotPath = '';
    if (_browserScreenshotData) {
      screenshotPath = await window.api.saveScreenshot(project.path, _browserScreenshotData, null);
    }

    // Build context message
    let contextMsg = '';
    if (_selectedElementInfo) {
      contextMsg += `Selected element: ${_selectedElementInfo.selector}\nHTML: ${_selectedElementInfo.outerHTML.slice(0, 1000)}\n`;
      if (_selectedElementInfo.text) contextMsg += `Text content: ${_selectedElementInfo.text.slice(0, 300)}\n`;
    }
    if (screenshotPath) {
      contextMsg += `Screenshot: ${screenshotPath}\n`;
    }
    contextMsg += `\n${prompt}`;

    const targetSessionId = browserAgentTarget.value;
    if (!targetSessionId) {
      showToast('No agent selected — start an agent first');
      return;
    }

    window.api.writeSession(targetSessionId, contextMsg + '\n');
    setTimeout(() => window.api.writeSession(targetSessionId, '\r'), 200);
    const targetEntry = sessions.get(targetSessionId);
    const targetName = targetEntry && targetEntry.meta ? targetEntry.meta.name : 'agent';
    showToast(`Sent to ${targetName}`);

    // Reset — clear capture, annotations, and selection
    browserAgentBar.classList.add('hidden');
    browserAgentPrompt.value = '';
    _browserScreenshotData = null;
    _selectedElementInfo = null;
    _annotations = [];
    _clearOverlay();
    browserSelectionBox.classList.add('hidden');
    _exitBrowserMode();
  });
}

if (browserAgentCancel) {
  browserAgentCancel.addEventListener('click', () => {
    browserAgentBar.classList.add('hidden');
    browserAgentPrompt.value = '';
    _browserScreenshotData = null;
    _selectedElementInfo = null;
    _selectStart = null;
    browserSelectionBox.classList.add('hidden');
    browserSelectionBox.style.width = '0';
    browserSelectionBox.style.height = '0';
  });
}

// Boot
init();

const { app, BrowserWindow, ipcMain, protocol, systemPreferences, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');

// Suppress EPIPE errors from dead PTY/IPC channels (non-fatal)
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE' || err.message === 'write EPIPE') return;
  console.error('Uncaught exception:', err);
});
const { SessionManager } = require('./session-manager');
const { ProjectManager } = require('./project-manager');
const { FileManager } = require('./file-manager');
const { SettingsManager } = require('./settings-manager');
const { ContextManager } = require('./context-manager');
const { SwarmManager } = require('./swarm-manager');
const { SearchManager } = require('./search-manager');
const { AuditManager } = require('./audit-manager');
const { initProjectSafety } = require('./safety');
const { PolicyEngine } = require('./policy-engine');
const { LivePrototypeManager } = require('./live-prototype-manager');

let mainWindow;
let sessionManager;
let projectManager;
let fileManager;
let settingsManager;
let contextManager;
let swarmManager;
let searchManager;
let auditManager;
let policyEngine;
let livePrototypeManager;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Dan IDE',
    icon: path.join(__dirname, '../../assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webviewTag: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Open DevTools in dev mode
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(() => {
  // Set dock icon on macOS
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(path.join(__dirname, '../../assets/icon.png'));
  }

  projectManager = new ProjectManager();
  sessionManager = new SessionManager();
  fileManager = new FileManager();
  settingsManager = new SettingsManager();
  contextManager = new ContextManager();
  auditManager = new AuditManager();
  policyEngine = new PolicyEngine();
  searchManager = new SearchManager();
  swarmManager = new SwarmManager(sessionManager, contextManager);
  livePrototypeManager = new LivePrototypeManager(sessionManager, settingsManager);

  createWindow();

  // Handle media permissions (microphone for live prototype)
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(true);
  });
  mainWindow.webContents.session.setPermissionCheckHandler(() => {
    return true;
  });
  if (mainWindow.webContents.session.setDevicePermissionHandler) {
    mainWindow.webContents.session.setDevicePermissionHandler(() => true);
  }

  // Request microphone access on macOS
  if (process.platform === 'darwin' && systemPreferences.askForMediaAccess) {
    systemPreferences.askForMediaAccess('microphone').then((granted) => {
      if (!granted) {
        console.log('Microphone access not granted — enable in System Settings > Privacy > Microphone');
      }
    });
    const screenStatus = systemPreferences.getMediaAccessStatus('screen');
    if (screenStatus !== 'granted') {
      console.log(`Screen recording: ${screenStatus} — system audio capture requires Screen Recording permission`);
    }
  }

  // Initialize shared context for all existing projects
  for (const project of projectManager.list()) {
    contextManager.initProject(project.path, project.id);
    contextManager.watchProject(project.path, project.id, sessionManager.listAll());
  }

  // Project IPC
  ipcMain.handle('projects:list', () => projectManager.list());
  ipcMain.handle('projects:add', (_, folderPath) => {
    const project = projectManager.add(folderPath);
    initProjectSafety(folderPath);
    contextManager.initProject(folderPath, project.id);
    return project;
  });
  ipcMain.handle('projects:remove', (_, id) => projectManager.remove(id));
  ipcMain.handle('projects:get', (_, id) => projectManager.get(id));

  // Session IPC
  ipcMain.handle('sessions:create', (_, opts) => {
    // Initialize context for project before spawning agent
    if (opts.projectPath && opts.projectId) {
      contextManager.initProject(opts.projectPath, opts.projectId);
      const activeSessions = sessionManager.listAll();
      contextManager.rebuildContext(opts.projectPath, opts.projectId, activeSessions);
      contextManager.watchProject(opts.projectPath, opts.projectId, activeSessions);
    }

    const session = sessionManager.create(opts);
    wireSession(session);
    auditManager.logEvent({ type: 'session_start', agentName: session.name || session.id, description: `Session started (cli: ${opts.cli || 'claude'})`, projectId: opts.projectId, sessionId: session.id });
    // Rebuild context now that new agent is listed
    if (opts.projectPath && opts.projectId) {
      contextManager.rebuildContext(opts.projectPath, opts.projectId, sessionManager.listAll());
    }
    return session.toJSON();
  });

  ipcMain.handle('sessions:listAll', () => sessionManager.listAll());
  ipcMain.handle('sessions:list', (_, projectId) => sessionManager.listForProject(projectId));
  ipcMain.handle('sessions:write', (_, { id, data }) => sessionManager.write(id, data));
  ipcMain.handle('sessions:resize', (_, { id, cols, rows }) => sessionManager.resize(id, cols, rows));
  ipcMain.handle('sessions:stop', (_, id) => {
    const session = sessionManager.sessions.get(id);
    sessionManager.stop(id);
    auditManager.logEvent({ type: 'session_stop', agentName: (session && session.name) || id, description: 'Session stopped', projectId: session && session.projectId, sessionId: id });
    if (session && session.projectPath && session.projectId) {
      contextManager.rebuildContext(session.projectPath, session.projectId, sessionManager.listAll());
    }
  });
  ipcMain.handle('sessions:remove', (_, id) => {
    const session = sessionManager.sessions.get(id);
    sessionManager.remove(id);
    if (session && session.projectPath && session.projectId) {
      contextManager.rebuildContext(session.projectPath, session.projectId, sessionManager.listAll());
    }
  });
  ipcMain.handle('sessions:rename', (_, { id, name }) => sessionManager.rename(id, name));
  ipcMain.handle('sessions:getHistory', (_, id) => sessionManager.getHistory(id));
  ipcMain.handle('sessions:getHistoryByPath', (_, filePath) => sessionManager.getHistoryByPath(filePath));
  ipcMain.handle('sessions:loadState', () => sessionManager.loadState());

  ipcMain.handle('sessions:restart', (_, id) => {
    const session = sessionManager.restart(id);
    if (session) wireSession(session);
    return session ? session.toJSON() : null;
  });

  // File system IPC
  ipcMain.handle('files:tree', (_, dirPath) => fileManager.readTree(dirPath));
  ipcMain.handle('files:read', (_, filePath) => fileManager.readFile(filePath));
  ipcMain.handle('files:write', (_, { filePath, content }) => fileManager.writeFile(filePath, content));
  ipcMain.handle('files:language', (_, filePath) => fileManager.getLanguage(filePath));

  // Settings IPC
  ipcMain.handle('settings:load', () => settingsManager.load());
  ipcMain.handle('settings:save', (_, patch) => settingsManager.save(patch));
  ipcMain.handle('settings:loadWorkspace', (_, projectId) => settingsManager.loadWorkspace(projectId));
  ipcMain.handle('settings:saveWorkspace', (_, { projectId, patch }) => settingsManager.saveWorkspace(projectId, patch));

  // Context IPC
  ipcMain.handle('context:rebuild', (_, { projectPath, projectId }) => {
    contextManager.rebuildContext(projectPath, projectId, sessionManager.listAll());
    return true;
  });
  ipcMain.handle('context:postMessage', (_, { projectPath, projectId, fromAgent, message }) => {
    contextManager.postMessage(projectPath, projectId, fromAgent, message);
    return true;
  });
  ipcMain.handle('context:init', (_, { projectPath, projectId }) => {
    contextManager.initProject(projectPath, projectId);
    contextManager.watchProject(projectPath, projectId, sessionManager.listAll());
    return true;
  });
  ipcMain.handle('context:readMessages', (_, projectId) => {
    const { workspaceMemoryDir } = require('./paths');
    const messagesFile = path.join(workspaceMemoryDir(projectId), 'MESSAGES.md');
    try {
      return fs.readFileSync(messagesFile, 'utf8');
    } catch {
      return '';
    }
  });
  ipcMain.handle('context:clearMessages', (_, projectId) => {
    const { workspaceMemoryDir } = require('./paths');
    const messagesFile = path.join(workspaceMemoryDir(projectId), 'MESSAGES.md');
    try { fs.writeFileSync(messagesFile, ''); } catch {}
    return true;
  });

  // Swarm IPC
  ipcMain.handle('swarm:create', (_, opts) => {
    const swarm = swarmManager.create(opts);
    // Wire each spawned session for live output
    for (const sessionId of swarm.sessionIds) {
      const session = sessionManager.sessions.get(sessionId);
      if (session) wireSession(session);
    }
    auditManager.logEvent({ type: 'swarm_created', agentName: 'system', description: `Swarm launched with ${swarm.sessionIds.length} agents`, projectId: opts.projectPath });
    return swarm;
  });
  ipcMain.handle('swarm:list', () => swarmManager.list());
  ipcMain.handle('swarm:listForProject', (_, projectId) => swarmManager.listForProject(projectId));
  ipcMain.handle('swarm:get', (_, swarmId) => swarmManager.get(swarmId));
  ipcMain.handle('swarm:progress', (_, swarmId) => swarmManager.checkProgress(swarmId));
  ipcMain.handle('swarm:activeForProject', (_, projectId) => swarmManager.getActiveSwarmForProject(projectId));
  ipcMain.handle('swarm:stop', (_, swarmId) => {
    swarmManager.stop(swarmId);
    return true;
  });
  ipcMain.handle('swarm:remove', (_, swarmId) => {
    swarmManager.remove(swarmId);
    return true;
  });

  // Policy IPC
  ipcMain.handle('policy:list', (_, projectPath) => policyEngine.getPolicies(projectPath));
  ipcMain.handle('policy:update', (_, { projectPath, policies }) => policyEngine.updatePolicies(projectPath, policies));
  ipcMain.handle('policy:generate', (_, projectPath) => policyEngine.generatePolicyPrompt(projectPath));

  // Audit IPC
  ipcMain.handle('audit:getEvents', (_, opts) => auditManager.getEvents(opts.projectId, { limit: opts.limit, since: opts.since }));
  ipcMain.handle('audit:getAll', (_, limit) => auditManager.getAll(limit));

  // Search IPC
  ipcMain.handle('search:query', (_, { projectPath, query }) => searchManager.search(projectPath, query));
  ipcMain.handle('search:structure', (_, projectPath) => searchManager.getFileStructure(projectPath));
  ipcMain.handle('search:fileSummary', (_, filePath) => searchManager.getFileSummary(filePath));


  // File watcher
  let fileWatcher = null;
  ipcMain.handle('files:watch', (_, dirPath) => {
    if (fileWatcher) { fileWatcher.close(); fileWatcher = null; }
    try {
      fileWatcher = fs.watch(dirPath, { recursive: true }, (eventType, filename) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('files:changed', { eventType, filename });
        }
      });
    } catch (e) { /* ignore watch errors */ }
    return true;
  });
  ipcMain.handle('files:unwatch', () => {
    if (fileWatcher) { fileWatcher.close(); fileWatcher = null; }
    return true;
  });

  // Open URL in native browser
  ipcMain.handle('shell:openExternal', (_, url) => {
    const { shell } = require('electron');
    shell.openExternal(url);
  });

  // Dialog for folder picker
  ipcMain.handle('dialog:openFolder', async () => {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    });
    if (result.canceled) return null;
    return result.filePaths[0];
  });

  // Browser screenshot - save to ~/.dan-ide/workspaces/<id>/screenshots/
  ipcMain.handle('browser:saveScreenshot', (_, { projectId, dataUrl, filename }) => {
    const { workspaceScreenshotsDir } = require('./paths');
    const screenshotsDir = workspaceScreenshotsDir(projectId);
    fs.mkdirSync(screenshotsDir, { recursive: true });
    const fname = filename || `screenshot-${Date.now()}.png`;
    const filePath = path.join(screenshotsDir, fname);
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
    return filePath;
  });

  // List screenshots
  ipcMain.handle('browser:listScreenshots', (_, projectId) => {
    const { workspaceScreenshotsDir } = require('./paths');
    const screenshotsDir = workspaceScreenshotsDir(projectId);
    try {
      return fs.readdirSync(screenshotsDir)
        .filter(f => f.endsWith('.png'))
        .map(f => ({ name: f, path: path.join(screenshotsDir, f) }));
    } catch { return []; }
  });

  // Live Prototype IPC
  ipcMain.handle('livePrototype:start', (_, mode) => {
    livePrototypeManager.start(mode);
    return true;
  });
  ipcMain.handle('livePrototype:stop', () => {
    livePrototypeManager.stop();
    return true;
  });
  ipcMain.handle('livePrototype:feed', (_, { text, speaker }) => {
    livePrototypeManager.feedTranscript(text, speaker);
    return true;
  });
  ipcMain.handle('livePrototype:forceDetect', (_, description) => {
    return livePrototypeManager.forceDetect(description);
  });
  ipcMain.handle('livePrototype:confirm', async (_, { editedDescription, editedName }) => {
    return await livePrototypeManager.confirmProposal(editedDescription, editedName);
  });
  ipcMain.handle('livePrototype:dismiss', () => {
    livePrototypeManager.dismissProposal();
    return true;
  });
  ipcMain.handle('livePrototype:stopBuild', () => {
    livePrototypeManager.stopPrototype();
    return true;
  });
  ipcMain.handle('livePrototype:attach', (_, attachment) => {
    livePrototypeManager.addAttachment(attachment);
    return true;
  });
  ipcMain.handle('livePrototype:removeAttachment', (_, index) => {
    livePrototypeManager.removeAttachment(index);
    return true;
  });
  ipcMain.handle('livePrototype:status', () => {
    return livePrototypeManager.status;
  });
  ipcMain.handle('livePrototype:getThoughts', () => {
    return livePrototypeManager.getThoughts();
  });
  ipcMain.handle('livePrototype:sendAudio', (_, buffer) => {
    livePrototypeManager.sendAudio(Buffer.from(buffer));
    return true;
  });

  // Desktop capturer for system audio
  ipcMain.handle('desktop:getSources', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
    return sources.map(s => ({ id: s.id, name: s.name }));
  });

  // File dialog for attaching docs
  ipcMain.handle('dialog:openFile', async () => {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        { name: 'Documents', extensions: ['pdf', 'md', 'txt', 'json', 'csv', 'html'] },
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'svg'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled) return null;
    return result.filePaths[0];
  });

  // Wire live prototype events to renderer
  livePrototypeManager.on('state', (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('livePrototype:state', state);
    }
  });
  livePrototypeManager.on('transcript', (chunk) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('livePrototype:transcript', chunk);
    }
  });
  livePrototypeManager.on('proposal', (proposal) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('livePrototype:proposal', proposal);
    }
  });
  livePrototypeManager.on('serverReady', (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('livePrototype:serverReady', info);
    }
  });
  livePrototypeManager.on('attachments', (attachments) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('livePrototype:attachments', attachments);
    }
  });
  livePrototypeManager.on('error', (err) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('livePrototype:error', err);
    }
  });
  livePrototypeManager.on('thought', (thought) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('livePrototype:thought', thought);
    }
  });
  livePrototypeManager.on('prototypeStatus', (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('livePrototype:prototypeStatus', status);
    }
  });
  livePrototypeManager.on('subagent', (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('livePrototype:subagent', info);
    }
  });
  livePrototypeManager.on('builderSession', (info) => {
    const session = sessionManager.sessions.get(info.sessionId);
    if (session) {
      wireSession(session);
    }
  });
});

function wireSession(session) {
  session.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`session:data:${session.id}`, data);
    }
  });
  session.onExit((code) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`session:exit:${session.id}`, code);
    }
  });
}

app.on('window-all-closed', () => {
  contextManager.stopAll();
  sessionManager.stopAll();
  app.quit();
});

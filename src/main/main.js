const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
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
const { TestRunner } = require('./test-runner');

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
let testRunner;

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
  projectManager = new ProjectManager();
  sessionManager = new SessionManager();
  fileManager = new FileManager();
  settingsManager = new SettingsManager();
  contextManager = new ContextManager();
  auditManager = new AuditManager();
  policyEngine = new PolicyEngine();
  testRunner = new TestRunner();
  searchManager = new SearchManager();
  swarmManager = new SwarmManager(sessionManager, contextManager);

  createWindow();

  // Initialize shared context for all existing projects
  for (const project of projectManager.list()) {
    contextManager.initProject(project.path);
    contextManager.watchProject(project.path, sessionManager.listAll());
  }

  // Project IPC
  ipcMain.handle('projects:list', () => projectManager.list());
  ipcMain.handle('projects:add', (_, folderPath) => {
    const project = projectManager.add(folderPath);
    initProjectSafety(folderPath);
    contextManager.initProject(folderPath);
    return project;
  });
  ipcMain.handle('projects:remove', (_, id) => projectManager.remove(id));
  ipcMain.handle('projects:get', (_, id) => projectManager.get(id));

  // Session IPC
  ipcMain.handle('sessions:create', (_, opts) => {
    // Initialize context for project before spawning agent
    if (opts.projectPath) {
      contextManager.initProject(opts.projectPath);
      const activeSessions = sessionManager.listAll();
      contextManager.rebuildContext(opts.projectPath, activeSessions);
      contextManager.watchProject(opts.projectPath, activeSessions);
    }

    const session = sessionManager.create(opts);
    wireSession(session);
    auditManager.logEvent({ type: 'session_start', agentName: session.name || session.id, description: `Session started (cli: ${opts.cli || 'claude'})`, projectId: opts.projectPath, sessionId: session.id });
    // Rebuild context now that new agent is listed
    if (opts.projectPath) {
      contextManager.rebuildContext(opts.projectPath, sessionManager.listAll());
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
    auditManager.logEvent({ type: 'session_stop', agentName: (session && session.name) || id, description: 'Session stopped', projectId: session && session.projectPath, sessionId: id });
    if (session && session.projectPath) {
      contextManager.rebuildContext(session.projectPath, sessionManager.listAll());
    }
  });
  ipcMain.handle('sessions:remove', (_, id) => {
    const session = sessionManager.sessions.get(id);
    sessionManager.remove(id);
    if (session && session.projectPath) {
      contextManager.rebuildContext(session.projectPath, sessionManager.listAll());
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

  // Context IPC
  ipcMain.handle('context:rebuild', (_, projectPath) => {
    contextManager.rebuildContext(projectPath, sessionManager.listAll());
    return true;
  });
  ipcMain.handle('context:postMessage', (_, { projectPath, fromAgent, message }) => {
    contextManager.postMessage(projectPath, fromAgent, message);
    return true;
  });
  ipcMain.handle('context:init', (_, projectPath) => {
    contextManager.initProject(projectPath);
    contextManager.watchProject(projectPath, sessionManager.listAll());
    return true;
  });
  ipcMain.handle('context:readMessages', (_, projectPath) => {
    const messagesFile = path.join(projectPath, '.dan-ide', 'memory', 'MESSAGES.md');
    try {
      return fs.readFileSync(messagesFile, 'utf8');
    } catch {
      return '';
    }
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

  // Test Runner IPC
  ipcMain.handle('tests:detect', (_, projectPath) => testRunner.detect(projectPath));
  ipcMain.handle('tests:run', (_, projectPath) => testRunner.run(projectPath));
  ipcMain.handle('tests:runFile', (_, { projectPath, testFile }) => testRunner.runSpecific(projectPath, testFile));

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

  // Dialog for folder picker
  ipcMain.handle('dialog:openFolder', async () => {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    });
    if (result.canceled) return null;
    return result.filePaths[0];
  });

  // Browser screenshot - save to .dan-ide/screenshots/
  ipcMain.handle('browser:saveScreenshot', (_, { projectPath, dataUrl, filename }) => {
    const screenshotsDir = path.join(projectPath, '.dan-ide', 'screenshots');
    fs.mkdirSync(screenshotsDir, { recursive: true });
    const fname = filename || `screenshot-${Date.now()}.png`;
    const filePath = path.join(screenshotsDir, fname);
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
    return filePath;
  });

  // List screenshots
  ipcMain.handle('browser:listScreenshots', (_, projectPath) => {
    const screenshotsDir = path.join(projectPath, '.dan-ide', 'screenshots');
    try {
      return fs.readdirSync(screenshotsDir)
        .filter(f => f.endsWith('.png'))
        .map(f => ({ name: f, path: path.join(screenshotsDir, f) }));
    } catch { return []; }
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

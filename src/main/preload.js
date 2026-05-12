const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');

contextBridge.exposeInMainWorld('api', {
  // Projects
  listProjects: () => ipcRenderer.invoke('projects:list'),
  addProject: (folderPath) => ipcRenderer.invoke('projects:add', folderPath),
  removeProject: (id) => ipcRenderer.invoke('projects:remove', id),
  getProject: (id) => ipcRenderer.invoke('projects:get', id),

  // Sessions
  createSession: (opts) => ipcRenderer.invoke('sessions:create', opts),
  listSessions: (projectId) => ipcRenderer.invoke('sessions:list', projectId),
  listAllSessions: () => ipcRenderer.invoke('sessions:listAll'),
  writeSession: (id, data) => ipcRenderer.invoke('sessions:write', { id, data }),
  resizeSession: (id, cols, rows) => ipcRenderer.invoke('sessions:resize', { id, cols, rows }),
  stopSession: (id) => ipcRenderer.invoke('sessions:stop', id),
  removeSession: (id) => ipcRenderer.invoke('sessions:remove', id),
  renameSession: (id, name) => ipcRenderer.invoke('sessions:rename', { id, name }),
  restartSession: (id) => ipcRenderer.invoke('sessions:restart', id),
  getSessionHistory: (id) => ipcRenderer.invoke('sessions:getHistory', id),
  getHistoryByPath: (filePath) => ipcRenderer.invoke('sessions:getHistoryByPath', filePath),
  loadSessionState: () => ipcRenderer.invoke('sessions:loadState'),

  // Session data events
  onSessionData: (id, callback) => {
    const channel = `session:data:${id}`;
    const listener = (_, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onSessionExit: (id, callback) => {
    const channel = `session:exit:${id}`;
    const listener = (_, code) => callback(code);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  // Files
  getFileTree: (dirPath) => ipcRenderer.invoke('files:tree', dirPath),
  readFile: (filePath) => ipcRenderer.invoke('files:read', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('files:write', { filePath, content }),
  getFileLanguage: (filePath) => ipcRenderer.invoke('files:language', filePath),

  // Paths (for Monaco loader)
  getNodeModulesPath: () => path.join(__dirname, '..', '..', 'node_modules'),

  // Settings (file-based, persistent)
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),

  // Shared context
  initContext: (projectPath) => ipcRenderer.invoke('context:init', projectPath),
  rebuildContext: (projectPath) => ipcRenderer.invoke('context:rebuild', projectPath),
  postContextMessage: (projectPath, fromAgent, message) =>
    ipcRenderer.invoke('context:postMessage', { projectPath, fromAgent, message }),

  // File watcher
  watchProject: (dirPath) => ipcRenderer.invoke('files:watch', dirPath),
  unwatchProject: () => ipcRenderer.invoke('files:unwatch'),
  onFileChange: (callback) => {
    const channel = 'files:changed';
    const listener = (_, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  // Messages
  readMessages: (projectPath) => ipcRenderer.invoke('context:readMessages', projectPath),

  // Swarm
  createSwarm: (opts) => ipcRenderer.invoke('swarm:create', opts),
  listSwarms: () => ipcRenderer.invoke('swarm:list'),
  listSwarmsForProject: (projectId) => ipcRenderer.invoke('swarm:listForProject', projectId),
  getSwarm: (swarmId) => ipcRenderer.invoke('swarm:get', swarmId),
  getSwarmProgress: (swarmId) => ipcRenderer.invoke('swarm:progress', swarmId),
  getActiveSwarmForProject: (projectId) => ipcRenderer.invoke('swarm:activeForProject', projectId),
  stopSwarm: (swarmId) => ipcRenderer.invoke('swarm:stop', swarmId),
  removeSwarm: (swarmId) => ipcRenderer.invoke('swarm:remove', swarmId),

  // Policies
  listPolicies: (projectPath) => ipcRenderer.invoke('policy:list', projectPath),
  updatePolicies: (projectPath, policies) => ipcRenderer.invoke('policy:update', { projectPath, policies }),

  // Search
  searchProject: (projectPath, query) => ipcRenderer.invoke('search:query', { projectPath, query }),
  getProjectStructure: (projectPath) => ipcRenderer.invoke('search:structure', projectPath),
  getFileSummary: (filePath) => ipcRenderer.invoke('search:fileSummary', filePath),

  // Tests
  detectTests: (projectPath) => ipcRenderer.invoke('tests:detect', projectPath),
  runTests: (projectPath) => ipcRenderer.invoke('tests:run', projectPath),
  runTestFile: (projectPath, testFile) => ipcRenderer.invoke('tests:runFile', { projectPath, testFile }),

  // Audit
  getAuditEvents: (opts) => ipcRenderer.invoke('audit:getEvents', opts),
  getAllAuditEvents: (limit) => ipcRenderer.invoke('audit:getAll', limit),

  // Browser
  saveScreenshot: (projectPath, dataUrl, filename) =>
    ipcRenderer.invoke('browser:saveScreenshot', { projectPath, dataUrl, filename }),
  listScreenshots: (projectPath) => ipcRenderer.invoke('browser:listScreenshots', projectPath),


  // Dialogs
  openFolderDialog: () => ipcRenderer.invoke('dialog:openFolder'),
});

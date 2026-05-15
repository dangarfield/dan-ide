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
  loadWorkspaceSettings: (projectId) => ipcRenderer.invoke('settings:loadWorkspace', projectId),
  saveWorkspaceSettings: (projectId, patch) => ipcRenderer.invoke('settings:saveWorkspace', { projectId, patch }),

  // Shared context
  initContext: (projectPath, projectId) => ipcRenderer.invoke('context:init', { projectPath, projectId }),
  rebuildContext: (projectPath, projectId) => ipcRenderer.invoke('context:rebuild', { projectPath, projectId }),
  postContextMessage: (projectPath, projectId, fromAgent, message) =>
    ipcRenderer.invoke('context:postMessage', { projectPath, projectId, fromAgent, message }),

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
  readMessages: (projectId) => ipcRenderer.invoke('context:readMessages', projectId),
  clearMessages: (projectId) => ipcRenderer.invoke('context:clearMessages', projectId),

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


  // Audit
  getAuditEvents: (opts) => ipcRenderer.invoke('audit:getEvents', opts),
  getAllAuditEvents: (limit) => ipcRenderer.invoke('audit:getAll', limit),

  // Browser
  saveScreenshot: (projectId, dataUrl, filename) =>
    ipcRenderer.invoke('browser:saveScreenshot', { projectId, dataUrl, filename }),
  listScreenshots: (projectId) => ipcRenderer.invoke('browser:listScreenshots', projectId),


  // Dialogs
  openFolderDialog: () => ipcRenderer.invoke('dialog:openFolder'),
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // Desktop capturer (for system audio)
  getDesktopSources: () => ipcRenderer.invoke('desktop:getSources'),

  // Live Prototype
  livePrototypeStart: (mode) => ipcRenderer.invoke('livePrototype:start', mode),
  livePrototypeStop: () => ipcRenderer.invoke('livePrototype:stop'),
  livePrototypeFeed: (text, speaker) => ipcRenderer.invoke('livePrototype:feed', { text, speaker }),
  livePrototypeForce: (description) => ipcRenderer.invoke('livePrototype:forceDetect', description),
  livePrototypeConfirm: (editedDescription, editedName) => ipcRenderer.invoke('livePrototype:confirm', { editedDescription, editedName }),
  livePrototypeDismiss: () => ipcRenderer.invoke('livePrototype:dismiss'),
  livePrototypeStopBuild: () => ipcRenderer.invoke('livePrototype:stopBuild'),
  livePrototypeAttach: (attachment) => ipcRenderer.invoke('livePrototype:attach', attachment),
  livePrototypeRemoveAttachment: (index) => ipcRenderer.invoke('livePrototype:removeAttachment', index),
  livePrototypeStatus: () => ipcRenderer.invoke('livePrototype:status'),
  livePrototypeGetThoughts: () => ipcRenderer.invoke('livePrototype:getThoughts'),
  livePrototypeSendAudio: (buffer) => ipcRenderer.invoke('livePrototype:sendAudio', buffer),

  onLivePrototypeState: (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on('livePrototype:state', listener);
    return () => ipcRenderer.removeListener('livePrototype:state', listener);
  },
  onLivePrototypeTranscript: (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on('livePrototype:transcript', listener);
    return () => ipcRenderer.removeListener('livePrototype:transcript', listener);
  },
  onLivePrototypeProposal: (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on('livePrototype:proposal', listener);
    return () => ipcRenderer.removeListener('livePrototype:proposal', listener);
  },
  onLivePrototypeServerReady: (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on('livePrototype:serverReady', listener);
    return () => ipcRenderer.removeListener('livePrototype:serverReady', listener);
  },
  onLivePrototypeAttachments: (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on('livePrototype:attachments', listener);
    return () => ipcRenderer.removeListener('livePrototype:attachments', listener);
  },
  onLivePrototypeError: (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on('livePrototype:error', listener);
    return () => ipcRenderer.removeListener('livePrototype:error', listener);
  },
  onLivePrototypePrototypeStatus: (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on('livePrototype:prototypeStatus', listener);
    return () => ipcRenderer.removeListener('livePrototype:prototypeStatus', listener);
  },
  onLivePrototypeSubagent: (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on('livePrototype:subagent', listener);
    return () => ipcRenderer.removeListener('livePrototype:subagent', listener);
  },
  onLivePrototypeThought: (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on('livePrototype:thought', listener);
    return () => ipcRenderer.removeListener('livePrototype:thought', listener);
  },
  onLivePrototypeThinkerSession: (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on('livePrototype:thinkerSession', listener);
    return () => ipcRenderer.removeListener('livePrototype:thinkerSession', listener);
  },
});

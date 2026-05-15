const fs = require('fs');
const path = require('path');
const { GLOBAL_DIR, workspaceSettingsFile, workspaceDir } = require('./paths');

const SETTINGS_FILE = path.join(GLOBAL_DIR, 'settings.json');

class SettingsManager {
  constructor() {
    fs.mkdirSync(GLOBAL_DIR, { recursive: true });
    this._cache = this._read();
  }

  _read() {
    try {
      const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
      return JSON.parse(data);
    } catch {
      return {};
    }
  }

  _write() {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(this._cache, null, 2));
  }

  load() {
    this._cache = this._read();
    return this._cache;
  }

  save(patch) {
    this._cache = { ...this._cache, ...patch };
    this._write();
    return this._cache;
  }

  get(key) {
    return this._cache[key];
  }

  // Workspace-level settings (stored in ~/.dan-ide/workspaces/<projectId>/settings.json)
  loadWorkspace(projectId) {
    const wsFile = workspaceSettingsFile(projectId);
    try {
      const data = fs.readFileSync(wsFile, 'utf8');
      return JSON.parse(data);
    } catch {
      return {};
    }
  }

  saveWorkspace(projectId, patch) {
    const wsDir = workspaceDir(projectId);
    const wsFile = workspaceSettingsFile(projectId);
    fs.mkdirSync(wsDir, { recursive: true });
    let current = {};
    try {
      current = JSON.parse(fs.readFileSync(wsFile, 'utf8'));
    } catch {}
    const merged = { ...current, ...patch };
    fs.writeFileSync(wsFile, JSON.stringify(merged, null, 2));
    return merged;
  }
}

module.exports = { SettingsManager };

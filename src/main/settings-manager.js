const fs = require('fs');
const path = require('path');
const os = require('os');

const GLOBAL_STATE_DIR = path.join(os.homedir(), '.dan-ide');
const SETTINGS_FILE = path.join(GLOBAL_STATE_DIR, 'settings.json');

class SettingsManager {
  constructor() {
    fs.mkdirSync(GLOBAL_STATE_DIR, { recursive: true });
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
}

module.exports = { SettingsManager };

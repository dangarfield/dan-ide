const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_DIR = path.join(require('os').homedir(), '.dan-ide');
const PROJECTS_FILE = path.join(CONFIG_DIR, 'projects.json');

class ProjectManager {
  constructor() {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    this.projects = this._load();
  }

  _load() {
    try {
      const data = fs.readFileSync(PROJECTS_FILE, 'utf8');
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  _save() {
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(this.projects, null, 2));
  }

  list() {
    return this.projects;
  }

  add(folderPath) {
    // Check if already exists
    const existing = this.projects.find((p) => p.path === folderPath);
    if (existing) return existing;

    const project = {
      id: crypto.randomUUID(),
      name: path.basename(folderPath),
      path: folderPath,
      addedAt: new Date().toISOString(),
    };

    // Initialize .dan-ide structure in project
    const danIdeDir = path.join(folderPath, '.dan-ide');
    fs.mkdirSync(path.join(danIdeDir, 'memory'), { recursive: true });
    fs.mkdirSync(path.join(danIdeDir, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(danIdeDir, 'tasks'), { recursive: true });

    // Create initial shared memory file
    const sharedMemPath = path.join(danIdeDir, 'memory', 'SHARED.md');
    if (!fs.existsSync(sharedMemPath)) {
      fs.writeFileSync(sharedMemPath, `# Shared Project Memory\n\nThis file is shared across all AI agent sessions in this project.\nAgents should read this before starting work and update it with important findings.\n\n## Project Notes\n\n## Active Tasks\n\n## Decisions Made\n`);
    }

    // Create config
    const configPath = path.join(danIdeDir, 'config.yaml');
    if (!fs.existsSync(configPath)) {
      fs.writeFileSync(configPath, `# Dan IDE project config\ndefault_cli: claude\nallowed_clis:\n  - claude\n  - kiro\n  - aider\n  - shell\n`);
    }

    this.projects.push(project);
    this._save();
    return project;
  }

  remove(id) {
    this.projects = this.projects.filter((p) => p.id !== id);
    this._save();
  }

  get(id) {
    return this.projects.find((p) => p.id === id) || null;
  }
}

module.exports = { ProjectManager };

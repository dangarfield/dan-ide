/**
 * Centralized path resolution for Dan IDE.
 *
 * Global data: ~/.dan-ide/
 *   settings.json, projects.json, audit.jsonl
 *   workspaces/<projectId>/  — per-workspace state
 *     settings.json
 *     memory/ (SHARED.md, MESSAGES.md, CONTEXT.md)
 *     sessions/
 *     screenshots/
 *     swarms/
 *     tasks/
 *
 * Project directory: <project>/
 *   .dan-ide/CLAUDE.md  — agent instructions (points to absolute paths)
 *   .kiro/rules/        — Kiro agent rules
 */

const path = require('path');
const os = require('os');

const GLOBAL_DIR = path.join(os.homedir(), '.dan-ide');

function globalDir() {
  return GLOBAL_DIR;
}

function workspaceDir(projectId) {
  return path.join(GLOBAL_DIR, 'workspaces', projectId);
}

function workspaceMemoryDir(projectId) {
  return path.join(GLOBAL_DIR, 'workspaces', projectId, 'memory');
}

function workspaceSessionsDir(projectId) {
  return path.join(GLOBAL_DIR, 'workspaces', projectId, 'sessions');
}

function workspaceScreenshotsDir(projectId) {
  return path.join(GLOBAL_DIR, 'workspaces', projectId, 'screenshots');
}

function workspaceSettingsFile(projectId) {
  return path.join(GLOBAL_DIR, 'workspaces', projectId, 'settings.json');
}

module.exports = {
  GLOBAL_DIR,
  globalDir,
  workspaceDir,
  workspaceMemoryDir,
  workspaceSessionsDir,
  workspaceScreenshotsDir,
  workspaceSettingsFile,
};

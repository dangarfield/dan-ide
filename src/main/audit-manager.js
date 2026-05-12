const fs = require('fs');
const path = require('path');

class AuditManager {
  constructor() {
    this.events = [];
  }

  /**
   * Log an audit event.
   * @param {object} event - { timestamp, agentName, type, description, projectId, sessionId }
   */
  logEvent(event) {
    const entry = {
      timestamp: event.timestamp || new Date().toISOString(),
      agentName: event.agentName || 'system',
      type: event.type || 'unknown',
      description: event.description || '',
      projectId: event.projectId || null,
      sessionId: event.sessionId || null,
    };
    this.events.push(entry);
    this._persist(entry);
    return entry;
  }

  /**
   * Get events filtered by projectId with optional limit and since.
   */
  getEvents(projectId, { limit, since } = {}) {
    let filtered = this.events.filter((e) => e.projectId === projectId);
    if (since) {
      const sinceDate = new Date(since);
      filtered = filtered.filter((e) => new Date(e.timestamp) >= sinceDate);
    }
    // Most recent first
    filtered = filtered.slice().reverse();
    if (limit) {
      filtered = filtered.slice(0, limit);
    }
    return filtered;
  }

  /**
   * Get events for a specific session.
   */
  getEventsForSession(sessionId) {
    return this.events.filter((e) => e.sessionId === sessionId).slice().reverse();
  }

  /**
   * Get all events with optional limit (most recent first).
   */
  getAll(limit) {
    const all = this.events.slice().reverse();
    if (limit) return all.slice(0, limit);
    return all;
  }

  /**
   * Load events from persisted audit.jsonl files across all projects.
   */
  loadFromFile(projectPath) {
    const auditFile = path.join(projectPath, '.dan-ide', 'audit.jsonl');
    try {
      if (fs.existsSync(auditFile)) {
        const lines = fs.readFileSync(auditFile, 'utf8').split('\n').filter((l) => l.trim());
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            this.events.push(entry);
          } catch { /* skip malformed lines */ }
        }
      }
    } catch { /* ignore read errors */ }
  }

  /**
   * Persist a single event to the project's audit.jsonl file.
   */
  _persist(entry) {
    if (!entry.projectId) return;
    try {
      const danIdeDir = path.join(entry.projectId, '.dan-ide');
      if (!fs.existsSync(danIdeDir)) {
        fs.mkdirSync(danIdeDir, { recursive: true });
      }
      const auditFile = path.join(danIdeDir, 'audit.jsonl');
      fs.appendFileSync(auditFile, JSON.stringify(entry) + '\n');
    } catch { /* ignore write errors */ }
  }
}

module.exports = { AuditManager };

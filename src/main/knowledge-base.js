const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class KnowledgeProvider {
  constructor(config) {
    this.name = config.name;
    this.type = config.type;
    this.config = config;
  }

  canHandle(query) { return false; }
  async query(query) { return null; }
}

class CLIProvider extends KnowledgeProvider {
  constructor(config) {
    super(config);
  }

  canHandle() { return true; }

  async query({ entities, domain, context }) {
    const cmd = this.config.command;
    const args = [...(this.config.args || [])];

    if (entities && entities.length > 0) {
      args.push('--entities', entities.join(','));
    }
    if (domain) {
      args.push('--domain', domain);
    }

    return new Promise((resolve) => {
      const proc = spawn(cmd, args, { timeout: 5000, shell: true });
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        if (code !== 0 || !stdout.trim()) {
          resolve(null);
          return;
        }
        try {
          const data = JSON.parse(stdout);
          resolve({ data, source: this.name, confidence: 0.8 });
        } catch {
          resolve({ data: stdout.trim(), source: this.name, confidence: 0.5 });
        }
      });

      proc.on('error', () => resolve(null));
    });
  }
}

class LocalFileProvider extends KnowledgeProvider {
  constructor(config) {
    super(config);
  }

  canHandle({ entities, domain }) {
    if (!this.config.paths || this.config.paths.length === 0) return false;
    return true;
  }

  async query({ entities, domain }) {
    const results = [];
    const paths = this.config.paths || [];

    for (const p of paths) {
      const resolved = p.replace(/^~/, require('os').homedir());
      try {
        const stat = fs.statSync(resolved);
        if (stat.isDirectory()) {
          const files = fs.readdirSync(resolved).filter(f => f.endsWith('.json'));
          for (const file of files.slice(0, 5)) {
            const content = fs.readFileSync(path.join(resolved, file), 'utf8');
            try {
              results.push({ file, data: JSON.parse(content) });
            } catch {}
          }
        } else if (resolved.endsWith('.json')) {
          const content = fs.readFileSync(resolved, 'utf8');
          results.push({ file: resolved, data: JSON.parse(content) });
        }
      } catch {}
    }

    if (results.length === 0) return null;
    return { data: results, source: this.name, confidence: 0.7 };
  }
}

class MCPProvider extends KnowledgeProvider {
  constructor(config) {
    super(config);
  }

  canHandle() { return true; }

  async query({ entities, domain, context }) {
    // MCP provider calls an MCP server via stdio
    const cmd = this.config.command;
    const args = this.config.args || [];

    const request = JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'query_data',
        arguments: { entities, domain, context },
      },
      id: 1,
    });

    return new Promise((resolve) => {
      const proc = spawn(cmd, args, { timeout: 5000, shell: true });
      let stdout = '';

      proc.stdin.write(request + '\n');
      proc.stdin.end();

      proc.stdout.on('data', (d) => { stdout += d.toString(); });

      proc.on('close', () => {
        try {
          const response = JSON.parse(stdout);
          if (response.result && response.result.content) {
            resolve({ data: response.result.content, source: this.name, confidence: 0.9 });
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });

      proc.on('error', () => resolve(null));
    });
  }
}

class KnowledgeBase extends EventEmitter {
  constructor(settings) {
    super();
    this._providers = [];
    this._settings = settings || {};
    this._initProviders();
  }

  _initProviders() {
    const providerConfigs = this._settings.providers || [];
    for (const config of providerConfigs) {
      switch (config.type) {
        case 'cli':
          this._providers.push(new CLIProvider(config));
          break;
        case 'local':
          this._providers.push(new LocalFileProvider(config));
          break;
        case 'mcp':
          this._providers.push(new MCPProvider(config));
          break;
      }
    }
  }

  updateSettings(settings) {
    this._settings = settings || {};
    this._providers = [];
    this._initProviders();
  }

  listProviders() {
    return this._providers.map(p => ({ name: p.name, type: p.type }));
  }

  async query({ entities, domain, context }) {
    if (this._providers.length === 0) return null;

    const timeout = 3000;
    const promises = this._providers
      .filter(p => p.canHandle({ entities, domain }))
      .map(p =>
        Promise.race([
          p.query({ entities, domain, context }),
          new Promise(resolve => setTimeout(() => resolve(null), timeout)),
        ])
      );

    const results = await Promise.all(promises);
    const valid = results.filter(r => r !== null);

    if (valid.length === 0) return null;

    // Return highest confidence result
    valid.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    return valid[0];
  }
}

module.exports = { KnowledgeBase };

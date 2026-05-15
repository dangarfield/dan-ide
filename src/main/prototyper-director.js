const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { loadPrompt } = require('./prompt-loader');

const PROTOTYPE_BASE = path.join(os.homedir(), 'code', 'prototype');
const PROTOTYPES_DIR = path.join(PROTOTYPE_BASE, 'builds');

class PrototyperDirector extends EventEmitter {
  constructor(sessionManager, knowledgeBase) {
    super();
    this._sessionManager = sessionManager;
    this._knowledgeBase = knowledgeBase;
    this._status = 'idle';
    this._currentPrototype = null;
    this._builderSessionId = null;
    this._serverUrl = null;
    this._outputWatcher = null;
    this._subprocesses = [];
    fs.mkdirSync(PROTOTYPES_DIR, { recursive: true });
  }

  get status() { return this._status; }
  get currentPrototype() { return this._currentPrototype; }
  get serverUrl() { return this._serverUrl; }
  get outputDir() { return this._currentPrototype ? this._currentPrototype.dir : null; }

  async execute(proposal, attachments, clarifications, transcriptText) {
    this._status = 'directing';
    this._serverUrl = null;
    this.emit('status', { status: 'directing', phase: 'Starting...' });

    const name = proposal.suggestedName;
    const dir = path.join(PROTOTYPES_DIR, name);
    fs.mkdirSync(dir, { recursive: true });

    this._currentPrototype = {
      name,
      dir,
      description: proposal.description,
      startTime: Date.now(),
      attachments: attachments || [],
    };

    const contextDir = path.join(dir, '.context');
    fs.mkdirSync(contextDir, { recursive: true });
    this._saveAttachments(attachments, contextDir);

    // Phase 1: Parallel — Knowledge Gathering + Research Spec
    const [knowledgeResult, specResult] = await Promise.all([
      this._gatherKnowledge(proposal, transcriptText),
      this._generateSpec(proposal, transcriptText, clarifications),
    ]);

    // Phase 2: Synthesise
    this.emit('status', { status: 'directing', phase: 'Synthesising results...' });
    const enrichedSpec = this._synthesise(specResult, knowledgeResult);

    fs.writeFileSync(path.join(dir, 'SPEC.md'), [
      `# Prototype: ${name}`,
      '',
      `## Specification`,
      enrichedSpec,
      '',
      `## Generated`,
      `Date: ${new Date().toISOString()}`,
      `Source: ${proposal.source}`,
      '',
      knowledgeResult ? `## Knowledge Context\n${knowledgeResult.slice(0, 2000)}` : '',
    ].join('\n'));

    // Phase 3: Build
    this._status = 'building';
    this.emit('status', { status: 'building', phase: 'spawning-builder' });

    const enrichedProposal = { ...proposal, description: enrichedSpec };
    const sessionId = this._spawnBuilder(enrichedProposal, attachments, dir, knowledgeResult);

    this.emit('status', { status: 'building', phase: 'builder-running' });
    return { sessionId, dir, name, spec: enrichedSpec };
  }

  stop() {
    // Kill subprocesses
    for (const child of this._subprocesses) {
      try { child.kill(); } catch {}
    }
    this._subprocesses = [];

    // Kill server on port
    if (this._serverUrl) {
      try {
        const portMatch = this._serverUrl.match(/:(\d+)/);
        if (portMatch) {
          const { execSync } = require('child_process');
          execSync(`lsof -ti:${portMatch[1]} | xargs kill -9 2>/dev/null || true`);
        }
      } catch {}
    }

    // Kill builder session
    if (this._builderSessionId) {
      this._sessionManager.stop(this._builderSessionId);
    }

    if (this._outputWatcher) {
      this._outputWatcher.close();
      this._outputWatcher = null;
    }

    this._status = 'idle';
    this._currentPrototype = null;
    this._builderSessionId = null;
    this._serverUrl = null;
    this.emit('status', { status: 'idle' });
  }

  // ---- Subagent: Knowledge Gatherer ----

  async _gatherKnowledge(proposal, transcriptText) {
    this.emit('subagent', { agent: 'knowledge', status: 'running' });
    this.emit('status', { status: 'directing', phase: 'Gathering knowledge...' });

    try {
      // Extract entities from both proposal and transcript
      const proposalEntities = this._extractEntities(proposal.description);
      const transcriptEntities = this._extractEntities(transcriptText || '');
      const allEntities = [...new Set([...proposalEntities, ...transcriptEntities])].slice(0, 15);

      if (allEntities.length === 0 || !this._knowledgeBase) {
        this.emit('subagent', { agent: 'knowledge', status: 'complete', result: null });
        return null;
      }

      const result = await this._knowledgeBase.query({
        entities: allEntities,
        domain: proposal.description,
        context: transcriptText ? transcriptText.slice(-1000) : '',
      });

      if (result && result.data) {
        const text = typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2);
        this.emit('subagent', { agent: 'knowledge', status: 'complete', result: text.slice(0, 200) });
        return text;
      }
    } catch {}

    this.emit('subagent', { agent: 'knowledge', status: 'complete', result: null });
    return null;
  }

  // ---- Subagent: Researcher ----

  async _generateSpec(proposal, transcriptText, clarifications) {
    this.emit('subagent', { agent: 'researcher', status: 'running' });
    this.emit('status', { status: 'directing', phase: 'Generating detailed spec...' });

    const prompt = loadPrompt('prototyper-researcher-system', {
      KNOWLEDGE_CONTEXT: 'Knowledge is being gathered in parallel — focus on the proposal and transcript.',
      PROPOSAL: proposal.description,
      TRANSCRIPT: transcriptText ? transcriptText.slice(-3000) : 'No transcript available.',
      CLARIFICATIONS: clarifications || 'None provided.',
    });

    return new Promise((resolve) => {
      const child = spawn('claude', ['--print'], { timeout: 120000 });
      this._subprocesses.push(child);
      let stdout = '';

      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', () => {});

      child.on('close', () => {
        this._subprocesses = this._subprocesses.filter(c => c !== child);
        const spec = stdout.trim();
        if (spec && spec.length > 100) {
          this.emit('subagent', { agent: 'researcher', status: 'complete', result: `${spec.length} chars` });
          resolve(spec);
        } else {
          this.emit('subagent', { agent: 'researcher', status: 'failed' });
          resolve(proposal.description);
        }
      });

      child.on('error', () => {
        this._subprocesses = this._subprocesses.filter(c => c !== child);
        this.emit('subagent', { agent: 'researcher', status: 'failed' });
        resolve(proposal.description);
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  }

  // ---- Synthesise ----

  _synthesise(spec, knowledge) {
    if (!knowledge) return spec;

    // Append knowledge context as a reference section within the spec
    return `${spec}\n\n---\n\n## Organisational Context (from knowledge base)\n\n${knowledge.slice(0, 3000)}`;
  }

  // ---- Subagent: Builder ----

  _spawnBuilder(proposal, attachments, dir, knowledgeContext) {
    this.emit('subagent', { agent: 'builder', status: 'running' });

    let attachmentsText = 'None';
    if (attachments && attachments.length > 0) {
      attachmentsText = attachments.map(att => {
        if (att.savedPath) return `- ${att.name || att.type}: ${att.savedPath}`;
        if (att.content) return `- ${att.name}: (inline, ${att.content.length} chars)`;
        return `- ${att.name || att.type}`;
      }).join('\n');
    }

    const builderPrompt = loadPrompt('prototyper-builder-system', {
      OUTPUT_DIR: dir,
      SPEC: proposal.description,
      KNOWLEDGE_CONTEXT: knowledgeContext || 'No organisational context available.',
      ATTACHMENTS: attachmentsText,
      TRANSCRIPT_EXCERPT: proposal.transcriptExcerpt ? proposal.transcriptExcerpt.slice(-500) : 'No transcript context.',
    });

    fs.writeFileSync(path.join(dir, '.context', 'builder-prompt.txt'), builderPrompt);

    const session = this._sessionManager.create({
      name: `Builder: ${proposal.suggestedName.slice(0, 24)}`,
      projectId: null,
      projectPath: dir,
      cli: 'claude',
      role: null,
      systemPrompt: builderPrompt,
    });

    this._builderSessionId = session.id;

    session.onData((data) => {
      this._detectServerUrl(data);
    });

    session.onExit(() => {
      if (this._status !== 'idle') {
        this._status = 'done';
        this.emit('subagent', { agent: 'builder', status: 'complete' });
        this.emit('status', { status: 'done', dir, name: proposal.suggestedName, serverUrl: this._serverUrl });
      }
    });

    setTimeout(() => {
      if (session.status === 'running') {
        const instruction = loadPrompt('prototyper-builder-instruction', { OUTPUT_DIR: dir });
        session.write(instruction + '\r');
      }
    }, 3000);

    this._watchOutput(dir);
    return session.id;
  }

  // ---- Utilities ----

  _saveAttachments(attachments, contextDir) {
    if (!attachments || attachments.length === 0) return;
    for (const att of attachments) {
      if (att.type === 'screenshot' && att.dataUrl) {
        const fname = att.name || `attachment-${Date.now()}.png`;
        const filePath = path.join(contextDir, fname);
        const base64 = att.dataUrl.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
        att.savedPath = filePath;
      } else if (att.type === 'document' && att.path) {
        const fname = path.basename(att.path);
        const dest = path.join(contextDir, fname);
        try { fs.copyFileSync(att.path, dest); att.savedPath = dest; } catch {}
      }
    }
  }

  _detectServerUrl(data) {
    const text = data.toString();
    const patterns = [
      /https?:\/\/localhost:\d+/,
      /https?:\/\/127\.0\.0\.1:\d+/,
      /https?:\/\/0\.0\.0\.0:\d+/,
      /Serving!\s+.*?(https?:\/\/[^\s]+)/,
      /Local:\s+(https?:\/\/[^\s]+)/,
      /listening (?:on|at)\s+(https?:\/\/[^\s]+)/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const url = match[1] || match[0];
        if (url !== this._serverUrl) {
          this._serverUrl = url;
          this._status = 'serving';
          this.emit('subagent', { agent: 'builder', status: 'serving', url });
          this.emit('status', { status: 'serving', serverUrl: url });
          this.emit('serverReady', { url, dir: this._currentPrototype ? this._currentPrototype.dir : null, sessionId: this._builderSessionId });
        }
        break;
      }
    }
  }

  _watchOutput(dir) {
    if (this._outputWatcher) this._outputWatcher.close();
    try {
      this._outputWatcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
        if (filename && (filename.endsWith('.html') || filename.endsWith('.css') || filename.endsWith('.js'))) {
          this.emit('fileCreated', { dir, filename });
        }
      });
    } catch {}
  }

  _extractEntities(text) {
    if (!text) return [];
    const words = text.split(/\s+/);
    return [...new Set(
      words
        .filter(w => w.length > 3 && w[0] === w[0].toUpperCase())
        .map(w => w.replace(/[^a-zA-Z]/g, ''))
        .filter(w => w.length > 3)
    )].slice(0, 15);
  }
}

module.exports = { PrototyperDirector };

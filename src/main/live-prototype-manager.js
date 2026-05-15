const { EventEmitter } = require('events');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { TranscriptionManager } = require('./transcription-manager');
const { IntentDetector } = require('./intent-detector');
const { PrototyperDirector } = require('./prototyper-director');
const { KnowledgeBase } = require('./knowledge-base');
const { loadPrompt } = require('./prompt-loader');

const PROTOTYPE_BASE = path.join(os.homedir(), 'code', 'prototype');
const PROTOTYPE_SESSIONS_DIR = path.join(PROTOTYPE_BASE, 'sessions');


class LivePrototypeManager extends EventEmitter {
  constructor(sessionManager, settingsManager) {
    super();
    this._sessionManager = sessionManager;
    this._settingsManager = settingsManager;

    const settings = this._getSettings();
    this._transcription = new TranscriptionManager(settings);
    this._intentDetector = new IntentDetector(settings);
    this._knowledgeBase = new KnowledgeBase(settings.knowledgeBase || {});
    this._director = new PrototyperDirector(sessionManager, this._knowledgeBase);

    this._listening = false;
    this._attachments = [];
    this._thoughts = [];
    this._clarifications = [];
    this._thinkerSessionId = null;
    this._thinkTimer = null;
    this._lastThinkTranscriptLen = 0;

    // Ensure prototype dirs exist
    fs.mkdirSync(PROTOTYPE_SESSIONS_DIR, { recursive: true });

    this._wireEvents();
  }

  get isListening() { return this._listening; }
  get status() { return this._getStatus(); }
  get thinkerSessionId() { return this._thinkerSessionId; }
  get pendingProposal() { return this._intentDetector.pendingProposal; }
  get prototypeStatus() { return this._director.status; }
  get serverUrl() { return this._director.serverUrl; }

  start(mode) {
    this._stopThinkingLoop();
    this._thinkerSessionId = null;

    const settings = this._getSettings();
    this._transcription = new TranscriptionManager(settings);
    this._wireTranscription();
    this._transcription.start(mode || settings.transcriptionMode || 'manual');
    this._listening = true;
    this._thoughts = [];
    this._lastThinkTranscriptLen = 0;
    this._spawnThinkerSession();
    this._startThinkingLoop();
    this.emit('state', this._getStatus());
  }

  stop() {
    this._transcription.stop();
    this._listening = false;
    this._stopThinkingLoop();
    this._thinkerSessionId = null;
    this.emit('state', this._getStatus());
  }

  getThoughts() {
    return this._thoughts;
  }

  feedTranscript(text, speaker) {
    // Capture clarifications separately for the research agent
    if (text.startsWith('[CLARIFICATION]:')) {
      const answer = text.replace('[CLARIFICATION]:', '').trim();
      this._clarifications.push(answer);
    }
    this._transcription.feedManualTranscript(text, speaker);
  }

  forceDetect(description) {
    const transcriptText = this._transcription.getTranscriptText(120000);
    return this._intentDetector.forceDetect(transcriptText, description);
  }

  updateProposal(description) {
    const proposal = this._intentDetector.pendingProposal;
    if (proposal) {
      proposal.description = description;
      proposal.suggestedName = this._generateName(description);
      this.emit('proposal', proposal);
    }
  }

  addAttachment(attachment) {
    this._attachments.push(attachment);
    this.emit('attachments', this._attachments);
  }

  removeAttachment(index) {
    this._attachments.splice(index, 1);
    this.emit('attachments', this._attachments);
  }

  getAttachments() {
    return this._attachments;
  }

  async confirmProposal(editedDescription, editedName) {
    const proposal = this._intentDetector.pendingProposal;
    if (!proposal) return null;

    if (editedDescription) {
      proposal.description = editedDescription;
    }
    if (editedName) {
      proposal.suggestedName = editedName;
    }

    this._intentDetector.clearProposal();
    this._intentDetector.setActivePrototype(true);

    const transcriptText = this._transcription.getTranscriptText(300000);
    const clarificationsText = this._clarifications.length > 0
      ? this._clarifications.map(c => `- ${c}`).join('\n')
      : '';

    // Director orchestrates: knowledge + research in parallel, then build
    const result = await this._director.execute(
      proposal,
      this._attachments,
      clarificationsText,
      transcriptText
    );

    this._attachments = [];
    this._clarifications = [];
    this.emit('builderSession', { sessionId: result.sessionId, name: result.name });
    this.emit('state', this._getStatus());
    return result;
  }

  dismissProposal() {
    this._intentDetector.clearProposal();
    this._attachments = [];
    this.emit('state', this._getStatus());
  }

  stopPrototype() {
    this._director.stop();
    this._intentDetector.setActivePrototype(false);
    this.emit('state', this._getStatus());
  }

  sendAudio(buffer) {
    this._transcription.sendAudio(buffer);
  }

  // ---- Thinker (background process, no agent session) ----

  _spawnThinkerSession() {
    this._thinkerSessionId = null;
    this.emit('state', this._getStatus());
  }

  _startThinkingLoop() {
    const intervalMs = this._getSettings().thinkIntervalMs || 15000;
    this._thinkingActive = false;

    this._thinkTimer = setInterval(() => {
      if (this._listening && !this._thinkingActive) {
        this._runThinkCycle();
      }
    }, intervalMs);
  }

  _stopThinkingLoop() {
    if (this._thinkTimer) {
      clearInterval(this._thinkTimer);
      this._thinkTimer = null;
    }
  }

  async _runThinkCycle() {
    const transcriptText = this._transcription.getTranscriptText(300000);
    if (!transcriptText || transcriptText.length < 10) return;
    if (transcriptText.length === this._lastThinkTranscriptLen) return;

    this._lastThinkTranscriptLen = transcriptText.length;
    this._thinkingActive = true;

    // Query knowledge base for context
    let knowledgeContext = '';
    try {
      const knowledgeData = await this._knowledgeBase.query({
        entities: this._extractEntities(transcriptText.slice(-500)),
        domain: transcriptText.slice(-200),
        context: transcriptText.slice(-500),
      });
      if (knowledgeData && knowledgeData.data) {
        knowledgeContext = typeof knowledgeData.data === 'string'
          ? knowledgeData.data
          : JSON.stringify(knowledgeData.data, null, 2);
      }
    } catch {}

    const promptContent = loadPrompt('prototyper-thinker-cycle', {
      KNOWLEDGE_CONTEXT: knowledgeContext || 'No knowledge providers configured. Operating without organisational context.',
      TRANSCRIPT: transcriptText.slice(-2000),
    });

    const { spawn } = require('child_process');
    const child = spawn('claude', ['--print'], { timeout: 45000 });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', () => {});
    child.on('close', () => {
      this._thinkingActive = false;
      if (stdout.trim()) {
        this._parseThinkerResponse(stdout.trim());
      }
    });
    child.on('error', () => { this._thinkingActive = false; });
    child.stdin.write(promptContent);
    child.stdin.end();
  }

  _parseThinkerResponse(output) {
    const match = output.match(/\{[^{}]*"text"\s*:\s*"[^"]*"[^{}]*"level"\s*:\s*"[^"]*"[^{}]*\}/);
    if (!match) return;

    try {
      const thought = JSON.parse(match[0]);
      if (!thought.text || !thought.level) return;

      const isDuplicate = this._thoughts.some(t => t.text === thought.text);
      if (isDuplicate) return;

      const entry = {
        text: thought.text,
        level: thought.level,
        timestamp: Date.now(),
        questions: thought.questions || null,
      };
      this._thoughts.push(entry);
      if (this._thoughts.length > 50) this._thoughts.shift();
      this.emit('thought', entry);

      if (thought.level === 'confident' && thought.proposal) {
        const proposal = {
          description: thought.proposal,
          suggestedName: thought.name || this._generateName(thought.proposal),
          timestamp: Date.now(),
          source: 'thinking',
          transcriptExcerpt: this._transcription.getTranscriptText(500) || '',
        };
        this._intentDetector._pendingProposal = proposal;
        this.emit('proposal', proposal);
      }
    } catch {}
  }

  // ---- Events ----

  _wireEvents() {
    this._wireTranscription();

    this._director.on('status', (status) => {
      this.emit('prototypeStatus', status);
      this.emit('state', this._getStatus());
    });

    this._director.on('serverReady', (info) => {
      this.emit('serverReady', info);
    });

    this._director.on('fileCreated', (info) => {
      this.emit('fileCreated', info);
    });

    this._director.on('subagent', (info) => {
      this.emit('subagent', info);
      this.emit('state', this._getStatus());
    });
  }

  _wireTranscription() {
    this._transcription.removeAllListeners();

    this._transcription.on('transcript', (chunk) => {
      this.emit('transcript', chunk);
    });

    this._transcription.on('error', (err) => {
      this.emit('error', err);
    });

    this._transcription.on('connected', (info) => {
      this.emit('connected', info);
    });
  }

  _getSettings() {
    try {
      const all = this._settingsManager.load();
      return all.livePrototype || {};
    } catch {
      return {};
    }
  }

  _getStatus() {
    return {
      listening: this._listening,
      transcriptionMode: this._transcription.mode,
      elapsed: this._transcription.elapsed,
      prototypeStatus: this._director.status,
      serverUrl: this._director.serverUrl,
      hasPendingProposal: this._intentDetector.hasPendingProposal,
      pendingProposal: this._intentDetector.pendingProposal,
      attachmentCount: this._attachments.length,
      outputDir: this._director.outputDir,
      thinkerSessionId: this._thinkerSessionId,
    };
  }

  _extractEntities(description) {
    const words = description.split(/\s+/);
    const entities = words
      .filter(w => w.length > 3 && w[0] === w[0].toUpperCase())
      .map(w => w.replace(/[^a-zA-Z]/g, ''))
      .filter(w => w.length > 3);
    return [...new Set(entities)].slice(0, 5);
  }

  _generateName(description) {
    const words = description
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2 && !['the', 'that', 'with', 'for', 'and'].includes(w))
      .slice(0, 4);
    if (words.length === 0) words.push('prototype');
    return words.join('-') + '-' + Date.now().toString(36).slice(-4);
  }
}

module.exports = { LivePrototypeManager };

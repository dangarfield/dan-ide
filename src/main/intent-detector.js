const { EventEmitter } = require('events');

const TRIGGER_PATTERNS = [
  /(?:we need|let's build|let's create|can you (?:show|build|make|create)|what if we (?:built|made|created)|imagine a|picture a|I want a|I'd like a|how about a)\s+(?:a |an |the )?(.{10,})/i,
  /(?:dashboard|page|form|app|tool|widget|interface|prototype|screen|view|panel|wizard)\s+(?:that|which|with|for|showing|displaying)\s+(.{10,})/i,
  /(?:let's prototype|prototype this|can we prototype|quick prototype of)\s*(.{5,})/i,
  /(?:show me what|show us what|visualize|display|render)\s+(.{10,})\s+(?:would|could|might|should)\s+look like/i,
  /(?:UI|UX|interface|front.?end)\s+(?:for|that|with|showing)\s+(.{10,})/i,
];

const COOLDOWN_MS = 60000;

class IntentDetector extends EventEmitter {
  constructor(settings) {
    super();
    this._settings = settings || {};
    this._lastTriggerTime = 0;
    this._pendingProposal = null;
    this._activePrototype = false;
  }

  get hasPendingProposal() { return !!this._pendingProposal; }
  get pendingProposal() { return this._pendingProposal; }

  setActivePrototype(active) {
    this._activePrototype = active;
  }

  feed(transcriptText) {
    if (!transcriptText || transcriptText.length < 20) return;

    const now = Date.now();
    if (now - this._lastTriggerTime < COOLDOWN_MS) return;

    const result = this._runHeuristics(transcriptText);
    if (result) {
      this._lastTriggerTime = now;
      const proposal = {
        description: result.description,
        suggestedName: this._generateName(result.description),
        timestamp: now,
        source: 'auto',
        transcriptExcerpt: transcriptText.slice(-500),
      };
      this._pendingProposal = proposal;
      this.emit('proposal', proposal);
    }
  }

  forceDetect(transcriptText, manualDescription) {
    const now = Date.now();
    const description = manualDescription || this._extractDescription(transcriptText) || transcriptText.slice(-200);
    const proposal = {
      description,
      suggestedName: this._generateName(description),
      timestamp: now,
      source: 'manual',
      transcriptExcerpt: transcriptText.slice(-500),
    };
    this._pendingProposal = proposal;
    this._lastTriggerTime = now;
    this.emit('proposal', proposal);
    return proposal;
  }

  clearProposal() {
    this._pendingProposal = null;
  }

  _runHeuristics(text) {
    for (const pattern of TRIGGER_PATTERNS) {
      const match = text.match(pattern);
      if (match && match[1]) {
        let description = match[1].trim();
        if (description.length > 300) description = description.slice(0, 300);
        // Clean up trailing punctuation
        description = description.replace(/[.!?,;:]+$/, '').trim();
        if (description.length >= 10) {
          return { description: match[0].trim(), rawCapture: description };
        }
      }
    }
    return null;
  }

  _extractDescription(text) {
    for (const pattern of TRIGGER_PATTERNS) {
      const match = text.match(pattern);
      if (match) return match[0].trim();
    }
    return null;
  }

  _generateName(description) {
    const words = description
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2 && !['the', 'that', 'with', 'for', 'and', 'this', 'from', 'would', 'could', 'should', 'which', 'have', 'show', 'showing', 'need', 'want', 'like', 'build', 'create', 'make'].includes(w))
      .slice(0, 4);
    if (words.length === 0) words.push('prototype');
    return words.join('-') + '-' + Date.now().toString(36).slice(-4);
  }
}

module.exports = { IntentDetector };

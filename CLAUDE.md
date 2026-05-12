# Dan IDE — Architect-First Agentic Development Environment

## Vision

Dan IDE is an **architect-first agentic IDE** — a desktop environment where software architects oversee, direct, and govern AI coding agents working on complex systems. The primary user is not a line-level coder; it's the person responsible for system-wide design, quality, and coordination.

### How It Serves Architects

1. **Command Center**: Architects see all agents working across a project (Canvas panel), monitor inter-agent communication (Messages panel), and track task progress — like a control tower.

2. **Visual Direction**: The Browser panel lets architects view running apps, annotate UIs with what needs changing, and dispatch those visual instructions directly to agents. This bridges the gap between "what I see is wrong" and "here's a task for you."

3. **Governance & Safety**: The Policy Engine enforces architectural constraints (no direct DB calls from UI layer, must use approved libraries, etc.). Agents can't violate these rules. The Audit Trail logs every action for review.

4. **Multi-Agent Orchestration**: Swarms let architects define a mission and delegate to specialized agent teams (scout → builder → reviewer workflow), mimicking how they'd direct a real dev team.

5. **Context Integration**: Agents automatically receive project structure, architecture docs, shared memory, and policy constraints — ensuring their suggestions align with the system's intended architecture.

## Architecture

```
src/
├── main/                    # Electron main process
│   ├── main.js              # App entry, IPC handlers
│   ├── session-manager.js   # PTY terminal management
│   ├── swarm-manager.js     # Multi-agent orchestration
│   ├── context-manager.js   # Shared memory & context generation
│   ├── search-manager.js    # Project-wide code search
│   ├── test-runner.js       # Test framework detection & execution
│   ├── policy-engine.js     # Rule-based agent constraints
│   ├── audit-manager.js     # Event logging & timeline
│   ├── project-manager.js   # Project registry
│   ├── file-manager.js      # File tree & read/write
│   ├── settings-manager.js  # Persistent settings
│   ├── safety.js            # Project safety initialization
│   └── preload.js           # Context bridge (renderer API)
└── renderer/                # Electron renderer
    ├── index.html           # UI layout with 5 panels
    ├── app.js               # Main UI logic (~2200 lines)
    ├── editor.js            # Monaco editor integration
    └── styles.css           # All styles
```

## UI Panels

- **Agents** — Terminal panes for each running agent
- **Messages** — Parsed inter-agent MESSAGES.md with Tasks and Audit tabs
- **Canvas** — Graph visualization of agent topology (coordinator at center)
- **Files** — File tree + Monaco editor
- **Browser** — Chromium webview with screenshot, annotation, and send-to-agent

## Key Patterns

- Vanilla JS, no framework (fast, simple, direct DOM manipulation)
- Electron with context isolation (preload.js bridges main↔renderer)
- PTY-based agent sessions (node-pty spawning Claude/Kiro/Aider/shell)
- File-based coordination (.dan-ide/memory/MESSAGES.md, SHARED.md, CONTEXT.md)
- Polling-based UI updates (messages every 3s, canvas every 2s, audit every 5s)

## Agent CLI Support

- `claude` — Claude Code (--dangerously-skip-permissions, --session-id, --system-prompt)
- `kiro` — Kiro CLI
- `aider` — Aider (--read context files)
- `shell` — Plain terminal

## Development

```bash
npm start        # Launch app
npm run dev      # Launch with DevTools
```

## See Also

- `BACKLOG.md` — Prioritized feature backlog (from PDF research)
- `research/` — Source research documents

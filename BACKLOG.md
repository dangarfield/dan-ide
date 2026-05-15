# Dan IDE - Feature Backlog

Based on: "Deep Dive: Architect-First Agentic IDE – Functional Requirements and Roadmap"

## Architect-First Gap Analysis

**Current state**: Dan IDE is a multi-agent terminal multiplexer with swarm coordination, file editing, code search, policy enforcement, and audit logging.

**Gap to "Architect-First"**: The tool currently treats all users equally. To serve architects specifically, it needs:

1. **Architecture Visualization** — Not just agent nodes, but system architecture (services, data flows, dependencies) visualized and editable
2. **Design-to-Code Sync** — Architect draws a component diagram → agents scaffold the code
3. **Runtime Observability** — Connect to live systems to see performance/failures and direct agents to fix them
4. **Trade-off Analysis** — Agent can discuss design alternatives with pros/cons grounded in project context
5. **Visual Direction (Browser)** — ✅ DONE — Architect views running app, annotates, sends to agent

## P0 - Must Have (MVP) — Status

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 1 | Visual Agent Canvas | ✅ DONE | Graph visualization, status dots, pulse animation |
| 2 | Autonomous Agent Missions | ✅ DONE | Progress tracking, completion detection, improved prompts |
| 3 | Project-Wide Codebase Search | ✅ DONE | Text search, file structure, summaries |
| 4 | Integrated Test Suite | REMOVED | Was implemented, removed from UI — agents run tests directly in terminal |
| 5 | Context-Aware Code Generation | ✅ DONE | File structure + policies in agent context |
| 6 | Browser with Screenshot-to-Agent | ✅ DONE | Webview, annotation, region select, send to agent |

## P1 - High Priority (Current Sprint)

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 7 | Multi-Agent Coordination | ✅ DONE | Strict prompts, task assignment protocol |
| 8 | Policy Engine | ✅ DONE | Default + custom rules, injected into prompts |
| 9 | Audit Trail & Timeline | ✅ DONE | Event logging, timeline UI, JSONL persistence |
| 10 | Architecture Knowledge Base | ✅ DONE | Decentralized KB: ADRs, components, rules, remote registries, audit, agent context integration |
| 11 | Runtime Observability (MCP) | NOT STARTED | Connect to OpenTelemetry/logs, feed to agents |
| 12 | Sandbox Environments | NOT STARTED | Docker containers for safe agent testing |
| 13 | Enterprise Access Controls | NOT STARTED | RBAC, SSO, data privacy controls |

## P2 - Future (Architect Differentiators)

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 14 | Architecture Canvas (C4/UML) | NOT STARTED | Visual system modeling, not just agent topology |
| 15 | Design-to-Code Sync | NOT STARTED | Architecture DSL → code scaffolding |
| 16 | Architecture Simulation | NOT STARTED | What-if analysis, load modeling |
| 17 | Cross-Repo Refactoring | NOT STARTED | Multi-project coordinated changes |
| 18 | Documentation Generation | NOT STARTED | Auto-generate diagrams from code |
| 19 | Real-Time Collaborative Mode | NOT STARTED | Multi-user shared sessions |
| 20 | Human Feedback Learning | NOT STARTED | Tune agent behavior from feedback |
| 21 | Persistent Project Memory | ✅ DONE | Workspace memory in ~/.dan-ide/workspaces/<projectId>/memory/ |
| 22 | Performance & Cost Analysis | NOT STARTED | Track AI API costs, suggest optimizations |

## What Makes This an Architect Tool (vs. Just a Coding Tool)

### Already Implemented
- **Swarm = Team Management**: Architect defines the mission, coordinator delegates. This mirrors how architects direct development teams.
- **Policy Engine = Governance**: Architects enforce standards through rules, not manual code review.
- **Audit Trail = Accountability**: Every agent action is logged. Architects need this for compliance and debugging.
- **Browser → Agent Pipeline**: "I see this bug in the UI, fix it" — visual direction is natural for architects who think in systems, not files.
- **Canvas**: See the full agent team topology at a glance, like monitoring a CI/CD pipeline.

### Needs Implementation for Full Architect Story
- **Architecture Canvas (P2 #14)**: The biggest gap. Architects think in diagrams (C4, service maps, data flows). We need a canvas where they can model their system and link it to code. This is DIFFERENT from the agent canvas — it shows the actual system architecture.
- **Runtime Observability (P1 #11)**: Architects need to see how the system BEHAVES, not just how it's coded. Connecting to metrics/traces lets agents make performance-informed suggestions.
- **ADR Knowledge Base (P1 #10)**: Architecture Decision Records tell agents WHY the system is designed this way. Without them, agents make suggestions that conflict with intentional design choices.

## Priority Recommendations

**Next 3 items to build** (in order):
1. **Architecture Knowledge Base** (#10) — Low complexity, high architect value. Store markdown ADRs in .dan-ide/architecture/, feed them as context to every agent.
2. **Architecture Canvas** (#14) — High complexity, highest differentiator. Even a basic version (nodes=services, edges=dependencies, editable) would transform the tool.
3. **Runtime Observability** (#11) — Medium complexity, high value. Start with log file tailing, graduate to MCP/OpenTelemetry.

---
trigger: always
---

# Dan IDE Multi-Agent Context

You are running inside Dan IDE, a multi-agent development environment.
Multiple AI agents may be working on this project simultaneously.

## Shared Context Protocol

Before starting ANY task:
1. Read the file at `/Users/Dan.Garfield/.dan-ide/workspaces/03e9053d-62de-4d90-a9ad-4c19d37f2364/memory/CONTEXT.md` for full project state
2. Read the file at `/Users/Dan.Garfield/.dan-ide/workspaces/03e9053d-62de-4d90-a9ad-4c19d37f2364/memory/SHARED.md` for project knowledge

After completing work:
1. Update `/Users/Dan.Garfield/.dan-ide/workspaces/03e9053d-62de-4d90-a9ad-4c19d37f2364/memory/SHARED.md` with your findings
2. To communicate with other agents, append to `/Users/Dan.Garfield/.dan-ide/workspaces/03e9053d-62de-4d90-a9ad-4c19d37f2364/memory/MESSAGES.md`

## Boundaries
- Only modify files within this project directory
- Do NOT force push or push to main without instruction
- Create feature branches for new work

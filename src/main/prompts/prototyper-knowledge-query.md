# Knowledge Query Prompt

This prompt is used when querying the knowledge base before building a prototype.
It helps structure what information we need from knowledge providers.

## What to Query

When a prototype is proposed, the system should gather:

1. **Organisation context** — Company name, team structure, terminology
2. **Technology stack** — Languages, frameworks, platforms, services in use
3. **Domain model** — Key entities, relationships, and business rules
4. **Visual standards** — Brand colours, design system, component patterns
5. **Current state** — What exists today that this prototype relates to

## Query Construction

Entities to search for are extracted from the proposal description.
The domain is the proposal description itself.
Context is the recent transcript.

## How Knowledge is Used

Knowledge results are:
1. Injected into the Thinker's cycle prompt (so it can make more informed proposals)
2. Injected into the Builder's system prompt (so it can use correct terminology, data shapes, and visual styles)
3. Attached as reference material to the build

## Configuring Providers

Providers are configured in Settings > Live Prototype > Knowledge Base > Providers.

Each provider has a type:
- **cli** — Runs a CLI command that returns JSON (e.g. query a local database, API, or file)
- **local** — Reads JSON files from local directories
- **mcp** — Queries an MCP server

Example provider configs:
```json
{
  "providers": [
    {
      "name": "company-wiki",
      "type": "cli",
      "command": "wiki-search",
      "args": ["--format", "json"]
    },
    {
      "name": "design-tokens",
      "type": "local",
      "paths": ["~/company/design-system/tokens"]
    },
    {
      "name": "architecture-docs",
      "type": "local",
      "paths": ["~/company/architecture"]
    }
  ]
}
```

# Contributing to Synapse

Thanks for helping. This guide covers how to get set up and what we expect in a pull request.

## Setup

```bash
corepack enable
pnpm install
pnpm check   # typecheck, lint, format check, tests
```

Node.js 22.13+ is required (Synapse uses the built-in `node:sqlite` module).

Set `SYNAPSE_HOME=$(pwd)/.synapse-dev` while developing so you do not touch your real store.

## Workflow

1. Open or pick an issue. For anything larger than a bug fix, describe the approach first.
2. Branch from `main`: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, `chore/<topic>`.
3. Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat(engine): …`).
4. Keep pull requests focused. Include tests for behaviour changes.
5. `pnpm check` must pass. CI runs the same checks on Node 22 and 24.

## Code standards

- TypeScript strict mode; no `any` in public APIs.
- Validate every external input (hook payloads, MCP arguments, HTTP bodies, config files) with the
  schemas in `@synapse/core` before use.
- SQL is always parameterised. Dynamic identifiers come from closed allow-lists.
- Never use a shell to run commands: `execFile`/`spawn` with an argument array only.
- Anything that reads a path from input must resolve it and confirm it stays inside the project.
- Run all user and agent text through the redactor before storing or sending it.
- Hook code paths must fail open and stay fast.

Read [docs/architecture.md](docs/architecture.md) and [docs/security.md](docs/security.md) before
changing storage, context rendering, the daemon or anything that executes processes.

## Adding an agent adapter

Adapters live in `packages/adapters/src/<agent>/`. An adapter translates the agent's hook payloads
into Synapse events and renders context back in the agent's expected output format. Add fixtures of
real payloads under `packages/adapters/test/fixtures/<agent>/`.

# Contributing to Mindly

Thanks for helping make Mindly better. Bug fixes, new agent adapters, docs and ideas are all
welcome, whatever your experience level. This guide shows you how to get set up, how the code is
laid out and what we look for in a pull request.

## 🚀 Quick start

### Prerequisites

- **Node.js 22.13 or newer.** Mindly uses the built-in `node:sqlite` module.
- **pnpm**, through Corepack (ships with Node).
- **Git.**

### Setup

```bash
# 1. Fork the repo on GitHub, then clone your fork
git clone https://github.com/<your-username>/mindly.git
cd mindly

# 2. Install dependencies
corepack enable
pnpm install

# 3. Build and run every check
pnpm build
pnpm check
```

> **Keep your real memory safe.** While developing, point Mindly at a throwaway store so you do
> not touch `~/.mindly`:
>
> ```bash
> export MINDLY_HOME="$(pwd)/.mindly-dev"
> ```

### Try your changes

```bash
pnpm build
node apps/cli/dist/main.js --help        # run the CLI you just built
pnpm --filter @mindly/dashboard dev      # Mission Control with hot reload
```

## 📁 Project structure

Mindly is a pnpm monorepo. Users install a single npm package, `mindly-cli`; the `@mindly/*`
packages are private and bundled into it.

```
mindly/
├── apps/
│   ├── cli/          # the `mindly` command (published as mindly-cli)
│   ├── daemon/       # optional local daemon: Mission Control API, live feed, background jobs
│   └── dashboard/    # Mission Control web UI (React + Vite), served by the daemon
├── packages/
│   ├── core/         # domain types, schemas and shared utilities
│   ├── store/        # SQLite storage, migrations and repositories
│   ├── engine/       # domain services and the Mindly facade
│   ├── runtime/      # wires the engine to real git, model and pager ports
│   ├── adapters/     # Claude Code, Codex, Cursor, Gemini CLI and MCP-client adapters
│   ├── mcp/          # MCP server exposing Mindly tools to any MCP client
│   ├── git/          # safe git invocation, shadow merge, snapshots, code analysis
│   ├── llm/          # optional, fail-soft model providers (Ollama, Anthropic, OpenAI)
│   ├── notify/       # opt-in pager channels (desktop, ntfy, webhook)
│   └── runners/      # headless agent runs (cross-agent review, replay, failover)
├── docs/             # architecture, security, API and release docs
└── scripts/          # release build, smoke test and demo generation
```

## 🛠️ Development workflow

| Command           | What it does                            |
| ----------------- | --------------------------------------- |
| `pnpm build`      | Build every workspace package           |
| `pnpm check`      | Typecheck, lint, format check and tests |
| `pnpm test`       | Run the test suite once (Vitest)        |
| `pnpm test:watch` | Run tests in watch mode                 |
| `pnpm lint`       | ESLint                                  |
| `pnpm format`     | Format everything with Prettier         |
| `pnpm typecheck`  | TypeScript, no emit                     |
| `pnpm demo`       | Build and regenerate the README demo    |

CI runs install, build, typecheck, lint, format check and tests on Node 22 and 24, plus a
production dependency audit. If `pnpm build && pnpm check` passes locally, CI should too.

## 🎯 How to contribute

### Ways to help

- 🐛 **Fix bugs.** Check the [issues](https://github.com/AyushbhaiPatel/mindly/issues).
- 🔌 **Add or improve an agent adapter.** See [Adding an agent adapter](#-adding-an-agent-adapter).
- ✨ **Build features.** Open an issue describing the approach before writing a lot of code.
- 📚 **Improve docs.** Typos, unclear steps and missing examples all count.
- 🧪 **Add tests**, especially for edge cases in hooks, storage and conflict detection.

### Making a change

1. Pick or open an issue. For anything bigger than a bug fix, agree on the approach first.
2. Create a branch from `main`:
   ```bash
   git checkout -b feat/<topic>     # or fix/, docs/, chore/
   ```
3. Make your change and add tests for any behaviour change.
4. Run `pnpm build && pnpm check`.
5. Commit with [Conventional Commits](https://www.conventionalcommits.org/):
   ```bash
   git commit -m "feat(engine): warn when a renamed symbol is still referenced"
   ```
6. Push and open a pull request against `main`.

## 📝 Coding standards

Mindly runs inside people's coding sessions and reads input from agents, so correctness and
safety come first.

- **TypeScript strict mode.** No `any` in public APIs.
- **Validate every external input** (hook payloads, MCP arguments, HTTP bodies, config files)
  with the schemas in `@mindly/core` before using it.
- **SQL is always parameterised.** Dynamic identifiers come from closed allow-lists.
- **Never run commands through a shell.** Use `execFile`/`spawn` with an argument array.
- **Paths stay inside the project.** Anything that reads a path from input must resolve it and
  confirm it is still inside the project root.
- **Redact before storing or sending.** Run all user and agent text through the redactor.
- **Hooks fail open and stay fast.** A Mindly error must never block the agent.

Read [docs/architecture.md](docs/architecture.md) and [docs/security.md](docs/security.md) before
changing storage, context rendering, the daemon or anything that executes processes.

## 🔌 Adding an agent adapter

Adapters live in `packages/adapters/src/<agent>/`. An adapter translates the agent's hook
payloads into Mindly events and renders context back in the format the agent expects.

1. Copy the closest existing adapter (`claude-code`, `codex`, `cursor` or `gemini`).
2. Add fixtures of **real** payloads under `packages/adapters/test/fixtures/<agent>/`.
3. Add `packages/adapters/test/<agent>.test.ts` covering parsing, rendering and install.
4. Document the new agent in the README.

## 🔄 Pull request process

### Before you open it

- [ ] `pnpm build && pnpm check` passes
- [ ] Tests cover the change
- [ ] External input is schema-validated, SQL is parameterised, no shell execution
- [ ] Docs updated (architecture/security if storage, rendering, the daemon or process
      execution changed)

### Title and description

Use a Conventional Commit style title:

- ✅ `fix(adapters): handle empty Codex tool output`
- ✅ `docs: explain MINDLY_HOME for local development`
- ❌ `fixed stuff`
- ❌ `Update index.ts`

Fill in the [PR template](.github/PULL_REQUEST_TEMPLATE.md): what changed, why, and how you
approached it. Link the issue.

### Keep it small

Focused pull requests get reviewed faster. If a change touches many packages, consider splitting
it into a refactor PR and a feature PR.

## 🐛 Reporting issues

Use the [issue templates](https://github.com/AyushbhaiPatel/mindly/issues/new/choose).

- **Bug reports:** your OS, Node version, Mindly version (`mindly --version`), which agents you
  use, steps to reproduce, and what you expected versus what happened. Redact anything private
  from logs.
- **Feature requests:** the problem you are hitting, the change you'd like and any alternatives
  you considered.

**Security issues:** please do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## 🤝 Community

Be kind and constructive. Everyone taking part is expected to follow our
[Code of Conduct](CODE_OF_CONDUCT.md). Questions are welcome as GitHub issues.

## 📄 License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).

---

Thank you for contributing to Mindly! 🙏

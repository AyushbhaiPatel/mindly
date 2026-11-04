# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install
pnpm test
```

## Code style

- Use pnpm, never npm or yarn.
- Prefer named exports over default exports.
- Testing:
  - Write tests with vitest
  - Never use snapshot tests
- Keep functions small and
  avoid deep nesting.

| Command | What |
| ------- | ---- |
| pnpm build | builds |

<!-- internal note: ignore this comment -->

@docs/architecture.md

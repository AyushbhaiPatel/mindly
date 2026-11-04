# Releasing `mindly-cli`

Mindly ships to users as one npm package, `mindly-cli`, which installs the `mindly` command.
The workspace packages (`@mindly/*`) stay private: their code is bundled into the release, and
only real third-party runtime dependencies are installed from the registry.

## Package layout

```
mindly-cli/
  package.json      generated: name/version/description from apps/cli, exact runtime deps
  dist/main.js      the `mindly` binary (bin), plus shared chunk-*.js files and source maps
  dist/daemon.js    the daemon process started by `mindly daemon start`
  dashboard/        the built Mission Control dashboard (apps/dashboard/dist)
  README.md
  LICENSE           Apache-2.0
  NOTICE            third-party licences of code bundled into dashboard/ (React and friends)
```

Paths are resolved by `resolveLayout()` in `packages/core/src/layout.ts`. The bundler defines
`__MINDLY_RELEASE__`, so in the release every module resolves relative to its own bundle file
(`<package>/dist/*.js`): the CLI entry is `dist/main.js`, the daemon entry `dist/daemon.js` and the
dashboard `dashboard/`. In a monorepo checkout they are `apps/cli/dist/main.js`,
`apps/daemon/dist/main.js` and `apps/dashboard/dist`. Agent hooks written by `mindly init` run
the global `mindly` when the CLI was started through it, otherwise
`node <package>/dist/main.js`, so both point at the installed package.

## Versioning

- Semantic versioning. Before 1.0, breaking changes bump the minor version.
- The version lives in `apps/cli/package.json` and must equal `MINDLY_VERSION` in
  `packages/core/src/index.ts` (what `mindly --version` and `/api/health` report). The build
  fails if they differ. Bump both in the same commit, for example `chore(release): 0.2.0`.
- Tag the release commit `v<version>` on `main`.

## Build

```sh
pnpm install --frozen-lockfile
pnpm release:build
```

`pnpm release:build` builds the dashboard and runs `scripts/build-release.mjs`, which:

1. bundles `apps/cli/src/main.ts` and `apps/daemon/src/main.ts` with esbuild (ESM,
   `platform: node`, `target: node22`, the `@mindly/source` condition, code splitting, source
   maps) into `release/mindly-cli/dist/`;
2. keeps every third-party dependency external and writes those the bundle imports, with the
   exact versions pinned in the workspace, to the generated `package.json` (no scripts, no
   devDependencies);
3. copies the dashboard, `README.md` and `LICENSE`, and writes `NOTICE` from the licence files of
   the dashboard's bundled dependencies;
4. fails if anything from `node_modules`, a test or a fixture was bundled, if an import is not a
   declared dependency, or if any output file contains this machine's repository or home path or
   looks like a secret.

`release/` is git-ignored.

## Pack and smoke test

```sh
cd release/mindly-cli
npm pack --dry-run                       # review the file list
npm pack --pack-destination /tmp/mindly-release
cd ../..
node scripts/smoke-release.mjs /tmp/mindly-release/mindly-cli-<version>.tgz
```

The smoke test installs the tarball in a fresh temp directory with a temp `HOME` and
`MINDLY_HOME` (network is needed for the third-party dependencies) and checks `npx mindly
--version`, `mindly doctor`, `mindly init --project --yes --agents claude-code` in a temp git repo
(hooks must point at the installed package, with and without `mindly` on `PATH`), a
`SessionStart` hook payload, and `mindly daemon start`, `/api/health`, the dashboard at `/` and
`mindly daemon stop`. CI runs the build, `npm pack --dry-run` and this smoke test on Node 22 for
every pull request; it never publishes.

## Publish (later, from GitHub Actions)

Publishing is not automated yet. When it is, it must happen only from a GitHub Actions workflow
triggered by a `v*` tag or a published GitHub release, never from a laptop:

```yaml
permissions:
  contents: read
  id-token: write # npm provenance
steps:
  - uses: actions/checkout@v4
  - uses: pnpm/action-setup@v4
  - uses: actions/setup-node@v4
    with: { node-version: 22, registry-url: 'https://registry.npmjs.org' }
  - run: pnpm install --frozen-lockfile
  - run: pnpm check
  - run: pnpm release:build
  - run: npm publish --provenance --access public
    working-directory: release/mindly-cli
```

Prefer npm trusted publishing (OIDC) for the repository and workflow; otherwise use an
automation token stored as an environment secret with required reviewers. Check that the tag
matches the package version before publishing, and verify the provenance badge on npmjs.com
afterwards.

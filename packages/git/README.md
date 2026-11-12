# @mindly/git

Safe git access and deterministic code analysis for Mindly. Used by the engine and the daemon for
shadow merges, snapshots, impact analysis and code provenance. Depends only on `@mindly/core` and
Node built-ins.

Requires git 2.26 or newer; shadow merge needs git 2.38 (2.40 for an explicit merge base) and
reports `{ supported: false }` on older versions instead of failing.

## API overview

| Area            | Functions                                                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Runner          | `runGit`, `gitVersion`, `hardenedGitEnv`, `HARDENING_CONFIG`                                                                             |
| Validation      | `assertValidRefName`, `assertValidBranchName`, `assertValidRevision`, `assertSafeRelativePath`, `isValidRefName`                         |
| Repository info | `findRepoRoot`, `isGitRepo`, `currentBranch`, `headCommit`, `resolveCommit`, `listWorktrees`, `changedFiles`, `diffForFile`, `fileAtRef` |
| Capture         | `captureWorktreeCommit` – tracked + untracked work as a commit, without touching the index, working tree or refs                         |
| Shadow merge    | `shadowMerge` (in-memory `merge-tree --write-tree`), `materializeTree` (temporary detached worktree with `dispose()`)                    |
| Checks          | `runChecks` – trusted commands against a materialized tree                                                                               |
| Snapshots       | `createSnapshotRef`, `listSnapshotRefs`, `restoreSnapshotToBranch`, `deleteSnapshotRef` (`refs/mindly/snapshots/<id>`)                   |
| Analysis        | `languageOf`, `extractExports`, `diffExportSurface`, `extractImports`, `extractReexports`, `buildImportGraph`, `hunkHashes`, `diffLines` |

Analysis is regex/lexer based (comments, strings, template and regex literals are masked first) and
supports TypeScript, JavaScript and Python; other languages return empty results.

## Security notes

- git is only ever run through `execFile('git', args)`: no shell, a timeout, an output cap and a
  minimal environment (`GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`,
  `GIT_LFS_SKIP_SMUDGE=1`, literal pathspecs, no pager, no inherited `GIT_*` variables).
- Every call overrides `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `core.sshCommand`,
  `credential.helper`, all `protocol.*.allow=never`, `submodule.recurse=false` and signing, so a
  hostile repository cannot run hooks or reach the network. Filter, diff and merge drivers defined
  in the repository's own config are disabled for operations that would run them.
- Ref names, revisions, snapshot ids and paths are validated in code; paths are passed after `--`
  and resolved with `resolveInsideRoot`. Errors are `MindlyError`s that never echo argument values.
- `captureWorktreeCommit` uses a private temporary index and never stores files on the secret
  deny-list (`isDeniedPath`); `restoreSnapshotToBranch` only ever creates new branches.
- `runChecks` executes arbitrary programs. Only pass checks the user explicitly trusted (for example
  from a project config whose hash was approved); it uses `spawn` without a shell, a minimal
  environment (`PATH`, `HOME`, `LANG`, `CI=1`), SIGTERM then SIGKILL on timeout and a 16 KiB output
  tail.

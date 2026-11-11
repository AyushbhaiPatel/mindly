// git commands that write covered files through an option or a setting rather than a path they
// name: an output file, a program run on the files, a folder filled with a checkout, a push into
// a working tree. Each runs in a scratch copy to show the covered file it writes, then the
// pre-tool hook is asked; it must block or at least warn. The commands after them write no
// covered file and must never be blocked.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GIT_ENV, file, guarded, runInCopy } from './written.js';

const RULE = 'Certificates are issued by hand';
type Verdict = 'deny' | 'warn' | 'allow';

/** v1: pem k1. v2: pem k2. HEAD (main): a.ts changed. */
const setUp = (scopes: string[], prep = '') => {
  const g = guarded({ [RULE]: scopes });
  file(g.dir, 'certs/server.pem', 'k1\n');
  file(g.dir, 'src/a.ts', 'x\n');
  g.git('add', '-A');
  g.git('commit', '-q', '-m', 'base');
  g.git('tag', 'v1');
  file(g.dir, 'certs/server.pem', 'k2\n');
  g.git('commit', '-qam', 'k2');
  g.git('tag', 'v2');
  file(g.dir, 'src/a.ts', 'y\n');
  g.git('commit', '-qam', 'a');
  if (prep) execFileSync('bash', ['-c', prep], { cwd: g.dir, env: GIT_ENV });
  return g;
};

/** A warning that part of the line was not read counts as a warning too. */
const verdictOf = (r: { decision: string | null; context: string | null }): Verdict =>
  r.decision === 'deny'
    ? 'deny'
    : (r.context ?? '').includes(RULE) || (r.context ?? '').includes('did not read')
      ? 'warn'
      : 'allow';

const LOCAL_PEM = 'echo local > certs/server.pem';
const PEM = ['**/*.pem'];
const VENDOR = ['vendor/**'];
const covered = (rel: string) => rel.endsWith('.pem') || rel.startsWith('vendor/');
const EXT = `'touch certs/new.pem; true'`;
const AHEAD =
  'git checkout -q -b ahead && echo k9 > certs/server.pem && git commit -qam k9 && git checkout -q main && git config receive.denyCurrentBranch updateInstead';
const HOOK =
  "mkdir -p hk && printf '#!/bin/sh\\necho hook > certs/server.pem\\n' > hk/pre-commit && chmod +x hk/pre-commit";
/** A home directory whose settings run the hook above. */
const FAKE_HOME = `${HOOK} && mkdir -p fakehome && printf '[core]\\n\\thooksPath = hk\\n' > fakehome/.gitconfig`;
const COMMIT = 'git commit -q --allow-empty -m x';
/** bash before 4.3 (macOS ships 3.2) has no namerefs, so those commands cannot run here. */
const BASH_MAJOR = Number(
  execFileSync('bash', ['-c', 'echo "${BASH_VERSINFO[0]}${BASH_VERSINFO[1]}"'], {
    encoding: 'utf8',
  }).trim(),
);
const NAMEREFS = BASH_MAJOR >= 43;
/** `mapfile` came with bash 4.0. */
const BASH4 = BASH_MAJOR >= 40;
/** `printf -v` into an array element came with bash 4.1. */
const PRINTF_ELEMENT = BASH_MAJOR >= 41;
/** Whether a command runs here at all (`rbash` and `env -S` are not everywhere). */
const works = (command: string): boolean => {
  try {
    execFileSync('bash', ['-c', command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const RBASH = works('command -v rbash');
/** `test -v` came with bash 4.2; bash 3.2 does not `source` a process substitution. */
const TEST_V = BASH_MAJOR >= 42;
/** Programs that are not everywhere (Linux's util-linux, strace). */
const has = (program: string): boolean => works(`command -v ${program}`);
const CO = 'git checkout -q v1 -- certs/server.pem';
const ENV_SPLIT = works("env -S 'true'");
/** GNU cp takes `-T`; BSD cp (macOS) does not. */
const CP_T = works('d=$(mktemp -d) && mkdir "$d/a" && cp -rT "$d/a" "$d/b" && rm -rf "$d"');
/** GNU `ln` takes abbreviated long options; BSD `ln` (macOS) does not. */
const LN_LONG = works('d=$(mktemp -d) && ln --sy "$d" "$d/l" && rm -rf "$d"');
/** bash 3.2 cannot parse a `case` inside `$(…)`. */
const CASE_IN_SUBST = works('[ "$(case x in x) echo ok;; esac)" = ok ]');
/** util-linux `script` takes `-c`; BSD `script` (macOS) does not. */
const SCRIPT_C = works('script -qec true /dev/null');
/** bash fails a `cd` through a folder that is not there and `..`; a shell that does not is not asked. */
const CD_CHECKS_DOTDOT = works(
  'd=$(mktemp -d) && mkdir "$d/a" && cd "$d" && ! cd a/nosuch/.. 2>/dev/null; r=$?; rm -rf "$d"; exit $r',
);
/** GNU `cp -a` copies a folder its owner cannot search; BSD `cp -a` (macOS) fails on one. */
const CP_CLOSED_FOLDER = works(
  'd=$(mktemp -d) && mkdir -p "$d/a/s" && chmod 600 "$d/a/s" && cp -a "$d/a/." "$d/b"; r=$?; chmod -R u+rwx "$d"; rm -rf "$d"; exit $r',
);
/** A newer bash keeps the `OLDPWD` it inherits, for `cd ~-`; bash 3.2 (macOS) starts without one. */
const OLDPWD_INHERITED = works(
  'd=$(mktemp -d) && mkdir "$d/s" && cd "$d/s" && [ "$(OLDPWD=.. bash -c \'cd ~- 2>/dev/null && pwd -P\')" = "$(cd .. && pwd -P)" ]; r=$?; cd /; rm -rf "$d"; exit $r',
);
/** GNU `cp -a` keeps two names of one file as one file; BSD `cp -a` (macOS) copies each. */
const CP_KEEPS_NAMES = works(
  'd=$(mktemp -d) && mkdir "$d/a" && echo x > "$d/a/f" && ln "$d/a/f" "$d/a/g" && cp -a "$d/a/." "$d/b" && [ "$d/b/f" -ef "$d/b/g" ]; r=$?; rm -rf "$d"; exit $r',
);
/** GNU `cp` takes `--remove-destination`; BSD `cp` (macOS) does not. */
const CP_REMOVES_DESTINATION = works(
  'd=$(mktemp -d) && echo a > "$d/a" && echo b > "$d/b" && cp --remove-destination "$d/a" "$d/b"; r=$?; rm -rf "$d"; exit $r',
);
/** A home directory `5` (the value arithmetic gives HOME) whose settings run the hook. */
const FIVE_HOME = `${HOOK} && mkdir -p 5 && printf '[core]\\n\\thooksPath = hk\\n' > 5/.gitconfig`;
/** A program run instead of git once `git` is hashed to it. */
const NOT_GIT = "printf '#!/bin/sh\\necho x > certs/server.pem\\n' > g.sh && chmod +x g.sh";

const cases: {
  name: string;
  scopes?: string[];
  prep?: string;
  command: string;
  /** What the hook may say: never `allow`. */
  want: Verdict[];
  /** Uses bash namerefs: run for real only where bash has them; the hook is asked either way. */
  namerefs?: boolean;
  /** False where the command cannot run (a newer bash, a program not there): only asked. */
  runs?: boolean;
}[] = [
  // Output written to a file it is given.
  {
    name: 'diff-tree --output',
    command: 'git diff-tree --output=certs/new.pem -p v1 v2',
    want: ['deny'],
  },
  {
    name: 'diff-index --output',
    command: 'git diff-index --output=certs/new.pem -p v1',
    want: ['deny'],
  },
  {
    name: 'rev-list --output',
    command: 'git rev-list --output=certs/new.pem HEAD',
    want: ['deny'],
  },
  {
    name: 'shortlog --output',
    command: 'git shortlog --output=certs/new.pem HEAD',
    want: ['deny'],
  },
  {
    name: 'blame --output',
    command: 'git blame --output=certs/new.pem src/a.ts',
    want: ['deny'],
  },
  // Abbreviated options, read as git reads them.
  { name: 'reset --har', prep: LOCAL_PEM, command: 'git reset --har v1', want: ['warn', 'deny'] },
  {
    name: 'checkout --forc',
    prep: LOCAL_PEM,
    command: 'git checkout --forc',
    want: ['warn', 'deny'],
  },
  {
    name: 'restore --work',
    prep: `${LOCAL_PEM} && git add certs/server.pem`,
    command: 'git restore --staged --work --source=v1 certs/server.pem',
    want: ['deny'],
  },
  // A program run on the files.
  {
    name: 'grep --open-files-in-pager',
    command: 'git grep --open-files-in-pager=rm k2',
    want: ['warn', 'deny'],
  },
  // Programs given with an option or a setting.
  {
    name: 'fetch --upload-pack',
    command: "git fetch --upload-pack='touch certs/new.pem; git-upload-pack' . main",
    want: ['warn', 'deny'],
  },
  {
    name: 'push --receive-pack',
    command: "git push --receive-pack='touch certs/new.pem; git-receive-pack' . HEAD:refs/heads/x",
    want: ['warn', 'deny'],
  },
  {
    name: '-c core.fsmonitor',
    command: "git -c core.fsmonitor='touch certs/new.pem; false' status",
    want: ['warn', 'deny'],
  },
  {
    name: '-c diff.external',
    command: "git -c diff.external='touch certs/new.pem; true' diff v1",
    want: ['warn', 'deny'],
  },
  {
    name: 'GIT_EXTERNAL_DIFF',
    command: "GIT_EXTERNAL_DIFF='touch certs/new.pem; true' git diff v1",
    want: ['warn', 'deny'],
  },
  {
    name: 'an exported GIT_EXTERNAL_DIFF',
    command: "export GIT_EXTERNAL_DIFF='touch certs/new.pem; true'; git diff v1",
    want: ['warn', 'deny'],
  },
  {
    name: 'archive --exec',
    command:
      "git archive --remote=. --exec='touch certs/new.pem; git-upload-archive' -o out.tar HEAD",
    want: ['warn', 'deny'],
  },
  {
    name: '-c core.hooksPath',
    prep: "mkdir -p h && printf '#!/bin/sh\\necho hook > certs/server.pem\\n' > h/pre-commit && chmod +x h/pre-commit && echo z > src/a.ts",
    command: 'git -c core.hooksPath=h commit -qam msg',
    want: ['warn', 'deny'],
  },
  // Paths read from standard input.
  {
    name: 'checkout-index --stdin',
    prep: LOCAL_PEM,
    command: 'echo certs/server.pem | git checkout-index -f --stdin',
    want: ['warn', 'deny'],
  },
  // A checkout put in a folder a rule covers, which has no covered file yet.
  { name: 'clone into it', scopes: VENDOR, command: 'git clone -q . vendor/lib', want: ['deny'] },
  {
    name: 'worktree add into it',
    scopes: VENDOR,
    command: 'git worktree add vendor/wt v1',
    want: ['deny'],
  },
  {
    name: 'checkout-index --prefix into it',
    scopes: VENDOR,
    command: 'git checkout-index -a --prefix=vendor/',
    want: ['deny'],
  },
  {
    name: 'read-tree --prefix -u into it',
    scopes: VENDOR,
    command: 'git read-tree --prefix=vendor/ -u v1',
    want: ['deny'],
  },
  {
    name: 'format-patch where it runs',
    scopes: VENDOR,
    prep: 'mkdir vendor',
    command: 'git -C vendor format-patch -2',
    want: ['deny'],
  },
  {
    name: 'format-patch --suffix',
    command: 'git format-patch --suffix=.pem -2',
    want: ['deny'],
  },
  // A push into the checked-out branch of a repository here, which updates its working tree.
  {
    name: 'push into a working tree',
    prep: 'git checkout -q -b ahead && echo k9 > certs/server.pem && git commit -qam k9 && git checkout -q main && git config receive.denyCurrentBranch updateInstead',
    command: 'git push . ahead:main',
    want: ['warn', 'deny'],
  },
  // An output file of read-tree.
  {
    name: 'read-tree --index-output',
    command: 'git read-tree --index-output=certs/idx.pem HEAD',
    want: ['deny'],
  },
  // init's options, and the folders it fills.
  {
    name: 'init -b main --bare into it',
    scopes: VENDOR,
    command: 'git init -q -b main --bare vendor',
    want: ['deny'],
  },
  {
    name: 'init --separate-git-dir into it',
    scopes: VENDOR,
    command: 'git init -q --separate-git-dir=vendor y',
    want: ['deny'],
  },
  {
    name: 'init --template, then a commit runs its hook',
    prep: "mkdir -p tpl/hooks && printf '#!/bin/sh\\necho hook > certs/server.pem\\n' > tpl/hooks/pre-commit && chmod +x tpl/hooks/pre-commit",
    command: 'git init -q --template=tpl && git commit -q --allow-empty -m x',
    want: ['warn', 'deny'],
  },
  // Settings written to a config file git reads.
  {
    name: 'config --file=.git/config core.hooksPath',
    prep: HOOK,
    command: 'git config --file=.git/config core.hooksPath hk && git commit -q --allow-empty -m x',
    want: ['warn', 'deny'],
  },
  {
    name: 'config -f .git/config core.fsmonitor',
    command:
      "git config -f .git/config core.fsmonitor 'echo hook > certs/server.pem; false' && git status -s",
    want: ['warn', 'deny'],
  },
  // Variables git honours besides its own.
  {
    name: 'EDITOR',
    command: "EDITOR='echo hook > certs/server.pem; true' git commit --allow-empty -q",
    want: ['warn', 'deny'],
  },
  {
    name: 'VISUAL',
    // git takes VISUAL only on a terminal that can show it.
    command: "TERM=xterm VISUAL='echo hook > certs/server.pem; true' git commit --allow-empty -q",
    want: ['warn', 'deny'],
  },
  {
    name: 'HOME with another .gitconfig',
    prep: `${HOOK} && mkdir -p fakehome && printf '[core]\\n\\thooksPath = hk\\n' > fakehome/.gitconfig`,
    command: 'HOME=fakehome git commit -q --allow-empty -m x',
    want: ['warn', 'deny'],
  },
  {
    name: 'XDG_CONFIG_HOME with another config',
    prep: `${HOOK} && mkdir -p xdg/git && printf '[core]\\n\\thooksPath = hk\\n' > xdg/git/config`,
    command: 'XDG_CONFIG_HOME=xdg git commit -q --allow-empty -m x',
    want: ['warn', 'deny'],
  },
  // Settings given to a shell that runs git.
  {
    name: 'GIT_CONFIG_* given to bash -c',
    prep: HOOK,
    command:
      "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=hk bash -c 'git commit -q --allow-empty -m x'",
    want: ['warn', 'deny'],
  },
  // Folders a clone or a submodule fills.
  {
    name: 'clone of a bundle',
    scopes: VENDOR,
    prep: 'git bundle create -q vendor.bundle --all',
    command: 'git clone -q vendor.bundle',
    want: ['deny'],
  },
  {
    name: 'submodule add into it',
    scopes: VENDOR,
    command: 'git -c protocol.file.allow=always submodule add -q ./ vendor/lib',
    want: ['deny'],
  },
  // The command bisect runs at each step.
  {
    name: 'bisect run',
    command: 'git bisect start HEAD v1 && git bisect run rm certs/server.pem',
    // `bisect start` may change the tree: what is run after it is not read fully.
    want: ['warn'],
  },
  // Variables set by code run in this shell, or read into it.
  {
    name: 'export inside eval',
    command: `eval "export GIT_EXTERNAL_DIFF=${EXT}"; git diff v1`,
    want: ['warn', 'deny'],
  },
  {
    name: 'set -a, then an assignment inside eval',
    command: `set -a; eval "GIT_EXTERNAL_DIFF=${EXT}"; git diff v1`,
    want: ['warn', 'deny'],
  },
  {
    name: 'export inside a DEBUG trap',
    command: `trap "export GIT_EXTERNAL_DIFF=${EXT}" DEBUG; git diff v1`,
    want: ['warn', 'deny'],
  },
  {
    // A file rather than `<(…)`: macOS's bash 3.2 does not read a process substitution with
    // `source`, so the command would not write anything there.
    name: 'source of a file',
    command: `printf '%s\\n' "export GIT_EXTERNAL_DIFF=${EXT}" > env.sh; source ./env.sh; git diff v1`,
    want: ['warn', 'deny'],
  },
  {
    name: 'set -a, then an assignment',
    command: `set -a; GIT_EXTERNAL_DIFF=${EXT}; git diff v1`,
    want: ['warn', 'deny'],
  },
  {
    name: 'declare -x',
    command: `declare -x GIT_EXTERNAL_DIFF=${EXT}; git diff v1`,
    want: ['warn', 'deny'],
  },
  {
    name: 'HOME set without export, already in the environment',
    prep: `${HOOK} && mkdir -p fakehome && printf '[core]\\n\\thooksPath = hk\\n' > fakehome/.gitconfig`,
    command: 'HOME=fakehome; git commit -q --allow-empty -m x',
    want: ['warn', 'deny'],
  },
  // `NAME+=value` sets a variable as `NAME=value` does.
  {
    name: 'NAME+= before git',
    command: `GIT_EXTERNAL_DIFF+=${EXT} git diff v1`,
    want: ['warn', 'deny'],
  },
  {
    name: 'export NAME+=',
    command: `export GIT_EXTERNAL_DIFF+=${EXT}; git diff v1`,
    want: ['warn', 'deny'],
  },
  {
    name: 'NAME+= before a git command that names the file',
    prep: LOCAL_PEM,
    command: 'X+=1 git checkout v1 -- certs/server.pem',
    // An assignment to an upper-case variable makes the line one not read fully.
    want: ['warn'],
  },
  // A value read as the destination of a push into a working tree.
  {
    name: 'push --recurse-submodules <value> into a working tree',
    prep: AHEAD,
    command: 'git push --recurse-submodules no . ahead:main',
    want: ['warn', 'deny'],
  },
  // A variable set anywhere on the line counts for every git command on it: in a function, before
  // or after, in a shell of its own or not, in whatever form the shell sets one.
  {
    name: 'export in a function called before git',
    command: `f() { export GIT_EXTERNAL_DIFF=${EXT}; }; f; git diff v1`,
    want: ['warn', 'deny'],
  },
  {
    name: 'export in a function defined with the keyword',
    command: `function f { export GIT_EXTERNAL_DIFF=${EXT}; }; f; git diff v1`,
    want: ['warn', 'deny'],
  },
  {
    name: 'HOME set in a function',
    prep: FAKE_HOME,
    command: `f() { HOME=fakehome; }; f; ${COMMIT}`,
    want: ['warn', 'deny'],
  },
  {
    name: 'eval in a function',
    command: `f() { eval "export GIT_EXTERNAL_DIFF=${EXT}"; }; f; git diff v1`,
    want: ['warn', 'deny'],
  },
  {
    name: 'source in a function',
    command: `printf '%s\\n' "export GIT_EXTERNAL_DIFF=${EXT}" > env.sh; f() { source ./env.sh; }; f; git diff v1`,
    want: ['warn', 'deny'],
  },
  {
    name: 'git in a function, export after it',
    command: `f() { git diff v1; }; export GIT_EXTERNAL_DIFF=${EXT}; f`,
    want: ['warn', 'deny'],
  },
  {
    name: 'git in an EXIT trap, export after it',
    command: `trap 'git diff v1' EXIT; export GIT_EXTERNAL_DIFF=${EXT}`,
    want: ['warn', 'deny'],
  },
  {
    name: 'an empty array, then an export in a group',
    command: `a=(); { export GIT_EXTERNAL_DIFF=${EXT}; }; git diff v1`,
    want: ['warn', 'deny'],
  },
  {
    name: 'for HOME in',
    prep: FAKE_HOME,
    command: `for HOME in fakehome; do ${COMMIT}; done`,
    want: ['warn', 'deny'],
  },
  {
    name: 'read HOME',
    prep: FAKE_HOME,
    command: `read HOME <<< fakehome; ${COMMIT}`,
    want: ['warn', 'deny'],
  },
  {
    name: 'printf -v HOME',
    prep: FAKE_HOME,
    command: `printf -v HOME fakehome; ${COMMIT}`,
    want: ['warn', 'deny'],
  },
  {
    name: 'declare -n, then a lower-case assignment',
    prep: FAKE_HOME,
    command: `declare -n h=HOME; h=fakehome; ${COMMIT}`,
    want: ['warn', 'deny'],
    namerefs: true,
  },
  {
    name: 'typeset -n, then a lower-case assignment',
    prep: FAKE_HOME,
    command: `typeset -n h=HOME; h=fakehome; ${COMMIT}`,
    want: ['warn', 'deny'],
    namerefs: true,
  },
  // Arithmetic sets variables wherever bash evaluates it: in a subscript, a test, a substring
  // offset, an integer variable's value, or a value evaluated later. HOME=5 is a folder `5`.
  {
    name: 'arithmetic in an assigned subscript',
    prep: FIVE_HOME,
    command: `a[HOME=5]=1; ${COMMIT}`,
    want: ['warn', 'deny'],
  },
  {
    name: 'arithmetic in a subscript printf -v writes',
    prep: FIVE_HOME,
    command: `printf -v 'a[HOME=5]' x; ${COMMIT}`,
    want: ['warn', 'deny'],
    runs: PRINTF_ELEMENT,
  },
  {
    name: 'arithmetic in a subscript read writes',
    prep: FIVE_HOME,
    command: `read 'a[HOME=5]' <<< x; ${COMMIT}`,
    want: ['warn', 'deny'],
  },
  {
    name: 'arithmetic in an array element subscript',
    prep: FIVE_HOME,
    command: `x=( [HOME=5]=1 ); ${COMMIT}`,
    want: ['warn', 'deny'],
  },
  {
    name: 'arithmetic in an expanded subscript',
    prep: FIVE_HOME,
    command: `: \${a[HOME=5]}; ${COMMIT}`,
    want: ['warn', 'deny'],
  },
  {
    name: 'arithmetic in a [[ -eq ]] test',
    prep: FIVE_HOME,
    command: `[[ 1 -eq HOME=5 ]]; ${COMMIT}`,
    want: ['warn', 'deny'],
  },
  {
    name: 'arithmetic in a substring offset',
    prep: FIVE_HOME,
    command: `x=a; : \${x:HOME=5}; ${COMMIT}`,
    want: ['warn', 'deny'],
  },
  {
    name: 'arithmetic in an integer variable',
    prep: FIVE_HOME,
    command: `typeset -i n=HOME=5; ${COMMIT}`,
    want: ['warn', 'deny'],
  },
  {
    name: 'arithmetic through a value, in (( ))',
    prep: FIVE_HOME,
    command: `v=HOME=5; ((v)); ${COMMIT}`,
    want: ['warn', 'deny'],
  },
  {
    name: 'arithmetic through a value, in let',
    prep: FIVE_HOME,
    command: `v=HOME=5; let v; ${COMMIT}`,
    want: ['warn', 'deny'],
  },
  {
    name: 'arithmetic through a value, in $(( ))',
    prep: FIVE_HOME,
    command: `v=HOME=5; : $((v)); ${COMMIT}`,
    want: ['warn', 'deny'],
  },
  {
    name: 'arithmetic through a value, in a subscript',
    prep: FIVE_HOME,
    command: `v=HOME=5; arr[v]=1; ${COMMIT}`,
    want: ['warn', 'deny'],
  },
  // Options that put assignments after a program's name into its environment.
  {
    name: 'set -k',
    prep: FAKE_HOME,
    command: `set -k; ${COMMIT} HOME=fakehome`,
    want: ['warn', 'deny'],
  },
  {
    name: 'shopt -o -s keyword',
    prep: FAKE_HOME,
    command: `shopt -o -s keyword; ${COMMIT} HOME=fakehome`,
    want: ['warn', 'deny'],
  },
  // A setting given to env, or a builtin run, through a word that is not plain text.
  {
    name: 'env given a variable',
    prep: FAKE_HOME,
    command: `v=HOME=fakehome; env "$v" ${COMMIT}`,
    want: ['warn', 'deny'],
  },
  {
    name: 'env given a substitution',
    prep: FAKE_HOME,
    command: `env $(echo HOME=fakehome) ${COMMIT}`,
    want: ['warn', 'deny'],
  },
  {
    name: 'env -S',
    prep: FAKE_HOME,
    command: `env -S 'HOME=fakehome ${COMMIT}'`,
    want: ['warn', 'deny'],
    runs: ENV_SPLIT,
  },
  {
    name: 'export run through a variable',
    prep: FAKE_HOME,
    command: `f=export; $f HOME=fakehome; ${COMMIT}`,
    want: ['warn', 'deny'],
  },
  {
    name: 'export run through a substitution',
    prep: FAKE_HOME,
    command: `$(echo export) HOME=fakehome; ${COMMIT}`,
    want: ['warn', 'deny'],
  },
  {
    name: 'xargs running env with its input',
    prep: FAKE_HOME,
    command: `echo HOME=fakehome | xargs -I{} env {} ${COMMIT}`,
    want: ['warn', 'deny'],
  },
  // `xargs git`: the subcommand comes from the input.
  {
    name: 'xargs git, given a setting',
    prep: FAKE_HOME,
    command: 'echo commit -q --allow-empty -m x | HOME=fakehome xargs git',
    want: ['warn', 'deny'],
  },
  {
    name: 'xargs git',
    command: "printf '%s\\n' checkout v1 -- certs/server.pem | xargs git",
    want: ['warn', 'deny'],
  },
  // Shell code given to `-c` with other options around it, or to another shell.
  {
    name: 'bash -c --',
    command: "bash -c -- 'git checkout -q v1 -- certs/server.pem'",
    want: ['warn', 'deny'],
  },
  {
    name: 'bash -ce',
    command: "bash -ce 'git checkout -q v1 -- certs/server.pem'",
    want: ['warn', 'deny'],
  },
  {
    name: 'bash -c -e',
    command: "bash -c -e 'git checkout -q v1 -- certs/server.pem'",
    want: ['warn', 'deny'],
  },
  {
    name: 'rbash -c',
    command: "rbash -c 'git checkout -q v1 -- certs/server.pem'",
    want: ['warn', 'deny'],
    runs: RBASH,
  },
  // `mapfile -C` runs its callback in this shell.
  {
    name: 'mapfile -C',
    prep: FAKE_HOME,
    command: `mapfile -c1 -C 'HOME=fakehome; :' arr <<< x; ${COMMIT}`,
    want: ['warn', 'deny'],
    runs: BASH4,
  },
  // git run from a subscript's substitution, or `git` hashed to another program.
  {
    name: 'git in a subscript printf -v writes',
    command: "printf -v 'a[$(git checkout -q v1 -- certs/server.pem)]' x",
    want: ['warn', 'deny'],
    runs: PRINTF_ELEMENT,
  },
  {
    name: 'git in a subscript evaluated later',
    command: "x='a[$(git checkout -q v1 -- certs/server.pem)]'; : $((x))",
    want: ['warn', 'deny'],
  },
  {
    name: 'git hashed to another program',
    prep: NOT_GIT,
    command: 'hash -p ./g.sh git; git status',
    want: ['warn', 'deny'],
  },
  // A harmless builtin given the option that sets a variable or runs a command through a word
  // that is not plain text.
  {
    name: 'printf -v given by a variable',
    prep: FAKE_HOME,
    command: `o=-v; printf "$o" HOME fakehome; ${COMMIT}`,
    want: ['warn', 'deny'],
  },
  {
    name: 'printf -v given by a substitution',
    prep: FAKE_HOME,
    command: `printf "$(echo -v)" HOME fakehome; ${COMMIT}`,
    want: ['warn', 'deny'],
  },
  {
    name: 'jobs -x given by a variable',
    prep: FAKE_HOME,
    command: `o=-x; jobs "$o" export HOME=fakehome; ${COMMIT}`,
    want: ['warn', 'deny'],
  },
  // `test -v` evaluates an element's subscript, running the substitution in it.
  { name: 'test -v of an element', command: `test -v 'a[$(${CO})]'`, want: ['warn'], runs: TEST_V },
  { name: '[ -v ] of an element', command: `[ -v 'a[$(${CO})]' ]`, want: ['warn'], runs: TEST_V },
  // git under a program not known here, which may run it with settings of its own.
  {
    name: 'git reset --hard under taskset',
    prep: LOCAL_PEM,
    command: 'taskset -c 0 git reset -q --hard v1',
    want: ['warn', 'deny'],
    runs: has('taskset'),
  },
  {
    name: 'git reset --hard under strace',
    prep: LOCAL_PEM,
    command: 'strace -f -o /dev/null git reset -q --hard v1',
    want: ['warn', 'deny'],
    runs: has('strace'),
  },
  {
    name: 'git reset --hard under chrt',
    prep: LOCAL_PEM,
    command: 'chrt -o 0 git reset -q --hard v1',
    want: ['warn', 'deny'],
    runs: has('chrt'),
  },
  {
    name: 'git under taskset, given HOME',
    prep: FAKE_HOME,
    command: `HOME=fakehome taskset -c 0 ${COMMIT}`,
    want: ['warn', 'deny'],
    runs: has('taskset'),
  },
  // flock's `-c` runs shell code.
  { name: 'flock -c', command: `flock lk -c '${CO}'`, want: ['warn'], runs: has('flock') },
  // Shell code from a shell's or `source`'s input, a file standing for it, or a process
  // substitution: a line not read fully, which only warns.
  {
    name: 'bash -s with arguments, from a here-string',
    command: `bash -s x <<< '${CO}'`,
    want: ['warn'],
  },
  {
    name: 'bash /dev/stdin, from a here-string',
    command: `bash /dev/stdin <<< '${CO}'`,
    want: ['warn'],
  },
  {
    name: 'bash -s with arguments, from a pipe',
    command: `echo '${CO}' | bash -s x`,
    want: ['warn'],
  },
  {
    name: 'bash -s with arguments, from a quoted here-document',
    command: `bash -s x <<'EOF'\n${CO}\nEOF`,
    want: ['warn'],
  },
  { name: 'bash of a process substitution', command: `bash <(echo '${CO}')`, want: ['warn'] },
  {
    name: 'source /dev/stdin, from a here-string',
    command: `source /dev/stdin <<< '${CO}'`,
    want: ['warn'],
    runs: BASH4,
  },
  {
    name: 'source of a process substitution',
    command: `source <(echo '${CO}')`,
    want: ['warn'],
    runs: BASH4,
  },
  {
    name: 'bash given a here-string of a variable',
    command: `c='${CO}'; bash <<< "$c"`,
    want: ['warn', 'deny'],
  },
  {
    name: 'bash given a here-document with a variable',
    command: `c='${CO}'; bash <<EOF\n$c\nEOF`,
    want: ['warn', 'deny'],
  },
  {
    name: 'bash given a variable through a pipe',
    command: `c='${CO}'; echo "$c" | bash`,
    want: ['warn', 'deny'],
  },
  { name: 'eval of a variable', command: `c='${CO}'; eval "$c"`, want: ['warn', 'deny'] },
  {
    name: 'xargs running sh -c on its input',
    command: `echo '${CO}' | xargs -I{} sh -c '{}'`,
    want: ['warn', 'deny'],
  },
  // `cd` through a symbolic link: `..` after it leads elsewhere than the text says.
  {
    name: 'cd -P through a symbolic link',
    command: `mkdir -p d/e && ln -s d/e l && cd -P l/.. && git checkout -q v1 -- ../certs/server.pem`,
    want: ['warn', 'deny'],
  },
  {
    name: 'cd through a symbolic link already there',
    prep: 'mkdir -p d/e && ln -s d/e l',
    command: 'cd l && git checkout -q v1 -- ../../certs/server.pem',
    want: ['warn', 'deny'],
  },
];

/** Commands that write no covered file: never blocked, and not warned about. */
const quiet: { name: string; prep?: string; command: string }[] = [
  { name: 'log with a colour setting', command: 'git -c color.ui=always log -1' },
  { name: 'log with a pager setting', command: 'git -c core.pager=cat log -1' },
  { name: 'log with GIT_PAGER', command: 'GIT_PAGER=cat git log -1' },
  { name: 'commit with GIT_EDITOR', prep: LOCAL_PEM, command: 'GIT_EDITOR=true git commit -qam x' },
  {
    name: 'commit with author settings',
    prep: LOCAL_PEM,
    command: 'git -c user.name=x -c user.email=y@example.invalid commit -qam x',
  },
  { name: 'diff-tree', command: 'git diff-tree -r HEAD' },
  { name: 'rev-list', command: 'git rev-list --count HEAD' },
  { name: 'shortlog', command: 'git shortlog -sn HEAD' },
  { name: 'grep with options', command: 'git grep -n -e k2 -- certs' },
  { name: 'blame of a line', command: 'git blame -L 1,1 src/a.ts' },
  { name: 'log with a pickaxe', command: 'git log -Gk2 -n1 --stat' },
  { name: 'status without untracked files', prep: LOCAL_PEM, command: 'git status -uno' },
  { name: 'fetch from here', command: 'git fetch -q . v1:refs/tags/again' },
  { name: 'push to a remote', command: 'git push -q origin main 2>/dev/null || true' },
  { name: 'config of the author', command: 'git config user.name x' },
  { name: 'format-patch into another folder', command: 'git format-patch -q -1 -o patches' },
  { name: 'archive to a file', command: 'git archive -o out.tar HEAD' },
  { name: 'diff to another file', command: 'git diff --output=out.diff v1' },
  { name: 'status with a locale', prep: LOCAL_PEM, command: 'LANG=C LC_ALL=C git status -s' },
  { name: 'log with a time zone and PAGER', command: 'TZ=UTC PAGER=cat git log -1' },
  { name: 'commit with EDITOR=true', prep: LOCAL_PEM, command: 'EDITOR=true git commit -qa' },
  {
    name: 'commit without signing',
    prep: LOCAL_PEM,
    command: 'git -c commit.gpgsign=false commit -qam x',
  },
  { name: 'log with --not', command: 'git log --oneline main --not v1' },
  { name: 'diff --compact-summary', command: 'git diff --compact-summary v1' },
  { name: 'log with an abbreviated option', command: 'git log --onel -1' },
  { name: 'fetch with a server option', command: 'git fetch -q -o x . v1:refs/tags/again || true' },
  { name: 'config of a file of its own', command: 'git config -f tool.ini core.hooksPath x' },
  { name: 'submodule status', command: 'git submodule status' },
  { name: 'status after a shell variable', command: 'msg=fix; git status' },
  { name: 'status in a folder', prep: 'mkdir -p sub', command: 'cd sub && git status' },
  {
    name: 'a build folder removed in a folder',
    prep: 'mkdir -p sub/dist',
    command: 'cd sub && rm -rf dist',
  },
  {
    name: 'a chain of commands in a folder named from here',
    prep: 'mkdir -p sub/dist',
    command: 'cd ./sub && rm -rf dist && mkdir dist && git status',
  },
  {
    name: 'files renamed in a folder',
    prep: 'mkdir -p sub && touch sub/a',
    command: 'cd sub && mv a b',
  },
  {
    name: 'a copy into a folder made on the line',
    command: 'mkdir build && cp src/a.ts build/a.ts',
  },
  {
    name: 'a folder removed, made again and filled',
    prep: 'mkdir dist',
    command: 'rm -rf dist && mkdir dist && cp src/a.ts dist/a.ts',
  },
  {
    name: 'copies into a folder on disk, then a file in it changed',
    prep: 'mkdir docs && echo t > docs/notes.md',
    command: 'cp src/a.ts docs/ && echo more >> docs/notes.md',
  },
  {
    name: 'a file written twice, then its mode changed',
    command: 'echo a > run.sh && echo b >> run.sh && chmod 755 run.sh',
  },
  { name: 'a new file written', command: 'echo x > new.txt' },
  { name: 'a file with one name added to', command: 'echo x >> src/a.ts' },
  {
    name: 'another name of a covered file removed',
    prep: 'ln certs/server.pem f',
    command: 'rm -f f',
  },
  {
    name: 'another name of a covered file given to another file',
    prep: 'ln certs/server.pem f',
    command: 'mv src/a.ts f',
  },
  {
    name: 'another name of a covered file made a link',
    prep: 'ln certs/server.pem f',
    command: 'ln -sf src/a.ts f',
  },
  {
    name: 'a folder made on the line, its mode changed, then filled',
    command: 'mkdir d && chmod 755 d && cp src/a.ts d/a.ts',
  },
  { name: 'a test of the diff', command: 'if git diff --quiet; then echo ok; fi' },
];

/** A folder `d` with a file of the covered name, to pour or link from. */
const D_FOLDER = 'mkdir -p d && echo z > d/server.pem';

// Copies, moves and links whose destination the text alone does not settle.
cases.push(
  {
    name: 'a wildcard read before the link it later matches',
    scopes: ['certs/**'],
    command: 'rm -f l*/server.pem; ln -s certs lnk && rm -f l*/server.pem',
    want: ['warn'],
  },
  {
    name: 'cp -rT pours a folder into a covered one',
    scopes: ['certs/server.pem'],
    prep: D_FOLDER,
    command: 'cp -rT d certs',
    want: ['warn'],
    runs: CP_T,
  },
  {
    name: 'cp -r --no-target-directory',
    scopes: ['certs/server.pem'],
    prep: D_FOLDER,
    command: 'cp -r --no-target-directory d certs',
    want: ['warn'],
    runs: CP_T,
  },
  {
    name: 'ln with one operand links into the folder it runs in',
    scopes: ['certs/**'],
    prep: D_FOLDER,
    command: 'cd certs && ln -f ../d/server.pem',
    want: ['warn'],
  },
  {
    name: 'ln -sf with one operand',
    scopes: ['certs/**'],
    prep: D_FOLDER,
    command: 'cd certs && ln -sf ../d/server.pem',
    want: ['warn'],
  },
  {
    name: 'cp into a folder made earlier on the line',
    scopes: VENDOR,
    command: 'mkdir vendor && cp src/a.ts vendor',
    want: ['deny'],
  },
  {
    name: 'mv into a folder made earlier on the line',
    scopes: VENDOR,
    command: 'mkdir vendor; mv src/a.ts vendor',
    want: ['deny'],
  },
);

/** The covered file gone from the last commit, its rule's folder left empty on disk. */
const EMPTY_RULE_FOLDER = 'git rm -q certs/server.pem && git commit -qm rm && mkdir certs';

cases.push(
  // A folder `mkdir` is asked to make may not be made: a copy to it still writes the name itself.
  {
    name: 'mkdir -p through a covered file fails, then cp overwrites the file',
    command: 'mkdir -p certs/server.pem/x; cp src/a.ts certs/server.pem',
    want: ['deny'],
  },
  {
    name: 'mkdir -p through a covered file fails, then mv overwrites the file',
    command: 'mkdir -p certs/server.pem/x 2>/dev/null; mv src/a.ts certs/server.pem',
    want: ['deny'],
  },
  {
    name: 'mkdir that never runs, then cp makes a covered file',
    command: 'false && mkdir -p new.pem/x; cp src/a.ts new.pem',
    want: ['deny'],
  },
  // git bringing a covered file back into an empty folder a rule names.
  {
    name: 'git checkout of a revision into an empty rule folder',
    scopes: ['certs/**'],
    prep: EMPTY_RULE_FOLDER,
    command: 'git checkout -q HEAD~1 -- .',
    // git is asked: it names the file it brings back.
    want: ['deny'],
  },
  {
    name: 'git reset --hard into an empty rule folder',
    scopes: ['certs/**'],
    prep: EMPTY_RULE_FOLDER,
    command: 'git reset -q --hard HEAD~1',
    want: ['deny'],
  },
  // A `cd` that fails leaves the commands after it where the shell was.
  {
    name: 'cd to a folder that is not there, then a covered file removed',
    scopes: ['certs/**'],
    command: 'cd nope; rm -f certs/server.pem',
    want: ['warn'],
  },
);

// Only a leading `cd <folder> &&` is read: where any other `cd` lands is not followed, as it
// may fail, never run, or go where the line has just changed the disk.
cases.push(
  {
    name: 'a cd to a folder made and removed earlier in the chain',
    scopes: ['certs/**'],
    command: 'mkdir x && rm -r x && cd x; rm -f certs/server.pem',
    want: ['warn'],
  },
  {
    name: 'a cd to a folder made and rmdir-ed earlier in the chain',
    scopes: ['certs/**'],
    command: 'mkdir x && rmdir x && cd x; rm -f certs/server.pem',
    want: ['warn'],
  },
  {
    name: 'a cd after a mkdir that fails on a file',
    scopes: ['certs/**'],
    prep: 'touch x',
    command: 'mkdir x && cd x; rm -f certs/server.pem',
    want: ['warn'],
  },
  {
    name: 'a cd after a mkdir that fails on a folder already there',
    scopes: ['certs/**'],
    prep: 'mkdir sub',
    command: 'mkdir sub && cd sub; rm -f certs/server.pem',
    want: ['warn'],
  },
  {
    name: 'a cd after a failed &&',
    scopes: ['certs/**'],
    prep: 'mkdir sub',
    command: 'false && cd sub; rm -f certs/server.pem',
    want: ['warn'],
  },
  {
    name: 'a cd after a succeeding ||',
    scopes: ['certs/**'],
    prep: 'mkdir sub',
    command: 'true || cd sub; rm -f certs/server.pem',
    want: ['warn'],
  },
  {
    name: 'a cd in an if branch not taken',
    scopes: ['certs/**'],
    prep: 'mkdir sub',
    command: 'if false; then cd sub; fi; rm -f certs/server.pem',
    want: ['warn'],
  },
  {
    name: 'a cd to a folder removed earlier on the line',
    scopes: ['certs/**'],
    prep: 'mkdir sub',
    command: 'rm -rf sub; cd sub; rm -f certs/server.pem',
    want: ['warn'],
  },
  {
    name: 'a cd to a folder rmdir-ed earlier on the line',
    scopes: ['certs/**'],
    prep: 'mkdir sub',
    command: 'rmdir sub; cd sub; rm -f certs/server.pem',
    want: ['warn'],
  },
  {
    name: 'a cd given two operands',
    scopes: ['certs/**'],
    prep: 'mkdir sub',
    command: 'cd sub x; rm -f certs/server.pem',
    want: ['warn'],
    // bash before 4.4 (macOS ships 3.2) ignores a second operand and enters the folder.
    runs: BASH_MAJOR >= 44,
  },
  {
    name: 'a leading cd to a folder there, then a path named from it',
    scopes: ['certs/**'],
    prep: 'mkdir sub',
    command: 'cd sub && rm -f ../certs/server.pem',
    want: ['deny'],
  },
  {
    name: 'a covered file removed after a folder made and filled on the line',
    scopes: ['certs/**'],
    command: 'mkdir -p out/a && touch out/a/x.txt && rm -f certs/server.pem',
    want: ['deny'],
  },
  {
    name: 'a file written, then moved onto a covered one',
    scopes: ['certs/**'],
    command: 'echo x > tmp && mv tmp certs/server.pem',
    want: ['deny'],
  },
  {
    name: 'a leading cd, a path named from it, and the line end',
    scopes: ['certs/**'],
    prep: 'mkdir sub',
    command: 'cd sub && rm -f ../certs/server.pem\n',
    want: ['deny'],
  },
);

describe('git commands that write a covered file through an option or a setting', () => {
  for (const c of cases) {
    it(c.name, async () => {
      const g = setUp(c.scopes ?? PEM, c.prep);
      try {
        const done = runInCopy(g.dir, c.command, covered);
        if ((!c.namerefs || NAMEREFS) && (c.runs ?? true)) {
          expect(
            done.written.length,
            `\`${c.command}\` writes a covered file; ${done.output}`,
          ).toBeGreaterThan(0);
        }
        const r = await g.shell(c.command);
        expect(
          c.want,
          `hook on \`${c.command}\` (writes ${done.written.join(', ')}): ${r.reason ?? ''}`,
        ).toContain(verdictOf(r));
      } finally {
        g.mindly.close();
      }
    });
  }
  for (const c of quiet) {
    it(`never blocks: ${c.name}`, async () => {
      const g = setUp(PEM, c.prep);
      try {
        const done = runInCopy(g.dir, c.command, covered);
        expect(done.written, c.command).toEqual([]);
        const r = await g.shell(c.command);
        expect(verdictOf(r), `hook on \`${c.command}\`: ${r.reason ?? ''}`).toBe('allow');
      } finally {
        g.mindly.close();
      }
    });
  }
});

/**
 * Commands that write no covered file but hold code the shell does not run (quoted text) on a
 * line that may evaluate text as code: never blocked, perhaps warned about.
 */
/** A tracked folder `vendor` that a rule covers, to reach through a link. */
const VENDOR_FILE = 'mkdir -p vendor && echo a > vendor/x && git add vendor && git commit -qm v';

/**
 * Lines Mindly does not read fully that write a covered file: a warning, never silence (and
 * never a block). Links made on the line, code fed to a shell in ways the text does not show
 * plainly, a `)` of a `case` in a substitution, git run through a variable or by `script`.
 */
const notReadFully: {
  name: string;
  scopes?: string[];
  prep?: string;
  command: string;
  runs?: boolean;
}[] = [
  {
    name: 'a link made with ln --sy, then cd into it',
    scopes: VENDOR,
    prep: VENDOR_FILE,
    command: 'ln --sy vendor c && cd c && git rm -q x',
    runs: LN_LONG,
  },
  {
    name: 'a link copied with cp -P, then cd into it',
    scopes: VENDOR,
    prep: `${VENDOR_FILE} && ln -s vendor l`,
    command: 'cp -P l c && cd c && git rm -q x',
  },
  {
    name: 'a function that cds, called after a link is made',
    scopes: VENDOR,
    prep: VENDOR_FILE,
    command: 'f() { cd c && git rm -q x; }; ln -s vendor c; f',
  },
  {
    name: 'bash of a process substitution of echo -e',
    command: "bash <(echo -e 'true\\ngit reset -q --hard v1')",
  },
  {
    name: 'bash of a process substitution of printf',
    command: "bash <(printf 'git\\treset -q --hard v1')",
  },
  { name: 'echo -e piped to bash', command: "echo -e 'git\\x20reset -q --hard v1' | bash" },
  {
    name: 'printf conversions piped to bash',
    command: "printf '%s %s -q --hard v1\\n' git reset | bash",
  },
  {
    name: "bash -s given a $'…' here-string",
    command: "bash -s <<< $'true\\ngit reset -q --hard v1'",
  },
  {
    name: 'a here-document, then a here-string, to bash',
    command: "bash <<'EOF' <<<'git reset -q --hard v1'\necho hi\nEOF\n",
  },
  {
    name: 'printf -v into a subscript with a case',
    command: `printf -v 'a[$(case x in x) ${CO};; esac)]' x`,
    runs: PRINTF_ELEMENT,
  },
  {
    name: 'a substitution holding a case',
    command: `echo "$(case x in x) ${CO};; esac)"`,
    runs: CASE_IN_SUBST,
  },
  { name: 'git through a variable', command: 'GIT=git; $GIT reset -q --hard v1' },
  {
    name: 'git run by script -c',
    command: "script -qec 'git reset -q --hard v1' /dev/null",
    runs: SCRIPT_C,
  },
  { name: 'a substitution in a default value', command: `echo "\${x:-'$(${CO})'}"` },
];

/** A TypeScript compiler, when the repository has one installed. */
const TSC = `${process.cwd()}/node_modules/.bin/tsc`;

// Lines whose programs, options or assignments the reader does not model completely.
notReadFully.push(
  // An assignment with a quoted value is still an assignment, before the program.
  {
    name: 'an empty quoted assignment before bash -c',
    command: "A='' bash -c 'x=certs/server.pem; rm $x'",
  },
  {
    name: 'an empty quoted assignment before sh -c',
    command: `A="" sh -c 'rm "$0"' certs/server.pem`,
  },
  {
    name: 'an empty quoted assignment before eval',
    command: "A='' eval 'x=certs/server.pem; rm $x'",
  },
  // A rule scoped to a folder, on a line not read fully: the folder is there.
  {
    name: 'bash -c removing a folder a rule names',
    scopes: ['certs'],
    command: "bash -c 'rm -r certs'",
  },
  // Launchers and assignments the reader does not model.
  { name: 'npx -c', command: "npx -c 'rm certs/server.pem'", runs: has('npx') },
  {
    name: 'npx --call under timeout',
    command: "timeout 5 npx --call 'rm certs/server.pem'",
    runs: has('npx') && has('timeout'),
  },
  {
    name: 'env --spl',
    command: "env --spl 'rm certs/server.pem'",
    // GNU env takes abbreviated long options; BSD env (macOS) does not.
    runs: works("env --spl 'true'"),
  },
  { name: 'HOME set, then ~', command: 'HOME=certs; rm ~/server.pem' },
  { name: 'HOME set, then cd', command: 'HOME=certs; cd; rm server.pem' },
  // Filters and programs that write, besides what they read.
  {
    name: 'a pipe into uniq with an output file',
    command: 'cat src/a.ts | uniq - certs/server.pem',
  },
  { name: 'uniq with an output file', command: 'uniq src/a.ts certs/server.pem' },
  { name: 'a pipe into sort -mo', command: 'cat src/a.ts | sort -mo certs/server.pem' },
  { name: 'sort -uo', command: 'sort -uo certs/server.pem src/a.ts' },
  { name: 'sort --outp=', command: 'sort --outp=certs/server.pem src/a.ts' },
  { name: 'rg --pre rm', command: 'rg --pre rm k certs', runs: has('rg') },
  { name: 'awk print to a file', command: `awk '{print > "certs/server.pem"}' src/a.ts` },
  { name: 'awk system', command: `awk 'BEGIN{system("rm certs/server.pem")}'` },
  { name: 'sed w', command: "sed -n 'w certs/server.pem' src/a.ts" },
  { name: 'ruby -i', command: `ruby -i -pe 'sub(/k/,"z")' certs/server.pem`, runs: has('ruby') },
  {
    name: 'tsc --outFile',
    command: `${TSC} src/a.ts --outFile certs/server.pem`,
    runs: works(`test -x ${TSC}`),
  },
  // Interpreters given code that builds the paths it writes.
  {
    name: 'python -c over listdir',
    command: `python3 -c 'import os; [os.remove(os.path.join("certs", f)) for f in os.listdir("certs")]'`,
    runs: has('python3'),
  },
  {
    name: 'node -e over readdirSync',
    command: `node -e 'const fs=require("fs"); for (const f of fs.readdirSync("certs")) fs.unlinkSync("certs/"+f)'`,
  },
  // A wildcard naming a folder made earlier on the line.
  { name: 'cp into k*/ made on the line', command: 'mkdir keys && cp certs/server.pem k*/' },
  {
    name: 'cp into v*/ made on the line',
    scopes: VENDOR,
    command: 'mkdir vendor && cp src/a.ts v*/',
  },
);

describe('a shell line that holds a patch is read as a shell line', () => {
  for (const command of [
    // A here-document that ends early: bash runs what follows its delimiter.
    "apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: notes.txt\n+a\nEOF\nrm -f certs/server.pem\n*** End Patch\nEOF",
    'apply_patch <<"EOF"\n*** Begin Patch\n*** Add File: notes.txt\n+a\nEOF\nrm -f certs/server.pem\n*** End Patch\nEOF',
    "apply_patch <<-'EOF'\n*** Begin Patch\n*** Add File: notes.txt\n+a\n\tEOF\nrm -f certs/server.pem\n*** End Patch\nEOF",
    // An unquoted delimiter: bash expands the here-document, substitutions and all.
    'apply_patch <<EOF\n*** Begin Patch\n*** Add File: notes.txt\n+$(rm -f certs/server.pem)\n*** End Patch\nEOF',
    // A bare patch given to the shell: bash runs each of its lines.
    '*** Begin Patch\n*** Update File: src/a.ts\n@@\n rm -f certs/server.pem\n-x\n+y\n*** End Patch',
  ]) {
    it(`a patch bash runs: ${JSON.stringify(command.slice(0, 30))}`, async () => {
      const { buildTool } = await import('../../adapters/src/shared/tools.js');
      const g = setUp(PEM);
      try {
        expect(runInCopy(g.dir, command, covered).written).toEqual(['certs/server.pem']);
        const r = await g.mindly.hooks.handle({
          agentKind: 'claude-code',
          event: 'pre_tool',
          externalSessionId: 'p',
          cwd: g.dir,
          transcriptPath: null,
          startSource: null,
          prompt: null,
          lastMessage: null,
          tool: buildTool({ name: 'Bash', input: { command } }),
        });
        expect(verdictOf(r)).toBe('warn');
      } finally {
        g.mindly.close();
      }
    });
  }

  it('a Bash line holding an apply_patch envelope', async () => {
    const { buildTool } = await import('../../adapters/src/shared/tools.js');
    const g = setUp(PEM);
    try {
      const command =
        "rm certs/server.pem; echo '*** Begin Patch\n*** Add File: notes.txt\n+x\n*** End Patch' >/dev/null";
      expect(runInCopy(g.dir, command, covered).written).toEqual(['certs/server.pem']);
      const r = await g.mindly.hooks.handle({
        agentKind: 'claude-code',
        event: 'pre_tool',
        externalSessionId: 'p',
        cwd: g.dir,
        transcriptPath: null,
        startSource: null,
        prompt: null,
        lastMessage: null,
        tool: buildTool({ name: 'Bash', input: { command } }),
      });
      expect(verdictOf(r)).toBe('deny');
    } finally {
      g.mindly.close();
    }
  });
});

describe('lines not read fully that write a covered file are warned about', () => {
  for (const c of notReadFully) {
    it(c.name, async () => {
      const g = setUp(c.scopes ?? PEM, c.prep);
      try {
        const done = runInCopy(g.dir, c.command, covered);
        if (c.runs ?? true)
          expect(done.written.length, `${c.command}: ${done.output}`).toBeGreaterThan(0);
        const r = await g.shell(c.command);
        expect(verdictOf(r), `hook on \`${c.command}\``).toBe('warn');
      } finally {
        g.mindly.close();
      }
    });
  }
});

const notBlocked: { name: string; scopes?: string[]; prep?: string; command: string }[] = [
  // What git clean removes is untracked: a folder rule over tracked files is not reached.
  {
    name: 'git clean of a pattern beside a folder rule',
    scopes: ['certs/**'],
    prep: 'echo t > junk.orig',
    command: "git clean -f '*.orig'",
  },
  {
    name: 'git clean of folders beside a folder rule',
    scopes: ['certs/**'],
    prep: 'mkdir -p a/dist && echo t > a/dist/x.js',
    command: "git clean -fd -- '**/dist'",
  },
  // A package manager is not modelled completely: the line warns, never blocks.
  { name: 'tests, then a commit', command: 'npm test >/dev/null 2>&1 && git commit -qm x' },
  // Text that is not run, with a subscript and a substitution in it.
  {
    name: 'a to-do line holding a substitution, written to a file',
    command: `printf '%s\\n' '- [ ] restore with $(${CO})' >> TODO.md`,
  },
  {
    name: 'a test against text holding a substitution',
    command: `[ "$x" = '[$(${CO})]' ] || echo no`,
  },
  // Lines not read fully, which warn when a covered file is there: a variable, a function, a
  // loop.
  {
    name: 'commit with a message from a shell variable',
    prep: LOCAL_PEM,
    command: 'msg="fix"; git commit -qam "$msg"',
  },
  { name: 'a function that only prints', command: 'f() { echo hi; }; f; git status' },
  { name: 'a loop that adds files', command: 'for f in src/a.ts; do git add "$f"; done' },
  {
    name: 'a commit with a message holding a variable',
    prep: LOCAL_PEM,
    command: 'git add -A && git commit -qm "fix $thing"',
  },
  {
    name: 'a quoted tip on a line with set -e',
    command: `set -e; echo 'tip: run $(${CO}) to restore'`,
  },
  {
    name: 'notes from a quoted here-document on a line with set -e',
    command:
      "set -e\ncat > notes.md <<'EOF'\nRotate with: $(openssl req -x509 -out certs/server.pem)\nEOF",
  },
];

describe('lines not read fully, and code the shell does not run, are never blocked', () => {
  for (const c of notBlocked) {
    it(c.name, async () => {
      const g = setUp(c.scopes ?? PEM, c.prep);
      try {
        const done = runInCopy(g.dir, c.command, covered);
        expect(done.written, c.command).toEqual([]);
        const r = await g.shell(c.command);
        expect(verdictOf(r), `hook on \`${c.command}\`: ${r.reason ?? ''}`).not.toBe('deny');
      } finally {
        g.mindly.close();
      }
    });
  }
});

/** Thirty-two paths: as many as a line not read fully has placed one by one. */
const MANY = Array.from({ length: 32 }, (_, i) => `f${i + 1}`).join(' ');
/** A folder whose name is a private-use character. */
const PRIVATE = String.fromCharCode(0xe000);
const inCerts = (rel: string) => rel.startsWith('certs/');
const endsInPem = (rel: string) => rel.endsWith('.pem');
/** Another name of the covered file, there before the line. */
const OTHER_NAME = 'ln certs/server.pem f';
/** A link to the covered folder, there before the line. */
const OLD_LINK = 'ln -s certs old';
/** A branch `other` whose tree holds a link `lnk` to the covered folder. */
const LINK_IN_REVISION =
  'git checkout -qb other && ln -s certs lnk && git add lnk && git commit -qm link && git checkout -q main';
/** A folder `a/b`, and a link `lnk` to it. */
const LINK_TO_FOLDER = 'mkdir -p a/b && ln -s a/b lnk';
/** A tracked folder `a/b` and an empty folder `x` beside it. */
const NESTED = 'mkdir -p a/b x && touch a/b/f && git add a && git commit -qm nested';

/**
 * Lines that write a covered file where the text does not tell which: a `cd` that is not the
 * first thing on the line, fails, or lands elsewhere than its operand says; the folder the line
 * runs in moved away; a path named after more of them than are placed one by one. None is read
 * fully, and each is warned about.
 */
const strays: {
  name: string;
  scopes?: string[];
  prep?: string;
  command: string;
  /** The files the rule covers; those under `certs/` unless given. */
  covered?: (rel: string) => boolean;
  /** Where the session's shell is, under the project. */
  cwd?: string;
  /** Variables the agent's shell inherited, and the hook with it. */
  env?: Record<string, string>;
  /** Only where the tests do not run as root, which enters any folder. */
  notRoot?: boolean;
  /** False where the command, or the copy it runs in, cannot be had as elsewhere: only asked. */
  runs?: boolean;
}[] = [
  // A path named after the first few: a covered file that is not there yet.
  {
    name: 'a new .env named after thirty-two other paths',
    scopes: ['.env'],
    covered: (rel) => rel === '.env',
    command: `touch ${MANY}; echo "KEY=$USER" > .env`,
  },
  {
    name: 'a new key file named after thirty-two other paths, the rule by extension',
    scopes: ['**/*.key'],
    covered: (rel) => rel.endsWith('.key'),
    command: `touch ${MANY}; echo "$USER" > certs/new.key`,
  },
  {
    name: 'the one file of a rule named after thirty-two other paths',
    scopes: ['certs/server.key'],
    covered: (rel) => rel.endsWith('.key'),
    command: `rm -f ${MANY} && echo $(date) > certs/server.key`,
  },
  {
    name: 'a rule folder that is not there, made and filled after thirty-two other paths',
    prep: 'git rm -rq certs && git commit -qm gone',
    command: `touch ${MANY}; mkdir certs && echo "$USER" > certs/new.pem`,
  },
  {
    name: 'a new .env named after more commands than are read for their paths',
    scopes: ['.env'],
    covered: (rel) => rel === '.env',
    command: `${'true; '.repeat(2001)}echo "KEY=$USER" > .env`,
  },
  // A command of redirections only comes before the cd: the cd is not the first on the line.
  {
    name: 'a cd after a redirection that succeeds and ||',
    prep: 'mkdir sub',
    command: '>x || cd sub && rm -f certs/server.pem',
  },
  {
    name: 'a cd after a redirection that fails and &&',
    prep: 'mkdir sub',
    command: '> nosuch/x && cd sub && true; rm -f certs/server.pem',
  },
  {
    name: 'a cd after 2>/dev/null and ||',
    prep: 'mkdir sub',
    command: '2>/dev/null || cd sub && rm -f certs/server.pem',
  },
  {
    name: 'a cd after </dev/null and ||',
    prep: 'mkdir sub',
    command: '</dev/null || cd sub && rm -f certs/server.pem',
  },
  {
    name: 'a cd after 2>&1 and ||',
    prep: 'mkdir sub',
    command: '2>&1 || cd sub && rm -f certs/server.pem',
  },
  // `env cd` runs a program, if there is one: the shell stays where it was.
  {
    name: 'a cd run by env',
    prep: 'mkdir sub',
    command: 'env cd sub; rm -f certs/server.pem',
  },
  {
    name: 'a cd run by env, then && and ;',
    prep: 'mkdir sub',
    command: 'env cd sub && true; rm -f certs/server.pem',
  },
  {
    name: 'a cd run by env after an assignment',
    prep: 'mkdir sub',
    command: 'env x=1 cd sub; rm -f certs/server.pem',
  },
  // A leading cd that fails though the folder its text comes to is there.
  {
    name: 'a leading cd through a folder that is not there and ..',
    prep: 'mkdir sub',
    command: 'cd sub/nosuch/.. && true; rm -f certs/server.pem',
    runs: CD_CHECKS_DOTDOT,
  },
  {
    name: 'a leading cd through a missing folder and .. to a folder beside it',
    prep: 'mkdir sub',
    command: 'cd nosuch/../sub && true; rm -f certs/server.pem',
    runs: CD_CHECKS_DOTDOT,
  },
  {
    name: 'a leading cd through a file and ..',
    prep: 'mkdir sub && touch sub/f',
    command: 'cd sub/f/.. && true; rm -f certs/server.pem',
  },
  {
    name: 'a leading cd to a folder that cannot be entered',
    prep: 'mkdir sub && chmod 600 sub',
    command: 'cd sub && ls; rm -f certs/server.pem',
    notRoot: true,
    runs: CP_CLOSED_FOLDER,
  },
  // A leading cd that lands elsewhere than its operand says.
  {
    name: 'a leading cd to ~-, the folder the shell was in before',
    prep: 'mkdir sub',
    cwd: 'sub',
    env: { OLDPWD: '..' },
    command: 'cd ~- && rm -f certs/server.pem',
    runs: OLDPWD_INHERITED,
  },
  {
    name: 'a leading cd to a name CDPATH finds elsewhere',
    prep: 'mkdir -p sub certs/sub',
    env: { CDPATH: 'certs' },
    command: 'cd sub && rm -f ../server.pem',
  },
  {
    name: 'a leading cd to a folder named by a private-use character',
    prep: `mkdir ${PRIVATE}`,
    command: `cd ${PRIVATE} && rm -f ../certs/server.pem`,
  },
  // The folder the commands run in is moved: what follows runs where the text does not tell.
  {
    name: 'the folder a cd entered moved into the covered folder',
    prep: 'mkdir sub',
    command: 'cd sub && mv ../sub ../certs/ && rm -f ../server.pem',
  },
  {
    name: 'the folder a cd entered moved by a wildcard',
    prep: 'mkdir sub',
    command: 'cd sub && mv ../su? ../certs/ && rm -f ../server.pem',
  },
  {
    name: 'a folder above the one a cd entered moved into the covered folder',
    prep: 'mkdir -p a/b',
    command: 'cd a/b && mv ../../a ../../certs && touch new.pem',
  },
  {
    name: 'the folder the session is in moved into the covered folder',
    prep: 'mkdir sub',
    cwd: 'sub',
    command: 'mv ../sub ../certs/ && rm -f ../server.pem',
  },
  {
    name: 'a folder above the one a cd entered moved by git mv',
    prep: NESTED,
    command: 'cd a/b && git mv ../../a ../../x/ && rm -f ../../../certs/server.pem',
  },
  {
    name: 'the folder the session is in moved through a link made on the line',
    prep: 'mkdir sub',
    cwd: 'sub',
    covered: (rel) => rel.endsWith('.pem'),
    command: 'ln -s .. up && mv up/sub ../certs/ && rm -f ../server.pem',
  },
  // A path through something made earlier on the line: a link, for all the text tells.
  {
    name: 'a covered file removed through a link made on the line',
    command: 'ln -s certs lnk && rm -f lnk/server.pem',
  },
  {
    name: 'a covered file made through a link made on the line',
    command: 'ln -s certs lnk && touch lnk/new.pem',
  },
  {
    name: 'a redirection through a link made on the line',
    command: 'ln -s certs lnk && echo x > lnk/server.pem',
  },
  {
    name: 'a copy through a link made on the line',
    command: 'ln -s certs lnk; cp src/a.ts lnk/server.pem',
  },
  {
    name: 'a link made in a folder, then a path through it',
    prep: 'mkdir sub',
    command: 'ln -s ../certs sub/lnk && rm -f sub/lnk/server.pem',
  },
  {
    name: 'a link made after a leading cd, then a path through it',
    prep: 'mkdir sub',
    command: 'cd sub && ln -s ../certs l && rm -f l/server.pem',
  },
  {
    name: 'a link made into a folder on disk, under the name of what it points to',
    prep: 'mkdir sub',
    command: 'ln -s ../certs sub && rm -f sub/certs/server.pem',
  },
  {
    name: 'a link that replaces a link on disk',
    prep: 'ln -s src l',
    command: 'ln -sfn certs l && rm -f l/server.pem',
  },
  // A write onto what may be a link, of either kind, goes to the file it stands for.
  {
    name: 'a redirection onto a link to a covered file made on the line',
    command: 'ln -s certs/server.pem f && echo x > f',
  },
  {
    name: 'a copy onto a link to a covered file made on the line',
    command: 'ln -s certs/server.pem f && cp src/a.ts f',
  },
  {
    name: 'a redirection onto another name of a covered file made on the line',
    command: 'ln certs/server.pem f && echo x > f',
  },
  {
    name: 'a redirection onto another name of a covered file made in a folder on disk',
    prep: 'mkdir sub',
    command: 'ln certs/server.pem sub && echo x > sub/server.pem',
  },
  // A link copied, moved or checked out on the line.
  {
    name: 'a link copied with cp -a, then a path through the copy',
    prep: OLD_LINK,
    command: 'cp -a old l2 && rm -f l2/server.pem',
  },
  {
    name: 'a link copied with cp -R, then a path through the copy',
    prep: OLD_LINK,
    command: 'cp -R old l2 && rm -f l2/server.pem',
  },
  {
    name: 'a link copied with cp -P, then a path through the copy',
    prep: OLD_LINK,
    command: 'cp -P old l2 && rm -f l2/server.pem',
  },
  {
    name: 'a link moved, then a path through its new name',
    prep: OLD_LINK,
    command: 'mv old l2 && rm -f l2/server.pem',
  },
  {
    name: 'a link checked out of another revision, then a path through it',
    prep: LINK_IN_REVISION,
    command: 'git checkout other -- lnk && rm -f lnk/server.pem',
  },
  // A folder `mkdir` made is a folder only while nothing else made that path.
  {
    name: 'a folder made and removed, then a link of its name',
    command: 'mkdir d && rmdir d && ln -s certs d && rm -f d/server.pem',
  },
  {
    name: 'a folder on disk removed, then a link of its name',
    prep: 'mkdir d',
    command: 'rm -rf d && ln -s certs d && rm -f d/server.pem',
  },
  {
    name: 'a folder on disk removed by a wildcard, then a link of its name',
    prep: 'mkdir sub',
    command: 'rm -rf su? && ln -s certs sub && rm -f sub/server.pem',
  },
  {
    name: 'a link, then a mkdir of its name that fails',
    command: 'ln -s certs d; mkdir d; rm -f d/server.pem',
  },
  {
    name: 'a link, then a mkdir -p of its name',
    command: 'ln -s certs d; mkdir -p d; rm -f d/server.pem',
  },
  {
    name: 'a link, then a mkdir -p of a folder through it',
    command: 'ln -s certs d && mkdir -p d/e && touch d/e/k.pem',
  },
  {
    name: 'a link made into a folder made on the line',
    command: 'mkdir d && ln -s ../certs d && rm -f d/certs/server.pem',
  },
  {
    name: 'a mkdir that never runs, then a link moved to its name',
    prep: OLD_LINK,
    command: 'false && mkdir d; mv old d; rm -f d/server.pem',
  },
  // A file that has another name is written under both: here the other name is a covered file.
  {
    name: 'a redirection onto another name of a covered file',
    prep: OTHER_NAME,
    command: 'echo x > f',
    runs: CP_KEEPS_NAMES,
  },
  {
    name: 'a redirection that adds to another name of a covered file',
    prep: OTHER_NAME,
    command: 'echo x >> f',
    runs: CP_KEEPS_NAMES,
  },
  {
    name: 'a copy onto another name of a covered file',
    prep: OTHER_NAME,
    command: 'cp src/a.ts f',
    runs: CP_KEEPS_NAMES,
  },
  {
    name: 'a forced copy onto another name of a covered file',
    prep: OTHER_NAME,
    command: 'cp -f src/a.ts f',
    runs: CP_KEEPS_NAMES,
  },
  {
    name: 'a copy into a folder that holds another name of a covered file',
    prep: 'mkdir dir && ln certs/server.pem dir/a.ts',
    command: 'cp src/a.ts dir/',
    runs: CP_KEEPS_NAMES,
  },
  {
    name: 'a folder copied over one that holds another name of a covered file',
    prep: 'mkdir -p dir/src && ln certs/server.pem dir/src/a.ts',
    command: 'cp -r src dir/',
    runs: CP_KEEPS_NAMES,
  },
  {
    name: 'the mode of another name of a covered file changed',
    prep: OTHER_NAME,
    command: 'chmod 600 f',
    runs: CP_KEEPS_NAMES,
  },
  {
    name: 'the time of another name of a covered file changed',
    prep: OTHER_NAME,
    command: 'touch f',
    runs: CP_KEEPS_NAMES,
  },
  {
    name: 'a redirection onto another name of a covered file after a leading cd',
    prep: 'mkdir sub && ln certs/server.pem sub/f',
    command: 'cd sub && echo x > f',
    runs: CP_KEEPS_NAMES,
  },
  {
    name: 'the mode of a folder that holds another name of a covered file changed',
    prep: 'mkdir -p dir/deep && ln certs/server.pem dir/deep/f',
    command: 'chmod -R 700 dir',
    runs: CP_KEEPS_NAMES,
  },
  {
    name: 'the mode of another name of a covered file changed by a wildcard',
    prep: 'mkdir dir && ln certs/server.pem dir/f',
    command: 'chmod 600 dir/*',
    runs: CP_KEEPS_NAMES,
  },
  {
    name: 'the output of git written onto another name of a covered file',
    prep: OTHER_NAME,
    command: 'git diff --output=f v1',
    runs: CP_KEEPS_NAMES,
  },
  // The shell is in a folder the session reached through a link: its `cd ..` and the paths its
  // programs are given part ways there.
  {
    name: 'a leading cd to .. from a folder reached through a link',
    prep: LINK_TO_FOLDER,
    cwd: 'lnk',
    command: 'cd .. && rm -f ../certs/server.pem',
  },
  {
    name: 'a leading cd to ../.. from a folder reached through a link',
    prep: LINK_TO_FOLDER,
    cwd: 'lnk',
    command: 'cd ../.. && rm -f certs/server.pem',
  },
];

describe('lines whose cd, moved folder or number of paths the text does not settle are warned about', () => {
  for (const c of strays) {
    const run = c.notRoot && process.getuid?.() === 0 ? it.skip : it;
    run(c.name, async () => {
      const g = setUp(c.scopes ?? ['certs/**'], c.prep);
      // The variables are set for the command as it really runs and for the hook, then put back.
      const shells: Record<string, string | undefined>[] = [GIT_ENV, process.env];
      const kept = shells.map((env) => ({ ...env }));
      for (const env of shells) Object.assign(env, c.env ?? {});
      try {
        const done =
          (c.runs ?? true)
            ? runInCopy(g.dir, c.command, c.covered ?? inCerts, c.cwd ?? '')
            : { written: [], output: 'not run here' };
        if (c.runs ?? true) {
          expect(
            done.written.length,
            `\`${c.command.slice(0, 200)}\` writes a covered file; ${done.output}`,
          ).toBeGreaterThan(0);
        }
        const r = await g.shell(c.command, join(g.dir, c.cwd ?? ''));
        expect(
          verdictOf(r),
          `hook on \`${c.command.slice(0, 200)}\` (writes ${done.written.join(', ')}): ${r.reason ?? ''}`,
        ).toBe('warn');
      } finally {
        shells.forEach((env, i) => {
          for (const k of Object.keys(c.env ?? {})) {
            const was = kept[i]?.[k];
            if (was === undefined) Reflect.deleteProperty(env, k);
            else env[k] = was;
          }
        });
        g.mindly.close();
      }
    });
  }
});

/** As `setUp`, with a tracked `a.txt` besides. */
const setUpWithFile = (scopes: string[], prep = '') =>
  setUp(
    scopes,
    ['echo a > a.txt && git add a.txt && git commit -qm a.txt', ...(prep ? [prep] : [])].join(
      ' && ',
    ),
  );

/**
 * A branch `other` with a link `envl` to `.env`; a stash and two patches that each bring a link
 * to it too; and a link `dl` on disk. Nothing is at `.env` yet.
 */
const LINKS_TO_A_NEW_FILE = [
  'mkdir sub',
  'git checkout -qb other && ln -s .env envl && git add envl && git commit -qm link',
  'git checkout -q main && git format-patch -q -1 other --stdout > m.patch',
  'ln -s .env sl && git add sl && git stash -q',
  'ln -s .env pl && git add pl && git diff --cached > p.patch && git rm -qf --cached pl && rm pl',
  'ln -s .env dl',
].join(' && ');

/**
 * Lines that write a covered file where nothing the hook is told settles it: a covered file that
 * is not there yet, made through what the line made; a link on disk that leads to a file that is
 * not there; a `..` after a link; a `~` that is not the user's own home; git sent to a folder the
 * line made. Each is warned about or blocked, never let through in silence. One scratch
 * repository serves each group.
 */
const unsettled: {
  title: string;
  scopes: string[];
  prep?: string;
  covered: (rel: string) => boolean;
  /** Variables the agent's shell inherited, and the hook with it. */
  env?: Record<string, string>;
  /** False where the commands cannot run as they do elsewhere: only asked. */
  runs?: boolean;
  cases: { name: string; command: string; cwd?: string }[];
}[] = [
  {
    title: 'a covered file that is not there yet, made through what the line made',
    scopes: ['.env'],
    prep: LINKS_TO_A_NEW_FILE,
    covered: (rel) => rel === '.env',
    cases: [
      {
        name: 'a link made on the line, then a redirection onto it',
        command: 'ln -s .env l && echo x > l',
      },
      { name: 'a link made on the line, then touch', command: 'ln -s .env l && touch l' },
      {
        name: 'a link made after a leading cd',
        command: 'cd sub && ln -s ../.env l && echo x > l',
      },
      { name: 'a link to nothing copied with cp -P', command: 'cp -P dl l && echo x > l' },
      { name: 'a link to nothing moved', command: 'mv dl l && echo x > l' },
      {
        name: 'a link git checked out by name',
        command: 'git checkout other -- envl && echo x > envl',
      },
      { name: 'a link a switch brought', command: 'git checkout -q other && echo x > envl' },
      { name: 'a link a merge brought', command: 'git merge -q other && echo x > envl' },
      { name: 'a link a stash brought back', command: 'git stash pop -q && echo x > sl' },
      { name: 'a link a patch applied brought', command: 'git apply p.patch && echo x > pl' },
      { name: 'a link a mailed patch brought', command: 'git am -q m.patch && echo x > envl' },
      { name: 'a redirection to a variable set on the line', command: 'out=.env; echo x > $out' },
      {
        name: 'a redirection in a loop over the name',
        command: 'for f in .env; do echo x > "$f"; done',
      },
    ],
  },
  {
    title: 'a rule folder that is not there yet, made through a link made on the line',
    scopes: ['secrets/**'],
    covered: (rel) => rel.startsWith('secrets/'),
    cases: [
      { name: 'mkdir and touch', command: 'ln -s . d && mkdir d/secrets && touch d/secrets/k' },
    ],
  },
  {
    title: 'a write through a link on disk that leads to a file that is not there',
    scopes: ['certs/**'],
    prep: 'ln -s certs/new.pem dl',
    covered: inCerts,
    cases: [
      { name: 'touch', command: 'touch dl' },
      { name: 'a redirection', command: 'echo x > dl' },
      { name: 'the output of git', command: 'git diff --output=dl v1' },
    ],
  },
  {
    title: 'a path with .. after a link',
    scopes: ['certs/**'],
    prep: 'mkdir -p certs/prod sub && ln -s certs/prod deep && ln -s ../certs sub/lk',
    covered: inCerts,
    cases: [
      { name: 'rm through a link on disk', command: 'rm -f deep/../server.pem' },
      { name: 'touch through a link on disk', command: 'touch deep/../new.pem' },
      { name: 'a redirection through a link on disk', command: 'echo x > deep/../server.pem' },
      { name: 'a copy into the folder above a link on disk', command: 'cp a.txt deep/..' },
      { name: 'rm through a link in a folder', command: 'rm -f sub/lk/../certs/server.pem' },
      { name: 'rm after a leading cd', command: 'cd sub && rm -f lk/../certs/server.pem' },
      {
        name: 'rm through a link made on the line',
        command: 'ln -s certs/prod l && rm -f l/../server.pem',
      },
      {
        name: 'a copy above a link made on the line',
        command: 'ln -s certs/prod l && cp a.txt l/..',
      },
    ],
  },
  {
    title: 'an operand under ~-, the folder the shell was in before',
    scopes: ['certs/**'],
    prep: 'mkdir sub',
    covered: inCerts,
    env: { OLDPWD: '..' },
    runs: OLDPWD_INHERITED,
    cases: [
      { name: 'rm', command: 'rm -f ~-/certs/server.pem', cwd: 'sub' },
      { name: 'a redirection', command: 'echo x > ~-/certs/new.pem', cwd: 'sub' },
    ],
  },
  {
    title: 'git sent to a working tree that is a link made on the line',
    scopes: ['certs/**'],
    prep: 'mkdir sub',
    covered: inCerts,
    cases: [
      {
        name: 'checkout of a path',
        command: 'ln -s . d && git --work-tree=d checkout v1 -- certs/server.pem',
      },
      { name: 'rm of a path', command: 'ln -s . d && git --work-tree=d rm -q certs/server.pem' },
      {
        name: 'checkout into the covered folder',
        command: 'ln -s certs l && git --work-tree=l checkout v1 -- .',
      },
    ],
  },
  {
    title: 'a folder copied over one that holds a link to another name of a covered file',
    scopes: ['certs/**'],
    prep: 'ln certs/server.pem f && mkdir -p dir2/src && ln -s ../../f dir2/src/a.ts',
    covered: inCerts,
    runs: CP_KEEPS_NAMES,
    cases: [{ name: 'cp -r', command: 'cp -r src dir2/' }],
  },
  {
    title: 'git fills a folder that holds another name of a covered file',
    scopes: ['certs/**'],
    prep: 'mkdir out && ln certs/server.pem out/0001-a.txt.patch',
    covered: inCerts,
    runs: CP_KEEPS_NAMES,
    cases: [{ name: 'format-patch -o', command: 'git format-patch -q -o out -1' }],
  },
  {
    title: 'a folder whose name is a literal ~',
    scopes: ['**/*.pem'],
    prep: "mkdir -p '~' && echo k > '~/k.pem'",
    covered: endsInPem,
    cases: [
      { name: 'the folder removed, named from here', command: "rm -rf './~'" },
      { name: 'the folder removed, quoted', command: "rm -rf '~'" },
      { name: 'a file in it removed', command: 'rm -f ./~/k.pem' },
      { name: 'a file in it removed, the name quoted', command: "rm -f '~'/k.pem" },
      { name: 'files in it removed by a wildcard', command: 'rm -f ./~/*.pem' },
      { name: 'a leading cd into it', command: 'cd ./~ && rm -f k.pem' },
      {
        name: 'a folder made and filled in it',
        command: "mkdir -p './~/d' && touch './~/d/x.pem'",
      },
      { name: 'git sent into it', command: "git -C './~' diff --output=n.pem v1" },
    ],
  },
  {
    title: 'a link under a folder whose name is a literal ~',
    scopes: ['certs/**'],
    prep: "mkdir -p '~' && ln -s ../certs '~/lk'",
    covered: inCerts,
    cases: [
      { name: 'rm through it', command: 'rm -f ./~/lk/server.pem' },
      { name: 'rm through it, the name quoted', command: 'rm -f "~"/lk/server.pem' },
      { name: 'a redirection through it', command: 'echo x > ./~/lk/new.pem' },
    ],
  },
  {
    title: 'a file whose name starts with ~',
    scopes: ['**/*.pem'],
    prep: "echo k > '~old.pem'",
    covered: endsInPem,
    cases: [
      { name: 'removed, named from here', command: 'rm -f ./~old.pem' },
      { name: 'removed, quoted', command: "rm -f '~old.pem'" },
      { name: 'a redirection', command: "echo x > '~new.pem'" },
      { name: 'touch', command: 'touch ./~new.pem' },
      { name: 'a copy', command: "cp a.txt './~new.pem'" },
      { name: 'the output of git', command: 'git diff --output=./~n.pem v1' },
    ],
  },
  {
    title: 'a wildcard that matches a symbolic link to a folder',
    scopes: ['certs/**'],
    prep: 'mkdir sub && ln -s certs lnk && ln -s ../certs sub/lk && ln -s . dot',
    covered: inCerts,
    cases: [
      { name: 'rm through the link', command: 'rm -f l?k/server.pem' },
      { name: 'rm through a link in a folder', command: 'rm -f sub/*/server.pem' },
      { name: 'rm through a link to the folder itself', command: 'rm -f d*/certs/server.pem' },
      { name: 'rm of what the link holds', command: 'rm -rf l?k/' },
      { name: 'a copy through the link', command: 'cp a.txt l?k/server.pem' },
      { name: 'a mode changed through the link', command: 'chmod 600 l?k/server.pem' },
    ],
  },
  {
    title:
      'a link git checks out by a pathspec it matches by its own rules, then a path through it',
    scopes: ['certs/**'],
    prep: 'git checkout -qb other && ln -s certs lnk2 && git add lnk2 && git commit -qm link && git checkout -q main',
    covered: inCerts,
    cases: [
      {
        name: 'letter case folded',
        command: "git checkout other -- ':(icase)LNK2' && rm -f lnk2/server.pem",
      },
      {
        name: 'a glob across folders',
        command: "git checkout other -- ':(glob)**/lnk2' && rm -f lnk2/server.pem",
      },
      {
        name: 'letter case folded for all',
        command: 'git --icase-pathspecs checkout other -- LNK2 && rm -f lnk2/server.pem',
      },
      {
        name: 'globs for all',
        command: "git --glob-pathspecs checkout other -- '**/lnk2' && rm -f lnk2/server.pem",
      },
      { name: 'restore', command: "git restore -s other ':(icase)LNK2' && echo x > lnk2/new.pem" },
    ],
  },
  {
    title: 'git writes a patch file onto a link of its name',
    scopes: ['certs/**'],
    prep: 'mkdir out && ln -s ../certs/server.pem out/0001-a.txt.patch && ln -s certs/server.pem 0001-a.txt.patch',
    covered: inCerts,
    cases: [
      { name: 'in the folder it is given', command: 'git format-patch -q -1 -o out' },
      { name: 'in the folder it runs in', command: 'git format-patch -q -1' },
    ],
  },
];

describe('lines whose paths nothing settles are never let through in silence', () => {
  for (const group of unsettled) {
    describe(group.title, () => {
      let g: ReturnType<typeof setUp>;
      const shells: Record<string, string | undefined>[] = [GIT_ENV, process.env];
      let kept: Record<string, string | undefined>[] = [];
      beforeAll(() => {
        g = setUpWithFile(group.scopes, group.prep);
        kept = shells.map((env) => ({ ...env }));
        for (const env of shells) Object.assign(env, group.env ?? {});
      });
      afterAll(() => {
        shells.forEach((env, i) => {
          for (const k of Object.keys(group.env ?? {})) {
            const was = kept[i]?.[k];
            if (was === undefined) Reflect.deleteProperty(env, k);
            else env[k] = was;
          }
        });
        g.mindly.close();
      });
      for (const c of group.cases) {
        it(`${c.name}: ${c.command}`, async () => {
          if (group.runs ?? true) {
            const done = runInCopy(g.dir, c.command, group.covered, c.cwd ?? '');
            expect(
              done.written.length,
              `\`${c.command}\` writes a covered file; ${done.output}`,
            ).toBeGreaterThan(0);
          }
          const r = await g.shell(c.command, join(g.dir, c.cwd ?? ''));
          expect(verdictOf(r), `hook on \`${c.command}\``).not.toBe('allow');
        });
      }
    });
  }

  /** A user whose home is `/`, so `~name/<absolute path>` is that path; none on some machines. */
  const rootHomed = (() => {
    try {
      const line = readFileSync('/etc/passwd', 'utf8')
        .split('\n')
        .find((l) => l.split(':')[5] === '/');
      return line?.split(':')[0] ?? null;
    } catch {
      return null;
    }
  })();
  (rootHomed === null ? it.skip : it)(
    'a covered file named from the home of a user whose home is /',
    async () => {
      const g = setUp(['certs/**']);
      try {
        const copy = realpathSync(mkdtempSync(join(tmpdir(), 'mindly-other-home-')));
        execFileSync('cp', ['-a', `${g.dir}/.`, copy]);
        const line = (dir: string) => `rm -f ~${rootHomed}${dir}/certs/server.pem`;
        execFileSync('bash', ['-c', line(copy)], { cwd: copy, env: GIT_ENV });
        expect(existsSync(join(copy, 'certs/server.pem')), 'the real run removes it').toBe(false);
        expect(verdictOf(await g.shell(line(g.dir)))).toBe('warn');
      } finally {
        g.mindly.close();
      }
    },
  );
});

describe('a recursive copy beside files with two names that no rule covers', () => {
  /** Two names of one file, as a package manager leaves all over node_modules. */
  const PAIR =
    'mkdir -p node_modules/.store node_modules/pkg evil/certs tpl && echo x > node_modules/.store/i.js && ln node_modules/.store/i.js node_modules/pkg/i.js && echo k9 > evil/certs/server.pem && echo t > tpl/t.txt';
  let g: ReturnType<typeof setUp>;
  beforeAll(() => {
    g = setUp(['certs/**'], PAIR);
  });
  afterAll(() => g.mindly.close());

  it('is blocked when it lands on a covered file: cp -r evil/certs .', async () => {
    const command = 'cp -r evil/certs .';
    expect(runInCopy(g.dir, command, inCerts).written).toEqual(['certs/server.pem']);
    expect(verdictOf(await g.shell('cp -r evil/certs/. certs'))).toBe('deny');
    expect(verdictOf(await g.shell(command))).toBe('deny');
  });

  it('is let through when it lands on nothing covered: cp -r tpl/. .', async () => {
    const command = 'cp -r tpl/. .';
    expect(runInCopy(g.dir, command, inCerts).written).toEqual([]);
    expect(verdictOf(await g.shell(command))).toBe('allow');
  });
});

describe('a leading cd, then a pipe into a filter', () => {
  let g: ReturnType<typeof setUp>;
  beforeAll(() => {
    g = setUp(['certs/**'], 'mkdir sub');
  });
  afterAll(() => g.mindly.close());

  it('runs nothing of the pipe when the cd fails', () => {
    const failing = 'cd nosuch && echo x | tee certs/new.pem';
    expect(runInCopy(g.dir, failing, inCerts).written).toEqual([]);
  });

  for (const command of [
    'cd src && grep -n y a.ts | head',
    'cd sub && git log --oneline | head -5',
    'cd src && cat a.ts | grep -n y | wc -l && git status',
  ]) {
    it(`is let through: ${command}`, async () => {
      expect(runInCopy(g.dir, command, inCerts).written).toEqual([]);
      expect(verdictOf(await g.shell(command))).toBe('allow');
    });
  }

  it('is not read fully with a ; after the pipe', async () => {
    const command = 'cd nosuch && git log --oneline | head -5; rm -f certs/server.pem';
    expect(runInCopy(g.dir, command, inCerts).written).toEqual(['certs/server.pem']);
    expect(verdictOf(await g.shell(command))).toBe('warn');
  });
});

describe('a line not read fully is warned about whatever is there', () => {
  it('names every enforced rule, once, with what it names that is covered', async () => {
    const g = guarded({
      'Certificates are issued by hand': ['certs/**'],
      'Env files are edited by hand': ['.env'],
      'Secrets stay out of the tree': ['secrets/**'],
    });
    try {
      file(g.dir, 'certs/server.pem', 'k\n');
      const r = await g.shell('npm test > certs/out.log');
      expect(r.decision).toBeNull();
      const told = (r.context ?? '').split('\n').filter((l) => l.includes('could not read'));
      expect(told).toHaveLength(1);
      for (const title of [
        'Certificates are issued by hand',
        'Env files are edited by hand',
        'Secrets stay out of the tree',
      ]) {
        expect(told[0]).toContain(title);
      }
      expect(told[0]).toContain('certs/out.log');
      // Nothing a rule covers is there, and nothing is named: still told.
      const bare = await g.shell('npm test');
      expect(bare.context ?? '').toContain('could not read this command fully');
      expect(bare.context ?? '').toContain('Env files are edited by hand');
      // A line read fully that touches nothing covered is not.
      expect((await g.shell('rm -rf dist')).context ?? '').not.toContain('enforced');
    } finally {
      g.mindly.close();
    }
  });
});

/** What is at a path, a link not followed: its kind, and where it points or what it holds. */
const whatIs = (path: string): string => {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return 'nothing';
  }
  if (st.isSymbolicLink()) return `link to ${readlinkSync(path)}`;
  return st.isFile() ? `file ${readFileSync(path, 'utf8')}` : 'folder';
};

/** A scratch copy of a repository. */
const copyOf = (dir: string): string => {
  const copy = realpathSync(mkdtempSync(join(tmpdir(), 'mindly-copy-')));
  execFileSync('cp', ['-a', `${dir}/.`, copy]);
  return copy;
};

describe('a covered name that is a symbolic link', () => {
  let g: ReturnType<typeof setUp>;
  beforeAll(() => {
    g = setUpWithFile(
      ['certs/**'],
      'mkdir other && echo o > other/file && echo b > b.txt && ln -s ../other/file certs/cur.pem && ln -s ../other/nothere certs/dang.pem',
    );
  });
  afterAll(() => g.mindly.close());

  for (const [command, name] of [
    ['rm -f certs/dang.pem', 'certs/dang.pem'],
    ['mv b.txt certs/dang.pem', 'certs/dang.pem'],
    ['ln -sf ../a.txt certs/dang.pem', 'certs/dang.pem'],
    ['rm -f certs/cur.pem', 'certs/cur.pem'],
    ['mv b.txt certs/cur.pem', 'certs/cur.pem'],
    ['ln -sf ../a.txt certs/cur.pem', 'certs/cur.pem'],
  ] as const) {
    it(`is not taken away or given to something else: ${command}`, async () => {
      const copy = copyOf(g.dir);
      const before = whatIs(join(copy, name));
      execFileSync('bash', ['-c', command], { cwd: copy, env: GIT_ENV });
      expect(whatIs(join(copy, name)), `\`${command}\` changes ${name}`).not.toBe(before);
      expect(verdictOf(await g.shell(command)), `hook on \`${command}\``).toBe('deny');
    });
  }

  (CP_REMOVES_DESTINATION ? it : it.skip)(
    'is not replaced by cp --remove-destination',
    async () => {
      const command = 'cp --remove-destination a.txt certs/dang.pem';
      const copy = copyOf(g.dir);
      execFileSync('bash', ['-c', command], { cwd: copy, env: GIT_ENV });
      expect(whatIs(join(copy, 'certs/dang.pem'))).toBe('file a\n');
      expect(verdictOf(await g.shell(command))).toBe('deny');
    },
  );

  it('is not written through when it leads to nothing', async () => {
    // The write would make `other/nothere`, which no rule covers: the name is what is covered.
    expect(verdictOf(await g.shell('echo x > certs/dang.pem'))).toBe('warn');
  });
});

describe('a path an editing tool reports', () => {
  let g: ReturnType<typeof setUp>;
  beforeAll(async () => {
    g = setUp(
      ['config/**'],
      `mkdir -p vendor/pkg config a && echo c > config/app.json && ln -s vendor/pkg deep && ln -s ${realpathSync(tmpdir())} out && ln -s config/new.json pending && ln -s round round`,
    );
    await g.shell('true');
  });
  afterAll(() => g.mindly.close());
  const write = (path: string) =>
    g.mindly.hooks.handle({
      agentKind: 'claude-code',
      event: 'pre_tool',
      externalSessionId: 'edits',
      cwd: g.dir,
      transcriptPath: null,
      startSource: null,
      prompt: null,
      lastMessage: null,
      tool: {
        name: 'Write',
        writes: true,
        shell: false,
        edits: [{ path, addedText: 'x\n', removedText: '', wholeFile: true }],
        command: null,
        failed: false,
        outputExcerpt: null,
      },
    });

  it('is blocked by its plain path', async () => {
    expect((await write(join(g.dir, 'config/app.json'))).decision).toBe('deny');
  });

  for (const tail of ['deep/../config/app.json', 'out/../config/app.json']) {
    it(`is placed as its text folds, with .. after a link: <root>/${tail}`, async () => {
      const copy = copyOf(g.dir);
      // What the tool does: fold the path as text, then write.
      writeFileSync(normalize(`${copy}/${tail}`), 'x\n');
      expect(readFileSync(join(copy, 'config/app.json'), 'utf8'), 'the covered file').toBe('x\n');
      expect((await write(`${g.dir}/${tail}`)).decision, 'the hook').toBe('deny');
    });
  }

  it('is placed as the system takes it too, with .. after a link', async () => {
    // Taken off the folder the link leads to, the path is `vendor/app.json`... and with the
    // link into the covered folder, the covered file.
    execFileSync('bash', ['-c', 'mkdir -p config/sub && ln -s config/sub into'], { cwd: g.dir });
    expect((await write(`${g.dir}/into/../app.json`)).decision).toBe('deny');
  });

  it('is let through with a .. and no link, where nothing is covered', async () => {
    const r = await write(`${g.dir}/a/../b.txt`);
    expect(r.decision).toBeNull();
    expect(r.context ?? '').not.toContain('enforced');
  });

  it('is placed where a link that leads to nothing would make the file', async () => {
    expect((await write(join(g.dir, 'pending'))).decision).toBe('deny');
  });

  it('is refused through a link that cannot be followed', async () => {
    const r = await write(join(g.dir, 'round'));
    expect(r.decision).toBe('deny');
    expect(r.reason).toContain('symbolic link Mindly cannot follow');
  });
});

describe('a comment on a line', () => {
  let g: ReturnType<typeof setUp>;
  beforeAll(() => {
    // Nothing the rule covers is there.
    g = setUp(['secrets/**', 'certs/**']);
  });
  afterAll(() => g.mindly.close());

  for (const command of ['# only a comment', 'git status # what changed', 'ls -la # list']) {
    it(`is not a reason to warn: ${command}`, async () => {
      expect(runInCopy(g.dir, command, () => true).written).toEqual([]);
      const r = await g.shell(command);
      expect(r.decision).toBeNull();
      expect(r.context ?? '').not.toContain('enforced');
    });
  }

  it('hides nothing on the line after it', async () => {
    const command = '# tidy up\nrm -f certs/server.pem';
    expect(runInCopy(g.dir, command, inCerts).written).toEqual(['certs/server.pem']);
    expect(verdictOf(await g.shell(command))).toBe('deny');
  });
});

describe('lines that stay read fully', () => {
  let g: ReturnType<typeof setUp>;
  beforeAll(() => {
    g = setUpWithFile(['certs/**'], 'echo t > y.tmp && ln -s y.tmp x.tmp');
  });
  afterAll(() => g.mindly.close());

  for (const command of [
    // A link the wildcard matches is only removed.
    'rm -f *.tmp',
    // Nothing is written through the path with `..`.
    'cat src/../a.txt',
  ]) {
    it(command, async () => {
      expect(runInCopy(g.dir, command, inCerts).written).toEqual([]);
      const r = await g.shell(command);
      expect(r.decision).toBeNull();
      expect(r.context ?? '').not.toContain('enforced');
    });
  }
});

describe('the warning for a line not read fully is handed to every kind of agent', () => {
  let g: ReturnType<typeof setUp>;
  beforeAll(() => {
    g = setUp(['certs/**']);
  });
  afterAll(() => g.mindly.close());
  const native: Record<string, string> = {
    'claude-code': 'PreToolUse',
    codex: 'PreToolUse',
    cursor: 'beforeShellExecution',
    gemini: 'BeforeTool',
  };

  for (const kind of Object.keys(native)) {
    it(kind, async () => {
      const { getAdapter, HOOK_AGENT_KINDS } = await import('../../adapters/src/index.js');
      expect([...HOOK_AGENT_KINDS].sort()).toEqual(Object.keys(native).sort());
      const result = await g.shell('npm test > certs/out.log');
      expect(result.decision).toBeNull();
      expect(result.context ?? '').toContain('could not read this command fully');
      const adapter = getAdapter(kind);
      if (adapter === null) throw new Error(`no adapter for ${kind}`);
      const rendered = adapter.render(
        {
          agentKind: kind as (typeof HOOK_AGENT_KINDS)[number],
          event: 'pre_tool',
          nativeEvent: native[kind] as string,
          externalSessionId: 'kinds',
          cwd: g.dir,
          transcriptPath: null,
          startSource: null,
          prompt: null,
          lastMessage: null,
          tool: {
            name: 'Bash',
            writes: false,
            shell: true,
            edits: [],
            command: 'npm test > certs/out.log',
            failed: false,
            outputExcerpt: null,
          },
        },
        result,
      );
      expect(rendered.stdout, `what ${kind} is handed`).toContain('could not read this command');
    });
  }
});

describe('a session in a folder reached through a link', () => {
  const certs = (rel: string) => rel.startsWith('certs/');

  it('places the paths of a line from the folder itself', async () => {
    const g = setUp(['certs/**'], LINK_TO_FOLDER);
    try {
      const command = 'rm -f ../../certs/server.pem';
      expect(runInCopy(g.dir, command, certs, 'lnk').written).toEqual(['certs/server.pem']);
      expect(verdictOf(await g.shell(command, join(g.dir, 'lnk')))).toBe('deny');
      // By the link's own name it is the folder beside the link that is meant, as the shell
      // finds it.
      expect(runInCopy(g.dir, 'rm -f ../certs/server.pem', certs, 'lnk').written).toEqual([]);
      expect(verdictOf(await g.shell('rm -f ../certs/server.pem', join(g.dir, 'lnk')))).toBe(
        'allow',
      );
    } finally {
      g.mindly.close();
    }
  });

  it('does not follow a cd to .. in a shell that came to the folder through the link', async () => {
    const g = setUp(['certs/**'], LINK_TO_FOLDER);
    try {
      const command = 'cd .. && rm -f certs/server.pem';
      // The shell goes back to where the link is; the session is given the folder itself.
      const done = runInCopy(g.dir, `cd ../../lnk && ${command}`, certs, 'a/b');
      expect(done.written, done.output).toEqual(['certs/server.pem']);
      expect(verdictOf(await g.shell(command, join(g.dir, 'a/b')))).toBe('warn');
    } finally {
      g.mindly.close();
    }
  });

  it('does not follow a cd to .. from a folder spelled without a link either', async () => {
    const g = setUp(['certs/**'], 'mkdir -p a/b');
    try {
      const command = 'cd .. && rm -f ../certs/server.pem';
      expect(runInCopy(g.dir, command, certs, 'a/b').written).toEqual(['certs/server.pem']);
      expect(verdictOf(await g.shell(command, join(g.dir, 'a/b')))).toBe('warn');
    } finally {
      g.mindly.close();
    }
  });
});

describe('a leading cd to a folder given in full', () => {
  it('is followed inside the project', async () => {
    const g = setUp(['certs/**'], 'mkdir -p sub/dist');
    try {
      const sub = join(g.dir, 'sub');
      expect(verdictOf(await g.shell(`cd ${sub} && rm -rf dist`))).toBe('allow');
      expect(verdictOf(await g.shell(`cd ${sub} && rm -f ../certs/server.pem`))).toBe('deny');
    } finally {
      g.mindly.close();
    }
  });

  it('is followed outside the project, where nothing is covered', async () => {
    const g = setUp(['certs/**']);
    try {
      const outside = realpathSync(mkdtempSync(join(tmpdir(), 'mindly-outside-')));
      const command = `cd ${outside} && rm -rf certs x`;
      expect(runInCopy(g.dir, command, (rel) => rel.startsWith('certs/')).written).toEqual([]);
      expect(verdictOf(await g.shell(command))).toBe('allow');
      // A path that leads back into the project is still found.
      expect(verdictOf(await g.shell(`cd ${outside} && rm -f ${g.dir}/certs/server.pem`))).toBe(
        'deny',
      );
    } finally {
      g.mindly.close();
    }
  });

  it('is not followed through a link', async () => {
    const g = setUp(['certs/**'], LINK_TO_FOLDER);
    try {
      const command = `cd ${g.dir}/lnk && rm -f ../../certs/server.pem`;
      expect(runInCopy(g.dir, command, (rel) => rel.startsWith('certs/')).written).toEqual([]);
      expect(verdictOf(await g.shell(command))).toBe('warn');
    } finally {
      g.mindly.close();
    }
  });
});

describe('git commands read without false warnings or slow reading', () => {
  it('lines of 200,000 characters of any shape are answered in good time', async () => {
    const g = setUp(PEM);
    try {
      await g.shell('true');
      for (const unit of [
        'mkdir x && cd x && ',
        'xargs -i ',
        'echo $(x) ',
        'a[$(b)] ',
        'git checkout -- a ',
        'cd a; ',
        '"$x" ',
      ]) {
        const command = `${unit.repeat(Math.floor(199_000 / unit.length))}git status`;
        const t0 = performance.now();
        await g.shell(command);
        expect(performance.now() - t0, unit).toBeLessThan(1000);
      }
    } finally {
      g.mindly.close();
    }
  });

  it('a line of 200,000 characters of mkdir and cd is answered well inside its time', async () => {
    const g = setUp(PEM);
    try {
      await g.shell('true');
      const unit = 'mkdir x && cd x && ';
      const command = `${unit.repeat(Math.floor(199_000 / unit.length))}git status`;
      let best = Infinity;
      for (let k = 0; k < 3; k++) {
        const t0 = performance.now();
        await g.shell(command);
        best = Math.min(best, performance.now() - t0);
      }
      // 200 ms is the aim; the bound leaves room for a busy runner.
      expect(best).toBeLessThan(500);
    } finally {
      g.mindly.close();
    }
  });

  it('a line of 200,000 characters that only names cd is answered well inside its time', async () => {
    const g = setUp(PEM);
    try {
      await g.shell('true');
      for (const [unit, want] of [
        ['echo cd ', 'allow'],
        ['git log cd ', 'allow'],
        // A program not known here: the line is not read fully.
        ['x cd ', 'warn'],
      ] as const) {
        const command = unit.repeat(Math.floor(199_000 / unit.length));
        let best = Infinity;
        let said: Verdict = 'deny';
        for (let k = 0; k < 3; k++) {
          const t0 = performance.now();
          said = verdictOf(await g.shell(command));
          best = Math.min(best, performance.now() - t0);
        }
        expect(said, unit).toBe(want);
        // 200 ms is the aim; the bound leaves room for a busy runner.
        expect(best, unit).toBeLessThan(500);
      }
    } finally {
      g.mindly.close();
    }
  });

  it('lines that hold what the line made against many names or stars are answered in good time', async () => {
    const g = setUp(['certs/**'], 'echo a > a.txt');
    try {
      await g.shell('true');
      const stars = `${'*a'.repeat(11)}*b`;
      const long = 'a'.repeat(32);
      const globs = Array.from({ length: 480 }, (_, i) => `t*${i}`).join(' ');
      let names = '';
      for (let i = 0; `touch ${globs} && cp `.length + names.length < 198_000; i++)
        names += `s${i} `;
      for (const [command, want] of [
        // A few hundred wildcards made, then one copy of thousands of files.
        [`touch ${globs} && cp ${names}dest/`, 'warn'],
        // A wildcard of many stars removed, then a copy to a long name.
        [`rm -f ${stars} && cp a.txt ${long}`, 'warn'],
        // A folder with a long name made, then a wildcard of many stars.
        [`mkdir ${long} && cp a.txt ${stars}/`, 'warn'],
        // With a covered file removed after it: not read fully for the stars, and told so in time.
        [`rm -f ${stars} && cp a.txt ${long} && rm -f certs/server.pem`, 'warn'],
        // With few enough stars to match, the same line is read fully and blocked.
        [`rm -f *a*b && cp a.txt ${long} && rm -f certs/server.pem`, 'deny'],
      ] as const) {
        expect(command.length).toBeLessThan(200_000);
        let best = Infinity;
        let said: Verdict = 'allow';
        for (let k = 0; k < 2; k++) {
          const t0 = performance.now();
          said = verdictOf(await g.shell(command));
          best = Math.min(best, performance.now() - t0);
        }
        expect(said, command.slice(0, 60)).toBe(want);
        // 200 ms is the aim; the bound leaves room for a busy runner.
        expect(best, command.slice(0, 60)).toBeLessThan(500);
      }
    } finally {
      g.mindly.close();
    }
  });

  it('a copy of many files to a deep new folder is answered in good time, and never in silence', async () => {
    for (const files of [30, 500]) {
      const g = setUp(
        ['certs/**'],
        `mkdir big2 && for i in $(seq 1 ${files}); do echo $i > big2/f$i; done`,
      );
      try {
        await g.shell('true');
        const deep = Array.from({ length: 1900 }, () => 'a').join('/');
        const command = `cp -r big2 ${deep}; rm -f certs/server.pem`;
        expect(command.length).toBeLessThan(4096);
        let best = Infinity;
        let said: Verdict = 'allow';
        for (let k = 0; k < 2; k++) {
          const t0 = performance.now();
          said = verdictOf(await g.shell(command));
          best = Math.min(best, performance.now() - t0);
        }
        expect(said, `${files} files`).toBe('deny');
        // 200 ms is the aim; the bound leaves room for a busy runner.
        expect(best, `${files} files`).toBeLessThan(500);
      } finally {
        g.mindly.close();
      }
    }
  });

  it('env -S strings in a substitution on a line that may set variables are read once', async () => {
    const g = setUp(PEM);
    try {
      const head = 'export X=1; : "$(';
      const tail = ')"; git status';
      const unit = 'env -S x ';
      const command =
        head + unit.repeat(Math.floor((199_000 - head.length - tail.length) / unit.length)) + tail;
      await g.shell('true');
      let best = Infinity;
      for (let k = 0; k < 3; k++) {
        const t0 = performance.now();
        await g.shell(command);
        best = Math.min(best, performance.now() - t0);
      }
      // 200 ms is the aim; the bound leaves room for a busy runner.
      expect(best).toBeLessThan(500);
    } finally {
      g.mindly.close();
    }
  });

  it('clone with harmless aliases of its options is not warned about', async () => {
    const g = setUp(PEM);
    try {
      for (const flags of ['--recurse-submodules', '--recursive', '--ipv4', '-4 --no-recursive']) {
        const r = await g.shell(`git clone ${flags} https://github.com/o/r.git`);
        expect(verdictOf(r), flags).toBe('allow');
      }
    } finally {
      g.mindly.close();
    }
  });

  it('repeated options with values are read in good time', async () => {
    const g = setUp(PEM);
    try {
      for (const [head, unit] of [
        ['git push', ' -o x'],
        ['git log', ' -Lx'],
        ['git clone', ' -c x'],
        ['git', ' -c a=b'],
      ] as const) {
        const command = `${head}${unit.repeat(Math.floor((199_980 - head.length) / unit.length))} origin`;
        const t0 = Date.now();
        await g.shell(command);
        expect(Date.now() - t0, `${head}${unit}`).toBeLessThan(1000);
      }
    } finally {
      g.mindly.close();
    }
  });

  it('arithmetic of 200,000 characters is read in good time', async () => {
    const g = setUp(PEM);
    try {
      for (const command of [
        `(( ${'a['.repeat(99_500)} )); git status`,
        `let '${'a['.repeat(99_500)}'; git status`,
      ]) {
        const t0 = Date.now();
        await g.shell(command);
        expect(Date.now() - t0, command.slice(0, 12)).toBeLessThan(1000);
      }
    } finally {
      g.mindly.close();
    }
  });

  it('a clone or submodule source of 200,000 characters is read in good time', async () => {
    const g = setUp(PEM);
    try {
      for (const sub of ['clone', 'submodule add']) {
        const command = `git ${sub} https://e.invalid${'/'.repeat(199_950)}x`;
        const t0 = Date.now();
        await g.shell(command);
        expect(Date.now() - t0, sub).toBeLessThan(1000);
      }
    } finally {
      g.mindly.close();
    }
  });
});

// git commands that write covered files through an option or a setting rather than a path they
// name: an output file, a program run on the files, a folder filled with a checkout, a push into
// a working tree. Each runs in a scratch copy to show the covered file it writes, then the
// pre-tool hook is asked; it must block or at least warn. The commands after them write no
// covered file and must never be blocked.
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
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

const verdictOf = (r: { decision: string | null; context: string | null }): Verdict =>
  r.decision === 'deny' ? 'deny' : (r.context ?? '').includes(RULE) ? 'warn' : 'allow';

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
const ENV_SPLIT = works("env -S 'true'");
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
    want: ['deny'],
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
    want: ['deny'],
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
  { name: 'tests, then a commit', command: 'npm test >/dev/null 2>&1 && git commit -qm x' },
  { name: 'status in a folder', prep: 'mkdir -p sub', command: 'cd sub && git status' },
  { name: 'a test of the diff', command: 'if git diff --quiet; then echo ok; fi' },
];

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

describe('git commands read without false warnings or slow reading', () => {
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

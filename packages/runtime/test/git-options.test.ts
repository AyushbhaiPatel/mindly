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
    want: ['warn'],
  },
  {
    name: 'git reset --hard into an empty rule folder',
    scopes: ['certs/**'],
    prep: EMPTY_RULE_FOLDER,
    command: 'git reset -q --hard HEAD~1',
    want: ['warn'],
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
  },
  {
    name: 'a leading cd to a folder there, then a path named from it',
    scopes: ['certs/**'],
    prep: 'mkdir sub',
    command: 'cd sub && rm -f ../certs/server.pem',
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
      expect(best).toBeLessThan(200);
    } finally {
      g.mindly.close();
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
      expect(best).toBeLessThan(200);
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

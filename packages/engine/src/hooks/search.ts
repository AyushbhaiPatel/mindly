/*
 * Finding the files that exist inside a directory or wildcard a shell command writes as a whole,
 * and that a rule covers. The cost follows the rule, not the size of the tree:
 *
 * - git is asked first. One call lists the tracked and untracked files that match the rules'
 *   own patterns; a second lists ignored files that match, and reports each ignored directory as
 *   one entry without going into it. Neither walks an ignored directory.
 * - An ignored directory is only gone into when a rule could cover a file inside it, with a
 *   budget of its own, so a large one cannot keep a small one from being searched. Dependency
 *   and repository folders are not gone into unless a rule names them.
 * - Each pattern git is given is limited to the directory being written, so a command on one
 *   folder never makes git scan the rest of the repository.
 * - A nested repository and a submodule are walked like an ignored directory: git lists neither.
 * - Without git (no repository, or git did not answer in time) each written directory is walked,
 *   one folder at a time, within what is left of the time.
 *
 * Names only: nothing is read. Every walk starts inside a working tree of the project and never
 * follows symbolic links, so it cannot leave it. Every loop checks the deadline it was given.
 */
import { existsSync, opendirSync, readFileSync, type Dir } from 'node:fs';
import { join, relative } from 'node:path';
import { globToRegExp, toPosix } from '@mindly/core';
import { isLiteralScope, literalPrefix, patternSegments, patternsMayOverlap } from './scope.js';
import type { FileKinds } from './shell.js';

/**
 * A whole directory or a wildcard pattern a shell command writes (`rm -r dir`, `rm dir/*.ts`),
 * inside a working tree of the project.
 */
export interface WrittenScope {
  /**
   * Glob relative to the tree root: `dir/**` for a directory, the pattern for a wildcard. A
   * top-level wildcard is written `./*.log`, so it means that one level and not any depth.
   */
  pattern: string;
  /** The directory before the first wildcard, which holds everything the pattern can match. */
  base: string;
  /** The pattern's segments below `base`. */
  rest: string[];
  /** Root of the working tree. */
  root: string;
  own: boolean;
  /** Only files with these extensions are written (a formatter); null: every file. */
  only: string[] | null;
  /** The wildcards also match names that start with a dot (a shell's do not). */
  dotfiles: boolean;
  /** Letter case is ignored (`find -iname`). */
  nocase: boolean;
  /**
   * Only files that exist there and are of these kinds are touched, nothing the command creates:
   * `git clean` (untracked files, ignored ones with `-x`), and what a git command that puts
   * back tracked files stands for when git cannot say. Decided by what is there, even against a
   * rule that names its directory.
   */
  existing?: FileKinds;
}

/** Every kind of file: a scope that is not limited to some. */
const ANY_FILE: FileKinds = { tracked: true, untracked: true, ignored: true };

/** What git can list for a search; see `GitPort.listFiles`. */
export type FileLister = (
  root: string,
  query: {
    kind: 'known' | 'ignored' | 'tracked' | 'dirs';
    pathspecs: string[];
    timeoutMs: number;
  },
) => Promise<{ files: string[]; complete: boolean } | null>;

/** Folders that are not searched, and that a rule covers only by naming them. */
const UNLISTED_DIRS = ['node_modules', '.git'];

/**
 * Bounds of the search, as an object so a test can lower them. `entries` is what one walk (one
 * ignored directory, or one folder of a written directory without git) may look at, and
 * `firstPass` what each folder gets before any gets more; `walks` how many such walks one hook
 * call starts; `pathspecs` how many patterns one git call is given.
 */
export const SEARCH_LIMITS = {
  entries: 150_000,
  firstPass: 2000,
  walks: 24,
  pathspecs: 48,
  gitMs: 400,
};

/** The scope pattern as shown to people. */
export function scopeLabel(scope: WrittenScope): string {
  return scope.pattern.replace(/^\.\//, '');
}

/** True for a scope that is one directory with all it holds. */
export const isWholeTree = (scope: WrittenScope): boolean =>
  scope.rest.length === 1 && scope.rest[0] === '**';

/**
 * The globs of `globs` that can cover something inside `scope`, judged from the patterns.
 * Dependency and repository folders are a rule's business only when the rule names them:
 * `rm -rf node_modules` is not about a rule for `*.pem`.
 */
export function globsReaching(scope: WrittenScope, globs: readonly string[]): string[] {
  const inside = UNLISTED_DIRS.filter((d) => scope.pattern.split('/').includes(d));
  const options = { nocase: scope.nocase };
  return globs.filter(
    (g) => patternsMayOverlap(g, scope.pattern, options) && inside.every((d) => g.includes(d)),
  );
}

/**
 * A matcher for one scope: which paths (relative to the tree root) the command's pattern stands
 * for. Built once, segment by segment, so a shell wildcard at the start of a name does not match
 * a dotfile, and repeated `**` cannot make the expression slow.
 */
export function scopeMatcher(scope: WrittenScope): (rel: string) => boolean {
  const base = toPosix(relative(scope.root, scope.base));
  const prefix = base === '' ? '' : `${base}/`;
  const parts: string[] = [];
  for (const segment of collapse(scope.rest)) {
    if (segment === '**') {
      parts.push('(?:.*/)?');
      continue;
    }
    let one: string;
    try {
      one = globToRegExp(segment).source.replace(/^\^/, '').replace(/\$$/, '');
    } catch {
      return () => true;
    }
    // A shell's `*` and `?` do not stand for a leading dot.
    const hidden = !scope.dotfiles && /^[*?]/.test(segment) ? '(?!\\.)' : '';
    parts.push(`${hidden}${one}/`);
  }
  // The last segment is a name, not a folder; a trailing `**` takes everything below.
  let body = parts.join('');
  if (scope.rest[scope.rest.length - 1] === '**') body = body.replace(/\(\?:\.\*\/\)\?$/, '.*');
  else body = body.replace(/\/$/, '');
  let re: RegExp;
  try {
    re = new RegExp(`^${body}$`, scope.nocase ? 'i' : '');
  } catch {
    return () => true;
  }
  const fold = (s: string): string => (scope.nocase ? s.toLowerCase() : s);
  const lead = fold(prefix);
  return (rel) => fold(rel).startsWith(lead) && re.test(rel.slice(prefix.length));
}

/** Pattern segments with runs of `**` made one, which changes nothing but the cost. */
export function collapse(segments: readonly string[]): string[] {
  return segments.filter((s, i) => !(s === '**' && segments[i - 1] === '**'));
}

/**
 * A fast test for "may one of these globs cover this path?": the literal end of the name is
 * compared before any expression is run, which settles almost every file.
 */
function ruleMatcher(globs: readonly string[], nocase: boolean): (rel: string) => boolean {
  const tests = globs.map((g) => {
    const segments = collapse(patternSegments(g));
    const last = segments[segments.length - 1] ?? '';
    // What every covered name ends with: `*.pem` ends with `.pem`, `.env*` says nothing.
    const tail = /[*?{]/.test(last) ? last.slice(last.search(/[^*?{}]*$/)) : last;
    let re: RegExp | null;
    try {
      re = globToRegExp(segments.join('/'), { nocase });
    } catch {
      re = null;
    }
    return { tail: nocase ? tail.toLowerCase() : tail, any: last === '**', re };
  });
  return (rel) => {
    const name = nocase ? rel.toLowerCase() : rel;
    for (const t of tests) {
      if (!t.any && t.tail !== '' && !name.endsWith(t.tail)) continue;
      if (t.re === null || t.re.test(rel)) return true;
    }
    return false;
  };
}

/**
 * A rule glob as git pathspecs (`:(top,glob)…`), or null when it cannot be given to git. When the
 * glob starts with `base` (the directory being written), that part is a name, not a pattern:
 * a folder called `[id]` or `{a,b}` is matched as it is written.
 */
function pathspecs(glob: string, nocase: boolean, base = ''): string[] | null {
  const magic = nocase ? ':(top,glob,icase)' : ':(top,glob)';
  const literal = base !== '' && (glob === base || glob.startsWith(`${base}/`));
  const head = literal ? `${gitLiteral(base)}/` : '';
  const rest = literal ? glob.slice(base.length + 1) || '**' : glob;
  // Alternatives become one pattern each; git has no `{a,b}`.
  let forms = [collapse(literal ? rest.split('/') : patternSegments(rest)).join('/')];
  for (let round = 0; round < 4; round++) {
    const next: string[] = [];
    let expanded = false;
    for (const f of forms) {
      const m = /\{([^{}]*)\}/.exec(f);
      if (!m) {
        next.push(f);
        continue;
      }
      expanded = true;
      for (const alt of (m[1] as string).split(',')) {
        next.push(f.slice(0, m.index) + alt + f.slice(m.index + m[0].length));
      }
    }
    forms = next;
    if (!expanded) break;
    if (forms.length > 16) return null;
  }
  if (forms.some((f) => f.includes('{') || f.length > 1024 || f.includes('\0'))) return null;
  // `[` is literal in a rule glob and a class in git's.
  return forms.map((f) => `${magic}${head}${f.replace(/[[\]\\]/g, '\\$&')}`);
}

interface TreeFacts {
  /** Files git knows (tracked or untracked, not ignored) that match what was asked. */
  files: string[] | null;
  /** Ignored files that match what was asked. */
  ignored: string[] | null;
  /** Ignored directories, each one entry, without what is inside. */
  ignoredDirs: string[];
  /** Nested repositories and submodules: git lists nothing inside them. */
  nestedDirs: string[];
  /** Tracked files that match what was asked, when a scope limited to some kinds asked. */
  tracked: string[] | null;
  trackedSet: Set<string> | null;
}

interface Plan {
  specs: Set<string>;
  bases: Set<string>;
  ok: boolean;
  /** Which listings the scopes need. */
  known: boolean;
  ignored: boolean;
  tracked: boolean;
}

/** What a search found for one scope. */
export interface Covered {
  /** Files that exist in the scope and that one of the globs covers. */
  files: string[];
  /** False when part of the scope could not be searched: an empty answer then proves nothing. */
  complete: boolean;
  /** The parts that could not be searched, for the message. */
  unsearched: string[];
}

/**
 * The searches of one hook call. `prepare` asks git once for everything that will be needed;
 * `covered` then answers from that, walking only what git does not go into.
 */
export class ScopeSearch {
  private readonly facts = new Map<string, TreeFacts | null>();
  private readonly walked = new Map<string, { files: string[]; complete: boolean }>();
  /** What git said, by name, of the covered files a walk found. */
  private readonly checked = new Map<
    string,
    { named: Set<string>; known: Set<string>; tracked: Set<string> }
  >();
  private walksLeft = SEARCH_LIMITS.walks;

  /**
   * @param lister how to ask git (null: there is no git to ask)
   * @param deadline the moment (on `now`'s clock) after which nothing more is searched
   */
  constructor(
    private readonly lister: FileLister | null,
    private readonly deadline: number,
    private readonly now: () => number = () => performance.now(),
  ) {}

  private timeLeft(): number {
    return this.deadline - this.now();
  }

  /**
   * Asks git, once per working tree, for what the given questions need. Each question is a scope
   * and the rule globs that can reach it.
   */
  async prepare(asks: readonly { scope: WrittenScope; globs: readonly string[] }[]): Promise<void> {
    const byRoot = new Map<string, Plan>();
    for (const { scope, globs } of asks) {
      if (globs.length === 0 || this.facts.has(scope.root)) continue;
      let plan = byRoot.get(scope.root);
      if (!plan) {
        plan = {
          specs: new Set(),
          bases: new Set(),
          ok: true,
          known: false,
          ignored: false,
          tracked: false,
        };
        byRoot.set(scope.root, plan);
      }
      const kinds = scope.existing ?? ANY_FILE;
      if (kinds.untracked) plan.known = true;
      if (kinds.ignored) plan.ignored = true;
      if (kinds.tracked !== kinds.untracked) plan.tracked = true;
      const base = toPosix(relative(scope.root, scope.base));
      plan.bases.add(base === '' ? ':(top)' : `:(top,literal)${base}`);
      // Folders only: listing untracked files, git names each repository nested anywhere under
      // the directory as one entry, and nothing else matches.
      if (kinds.untracked)
        plan.specs.add(`:(top,glob)${base === '' ? '' : `${gitLiteral(base)}/`}**/`);
      for (const g of globs) {
        // A rule that names its directory, asked about a pattern inside it: everything the
        // pattern matches is covered, so the pattern is what git is asked for. Otherwise the
        // rule's pattern, limited to the directory being written.
        const inside = isLiteralScope(g) && isWithin(base, g);
        const asked = inside ? scope.pattern : limitTo(base, g);
        const specs = pathspecs(asked, scope.nocase, base);
        if (specs === null) plan.ok = false;
        else for (const s of specs) plan.specs.add(s);
      }
    }
    await Promise.all(
      [...byRoot].map(async ([root, plan]) => {
        this.facts.set(root, await this.ask(root, plan));
      }),
    );
    // A scope limited to some kinds of file whose listings did not come in time is walked, and
    // git is asked about the few covered files found there, by name: which are tracked, and which
    // are not ignored. A walk alone cannot tell.
    const found = new Map<string, Set<string>>();
    for (const { scope, globs } of asks) {
      if (globs.length === 0 || scope.existing === undefined) continue;
      if (this.pool(scope) !== null) continue;
      const walked = this.walkScope(scope, globs, scopeMatcher(scope), ruleMatcher(globs, false));
      let named = found.get(scope.root);
      if (!named) found.set(scope.root, (named = new Set()));
      for (const f of walked.files) named.add(f);
    }
    await Promise.all(
      [...found].map(async ([root, named]) => {
        if (named.size === 0 || named.size > SEARCH_LIMITS.pathspecs) return;
        const timeoutMs = Math.floor(Math.min(SEARCH_LIMITS.gitMs, this.timeLeft() / 2));
        if (timeoutMs < 20) return;
        const pathspecs = [...named].map((f) => `:(top,literal)${f}`);
        const [known, tracked] = await Promise.all([
          this.list(root, { kind: 'known', pathspecs, timeoutMs }),
          this.list(root, { kind: 'tracked', pathspecs, timeoutMs }),
        ]);
        if (!known?.complete || !tracked?.complete) return;
        this.checked.set(root, {
          named,
          known: new Set(known.files),
          tracked: new Set(tracked.files),
        });
      }),
    );
  }

  /**
   * The kind of a covered file as far as git said: from the listings that came in time (each
   * holds every covered file of its kind), or from what it said of the file by name. `untracked`
   * stands for not tracked and not ignored; `not-tracked` for one of those two. Null: unknown.
   */
  private kindOf(
    f: string,
    facts: TreeFacts | null,
    checked: { named: Set<string>; known: Set<string>; tracked: Set<string> } | undefined,
  ): 'tracked' | 'untracked' | 'ignored' | 'not-tracked' | null {
    if (checked?.named.has(f)) {
      if (checked.tracked.has(f)) return 'tracked';
      return checked.known.has(f) ? 'untracked' : 'ignored';
    }
    if (facts === null) return null;
    if (facts.trackedSet?.has(f)) return 'tracked';
    if (facts.ignored?.includes(f)) return 'ignored';
    if (facts.files?.includes(f)) return facts.trackedSet === null ? null : 'untracked';
    if (facts.trackedSet === null) return null;
    // Not tracked: untracked or ignored, which the listing that did not come would have said.
    if (facts.files !== null) return 'ignored';
    if (facts.ignored !== null) return 'untracked';
    return 'not-tracked';
  }

  /** The files of the kinds a scope touches, from git's listings; null when they are not in. */
  private pool(scope: WrittenScope): string[] | null {
    const facts = this.facts.get(scope.root) ?? null;
    if (facts === null) return null;
    const kinds = scope.existing ?? ANY_FILE;
    const { files, tracked, trackedSet } = facts;
    let pool: string[] | null;
    if (kinds.tracked && kinds.untracked) pool = files;
    else if (kinds.tracked) pool = tracked;
    else if (kinds.untracked)
      pool = files === null || trackedSet === null ? null : files.filter((f) => !trackedSet.has(f));
    else pool = [];
    if (pool !== null && kinds.ignored)
      pool = facts.ignored === null ? null : [...pool, ...facts.ignored];
    return pool;
  }

  /** One listing from git, given up on (as cut short) when git does not answer in time. */
  private async list(
    root: string,
    query: Parameters<FileLister>[1],
  ): Promise<{ files: string[]; complete: boolean } | null> {
    const lister = this.lister;
    if (lister === null) return null;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<{ files: string[]; complete: boolean }>((resolve) => {
      timer = setTimeout(() => resolve({ files: [], complete: false }), query.timeoutMs + 50);
    });
    try {
      return await Promise.race([lister(root, query).catch(() => null), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async ask(root: string, plan: Plan): Promise<TreeFacts | null> {
    if (this.lister === null || !plan.ok || plan.specs.size > SEARCH_LIMITS.pathspecs) return null;
    const timeoutMs = Math.floor(Math.min(SEARCH_LIMITS.gitMs, this.timeLeft() / 2));
    if (timeoutMs < 20) return null;
    const specs = [...plan.specs];
    const bases = [...plan.bases];
    const none = Promise.resolve(null);
    const [known, ignored, tracked, dirs] = await Promise.all([
      plan.known ? this.list(root, { kind: 'known', pathspecs: specs, timeoutMs }) : none,
      plan.ignored ? this.list(root, { kind: 'ignored', pathspecs: specs, timeoutMs }) : none,
      plan.tracked ? this.list(root, { kind: 'tracked', pathspecs: specs, timeoutMs }) : none,
      plan.known ? this.list(root, { kind: 'dirs', pathspecs: bases, timeoutMs }) : none,
    ]);
    // A listing that is needed and did not come (no git here, no answer in time) is left out:
    // what needs it is walked instead.
    const got = (
      list: { files: string[]; complete: boolean } | null,
    ): { files: string[]; complete: boolean } | null => (list?.complete ? list : null);
    const k = got(known);
    const i = got(ignored);
    const t = got(tracked);
    const d = got(dirs);
    if (k === null && i === null && t === null) return null;
    // An untracked directory with a `.git` of its own is a nested repository, and so is each
    // folder git lists as one entry among untracked files, however deep; registered submodules
    // are named in `.gitmodules`.
    const nested = (d?.files ?? [])
      .filter((x) => x.endsWith('/') && existsSync(join(root, x, '.git')))
      .map((x) => x.slice(0, -1));
    for (const f of k?.files ?? []) if (f.endsWith('/')) nested.push(f.slice(0, -1));
    nested.push(...submodules(root));
    return {
      files: k === null || d === null ? null : k.files.filter((f) => !f.endsWith('/')),
      ignored: i === null ? null : i.files.filter((f) => !f.endsWith('/')),
      ignoredDirs: (i?.files ?? []).filter((f) => f.endsWith('/')).map((f) => f.slice(0, -1)),
      nestedDirs: [...new Set(nested)],
      tracked: t?.files ?? null,
      trackedSet: t === null ? null : new Set(t.files),
    };
  }

  /**
   * Files that exist in `scope` and that one of `globs` covers, as paths relative to the tree
   * root. Call `prepare` with the same question first; without it the scope is walked.
   */
  covered(scope: WrittenScope, globs: readonly string[]): Covered {
    const inScope = scopeMatcher(scope);
    // The rule keeps its own letter case, whatever the command's pattern ignores.
    const byRule = ruleMatcher(globs, false);
    const kinds = scope.existing ?? ANY_FILE;
    const facts = this.facts.get(scope.root) ?? null;
    // The files of the kinds the command touches, from git's listings.
    const pool = this.pool(scope);
    if (facts === null || pool === null) {
      // Without git's listings the scope is walked. Where there is no git, every covered file
      // found counts. Where git did not answer in time, what it said of the files found, by
      // name, tells their kind; one it said nothing of could be of a kind the command leaves
      // alone (an ignored `.env` for `git clean`), so it is not searched to the end.
      const walked = this.walkScope(scope, globs, inScope, byRule);
      if (scope.existing === undefined || this.lister === null) return walked;
      if (kinds.tracked && kinds.untracked && kinds.ignored) return walked;
      const checked = this.checked.get(scope.root);
      const files: string[] = [];
      let unknown = false;
      for (const f of walked.files) {
        const kind = this.kindOf(f, facts, checked);
        // Not tracked is enough to know when both other kinds are touched.
        const touched =
          kind === null
            ? null
            : kind === 'tracked'
              ? kinds.tracked
              : kind === 'untracked'
                ? kinds.untracked
                : kind === 'ignored'
                  ? kinds.ignored
                  : kinds.untracked && kinds.ignored
                    ? true
                    : null;
        if (touched === null) unknown = true;
        else if (touched) files.push(f);
      }
      const unsearched = unknown ? [scopeLabel(scope), ...walked.unsearched] : walked.unsearched;
      return { files, complete: unsearched.length === 0, unsearched };
    }
    const files = pool.filter((f) => inScope(f) && byRule(f));
    const unsearched: string[] = [];
    let complete = true;
    const deps = UNLISTED_DIRS.filter((d) => globs.some((g) => g.includes(d)));
    const reaches = (dir: string): boolean =>
      patternsMayOverlap(scope.pattern, `${dir}/**`, { nocase: scope.nocase }) &&
      globs.some((g) => patternsMayOverlap(g, `${dir}/**`)) &&
      !dir.split('/').some((s) => UNLISTED_DIRS.includes(s) && !deps.includes(s));
    const walkInto = [
      ...(kinds.ignored ? facts.ignoredDirs : []),
      ...(kinds.untracked ? facts.nestedDirs : []),
    ];
    for (const dir of walkInto) {
      // Only a directory the scope reaches into, and a rule could cover a file of.
      if (!reaches(dir)) continue;
      const found = this.walk(scope.root, join(scope.root, dir), deps, byRule, globs.join('\0'));
      for (const f of found.files) if (inScope(f)) files.push(f);
      if (!found.complete) {
        complete = false;
        unsearched.push(dir);
      }
    }
    return { files: [...new Set(files)], complete, unsearched };
  }

  /**
   * Every file that exists in `scope`, whatever covers it: what a wildcard stands for, for a
   * write guard that asked about it.
   */
  async listAll(scope: WrittenScope): Promise<Covered> {
    const inScope = scopeMatcher(scope);
    const base = toPosix(relative(scope.root, scope.base));
    const specs = pathspecs(scope.pattern, scope.nocase, base);
    const timeoutMs = Math.floor(Math.min(SEARCH_LIMITS.gitMs, this.timeLeft() / 2));
    const kinds = scope.existing ?? ANY_FILE;
    if (this.lister !== null && specs !== null && timeoutMs >= 20) {
      const query = { pathspecs: specs, timeoutMs };
      const [known, tracked] = await Promise.all([
        kinds.untracked ? this.list(scope.root, { kind: 'known', ...query }) : null,
        kinds.tracked !== kinds.untracked
          ? this.list(scope.root, { kind: 'tracked', ...query })
          : null,
      ]);
      const kept = tracked?.complete ? new Set(tracked.files) : null;
      // Tracked files only (what `git reset --hard` puts back), or untracked ones only
      // (`git clean`, which leaves tracked files alone), or both.
      const pool = !kinds.untracked
        ? tracked?.complete
          ? tracked.files
          : null
        : known?.complete && (kinds.tracked || kept !== null)
          ? known.files.filter((f) => kinds.tracked || !kept?.has(f))
          : null;
      if (pool !== null) {
        const files = pool.filter((f) => !f.endsWith('/') && inScope(f));
        return { files, complete: true, unsearched: [] };
      }
    }
    return this.walkScope(scope, ['**'], inScope, () => true);
  }

  /** Without git: the written directory itself is walked, from where a rule can first match. */
  private walkScope(
    scope: WrittenScope,
    globs: readonly string[],
    inScope: (rel: string) => boolean,
    byRule: (rel: string) => boolean,
  ): Covered {
    const files = new Set<string>();
    const unsearched: string[] = [];
    const deps = UNLISTED_DIRS.filter((d) => globs.some((g) => g.includes(d)));
    const starts = new Set<string>();
    for (const g of globs) {
      // A rule that names its directory is searched there, not from the top of the whole tree.
      const below = literalPrefix(g).join('/');
      const base = toPosix(relative(scope.root, scope.base));
      const narrower = isWholeTree(scope) && below !== '' && isWithin(below, `${base}/**`);
      starts.add(narrower ? join(scope.root, below) : scope.base);
    }
    for (const start of starts) {
      // A wildcard right below the base only needs that one level.
      const depth = scope.rest.includes('**') ? Infinity : scope.rest.length;
      const found = this.walk(scope.root, start, deps, byRule, globs.join('\0'), depth);
      for (const f of found.files) if (inScope(f)) files.add(f);
      if (!found.complete) unsearched.push(toPosix(relative(scope.root, start)) || '.');
    }
    return { files: [...files], complete: unsearched.length === 0, unsearched };
  }

  /**
   * Files under `dir` a rule covers. One walk has one budget, and is done once per hook call
   * whatever the rules that ask; the directory is read entry by entry, so even a very wide one
   * stops where the budget or the deadline ends.
   */
  private walk(
    root: string,
    dir: string,
    deps: readonly string[],
    byRule: (rel: string) => boolean,
    _key: string,
    maxDepth = Infinity,
  ): { files: string[]; complete: boolean } {
    const all = this.walkAll(root, dir, deps, maxDepth);
    return { files: all.files.filter(byRule), complete: all.complete };
  }

  /**
   * Every file under `dir`, at most `maxDepth` levels down. The folders right below it are each
   * walked on their own: first all of them with a small budget, then those not finished with
   * the full one. A large folder therefore never keeps a small one beside it from being searched.
   * Done once per hook call for a directory, whatever the rules that ask.
   */
  private walkAll(
    root: string,
    dir: string,
    deps: readonly string[],
    maxDepth: number,
  ): { files: string[]; complete: boolean } {
    const cacheKey = `${dir}\0${deps.join('/')}\0${maxDepth}`;
    const known = this.walked.get(cacheKey);
    if (known) return known;
    const result = { files: [] as string[], complete: true };
    this.walked.set(cacheKey, result);
    if (this.walksLeft <= 0 || this.timeLeft() <= 0) {
      result.complete = false;
      return result;
    }
    this.walksLeft--;
    // The directory itself, one level.
    const top = this.walkTree(root, dir, deps, 1, SEARCH_LIMITS.entries);
    append(result.files, top.files);
    if (!top.complete) {
      result.complete = false;
      return result;
    }
    if (maxDepth <= 1) return result;
    // Then each folder below it on its own, small budgets first.
    let pending = top.dirs;
    for (const budget of [SEARCH_LIMITS.firstPass, SEARCH_LIMITS.entries]) {
      const unfinished: string[] = [];
      for (const child of pending) {
        if (this.timeLeft() <= 0) {
          unfinished.push(child);
          continue;
        }
        const sub = this.walkTree(root, child, deps, maxDepth - 1, budget);
        if (sub.complete) append(result.files, sub.files);
        else unfinished.push(child);
      }
      pending = unfinished;
      if (pending.length === 0) break;
    }
    if (pending.length > 0) result.complete = false;
    return result;
  }

  /** Files under `dir` (and, at its top level, the folders to go into), within `budget` entries. */
  private walkTree(
    root: string,
    dir: string,
    deps: readonly string[],
    maxDepth: number,
    budget: number,
  ): { files: string[]; dirs: string[]; complete: boolean } {
    const result = { files: [] as string[], dirs: [] as string[], complete: true };
    let left = budget;
    const queue: { path: string; depth: number }[] = [{ path: dir, depth: 1 }];
    while (queue.length > 0) {
      const { path, depth } = queue.pop() as { path: string; depth: number };
      let handle: Dir;
      try {
        handle = opendirSync(path, { bufferSize: 256 });
      } catch {
        // Not a directory, or gone: nothing there to cover.
        continue;
      }
      try {
        const rel = toPosix(relative(root, path));
        const prefix = rel === '' ? '' : `${rel}/`;
        for (;;) {
          const e = handle.readSync();
          if (e === null) break;
          if (--left < 0 || ((left & 255) === 0 && this.timeLeft() <= 0)) {
            result.complete = false;
            return result;
          }
          if (e.isDirectory()) {
            if (e.name === '.git' || (UNLISTED_DIRS.includes(e.name) && !deps.includes(e.name)))
              continue;
            if (depth < maxDepth) queue.push({ path: join(path, e.name), depth: depth + 1 });
            else if (depth === 1) result.dirs.push(join(path, e.name));
            continue;
          }
          result.files.push(`${prefix}${e.name}`);
        }
      } finally {
        handle.closeSync();
      }
    }
    return result;
  }
}

/**
 * A rule glob limited to what lies under `base` (relative; `''` is the root), so git is only
 * asked about the directory being written. Exact when the glob starts with `**` or names a
 * directory around or inside `base`; otherwise everything under `base`, filtered afterwards.
 */
export function limitTo(base: string, glob: string): string {
  if (base === '') return glob;
  const segments = collapse(patternSegments(glob));
  if (segments[0] === '**') return [base, ...segments].join('/');
  const prefix = literalPrefix(glob).join('/');
  // The rule already lies inside the directory.
  if (prefix === base || prefix.startsWith(`${base}/`)) return glob;
  if (base.startsWith(`${prefix}/`) || prefix === '') {
    const after = segments.slice(prefix === '' ? 0 : prefix.split('/').length);
    if (after[0] === '**') return [base, ...after].join('/');
  }
  return `${base}/**`;
}

/** A name as text for a `:(glob)` pathspec: its wildcards are escaped. */
function gitLiteral(name: string): string {
  return name.replace(/[[\]*?\\]/g, '\\$&');
}

/** Paths of the submodules registered in `.gitmodules` (no git call: the file is read). */
function submodules(root: string): string[] {
  let text: string;
  try {
    text = readFileSync(join(root, '.gitmodules'), 'utf8').slice(0, 256 * 1024);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const m of text.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)) {
    const path = toPosix((m[1] as string).replace(/^"|"$/g, '')).replace(/\/+$/, '');
    if (path !== '' && !path.split('/').includes('..') && out.length < 256) out.push(path);
  }
  return out;
}

/** Adds `more` to `to` one by one: a spread of a long list overflows the call stack. */
function append(to: string[], more: readonly string[]): void {
  for (const x of more) to.push(x);
}

/** Whether the directory `dir` (relative, `''` for the root) lies in what `glob` covers. */
function isWithin(dir: string, glob: string): boolean {
  const g = patternSegments(glob);
  const tree = g[g.length - 1] === '**' ? g.slice(0, -1) : g;
  const d = dir === '' ? [] : dir.split('/');
  return tree.length <= d.length && tree.every((s, i) => s === d[i]);
}

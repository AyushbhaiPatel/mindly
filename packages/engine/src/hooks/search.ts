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
   * Only files that exist are touched (`git clean`): nothing the command creates. Decided by
   * what is there, even against a rule that names its directory. `withIgnored` says whether
   * ignored files are touched too (`git clean -x`).
   */
  existing?: boolean;
  withIgnored?: boolean;
}

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

/** A rule glob as git pathspecs (`:(top,glob)…`), or null when it cannot be given to git. */
function pathspecs(glob: string, nocase: boolean): string[] | null {
  const magic = nocase ? ':(top,glob,icase)' : ':(top,glob)';
  // Alternatives become one pattern each; git has no `{a,b}`.
  let forms = [collapse(patternSegments(glob)).join('/')];
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
  return forms.map((f) => `${magic}${f.replace(/[[\]\\]/g, '\\$&')}`);
}

interface TreeFacts {
  /** Files git knows (tracked or untracked, not ignored) that match what was asked. */
  files: string[];
  /** Ignored files that match what was asked. */
  ignored: string[];
  /** Ignored directories, each one entry, without what is inside. */
  ignoredDirs: string[];
  /** Nested repositories and submodules: git lists nothing inside them. */
  nestedDirs: string[];
  /** Tracked files among `files`, when a scope that only touches untracked files asked. */
  tracked: Set<string> | null;
  complete: boolean;
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
    const byRoot = new Map<
      string,
      { specs: Set<string>; bases: Set<string>; ok: boolean; untracked: boolean }
    >();
    for (const { scope, globs } of asks) {
      if (globs.length === 0 || this.facts.has(scope.root)) continue;
      let plan = byRoot.get(scope.root);
      if (!plan)
        byRoot.set(
          scope.root,
          (plan = { specs: new Set(), bases: new Set(), ok: true, untracked: false }),
        );
      if (scope.existing === true) plan.untracked = true;
      const base = toPosix(relative(scope.root, scope.base));
      plan.bases.add(base === '' ? ':(top)' : `:(top,literal)${base}`);
      for (const g of globs) {
        // A rule that names its directory, asked about a pattern inside it: everything the
        // pattern matches is covered, so the pattern is what git is asked for. Otherwise the
        // rule's pattern, limited to the directory being written.
        const inside = isLiteralScope(g) && isWithin(base, g);
        const asked = inside ? scope.pattern : limitTo(base, g);
        const specs = pathspecs(asked, scope.nocase);
        if (specs === null) plan.ok = false;
        else for (const s of specs) plan.specs.add(s);
      }
    }
    await Promise.all(
      [...byRoot].map(async ([root, plan]) => {
        this.facts.set(root, await this.ask(root, plan));
      }),
    );
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

  private async ask(
    root: string,
    plan: { specs: Set<string>; bases: Set<string>; ok: boolean; untracked: boolean },
  ): Promise<TreeFacts | null> {
    if (this.lister === null || !plan.ok || plan.specs.size > SEARCH_LIMITS.pathspecs) return null;
    const timeoutMs = Math.floor(Math.min(SEARCH_LIMITS.gitMs, this.timeLeft() / 2));
    if (timeoutMs < 20) return null;
    const specs = [...plan.specs];
    const bases = [...plan.bases];
    const [known, ignored, tracked, dirs] = await Promise.all([
      this.list(root, { kind: 'known', pathspecs: specs, timeoutMs }),
      this.list(root, { kind: 'ignored', pathspecs: specs, timeoutMs }),
      plan.untracked
        ? this.list(root, { kind: 'tracked', pathspecs: specs, timeoutMs })
        : Promise.resolve(null),
      this.list(root, { kind: 'dirs', pathspecs: bases, timeoutMs }),
    ]);
    // No git here, or no answer in time: the caller walks instead.
    if (known === null || ignored === null || dirs === null) return null;
    if (!known.complete || !ignored.complete || !dirs.complete) return null;
    // An untracked directory with a `.git` of its own is a nested repository; registered
    // submodules are named in `.gitmodules`.
    const nested = dirs.files
      .filter((d) => d.endsWith('/') && existsSync(join(root, d, '.git')))
      .map((d) => d.slice(0, -1));
    nested.push(...submodules(root));
    return {
      files: known.files.filter((f) => !f.endsWith('/')),
      ignored: ignored.files.filter((f) => !f.endsWith('/')),
      ignoredDirs: ignored.files.filter((f) => f.endsWith('/')).map((f) => f.slice(0, -1)),
      nestedDirs: [...new Set(nested)],
      tracked: tracked?.complete ? new Set(tracked.files) : null,
      complete: true,
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
    const facts = this.facts.get(scope.root) ?? null;
    if (facts === null) return this.walkScope(scope, globs, inScope, byRule);
    // `git clean` leaves tracked files alone, and ignored ones without -x.
    const clean = scope.existing === true;
    const kept = clean ? facts.tracked : null;
    const withIgnored = !clean || scope.withIgnored === true;
    const files = [...facts.files, ...(withIgnored ? facts.ignored : [])].filter(
      (f) => inScope(f) && byRule(f) && !kept?.has(f),
    );
    const unsearched: string[] = [];
    let complete = !(clean && kept === null);
    if (!complete) unsearched.push(scopeLabel(scope));
    const deps = UNLISTED_DIRS.filter((d) => globs.some((g) => g.includes(d)));
    const walkInto = [...(withIgnored ? facts.ignoredDirs : []), ...facts.nestedDirs];
    for (const dir of walkInto) {
      // Only a directory the scope reaches into, and a rule could cover a file of.
      const reach = { nocase: scope.nocase };
      if (!patternsMayOverlap(scope.pattern, `${dir}/**`, reach)) continue;
      if (!globs.some((g) => patternsMayOverlap(g, `${dir}/**`))) continue;
      if (dir.split('/').some((s) => UNLISTED_DIRS.includes(s) && !deps.includes(s))) continue;
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
    const specs = pathspecs(scope.pattern, scope.nocase);
    const timeoutMs = Math.floor(Math.min(SEARCH_LIMITS.gitMs, this.timeLeft() / 2));
    if (this.lister !== null && specs !== null && timeoutMs >= 20) {
      const query = { pathspecs: specs, timeoutMs };
      const [known, tracked] = await Promise.all([
        this.list(scope.root, { kind: 'known', ...query }),
        scope.existing === true
          ? this.list(scope.root, { kind: 'tracked', ...query })
          : Promise.resolve(null),
      ]);
      if (known !== null && known.complete) {
        // `git clean` leaves tracked files alone.
        const kept = tracked?.complete ? new Set(tracked.files) : null;
        const files = known.files.filter((f) => inScope(f) && !kept?.has(f));
        const complete = known.complete && (scope.existing !== true || kept !== null);
        return { files, complete, unsearched: complete ? [] : [scopeLabel(scope)] };
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

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
 * - Without git (no repository, or the listing failed) the written directory itself is walked,
 *   again with a budget of its own.
 *
 * Names only: nothing is read. Every walk starts inside a working tree of the project and never
 * follows symbolic links, so it cannot leave it. Every loop checks the deadline it was given.
 */
import { opendirSync, type Dir } from 'node:fs';
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
   * Files are brought back from the git index: only those that differ from it change. When git
   * can say which those are, nothing else counts.
   */
  restore: boolean;
  /**
   * Only files that exist are touched (`git clean`): nothing the command creates. Decided by
   * what is there, even against a rule that names its directory.
   */
  existing?: boolean;
}

/** What git can list for a search; see `GitPort.listFiles`. */
export type FileLister = (
  root: string,
  query: {
    kind: 'known' | 'ignored' | 'changed' | 'tracked';
    pathspecs: string[];
    timeoutMs: number;
  },
) => Promise<{ files: string[]; complete: boolean } | null>;

/** Folders that are not searched, and that a rule covers only by naming them. */
const UNLISTED_DIRS = ['node_modules', '.git'];

/**
 * Bounds of the search, as an object so a test can lower them. `entries` is what one walk (one
 * ignored directory, or one written directory without git) may look at; `walks` how many such
 * walks one hook call starts; `pathspecs` how many patterns one git call is given.
 */
export const SEARCH_LIMITS = { entries: 150_000, walks: 24, pathspecs: 48, gitMs: 400 };

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
  /** Files git knows (tracked, untracked, ignored) that match what was asked. */
  files: string[];
  /** Ignored directories, each one entry, without what is inside. */
  ignoredDirs: string[];
  /** Tracked files that differ from the index, when that was asked. */
  changed: Set<string> | null;
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
      { specs: Set<string>; restore: Set<string>; ok: boolean; untracked: boolean }
    >();
    for (const { scope, globs } of asks) {
      if (globs.length === 0 || this.facts.has(scope.root)) continue;
      let plan = byRoot.get(scope.root);
      if (!plan)
        byRoot.set(
          scope.root,
          (plan = { specs: new Set(), restore: new Set(), ok: true, untracked: false }),
        );
      if (scope.existing === true) plan.untracked = true;
      const base = toPosix(relative(scope.root, scope.base));
      for (const g of globs) {
        // A rule that names its directory, asked about a pattern inside it: everything the
        // pattern matches is covered, so the pattern is what git is asked for.
        const inside = isLiteralScope(g) && isWithin(base, g);
        const asked = inside ? scope.pattern : g;
        const specs = pathspecs(asked, scope.nocase);
        if (specs === null) plan.ok = false;
        else for (const s of specs) plan.specs.add(s);
      }
      if (scope.restore) plan.restore.add(base === '' ? ':(top)' : `:(top,literal)${base}`);
    }
    await Promise.all(
      [...byRoot].map(async ([root, plan]) => {
        this.facts.set(root, await this.ask(root, plan));
      }),
    );
  }

  private async ask(
    root: string,
    plan: { specs: Set<string>; restore: Set<string>; ok: boolean; untracked: boolean },
  ): Promise<TreeFacts | null> {
    const lister = this.lister;
    if (lister === null || !plan.ok || plan.specs.size > SEARCH_LIMITS.pathspecs) return null;
    const timeoutMs = Math.floor(Math.min(SEARCH_LIMITS.gitMs, this.timeLeft()));
    if (timeoutMs < 20) return null;
    const specs = [...plan.specs];
    const [known, ignored, changed, tracked] = await Promise.all([
      lister(root, { kind: 'known', pathspecs: specs, timeoutMs }),
      lister(root, { kind: 'ignored', pathspecs: specs, timeoutMs }),
      plan.restore.size > 0
        ? lister(root, { kind: 'changed', pathspecs: [...plan.restore], timeoutMs })
        : Promise.resolve(null),
      plan.untracked
        ? lister(root, { kind: 'tracked', pathspecs: specs, timeoutMs })
        : Promise.resolve(null),
    ]);
    // No git here: the caller walks instead.
    if (known === null || ignored === null) return null;
    const dirs = ignored.files.filter((f) => f.endsWith('/')).map((f) => f.slice(0, -1));
    return {
      files: [...known.files, ...ignored.files.filter((f) => !f.endsWith('/'))],
      ignoredDirs: dirs,
      changed: changed?.complete ? new Set(changed.files) : null,
      tracked: tracked?.complete ? new Set(tracked.files) : null,
      complete: known.complete && ignored.complete,
    };
  }

  /**
   * Files that exist in `scope` and that one of `globs` covers, as paths relative to the tree
   * root. Call `prepare` with the same question first; without it the scope is walked.
   */
  covered(scope: WrittenScope, globs: readonly string[]): Covered {
    const inScope = scopeMatcher(scope);
    const byRule = ruleMatcher(globs, scope.nocase);
    const facts = this.facts.get(scope.root) ?? null;
    if (facts === null) return this.walkScope(scope, globs, inScope, byRule);
    // Bringing files back from the index only touches those that differ from it.
    if (scope.restore && facts.changed !== null) {
      const files = [...facts.changed].filter((f) => inScope(f) && byRule(f));
      return { files, complete: true, unsearched: [] };
    }
    // `git clean` leaves tracked files alone.
    const kept = scope.existing === true ? facts.tracked : null;
    const files = facts.files.filter((f) => inScope(f) && byRule(f) && !kept?.has(f));
    const unsearched: string[] = [];
    let complete = facts.complete;
    if (!complete) unsearched.push(scopeLabel(scope));
    const deps = UNLISTED_DIRS.filter((d) => globs.some((g) => g.includes(d)));
    for (const dir of facts.ignoredDirs) {
      // Only an ignored directory the scope reaches into, and a rule could cover a file of.
      const reach = { nocase: scope.nocase };
      if (!patternsMayOverlap(scope.pattern, `${dir}/**`, reach)) continue;
      if (!globs.some((g) => patternsMayOverlap(g, `${dir}/**`, reach))) continue;
      if (dir.split('/').some((s) => UNLISTED_DIRS.includes(s) && !deps.includes(s))) continue;
      const found = this.walk(scope.root, join(scope.root, dir), deps, byRule, globs.join('\0'));
      files.push(...found.files.filter(inScope));
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
    const timeoutMs = Math.floor(Math.min(SEARCH_LIMITS.gitMs, this.timeLeft()));
    if (this.lister !== null && specs !== null && timeoutMs >= 20) {
      const query = { pathspecs: specs, timeoutMs };
      const [known, tracked] = await Promise.all([
        this.lister(scope.root, { kind: 'known', ...query }),
        scope.existing === true
          ? this.lister(scope.root, { kind: 'tracked', ...query })
          : Promise.resolve(null),
      ]);
      if (known !== null) {
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
    let left = SEARCH_LIMITS.entries;
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

/** Whether the directory `dir` (relative, `''` for the root) lies in what `glob` covers. */
function isWithin(dir: string, glob: string): boolean {
  const g = patternSegments(glob);
  const tree = g[g.length - 1] === '**' ? g.slice(0, -1) : g;
  const d = dir === '' ? [] : dir.split('/');
  return tree.length <= d.length && tree.every((s, i) => s === d[i]);
}

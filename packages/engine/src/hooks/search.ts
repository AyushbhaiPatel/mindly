/*
 * Looking for files that exist inside a directory or wildcard a shell command writes as a whole.
 * Names only: nothing is read. The search always starts inside a working tree of the project and
 * never follows symbolic links, so it cannot leave it.
 */
import { readdirSync, type Dirent } from 'node:fs';
import { join, relative } from 'node:path';
import { globToRegExp, matchesGlob, toPosix } from '@mindly/core';
import { literalPrefix, patternsMayOverlap } from './scope.js';

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
}

/** Folders that are not searched, and that a rule covers only by naming them. */
const UNLISTED_DIRS = ['node_modules', '.git'];

/** Directory entries one hook call may look at, over all its searches. */
const MAX_SEARCH_ENTRIES = 200_000;
/** Time one hook call may spend searching, in milliseconds. */
const MAX_SEARCH_MS = 400;

/** The scope pattern as shown to people. */
export function scopeLabel(scope: WrittenScope): string {
  return scope.pattern.replace(/^\.\//, '');
}

/**
 * The globs of `globs` that can cover something inside `scope`, judged from the patterns.
 * Dependency and repository folders are a rule's business only when the rule names them:
 * `rm -rf node_modules` is not about a rule for `*.pem`.
 */
export function globsReaching(scope: WrittenScope, globs: readonly string[]): string[] {
  const inside = UNLISTED_DIRS.filter((d) => scope.pattern.split('/').includes(d));
  return globs.filter(
    (g) => patternsMayOverlap(g, scope.pattern) && inside.every((d) => g.includes(d)),
  );
}

/**
 * Finds existing files for the scopes of one hook call, within one shared budget. Listings are
 * kept, so several rules asking about the same directory cost one walk.
 */
export class ScopeSearch {
  private entriesLeft = MAX_SEARCH_ENTRIES;
  private readonly deadline: number;
  private readonly listings = new Map<string, { files: string[]; complete: boolean }>();

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
    this.deadline = now() + MAX_SEARCH_MS;
  }

  private readonly now: () => number;

  /**
   * Files that exist in `scope` and that one of `globs` covers, as paths relative to the tree
   * root. `complete` is false when the budget ran out first: then an empty answer proves nothing.
   */
  covered(scope: WrittenScope, globs: readonly string[]): { files: string[]; complete: boolean } {
    const files = new Set<string>();
    let complete = true;
    let inScope: RegExp;
    try {
      inScope = globToRegExp(scope.pattern.replace(/^\.\//, ''));
    } catch {
      return { files: [], complete: false };
    }
    for (const glob of globs) {
      const { dir, rest } = this.start(scope, glob);
      const deps = UNLISTED_DIRS.some((d) => glob.includes(d));
      const listing = this.list(scope.root, dir, rest, deps);
      complete &&= listing.complete;
      for (const f of listing.files) {
        if (inScope.test(f) && matchesGlob(f, glob)) files.add(f);
      }
    }
    return { files: [...files], complete };
  }

  /**
   * Where to look for what `glob` covers inside `scope`. A rule that names its directory
   * (`prisma/migrations/**`) is searched there, not from the top of a whole tree being written.
   */
  private start(scope: WrittenScope, glob: string): { dir: string; rest: string[] } {
    if (scope.rest.length === 1 && scope.rest[0] === '**') {
      const below = literalPrefix(glob).join('/');
      const base = toPosix(relative(scope.root, scope.base));
      if (below !== '' && (base === '' || below.startsWith(`${base}/`))) {
        return { dir: join(scope.root, below), rest: ['**'] };
      }
    }
    return { dir: scope.base, rest: scope.rest };
  }

  private list(
    root: string,
    dir: string,
    rest: readonly string[],
    deps: boolean,
  ): { files: string[]; complete: boolean } {
    const key = `${dir}\0${rest.join('/')}\0${deps}`;
    const known = this.listings.get(key);
    if (known) return known;
    const files: string[] = [];
    const complete = this.expand(root, dir, rest, deps, files);
    const listing = { files, complete };
    this.listings.set(key, listing);
    return listing;
  }

  /** Expands the pattern segments below `dir`; false when the budget ran out. */
  private expand(
    root: string,
    dir: string,
    rest: readonly string[],
    deps: boolean,
    out: string[],
  ): boolean {
    const segment = rest[0];
    if (segment === undefined) return true;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // Not a directory, or gone: nothing there to cover.
      return true;
    }
    this.entriesLeft -= entries.length;
    if (this.entriesLeft < 0 || this.now() > this.deadline) return false;
    const everything = segment === '**';
    let name: RegExp | null = null;
    if (!everything && /[*?{]/.test(segment)) {
      try {
        name = globToRegExp(segment);
      } catch {
        return false;
      }
    }
    let complete = true;
    for (const e of entries) {
      const matches = everything || (name ? name.test(e.name) : e.name === segment);
      if (!matches) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '.git' || (!deps && UNLISTED_DIRS.includes(e.name))) continue;
        const below = everything ? rest : rest.slice(1);
        if (below.length > 0 && !this.expand(root, full, below, deps, out)) complete = false;
        continue;
      }
      // A file matches where the pattern ends, or anywhere below a `**`.
      if (everything || rest.length === 1) out.push(toPosix(relative(root, full)));
    }
    return complete;
  }
}

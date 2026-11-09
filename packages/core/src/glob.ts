/**
 * Minimal, dependency-free glob matching for project-relative POSIX paths.
 *
 * Supported syntax: `**` (any number of path segments), `*` (anything except `/`), `?` (one
 * character except `/`) and `{a,b}` alternation (not nested). Everything else is literal; regex
 * metacharacters are escaped, so a glob can never become an arbitrary regular expression.
 *
 * A pattern can also name a folder, the way a `.gitignore` line does: a pattern without wildcards
 * (`infra`, `src/api`) matches that path and everything below it, and a pattern ending in `/`
 * (`deploy/`, `src/api/`) matches only what is below it.
 */

const cache = new Map<string, RegExp>();

export interface GlobOptions {
  /** Case-insensitive matching (used for security deny-lists on case-insensitive file systems). */
  nocase?: boolean;
}
const MAX_GLOB_LENGTH = 512;

function escapeRegex(ch: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(ch) ? `\\${ch}` : ch;
}

export function globToRegExp(glob: string, options: GlobOptions = {}): RegExp {
  if (glob.length > MAX_GLOB_LENGTH) throw new Error('glob too long');
  return compile(glob, options);
}

/** `globToRegExp` without the length limit, for the patterns `expandGlob` derives from a checked one. */
function compile(glob: string, options: GlobOptions): RegExp {
  const key = `${options.nocase ? 'i' : 's'}:${glob}`;
  const cached = cache.get(key);
  if (cached) return cached;

  let re = '';
  let inGroup = false;
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        const atSegmentStart = i === 0 || glob[i - 1] === '/';
        const atSegmentEnd = i + 2 === glob.length || glob[i + 2] === '/';
        if (atSegmentStart && atSegmentEnd) {
          // `**/` matches zero or more directories; trailing `**` matches everything below.
          if (glob[i + 2] === '/') {
            re += '(?:[^/]*/)*';
            i += 2;
          } else {
            re += '.*';
            i += 1;
          }
          continue;
        }
        re += '[^/]*';
        i += 1;
        continue;
      }
      re += '[^/]*';
    } else if (ch === '?') {
      re += '[^/]';
    } else if (ch === '{' && !inGroup) {
      inGroup = true;
      re += '(?:';
    } else if (ch === '}' && inGroup) {
      inGroup = false;
      re += ')';
    } else if (ch === ',' && inGroup) {
      re += '|';
    } else {
      re += escapeRegex(ch);
    }
  }
  if (inGroup) throw new Error('unterminated { in glob');
  const compiled = new RegExp(`^${re}$`, options.nocase ? 'i' : '');
  if (cache.size > 2000) cache.clear();
  cache.set(key, compiled);
  return compiled;
}

const HAS_WILDCARD = /[*?{]/;

/**
 * The plain patterns (matched against the whole path) that `glob` stands for.
 *
 * - A pattern without a slash matches at any depth, like `.gitignore`.
 * - A pattern ending in `/` names a folder and matches only what is below it.
 * - A pattern without wildcards names a file or a folder: it matches the path itself and
 *   everything below it, so `src/api` covers `src/api/billing.ts`.
 */
function expandGlob(glob: string): string[] {
  const folderOnly = glob.endsWith('/');
  const trimmed = glob.replace(/\/+$/, '');
  if (trimmed === '' || trimmed === '.') return [];
  const self = trimmed.includes('/') ? trimmed.replace(/^\.\//, '') : `**/${trimmed}`;
  if (self === '') return [];
  const below = `${self}/**`;
  if (folderOnly) return [below];
  return HAS_WILDCARD.test(trimmed) ? [self] : [self, below];
}

/** True when `path` (project-relative, POSIX separators) matches `glob`. */
export function matchesGlob(path: string, glob: string, options: GlobOptions = {}): boolean {
  if (glob.length > MAX_GLOB_LENGTH) throw new Error('glob too long');
  const normalized = path.replace(/^\.\//, '');
  return expandGlob(glob).some((g) => compile(g, options).test(normalized));
}

export function matchesAnyGlob(
  path: string,
  globs: readonly string[],
  options: GlobOptions = {},
): boolean {
  return globs.some((g) => matchesGlob(path, g, options));
}

const WILDCARD = /[*?[{]/;

/** Segments of a plain pattern, as `expandGlob` returns them. */
function globSegments(plain: string): string[] {
  return plain.split('/').filter((s) => s !== '' && s !== '.');
}

/** A file-name pattern without `**`, groups or classes: its literal head (before the first wildcard) and tail (after the last). */
function headTail(segment: string): { head: string; tail: string } | null {
  if (segment.includes('**') || /[[{]/.test(segment)) return null;
  const first = segment.search(/[*?]/);
  if (first === -1) return { head: segment, tail: segment };
  let last = segment.length - 1;
  while (last >= 0 && !/[*?]/.test(segment[last] as string)) last--;
  return { head: segment.slice(0, first), tail: segment.slice(last + 1) };
}

/**
 * Whether two globs could match the same path, decided from the patterns alone (no file list):
 * false only when they are provably disjoint. Two globs are disjoint when their literal leading
 * segments differ, when their literal trailing segments differ, or when their file-name patterns
 * have literal heads or tails that cannot both fit one name (`*.ts` and `*.css`). Anything
 * involving `**`, groups or classes at the point of comparison counts as a possible overlap.
 * With `nocase`, literal text is compared ignoring letter case.
 *
 * Patterns are read the way `matchesGlob` reads them, so a folder (`src/api`, `src/api/`)
 * overlaps anything below it.
 */
export function globsMayOverlap(a: string, b: string, options: GlobOptions = {}): boolean {
  const fold = (s: string): string => (options.nocase ? s.toLowerCase() : s);
  const as = expandGlob(fold(a));
  const bs = expandGlob(fold(b));
  return as.some((x) => bs.some((y) => plainMayOverlap(globSegments(x), globSegments(y))));
}

function plainMayOverlap(A: string[], B: string[]): boolean {
  const literal = (s: string | undefined): s is string => s !== undefined && !WILDCARD.test(s);
  let i = 0;
  while (literal(A[i]) && literal(B[i])) {
    if (A[i] !== B[i]) return false;
    i++;
  }
  if (i === A.length && i === B.length) return true;
  // A fully literal path cannot also be a folder of the other pattern's literal continuation.
  if (i === A.length) return !literal(B[i]);
  if (i === B.length) return !literal(A[i]);
  let ai = A.length - 1;
  let bi = B.length - 1;
  while (ai > i && bi > i && literal(A[ai]) && literal(B[bi])) {
    if (A[ai] !== B[bi]) return false;
    ai--;
    bi--;
  }
  if (ai !== A.length - 1 || bi !== B.length - 1) return true;
  const x = headTail(A[ai] as string);
  const y = headTail(B[bi] as string);
  if (!x || !y) return true;
  const fits = (p: string, q: string): boolean => p.startsWith(q) || q.startsWith(p);
  const ends = (p: string, q: string): boolean => p.endsWith(q) || q.endsWith(p);
  if (x.head && y.head && !fits(x.head, y.head)) return false;
  if (x.tail && y.tail && !ends(x.tail, y.tail)) return false;
  return true;
}

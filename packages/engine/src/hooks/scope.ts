/*
 * Comparing two path patterns without a file list: the directory or wildcard a shell command
 * writes as a whole, against the scope of a rule or the files a split part owns. Both are globs
 * in the syntax of `@mindly/core` (`**`, `*`, `?`, `{a,b}`). Unlike a shell, that syntax reads a
 * pattern without a slash as "this name at any depth"; a pattern that starts with `./` is
 * anchored at the root, which is how a top-level shell wildcard (`rm *.log`) is written here.
 */
import { globToRegExp, type GlobOptions } from '@mindly/core';

const WILD = /[*?{]/;

/** Segments of a glob as the glob layer reads it: no slash means the name at any depth. */
export function patternSegments(glob: string): string[] {
  const anchored = glob.includes('/') ? glob.replace(/^\.\//, '') : `**/${glob}`;
  return anchored.split('/').filter((s) => s !== '' && s !== '.');
}

/** The directories a glob names literally before its first wildcard segment. */
export function literalPrefix(glob: string): string[] {
  const segments = patternSegments(glob);
  const wild = segments.findIndex((s) => WILD.test(s));
  return wild === -1 ? segments.slice(0, -1) : segments.slice(0, wild);
}

/**
 * True for a glob that names one path or one whole directory: literal segments, optionally ending
 * in `**`. What it covers is known from its text alone.
 */
export function isLiteralScope(glob: string): boolean {
  const segments = patternSegments(glob);
  const body = segments[segments.length - 1] === '**' ? segments.slice(0, -1) : segments;
  return body.length > 0 && body.every((s) => !WILD.test(s));
}

/** Literal text before the first wildcard of a file-name pattern, and after the last. */
function headTail(segment: string): { head: string; tail: string } | null {
  if (segment.includes('{')) return null;
  const first = segment.search(/[*?]/);
  if (first === -1) return { head: segment, tail: segment };
  let last = segment.length - 1;
  while (last >= 0 && !/[*?]/.test(segment[last] as string)) last--;
  return { head: segment.slice(0, first), tail: segment.slice(last + 1) };
}

/** Whether one name could match both single-segment patterns. */
function segmentsMayMatch(a: string, b: string, options: GlobOptions): boolean {
  const fold = (s: string): string => (options.nocase ? s.toLowerCase() : s);
  const aWild = WILD.test(a);
  const bWild = WILD.test(b);
  if (!aWild && !bWild) return fold(a) === fold(b);
  try {
    if (!aWild) return globToRegExp(b, options).test(a);
    if (!bWild) return globToRegExp(a, options).test(b);
  } catch {
    return true;
  }
  const x = headTail(fold(a));
  const y = headTail(fold(b));
  if (!x || !y) return true;
  if (!x.head.startsWith(y.head) && !y.head.startsWith(x.head)) return false;
  return x.tail.endsWith(y.tail) || y.tail.endsWith(x.tail);
}

/**
 * Whether two globs could match the same path, decided from the patterns alone. Segments are
 * compared one to one, so the number of directories matters: `./*.log` (one segment) cannot
 * reach `src/web/**`, and the `dist` folders one level below `packages` cannot reach
 * `packages/db/prisma/**`. `**` on
 * either side stands for any number of segments. False only when they are provably disjoint.
 */
export function patternsMayOverlap(a: string, b: string, options: GlobOptions = {}): boolean {
  const A = patternSegments(a);
  const B = patternSegments(b);
  const seen = new Map<number, boolean>();
  const walk = (i: number, j: number): boolean => {
    if (i === A.length && j === B.length) return true;
    const key = i * (B.length + 1) + j;
    const known = seen.get(key);
    if (known !== undefined) return known;
    // Guards against revisiting while this state is being worked out.
    seen.set(key, false);
    let result: boolean;
    if (i < A.length && A[i] === '**') {
      result = walk(i + 1, j) || (j < B.length && walk(i, j + 1));
    } else if (j < B.length && B[j] === '**') {
      result = walk(i, j + 1) || (i < A.length && walk(i + 1, j));
    } else if (i === A.length || j === B.length) {
      result = false;
    } else {
      result = segmentsMayMatch(A[i] as string, B[j] as string, options) && walk(i + 1, j + 1);
    }
    seen.set(key, result);
    return result;
  };
  return walk(0, 0);
}

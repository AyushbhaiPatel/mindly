/**
 * Minimal, dependency-free glob matching for project-relative POSIX paths.
 *
 * Supported syntax: `**` (any number of path segments), `*` (anything except `/`), `?` (one
 * character except `/`) and `{a,b}` alternation (not nested). Everything else is literal; regex
 * metacharacters are escaped, so a glob can never become an arbitrary regular expression.
 */

const cache = new Map<string, RegExp>();
const MAX_GLOB_LENGTH = 512;

function escapeRegex(ch: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(ch) ? `\\${ch}` : ch;
}

export function globToRegExp(glob: string): RegExp {
  const cached = cache.get(glob);
  if (cached) return cached;
  if (glob.length > MAX_GLOB_LENGTH) throw new Error('glob too long');

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
  const compiled = new RegExp(`^${re}$`);
  if (cache.size > 2000) cache.clear();
  cache.set(glob, compiled);
  return compiled;
}

/** True when `path` (project-relative, POSIX separators) matches `glob`. */
export function matchesGlob(path: string, glob: string): boolean {
  const normalized = path.replace(/^\.\//, '');
  // A pattern without a slash matches the basename anywhere, like .gitignore.
  if (!glob.includes('/')) {
    const base = normalized.slice(normalized.lastIndexOf('/') + 1);
    return globToRegExp(glob).test(base);
  }
  return globToRegExp(glob.replace(/^\.\//, '')).test(normalized);
}

export function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => matchesGlob(path, g));
}

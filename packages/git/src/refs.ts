import { SynapseError } from '@synapse/core';

const MAX_REF_LENGTH = 1024;
// ASCII control characters (incl. DEL), space and the characters `git check-ref-format` forbids.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_REF_CHARS = /[\u0000- \u007F~^:?*[\\]/;

/**
 * Returns a reason string when `name` is not a valid git reference name, or null when it is.
 * Implements the rules of `git check-ref-format` in code, plus a ban on a leading `-` so a ref can
 * never be parsed as an option.
 */
export function refNameProblem(name: string): string | null {
  if (typeof name !== 'string' || name.length === 0) return 'empty';
  if (name.length > MAX_REF_LENGTH) return 'too long';
  if (name.startsWith('-')) return 'starts with "-"';
  if (FORBIDDEN_REF_CHARS.test(name)) return 'contains a forbidden character';
  if (name.includes('..')) return 'contains ".."';
  if (name.includes('@{')) return 'contains "@{"';
  if (name === '@') return 'is "@"';
  if (name.startsWith('/') || name.endsWith('/')) return 'starts or ends with "/"';
  if (name.includes('//')) return 'contains "//"';
  if (name.endsWith('.')) return 'ends with "."';
  for (const component of name.split('/')) {
    if (component.startsWith('.')) return 'has a component starting with "."';
    if (component.endsWith('.lock')) return 'has a component ending with ".lock"';
  }
  return null;
}

/** True when `name` is a syntactically valid reference name (see `refNameProblem`). */
export function isValidRefName(name: string): boolean {
  return refNameProblem(name) === null;
}

/** Throws `invalid_input` unless `name` is a valid reference name. */
export function assertValidRefName(name: string, what = 'ref name'): void {
  const problem = refNameProblem(name);
  if (problem !== null) throw new SynapseError('invalid_input', `invalid ${what}: ${problem}`);
}

/**
 * Throws `invalid_input` unless `name` is a valid short branch name (as in `refs/heads/<name>`).
 * Additionally rejects `HEAD` and names that start with `refs/`.
 */
export function assertValidBranchName(name: string): void {
  assertValidRefName(name, 'branch name');
  if (name === 'HEAD' || name.startsWith('refs/')) {
    throw new SynapseError('invalid_input', 'invalid branch name: reserved');
  }
}

const OBJECT_ID_RE = /^[0-9a-f]{4,64}$/i;

/** True for an abbreviated or full hexadecimal object id. */
export function isObjectId(value: string): boolean {
  return OBJECT_ID_RE.test(value);
}

/**
 * Throws `invalid_input` unless `rev` is an object id, `HEAD`, or a valid ref name. Revision
 * expressions (`~`, `^`, `@{…}`, `:path`) are deliberately not accepted from callers.
 */
export function assertValidRevision(rev: string): void {
  if (typeof rev !== 'string') throw new SynapseError('invalid_input', 'invalid revision');
  if (rev === 'HEAD' || isObjectId(rev)) return;
  assertValidRefName(rev, 'revision');
}

const SNAPSHOT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Throws `invalid_input` unless `id` is a safe snapshot id (letters, digits, `_` and `-`). */
export function assertValidSnapshotId(id: string): void {
  if (typeof id !== 'string' || !SNAPSHOT_ID_RE.test(id)) {
    throw new SynapseError('invalid_input', 'invalid snapshot id');
  }
}

/**
 * Validates a repository-relative path passed to git: relative, POSIX separators, no NUL, no
 * `..` or `.` segments, not inside `.git`. Returns the path unchanged.
 */
export function assertSafeRelativePath(path: string): string {
  if (typeof path !== 'string' || path === '' || path.length > 4096 || path.includes('\0')) {
    throw new SynapseError('invalid_input', 'invalid repository path');
  }
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\\')) {
    throw new SynapseError('invalid_input', 'repository path must be relative');
  }
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new SynapseError('invalid_input', 'repository path must be normalised');
  }
  if (segments.some((s) => s.toLowerCase() === '.git')) {
    throw new SynapseError('invalid_input', 'repository path must not point into .git');
  }
  return path;
}

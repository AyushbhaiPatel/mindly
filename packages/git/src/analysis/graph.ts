import { readFile, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { posix } from 'node:path';
import { MindlyError, isDeniedPath, tryResolveInsideRoot } from '@mindly/core';
import { extractImports, extractReexports } from './imports.js';
import { languageOf } from './language.js';
import type { Language } from './language.js';

/** Files larger than this are not read by the import graph. */
export const MAX_GRAPH_FILE_BYTES = 512 * 1024;
/** Default cap on the number of files analysed. */
export const DEFAULT_GRAPH_MAX_FILES = 20_000;
/** Directory names never analysed. */
export const EXCLUDED_DIRS: readonly string[] = ['node_modules', 'dist', '.git'];

const JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
/** Tried after the source extensions: declaration files and the explicit-module TS extensions. */
const TS_ONLY_EXTENSIONS = ['.d.ts', '.mts', '.cts', '.d.mts', '.d.cts'];
const PY_EXTENSIONS = ['.py'];
/** ESM-style `.js` specifiers that actually point at TypeScript sources. */
const TS_SUBSTITUTES: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx', '.d.ts'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts', '.d.mts'],
  '.cjs': ['.cts', '.d.cts'],
};

/** Options for `buildImportGraph`. */
export interface ImportGraphOptions {
  /** Maximum files analysed (default 20 000); the rest are ignored. */
  maxFiles?: number;
  /** Extra deny globs on top of the core deny-list. */
  extraDeny?: readonly string[];
}

/** Repository-local import graph returned by `buildImportGraph`. */
export interface ImportGraph {
  /** Realpath of the repository root. */
  root: string;
  /** Repository-relative files that were analysed. */
  files: readonly string[];
  /** Resolved repository-relative imports per analysed file. */
  edges: ReadonlyMap<string, readonly string[]>;
  /** Files imported by `file`. */
  dependenciesOf(file: string): string[];
  /**
   * Files that import `file`, sorted. `file` may be absolute or repository-relative.
   *
   * - `transitive`: also the files that import those, and so on.
   * - `throughReexports`: also the files that reach `file` through modules re-exporting it (an
   *   `index.ts` with `export * from './file'`, a Python `__init__.py`), but not through modules
   *   that merely use it.
   */
  dependentsOf(
    file: string,
    options?: { transitive?: boolean; throughReexports?: boolean },
  ): string[];
}

function isExcluded(rel: string, extraDeny: readonly string[]): boolean {
  const segments = rel.split('/');
  if (segments.some((s) => EXCLUDED_DIRS.includes(s) || s === '..')) return true;
  return isDeniedPath(rel, extraDeny);
}

/**
 * Builds a repository-local import graph for TS/JS/Python files. Relative specifiers are resolved
 * to files (trying `.ts .tsx .js .jsx .mjs .cjs .py`, `index.*` and `__init__.py`); Python dotted
 * imports are also tried from the repository root. Bare package imports are ignored.
 *
 * Bounded: skips files over 512 KiB, `node_modules`, `dist`, `.git`, denied paths and anything
 * resolving outside the root (every path goes through `resolveInsideRoot` before it is read).
 */
export async function buildImportGraph(
  repoRoot: string,
  files: readonly string[],
  options: ImportGraphOptions = {},
): Promise<ImportGraph> {
  let root: string;
  try {
    root = realpathSync(repoRoot);
  } catch {
    throw new MindlyError('not_found', 'repository root does not exist');
  }
  const extraDeny = options.extraDeny ?? [];
  const maxFiles = Math.max(0, Math.floor(options.maxFiles ?? DEFAULT_GRAPH_MAX_FILES));
  const existsCache = new Map<string, Promise<boolean>>();

  const toRel = (file: string): string | null => {
    const resolved = tryResolveInsideRoot(root, file);
    if (!resolved || resolved.rel === '') return null;
    return resolved.rel;
  };

  const isFile = (rel: string): Promise<boolean> => {
    let cached = existsCache.get(rel);
    if (!cached) {
      cached = (async () => {
        if (isExcluded(rel, extraDeny)) return false;
        const resolved = tryResolveInsideRoot(root, rel);
        if (!resolved) return false;
        try {
          return (await stat(resolved.abs)).isFile();
        } catch {
          return false;
        }
      })();
      existsCache.set(rel, cached);
    }
    return cached;
  };

  const firstExisting = async (candidates: readonly string[]): Promise<string | null> => {
    for (const c of candidates) {
      if (c === '' || c.startsWith('../') || c === '..') continue;
      if (await isFile(c)) return c;
    }
    return null;
  };

  const resolveJs = (fromRel: string, spec: string): Promise<string | null> => {
    if (!spec.startsWith('./') && !spec.startsWith('../') && spec !== '.' && spec !== '..') {
      return Promise.resolve(null);
    }
    const base = posix.normalize(posix.join(posix.dirname(fromRel), spec));
    const candidates: string[] = [base];
    const ext = posix.extname(base);
    for (const sub of TS_SUBSTITUTES[ext] ?? []) candidates.push(base.slice(0, -ext.length) + sub);
    for (const e of JS_EXTENSIONS) candidates.push(base + e);
    for (const e of TS_ONLY_EXTENSIONS) candidates.push(base + e);
    for (const e of JS_EXTENSIONS) candidates.push(posix.join(base, `index${e}`));
    candidates.push(posix.join(base, 'index.d.ts'));
    return firstExisting(candidates);
  };

  const resolvePy = (fromRel: string, spec: string): Promise<string | null> => {
    const dots = /^\.*/.exec(spec)?.[0].length ?? 0;
    const modPath = spec.slice(dots).split('.').filter(Boolean).join('/');
    let baseDir: string;
    if (dots === 0) baseDir = '';
    else {
      baseDir = posix.dirname(fromRel);
      for (let k = 1; k < dots; k++) baseDir = posix.dirname(baseDir);
      if (baseDir === '.') baseDir = '';
    }
    const base = modPath === '' ? baseDir : baseDir === '' ? modPath : `${baseDir}/${modPath}`;
    const candidates: string[] = [];
    if (base !== '') for (const e of PY_EXTENSIONS) candidates.push(base + e);
    candidates.push(base === '' ? '__init__.py' : `${base}/__init__.py`);
    return firstExisting(candidates);
  };

  const analysed: string[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (analysed.length >= maxFiles) break;
    if (typeof f !== 'string' || f.includes('\0')) continue;
    const rel = toRel(f);
    if (!rel || seen.has(rel) || isExcluded(rel, extraDeny) || !languageOf(rel)) continue;
    seen.add(rel);
    analysed.push(rel);
  }

  const edges = new Map<string, string[]>();
  /** Per file, the dependencies whose exports it passes on. */
  const reexported = new Map<string, Set<string>>();
  for (const rel of analysed) {
    const lang = languageOf(rel) as Language;
    const resolved = tryResolveInsideRoot(root, rel);
    if (!resolved) continue;
    let source: string;
    try {
      const st = await stat(resolved.abs);
      if (!st.isFile() || st.size > MAX_GRAPH_FILE_BYTES) continue;
      source = await readFile(resolved.abs, 'utf8');
    } catch {
      continue;
    }
    const deps = new Set<string>();
    const resolveSpec = (spec: string): Promise<string | null> =>
      lang === 'python' ? resolvePy(rel, spec) : resolveJs(rel, spec);
    for (const spec of extractImports(source, lang)) {
      const target = await resolveSpec(spec);
      if (target && target !== rel) deps.add(target);
    }
    edges.set(rel, [...deps].sort());
    if (lang === 'python' && posix.basename(rel) !== '__init__.py') continue;
    const passedOn = new Set<string>();
    for (const spec of extractReexports(source, lang)) {
      const target = await resolveSpec(spec);
      if (target && target !== rel) passedOn.add(target);
    }
    if (passedOn.size > 0) reexported.set(rel, passedOn);
  }

  const reverse = new Map<string, Set<string>>();
  for (const [from, deps] of edges) {
    for (const to of deps) {
      let set = reverse.get(to);
      if (!set) reverse.set(to, (set = new Set()));
      set.add(from);
    }
  }

  return {
    root,
    files: analysed,
    edges,
    dependenciesOf(file: string): string[] {
      const rel = toRel(file);
      return rel ? [...(edges.get(rel) ?? [])] : [];
    },
    dependentsOf(
      file: string,
      opts: { transitive?: boolean; throughReexports?: boolean } = {},
    ): string[] {
      const rel = toRel(file);
      if (!rel) return [];
      const result = new Set<string>();
      const queue = [rel];
      while (queue.length > 0) {
        const cur = queue.shift() as string;
        for (const dep of reverse.get(cur) ?? []) {
          if (dep === rel || result.has(dep)) continue;
          result.add(dep);
          const passesOn = opts.throughReexports === true && reexported.get(dep)?.has(cur);
          if (opts.transitive || passesOn) queue.push(dep);
        }
      }
      return [...result].sort();
    },
  };
}

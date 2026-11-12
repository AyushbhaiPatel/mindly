import { MAX_ANALYSIS_BYTES, pythonLogicalLines } from './exports.js';
import type { Language } from './language.js';
import { maskJs, maskPy } from './lexer.js';

const MAX_SPECIFIER_LENGTH = 1024;

/** One module specifier; `reexport` when the file passes the module's exports on. */
interface Found {
  spec: string;
  reexport: boolean;
}

function jsImports(source: string): Found[] {
  const { code, mask } = maskJs(source);
  const found: [number, string, boolean][] = [];
  // A match is valid only if its keyword is real code (identical in mask) and not a member
  // access such as `foo.require(…)`.
  const accept = (index: number, keywordLength: number): boolean =>
    code.slice(index, index + keywordLength) === mask.slice(index, index + keywordLength) &&
    code[index - 1] !== '.' &&
    !/[\w$]/.test(code[index - 1] ?? '');

  // Static import/export … from 'x' (the clause between keyword and `from` must be code).
  const fromRe = /\b(import|export)\b([^;'"`]*?)\bfrom\s*(['"])([^'"\r\n]+)\3/g;
  for (const m of code.matchAll(fromRe)) {
    const kw = m[1] as string;
    if (!accept(m.index, kw.length)) continue;
    const clause = m[2] as string;
    if (mask.slice(m.index + kw.length, m.index + kw.length + clause.length) !== clause) continue;
    found.push([m.index, m[4] as string, kw === 'export']);
  }
  // Side-effect imports: import 'x'
  for (const m of code.matchAll(/\bimport\s*(['"])([^'"\r\n]+)\1/g)) {
    if (accept(m.index, 6)) found.push([m.index, m[2] as string, false]);
  }
  // require('x'), import('x'), import x = require('x')
  for (const m of code.matchAll(/\b(require|import)\s*\(\s*(['"])([^'"\r\n]+)\2\s*\)/g)) {
    const kw = m[1] as string;
    if (accept(m.index, kw.length)) found.push([m.index, m[3] as string, false]);
  }
  return found.sort((a, b) => a[0] - b[0]).map(([, spec, reexport]) => ({ spec, reexport }));
}

function pyImports(source: string): Found[] {
  const { code, mask } = maskPy(source);
  const out: Found[] = [];
  // `from x import y` binds `y` in the importing module, which is how a package's `__init__.py`
  // passes names on; the graph only treats it as a re-export there.
  const push = (spec: string, reexport: boolean): void => {
    out.push({ spec, reexport });
  };
  for (const line of pythonLogicalLines(mask, code)) {
    const text = line.m.replace(/\\\r?\n/g, ' ');
    const from = /^from\s+(\.*)\s*([A-Za-z_][\w.]*)?\s+import\s+([\s\S]+)$/.exec(text);
    if (from) {
      const dots = from[1] ?? '';
      const mod = from[2] ?? '';
      const names = (from[3] ?? '')
        .replace(/[()]/g, ' ')
        .split(',')
        .map((n) => n.trim().split(/\s+/)[0] ?? '')
        .filter((n) => /^[A-Za-z_]\w*$/.test(n));
      if (mod !== '') {
        push(`${dots}${mod}`, true);
        // An imported name may itself be a module of the package (`from pkg import mod`).
        for (const n of names) push(`${dots}${mod}.${n}`, true);
        continue;
      }
      if (dots === '') continue;
      if (names.length === 0) push(dots, true);
      for (const n of names) push(`${dots}${n}`, true);
      continue;
    }
    const imp = /^import\s+([\s\S]+)$/.exec(text);
    if (imp) {
      for (const part of (imp[1] ?? '').split(',')) {
        const mod = part.trim().split(/\s+/)[0] ?? '';
        if (/^[A-Za-z_][\w.]*$/.test(mod)) push(mod, false);
      }
    }
  }
  return out;
}

function findSpecifiers(source: string, lang: Language | null): Found[] {
  if (typeof source !== 'string' || source.length > MAX_ANALYSIS_BYTES) return [];
  let found: Found[];
  if (lang === 'typescript' || lang === 'javascript') found = jsImports(source);
  else if (lang === 'python') found = pyImports(source);
  else return [];
  return found.filter((f) => f.spec.length > 0 && f.spec.length <= MAX_SPECIFIER_LENGTH);
}

/**
 * Module specifiers imported by a source file, in order of first appearance, deduplicated.
 *
 * - TS/JS: `import … from`, side-effect `import 'x'`, `export … from`, `import('x')`, `require('x')`.
 * - Python: `import a.b`, `from .x import y` (`from . import a` yields `.a`). `from pkg import a`
 *   yields `pkg` and `pkg.a`, because `a` may be a module of the package rather than a name in it.
 *
 * Returns `[]` for unsupported languages or inputs over 512 KiB.
 */
export function extractImports(source: string, lang: Language | null): string[] {
  return [...new Set(findSpecifiers(source, lang).map((f) => f.spec))];
}

/**
 * The subset of `extractImports` through which a file passes another module's exports on:
 * `export … from 'x'` in TS/JS, and `from x import y` in Python (which only re-exports from a
 * package's `__init__.py`; the import graph applies that rule).
 */
export function extractReexports(source: string, lang: Language | null): string[] {
  return [
    ...new Set(
      findSpecifiers(source, lang)
        .filter((f) => f.reexport)
        .map((f) => f.spec),
    ),
  ];
}

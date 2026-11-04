import { MAX_ANALYSIS_BYTES, pythonLogicalLines } from './exports.js';
import type { Language } from './language.js';
import { maskJs, maskPy } from './lexer.js';

const MAX_SPECIFIER_LENGTH = 1024;

function jsImports(source: string): string[] {
  const { code, mask } = maskJs(source);
  const found: [number, string][] = [];
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
    found.push([m.index, m[4] as string]);
  }
  // Side-effect imports: import 'x'
  for (const m of code.matchAll(/\bimport\s*(['"])([^'"\r\n]+)\1/g)) {
    if (accept(m.index, 6)) found.push([m.index, m[2] as string]);
  }
  // require('x'), import('x'), import x = require('x')
  for (const m of code.matchAll(/\b(require|import)\s*\(\s*(['"])([^'"\r\n]+)\2\s*\)/g)) {
    const kw = m[1] as string;
    if (accept(m.index, kw.length)) found.push([m.index, m[3] as string]);
  }
  return found.sort((a, b) => a[0] - b[0]).map(([, spec]) => spec);
}

function pyImports(source: string): string[] {
  const { code, mask } = maskPy(source);
  const out: string[] = [];
  for (const line of pythonLogicalLines(mask, code)) {
    const text = line.m.replace(/\\\r?\n/g, ' ');
    const from = /^from\s+(\.*)\s*([A-Za-z_][\w.]*)?\s+import\s+([\s\S]+)$/.exec(text);
    if (from) {
      const dots = from[1] ?? '';
      const mod = from[2] ?? '';
      if (mod !== '') {
        out.push(`${dots}${mod}`);
        continue;
      }
      if (dots === '') continue;
      const names = (from[3] ?? '')
        .replace(/[()]/g, ' ')
        .split(',')
        .map((n) => n.trim().split(/\s+/)[0] ?? '')
        .filter((n) => /^[A-Za-z_]\w*$/.test(n));
      if (names.length === 0) out.push(dots);
      for (const n of names) out.push(`${dots}${n}`);
      continue;
    }
    const imp = /^import\s+([\s\S]+)$/.exec(text);
    if (imp) {
      for (const part of (imp[1] ?? '').split(',')) {
        const mod = part.trim().split(/\s+/)[0] ?? '';
        if (/^[A-Za-z_][\w.]*$/.test(mod)) out.push(mod);
      }
    }
  }
  return out;
}

/**
 * Module specifiers imported by a source file, in order of first appearance, deduplicated.
 *
 * - TS/JS: `import … from`, side-effect `import 'x'`, `export … from`, `import('x')`, `require('x')`.
 * - Python: `import a.b`, `from .x import y` (`from . import a` yields `.a`).
 *
 * Returns `[]` for unsupported languages or inputs over 512 KiB.
 */
export function extractImports(source: string, lang: Language | null): string[] {
  if (typeof source !== 'string' || source.length > MAX_ANALYSIS_BYTES) return [];
  let specs: string[];
  if (lang === 'typescript' || lang === 'javascript') specs = jsImports(source);
  else if (lang === 'python') specs = pyImports(source);
  else return [];
  return [...new Set(specs.filter((s) => s.length > 0 && s.length <= MAX_SPECIFIER_LENGTH))];
}

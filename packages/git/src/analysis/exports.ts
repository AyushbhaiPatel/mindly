import type { Language } from './language.js';
import { maskJs, maskPy } from './lexer.js';
import {
  capSig,
  isIdentChar,
  matchBalanced,
  normalizeSig,
  scanStatementEnd,
  scanType,
  shortHash,
  skipWs,
} from './scan.js';

/** Kind of an exported symbol. */
export type ExportKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'namespace'
  | 'variable'
  | 'reexport'
  | 'unknown';

/** One exported symbol and a coarse signature used to detect surface changes. */
export interface ExportedSymbol {
  /** Exported name (`default` for default exports, `*:<specifier>` for `export *`). */
  name: string;
  kind: ExportKind;
  /**
   * Normalised signature: parameter and return text for functions, a `#hash` of the body for
   * types, interfaces, classes, enums and namespaces, an annotation for variables, or `''` when
   * nothing stable is known.
   */
  signature: string;
}

/** Result of `diffExportSurface`: exports added, removed, and changed (kind or signature). */
export interface ExportSurfaceDiff {
  added: ExportedSymbol[];
  removed: ExportedSymbol[];
  changed: { name: string; before: ExportedSymbol; after: ExportedSymbol }[];
}

/** Maximum source size analysed (larger inputs return no exports). */
export const MAX_ANALYSIS_BYTES = 512 * 1024;

const IDENT = '[A-Za-z_$][\\w$]*';

interface Sym {
  kind: ExportKind;
  signature: string;
}

class SymbolTable {
  readonly map = new Map<string, Sym>();
  add(name: string, sym: Sym): void {
    const prev = this.map.get(name);
    if (prev && prev.kind === 'function' && sym.kind === 'function') {
      // Overloads: keep every signature in declaration order.
      this.map.set(name, { kind: 'function', signature: `${prev.signature} | ${sym.signature}` });
      return;
    }
    if (prev && sym.kind === 'unknown') return;
    this.map.set(name, sym);
  }
}

// ---------------------------------------------------------------------------------------------
// TypeScript / JavaScript
// ---------------------------------------------------------------------------------------------

interface Stmt {
  /** Masked statement text. */
  m: string;
  /** Code statement text (strings intact, comments blanked). */
  c: string;
}

function topLevelStatements(mask: string, code: string): Stmt[] {
  const out: Stmt[] = [];
  let i = 0;
  while (i < mask.length) {
    i = skipWs(mask, i);
    while (i < mask.length && (mask[i] === ';' || mask[i] === '}' || mask[i] === ')')) {
      i = skipWs(mask, i + 1);
    }
    if (i >= mask.length) break;
    const end = Math.max(scanStatementEnd(mask, i), i + 1);
    out.push({ m: mask.slice(i, end), c: code.slice(i, end) });
    i = end;
  }
  return out;
}

/** Signature of a function starting at `p` (generics, parameters, return type). */
function functionSig(st: Stmt, p: number, stopAtArrow = false): { sig: string; end: number } {
  let k = skipWs(st.m, p);
  const start = k;
  if (st.m[k] === '<') k = skipWs(st.m, matchBalanced(st.m, k));
  if (st.m[k] !== '(') return { sig: '', end: k };
  k = matchBalanced(st.m, k);
  const afterParams = skipWs(st.m, k);
  let end = k;
  if (st.m[afterParams] === ':') {
    end = scanType(st.m, afterParams + 1, stopAtArrow ? ',' : '', stopAtArrow);
  }
  return { sig: capSig(normalizeSig(st.c.slice(start, end))), end };
}

/** Signature of a value expression when it is a function/arrow; otherwise ''. */
function valueSig(st: Stmt, p: number): { kind: ExportKind; sig: string } {
  let k = skipWs(st.m, p);
  const rest = st.m.slice(k);
  const asyncM = /^async\b\s*/.exec(rest);
  if (asyncM) k = skipWs(st.m, k + asyncM[0].length);
  const fnM = /^function\b\s*\*?\s*(?:[A-Za-z_$][\w$]*)?/.exec(st.m.slice(k));
  if (fnM) return { kind: 'function', sig: functionSig(st, k + fnM[0].length).sig };
  if (st.m[k] === '(' || st.m[k] === '<') {
    const { sig, end } = functionSig(st, k, true);
    const arrow = skipWs(st.m, end);
    if (st.m.startsWith('=>', arrow)) return { kind: 'function', sig };
    return { kind: 'variable', sig: '' };
  }
  const single = new RegExp(`^(${IDENT})\\s*=>`).exec(st.m.slice(k));
  if (single) return { kind: 'function', sig: `(${single[1] ?? ''})` };
  if (st.m.startsWith('class', k) && !isIdentChar(st.m[k + 5])) {
    return { kind: 'class', sig: classSig(st, k + 5).sig };
  }
  return { kind: 'variable', sig: '' };
}

/** Collapses function/method/static-block bodies to `{}` in class-like bodies, keeping types. */
function skeleton(m: string, c: string): string {
  let out = '';
  let k = 0;
  while (k < m.length) {
    const ch = m[k] as string;
    if (ch === '{') {
      let j = k - 1;
      while (j >= 0 && /\s/.test(m[j] as string)) j -= 1;
      const prev = j >= 0 ? (m[j] as string) : '';
      // Type literals and object initialisers follow one of these; any other `{` opens a body.
      const isTypeOrValue = j >= 0 && ':|&<,(=['.includes(prev);
      if (!isTypeOrValue) {
        out += '{}';
        k = matchBalanced(m, k);
        continue;
      }
    }
    out += c[k] as string;
    k += 1;
  }
  return out;
}

function classSig(st: Stmt, p: number): { sig: string; end: number } {
  const open = st.m.indexOf('{', p);
  if (open === -1) return { sig: shortHash(normalizeSig(st.c.slice(p))), end: st.m.length };
  const close = matchBalanced(st.m, open);
  const header = normalizeSig(st.c.slice(p, open));
  const body = skeleton(st.m.slice(open + 1, close - 1), st.c.slice(open + 1, close - 1));
  const members = body
    .split(/[;\n]/)
    .map((seg) => seg.trim())
    .filter((seg) => seg !== '' && !/^(private\b|protected\b|#)/.test(seg))
    .map((seg) => {
      // Drop property initialisers; keep the declared shape.
      const eq = seg.search(/=(?!>)/);
      const paren = seg.indexOf('(');
      return normalizeSig(eq !== -1 && (paren === -1 || eq < paren) ? seg.slice(0, eq) : seg);
    })
    .filter((seg) => seg !== '');
  return { sig: shortHash(`${header}|${members.join(';')}`), end: close };
}

/** Names bound by a destructuring pattern (masked text). */
function patternNames(pattern: string): string[] {
  const inner = pattern.slice(1, -1);
  const items: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    if (ch === ',' && depth === 0) {
      items.push(cur);
      cur = '';
    } else cur += ch;
  }
  items.push(cur);
  const names: string[] = [];
  for (const raw of items) {
    let item = raw.trim().replace(/^\.\.\./, '');
    if (item === '') continue;
    const colon = pattern.startsWith('{') ? topLevelIndex(item, ':') : -1;
    if (colon !== -1) item = item.slice(colon + 1).trim();
    const eq = topLevelIndex(item, '=');
    if (eq !== -1) item = item.slice(0, eq).trim();
    if (item.startsWith('{') || item.startsWith('[')) names.push(...patternNames(item));
    else if (new RegExp(`^${IDENT}$`).test(item)) names.push(item);
  }
  return names;
}

function topLevelIndex(s: string, ch: string): number {
  let depth = 0;
  for (let k = 0; k < s.length; k++) {
    const c = s[k] as string;
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    else if (c === ch && depth === 0) return k;
  }
  return -1;
}

/** Parses `const a = …, { b, c: d } = …` declarators starting at `p`. */
function declarators(st: Stmt, p: number): { name: string; sym: Sym }[] {
  const out: { name: string; sym: Sym }[] = [];
  let k = skipWs(st.m, p);
  while (k < st.m.length) {
    let names: string[];
    const ch = st.m[k];
    if (ch === '{' || ch === '[') {
      const end = matchBalanced(st.m, k);
      names = patternNames(st.m.slice(k, end));
      k = end;
    } else {
      const id = new RegExp(`^${IDENT}`).exec(st.m.slice(k));
      if (!id) break;
      names = [id[0]];
      k += id[0].length;
    }
    k = skipWs(st.m, k);
    if (st.m[k] === '!') k = skipWs(st.m, k + 1);
    let annotation = '';
    if (st.m[k] === ':') {
      const end = scanType(st.m, k + 1, ',');
      annotation = normalizeSig(st.c.slice(k + 1, end));
      k = skipWs(st.m, end);
    }
    let sym: Sym = { kind: 'variable', signature: annotation ? capSig(`:${annotation}`) : '' };
    if (st.m[k] === '=') {
      const valueStart = k + 1;
      if (!annotation && names.length === 1) {
        const v = valueSig(st, valueStart);
        sym = { kind: v.kind, signature: v.sig };
      }
      // Skip the initializer up to the next top-level comma.
      let depth = 0;
      k = valueStart;
      while (k < st.m.length) {
        const c = st.m[k] as string;
        if ('([{'.includes(c)) depth += 1;
        else if (')]}'.includes(c)) depth -= 1;
        else if (c === ',' && depth === 0) break;
        k += 1;
      }
    }
    for (const name of names) out.push({ name, sym });
    if (st.m[k] !== ',') break;
    k = skipWs(st.m, k + 1);
  }
  return out;
}

function stringAt(st: Stmt, p: number): string | null {
  const k = skipWs(st.m, p);
  const q = st.c[k];
  if (q !== '"' && q !== "'") return null;
  const end = st.c.indexOf(q, k + 1);
  return end === -1 ? null : st.c.slice(k + 1, end);
}

interface ExportListItem {
  local: string;
  exported: string;
}

function exportList(st: Stmt, open: number): { items: ExportListItem[]; end: number } {
  const close = matchBalanced(st.m, open);
  const items: ExportListItem[] = [];
  for (const raw of st.m.slice(open + 1, close - 1).split(',')) {
    const part = raw.trim().replace(/^type\s+/, '');
    if (part === '') continue;
    const m = new RegExp(`^(${IDENT})(?:\\s+as\\s+(${IDENT}))?$`).exec(part);
    if (m && m[1]) items.push({ local: m[1], exported: m[2] ?? m[1] });
  }
  return { items, end: close };
}

function extractJsExports(source: string): ExportedSymbol[] {
  const { mask, code } = maskJs(source);
  const locals = new SymbolTable();
  const exports = new SymbolTable();
  // Exported names that refer to local declarations, resolved after the full scan.
  const deferred: { exported: string; local: string }[] = [];

  for (const st of topLevelStatements(mask, code)) {
    let p = 0;
    const at = (re: RegExp): RegExpExecArray | null => {
      re.lastIndex = p;
      const m = re.exec(st.m);
      if (m) p = re.lastIndex;
      return m;
    };
    let exported = false;
    let isDefault = false;

    // CommonJS
    const cjsNamed = at(
      new RegExp(`(?:module\\s*\\.\\s*)?exports\\s*\\.\\s*(${IDENT})\\s*=(?!=)`, 'y'),
    );
    if (cjsNamed && cjsNamed[1]) {
      const v = valueSig(st, p);
      exports.add(cjsNamed[1], { kind: v.kind, signature: v.sig });
      continue;
    }
    if (at(/module\s*\.\s*exports\s*=(?!=)\s*/y)) {
      if (st.m[p] === '{') {
        const close = matchBalanced(st.m, p);
        for (const raw of splitTopLevel(st.m.slice(p + 1, close - 1))) {
          const item = raw.text.trim();
          const offset = p + 1 + raw.start + (raw.text.length - raw.text.trimStart().length);
          const kv = new RegExp(`^(${IDENT})\\s*:`).exec(item);
          const method = new RegExp(`^(?:async\\s+)?(${IDENT})\\s*\\(`).exec(item);
          const shorthand = new RegExp(`^(${IDENT})$`).exec(item);
          if (kv && kv[1]) {
            const v = valueSig(st, offset + kv[0].length);
            exports.add(kv[1], { kind: v.kind, signature: v.sig });
          } else if (method && method[1]) {
            const sig = functionSig(st, offset + method[0].length - 1).sig;
            exports.add(method[1], { kind: 'function', signature: sig });
          } else if (shorthand && shorthand[1]) {
            deferred.push({ exported: shorthand[1], local: shorthand[1] });
          }
        }
      } else {
        const id = new RegExp(`(${IDENT})\\s*;?\\s*$`, 'y');
        id.lastIndex = p;
        const m = id.exec(st.m);
        if (m && m[1]) deferred.push({ exported: 'default', local: m[1] });
        else {
          const v = valueSig(st, p);
          exports.add('default', { kind: v.kind, signature: v.sig });
        }
      }
      continue;
    }

    if (at(/export\b\s*/y)) {
      exported = true;
      if (at(/default\b\s*/y)) isDefault = true;
    }
    if (exported && !isDefault) {
      const star = at(new RegExp(`\\*\\s*(?:as\\s+(${IDENT})\\s*)?from\\b`, 'y'));
      if (star) {
        const spec = stringAt(st, p) ?? '';
        if (star[1]) exports.add(star[1], { kind: 'reexport', signature: `from:${spec}` });
        else exports.add(`*:${spec}`, { kind: 'reexport', signature: `from:${spec}` });
        continue;
      }
      if (at(/(?:type\s*)?(?=\{)/y) && st.m[p] === '{') {
        const { items, end } = exportList(st, p);
        const from = /^\s*from\b/.exec(st.m.slice(end));
        if (from) {
          const spec = stringAt(st, end + from[0].length) ?? '';
          for (const it of items) {
            exports.add(it.exported, { kind: 'reexport', signature: `from:${spec}#${it.local}` });
          }
        } else {
          for (const it of items) deferred.push({ exported: it.exported, local: it.local });
        }
        continue;
      }
      if (at(/=\s*/y)) {
        const id = new RegExp(`(${IDENT})\\s*;?\\s*$`, 'y');
        id.lastIndex = p;
        const m = id.exec(st.m);
        if (m && m[1]) deferred.push({ exported: 'export=', local: m[1] });
        else exports.add('export=', { kind: 'unknown', signature: '' });
        continue;
      }
      if (at(/as\s+namespace\b/y)) continue;
      const alias = at(new RegExp(`import\\s+(${IDENT})\\s*=`, 'y'));
      if (alias && alias[1]) {
        exports.add(alias[1], {
          kind: 'namespace',
          signature: capSig(normalizeSig(st.c.slice(p))),
        });
        continue;
      }
    }

    at(/declare\s+/y);
    at(/abstract\s+/y);
    const isAsync = at(/async\s+/y) !== null;
    let decls: { name: string; sym: Sym }[] = [];
    let anonymousDefault: Sym | null = null;

    const fn = at(new RegExp(`function\\b\\s*\\*?\\s*(${IDENT})?`, 'y'));
    if (fn) {
      const { sig } = functionSig(st, p);
      if (fn[1]) decls = [{ name: fn[1], sym: { kind: 'function', signature: sig } }];
      else anonymousDefault = { kind: 'function', signature: sig };
    } else if (!isAsync) {
      const cls = at(new RegExp(`class\\b\\s*(${IDENT})?`, 'y'));
      const iface = cls ? null : at(new RegExp(`interface\\s+(${IDENT})`, 'y'));
      const type = cls || iface ? null : at(new RegExp(`type\\s+(${IDENT})\\s*(?=[<=])`, 'y'));
      const en =
        cls || iface || type ? null : at(new RegExp(`(?:const\\s+)?enum\\s+(${IDENT})`, 'y'));
      const ns =
        cls || iface || type || en
          ? null
          : at(new RegExp(`(?:namespace|module)\\s+(${IDENT}(?:\\.${IDENT})*)`, 'y'));
      const vars = cls || iface || type || en || ns ? null : at(/(?:const|let|var|using)\s+/y);
      if (cls) {
        const sym: Sym = { kind: 'class', signature: classSig(st, p).sig };
        if (cls[1] && cls[1] !== 'extends' && cls[1] !== 'implements') {
          decls = [{ name: cls[1], sym }];
        } else anonymousDefault = sym;
      } else if (iface && iface[1]) {
        decls = [
          {
            name: iface[1],
            sym: { kind: 'interface', signature: shortHash(normalizeSig(st.c.slice(p))) },
          },
        ];
      } else if (type && type[1]) {
        decls = [
          {
            name: type[1],
            sym: { kind: 'type', signature: shortHash(normalizeSig(st.c.slice(p))) },
          },
        ];
      } else if (en && en[1]) {
        decls = [
          { name: en[1], sym: { kind: 'enum', signature: shortHash(normalizeSig(st.c.slice(p))) } },
        ];
      } else if (ns && ns[1]) {
        const body = st.m.indexOf('{', p);
        const sig =
          body === -1 ? '' : shortHash(normalizeSig(skeleton(st.m.slice(body), st.c.slice(body))));
        decls = [{ name: ns[1], sym: { kind: 'namespace', signature: sig } }];
      } else if (vars) {
        decls = declarators(st, p);
      }
    }

    for (const d of decls) locals.add(d.name, d.sym);
    if (!exported) continue;
    if (isDefault) {
      if (decls.length === 1 && decls[0]) exports.add('default', decls[0].sym);
      else if (anonymousDefault) exports.add('default', anonymousDefault);
      else {
        const id = new RegExp(`(${IDENT})\\s*;?\\s*$`, 'y');
        id.lastIndex = p;
        const m = id.exec(st.m);
        if (m && m[1]) deferred.push({ exported: 'default', local: m[1] });
        else {
          const v = valueSig(st, p);
          exports.add('default', { kind: v.kind, signature: v.sig });
        }
      }
    } else {
      for (const d of decls) exports.add(d.name, d.sym);
    }
  }

  for (const d of deferred) {
    exports.add(d.exported, locals.map.get(d.local) ?? { kind: 'unknown', signature: '' });
  }
  return toList(exports);
}

function splitTopLevel(s: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  let depth = 0;
  let start = 0;
  for (let k = 0; k < s.length; k++) {
    const c = s[k] as string;
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    else if (c === ',' && depth === 0) {
      out.push({ text: s.slice(start, k), start });
      start = k + 1;
    }
  }
  out.push({ text: s.slice(start), start });
  return out;
}

function toList(table: SymbolTable): ExportedSymbol[] {
  return [...table.map.entries()]
    .map(([name, sym]) => ({ name, kind: sym.kind, signature: sym.signature }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------------------------

/** A Python logical line (internal to the analysers). */
export interface PyLine {
  /** Indentation (columns) of the logical line. */
  indent: number;
  /** Masked text of the logical line (continuations joined). */
  m: string;
  /** Code text of the logical line. */
  c: string;
}

/** Splits Python source into logical lines (bracket and backslash continuations joined). */
export function pythonLogicalLines(mask: string, code: string): PyLine[] {
  const lines: PyLine[] = [];
  let depth = 0;
  let start = 0;
  const flush = (end: number): void => {
    const m = mask.slice(start, end);
    const c = code.slice(start, end);
    const first = m.search(/\S/);
    if (first !== -1) {
      const indentText = m.slice(0, first).replace(/^[\s]*\n/, '');
      lines.push({ indent: indentText.replace(/\t/g, '    ').length, m: m.trim(), c: c.trim() });
    }
    start = end + 1;
  };
  for (let k = 0; k < mask.length; k++) {
    const ch = mask[k] as string;
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
    else if (ch === '\n' && depth === 0) {
      let j = k - 1;
      if (mask[j] === '\r') j -= 1;
      if (mask[j] === '\\') continue;
      flush(k);
    }
  }
  flush(mask.length);
  return lines;
}

function pyDefSig(m: string, c: string, from: number): string {
  const open = m.indexOf('(', from);
  if (open === -1) return '';
  const close = matchBalanced(m, open);
  const colon = m.indexOf(':', close);
  const tail = m.slice(close, colon === -1 ? m.length : colon);
  const arrow = tail.indexOf('->');
  const ret = arrow === -1 ? '' : c.slice(close + arrow, colon === -1 ? m.length : colon);
  return capSig(normalizeSig(c.slice(open, close) + ret));
}

const PY_KEYWORDS = new Set([
  'if',
  'elif',
  'else',
  'try',
  'except',
  'finally',
  'while',
  'for',
  'with',
  'match',
  'case',
  'lambda',
  'return',
  'async',
]);

function extractPyExports(source: string): ExportedSymbol[] {
  const { mask, code } = maskPy(source);
  const lines = pythonLogicalLines(mask, code);
  const locals = new SymbolTable();
  let allNames: string[] | null = null;
  const DEF_RE = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/;
  const CLASS_RE = /^class\s+([A-Za-z_]\w*)/;

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx] as PyLine;
    if (line.indent !== 0) continue;
    const def = DEF_RE.exec(line.m);
    if (def && def[1]) {
      locals.add(def[1], { kind: 'function', signature: pyDefSig(line.m, line.c, def[0].length) });
      continue;
    }
    const cls = CLASS_RE.exec(line.m);
    if (cls && cls[1]) {
      let bases = '';
      const after = line.m.slice(cls[0].length);
      if (after.trimStart().startsWith('(')) {
        const open = line.m.indexOf('(', cls[0].length);
        bases = normalizeSig(line.c.slice(open, matchBalanced(line.m, open)));
      }
      const members: string[] = [];
      let memberIndent = -1;
      for (let j = idx + 1; j < lines.length; j++) {
        const inner = lines[j] as PyLine;
        if (inner.indent === 0) break;
        if (memberIndent === -1) memberIndent = inner.indent;
        if (inner.indent !== memberIndent) continue;
        const mdef = DEF_RE.exec(inner.m);
        if (mdef && mdef[1]) {
          const name = mdef[1];
          if (name.startsWith('_') && !/^__\w+__$/.test(name)) continue;
          members.push(`${name}${pyDefSig(inner.m, inner.c, mdef[0].length)}`);
          continue;
        }
        const attr = /^([A-Za-z]\w*)\s*:\s*([^=]+)/.exec(inner.c);
        if (attr && attr[1] && attr[2]) members.push(`${attr[1]}:${normalizeSig(attr[2])}`);
      }
      locals.add(cls[1], { kind: 'class', signature: shortHash(`${bases}|${members.join(';')}`) });
      continue;
    }
    const all = /^__all__\s*(\+)?=\s*/.exec(line.m);
    if (all) {
      const names = [...line.c.slice(all[0].length).matchAll(/(['"])([A-Za-z_]\w*)\1/g)].map(
        (m) => m[2] as string,
      );
      allNames = all[1] && allNames ? [...allNames, ...names] : names;
      continue;
    }
    const assign = /^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(?::\s*([^=]+?))?\s*=(?!=)/d.exec(
      line.m,
    );
    if (assign && assign[1]) {
      const span = assign.indices?.[2];
      const annotation = span ? normalizeSig(line.c.slice(span[0], span[1])) : '';
      for (const name of assign[1].split(',').map((s) => s.trim())) {
        locals.add(name, { kind: 'variable', signature: annotation ? `:${annotation}` : '' });
      }
      continue;
    }
    const annotated = /^([A-Za-z_]\w*)\s*:\s*(\S.*)$/d.exec(line.m);
    if (annotated && annotated[1] && !PY_KEYWORDS.has(annotated[1])) {
      const span = annotated.indices?.[2];
      const annotation = span ? normalizeSig(line.c.slice(span[0], span[1])) : '';
      locals.add(annotated[1], { kind: 'variable', signature: `:${annotation}` });
    }
  }

  const exports = new SymbolTable();
  if (allNames) {
    for (const name of allNames) {
      exports.add(name, locals.map.get(name) ?? { kind: 'unknown', signature: '' });
    }
  } else {
    for (const [name, sym] of locals.map) if (!name.startsWith('_')) exports.add(name, sym);
  }
  return toList(exports);
}

/**
 * Extracts the exported surface of a module: names plus a coarse signature so a before/after
 * comparison detects added, removed and *changed* exports. Regex/lexer based and deterministic;
 * returns `[]` for unsupported languages or inputs over 512 KiB.
 *
 * - TS/JS: ES module `export` forms (declarations, lists, re-exports, defaults, `export =`) and
 *   CommonJS `module.exports` / `exports.x`.
 * - Python: `__all__` when present, otherwise public top-level functions, classes and assignments.
 */
export function extractExports(source: string, lang: Language | null): ExportedSymbol[] {
  if (typeof source !== 'string' || source.length > MAX_ANALYSIS_BYTES) return [];
  if (lang === 'typescript' || lang === 'javascript') return extractJsExports(source);
  if (lang === 'python') return extractPyExports(source);
  return [];
}

/** Compares two export surfaces by name; a kind or signature change counts as `changed`. */
export function diffExportSurface(
  before: readonly ExportedSymbol[],
  after: readonly ExportedSymbol[],
): ExportSurfaceDiff {
  const b = new Map(before.map((s) => [s.name, s]));
  const a = new Map(after.map((s) => [s.name, s]));
  const added: ExportedSymbol[] = [];
  const removed: ExportedSymbol[] = [];
  const changed: ExportSurfaceDiff['changed'] = [];
  for (const [name, sym] of a) {
    const prev = b.get(name);
    if (!prev) added.push(sym);
    else if (prev.kind !== sym.kind || prev.signature !== sym.signature) {
      changed.push({ name, before: prev, after: sym });
    }
  }
  for (const [name, sym] of b) if (!a.has(name)) removed.push(sym);
  const byName = (x: { name: string }, y: { name: string }): number =>
    x.name < y.name ? -1 : x.name > y.name ? 1 : 0;
  return {
    added: added.sort(byName),
    removed: removed.sort(byName),
    changed: changed.sort(byName),
  };
}

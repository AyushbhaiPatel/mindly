/**
 * Tiny, deterministic lexers used by the analysers. They do not build tokens; they produce two
 * strings of the same length as the input:
 *
 * - `code`: comments replaced by spaces (newlines kept), strings intact.
 * - `mask`: like `code`, but the *contents* of string, template and regex literals are also
 *   replaced by spaces (delimiters kept).
 *
 * Because offsets are preserved, a pattern found in `mask` (where it cannot be inside a string or
 * comment) can be sliced out of `code` (where string literal types and module specifiers are
 * still readable).
 */
export interface Masked {
  code: string;
  mask: string;
}

const REGEX_PREFIX_CHARS = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const REGEX_PREFIX_WORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

function blank(ch: string): string {
  return ch === '\n' || ch === '\r' ? ch : ' ';
}

/** Lexes JavaScript / TypeScript (including template literals, nested `${}` and regex literals). */
export function maskJs(src: string): Masked {
  const n = src.length;
  const code: string[] = new Array<string>(n);
  const mask: string[] = new Array<string>(n);
  // Stack of brace depths at which we re-enter a template literal.
  const templateStack: number[] = [];
  let braceDepth = 0;
  let lastSignificant = '';
  let lastWord = '';
  let i = 0;

  const keep = (k: number): void => {
    code[k] = src[k] as string;
    mask[k] = src[k] as string;
  };
  const hideBoth = (k: number): void => {
    const b = blank(src[k] as string);
    code[k] = b;
    mask[k] = b;
  };
  const hideMask = (k: number): void => {
    code[k] = src[k] as string;
    mask[k] = blank(src[k] as string);
  };

  // Scans template literal characters starting at `i` (just after a backtick or a closing `}`)
  // until the closing backtick or a `${`.
  const scanTemplate = (): void => {
    while (i < n) {
      const ch = src[i];
      if (ch === '\\') {
        hideMask(i);
        if (i + 1 < n) hideMask(i + 1);
        i += 2;
        continue;
      }
      if (ch === '`') {
        keep(i);
        i += 1;
        lastSignificant = '`';
        lastWord = '';
        return;
      }
      if (ch === '$' && src[i + 1] === '{') {
        keep(i);
        keep(i + 1);
        i += 2;
        templateStack.push(braceDepth);
        braceDepth += 1;
        lastSignificant = '{';
        lastWord = '';
        return;
      }
      hideMask(i);
      i += 1;
    }
  };

  while (i < n) {
    const ch = src[i] as string;
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') hideBoth(i++);
      continue;
    }
    if (ch === '/' && next === '*') {
      hideBoth(i++);
      hideBoth(i++);
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) hideBoth(i++);
      if (i < n) {
        hideBoth(i++);
        hideBoth(i++);
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      keep(i++);
      while (i < n && src[i] !== ch && src[i] !== '\n') {
        if (src[i] === '\\' && i + 1 < n) hideMask(i++);
        hideMask(i++);
      }
      if (i < n && src[i] === ch) keep(i++);
      lastSignificant = ch;
      lastWord = '';
      continue;
    }
    if (ch === '`') {
      keep(i++);
      scanTemplate();
      continue;
    }
    if (ch === '/') {
      const regexAllowed =
        lastSignificant === '' ||
        REGEX_PREFIX_CHARS.has(lastSignificant) ||
        REGEX_PREFIX_WORDS.has(lastWord);
      if (regexAllowed) {
        keep(i++);
        let inClass = false;
        while (i < n && src[i] !== '\n') {
          const c = src[i];
          if (c === '\\' && i + 1 < n) {
            hideMask(i++);
            hideMask(i++);
            continue;
          }
          if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          else if (c === '/' && !inClass) break;
          hideMask(i++);
        }
        if (i < n && src[i] === '/') keep(i++);
        while (i < n && /[a-z]/i.test(src[i] as string)) keep(i++);
        lastSignificant = ')';
        lastWord = '';
        continue;
      }
    }
    if (ch === '{') {
      braceDepth += 1;
    } else if (ch === '}') {
      if (templateStack.length > 0 && templateStack[templateStack.length - 1] === braceDepth - 1) {
        templateStack.pop();
        braceDepth -= 1;
        keep(i++);
        scanTemplate();
        continue;
      }
      braceDepth = Math.max(0, braceDepth - 1);
    }
    keep(i);
    if (/[A-Za-z0-9_$]/.test(ch)) {
      // Accumulate the current word for keyword detection.
      const prev = src[i - 1];
      lastWord = prev !== undefined && /[A-Za-z0-9_$]/.test(prev) ? lastWord + ch : ch;
      lastSignificant = 'a';
    } else if (!/\s/.test(ch)) {
      lastSignificant = ch;
      lastWord = '';
    }
    i += 1;
  }
  return { code: code.join(''), mask: mask.join('') };
}

/** Lexes Python (comments, single/double/triple-quoted strings with any prefix). */
export function maskPy(src: string): Masked {
  const n = src.length;
  const code: string[] = new Array<string>(n);
  const mask: string[] = new Array<string>(n);
  let i = 0;
  const keep = (k: number): void => {
    code[k] = src[k] as string;
    mask[k] = src[k] as string;
  };
  while (i < n) {
    const ch = src[i] as string;
    if (ch === '#') {
      while (i < n && src[i] !== '\n') {
        code[i] = ' ';
        mask[i] = ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      const triple = src[i + 1] === ch && src[i + 2] === ch;
      const delim = triple ? ch.repeat(3) : ch;
      for (let k = 0; k < delim.length; k++) keep(i++);
      while (i < n) {
        if (src[i] === '\\' && i + 1 < n) {
          code[i] = src[i] as string;
          mask[i] = ' ';
          i += 1;
          code[i] = src[i] as string;
          mask[i] = blank(src[i] as string);
          i += 1;
          continue;
        }
        if (src.startsWith(delim, i)) break;
        if (!triple && src[i] === '\n') break;
        code[i] = src[i] as string;
        mask[i] = blank(src[i] as string);
        i += 1;
      }
      if (src.startsWith(delim, i)) for (let k = 0; k < delim.length; k++) keep(i++);
      continue;
    }
    keep(i);
    i += 1;
  }
  return { code: code.join(''), mask: mask.join('') };
}

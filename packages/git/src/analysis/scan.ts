import { sha256 } from '@synapse/core';

/** Characters that, at the end of a line, mean the statement continues on the next line. */
const CONTINUES_AFTER = new Set('=,(+-*/%&|^!?:<.['.split(''));
/** Characters that, at the start of the next line, mean the statement continues. */
const CONTINUES_BEFORE = new Set('.?|&=,:)]}*%'.split(''));

const OPEN = new Set(['(', '[', '{']);
const CLOSE = new Set([')', ']', '}']);

/** True for characters that may appear in a JS identifier. */
export function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

/** Index of the first non-whitespace character at or after `i` (or `s.length`). */
export function skipWs(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i] as string)) i += 1;
  return i;
}

function prevNonWs(s: string, i: number, floor: number): string {
  for (let k = i - 1; k >= floor; k--) {
    const ch = s[k] as string;
    if (!/\s/.test(ch)) return ch;
  }
  return '';
}

/**
 * Given `s[open]` is `(`, `[`, `{` or `<`, returns the index just after the matching closer
 * (or `s.length`). `<`/`>` are only counted when starting from `<`, and `=>` is ignored.
 */
export function matchBalanced(s: string, open: number): number {
  const opener = s[open];
  const angle = opener === '<';
  let depth = 0;
  for (let k = open; k < s.length; k++) {
    const ch = s[k] as string;
    if (OPEN.has(ch) || (angle && ch === '<')) depth += 1;
    else if (CLOSE.has(ch) || (angle && ch === '>' && s[k - 1] !== '=')) {
      depth -= 1;
      if (depth === 0) return k + 1;
    }
  }
  return s.length;
}

/**
 * End (exclusive) of the JS/TS statement starting at `start` in masked text: a `;` at depth 0, or
 * a newline at depth 0 that is not followed or preceded by a continuation.
 */
export function scanStatementEnd(s: string, start: number): number {
  let depth = 0;
  for (let k = start; k < s.length; k++) {
    const ch = s[k] as string;
    if (OPEN.has(ch)) depth += 1;
    else if (CLOSE.has(ch)) {
      depth -= 1;
      if (depth < 0) return k;
    } else if (depth === 0 && ch === ';') {
      return k + 1;
    } else if (depth === 0 && ch === '\n') {
      const prev = prevNonWs(s, k, start);
      const nextIdx = skipWs(s, k);
      if (nextIdx >= s.length) return s.length;
      const next = s[nextIdx] as string;
      const arrow = prev === '>' && s[s.lastIndexOf('>', k) - 1] === '=';
      if (prev === '' || CONTINUES_AFTER.has(prev) || arrow) continue;
      if (CONTINUES_BEFORE.has(next)) continue;
      if (next === '{' && (prev === ')' || prev === '>')) continue;
      if (/^(extends|implements)\b/.test(s.slice(nextIdx, nextIdx + 11))) continue;
      return k;
    }
  }
  return s.length;
}

/**
 * Scans a TypeScript type annotation starting at `i` and returns where it ends: at a body `{`, a
 * `;`, an `=` (not `=>`), or any character in `stopAt` at depth 0. Object type literals (a `{`
 * after `:`, `|`, `&`, `<`, `,`, `(` or `=>`) are consumed.
 */
export function scanType(s: string, i: number, stopAt = '', stopAtArrow = false): number {
  let depth = 0;
  for (let k = i; k < s.length; k++) {
    const ch = s[k] as string;
    if (depth === 0) {
      if (stopAtArrow && ch === '=' && s[k + 1] === '>') return k;
      if (ch === ';' || stopAt.includes(ch)) return k;
      if (ch === '=' && s[k + 1] !== '>') return k;
      if (ch === '{') {
        const prev = prevNonWs(s, k, i);
        const typeLiteral =
          k === skipWs(s, i) ||
          prev === ':' ||
          prev === '|' ||
          prev === '&' ||
          prev === '<' ||
          prev === ',' ||
          prev === '(' ||
          (prev === '>' && s[s.lastIndexOf('>', k) - 1] === '=');
        if (!typeLiteral) return k;
        k = matchBalanced(s, k) - 1;
        continue;
      }
    }
    if (ch === '(' || ch === '[' || ch === '{' || ch === '<') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}' || (ch === '>' && s[k - 1] !== '=')) {
      if (depth === 0) return k;
      depth -= 1;
    }
  }
  return s.length;
}

/**
 * Normalises signature text so formatting changes (whitespace, quote style, trailing commas) do
 * not register as a signature change.
 */
export function normalizeSig(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/"/g, "'")
    .replace(/\s*([(){}[\]<>,;:=|&?*+])\s*/g, '$1')
    .replace(/[,;]+([)\]}>])/g, '$1')
    .replace(/^[|&]/, '')
    .replace(/[;,]+$/, '');
}

/** Short content hash used as a coarse signature for type-like declarations. */
export function shortHash(text: string): string {
  return `#${sha256(text).slice(0, 16)}`;
}

/** Caps a normalised signature: long ones are replaced by their hash. */
export function capSig(sig: string, max = 300): string {
  return sig.length > max ? shortHash(sig) : sig;
}

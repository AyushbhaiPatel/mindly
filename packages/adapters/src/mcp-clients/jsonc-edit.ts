import {
  applyEdits,
  createScanner,
  findNodeAtLocation,
  getNodeValue,
  modify,
  parseTree,
  printParseErrorCode,
} from 'jsonc-parser';
import type { Edit, FormattingOptions, Node, ParseError } from 'jsonc-parser';
import { MindlyError } from '@mindly/core';
import type { McpConfigFormat } from './catalog.js';

/*
 * Minimal, format-preserving edits of JSON / JSONC config files. Only the one property being
 * added, replaced or removed changes; every other byte (comments, ordering, indentation, line
 * endings, trailing newline) is kept. Parsing uses `jsonc-parser` (the parser VS Code uses for
 * its settings files); the edits themselves are computed here so neighbouring properties are
 * never reformatted. Unusual layouts (several properties on one line, comments inside an empty
 * object) fall back to `jsonc-parser`'s unformatted insert/remove, which still keeps every other
 * byte.
 */

const BOM = '\uFEFF';

// SyntaxKind values (a const enum in jsonc-parser's typings, unusable with isolatedModules).
const TOKEN_COMMA = 5;
const TOKEN_LINE_COMMENT = 12;
const TOKEN_BLOCK_COMMENT = 13;
const TOKEN_LINE_BREAK = 14;
const TOKEN_TRIVIA = 15;

interface Parsed {
  /** Text without a leading BOM. */
  body: string;
  /** The BOM to put back in front of the edited text ('' when there was none). */
  bom: string;
  root: Node | undefined;
}

function parseText(file: string, text: string, format: McpConfigFormat): Parsed {
  const bom = text.startsWith(BOM) ? BOM : '';
  const body = bom === '' ? text : text.slice(1);
  if (body.trim() === '') return { body, bom, root: undefined };
  const errors: ParseError[] = [];
  const root = parseTree(body, errors, {
    disallowComments: format === 'json',
    allowTrailingComma: format === 'jsonc',
    allowEmptyContent: false,
  });
  const first = errors[0];
  if (first !== undefined || root === undefined) {
    const what = format === 'json' ? 'valid JSON' : 'valid JSON (comments are allowed)';
    const detail =
      first !== undefined ? ` (${printParseErrorCode(first.error)} at offset ${first.offset})` : '';
    throw new MindlyError(
      'invalid_input',
      `${file} is not ${what}${detail}; fix it before running the installer`,
    );
  }
  if (root.type !== 'object') {
    throw new MindlyError('invalid_input', `${file} must contain a JSON object at the top level`);
  }
  return { body, bom, root };
}

/** Refuses when any existing container on `path` is not an object (never overwrite it). */
function checkContainers(file: string, root: Node, path: readonly string[]): void {
  for (let i = 1; i <= path.length; i++) {
    const node = findNodeAtLocation(root, path.slice(0, i));
    if (node === undefined) return;
    if (node.type !== 'object') {
      throw new MindlyError(
        'invalid_input',
        `"${path.slice(0, i).join('.')}" in ${file} is not an object; Mindly will not overwrite it`,
      );
    }
  }
}

/** Indentation and line endings used by `text`, so inserted lines match the file. */
export function detectFormatting(text: string): FormattingOptions {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indent = /^([ \t]+)\S/m.exec(text)?.[1];
  if (indent?.startsWith('\t')) return { insertSpaces: false, tabSize: 4, eol };
  const size = indent === undefined ? 2 : Math.min(Math.max(indent.length, 1), 8);
  return { insertSpaces: true, tabSize: size, eol };
}

function nest(path: readonly string[], value: unknown): unknown {
  let out = value;
  for (let i = path.length - 1; i >= 0; i--) out = { [path[i] as string]: out };
  return out;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Leading whitespace of the line containing `offset`. */
function lineIndent(text: string, offset: number): string {
  const start = text.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(start))?.[0] ?? '';
}

/** True when only whitespace precedes `offset` on its line. */
function startsLine(text: string, offset: number): boolean {
  const start = text.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*$/.test(text.slice(start, offset));
}

function unitOf(options: FormattingOptions): string {
  return options.insertSpaces ? ' '.repeat(options.tabSize ?? 2) : '\t';
}

/** Pretty-prints `value` for insertion on a line indented with `indent`. */
function pretty(value: unknown, indent: string, options: FormattingOptions): string {
  return JSON.stringify(value, null, unitOf(options))
    .split('\n')
    .join((options.eol ?? '\n') + indent);
}

/** An object property line (`"key": value`) or, with `key` null, an array element. */
function entryText(
  key: string | null,
  value: unknown,
  indent: string,
  options: FormattingOptions,
): string {
  const text = pretty(value, indent, options);
  return key === null ? text : `${JSON.stringify(key)}: ${text}`;
}

interface LineTail {
  /** Offset of a comma following the node on the same line. */
  comma: number | null;
  /** Offset of the line break ending the line, or null when another token follows. */
  lineBreak: number | null;
  /** Start of the next line. */
  nextLine: number | null;
  /** Whether a comment sits between the node and the end of the line. */
  comment: boolean;
}

/** Describes what follows `offset` up to the end of its line. */
function lineTail(text: string, offset: number): LineTail {
  const scanner = createScanner(text, false);
  scanner.setPosition(offset);
  const tail: LineTail = { comma: null, lineBreak: null, nextLine: null, comment: false };
  for (;;) {
    const token = scanner.scan() as number;
    if (token === TOKEN_TRIVIA) continue;
    if (token === TOKEN_COMMA && tail.comma === null) {
      tail.comma = scanner.getTokenOffset();
      continue;
    }
    if (token === TOKEN_LINE_COMMENT || token === TOKEN_BLOCK_COMMENT) {
      if (scanner.getTokenValue().includes('\n')) return tail;
      tail.comment = true;
      continue;
    }
    if (token === TOKEN_LINE_BREAK) {
      tail.lineBreak = scanner.getTokenOffset();
      tail.nextLine = scanner.getTokenOffset() + scanner.getTokenLength();
    }
    return tail;
  }
}

/**
 * Edits that add property `key` = `value` to the object `obj` (or, with `key` null, append `value`
 * to the array `obj`), or null to fall back.
 */
function insertEdits(
  body: string,
  obj: Node,
  key: string | null,
  value: unknown,
  options: FormattingOptions,
): Edit[] | null {
  const eol = options.eol ?? '\n';
  const children = obj.children ?? [];
  const last = children[children.length - 1];
  if (last === undefined) {
    const inner = body.slice(obj.offset + 1, obj.offset + obj.length - 1);
    if (inner.trim() !== '') return null;
    const outer = lineIndent(body, obj.offset);
    const indent = outer + unitOf(options);
    const entry = entryText(key, value, indent, options);
    return [
      {
        offset: obj.offset + 1,
        length: inner.length,
        content: `${eol}${indent}${entry}${eol}${outer}`,
      },
    ];
  }
  if (!startsLine(body, last.offset)) return null;
  const end = last.offset + last.length;
  const tail = lineTail(body, end);
  if (tail.lineBreak === null) return null;
  const indent = lineIndent(body, last.offset);
  const entry = entryText(key, value, indent, options);
  const edits: Edit[] = [];
  if (tail.comma === null) edits.push({ offset: end, length: 0, content: ',' });
  // A trailing comma after the last property (JSONC style) is repeated on the new last one.
  edits.push({
    offset: tail.lineBreak,
    length: 0,
    content: `${eol}${indent}${entry}${tail.comma === null ? '' : ','}`,
  });
  return edits;
}

/**
 * Edits that remove the property node `prop` from its object `obj` (or the element `prop` from
 * the array `obj`), or null to fall back.
 */
function removeEdits(body: string, obj: Node, prop: Node): Edit[] | null {
  const children = obj.children ?? [];
  const index = children.indexOf(prop);
  if (index < 0 || !startsLine(body, prop.offset)) return null;
  const tail = lineTail(body, prop.offset + prop.length);
  if (tail.lineBreak === null || tail.nextLine === null || tail.comment) return null;
  const lineStart = body.lastIndexOf('\n', prop.offset - 1) + 1;
  const innerStart = obj.offset + 1;
  const innerEnd = obj.offset + obj.length - 1;
  if (children.length === 1) {
    const rest = body.slice(innerStart, lineStart) + body.slice(tail.nextLine, innerEnd);
    // Mindly was the only entry: collapse the object back to `{}`.
    if (rest.trim() === '')
      return [{ offset: innerStart, length: innerEnd - innerStart, content: '' }];
  }
  const edits: Edit[] = [{ offset: lineStart, length: tail.nextLine - lineStart, content: '' }];
  const previous = children[index - 1];
  if (index === children.length - 1 && tail.comma === null && previous !== undefined) {
    // The removed property was last without a comma: drop the comma the previous one gained.
    const prevTail = lineTail(body, previous.offset + previous.length);
    if (prevTail.comma !== null && prevTail.comma < lineStart) {
      edits.push({ offset: prevTail.comma, length: 1, content: '' });
    }
  }
  return edits;
}

/** Reads the value at `path`, or undefined when absent. Validates the file first. */
export function readJsoncValue(
  file: string,
  text: string | null,
  format: McpConfigFormat,
  path: readonly string[],
): unknown {
  if (text === null) return undefined;
  const { root } = parseText(file, text, format);
  if (root === undefined) return undefined;
  const node = findNodeAtLocation(root, [...path]);
  return node === undefined ? undefined : (getNodeValue(node) as unknown);
}

/**
 * Sets `path` to `value` in a JSON/JSONC document, creating missing parent objects. Returns the
 * new text, or the original text when the value is already there. `text` null or blank creates
 * a fresh 2-space-indented document.
 */
export function setJsoncValue(
  file: string,
  text: string | null,
  format: McpConfigFormat,
  path: readonly string[],
  value: unknown,
): string {
  if (path.length === 0) throw new Error('setJsoncValue needs a non-empty path');
  const parsed = text === null ? null : parseText(file, text, format);
  if (parsed === null || parsed.root === undefined) {
    return `${parsed?.bom ?? ''}${JSON.stringify(nest(path, value), null, 2)}\n`;
  }
  const { body, bom, root } = parsed;
  checkContainers(file, root, path.slice(0, -1));
  const existing = findNodeAtLocation(root, [...path]);
  if (existing !== undefined && sameJson(getNodeValue(existing), value)) return text as string;
  const options = detectFormatting(body);
  let edits: Edit[] | null;
  if (existing !== undefined) {
    // Replace only the value; the key, its neighbours and comments stay put.
    const indent = lineIndent(body, existing.parent?.offset ?? existing.offset);
    edits = [
      { offset: existing.offset, length: existing.length, content: pretty(value, indent, options) },
    ];
  } else {
    // The deepest existing object on the path receives the new property.
    let depth = path.length - 1;
    while (depth > 0 && findNodeAtLocation(root, path.slice(0, depth)) === undefined) depth--;
    const container = depth === 0 ? root : findNodeAtLocation(root, path.slice(0, depth));
    const key = path[depth] as string;
    edits =
      container === undefined
        ? null
        : insertEdits(body, container, key, nest(path.slice(depth + 1), value), options);
  }
  edits ??= modify(body, [...path], value, {});
  const result = bom + applyEdits(body, edits);
  // Defensive: the edited document must parse and hold exactly the intended value.
  if (!sameJson(readJsoncValue(file, result, format, path), value)) {
    throw new MindlyError('internal', `could not update ${file} safely`);
  }
  return result;
}

/**
 * Removes the property at `path` from a JSON/JSONC document. Returns the new text, or the
 * original text when the property is absent. With `pruneEmptyParent`, a parent object that becomes
 * empty is removed too (never the document root).
 */
export function removeJsoncValue(
  file: string,
  text: string,
  format: McpConfigFormat,
  path: readonly string[],
  options: { pruneEmptyParent?: boolean } = {},
): string {
  if (path.length === 0) throw new Error('removeJsoncValue needs a non-empty path');
  const parsed = parseText(file, text, format);
  if (parsed.root === undefined) return text;
  const { body, bom, root } = parsed;
  checkContainers(file, root, path.slice(0, -1));
  const node = findNodeAtLocation(root, [...path]);
  if (node === undefined) return text;
  const prop = node.parent;
  const obj = prop?.parent;
  const edits =
    (prop !== undefined && obj !== undefined ? removeEdits(body, obj, prop) : null) ??
    modify(body, [...path], undefined, {});
  let result = bom + applyEdits(body, edits);
  if (readJsoncValue(file, result, format, path) !== undefined) {
    throw new MindlyError('internal', `could not update ${file} safely`);
  }
  // A servers object left empty (typically created by our own install) is removed as well, so
  // install followed by uninstall restores the original file. The document root is never removed.
  const parent = path.slice(0, -1);
  if (options.pruneEmptyParent && parent.length > 0) {
    const value = readJsoncValue(file, result, format, parent);
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
    ) {
      result = removeJsoncValue(file, result, format, parent);
    }
  }
  return result;
}

/**
 * Edits one element of the array at `path`: `index` null appends `value`, `value` undefined
 * removes the element at `index`, anything else replaces it. The other elements, and the
 * comments around them, keep their bytes. The array must already exist.
 */
export function editJsoncArrayItem(
  file: string,
  text: string,
  format: McpConfigFormat,
  path: readonly string[],
  index: number | null,
  value: unknown,
): string {
  const { body, bom, root } = parseText(file, text, format);
  const array = root === undefined ? undefined : findNodeAtLocation(root, [...path]);
  if (array?.type !== 'array') {
    throw new MindlyError('invalid_input', `"${path.join('.')}" in ${file} is not an array`);
  }
  const children = array.children ?? [];
  const at = index ?? children.length;
  const child = children[at];
  const expected = [...(getNodeValue(array) as unknown[])];
  let edits: Edit[] | null;
  if (index === null) {
    expected.push(value);
    edits = insertEdits(body, array, null, value, detectFormatting(body));
  } else if (child === undefined) {
    throw new MindlyError('internal', `no element ${at} in ${path.join('.')} of ${file}`);
  } else if (value === undefined) {
    expected.splice(at, 1);
    edits = removeEdits(body, array, child);
  } else {
    expected[at] = value;
    const indent = lineIndent(body, child.offset);
    edits = [
      {
        offset: child.offset,
        length: child.length,
        content: pretty(value, indent, detectFormatting(body)),
      },
    ];
  }
  edits ??= modify(body, [...path, at], value, { isArrayInsertion: index === null });
  const result = bom + applyEdits(body, edits);
  if (!sameJson(readJsoncValue(file, result, format, path), expected)) {
    throw new MindlyError('internal', `could not update ${file} safely`);
  }
  return result;
}

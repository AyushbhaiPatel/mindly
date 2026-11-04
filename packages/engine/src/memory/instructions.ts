import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { isDeniedPath, sanitizeLine, tryResolveInsideRoot } from '@mindly/core';
import { findSection } from './managed-section.js';
import { cleanScopePaths, MAX_TITLE } from './service.js';

/*
 * Rule import from agent instruction files (CLAUDE.md, AGENTS.md, .cursorrules, …). The user
 * wrote these files for their agents, so `mindly init` turns each bullet or sentence into a Mindly
 * rule that every connected agent receives, with the file and line as provenance.
 *
 * Parsing is deterministic and conservative: headings, code blocks, tables, comments, imports and
 * the usual "This file provides guidance to …" preamble are skipped; a lead-in such as "When
 * writing tests:" is folded into the bullets under it. The section Mindly writes its own rules
 * into is skipped too, so synced rules are never imported back.
 */

/** Where an instruction file lives (relative to the project root) and which agents read it. */
export interface InstructionSource {
  path: string;
  agents: string;
  /** A directory whose matching files are each a rules file. */
  dir?: boolean;
  /** File name suffixes accepted inside `dir`. */
  ext?: readonly string[];
}

/** Every instruction file Mindly imports, at the project root. */
export const INSTRUCTION_SOURCES: readonly InstructionSource[] = Object.freeze([
  { path: 'CLAUDE.md', agents: 'Claude Code' },
  { path: 'CLAUDE.local.md', agents: 'Claude Code' },
  { path: '.claude/CLAUDE.md', agents: 'Claude Code' },
  { path: 'AGENTS.md', agents: 'Codex, OpenCode, Amp' },
  { path: 'GEMINI.md', agents: 'Gemini CLI' },
  { path: '.cursorrules', agents: 'Cursor' },
  { path: '.cursor/rules', agents: 'Cursor', dir: true, ext: ['.mdc', '.md'] },
  { path: '.windsurfrules', agents: 'Windsurf' },
  { path: '.windsurf/rules', agents: 'Windsurf', dir: true, ext: ['.md'] },
  { path: '.github/copilot-instructions.md', agents: 'GitHub Copilot' },
  { path: '.github/instructions', agents: 'GitHub Copilot', dir: true, ext: ['.instructions.md'] },
  { path: '.clinerules', agents: 'Cline' },
  { path: '.clinerules', agents: 'Cline', dir: true, ext: ['.md', '.txt'] },
  { path: '.roorules', agents: 'Roo Code' },
  { path: '.roo/rules', agents: 'Roo Code', dir: true, ext: ['.md', '.txt'] },
  { path: '.kiro/steering', agents: 'Kiro', dir: true, ext: ['.md'] },
  { path: '.rules', agents: 'Zed' },
  { path: '.augment-guidelines', agents: 'Augment' },
  { path: '.augment/rules', agents: 'Augment', dir: true, ext: ['.md'] },
]);

const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 50;
const MAX_DIR_DEPTH = 3;
const MAX_RULES_PER_FILE = 200;
const MAX_RULE_CHARS = 1000;
const MIN_RULE_CHARS = 12;

/** One rule found in an instruction file. */
export interface InstructionRule {
  /** Project-relative POSIX path of the file. */
  file: string;
  /** 1-based line the rule starts on. */
  line: number;
  /** The rule as written, markdown markers removed. */
  text: string;
  /** Title Mindly stores (the text, shortened when long). */
  title: string;
  /**
   * The first source line, kept as evidence so the rule goes stale when the line is removed; null
   * for UTF-16 files, which keep only the file as evidence.
   */
  excerpt: string | null;
  /** Path globs the file applies to (Cursor `globs`, Copilot `applyTo`, Kiro `fileMatchPattern`). */
  scopePaths: string[];
}

/** An instruction file found in the project. */
export interface InstructionFile {
  path: string;
  agents: string;
  rules: InstructionRule[];
  /** Why the file was not parsed: applied only on request, too large, or unreadable. */
  skipped: 'manual' | 'too_large' | 'unreadable' | null;
}

/** Result of parsing one file's content. */
export interface ParsedInstructions {
  rules: Omit<InstructionRule, 'file'>[];
  scopePaths: string[];
  /** The file is only applied when asked for (Cursor manual rules, Kiro `inclusion: manual`, …). */
  manual: boolean;
}

/** Finds the instruction files at `root`, skipping deny-listed paths and links leaving the root. */
export function scanInstructionFiles(
  root: string,
  denyPaths: readonly string[] = [],
): InstructionFile[] {
  const seen = new Set<string>();
  const out: InstructionFile[] = [];
  const add = (abs: string, agents: string): void => {
    if (out.length >= MAX_FILES) return;
    const resolved = tryResolveInsideRoot(root, abs);
    if (!resolved || resolved.rel === '' || isDeniedPath(resolved.rel, denyPaths)) return;
    // CLAUDE.md is often a symlink to AGENTS.md: read each real file once.
    if (seen.has(resolved.abs)) return;
    seen.add(resolved.abs);
    out.push(readInstructionFile(resolved.abs, relative(root, abs).split(sep).join('/'), agents));
  };
  for (const source of INSTRUCTION_SOURCES) {
    const abs = join(root, source.path);
    let isDir: boolean;
    try {
      const st = statSync(abs);
      if (!st.isFile() && !st.isDirectory()) continue;
      isDir = st.isDirectory();
    } catch {
      continue;
    }
    if (source.dir !== true) {
      if (!isDir) add(abs, source.agents);
    } else if (isDir) {
      for (const file of listFiles(abs, source.ext ?? ['.md'], 0)) add(file, source.agents);
    }
  }
  return out;
}

function listFiles(dir: string, ext: readonly string[], depth: number): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    const abs = join(dir, name);
    let isDir: boolean;
    let isFile: boolean;
    try {
      const st = lstatSync(abs).isSymbolicLink() ? statSync(abs) : lstatSync(abs);
      isDir = st.isDirectory();
      isFile = st.isFile();
    } catch {
      continue;
    }
    if (isDir && depth < MAX_DIR_DEPTH) out.push(...listFiles(abs, ext, depth + 1));
    else if (isFile && ext.some((e) => name.toLowerCase().endsWith(e))) out.push(abs);
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

function readInstructionFile(abs: string, rel: string, agents: string): InstructionFile {
  const base = { path: rel, agents, rules: [] };
  let content: string | null;
  let utf16: boolean;
  try {
    const st = statSync(abs);
    if (!st.isFile()) return { ...base, skipped: 'unreadable' };
    if (st.size > MAX_FILE_BYTES) return { ...base, skipped: 'too_large' };
    const buf = readFileSync(abs);
    utf16 = (buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff);
    content = decodeText(buf);
  } catch {
    return { ...base, skipped: 'unreadable' };
  }
  if (content === null) return { ...base, skipped: 'unreadable' };
  const parsed = parseInstructions(content);
  if (parsed.manual) return { ...base, skipped: 'manual' };
  // Evidence excerpts are matched against the file read as UTF-8, so UTF-16 files keep only the
  // file and line as provenance.
  return {
    ...base,
    rules: parsed.rules.map((r) => ({ ...r, file: rel, ...(utf16 ? { excerpt: null } : {}) })),
    skipped: null,
  };
}

/**
 * Decodes UTF-8, or UTF-16 with a byte order mark (common from Windows editors). Returns null for
 * anything else that is not clean text, so a binary or mis-encoded file is never imported.
 */
export function decodeText(buf: Buffer): string | null {
  let text: string;
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    text = buf.subarray(2).toString('utf16le');
  } else if (buf[0] === 0xfe && buf[1] === 0xff) {
    const body = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
    text = body.swap16().toString('utf16le');
  } else {
    text = buf.toString('utf8');
  }
  return text.includes('\0') || text.includes('\uFFFD') ? null : text;
}

interface Item {
  line: number;
  excerpt: string;
  text: string;
  /** Indent of a list item; -1 for a paragraph, -2 for a block break (heading, fence). */
  indent: number;
  /** Paragraphs: where each source line starts in `text`, for per-sentence provenance. */
  rows?: { at: number; line: number; excerpt: string }[];
  /** Block breaks: the heading (or bold label, level 7) that starts a section. */
  heading?: { level: number; text: string };
}

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s{0,3}(#{1,6})(\s|$)/;
/** Wording that turns the items under it into prohibitions ("Don'ts", "Never:", "Avoid"). */
const NEGATION =
  /\b(don'?ts?|do not|never|avoid|must not|should not|shouldn'?t|forbidden|prohibited|banned|not allowed|anti-?patterns?|pitfalls?)\b|^no\b/i;
const SETEXT = /^\s{0,3}(=+|-+)\s*$/;
const THEMATIC_BREAK = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const BULLET = /^(\s*)(?:[-*+]|\d{1,3}[.)])\s+(.*)$/;
const BOLD_ONLY = /^\s*(\*\*|__)[^*_]+\1:?\s*$/;
const BOILERPLATE = [
  /\b(this|the following) (file|document)\b.*\b(guidance|instructions|rules|context)\b/i,
  /\bwhen working with (the )?code in this repository\b/i,
  /^you are (an? |the )?(expert|senior|experienced|helpful|world-class)\b/i,
];

/** Splits an instruction file into rules. Pure; exported for tests. */
export function parseInstructions(content: string): ParsedInstructions {
  const lines = withoutManagedSection(content.replace(/^\uFEFF/, '')).split(/\r?\n/);
  const meta = frontMatter(lines);
  const items: Item[] = [];
  let current: Item | null = null;
  let inFence = false;
  let inComment = false;
  const flush = (): void => {
    if (current) items.push(current);
    current = null;
  };
  const breakBlock = (heading?: { level: number; text: string }): void => {
    flush();
    items.push({ line: 0, excerpt: '', text: '', indent: -2, ...(heading ? { heading } : {}) });
  };
  for (let i = meta.bodyStart; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    if (inComment) {
      if (raw.includes('-->')) inComment = false;
      continue;
    }
    if (FENCE.test(raw)) {
      inFence = !inFence;
      breakBlock();
      continue;
    }
    if (inFence) continue;
    let line = raw.replace(/<!--.*?-->/g, '');
    if (line.includes('<!--')) {
      inComment = true;
      line = line.slice(0, line.indexOf('<!--'));
    }
    line = line.replace(/^\s{0,3}>\s?/, '');
    const trimmed = line.trim();
    if (trimmed === '') {
      flush();
      continue;
    }
    const setext = current === null && SETEXT.test(lines[i + 1] ?? '') && !BULLET.test(line);
    const atx = HEADING.exec(line);
    if (atx) {
      breakBlock({ level: (atx[1] ?? '#').length, text: trimmed.replace(/^#+\s*|\s*#+$/g, '') });
      continue;
    }
    if (setext) {
      breakBlock({ level: (lines[i + 1] ?? '').trim().startsWith('=') ? 1 : 2, text: trimmed });
      i++;
      continue;
    }
    if (BOLD_ONLY.test(line)) {
      breakBlock({
        level: 7,
        text: trimmed.replace(/^(\*\*|__)|(\*\*|__)$|(\*\*|__)?:?(\*\*|__)?$/g, ''),
      });
      continue;
    }
    if (THEMATIC_BREAK.test(line)) {
      breakBlock();
      continue;
    }
    if (/^\s*\|/.test(line) || /^@\S+$/.test(trimmed) || /^<\/?[a-z][^>]*>$/i.test(trimmed)) {
      flush();
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      flush();
      current = {
        line: i + 1,
        excerpt: raw.trim(),
        text: (bullet[2] ?? '').replace(/^\[[ xX]\]\s+/, ''),
        indent: (bullet[1] ?? '').replace(/\t/g, '    ').length,
      };
      continue;
    }
    const row = { line: i + 1, excerpt: raw.trim() };
    if (current?.indent === -1 && startsNewLine(current.text, trimmed)) flush();
    if (current) {
      current.rows?.push({ ...row, at: current.text.length + 1 });
      current.text += ` ${trimmed}`;
    } else {
      current = { ...row, text: trimmed, indent: -1, rows: [{ ...row, at: 0 }] };
    }
  }
  flush();

  const rules: Omit<InstructionRule, 'file'>[] = [];
  const headings: { level: number; text: string }[] = [];
  let paragraphLeadIn: string | null = null;
  for (let i = 0; i < items.length && rules.length < MAX_RULES_PER_FILE; i++) {
    const item = items[i] as Item;
    if (item.indent === -2) {
      if (item.heading) {
        const level = item.heading.level;
        while ((headings.at(-1)?.level ?? 0) >= level) headings.pop();
        headings.push({ level, text: inline(item.heading.text) });
      }
      paragraphLeadIn = null;
      continue;
    }
    const text = inline(item.text);
    const next = items[i + 1];
    // A lead-in ("When writing tests:", "Never do these:") is folded into the items under it.
    if (next !== undefined && next.indent > item.indent && isLeadIn(text)) {
      if (item.indent === -1) paragraphLeadIn = bare(text);
      continue;
    }
    if (item.indent === -1) paragraphLeadIn = null;
    // Context that changes the meaning of an item is kept with it: a negating section heading
    // ("Don'ts") and every lead-in above the item. Topic headings ("Code style") are dropped.
    const context = [
      ...headings.filter((h) => negating(h.text)).map((h) => bare(h.text)),
      ...(item.indent >= 0 && paragraphLeadIn ? [paragraphLeadIn] : []),
      ...ancestorLeadIns(items, i),
    ];
    const prefix = context.length > 0 ? `${context.join(': ')}:` : null;
    const pieces = item.rows ? sentences(item.text) : [{ text: item.text, at: 0 }];
    for (const piece of pieces) {
      const body = inline(piece.text);
      const full = prefix ? `${prefix} ${lowerFirst(body)}` : body;
      if (!keep(full)) continue;
      const source = item.rows?.filter((r) => r.at <= piece.at).at(-1) ?? item;
      rules.push({
        line: source.line,
        text: full,
        title: titleOf(full),
        excerpt: source.excerpt,
        scopePaths: meta.scopePaths,
      });
    }
  }
  return { rules, scopePaths: meta.scopePaths, manual: meta.manual };
}

/** Blanks Mindly's own rules section, keeping its line breaks so line numbers stay right. */
function withoutManagedSection(content: string): string {
  const bounds = findSection(content);
  if (bounds === null || bounds === 'damaged') return content;
  const section = content.slice(bounds.start, bounds.end).replace(/[^\n]/g, '');
  return content.slice(0, bounds.start) + section + content.slice(bounds.end);
}

/** Lead-ins of the list items a nested item sits under, outermost first. */
function ancestorLeadIns(items: readonly Item[], index: number): string[] {
  const out: string[] = [];
  let indent = (items[index] as Item).indent;
  for (let j = index - 1; j >= 0 && indent > 0; j--) {
    const p = items[j] as Item;
    if (p.indent < 0) break;
    if (p.indent >= indent) continue;
    indent = p.indent;
    const text = inline(p.text);
    if (isLeadIn(text)) out.unshift(bare(text));
  }
  return out;
}

/** Text that introduces the items below it rather than stating a rule of its own. */
function isLeadIn(text: string): boolean {
  if (text.endsWith(':') || words(text) < 4) return true;
  return negating(text) && !/[.!]$/.test(text);
}

function negating(text: string): boolean {
  return NEGATION.test(text.replace(/[‘’]/g, "'"));
}

function bare(text: string): string {
  return text.replace(/[:.]+$/, '').trim();
}

function lowerFirst(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

function words(text: string): number {
  return text.split(/\s+/).filter((w) => w !== '').length;
}

/** Removes emphasis and link syntax, keeping code spans as written. */
function inline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) =>
      label === url ? url : `${label} (${url})`,
    )
    .replace(/(\*\*|__)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Splits a paragraph into sentences; "e.g." and similar abbreviations stay intact. */
function sentences(text: string): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = [];
  const boundary = /(?<=[^.\s]{3}[.!?])\s+(?=[A-Z`"'])/g;
  let start = 0;
  for (const m of text.matchAll(boundary)) {
    out.push({ text: text.slice(start, m.index), at: start });
    start = m.index + m[0].length;
  }
  out.push({ text: text.slice(start), at: start });
  return out.filter((s) => s.text.trim() !== '');
}

const CONTINUES =
  /\b(a|an|the|and|or|but|to|of|in|on|for|with|by|from|as|at|than|use|using|is|are)$/i;

/**
 * Plain-text rule files (.cursorrules, .rules) put one rule per line without punctuation. A line
 * starting with a capital letter begins a new rule unless the previous line visibly continues.
 */
function startsNewLine(previous: string, line: string): boolean {
  return /^[A-Z]/.test(line) && !/[,;(-]$/.test(previous) && !CONTINUES.test(previous);
}

function keep(text: string): boolean {
  if (text.length < MIN_RULE_CHARS || text.length > MAX_RULE_CHARS) return false;
  if (words(text) < 3 || text.endsWith(':') || text.endsWith('?')) return false;
  if (/^https?:\/\/\S+$/.test(text)) return false;
  return !BOILERPLATE.some((re) => re.test(text));
}

function titleOf(text: string): string {
  const line = sanitizeLine(text.replace(/[.!]+$/, ''), MAX_TITLE * 2);
  return line.length <= MAX_TITLE ? line : `${line.slice(0, MAX_TITLE - 1).trimEnd()}…`;
}

interface FrontMatter {
  bodyStart: number;
  scopePaths: string[];
  manual: boolean;
}

/** Reads the YAML front matter of Cursor, Windsurf, Kiro and Copilot rule files. */
function frontMatter(lines: readonly string[]): FrontMatter {
  const none: FrontMatter = { bodyStart: 0, scopePaths: [], manual: false };
  if ((lines[0] ?? '').trim() !== '---') return none;
  const end = lines.findIndex((l, i) => i > 0 && i < 60 && l.trim() === '---');
  if (end < 0) return none;
  const fields = new Map<string, string[]>();
  let key: string | null = null;
  for (const l of lines.slice(1, end)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(l);
    if (kv) {
      key = (kv[1] ?? '').toLowerCase();
      fields.set(key, yamlList(kv[2] ?? ''));
      continue;
    }
    const item = /^\s*-\s+(.*)$/.exec(l);
    if (item && key) fields.get(key)?.push(...yamlList(item[1] ?? ''));
  }
  const one = (k: string): string => (fields.get(k)?.[0] ?? '').toLowerCase();
  const globs = ['globs', 'applyto', 'filematchpattern']
    .flatMap((k) => fields.get(k) ?? [])
    .filter((g) => !['**', '**/*', '*'].includes(g));
  let scopePaths: string[];
  try {
    scopePaths = cleanScopePaths(globs);
  } catch {
    scopePaths = [];
  }
  const manual =
    one('inclusion') === 'manual' ||
    one('trigger') === 'manual' ||
    one('trigger') === 'model_decision' ||
    (one('alwaysapply') === 'false' && globs.length === 0);
  return { bodyStart: end + 1, scopePaths, manual };
}

function yamlList(value: string): string[] {
  return value
    .trim()
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter((s) => s !== '');
}

/** Normalised title used to recognise a rule Mindly already has. */
export function ruleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/…$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Splits `rules` into new ones and ones already known: an existing rule with the same title, or the
 * same full text earlier in this import (titles of long rules are shortened, so they are not used
 * to compare rules with each other).
 */
export function dedupeRules(
  rules: readonly InstructionRule[],
  knownTitles: Iterable<string>,
): { fresh: InstructionRule[]; known: InstructionRule[] } {
  const existing = new Set<string>();
  for (const t of knownTitles) existing.add(ruleKey(t));
  const seen = new Set<string>();
  const fresh: InstructionRule[] = [];
  const known: InstructionRule[] = [];
  for (const r of rules) {
    const key = ruleKey(r.text);
    if (existing.has(ruleKey(r.title)) || seen.has(key)) {
      known.push(r);
    } else {
      seen.add(key);
      fresh.push(r);
    }
  }
  return { fresh, known };
}

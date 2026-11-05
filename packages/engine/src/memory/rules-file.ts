import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  isDeniedPath,
  sanitizeForContext,
  sanitizeLine,
  sha256,
  tryResolveInsideRoot,
  type Memory,
} from '@mindly/core';
import type { Kernel } from '../kernel.js';
import { decodeText } from './instructions.js';
import {
  eolOf,
  findSection,
  removeSection,
  RULES_END,
  RULES_START,
  writeSection,
} from './managed-section.js';
import type { MemoryService } from './service.js';

/*
 * Rules file sync: keeps the project's approved rules in a marked section of its agent instruction
 * files (AGENTS.md, CLAUDE.md, GEMINI.md), so agents that are not connected to Mindly follow them
 * too and the rules are versioned with the code. Opt-in per checkout (a linked git worktree is its
 * own checkout); once on, the section is rewritten whenever a rule is approved, edited or archived.
 * Output is deterministic, so an unchanged rule set never changes the files. A rule imported from
 * a file is not written back into that file: the file already states it in the user's own words.
 */

/** Instruction files Mindly writes rules into, in the order they are listed. */
export const RULES_FILE_CANDIDATES: readonly string[] = Object.freeze([
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
]);

const MAX_FILE_BYTES = 1024 * 1024;
const BODY_CHARS = 280;

/** Why a file was left alone. */
export type RulesFileSkip =
  | 'outside_project'
  | 'not_markdown'
  | 'denied'
  | 'broken_link'
  | 'unreadable'
  | 'damaged'
  | 'changed'
  | 'unwritable';

/** What syncing (or removing) the rules section does to one file. */
export interface RulesFileChange {
  /** File name as configured, relative to the checkout (e.g. CLAUDE.md). */
  path: string;
  /** Checkout-relative file actually written; differs from `path` when it is a symlink. */
  target: string;
  /** Other configured names that point at the same file. */
  aliases: string[];
  /** Current content; null when the file does not exist. */
  previous: string | null;
  /** New content; null when the file is deleted. Equal to `previous` when nothing changes. */
  next: string | null;
  /** The section was changed outside Mindly since Mindly last wrote it; the change is replaced. */
  edited: boolean;
  skipped: RulesFileSkip | null;
}

/** A checkout (repository root or linked worktree) with rules sync on. */
export interface RulesFileCheckout {
  projectId: string;
  root: string;
}

/** Per-checkout state, stored in Mindly's database (never in the repository). */
interface CheckoutState {
  files: string[];
  /** Files Mindly created; removing the section deletes them when nothing else is left. */
  created: string[];
  /** Files that had no final line break before Mindly appended the section. */
  noFinalNewline: string[];
  /** sha256 of the section Mindly last wrote, by target path. */
  written: Record<string, string>;
}

interface RulesFileState {
  checkouts: Record<string, CheckoutState>;
}

const stateKey = (projectId: string): string => `rules-file:${projectId}`;
const emptyCheckout = (): CheckoutState => ({
  files: [],
  created: [],
  noFinalNewline: [],
  written: {},
});

/** Imported-rule bodies that only record where the rule came from. */
const IMPORTED = /(?:^|\n\n)Imported from [^\n]*, line \d+\.$/;
/** Captured-rule bodies that only quote the prompt the rule came from. */
const STATED = /^Stated by the user in an? \S+ session: /;

/**
 * One rule as a Markdown bullet: the title, then the body on the same line when it adds
 * something, as in the context agents receive. Provenance-only bodies are left out.
 */
export function ruleLine(rule: Memory): string {
  const title = sanitizeLine(rule.title, 160);
  let body = rule.body;
  if (STATED.test(body)) body = '';
  if (IMPORTED.test(body)) {
    body = body.replace(IMPORTED, '');
    // A long imported rule keeps its full text in the body and a shortened title.
    if (title.endsWith('…') && body.startsWith(title.slice(0, -1)))
      return `- ${escape(oneLine(body, 1000))}`;
  }
  const text = oneLine(body, BODY_CHARS);
  return `- ${escape(title)}${text && text !== title ? ` — ${escape(text)}` : ''}`;
}

function oneLine(text: string, max: number): string {
  return sanitizeForContext(text, max)
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

/** Keeps rule text from opening or closing an HTML comment (and so from ending the section). */
function escape(text: string): string {
  return text.replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;');
}

/**
 * Renders the managed section (markers included, no trailing line break) for `rules`. `omitted`
 * counts approved rules left out because the file already states them.
 */
export function renderRulesSection(rules: readonly Memory[], eol = '\n', omitted = 0): string {
  const groups = new Map<string, Memory[]>();
  for (const r of rules) {
    const key = [...r.scope.paths].sort().join('\n');
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const lines = [
    RULES_START,
    '## Project rules',
    '',
    '<!-- Managed by Mindly. Edit rules with `mindly rules` or in Mission Control; changes made here are replaced. -->',
    '',
  ];
  if (rules.length === 0) {
    lines.push(
      omitted > 0
        ? '_Every approved rule is already written elsewhere in this file._'
        : '_No approved rules yet._',
      '',
    );
  }
  for (const key of [...groups.keys()].sort(compareText)) {
    if (key !== '') {
      const globs = key.split('\n').map((g) => `\`${g.replace(/`/g, "'")}\``);
      lines.push(`### When working on ${globs.join(', ')}`, '');
    }
    const sorted = [...(groups.get(key) ?? [])].sort(
      (a, b) => compareText(a.title, b.title) || compareText(a.id, b.id),
    );
    for (const r of sorted) lines.push(ruleLine(r));
    lines.push('');
  }
  lines.push(RULES_END);
  return lines.join(eol);
}

/** Locale-independent ordering, so every machine renders the same file. */
function compareText(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x !== y) return x < y ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

interface Target {
  path: string;
  abs: string;
  target: string;
  aliases: string[];
  skipped: RulesFileSkip | null;
}

export class RulesFileService {
  constructor(
    private readonly k: Kernel,
    private readonly memory: MemoryService,
  ) {}

  /** The files rules are kept in for this checkout, or null when sync is off there. */
  enabledFiles(projectId: string, root: string): string[] | null {
    return this.state(projectId)?.checkouts[root]?.files ?? null;
  }

  /** Every checkout, in every project, with rules sync on. */
  enabledCheckouts(): RulesFileCheckout[] {
    const out: RulesFileCheckout[] = [];
    for (const p of this.k.store.projects.list()) {
      for (const root of Object.keys(this.state(p.id)?.checkouts ?? {}).sort()) {
        out.push({ projectId: p.id, root });
      }
    }
    return out;
  }

  /**
   * The instruction files a checkout uses: those of {@link RULES_FILE_CANDIDATES} that exist, or
   * AGENTS.md when there is none.
   */
  defaultFiles(root: string): string[] {
    const found = RULES_FILE_CANDIDATES.filter((f) => {
      try {
        lstatSync(join(root, f));
        return true;
      } catch {
        return false;
      }
    });
    return found.length > 0 ? found : ['AGENTS.md'];
  }

  /**
   * The rules written to the files: active, branch-independent rules the user approved explicitly
   * (see {@link MemoryService.userApprovedIds}). Rules auto-approved from a prompt's wording reach
   * connected agents but are never committed to the repository until the user approves them.
   */
  rules(projectId: string): Memory[] {
    return this.partition(projectId).synced;
  }

  /** Approved rules left out of the files because the user has not approved them explicitly. */
  awaitingApproval(projectId: string): Memory[] {
    return this.partition(projectId).awaiting;
  }

  private partition(projectId: string): { synced: Memory[]; awaiting: Memory[] } {
    const approved = this.memory
      .list(projectId, {
        kinds: ['rule'],
        trust: ['approved', 'verified'],
        status: 'active',
        limit: 1000,
      })
      .filter((m) => m.scope.branch === null);
    const explicit = this.memory.userApprovedIds(projectId);
    return {
      synced: approved.filter((m) => explicit.has(m.id)),
      awaiting: approved.filter((m) => !explicit.has(m.id)),
    };
  }

  /**
   * What `mindly rules sync` would write in the checkout at `root`: the files already in use plus
   * the checkout's instruction files (see {@link defaultFiles}). Writes nothing.
   */
  planSync(projectId: string, root: string): RulesFileChange[] {
    return this.plan(projectId, root, 'sync', this.syncFiles(projectId, root));
  }

  /** What turning sync off in a checkout would write: the section removed from every file. */
  planRemove(projectId: string, root: string): RulesFileChange[] {
    const files = new Set([
      ...(this.enabledFiles(projectId, root) ?? []),
      ...RULES_FILE_CANDIDATES,
    ]);
    return this.plan(projectId, root, 'remove', [...files]);
  }

  /** Writes the rules into the checkout's files and keeps them updated from now on. */
  sync(projectId: string, root: string): RulesFileChange[] {
    return this.apply(projectId, root, 'sync', this.planSync(projectId, root));
  }

  /** Removes the section from the checkout's files and turns sync off there. */
  remove(projectId: string, root: string): RulesFileChange[] {
    const changes = this.apply(projectId, root, 'remove', this.planRemove(projectId, root));
    const state = this.state(projectId);
    if (state) {
      state.checkouts = Object.fromEntries(
        Object.entries(state.checkouts).filter(([r]) => r !== root),
      );
      if (Object.keys(state.checkouts).length === 0) this.k.store.kv.delete(stateKey(projectId));
      else this.k.store.kv.set(stateKey(projectId), state);
    }
    return changes;
  }

  /**
   * Rewrites the section in every checkout with sync on after a rule changed. Only files that
   * still exist are written (a file the user deleted stays deleted). Never throws.
   */
  refresh(projectId: string): RulesFileChange[] {
    const out: RulesFileChange[] = [];
    try {
      const state = this.state(projectId);
      for (const [root, checkout] of Object.entries(state?.checkouts ?? {})) {
        const files = checkout.files.filter((f) => existsSync(join(root, f)));
        if (files.length === 0) continue;
        const changes = this.apply(
          projectId,
          root,
          'sync',
          this.plan(projectId, root, 'sync', files),
        );
        for (const c of changes) {
          if (c.edited) {
            this.k.logger.warn('replaced hand edits in the Mindly rules section', {
              file: c.target,
            });
          }
          if (c.skipped === 'changed' || c.skipped === 'unwritable') {
            this.k.logger.warn('rules file not updated', { file: c.target, reason: c.skipped });
          }
        }
        out.push(...changes);
      }
    } catch (err) {
      this.k.logger.warn('rules file sync failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return out;
  }

  private syncFiles(projectId: string, root: string): string[] {
    const kept = (this.enabledFiles(projectId, root) ?? []).filter((f) =>
      existsSync(join(root, f)),
    );
    return [...new Set([...kept, ...this.defaultFiles(root)])];
  }

  private state(projectId: string): RulesFileState | null {
    return this.k.store.kv.get<RulesFileState>(stateKey(projectId));
  }

  /** Files each imported rule came from (checkout-relative), by rule id. */
  private importedFrom(rules: readonly Memory[]): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const r of rules) {
      if (!r.tags.includes('imported')) continue;
      out.set(r.id, new Set(this.k.store.memories.evidenceFor(r.id).map((e) => e.ref)));
    }
    return out;
  }

  private plan(
    projectId: string,
    root: string,
    mode: 'sync' | 'remove',
    files: string[],
  ): RulesFileChange[] {
    const checkout = this.state(projectId)?.checkouts[root];
    const rules = mode === 'sync' ? this.rules(projectId) : [];
    const sources = this.importedFrom(rules);
    const out: RulesFileChange[] = [];
    for (const t of this.targets(root, files)) {
      const base = { path: t.path, target: t.target, aliases: t.aliases, edited: false };
      if (t.skipped) {
        // Mindly never wrote to a file it cannot write: there is nothing to remove there.
        if (mode === 'remove') continue;
        out.push({ ...base, previous: null, next: null, skipped: t.skipped });
        continue;
      }
      const previous = readText(t.abs);
      if (previous === undefined) {
        out.push({ ...base, previous: null, next: null, skipped: 'unreadable' });
        continue;
      }
      const bounds = previous === null ? null : findSection(previous);
      if (bounds === 'damaged') {
        out.push({ ...base, previous, next: previous, skipped: 'damaged' });
        continue;
      }
      if (mode === 'remove') {
        if (previous === null || bounds === null) continue;
        let rest = removeSection(previous, bounds);
        if (checkout?.noFinalNewline.includes(t.target)) rest = rest.replace(/\r?\n$/, '');
        const created = checkout?.created.includes(t.target) ?? false;
        out.push({ ...base, previous, next: rest === '' && created ? null : rest, skipped: null });
        continue;
      }
      const names = new Set([t.target, t.path, ...t.aliases]);
      const kept = rules.filter((r) => ![...(sources.get(r.id) ?? [])].some((f) => names.has(f)));
      if (bounds === null && kept.length === 0 && rules.length > 0) {
        // Every rule is already written in this file: a section would only say so. An existing
        // section is kept (with that note) until sync is turned off.
        out.push({ ...base, previous, next: previous, skipped: null });
        continue;
      }
      const section = renderRulesSection(kept, eolOf(previous ?? ''), rules.length - kept.length);
      const current = bounds ? (previous ?? '').slice(bounds.start, bounds.end) : null;
      const edited =
        current !== null && current !== section && sha256(current) !== checkout?.written[t.target];
      out.push({
        ...base,
        previous,
        next: writeSection(previous ?? '', section, bounds),
        edited,
        skipped: null,
      });
    }
    return out;
  }

  private apply(
    projectId: string,
    root: string,
    mode: 'sync' | 'remove',
    changes: RulesFileChange[],
  ): RulesFileChange[] {
    const state: RulesFileState = this.state(projectId) ?? { checkouts: {} };
    const checkout = state.checkouts[root] ?? emptyCheckout();
    const out: RulesFileChange[] = [];
    for (const planned of changes) {
      let c = planned;
      if (!c.skipped && c.next !== c.previous) {
        const abs = join(root, c.target);
        try {
          // Something else wrote the file since it was read: leave it for the next sync.
          if (readText(abs) !== c.previous) throw new Changed();
          if (c.next === null) unlinkSync(abs);
          else writeAtomic(abs, c.next);
          if (c.previous === null) checkout.created = [...new Set([...checkout.created, c.target])];
          if (
            mode === 'sync' &&
            c.previous &&
            !c.previous.endsWith('\n') &&
            findSection(c.previous) === null
          ) {
            checkout.noFinalNewline = [...new Set([...checkout.noFinalNewline, c.target])];
          }
        } catch (err) {
          c = {
            ...c,
            next: c.previous,
            edited: false,
            skipped: err instanceof Changed ? 'changed' : 'unwritable',
          };
        }
      }
      if (mode === 'sync' && !c.skipped && c.next !== null) {
        const bounds = findSection(c.next);
        if (bounds && bounds !== 'damaged') {
          checkout.written[c.target] = sha256(c.next.slice(bounds.start, bounds.end));
        }
      }
      out.push(c);
    }
    if (mode === 'sync') {
      const files = out.filter((c) => c.skipped === null).map((c) => c.path);
      checkout.files = [...new Set([...checkout.files, ...files])];
      state.checkouts[root] = checkout;
      this.k.store.kv.set(stateKey(projectId), state);
    }
    return out;
  }

  /**
   * Resolves file names to the files written. A symlink (CLAUDE.md -> AGENTS.md is common) is
   * written through to its target inside the checkout, and each real file is written once.
   */
  private targets(root: string, files: readonly string[]): Target[] {
    const deny = this.k.config.redaction.denyPaths;
    const out: Target[] = [];
    for (const path of files) {
      const abs = join(root, path);
      let skipped: RulesFileSkip | null = null;
      let link = false;
      try {
        link = lstatSync(abs).isSymbolicLink();
        if (link) statSync(abs);
      } catch {
        if (link) skipped = 'broken_link';
      }
      const resolved = skipped ? null : tryResolveInsideRoot(root, abs);
      if (!skipped && !resolved) skipped = 'outside_project';
      const target = resolved?.rel ?? path;
      if (!skipped && !/\.md$/i.test(target)) skipped = 'not_markdown';
      if (!skipped && isDeniedPath(target, deny)) skipped = 'denied';
      const same = out.find((t) => t.skipped === null && t.target === target);
      if (!skipped && same) {
        same.aliases.push(path);
        continue;
      }
      out.push({ path, abs: resolved?.abs ?? abs, target, aliases: [], skipped });
    }
    return out;
  }
}

class Changed extends Error {}

/**
 * Replaces a file through a temporary file in the same directory and a rename, so a crash or a
 * full disk never leaves it half written. An existing file keeps its permissions.
 */
function writeAtomic(abs: string, text: string): void {
  let mode: number | null = null;
  try {
    mode = statSync(abs).mode & 0o7777;
  } catch {
    // A new file gets the default permissions.
  }
  const tmp = join(dirname(abs), `.${basename(abs)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, text, { flag: 'wx' });
    if (mode !== null) chmodSync(tmp, mode);
    renameSync(tmp, abs);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** UTF-8 text of a file; null when it does not exist, undefined when it cannot be rewritten. */
function readText(abs: string): string | null | undefined {
  let buf: Buffer;
  try {
    const st = statSync(abs);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return undefined;
    buf = readFileSync(abs);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
  }
  // UTF-16 files are read for import but not rewritten: Mindly writes UTF-8 only.
  if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) {
    return undefined;
  }
  return decodeText(buf) ?? undefined;
}

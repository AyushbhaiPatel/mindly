import { readFileSync, statSync } from 'node:fs';
import {
  globToRegExp,
  hasUnsafeChars,
  invalidInput,
  isDeniedPath,
  isRepoFileSource,
  normalizeLine,
  redactText,
  sanitizeForContext,
  sanitizeLine,
  sha256,
  MindlyError,
  tryResolveInsideRoot,
  type Memory,
  type MemoryEvidence,
  type MemoryKind,
  type MemorySource,
  type Trust,
} from '@mindly/core';
import type { MemoryFilter, MemoryPatch, MemorySearchHit } from '@mindly/store';
import type { Kernel } from '../kernel.js';
import { stripManagedSection } from './managed-section.js';

export const MAX_TITLE = 160;
export const MAX_BODY = 4000;
/** Minimum normalised excerpt length for evidence to count as verification. */
export const MIN_VERIFY_EXCERPT = 20;
const MAX_EVIDENCE_FILE_BYTES = 512 * 1024;

export interface EvidenceInput {
  /** Project-relative or absolute path inside the project. */
  path: string;
  /** Text the memory relies on; must currently exist in the file. */
  excerpt?: string;
}

export interface RememberInput {
  projectId: string;
  projectRoot: string;
  kind: MemoryKind;
  title: string;
  body: string;
  tags?: string[];
  scopePaths?: string[];
  branch?: string | null;
  source: MemorySource;
  /** Requested trust; clamped by `clampTrust` according to the source. */
  trust?: Trust;
  enforce?: boolean;
  pinned?: boolean;
  evidence?: EvidenceInput[];
  reason?: string | null;
}

/**
 * What {@link MemoryService.rememberResult} did. Every `kept_` outcome leaves the memory exactly as
 * it was and attaches nothing to it; apart from `kept_rejected`, the occurrence is recorded.
 *
 * - `kept_rejected`: the user rejected a memory with this title.
 * - `kept_approved`: the user approved a memory with this title.
 * - `kept_user_decision`: the user pinned or enforced the memory. Only the user changes it.
 *
 * `updated` from an agent means it changed a memory its own kind proposed. Its trust is worked out
 * again from the evidence given, as for a new memory, so a verified or stale fact can be corrected.
 * - `kept_other_author`: a different agent proposed a memory with this title.
 *
 * Callers that go on to approve, enforce, announce or link the result must do so only for
 * `created` and `updated`: a kept memory is someone else's.
 */
export type RememberOutcome =
  | 'created'
  | 'updated'
  | 'kept_approved'
  | 'kept_rejected'
  | 'kept_user_decision'
  | 'kept_other_author';

/** Why a source other than the user may not change a memory (see {@link agentLock}). */
type AgentLock = 'rejected' | 'approved' | 'decided' | 'other_author';

/**
 * Whether `by`, a source other than the user, may change `m`; null when it may. Once the user
 * approved, rejected, pinned, enforced or archived a memory (states only the user sets), it is the
 * user's. Otherwise the agent kind that proposed it may change it, including when the code has
 * marked it verified or stale: those say whether its evidence still matches, not that its text is
 * right, and its author must be able to correct it. `takesOver` (a repository file restating an
 * agent's proposal) lifts only the author check. The one rule behind both
 * {@link MemoryService.rememberResult} and {@link MemoryService.update}.
 */
function agentLock(m: Memory, by: MemorySource, takesOver = false): AgentLock | null {
  if (m.trust === 'rejected') return 'rejected';
  if (m.trust === 'approved') return 'approved';
  if (m.status !== 'active' || m.enforce || m.pinned) return 'decided';
  return takesOver || sameAuthor(m.source, by) ? null : 'other_author';
}

const KEPT: Record<AgentLock, RememberOutcome> = {
  rejected: 'kept_rejected',
  approved: 'kept_approved',
  decided: 'kept_user_decision',
  other_author: 'kept_other_author',
};

/** Evidence rows one memory keeps. */
const MAX_EVIDENCE_ROWS = 20;

/** Whose word wins when two sources write the same title: the user, then a repository file. */
function authority(source: MemorySource): number {
  if (source.type === 'user') return 3;
  return isRepoFileSource(source) ? 2 : 1;
}

/** How long one `restated` event stands for every restatement by the same session. */
const RESTATED_WINDOW_MS = 60 * 60 * 1000;

/** Evidence that passed {@link MemoryService.checkEvidence}. */
interface CheckedEvidence {
  rel: string;
  excerpt: string | null;
  hash: string | null;
}

/** Whether two sources are the same author: the user, the system, or agents of one kind. */
function sameAuthor(a: MemorySource, b: MemorySource): boolean {
  return a.type === b.type && a.agentKind === b.agentKind;
}

export interface RememberResult {
  memory: Memory;
  outcome: RememberOutcome;
}

/**
 * Agents can only ever propose. Users approve. Code-derived facts are verified. Nobody but the
 * user can create an `enforce` rule. This is the core of the trust layer (see docs/security.md).
 */
export function clampTrust(source: MemorySource, requested: Trust | undefined): Trust {
  switch (source.type) {
    case 'user':
      return requested === 'rejected' || requested === 'stale'
        ? requested
        : (requested ?? 'approved');
    case 'code':
      return 'verified';
    case 'agent':
    case 'system':
      return requested === 'stale' ? 'stale' : 'proposed';
  }
}

export function cleanTags(tags: readonly string[] | undefined): string[] {
  const out = new Set<string>();
  for (const t of tags ?? []) {
    const tag = t
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    if (tag) out.add(tag);
    if (out.size >= 12) break;
  }
  return [...out];
}

export function cleanScopePaths(paths: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of paths ?? []) {
    const p = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (
      !p ||
      p.startsWith('/') ||
      p.split('/').includes('..') ||
      p.length > 300 ||
      hasUnsafeChars(p)
    ) {
      throw invalidInput('scope paths must be project-relative globs');
    }
    try {
      globToRegExp(p);
    } catch {
      throw invalidInput(`invalid scope glob: ${p.slice(0, 60)}`);
    }
    out.push(p);
    if (out.length >= 20) break;
  }
  return out;
}

export class MemoryService {
  private readonly ruleListeners: ((projectId: string) => void)[] = [];
  private readonly updateListeners: ((
    memory: Memory,
    previous: Memory,
    by: MemorySource,
  ) => void)[] = [];
  private batchDepth = 0;
  private readonly pendingRuleChanges = new Set<string>();

  constructor(private readonly k: Kernel) {}

  /** Calls `fn` with the project id after any rule of that project is created or changed. */
  onRulesChanged(fn: (projectId: string) => void): void {
    this.ruleListeners.push(fn);
  }

  /** Calls `fn` after `update` changed a memory, with the new and the previous version. */
  onUpdated(fn: (memory: Memory, previous: Memory, by: MemorySource) => void): void {
    this.updateListeners.push(fn);
  }

  /** Runs `fn`, reporting rule changes made inside it once per project when it returns. */
  batchRuleChanges<T>(fn: () => T): T {
    this.batchDepth++;
    try {
      return fn();
    } finally {
      this.batchDepth--;
      if (this.batchDepth === 0) {
        const projects = [...this.pendingRuleChanges];
        this.pendingRuleChanges.clear();
        for (const p of projects) this.notifyRules(p);
      }
    }
  }

  private rulesChanged(m: Memory): void {
    if (m.kind !== 'rule') return;
    if (this.batchDepth > 0) this.pendingRuleChanges.add(m.projectId);
    else this.notifyRules(m.projectId);
  }

  private notifyRules(projectId: string): void {
    for (const fn of this.ruleListeners) {
      try {
        fn(projectId);
      } catch (err) {
        this.k.logger.warn('rule change listener failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private clean(text: string, max: number): string {
    return sanitizeForContext(
      redactText(text, { extraPatterns: this.k.config.redaction.extraPatterns }),
      max,
    );
  }

  /**
   * Stores a memory. If an active memory of the same kind with the same normalised title already
   * exists, it is updated as a new version instead of creating a duplicate. Callers that must tell
   * the author when nothing was stored use {@link rememberResult}.
   */
  remember(input: RememberInput): Memory {
    return this.rememberResult(input).memory;
  }

  /** {@link remember}, also saying what happened to the memory (see {@link RememberOutcome}). */
  rememberResult(input: RememberInput): RememberResult {
    const title = sanitizeLine(
      redactText(input.title, { extraPatterns: this.k.config.redaction.extraPatterns }),
      MAX_TITLE,
    );
    const body = this.clean(input.body, MAX_BODY);
    if (!title) throw invalidInput('memory title is empty');
    const tags = cleanTags(input.tags);
    const scopePaths = cleanScopePaths(input.scopePaths);
    let trust = clampTrust(input.source, input.trust);
    const enforce = input.source.type === 'user' && input.kind === 'rule' && input.enforce === true;
    const evidence = (input.evidence ?? [])
      .slice(0, 10)
      .map((e) => this.checkEvidence(input.projectRoot, e));
    if (evidence.some((e) => !e.valid)) {
      throw invalidInput('evidence excerpt not found in the referenced file');
    }
    // A fact backed by substantial excerpts that exist in the code is verified. Evidence without an
    // excerpt proves nothing. Rules and decisions are never auto-verified: an excerpt existing does
    // not prove an instruction is legitimate.
    const substantial =
      evidence.length > 0 &&
      evidence.every(
        (e) => e.excerpt !== null && normalizeBlock(e.excerpt).length >= MIN_VERIFY_EXCERPT,
      );
    if (input.kind === 'fact' && substantial && trust === 'proposed') trust = 'verified';

    const existing = this.findSameTitle(input.projectId, input.kind, title, input.branch ?? null);
    // The user outranks a repository file, which outranks an agent: a write from higher up
    // replaces the memory and takes it over, so its text is never left under another name.
    const takesOver = existing !== null && authority(input.source) > authority(existing.source);
    if (existing && input.source.type !== 'user') {
      if (agentLocked(existing) && !takesOver) {
        // Restating a user memory would otherwise let an agent rewrite it while keeping user
        // trust.
        throw new MindlyError(
          'forbidden',
          'a user memory with this title exists; propose the change under a different title',
        );
      }
      // Saying it again changes a memory exactly when `update()` would let this source change
      // it. What the user decided stays decided, and a memory stays in the words of whoever it is
      // attributed to: nobody else puts their text under that name or hangs evidence on it that
      // would later make it go stale. The caller is told, so nothing is dropped unknowingly.
      const lock = agentLock(existing, input.source, takesOver);
      if (lock === 'rejected') return { memory: existing, outcome: 'kept_rejected' };
      if (lock) return { memory: this.restated(existing, input), outcome: KEPT[lock] };
    }
    // A repository file replaces an agent's proposal whole; the agent's version stays in the
    // history. The user's own write keeps what it did not mention, as it always has.
    const replaces = takesOver && input.source.type !== 'user';
    const memory = this.k.store.transaction(() => {
      let m: Memory;
      if (existing) {
        m = this.k.store.memories.update(
          existing.id,
          {
            body,
            tags: replaces ? tags : [...new Set([...existing.tags, ...tags])].slice(0, 12),
            ...(replaces || scopePaths.length ? { scope: { paths: scopePaths } } : {}),
            // Re-stating a memory never downgrades user trust, and never upgrades agent claims.
            trust:
              rankTrust(existing.trust) >= rankTrust(trust) && existing.source.type === 'user'
                ? existing.trust
                : trust,
            ...(takesOver ? { source: input.source } : {}),
            ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
            ...(enforce ? { enforce } : {}),
          },
          input.source,
          input.reason ?? 'restated',
        );
      } else {
        m = this.k.store.memories.create({
          projectId: input.projectId,
          kind: input.kind,
          title,
          body,
          tags,
          scope: { paths: scopePaths, branch: input.branch ?? null },
          trust,
          source: input.source,
          enforce,
          pinned: input.pinned ?? false,
          reason: input.reason ?? null,
        });
      }
      if (takesOver) {
        // The user or a repository file takes the memory over: the evidence of the claim it
        // replaces goes with that claim, and only what the new author gives is attached.
        this.k.store.memories.clearEvidence(m.id);
      } else if (existing) {
        // Its author (the user or the agent kind that proposed it) restates the claim as it
        // stands now. Evidence that no longer holds is not support for it any more: left
        // attached, the next sweep would mark the restated memory stale again. Evidence that
        // still holds stays, with or without new evidence given.
        const root = this.k.store.projects.get(input.projectId).root;
        const deny = this.k.config.redaction.denyPaths;
        for (const e of this.k.store.memories.evidenceFor(m.id)) {
          if (evidenceState(root, deny, e) === 'invalid') {
            this.k.store.memories.deleteEvidence(e.id);
          }
        }
      }
      this.attachEvidence(m.id, input.projectId, evidence);
      this.k.store.events.append({
        projectId: input.projectId,
        sessionId: input.source.sessionId,
        type: existing ? 'memory.updated' : 'memory.created',
        payload: {
          memoryId: m.id,
          kind: m.kind,
          title: m.title,
          trust: m.trust,
          source: m.source.type,
        },
      });
      return m;
    });
    this.rulesChanged(memory);
    return { memory, outcome: existing ? 'updated' : 'created' };
  }

  /**
   * Records that a memory was stated again by someone who may not change it. The memory itself is
   * untouched, and no evidence is attached to it: a memory goes stale when any of its evidence
   * stops matching, so evidence from someone else would let them take it out of circulation by
   * pointing it at a line that is bound to change. The trace is a `restated` event, at most one
   * per memory and session in {@link RESTATED_WINDOW_MS}, so a command failing in a loop does not
   * fill the event log.
   */
  private restated(existing: Memory, input: RememberInput): Memory {
    this.k.store.transaction(() => {
      const noted = this.k.store.events
        .query(input.projectId, {
          types: ['memory.updated'],
          since: this.k.clock.now() - RESTATED_WINDOW_MS,
          order: 'desc',
          limit: 1000,
        })
        .some(
          (e) =>
            e.sessionId === input.source.sessionId &&
            e.payload['memoryId'] === existing.id &&
            e.payload['restated'] === true,
        );
      if (noted) return;
      this.k.store.events.append({
        projectId: input.projectId,
        sessionId: input.source.sessionId,
        type: 'memory.updated',
        payload: {
          memoryId: existing.id,
          kind: existing.kind,
          title: existing.title,
          trust: existing.trust,
          source: existing.source.type,
          restated: true,
          reason: input.reason ?? 'restated',
        },
      });
    });
    return existing;
  }

  /**
   * Adds file evidence to a memory. A row it already has is skipped: the same file and excerpt,
   * or an excerpt that is part of one it already holds for that file. A memory keeps its newest
   * {@link MAX_EVIDENCE_ROWS} rows, so restating it with ever different excerpts cannot grow it
   * without bound.
   */
  private attachEvidence(
    memoryId: string,
    projectId: string,
    evidence: readonly CheckedEvidence[],
  ): void {
    if (evidence.length === 0) return;
    const repo = this.k.store.memories;
    const have = repo.evidenceFor(memoryId).map((e) => ({
      id: e.id,
      ref: e.ref,
      hash: e.contentHash,
      text: e.excerpt === null ? null : normalizeBlock(e.excerpt),
    }));
    for (const e of evidence) {
      const text = e.excerpt === null ? null : normalizeBlock(e.excerpt);
      const at = have.findIndex(
        (h) =>
          h.ref === e.rel &&
          (h.hash === e.hash || (text !== null && h.text !== null && h.text.includes(text))),
      );
      if (at >= 0) {
        // Stated again: the row counts as new, so trimming below never drops what was just said.
        const [known] = have.splice(at, 1);
        if (known) {
          repo.touchEvidence(known.id);
          have.push(known);
        }
        continue;
      }
      const row = repo.addEvidence({
        memoryId,
        projectId,
        type: 'file',
        ref: e.rel,
        excerpt: e.excerpt,
        contentHash: e.hash,
      });
      have.push({ id: row.id, ref: e.rel, hash: e.hash, text });
    }
    for (const old of have.slice(0, Math.max(0, have.length - MAX_EVIDENCE_ROWS))) {
      repo.deleteEvidence(old.id);
    }
  }

  /** The active memory of `kind` with the same normalised title on `branch`, if any. */
  findSameTitle(
    projectId: string,
    kind: MemoryKind,
    title: string,
    branch: string | null,
  ): Memory | null {
    const norm = normalizeTitle(title);
    return this.k.store.memories.findByTitle(
      projectId,
      kind,
      branch,
      (other) => normalizeTitle(other) === norm,
    );
  }

  /** Validates a piece of file evidence: path containment, deny-list, size, and excerpt presence. */
  checkEvidence(
    projectRoot: string,
    e: EvidenceInput,
  ): { rel: string; excerpt: string | null; hash: string | null; valid: boolean } {
    const resolved = tryResolveInsideRoot(projectRoot, e.path);
    if (!resolved)
      throw new MindlyError('path_outside_project', 'evidence path is outside the project');
    if (isDeniedPath(resolved.rel, this.k.config.redaction.denyPaths)) {
      throw new MindlyError('forbidden', 'evidence path is on the deny-list');
    }
    const excerpt = e.excerpt ? e.excerpt.slice(0, 2000) : null;
    if (!excerpt) {
      // Without an excerpt the file itself is the evidence, so it has to be there.
      if (!isFile(resolved.abs)) throw invalidInput('evidence file does not exist in the project');
      return { rel: resolved.rel, excerpt: null, hash: null, valid: true };
    }
    const content = readBounded(resolved.abs);
    const normExcerpt = normalizeBlock(excerpt);
    const valid =
      content !== null && normalizeBlock(stripManagedSection(content)).includes(normExcerpt);
    return {
      rel: resolved.rel,
      excerpt: this.clean(excerpt, 2000),
      hash: sha256(normExcerpt),
      valid,
    };
  }

  update(
    id: string,
    patch: MemoryPatch,
    by: MemorySource,
    reason: string | null,
    record = false,
  ): Memory {
    const cur = this.k.store.memories.get(id);
    const clean: MemoryPatch = { ...patch };
    if (patch.title !== undefined) clean.title = sanitizeLine(redactText(patch.title), MAX_TITLE);
    if (patch.body !== undefined) clean.body = this.clean(patch.body, MAX_BODY);
    if (patch.tags !== undefined) clean.tags = cleanTags(patch.tags);
    if (patch.scope?.paths !== undefined) {
      clean.scope = { ...patch.scope, paths: cleanScopePaths(patch.scope.paths) };
    }
    // Who a memory is attributed to changes only when a higher authority restates it.
    delete clean.source;
    if (by.type !== 'user') {
      if (agentLocked(cur)) throw new MindlyError('forbidden', 'agents cannot edit user memories');
      // An agent may refine or archive what its own kind proposed (from any of its sessions) while
      // nobody has settled it (see agentLock). This is refused out loud: a dropped field would
      // look like success to the caller.
      if (agentLock(cur, by)) {
        throw new MindlyError(
          'forbidden',
          'agents can only change memories they proposed that the user has not decided on',
        );
      }
      // Trust and enforcement are never an agent's to set.
      delete clean.trust;
      delete clean.enforce;
      delete clean.pinned;
    }
    if (clean.enforce && cur.kind !== 'rule') delete clean.enforce;
    const m = this.k.store.memories.update(id, clean, by, reason, record && by.type === 'user');
    this.k.store.events.append({
      projectId: m.projectId,
      sessionId: by.sessionId,
      type: m.status === 'archived' ? 'memory.archived' : 'memory.updated',
      payload: { memoryId: m.id, version: m.version, trust: m.trust, reason },
    });
    this.rulesChanged(m);
    for (const fn of this.updateListeners) {
      try {
        fn(m, cur, by);
      } catch (err) {
        this.k.logger.warn('memory update listener failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return m;
  }

  /**
   * The user's explicit approval. Always recorded as a version written by the user, even when the
   * memory was approved already (a rule captured from a prompt), because rules file sync only
   * writes rules the user approved this way (see {@link userApprovedIds}).
   */
  approve(id: string): Memory {
    return this.update(id, { trust: 'approved' }, USER, 'approved by user', true);
  }

  /**
   * Ids of the project's memories the user approved explicitly: added or approved with the CLI,
   * in Mission Control or by confirming an import, as opposed to auto-approved from a prompt.
   */
  userApprovedIds(projectId: string): Set<string> {
    return this.k.store.memories.userApprovedIds(projectId);
  }

  reject(id: string): Memory {
    return this.update(id, { trust: 'rejected' }, USER, 'rejected by user');
  }

  archive(id: string, by: MemorySource = USER): Memory {
    return this.update(id, { status: 'archived' }, by, 'archived');
  }

  /** Marks a memory stale (self-healing); keeps it for history but stops presenting it as true. */
  markStale(id: string, reason: string): Memory {
    const m = this.k.store.memories.update(id, { trust: 'stale' }, SYSTEM, reason);
    this.k.store.events.append({
      projectId: m.projectId,
      sessionId: null,
      type: 'memory.stale',
      payload: { memoryId: m.id, title: m.title, reason },
    });
    this.rulesChanged(m);
    return m;
  }

  /** Hard delete (explicit user action). */
  forget(id: string): void {
    const m = this.k.store.memories.get(id);
    this.k.store.memories.delete(id);
    this.k.store.events.append({
      projectId: m.projectId,
      sessionId: null,
      type: 'memory.archived',
      payload: { memoryId: id, deleted: true },
    });
    this.rulesChanged(m);
  }

  search(projectId: string, query: string, filter: MemoryFilter = {}): MemorySearchHit[] {
    return this.k.store.memories.search(projectId, query, {
      trust: ['verified', 'approved', 'proposed'],
      ...filter,
    });
  }

  list(projectId: string, filter: MemoryFilter = {}): Memory[] {
    return this.k.store.memories.list(projectId, filter);
  }
}

/**
 * Memories only the user may change: their own, and rules imported from the repository's
 * instruction files (which wait for the user's approval and must not be rewritten by an agent).
 */
function agentLocked(m: Memory): boolean {
  return m.source.type === 'user' || isRepoFileSource(m.source);
}

export const USER: MemorySource = { type: 'user', sessionId: null, agentKind: null };
export const SYSTEM: MemorySource = { type: 'system', sessionId: null, agentKind: null };

export function rankTrust(t: Trust): number {
  return { rejected: 0, stale: 1, proposed: 2, verified: 3, approved: 4 }[t];
}

function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Normalises a multi-line block for excerpt matching (whitespace-insensitive per line). */
export function normalizeBlock(text: string): string {
  return text
    .split(/\r?\n/)
    .map(normalizeLine)
    .filter((l) => l.length > 0)
    .join('\n');
}

const MAX_WINDOW_LINES = 20_000;

/**
 * Decides whether an evidence excerpt is still present in `content`. Matches the normalised
 * stored excerpt as a substring, or (because stored excerpts are redacted/sanitised and may differ
 * from the original) any run of normalised lines whose hash equals the stored content hash.
 */
export function excerptPresent(
  content: string,
  excerpt: string,
  contentHash: string | null,
): boolean {
  const normContent = normalizeBlock(content);
  const normExcerpt = normalizeBlock(excerpt);
  if (normExcerpt.length > 0 && normContent.includes(normExcerpt)) return true;
  if (!contentHash) return false;
  if (normExcerpt.length > 0 && sha256(normExcerpt) === contentHash) {
    // The stored excerpt is the original; the substring test above is authoritative.
    return false;
  }
  const n = Math.max(1, normExcerpt.split('\n').length);
  const lines = normContent.split('\n').slice(0, MAX_WINDOW_LINES);
  for (let i = 0; i + n <= lines.length; i++) {
    if (sha256(lines.slice(i, i + n).join('\n')) === contentHash) return true;
  }
  return false;
}

/**
 * Whether an evidence row still holds, judged exactly as the self-healing sweep judges it, against
 * the same project root: `unknown` when the file cannot be looked at (outside the project, behind
 * a link leaving it, on the deny-list, too large or unreadable), `invalid` when it is gone or no
 * longer holds the excerpt (outside Mindly's own section), `valid` otherwise. Only `invalid`
 * evidence may be dropped.
 */
export function evidenceState(
  projectRoot: string,
  denyPaths: readonly string[],
  e: Pick<MemoryEvidence, 'ref' | 'excerpt' | 'contentHash'>,
): 'valid' | 'invalid' | 'unknown' {
  const p = tryResolveInsideRoot(projectRoot, e.ref);
  if (!p || p.rel === '' || isDeniedPath(p.rel, denyPaths)) return 'unknown';
  if (!isFile(p.abs)) return 'invalid';
  const content = readBounded(p.abs);
  if (content === null) return 'unknown';
  if (e.excerpt === null) return 'valid';
  return excerptPresent(stripManagedSection(content), e.excerpt, e.contentHash)
    ? 'valid'
    : 'invalid';
}

function isFile(abs: string): boolean {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

export function readBounded(abs: string, max = MAX_EVIDENCE_FILE_BYTES): string | null {
  try {
    const st = statSync(abs);
    if (!st.isFile() || st.size > max) return null;
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

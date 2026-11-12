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
  MindlyError,
  tryResolveInsideRoot,
  type Memory,
  type MemoryKind,
  type MemorySource,
  type Trust,
} from '@mindly/core';
import type { MemoryFilter, MemoryPatch, MemorySearchHit } from '@mindly/store';
import type { Kernel } from '../kernel.js';
import { evidenceHash } from './evidence-hash.js';
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
   * exists, it is updated as a new version instead of creating a duplicate.
   */
  remember(input: RememberInput): Memory {
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
    if (existing && agentLocked(existing) && input.source.type !== 'user') {
      // Restating a user memory would otherwise let an agent rewrite it while keeping user trust.
      throw new MindlyError(
        'forbidden',
        'a user memory with this title exists; propose the change under a different title',
      );
    }
    const memory = this.k.store.transaction(() => {
      let m: Memory;
      if (existing) {
        m = this.k.store.memories.update(
          existing.id,
          {
            body,
            tags: [...new Set([...existing.tags, ...tags])].slice(0, 12),
            ...(scopePaths.length ? { scope: { paths: scopePaths } } : {}),
            // Re-stating a memory never downgrades user trust, and never upgrades agent claims.
            trust:
              rankTrust(existing.trust) >= rankTrust(trust) && existing.source.type === 'user'
                ? existing.trust
                : trust,
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
      for (const e of evidence) {
        this.k.store.memories.addEvidence({
          memoryId: m.id,
          projectId: input.projectId,
          type: 'file',
          ref: e.rel,
          excerpt: e.excerpt,
          contentHash: e.hash,
        });
      }
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
    return memory;
  }

  /** The active memory of `kind` with the same normalised title on `branch`, if any. */
  findSameTitle(
    projectId: string,
    kind: MemoryKind,
    title: string,
    branch: string | null,
  ): Memory | null {
    const norm = normalizeTitle(title);
    const candidates = this.k.store.memories.search(projectId, title, { kinds: [kind], limit: 10 });
    for (const { memory } of candidates) {
      if (normalizeTitle(memory.title) === norm && memory.scope.branch === branch) return memory;
    }
    return null;
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
    if (!excerpt) return { rel: resolved.rel, excerpt: null, hash: null, valid: true };
    const content = readBounded(resolved.abs);
    const normExcerpt = normalizeBlock(excerpt);
    const valid =
      content !== null && normalizeBlock(stripManagedSection(content)).includes(normExcerpt);
    return {
      rel: resolved.rel,
      excerpt: this.clean(excerpt, 2000),
      // Describes the text as found when the stored excerpt cannot be looked for as written.
      hash: evidenceHash(normExcerpt, normalizeBlock(this.clean(excerpt, 2000))),
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
    if (patch.title !== undefined) {
      clean.title = sanitizeLine(
        redactText(patch.title, { extraPatterns: this.k.config.redaction.extraPatterns }),
        MAX_TITLE,
      );
    }
    if (patch.body !== undefined) clean.body = this.clean(patch.body, MAX_BODY);
    if (patch.tags !== undefined) clean.tags = cleanTags(patch.tags);
    if (patch.scope?.paths !== undefined) {
      clean.scope = { ...patch.scope, paths: cleanScopePaths(patch.scope.paths) };
    }
    if (by.type !== 'user') {
      // Agents may refine content of their own proposals but cannot change trust or enforcement.
      if (agentLocked(cur)) throw new MindlyError('forbidden', 'agents cannot edit user memories');
      delete clean.trust;
      delete clean.enforce;
      delete clean.pinned;
      if (patch.status === 'archived' && cur.source.sessionId !== by.sessionId) delete clean.status;
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

export function readBounded(abs: string, max = MAX_EVIDENCE_FILE_BYTES): string | null {
  try {
    const st = statSync(abs);
    if (!st.isFile() || st.size > max) return null;
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

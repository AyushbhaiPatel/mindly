import { statSync, type Stats } from 'node:fs';
import { type MemoryEvidence, type Session } from '@mindly/core';
import type { TelepathyService } from '../coordination/telepathy.js';
import type { BusEvents, Kernel } from '../kernel.js';
import { evidenceHash, parseSpan } from '../memory/evidence-hash.js';
import {
  excerptIn,
  isEarlierForm,
  normalizeBlock,
  normFile,
  type ExcerptState,
  type NormFile,
} from '../memory/excerpts.js';
import { stripManagedSection } from '../memory/managed-section.js';
import { readBounded, type MemoryService } from '../memory/service.js';
import type { Mindly } from '../mindly.js';
import {
  attachService,
  guarded,
  liveSessions,
  MAX_FILES_PER_EVENT,
  safeProjectPath,
} from './shared.js';

export {
  EARLIER_FORM_WORK,
  EVIDENCE_SCAN_WORK,
  excerptPresent,
  excerptState,
  excerptWork,
  excerptsPresent,
  excerptsWork,
  type ExcerptState,
} from '../memory/excerpts.js';

const MAX_SWEEP_EVIDENCE = 2000;

/** Outcome of re-checking one evidence row. */
export interface EvidenceCheck {
  evidenceId: string;
  memoryId: string;
  path: string;
  /**
   * `unknown` when the file could not be read (too large, unreadable, denied), or when evidence
   * stored with the earlier kind of hash could not be placed in it.
   */
  state: 'valid' | 'invalid' | 'unknown';
  /** True when this check marked the memory stale. */
  markedStale: boolean;
  /** True when invalid evidence became valid again. */
  restored: boolean;
}

/** Summary of a project-wide sweep. */
export interface SweepResult {
  checked: number;
  invalid: number;
  markedStale: number;
  restored: number;
}

/**
 * Self-healing memory: when a file changes, re-checks every memory whose evidence points at it.
 * Evidence that no longer exists marks the memory `stale` and tells the live sessions. Evidence
 * that reappears is marked valid again, but trust is never restored automatically.
 */
export class SelfHealingService {
  constructor(
    private readonly k: Kernel,
    private readonly memory: MemoryService,
    private readonly telepathy: TelepathyService,
  ) {}

  /** Bus entry point. Never throws. */
  async onFilesChanged(p: BusEvents['files.changed']): Promise<EvidenceCheck[]> {
    const out: EvidenceCheck[] = [];
    for (const f of p.files.slice(0, MAX_FILES_PER_EVENT)) {
      await guarded(this.k, 'self-healing', () => {
        out.push(...this.recheckFile(p.projectId, p.projectRoot, f.path, p.session));
      });
    }
    return out;
  }

  /** Re-checks all evidence rows referencing `path`. `actor` is the session that changed it. */
  recheckFile(
    projectId: string,
    projectRoot: string,
    path: string,
    actor: Session | null,
  ): EvidenceCheck[] {
    const rows = this.k.store.memories.evidenceForFile(projectId, path);
    if (rows.length === 0) return [];
    return this.checkRows(projectId, rows, this.fileReader(projectRoot), actor);
  }

  /**
   * Checks the evidence rows of one file. Whether each excerpt is in the file is looked up for
   * all of them in one pass first. Rows of an earlier form share an allowance of work for the
   * file; they take turns being first, so none is left out every time. Results are in row order.
   */
  private checkRows(
    projectId: string,
    rows: readonly MemoryEvidence[],
    read: (rel: string) => FileState,
    actor: Session | null,
  ): EvidenceCheck[] {
    const first = rows[0];
    if (!first) return [];
    const file = read(first.ref);
    if (file.kind === 'present') {
      file
        .file()
        .prepare(rows.flatMap((e) => (e.excerpt === null ? [] : [normalizeBlock(e.excerpt)])));
    }
    const earlier = rows.filter((e) => isEarlierForm(e));
    const key = `self-healing:turn:${projectId}:${first.ref}`;
    let order = rows;
    let turn = 0;
    if (earlier.length > 1) {
      turn = this.k.store.kv.get<number>(key) ?? 0;
      const shift = turn % earlier.length;
      const rotated = [...earlier.slice(shift), ...earlier.slice(0, shift)];
      order = [...rows.filter((e) => !isEarlierForm(e)), ...rotated];
    } else if (this.k.store.kv.get<number>(key) !== null) {
      // No rows left to take turns.
      this.k.store.kv.delete(key);
    }
    const out = new Map<string, EvidenceCheck>();
    for (const e of order) out.set(e.id, this.check(projectId, e, read, actor));
    if (earlier.length > 1) {
      // The next turn starts with the next row, once this one had work to share.
      const worked =
        (file.kind === 'present' && file.file().spent() > 0) ||
        earlier.some((e) => out.get(e.id)?.state !== 'unknown');
      if (worked) this.k.store.kv.set(key, turn + 1);
    }
    return rows.map((e) => out.get(e.id) as EvidenceCheck);
  }

  /**
   * Re-checks all file evidence of a project (bounded); used by the daemon's periodic sweep.
   * Files are read at most once each.
   */
  sweep(projectId: string, max = MAX_SWEEP_EVIDENCE): SweepResult {
    const project = this.k.store.projects.get(projectId);
    const reader = this.fileReader(project.root);
    const result: SweepResult = { checked: 0, invalid: 0, markedStale: 0, restored: 0 };
    const byFile = new Map<string, MemoryEvidence[]>();
    for (const e of this.k.store.memories.allFileEvidence(projectId, max)) {
      const list = byFile.get(e.ref);
      if (list) list.push(e);
      else byFile.set(e.ref, [e]);
    }
    for (const rows of byFile.values()) {
      for (const c of this.checkRows(projectId, rows, reader, null)) {
        if (c.state === 'unknown') continue;
        result.checked++;
        if (c.state === 'invalid') result.invalid++;
        if (c.markedStale) result.markedStale++;
        if (c.restored) result.restored++;
      }
    }
    return result;
  }

  private fileReader(projectRoot: string): (rel: string) => FileState {
    const cache = new Map<string, FileState>();
    return (rel) => {
      const hit = cache.get(rel);
      if (hit) return hit;
      const state = this.readFile(projectRoot, rel);
      cache.set(rel, state);
      return state;
    };
  }

  private readFile(projectRoot: string, rel: string): FileState {
    const p = safeProjectPath(this.k, projectRoot, rel);
    if (!p) return { kind: 'unreadable' };
    // Taken before the content is read, so it describes no newer file than the one read.
    let st: Stats;
    try {
      st = statSync(p.abs);
    } catch {
      return { kind: 'missing' };
    }
    if (!st.isFile()) return { kind: 'missing' };
    const content = readBounded(p.abs);
    if (content === null) return { kind: 'unreadable' };
    let file: NormFile | null = null;
    return {
      kind: 'present',
      seen: `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`,
      // Rules Mindly wrote into an instruction file are not evidence for those same rules.
      file: () => (file ??= normFile(stripManagedSection(content))),
    };
  }

  /** Where it is kept what a file looked like when a piece of evidence was found gone from it. */
  private goneKey(projectId: string, evidenceId: string): string {
    return `self-healing:gone:${projectId}:${evidenceId}`;
  }

  private check(
    projectId: string,
    e: MemoryEvidence,
    read: (rel: string) => FileState,
    actor: Session | null,
  ): EvidenceCheck {
    const base = { evidenceId: e.id, memoryId: e.memoryId, path: e.ref };
    const file = read(e.ref);
    if (file.kind === 'unreadable') {
      return { ...base, state: 'unknown', markedStale: false, restored: false };
    }
    const goneKey = this.goneKey(projectId, e.id);
    if (file.kind === 'present' && !e.valid && this.k.store.kv.get<string>(goneKey) === file.seen) {
      // Found gone from this very file (same size, times and inode): nothing to look at again.
      // Anything else, an older time or another inode included, is looked at.
      return { ...base, state: 'invalid', markedStale: false, restored: false };
    }
    let found: ExcerptState = 'present';
    if (file.kind !== 'present') {
      found = 'absent';
    } else if (e.excerpt !== null) {
      const content = file.file();
      const look = excerptIn(content, e.excerpt, e.contentHash);
      found = look.state;
      if (look.at) {
        // Evidence of the earliest form found where it was taken from: from now on it is checked
        // by the exact text it was taken from.
        const hash = evidenceHash(
          content.content.slice(look.at.start, look.at.end),
          normalizeBlock(e.excerpt),
        );
        if (parseSpan(hash)) this.k.store.memories.setEvidenceHash(e.id, hash);
      }
    }
    if (found === 'unknown') {
      // Evidence stored in an earlier form that could not be placed, but is not gone either: it
      // stays as it was.
      return { ...base, state: 'unknown', markedStale: false, restored: false };
    }
    const valid = found === 'present';
    this.k.store.memories.markEvidence(e.id, valid);
    if (valid || file.kind !== 'present') this.k.store.kv.delete(goneKey);
    else this.k.store.kv.set(goneKey, file.seen);
    if (valid) {
      return { ...base, state: 'valid', markedStale: false, restored: !e.valid };
    }
    let markedStale = false;
    const m = this.k.store.memories.find(e.memoryId);
    if (m && m.status === 'active' && m.trust !== 'stale' && m.trust !== 'rejected') {
      const reason =
        file.kind === 'missing' ? `${e.ref} was deleted` : `evidence in ${e.ref} changed`;
      const stale = this.memory.markStale(m.id, reason);
      markedStale = true;
      const recipients = liveSessions(this.k, projectId).map((s) => s.id);
      if (actor && !recipients.includes(actor.id)) recipients.push(actor.id);
      if (recipients.length > 0) {
        this.telepathy.send({
          projectId,
          // `from: null` so the acting session is notified as well.
          from: null,
          to: { sessionIds: recipients },
          kind: 'stale_memory',
          priority: 6,
          title: `Memory "${stale.title}" may be outdated because ${e.ref} changed`,
          body: `The ${stale.kind} relied on text in ${e.ref} that is no longer there. It is now marked stale; verify it before relying on it, and update or archive it if it no longer holds.`,
          dedupeKey: `stale:${m.id}:${e.id}`,
        });
      }
    }
    return { ...base, state: 'invalid', markedStale, restored: false };
  }
}

/** A present file is normalised once, when the first evidence row needs it. */
type FileState =
  /** `seen`: size, modification and change times and inode of the file when it was read. */
  | { kind: 'present'; seen: string; file: () => NormFile }
  | { kind: 'missing' }
  | { kind: 'unreadable' };

/** Feature module: re-verifies memory evidence on `files.changed`. */
export const selfHealingModule = (mindly: Mindly): void => {
  const service = attachService(
    mindly,
    'self-healing',
    new SelfHealingService(mindly.kernel, mindly.memory, mindly.telepathy),
  );
  mindly.bus.on('files.changed', 'self-healing', async (p) => {
    await service.onFilesChanged(p);
  });
};

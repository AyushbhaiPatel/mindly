import { existsSync } from 'node:fs';
import { fingerprint, type Conflict, type Session } from '@synapse/core';
import type { TelepathyService } from '../coordination/telepathy.js';
import { sessionLabel } from '../coordination/work.js';
import type { BusEvents, ChangedFile, Kernel } from '../kernel.js';
import { readBounded } from '../memory/service.js';
import type { ExportSurfaceDiff } from '../ports.js';
import type { Synapse } from '../synapse.js';
import { attachService, guarded, liveSessions, MAX_FILES_PER_EVENT, nameList } from './shared.js';

/** Files whose export surface the impact radar analyses. */
export const IMPACT_FILE_RE = /\.(?:[cm]?[jt]sx?|py)$/i;
const MAX_DEPENDENTS = 200;
const RECENT_CHANGES_MS = 2 * 60 * 60_000;
const SYMBOL_RE = /^[\w$.]{1,80}$/;

/** Result of analysing one changed file. */
export interface ImpactReport {
  path: string;
  diff: ExportSurfaceDiff;
  dependents: string[];
  /** Sessions notified, with the files of theirs that are affected. */
  affected: { sessionId: string; files: string[] }[];
  conflict: Conflict | null;
}

/** kv key under which the last known export surface of a file is stored. */
export function surfaceKey(projectId: string, path: string): string {
  return `surface:${projectId}:${path}`;
}

/**
 * Impact radar: notices when an agent changes the exported surface of a module (removed or
 * changed exports) and tells the other live sessions whose work depends on that module.
 */
export class ImpactService {
  constructor(
    private readonly k: Kernel,
    private readonly telepathy: TelepathyService,
  ) {}

  /** Analyses every supported file of a `files.changed` event (bounded). Never throws. */
  async onFilesChanged(p: BusEvents['files.changed']): Promise<ImpactReport[]> {
    const out: ImpactReport[] = [];
    const files = p.files.filter((f) => IMPACT_FILE_RE.test(f.path)).slice(0, MAX_FILES_PER_EVENT);
    for (const f of files) {
      await guarded(this.k, 'impact', async () => {
        const r = await this.analyze(p.projectId, p.projectRoot, p.session, f);
        if (r) out.push(r);
      });
    }
    return out;
  }

  /**
   * Compares the file's current export surface with the last known one and reports the impact.
   * `file.abs` must already be validated (inside the project, not denied); the hook handler does.
   * Returns null when nothing relevant changed.
   */
  async analyze(
    projectId: string,
    projectRoot: string,
    session: Session,
    file: ChangedFile,
  ): Promise<ImpactReport | null> {
    const git = this.k.ports.git;
    let after: Map<string, string> | null;
    if (!existsSync(file.abs)) {
      after = new Map();
    } else {
      const content = readBounded(file.abs);
      if (content === null) return null;
      after = git.exportSurface(content, file.path);
    }
    if (!after) return null;

    const key = surfaceKey(projectId, file.path);
    const stored = this.k.store.kv.get<Record<string, string>>(key);
    let before: Map<string, string> | null;
    if (stored && typeof stored === 'object') {
      before = new Map(Object.entries(stored).filter(([, v]) => typeof v === 'string'));
    } else {
      const head = await git.fileAtRef(projectRoot, 'HEAD', file.path);
      before = head === null ? null : git.exportSurface(head, file.path);
    }
    this.k.store.kv.set(key, Object.fromEntries(after));
    if (!before) return null;

    const raw = git.diffExportSurface(before, after);
    const diff: ExportSurfaceDiff = {
      added: cleanNames(raw.added),
      removed: cleanNames(raw.removed),
      changed: cleanNames(raw.changed),
    };
    if (diff.removed.length === 0 && diff.changed.length === 0) return null;

    const dependents = [
      ...new Set((await git.dependentsOf(projectRoot, file.path)).filter((d) => d !== file.path)),
    ].slice(0, MAX_DEPENDENTS);
    const targets = new Set([file.path, ...dependents]);
    const affected = this.affectedSessions(projectId, session, targets);
    if (affected.length === 0 && dependents.length === 0) {
      return { path: file.path, diff, dependents, affected: [], conflict: null };
    }

    const who = sessionLabel(session);
    const summary = describeDiff(diff);
    const sessionIds = [session.id, ...affected.map((a) => a.session.id)].sort();
    const { conflict, isNew } = this.k.store.conflicts.report({
      projectId,
      kind: 'impact',
      severity: diff.removed.length > 0 ? 'critical' : 'warning',
      title: `${who} changed the exports of ${file.path}`,
      detail: `${summary}. ${dependents.length} file(s) import it${
        dependents.length ? `: ${nameList(dependents, 8)}` : ''
      }.`,
      sessionIds,
      paths: [file.path, ...dependents.slice(0, 50)],
      fingerprint: fingerprint(
        'impact',
        session.id,
        file.path,
        ...diff.removed,
        '|',
        ...diff.changed,
      ),
    });
    if (isNew) {
      this.k.store.events.append({
        projectId,
        sessionId: session.id,
        type: 'conflict.opened',
        payload: { conflictId: conflict.id, kind: conflict.kind, title: conflict.title },
      });
    }
    const diffKey = fingerprint(...diff.removed, '|', ...diff.changed, '|', ...diff.added);
    for (const a of affected) {
      this.send(projectId, session, a.session, file.path, summary, a.files, diffKey, conflict);
    }
    return {
      path: file.path,
      diff,
      dependents,
      affected: affected.map((a) => ({ sessionId: a.session.id, files: a.files })),
      conflict,
    };
  }

  private send(
    projectId: string,
    from: Session,
    to: Session,
    path: string,
    summary: string,
    files: string[],
    diffKey: string,
    conflict: Conflict,
  ): void {
    const theirs = files.filter((f) => f !== path);
    const lines = [`${summary}.`];
    if (theirs.length) lines.push(`Your files that import it: ${nameList(theirs, 10)}.`);
    else lines.push(`You are working on ${path} as well.`);
    lines.push('Re-check usages of these exports before continuing.');
    // The telepathy service sanitises and redacts title and body.
    this.telepathy.send({
      projectId,
      from,
      to: { sessionIds: [to.id] },
      kind: 'impact',
      priority: 7,
      title: `${sessionLabel(from)} changed the exports of ${path}`,
      body: lines.join(' '),
      dedupeKey: `impact:${conflict.id}:${diffKey}`,
    });
  }

  /** Other live sessions whose active intents or recent edits touch any of `targets`. */
  private affectedSessions(
    projectId: string,
    actor: Session,
    targets: ReadonlySet<string>,
  ): { session: Session; files: string[] }[] {
    const since = this.k.clock.now() - RECENT_CHANGES_MS;
    const out: { session: Session; files: string[] }[] = [];
    for (const s of liveSessions(this.k, projectId)) {
      if (s.id === actor.id) continue;
      const files = new Set<string>();
      for (const i of this.k.store.intents.activeForSession(s.id)) {
        for (const f of i.targets.files) if (targets.has(f)) files.add(f);
      }
      for (const c of this.k.store.fileChanges.forSession(s.id, since)) {
        if (targets.has(c.path)) files.add(c.path);
      }
      if (files.size > 0) out.push({ session: s, files: [...files].sort() });
    }
    return out;
  }
}

function cleanNames(names: readonly string[]): string[] {
  return [...new Set(names.filter((n) => SYMBOL_RE.test(n)))].sort().slice(0, 100);
}

/** Human-readable summary of an export-surface diff, symbol names only. */
export function describeDiff(diff: ExportSurfaceDiff): string {
  const parts: string[] = [];
  if (diff.removed.length) parts.push(`Removed: ${nameList(diff.removed)}`);
  if (diff.changed.length) parts.push(`Changed signature: ${nameList(diff.changed)}`);
  if (diff.added.length) parts.push(`Added: ${nameList(diff.added)}`);
  return parts.join('. ') || 'Exports changed';
}

/** Feature module: registers the impact radar on `files.changed`. */
export const impactModule = (synapse: Synapse): void => {
  const service = attachService(
    synapse,
    'impact',
    new ImpactService(synapse.kernel, synapse.telepathy),
  );
  synapse.bus.on('files.changed', 'impact', async (p) => {
    await service.onFilesChanged(p);
  });
};

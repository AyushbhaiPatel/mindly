import { existsSync } from 'node:fs';
import { fingerprint, sha256, type Conflict, type Session } from '@mindly/core';
import type { TelepathyService } from '../coordination/telepathy.js';
import { sessionLabel } from '../coordination/work.js';
import type { BusEvents, ChangedFile, Kernel } from '../kernel.js';
import { readBounded } from '../memory/service.js';
import type { ExportSurfaceDiff } from '../ports.js';
import type { Mindly } from '../mindly.js';
import { attachService, guarded, liveSessions, MAX_FILES_PER_EVENT, nameList } from './shared.js';

/** Files whose export surface the impact radar analyses. */
export const IMPACT_FILE_RE = /\.(?:[cm]?[jt]sx?|py)$/i;
const MAX_DEPENDENTS = 200;
const RECENT_CHANGES_MS = 2 * 60 * 60_000;
const SYMBOL_RE = /^[\w$.]{1,80}$/;
/** Open impact conflicts remembered per file, so they can be closed when the exports come back. */
const MAX_OPEN_PER_FILE = 20;
const MAX_BASELINE_BYTES = 512 * 1024;
/**
 * Version of the signature format the export analysis produces. Bump it whenever a change to the
 * analysis alters the signature of unchanged code (how a class is hashed, how a signature is
 * normalised), and list the kinds it touches in `FORMAT_CHANGES`.
 */
export const SURFACE_FORMAT = 2;

/** What one format changed about the signatures stored by the formats before it. */
interface FormatChange {
  /** Kinds whose signature is written differently: an older one is never comparable. */
  rewritten: readonly string[];
  /**
   * Kinds the analysis now resolves further: an export stored under one of them may be reported
   * under another kind for the same code, so that kind change is not a change.
   */
  resolved: readonly string[];
}

/**
 * Per format, what it changed. Signatures stored by an earlier format are compared with a fresh
 * surface except where listed here; which names exist always is.
 *
 * - 2: class signatures cover constructor parameters and function-valued members; declarations
 *   the analysis could not read before (kind `unknown`) are now read.
 */
const FORMAT_CHANGES: Readonly<Record<number, FormatChange>> = {
  2: { rewritten: ['class'], resolved: ['unknown'] },
};

/**
 * Kind of a stored signature. The git port writes each one as `<kind>:<signature>`; a value
 * without that prefix has no kind and is always compared.
 */
function kindOf(signature: string): string {
  const colon = signature.indexOf(':');
  return colon === -1 ? '' : signature.slice(0, colon);
}

/**
 * What the formats after `from` changed, merged. `null` when `from` is newer than this version
 * knows: nothing stored by it can be compared.
 */
function changesSince(from: number): { rewritten: Set<string>; resolved: Set<string> } | null {
  if (from > SURFACE_FORMAT) return null;
  const rewritten = new Set<string>();
  const resolved = new Set<string>();
  for (let v = from + 1; v <= SURFACE_FORMAT; v++) {
    for (const kind of FORMAT_CHANGES[v]?.rewritten ?? []) rewritten.add(kind);
    for (const kind of FORMAT_CHANGES[v]?.resolved ?? []) resolved.add(kind);
  }
  return { rewritten, resolved };
}

/**
 * Brings signatures stored in format `from` up to the current one. A signature that can no longer
 * be compared takes the current signature of the same export, so it reads as unchanged; a name
 * that is gone, or whose kind really changed, is left alone and still reports as removed or
 * changed.
 */
function migrateSignatures(
  stored: Iterable<[string, string]>,
  from: number,
  current: ReadonlyMap<string, string>,
): Map<string, string> {
  const out = new Map(stored);
  if (from === SURFACE_FORMAT) return out;
  const changes = changesSince(from);
  for (const [name, sig] of out) {
    const now = current.get(name);
    if (now === undefined) continue;
    const kind = kindOf(sig);
    const sameKind = kindOf(now) === kind;
    const stale = changes === null || changes.rewritten.has(kind) ? sameKind : false;
    const furtherResolved = changes !== null && changes.resolved.has(kind) && !sameKind;
    if (stale || furtherResolved) out.set(name, now);
  }
  return out;
}

/**
 * True when a signature stored in format `from` can still show that an export is back as it was.
 * One that the current format writes differently cannot: nothing it is compared with would match
 * for the right reason.
 */
function canShowRestored(signature: string, from: number): boolean {
  if (from === SURFACE_FORMAT) return true;
  const changes = changesSince(from);
  if (changes === null) return false;
  const kind = kindOf(signature);
  return !changes.rewritten.has(kind) && !changes.resolved.has(kind);
}

/** Result of analysing one changed file. */
export interface ImpactReport {
  path: string;
  diff: ExportSurfaceDiff;
  dependents: string[];
  /** Sessions notified, with the files of theirs that are affected. */
  affected: { sessionId: string; files: string[] }[];
  conflict: Conflict | null;
}

/**
 * kv key under which the last known export surface of a file is stored. Each linked worktree has
 * its own copy of the file, so it has its own surface: pass `worktree` for any checkout other than
 * the project's main one.
 */
export function surfaceKey(projectId: string, path: string, worktree?: string): string {
  if (worktree === undefined) return `surface:${projectId}:${path}`;
  return `surface:${projectId}:@${sha256(worktree).slice(0, 16)}:${path}`;
}

/** What is remembered next to a stored surface. */
interface SurfaceState {
  /**
   * `SURFACE_FORMAT` the surface was written with. Formats have been recorded since format 2, so
   * a surface with no state entry, or a state entry without this field, was written before formats
   * existed and is format 1.
   */
  format: number;
  /** HEAD of the checkout when the surface was stored (null when unknown). */
  head: string | null;
  /** Conflicts this file's changes opened, with the exports as they were before. */
  open: { conflictId: string; before: Record<string, string> }[];
}

function stateKey(surface: string): string {
  return `surface-state:${surface.slice('surface:'.length)}`;
}

function readState(value: unknown): SurfaceState {
  const v = (value ?? {}) as Partial<SurfaceState>;
  const open = Array.isArray(v.open)
    ? v.open.filter(
        (o): o is SurfaceState['open'][number] =>
          typeof o === 'object' &&
          o !== null &&
          typeof o.conflictId === 'string' &&
          typeof o.before === 'object' &&
          o.before !== null,
      )
    : [];
  return {
    // No recorded format means format 1 (see `SurfaceState.format`).
    format: typeof v.format === 'number' ? v.format : 1,
    head: typeof v.head === 'string' ? v.head : null,
    open,
  };
}

/** Root of the checkout `file` lives in: the actor's worktree, which may not be the project root. */
function treeRootOf(file: ChangedFile, projectRoot: string): string {
  const suffix = `/${file.path}`;
  return file.abs.endsWith(suffix) ? file.abs.slice(0, -suffix.length) || '/' : projectRoot;
}

/**
 * Impact radar: notices when an agent changes the exported surface of a module (removed or
 * changed exports) and tells the other live sessions whose work depends on that module.
 */
/**
 * Extra recipients of an impact update. Returns live sessions that must hear about a changed
 * export surface of `path` even when they never touched the file (e.g. the dependants of a split
 * part), each with the one-line reason shown to them.
 */
export type ImpactRecipientResolver = (
  projectId: string,
  actor: Session,
  path: string,
) => { session: Session; note: string }[];

export class ImpactService {
  private readonly resolvers: ImpactRecipientResolver[] = [];

  constructor(
    private readonly k: Kernel,
    private readonly telepathy: TelepathyService,
  ) {}

  /** Registers a resolver consulted for every export-surface change. */
  addRecipientResolver(fn: ImpactRecipientResolver): void {
    this.resolvers.push(fn);
  }

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

    // The file, its HEAD version and its importers are those of the checkout the agent works in.
    const tree = treeRootOf(file, projectRoot);
    const key = surfaceKey(projectId, file.path, tree === projectRoot ? undefined : tree);
    const kv = this.k.store.kv;

    // Everything that has to be waited for comes first. What it depends on (is there a stored
    // surface, which HEAD was it taken at) is only a first look here and is checked again below.
    const seen = readState(kv.get<unknown>(stateKey(key)));
    const hadSurface = kv.get<unknown>(key) !== null;
    const head = await git.headCommit(tree);
    let atHead: Map<string, string> | null = null;
    let committed: Map<string, string> | null = null;
    if (!hadSurface) {
      const content = await git.fileAtRef(tree, 'HEAD', file.path);
      atHead = content === null ? null : git.exportSurface(content, file.path);
    } else if (head !== null && seen.head !== null && head !== seen.head) {
      committed = await this.committedSurface(tree, file.path, seen.head, head);
    }

    // Reading the stored surface, comparing and storing the new one is one transaction with no
    // wait in it. Two edits of the file analysed at the same time (each hook is its own process)
    // are then compared one after the other, and a change is reported once, for the first.
    const { before, restored } = this.k.store.transaction(() => {
      const stored = kv.get<Record<string, string>>(key);
      const state = readState(kv.get<unknown>(stateKey(key)));
      let baseline: Map<string, string> | null;
      let open = state.open;
      if (stored && typeof stored === 'object') {
        // A surface stored by another version is still right about which exports exist and about
        // every signature that version wrote the same way; only the others are taken as unchanged.
        baseline = migrateSignatures(
          Object.entries(stored).filter(([, v]) => typeof v === 'string'),
          state.format,
          after,
        );
        // A conflict remembered with a signature that cannot be compared any more can never be
        // shown restored. It is forgotten here and stays open until someone resolves it.
        open = open.filter((o) =>
          Object.values(o.before).every((sig) => canShowRestored(sig, state.format)),
        );
        if (committed && state.head === seen.head) baseline = committed;
      } else {
        baseline = atHead;
      }
      const back: SurfaceState['open'] = [];
      const kept: SurfaceState['open'] = [];
      for (const o of open) {
        const names = Object.keys(o.before);
        const isBack =
          baseline !== null && names.length > 0 && names.every((n) => after.get(n) === o.before[n]);
        (isBack ? back : kept).push(o);
      }
      kv.set(key, Object.fromEntries(after));
      kv.set(stateKey(key), {
        format: SURFACE_FORMAT,
        head,
        open: kept.slice(-MAX_OPEN_PER_FILE),
      });
      return { before: baseline, restored: back };
    });
    if (!before) return null;

    this.closeRestored(projectId, session, file.path, restored);
    const raw = git.diffExportSurface(before, after);
    const diff: ExportSurfaceDiff = {
      added: cleanNames(raw.added),
      removed: cleanNames(raw.removed),
      changed: cleanNames(raw.changed),
    };
    if (diff.removed.length === 0 && diff.changed.length === 0) return null;

    const dependents = [
      ...new Set((await git.dependentsOf(tree, file.path)).filter((d) => d !== file.path)),
    ].slice(0, MAX_DEPENDENTS);
    const targets = new Set([file.path, ...dependents]);
    const affected = this.affectedSessions(projectId, session, targets);
    for (const resolve of this.resolvers) {
      for (const r of resolve(projectId, session, file.path)) {
        if (r.session.id === session.id) continue;
        const existing = affected.find((a) => a.session.id === r.session.id);
        if (existing) existing.note = r.note;
        else affected.push({ session: r.session, files: [], note: r.note });
      }
    }
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
    const was: Record<string, string> = {};
    for (const name of [...diff.removed, ...diff.changed]) {
      const sig = before.get(name);
      if (sig !== undefined) was[name] = sig;
    }
    this.k.store.transaction(() => {
      const state = readState(kv.get<unknown>(stateKey(key)));
      const open = [
        ...state.open.filter((o) => o.conflictId !== conflict.id),
        { conflictId: conflict.id, before: was },
      ];
      kv.set(stateKey(key), { ...state, open: open.slice(-MAX_OPEN_PER_FILE) });
    });
    const diffKey = fingerprint(...diff.removed, '|', ...diff.changed, '|', ...diff.added);
    for (const a of affected) {
      this.send(
        projectId,
        session,
        a.session,
        file.path,
        summary,
        a.files,
        diffKey,
        conflict,
        a.note,
      );
    }
    return {
      path: file.path,
      diff,
      dependents,
      affected: affected.map((a) => ({ sessionId: a.session.id, files: a.files })),
      conflict,
    };
  }

  /**
   * The surface to compare against after HEAD moved since the stored one was taken. A commit,
   * checkout or pull that changed the file's exports happened outside any agent edit, so the
   * stored surface no longer describes what the agent started from: the committed file does.
   * Null when the commits left the exports alone (or cannot be read), and the stored surface holds.
   */
  private async committedSurface(
    tree: string,
    path: string,
    oldHead: string,
    newHead: string,
  ): Promise<Map<string, string> | null> {
    const git = this.k.ports.git;
    const surfaceAt = async (ref: string): Promise<Map<string, string> | null> => {
      if (!git.fileStateAtRef) return null;
      const at = await git.fileStateAtRef(tree, ref, path, MAX_BASELINE_BYTES);
      if (at?.state === 'absent') return new Map();
      return at?.state === 'file' ? git.exportSurface(at.content, path) : null;
    };
    const [then, now] = [await surfaceAt(oldHead), await surfaceAt(newHead)];
    if (!then || !now) return null;
    const moved = git.diffExportSurface(then, now);
    const same = moved.added.length + moved.removed.length + moved.changed.length === 0;
    return same ? null : now;
  }

  /**
   * Closes the conflicts of earlier changes to `path` whose exports are back as they were
   * (`restored`, already taken off the file's state) and tells the sessions that were warned.
   */
  private closeRestored(
    projectId: string,
    actor: Session,
    path: string,
    restored: SurfaceState['open'],
  ): void {
    for (const o of restored) {
      const conflict = this.k.store.conflicts.find(o.conflictId);
      if (!conflict || (conflict.status !== 'open' && conflict.status !== 'acknowledged')) continue;
      this.k.store.conflicts.setStatus(conflict.id, 'resolved');
      this.k.store.events.append({
        projectId,
        sessionId: actor.id,
        type: 'conflict.updated',
        payload: { conflictId: conflict.id, kind: conflict.kind, status: 'resolved' },
      });
      const live = new Set(liveSessions(this.k, projectId).map((s) => s.id));
      const told = conflict.sessionIds.filter((id) => id !== actor.id && live.has(id));
      if (told.length === 0) continue;
      this.telepathy.send({
        projectId,
        from: actor,
        to: { sessionIds: told },
        kind: 'impact',
        priority: 5,
        title: `${sessionLabel(actor)} restored the exports of ${path}`,
        body: `Back as before: ${nameList(cleanNames(Object.keys(o.before)))}. The earlier warning about ${path} no longer applies.`,
        dedupeKey: `impact-restored:${conflict.id}:${conflict.updatedAt}`,
      });
    }
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
    note?: string,
  ): void {
    const theirs = files.filter((f) => f !== path);
    const lines = [`${summary}.`];
    if (note) lines.push(note);
    else if (theirs.length) lines.push(`Your files that import it: ${nameList(theirs, 10)}.`);
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
  ): { session: Session; files: string[]; note?: string }[] {
    const since = this.k.clock.now() - RECENT_CHANGES_MS;
    const out: { session: Session; files: string[]; note?: string }[] = [];
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
export const impactModule = (mindly: Mindly): void => {
  const service = attachService(
    mindly,
    'impact',
    new ImpactService(mindly.kernel, mindly.telepathy),
  );
  mindly.bus.on('files.changed', 'impact', async (p) => {
    await service.onFilesChanged(p);
  });
};

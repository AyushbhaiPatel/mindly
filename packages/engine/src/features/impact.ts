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
/** A conflict that can no longer be shown restored is closed once untouched for this long. */
const STALE_CONFLICT_MS = 7 * 24 * 60 * 60_000;
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
  open: OpenImpact[];
}

/** A conflict opened by a change to the file, remembered so it can be closed when undone. */
interface OpenImpact {
  conflictId: string;
  /** Signatures of the removed and changed exports, as they were before the change. */
  before: Record<string, string>;
  /** The exports the change removed. */
  removed: string[];
  /** Format `before` is written in. */
  format: number;
}

function stateKey(surface: string): string {
  return `surface-state:${surface.slice('surface:'.length)}`;
}

function readState(value: unknown): SurfaceState {
  const v = (value ?? {}) as Partial<SurfaceState>;
  // No recorded format means format 1 (see `SurfaceState.format`).
  const format = typeof v.format === 'number' ? v.format : 1;
  const open: OpenImpact[] = [];
  for (const o of Array.isArray(v.open) ? (v.open as unknown[]) : []) {
    if (typeof o !== 'object' || o === null) continue;
    const e = o as Partial<OpenImpact>;
    if (typeof e.conflictId !== 'string' || typeof e.before !== 'object' || e.before === null) {
      continue;
    }
    open.push({
      conflictId: e.conflictId,
      before: e.before,
      removed: Array.isArray(e.removed) ? e.removed.filter((n) => typeof n === 'string') : [],
      // Entries written before formats were recorded per entry share the file's format.
      format: typeof e.format === 'number' ? e.format : format,
    });
  }
  return { format, head: typeof v.head === 'string' ? v.head : null, open };
}

/**
 * Export surface of the file as it is on disk now (empty when it was deleted), or null when it
 * cannot be read or is not analysed. Synchronous, so it can run inside a store transaction.
 */
function surfaceNow(k: Kernel, file: ChangedFile): Map<string, string> | null {
  if (!existsSync(file.abs)) return new Map();
  const content = readBounded(file.abs);
  return content === null ? null : k.ports.git.exportSurface(content, file.path);
}

/** A file's exports at two commits. */
interface CommitDelta {
  then: ReadonlyMap<string, string>;
  now: ReadonlyMap<string, string>;
  /** Whether the file's content differs between the two commits. */
  fileChanged: boolean;
}

/**
 * The baseline to compare `after` with once HEAD moved from `then` to `now` since `surface` was
 * stored. A commit, pull, checkout, reset or stash is not an agent edit, so nothing it did to the
 * file is reported; what is still the agents' own is compared as usual.
 *
 * When the file is the same at both commits (HEAD moved for another file), git did nothing to it
 * and the surface is the baseline as it is. Otherwise, per export:
 *
 * - Absent at both commits: git has nothing to say about it; it is compared as usual.
 * - The file holds it as `now` does: the git operation explains it (a pull brought it, a
 *   checkout or `git stash` put the committed version back over an uncommitted change), so it
 *   reads as unchanged.
 * - The surface holds it as `then` did: the surface predates what the commits did to it, so it
 *   takes the value at `now`.
 * - Otherwise the surface shows an uncommitted change still in the working tree (or one the
 *   surface already saw after the commit) and is kept, so the file is compared with it.
 *
 * What cannot be told apart: an agent edit made after such a move that puts an export of this file
 * back to its committed value reads as the git operation and is missed; a checkout between commits
 * where the file is identical that discards an uncommitted change reads as an agent edit.
 */
function applyCommitDelta(
  surface: ReadonlyMap<string, string>,
  delta: CommitDelta,
  after: ReadonlyMap<string, string>,
): Map<string, string> {
  const out = new Map(surface);
  if (!delta.fileChanged) return out;
  for (const name of new Set([...delta.then.keys(), ...delta.now.keys()])) {
    const was = delta.then.get(name);
    const is = delta.now.get(name);
    const explained = is !== undefined && after.get(name) === is;
    if (!explained && out.get(name) !== was) continue;
    if (is === undefined) out.delete(name);
    else out.set(name, is);
  }
  return out;
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
    // The file, its HEAD version and its importers are those of the checkout the agent works in.
    const tree = treeRootOf(file, projectRoot);
    const key = surfaceKey(projectId, file.path, tree === projectRoot ? undefined : tree);
    const kv = this.k.store.kv;

    // Reading the file, comparing it with the stored surface and storing the new one happen in one
    // transaction, before anything is waited for. Analyses of the same file (each hook is its own
    // process) are then compared in the order the file was read, which is the order the edits were
    // made: each one sees the surface the edit before it left, and a change is reported once,
    // against the agent that made it.
    //
    // What this cannot fix: two hooks may reach this point out of edit order, the hook of the
    // later edit reading the file first. Its agent is then credited with both changes and the
    // earlier one finds nothing left. Telling them apart needs the content each edit produced,
    // which the hooks do not reliably give (partial edit text, several edits in one call).
    const seen = this.k.store.transaction(() => {
      const after = surfaceNow(this.k, file);
      if (!after) return null;
      const stored = kv.get<Record<string, string>>(key);
      const state = readState(kv.get<unknown>(stateKey(key)));
      // A surface stored by another version is still right about which exports exist and about
      // every signature that version wrote the same way; only the others are taken as unchanged.
      const baseline =
        stored && typeof stored === 'object'
          ? migrateSignatures(
              Object.entries(stored).filter(([, v]) => typeof v === 'string'),
              state.format,
              after,
            )
          : null;
      const outcome = this.sortOpen(state.open, after);
      kv.set(key, Object.fromEntries(after));
      kv.set(stateKey(key), { format: SURFACE_FORMAT, head: state.head, open: outcome.kept });
      return { after, baseline, priorHead: state.head, ...outcome };
    });
    if (!seen) return null;
    const { after } = seen;
    this.closeRestored(projectId, session, file.path, seen.restored);
    this.closeOutdated(projectId, session, file.path, seen.outdated, after);

    // Then what has to be waited for: the HEAD the comparison is made against. `priorHead` is the
    // HEAD recorded when this analysis read the stored surface, so a move is judged against what
    // that surface was taken at.
    const head = await git.headCommit(tree);
    let before = seen.baseline;
    if (!before) {
      // First sight of the file: compare with what is committed.
      const content = await git.fileAtRef(tree, 'HEAD', file.path);
      before = content === null ? null : git.exportSurface(content, file.path);
    } else if (head !== null && seen.priorHead !== null && head !== seen.priorHead) {
      const moved = await this.commitDelta(tree, file.path, seen.priorHead, head);
      if (moved) before = applyCommitDelta(before, moved, after);
    }
    await this.recordHead(tree, key, seen.priorHead, head);
    if (!before) return null;

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
      const entry: OpenImpact = {
        conflictId: conflict.id,
        before: was,
        removed: diff.removed,
        format: SURFACE_FORMAT,
      };
      const open = [...state.open.filter((o) => o.conflictId !== conflict.id), entry];
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
   * The file's exports at `oldHead` and `newHead`, or null when either cannot be read. Wanted even
   * when the commits left the exports alone: a checkout or stash between them may have put the
   * committed file back over an uncommitted change the stored surface still shows.
   */
  private async commitDelta(
    tree: string,
    path: string,
    oldHead: string,
    newHead: string,
  ): Promise<CommitDelta | null> {
    const git = this.k.ports.git;
    const at = async (
      ref: string,
    ): Promise<{ content: string | null; surface: Map<string, string> } | null> => {
      if (!git.fileStateAtRef) return null;
      const state = await git.fileStateAtRef(tree, ref, path, MAX_BASELINE_BYTES);
      if (state?.state === 'absent') return { content: null, surface: new Map() };
      if (state?.state !== 'file') return null;
      const surface = git.exportSurface(state.content, path);
      return surface ? { content: state.content, surface } : null;
    };
    const [then, now] = [await at(oldHead), await at(newHead)];
    if (!then || !now) return null;
    return { then: then.surface, now: now.surface, fileChanged: then.content !== now.content };
  }

  /**
   * Sorts the conflicts remembered for a file against its current surface: those whose exports
   * are back as they were (`restored`), those that can never be shown restored and are done with
   * (`outdated`: the exports they removed are back, or nothing touched them for a week), and the
   * rest (`kept`). Conflicts closed meanwhile are forgotten.
   */
  private sortOpen(
    open: readonly OpenImpact[],
    after: ReadonlyMap<string, string>,
  ): { kept: OpenImpact[]; restored: OpenImpact[]; outdated: OpenImpact[] } {
    const kept: OpenImpact[] = [];
    const restored: OpenImpact[] = [];
    const outdated: OpenImpact[] = [];
    const now = this.k.clock.now();
    for (const o of open) {
      const conflict = this.k.store.conflicts.find(o.conflictId);
      if (!conflict || (conflict.status !== 'open' && conflict.status !== 'acknowledged')) continue;
      const names = Object.keys(o.before);
      const comparable = Object.values(o.before).every((sig) => canShowRestored(sig, o.format));
      if (comparable) {
        const back = names.length > 0 && names.every((n) => after.get(n) === o.before[n]);
        (back ? restored : kept).push(o);
        continue;
      }
      // Remembered in a format the current one writes differently: whether the exports are back
      // as they were cannot be told, but a removed export showing up again, or a long silence, ends
      // the warning.
      const removedBack = o.removed.length > 0 && o.removed.every((n) => after.has(n));
      const quiet = now - conflict.updatedAt >= STALE_CONFLICT_MS;
      (removedBack || quiet ? outdated : kept).push(o);
    }
    return { kept: kept.slice(-MAX_OPEN_PER_FILE), restored, outdated };
  }

  /**
   * Records the HEAD the stored surface was compared against. A HEAD read before one another
   * analysis already recorded is older, and is never written over it; the transaction checks that
   * nothing was recorded while that was being found out.
   */
  private async recordHead(
    tree: string,
    key: string,
    priorHead: string | null,
    head: string | null,
  ): Promise<void> {
    if (head === null) return;
    const kv = this.k.store.kv;
    const recorded = readState(kv.get<unknown>(stateKey(key))).head;
    let older = false;
    if (recorded !== null && recorded !== priorHead && recorded !== head) {
      older = (await this.k.ports.git.isAncestor?.(tree, head, recorded)) ?? false;
    }
    this.k.store.transaction(() => {
      const state = readState(kv.get<unknown>(stateKey(key)));
      // Changed again while the order was being checked: the later writer knows better.
      if (state.head !== recorded || older) return;
      kv.set(stateKey(key), { ...state, head });
    });
  }

  /**
   * Closes conflicts whose change can no longer be compared with the file (see `sortOpen`), with
   * a plain note: nothing says the exports are exactly as they were.
   */
  private closeOutdated(
    projectId: string,
    actor: Session,
    path: string,
    outdated: readonly OpenImpact[],
    after: ReadonlyMap<string, string>,
  ): void {
    for (const o of outdated) {
      const conflict = this.k.store.conflicts.find(o.conflictId);
      if (!conflict || (conflict.status !== 'open' && conflict.status !== 'acknowledged')) continue;
      this.k.store.conflicts.setStatus(conflict.id, 'resolved');
      this.k.store.events.append({
        projectId,
        sessionId: actor.id,
        type: 'conflict.updated',
        payload: { conflictId: conflict.id, kind: conflict.kind, status: 'resolved' },
      });
      // Only a removed export showing up again is worth telling; a long silence is not news.
      const names = cleanNames(o.removed);
      if (names.length === 0 || !o.removed.every((n) => after.has(n))) continue;
      const live = new Set(liveSessions(this.k, projectId).map((s) => s.id));
      const told = conflict.sessionIds.filter((id) => id !== actor.id && live.has(id));
      if (told.length === 0) continue;
      this.telepathy.send({
        projectId,
        from: actor,
        to: { sessionIds: told },
        kind: 'impact',
        priority: 4,
        title: `${path} exports ${nameList(names)} again`,
        body: `The earlier warning about ${path} is closed. Check that the exports match what your code expects.`,
        dedupeKey: `impact-closed:${conflict.id}:${conflict.updatedAt}`,
      });
    }
  }

  /**
   * Closes the conflicts of earlier changes to `path` whose exports are back as they were
   * (`restored`, already taken off the file's state) and tells the sessions that were warned.
   */
  private closeRestored(
    projectId: string,
    actor: Session,
    path: string,
    restored: readonly OpenImpact[],
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

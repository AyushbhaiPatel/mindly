import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, Store, schemaVersion } from '../src/index.js';
import { setup } from './helpers.js';

const DAY = 86_400_000;

function change(
  store: Store,
  projectId: string,
  sessionId: string,
  path: string,
  hashes: string[],
) {
  return store.fileChanges.record({
    projectId,
    sessionId,
    path,
    tool: 'Edit',
    hunkHashes: hashes,
    addedLines: hashes.length,
    removedLines: 1,
    promptEventId: null,
  });
}

function tables(store: Store): string[] {
  return (
    store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[]
  ).map((t) => t.name);
}

describe('line survival schema (v5)', () => {
  it('is the fifth migration, with an index on the project', () => {
    const { store } = setup();
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(5);
    expect(MIGRATIONS[4]).toContain('CREATE TABLE line_survival');
    expect(MIGRATIONS[3]).not.toContain('line_survival');
    expect(schemaVersion(store.db)).toBe(MIGRATIONS.length);
    const cols = (
      store.db.prepare('PRAGMA table_info(line_survival)').all() as { name: string; pk: number }[]
    ).map((c) => [c.name, c.pk]);
    expect(cols).toEqual([
      ['change_id', 1],
      ['project_id', 0],
      ['checked_at', 0],
      ['total_hashes', 0],
      ['kept_hashes', 0],
    ]);
    const index = store.db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'line_survival_project'",
      )
      .get() as { sql: string } | undefined;
    expect(index?.sql).toContain('(project_id)');
  });

  it('upgrades a v4 database and keeps its data', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mindly-track-')), 'mindly.db');
    const old = Store.open(path);
    const project = old.projects.upsertByRoot('/repo', 'repo');
    const session = old.sessions.upsert({
      projectId: project.id,
      agentKind: 'codex',
      externalId: 'cx-1',
      worktree: '/repo',
      branch: 'main',
      transcriptPath: null,
    }).session;
    const c = change(old, project.id, session.id, 'src/api/a.ts', ['h1', 'h2']);
    const run = old.runs.create({ projectId: project.id, kind: 'bisect', title: 'b', input: {} });
    old.db.exec('DROP TABLE line_survival; PRAGMA user_version = 4;');
    expect(tables(old)).not.toContain('line_survival');
    old.close();

    const store = Store.open(path);
    expect(schemaVersion(store.db)).toBe(MIGRATIONS.length);
    expect(tables(store)).toContain('line_survival');
    expect(store.fileChanges.forPath(project.id, 'src/api/a.ts').map((x) => x.id)).toEqual([c.id]);
    expect(store.track.hashes(c.id).sort()).toEqual(['h1', 'h2']);
    expect(store.runs.get(run.id).kind).toBe('bisect');
    expect(store.sessions.get(session.id).agentKind).toBe('codex');
    store.track.recordSurvival({
      changeId: c.id,
      projectId: project.id,
      totalHashes: 2,
      keptHashes: 1,
    });
    expect(store.track.survivalGroups(project.id, 0, Number.MAX_SAFE_INTEGER)).toEqual([
      { path: 'src/api/a.ts', agentKind: 'codex', totalHashes: 2, keptHashes: 1 },
    ]);
    store.close();
  });
});

describe('TrackRepo', () => {
  it('groups edits by path and session within the window', () => {
    const { store, project, a, b, clock } = setup();
    change(store, project.id, a.id, 'src/api/x.ts', ['1']);
    clock.advance(DAY);
    const from = clock.now();
    change(store, project.id, a.id, 'src/api/x.ts', ['2', '3']);
    change(store, project.id, a.id, 'src/api/x.ts', ['4']);
    change(store, project.id, b.id, 'README.md', []);
    const groups = store.track
      .editGroups(project.id, from)
      .sort((x, y) => x.path.localeCompare(y.path));
    expect(groups).toEqual([
      {
        path: 'README.md',
        sessionId: b.id,
        agentKind: 'codex',
        edits: 1,
        addedLines: 0,
        removedLines: 1,
      },
      {
        path: 'src/api/x.ts',
        sessionId: a.id,
        agentKind: 'claude-code',
        edits: 2,
        addedLines: 3,
        removedLines: 2,
      },
    ]);
  });

  it('records survival once, lists and counts what is still pending', () => {
    const { store, project, a, clock } = setup();
    const old = change(store, project.id, a.id, 'src/a.ts', ['1', '2']);
    clock.advance(10 * DAY);
    const recent = change(store, project.id, a.id, 'src/b.ts', ['3']);
    const before = clock.now() - 7 * DAY;
    expect(store.track.pendingSurvival(project.id, before, 10).map((p) => p.changeId)).toEqual([
      old.id,
    ]);
    expect(store.track.pendingSurvival(null, before, 10)[0]).toMatchObject({
      changeId: old.id,
      projectId: project.id,
      sessionId: a.id,
      path: 'src/a.ts',
      worktree: '/repo',
    });
    expect(store.track.countPendingSurvival(project.id, before)).toBe(1);
    expect(store.track.countPendingSurvival(project.id, clock.now())).toBe(2);
    store.track.recordSurvival({
      changeId: old.id,
      projectId: project.id,
      totalHashes: 2,
      keptHashes: 5,
    });
    // Computed once: a second result for the same edit is ignored.
    store.track.recordSurvival({
      changeId: old.id,
      projectId: project.id,
      totalHashes: 2,
      keptHashes: 0,
    });
    const row = store.db
      .prepare('SELECT total_hashes, kept_hashes FROM line_survival WHERE change_id = ?')
      .get(old.id) as { total_hashes: number; kept_hashes: number };
    expect(row).toEqual({ total_hashes: 2, kept_hashes: 2 });
    expect(store.track.countPendingSurvival(project.id, before)).toBe(0);
    expect(store.track.pendingSurvival(project.id, clock.now(), 10).map((p) => p.changeId)).toEqual(
      [recent.id],
    );
  });

  it('deletes survival rows with their edit (and project)', () => {
    const { store, project, a } = setup();
    const c = change(store, project.id, a.id, 'src/a.ts', ['1']);
    store.track.recordSurvival({
      changeId: c.id,
      projectId: project.id,
      totalHashes: 1,
      keptHashes: 1,
    });
    store.projects.delete(project.id);
    const n = store.db.prepare('SELECT COUNT(*) AS n FROM line_survival').get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('finds sessions that hit a usage limit from events and rate-limit handoffs', () => {
    const { store, project, a, b, clock } = setup();
    const from = clock.now();
    store.events.append({
      projectId: project.id,
      sessionId: a.id,
      type: 'session.rate_limited',
      payload: {},
    });
    store.handoffs.create({
      projectId: project.id,
      fromSessionId: b.id,
      toAgentKind: 'claude-code',
      taskId: null,
      reason: 'rate_limit',
      summary: 'limit',
      packet: {
        goal: 'g',
        plan: [],
        filesChanged: [],
        recentPrompts: [],
        decisions: [],
        blockers: [],
        nextSteps: [],
        branch: null,
        headCommit: null,
      },
    });
    expect([...store.track.limitedSessionIds(project.id, from)].sort()).toEqual(
      [a.id, b.id].sort(),
    );
    expect(store.track.limitedSessionIds(project.id, clock.now() + 1).size).toBe(0);
  });
});

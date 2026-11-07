import { codename, shortId } from '@mindly/core';
import { describe, expect, it } from 'vitest';
import { normaliseIdRef } from '../src/index.js';
import { setup } from './helpers.js';

const user = { type: 'user' as const, sessionId: null, agentKind: null };

function twoMemories() {
  const env = setup();
  const make = (title: string) =>
    env.store.memories.create({
      projectId: env.project.id,
      kind: 'rule',
      title,
      body: '',
      source: user,
      trust: 'approved',
    });
  return { ...env, m1: make('Use pnpm'), m2: make('No default exports') };
}

describe('id lookup', () => {
  it('resolves full ids, short ids and unique prefixes', () => {
    const { store, project, clock, m1, m2 } = twoMemories();
    expect(store.ids.lookup('memory', project.id, m1.id)).toEqual({
      type: 'exact',
      matches: [{ id: m1.id, title: 'Use pnpm' }],
    });
    expect(store.ids.lookup('memory', project.id, m1.id.toUpperCase()).matches[0]?.id).toBe(m1.id);
    expect(store.ids.lookup('memory', project.id, shortId(m2.id))).toEqual({
      type: 'short',
      matches: [{ id: m2.id, title: 'No default exports' }],
    });
    // Ids start with their creation time: one made a day later has a different prefix.
    clock.advance(86_400_000);
    const later = store.memories.create({
      projectId: project.id,
      kind: 'note',
      title: 'Later',
      body: '',
      source: user,
      trust: 'approved',
    });
    expect(store.ids.lookup('memory', project.id, later.id.slice(0, 13))).toEqual({
      type: 'prefix',
      matches: [{ id: later.id, title: 'Later' }],
    });
  });

  it('resolves a readable name to the record whose id it spells', () => {
    const { store, project, m1, m2 } = twoMemories();
    // Ids whose names were the same (ruby-fox) when names were a 2-word hash of the id.
    const a = '01a1a6ed-0000-7000-8000-000010036224';
    const decoy = '01a1a6ed-0000-7000-8000-0000100bd77e';
    // Give the memories those ids (their version rows keep the old ones, so skip the FK check).
    store.db.exec('PRAGMA foreign_keys = OFF');
    const setId = store.db.prepare('UPDATE memories SET id = ? WHERE id = ?');
    setId.run(a, m1.id);
    setId.run(decoy, m2.id);
    expect(store.ids.lookup('memory', project.id, codename(a))).toEqual({
      type: 'name',
      matches: [{ id: a, title: 'Use pnpm' }],
    });
    expect(store.ids.lookup('memory', project.id, ` ${codename(decoy).toUpperCase()} `)).toEqual({
      type: 'name',
      matches: [{ id: decoy, title: 'No default exports' }],
    });
    expect(store.ids.lookup('conflict', project.id, codename(a)).type).toBe('none');
  });

  it('reports every candidate of an ambiguous prefix', () => {
    const { store, project, m1, m2 } = twoMemories();
    // Both ids were made in the same millisecond, so they share their time prefix.
    const r = store.ids.lookup('memory', project.id, m1.id.slice(0, 8));
    expect(r.type).toBe('prefix');
    expect(r.matches.map((m) => m.id).sort()).toEqual([m1.id, m2.id].sort());
  });

  it('is scoped to the project and kind', () => {
    const { store, project, m1, a } = twoMemories();
    const other = store.projects.upsertByRoot('/other', 'other');
    expect(store.ids.lookup('memory', other.id, m1.id).type).toBe('none');
    expect(store.ids.lookup('conflict', project.id, m1.id).type).toBe('none');
    expect(store.ids.lookup('session', project.id, shortId(a.id))).toEqual({
      type: 'short',
      matches: [{ id: a.id, title: 'claude-code session' }],
    });
  });

  it('rejects input that cannot be an id without querying', () => {
    const { store, project } = twoMemories();
    for (const bad of ['', 'abc', "x' OR 1=1 --", '%', '____', 'zzzzzzzz', 'a'.repeat(37)]) {
      expect(store.ids.lookup('memory', project.id, bad)).toEqual({ type: 'none', matches: [] });
    }
    expect(normaliseIdRef(' 01A1-A6ED ')).toBe('01a1a6ed');
    expect(normaliseIdRef('01a')).toBeNull();
  });
});

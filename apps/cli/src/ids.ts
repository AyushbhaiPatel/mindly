import { sanitizeLine, shortId } from '@mindly/core';
import { normaliseIdRef, type IdKind, type Store } from '@mindly/store';
import { HintedError, UsageError } from './util.js';

/** How each kind is named in messages, and where to find its ids. */
const KINDS: Record<IdKind, { one: string; many: string; list: string }> = {
  memory: { one: 'memory', many: 'memories', list: 'mindly memory list' },
  conflict: { one: 'conflict', many: 'conflicts', list: 'mindly conflicts --all' },
  snapshot: { one: 'snapshot', many: 'snapshots', list: 'mindly snapshot list' },
  session: { one: 'agent session', many: 'agent sessions', list: 'mindly status' },
  handoff: { one: 'handoff', many: 'handoffs', list: 'mindly handoffs' },
  contract: { one: 'check', many: 'checks', list: 'mindly memory show <memory id>' },
  run: { one: 'run', many: 'runs', list: 'mindly dashboard' },
};

/**
 * Resolves an id typed by the user to the full id of a record of `kind` in `projectId`. Accepts
 * the full id, the 8-character short id shown in human output, or any unique prefix of the full
 * id. Throws a usage error for input that is not id-shaped, `not_found` when nothing matches, and
 * `invalid_input` listing the candidates (with their titles) when the reference is ambiguous.
 */
export function resolveId(store: Store, kind: IdKind, projectId: string, input: string): string {
  const k = KINDS[kind];
  const typed = sanitizeLine(input, 40);
  if (normaliseIdRef(input) === null) {
    throw new UsageError(
      `"${typed}" is not a ${k.one} id. Use the 8-character id shown in brackets, e.g. [9f02a0c3] (see ${k.list})`,
    );
  }
  const found = store.ids.lookup(kind, projectId, input, 10);
  const [first] = found.matches;
  if (first === undefined) {
    throw new HintedError(
      'not_found',
      `No ${k.one} with id ${typed} in this project.`,
      `See the ${k.many} and their ids with: ${k.list}`,
    );
  }
  if (found.matches.length === 1) return first.id;
  // Two records can share a short id; then only the full id tells them apart.
  const shorts = found.matches.map((m) => shortId(m.id));
  const clash = new Set(shorts).size !== shorts.length;
  const lines = found.matches.map(
    (m) => `  ${clash ? m.id : shortId(m.id)}  ${sanitizeLine(m.title, 80)}`,
  );
  throw new HintedError(
    'invalid_input',
    `${typed} matches ${found.matches.length === 10 ? '10 or more' : found.matches.length} ${k.many}:\n${lines.join('\n')}`,
    `Use one of the ids above${clash ? '' : ' (or more characters of the full id)'}.`,
  );
}

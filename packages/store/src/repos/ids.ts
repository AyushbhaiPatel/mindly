import { type Db, type Row, str } from '../db.js';

/** Kinds of record that people refer to by id on the command line or in the dashboard. */
export const ID_KINDS = [
  'memory',
  'conflict',
  'snapshot',
  'session',
  'handoff',
  'contract',
  'run',
  'save',
] as const;
export type IdKind = (typeof ID_KINDS)[number];

/**
 * Table and title expression per kind. Both are fixed strings chosen here (never from input), so
 * interpolating them into SQL is safe; every value from input is a bound parameter.
 */
const SPECS: Record<IdKind, { table: string; title: string }> = {
  memory: { table: 'memories', title: 'title' },
  conflict: { table: 'conflicts', title: 'title' },
  snapshot: { table: 'snapshots', title: 'label' },
  session: { table: 'sessions', title: "COALESCE(label, agent_kind || ' session')" },
  handoff: { table: 'handoffs', title: 'summary' },
  contract: { table: 'contracts', title: 'kind' },
  run: { table: 'runs', title: 'title' },
  save: { table: 'saves', title: 'title' },
};

/** One record an id reference may point to. */
export interface IdMatch {
  id: string;
  title: string;
}

/** How an id reference matched. */
export type IdMatchType = 'exact' | 'short' | 'prefix' | 'none';

/** Result of {@link IdRepo.lookup}: the candidates of the best match type, most recent first. */
export interface IdLookup {
  type: IdMatchType;
  matches: IdMatch[];
}

/** Shortest prefix accepted (after removing dashes); shorter ones match far too much. */
export const MIN_ID_PREFIX = 4;
/** Length of a short id (`shortId()` in core: the last 8 hex digits of the id). */
const SHORT_ID_LENGTH = 8;
const REF_RE = /^[0-9a-f-]{1,36}$/;

/** Normalises an id reference typed by a person; null when it cannot be an id at all. */
export function normaliseIdRef(input: string): string | null {
  const ref = input.trim().toLowerCase();
  if (!REF_RE.test(ref)) return null;
  const compact = ref.replace(/-/g, '');
  return compact.length >= MIN_ID_PREFIX ? compact : null;
}

/**
 * Resolves the ids people type: a full id, the 8-character short id shown in human output (the
 * last 8 hex digits), or any unique prefix of the full id. Lookups are always scoped to one
 * project and use bound parameters only.
 */
export class IdRepo {
  constructor(private readonly db: Db) {}

  /**
   * Finds the records of `kind` in `projectId` that `input` refers to. Precedence: an exact full
   * id, then short-id (suffix) matches, then prefix matches. Returns at most `max` candidates of
   * the winning match type (`type: 'none'` and no matches when nothing fits or the input is not
   * id-shaped).
   */
  lookup(kind: IdKind, projectId: string, input: string, max = 10): IdLookup {
    const compact = normaliseIdRef(input);
    if (compact === null) return { type: 'none', matches: [] };
    const { table, title } = SPECS[kind];
    const n = Math.max(1, Math.min(Math.trunc(max), 50));
    const select = (where: string, ...params: string[]): IdMatch[] =>
      (
        this.db
          .prepare(
            `SELECT id, ${title} AS title FROM ${table}
             WHERE project_id = ? AND ${where} ORDER BY id DESC LIMIT ?`,
          )
          .all(projectId, ...params, n) as Row[]
      ).map((r) => ({ id: str(r, 'id'), title: str(r, 'title') }));

    // The input is hex and dashes only (checked above), so it cannot contain LIKE wildcards.
    const exact = select("replace(id, '-', '') = ?", compact);
    if (exact.length > 0) return { type: 'exact', matches: exact };
    if (compact.length === SHORT_ID_LENGTH) {
      const short = select("substr(replace(id, '-', ''), -8) = ?", compact);
      if (short.length > 0) return { type: 'short', matches: short };
    }
    const prefix = select("replace(id, '-', '') LIKE ?", `${compact}%`);
    return prefix.length > 0 ? { type: 'prefix', matches: prefix } : { type: 'none', matches: [] };
  }
}

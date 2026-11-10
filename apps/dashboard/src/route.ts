import { PAGES, type Page } from './vocab';

/*
 * The dashboard's address: `#/<page>?p=<project>&sub=<section>…`. Reading it is kept apart from
 * the components so it can be tested without a browser.
 */

export interface ParsedRoute {
  page: Page;
  params: Record<string, string>;
}

const PAGE_KEYS = new Set<string>(PAGES.map((p) => p.key));

/**
 * Older links and the views' own `navigate()` calls still use the previous page names; each maps
 * to a page and, where the page has sections, the section to open.
 */
const ALIASES: ReadonlyMap<string, { page: Page; sub?: string }> = new Map([
  ['overview', { page: 'home' }],
  ['coordination', { page: 'agents', sub: 'team' }],
  ['split', { page: 'agents', sub: 'split' }],
  ['runs', { page: 'history', sub: 'runs' }],
  ['insight', { page: 'history', sub: 'xray' }],
]);

/**
 * The page a path names. Anything that is not a page or an older name of one opens the home
 * page: the path comes from the address bar, so it can be any text (`constructor`, `__proto__`).
 */
export function canonicalRoute(path: string, params: Record<string, string>): ParsedRoute {
  if (PAGE_KEYS.has(path)) return { page: path as Page, params };
  const alias = ALIASES.get(path);
  if (!alias) return { page: 'home', params };
  return { page: alias.page, params: alias.sub ? { sub: alias.sub, ...params } : params };
}

/** Reads a `location.hash` value (`#/memory?p=…`). */
export function parseRoute(hash: string): ParsedRoute {
  const raw = hash.replace(/^#\/?/, '');
  const [path = '', query = ''] = raw.split('?');
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(query)) params[k] = v;
  return canonicalRoute(path, params);
}

/** The `location.hash` value for a page and its parameters. */
export function formatRoute(path: string, params: Record<string, string> = {}): string {
  const c = canonicalRoute(path, params);
  const q = new URLSearchParams(c.params).toString();
  return `#/${c.page}${q ? `?${q}` : ''}`;
}

/**
 * The project an address asks for: its `p` parameter when that names a known project, else
 * `fallback` (the project already shown, or the one remembered from the last visit).
 */
export function projectOfRoute(
  params: { get(name: string): string | null },
  projectIds: readonly string[],
  fallback: string | null,
): string | null {
  const asked = params.get('p');
  if (asked !== null && projectIds.includes(asked)) return asked;
  if (fallback !== null && projectIds.includes(fallback)) return fallback;
  return projectIds[0] ?? null;
}

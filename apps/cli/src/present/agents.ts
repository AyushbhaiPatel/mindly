import { adapters, getAdapter } from '@mindly/adapters';
import { sanitizeLine, shortId, type Session } from '@mindly/core';

/** Product name of an agent kind (`claude-code` -> `Claude Code`), from the adapters. */
export function agentName(kind: string): string {
  if (kind === 'generic') return 'Agent';
  const adapter = getAdapter(kind);
  // Catalog names may carry a qualifier ("Augment (Auggie CLI)"); the short form reads better.
  return adapter ? adapter.displayName.replace(/\s*\(.*\)$/, '') : sanitizeLine(kind, 32);
}

/** A session as people see it: `Claude Code - 4409d433` (with its label when it has one). */
export function sessionName(s: Pick<Session, 'id' | 'agentKind' | 'label'>): string {
  const label = s.label ? sanitizeLine(s.label, 40) : '';
  return `${agentName(s.agentKind)}${label ? ` "${label}"` : ''} \u00B7 ${shortId(s.id)}`;
}

/** Agent kinds known to the adapters, longest first so `claude-code` wins over a prefix. */
const KNOWN = Object.keys(adapters).sort((a, b) => b.length - a.length);
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SESSION_TAG_RE = /(?<![\w/.-])([a-z][a-z0-9-]{1,31}) #([0-9a-f]{8})\b/g;
const KIND_IN_TEXT_RE = new RegExp(
  `(?<![\\w/.-])(${KNOWN.map(escape).join('|')})(?= "| session| agent|'s )`,
  'g',
);

/**
 * Rewrites engine-made labels inside stored text (conflict titles, update titles) into the
 * human form: `claude-code #4409d433` -> `Claude Code - 4409d433`, `a codex session` ->
 * `a Codex session`. The input must already be sanitised.
 */
export function humanizeText(text: string): string {
  return text
    .replace(SESSION_TAG_RE, (_m, kind: string, tag: string) => `${agentName(kind)} \u00B7 ${tag}`)
    .replace(KIND_IN_TEXT_RE, (kind: string) => agentName(kind));
}

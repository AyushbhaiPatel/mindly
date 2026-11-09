import { parse, stringify } from 'smol-toml';
import { MindlyError } from '@mindly/core';
import { isRecord } from '../shared/payload.js';

/*
 * Minimal, comment-preserving edits to Codex's `config.toml`. Mindly owns exactly one table,
 * `[mcp_servers.mindly]`, written inside marker comments. Everything else in the file is kept
 * byte-for-byte; the result is re-parsed before it is returned.
 */

export const TOML_BLOCK_BEGIN = '# >>> mindly: managed MCP server (edit with `mindly install`) >>>';
export const TOML_BLOCK_END = '# <<< mindly <<<';

/** Parses TOML, refusing invalid documents with a `MindlyError`. */
export function parseToml(path: string, text: string): Record<string, unknown> {
  try {
    return parse(text) as Record<string, unknown>;
  } catch (cause) {
    throw new MindlyError(
      'invalid_input',
      `${path} is not valid TOML; fix it before running the installer`,
      { cause },
    );
  }
}

function hasServer(doc: Record<string, unknown>, name: string): boolean {
  const servers = doc['mcp_servers'];
  return isRecord(servers) && name in servers;
}

function removeMarkedBlock(path: string, lines: string[]): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inside && trimmed === TOML_BLOCK_BEGIN) {
      inside = true;
      continue;
    }
    if (inside) {
      if (trimmed === TOML_BLOCK_END) inside = false;
      continue;
    }
    out.push(line);
  }
  if (inside) {
    throw new MindlyError(
      'invalid_input',
      `${path} has an unterminated Mindly block; remove it by hand`,
    );
  }
  return out;
}

const HEADER_RE = /^\s*\[\[?\s*([^[\]]+?)\s*\]\]?\s*(?:#.*)?$/;

function normaliseKey(raw: string): string {
  return raw
    .split('.')
    .map((part) =>
      part
        .trim()
        .replace(/^"(.*)"$/, '$1')
        .replace(/^'(.*)'$/, '$1'),
    )
    .join('.');
}

/**
 * Drops `[table]` and its sub-tables (`[table.x]`) from the line list. Comment lines sitting
 * directly above the next table's header describe that table, not the one removed, and stay.
 */
function removeTable(lines: string[], table: string): string[] {
  const out: string[] = [];
  let skipping = false;
  // Comment and blank lines seen since the removed table's last line of content.
  let trailing: string[] = [];
  for (const line of lines) {
    const m = HEADER_RE.exec(line);
    if (m) {
      const key = normaliseKey(m[1] ?? '');
      const skip = key === table || key.startsWith(`${table}.`);
      if (skipping && !skip) {
        const firstComment = trailing.findIndex((l) => l.trim().startsWith('#'));
        if (firstComment >= 0) out.push(...trailing.slice(firstComment));
      }
      trailing = [];
      skipping = skip;
    } else if (skipping) {
      const t = line.trim();
      if (t === '' || t.startsWith('#')) trailing.push(line);
      else trailing = [];
    }
    if (!skipping) out.push(line);
  }
  return out;
}

function trimTrailingBlank(lines: string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && (out[out.length - 1] ?? '').trim() === '') out.pop();
  return out;
}

/**
 * Returns `text` with Mindly's MCP server table removed and, when `server` is given, re-added
 * as a marked block at the end of the file.
 */
export function upsertMcpServerToml(
  path: string,
  text: string,
  name: string,
  server: { command: string; args: string[] } | null,
): string {
  parseToml(path, text);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let lines = removeMarkedBlock(path, text.split(/\r?\n/));
  if (hasServer(parseToml(path, lines.join('\n')), name)) {
    lines = removeTable(lines, `mcp_servers.${name}`);
    if (hasServer(parseToml(path, lines.join('\n')), name)) {
      throw new MindlyError(
        'invalid_input',
        `${path} defines mcp_servers.${name} in a form Mindly cannot edit; remove it by hand`,
      );
    }
  }
  lines = trimTrailingBlank(lines);
  if (server !== null) {
    const table = stringify({ mcp_servers: { [name]: server } })
      .trim()
      .split(/\r?\n/);
    if (lines.length > 0) lines.push('');
    lines.push(TOML_BLOCK_BEGIN, ...table, TOML_BLOCK_END);
  }
  const result = lines.length === 0 ? '' : `${lines.join(eol)}${eol}`;
  let doc: Record<string, unknown>;
  try {
    doc = parse(result) as Record<string, unknown>;
  } catch (cause) {
    // The file itself parsed above: it is our table that does not fit, which happens when
    // `mcp_servers` (or the server) is written as an inline table or with dotted keys.
    throw new MindlyError(
      'invalid_input',
      `${path} defines mcp_servers in a form Mindly cannot add a server to (an inline table or dotted keys); write each server as its own [mcp_servers.<name>] table`,
      { cause },
    );
  }
  const ok = server === null ? !hasServer(doc, name) : hasServer(doc, name);
  if (!ok) {
    throw new MindlyError(
      'invalid_input',
      `could not update mcp_servers.${name} in ${path} safely`,
    );
  }
  return result;
}

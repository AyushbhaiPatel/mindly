import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { MINDLY_VERSION, MindlyError, writeJsonFile } from '@mindly/core';
import type { Mindly } from '@mindly/engine';
import { withProject } from '../context.js';
import { confirm } from '../io.js';
import { clean, plural, type Out } from '../util.js';

/** `mindly trust [--show|--revoke]`: review and trust the project's `.mindly/config.json`. */
export async function trust(
  out: Out,
  o: { show?: boolean; revoke?: boolean; yes?: boolean; json?: boolean },
): Promise<number> {
  return withProject(out.io, async ({ mindly, project }) => {
    const pid = project.project.id;
    const s = out.style;
    if (o.revoke) {
      mindly.projects.untrust(pid);
      out.line('Trust revoked. Commands from this project config will not run.');
      return 0;
    }
    const status = {
      trusted: project.trusted,
      configHash: project.configHash,
      configError: project.configError,
      checks: project.config.checks.map((c) => ({
        name: c.name,
        argv: c.argv,
        timeoutSec: c.timeoutSec,
      })),
    };
    if (o.json && o.show) {
      out.json(status);
      return 0;
    }
    out.line(`Project config: ${clean(`${project.root}/.mindly/config.json`, 400)}`);
    if (project.configError) {
      out.line(s.red(`Invalid: ${clean(project.configError, 300)}`));
      return o.show ? 0 : 1;
    }
    if (project.configHash === null) {
      out.line('No project config: there is nothing to trust.');
      return 0;
    }
    out.line(`Status: ${project.trusted ? s.green('trusted') : s.yellow('not trusted')}`);
    out.line(`sha256: ${project.configHash}`);
    out.line(
      `Checks (${status.checks.length}) - run without a shell against shadow-merged trees and replays:`,
    );
    for (const c of status.checks) {
      out.line(`  ${clean(c.name, 64)}: ${JSON.stringify(c.argv)} (timeout ${c.timeoutSec}s)`);
    }
    if (project.config.ignore.length) {
      out.line(`Ignore globs: ${project.config.ignore.map((g) => clean(g, 100)).join(', ')}`);
    }
    if (project.config.notes) out.line(`Notes: ${clean(project.config.notes, 300)}`);
    if (o.show) return 0;
    if (project.trusted) {
      out.line('This exact config is already trusted.');
      return 0;
    }
    if (
      !(await confirm(out.io, 'Trust this config and allow these commands to run?', o.yes === true))
    ) {
      return 1;
    }
    // Pass the hash that was shown: the engine refuses if the file changed in the meantime.
    const after = mindly.projects.trust(pid, project.configHash);
    if (o.json) out.json({ trusted: after.trusted, configHash: after.configHash });
    else out.line(s.green(`Trusted (sha256 ${after.configHash ?? '-'}).`));
    return 0;
  });
}

/** Tables exported for a project, each selected by an allow-listed query. */
const EXPORT_QUERIES: readonly (readonly [string, string])[] = [
  ['sessions', 'SELECT * FROM sessions WHERE project_id = ? ORDER BY started_at'],
  ['memories', 'SELECT * FROM memories WHERE project_id = ? ORDER BY created_at'],
  [
    'memoryVersions',
    'SELECT * FROM memory_versions WHERE memory_id IN (SELECT id FROM memories WHERE project_id = ?) ORDER BY memory_id, version',
  ],
  ['memoryEvidence', 'SELECT * FROM memory_evidence WHERE project_id = ? ORDER BY created_at'],
  ['tasks', 'SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at'],
  ['intents', 'SELECT * FROM intents WHERE project_id = ? ORDER BY created_at'],
  [
    'intentTargets',
    'SELECT * FROM intent_targets WHERE intent_id IN (SELECT id FROM intents WHERE project_id = ?)',
  ],
  ['fileChanges', 'SELECT * FROM file_changes WHERE project_id = ? ORDER BY created_at'],
  [
    'fileChangeHunks',
    'SELECT * FROM file_change_hunks WHERE change_id IN (SELECT id FROM file_changes WHERE project_id = ?)',
  ],
  ['conflicts', 'SELECT * FROM conflicts WHERE project_id = ? ORDER BY created_at'],
  ['deliveries', 'SELECT * FROM deliveries WHERE project_id = ? ORDER BY created_at'],
  ['contextPackets', 'SELECT * FROM context_packets WHERE project_id = ? ORDER BY created_at'],
  ['handoffs', 'SELECT * FROM handoffs WHERE project_id = ? ORDER BY created_at'],
  ['contracts', 'SELECT * FROM contracts WHERE project_id = ? ORDER BY created_at'],
  ['snapshots', 'SELECT * FROM snapshots WHERE project_id = ? ORDER BY created_at'],
  ['runs', 'SELECT * FROM runs WHERE project_id = ? ORDER BY created_at'],
  ['events', 'SELECT * FROM events WHERE project_id = ? ORDER BY seq'],
];

/** Every stored row of one project, as stored (JSON columns stay JSON text). */
export function exportProject(mindly: Mindly, projectId: string): Record<string, unknown> {
  const db = mindly.store.db;
  const data: Record<string, unknown> = {
    format: 'mindly-export',
    version: 1,
    mindlyVersion: MINDLY_VERSION,
    exportedAt: new Date(mindly.kernel.clock.now()).toISOString(),
    project: mindly.store.projects.get(projectId),
  };
  for (const [key, sql] of EXPORT_QUERIES) {
    data[key] = db.prepare(sql).all(projectId);
  }
  return data;
}

/** `mindly export [--out file]`: the project's data as JSON (files are written with mode 0600). */
export async function exportCmd(out: Out, o: { out?: string; force?: boolean }): Promise<number> {
  return withProject(out.io, ({ mindly, project }) => {
    const data = exportProject(mindly, project.project.id);
    if (o.out === undefined || o.out === '-') {
      out.json(data);
      return 0;
    }
    if (o.out.includes('\0')) throw new MindlyError('invalid_input', 'invalid output path');
    const file = resolve(out.io.cwd, o.out);
    if (existsSync(file) && !o.force) {
      throw new MindlyError('conflict', `${file} already exists (use --force to overwrite)`);
    }
    writeJsonFile(file, data);
    out.line(`Exported ${clean(project.project.name, 80)} to ${file} (mode 0600).`);
    return 0;
  });
}

/** `mindly forget --project | --memory <id>`: hard deletes (asks for confirmation). */
export async function forget(
  out: Out,
  o: { project?: boolean; memory?: string; yes?: boolean },
): Promise<number> {
  if (o.project === true && o.memory !== undefined) {
    throw new MindlyError('invalid_input', 'use either --project or --memory');
  }
  if (o.memory !== undefined) {
    const { memoryForget } = await import('./memory.js');
    return memoryForget(out, o.memory, { ...(o.yes !== undefined ? { yes: o.yes } : {}) });
  }
  if (o.project !== true) {
    throw new MindlyError('invalid_input', 'say what to forget: --project or --memory <id>');
  }
  return withProject(out.io, async ({ mindly, project }) => {
    const pid = project.project.id;
    const counts = mindly.store.memories.count(pid);
    const memories = Object.values(counts).reduce((a, b) => a + b, 0);
    out.line(
      `This permanently deletes everything Mindly stored for ${clean(project.project.name, 80)} (${clean(project.root, 300)}): ${plural(memories, 'memory', 'memories')}, sessions, events, tasks, snapshots and runs.`,
    );
    out.line(
      out.style.dim(
        'Your code and git history are not touched. Run `mindly export` first to keep a copy.',
      ),
    );
    if (!(await confirm(out.io, 'Forget this project?', o.yes === true))) return 1;
    mindly.store.projects.delete(pid);
    mindly.store.vacuum();
    out.line('Forgotten.');
    return 0;
  });
}

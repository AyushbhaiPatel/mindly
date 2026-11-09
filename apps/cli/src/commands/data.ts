import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { MINDLY_VERSION, writeJsonFile } from '@mindly/core';
import { sentinelOf, type Mindly } from '@mindly/engine';
import { withProject } from '../context.js';
import { confirm } from '../io.js';
import { argvWords } from '../present/index.js';
import { clean, HintedError, plural, UsageError, type Out } from '../util.js';

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
      out.line('Trust revoked: Mindly will not run the commands in this project config any more.');
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
      sentinel: project.config.sentinel
        ? {
            checks: project.config.sentinel.checks ?? null,
            setup: project.config.sentinel.setup ?? null,
            setupTimeoutSec: project.config.sentinel.setupTimeoutSec,
          }
        : null,
    };
    if (o.json && o.show) {
      out.json(status);
      return 0;
    }
    const sc = out.screen();
    const file = clean(`${project.root}/.mindly/config.json`, 400);
    if (project.configError) {
      sc.summary(`${sc.mark('fail')} This project's config is invalid, so Mindly ignores it.`);
      sc.text(`File: ${file}`, 2);
      sc.text(`Problem: ${clean(project.configError, 300)}`, 2);
      sc.next([{ why: 'Fix the file, then run mindly trust again.' }]);
      return o.show ? 0 : 1;
    }
    if (project.configHash === null) {
      sc.summary('This project has no .mindly/config.json: there is nothing to trust.');
      sc.note(
        "A project config can list checks (such as your test command) that Mindly runs when it compares agents' work.",
        2,
      );
      return 0;
    }
    sc.summary(
      project.trusted
        ? `${sc.mark('ok')} This project's config is trusted.`
        : `${sc.mark('warn')} This project's config is not trusted yet, so its checks do not run.`,
    );
    sc.note(`File: ${file}`, 2);
    sc.blank();
    if (status.checks.length) {
      sc.text(
        `Trusting it lets Mindly run ${status.checks.length === 1 ? 'this command' : `these ${status.checks.length} commands`} on your machine (without a shell) when it checks merges and replays of agents' work, and after agent edits when the sentinel is on:`,
      );
      sc.rows(
        status.checks.map((c) => ({
          marker: 'item',
          text: `${clean(c.name, 64)}: ${clean(argvWords(c.argv), 300)} (stopped after ${c.timeoutSec}s)`,
          details: [`argv ${JSON.stringify(c.argv)}`],
        })),
      );
    }
    const setup = status.sentinel?.setup ?? null;
    if (setup) {
      sc.text(
        `${status.checks.length ? 'And' : 'Trusting it lets Mindly run'} this setup command in the sentinel's scratch copy of the code before those checks, and again when a lockfile changes:`,
      );
      sc.rows([
        {
          marker: 'item',
          text: `${clean(argvWords(setup), 300)} (stopped after ${status.sentinel?.setupTimeoutSec ?? 600}s)`,
          details: [`argv ${JSON.stringify(setup)}`],
        },
      ]);
    }
    if (!status.checks.length && !setup) {
      sc.text('It lists no commands, so trusting it lets nothing run.');
    }
    if (project.config.ignore.length) {
      sc.text(
        `Mindly also ignores these paths: ${project.config.ignore.map((g) => clean(g, 100)).join(', ')}`,
      );
    }
    if (project.config.notes) sc.text(`Notes: ${clean(project.config.notes, 300)}`);
    sc.note(`Fingerprint (sha256): ${project.configHash}. If the file changes, Mindly asks again.`);
    if (o.show) return 0;
    if (project.trusted) return 0;
    if (
      !(await confirm(out.io, 'Trust this config and allow these commands to run?', o.yes === true))
    ) {
      out.line('Not trusted: its checks will not run.');
      return 1;
    }
    // Pass the hash that was shown: the engine refuses if the file changed in the meantime.
    const after = mindly.projects.trust(pid, project.configHash);
    if (o.json) out.json({ trusted: after.trusted, configHash: after.configHash });
    else {
      out.line(
        s.green(
          `Trusted. Mindly will run these checks; if the file changes, it asks again (sha256 ${after.configHash ?? '-'}).`,
        ),
      );
    }
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
    if (o.out.includes('\0')) throw new UsageError('--out is not a valid file path');
    const file = resolve(out.io.cwd, o.out);
    if (existsSync(file) && !o.force) {
      throw new HintedError(
        'conflict',
        `${file} already exists, so nothing was exported`,
        'Choose another --out file, or add --force to overwrite it',
      );
    }
    writeJsonFile(file, data);
    const sc = out.screen();
    sc.text(
      `${sc.mark('ok')} Exported everything Mindly stored for ${clean(project.project.name, 80)} to ${file}`,
    );
    sc.note('Only you can read the file. It may contain prompts and code excerpts.', 2);
    return 0;
  });
}

/** `mindly forget --project | --memory <id>`: hard deletes (asks for confirmation). */
export async function forget(
  out: Out,
  o: { project?: boolean; memory?: string; yes?: boolean },
): Promise<number> {
  if (o.project === true && o.memory !== undefined) {
    throw new UsageError('use either --project or --memory <id>, not both');
  }
  if (o.memory !== undefined) {
    const { memoryForget } = await import('./memory.js');
    return memoryForget(out, o.memory, { ...(o.yes !== undefined ? { yes: o.yes } : {}) });
  }
  if (o.project !== true) {
    throw new UsageError(
      'say what to forget: --project (everything for this project) or --memory <id>',
    );
  }
  return withProject(out.io, async ({ mindly, project }) => {
    const pid = project.project.id;
    const counts = mindly.store.memories.count(pid);
    const memories = Object.values(counts).reduce((a, b) => a + b, 0);
    out.line(
      `This permanently deletes everything Mindly stored for ${clean(project.project.name, 80)} (${clean(project.root, 300)}): ${plural(memories, 'memory', 'memories')}, sessions, events, tasks, snapshots, checkpoints, the sentinel's scratch copies and runs.`,
    );
    out.line(
      out.style.dim(
        'Your code and git history are not touched. Run `mindly export` first to keep a copy.',
      ),
    );
    // A pass running now would recreate what is being deleted: refuse before asking.
    if (sentinelOf(mindly).busy(pid)) {
      const { busyError } = await import('./sentinel.js');
      throw busyError();
    }
    if (!(await confirm(out.io, 'Forget this project?', o.yes === true))) {
      out.line('Nothing was deleted.');
      return 1;
    }
    // The sentinel's scratch trees and the checkpoint refs live in the repositories: delete them
    // before their rows go. A pass that started while the question was open keeps its tree, so
    // nothing is deleted then (its rows are how the tree is found again).
    const sentinel = await sentinelOf(mindly).forget(pid);
    if (sentinel.busy.length > 0) {
      const { busyError } = await import('./sentinel.js');
      throw busyError();
    }
    await mindly.checkpoints.forget(pid);
    for (const w of sentinel.failed) {
      out.warn(
        `The sentinel's scratch copy for ${clean(w, 300)} could not be removed: delete ${clean(sentinelOf(mindly).warmPath(pid, w), 300)}, then run \`git worktree prune\` in the repository.`,
      );
    }
    mindly.store.projects.delete(pid);
    mindly.store.vacuum();
    out.line(`Forgotten: Mindly no longer has any data for ${clean(project.project.name, 80)}.`);
    return 0;
  });
}

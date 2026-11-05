import { existsSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { shortId } from '@mindly/core';
import { renderSavesCard, savesOf, startOfLocalWeek } from '@mindly/engine';
import { withProject } from '../context.js';
import { resolveId } from '../ids.js';
import { clean, HintedError, parseDuration, UsageError, type Out } from '../util.js';
import { renderSaves, saveStatusWord } from '../views/saves.js';

const WEEK_MS = 7 * 86_400_000;

/** `mindly saves [--since 7d] [--all] [--json]`. */
export async function saves(
  out: Out,
  o: { since?: string; all?: boolean; json?: boolean },
): Promise<number> {
  const span = o.since !== undefined ? parseDuration(o.since) : WEEK_MS;
  return withProject(out.io, ({ mindly, project }) => {
    const pid = project.project.id;
    const svc = savesOf(mindly);
    // Settle saves whose window passed, so the list is current without the daemon.
    svc.sweep(pid);
    const since = mindly.kernel.clock.now() - span;
    const { total, byKind, byAgent } = svc.summary(pid, since);
    const list = svc.list(pid, {
      since,
      limit: 500,
      ...(o.all ? {} : { statuses: ['confirmed', 'caught'] as const }),
    });
    if (o.json) {
      out.json({ since, summary: { total, byKind, byAgent }, saves: list });
      return 0;
    }
    renderSaves(out.screen(), {
      projectName: project.project.name,
      since,
      summary: { total },
      saves: list,
      all: o.all === true,
    });
    return 0;
  });
}

/** `mindly saves reject <id>`: "not a save". */
export async function savesReject(out: Out, id: string): Promise<number> {
  return withProject(out.io, ({ mindly, project }) => {
    const sid = resolveId(mindly.store, 'save', project.project.id, id);
    const before = mindly.store.saves.get(sid);
    const after = savesOf(mindly).rejectByUser(sid);
    const sc = out.screen();
    if (before.status === 'rejected') {
      sc.text(
        `Save ${shortId(sid)} was already removed from every total: ${clean(after.title, 120)}`,
      );
      return 0;
    }
    if (after.status !== 'rejected') {
      sc.text(
        `Save ${shortId(sid)} is not in any total (${saveStatusWord(after.status)}): ${clean(after.title, 120)}`,
      );
      return 0;
    }
    sc.text(
      `${sc.mark('ok')} Save ${shortId(sid)} removed from every total: ${clean(after.title, 120)}`,
    );
    return 0;
  });
}

/**
 * `mindly saves card [--week] [--since 7d] [--details] [--out card.svg] [--force]`: the share card
 * as SVG, on stdout or into a file. Without `--details` it has counts and agent names only.
 */
export async function savesCard(
  out: Out,
  o: { week?: boolean; since?: string; details?: boolean; out?: string; force?: boolean },
): Promise<number> {
  if (o.week && o.since !== undefined)
    throw new UsageError('use either --week or --since, not both');
  const span = o.since !== undefined ? parseDuration(o.since) : WEEK_MS;
  let file: string | null = null;
  if (o.out !== undefined && o.out !== '-') {
    if (o.out.includes('\0')) throw new UsageError('--out is not a valid file path');
    const ext = extname(o.out).toLowerCase();
    if (ext === '.png') {
      throw new HintedError(
        'invalid_input',
        'Mindly renders the card as SVG; it does not ship an image renderer for PNG',
        'Use --out card.svg, or download a PNG with the Share button under Saves in Mission Control (mindly dashboard)',
      );
    }
    if (ext !== '.svg') throw new UsageError('--out must be an .svg file, e.g. --out card.svg');
    file = resolve(out.io.cwd, o.out);
    if (existsSync(file) && !o.force) {
      throw new HintedError(
        'conflict',
        `${file} already exists, so no card was written`,
        'Choose another --out file, or add --force to overwrite it',
      );
    }
  }
  return withProject(out.io, ({ mindly, project }) => {
    const pid = project.project.id;
    const svc = savesOf(mindly);
    svc.sweep(pid);
    const now = mindly.kernel.clock.now();
    const since = o.week ? startOfLocalWeek(now) : now - span;
    const summary = svc.summary(pid, since);
    const svg = renderSavesCard({
      summary,
      until: now,
      ...(o.details
        ? {
            details: {
              projectName: project.project.name,
              saves: summary.recent.map((s) => ({ title: s.title, paths: s.paths })),
            },
          }
        : {}),
    });
    if (file === null) {
      out.io.stdout.write(svg);
      return 0;
    }
    writeFileSync(file, svg, { mode: 0o644 });
    const sc = out.screen();
    sc.text(
      `${sc.mark('ok')} Wrote the card for ${summary.total} ${summary.total === 1 ? 'save' : 'saves'} to ${file}`,
    );
    sc.note(
      o.details
        ? 'It includes the project name, file paths and save details: check it before you share it.'
        : 'It shows counts and agent names only: no project name, file paths or code.',
      2,
    );
    return 0;
  });
}

import { useEffect, useState } from 'react';
import { describeError } from '../api';
import { useAction, useApp } from '../state';
import type { Save, SavesResult } from '../types';
import { COLUMNS, EMPTY, productName, saveKindWords, saveStatusWords, shortId } from '../vocab';
import {
  Age,
  CodeText,
  CopyId,
  DataTable,
  Drawer,
  DotWord,
  Empty,
  Facts,
  Panel,
  Paths,
  type Column,
} from './ui';

/**
 * The Saves panel of the overview: confirmed saves of the last 7 days (when · what · agents), a
 * line for saves still waiting for evidence, "Not a save" in each row's menu, and the Share
 * button that opens the weekly card.
 */
export function SavesPanel({ res, onChange }: { res: SavesResult | undefined; onChange(): void }) {
  const { client, sessions } = useApp();
  const { busy, run } = useAction();
  const [sharing, setSharing] = useState(false);
  const confirmed = (res?.saves ?? []).filter((s) => s.status === 'confirmed');
  const pending = (res?.saves ?? []).filter((s) => s.status === 'caught').length;
  const agents = (s: Save) =>
    [...new Set(s.sessionIds.map((id) => productName(sessions.get(id)?.agentKind)))].join(', ');
  const cols: Column<Save>[] = [
    { key: 'when', header: COLUMNS.when, kind: 'meta', cell: (s) => <Age ms={s.createdAt} /> },
    {
      key: 'what',
      header: COLUMNS.what,
      kind: 'main',
      title: (s) => s.title,
      cell: (s) => <CodeText text={s.title} />,
    },
    { key: 'agents', header: COLUMNS.agents, kind: 'clip', cell: agents },
  ];
  return (
    <Panel
      title="Saves"
      help="saves"
      meta={res ? `${res.summary.total} this week` : undefined}
      actions={
        <button
          type="button"
          className="btn-primary"
          disabled={!res || res.summary.total === 0}
          onClick={() => setSharing(true)}
        >
          Share
        </button>
      }
    >
      {confirmed.length === 0 ? (
        <Empty>{EMPTY.saves}</Empty>
      ) : (
        <DataTable
          label="Saves"
          columns={cols}
          rows={confirmed}
          rowKey={(s) => s.id}
          menuLabel={(s) => `Actions for save ${shortId(s.id)}`}
          menu={(s) => [
            {
              label: 'Not a save',
              danger: true,
              disabled: busy !== null,
              onSelect: () =>
                void run(
                  `save:${s.id}`,
                  () => client.rejectSave(s.id),
                  'Removed from your saves',
                ).then((ok) => ok && onChange()),
            },
          ]}
          detail={(s) => (
            <Facts
              items={[
                ['Kind', saveKindWords(s.kind)],
                [
                  'Status',
                  <DotWord key="st" tone="good">
                    {saveStatusWords(s.status)}
                  </DotWord>,
                ],
                ['Files', s.paths.length > 0 && <Paths key="p" paths={s.paths} max={Infinity} />],
                [
                  'Evidence',
                  `${s.evidence.length} recorded event${s.evidence.length === 1 ? '' : 's'}`,
                ],
                ['Id', <CopyId key="id" id={s.id} label="save id" />],
              ]}
            />
          )}
        />
      )}
      {pending > 0 && (
        <p className="line-meta muted">{pending} more waiting for evidence (not counted yet)</p>
      )}
      <ShareDrawer open={sharing} onClose={() => setSharing(false)} />
    </Panel>
  );
}

/** Draws an SVG data URL on a canvas at 2x and returns a PNG data URL (no server involved). */
async function svgToPng(svgUrl: string): Promise<string> {
  const img = new Image();
  img.src = svgUrl;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth * 2;
  canvas.height = img.naturalHeight * 2;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot draw the card.');
  ctx.scale(2, 2);
  ctx.drawImage(img, 0, 0);
  return canvas.toDataURL('image/png');
}

function download(url: string, name: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
}

/**
 * The weekly card: a preview, an opt-in for project details, and downloads as SVG or PNG. The
 * card carries counts and agent names only unless the user includes details.
 */
function ShareDrawer({ open, onClose }: { open: boolean; onClose(): void }) {
  const { client, project, notify } = useApp();
  const [details, setDetails] = useState(false);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSvg(null);
    setError(null);
    client.savesCard(project.id, details).then(
      (text) => {
        if (!cancelled) setSvg(text);
      },
      (e: unknown) => {
        if (!cancelled) setError(describeError(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, details, client, project.id]);
  const url = svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : null;
  return (
    <Drawer open={open} onClose={onClose} title="Share your week" wide>
      <div className="detail-stack">
        {error ? (
          <Empty>{error}</Empty>
        ) : url ? (
          <img className="share-card" src={url} alt="Your Mindly saves this week" />
        ) : (
          <Empty>Drawing the card…</Empty>
        )}
        <label className="check-line">
          <input type="checkbox" checked={details} onChange={(e) => setDetails(e.target.checked)} />{' '}
          Include the project name, file paths and what each save was
        </label>
        <p className="muted">
          {details
            ? 'Check the card before you post it: it shows project details.'
            : 'Safe to post: only counts and agent names, no project name, paths or code.'}
        </p>
        <p className="line-meta">
          <button
            type="button"
            className="btn-primary"
            disabled={!url}
            onClick={() => url && download(url, 'mindly-saves.svg')}
          >
            Download SVG
          </button>
          <button
            type="button"
            className="tlink"
            disabled={!url}
            onClick={() =>
              url &&
              void svgToPng(url).then(
                (png) => download(png, 'mindly-saves.png'),
                (e: unknown) => notify(describeError(e), 'bad'),
              )
            }
          >
            Download PNG
          </button>
        </p>
      </div>
    </Drawer>
  );
}

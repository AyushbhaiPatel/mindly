import { describe, expect, it } from 'vitest';
import { CARD_CHAR_WIDTH_EM, renderSavesCard, type SavesSummary } from '../../src/index.js';

/*
 * Lays the card's text out the way the card itself estimates it (a character is a fixed share of
 * the font size per family) and checks that every line stays inside the white card and that no two
 * lines overlap. It needs no browser; it catches the layout mistakes, not font differences.
 */

interface Box {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function unescape(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function boxes(svg: string): { boxes: Box[]; W: number; H: number } {
  const W = Number(/ width="(\d+)"/.exec(svg)?.[1]);
  const H = Number(/ height="(\d+)"/.exec(svg)?.[1]);
  const out: Box[] = [];
  for (const m of svg.matchAll(/<text ([^>]*)>([^<]*)<\/text>/g)) {
    const attrs = m[1] ?? '';
    const attr = (name: string): string | undefined =>
      new RegExp(`(?:^| )${name}="([^"]*)"`).exec(attrs)?.[1];
    const text = unescape(m[2] ?? '');
    const size = Number(attr('font-size'));
    const family = attr('font-family') ?? '';
    const em = family.includes('monospace')
      ? CARD_CHAR_WIDTH_EM.mono
      : family.includes('serif') && !family.includes('sans-serif')
        ? CARD_CHAR_WIDTH_EM.serif
        : CARD_CHAR_WIDTH_EM.sans;
    const w = [...text].length * size * em;
    const anchor = attr('text-anchor') ?? 'start';
    const x0 = Number(attr('x'));
    const x = anchor === 'end' ? x0 - w : anchor === 'middle' ? x0 - w / 2 : x0;
    // Ascent of about 0.8 em above the baseline, descent of about 0.25 em below it.
    const y = Number(attr('y')) - size * 0.8;
    out.push({ text, x, y, w, h: size * 1.05 });
  }
  return { boxes: out, W, H };
}

function problems(svg: string): string[] {
  const { boxes: all, W, H } = boxes(svg);
  const out: string[] = [];
  for (const b of all) {
    if (b.x < 24 || b.x + b.w > W - 24 || b.y < 24 || b.y + b.h > H - 24) {
      out.push(
        `outside the card: "${b.text.slice(0, 50)}" x=${Math.round(b.x)}..${Math.round(b.x + b.w)}`,
      );
    }
  }
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i] as Box;
      const c = all[j] as Box;
      const ix = Math.min(a.x + a.w, c.x + c.w) - Math.max(a.x, c.x);
      const iy = Math.min(a.y + a.h, c.y + c.h) - Math.max(a.y, c.y);
      if (ix > 2 && iy > 2)
        out.push(`overlap: "${a.text.slice(0, 40)}" and "${c.text.slice(0, 40)}"`);
    }
  }
  return out;
}

const ALL_KINDS = {
  overlap_avoided: 9,
  impact_warned: 8,
  rule_enforced: 7,
  mistake_avoided: 6,
  merge_conflict_early: 5,
  check_broken_early: 4,
  limit_handoff: 3,
};
const UNTIL = 1_750_000_200_000;
const LONG_PATH = 'packages/engine/src/features/coordination/overlap-detection-service.ts';

describe('share card layout', () => {
  it('keeps the agents clear of the kind rows', () => {
    const summary: SavesSummary = {
      since: 1_749_400_000_000,
      total: 42,
      byKind: ALL_KINDS,
      byAgent: { 'claude-code': 21, codex: 12, cursor: 6, 'gemini-cli': 3 },
      recent: [],
    };
    expect(problems(renderSavesCard({ summary, until: UNTIL }))).toEqual([]);
    // Six agents, one with a long made-up name, next to the longest kind label.
    const many: SavesSummary = {
      ...summary,
      byKind: { overlap_avoided: 3 },
      byAgent: {
        'claude-code': 9,
        codex: 8,
        cursor: 7,
        'gemini-cli': 6,
        'a-very-long-agent-name-from-somewhere-else': 5,
        aider: 4,
      },
    };
    const svg = renderSavesCard({ summary: many, until: UNTIL });
    expect(problems(svg)).toEqual([]);
    expect(svg).toContain('Aider 4');
  });

  it('fits the files of a save on one line inside the card', () => {
    const summary: SavesSummary = {
      since: 1_749_400_000_000,
      total: 2,
      byKind: { impact_warned: 2 },
      byAgent: { codex: 2 },
      recent: [],
    };
    const title = 'Codex was told Claude Code changed code it uses before it wrote code using it';
    const svg = renderSavesCard({
      summary,
      until: UNTIL,
      details: {
        projectName: 'a project name long enough to run into the dates on the right of the card',
        saves: [
          { title, paths: [LONG_PATH, LONG_PATH, LONG_PATH] },
          { title: 'x'.repeat(200), paths: Array.from({ length: 9 }, (_, i) => `src/f${i}.ts`) },
          { title, paths: ['src/a.ts', 'src/b.ts'] },
        ],
      },
    });
    expect(problems(svg)).toEqual([]);
    // A long path keeps its start and its file name; what does not fit is counted.
    expect(svg).toContain('overlap-detection-service.ts');
    expect(svg).toMatch(/packages\/engine\/[^<]*…[^<]*overlap-detection-service\.ts/);
    expect(svg).toContain('+');
    expect(svg).toContain('more');
    expect(svg).toContain('src/a.ts, src/b.ts<');
  });

  it('keeps the standard 1200x630 card for up to six kinds', () => {
    const six = { ...ALL_KINDS, limit_handoff: 0 };
    const svg = renderSavesCard({
      summary: {
        since: 1_749_400_000_000,
        total: 39,
        byKind: six,
        byAgent: { 'claude-code': 9, codex: 8, cursor: 7, 'gemini-cli': 6, aider: 5, other: 4 },
        recent: [],
      },
      until: UNTIL,
    });
    expect(svg).toMatch(/^<svg [^>]*width="1200" height="630"/);
    expect(problems(svg)).toEqual([]);
  });
});

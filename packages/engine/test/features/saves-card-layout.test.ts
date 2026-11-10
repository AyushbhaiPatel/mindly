import { describe, expect, it } from 'vitest';
import {
  CARD_CHAR_WIDTH_EM,
  CARD_EMOJI_EM,
  CARD_WIDE_CHAR_EM,
  renderSavesCard,
  type SavesSummary,
} from '../../src/index.js';

/** Wide by script or block, independent of the card's own table. */
const WIDE =
  /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|[\u3000-\u303F\uFF00-\uFF60\uFFE0-\uFFE6]/u;
const EMOJI = /\p{Extended_Pictographic}/u;

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
    // A wide character (CJK, Hangul, kana, fullwidth forms) takes a full em, an emoji a bit more.
    let ems = 0;
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
      text,
    )) {
      ems += EMOJI.test(segment) ? CARD_EMOJI_EM : WIDE.test(segment) ? CARD_WIDE_CHAR_EM : em;
    }
    const w = ems * size;
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

  it('measures wide characters and emoji at their real width', () => {
    const summary: SavesSummary = {
      since: 1_749_400_000_000,
      total: 3,
      byKind: { impact_warned: 3 },
      byAgent: { codex: 2, 'エージェント-助手-도우미-代理人-アシスタント': 1 },
      recent: [],
    };
    const japanese = [
      'docs/設計/ユーザー管理機能の詳細設計書_第二版.md',
      'docs/設計/決済サービス連携の仕様と移行計画.md',
      'docs/議事録/2025年度第三四半期の振り返り.md',
    ];
    const svg = renderSavesCard({
      summary,
      until: UNTIL,
      details: {
        projectName: '顧客オンボーディング基盤のモノレポジトリ第二版ステージング環境用の設定一式',
        saves: [
          { title: 'Codex was told Claude Code changed code it uses', paths: japanese },
          {
            title: `${'결제 서비스의 변경 사항을 읽기 전에 덮어쓰지 않도록 멈췄습니다 '.repeat(3)}`,
            paths: ['src/한국어/결제서비스연동모듈의상세구현과테스트코드.ts', 'src/a.ts'],
          },
          {
            title: `Shipped 🚀🚀🚀 ${'👩‍💻'.repeat(60)}`,
            paths: [`assets/${'🎉'.repeat(40)}.png`, `assets/${'🔥'.repeat(40)}.png`],
          },
          {
            title: 'ＦＵＬＬＷＩＤＴＨ ＴＩＴＬＥ '.repeat(6),
            paths: ['ｓｒｃ／ｆｕｌｌｗｉｄｔｈ／ｆｉｌｅ＿ｎａｍｅ＿ｏｎｅ.ts'],
          },
        ],
      },
    });
    expect(problems(svg)).toEqual([]);
    // The file names are kept, the middles elided, and what does not fit is counted.
    expect(svg).toContain('docs/設計/ユーザー管理機能の詳細設計書_第二版.md, ');
    expect(svg).toMatch(/移行計画\.md, \+1 more</);
    expect(svg).toMatch(/assets\/🎉+…🎉+\.png/u);
    // An emoji sequence is never split.
    expect(svg).not.toMatch(/‍…|‍</);
  });

  it('leaves room for a large total next to its caption', () => {
    for (const total of [7, 42, 999, 1234, 98_765]) {
      const svg = renderSavesCard({
        summary: { since: 1_749_400_000_000, total, byKind: {}, byAgent: {}, recent: [] },
        until: UNTIL,
      });
      expect(problems(svg), String(total)).toEqual([]);
      // The serif's figures run wider than its letters: about 0.6 em each at 132 px.
      const caption = Number(/<text x="(\d+)" y="250" font-size="40"/.exec(svg)?.[1]);
      expect(caption, String(total)).toBeGreaterThanOrEqual(64 + String(total).length * 132 * 0.6);
    }
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

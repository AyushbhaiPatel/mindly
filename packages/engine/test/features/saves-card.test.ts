import { describe, expect, it } from 'vitest';
import type { Save } from '@mindly/core';
import {
  renderSavesCard,
  SAVE_KIND_LABELS,
  savesPeriodWords,
  startOfLocalWeek,
  type SavesSummary,
} from '../../src/index.js';

const SECRET_PATH = 'services/billing/zebra-ledger.ts';
const CODE = 'if (user.role === "admin") { grant(); }';

function save(over: Partial<Save>): Save {
  return {
    id: '019a0000-0000-7000-8000-000000000001',
    projectId: 'p',
    kind: 'impact_warned',
    status: 'confirmed',
    title: 'Codex was told Claude Code changed code it uses before it wrote code using it',
    sessionIds: ['s1'],
    paths: [SECRET_PATH],
    evidence: ['e1', 'e2'],
    fingerprint: 'f',
    refs: {},
    createdAt: 1_750_000_000_000,
    confirmedAt: 1_750_000_100_000,
    ...over,
  };
}

const summary: SavesSummary = {
  since: 1_749_400_000_000,
  total: 3,
  byKind: { impact_warned: 2, mistake_avoided: 1 },
  byAgent: { codex: 2, 'claude-code': 1 },
  recent: [
    save({}),
    save({
      id: '019a0000-0000-7000-8000-000000000002',
      title: `Ran \`${CODE}\` <script>x</script>`,
    }),
  ],
};

describe('saves card (AC6)', () => {
  it('shows counts by kind and agent names only by default', () => {
    const svg = renderSavesCard({ summary, until: 1_750_000_200_000 });
    expect(svg).toMatch(/^<svg [^>]*width="1200" height="630"/);
    expect(svg).toContain(SAVE_KIND_LABELS.impact_warned);
    expect(svg).toContain(SAVE_KIND_LABELS.mistake_avoided);
    expect(svg).not.toContain(SAVE_KIND_LABELS.rule_enforced);
    expect(svg).toContain('Codex');
    expect(svg).toContain('Claude Code');
    for (const secret of [
      SECRET_PATH,
      'zebra',
      'grant()',
      'user.role',
      'Codex was told',
      '<script',
    ]) {
      expect(svg, secret).not.toContain(secret);
    }
  });

  it('adds the project name, sentences and files with details, escaped', () => {
    const svg = renderSavesCard({
      summary,
      until: 1_750_000_200_000,
      details: {
        projectName: 'zebra <billing>',
        saves: summary.recent.map((s) => ({ title: s.title, paths: s.paths })),
      },
    });
    expect(svg).toContain('zebra &lt;billing&gt;');
    expect(svg).toContain(SECRET_PATH);
    expect(svg).toContain('Codex was told');
    expect(svg).not.toContain('<script');
  });

  it('names the period it covers, not always "this week"', () => {
    const now = new Date(2026, 10, 5, 15, 0).getTime(); // a Thursday
    const day = 86_400_000;
    expect(savesPeriodWords(startOfLocalWeek(now), now)).toBe('this week');
    expect(savesPeriodWords(now - 7 * day, now)).toBe('in the last 7 days');
    expect(savesPeriodWords(now - 30 * day, now)).toBe('in the last 30 days');
    expect(savesPeriodWords(now - day, now)).toBe('in the last day');
    expect(savesPeriodWords(now - 3_600_000 * 12, now)).toBe('in the last 12 hours');
    const svg = renderSavesCard({ summary: { ...summary, since: now - 30 * day }, until: now });
    expect(svg).toContain('saves in the last 30 days');
    expect(svg).not.toContain('this week');
  });

  it('draws an empty week without inventing anything', () => {
    const svg = renderSavesCard({
      summary: { since: 0, total: 0, byKind: {}, byAgent: {}, recent: [] },
      until: 1_750_000_200_000,
    });
    for (const label of Object.values(SAVE_KIND_LABELS)) expect(svg).not.toContain(label);
    expect(svg).toMatch(/>0</);
  });
});

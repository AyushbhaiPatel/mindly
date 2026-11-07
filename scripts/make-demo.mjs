#!/usr/bin/env node
// Generates docs/assets/demo.svg, the animated demo at the top of the README.
//
// Regenerate with:   pnpm demo        (= pnpm build && node scripts/make-demo.mjs)
//
// Everything in the demo is REAL Mindly output. The script:
//   1. builds a small billing repository in a temporary HOME and runs a three-agent scenario
//      against the built CLI through real hook payloads: Claude Code changes createInvoice() while
//      Codex works on the Stripe webhook that calls it, Cursor removes the webhook's signature
//      check (a decision with a check attached), Claude Code tries to edit an applied migration
//      (an enforced rule), and Codex caches tax rates, which breaks the billing tests;
//   2. captures what Mindly prints or tells each agent, runs `mindly bisect -- npm test`, starts
//      the daemon against the temporary home and takes a screenshot of Mission Control (light
//      mode) with the locally installed Chrome through playwright-core (no browser is downloaded);
//   3. renders six cross-fading scenes in Mindly's visual style into one self-contained SVG, with
//      Latin DM Sans and Newsreader embedded as base64 woff2 so it renders in the brand fonts even
//      inside an <img>. With prefers-reduced-motion the SVG shows the bisect scene only.
//
// Long command output is shortened to the lines that matter (marked with "…"); nothing is
// rewritten. Requirements: Google Chrome installed (playwright's `chrome` channel). Nothing
// touches the real ~/.mindly or any agent configuration; the daemon is stopped and temp dirs are
// deleted at the end.

/* global document, Image, NodeFilter -- used only inside page.evaluate(), which runs in the browser */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(repo, 'apps', 'cli', 'dist', 'main.js');
const out = join(repo, 'docs', 'assets', 'demo.svg');
const dashboardRequire = createRequire(join(repo, 'apps', 'dashboard', 'package.json'));

/** Base64 of a font file shipped by an @fontsource-variable package of the dashboard. */
function fontData(pkg, file) {
  const dir = dirname(dashboardRequire.resolve(`${pkg}/package.json`));
  return readFileSync(join(dir, 'files', file)).toString('base64');
}

const FONTS = {
  sans: fontData('@fontsource-variable/dm-sans', 'dm-sans-latin-wght-normal.woff2'),
  serif: fontData('@fontsource-variable/newsreader', 'newsreader-latin-wght-normal.woff2'),
  serifItalic: fontData('@fontsource-variable/newsreader', 'newsreader-latin-wght-italic.woff2'),
};
const FONT_FACES =
  `@font-face{font-family:"DM Sans";font-weight:100 1000;src:url(data:font/woff2;base64,${FONTS.sans}) format("woff2")}` +
  `@font-face{font-family:"Newsreader";font-weight:200 800;src:url(data:font/woff2;base64,${FONTS.serif}) format("woff2")}` +
  `@font-face{font-family:"Newsreader";font-style:italic;font-weight:200 800;src:url(data:font/woff2;base64,${FONTS.serifItalic}) format("woff2")}`;

// ------------------------------------------------------------------ the scenario

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mindly-demo-')));
const home = join(tmp, 'home');
const app = join(tmp, 'acme-billing');
mkdirSync(home, { recursive: true });
mkdirSync(app, { recursive: true });
const env = {
  PATH: process.env.PATH ?? '',
  HOME: home,
  MINDLY_HOME: join(home, '.mindly'),
  LANG: 'en_US.UTF-8',
  NO_COLOR: '1',
  COLUMNS: '84',
};
const REPO_LABEL = '~/acme-billing';

const git = (...args) =>
  execFileSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@example.invalid', ...args], {
    cwd: app,
    env,
  });
const mindly = (args, input) =>
  execFileSync(process.execPath, [cli, ...args], {
    cwd: app,
    env,
    input,
    encoding: 'utf8',
    timeout: 300_000,
  });
/** Runs one agent hook with a payload shaped the way that agent sends it. */
const hook = (agent, event, payload) =>
  mindly(
    ['hook', agent, event],
    JSON.stringify(
      agent === 'cursor'
        ? { workspace_roots: [app], hook_event_name: event, ...payload }
        : { cwd: app, hook_event_name: event, ...payload },
    ),
  );
/** Hides the temporary directory: the demo shows the repository as ~/acme-billing. */
const tidy = (s) => s.split(app).join(REPO_LABEL).split(tmp).join('~');
const put = (rel, text) => {
  mkdirSync(dirname(join(app, rel)), { recursive: true });
  writeFileSync(join(app, rel), text);
};
const read = (rel) => readFileSync(join(app, rel), 'utf8');
/** Applies an edit on disk, failing loudly when the scenario and the files drift apart. */
function apply(rel, oldText, newText) {
  const text = read(rel);
  if (!text.includes(oldText)) throw new Error(`demo: edit target not found in ${rel}`);
  put(rel, text.replace(oldText, newText));
}
/** The context Mindly returned to an agent, whatever the agent's output format. */
function contextOf(raw) {
  if (!raw) return '';
  const j = JSON.parse(raw);
  return j.hookSpecificOutput?.additionalContext ?? j.additional_context ?? j.agent_message ?? '';
}
/** The first delivered update of a kind, without the "[kind · from … · when]" prefix. */
function updateLine(context, kind) {
  const line = context.split('\n').find((l) => l.startsWith(`- [${kind}`));
  if (!line) throw new Error(`demo: no ${kind} update was delivered`);
  return line.replace(/^- \[[^\]]+\] /, '');
}

const claude = {
  prompt: (p) => hook('claude-code', 'UserPromptSubmit', { session_id: 'cc', prompt: p }),
  edit(rel, oldText, newText) {
    const tool_input = { file_path: join(app, rel), old_string: oldText, new_string: newText };
    const pre = JSON.parse(
      hook('claude-code', 'PreToolUse', { session_id: 'cc', tool_name: 'Edit', tool_input }) ||
        '{}',
    );
    if (pre.hookSpecificOutput?.permissionDecision === 'deny') {
      return { denied: pre.hookSpecificOutput.permissionDecisionReason };
    }
    apply(rel, oldText, newText);
    hook('claude-code', 'PostToolUse', {
      session_id: 'cc',
      tool_name: 'Edit',
      tool_input,
      tool_response: { success: true },
    });
    return { denied: null };
  },
};
const codex = {
  prompt: (p) => hook('codex', 'UserPromptSubmit', { session_id: 'cx', prompt: p }),
  patch(rel, oldText, newText) {
    const body = (sign, t) =>
      t
        .split('\n')
        .map((l) => sign + l)
        .join('\n');
    const patch = `*** Begin Patch\n*** Update File: ${rel}\n@@\n${body('-', oldText)}\n${body('+', newText)}\n*** End Patch`;
    const tool_input = { command: ['apply_patch', patch] };
    hook('codex', 'PreToolUse', { session_id: 'cx', tool_name: 'apply_patch', tool_input });
    apply(rel, oldText, newText);
    hook('codex', 'PostToolUse', {
      session_id: 'cx',
      tool_name: 'apply_patch',
      tool_input,
      tool_response: { output: 'Success' },
    });
  },
};
const cursor = {
  prompt: (p) => hook('cursor', 'beforeSubmitPrompt', { conversation_id: 'cu', prompt: p }),
  edit(rel, oldText, newText) {
    apply(rel, oldText, newText);
    hook('cursor', 'afterFileEdit', {
      conversation_id: 'cu',
      file_path: join(app, rel),
      edits: [{ old_string: oldText, new_string: newText }],
    });
  },
};

const OLD_SIGNATURE = 'export function createInvoice(customerId: string, items: LineItem[]) {';
const NEW_SIGNATURE = 'export function createInvoice(opts: InvoiceOptions) {';
const SIGNATURE_CHECK =
  '  const event = stripe.webhooks.constructEvent(body, signature, WEBHOOK_SECRET);';
const NO_SIGNATURE_CHECK = '  const event = JSON.parse(body);';

let captured;
let shot;
let browser;
let daemonStarted = false;
try {
  // A small billing service: a billing package, an API with a Stripe webhook, a web app and
  // database migrations. The billing tests run with plain `node --test`.
  put(
    'package.json',
    `${JSON.stringify({ name: 'acme-billing', private: true, type: 'module', scripts: { test: 'node --test packages/billing/test/' } }, null, 2)}\n`,
  );
  put(
    'packages/billing/src/invoice.ts',
    `import { taxFor } from './tax.ts';

export interface LineItem {
  sku: string;
  amount: number;
}

${OLD_SIGNATURE}
  const subtotal = items.reduce((sum, i) => sum + i.amount, 0);
  return { customerId, subtotal, tax: taxFor('EU', subtotal), currency: 'USD' };
}
`,
  );
  put(
    'packages/billing/src/tax.ts',
    `const RATES: Record<string, number> = { EU: 0.2, US: 0.07, UK: 0.2 };

export function setRate(region: string, rate: number) {
  RATES[region] = rate;
}

export function taxFor(region: string, amount: number) {
  return Math.round(amount * (RATES[region] ?? 0) * 100) / 100;
}
`,
  );
  put(
    'packages/billing/test/tax.test.ts',
    `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setRate, taxFor } from '../src/tax.ts';

test('tax follows the current rate', () => {
  assert.equal(taxFor('EU', 100), 20);
  setRate('EU', 0.21);
  assert.equal(taxFor('EU', 100), 21);
});
`,
  );
  put(
    'apps/api/src/webhooks/stripe.ts',
    `import Stripe from 'stripe';
import { createInvoice } from '../../../../packages/billing/src/invoice.ts';

const stripe = new Stripe(process.env.STRIPE_KEY ?? '');
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? '';

export async function handleStripeWebhook(body: string, signature: string) {
${SIGNATURE_CHECK}
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    return createInvoice(session.customer, session.line_items);
  }
  return null;
}
`,
  );
  put(
    'apps/web/src/settings/billing.tsx',
    `export function BillingSettings() {
  return <section><h2>Billing</h2></section>;
}
`,
  );
  put(
    'prisma/migrations/20261103_add_currency/migration.sql',
    "ALTER TABLE invoices ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD';\n",
  );
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'billing service');
  mindly(['init', '--project', '--yes', '--agents', 'claude-code,codex,cursor']);

  // What the team decided, recorded by the user.
  const decision = JSON.parse(
    mindly([
      'memory',
      'add',
      '--kind',
      'decision',
      '--title',
      'Stripe webhooks verify the signature',
      '--body',
      'Every handler calls stripe.webhooks.constructEvent before reading the event.',
      '--json',
    ]),
  );
  const decisionId = decision.id ?? decision.memory?.id;
  if (!decisionId) throw new Error('demo: memory add returned no id');
  mindly([
    'contract',
    'add',
    decisionId,
    '--kind',
    'pattern_present',
    '--path',
    'apps/api/src/webhooks/stripe.ts',
    '--pattern',
    'constructEvent\\(',
    '--json',
  ]);
  mindly([
    'memory',
    'add',
    '--kind',
    'rule',
    '--title',
    'Applied migrations are never edited; add a new migration instead',
    '--scope',
    'prisma/migrations/**',
    '--enforce',
    '--json',
  ]);
  mindly([
    'memory',
    'add',
    '--kind',
    'rule',
    '--title',
    'Tax rates are not cached across requests',
    '--scope',
    'packages/billing/src/tax.ts',
    '--json',
  ]);

  // Three agents start work on the same repository.
  hook('claude-code', 'SessionStart', { session_id: 'cc', source: 'startup' });
  hook('codex', 'SessionStart', { session_id: 'cx', source: 'startup' });
  hook('cursor', 'sessionStart', { conversation_id: 'cu' });
  codex.prompt('Create the invoice when Stripe checkout completes');
  codex.patch(
    'apps/api/src/webhooks/stripe.ts',
    "  if (event.type === 'checkout.session.completed') {",
    "  if (event.type === 'checkout.session.completed' && event.livemode) {",
  );
  cursor.prompt('Add a currency picker to the billing settings page');
  cursor.edit(
    'apps/web/src/settings/billing.tsx',
    '<h2>Billing</h2>',
    '<h2>Billing</h2>\n      <CurrencyPicker />',
  );
  const status = tidy(mindly(['status']));

  // Claude Code changes createInvoice; Codex's webhook calls it.
  const claudePrompt = 'Move createInvoice to an options object and add currency';
  claude.prompt(claudePrompt);
  claude.edit(
    'packages/billing/src/invoice.ts',
    `${OLD_SIGNATURE}
  const subtotal = items.reduce((sum, i) => sum + i.amount, 0);
  return { customerId, subtotal, tax: taxFor('EU', subtotal), currency: 'USD' };`,
    `export interface InvoiceOptions {
  customerId: string;
  lineItems: LineItem[];
  currency: string;
}

${NEW_SIGNATURE}
  const subtotal = opts.lineItems.reduce((sum, i) => sum + i.amount, 0);
  return { ...opts, subtotal, tax: taxFor('EU', subtotal) };`,
  );
  const codexPrompt = 'Also handle refunds in the webhook';
  const impact = updateLine(contextOf(codex.prompt(codexPrompt)), 'impact');
  codex.patch(
    'apps/api/src/webhooks/stripe.ts',
    '    return createInvoice(session.customer, session.line_items);',
    '    return createInvoice({ customerId: session.customer, lineItems: session.line_items, currency: session.currency });',
  );

  // Codex caches tax rates, against the project's rule; the billing tests now fail.
  const cachePrompt = 'make tax calculation faster, cache the rates per region';
  codex.prompt(cachePrompt);
  codex.patch(
    'packages/billing/src/tax.ts',
    `export function taxFor(region: string, amount: number) {
  return Math.round(amount * (RATES[region] ?? 0) * 100) / 100;
}`,
    `const cache = new Map<string, number>();

export function taxFor(region: string, amount: number) {
  if (!cache.has(region)) cache.set(region, RATES[region] ?? 0);
  return Math.round(amount * (cache.get(region) ?? 0) * 100) / 100;
}`,
  );

  // Ordinary work continues.
  claude.prompt('Show the currency on the invoice email');
  claude.edit('apps/web/src/settings/billing.tsx', '<section>', '<section className="billing">');
  cursor.prompt('Use the design system select for the currency picker');
  cursor.edit(
    'apps/web/src/settings/billing.tsx',
    '<CurrencyPicker />',
    '<CurrencyPicker size="sm" />',
  );

  // Cursor removes the signature check the team decided on.
  const cursorPrompt = 'simplify the stripe webhook handler, the signature check is noisy';
  cursor.prompt(cursorPrompt);
  cursor.edit('apps/api/src/webhooks/stripe.ts', SIGNATURE_CHECK, NO_SIGNATURE_CHECK);
  const broken = updateLine(
    contextOf(claude.prompt('Now update the invoice email template')),
    'conflict',
  );

  // Claude Code tries to edit a migration that has already been applied.
  const migrationPrompt = 'The currency default should be EUR';
  claude.prompt(migrationPrompt);
  const migration = 'prisma/migrations/20261103_add_currency/migration.sql';
  const blocked = claude.edit(migration, "DEFAULT 'USD'", "DEFAULT 'EUR'").denied;
  if (!blocked) throw new Error('demo: the enforced rule did not block the write');

  const bisect = tidy(mindly(['bisect', '--', 'npm', 'test']));
  captured = {
    status,
    claudePrompt,
    codexPrompt,
    impact,
    cursorPrompt,
    broken,
    migrationPrompt,
    migration,
    blocked,
    bisect,
  };

  // ---------------------------------------------------------------- Mission Control screenshot
  mindly(['daemon', 'start']);
  daemonStarted = true;
  const state = JSON.parse(readFileSync(join(env.MINDLY_HOME, 'daemon.json'), 'utf8'));
  const token = readFileSync(join(env.MINDLY_HOME, 'daemon.token'), 'utf8').trim();
  const base = `http://127.0.0.1:${Number(state.port)}`;
  const codeRes = await fetch(`${base}/api/auth/codes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  });
  if (!codeRes.ok) throw new Error(`login code request failed: HTTP ${codeRes.status}`);
  const { code } = await codeRes.json();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(code)) throw new Error('invalid login code');

  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  await page.goto(`${base}/#login=${code}`);
  await page.getByRole('region', { name: 'Agents' }).waitFor({ timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800);
  await page.evaluate(
    ([appPath, tmpPath, label]) => {
      // Show the temporary repository the way a user would see their own.
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        n.textContent = (n.textContent ?? '').split(appPath).join(label).split(tmpPath).join('~');
      }
    },
    [app, tmp, REPO_LABEL],
  );
  const width = 1280;
  const height = 700;
  const png = await page.screenshot({ clip: { x: 0, y: 0, width, height } });
  shot = { png, width, height };
  await context.close();
} finally {
  if (daemonStarted) {
    try {
      mindly(['daemon', 'stop']);
    } catch (err) {
      console.error(`demo: could not stop the daemon: ${err.message}`);
    }
  }
  if (!shot && browser) await browser.close();
  rmSync(tmp, { recursive: true, force: true });
}

// ------------------------------------------------------------------ shorten the output

/** Agent labels as people read them: "claude-code #cf395b2f" becomes "Claude Code". */
const AGENT_NAMES = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor' };
const named = (s) =>
  s.replace(/\b(claude-code|codex|cursor) #[0-9a-f]{6,}/g, (_, k) => AGENT_NAMES[k]);

const statusLines = captured.status.trimEnd().split('\n');

/**
 * The bisect report without the stack trace: the verdict, who and why, the last good step, the
 * assertion that failed, and the next commands.
 */
function bisectLines(report) {
  const lines = report.trimEnd().split('\n');
  const tail = lines.findIndex((l) => l.trim().startsWith('failing output'));
  const next = lines.findIndex((l) => /^(→|->)/.test(l));
  if (tail < 0 || next < 0) throw new Error('demo: unexpected bisect report');
  const assertion = lines
    .slice(tail + 1, next)
    .filter((l) => /^\s*(actual|expected):/.test(l))
    .map((l) => l.replace(/,\s*$/, ''));
  if (assertion.length !== 2) throw new Error('demo: bisect output has no assertion');
  return {
    head: lines.slice(0, tail),
    failing: `  failing: ${assertion.map((l) => l.trim()).join(', ')}`,
    next: lines.slice(next).filter((l) => l.trim() !== ''),
  };
}
const bisect = bisectLines(captured.bisect);

// ------------------------------------------------------------------ layout

const W = 860;
const CARD = { x: 28, y: 104, w: 804 };
const BAR = 42; // card title bar
const BODY_X = CARD.x + 26;
const BODY_W = CARD.w - 52;
const LINE = 24;
const MONO = 13.5;
const NOTE = 16; // font size of what Mindly delivered
const NOTE_LINE = 25;
const IMG_W = CARD.w - 2;
const FADE = 0.7; // cross-fade, seconds

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const COLOURS = {
  'Claude Code': '#c26a4a',
  Codex: '#3d7be0',
  Cursor: '#8a6cd8',
  Terminal: '#8d8a80',
  Browser: '#2f9e7a',
};
const TONES = {
  info: { fill: '#3d7be0', label: '#2563c9' },
  alert: { fill: '#d0563a', label: '#b2452c' },
};

// Measure and encode in the browser: real font metrics for wrapping, and Chrome's WebP encoder.
const measurePage = await browser.newPage();
let encoded;
let wrap;
try {
  await measurePage.setContent(
    `<style>${FONT_FACES}</style><p style="font-family:'DM Sans'">a</p><p style="font-family:Newsreader">a</p><p style="font-family:Newsreader;font-style:italic">a</p>`,
  );
  await measurePage.evaluate(async () => {
    await document.fonts.load('15px "DM Sans"');
    await document.fonts.load('26px Newsreader');
    await document.fonts.load('italic 26px Newsreader');
  });
  const notes = [named(captured.impact), named(captured.broken), captured.blocked];
  const wrapped = await measurePage.evaluate(
    ([texts, max, size]) => {
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.font = `400 ${size}px "DM Sans"`;
      return texts.map((text) => {
        const lines = [];
        let cur = '';
        for (const word of text.split(/\s+/)) {
          const next = cur ? `${cur} ${word}` : word;
          if (cur && ctx.measureText(next).width > max) {
            lines.push(cur);
            cur = word;
          } else cur = next;
        }
        if (cur) lines.push(cur);
        return lines;
      });
    },
    [notes, BODY_W - 44, NOTE],
  );
  wrap = { impact: wrapped[0], broken: wrapped[1], blocked: wrapped[2] };
  const targetW = IMG_W * 2;
  const targetH = Math.round((shot.height / shot.width) * targetW);
  encoded = await measurePage.evaluate(
    async ([b64, w, h]) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);
      return c.toDataURL('image/webp', 0.86).replace(/^data:image\/webp;base64,/, '');
    },
    [shot.png.toString('base64'), targetW, targetH],
  );
} finally {
  await browser.close();
}
const IMG_H = Math.round((shot.height / shot.width) * IMG_W);

// ------------------------------------------------------------------ scenes

/**
 * A scene: a step label, a serif title with one italic word, the card's title bar, and rows.
 * Row kinds: prompt, tool, del, add, note, out, strong, warn, next, more, blank.
 */
const scenes = [
  {
    step: 'Three agents, one repository',
    title: ['Three agents. ', 'One', ' shared view.'],
    agent: 'Terminal',
    where: REPO_LABEL,
    dur: 5,
    rows: [
      ['prompt', 'mindly status'],
      ['blank'],
      ...statusLines.map((l) => [/^Agents$/.test(l) ? 'strong' : 'out', l]),
    ],
  },
  {
    step: 'Change warnings',
    title: ['Codex hears about it ', 'before', ' it breaks.'],
    agent: 'Claude Code',
    where: `${REPO_LABEL} · packages/billing`,
    dur: 7,
    rows: [
      ['prompt', captured.claudePrompt],
      ['tool', 'Edit packages/billing/src/invoice.ts'],
      ['del', OLD_SIGNATURE],
      ['add', NEW_SIGNATURE],
      ['blank'],
      ['note', { label: 'Mindly → Codex, on its next step', tone: 'info', lines: wrap.impact }],
    ],
  },
  {
    step: 'Decisions that check themselves',
    title: ['A decision that ', 'checks', ' itself.'],
    agent: 'Cursor',
    where: `${REPO_LABEL} · apps/api`,
    dur: 7,
    rows: [
      ['prompt', captured.cursorPrompt],
      ['tool', 'Edit apps/api/src/webhooks/stripe.ts'],
      ['del', SIGNATURE_CHECK.trim()],
      ['add', NO_SIGNATURE_CHECK.trim()],
      ['blank'],
      ['note', { label: 'Mindly → every agent', tone: 'alert', lines: wrap.broken }],
    ],
  },
  {
    step: 'Enforced rules',
    title: ['Some rules ', "don't", ' bend.'],
    agent: 'Claude Code',
    where: `${REPO_LABEL} · prisma`,
    dur: 5.5,
    rows: [
      ['prompt', captured.migrationPrompt],
      ['tool', `Edit ${captured.migration}`],
      ['blank'],
      ['note', { label: 'Mindly blocked the write', tone: 'alert', lines: wrap.blocked }],
    ],
  },
  {
    step: 'mindly bisect',
    title: ['Which edit ', 'broke', ' the tests?'],
    agent: 'Terminal',
    where: REPO_LABEL,
    dur: 8,
    rows: [
      ['prompt', 'mindly bisect -- npm test'],
      ['blank'],
      ...bisect.head.map((l, k) => [k === 0 ? 'strong' : 'out', l]),
      ['warn', bisect.failing],
      ['blank'],
      ...bisect.next.map((l) => ['next', l]),
    ],
  },
  {
    step: 'Mission Control',
    title: ['Every agent, ', 'live', ', in one place.'],
    agent: 'Browser',
    where: 'mindly dashboard · 127.0.0.1',
    dur: 6,
    image: true,
  },
];
const DURS = scenes.map((s) => s.dur);
const LOOP = DURS.reduce((a, b) => a + b, 0);

// Height of a scene's body, to size the card for the tallest one.
function bodyHeight(scene) {
  if (scene.image) return IMG_H;
  let h = 28;
  for (const [kind, value] of scene.rows) {
    h += kind === 'note' ? 34 + value.lines.length * NOTE_LINE + 18 : LINE;
  }
  return h + 14;
}
const CARD_H = BAR + Math.max(...scenes.map(bodyHeight));
const H = CARD.y + CARD_H + 30;

// Monospace rows must fit the card (0.62em is wider than common monospace fonts).
for (const scene of scenes) {
  for (const [kind, value] of scene.rows ?? []) {
    if (typeof value !== 'string' || kind === 'prompt') continue;
    const extra = kind === 'del' || kind === 'add' ? 28 : 0;
    if (value.length * MONO * 0.62 + extra > BODY_W) {
      throw new Error(`demo: row too wide in "${scene.step}": ${value}`);
    }
  }
}

// ------------------------------------------------------------------ animation

const starts = DURS.reduce((acc, d, i) => [...acc, (acc[i] ?? 0) + d], [0]).slice(0, -1);
/** Keyframe offset for a time in seconds, clamped to the loop. */
const pct = (t) => `${((Math.min(Math.max(t, 0), LOOP) / LOOP) * 100).toFixed(3)}%`;

let css = '';
/**
 * Keyframes for a scene group. At each cut the outgoing scene fades out slightly ahead of the
 * incoming one fading in, so the two overlap only briefly (no smeared double text). The cut from
 * the last scene back to the first happens in the loop's final FADE seconds.
 */
const fadeOut = (c) => [c - FADE / 2, c + FADE / 6];
const fadeIn = (c) => [c - FADE / 6, c + FADE / 2];
function sceneKeyframes(i) {
  const cutIn = i === 0 ? LOOP - FADE / 2 : starts[i];
  const cutOut = i === scenes.length - 1 ? LOOP - FADE / 2 : starts[i] + DURS[i];
  const [o0, o1] = fadeOut(cutOut);
  const [i0, i1] = fadeIn(cutIn);
  if (i === 0) {
    return `0%{opacity:1}${pct(o0)}{opacity:1}${pct(o1)}{opacity:0}${pct(i0)}{opacity:0}100%{opacity:1}`;
  }
  return `0%{opacity:0}${pct(i0)}{opacity:0}${pct(i1)}{opacity:1}${pct(o0)}{opacity:1}${pct(o1)}{opacity:0}100%{opacity:0}`;
}
scenes.forEach((_, i) => {
  css += `@keyframes s${i}{${sceneKeyframes(i)}}.s${i}{opacity:${i === 0 ? 1 : 0};animation:s${i} ${LOOP}s linear infinite}\n`;
});

let rowCount = 0;
/** A row that appears `delay` seconds into scene `i` and stays until the scene has faded out. */
function rowClass(i, delay) {
  const a = starts[i] + delay;
  const last = i === scenes.length - 1;
  const e = starts[i] + DURS[i] + FADE / 2;
  const name = `r${rowCount++}`;
  const hold = last
    ? '100%{opacity:1;transform:none}'
    : `${pct(e)}{opacity:1;transform:none}${pct(e + 0.05)}{opacity:0}100%{opacity:0}`;
  css += `@keyframes ${name}{0%{opacity:0;transform:translateY(4px)}${pct(a)}{opacity:0;transform:translateY(4px)}${pct(a + 0.35)}{opacity:1;transform:none}${hold}}`;
  css += `.${name}{opacity:0;animation:${name} ${LOOP}s cubic-bezier(.16,1,.3,1) infinite}\n`;
  return name;
}

// ------------------------------------------------------------------ render

const SANS = 'font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif';
const bodyTop = CARD.y + BAR;

function renderTitle(scene, i) {
  const [a, em, b] = scene.title;
  let g = `<text x="${CARD.x + 2}" y="48" class="step">${String(i + 1).padStart(2, '0')}  ·  ${esc(scene.step)}</text>`;
  g += `<text x="${CARD.x}" y="84" class="title">${esc(a)}<tspan class="em">${esc(em)}</tspan>${esc(b)}</text>`;
  g += `<circle cx="${W - CARD.x - 6 - (scenes.length - 1 - i) * 16}" cy="80" r="4" fill="#3686e7"/>`;
  return g;
}

function renderBar(scene) {
  const y = CARD.y + BAR / 2 + 5;
  let g = `<circle cx="${CARD.x + 22}" cy="${CARD.y + BAR / 2}" r="4" fill="${COLOURS[scene.agent]}"/>`;
  g += `<text x="${CARD.x + 34}" y="${y}" class="bar">${esc(scene.agent)}</text>`;
  g += `<text x="${CARD.x + CARD.w - 20}" y="${y}" class="bar-meta">${esc(scene.where)}</text>`;
  return g;
}

function renderRows(scene, i) {
  let g = '';
  let y = bodyTop + 38;
  let n = 0;
  const delay = () => 0.35 + Math.min(n++, 16) * 0.13;
  for (const [kind, value] of scene.rows) {
    if (kind === 'blank') {
      y += LINE;
      continue;
    }
    if (kind === 'note') {
      const cls = rowClass(i, delay() + 0.6);
      const tone = TONES[value.tone];
      const h = 34 + value.lines.length * NOTE_LINE + 4;
      g += `<g class="${cls}">`;
      g += `<rect x="${BODY_X}" y="${y - 8}" width="${BODY_W}" height="${h}" rx="10" fill="${tone.fill}" fill-opacity="0.08"/>`;
      g += `<rect x="${BODY_X}" y="${y - 8}" width="3" height="${h}" rx="1.5" fill="${tone.fill}"/>`;
      g += `<text x="${BODY_X + 22}" y="${y + 12}" class="note-label" fill="${tone.label}">${esc(value.label)}</text>`;
      value.lines.forEach((l, k) => {
        g += `<text x="${BODY_X + 22}" y="${y + 38 + k * NOTE_LINE}" class="note">${esc(l)}</text>`;
      });
      g += '</g>';
      y += h + 18;
      continue;
    }
    const cls = rowClass(i, delay());
    const base = y + 9;
    if (kind === 'prompt') {
      const terminal = scene.agent === 'Terminal';
      const sign = terminal ? '$' : '›';
      g += `<text x="${BODY_X}" y="${base}" class="${cls} ${terminal ? 'mono' : 'ask'}"><tspan class="dim">${sign}</tspan> <tspan class="ink">${esc(value)}</tspan></text>`;
    } else if (kind === 'tool') {
      const [verb, ...rest] = value.split(' ');
      g += `<g class="${cls}"><circle cx="${BODY_X + 4}" cy="${base - 4.5}" r="3.5" fill="${COLOURS[scene.agent]}"/>`;
      g += `<text x="${BODY_X + 16}" y="${base}" class="mono"><tspan class="ink" font-weight="600">${esc(verb)}</tspan><tspan class="ink2"> ${esc(rest.join(' '))}</tspan></text></g>`;
    } else if (kind === 'del' || kind === 'add') {
      const fill = kind === 'del' ? '#e0607e' : '#2fb386';
      const mark = kind === 'del' ? '−' : '+';
      g += `<g class="${cls}"><rect x="${BODY_X}" y="${y - 6}" width="${BODY_W}" height="${LINE}" rx="4" fill="${fill}" fill-opacity="${kind === 'del' ? 0.11 : 0.13}"/>`;
      g += `<text x="${BODY_X + 10}" y="${base}" class="mono"><tspan class="${kind}">${mark}</tspan><tspan class="ink2">  ${esc(value)}</tspan></text></g>`;
    } else {
      g += `<text x="${BODY_X}" y="${base}" class="${cls} mono ${kind}">${esc(value) || ' '}</text>`;
    }
    y += LINE;
  }
  return g;
}

function renderImage(i) {
  const cls = rowClass(i, 0.2);
  return (
    `<g class="${cls}" clip-path="url(#cardBody)">` +
    `<image x="${CARD.x + 1}" y="${bodyTop}" width="${IMG_W}" height="${IMG_H}" preserveAspectRatio="xMidYMin slice" href="data:image/webp;base64,${encoded}"/>` +
    `</g>`
  );
}

let scenesSvg = '';
scenes.forEach((scene, i) => {
  const inner =
    renderTitle(scene, i) +
    renderBar(scene) +
    (scene.image ? renderImage(i) : renderRows(scene, i));
  scenesSvg += `<g class="s${i}">${inner}</g>\n`;
});

const dots = scenes
  .map(
    (_, i) =>
      `<circle cx="${W - CARD.x - 6 - (scenes.length - 1 - i) * 16}" cy="80" r="4" fill="none" stroke="#c9c6bb"/>`,
  )
  .join('');

const label =
  'Mindly demo, recorded from a real run. Three agents work on one billing repository. Claude Code ' +
  'changes createInvoice() and Codex, whose Stripe webhook calls it, is told before its next step. ' +
  'Cursor removes the webhook signature check and every agent is told that a recorded decision no ' +
  'longer holds. An edit to an applied migration is blocked by an enforced rule. mindly bisect finds ' +
  'the Codex edit that broke the billing tests, with the prompt behind it, and Mission Control shows ' +
  'the same live view in the browser.';

const reducedShown = scenes.findIndex((s) => s.step === 'mindly bisect');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">
<title>${esc(label)}</title>
<!-- Generated by scripts/make-demo.mjs (pnpm demo). Embedded fonts: DM Sans and Newsreader (Latin subsets from @fontsource-variable), licensed under the SIL Open Font License 1.1. -->

<defs>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbfdff"/><stop offset=".38" stop-color="#edf8ff"/><stop offset=".66" stop-color="#e8f4fb"/><stop offset="1" stop-color="#fbfdff"/></linearGradient>
<radialGradient id="glow"><stop offset="0" stop-color="#93d2f8" stop-opacity=".5"/><stop offset=".52" stop-color="#bae6fd" stop-opacity=".3"/><stop offset=".76" stop-color="#bae6fd" stop-opacity="0"/></radialGradient>
<radialGradient id="cloudA"><stop offset="0" stop-color="#e0f2fe" stop-opacity=".85"/><stop offset="1" stop-color="#e0f2fe" stop-opacity="0"/></radialGradient>
<radialGradient id="cloudB"><stop offset="0" stop-color="#7dd3fc" stop-opacity=".45"/><stop offset="1" stop-color="#7dd3fc" stop-opacity="0"/></radialGradient>
<radialGradient id="cloudC"><stop offset="0" stop-color="#ffffff" stop-opacity=".8"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
<radialGradient id="cloudD"><stop offset="0" stop-color="#60a5fa" stop-opacity=".28"/><stop offset="1" stop-color="#60a5fa" stop-opacity="0"/></radialGradient>
<filter id="blur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="28"/></filter>
<filter id="shadow" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="10" stdDeviation="16" flood-color="#14284a" flood-opacity=".10"/></filter>
<clipPath id="frame"><rect width="${W}" height="${H}" rx="18"/></clipPath>
<clipPath id="cardBody"><path d="M${CARD.x + 1} ${bodyTop}H${CARD.x + CARD.w - 1}V${CARD.y + CARD_H - 14}a13 13 0 0 1-13 13H${CARD.x + 14}a13 13 0 0 1-13-13Z"/></clipPath>
</defs>
<style>
${FONT_FACES}
text{${SANS};white-space:pre}
.mono{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;font-size:${MONO}px}
.ask{font-size:15px}
.step{font-size:12.5px;fill:#6b6a64;letter-spacing:.01em}
.title{font-family:Newsreader,Georgia,"Times New Roman",serif;font-size:30px;fill:#141413;letter-spacing:-.02em}
.em{font-style:italic}
.bar{font-size:13.5px;font-weight:500;fill:#141413}
.bar-meta{font-size:13px;fill:#6b6a64;text-anchor:end}
.dim{fill:#8d8a80}.ink{fill:#141413}.ink2{fill:#3d3d3a}
.del{fill:#c2415f;font-weight:700}.add{fill:#13865f;font-weight:700}
.out{fill:#3d3d3a}.strong{fill:#141413;font-weight:700}.warn{fill:#b2452c}.next{fill:#2563c9}
.note-label{font-size:12.5px;font-weight:600;letter-spacing:.01em}
.note{font-size:${NOTE}px;fill:#141413}
${css}
@media (prefers-reduced-motion:reduce){
g,text{animation:none!important;transform:none!important}
.s${reducedShown},.s${reducedShown} *{opacity:1!important}
${scenes
  .map((_, i) => i)
  .filter((i) => i !== reducedShown)
  .map((i) => `.s${i}`)
  .join(',')}{opacity:0!important}
}
</style>
<g clip-path="url(#frame)">
<rect width="${W}" height="${H}" fill="url(#sky)"/>
<g filter="url(#blur)">
<ellipse cx="${W / 2}" cy="${H * 0.55}" rx="${W * 0.62}" ry="${H * 0.42}" fill="url(#glow)"/>
<ellipse cx="${W * 0.08}" cy="${H * 0.3}" rx="${W * 0.3}" ry="46" fill="url(#cloudA)"/>
<ellipse cx="${W * 0.45}" cy="${H * 0.52}" rx="${W * 0.34}" ry="52" fill="url(#cloudB)"/>
<ellipse cx="${W * 0.74}" cy="${H * 0.22}" rx="${W * 0.26}" ry="40" fill="url(#cloudC)"/>
<ellipse cx="${W * 0.96}" cy="${H * 0.7}" rx="${W * 0.36}" ry="58" fill="url(#cloudD)"/>
<ellipse cx="${W * 0.2}" cy="${H * 0.82}" rx="${W * 0.3}" ry="44" fill="url(#cloudA)"/>
</g>
<text x="${W - CARD.x}" y="50" text-anchor="end" style="font-family:Newsreader,Georgia,serif;font-size:19px;fill:#141413;letter-spacing:-.01em">mind<tspan class="em">ly</tspan></text>
${dots}
<rect x="${CARD.x}" y="${CARD.y}" width="${CARD.w}" height="${CARD_H}" rx="14" fill="#ffffff" fill-opacity=".78" stroke="#e2dfd4" filter="url(#shadow)"/>
<path d="M${CARD.x + 1} ${CARD.y + BAR}H${CARD.x + CARD.w - 1}" stroke="#e2dfd4"/>
${scenesSvg}</g>
</svg>
`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, svg);
console.log(
  `demo: wrote ${out} (${(svg.length / 1024).toFixed(0)} KiB, ${scenes.length} scenes, ${LOOP}s loop; ` +
    `image ${(encoded.length / 1024).toFixed(0)} KiB base64)`,
);

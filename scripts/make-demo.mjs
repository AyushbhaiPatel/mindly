#!/usr/bin/env node
// Generates docs/assets/demo.svg, the animated demo at the top of the README.
//
// Regenerate with:   pnpm demo        (= pnpm build && node scripts/make-demo.mjs)
//
// Everything in the demo is REAL Mindly output. The script:
//   1. runs a two-agent scenario against the built CLI in a temporary HOME and git repository
//      (Claude Code changes login() in src/auth.ts while Codex works on src/dashboard.ts, which
//      imports it) and captures what Mindly tells Codex and what `mindly status` prints;
//   2. starts the daemon against that temporary home, logs in with a one-time code and takes a
//      screenshot of Mission Control (light mode, 1280x800) with the locally installed Chrome
//      through playwright-core (no browser is downloaded);
//   3. renders four cross-fading scenes in Mindly's visual style into one self-contained SVG, with
//      Latin DM Sans and Newsreader embedded as base64 woff2 so it renders in the brand fonts even
//      inside an <img>. With prefers-reduced-motion the SVG shows the Mission Control frame only.
//
// Requirements: Google Chrome installed (playwright's `chrome` channel). Nothing touches the real
// ~/.mindly or any agent configuration; the daemon is stopped and temp dirs are deleted at the end.

/* global document, window, Image -- used only inside page.evaluate(), which runs in the browser */

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

// ------------------------------------------------------------------ run the scenario

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mindly-demo-')));
const home = join(tmp, 'home');
const app = join(tmp, 'my-app');
mkdirSync(home, { recursive: true });
mkdirSync(join(app, 'src'), { recursive: true });
const env = {
  PATH: process.env.PATH ?? '',
  HOME: home,
  MINDLY_HOME: join(home, '.mindly'),
  LANG: 'en_US.UTF-8',
  NO_COLOR: '1',
  COLUMNS: '86',
};

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
    timeout: 60_000,
  });
const hook = (agent, event, payload) =>
  mindly(['hook', agent, event], JSON.stringify({ cwd: app, ...payload }));
/** Hides the temporary directory: the demo shows the repo as ~/my-app. */
const tidy = (s) => s.split(app).join('~/my-app').split(tmp).join('~');

let codexContext;
let status;
let shot;
let browser;
let daemonStarted = false;
try {
  writeFileSync(
    join(app, 'src', 'auth.ts'),
    'export function login(user: string) {\n  return { user };\n}\n',
  );
  writeFileSync(
    join(app, 'src', 'dashboard.ts'),
    "import { login } from './auth';\nexport const session = login('ayush');\n",
  );
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'init');

  hook('claude-code', 'SessionStart', { session_id: 'cc', source: 'startup' });
  hook('codex', 'SessionStart', { session_id: 'cx', source: 'startup' });
  hook('codex', 'PreToolUse', {
    session_id: 'cx',
    tool_name: 'apply_patch',
    tool_input: {
      command: [
        'apply_patch',
        "*** Begin Patch\n*** Update File: src/dashboard.ts\n@@\n-export const session = login('ayush');\n+export const session = login('ayush');\n*** End Patch",
      ],
    },
  });
  hook('claude-code', 'UserPromptSubmit', {
    session_id: 'cc',
    prompt: 'Add a password parameter to login',
  });
  writeFileSync(
    join(app, 'src', 'auth.ts'),
    'export function login(user: string, password: string) {\n  return { user };\n}\n',
  );
  hook('claude-code', 'PostToolUse', {
    session_id: 'cc',
    tool_name: 'Edit',
    tool_input: {
      file_path: join(app, 'src', 'auth.ts'),
      old_string: 'login(user: string)',
      new_string: 'login(user: string, password: string)',
    },
    tool_response: { success: true },
  });
  const res = JSON.parse(
    hook('codex', 'UserPromptSubmit', { session_id: 'cx', prompt: 'finish the dashboard page' }),
  );
  codexContext = res.hookSpecificOutput.additionalContext;
  status = tidy(mindly(['status']));

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
  await page.waitForTimeout(600);
  const bottom = await page.evaluate(
    ([appPath, tmpPath]) => {
      // Show the temp repo the way a user would see their own: ~/my-app.
      for (const el of document.querySelectorAll('.root-path')) {
        el.textContent = (el.textContent ?? '').split(appPath).join('~/my-app');
        el.textContent = el.textContent.split(tmpPath).join('~');
      }
      const panel = (name) =>
        [...document.querySelectorAll('section.panel')].find((s) => {
          const id = s.getAttribute('aria-labelledby');
          return id && document.getElementById(id)?.textContent?.trim().startsWith(name);
        });
      // The top of the page down to the agents, plus the scenario's conflict when it is listed.
      const last = panel('Conflicts') ?? panel('Agents');
      if (!last) throw new Error('Agents section not found');
      return last.getBoundingClientRect().bottom + window.scrollY;
    },
    [app, tmp],
  );
  const width = 1280;
  const height = Math.ceil(bottom + 24);
  const png = await page.screenshot({ clip: { x: 0, y: 0, width, height }, fullPage: true });
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

// The update line Mindly delivered to Codex, without the reference-data preamble.
const update = codexContext
  .split('\n')
  .find((l) => l.startsWith('- [impact'))
  ?.replace(/^- \[impact · from [^\]]+\] /, '')
  .replace(/claude-code #[0-9a-f]+/g, 'Claude Code');
if (!update) throw new Error('scenario did not produce an impact update');

// ------------------------------------------------------------------ layout

const W = 860;
const CARD = { x: 28, y: 104, w: 804 };
const BAR = 42; // card title bar
const BODY_X = CARD.x + 26;
const BODY_W = CARD.w - 52;
const LINE = 25;
const MONO = 14.5;
const NOTE = 17; // font size of the update Mindly delivered
const NOTE_LINE = 27;
const IMG_W = CARD.w - 2;
const LOOP = 22; // seconds
const FADE = 0.7; // cross-fade, seconds
// Scene lengths in seconds; the last one (Mission Control) holds longest.
const DURS = [5, 5.5, 5, 6.5];

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Measure and encode in the browser: real font metrics for wrapping, and Chrome's WebP encoder.
const measurePage = await browser.newPage();
let encoded;
let wrapped;
let widest;
try {
  await measurePage.setContent(
    `<style>${FONT_FACES}</style><p style="font-family:'DM Sans'">a</p><p style="font-family:Newsreader">a</p><p style="font-family:Newsreader;font-style:italic">a</p>`,
  );
  await measurePage.evaluate(async () => {
    await document.fonts.load('15px "DM Sans"');
    await document.fonts.load('26px Newsreader');
    await document.fonts.load('italic 26px Newsreader');
  });
  wrapped = await measurePage.evaluate(
    ([text, max, size]) => {
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.font = `400 ${size}px "DM Sans"`;
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
      return { lines, widest: Math.max(...lines.map((l) => ctx.measureText(l).width)) };
    },
    [update, BODY_W - 44, NOTE],
  );
  widest = wrapped.widest;
  wrapped = wrapped.lines;
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
      return c.toDataURL('image/webp', 0.9).replace(/^data:image\/webp;base64,/, '');
    },
    [shot.png.toString('base64'), targetW, targetH],
  );
} finally {
  await browser.close();
}
const IMG_H = Math.round((shot.height / shot.width) * IMG_W);

// ------------------------------------------------------------------ scenes

/**
 * A scene: caption (serif title with one italic word), the card's title bar, and body rows.
 * Row kinds: prompt, tool, del, add, note (Mindly's update), out, warn, next, blank.
 */
const statusRows = status
  .trimEnd()
  .split('\n')
  .map((l) => [/^(→|->)/.test(l) ? 'next' : /^\s+!/.test(l) ? 'warn' : 'out', l]);
const longestStatus = Math.max(...statusRows.map(([, l]) => l.length));

const scenes = [
  {
    step: 'Claude Code',
    title: ['Claude Code ', 'changes', ' login()'],
    agent: { name: 'Claude Code', colour: '#b28cff' },
    where: '~/my-app',
    rows: [
      ['prompt', 'Add a password parameter to login'],
      ['blank', ''],
      ['tool', 'Edit src/auth.ts'],
      ['del', 'export function login(user: string) {'],
      ['add', 'export function login(user: string, password: string) {'],
    ],
  },
  {
    step: 'Codex',
    title: ['Mindly ', 'tells', ' Codex first'],
    agent: { name: 'Codex', colour: '#6aa8ff' },
    where: '~/my-app',
    rows: [
      ['prompt', 'finish the dashboard page'],
      ['blank', ''],
      ['note', wrapped],
    ],
  },
  {
    step: 'Terminal',
    title: ['One ', 'status', ' for every agent'],
    agent: { name: 'Terminal', colour: '#c9c6bb' },
    where: '~/my-app',
    rows: [['prompt', 'mindly status'], ['blank', ''], ...statusRows],
  },
  {
    step: 'Mission Control',
    title: ['The same view, ', 'live', ' in the browser'],
    agent: { name: 'Browser', colour: '#3fd9a8' },
    where: 'mindly dashboard · 127.0.0.1',
    image: true,
  },
];

// Height of a scene's body, to size the card for the tallest one.
function bodyHeight(scene) {
  if (scene.image) return IMG_H;
  let h = 24;
  for (const [kind, text] of scene.rows) {
    h += kind === 'note' ? 34 + text.length * NOTE_LINE + 14 : LINE;
  }
  return h + 18;
}
const CARD_H = BAR + Math.max(...scenes.map(bodyHeight));
const H = CARD.y + CARD_H + 30;

// Rough check that the monospace status output fits (0.62em is wider than common mono fonts).
const monoFits = longestStatus * MONO * 0.62 <= BODY_W;
if (!monoFits) throw new Error(`status output too wide: ${longestStatus} chars`);
if (widest > BODY_W - 44) throw new Error('update text overflows');

// ------------------------------------------------------------------ animation

const starts = DURS.reduce((acc, d, i) => [...acc, (acc[i] ?? 0) + d], [0]).slice(0, -1);
const total = DURS.reduce((a, b) => a + b, 0);
if (total !== LOOP) throw new Error('scene durations must add up to LOOP');
/** Keyframe offset for a time in seconds, clamped to the loop. */
const pct = (t) => `${((Math.min(Math.max(t, 0), LOOP) / LOOP) * 100).toFixed(3)}%`;

let css = '';
/**
 * Keyframes for a scene group. At each cut the outgoing scene fades out slightly ahead of the
 * incoming one fading in, so the two overlap only briefly (no smeared double text). The cut from
 * the last scene back to the first happens in the loop's final FADE seconds, so the loop wraps
 * with the same cross-fade as every other cut.
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
  // Progress: this scene's dot, filled.
  g += `<circle cx="${W - CARD.x - 6 - (scenes.length - 1 - i) * 16}" cy="80" r="4" fill="#3686e7"/>`;
  return g;
}

function renderBar(scene) {
  const y = CARD.y + BAR / 2 + 5;
  let g = `<circle cx="${CARD.x + 22}" cy="${CARD.y + BAR / 2}" r="4" fill="${scene.agent.colour}"/>`;
  g += `<text x="${CARD.x + 34}" y="${y}" class="bar">${esc(scene.agent.name)}</text>`;
  g += `<text x="${CARD.x + CARD.w - 20}" y="${y}" class="bar-meta">${esc(scene.where)}</text>`;
  return g;
}

function renderRows(scene, i) {
  let g = '';
  // Centre the rows in the card (sized for the tallest scene), a little above the middle.
  let y = bodyTop + 24 + Math.round(((CARD_H - BAR - bodyHeight(scene)) / 2) * 0.85);
  let n = 0;
  const delay = () => 0.35 + Math.min(n++, 14) * 0.16;
  for (const [kind, text] of scene.rows) {
    if (kind === 'blank') {
      y += LINE;
      continue;
    }
    if (kind === 'note') {
      const cls = rowClass(i, delay() + 0.5);
      const h = 34 + text.length * NOTE_LINE + 4;
      g += `<g class="${cls}">`;
      g += `<rect x="${BODY_X}" y="${y - 8}" width="${BODY_W}" height="${h}" rx="10" fill="#6aa8ff" fill-opacity="0.09"/>`;
      g += `<rect x="${BODY_X}" y="${y - 8}" width="3" height="${h}" rx="1.5" fill="url(#gel)"/>`;
      g += `<text x="${BODY_X + 22}" y="${y + 12}" class="note-label">Mindly → Codex, before it writes any code</text>`;
      text.forEach((l, k) => {
        g += `<text x="${BODY_X + 22}" y="${y + 40 + k * NOTE_LINE}" class="note">${esc(l)}</text>`;
      });
      g += '</g>';
      y += h + 14;
      continue;
    }
    const cls = rowClass(i, delay());
    const base = y + 9;
    if (kind === 'prompt') {
      const sign = scene.step === 'Terminal' ? '$' : '›';
      g += `<text x="${BODY_X}" y="${base}" class="${cls} mono"><tspan class="dim">${sign}</tspan> <tspan class="ink">${esc(text)}</tspan></text>`;
    } else if (kind === 'tool') {
      g += `<g class="${cls}"><circle cx="${BODY_X + 4}" cy="${base - 4.5}" r="3.5" fill="${scene.agent.colour}"/>`;
      g += `<text x="${BODY_X + 16}" y="${base}" class="mono"><tspan class="ink" font-weight="600">Edit</tspan><tspan class="ink2"> ${esc(text.replace(/^Edit /, ''))}</tspan></text></g>`;
    } else if (kind === 'del' || kind === 'add') {
      const fill = kind === 'del' ? '#f27bb0' : '#3fd9a8';
      const mark = kind === 'del' ? '−' : '+';
      g += `<g class="${cls}"><rect x="${BODY_X}" y="${y - 6}" width="${BODY_W}" height="${LINE}" rx="4" fill="${fill}" fill-opacity="${kind === 'del' ? 0.13 : 0.16}"/>`;
      g += `<text x="${BODY_X + 10}" y="${base}" class="mono"><tspan class="${kind}">${mark}</tspan><tspan class="ink2">  ${esc(text)}</tspan></text></g>`;
    } else {
      g += `<text x="${BODY_X}" y="${base}" class="${cls} mono ${kind}">${esc(text) || ' '}</text>`;
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
  'Mindly demo. Claude Code adds a password parameter to login() in src/auth.ts. Before Codex writes ' +
  'any code in src/dashboard.ts, which calls login(), Mindly tells it about the change. mindly status ' +
  'shows both agents and the conflict, and Mission Control shows the same live view in the browser.';

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
<linearGradient id="gel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3686e7"/><stop offset="1" stop-color="#9fd8f6"/></linearGradient>
<filter id="blur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="28"/></filter>
<filter id="shadow" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="10" stdDeviation="16" flood-color="#14284a" flood-opacity=".10"/></filter>
<clipPath id="frame"><rect width="${W}" height="${H}" rx="18"/></clipPath>
<clipPath id="cardBody"><path d="M${CARD.x + 1} ${bodyTop}H${CARD.x + CARD.w - 1}V${CARD.y + CARD_H - 14}a13 13 0 0 1-13 13H${CARD.x + 14}a13 13 0 0 1-13-13Z"/></clipPath>
</defs>
<style>
${FONT_FACES}
text{${SANS};white-space:pre}
.mono{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;font-size:${MONO}px}
.step{font-size:12.5px;fill:#6b6a64;letter-spacing:.01em}
.title{font-family:Newsreader,Georgia,"Times New Roman",serif;font-size:30px;fill:#141413;letter-spacing:-.02em}
.em{font-style:italic}
.bar{font-size:13.5px;font-weight:500;fill:#141413}
.bar-meta{font-size:13px;fill:#6b6a64;text-anchor:end}
.dim{fill:#6b6a64}.ink{fill:#141413}.ink2{fill:#3d3d3a}
.del{fill:#c8643f;font-weight:700}.add{fill:#13865f;font-weight:700}
.out{fill:#3d3d3a}.warn{fill:#c8643f}.next{fill:#2563c9}
.note-label{font-size:12.5px;font-weight:500;fill:#2563c9}
.note{font-size:${NOTE}px;fill:#141413}
${css}
@media (prefers-reduced-motion:reduce){
g,text{animation:none!important;transform:none!important}
.s${scenes.length - 1},.s${scenes.length - 1} *{opacity:1!important}
.s${scenes
  .map((_, i) => i)
  .slice(0, -1)
  .join(',.s')}{opacity:0!important}
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
<rect x="${CARD.x}" y="${CARD.y}" width="${CARD.w}" height="${CARD_H}" rx="14" fill="#ffffff" fill-opacity=".74" stroke="#e2dfd4" filter="url(#shadow)"/>
<path d="M${CARD.x + 1} ${CARD.y + BAR}H${CARD.x + CARD.w - 1}" stroke="#e2dfd4"/>
${scenesSvg}</g>
</svg>
`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, svg);
console.log(
  `demo: wrote ${out} (${(svg.length / 1024).toFixed(0)} KiB, ${scenes.length} scenes, ${LOOP}s loop; ` +
    `image ${(encoded.length / 1024).toFixed(0)} KiB base64; update wraps to ${wrapped.length} lines, ` +
    `widest ${widest.toFixed(0)}/${BODY_W - 44}px; status ${longestStatus} chars)`,
);

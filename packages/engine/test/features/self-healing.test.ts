import { copyFileSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeLine, redactText, sanitizeForContext, sha256 } from '@mindly/core';
import { describe, expect, it, vi } from 'vitest';
import {
  EARLIER_FORM_WORK,
  EVIDENCE_SCAN_WORK,
  excerptPresent,
  excerptState,
  excerptWork,
  normalizeBlock,
  selfHealingOf,
} from '../../src/index.js';
import { evidenceHash } from '../../src/memory/evidence-hash.js';
import { event, writeTool } from '../helpers.js';
import { agentSource, AUTH_V1, featureSetup } from './fixtures.js';

describe('self-healing memory', () => {
  it('marks a memory stale when its evidence disappears and tells every live session', async () => {
    const { root, mindly, pid, cc, cx, write } = await featureSetup();
    const m = mindly.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'fact',
      title: 'Login returns the admin role',
      body: 'login() always returns role admin',
      source: agentSource(cx),
      evidence: [{ path: 'src/auth.ts', excerpt: 'return { role: "admin" };' }],
    });
    expect(m.trust).toBe('verified');

    write('src/auth.ts', AUTH_V1.replace('return { role: "admin" };', 'return { role: "user" };'));
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', {
        tool: writeTool('src/auth.ts', 'return { role: "user" };'),
      }),
    );

    expect(mindly.store.memories.get(m.id).trust).toBe('stale');
    expect(mindly.store.memories.evidenceFor(m.id)[0]!.valid).toBe(false);
    const stale = mindly.store.deliveries.list(pid).filter((d) => d.kind === 'stale_memory');
    expect(stale.map((d) => d.targetSessionId).sort()).toEqual([cc.id, cx.id].sort());

    const res = await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'prompt', { prompt: 'what next' }),
    );
    expect(res.context).toContain(
      'Memory "Login returns the admin role" may be outdated because src/auth.ts changed',
    );

    // The excerpt comes back: evidence is valid again, trust stays stale for the user to restore.
    write('src/auth.ts', AUTH_V1);
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', {
        tool: writeTool('src/auth.ts', 'return { role: "admin" };'),
      }),
    );
    expect(mindly.store.memories.evidenceFor(m.id)[0]!.valid).toBe(true);
    expect(mindly.store.memories.get(m.id).trust).toBe('stale');
    expect(mindly.store.events.query(pid, { types: ['memory.stale'] })).toHaveLength(1);
  });

  it('sweeps all evidence of a project, including deleted files', async () => {
    const { root, mindly, pid, write } = await featureSetup();
    const a = mindly.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'decision',
      title: 'Dashboard imports login',
      body: 'x',
      source: { type: 'user', sessionId: null, agentKind: null },
      evidence: [{ path: 'src/dashboard.ts', excerpt: "import { login } from './auth';" }],
    });
    const b = mindly.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'fact',
      title: 'Auth module exists',
      body: 'y',
      source: { type: 'user', sessionId: null, agentKind: null },
      evidence: [{ path: 'src/auth.ts' }],
    });
    write('src/dashboard.ts', 'export const view = 1;\n');
    const result = selfHealingOf(mindly).sweep(pid);
    expect(result).toEqual({ checked: 2, invalid: 1, markedStale: 1, restored: 0 });
    expect(mindly.store.memories.get(a.id).trust).toBe('stale');
    expect(mindly.store.memories.get(b.id).trust).toBe('approved');
    // No live session other than the two fixtures: both are told.
    expect(mindly.store.deliveries.list(pid).filter((d) => d.kind === 'stale_memory')).toHaveLength(
      2,
    );
  });

  it('matches redacted excerpts through the stored content hash', () => {
    const original = 'const key = "abc";\nconnect(key);';
    const hash = sha256(original.split('\n').map(normalizeLine).join('\n'));
    const content = `// header\n  const key = "abc";\nconnect(key);\n`;
    expect(excerptPresent(content, 'const key = "[REDACTED]";\nconnect(key);', hash)).toBe(true);
    expect(excerptPresent('other', 'const key = "[REDACTED]";\nconnect(key);', hash)).toBe(false);
    expect(excerptPresent('a\n   b   c\n', 'b c', null)).toBe(true);
  });

  it('keeps a redacted excerpt that is part of a longer line valid while the file is unchanged', async () => {
    const { root, mindly, pid, cc, write } = await featureSetup();
    const secret = ['sk', 'live', 'a1B2c3D4e5F6g7H8i9J0k1L2'].join('_');
    const file = `export const client = connect({ region: "eu", token: "${secret}", retries: 3 });\n`;
    write('src/client.ts', file);
    const m = mindly.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'fact',
      title: 'The client retries three times',
      body: 'connect() is called with retries: 3',
      source: agentSource(cc),
      evidence: [{ path: 'src/client.ts', excerpt: `token: "${secret}", retries: 3` }],
    });
    const stored = mindly.store.memories.evidenceFor(m.id)[0]!;
    expect(stored.excerpt).toContain('[REDACTED]');
    expect(stored.excerpt).not.toContain(secret);

    expect(selfHealingOf(mindly).sweep(pid)).toMatchObject({ invalid: 0, markedStale: 0 });
    expect(mindly.store.memories.get(m.id).trust).not.toBe('stale');
    expect(mindly.store.deliveries.list(pid).filter((d) => d.kind === 'stale_memory')).toEqual([]);

    // The text around the secret is gone: the evidence no longer holds.
    write('src/client.ts', file.replace('retries: 3', 'retries: 5'));
    expect(selfHealingOf(mindly).sweep(pid)).toMatchObject({ invalid: 1, markedStale: 1 });
  });

  it('places evidence stored with the hash of its excerpt between what the redaction left', () => {
    const line = 'const c = connect({ token: "abcdef123456", retries: 3 });';
    const stored = 'token: "[REDACTED]", retries: 3';
    const hash = sha256(normalizeLine('token: "abcdef123456", retries: 3'));
    expect(excerptPresent(`// x\n${line}\n`, stored, hash)).toBe(true);
    // Another value in the same place is not the text the evidence was taken from.
    expect(excerptPresent(line.replace('abcdef123456', 'zzzzzz999999'), stored, hash)).toBe(false);
    expect(excerptPresent(line.replace('retries: 3', 'retries: 4'), stored, hash)).toBe(false);

    // The real line behind hundreds of lookalikes is still found.
    const lookalikes = Array.from(
      { length: 300 },
      (_, i) => `a${i}({ token: "v${i}", retries: 9 });`,
    );
    expect(excerptState([...lookalikes, line].join('\n'), stored, hash)).toBe('present');
    expect(excerptState(lookalikes.join('\n'), stored, hash)).toBe('absent');

    // An excerpt that opens or closes with the redaction cannot be placed; what it kept is still
    // there, so it is not decided (it keeps its validity).
    const open = sha256(normalizeLine('abcdef123456", retries: 3'));
    expect(excerptState(line, '[REDACTED]", retries: 3', open)).toBe('unknown');
    expect(excerptState(line, 'token: "[REDACTED]', sha256('token: "abcdef123456'))).toBe(
      'unknown',
    );
  });

  it('keeps earlier evidence as it was when it cannot be placed in a few tries', async () => {
    // One line of 600 lookalike pairs: more candidates than the fallback hashes.
    const dense = 'k="v";'.repeat(600);
    expect(excerptState(dense, 'k="[REDACTED]";', sha256('k="abcdef123456";'))).toBe('unknown');

    const { root, mindly, pid, cc, write } = await featureSetup();
    write('src/dense.ts', 'const x = { k="abcdef123456"; };\n');
    const m = mindly.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'fact',
      title: 'The dense file sets k',
      body: 'k is set inline',
      source: agentSource(cc),
      evidence: [{ path: 'src/dense.ts', excerpt: 'k="abcdef123456";' }],
    });
    // As an earlier version stored it: redacted text, hash of the excerpt.
    mindly.store.db
      .prepare('UPDATE memory_evidence SET excerpt = ?, content_hash = ? WHERE memory_id = ?')
      .run('k="[REDACTED]";', sha256('k="abcdef123456";'), m.id);
    expect(selfHealingOf(mindly).sweep(pid)).toMatchObject({ checked: 1, invalid: 0 });

    // Found where it was taken from: moved to the exact form, which sees any later change.
    expect(mindly.store.memories.evidenceFor(m.id)[0]!.contentHash).toMatch(/^span:/);
    write('src/dense.ts', `${dense}\n`);
    expect(selfHealingOf(mindly).sweep(pid)).toMatchObject({ checked: 1, invalid: 1 });

    // Not moved yet, the same row is not decided in the dense file and keeps its validity.
    mindly.store.db
      .prepare('UPDATE memory_evidence SET content_hash = ?, valid = 1 WHERE memory_id = ?')
      .run(sha256('k="abcdef123456";'), m.id);
    write('src/dense.ts', `${dense}\n// touched\n`);
    expect(selfHealingOf(mindly).sweep(pid)).toMatchObject({ checked: 0, invalid: 0 });
    expect(mindly.store.memories.evidenceFor(m.id)[0]!.valid).toBe(true);
  });

  it('marks a memory stale when a redacted value at the end of its evidence is replaced', async () => {
    const { root, mindly, pid, cc, write } = await featureSetup();
    const secret = ['sk', 'live', 'a1B2c3D4e5F6g7H8i9J0k1L2'].join('_');
    write('src/client.yaml', `client:\n  token: ${secret}\n  retries: 3\n`);
    const m = mindly.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'fact',
      title: 'The client token is set inline',
      body: 'src/client.yaml holds the token itself',
      source: agentSource(cc),
      evidence: [{ path: 'src/client.yaml', excerpt: `token: ${secret}` }],
    });
    const stored = mindly.store.memories.evidenceFor(m.id)[0]!;
    expect(stored.excerpt).toBe('token: [REDACTED]');
    expect(stored.contentHash).toMatch(/^span:\d+:[0-9a-f]{8}:[0-9a-f]{64}$/);
    expect(selfHealingOf(mindly).sweep(pid)).toMatchObject({ invalid: 0, markedStale: 0 });

    write('src/client.yaml', 'client:\n  token: ${VAULT_TOKEN}\n  retries: 3\n');
    expect(selfHealingOf(mindly).sweep(pid)).toMatchObject({ invalid: 1, markedStale: 1 });
    expect(mindly.store.memories.get(m.id).trust).toBe('stale');
  });

  it('looks for the text a redacted excerpt was taken from, wherever it is', () => {
    /** The hash stored for `found`, kept as `stored`. */
    const hashFor = (found: string, stored: string) =>
      evidenceHash(normalizeBlock(found), normalizeBlock(stored));
    const line = 'connect({ token: "abcdef123456", retries: 3 });';
    const file = `// client\n${line}\nexport {};\n`;

    // A redaction at the end of the excerpt, in the middle of a line.
    const closing = hashFor('token: "abcdef123456', 'token: "[REDACTED]');
    expect(closing).toMatch(/^span:/);
    expect(excerptPresent(file, 'token: "[REDACTED]', closing)).toBe(true);
    expect(
      excerptPresent(file.replace('abcdef123456', 'zzzzzz999999'), 'token: "[REDACTED]', closing),
    ).toBe(false);
    // What is on the line besides the cited text is not part of the evidence.
    expect(
      excerptPresent(file.replace('retries: 3', 'retries: 4'), 'token: "[REDACTED]', closing),
    ).toBe(true);
    expect(excerptPresent(`// other\n${line}\n`, 'token: "[REDACTED]', closing)).toBe(true);

    // Nothing but a redaction.
    const only = hashFor('abcdef123456', '[REDACTED]');
    expect(excerptPresent(file, '[REDACTED]', only)).toBe(true);
    expect(excerptPresent('', '[REDACTED]', only)).toBe(false);
    expect(excerptPresent('export const unrelated = 1;\n', '[REDACTED]', only)).toBe(false);

    // A secret line followed by a plain one, with the secret line removed.
    const two = hashFor('abcdef123456\nmaxRetries = 3', '[REDACTED]\nmaxRetries = 3');
    expect(
      excerptPresent('x = 1\nabcdef123456\nmaxRetries = 3\n', '[REDACTED]\nmaxRetries = 3', two),
    ).toBe(true);
    expect(excerptPresent('x = 1\nmaxRetries = 3\n', '[REDACTED]\nmaxRetries = 3', two)).toBe(
      false,
    );
    expect(excerptPresent('maxRetries = 3\n', '[REDACTED]\nmaxRetries = 3', two)).toBe(false);

    // The parts still exist, thousands of lines apart: that is not the excerpt.
    const three = hashFor('abcdef123456\nalpha = 1\nomega = 2', '[REDACTED]\nalpha = 1\nomega = 2');
    const filler = Array.from({ length: 5000 }, (_, i) => `line${i} = ${i}`).join('\n');
    expect(
      excerptPresent(
        `abcdef123456\nalpha = 1\n${filler}\nomega = 2\n`,
        '[REDACTED]\nalpha = 1\nomega = 2',
        three,
      ),
    ).toBe(false);

    // An excerpt kept as it was found keeps the plain hash: the substring test decides.
    expect(hashFor('retries: 3', 'retries: 3')).toBe(sha256('retries: 3'));
  });

  it('treats a redacted excerpt like any other: present while the cited text is', async () => {
    const { root, mindly, pid, cc, write } = await featureSetup();
    const secret = ['sk', 'live', 'a1B2c3D4e5F6g7H8i9J0k1L2'].join('_');
    const copy = (comment: string) => `const key = "${secret}"; // ${comment}`;
    write('src/keys.ts', `${copy('first')}\n${copy('second')}\n`);
    const remember = (title: string, excerpt: string) =>
      mindly.memory.remember({
        projectId: pid,
        projectRoot: root,
        kind: 'fact',
        title,
        body: 'b',
        source: agentSource(cc),
        evidence: [{ path: 'src/keys.ts', excerpt }],
      });
    const redacted = remember('The key is inline', `const key = "${secret}";`);
    write('src/plain.ts', 'export const retries = 3; // tuned\n');
    const plain = mindly.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'fact',
      title: 'Retries are three',
      body: 'b',
      source: agentSource(cc),
      evidence: [{ path: 'src/plain.ts', excerpt: 'export const retries = 3;' }],
    });
    expect(mindly.store.memories.evidenceFor(redacted.id)[0]!.excerpt).toContain('[REDACTED]');

    // A comment edit on the first copy's line: the cited text is still there, twice over once.
    write('src/keys.ts', `${copy('first, edited')}\n${copy('second')}\n`);
    write('src/plain.ts', 'export const retries = 3; // tuned again\n');
    expect(selfHealingOf(mindly).sweep(pid)).toMatchObject({ invalid: 0, markedStale: 0 });

    // Both copies gone: the evidence ends.
    write('src/keys.ts', 'const key = process.env.KEY;\n');
    expect(selfHealingOf(mindly).sweep(pid)).toMatchObject({ invalid: 1, markedStale: 1 });
    expect(mindly.store.memories.get(redacted.id).trust).toBe('stale');
    expect(mindly.store.memories.get(plain.id).trust).not.toBe('stale');
  });

  it('looks at evidence found gone again whenever the file is not the one it was gone from', async () => {
    const { root, clock, mindly, pid, cc, write } = await featureSetup();
    const secret = ['sk', 'live', 'a1B2c3D4e5F6g7H8i9J0k1L2'].join('_');
    const good = `export const client = connect({ token: "${secret}", retries: 3 });\n`;
    const bad = 'export const client = connect({ token: process.env.TOKEN, retries: 3 });\n';
    const path = join(root, 'src/client.ts');
    const backup = join(root, 'client.ts.bak');
    write('src/client.ts', good);
    writeFileSync(backup, good);
    const old = (Date.now() - 3_600_000) / 1000;
    utimesSync(backup, old, old);
    const m = mindly.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'fact',
      title: 'The client token is set inline',
      body: 'b',
      source: agentSource(cc),
      evidence: [{ path: 'src/client.ts', excerpt: `token: "${secret}"` }],
    });
    const evidence = () => mindly.store.memories.evidenceFor(m.id)[0]!;
    const sweep = () => selfHealingOf(mindly).sweep(pid);
    const goneAgain = () => {
      write('src/client.ts', bad);
      expect(sweep()).toMatchObject({ invalid: 1 });
      expect(evidence().valid).toBe(false);
    };
    // The store's clock runs ahead of every file time below, as a lagging file system's would.
    clock.t = Date.now() + 3_600_000;

    // Unchanged since it was found gone: not looked at again.
    goneAgain();
    const mark = vi.spyOn(mindly.store.memories, 'markEvidence');
    expect(sweep()).toMatchObject({ invalid: 1, restored: 0 });
    expect(mark).not.toHaveBeenCalled();
    mark.mockRestore();

    // `mv backup src/client.ts`: another inode, an hour-old time.
    renameSync(backup, path);
    expect(sweep()).toMatchObject({ invalid: 0, restored: 1 });

    // `cp -p backup src/client.ts`: the same inode, the backup's old times.
    goneAgain();
    writeFileSync(backup, good);
    copyFileSync(backup, path);
    utimesSync(path, old, old);
    expect(sweep()).toMatchObject({ invalid: 0, restored: 1 });

    // Written back in place with a time older than the last check.
    goneAgain();
    writeFileSync(path, good);
    utimesSync(path, old, old);
    expect(sweep()).toMatchObject({ invalid: 0, restored: 1 });
  });

  it('never cites half of a character', () => {
    const smile = '\u{1F642}';
    const grin = '\u{1F600}';
    // An excerpt cut inside the emoji: the span stops before it.
    const cut = `const tag = "x${smile}";`.slice(0, 15);
    expect(cut.charCodeAt(14)).toBe(0xd83d);
    expect(evidenceHash(cut, 'stored differently')).toBe(
      evidenceHash(cut.slice(0, 14), 'stored differently'),
    );
    expect(evidenceHash(smile.slice(1) + 'abc', 'x')).toBe(evidenceHash('abc', 'x'));

    // A window that starts inside a pair is not a match, even where the encoded text agrees
    // (half a character is encoded as U+FFFD).
    const span = evidenceHash('�abc', '[REDACTED]abc');
    expect(excerptPresent(`x${grin}abc`, '[REDACTED]abc', span)).toBe(false);
    expect(excerptPresent('x�abc', '[REDACTED]abc', span)).toBe(true);
  });

  it('decides about earlier redacted evidence in a large file without delaying the hook', async () => {
    const timed = <T>(f: () => T): [T, number] => {
      const t = performance.now();
      const r = f();
      return [r, performance.now() - t];
    };
    const lines: string[] = [];
    for (let i = 0, size = 0; size < 500 * 1024; i++) {
      const l = `  "key${i}": "value${i}",`;
      lines.push(l);
      size += l.length + 1;
    }
    const content = lines.join('\n');
    const original = 'apiToken: "sk-live-0123456789abcdef"';
    // Its start is gone, its end (`"`) is on every line.
    const [gone, goneMs] = timed(() =>
      excerptState(content, 'apiToken: "[REDACTED]"', sha256(original)),
    );
    expect(gone).toBe('absent');
    // Both ends on every line and no pair is the original: decided within the budget.
    const [lookalike, lookalikeMs] = timed(() =>
      excerptState(content, '"key[REDACTED]",', sha256('"key0": "nothing here",')),
    );
    expect(['absent', 'unknown']).toContain(lookalike);
    // The original among them is still found.
    const placed = `${lines.slice(0, 15_000).join('\n')}\n  ${original},\n${lines.slice(15_000).join('\n')}`;
    expect(excerptState(placed, 'apiToken: "[REDACTED]"', sha256(original))).toBe('present');

    // Through the post-edit path: a stored row of that kind, the key renamed.
    const { root, mindly, pid, cx, write } = await featureSetup();
    write('src/settings.json', `{\n  ${original},\n${content}\n}\n`);
    const m = mindly.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'decision',
      title: 'settings token',
      body: 'b',
      source: agentSource(cx),
      evidence: [{ path: 'src/settings.json', excerpt: original }],
    });
    mindly.store.db
      .prepare('UPDATE memory_evidence SET content_hash = ? WHERE memory_id = ?')
      .run(sha256(original), m.id);
    write(
      'src/settings.json',
      `{\n  ${original.replace('apiToken', 'serviceToken')},\n${content}\n}\n`,
    );
    const [checks, recheckMs] = timed(() =>
      selfHealingOf(mindly).recheckFile(pid, root, 'src/settings.json', null),
    );
    expect(checks.map((c) => c.state)).toEqual(['invalid']);
    // Tens of milliseconds on an idle machine (it took seconds); room left for a busy one.
    expect(Math.max(goneMs, lookalikeMs, recheckMs)).toBeLessThan(500);
  });

  it('finds earlier evidence that was made safe as well as redacted while its line is there', async () => {
    const zwj = '‍';
    const secret = ['sk', 'live', 'a1B2c3D4e5F6g7H8i9J0k1L2'].join('_');
    // A whole line with an emoji sequence (joined by an invisible character) and a secret.
    const original = `const TEAM = { badge: "👩${zwj}💻 maintainers of the api client", token: "${secret}" };`;
    // As an earlier version stored it: redacted and made safe, with the bare hash of the original.
    const stored = sanitizeForContext(redactText(original), 2000);
    const legacyHash = sha256(normalizeBlock(original));
    expect(stored).toContain('[REDACTED]');
    expect(stored).not.toContain(zwj);
    const content = `// header\n${original}\nexport {};\n`;
    expect(excerptState(content, stored, legacyHash)).toBe('present');
    expect(excerptState(content.replace('maintainers', 'owners'), stored, legacyHash)).toBe(
      'absent',
    );

    const { root, mindly, pid, cc, write } = await featureSetup();
    write('src/team.ts', content);
    const m = mindly.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'fact',
      title: 'The team badge is in team.ts',
      body: 'b',
      source: agentSource(cc),
      evidence: [{ path: 'src/team.ts', excerpt: original }],
    });
    mindly.store.db
      .prepare('UPDATE memory_evidence SET excerpt = ?, content_hash = ? WHERE memory_id = ?')
      .run(stored, legacyHash, m.id);
    expect(selfHealingOf(mindly).sweep(pid)).toMatchObject({ checked: 1, invalid: 0 });
    expect(mindly.store.memories.evidenceFor(m.id)[0]!.valid).toBe(true);
    expect(mindly.store.memories.get(m.id).trust).not.toBe('stale');
  });

  it('places earlier evidence that is part of a line however it was made safe', () => {
    const secret = ['sk', 'live', 'a1B2c3D4e5F6g7H8i9J0k1L2'].join('_');
    /** As an earlier version stored `original`: redacted, made safe, the bare hash. */
    const legacy = (original: string) => ({
      stored: sanitizeForContext(redactText(original), 2000),
      hash: sha256(normalizeBlock(original)),
    });
    const shapes: [string, string, string][] = [
      // name, the excerpt as found, the rest of its line around it
      ['a joiner in the kept text', `badge: "👩‍💻 maintainers", token: "${secret}"`, 'TEAM'],
      ['a neutralised delimiter', `note: "<mindly-context> here", token: "${secret}"`, 'X'],
      ['plain', `badge: "maintainers", token: "${secret}"`, 'TEAM'],
    ];
    for (const [name, original, id] of shapes) {
      const { stored, hash } = legacy(original);
      expect(stored, name).toContain('[REDACTED]');
      const content = `// header\nconst ${id} = { ${original}, region: "eu" };\nexport {};\n`;
      expect(excerptState(content, stored, hash), name).toBe('present');
      // The value changed, what was kept is still there: not decided.
      expect(excerptState(content.replace(secret, 'sk_live_other'), stored, hash), name).toBe(
        'unknown',
      );
      // What was kept is gone.
      expect(excerptState('export {};\n', stored, hash), name).toBe('absent');
    }

    // Redaction made it longer than an excerpt may be, so it was stored cut short.
    const long = `password=Xy7kQ2pZ ${'lorem ipsum '.repeat(166)}end`.slice(0, 1999);
    const cut = legacy(long);
    expect(redactText(long).length).toBeGreaterThan(2000);
    expect(cut.stored.endsWith('…')).toBe(true);
    const line = `// header\nconst LONG = "${long} and more";\nexport {};\n`;
    expect(excerptState(line, cut.stored, cut.hash)).toBe('present');
    // A changed value, or a change past where it was cut (only the hash knows that text): what
    // was kept is still there, so it is not decided.
    expect(excerptState(line.replace('Xy7kQ2pZ', 'Qq1wW2eE'), cut.stored, cut.hash)).toBe(
      'unknown',
    );
    const changedEnd = line.replace(long, `${long.slice(0, -1)}#`);
    expect(changedEnd).not.toBe(line);
    expect(excerptState(changedEnd, cut.stored, cut.hash)).toBe('unknown');
    expect(excerptState('export {};\n', cut.stored, cut.hash)).toBe('absent');
  });

  it('re-checks earlier multi-line evidence of a large file within the hook budget', async () => {
    const timed = <T>(f: () => T): [T, number] => {
      const t = performance.now();
      const r = f();
      return [r, performance.now() - t];
    };
    const secret = ['sk', 'live', 'a1B2c3D4e5F6g7H8i9J0k1L2'].join('_');
    const lines: string[] = [];
    for (let i = 0, size = 0; size < 500 * 1024; i++) {
      const l = `  "key${i}": "value${i}",`;
      lines.push(l);
      size += l.length + 1;
    }
    const block = (n: number, at: number) => {
      const b = Array.from({ length: n }, (_, i) => `g${i}: 1,`);
      b[at] = `token: "${secret}",`;
      return b.join('\n');
    };
    const { root, mindly, pid, cc, write } = await featureSetup();
    // Three blocks of 140 to 180 lines that were in the file and are gone now.
    const blocks = [block(140, 70), block(160, 80), block(180, 90)];
    write('src/big.json', `${blocks.join('\n')}\n${lines.join('\n')}\n`);
    const ids = blocks.map(
      (b, j) =>
        mindly.memory.remember({
          projectId: pid,
          projectRoot: root,
          kind: 'fact',
          title: `block ${j}`,
          body: 'b',
          source: agentSource(cc),
          evidence: [{ path: 'src/big.json', excerpt: b }],
        }).id,
    );
    // As an earlier version stored them.
    for (const [j, b] of blocks.entries()) {
      mindly.store.db
        .prepare('UPDATE memory_evidence SET excerpt = ?, content_hash = ? WHERE memory_id = ?')
        .run(sanitizeForContext(redactText(b), 2000), sha256(normalizeBlock(b)), ids[j] as string);
    }
    const [same, sameMs] = timed(() =>
      selfHealingOf(mindly).recheckFile(pid, root, 'src/big.json', null),
    );
    expect(same.map((c) => c.state)).toEqual(['valid', 'valid', 'valid']);
    write('src/big.json', `${lines.join('\n')}\n`);
    const [gone, goneMs] = timed(() =>
      selfHealingOf(mindly).recheckFile(pid, root, 'src/big.json', null),
    );
    expect(gone.map((c) => c.state)).toEqual(['invalid', 'invalid', 'invalid']);
    // Tens of milliseconds on an idle machine (the whole-line hashing alone took ~600 ms).
    expect(Math.max(sameMs, goneMs)).toBeLessThan(500);
  });

  it('decides earlier whole-line evidence in a large file from where its kept text is', () => {
    const timed = <T>(f: () => T): [T, number] => {
      const t = performance.now();
      const r = f();
      return [r, performance.now() - t];
    };
    const lines: string[] = [];
    for (let i = 0, size = 0; size < 500 * 1024; i++) {
      lines.push(`g${i}: ${i},`);
      size += 12;
    }
    // Opens with a redaction: no fixed start, so it is placed by the lines its kept text is on.
    const original = `abcdef123456\n${lines.slice(0, 199).join('\n')}`;
    const stored = `[REDACTED]\n${lines.slice(0, 199).join('\n')}`;
    const hash = sha256(normalizeBlock(original));
    // The redacted line changed, the kept lines are still there: not decided.
    const [gone, goneMs] = timed(() => excerptState(`other\n${lines.join('\n')}`, stored, hash));
    expect(gone).toBe('unknown');
    // The kept lines are gone.
    expect(excerptState(lines.slice(300).join('\n'), stored, hash)).toBe('absent');
    const [there, thereMs] = timed(() =>
      excerptState(`abcdef123456\n${lines.join('\n')}`, stored, hash),
    );
    expect(there).toBe('present');
    expect(Math.max(goneMs, thereMs)).toBeLessThan(500);

    // `lines:` evidence of an earlier build of this release: a cited block of 40 lines.
    const block = Array.from({ length: 40 }, (_, i) => `  "g${i}": ${i},`).join('\n');
    const cited = `lines:40:${sha256(normalizeBlock(block))}`;
    const big = lines.join('\n');
    expect(excerptState(`${block}\n${big}`, block, cited)).toBe('present');
    const [deleted, deletedMs] = timed(() => excerptState(big, block, cited));
    expect(deleted).toBe('absent');
    expect(deletedMs).toBeLessThan(500);
  });

  it('places whole-line evidence whose lines changed in number when it was made safe', () => {
    const secret = ['sk', 'live', 'a1B2c3D4e5F6g7H8i9J0k1L2'].join('_');
    const tail = `const TOKEN = "${secret}"; // the production key for billing`;
    for (const [name, block, n] of [
      // A line of only an invisible character: gone from the excerpt, a line of the file.
      ['an invisible-only line', `const A = 1;\n\u200B\n${tail}`, 3],
      // A lone carriage return: a line break in the excerpt, a space in the file.
      ['a lone carriage return', `a;\rb;\n${tail}`, 2],
    ] as const) {
      const text: string = block;
      const stored = sanitizeForContext(redactText(text), 2000);
      const cited = `lines:${n}:${sha256(normalizeBlock(text))}`;
      const content = `// header\n${text}\nexport {};\n`;
      expect(excerptState(content, stored, cited), name).toBe('present');
      expect(excerptState(content.replace('billing', 'payroll'), stored, cited), name).toBe(
        'absent',
      );
      expect(excerptState(content.replace(secret, 'sk_live_other'), stored, cited), name).toBe(
        'unknown',
      );
    }
  });

  it('keeps whole-line evidence it cannot place within the work for one file', () => {
    const timed = <T>(f: () => T): [T, number] => {
      const t = performance.now();
      const r = f();
      return [r, performance.now() - t];
    };
    const lines: string[] = [];
    for (let i = 0, size = 0; size < 500 * 1024; i++) {
      lines.push(`k${i}`);
      size += 6;
    }
    // A cited block of 400 lines whose stored excerpt was cut short: no fixed end to place it by.
    // The file holds what was kept of it, not the whole block.
    const block = Array.from({ length: 400 }, (_, i) => `v${i}`).join('\n');
    const file = `${block.split('\n').slice(0, 399).join('\n')}\n${lines.join('\n')}`;
    const cut = timed(() =>
      excerptState(file, `${block.slice(0, 1500)}…`, `lines:400:${sha256(normalizeBlock(block))}`),
    );
    // A cited block of 200 lines of which only redactions were kept.
    const keys = Array.from({ length: 200 }, (_, i) => `abcdef1234567890${i}`).join('\n');
    const redacted = timed(() =>
      excerptState(
        file,
        keys
          .split('\n')
          .map(() => '[REDACTED]')
          .join('\n'),
        `lines:200:${sha256(normalizeBlock(keys))}`,
      ),
    );
    // Not decided either way: the evidence keeps the validity it had.
    expect(cut[0]).toBe('unknown');
    expect(redacted[0]).toBe('unknown');
    expect(Math.max(cut[1], redacted[1])).toBeLessThan(100);
  });

  it('never calls earlier evidence gone while what it kept is in the file', () => {
    const secret = ['sk', 'live', 'a1B2c3D4e5F6g7H8i9J0k1L2'].join('_');
    /** `lines:` as an earlier build of this release wrote it: the whole lines the excerpt spans. */
    const cited = (file: string, excerpt: string): string => {
      const norm = normalizeBlock(file);
      const ne = normalizeBlock(excerpt);
      const at = norm.indexOf(ne);
      expect(at).toBeGreaterThanOrEqual(0);
      const start = norm.lastIndexOf('\n', at - 1) + 1;
      const nl = norm.indexOf('\n', at + ne.length);
      const c = norm.slice(start, nl === -1 ? norm.length : nl);
      return `lines:${c.split('\n').length}:${sha256(c)}`;
    };
    for (const [name, file, excerpt] of [
      // A lone carriage return quoted as a space (both normalise to one space).
      [
        'a lone carriage return quoted as a space',
        `// header\na;\rb;\nconst TOKEN = "${secret}"; // billing\nexport {};\n`,
        `a; b;\nconst TOKEN = "${secret}"; // billing`,
      ],
      // A `<` that only the file made safe neutralises (the next line starts with `Mindly`).
      [
        'a `<` before Mindly',
        `const TOKEN = "${secret}"; // billing\ntype Store = Map<\n  MindlyKey,\n  number\n>;\n`,
        `const TOKEN = "${secret}"; // billing\ntype Store = Map<`,
      ],
    ] as const) {
      const stored = sanitizeForContext(redactText(excerpt), 2000);
      expect(excerptState(file, stored, cited(file, excerpt)), name).toBe('present');
    }

    // Whole lines of the earliest form that open with a secret and end with a line of only an
    // invisible character (the excerpt lost that line when it was made safe).
    const block = `${secret}\nconst A = 1; // the production billing key\n\u200B`;
    const stored = sanitizeForContext(redactText(block), 2000);
    expect(stored).toBe('[REDACTED]\nconst A = 1; // the production billing key');
    const hash = sha256(normalizeBlock(block));
    expect(excerptState(`// header\n${block}\nexport {};\n`, stored, hash)).toBe('present');
    expect(excerptState('// header\nexport {};\n', stored, hash)).toBe('absent');
  });

  it('decides earlier whole-line evidence of a large file with a stray invisible line quickly', () => {
    /** The best of three runs: the time of the work, not of compiling it. */
    const timed = <T>(f: () => T): [T, number] => {
      let best = Infinity;
      let r = f();
      for (let i = 0; i < 3; i++) {
        const t = performance.now();
        r = f();
        best = Math.min(best, performance.now() - t);
      }
      return [r, best];
    };
    const rows: string[] = [];
    for (let i = 0, size = 0; size < 500 * 1024; i++) {
      rows.push(i % 2 ? '},' : `{ "password": "pw${i}xxxxxx",`);
      size += 24;
    }
    const block = Array.from({ length: 30 }, (_, i) =>
      i % 2 ? '},' : `{ "password": "secret${i}zzzzzz",`,
    ).join('\n');
    const stored = sanitizeForContext(redactText(block), 2000);
    const hash = `lines:30:${sha256(normalizeBlock(block))}`;
    const mid = rows.length >> 1;
    // One line of only an invisible character, and one lone carriage return, in 500 KB.
    for (const stray of ['\u200B', 'a\rb']) {
      const file = [...rows.slice(0, mid), stray, ...rows.slice(mid)].join('\n');
      // The block is not in the file; what it kept is everywhere: not decided.
      const gone = excerptWork(file, stored, hash);
      expect(gone.state).toBe('unknown');
      // The block is there, ending in a line of only an invisible character.
      const withBlock = `${block}\n\u200B\n${file}`;
      const blockHash = `lines:31:${sha256(normalizeBlock(`${block}\n\u200B`))}`;
      const there = excerptWork(withBlock, stored, blockHash);
      expect(there.state).not.toBe('absent');
      // The hashing it does is bounded by the allowance for one file, whatever the machine.
      expect(gone.work).toBeLessThanOrEqual(EARLIER_FORM_WORK);
      expect(there.work).toBeLessThanOrEqual(EARLIER_FORM_WORK);
      // And the rest is a few passes over the file: measured against normalising that file once
      // on the same machine (tens of milliseconds here, about five times normalising).
      const [, normalising] = timed(() => normalizeBlock(withBlock));
      const [, goneMs] = timed(() => excerptState(file, stored, hash));
      const [, thereMs] = timed(() => excerptState(withBlock, stored, blockHash));
      expect(Math.max(goneMs, thereMs)).toBeLessThan(20 * normalising + 50);
    }
  });

  it('pays for every hash of an earlier excerpt stored cut short, within one allowance', () => {
    /** The best of three runs: the time of the work, not of compiling it. */
    const timed = <T>(f: () => T): [T, number] => {
      let best = Infinity;
      let r = f();
      for (let i = 0; i < 3; i++) {
        const t = performance.now();
        r = f();
        best = Math.min(best, performance.now() - t);
      }
      return [r, best];
    };
    // A 500 KB config of lookalike lines; the excerpt's start is on every one of them.
    const rows: string[] = [];
    for (let i = 0, size = 0; size < 500 * 1024; i++) {
      rows.push(`"password": "pw${String(i).padStart(6, '0')}",`);
      size += 24;
    }
    const file = rows.join('\n');
    // 2000 characters that redaction made longer: stored cut short, with the bare hash.
    let excerpt = '';
    for (let i = 1000; excerpt.length < 2000; i++) excerpt += (excerpt ? '\n' : '') + rows[i];
    excerpt = excerpt.slice(0, 2000);
    const stored = sanitizeForContext(redactText(excerpt), 2000);
    expect(stored.endsWith('…')).toBe(true);
    const hash = sha256(normalizeBlock(excerpt));
    for (const content of [file, file.replace('pw001005', 'pw999999')]) {
      const found = excerptWork(content, stored, hash);
      // Too many lookalikes to place it within the allowance: not decided, never gone.
      expect(found.state).not.toBe('absent');
      expect(found.work).toBeLessThanOrEqual(EARLIER_FORM_WORK);
      // A few passes over the file (about twice normalising it here), measured on this machine.
      const [, normalising] = timed(() => normalizeBlock(content));
      const [, ms] = timed(() => excerptState(content, stored, hash));
      expect(ms).toBeLessThan(20 * normalising + 50);
    }
  });

  it('looks for evidence in time linear in the file, whatever the file and the excerpt hold', async () => {
    /** The best of three runs: the time of the work, not of compiling it. */
    const timed = <T>(f: () => T): [T, number] => {
      let best = Infinity;
      let r = f();
      for (let i = 0; i < 3; i++) {
        const t = performance.now();
        r = f();
        best = Math.min(best, performance.now() - t);
      }
      return [r, best];
    };
    /** Within the allowances, and a few passes over the file measured on this machine. */
    const quick = (content: string, excerpt: string, hash: string | null) => {
      const [found, ms] = timed(() => excerptWork(content, excerpt, hash));
      expect(found.scanned).toBeLessThanOrEqual(EVIDENCE_SCAN_WORK);
      expect(found.work).toBeLessThanOrEqual(EARLIER_FORM_WORK);
      const [, normalising] = timed(() => normalizeBlock(content));
      expect(ms).toBeLessThan(20 * normalising + 50);
      return found.state;
    };
    // A long run of one character, where a built-in search takes time quadratic in it.
    const run = 'a'.repeat(500_000);
    expect(quick(run, `${'a'.repeat(200)}b${'a'.repeat(1799)}`, null)).toBe('absent');
    expect(quick(run, `${'a'.repeat(200)}[REDACTED]${'a'.repeat(1780)}`, sha256('gone'))).not.toBe(
      'absent',
    );
    // A line made safe away entirely, next to a line holding the kept text 120 000 times.
    const lines = `${'\u0001'.repeat(250_000)}\nx${' x'.repeat(120_000)}`;
    expect(quick(lines, 'x [REDACTED]', `lines:3:${sha256('gone')}`)).toBe('unknown');

    // Twenty rows of one file in one re-check, through the hook path.
    const { root, mindly, pid, cx, write } = await featureSetup();
    const excerpts = Array.from(
      { length: 20 },
      (_, i) => `${'a'.repeat(200 + i)}b${'a'.repeat(1799 - i)}`,
    );
    write('src/data.txt', excerpts.join('\n'));
    for (const [i, excerpt] of excerpts.entries()) {
      mindly.memory.remember({
        projectId: pid,
        projectRoot: root,
        kind: 'fact',
        title: `fact ${i}`,
        body: `fact ${i}`,
        source: agentSource(cx),
        evidence: [{ path: 'src/data.txt', excerpt }],
      });
    }
    write('src/data.txt', run);
    const [, oneRow] = timed(() => excerptState(run, excerpts[0] as string, null));
    const t = performance.now();
    const checks = selfHealingOf(mindly).recheckFile(pid, root, 'src/data.txt', null);
    const all = performance.now() - t;
    expect(checks.map((c) => c.state)).toEqual(excerpts.map(() => 'invalid'));
    // The file is read and converted once; each row is one linear pass over it, and the rest is
    // marking the memories stale (a few times one row's time here).
    expect(all).toBeLessThan(60 * oneRow + 100);
  });

  it('decides every plain row of a large file in one pass, however many there are', async () => {
    const { root, mindly, pid, cx, write } = await featureSetup();
    const excerpts = Array.from(
      { length: 80 },
      (_, i) => `const value${i} = compute(${i}); // fact ${i}`,
    );
    const filler = Array.from({ length: 12_000 }, (_, i) => `let filler${i} = ${i};`).join('\n');
    write('src/big.ts', `${excerpts.join('\n')}\n${filler}`);
    for (const [i, excerpt] of excerpts.entries()) {
      mindly.memory.remember({
        projectId: pid,
        projectRoot: root,
        kind: 'fact',
        title: `fact ${i}`,
        body: `fact ${i}`,
        source: agentSource(cx),
        evidence: [{ path: 'src/big.ts', excerpt }],
      });
    }
    // Every excerpt removed: every one of them is gone, none left undecided.
    const after = `${filler}\n${filler}\n${filler}`.slice(0, 500_000);
    write('src/big.ts', after);
    let oneRow = Infinity;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      excerptState(after, excerpts[0] as string, null);
      oneRow = Math.min(oneRow, performance.now() - t);
    }
    const t = performance.now();
    const checks = selfHealingOf(mindly).recheckFile(pid, root, 'src/big.ts', null);
    const all = performance.now() - t;
    expect(checks.map((c) => c.state)).toEqual(excerpts.map(() => 'invalid'));
    // One pass for all rows; the rest is marking eighty memories stale.
    expect(all).toBeLessThan(60 * oneRow + 200);
  });

  it('gives every earlier row of a file a turn at the work allowed for it', async () => {
    const { root, mindly, pid, cx, write } = await featureSetup();
    const secret = ['sk', 'live', 'a1B2c3D4e5F6g7H8i9J0k1L2'].join('_');
    // 500 KB of short lookalike lines, and one line of its own.
    const rows: string[] = [];
    for (let i = 0, size = 0; size < 500 * 1024; i++) {
      rows.push(`k: ${i % 10}`);
      size += 5;
    }
    const own = `const apiKey = "${secret}"; // billing`;
    write('src/config.txt', `${rows.join('\n')}\n${own}\n`);
    const remember = (title: string, excerpt: string) =>
      mindly.memory.remember({
        projectId: pid,
        projectRoot: root,
        kind: 'fact',
        title,
        body: 'b',
        source: agentSource(cx),
        evidence: [{ path: 'src/config.txt', excerpt }],
      }).id;
    // Stored by an earlier build: a cited line whose kept text is on every line of the file (its
    // placement takes all the work allowed), and a row that is found at once when it has a turn.
    const greedy = remember('greedy', 'k: 1');
    const placeable = remember('placeable', `apiKey = "${secret}"; // billing`);
    mindly.store.db
      .prepare('UPDATE memory_evidence SET excerpt = ?, content_hash = ? WHERE memory_id = ?')
      .run('k: [REDACTED]', `lines:3:${sha256('gone')}`, greedy);
    const original = `apiKey = "${secret}"; // billing`;
    mindly.store.db
      .prepare('UPDATE memory_evidence SET excerpt = ?, content_hash = ? WHERE memory_id = ?')
      .run(
        sanitizeForContext(redactText(original), 2000),
        sha256(normalizeBlock(original)),
        placeable,
      );
    const hashOf = (id: string) => mindly.store.memories.evidenceFor(id)[0]!.contentHash ?? '';
    expect(hashOf(placeable)).not.toMatch(/^span:/);
    // Within two re-checks the second row has had the first turn: found, and moved to the exact
    // form. Neither is ever called gone.
    for (let i = 0; i < 2; i++) {
      const states = selfHealingOf(mindly).recheckFile(pid, root, 'src/config.txt', null);
      expect(states.map((c) => c.state)).not.toContain('invalid');
    }
    expect(hashOf(placeable)).toMatch(/^span:/);
  });

  it('builds the file made safe only when the work allowed for earlier evidence pays for it', () => {
    /** The best of three runs: the time of the work, not of compiling it. */
    const timed = <T>(f: () => T): [T, number] => {
      let best = Infinity;
      let r = f();
      for (let i = 0; i < 3; i++) {
        const t = performance.now();
        r = f();
        best = Math.min(best, performance.now() - t);
      }
      return [r, best];
    };
    // 500 KB with a character making safe removes on every line.
    const content = '\u0001x\n'.repeat(166_666);
    const [found, ms] = timed(() =>
      excerptWork(content, 'x[REDACTED]', `lines:1:${sha256('gone')}`),
    );
    expect(found.state).toBe('unknown');
    expect(found.work).toBeLessThanOrEqual(EARLIER_FORM_WORK);
    expect(found.scanned).toBeLessThanOrEqual(EVIDENCE_SCAN_WORK);
    // Little more than normalising the file, measured on this machine (the file made safe is not
    // built: it would cost more than the work allowed).
    const [, normalising] = timed(() => normalizeBlock(content));
    expect(ms).toBeLessThan(4 * normalising + 50);
  });

  it('keeps the validity of earlier evidence it cannot decide within the work for one file', () => {
    // Nothing but redactions was kept, on 40 lines: only every run of 40 whole lines could place
    // it, and in a 500 KB file that is more hashing than one check may do.
    const lines: string[] = [];
    for (let i = 0, size = 0; size < 500 * 1024; i++) {
      lines.push(`k${i}`);
      size += 6;
    }
    const keys = Array.from({ length: 40 }, (_, i) => `abcdef1234567890${i}`);
    const stored = keys.map(() => '[REDACTED]').join('\n');
    const hash = sha256(normalizeBlock(keys.join('\n')));
    expect(excerptState(lines.join('\n'), stored, hash)).toBe('unknown');
    // In a small file it is found; nothing kept can show it gone, so it is never called gone.
    const small = lines.slice(0, 400).join('\n');
    expect(excerptState(small, stored, hash)).toBe('unknown');
    expect(excerptState(`${small}\n${keys.join('\n')}`, stored, hash)).toBe('present');
  });

  it('places earlier evidence holding characters that are both unsafe and whitespace', () => {
    const secret = ['sk', 'live', 'a1B2c3D4e5F6g7H8i9J0k1L2'].join('_');
    for (const [name, ch] of [
      ['zero width no-break space', '\uFEFF'],
      ['vertical tab', '\u000B'],
      ['form feed', '\u000C'],
      ['lone carriage return', '\r'],
    ] as const) {
      const original = `sep: "a${ch}b", token: "${secret}"`;
      const stored = sanitizeForContext(redactText(original), 2000);
      const hash = sha256(normalizeBlock(original));
      expect(stored, name).toContain('[REDACTED]');
      const content = `// header\nconst X = { ${original}, region: "eu" };\nexport {};\n`;
      expect(excerptState(content, stored, hash), name).toBe('present');
      expect(excerptState(content.replace(secret, 'sk_live_other'), stored, hash), name).toBe(
        'unknown',
      );
      expect(excerptState(content.replace('sep: ', 'separator: '), stored, hash), name).toBe(
        'absent',
      );
    }
    // An invisible character just before what was kept (it was removed from the excerpt).
    const original = `\u200Btoken: "${secret}", region: "eu"`;
    const stored = sanitizeForContext(redactText(original), 2000);
    expect(stored.startsWith('token')).toBe(true);
    const content = `const X = { ${original} };\n`;
    expect(excerptState(content, stored, sha256(normalizeBlock(original)))).toBe('present');
  });

  it('places a cut excerpt whose cut fell inside a pair of a character', () => {
    let checked = 0;
    for (let pad = 0; pad < 4; pad++) {
      const original = `password=Xy7kQ2pZ ${'x'.repeat(pad)}${'ab😀'.repeat(500)}`.slice(0, 2000);
      const stored = sanitizeForContext(redactText(original), 2000);
      const hash = sha256(normalizeBlock(original));
      expect(stored.endsWith('…')).toBe(true);
      const content = `// header\nconst LONG = "${original} and more";\nexport {};\n`;
      // Whether the cut fell inside a pair, between two characters, or the original itself ends
      // with half of one (it was cut to 2000 code units when accepted).
      expect(excerptState(content, stored, hash), `pad ${pad}`).toBe('present');
      expect(
        excerptState(content.replace('Xy7kQ2pZ', 'Qq1wW2eE'), stored, hash),
        `pad ${pad}`,
      ).toBe('unknown');
      checked++;
    }
    expect(checked).toBe(4);
  });

  it('finds redacted evidence past the first 20,000 lines of a file', async () => {
    const { root, mindly, pid, cc, write } = await featureSetup();
    const secret = ['sk', 'live', 'a1B2c3D4e5F6g7H8i9J0k1L2'].join('_');
    const lines = Array.from({ length: 21_000 }, (_, i) => `k${i}=${i}`);
    lines[20_500] = `API_KEY=${secret} # prod`;
    write('src/long.env.txt', `${lines.join('\n')}\n`);
    const m = mindly.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'fact',
      title: 'The API key is set inline',
      body: 'b',
      source: agentSource(cc),
      evidence: [{ path: 'src/long.env.txt', excerpt: `API_KEY=${secret}` }],
    });
    expect(selfHealingOf(mindly).sweep(pid)).toMatchObject({ checked: 1, invalid: 0 });
    lines[20_500] = 'API_KEY=${VAULT_KEY} # prod';
    write('src/long.env.txt', `${lines.join('\n')}\n`);
    expect(selfHealingOf(mindly).sweep(pid)).toMatchObject({ invalid: 1, markedStale: 1 });
    expect(mindly.store.memories.get(m.id).trust).toBe('stale');
  });

  it('re-checks long redacted excerpts in time linear in the file, whatever their length', async () => {
    const { root, clock, mindly, pid, cc, write } = await featureSetup();
    const secret = (j: number) =>
      ['sk', 'live', `a1B2c3D4e5F6g7H8i9J0${String(j).padStart(4, '0')}`].join('_');
    // Blocks of up to 900 short lines, each opened by a secret, in a file of about 440 KB.
    const block = (j: number, n: number) =>
      [
        `token=${secret(j)}`,
        ...Array.from({ length: n - 1 }, (_, i) => String.fromCharCode(97 + (i % 26))),
      ].join('\n');
    const sizes = [900, 800, 700, 600, 500, 400, 300, 200, 100, 30];
    const filler = Array.from({ length: 48_000 }, (_, i) => `v${i}=x`).join('\n');
    const content = `${filler}\n${sizes.map((n, j) => block(j, n)).join('\n')}\n`;
    expect(content.length).toBeGreaterThan(400_000);
    write('src/blocks.txt', content);
    const ids = sizes.map(
      (n, j) =>
        mindly.memory.remember({
          projectId: pid,
          projectRoot: root,
          kind: 'fact',
          title: `block ${j}`,
          body: 'b',
          source: agentSource(cc),
          evidence: [{ path: 'src/blocks.txt', excerpt: block(j, n) }],
        }).id,
    );
    const timed = <T>(f: () => T): [T, number] => {
      const t = performance.now();
      const r = f();
      return [r, performance.now() - t];
    };
    const [same, sameMs] = timed(() =>
      selfHealingOf(mindly).recheckFile(pid, root, 'src/blocks.txt', null),
    );
    expect(same.map((r) => r.state)).toEqual(sizes.map(() => 'valid'));

    // Every secret rotated: all gone.
    write('src/blocks.txt', content.replace(/token=sk_live_/g, 'token=rotated_'));
    const [gone, goneMs] = timed(() =>
      selfHealingOf(mindly).recheckFile(pid, root, 'src/blocks.txt', null),
    );
    expect(gone.map((r) => r.state)).toEqual(sizes.map(() => 'invalid'));
    expect(mindly.store.memories.get(ids[0]!).trust).toBe('stale');
    // Tens of milliseconds on an idle machine; the bound leaves room for a busy one.
    expect(sameMs).toBeLessThan(1000);
    expect(goneMs).toBeLessThan(1000);

    // A sweep with the file unchanged does not look at evidence already found gone again. (The
    // store's clock is a fixed one here; it is moved past the file's time, as a real one would be.)
    clock.t = Date.now() + 60_000;
    selfHealingOf(mindly).recheckFile(pid, root, 'src/blocks.txt', null);
    const mark = vi.spyOn(mindly.store.memories, 'markEvidence');
    const [swept, sweepMs] = timed(() => selfHealingOf(mindly).sweep(pid));
    expect(swept).toMatchObject({ invalid: sizes.length, markedStale: 0 });
    expect(mark).not.toHaveBeenCalled();
    expect(sweepMs).toBeLessThan(1000);
    // Once the file is written again, it is looked at.
    write('src/blocks.txt', content);
    const later = (Date.now() + 120_000) / 1000;
    utimesSync(join(root, 'src/blocks.txt'), later, later);
    expect(selfHealingOf(mindly).sweep(pid)).toMatchObject({ invalid: 0, restored: sizes.length });
  });

  const SK = ['sk', 'live', 'abcdefghijklmnop1234'].join('_');
  const pem = (n: number): string =>
    [
      '-----BEGIN RSA PRIVATE KEY-----',
      ...Array.from(
        { length: n },
        (_, i) =>
          `MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cK${String(i).padStart(2, '0')}`,
      ),
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');

  /** Name, file content, excerpt: the shapes evidence with a secret in it takes. */
  const SHAPES: [string, string, string][] = [
    ['env full line', `A=1\nAPI_KEY=${SK}\nB=2\n`, `API_KEY=${SK}`],
    ['env part of an export line', `export API_KEY=${SK} # prod\n`, `API_KEY=${SK}`],
    [
      'json full line',
      '{\n  "token": "abcdef123456",\n  "x": 1\n}\n',
      '  "token": "abcdef123456",',
    ],
    [
      'json part of a line',
      '{\n  "token": "abcdef123456",\n  "x": 1\n}\n',
      '"token": "abcdef123456"',
    ],
    ['json minified', '{"a":1,"token":"abcdef123456","x":1}\n', '"token":"abcdef123456"'],
    ['yaml quoted', 'db:\n  password: "hunter2hunter2" # prod\n', 'password: "hunter2hunter2"'],
    ['yaml unquoted', 'db:\n  password: hunter2hunter2 # prod\n', 'password: hunter2hunter2'],
    [
      'curl whole line',
      'run:\n  curl -H "Authorization: Bearer abcdefgh12345678" https://x.test/a\n',
      'curl -H "Authorization: Bearer abcdefgh12345678" https://x.test/a',
    ],
    [
      'curl part of a line',
      'run:\n  curl -H "Authorization: Bearer abcdefgh12345678" https://x.test/a\n',
      '-H "Authorization: Bearer abcdefgh12345678" https',
    ],
    [
      'curl ending at the secret',
      'run:\n  curl -H "Authorization: Bearer abcdefgh12345678" https://x.test/a\n',
      'curl -H "Authorization: Bearer abcdefgh12345678',
    ],
    [
      'several lines, first one in part',
      'const cfg = {\n  host: "db",\n  password: "hunter2hunter2",\n  port: 5432,\n};\n',
      'cfg = {\n  host: "db",\n  password: "hunter2hunter2",\n  port: 5432',
    ],
    [
      'several whole lines',
      'const cfg = {\n  host: "db",\n  password: "hunter2hunter2",\n  port: 5432,\n};\n',
      '  host: "db",\n  password: "hunter2hunter2",\n  port: 5432,',
    ],
    ['cut inside the token', 'TOKEN=abcdefghijklmnop\n', 'TOKEN=abcdefghij'],
    ['crlf full line', `A=1\r\nAPI_KEY=${SK}\r\nB=2\r\n`, `API_KEY=${SK}`],
    ['crlf several lines', `A=1\r\nAPI_KEY=${SK}\r\nB=2\r\n`, `A=1\r\nAPI_KEY=${SK}\r\nB=2`],
    ['crlf part of a line', `export API_KEY=${SK} # x\r\nB=2\r\n`, `API_KEY=${SK}`],
    [
      'starting at the secret',
      `const k = "${SK}"; // stripe key here\n`,
      `${SK}"; // stripe key here`,
    ],
    ['only the secret', `stripe:\n  key: ${SK}\n`, SK],
    ['only the secret, in quotes', `const k = "${SK}";\n`, SK],
    [
      'query string',
      'const u = "https://x.test/?api_key=abcdef123456&v=2";\n',
      'api_key=abcdef123456',
    ],
    [
      'query string to the end of the value',
      'const u = "https://x.test/?api_key=abcdef123456&v=2";\n',
      '"https://x.test/?api_key=abcdef123456&v=2"',
    ],
    [
      'credentials in a url',
      'DATABASE_URL=postgres://admin:s3cretpw@db.internal:5432/app\n',
      'postgres://admin:s3cretpw@db.internal',
    ],
    [
      'secret followed by a pipe',
      'echo "password=hunter2hunter2|next"\n',
      'password=hunter2hunter2',
    ],
    ['secret followed by an escape', 'printf "token=abcdef123456\\n"\n', 'token=abcdef123456'],
    [
      'secret followed by a full stop',
      'Use the staging password=hunter2hunter2. Then deploy.\n',
      'password=hunter2hunter2',
    ],
    [
      'inline code in prose',
      'Set `API_TOKEN=abcdef123456` in the env file before running.\n',
      'API_TOKEN=abcdef123456',
    ],
    [
      'two secrets on a line',
      'A_TOKEN=xxxxxxxx11 B_TOKEN=yyyyyyyy22 C=3\n',
      'A_TOKEN=xxxxxxxx11 B_TOKEN=yyyyyyyy22',
    ],
    ['key block of 10 lines', `x\n${pem(10)}\ny\n`, pem(10)],
    [
      'key block of 26 lines after text on its line',
      `export const KEY = \`${pem(26)}\`;\n`,
      `KEY = \`${pem(26)}`,
    ],
    [
      'key block of 26 lines after a text line',
      `key below\n${pem(26)}\nend\n`,
      `below\n${pem(26)}`,
    ],
    [
      'key block of 10 lines after a text line',
      `key below\n${pem(10)}\nend\n`,
      `below\n${pem(10)}`,
    ],
    [
      'sanitised, not redacted',
      '// see <mindly-context> tag handling in parser\nconst a = 1;\n',
      '<mindly-context> tag handling in parser',
    ],
    ['trailing spaces', `API_KEY=${SK}   \nB=2\n`, `API_KEY=${SK}   `],
    ['python dict', "cfg = {'api_key': 'abcdef123456', 'x': 1}\n", "'api_key': 'abcdef123456'"],
    [
      'padded base64',
      'Authorization: Basic dXNlcjpwYXNzd29yZA== extra\n',
      'Authorization: Basic dXNlcjpwYXNzd29yZA==',
    ],
    ['tabs', '\tdb:\n\t\tpassword:\t"hunter2hunter2"\t# prod\n', 'password:\t"hunter2hunter2"'],
  ];

  it('holds for every shape of excerpt while the file is unchanged, and ends when its line changes', async () => {
    const { root, mindly, pid, cx, write } = await featureSetup();
    const wrong: string[] = [];
    for (const [i, [name, content, excerpt]] of SHAPES.entries()) {
      const rel = `src/shape${i}.txt`;
      write(rel, content);
      mindly.memory.remember({
        projectId: pid,
        projectRoot: root,
        kind: 'decision',
        title: `shape ${i}`,
        body: 'b',
        source: agentSource(cx),
        evidence: [{ path: rel, excerpt }],
      });
      const unchanged = selfHealingOf(mindly).recheckFile(pid, root, rel, null)[0]!.state;
      write(
        rel,
        content.replace(
          /abcdef|hunter2|xxxxxxxx|s3cretpw|MIIEvQ|dXNlcjpw|mindly-context/,
          'CHANGED0',
        ),
      );
      const changed = selfHealingOf(mindly).recheckFile(pid, root, rel, null)[0]!.state;
      if (unchanged !== 'valid' || changed !== 'invalid') {
        wrong.push(`${name}: unchanged ${unchanged}, changed ${changed}`);
      }
    }
    expect(SHAPES).toHaveLength(36);
    expect(wrong).toEqual([]);
  });

  it('checks evidence in large files in one pass, and sees a rotated value', async () => {
    const timed = <T>(f: () => T): [T, number] => {
      const t = performance.now();
      const r = f();
      return [r, performance.now() - t];
    };
    const value = (i: number) => `tok${String(i).padStart(9, '0')}xyz`;
    const json = [
      '{',
      ...Array.from(
        { length: 6000 },
        (_, i) =>
          `  "svc${i}": { "token": "${value(i)}", "url": "https://example.test/${i}", "n": ${i} },`,
      ),
      '  "end": 1',
      '}',
    ].join('\n');
    expect(json.length).toBeGreaterThan(500_000);
    for (const i of [5, 3000, 5999]) {
      const hash = evidenceHash(`"token": "${value(i)}"`, '"token": "[REDACTED]"');
      const [there, ms] = timed(() => excerptState(json, '"token": "[REDACTED]"', hash));
      expect(there).toBe('present');
      const [gone, ms2] = timed(() =>
        excerptState(json.replace(value(i), 'rotatedrotated'), '"token": "[REDACTED]"', hash),
      );
      expect(gone).toBe('absent');
      // A few milliseconds each on an idle machine; the bound leaves room for a busy one.
      expect(Math.max(ms, ms2)).toBeLessThan(250);
    }

    const { root, mindly, pid, cx, write } = await featureSetup();
    const env = (special: string): string =>
      `${Array.from(
        { length: 4000 },
        (_, i) =>
          `SERVICE_${i}_TOKEN=${i === 3999 ? special : `value${String(i).padStart(8, '0')}`} # svc ${i}`,
      ).join('\n')}\n`;
    write('src/big.env.txt', env('tok_special_12345'));
    const ids: string[] = [];
    for (let j = 0; j < 20; j++) {
      ids.push(
        mindly.memory.remember({
          projectId: pid,
          projectRoot: root,
          kind: 'decision',
          title: `service token ${j}`,
          body: 'b',
          source: agentSource(cx),
          evidence: [{ path: 'src/big.env.txt', excerpt: '_TOKEN=tok_special_12345' }],
        }).id,
      );
    }
    const [same, sameMs] = timed(() =>
      selfHealingOf(mindly).recheckFile(pid, root, 'src/big.env.txt', null),
    );
    expect(same.map((r) => r.state)).toEqual(Array.from({ length: 20 }, () => 'valid'));
    write('src/big.env.txt', env('value_rotated_999'));
    const [rotated, rotatedMs] = timed(() =>
      selfHealingOf(mindly).recheckFile(pid, root, 'src/big.env.txt', null),
    );
    expect(rotated.map((r) => r.state)).toEqual(Array.from({ length: 20 }, () => 'invalid'));
    expect(mindly.store.memories.get(ids[0]!).trust).toBe('stale');
    // The file is read and normalised once for all 20 rows.
    expect(sameMs).toBeLessThan(250);
    expect(rotatedMs).toBeLessThan(250);
  });
});

import { normalizeLine, sha256 } from '@mindly/core';
import { describe, expect, it } from 'vitest';
import { excerptPresent, excerptState, normalizeBlock, selfHealingOf } from '../../src/index.js';
import { citedLinesHash } from '../../src/memory/evidence-hash.js';
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

    // An excerpt that opens or closes with the redaction cannot be placed: gone, as before.
    const open = sha256(normalizeLine('abcdef123456", retries: 3'));
    expect(excerptState(line, '[REDACTED]", retries: 3', open)).toBe('absent');
    expect(excerptState(line, 'token: "[REDACTED]', sha256('token: "abcdef123456'))).toBe('absent');
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

    write('src/dense.ts', `${dense}\n`);
    expect(selfHealingOf(mindly).sweep(pid)).toEqual({
      checked: 0,
      invalid: 0,
      markedStale: 0,
      restored: 0,
    });
    expect(mindly.store.memories.evidenceFor(m.id)[0]!.valid).toBe(true);
    expect(mindly.store.memories.get(m.id).trust).not.toBe('stale');
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
    expect(stored.contentHash).toMatch(/^lines:1:[0-9a-f]{64}$/);
    expect(selfHealingOf(mindly).sweep(pid)).toMatchObject({ invalid: 0, markedStale: 0 });

    write('src/client.yaml', 'client:\n  token: ${VAULT_TOKEN}\n  retries: 3\n');
    expect(selfHealingOf(mindly).sweep(pid)).toMatchObject({ invalid: 1, markedStale: 1 });
    expect(mindly.store.memories.get(m.id).trust).toBe('stale');
  });

  it('compares the lines an excerpt was taken from, whatever the redaction left of it', () => {
    const cited = (content: string, excerpt: string) =>
      citedLinesHash(normalizeBlock(content), normalizeBlock(excerpt));
    const line = 'connect({ token: "abcdef123456", retries: 3 });';
    const file = `// client\n${line}\nexport {};\n`;

    // A redaction at the end of the excerpt, in the middle of a line.
    const closing = cited(file, 'token: "abcdef123456');
    expect(closing).toMatch(/^lines:1:/);
    expect(excerptPresent(file, 'token: "[REDACTED]', closing)).toBe(true);
    expect(
      excerptPresent(file.replace('abcdef123456', 'zzzzzz999999'), 'token: "[REDACTED]', closing),
    ).toBe(false);
    // Anything else on the cited line counts as a change of it.
    expect(
      excerptPresent(file.replace('retries: 3', 'retries: 4'), 'token: "[REDACTED]', closing),
    ).toBe(false);
    // Lines around it do not.
    expect(excerptPresent(`// other\n${line}\n`, 'token: "[REDACTED]', closing)).toBe(true);

    // Nothing but a redaction.
    const only = cited(file, 'abcdef123456');
    expect(excerptPresent(file, '[REDACTED]', only)).toBe(true);
    expect(excerptPresent('', '[REDACTED]', only)).toBe(false);
    expect(excerptPresent('export const unrelated = 1;\n', '[REDACTED]', only)).toBe(false);

    // A secret line followed by a plain one, with the secret line removed.
    const pair = 'x = 1\nabcdef123456\nmaxRetries = 3\n';
    const two = cited(pair, 'abcdef123456\nmaxRetries = 3');
    expect(two).toMatch(/^lines:2:/);
    expect(excerptPresent(pair, '[REDACTED]\nmaxRetries = 3', two)).toBe(true);
    expect(excerptPresent('x = 1\nmaxRetries = 3\n', '[REDACTED]\nmaxRetries = 3', two)).toBe(
      false,
    );
    expect(excerptPresent('maxRetries = 3\n', '[REDACTED]\nmaxRetries = 3', two)).toBe(false);

    // The parts still exist, thousands of lines apart: that is not the excerpt.
    const three = cited(
      'abcdef123456\nalpha = 1\nomega = 2\n',
      'abcdef123456\nalpha = 1\nomega = 2',
    );
    const filler = Array.from({ length: 5000 }, (_, i) => `line${i} = ${i}`).join('\n');
    expect(
      excerptPresent(
        `abcdef123456\nalpha = 1\n${filler}\nomega = 2\n`,
        '[REDACTED]\nalpha = 1\nomega = 2',
        three,
      ),
    ).toBe(false);
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
      const hash = citedLinesHash(normalizeBlock(json), `"token": "${value(i)}"`);
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
    // The file is read and hashed once for all 20 rows.
    expect(sameMs).toBeLessThan(250);
    expect(rotatedMs).toBeLessThan(250);
  });
});

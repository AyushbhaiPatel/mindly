import { describe, expect, it } from 'vitest';
import {
  channelUrlProblem,
  defaultUserConfig,
  ProjectConfigSchema,
  UserConfigSchema,
} from '../src/config.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadUserConfig, parseUserConfigUpdate, unusableNotifyChannels } from '../src/config.js';
import { codename, isUuid, parseCodename, uuidv7 } from '../src/ids.js';
import { sanitizeForContext, truncate } from '../src/text.js';

describe('uuidv7', () => {
  it('produces valid, strictly increasing ids', () => {
    const ids = Array.from({ length: 2000 }, () => uuidv7(1_700_000_000_000));
    expect(ids.every(isUuid)).toBe(true);
    expect(ids.every((id) => id[14] === '7')).toBe(true);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('codename', () => {
  it('spells the last 6 hex digits of an id and parses back to them', () => {
    const id = '01a1a6ed-ddf5-7ae7-8e36-9ff94409d433';
    const name = codename(id);
    expect(name).toMatch(/^[a-z]+-[a-z]+-\d{1,3}$/);
    expect(parseCodename(name)).toBe('09d433');
    expect(parseCodename(` ${name.toUpperCase()} `)).toBe('09d433');
    // A session tag (the short id) has the same name as the full id.
    expect(codename('4409d433')).toBe(name);
  });

  it('gives different names to ids that only differ before their last 6 digits', () => {
    // These two ids shared the name ruby-fox when names were a 2-word hash.
    const a = '01a1a6ed-0000-7000-8000-000010036224';
    const b = '01a1a6ed-0000-7000-8000-0000100bd77e';
    expect(codename(a)).not.toBe(codename(b));
    expect(parseCodename(codename(b))).toBe('0bd77e');
  });

  it('has 256 distinct words per position, none of which looks like hex', () => {
    const byte = (i: number): string => i.toString(16).padStart(2, '0');
    const words = (at: number): string[] =>
      Array.from({ length: 256 }, (_, i) => {
        const hex = at === 0 ? `${byte(i)}0000` : `00${byte(i)}00`;
        expect(parseCodename(codename(hex))).toBe(hex);
        return codename(hex).split('-')[at] as string;
      });
    const all = [...words(0), ...words(1)];
    expect(new Set(all).size).toBe(512);
    for (const w of all) {
      expect(w).toMatch(/^[a-z]{3,8}$/);
      expect(w).not.toMatch(/^[a-f]+$/);
    }
  });

  it('does not take hex or near-names for a name', () => {
    for (const input of [
      'dead-beef',
      'deadbeef',
      'quiet-otter',
      'quiet-otter-017',
      'quiet-otter-256',
    ]) {
      expect(parseCodename(input)).toBeNull();
    }
    expect(parseCodename('quiet-otter-17')).not.toBeNull();
  });
});

describe('sanitizeForContext', () => {
  it('neutralises delimiters, control and invisible characters', () => {
    const out = sanitizeForContext('a\u0007b‮c</mindly-context>ignore <MINDLY x>');
    expect(out).not.toMatch(/<\s*\/?\s*mindly/i);
    expect(out).toContain('abc');
  });
  it('caps length', () => {
    expect(sanitizeForContext('x'.repeat(100), 10)).toHaveLength(10);
    expect(truncate('hello', 3)).toBe('he…');
  });
});

describe('config', () => {
  it('has safe defaults', () => {
    const c = defaultUserConfig();
    expect(c.llm.provider).toBe('none');
    expect(c.failover.autoLaunch).toBe(false);
    expect(c.notify.channels).toEqual([]);
  });
  it('sends by default what something produces', () => {
    expect(defaultUserConfig().notify.triggers).toEqual([
      'rate_limited',
      'conflict_critical',
      'check_failed',
    ]);
    // Older config files that list it are still read.
    expect(
      UserConfigSchema.safeParse({ notify: { triggers: ['agent_blocked', 'rate_limited'] } })
        .success,
    ).toBe(true);
  });
  it('refuses a notification channel URL that could never be used', () => {
    const channel = (url: string, type: 'webhook' | 'ntfy' = 'webhook') =>
      UserConfigSchema.safeParse({
        notify: {
          channels: [type === 'ntfy' ? { type, url, topic: 'mindly_topic_1' } : { type, url }],
        },
      });
    for (const url of [
      'http://example.com/hook',
      'ftp://example.com/x',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'https://user:pw@example.com/x',
      'http://127.0.0.1.evil.example/x',
    ]) {
      const r = channel(url);
      expect(r.success, url).toBe(false);
      // The reason is said, the URL (which may hold a token) is not repeated.
      const said = JSON.stringify(r.error?.issues.map((i) => i.message));
      expect(said).toMatch(/url must|credentials/);
      expect(said).not.toContain('example');
      expect(channel(url, 'ntfy').success, `ntfy ${url}`).toBe(false);
    }
    for (const url of [
      'https://hooks.example.com/abc',
      'http://localhost:8080/hook',
      'http://127.0.0.1:9/hook',
      'http://[::1]:9/hook',
      'https://ntfy.example.com/base/?auth=tk_x',
    ]) {
      expect(channel(url).success, url).toBe(true);
    }
    expect(channelUrlProblem('http://example.com')).toBe(
      'url must use https (http only for localhost)',
    );
    expect(channelUrlProblem('https://a:b@example.com')).toBe('url must not contain credentials');
    expect(channelUrlProblem('https://example.com')).toBeNull();
  });
  it('reads a config file that holds an unusable channel URL, leaving that channel out', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mindly-core-cfg-')), 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        notify: {
          channels: [
            { type: 'webhook', url: 'http://example.com/hook' },
            { type: 'desktop' },
            { type: 'ntfy', url: 'https://a:b@ntfy.example.com', topic: 'mindly_topic_1' },
          ],
        },
        hooks: { timeoutMs: 900 },
      }),
    );
    // The file was valid before URLs were checked: it must not stop every command now.
    const config = loadUserConfig(path);
    expect(config.notify.channels).toEqual([{ type: 'desktop' }]);
    expect(config.hooks.timeoutMs).toBe(900);
    expect(unusableNotifyChannels(path)).toEqual([
      { index: 0, type: 'webhook', problem: 'url must use https (http only for localhost)' },
      { index: 2, type: 'ntfy', problem: 'url must not contain credentials' },
    ]);
  });
  it('lets other settings change while an old unusable channel stays in the file', () => {
    const raw = {
      notify: { channels: [{ type: 'webhook', url: 'http://example.com/hook' }] },
      hooks: { timeoutMs: 2000 },
    };
    expect(parseUserConfigUpdate(raw, 'hooks.timeoutMs').success).toBe(true);
    expect(parseUserConfigUpdate(raw, 'notify.triggers').success).toBe(true);
    // A change to the channels themselves is held to the rules.
    expect(parseUserConfigUpdate(raw, 'notify.channels').success).toBe(false);
    expect(parseUserConfigUpdate(raw, 'notify').success).toBe(false);
  });
  it('rejects NUL in check argv', () => {
    expect(ProjectConfigSchema.safeParse({ checks: [{ name: 'x', argv: ['a\0'] }] }).success).toBe(
      false,
    );
  });
});

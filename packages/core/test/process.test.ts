import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  psProcessLookup,
  ancestorChain,
  completeLines,
  hookAncestryKey,
  isLauncherName,
  isShellName,
  MAX_ANCESTORS,
  parseProcessChain,
  parsePsTable,
  processRuns,
  systemProcessLookup,
  type ProcessLookup,
} from '../src/index.js';

/** A process table: pid -> [parent pid, start]. */
function table(rows: Record<number, [number, string]>): ProcessLookup {
  return (pid) => {
    const row = rows[pid];
    return row ? { ppid: row[0], start: row[1] } : null;
  };
}

describe('ancestorChain', () => {
  it('lists the ancestors nearest first, without the process itself or init', () => {
    const lookup = table({ 50: [40, 'e'], 40: [30, 'd'], 30: [1, 'c'], 1: [0, 'a'] });
    expect(ancestorChain(50, lookup)).toEqual([
      { pid: 40, start: 'd' },
      { pid: 30, start: 'c' },
    ]);
  });

  it('stops at the limit, at a process it cannot read and at a loop', () => {
    const deep: Record<number, [number, string]> = {};
    for (let pid = 100; pid > 80; pid--) deep[pid] = [pid - 1, `s${pid}`];
    expect(ancestorChain(100, table(deep))).toHaveLength(MAX_ANCESTORS);
    expect(ancestorChain(50, table({ 50: [40, 'e'] }))).toEqual([]);
    expect(ancestorChain(50, table({ 50: [40, 'e'], 40: [50, 'd'] }))).toEqual([
      { pid: 40, start: 'd' },
    ]);
    expect(ancestorChain(50, () => null)).toEqual([]);
    expect(
      ancestorChain(50, () => {
        throw new Error('no process table');
      }),
    ).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('reads the real parent of this process', () => {
    const chain = ancestorChain(process.pid);
    expect(chain[0]?.pid).toBe(process.ppid);
    expect(chain[0]?.start).not.toBe('');
    expect(processRuns(chain[0]!)).toBe(true);
    // The same PID with another start time is another process.
    expect(processRuns({ pid: chain[0]!.pid, start: 'not-this-one' })).toBe(false);
    expect(systemProcessLookup()(process.pid)?.ppid).toBe(process.ppid);
  });

  it.skipIf(!existsSync('/bin/ps') && !existsSync('/usr/bin/ps'))(
    'reads the same parent through ps, where there is no /proc',
    () => {
      const lookup = psProcessLookup();
      const chain = ancestorChain(process.pid, lookup);
      expect(chain[0]?.pid).toBe(process.ppid);
      expect(chain[0]?.start).toMatch(/\d{4}$/);
      expect(processRuns(chain[0]!, lookup)).toBe(true);
    },
  );
});

describe('parsePsTable', () => {
  it('reads pid, parent and start time from each line', () => {
    const out = [
      '    1     0 Mon Nov  9 20:13:54 2026',
      '  812     1 Mon Nov  9 20:14:02 2026',
      '34567   812 Tue Nov 10 03:01:09 2026',
      'garbage',
      '',
    ].join('\n');
    const t = parsePsTable(out);
    expect(t.size).toBe(3);
    expect(t.get(34567)).toEqual({ ppid: 812, start: 'Tue Nov 10 03:01:09 2026' });
    expect(t.get(1)).toEqual({ ppid: 0, start: 'Mon Nov 9 20:13:54 2026' });
    // A header, CRLF line ends and junk around the table do not get in the way.
    const odd = parsePsTable(`  PID  PPID STARTED\r\n${out.replace(/\n/g, '\r\n')}junk\r\n`);
    expect(odd.get(812)).toEqual({ ppid: 1, start: 'Mon Nov 9 20:14:02 2026' });
    const lookup: ProcessLookup = (pid) => t.get(pid) ?? null;
    expect(ancestorChain(34567, lookup)).toEqual([{ pid: 812, start: 'Mon Nov 9 20:14:02 2026' }]);
  });
});

describe('ps output', () => {
  const whole = '  812     1 Mon Nov  9 20:14:02 2026 /usr/bin/node\n';
  it('reads the command name after the start time', () => {
    expect(parsePsTable(whole).get(812)).toEqual({
      ppid: 1,
      start: 'Mon Nov 9 20:14:02 2026',
      name: '/usr/bin/node',
    });
    expect(
      parsePsTable('  9  1 Mon Nov  9 20:14:02 2026 Cursor Helper (Plugin)\n').get(9)?.name,
    ).toBe('Cursor Helper (Plugin)');
  });

  it('drops a line cut off when ps was killed or failed', () => {
    // Killed in the middle of the year: the cut line would still parse, with a wrong start.
    const cut = `${whole}34567   812 Tue Nov 10 03:01:09 20`;
    expect(parsePsTable(completeLines(cut, true)).has(34567)).toBe(false);
    expect(parsePsTable(completeLines(cut, false)).has(34567)).toBe(false);
    // A line that ended before the cut is whole, killed or not.
    expect(parsePsTable(completeLines(`${whole}9 1 Tue Nov 10 03:01:09 2026\n`, true)).has(9)).toBe(
      true,
    );
    expect(completeLines(whole, false)).toBe(whole);
  });

  it('tells launchers from clients by name', () => {
    for (const name of [
      'node',
      '/usr/local/bin/node',
      'npx',
      'npm exec',
      'pnpm',
      'sh',
      'node.exe',
    ]) {
      expect(isLauncherName(name)).toBe(true);
    }
    for (const name of ['claude', 'codex', 'Cursor Helper', 'tmux: server', undefined, '']) {
      expect(isLauncherName(name)).toBe(false);
    }
    // macOS `ps` prints the full path, which may hold spaces.
    expect(isLauncherName('/Users/x/Library/Application Support/fnm/node-versions/bin/node')).toBe(
      true,
    );
    expect(isLauncherName('/Applications/Some App.app/Contents/MacOS/Some App')).toBe(false);
    expect(isShellName('/bin/bash')).toBe(true);
    // Login shells as macOS `ps` lists them, and the csh family.
    for (const shell of ['-zsh', '-bash', 'tcsh', 'csh', 'ksh', 'fish', 'dash']) {
      expect(isShellName(shell)).toBe(true);
    }
    expect(isShellName('node')).toBe(false);
  });
});

describe('stored chains', () => {
  it('reads back only well-formed entries', () => {
    expect(parseProcessChain([{ pid: 4, start: 'x' }, { pid: 'no' }, null, 7])).toEqual([
      { pid: 4, start: 'x' },
    ]);
    expect(parseProcessChain('nonsense')).toEqual([]);
    expect(parseProcessChain(null)).toEqual([]);
    expect(hookAncestryKey('claude-code', 'abc')).toBe('hook:ancestry:claude-code:abc');
  });
});

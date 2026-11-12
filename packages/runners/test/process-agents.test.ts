import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isMindlyError } from '@mindly/core';
import {
  AGENT_PROFILES,
  buildAgentEnv,
  createRunners,
  detectAgent,
  launchTask,
  parseClaudeOutput,
  parseCodexOutput,
  runAgent,
  runProcess,
} from '../src/index.js';
import {
  claudeResultBody,
  codexResultBody,
  installFake,
  isAlive,
  makeFakeBin,
  makeRepo,
  tempDir,
} from './helpers.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('detectAgent', () => {
  it('finds executables on PATH and ignores missing or non-executable ones', () => {
    const bin = makeFakeBin();
    expect(detectAgent('claude-code', { PATH: bin.dir })).toBeNull();
    installFake(bin, 'claude', claudeResultBody('hi'));
    expect(detectAgent('claude-code', { PATH: bin.dir })).toBe(join(bin.dir, 'claude'));
    // Relative PATH entries are ignored.
    expect(detectAgent('claude-code', { PATH: '.' })).toBeNull();
  });

  it('rejects unsupported agent kinds', () => {
    expect(() => detectAgent('cursor')).toThrow(/unsupported agent kind/);
    expect(() => detectAgent('../claude')).toThrow();
  });
});

describe('buildAgentEnv', () => {
  it('keeps only the allow-list plus set auth variables', () => {
    const env = buildAgentEnv(['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR'], {
      PATH: '/bin',
      HOME: '/home/x',
      SECRET_X: 'no',
      NODE_OPTIONS: '--require evil',
      ANTHROPIC_API_KEY: 'k',
      TERM: 'xterm-256color',
    });
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/home/x',
      TERM: 'dumb',
      NO_COLOR: '1',
      MINDLY_HEADLESS_RUN: '1',
      ANTHROPIC_API_KEY: 'k',
    });
  });
});

describe('agent argv', () => {
  const ctx = { cwd: '/repo', maxTurns: 5, lastMessageFile: '/tmp/x/last.txt' };

  it('claude review uses plan mode, read-only tools and denies edit/write/bash', () => {
    const argv = AGENT_PROFILES['claude-code'].buildArgv({ ...ctx, mode: 'review' });
    expect(argv).toContain('-p');
    expect(argv.join(' ')).toContain('--permission-mode plan');
    expect(argv.join(' ')).toContain('--output-format json');
    const denied = argv[argv.indexOf('--disallowedTools') + 1] ?? '';
    for (const t of ['Edit', 'Write', 'Bash']) expect(denied.split(',')).toContain(t);
    expect(argv[argv.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    expect(argv).not.toContain('acceptEdits');
  });

  it('claude task uses acceptEdits', () => {
    const argv = AGENT_PROFILES['claude-code'].buildArgv({ ...ctx, mode: 'task' });
    expect(argv.join(' ')).toContain('--permission-mode acceptEdits');
  });

  it('codex review uses the read-only sandbox and reads the prompt from stdin', () => {
    const argv = AGENT_PROFILES.codex.buildArgv({ ...ctx, mode: 'review' });
    expect(argv[0]).toBe('exec');
    expect(argv.join(' ')).toContain('--sandbox read-only');
    expect(argv.at(-1)).toBe('-');
    expect(AGENT_PROFILES.codex.buildArgv({ ...ctx, mode: 'task' }).join(' ')).toContain(
      '--sandbox workspace-write',
    );
  });
});

describe('output parsing', () => {
  it('parses claude json and tolerates plain text', () => {
    const p = parseClaudeOutput(
      JSON.stringify({ type: 'result', result: 'done', total_cost_usd: 0.5, is_error: false }),
    );
    expect(p).toMatchObject({ text: 'done', structured: true, costUsd: 0.5, isError: false });
    expect(parseClaudeOutput('just text\n')).toMatchObject({
      text: 'just text',
      structured: false,
    });
    expect(parseClaudeOutput('{"type":"result","is_error":true,"result":"x"}').isError).toBe(true);
  });

  it('parses codex jsonl, prefers the last-message file and ignores junk lines', () => {
    const out = [
      'noise',
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"from events"}}',
      '{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":4}}',
      '{broken',
    ].join('\n');
    expect(parseCodexOutput(out, null)).toMatchObject({
      text: 'from events',
      sessionId: 't1',
      usage: { inputTokens: 3, outputTokens: 4 },
    });
    expect(parseCodexOutput(out, 'from file').text).toBe('from file');
    expect(parseCodexOutput('plain', null)).toMatchObject({ text: 'plain', structured: false });
  });
});

describe('runAgent', () => {
  it('sends the prompt via stdin (not argv) with a minimal environment', async () => {
    const bin = makeFakeBin();
    installFake(bin, 'claude', claudeResultBody('ok'));
    const cwd = tempDir();
    const prompt = 'PROMPT-MARKER-123 please do things';
    const res = await runAgent('claude-code', 'review', cwd, prompt, 20, { env: bin.env });
    expect(res.status).toBe('completed');
    expect(res.parsed.text).toBe('ok');
    expect(res.costUsd).toBe(0.0123);
    const log = bin.log('claude');
    expect(log).not.toBeNull();
    expect(log?.stdin).toBe(prompt);
    expect(log?.argv.join(' ')).not.toContain('PROMPT-MARKER-123');
    expect(log?.env['SECRET_X']).toBeUndefined();
    expect(log?.env['OPENAI_API_KEY']).toBeUndefined();
    expect(log?.env['ANTHROPIC_API_KEY']).toBe('test-anthropic-key');
    expect(log?.env['TERM']).toBe('dumb');
    expect(log?.cwd).toBe(cwd);
  });

  it('reads codex output from the last-message file', async () => {
    const bin = makeFakeBin();
    installFake(bin, 'codex', codexResultBody('codex says hi'));
    const cwd = tempDir();
    const res = await runAgent('codex', 'review', cwd, 'hello', 20, { env: bin.env });
    expect(res.status).toBe('completed');
    expect(res.parsed.text).toBe('codex says hi');
    expect(res.usage).toEqual({ inputTokens: 50, outputTokens: 7, cachedInputTokens: 10 });
    const log = bin.log('codex');
    expect(log?.env['OPENAI_API_KEY']).toBe('test-openai-key');
    expect(log?.env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(log?.argv).toContain(cwd);
  });

  it('kills the process group on timeout, escalating to SIGKILL', async () => {
    const bin = makeFakeBin();
    const pidFile = join(tempDir(), 'grandchild.pid');
    installFake(
      bin,
      'claude',
      `process.on('SIGTERM', () => {});
       const c = cp.spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });
       fs.writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
       setInterval(() => {}, 1000);`,
    );
    const res = await runAgent('claude-code', 'task', tempDir(), 'x', 1, {
      env: bin.env,
      killGraceMs: 200,
    });
    expect(res.status).toBe('timeout');
    expect(res.process.timedOut).toBe(true);
    expect(res.durationMs).toBeLessThan(10_000);
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    await sleep(300);
    expect(isAlive(grandchild)).toBe(false);
  });

  it('still kills a group member that ignores SIGTERM after the program itself has exited', async () => {
    const pidFile = join(tempDir(), 'grandchild.pid');
    // The program dies on SIGTERM; its child ignores it and holds none of the pipes.
    const program = `
      const cp = require('node:child_process');
      const c = cp.spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
      setInterval(() => {}, 1000);`;
    for (const how of ['timeout', 'abort'] as const) {
      const ac = new AbortController();
      if (how === 'abort') setTimeout(() => ac.abort(), 500);
      const res = await runProcess({
        bin: process.execPath,
        argv: ['-e', program],
        cwd: tempDir(),
        env: {},
        timeoutMs: how === 'timeout' ? 500 : 30_000,
        killGraceMs: 200,
        signal: ac.signal,
      });
      expect([how, res.timedOut, res.aborted]).toEqual([how, how === 'timeout', how === 'abort']);
      const grandchild = Number(readFileSync(pidFile, 'utf8'));
      await sleep(600);
      expect(isAlive(grandchild)).toBe(false);
    }
  });

  it('does not report a timeout for a program that ended in time while a child held its output', async () => {
    // Exits at once with code 0; its child keeps stdout open past the time limit.
    const program = `
      require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'inherit' });
      console.log('done');
      process.exit(0);`;
    const res = await runProcess({
      bin: process.execPath,
      argv: ['-e', program],
      cwd: tempDir(),
      env: {},
      timeoutMs: 600,
      killGraceMs: 200,
    });
    expect(res.timedOut).toBe(false);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('done');
    expect(res.durationMs).toBeLessThan(10_000);
  });

  it('supports AbortSignal', async () => {
    const bin = makeFakeBin();
    installFake(bin, 'claude', 'setInterval(() => {}, 1000);');
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const res = await runAgent('claude-code', 'task', tempDir(), 'x', 30, {
      env: bin.env,
      signal: ac.signal,
      killGraceMs: 200,
    });
    expect(res.status).toBe('aborted');
  });

  it('caps stdout (head) and stderr (tail)', async () => {
    const bin = makeFakeBin();
    installFake(
      bin,
      'claude',
      `process.stderr.write('E'.repeat(200000) + 'STDERR-END');
       const chunk = 'A'.repeat(65536);
       let n = 0;
       const pump = () => { while (n < 48) { n++; if (!process.stdout.write(chunk)) { process.stdout.once('drain', pump); return; } } };
       pump();`,
    );
    const res = await runAgent('claude-code', 'task', tempDir(), 'x', 20, {
      env: bin.env,
      maxStdoutBytes: 100_000,
      maxStderrBytes: 1000,
    });
    expect(res.process.stdoutTruncated).toBe(true);
    expect(res.process.stdout.length).toBe(100_000);
    expect(res.process.stderrTruncated).toBe(true);
    expect(res.process.stderr.length).toBe(1000);
    expect(res.process.stderr.endsWith('STDERR-END')).toBe(true);
    // Unparseable output is tolerated.
    expect(res.parsed.structured).toBe(false);
  });

  it('reports failures and missing agents', async () => {
    const bin = makeFakeBin();
    installFake(bin, 'claude', `process.stderr.write('boom'); process.exit(3);`);
    const res = await runAgent('claude-code', 'task', tempDir(), 'x', 20, { env: bin.env });
    expect(res.status).toBe('failed');
    expect(res.exitCode).toBe(3);
    await expect(
      runAgent('codex', 'task', tempDir(), 'x', 20, { env: { PATH: bin.dir } }),
    ).rejects.toSatisfy((e: unknown) => isMindlyError(e, 'unavailable'));
  });

  it('rejects invalid prompts and timeouts', async () => {
    await expect(runAgent('claude-code', 'task', tempDir(), '', 10)).rejects.toThrow(/prompt/);
    await expect(runAgent('claude-code', 'task', tempDir(), 'x', 0)).rejects.toThrow(/timeout/);
  });
});

describe('launchTask and createRunners', () => {
  it('launches in task mode inside a git worktree only', async () => {
    const bin = makeFakeBin();
    installFake(bin, 'codex', codexResultBody('finished the task'));
    const repo = makeRepo();
    const res = await launchTask(
      { agent: 'codex', cwd: repo, prompt: 'continue', timeoutSec: 20 },
      { env: bin.env },
    );
    expect(res).toMatchObject({ status: 'completed', summary: 'finished the task', cwd: repo });
    expect(res.sessionId).toBe('thread-1');
    expect(bin.log('codex')?.argv.join(' ')).toContain('--sandbox workspace-write');
    await expect(
      launchTask({ agent: 'codex', cwd: tempDir(), prompt: 'x', timeoutSec: 5 }, { env: bin.env }),
    ).rejects.toThrow();
    await expect(
      launchTask({ agent: 'cursor', cwd: repo, prompt: 'x', timeoutSec: 5 }),
    ).rejects.toThrow(/unsupported agent kind/);
  });

  it('available() checks PATH (defaults to process.env)', async () => {
    const bin = makeFakeBin();
    installFake(bin, 'claude', claudeResultBody('x'));
    const saved = process.env['PATH'];
    process.env['PATH'] = bin.dir;
    try {
      const runners = createRunners();
      expect(await runners.available('claude-code')).toBe(true);
      expect(await runners.available('codex')).toBe(false);
      expect(await runners.available('cursor')).toBe(false);
    } finally {
      process.env['PATH'] = saved;
    }
  });
});

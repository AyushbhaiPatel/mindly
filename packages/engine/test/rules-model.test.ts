import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultUserConfig, type Logger, type UserConfig } from '@mindly/core';
import { Mindly, type LlmCallOptions, type LlmPort } from '../src/index.js';
import { event, FakeClock, fakeGit } from './helpers.js';

type Verdict = Awaited<ReturnType<LlmPort['classifyCorrection']>>;

/** A model that answers (or never answers) and records what it was sent. */
function fakeModel(answer: (prompt: string, options?: LlmCallOptions) => Promise<Verdict>): {
  port: LlmPort;
  prompts: string[];
  options: (LlmCallOptions | undefined)[];
} {
  const prompts: string[] = [];
  const options: (LlmCallOptions | undefined)[] = [];
  return {
    prompts,
    options,
    port: {
      available: true,
      classifyCorrection: (prompt, o) => {
        prompts.push(prompt);
        options.push(o);
        return answer(prompt, o);
      },
      summarizeTurn: async () => null,
    },
  };
}

/** Never answers on its own; resolves null once the caller gives up. */
function silentModel(): ReturnType<typeof fakeModel> {
  return fakeModel(
    (_p, o) =>
      new Promise((resolve) => {
        o?.signal?.addEventListener('abort', () => resolve(null), { once: true });
      }),
  );
}

function open(llm: LlmPort, patch: (c: UserConfig) => void = () => undefined) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'syn-rules-model-')));
  const config = defaultUserConfig();
  patch(config);
  const mindly = Mindly.open({
    inMemory: true,
    clock: new FakeClock(),
    config,
    ports: { git: fakeGit, llm },
  });
  const pid = mindly.store.projects.upsertByRoot(root, 'demo').id;
  return { root, mindly, pid };
}

async function say(p: ReturnType<typeof open>, prompt: string) {
  await p.mindly.hooks.handle(event(p.root, 'claude-code', 'cc', 'session_start'));
  await p.mindly.hooks.handle(event(p.root, 'claude-code', 'cc', 'prompt', { prompt }));
  return p.mindly.memory
    .list(p.pid, { kinds: ['rule'] })
    .filter((m) => m.tags.includes('say-it-once'));
}

describe('rules confirmed by the model', () => {
  it('stores the rule as with no model when the model does not answer in time', async () => {
    const model = silentModel();
    const p = open(model.port);
    const started = Date.now();
    const rules = await say(p, 'No, use pnpm instead of npm.');
    const took = Date.now() - started;
    expect(rules.map((r) => [r.title, r.trust])).toEqual([['Use pnpm instead of npm', 'proposed']]);
    // The default hook deadline is 1500 ms: the model gets well under it.
    expect(took).toBeLessThan(1000);
    expect(model.options[0]?.signal?.aborted).toBe(true);
  });

  it('asks about several sentences at once, within one budget', async () => {
    const model = silentModel();
    const p = open(model.port, (c) => {
      c.hooks.timeoutMs = 500;
    });
    const started = Date.now();
    await say(p, 'No, use pnpm instead of npm.\nDo not touch the generated folder.');
    const took = Date.now() - started;
    expect(model.prompts).toHaveLength(2);
    // 40% of a 500 ms deadline, shared: not one budget after the other.
    expect(took).toBeLessThan(450);
  });

  it('never raises a medium-strength correction above proposed', async () => {
    const model = fakeModel(async () => ({
      isRule: true,
      rule: 'Use pnpm',
      scopeGlobs: ['packages/**'],
      confidence: 0.99,
    }));
    const p = open(model.port);
    const rules = await say(p, 'No, use pnpm instead of npm.');
    expect(rules.map((r) => r.trust)).toEqual(['proposed']);
    // It may still narrow where the rule applies.
    expect(rules[0]?.scope.paths).toEqual(['packages/**']);
  });

  it('never changes the scope of a rule the user approved, and only narrows a proposal', async () => {
    let globs = ['src/a/**'];
    const model = fakeModel(async () => ({
      isRule: true,
      rule: 'Use pnpm',
      scopeGlobs: globs,
      confidence: 0.5,
    }));
    const p = open(model.port);
    const [first] = await say(p, 'No, use pnpm instead of npm.');
    expect(first?.scope.paths).toEqual(['src/a/**']);

    // Wider than the proposal: not applied.
    globs = ['src/**'];
    const [wider] = await say(p, 'No, use pnpm instead of npm.');
    expect(wider?.scope.paths).toEqual(['src/a/**']);

    // Inside it: applied.
    globs = ['src/a/b/**'];
    const [narrower] = await say(p, 'No, use pnpm instead of npm.');
    expect(narrower?.scope.paths).toEqual(['src/a/b/**']);

    // Once the user approved it, the model's scope is ignored, wider or narrower.
    p.mindly.memory.approve(first!.id);
    for (const g of [['**'], ['nothing-matches/**'], ['src/a/b/c/**']]) {
      globs = g;
      const [after] = await say(p, 'No, use pnpm instead of npm.');
      expect(after?.trust).toBe('approved');
      expect(after?.scope.paths).toEqual(['src/a/b/**']);
    }
  });

  it('drops a sentence the model says is not a rule', async () => {
    const model = fakeModel(async () => ({
      isRule: false,
      rule: '',
      scopeGlobs: [],
      confidence: 0.9,
    }));
    const p = open(model.port);
    expect(await say(p, 'No, use pnpm instead of npm.')).toEqual([]);
  });

  it('sends the sentence with the user’s extra redaction patterns applied', async () => {
    const model = fakeModel(async () => null);
    const p = open(model.port, (c) => {
      c.redaction.extraPatterns = ['ACME-INTERNAL-[0-9]+'];
    });
    await say(p, 'No, use ACME-INTERNAL-424242 instead of npm.');
    expect(model.prompts[0]).not.toContain('ACME-INTERNAL-424242');
    expect(model.options[0]?.redactPatterns).toEqual(['ACME-INTERNAL-[0-9]+']);
  });

  it('logs once that the configured model cannot be used', async () => {
    const lines: string[] = [];
    const port: LlmPort = {
      available: false,
      unavailableReason: 'ollama baseUrl must point at localhost',
      classifyCorrection: async () => null,
      summarizeTurn: async () => null,
    };
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'syn-rules-model-')));
    const logger: Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (m, f) => lines.push(`${m} ${JSON.stringify(f ?? {})}`),
      error: () => undefined,
      child: () => logger,
    };
    const mindly = Mindly.open({
      inMemory: true,
      clock: new FakeClock(),
      ports: { git: fakeGit, llm: port },
      logger,
    });
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    for (let i = 0; i < 3; i++) {
      await mindly.hooks.handle(
        event(root, 'claude-code', 'cc', 'prompt', { prompt: 'No, use pnpm instead of npm.' }),
      );
    }
    expect(lines.filter((l) => l.includes('localhost'))).toHaveLength(1);
  });
});

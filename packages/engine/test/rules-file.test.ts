import {
  chmodSync,
  existsSync,
  readdirSync,
  statSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Memory } from '@mindly/core';
import {
  findSection,
  parseInstructions,
  removeSection,
  renderRulesSection,
  RULES_END,
  RULES_START,
  ruleLine,
  selfHealingOf,
  snapshotService,
  stripManagedSection,
  USER,
  writeSection,
} from '../src/index.js';
import { featureSetup } from './features/fixtures.js';
import { event, setup } from './helpers.js';

function rule(title: string, paths: string[] = [], id = title, body = ''): Memory {
  return { id, title, body, scope: { paths, branch: null } } as unknown as Memory;
}

function project() {
  const s = setup();
  const pid = s.mindly.store.projects.upsertByRoot(s.root, 'demo').id;
  const add = (title: string, extra: { scopePaths?: string[]; agent?: boolean } = {}): Memory =>
    s.mindly.memory.remember({
      projectId: pid,
      projectRoot: s.root,
      kind: 'rule',
      title,
      body: '',
      source: extra.agent ? { type: 'agent', sessionId: null, agentKind: 'codex' } : USER,
      ...(extra.scopePaths ? { scopePaths: extra.scopePaths } : {}),
    });
  const read = (rel: string): string => readFileSync(join(s.root, rel), 'utf8');
  return { ...s, pid, add, read, files: s.mindly.rulesFile };
}

const section = (text: string): string => {
  const b = findSection(text);
  if (b === null || b === 'damaged') throw new Error('no section');
  return text.slice(b.start, b.end);
};

describe('rules section rendering', () => {
  it('is deterministic: sorted rules, scoped groups after the general rules', () => {
    const rules = [
      rule('Validate every request body', ['src/api/**']),
      rule('use pnpm, never npm'),
      rule('Answer in British English'),
      rule('Keep handlers small', ['src/api/**']),
      rule('Write tests with vitest', ['test/**', 'src/**/*.test.ts']),
    ];
    const text = renderRulesSection(rules);
    expect(text).toBe(renderRulesSection([...rules].reverse()));
    expect(text.split('\n')).toEqual([
      RULES_START,
      '## Project rules',
      '',
      expect.stringContaining('Managed by Mindly'),
      '',
      '- Answer in British English',
      '- use pnpm, never npm',
      '',
      '### When working on `src/**/*.test.ts`, `test/**`',
      '',
      '- Write tests with vitest',
      '',
      '### When working on `src/api/**`',
      '',
      '- Keep handlers small',
      '- Validate every request body',
      '',
      RULES_END,
    ]);
  });

  it('says when there are no rules and cannot be ended early by a rule', () => {
    expect(renderRulesSection([])).toContain('_No approved rules yet._');
    const text = renderRulesSection([rule(`Never write ${RULES_END} or <!-- comments`)]);
    expect(findSection(text)).toEqual({ start: 0, end: text.length });
    expect(text).toContain('- Never write &lt;!-- mindly:rules:end --&gt; or &lt;!-- comments');
  });

  it('writes the body like agents see it, leaving out where the rule came from', () => {
    expect(
      ruleLine(rule('Use pnpm', [], 'a', 'The lockfile is pnpm-lock.yaml;\nnpm breaks it.')),
    ).toBe('- Use pnpm — The lockfile is pnpm-lock.yaml; npm breaks it.');
    expect(ruleLine(rule('Use pnpm', [], 'a', 'Imported from AGENTS.md, line 3.'))).toBe(
      '- Use pnpm',
    );
    expect(
      ruleLine(
        rule('Use pnpm', [], 'a', 'Stated by the user in a claude-code session: "use pnpm"'),
      ),
    ).toBe('- Use pnpm');
    const long = 'Always run the full test suite before pushing a branch that changes the store';
    expect(
      ruleLine(
        rule(`${long.slice(0, 30)}…`, [], 'a', `${long}\n\nImported from CLAUDE.md, line 9.`),
      ),
    ).toBe(`- ${long}`);
    expect(ruleLine(rule('Use pnpm', [], 'a', 'x'.repeat(400)))).toMatch(
      /^- Use pnpm — x{200,280}…?$/,
    );
    expect(ruleLine(rule('Close it', [], 'a', 'then write --> here'))).toBe(
      '- Close it — then write --&gt; here',
    );
  });

  it('uses the line endings of the file', () => {
    expect(renderRulesSection([rule('Use pnpm, never npm')], '\r\n')).toContain('\r\n- Use pnpm');
  });
});

describe('managed section editing', () => {
  const sec = renderRulesSection([rule('Use pnpm, never npm')]);

  it('appends after a blank line and removes back to the original bytes', () => {
    for (const original of [
      '# Notes\n\nKeep it short.\n',
      '# Notes\n\n\n',
      '\uFEFF# BOM\r\n',
      '',
    ]) {
      const added = writeSection(original, sec, null);
      expect(added.startsWith(original)).toBe(true);
      const bounds = findSection(added);
      expect(bounds).not.toBeNull();
      expect(removeSection(added, bounds as { start: number; end: number })).toBe(original);
    }
    expect(writeSection('no newline', sec, null)).toBe(`no newline\n\n${sec}\n`);
  });

  it('replaces the section in place and keeps every byte around it', () => {
    const before = 'Intro line  \r\n\r\n';
    const after = '\r\n\r\n## After\r\ntrailing\twhitespace \r\n';
    const text = `${before}${RULES_START}\r\n- old rule\r\n${RULES_END}${after}`;
    const next = writeSection(text, sec, findSection(text) as { start: number; end: number });
    expect(next).toBe(before + sec + after);
  });

  it('ignores markers in code blocks and refuses damaged markers', () => {
    const fenced = `# Docs\n\n\`\`\`md\n${RULES_START}\n${RULES_END}\n\`\`\`\n`;
    // Markers only inside code: not a section, and never safe to append another one.
    expect(findSection(fenced)).toBe('damaged');
    expect(findSection(`${fenced}\n${sec}\n`)).toEqual({
      start: fenced.length + 1,
      end: fenced.length + 1 + sec.length,
    });
    expect(findSection('# Plain notes\n')).toBeNull();
    expect(findSection(`${RULES_START}\n- a\n`)).toBe('damaged');
    expect(findSection(`${RULES_END}\n${RULES_START}\n`)).toBe('damaged');
    expect(findSection(`${RULES_START}\n${RULES_END}\n${RULES_START}\n${RULES_END}\n`)).toBe(
      'damaged',
    );
    expect(stripManagedSection(`a\n${sec}\nb\n`)).toBe('a\n\nb\n');
  });

  it('follows CommonMark fences: same character, closer at least as long, up to 3 spaces', () => {
    const at = (before: string): number => before.length;
    // A ```` block containing a ``` line is still open at the ``` line.
    const nested = '````md\n```\nexample\n```\n````\n\n';
    expect(findSection(nested + sec)).toEqual({ start: at(nested), end: at(nested) + sec.length });
    // ~~~ does not close a ``` fence, and a fence indented by up to 3 spaces counts.
    const mixed = '   ```\n~~~\n```\n\n';
    expect(findSection(mixed + sec)).toEqual({ start: at(mixed), end: at(mixed) + sec.length });
    // An unclosed fence runs to the end of the file: the markers after it are code.
    expect(findSection(`\`\`\`\nunclosed\n\n${sec}\n`)).toBe('damaged');
    // ``` with a backtick in its info string is inline code, not a fence.
    const inline = '``` a ` b\n\n';
    expect(findSection(inline + sec)).toEqual({ start: at(inline), end: at(inline) + sec.length });
    // Markers in an indented code block (4+ spaces) are not markers.
    const indented = `Example:\n\n    ${RULES_START}\n    ${RULES_END}\n\n`;
    expect(findSection(indented + sec)).toEqual({
      start: at(indented),
      end: at(indented) + sec.length,
    });
    expect(findSection(indented)).toBe('damaged');
  });
});

describe('rules file sync', () => {
  it('writes AGENTS.md when the project has no instruction file, and only approved rules', () => {
    const p = project();
    p.add('Use pnpm, never npm');
    p.add('Prefer tabs', { agent: true });
    expect(p.files.enabledFiles(p.pid, p.root)).toBeNull();
    expect(p.files.planSync(p.pid, p.root).map((c) => c.path)).toEqual(['AGENTS.md']);
    expect(existsSync(join(p.root, 'AGENTS.md'))).toBe(false);

    const changes = p.files.sync(p.pid, p.root);
    expect(changes[0]).toMatchObject({ path: 'AGENTS.md', previous: null, skipped: null });
    expect(p.read('AGENTS.md')).toBe(`${renderRulesSection(p.files.rules(p.pid))}\n`);
    expect(p.read('AGENTS.md')).toContain('- Use pnpm, never npm');
    expect(p.read('AGENTS.md')).not.toContain('Prefer tabs');
    expect(p.files.enabledFiles(p.pid, p.root)).toEqual(['AGENTS.md']);
  });

  it('uses the instruction files the project has and never touches the rest of them', () => {
    const p = project();
    const claude = '# Claude\r\n\r\n- Keep answers short.\r\n';
    const gemini = '# Gemini\n\nNo trailing newline';
    writeFileSync(join(p.root, 'CLAUDE.md'), claude);
    writeFileSync(join(p.root, 'GEMINI.md'), gemini);
    p.add('Use pnpm, never npm');
    p.files.sync(p.pid, p.root);
    expect(p.files.enabledFiles(p.pid, p.root)).toEqual(['CLAUDE.md', 'GEMINI.md']);
    expect(existsSync(join(p.root, 'AGENTS.md'))).toBe(false);
    const c = p.read('CLAUDE.md');
    expect(c.startsWith(`${claude}\r\n${RULES_START}\r\n`)).toBe(true);
    expect(c.endsWith(`${RULES_END}\r\n`)).toBe(true);
    expect(p.read('GEMINI.md').startsWith(`${gemini}\n\n${RULES_START}\n`)).toBe(true);

    const again = p.files.sync(p.pid, p.root);
    expect(again.every((x) => x.next === x.previous)).toBe(true);
    expect(p.read('CLAUDE.md')).toBe(c);

    p.files.remove(p.pid, p.root);
    expect(p.read('CLAUDE.md')).toBe(claude);
    expect(p.read('GEMINI.md')).toBe(gemini);
    expect(p.files.enabledFiles(p.pid, p.root)).toBeNull();
  });

  it('updates the files when rules are approved, edited, archived or deleted', () => {
    const p = project();
    const kept = p.add('Use pnpm, never npm');
    p.files.sync(p.pid, p.root);
    const proposed = p.add('Run the linter before every commit', { agent: true });
    expect(p.read('AGENTS.md')).not.toContain('Run the linter');
    p.mindly.memory.approve(proposed.id);
    expect(p.read('AGENTS.md')).toContain('- Run the linter before every commit');
    p.mindly.memory.update(kept.id, { title: 'Use pnpm only' }, USER, 'edited');
    expect(p.read('AGENTS.md')).toContain('- Use pnpm only');
    expect(p.read('AGENTS.md')).not.toContain('never npm');
    p.mindly.memory.update(kept.id, { scope: { paths: ['scripts/**'] } }, USER, 'scoped');
    expect(p.read('AGENTS.md')).toContain('### When working on `scripts/**`\n\n- Use pnpm only');
    p.mindly.memory.archive(kept.id);
    expect(p.read('AGENTS.md')).not.toContain('Use pnpm only');
    p.mindly.memory.forget(proposed.id);
    expect(p.read('AGENTS.md')).toContain('_No approved rules yet._');
  });

  it('does nothing while it is off', () => {
    const p = project();
    writeFileSync(join(p.root, 'AGENTS.md'), '# Agents\n');
    p.add('Use pnpm, never npm');
    expect(p.read('AGENTS.md')).toBe('# Agents\n');
    p.files.sync(p.pid, p.root);
    p.add('Never edit generated files');
    expect(section(p.read('AGENTS.md'))).toContain('- Never edit generated files');

    p.files.remove(p.pid, p.root);
    expect(p.read('AGENTS.md')).toBe('# Agents\n');
    p.add('Keep commits small and focused');
    expect(p.read('AGENTS.md')).toBe('# Agents\n');
  });

  it('deletes a file it created when removing leaves it empty', () => {
    const p = project();
    p.add('Use pnpm, never npm');
    p.files.sync(p.pid, p.root);
    p.files.remove(p.pid, p.root);
    expect(existsSync(join(p.root, 'AGENTS.md'))).toBe(false);

    p.files.sync(p.pid, p.root);
    unlinkSync(join(p.root, 'AGENTS.md'));
    p.add('Never edit generated files');
    expect(existsSync(join(p.root, 'AGENTS.md'))).toBe(false);
  });

  it('replaces hand edits inside the section and reports them', () => {
    const p = project();
    p.add('Use pnpm, never npm');
    p.files.sync(p.pid, p.root);
    const original = p.read('AGENTS.md');
    writeFileSync(
      join(p.root, 'AGENTS.md'),
      `# Mine\n\n${original.replace('- Use pnpm, never npm', '- Use yarn')}`,
    );
    const plan = p.files.planSync(p.pid, p.root);
    expect(plan[0]?.edited).toBe(true);
    const done = p.files.sync(p.pid, p.root);
    expect(done[0]?.edited).toBe(true);
    expect(p.read('AGENTS.md')).toBe(`# Mine\n\n${original}`);
    expect(p.files.planSync(p.pid, p.root)[0]?.edited).toBe(false);
  });

  it('writes through a symlink to its target once and keeps the link', () => {
    const p = project();
    writeFileSync(join(p.root, 'AGENTS.md'), '# Agents\n');
    symlinkSync('AGENTS.md', join(p.root, 'CLAUDE.md'));
    mkdirSync(join(p.root, 'docs'));
    writeFileSync(join(p.root, 'docs', 'gemini.md'), '# Gemini\n');
    symlinkSync(join('docs', 'gemini.md'), join(p.root, 'GEMINI.md'));
    p.add('Use pnpm, never npm');
    const changes = p.files.sync(p.pid, p.root);
    expect(changes.map((c) => [c.path, c.target, c.aliases])).toEqual([
      ['AGENTS.md', 'AGENTS.md', ['CLAUDE.md']],
      ['GEMINI.md', 'docs/gemini.md', []],
    ]);
    expect(lstatSync(join(p.root, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(p.root, 'CLAUDE.md'))).toBe('AGENTS.md');
    expect(lstatSync(join(p.root, 'GEMINI.md')).isSymbolicLink()).toBe(true);
    expect(p.read('docs/gemini.md')).toContain('- Use pnpm, never npm');
    expect(p.read('AGENTS.md').split(RULES_START)).toHaveLength(2);

    p.files.remove(p.pid, p.root);
    expect(lstatSync(join(p.root, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
    expect(p.read('AGENTS.md')).toBe('# Agents\n');
    expect(p.read('docs/gemini.md')).toBe('# Gemini\n');
  });

  it('leaves damaged markers, broken links and links leaving the project alone', () => {
    const p = project();
    const damaged = `# Agents\n${RULES_START}\n- half a section\n`;
    writeFileSync(join(p.root, 'AGENTS.md'), damaged);
    symlinkSync('missing.md', join(p.root, 'CLAUDE.md'));
    const outside = setup().root;
    writeFileSync(join(outside, 'elsewhere.md'), '# Elsewhere\n');
    symlinkSync(join(outside, 'elsewhere.md'), join(p.root, 'GEMINI.md'));
    p.add('Use pnpm, never npm');
    const changes = p.files.sync(p.pid, p.root);
    expect(changes.map((c) => [c.path, c.skipped])).toEqual([
      ['AGENTS.md', 'damaged'],
      ['CLAUDE.md', 'broken_link'],
      ['GEMINI.md', 'outside_project'],
    ]);
    expect(p.read('AGENTS.md')).toBe(damaged);
    expect(readFileSync(join(outside, 'elsewhere.md'), 'utf8')).toBe('# Elsewhere\n');
  });

  it('never adds a second section to a file with unbalanced or nested fences', () => {
    const p = project();
    p.add('Use pnpm, never npm');
    p.files.sync(p.pid, p.root);
    const synced = section(p.read('AGENTS.md'));
    const files: Record<string, string> = {
      // An unclosed fence before the section hides its markers.
      unclosed: `# Agents\n\n\`\`\`sh\npnpm test\n\n${synced}\n`,
      // A ``` line inside a ```` block toggled the old parser out of the fence.
      nested: `# Agents\n\n\`\`\`\`md\n\`\`\`\nexample\n\`\`\`\`\n\n${synced}\n`,
      // A start marker shown in indented code, then the real section.
      indented: `# Agents\n\n    ${RULES_START}\n\n${synced}\n`,
    };
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(p.root, 'AGENTS.md'), text);
      for (let i = 0; i < 3; i++) {
        p.files.sync(p.pid, p.root);
        p.add(`Rule number ${i} for the ${name} file`);
        p.files.refresh(p.pid);
      }
      const after = p.read('AGENTS.md');
      const starts = after.split('\n').filter((l) => l === RULES_START).length;
      expect(starts, name).toBeLessThanOrEqual(1);
      if (name === 'unclosed') {
        // The section cannot be recognised: the file is reported and left alone.
        expect(after, name).toBe(text);
        expect(p.files.planSync(p.pid, p.root)[0]?.skipped).toBe('damaged');
      } else {
        expect(section(after), name).toContain(`- Rule number 2 for the ${name} file`);
      }
    }
  });

  it('writes only rules the user approved explicitly, not ones auto-approved from a prompt', async () => {
    const p = project();
    writeFileSync(join(p.root, 'AGENTS.md'), '# Agents\n');
    p.add('Use pnpm, never npm');
    p.files.sync(p.pid, p.root);
    await p.mindly.hooks.handle(event(p.root, 'claude-code', 'cc', 'session_start'));
    await p.mindly.hooks.handle(
      event(p.root, 'claude-code', 'cc', 'prompt', {
        prompt: 'From now on always run the linter before every commit.',
      }),
    );
    const captured = p.mindly.memory
      .list(p.pid, { kinds: ['rule'] })
      .find((m) => m.tags.includes('say-it-once'));
    // Auto-approved for connected agents, but not committed to the repository.
    expect(captured?.trust).toBe('approved');
    expect(p.read('AGENTS.md')).not.toContain('linter');
    expect(p.files.rules(p.pid).map((m) => m.title)).toEqual(['Use pnpm, never npm']);
    expect(p.files.awaitingApproval(p.pid).map((m) => m.id)).toEqual([captured?.id]);

    // `mindly rules --approve`, Mission Control and an import confirmation all call approve().
    p.mindly.memory.approve(captured!.id);
    expect(section(p.read('AGENTS.md'))).toContain('linter before every commit');
    expect(p.files.awaitingApproval(p.pid)).toEqual([]);
  });

  it('does not add a section that would only say every rule is already in the file', () => {
    const p = project();
    const agents = '# Agents\n\n- Keep commits small and focused.\n';
    writeFileSync(join(p.root, 'AGENTS.md'), agents);
    const plan = p.mindly.rules.planImport(p.pid, p.root);
    p.mindly.rules.importRules(p.pid, p.root, plan.fresh, 'approved');
    const changes = p.files.sync(p.pid, p.root);
    expect(changes[0]).toMatchObject({ path: 'AGENTS.md', skipped: null, next: agents });
    expect(p.read('AGENTS.md')).toBe(agents);
    expect(p.files.enabledFiles(p.pid, p.root)).toEqual(['AGENTS.md']);

    // A rule from elsewhere adds the section; once it is gone again the section stays, with a note.
    const other = p.add('Use pnpm, never npm');
    expect(section(p.read('AGENTS.md'))).toContain('- Use pnpm, never npm');
    p.mindly.memory.archive(other.id);
    expect(section(p.read('AGENTS.md'))).toContain(
      '_Every approved rule is already written elsewhere in this file._',
    );
    p.files.remove(p.pid, p.root);
    expect(p.read('AGENTS.md')).toBe(agents);
  });

  it('is never imported back and is not evidence for the rules it lists', () => {
    const p = project();
    writeFileSync(join(p.root, 'AGENTS.md'), '# Agents\n\n- Keep commits small and focused.\n');
    const plan = p.mindly.rules.planImport(p.pid, p.root);
    p.mindly.rules.importRules(p.pid, p.root, plan.fresh, 'approved');
    p.add('Use pnpm, never npm');
    p.files.sync(p.pid, p.root);
    expect(section(p.read('AGENTS.md'))).toContain('- Use pnpm, never npm\n');

    const parsed = parseInstructions(p.read('AGENTS.md')).rules.map((r) => r.title);
    expect(parsed).toEqual(['Keep commits small and focused']);
    expect(p.mindly.rules.planImport(p.pid, p.root).fresh).toEqual([]);
    const evidence = { path: 'AGENTS.md', excerpt: '- Use pnpm, never npm' };
    expect(p.mindly.memory.checkEvidence(p.root, evidence).valid).toBe(false);
  });

  it('leaves imported rules in the file they came from, so removing one only drops that rule', async () => {
    const { root, mindly, pid } = await featureSetup();
    const agents = '# Agents\n\n- Use pnpm, never npm or yarn\n- Keep commits small and focused\n';
    writeFileSync(join(root, 'AGENTS.md'), agents);
    writeFileSync(join(root, 'GEMINI.md'), '# Gemini\n');
    const plan = mindly.rules.planImport(pid, root);
    mindly.rules.importRules(pid, root, plan.fresh, 'approved');
    mindly.rulesFile.sync(pid, root);
    const read = (f: string): string => readFileSync(join(root, f), 'utf8');
    // Every rule is already in AGENTS.md: no section there yet.
    expect(read('AGENTS.md')).toBe(agents);
    expect(section(read('GEMINI.md'))).toContain('- Use pnpm, never npm or yarn\n');

    mindly.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'rule',
      title: 'Answer in British English',
      body: '',
      source: USER,
    });
    expect(section(read('AGENTS.md'))).toContain('- Answer in British English');
    expect(section(read('AGENTS.md'))).not.toContain('pnpm');

    // The user deletes one original line: only that rule goes stale and leaves the other files.
    writeFileSync(
      join(root, 'AGENTS.md'),
      read('AGENTS.md').replace('- Use pnpm, never npm or yarn\n', ''),
    );
    selfHealingOf(mindly).sweep(pid);
    const titles = (trust: 'approved' | 'stale'): string[] =>
      mindly.memory
        .list(pid, { kinds: ['rule'], trust: [trust] })
        .map((m) => m.title)
        .sort();
    expect(titles('stale')).toEqual(['Use pnpm, never npm or yarn']);
    expect(titles('approved')).toEqual([
      'Answer in British English',
      'Keep commits small and focused',
    ]);
    expect(section(read('GEMINI.md'))).not.toContain('pnpm');
    expect(section(read('GEMINI.md'))).toContain('- Keep commits small and focused\n');
    expect(read('AGENTS.md')).toContain('- Keep commits small and focused\n');
  });

  it('writes atomically, keeps the mode and leaves the file alone when a write fails', () => {
    const p = project();
    writeFileSync(join(p.root, 'AGENTS.md'), '# Agents\n');
    chmodSync(join(p.root, 'AGENTS.md'), 0o640);
    const inode = statSync(join(p.root, 'AGENTS.md')).ino;
    p.add('Use pnpm, never npm');
    p.files.sync(p.pid, p.root);
    const st = statSync(join(p.root, 'AGENTS.md'));
    expect(st.ino).not.toBe(inode);
    expect(st.mode & 0o777).toBe(0o640);
    expect(readdirSync(p.root).filter((f) => f.endsWith('.tmp'))).toEqual([]);

    const before = p.read('AGENTS.md');
    chmodSync(p.root, 0o555);
    try {
      p.add('Never edit generated files');
      const r = p.files.sync(p.pid, p.root);
      expect(r[0]?.skipped).toBe('unwritable');
    } finally {
      chmodSync(p.root, 0o755);
    }
    expect(p.read('AGENTS.md')).toBe(before);
    expect(readdirSync(p.root).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    p.add('Keep commits small and focused');
    expect(p.read('AGENTS.md')).toContain('- Never edit generated files');
  });

  it('keeps each checkout (linked worktree) separately and refreshes every one', () => {
    const p = project();
    const worktree = setup().root;
    writeFileSync(join(worktree, 'AGENTS.md'), '# Worktree\n');
    p.add('Use pnpm, never npm');
    p.files.sync(p.pid, worktree);
    expect(existsSync(join(p.root, 'AGENTS.md'))).toBe(false);
    expect(p.files.enabledFiles(p.pid, p.root)).toBeNull();
    expect(p.files.enabledCheckouts()).toEqual([{ projectId: p.pid, root: worktree }]);

    p.files.sync(p.pid, p.root);
    p.add('Never edit generated files');
    for (const r of [p.root, worktree]) {
      expect(readFileSync(join(r, 'AGENTS.md'), 'utf8')).toContain('- Never edit generated files');
    }
    p.files.remove(p.pid, worktree);
    expect(readFileSync(join(worktree, 'AGENTS.md'), 'utf8')).toBe('# Worktree\n');
    expect(p.files.enabledCheckouts()).toEqual([{ projectId: p.pid, root: p.root }]);
    p.files.remove(p.pid, p.root);
    expect(p.files.enabledCheckouts()).toEqual([]);
  });

  it('imports text after a lone start marker', () => {
    const titles = parseInstructions(
      `# Rules\n\n${RULES_START}\n\n- Never commit secrets to the repo.\n`,
    ).rules.map((r) => r.title);
    expect(titles).toEqual(['Never commit secrets to the repo']);
  });

  it('writes once for a whole import and follows a snapshot restore', async () => {
    const p = project();
    p.files.sync(p.pid, p.root);
    writeFileSync(
      join(p.root, 'CLAUDE.md'),
      '- Keep commits small and focused.\n- Never edit generated files.\n',
    );
    const plan = p.mindly.rules.planImport(p.pid, p.root);
    let writes = 0;
    p.mindly.memory.onRulesChanged(() => writes++);
    p.mindly.rules.importRules(p.pid, p.root, plan.fresh, 'approved');
    expect(writes).toBe(1);
    expect(p.read('AGENTS.md')).toContain('- Never edit generated files');

    const snaps = snapshotService(p.mindly);
    const snap = await snaps.create(p.pid, 'before');
    p.add('Answer in British English');
    expect(p.read('AGENTS.md')).toContain('British English');
    await snaps.restore(snap.id);
    expect(p.read('AGENTS.md')).not.toContain('British English');
  });
});

describe('file ending inside an unclosed code block', () => {
  it('is never appended to, so the section cannot land inside the code block', async () => {
    const { findSection } = await import('../src/memory/managed-section.js');
    expect(findSection('# Notes\n\n```js\nunclosed fence\n')).toBe('damaged');
    expect(findSection('# Notes\n\n```js\nclosed\n```\n')).toBeNull();
    expect(findSection('~~~~\ninner ~~~\n')).toBe('damaged');
  });
});

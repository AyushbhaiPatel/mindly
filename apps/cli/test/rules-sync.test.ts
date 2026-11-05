import { existsSync, lstatSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cli, git, sandbox, tempDir, write, type Sandbox } from './helpers.js';

const START = '<!-- mindly:rules:start -->';
const END = '<!-- mindly:rules:end -->';

function read(sb: Sandbox, rel: string): string {
  return readFileSync(join(sb.repo, rel), 'utf8');
}

async function addRule(sb: Sandbox, title: string, ...extra: string[]): Promise<void> {
  expect(
    (await cli(sb, ['memory', 'add', '--kind', 'rule', '--title', title, ...extra])).code,
  ).toBe(0);
}

describe('rules sync', () => {
  it('previews, asks before turning on, then keeps the files updated', async () => {
    const sb = sandbox();
    write(sb.repo, 'CLAUDE.md', '# Claude\n\n- Keep answers short.\n');
    await addRule(sb, 'Use pnpm, never npm');
    await addRule(sb, 'Validate request bodies', '--scope', 'src/api/**');

    const dry = await cli(sb, ['rules', 'sync', '--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain('Writing 2 approved rules into your agent instruction files');
    expect(dry.stdout).toMatch(/CLAUDE\.md \(modified, \+\d+ -0 lines\)/);
    expect(dry.stdout).toContain('+ - Use pnpm, never npm');
    expect(dry.stdout).toContain('Dry run: nothing was written.');
    expect(read(sb, 'CLAUDE.md')).toBe('# Claude\n\n- Keep answers short.\n');

    const noTty = await cli(sb, ['rules', 'sync']);
    expect(noTty.code).toBe(1);
    expect(noTty.stdout).toContain('Nothing changed.');
    const declined = await cli(sb, ['rules', 'sync'], { answers: ['n'] });
    expect(declined.code).toBe(1);
    expect(read(sb, 'CLAUDE.md')).not.toContain(START);

    const on = await cli(sb, ['rules', 'sync'], { answers: ['y'] });
    expect(on.code).toBe(0);
    expect(on.stdout).toContain('Updated 1 file.');
    expect(on.stdout).toContain('mindly rules sync --off');
    const text = read(sb, 'CLAUDE.md');
    expect(text.startsWith('# Claude\n\n- Keep answers short.\n\n' + START + '\n')).toBe(true);
    expect(text).toContain('- Use pnpm, never npm\n');
    expect(text).toContain('### When working on `src/api/**`\n\n- Validate request bodies\n');
    expect(existsSync(join(sb.repo, 'AGENTS.md'))).toBe(false);

    const same = await cli(sb, ['rules', 'sync']);
    expect(same.code).toBe(0);
    expect(same.stdout).toContain('CLAUDE.md (up to date)');
    expect(same.stdout).toContain('Everything is up to date.');
    expect(read(sb, 'CLAUDE.md')).toBe(text);

    await addRule(sb, 'Never edit generated files');
    expect(read(sb, 'CLAUDE.md')).toContain('- Never edit generated files\n');
    const id = JSON.parse((await cli(sb, ['rules', '--json'])).stdout).approved.find(
      (m: { title: string }) => m.title === 'Use pnpm, never npm',
    ).id as string;
    expect((await cli(sb, ['memory', 'archive', id])).code).toBe(0);
    expect(read(sb, 'CLAUDE.md')).not.toContain('Use pnpm');

    const off = await cli(sb, ['rules', 'sync', '--off', '--yes']);
    expect(off.code).toBe(0);
    expect(off.stdout).toContain('Rules sync is off.');
    expect(read(sb, 'CLAUDE.md')).toBe('# Claude\n\n- Keep answers short.\n');
    await addRule(sb, 'Keep commits small and focused');
    expect(read(sb, 'CLAUDE.md')).toBe('# Claude\n\n- Keep answers short.\n');
  });

  it('warns about hand edits inside the section and replaces them', async () => {
    const sb = sandbox();
    await addRule(sb, 'Use pnpm, never npm');
    expect((await cli(sb, ['rules', 'sync', '--yes'])).code).toBe(0);
    const synced = read(sb, 'AGENTS.md');
    write(sb.repo, 'AGENTS.md', '# Mine\n\n' + synced.replace('never npm', 'or yarn'));
    const r = await cli(sb, ['rules', 'sync']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('The Mindly section was edited by hand; those edits are replaced.');
    expect(r.stdout).toContain('Replaced hand edits in the Mindly section of AGENTS.md.');
    expect(read(sb, 'AGENTS.md')).toBe('# Mine\n\n' + synced);
  });

  it('reports files it cannot write', async () => {
    const sb = sandbox();
    write(sb.repo, 'AGENTS.md', START + '\n- half\n');
    await addRule(sb, 'Use pnpm, never npm');
    const r = await cli(sb, ['rules', 'sync', '--yes']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      'its Mindly markers are incomplete, repeated or inside a code block',
    );
    expect(read(sb, 'AGENTS.md')).toBe(START + '\n- half\n');
  });

  it('init offers it on a terminal only, after the rules are imported', async () => {
    const sb = sandbox();
    write(sb.repo, 'AGENTS.md', '# Agents\n\n- Run the linter before every commit.\n');
    symlinkSync('AGENTS.md', join(sb.repo, 'CLAUDE.md'));
    const scripted = sandbox();
    write(scripted.repo, 'AGENTS.md', '- Run the linter before every commit.\n');
    await addRule(scripted, 'Use pnpm, never npm');
    const yesFlag = await cli(scripted, ['init', '--yes']);
    expect(yesFlag.code).toBe(0);
    expect(yesFlag.stdout).not.toContain('Rules in your agent instruction files');
    expect(read(scripted, 'AGENTS.md')).not.toContain(START);

    const no = await cli(sb, ['init'], { answers: ['y', 'n'] });
    expect(no.stdout).toContain('Imported 1 rule.');
    expect(no.stdout).toContain('Rules in your agent instruction files');
    expect(no.stdout).toContain('mindly rules sync');
    expect(read(sb, 'AGENTS.md')).not.toContain(START);

    const yes = await cli(sb, ['init'], { answers: ['y'] });
    expect(yes.code).toBe(0);
    // The only rule came from AGENTS.md, so there is nothing to add: no near-empty section.
    expect(yes.stdout).toContain('Rules sync is on. AGENTS.md already states every approved rule');
    expect(lstatSync(join(sb.repo, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
    expect(read(sb, 'AGENTS.md')).toBe('# Agents\n\n- Run the linter before every commit.\n');
    await addRule(sb, 'Use pnpm, never npm');
    const text = read(sb, 'AGENTS.md');
    expect(text.split(START)).toHaveLength(2);
    expect(text).toContain('- Use pnpm, never npm\n\n' + END);
    // The imported rule is not repeated in the section.
    expect(text.match(/Run the linter/g)).toHaveLength(1);

    // Re-importing the file finds nothing new: the section is Mindly's own.
    const again = await cli(sb, ['rules', 'import', '--dry-run']);
    expect(again.stdout).toContain('Nothing new to import.');

    const kept = await cli(sb, ['init'], { answers: [] });
    expect(kept.stdout).not.toContain('Rules in your agent instruction files');
  });

  it('uninstall removes the section everywhere, worktrees included, and turns sync off', async () => {
    const sb = sandbox();
    write(sb.repo, 'GEMINI.md', '# Gemini');
    await addRule(sb, 'Use pnpm, never npm');
    expect((await cli(sb, ['rules', 'sync', '--yes'])).code).toBe(0);
    expect(read(sb, 'GEMINI.md')).toContain(START);

    const linked = join(tempDir('mindly-cli-wt-'), 'linked');
    git(sb.repo, 'worktree', 'add', '-q', linked);
    write(linked, 'AGENTS.md', '# Linked\n');
    const wt = await cli(sb, ['rules', 'sync', '--yes'], { cwd: linked });
    expect(wt.code).toBe(0);
    expect(wt.stdout.replace(/\s+/g, ' ')).toContain(`In this worktree: ${realpathSync(linked)}`);
    expect(readFileSync(join(linked, 'AGENTS.md'), 'utf8')).toContain('- Use pnpm, never npm');
    expect(existsSync(join(sb.repo, 'AGENTS.md'))).toBe(false);
    await addRule(sb, 'Never edit generated files');
    expect(readFileSync(join(linked, 'AGENTS.md'), 'utf8')).toContain(
      '- Never edit generated files',
    );

    const partial = await cli(sb, ['uninstall', '--agents', 'codex', '--dry-run']);
    expect(partial.stdout).not.toContain('Rules in agent instruction files');
    const elsewhere = tempDir('mindly-cli-elsewhere-');
    const dry = await cli(sb, ['uninstall', '--dry-run'], { cwd: elsewhere });
    expect(dry.stdout).toContain('Rules in agent instruction files');
    expect(dry.stdout).toMatch(/GEMINI\.md \(modified, \+0 -\d+ lines\)/);
    expect(dry.stdout).toMatch(/AGENTS\.md \(modified, \+0 -\d+ lines\)/);
    expect(read(sb, 'GEMINI.md')).toContain(START);

    const r = await cli(sb, ['uninstall', '--yes'], { cwd: linked });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Wrote ${join(sb.repo, 'GEMINI.md')}`);
    expect(r.stdout).toContain("Removed Mindly's rules section");
    expect(read(sb, 'GEMINI.md')).toBe('# Gemini');
    expect(readFileSync(join(linked, 'AGENTS.md'), 'utf8')).toBe('# Linked\n');
    await addRule(sb, 'Keep commits small and focused');
    expect(read(sb, 'GEMINI.md')).toBe('# Gemini');
    expect((await cli(sb, ['uninstall', '--dry-run'])).stdout).not.toContain('Rules in agent');
  });
});

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  EMPTY_HOOK_RESULT,
  globsMayOverlap,
  globToRegExp,
  isDeniedPath,
  matchesAnyGlob,
  redactText,
  fingerprint,
  sanitizeLine,
  toPosix,
  tryResolveInsideRoot,
  type HookResult,
  type Memory,
  type Save,
  type SaveKind,
  type NormalizedHookEvent,
  type Session,
} from '@mindly/core';
import type { ContextBuilder } from '../context/builder.js';
import { readBounded } from '../memory/service.js';
import { memoryLine, renderSections } from '../context/render.js';
import type { IntentService } from '../coordination/work.js';
import type { TelepathyService } from '../coordination/telepathy.js';
import { LIVE_WINDOW_MS, type ChangedFile, type EngineBus, type Kernel } from '../kernel.js';
import type { CheckpointService } from '../features/checkpoints.js';
import { commandKey, type MistakeService } from '../memory/mistakes.js';
import {
  normalizeCommandLine,
  pathNamer,
  shellMayWrite,
  shellMayWriteFiles,
  shellWriteTargets,
} from './shell.js';
import type { RuleService } from '../memory/rules.js';
import type { ProjectContext, ProjectService } from '../projects.js';

const MAX_PROMPT_STORED = 4000;

/** Paths of one tool call that are checked against rules and guards (adapters report up to 500). */
const MAX_CHECKED_PATHS = 500;
/** Paths of one tool call whose change is recorded (provenance, checkpoint, impact). */
const MAX_RECORDED_PATHS = 50;
/**
 * Entries looked at when a directory or wildcard a shell command writes is listed. A listing that
 * stops here is incomplete, and an incomplete listing never clears the command.
 */
const MAX_TREE_ENTRIES = 2000;
/**
 * Places outside the session's working tree that one tool call may have looked up (one git call
 * each) to learn whether they are another working tree of the project. Paths in trees already
 * found cost nothing. A path that would need a lookup beyond this is not checked, and a call
 * with such a path is denied rather than let through unchecked.
 */
const MAX_TREE_LOOKUPS = 16;
/** Files of one shell command that are checked again (decisions, exports) after it ran. */
const MAX_SHELL_CHANGED = 20;

/** A path a tool is about to write, as rules and guards see it. */
interface CheckedPath {
  /** Relative to the working tree that holds it. */
  rel: string;
  abs: string;
  /**
   * Inside the session's own working tree and not on the deny-list: only such paths are recorded
   * or read. The others (deny-listed files, files in another working tree of the project) are
   * still matched against rules and guards by name, and nothing about them is stored.
   */
  own: boolean;
}

/** Where a path is: the working tree of the project that holds it. */
interface Located extends CheckedPath {
  /** Root of that working tree. */
  root: string;
}

/**
 * A whole directory or a wildcard pattern a shell command writes (`rm -r dir`, `rm dir/*.ts`),
 * inside a working tree of the project. It is judged by what it can match, not by a listing.
 */
interface WrittenScope {
  /** Glob relative to the tree root: `dir/**` for a directory, the pattern for a wildcard. */
  pattern: string;
  /** Directory that holds everything the pattern can match. */
  base: string;
  root: string;
  own: boolean;
  /** Files under `base` that match, listed at most once per hook call. */
  listing?: { files: string[]; complete: boolean };
}

/** What a tool call writes, as far as it could be placed in the project. */
interface Writes {
  paths: CheckedPath[];
  scopes: WrittenScope[];
  /** Paths that may be in the project but could not be placed (see {@link MAX_TREE_LOOKUPS}). */
  unchecked: number;
}

/** Other working trees of the project found while placing the paths of one tool call. */
interface TreeLookups {
  roots: string[];
  /** Directory looked up, to the project tree that holds it (null: not this project). */
  dirs: Map<string, string | null>;
}

/** Save kinds settled by what the helped agent does next (its later tool calls). */
const WATCHED_SAVE_KINDS: readonly SaveKind[] = [
  'overlap_avoided',
  'mistake_avoided',
  'rule_enforced',
];

/**
 * Fingerprint of a normalized, redacted shell command line: compares two runs without storing
 * either.
 */
export function commandLineFingerprint(command: string): string {
  return fingerprint('command-line', redactText(normalizeCommandLine(command)));
}

export interface HookDeps {
  projects: ProjectService;
  context: ContextBuilder;
  intents: IntentService;
  telepathy: TelepathyService;
  rules: RuleService;
  mistakes: MistakeService;
  checkpoints: CheckpointService;
  bus: EngineBus;
}

/** What a write guard says about the files a tool is about to change. */
export interface WriteGuardResult {
  /** Coordination warnings shown to the agent (mandatory context). */
  warnings: string[];
  /** When set, the tool call is denied with this reason (same path as user `enforce` rules). */
  deny: string | null;
}

/**
 * Consulted before a file-writing tool runs. Feature modules (e.g. split ownership) register
 * guards; `paths` are relative to the agent's working tree. `whole` are glob patterns (same
 * base) for directories and wildcards a shell command writes as a whole: a guard decides them by
 * what they can match, since the files they stand for are not listed. A guard that throws is
 * ignored.
 */
export type WriteGuard = (
  project: ProjectContext,
  session: Session,
  paths: readonly string[],
  whole: readonly string[],
) => WriteGuardResult | Promise<WriteGuardResult>;

/**
 * Translates normalised hook events into engine operations. `handle` never throws: any internal
 * failure is logged and an empty result returned, so a Mindly bug can never block an agent.
 */
export class HookHandler {
  private readonly guards: WriteGuard[] = [];

  constructor(
    private readonly k: Kernel,
    private readonly d: HookDeps,
  ) {}

  /** Registers a guard consulted before every file-writing tool call. */
  useWriteGuard(guard: WriteGuard): void {
    this.guards.push(guard);
  }

  private async consultGuards(
    project: ProjectContext,
    session: Session,
    paths: readonly string[],
    whole: readonly string[] = [],
  ): Promise<WriteGuardResult> {
    const out: WriteGuardResult = { warnings: [], deny: null };
    if (paths.length === 0 && whole.length === 0) return out;
    for (const guard of this.guards) {
      try {
        const r = await guard(project, session, paths, whole);
        out.warnings.push(...r.warnings);
        out.deny ??= r.deny;
      } catch (err) {
        this.k.logger.warn('write guard failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return out;
  }

  async handle(evt: NormalizedHookEvent): Promise<HookResult> {
    try {
      return await this.dispatch(evt);
    } catch (err) {
      this.k.logger.error('hook handling failed', {
        event: evt.event,
        agent: evt.agentKind,
        error: err instanceof Error ? err.message : String(err),
      });
      return EMPTY_HOOK_RESULT;
    }
  }

  private async dispatch(reported: NormalizedHookEvent): Promise<HookResult> {
    const evt = withUsableCwd(reported);
    const project = await this.d.projects.resolve(evt.cwd);
    const session = await this.session(project, evt);
    switch (evt.event) {
      case 'session_start':
        return this.sessionStart(project, session, evt);
      case 'prompt':
        return this.prompt(project, session, evt);
      case 'pre_tool':
        return this.preTool(project, session, evt);
      case 'post_tool':
        return this.postTool(project, session, evt);
      case 'stop':
        return this.stop(project, session, evt);
      case 'session_end':
        return this.sessionEnd(project, session);
    }
  }

  private async session(project: ProjectContext, evt: NormalizedHookEvent): Promise<Session> {
    const externalId = sanitizeLine(evt.externalSessionId, 200) || 'unknown';
    const existing = this.k.store.sessions.findByExternal(
      project.project.id,
      evt.agentKind,
      externalId,
    );
    // Only look up the branch when needed (it costs a git process).
    const branch =
      !existing || evt.event === 'session_start'
        ? await this.k.ports.git.currentBranch(evt.cwd)
        : null;
    const { session } = this.k.store.sessions.upsert({
      projectId: project.project.id,
      agentKind: evt.agentKind,
      externalId,
      worktree: evt.cwd,
      branch,
      transcriptPath: evt.transcriptPath,
    });
    return session;
  }

  private async sessionStart(
    project: ProjectContext,
    session: Session,
    evt: NormalizedHookEvent,
  ): Promise<HookResult> {
    this.k.store.sessions.endStale(project.project.id, LIVE_WINDOW_MS * 4);
    this.k.store.intents.expire();
    this.k.store.deliveries.expire();
    this.k.store.events.append({
      projectId: project.project.id,
      sessionId: session.id,
      type: 'session.started',
      payload: { agent: session.agentKind, source: evt.startSource, branch: session.branch },
    });
    // A full rescan: whatever changed since the last checkpoint happened outside any agent.
    await this.d.checkpoints.rescan(project, evt.cwd);
    await this.d.checkpoints.pruneIfDue(project.project.id);
    await this.d.bus.emit('session.started', {
      projectId: project.project.id,
      projectRoot: project.root,
      session,
      source: evt.startSource,
    });
    const built = this.d.context.sessionStart(project, session);
    return { ...EMPTY_HOOK_RESULT, context: built.text };
  }

  private async prompt(
    project: ProjectContext,
    session: Session,
    evt: NormalizedHookEvent,
  ): Promise<HookResult> {
    const raw = evt.prompt ?? '';
    this.d.telepathy.ackPreviousTurn(session);
    const redacted = redactText(raw, { extraPatterns: this.k.config.redaction.extraPatterns });
    this.k.store.events.append({
      projectId: project.project.id,
      sessionId: session.id,
      type: 'prompt.submitted',
      payload: {
        prompt: redacted.slice(0, MAX_PROMPT_STORED),
        summary: sanitizeLine(redacted, 160),
        length: raw.length,
      },
    });
    if (session.status !== 'active') this.k.store.sessions.setStatus(session.id, 'active');
    await this.d.checkpoints.rescan(project, evt.cwd);
    const rules = await this.d.rules.captureFromPrompt({
      projectId: project.project.id,
      projectRoot: project.root,
      session,
      prompt: raw,
    });
    const built = this.d.context.prompt(project, session, raw);
    const userMessage = rules.length
      ? `Mindly saved ${rules.length === 1 ? 'a project rule' : `${rules.length} project rules`} for all agents: ${rules.map((r) => r.title).join('; ')}`
      : null;
    return { ...EMPTY_HOOK_RESULT, context: built.text, userMessage };
  }

  /**
   * Places a path in the project: in the session's working tree, or in another working tree of
   * the same project (a split part's worktree, the main checkout), relative to the tree that holds
   * it, so its owner and the rules for it are found by the same name. Null when it is outside the
   * project; `'unknown'` when finding out would take one lookup too many.
   */
  private async locate(
    project: ProjectContext,
    treeRoot: string,
    abs: string,
    trees: TreeLookups | null,
  ): Promise<Located | 'unknown' | null> {
    const deny = this.k.config.redaction.denyPaths;
    const inTree = tryResolveInsideRoot(treeRoot, abs);
    if (inTree) return { ...inTree, root: treeRoot, own: !isDeniedPath(inTree.rel, deny) };
    if (trees === null) return null;
    for (const root of trees.roots) {
      const found = tryResolveInsideRoot(root, abs);
      if (found) return { ...found, root, own: false };
    }
    const dir = nearestDirectory(abs);
    if (dir === null) return null;
    let root = trees.dirs.get(dir);
    if (root === undefined) {
      if (trees.dirs.size >= MAX_TREE_LOOKUPS) return 'unknown';
      root = await this.projectTree(project, dir);
      trees.dirs.set(dir, root);
      if (root !== null && !trees.roots.includes(root)) trees.roots.push(root);
    }
    if (root === null) return null;
    const found = tryResolveInsideRoot(root, abs);
    return found ? { ...found, root, own: false } : null;
  }

  /** Root of the working tree holding `dir` when it is another tree of this project, else null. */
  private async projectTree(project: ProjectContext, dir: string): Promise<string | null> {
    const git = this.k.ports.git;
    try {
      const root = await git.findRepoRoot(dir);
      if (!root) return null;
      const main = git.projectRoot ? await git.projectRoot(dir) : root;
      return main === project.root ? root : null;
    } catch {
      return null;
    }
  }

  /**
   * Resolves agent-reported paths for the checks before a write (see `locate`). Anything outside
   * the project is dropped; paths that could not be placed are counted, never passed as fine.
   */
  private async checkedPaths(
    project: ProjectContext,
    cwd: string,
    paths: readonly string[],
    trees: TreeLookups | null = { roots: [], dirs: new Map() },
  ): Promise<{ paths: CheckedPath[]; unchecked: number }> {
    const treeRoot = (await this.k.ports.git.findRepoRoot(cwd)) ?? project.root;
    const out: CheckedPath[] = [];
    const seen = new Set<string>();
    let unchecked = 0;
    for (const p of paths.slice(0, MAX_CHECKED_PATHS)) {
      if (typeof p !== 'string' || p.length === 0 || p.length > 4096) continue;
      const found = await this.locate(
        project,
        treeRoot,
        isAbsolute(p) ? p : resolve(cwd, p),
        trees,
      );
      if (found === 'unknown') unchecked++;
      if (found === null || found === 'unknown' || found.rel === '' || seen.has(found.abs))
        continue;
      seen.add(found.abs);
      out.push({ rel: found.rel, abs: found.abs, own: found.own });
    }
    return { paths: out, unchecked };
  }

  /**
   * Agent-reported paths that may be recorded and read: inside the session's own working tree
   * (which may be a linked worktree of the project) and not on the deny-list. No other tree is
   * looked up.
   */
  private async projectPaths(
    project: ProjectContext,
    cwd: string,
    paths: readonly string[],
  ): Promise<{ rel: string; abs: string }[]> {
    return (await this.checkedPaths(project, cwd, paths, null)).paths
      .filter((p) => p.own)
      .map(({ rel, abs }) => ({ rel, abs }));
  }

  /**
   * What a shell command writes, read from its text and placed like the paths of an editing
   * tool. `certain` are writes the text shows; `possible` are paths given to a program that may
   * only read them. A directory written as a whole and a wildcard become a scope: nothing is
   * listed here, and nothing outside the project is ever read. With `ownTreeOnly` (after the
   * command ran) only files in the session's working tree are placed, without any lookup.
   */
  private async shellWrites(
    project: ProjectContext,
    cwd: string,
    command: string,
    ownTreeOnly = false,
  ): Promise<{ certain: Writes; possible: Writes }> {
    const certain: Writes = { paths: [], scopes: [], unchecked: 0 };
    const possible: Writes = { paths: [], scopes: [], unchecked: 0 };
    const targets = shellWriteTargets(command, { home: homedir() });
    if (targets.length === 0) return { certain, possible };
    const treeRoot = (await this.k.ports.git.findRepoRoot(cwd)) ?? project.root;
    const trees: TreeLookups | null = ownTreeOnly ? null : { roots: [], dirs: new Map() };
    const seen = new Set<string>();
    for (const t of targets) {
      const into = t.certain ? certain : possible;
      const place = async (abs: string): Promise<Located | null> => {
        const found = await this.locate(project, treeRoot, abs, trees);
        if (found === 'unknown') into.unchecked++;
        return found === 'unknown' ? null : found;
      };
      const file = (at: Located | null): void => {
        if (at === null || at.rel === '' || seen.has(`${t.certain}:${at.abs}`)) return;
        seen.add(`${t.certain}:${at.abs}`);
        into.paths.push({ rel: at.rel, abs: at.abs, own: at.own });
      };
      const scope = (at: Located, pattern: string): void => {
        into.scopes.push({ pattern, base: at.abs, root: at.root, own: at.own });
      };
      const path = isAbsolute(t.path) ? t.path : resolve(cwd, placeHome(t.path));
      if (t.glob) {
        // Everything the pattern can match is under the directory before its first wildcard.
        const segments = toPosix(path).split('/');
        const wild = segments.findIndex((x) => /[*?{]/.test(x));
        const at = await place(segments.slice(0, wild).join('/') || '/');
        if (at === null) continue;
        const pattern = [...(at.rel === '' ? [] : [at.rel]), ...segments.slice(wild)].join('/');
        scope(at, pattern);
        if (t.tree) scope(at, `${pattern}/**`);
      } else if (t.tree) {
        const at = await place(path);
        if (at === null) continue;
        file(at);
        scope(at, at.rel === '' ? '**' : `${at.rel}/**`);
      } else if (t.entries.length > 0 && isDirectory(path)) {
        for (const name of t.entries) file(await place(join(path, name)));
      } else {
        file(await place(path));
      }
    }
    // What the text shows as written is not also reported as a mere possibility.
    const sure = new Set(certain.paths.map((p) => p.abs));
    possible.paths = possible.paths.filter((p) => !sure.has(p.abs));
    return { certain, possible };
  }

  /**
   * The rule the user marked as enforced that covers one of the written `paths` or can cover
   * something in one of the written `scopes`, with what it covers (for the message).
   */
  private enforcedRule(
    projectId: string,
    paths: readonly string[],
    scopes: readonly WrittenScope[] = [],
  ): { rule: Memory; covers: string[] } | null {
    if (paths.length === 0 && scopes.length === 0) return null;
    const rules = this.k.store.memories
      .list(projectId, { kinds: ['rule'], trust: ['approved', 'verified'], limit: 300 })
      .filter((m) => m.enforce && m.source.type === 'user' && m.scope.paths.length > 0);
    for (const rule of rules) {
      const covers = [
        ...paths.filter((p) => matchesAnyGlob(p, rule.scope.paths)),
        ...scopes.flatMap((s) => scopeCovered(s, rule.scope.paths)),
      ];
      if (covers.length > 0) return { rule, covers };
    }
    return null;
  }

  private ruleDenial(
    hit: { rule: Memory; covers: readonly string[] },
    context: string | null,
  ): HookResult {
    return {
      ...EMPTY_HOOK_RESULT,
      decision: 'deny',
      reason: `Blocked by a project rule the user marked as enforced: "${hit.rule.title}". Ask the user before changing ${hit.covers
        .slice(0, 20)
        .map((x) => sanitizeLine(x, 160))
        .join(', ')}.`,
      context,
    };
  }

  private async preTool(
    project: ProjectContext,
    session: Session,
    evt: NormalizedHookEvent,
  ): Promise<HookResult> {
    const tool = evt.tool;
    if (!tool) return EMPTY_HOOK_RESULT;
    const pid = project.project.id;
    // Saves of this session still waiting for evidence: while there are any, every tool call is
    // recorded (without its content), because what the agent does next is that evidence.
    const pending = this.k.store.saves.caughtFor(pid, session.id, WATCHED_SAVE_KINDS);
    const toolName = sanitizeLine(tool.name, 40);
    if (tool.writes && tool.edits.length > 0) {
      const { paths: checked, unchecked } = await this.checkedPaths(
        project,
        evt.cwd,
        tool.edits.map((e) => e.path),
      );
      if (unchecked > 0) return uncheckedDenial(unchecked);
      if (checked.length === 0) {
        if (pending.length > 0)
          this.appendToolEvent(pid, session, 'tool.before', { tool: toolName });
        return EMPTY_HOOK_RESULT;
      }
      const paths = checked.filter((p) => p.own).map((p) => p.rel);
      // Deny-listed files and files in another working tree: checked by name, never recorded.
      const unrecorded = checked.filter((p) => !p.own).map((p) => p.rel);
      const overlap = this.d.intents.noteEditing(session, paths);
      const guard = await this.consultGuards(project, session, paths);
      const built =
        paths.length > 0
          ? this.d.context.preWrite(project, session, paths, [
              ...overlap.warnings,
              ...guard.warnings,
            ])
          : null;
      const outside =
        unrecorded.length > 0
          ? await this.consultGuards(project, session, unrecorded)
          : { warnings: [], deny: null };
      const all = [...paths, ...unrecorded];
      const rule = built?.deny
        ? { rule: built.deny, covers: coveredBy(built.deny, all) }
        : this.enforcedRule(pid, unrecorded);
      if (overlap.overlaps.length > 0 || rule || pending.length > 0) {
        // What Mindly told the agent before this write: the evidence of overlap and rule saves.
        this.appendToolEvent(pid, session, 'tool.before', {
          tool: toolName,
          ...(paths.length > 0 ? { paths } : {}),
          overlaps: overlap.overlaps,
          deniedBy: rule?.rule.id ?? null,
        });
      }
      const context = joinContext(
        built?.text ?? null,
        renderSections([
          { heading: 'Coordination warning', lines: outside.warnings.map((w) => `- ${w}`) },
        ]),
      );
      if (rule) return this.ruleDenial(rule, context);
      const denied = guard.deny ?? outside.deny;
      if (denied) return { ...EMPTY_HOOK_RESULT, decision: 'deny', reason: denied, context };
      return { ...EMPTY_HOOK_RESULT, context };
    }
    if (tool.shell && tool.command) {
      const mistakes = this.d.mistakes.forCommand(pid, tool.command);
      // A command that writes a file (sed -i, cat > file, mv, rm) answers to the same rules and
      // guards as an editing tool, for the files its text shows it writes. A path that is only
      // handed to a program Mindly does not know may just be read: that is a warning, not a block.
      const { certain, possible } = await this.shellWrites(project, evt.cwd, tool.command);
      if (certain.unchecked > 0) return uncheckedDenial(certain.unchecked);
      const written = certain.paths.map((p) => p.rel);
      const named = possible.paths.map((p) => p.rel);
      const patterns = (w: Writes): string[] => w.scopes.map((x) => x.pattern);
      const guard = await this.consultGuards(project, session, written, patterns(certain));
      const soft = await this.consultGuards(project, session, named, patterns(possible));
      const rule = this.enforcedRule(pid, written, certain.scopes);
      const softRule = rule ? null : this.enforcedRule(pid, named, possible.scopes);
      if (mistakes.length > 0 || pending.length > 0 || rule) {
        const recorded = certain.paths.filter((p) => p.own).map((p) => p.rel);
        this.appendToolEvent(pid, session, 'tool.before', {
          tool: toolName,
          ...this.shellFacts(tool.command, pending),
          ...(mistakes.length > 0 ? { mistakes: mistakes.map((m) => m.id) } : {}),
          ...(rule ? { deniedBy: rule.rule.id, paths: recorded.slice(0, 50) } : {}),
        });
      }
      const warnings = [...guard.warnings, ...soft.warnings];
      if (softRule) {
        warnings.push(
          `This command names ${softRule.covers
            .slice(0, 5)
            .map((x) => sanitizeLine(x, 160))
            .join(
              ', ',
            )}, covered by a project rule the user marked as enforced: "${softRule.rule.title}". Do not change it without asking the user.`,
        );
      }
      if (possible.unchecked > 0) {
        warnings.push(
          `${possible.unchecked} of the paths this command names lie outside this working tree and were not checked against the project's rules.`,
        );
      }
      const sections = [
        ...(mistakes.length > 0
          ? [
              {
                heading: 'A similar command failed before in this project',
                lines: mistakes.map((m) => memoryLine(m)),
              },
            ]
          : []),
        ...(warnings.length > 0
          ? [{ heading: 'Coordination warning', lines: warnings.map((w) => `- ${w}`) }]
          : []),
      ];
      const context = sections.length > 0 ? renderSections(sections) : null;
      if (rule) return this.ruleDenial(rule, context);
      if (guard.deny)
        return { ...EMPTY_HOOK_RESULT, decision: 'deny', reason: guard.deny, context };
      return context === null ? EMPTY_HOOK_RESULT : { ...EMPTY_HOOK_RESULT, context };
    }
    if (pending.length > 0) this.appendToolEvent(pid, session, 'tool.before', { tool: toolName });
    return EMPTY_HOOK_RESULT;
  }

  private async postTool(
    project: ProjectContext,
    session: Session,
    evt: NormalizedHookEvent,
  ): Promise<HookResult> {
    const tool = evt.tool;
    if (!tool) return EMPTY_HOOK_RESULT;
    this.k.store.sessions.touch(session.id);
    // Only sessions with a save waiting for evidence record their tool calls: one indexed query,
    // no memory lookups (whether a warned command ran again is told by the pending save itself).
    const pending = this.k.store.saves.caughtFor(
      project.project.id,
      session.id,
      WATCHED_SAVE_KINDS,
    );
    if (pending.length > 0) {
      const paths =
        tool.writes && tool.edits.length > 0
          ? (
              await this.projectPaths(
                project,
                evt.cwd,
                tool.edits.map((e) => e.path),
              )
            ).map((p) => p.rel)
          : [];
      this.appendToolEvent(project.project.id, session, 'tool.after', {
        tool: sanitizeLine(tool.name, 40),
        ...(paths.length > 0 ? { paths } : {}),
        ...(tool.shell && tool.command ? this.shellFacts(tool.command, pending) : {}),
        failed: tool.failed,
      });
    }
    // A shell command that may have written files: whatever changed goes into a step no agent
    // edit explains. A shell tool that reports its own edits (a patch) is handled as an edit.
    // The files it changed are checked like any other edit (decisions, exports), credited to the
    // session that ran the command.
    if (tool.shell && tool.command && !tool.writes && shellMayWriteFiles(tool.command)) {
      const step = await this.d.checkpoints.rescan(project, evt.cwd);
      await this.afterShellWrite(project, session, evt.cwd, tool.command, step?.paths ?? []);
    }
    if (tool.shell && tool.failed && tool.command) {
      this.d.mistakes.recordFailedCommand({
        projectId: project.project.id,
        projectRoot: project.root,
        session,
        command: tool.command,
        output: tool.outputExcerpt,
      });
      return EMPTY_HOOK_RESULT;
    }
    if (!tool.writes || tool.failed || tool.edits.length === 0) return EMPTY_HOOK_RESULT;

    const promptEvent = this.k.store.events.query(project.project.id, {
      sessionId: session.id,
      types: ['prompt.submitted'],
      order: 'desc',
      limit: 1,
    })[0];
    const changed: ChangedFile[] = [];
    let firstChangeId: string | null = null;
    for (const edit of tool.edits.slice(0, MAX_RECORDED_PATHS)) {
      const [resolved] = await this.projectPaths(project, evt.cwd, [edit.path]);
      if (!resolved) continue;
      const content = readBounded(resolved.abs, MAX_PROVENANCE_FILE_BYTES);
      const hashes = this.provenanceHashes(content, edit.addedText);
      const recorded = this.k.store.fileChanges.record({
        projectId: project.project.id,
        sessionId: session.id,
        path: resolved.rel,
        tool: sanitizeLine(tool.name, 40),
        hunkHashes: hashes,
        lineHashes: this.addedLineHashes(content, edit.addedText, edit.removedText),
        addedLines: countLines(edit.addedText),
        removedLines: countLines(edit.removedText),
        promptEventId: promptEvent?.id ?? null,
      });
      firstChangeId ??= recorded.id;
      changed.push({
        path: resolved.rel,
        abs: resolved.abs,
        addedText: edit.addedText,
        removedText: edit.removedText,
        wholeFile: edit.wholeFile,
      });
    }
    if (changed.length === 0) return EMPTY_HOOK_RESULT;
    this.k.store.events.append({
      projectId: project.project.id,
      sessionId: session.id,
      type: 'file.changed',
      payload: { paths: changed.map((c) => c.path), tool: tool.name },
    });
    // The checkpoint of this edit: the tree after it, holding only the paths the tool touched.
    await this.d.checkpoints.afterEdit(project, session, evt.cwd, {
      paths: changed.map((c) => c.path),
      tool: tool.name,
      fileChangeId: firstChangeId,
      promptEventId: promptEvent?.id ?? null,
    });
    for (const c of changed) this.d.intents.checkRecentEditors(session, c.path);
    await this.d.bus.emit('files.changed', {
      projectId: project.project.id,
      projectRoot: project.root,
      session,
      files: changed,
    });
    return EMPTY_HOOK_RESULT;
  }

  /**
   * After a shell command that may have written files: the files it wrote go through the same
   * checks as an edit made with a tool. They are the write targets its text shows, and the paths
   * of the rescan step that the command names (a file, or a directory above it). Nothing is
   * recorded as an agent edit: the command's changes stay a step no edit explains.
   */
  private async afterShellWrite(
    project: ProjectContext,
    session: Session,
    cwd: string,
    command: string,
    stepPaths: readonly string[],
  ): Promise<void> {
    try {
      const files = new Map<string, ChangedFile>();
      const add = (rel: string, abs: string): void => {
        if (files.size < MAX_SHELL_CHANGED && !files.has(rel)) {
          files.set(rel, { path: rel, abs, addedText: '', removedText: '', wholeFile: true });
        }
      };
      // Only what is cheap to know again after the command: the files it names outright in this
      // working tree. Directories and wildcards are covered by the paths of the rescan step.
      const { certain } = await this.shellWrites(project, cwd, command, true);
      for (const p of certain.paths) if (p.own && !isDirectory(p.abs)) add(p.rel, p.abs);
      if (stepPaths.length > 0 && files.size < MAX_SHELL_CHANGED) {
        const names = pathNamer(command);
        const named = stepPaths.filter((p) => names(p)).slice(0, MAX_SHELL_CHANGED);
        if (named.length > 0) {
          const treeRoot = (await this.k.ports.git.findRepoRoot(cwd)) ?? project.root;
          for (const p of await this.projectPaths(project, treeRoot, named)) add(p.rel, p.abs);
        }
      }
      if (files.size === 0) return;
      await this.d.bus.emit('files.changed', {
        projectId: project.project.id,
        projectRoot: project.root,
        session,
        files: [...files.values()],
      });
    } catch (err) {
      this.k.logger.warn('shell write not followed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private appendToolEvent(
    projectId: string,
    session: Session,
    type: 'tool.before' | 'tool.after',
    payload: Record<string, unknown>,
  ): void {
    this.k.store.events.append({ projectId, sessionId: session.id, type, payload });
  }

  /**
   * What saves need to know about a shell command, without storing it: its redacted key, a
   * fingerprint of its normalized command line, whether it is the command of a pending mistake
   * save (`again`), and which watched files of pending saves it may have written (`touched`).
   */
  private shellFacts(command: string, pending: readonly Save[]): Record<string, unknown> {
    const key = this.commandKey(command);
    const watched = new Set<string>();
    for (const s of pending) {
      if (s.kind === 'overlap_avoided' || s.kind === 'rule_enforced') {
        for (const p of s.paths) watched.add(p);
      }
    }
    const touched = [...watched].filter((p) => shellMayWrite(command, p)).slice(0, 20);
    return {
      command: key,
      line: commandLineFingerprint(command),
      again: pending.some((s) => s.kind === 'mistake_avoided' && s.refs.command === key),
      ...(touched.length > 0 ? { touched } : {}),
    };
  }

  /** The comparable key of a shell command (program and subcommand), redacted. */
  private commandKey(command: string): string {
    return sanitizeLine(
      redactText(commandKey(command), { extraPatterns: this.k.config.redaction.extraPatterns }),
      120,
    );
  }

  /**
   * Line hashes for provenance. Edits often replace part of a line (`old_string` / `new_string`),
   * so besides the added text itself, every line of the file as written that contains an added
   * fragment is hashed too; `mindly why` hashes whole lines and would otherwise miss them.
   */
  private provenanceHashes(content: string | null, addedText: string): string[] {
    const hashes = new Set(this.k.ports.git.hunkHashes(addedText));
    const fragments = addedText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length >= 4)
      .slice(0, 200);
    if (fragments.length === 0) return [...hashes];
    if (content === null) return [...hashes];
    for (const line of content.split(/\r?\n/)) {
      if (line.length > 2000) continue;
      if (fragments.some((f) => line.includes(f))) {
        for (const h of this.k.ports.git.hunkHashes(line)) hashes.add(h);
      }
    }
    return [...hashes].slice(0, 5000);
  }

  /**
   * Hashes of the lines an edit added or changed (what `mindly track` measures survival over),
   * always as whole lines of the file as written, so every tool is measured the same way.
   *
   * When the added text occurs exactly once in the file (an Edit-style replacement, a whole-file
   * write), the edit is located there: the file lines it spans are compared with the same lines
   * with the edit undone (added text replaced by the removed text), and every line that differs
   * counts. A change inside a line (`foo(1)` to `foo(2)`) records that whole line; unchanged
   * context inside the replacement does not count. Otherwise (several hunks, the text found more
   * than once) only added lines that are whole lines of the file count, minus removed ones.
   */
  private addedLineHashes(
    content: string | null,
    addedText: string,
    removedText: string,
  ): string[] {
    if (content === null || addedText === '') return [];
    const located = this.changedLines(content, addedText, removedText);
    if (located !== null) return located;
    const git = this.k.ports.git;
    const norm = (l: string): string => l.trim().replace(/\s+/g, ' ');
    // Only lines of the file equal to an added line are hashed (cheap on large files).
    const added = new Set(addedText.split(/\r?\n/).map(norm));
    const lines = new Set<string>();
    for (const line of content.split(/\r?\n/)) {
      if (line.length <= 2000 && added.has(norm(line))) {
        for (const h of git.hunkHashes(line)) lines.add(h);
      }
    }
    const removed = new Map<string, number>();
    for (const h of git.hunkHashes(removedText)) removed.set(h, (removed.get(h) ?? 0) + 1);
    const out = new Set<string>();
    for (const h of git.hunkHashes(addedText)) {
      const n = removed.get(h) ?? 0;
      if (n > 0) {
        removed.set(h, n - 1);
        continue;
      }
      if (lines.has(h)) out.add(h);
    }
    return [...out].slice(0, 5000);
  }

  /**
   * The lines an edit changed, found by locating its added text in the file (it must occur
   * exactly once) and undoing it there. Null when it cannot be located.
   */
  private changedLines(content: string, addedText: string, removedText: string): string[] | null {
    const at = content.indexOf(addedText);
    if (at === -1 || content.indexOf(addedText, at + 1) !== -1) return null;
    // Widen to whole lines: what precedes the edit on its first line, what follows on its last.
    const start = content.lastIndexOf('\n', at - 1) + 1;
    const nl = content.indexOf('\n', at + addedText.length);
    const end = nl === -1 ? content.length : nl;
    const before = content.slice(start, at);
    const after = content.slice(at + addedText.length, end);
    const norm = (l: string): string => l.trim().replace(/\s+/g, ' ');
    const undone = new Map<string, number>();
    for (const l of `${before}${removedText}${after}`.split(/\r?\n/)) {
      undone.set(norm(l), (undone.get(norm(l)) ?? 0) + 1);
    }
    const git = this.k.ports.git;
    const out = new Set<string>();
    for (const line of `${before}${addedText}${after}`.split(/\r?\n/)) {
      const n = undone.get(norm(line)) ?? 0;
      if (n > 0) {
        undone.set(norm(line), n - 1);
        continue;
      }
      if (line.length <= 2000) for (const h of git.hunkHashes(line)) out.add(h);
      if (out.size >= 5000) break;
    }
    return [...out];
  }

  private async stop(
    project: ProjectContext,
    session: Session,
    evt: NormalizedHookEvent,
  ): Promise<HookResult> {
    const files = this.k.store.fileChanges.recentPaths(
      session.id,
      session.lastSeenAt - 60 * 60_000,
    );
    this.k.store.events.append({
      projectId: project.project.id,
      sessionId: session.id,
      type: 'turn.completed',
      payload: { filesChanged: files.slice(0, 50) },
    });
    this.k.store.sessions.setStatus(session.id, 'idle');
    await this.d.bus.emit('turn.stopped', {
      projectId: project.project.id,
      projectRoot: project.root,
      session,
      lastMessage: evt.lastMessage,
      transcriptPath: evt.transcriptPath,
    });
    return EMPTY_HOOK_RESULT;
  }

  private async sessionEnd(project: ProjectContext, session: Session): Promise<HookResult> {
    this.k.store.sessions.setStatus(session.id, 'ended');
    this.d.intents.closeSession(session);
    this.k.store.events.append({
      projectId: project.project.id,
      sessionId: session.id,
      type: 'session.ended',
      payload: {},
    });
    await this.d.bus.emit('session.ended', {
      projectId: project.project.id,
      projectRoot: project.root,
      session,
    });
    return EMPTY_HOOK_RESULT;
  }
}

/** Upper bound on file size read to map partial-line edits back to whole lines. */
const MAX_PROVENANCE_FILE_BYTES = 512 * 1024;

/** Two context blocks as one text; null when both are empty. */
function joinContext(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  return b === null ? a : `${a}\n${b}`;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The deepest existing directory at or above `path`; null when there is none. */
function nearestDirectory(path: string): string | null {
  let current = path;
  for (let i = 0; i < 64; i++) {
    if (isDirectory(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/** Paths of `paths` a rule's scope covers; all of them when none can be told apart. */
function coveredBy(rule: Memory, paths: readonly string[]): string[] {
  const covered = paths.filter((p) => matchesAnyGlob(p, rule.scope.paths));
  return covered.length > 0 ? covered : [...paths];
}

function uncheckedDenial(count: number): HookResult {
  return {
    ...EMPTY_HOOK_RESULT,
    decision: 'deny',
    reason: `Mindly could not check ${count} of the paths this call writes: they lie outside this working tree, in more different places than it looks up at once. Make the change in smaller steps.`,
  };
}

/**
 * `~name/x` as a path next to the user's own home directory (where other users' homes are);
 * anything else unchanged. `~` and `~/x` were already placed by the shell reading.
 */
function placeHome(path: string): string {
  const m = /^~([^/]+)(\/.*)?$/.exec(path);
  return m ? join(dirname(homedir()), m[1] as string, m[2] ?? '') : path;
}

/** Dependency and repository folders: not listed, and a rule covers them only by naming them. */
const UNLISTED_DIRS = ['node_modules', '.git'];

/**
 * What a rule's scope (`globs`) covers of a directory or wildcard a command writes as a whole.
 * Decided by what the two can match: when they cannot overlap, nothing. When they can, the files
 * that exist are listed as an aid, and the answer is exact if the listing is complete; a listing
 * that was cut short never clears the command, the scope itself then counts as covered.
 */
function scopeCovered(scope: WrittenScope, globs: readonly string[]): string[] {
  const inUnlisted = UNLISTED_DIRS.filter((d) => scope.pattern.split('/').includes(d));
  const relevant = globs.filter(
    (g) =>
      globsMayOverlap(g, scope.pattern) &&
      // `rm -rf node_modules` is not about a rule for `*.pem`, unless the rule says so.
      inUnlisted.every((d) => g.includes(d)),
  );
  if (relevant.length === 0) return [];
  scope.listing ??= listScope(scope);
  const hits = scope.listing.files.filter((f) => matchesAnyGlob(f, relevant));
  if (hits.length > 0) return hits.slice(0, 5);
  // Nothing found: trusted only when everything was looked at, and no rule reaches into the
  // folders a listing skips.
  const skipsMatter = relevant.some((g) => UNLISTED_DIRS.some((d) => g.includes(d)));
  return scope.listing.complete && !skipsMatter ? [] : [scope.pattern];
}

/**
 * Files under the scope's directory that its pattern matches, relative to the tree root. Names
 * only, nothing is read; symbolic links are not followed; bounded by {@link MAX_TREE_ENTRIES}.
 * The scope is always inside a working tree of the project, so nothing outside it is listed.
 */
function listScope(scope: WrittenScope): { files: string[]; complete: boolean } {
  let match: RegExp;
  try {
    match = globToRegExp(scope.pattern);
  } catch {
    return { files: [], complete: false };
  }
  const files: string[] = [];
  const queue = [scope.base];
  let looked = 0;
  while (queue.length > 0) {
    const current = queue.shift() as string;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++looked > MAX_TREE_ENTRIES) return { files, complete: false };
      const full = join(current, e.name);
      if (e.isDirectory()) {
        if (!UNLISTED_DIRS.includes(e.name)) queue.push(full);
        continue;
      }
      const rel = toPosix(relative(scope.root, full));
      if (match.test(rel)) files.push(rel);
    }
  }
  return { files, complete: true };
}

/**
 * A hook whose working directory no longer exists (a removed worktree) still names the file it
 * is about to write: when that path is absolute, the event is read from the nearest directory
 * that exists, so rules and guards for the file still apply.
 */
function withUsableCwd(evt: NormalizedHookEvent): NormalizedHookEvent {
  if (evt.event !== 'pre_tool' || existsSync(evt.cwd)) return evt;
  const path = evt.tool?.edits.map((e) => e.path).find((p) => isAbsolute(p));
  const dir = path ? nearestDirectory(path) : null;
  return dir === null ? evt : { ...evt, cwd: dir };
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split('\n').length;
}

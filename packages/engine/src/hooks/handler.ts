import { existsSync, lstatSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import {
  EMPTY_HOOK_RESULT,
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
  readShellWrites,
  shellMayWrite,
  shellMayWriteFiles,
} from './shell.js';
import { isLiteralScope } from './scope.js';
import { globsReaching, scopeLabel, ScopeSearch, type WrittenScope } from './search.js';
import type { RuleService } from '../memory/rules.js';
import type { ProjectContext, ProjectService } from '../projects.js';

const MAX_PROMPT_STORED = 4000;

/**
 * Paths of one tool call that are checked against rules and guards. Adapters report up to 500
 * edits, and a patch that moves files reports two paths for each. A call with more is refused.
 */
const MAX_CHECKED_PATHS = 1000;
/** Paths of one tool call whose change is recorded (provenance, checkpoint, impact). */
const MAX_RECORDED_PATHS = 50;
/**
 * Normally git lists every working tree of the project in one call, and a path outside the
 * session's tree is placed by name. Only when that list cannot be had are places looked up one by
 * one (one git call each, trees already found cost nothing), at most this many per tool call. A
 * path that would need a lookup beyond this is not checked, and a call with such a path is
 * denied rather than let through unchecked.
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

/** What a tool call writes, as far as it could be placed in the project. */
interface Writes {
  paths: CheckedPath[];
  scopes: WrittenScope[];
  /** Paths that may be in the project but could not be placed (see {@link MAX_TREE_LOOKUPS}). */
  unchecked: number;
}

/** A rule the user marked as enforced, and what it covers of a tool call. */
interface RuleHit {
  rule: Memory;
  covers: string[];
  /**
   * Set when nothing covered was found but the search could not finish: the rule may or may not
   * apply. That is a warning, never a block.
   */
  unfinished?: boolean;
}

/** Other working trees of the project found while placing the paths of one tool call. */
interface TreeLookups {
  roots: string[];
  /** True once `roots` holds every working tree of the project: nothing is left to look up. */
  all?: boolean;
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
    if (trees.all === undefined) {
      // One call lists every working tree of the project; any path is then placed by name.
      const listed = (await this.k.ports.git.workingTrees?.(treeRoot).catch(() => null)) ?? null;
      trees.all = listed !== null;
      if (listed !== null) trees.roots = listed.filter((t) => t !== treeRoot);
    }
    for (const root of trees.roots) {
      const found = tryResolveInsideRoot(root, abs);
      if (found) return { ...found, root, own: false };
    }
    if (trees.all) return null;
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
    // What does not fit is counted as not checked, never dropped as fine.
    let unchecked = Math.max(0, paths.length - MAX_CHECKED_PATHS);
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
   * `limit` says why the command was not read to its end, when it was not.
   */
  private async shellWrites(
    project: ProjectContext,
    cwd: string,
    command: string,
    ownTreeOnly = false,
  ): Promise<{ certain: Writes; possible: Writes; limit: string | null }> {
    const certain: Writes = { paths: [], scopes: [], unchecked: 0 };
    const possible: Writes = { paths: [], scopes: [], unchecked: 0 };
    const treeRoot = (await this.k.ports.git.findRepoRoot(cwd)) ?? project.root;
    // The command is read as text; where it runs, the home directory and the repository root
    // are handed in so `~`, `$HOME` and `$(git rev-parse --show-toplevel)` can be placed.
    const reading = readShellWrites(command, { home: toPosix(homedir()), top: toPosix(treeRoot) });
    const trees: TreeLookups | null = ownTreeOnly ? null : { roots: [], dirs: new Map() };
    const seen = new Set<string>();
    for (const t of reading.targets) {
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
      const scope = (at: Located, rest: string[]): void => {
        const pattern = [...(at.rel === '' ? [] : [at.rel]), ...rest].join('/');
        into.scopes.push({
          // A single segment is written `./x`: this level only, not that name at any depth.
          pattern: pattern.includes('/') || pattern === '**' ? pattern : `./${pattern}`,
          base: at.abs,
          rest,
          root: at.root,
          own: at.own,
          only: t.only,
        });
      };
      const path = isAbsolute(t.path) ? t.path : resolve(cwd, placeHome(t.path));
      if (t.glob) {
        // Everything the pattern can match is under the directory before its first wildcard.
        const segments = toPosix(path).split('/');
        const wild = segments.findIndex((x) => /[*?{]/.test(x));
        const base = segments.slice(0, wild).join('/') || '/';
        const rest = segments.slice(wild);
        const at = await place(base);
        if (at !== null) {
          scope(at, rest);
          if (t.tree) scope(at, [...rest, '**']);
        } else if (t.tree) {
          // A pattern above the project that takes the project with it (`rm -rf ~/*`).
          const left = downTo(base, treeRoot, rest);
          const root = left === null ? null : await place(treeRoot);
          if (root !== null) scope(root, [...(left as string[]), '**']);
        }
        continue;
      }
      // A directory above the project, written with everything in it, holds the project too.
      if (t.tree && t.certain && downTo(toPosix(path), treeRoot, []) !== null) {
        const root = await place(treeRoot);
        if (root !== null) scope(root, ['**']);
        continue;
      }
      // A bare word given to an unknown program is a path only when such an entry exists.
      if (t.ifExists && !exists(path)) continue;
      const directory = isDirectory(path);
      if (t.entries.length > 0 && directory) {
        // A copy into a directory: each source lands under its own name, a directory with
        // everything in it; `.` pours into the directory itself.
        for (const name of t.entries) {
          const at = await place(name === '.' ? path : join(path, name));
          if (at === null) continue;
          if (name !== '.') file(at);
          if (t.tree) scope(at, ['**']);
        }
        continue;
      }
      const at = await place(path);
      if (at === null) continue;
      file(at);
      // A whole tree is written when the text says so; a path merely given to a program counts
      // as a tree only when it is a directory.
      if (t.tree && (t.certain || directory)) scope(at, ['**']);
    }
    // What the text shows as written is not also reported as a mere possibility.
    const sure = new Set(certain.paths.map((p) => p.abs));
    possible.paths = possible.paths.filter((p) => !sure.has(p.abs));
    return { certain, possible, limit: reading.limit };
  }

  /**
   * What the rules the user marked as enforced say about a write. `deny` is the first rule that
   * covers a written path, or something a written scope certainly reaches. `warn` are rules that
   * may apply: they cover a file the command would not rewrite, or the search for covered files
   * could not finish.
   *
   * A scope (a directory or wildcard written as a whole) is decided exactly, not by giving up:
   * a rule that names one path or one directory (`prisma/migrations/**`) is compared as text,
   * with no listing; a rule with wildcards (a `.pem` file at any depth) applies when a file it covers exists
   * there, which is searched within a budget. Only when the budget runs out is the answer not
   * known, and then the command is warned, not blocked: denying on "could not look" would stop
   * everyday commands (`rm -rf dist`) in every large repository, while the editing tools and
   * every path a command names outright stay enforced.
   */
  private enforcedRules(
    projectId: string,
    paths: readonly string[],
    scopes: readonly WrittenScope[],
    search: ScopeSearch,
  ): { deny: RuleHit | null; warn: RuleHit[] } {
    const warn: RuleHit[] = [];
    if (paths.length === 0 && scopes.length === 0) return { deny: null, warn };
    const rules = this.k.store.memories
      .list(projectId, { kinds: ['rule'], trust: ['approved', 'verified'], limit: 300 })
      .filter((m) => m.enforce && m.source.type === 'user' && m.scope.paths.length > 0);
    for (const rule of rules) {
      const globs = rule.scope.paths;
      const covers = paths.filter((p) => matchesAnyGlob(p, globs));
      const maybe: string[] = [];
      let unfinished = false;
      for (const s of scopes) {
        const reaching = globsReaching(s, globs);
        if (reaching.length === 0) continue;
        // A whole directory against a rule that names its path or directory: known from the
        // text, and it also holds for files the command creates or brings back. A wildcard only
        // stands for what exists, and a formatter only rewrites the kinds of file it knows: for
        // those, existing files decide.
        const wholeTree = s.rest.length === 1 && s.rest[0] === '**';
        if (wholeTree && s.only === null && reaching.some(isLiteralScope)) {
          covers.push(scopeLabel(s));
          continue;
        }
        const found = search.covered(s, reaching);
        const rewritten = found.files.filter((f) => writesKind(s, f));
        if (rewritten.length > 0) covers.push(...rewritten.slice(0, 5));
        else if (found.files.length > 0) maybe.push(...found.files.slice(0, 5));
        else if (!found.complete) {
          unfinished = true;
          maybe.push(scopeLabel(s));
        }
      }
      if (covers.length > 0) {
        // `x` and `x/**` are one thing to the reader.
        const named = covers.filter((c) => !(c.endsWith('/**') && covers.includes(c.slice(0, -3))));
        return { deny: { rule, covers: [...new Set(named)] }, warn };
      }
      if (maybe.length > 0) warn.push({ rule, covers: maybe, unfinished });
    }
    return { deny: null, warn };
  }

  private ruleDenial(hit: RuleHit, context: string | null): HookResult {
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
      // A patch too large to report in full is refused: the files that were cut are unknown.
      if (unchecked > 0 || tool.editsCut === true) {
        return uncheckedDenial(unchecked, tool.editsCut === true);
      }
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
      const rule: RuleHit | null = built?.deny
        ? { rule: built.deny, covers: coveredBy(built.deny, all) }
        : this.enforcedRules(pid, unrecorded, [], new ScopeSearch()).deny;
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
      const { certain, possible, limit } = await this.shellWrites(project, evt.cwd, tool.command);
      if (certain.unchecked > 0) return uncheckedDenial(certain.unchecked, false);
      const written = certain.paths.map((p) => p.rel);
      const named = possible.paths.map((p) => p.rel);
      const patterns = (w: Writes): string[] => w.scopes.map((x) => x.pattern);
      const search = new ScopeSearch();
      const guarded = async (w: Writes, paths: string[]): Promise<WriteGuardResult> => {
        const first = await this.consultGuards(project, session, paths, patterns(w));
        if (first.deny === null && first.warnings.length === 0) return first;
        // A wildcard only stands for what exists: when a guard objects to one, the files it
        // expands to are what is really asked about. A whole directory stays a pattern.
        const listed = expandWildcards(w.scopes, search);
        if (listed === null) return first;
        return this.consultGuards(project, session, [...paths, ...listed.files], listed.whole);
      };
      const guard = await guarded(certain, written);
      const soft = await guarded(possible, named);
      const rules = this.enforcedRules(pid, written, certain.scopes, search);
      const rule = rules.deny;
      const softRules = rule ? null : this.enforcedRules(pid, named, possible.scopes, search);
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
      const names = (hit: RuleHit): string =>
        hit.covers
          .slice(0, 5)
          .map((x) => sanitizeLine(x, 160))
          .join(', ');
      // A possible write only warns when a covered file was actually found.
      const mayApply = softRules
        ? [...(softRules.deny ? [softRules.deny] : []), ...softRules.warn].filter(
            (h) => !h.unfinished,
          )
        : [];
      for (const hit of [...rules.warn, ...mayApply].slice(0, 5)) {
        warnings.push(
          hit.unfinished
            ? `Mindly could not finish looking through ${names(hit)} for files covered by a project rule the user marked as enforced: "${hit.rule.title}". Do not change such files without asking the user.`
            : `This command names ${names(hit)}, covered by a project rule the user marked as enforced: "${hit.rule.title}". Do not change it without asking the user.`,
        );
      }
      if (possible.unchecked > 0) {
        warnings.push(
          `${possible.unchecked} of the paths this command names lie outside this working tree and were not checked against the project's rules.`,
        );
      }
      if (limit !== null) {
        warnings.push(
          `Mindly did not read this whole command (${limit}); the part it did not read was not checked against the project's rules. Do not use it to change files a rule protects.`,
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

function uncheckedDenial(count: number, cut: boolean): HookResult {
  return {
    ...EMPTY_HOOK_RESULT,
    decision: 'deny',
    reason: cut
      ? 'Mindly could not check this call: it changes more files than are reported at once. Make the change in smaller steps.'
      : `Mindly could not check ${count} of the paths this call writes: they lie outside this working tree, in more different places than it looks up at once, or the call writes too many files. Make the change in smaller steps.`,
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

/**
 * For a directory `from` above `root` and the pattern segments written below it: what is left of
 * the pattern once it has walked down to `root`, or null when `from` is not above `root` or the
 * pattern leads elsewhere. a wildcard right below a home that holds the project leaves nothing:
 * the project goes as a whole.
 */
function downTo(from: string, root: string, rest: readonly string[]): string[] | null {
  const top = toPosix(root);
  const above = from === '/' ? '/' : `${from.replace(/\/+$/, '')}/`;
  if (from === top || !top.startsWith(above)) return null;
  const between = top.slice(above.length).split('/');
  let at = 0;
  for (const name of between) {
    const segment = rest[at];
    if (segment === undefined) return [];
    if (segment === '**') return rest.slice(at);
    try {
      if (!globToRegExp(segment).test(name)) return null;
    } catch {
      return null;
    }
    at++;
  }
  return rest.slice(at);
}

/** Whether a file or directory is there (a link counts, wherever it points). */
function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Files one hook call hands to the write guards in place of the wildcards that name them. */
const MAX_EXPANDED_FILES = 1000;

/**
 * The files the wildcard scopes stand for, and the scopes that stay patterns: whole directories,
 * and wildcards whose files could not all be listed. Null when there is no wildcard to expand.
 */
function expandWildcards(
  scopes: readonly WrittenScope[],
  search: ScopeSearch,
): { files: string[]; whole: string[] } | null {
  const files: string[] = [];
  const whole: string[] = [];
  let expanded = false;
  for (const s of scopes) {
    const tree = s.rest.length === 1 && s.rest[0] === '**';
    const found = tree ? null : search.covered(s, ['**']);
    if (
      found === null ||
      !found.complete ||
      files.length + found.files.length > MAX_EXPANDED_FILES
    ) {
      whole.push(s.pattern);
      continue;
    }
    expanded = true;
    files.push(...found.files.filter((f) => writesKind(s, f)));
  }
  return expanded ? { files, whole } : null;
}

/** Whether what writes the scope rewrites a file of this kind. */
function writesKind(scope: WrittenScope, file: string): boolean {
  return scope.only === null || scope.only.includes(extname(file).slice(1).toLowerCase());
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

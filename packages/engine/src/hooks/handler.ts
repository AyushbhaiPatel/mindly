import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  opendirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import {
  EMPTY_HOOK_RESULT,
  globToRegExp,
  hasUnsafeChars,
  deniedPathTest,
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
  type InPlace,
  mayHold,
  partNames,
  normalizeCommandLine,
  pathNamer,
  readShellWrites,
  type FileKinds,
  shellMayWrite,
  shellMayWriteFiles,
} from './shell.js';
import { isLiteralScope, patternSegments, patternsMayOverlap } from './scope.js';
import {
  collapse,
  globsReaching,
  isWholeTree,
  scopeLabel,
  ScopeSearch,
  type WrittenScope,
} from './search.js';
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
/** Folders a shell command's `cd`s pass through that are checked for symbolic links. */
const MAX_LINK_LOOKUPS = 256;
/**
 * Files and folders a shell command writes in place that are looked at for another name: an
 * everyday folder (a build, the sources) is looked through whole, within the time there is.
 */
const MAX_NAME_LOOKUPS = 50_000;
/** Files of one shell command that are checked again (decisions, exports) after it ran. */
const MAX_SHELL_CHANGED = 20;
/**
 * Time the checks before a tool may take: reading the command, placing its paths and searching
 * for covered files. It is well under the hook's own deadline (`hooks.timeoutMs`, of which it is
 * at most this share), so the answer is given by Mindly and not cut off by the timer. What is not
 * read or searched when it runs out becomes a warning.
 */
const PRE_TOOL_BUDGET_MS = 900;
const PRE_TOOL_SHARE = 0.6;
/** Wildcard segments one written pattern may have; a deeper one counts as its whole directory. */
const MAX_PATTERN_SEGMENTS = 16;
/** Files one source brings that are placed one by one in a folder that is not there. */
const MAX_PLACED_ENTRIES = 2000;
/** Most folders above what `mkdir -p` names that one call places as made. */
const MAX_PARENTS = 256;
/**
 * Entries listed in one source of a copy to see what it brings, within the time there is. A
 * source with more cannot be listed, and what it brings is not known.
 */
const MAX_SOURCE_ENTRIES = 50_000;

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
  /** Letter case does not count when matching rules (`git --icase-pathspecs`). */
  nocase?: boolean;
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
  /** Directories in which files of unknown names are put (an archive unpacked, a copy). */
  landings: Located[];
  /**
   * Files a copy brings to a folder that is not there, too many to place one by one: the
   * folder, and their names under it. Held against the rules by name.
   */
  bulk?: { at: Located; names: readonly string[] }[];
  /** Paths that may be in the project but could not be placed (see {@link MAX_TREE_LOOKUPS}). */
  unchecked: number;
  /** Paths refused as unsafe to place: control or bidi characters, or far too long. */
  unsafe: number;
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
  /**
   * The search that could not finish was for files a git command may write across the whole
   * tree: said even where the write is only possible.
   */
  wholeTree?: boolean;
}

/** Other working trees of the project found while placing the paths of one tool call. */
interface TreeLookups {
  roots: string[];
  /** True once `roots` holds every working tree of the project: nothing is left to look up. */
  all?: boolean;
  /** For a folder looked at: whether it, or one above it below the tree's top, holds `.git`. */
  nested?: Map<string, boolean>;
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
  private deniedTest: ((rel: string) => boolean) | null = null;

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
    const own = inTree ? { ...inTree, root: treeRoot, own: !isDeniedPath(inTree.rel, deny) } : null;
    // A path in the session's tree is in that tree, unless a folder on the way to it holds a
    // repository of its own: then it may be in a working tree kept inside this one.
    if (own !== null && (trees === null || !inRepositoryBelow(own, trees))) {
      return own;
    }
    if (trees === null) return null;
    await this.otherTrees(treeRoot, trees);
    // The innermost working tree that holds the path is the one it belongs to.
    let inner: Located | null = null;
    for (const root of trees.roots) {
      if (inner !== null && root.length <= inner.root.length) continue;
      if (own !== null && root.length <= treeRoot.length) continue;
      const found = tryResolveInsideRoot(root, abs);
      if (found) inner = { ...found, root, own: false };
    }
    if (inner !== null || own !== null) return inner ?? own;
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

  /** The other working trees of the project, listed once for a call. */
  private async otherTrees(treeRoot: string, trees: TreeLookups): Promise<string[]> {
    if (trees.all === undefined) {
      // One call lists every working tree of the project; any path is then placed by name.
      const listed = (await this.k.ports.git.workingTrees?.(treeRoot).catch(() => null)) ?? null;
      trees.all = listed !== null;
      if (listed !== null) trees.roots = listed.filter((t) => t !== treeRoot);
    }
    return trees.roots;
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
   * A name in a located folder, the name itself not followed. With `onTheWay`, a folder that
   * only leads to the names placed under it: whether one may be recorded is decided for each.
   */
  private under(dir: Located, name: string, onTheWay = false): Located {
    const rel = dir.rel === '' ? toPosix(name) : `${dir.rel}/${toPosix(name)}`;
    return {
      ...dir,
      rel,
      abs: `${dir.abs}${sep}${name}`,
      own: dir.own && (onTheWay || !this.denied(rel)),
    };
  }

  /** Whether a path is on the deny-list; its patterns are compiled once. */
  private denied(rel: string): boolean {
    this.deniedTest ??= deniedPathTest(this.k.config.redaction.denyPaths);
    return this.deniedTest(rel);
  }

  /**
   * The places a write to a path may change (see {@link writePlaces}), each located: where the
   * path leads, and the name itself when that is a symbolic link.
   */
  private async locateAll(
    project: ProjectContext,
    treeRoot: string,
    places: readonly { at: string; name?: string }[],
    trees: TreeLookups | null,
  ): Promise<(Located | 'unknown')[]> {
    const found: (Located | 'unknown')[] = [];
    for (const place of places) {
      if (place.name === undefined) {
        const at = await this.locate(project, treeRoot, place.at, trees);
        if (at !== null) found.push(at);
        continue;
      }
      // The name as it is written in its folder: the folder is resolved, the name is not.
      const dir = await this.locate(project, treeRoot, place.at, trees);
      if (dir === null) continue;
      if (dir === 'unknown') {
        found.push(dir);
        continue;
      }
      found.push(this.under(dir, place.name));
    }
    return found;
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
    /** Before a write: every place the write may change, not only where the path leads. */
    everyPlace = false,
  ): Promise<{ paths: CheckedPath[]; unchecked: number; unsafe: number; lost: number }> {
    const treeRoot = (await this.k.ports.git.findRepoRoot(cwd)) ?? project.root;
    const out: CheckedPath[] = [];
    const seen = new Set<string>();
    // What does not fit is counted as not checked, never dropped as fine.
    let unchecked = Math.max(0, paths.length - MAX_CHECKED_PATHS);
    let unsafe = 0;
    let lost = 0;
    for (const p of paths.slice(0, MAX_CHECKED_PATHS)) {
      if (typeof p !== 'string' || p.length === 0) continue;
      // A path that cannot be placed safely is never passed over as outside the project.
      if (hasUnsafeChars(p) || p.length > 4096) {
        unsafe++;
        continue;
      }
      if (everyPlace) {
        // Not folded here: a `..` after a link is placed both as text and as the system does.
        const places = writePlaces(isAbsolute(p) ? p : `${cwd}/${p}`);
        if (places.lost) lost++;
        for (const found of await this.locateAll(project, treeRoot, places.places, trees)) {
          if (found === 'unknown') unchecked++;
          else if (found.rel !== '' && !seen.has(found.abs)) {
            seen.add(found.abs);
            out.push({ rel: found.rel, abs: found.abs, own: found.own });
          }
        }
        continue;
      }
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
    return { paths: out, unchecked, unsafe, lost };
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
   * only read them. A directory written as a whole and a wildcard become a scope: nothing of the
   * project is listed here. With `ownTreeOnly` (after the command ran) only files in the
   * session's working tree are placed, without any lookup. `limit` says why the command was not
   * read to its end, when it was not.
   */
  private async shellWrites(
    project: ProjectContext,
    session: string,
    command: string,
    ownTreeOnly = false,
    timeUp: () => boolean = () => false,
    understoodOnly = false,
  ): Promise<{
    certain: Writes;
    possible: Writes;
    limit: string | null;
    understood: boolean;
    /** The line's text was read fully, but what one of its copies brings could not be listed. */
    unlisted: boolean;
  }> {
    const certain: Writes = {
      paths: [],
      scopes: [],
      landings: [],
      bulk: [],
      unchecked: 0,
      unsafe: 0,
    };
    const possible: Writes = { paths: [], scopes: [], landings: [], unchecked: 0, unsafe: 0 };
    // The programs of the line find their paths from the folder itself, whatever links the
    // session's spelling of it goes through: paths are placed from there.
    const cwd = physical(resolve(session));
    const treeRoot = (await this.k.ports.git.findRepoRoot(cwd)) ?? project.root;
    // The command is read as text; where it runs, the home directory and the repository root
    // are handed in so `~`, `$HOME` and `$(git rev-parse --show-toplevel)` can be placed.
    // A `cd` through a symbolic link leads elsewhere than its text says. Asked of the disk a
    // bounded number of times; past that, or out of time, a path counts as one.
    let lookups = 0;
    let looked = 0;
    /** For each folder that is not there: whether the nearest name above it leads nowhere. */
    const nowhere = new Map<string, boolean>();
    const linked = (path: string): boolean => {
      if (++lookups > MAX_LINK_LOOKUPS || timeUp()) return true;
      try {
        return lstatSync(resolve(cwd, path)).isSymbolicLink();
      } catch {
        return false;
      }
    };
    // An `mv` of the folder the commands run in, or of one above it, takes them elsewhere than
    // the text says. Both are compared as they are on disk, links followed.
    const holds = (path: string, dir: string): boolean => {
      if (++lookups > MAX_LINK_LOOKUPS || timeUp()) return true;
      return mayHold(toPosix(physical(resolve(cwd, path))), toPosix(physical(resolve(cwd, dir))));
    };
    /** For each name looked at: whether it is a symbolic link; null when it is not there. */
    const links = new Map<string, boolean | null>();
    /** Folders that are there with no symbolic link on the way to them. */
    const clear = new Set<string>();
    const start = toPosix(cwd);
    // The folder the line runs in is told as it is on disk, so no link is above it: a path
    // under it is looked at from there, any other from the root, down to the first part that
    // is not there.
    const viaLink = (path: string): boolean => {
      const abs = toPosix(resolve(cwd, path));
      const folder = abs.slice(0, Math.max(abs.lastIndexOf('/'), 0));
      const from = clear.has(folder)
        ? folder.length
        : abs.startsWith(`${start}/`)
          ? start.length
          : 0;
      for (let end = abs.indexOf('/', from + 1); ; end = abs.indexOf('/', end + 1)) {
        // The last part is reached: every folder above it is there, and no link.
        if (end === -1 && folder !== '') clear.add(folder);
        const at = end === -1 ? abs : abs.slice(0, end);
        let link = links.get(at);
        if (link === undefined) {
          if (++looked > MAX_NAME_LOOKUPS || timeUp()) return true;
          try {
            link = lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink() ?? null;
          } catch {
            link = null;
          }
          links.set(at, link);
        }
        if (link === null || end === -1) return link === true;
        if (link) return true;
      }
    };
    const reading = readShellWrites(command, {
      home: toPosix(homedir()),
      top: toPosix(treeRoot),
      timeUp,
      linked,
      understoodOnly,
      isDir: (path) => canEnter(resolve(cwd, path)),
      // A `CDPATH` the agent's shell inherits is the one this process has.
      cdpath: (process.env.CDPATH ?? '') !== '',
      cwd: toPosix(cwd),
      holds,
      viaLink,
      // A file with another name is written under both, and a link that leads nowhere yet
      // is written through: looked for while there is time.
      strays: (write) =>
        writesElsewhere(
          {
            ...write,
            path: toPosix(resolve(cwd, write.path)),
            from: write.from == null ? null : resolve(cwd, write.from),
          },
          () => {
            looked++;
            return looked > MAX_NAME_LOOKUPS || timeUp();
          },
          nowhere,
        ),
    });
    let limit = reading.limit;
    const trees: TreeLookups | null = ownTreeOnly ? null : { roots: [], dirs: new Map() };
    /** Folders that names are placed under, each placed once. */
    const missing = new Map<string, Located | 'unknown' | null>();
    const seen = new Set<string>();
    // What a copy brings could not be found out: the line is not one read fully after all.
    let unsure = false;
    // What each source folder of a copy holds, and whether a symbolic link is in it.
    const listings = new Map<string, { names: string[] | null; link: boolean }>();
    // Folders above what `mkdir -p` names that were placed as made, each once.
    const parents = new Set<string>();
    let late = false;
    for (const t of reading.targets) {
      // Out of time: what is left is not placed, and the line is told it was not read to its
      // end. Searching what the placed paths hold is bounded apart, and reports what it did
      // not get to.
      if (!late && timeUp()) late = true;
      if (late) {
        limit ??= 'no time was left to place all it writes';
        continue;
      }
      const into = t.certain ? certain : possible;
      // Only files that exist there, of the kinds git touches (`git clean`, and what a command
      // that puts back tracked files stands for when git cannot say).
      const existing: FileKinds | null =
        t.how === 'clean' || t.how === 'clean-ignored'
          ? { tracked: false, untracked: true, ignored: t.how === 'clean-ignored' }
          : t.touches;
      const place = async (abs: string): Promise<Located | null> => {
        if (hasUnsafeChars(abs) || abs.length > 4096) {
          into.unsafe++;
          return null;
        }
        // Under a folder that is not there, a name is where the folder is: the folder is
        // placed once for all the names the line gives under it, from the nearest folder above
        // it that is there, which is placed once for all the folders missing under it.
        const dir = dirname(abs);
        if (dir !== abs && !exists(dir)) {
          let at = missing.get(dir);
          if (at === undefined) {
            const up = nearestThere(dir);
            let from = missing.get(up);
            if (from === undefined) {
              from = await this.locate(project, treeRoot, up, trees);
              missing.set(up, from);
            }
            const rest = dir.slice(up.length).replace(/^[\\/]+/, '');
            at =
              from === null || from === 'unknown' || rest === ''
                ? from
                : this.under(from, rest, true);
            missing.set(dir, at);
          }
          if (at === 'unknown') into.unchecked++;
          return at === null || at === 'unknown' ? null : this.under(at, basename(abs));
        }
        // A name in a folder that is there is placed under the folder too, which is placed
        // once however many names the line gives in it: a name that is not there, or one that
        // following would not change.
        // Not the top of a working tree, which is no part of the tree its folder is in: a
        // linked worktree kept inside the main checkout is placed as its own tree.
        const there = exists(abs);
        if (dir !== abs && (!there || (asSpelled(abs) && !exists(join(abs, '.git'))))) {
          let at = missing.get(dir);
          if (at === undefined) {
            at = await this.locate(project, treeRoot, dir, trees);
            missing.set(dir, at);
          }
          if (at === 'unknown') {
            into.unchecked++;
            return null;
          }
          // A name that is there is put under its folder only in the session's own tree.
          if (at !== null && (!there || at.root === treeRoot)) {
            return this.under(at, basename(abs));
          }
        }
        const found = await this.locate(project, treeRoot, abs, trees);
        if (found === 'unknown') into.unchecked++;
        return found === 'unknown' ? null : found;
      };
      const file = (at: Located | null): void => {
        if (at === null || at.rel === '' || seen.has(`${t.certain}:${at.abs}`)) return;
        seen.add(`${t.certain}:${at.abs}`);
        into.paths.push({
          rel: at.rel,
          abs: at.abs,
          own: at.own,
          ...(t.nocase ? { nocase: true } : {}),
        });
      };
      const scope = (
        at: Located,
        segments: readonly string[],
        base = at.abs,
        /** Whatever is there, not only the kinds of file the command touches. */
        any = false,
      ): void => {
        // Runs of `**` are one, and a pattern too deep to compare counts as its directory.
        let rest = collapse(segments);
        if (rest.length > MAX_PATTERN_SEGMENTS) rest = ['**'];
        const pattern = [...(at.rel === '' ? [] : [at.rel]), ...rest].join('/');
        into.scopes.push({
          // A single segment is written `./x`: this level only, not that name at any depth.
          pattern: pattern.includes('/') || pattern === '**' ? pattern : `./${pattern}`,
          base,
          rest,
          root: at.root,
          own: at.own,
          only: t.only,
          dotfiles: t.dotfiles,
          nocase: t.nocase,
          ...(existing !== null && !any ? { existing } : {}),
        });
      };
      const landing = (at: Located | null): void => {
        if (at !== null) into.landings.push(at);
      };
      /**
       * The project's working trees kept under a folder that is written as a whole or by a
       * wildcard: each holds its files under its own names, and is a scope of its own.
       */
      const treesBelow = async (
        base: string,
        rest: readonly string[],
        /** The session's own tree too, when the folder is above its top. */
        own = true,
        /** Whatever the trees hold, not only the kinds of file the command touches. */
        any = false,
      ): Promise<void> => {
        if (trees === null) return;
        // The folder as it is on disk: the trees are told by where they really are.
        const real = physical(base);
        const above = real.endsWith(sep) ? real : `${real}${sep}`;
        const roots = [
          ...(hasLinkedTrees(treeRoot) ? await this.otherTrees(treeRoot, trees) : []),
          ...(own ? [treeRoot] : []),
        ];
        for (const root of roots) {
          // A tree below the folder, or one whose top the folder is.
          if (root !== real && !root.startsWith(above)) continue;
          const parts = root === real ? [] : root.slice(above.length).split(sep);
          // The parts of the pattern that lead to the tree's top; what is left names files in it.
          let k = 0;
          while (k < parts.length && rest[k] !== undefined && rest[k] !== '**') {
            const part = parts[k] as string;
            const pattern = rest[k] as string;
            // A shell's wildcard does not stand for a leading dot.
            if (!t.dotfiles && part.startsWith('.') && /^[*?]/.test(pattern)) break;
            try {
              if (!globToRegExp(pattern).test(part)) break;
            } catch {
              // Not a part that can be held against a name: where it leads is not told.
              unsure = true;
              break;
            }
            k++;
          }
          if (k < parts.length && rest[k] !== '**') continue;
          const left = rest[k] === '**' ? rest.slice(k) : rest.slice(parts.length);
          // A folder the rest names that the tree does not hold: nothing of it is there.
          const wild = left.findIndex((x) => /[*?{]/.test(x));
          const folders = left.slice(0, wild === -1 ? left.length - 1 : wild);
          if (folders.length > 0 && !exists(join(root, ...folders))) continue;
          const top = await this.locate(project, treeRoot, root, trees);
          if (top === null || top === 'unknown' || top.root !== root) continue;
          scope(top, left.length > 0 ? left : ['**'], top.abs, any);
        }
      };
      // Another user's home (`~name`) is wherever the system says: not placed by guessing. A
      // line that names one is not read fully, and is warned about as a whole.
      if (t.unplaced) continue;
      const path = isAbsolute(t.path) ? t.path : resolve(cwd, t.path);
      /** The name itself, when it is a symbolic link, besides where it leads. */
      const named = async (target: string): Promise<void> => {
        // The first is the path itself, placed already.
        const others = writePlaces(target).places.slice(1);
        for (const found of await this.locateAll(project, treeRoot, others, trees)) {
          if (found === 'unknown') into.unchecked++;
          else file(found);
        }
      };
      /**
       * The files a source folder brings; null when it is no folder. One that cannot be listed
       * in full (too many names, no leave to read it, no time left), or that holds a symbolic
       * link when the copy follows them, brings what is not known: the line is not read fully.
       */
      const listed = (from: string): string[] | null => {
        // Listed once for a call, however many commands of the line copy it.
        let listing = listings.get(from);
        if (listing === undefined) {
          let link = false;
          const names = entriesUnder(from, timeUp, () => {
            link = true;
          });
          listing = { names, link };
          listings.set(from, listing);
        }
        if (listing.link && t.follows) unsure = true;
        const brought = listing.names;
        if (brought === null && isDirectory(from)) {
          unsure = true;
          if (timeUp()) limit ??= 'no time was left to place all it writes';
        }
        return brought;
      };
      /** What a source brings, under where it lands; within the time there is. */
      const brings = async (dest: string, brought: readonly string[]): Promise<void> => {
        // Under a folder that is not there, nothing is: each lands by its name below it.
        const base = exists(dest) ? null : await place(dest);
        // Too many to place one by one, and nothing is where they land: kept by name.
        if (base !== null && brought.length > MAX_PLACED_ENTRIES && t.certain) {
          certain.bulk?.push({ at: base, names: brought });
          return;
        }
        for (const rel of brought) {
          if (timeUp()) {
            limit ??= 'no time was left to place all it writes';
            return;
          }
          if (base === null) {
            file(await place(join(dest, rel)));
            await named(join(dest, rel));
          }
          // Put together as text: the folder is placed, and what is under it is not there.
          else file(this.under(base, rel));
        }
      };
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
          await treesBelow(base, t.tree ? [...rest, '**'] : rest);
        } else if (t.tree) {
          // A pattern above the project that takes the project with it (`rm -rf ~/*`).
          const left = downTo(base, treeRoot, rest);
          const root = left === null ? null : await place(treeRoot);
          if (root !== null) scope(root, [...(left as string[]), '**']);
          await treesBelow(base, [...rest, '**'], false);
        } else {
          // A pattern from above the project that reaches into it (`rm -f ../*/certs/*.pem`).
          await treesBelow(base, rest);
        }
        continue;
      }
      /**
       * `mkdir -p` makes the folders above the one it names that are not there: each is
       * written too, as many as are placed.
       */
      const above = async (): Promise<void> => {
        for (let up = dirname(path); t.parents && up !== dirname(up); up = dirname(up)) {
          if (parents.has(up) || exists(up)) break;
          if (parents.size >= MAX_PARENTS) {
            limit ??= `more than ${MAX_PARENTS} folders made on the way`;
            break;
          }
          parents.add(up);
          file(await place(up));
        }
      };
      // A word that is a path only when such an entry exists.
      if (t.ifExists && !exists(path)) continue;
      // A directory above the project, written with everything in it, holds the project too.
      // (Not the destination of a copy or move: each source lands there under its own name,
      // which is placed like any other path.)
      if (
        t.tree &&
        t.entries.length === 0 &&
        t.how !== 'land' &&
        downTo(toPosix(path), treeRoot, []) !== null
      ) {
        const root = await place(treeRoot);
        if (root !== null) scope(root, ['**']);
        await treesBelow(path, ['**'], false, t.nested);
        continue;
      }
      // `ln -n` takes a link to a folder as the name it is, not as the folder it leads to.
      // A folder `mkdir` made earlier on the line is one, though it is not on disk yet.
      const directory = t.intoFolder || (isDirectory(path) && !(t.noFollow && isLink(path)));
      if (t.how === 'land') {
        // An archive unpacked there: files of unknown names are put somewhere inside.
        landing(await place(path));
        continue;
      }
      if (t.entries.length > 0) {
        // A copy creates or overwrites what its sources bring; it does not destroy the
        // destination. Each source is looked at, when it is here to look at, to see what lands.
        if (!directory) {
          const at = await place(path);
          file(at);
          await named(path);
          const source = t.sources[0] ?? null;
          const from = source === null || source.startsWith('~') ? null : resolve(cwd, source);
          // A source that is a directory brings what it holds; one that is not here (made
          // earlier in the same command, or given by a variable) may be either.
          if (t.tree && (from === null || isDirectory(from) || !exists(from))) {
            const brought = from === null ? null : listed(from);
            if (brought === null) landing(at);
            else await brings(path, brought);
          }
          continue;
        }
        // The folder `mkdir` made is written by it, with those above it; and when something
        // else is at its name (the `mkdir` failed, or did not run), the copy writes that.
        if (t.intoFolder && !isDirectory(path)) {
          file(await place(path));
          await named(path);
          await above();
        }
        for (const [name, from] of copied(t, cwd, timeUp)) {
          if (name === null) {
            // Names that could not be found out: what lands is not known.
            unsure = true;
            if (timeUp()) limit ??= 'no time was left to place all it writes';
            landing(await place(path));
            continue;
          }
          const dest = name === '.' ? path : join(path, name);
          // The name each source lands under is checked as a name too: a link there is
          // replaced by a move or a new link, and written through by a copy.
          if (name !== '.') await named(dest);
          if (from !== null && isFile(from)) {
            file(await place(dest));
            continue;
          }
          const brought = from !== null && t.tree ? listed(from) : null;
          if (brought !== null) {
            await brings(dest, brought);
            continue;
          }
          // A source that is not here to look at: its own name lands, and what it holds is
          // not known.
          if (name !== '.') file(await place(dest));
          if (t.tree || name === '.') landing(await place(dest));
        }
        // `ln -s` makes a link under the name of each source as written, there or not: a
        // wildcard that matches nothing stays in the name.
        for (const name of t.asWritten ? t.entries : []) {
          if (/[*?]/.test(name)) file(await place(join(path, name)));
        }
        continue;
      }
      const at = await place(path);
      if (at === null) continue;
      if (existing !== null && !ownTreeOnly) {
        // The path and what is under it are decided by what is there, never by the name alone.
        if (at.rel !== '') {
          const parent = toPosix(dirname(at.rel));
          scope({ ...at, rel: parent === '.' ? '' : parent }, [basename(at.rel)], dirname(at.abs));
        }
        scope(at, ['**']);
        // Given `-f` twice, `git clean` also removes the repositories and working trees kept
        // under what it cleans, with all they hold.
        if (t.nested) await treesBelow(path, ['**'], false, true);
        continue;
      }
      file(at);
      await named(path);
      await above();
      // A whole tree is written when the text says so; a path merely given to a program counts
      // as a tree only when it is a directory.
      if (t.tree && (t.certain || directory)) {
        scope(at, ['**']);
        await treesBelow(path, ['**']);
      }
    }
    // What the text shows as written is not also reported as a mere possibility.
    const sure = new Set(certain.paths.map((p) => p.abs));
    possible.paths = possible.paths.filter((p) => !sure.has(p.abs));
    return {
      certain,
      possible,
      limit,
      understood: reading.understood && !unsure,
      unlisted: reading.understood && unsure,
    };
  }

  /** The rules the user marked as enforced that have a scope. */
  private enforced(projectId: string): Memory[] {
    return this.k.store.memories
      .list(projectId, { kinds: ['rule'], trust: ['approved', 'verified'], limit: 300 })
      .filter((m) => m.enforce && m.source.type === 'user' && m.scope.paths.length > 0);
  }

  /**
   * What the rules the user marked as enforced say about a write. `deny` is the first rule that
   * covers a written path, or something a written scope certainly reaches. `warn` are rules that
   * may apply: files of unknown names land where the rule can match, or the search for covered
   * files could not finish.
   *
   * A scope (a directory or wildcard written as a whole) is decided exactly, not by giving up:
   * a rule that names one path or one directory (`prisma/migrations/**`) is compared as text,
   * with no listing; a rule with wildcards (a `.pem` file at any depth) applies when a file it
   * covers exists there (see `ScopeSearch`). Each scope has its own answer: a search that could
   * not finish for one never weakens a match found for another, and it is a warning that names
   * what could not be searched, not a block, because denying on "could not look" would stop
   * everyday commands in every large repository.
   */
  private enforcedRules(
    rules: readonly Memory[],
    writes: Writes,
    search: ScopeSearch,
    /** For possible writes: a folder a rule names, there under this root, is reached. */
    root: string | null = null,
    /** Asked now and then while paths are matched: true when there is no time left. */
    timeUp: () => boolean = () => false,
  ): { deny: RuleHit | null; warn: RuleHit[]; cut: boolean } {
    const warn: RuleHit[] = [];
    let cut = false;
    // The names a big copy brings are held once against every pattern that can match under
    // the folder they land in, whatever the folder is called (nothing is walked there; the
    // names are in hand); only one that fits is looked at rule by rule.
    const brought = new Map<Memory, string[]>();
    const quiet = new Map<readonly string[], Map<string, boolean>>();
    for (const b of writes.bulk ?? []) {
      const under = b.at.rel === '' ? '**' : `${b.at.rel}/**`;
      const reach = rules
        .map((rule) => ({
          rule,
          test: null as ReturnType<typeof globsTest> | null,
          globs: rule.scope.paths.filter((g) => patternsMayOverlap(g, under)),
        }))
        .filter((x) => x.globs.length > 0);
      if (reach.length === 0) continue;
      const any = globsTest(
        reach.flatMap((x) => x.globs),
        false,
      );
      const prefix = b.at.rel === '' ? '' : `${b.at.rel}/`;
      // The same names under another folder, against the same patterns: when no name fits
      // any of them by itself, only the folder's own path can make one fit.
      const key = reach.flatMap((x) => x.globs).join('\0');
      let none = quiet.get(b.names)?.get(key);
      if (none === undefined) {
        none = !b.names.some((name) => any.fits(toPosix(name)));
        quiet.set(b.names, (quiet.get(b.names) ?? new Map<string, boolean>()).set(key, none));
      }
      if (none && !any.fits(prefix)) continue;
      for (let i = 0; i < b.names.length && !cut; i++) {
        if ((i & 1023) === 1023 && timeUp()) cut = true;
        const name = toPosix(b.names[i] as string);
        if (!any(name, prefix)) continue;
        for (const x of reach) {
          if (!(x.test ??= globsTest(x.globs, false))(name, prefix)) continue;
          const hits = brought.get(x.rule) ?? [];
          if (hits.length < 5) hits.push(`${prefix}${name}`);
          brought.set(x.rule, hits);
        }
      }
    }
    for (const rule of rules) {
      const globs = rule.scope.paths;
      // A copy may bring thousands of paths: each rule's patterns are compiled once, and the
      // matching stops when the time is up, which the caller says.
      const plain = globsTest(globs, false);
      let folded: ((rel: string) => boolean) | null = null;
      const covers: string[] = [];
      for (let i = 0; i < writes.paths.length && !cut; i++) {
        if ((i & 1023) === 1023 && timeUp()) cut = true;
        const p = writes.paths[i] as Writes['paths'][number];
        if (p.nocase ? (folded ??= globsTest(globs, true))(p.rel) : plain(p.rel)) {
          covers.push(p.rel);
        }
      }
      covers.push(...(brought.get(rule) ?? []));
      const maybe: string[] = [];
      const unsearched: string[] = [];
      let wholeTree = false;
      for (const s of writes.scopes) {
        const reaching = globsReaching(s, globs);
        if (reaching.length === 0) continue;
        if (settledByText(s, reaching)) {
          covers.push(scopeLabel(s));
          continue;
        }
        const found = search.covered(s, reaching);
        // A formatter only rewrites the kinds of file it knows; the others are not its business.
        const rewritten = found.files.filter((f) => writesKind(s, f));
        // What may change any file of the tree reaches a folder a rule names when the folder is
        // there, whatever files it holds.
        const folders =
          s.existing !== undefined && root !== null
            ? reaching.filter(
                (g) =>
                  !/[*?[\]{}]/.test(g.replace(/\/\*\*$/, '')) &&
                  isDirectory(join(root, g.replace(/\/\*\*$/, ''))),
              )
            : [];
        if (rewritten.length > 0) covers.push(...rewritten.slice(0, 5));
        else if (folders.length > 0) covers.push(...folders.slice(0, 5));
        else if (!found.complete) {
          unsearched.push(...found.unsearched);
          if (s.existing !== undefined) wholeTree = true;
        }
      }
      for (const l of writes.landings) {
        const label = l.rel === '' ? '.' : l.rel;
        // Files of unknown names land there. Inside a directory the rule names, any of them is
        // covered. Around it, or for a rule that matches names at any depth, they may or may not
        // land on a covered file: worth a warning when such a file is there to be overwritten.
        if (globs.some((g) => isLiteralScope(g) && landsInside(l.rel, g))) {
          covers.push(label);
          continue;
        }
        const ls = landingScope(l);
        const reaching = globsReaching(ls, globs);
        if (reaching.some(isLiteralScope)) maybe.push(label);
        else if (reaching.length > 0 && search.covered(ls, reaching).files.length > 0)
          maybe.push(label);
      }
      if (covers.length > 0) {
        // `x` and `x/**` are one thing to the reader.
        const named = covers.filter((c) => !(c.endsWith('/**') && covers.includes(c.slice(0, -3))));
        return { deny: { rule, covers: [...new Set(named)] }, warn, cut };
      }
      if (maybe.length > 0) warn.push({ rule, covers: [...new Set(maybe)] });
      if (unsearched.length > 0)
        warn.push({ rule, covers: [...new Set(unsearched)], unfinished: true, wholeTree });
    }
    return { deny: null, warn, cut };
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
      const {
        paths: checked,
        unchecked,
        unsafe,
        lost,
      } = await this.checkedPaths(
        project,
        evt.cwd,
        tool.edits.map((e) => e.path),
        undefined,
        true,
      );
      if (unsafe > 0) return unsafeDenial();
      if (lost > 0) return lostDenial(lost);
      // A patch too large to report in full is refused: the files that were cut are unknown.
      if (unchecked > 0 || tool.editsCut === true) {
        return uncheckedDenial(unchecked, tool.editsCut === true);
      }
      // A file with another name as well is written under both: it is the very file a rule
      // names, or it may be a file a rule covers, which the name does not tell. Looked at for
      // every path the tool reports, one outside the project too: its other name may be inside.
      const enforced = this.enforced(pid);
      const inside = new Set(checked.map((p) => p.abs));
      const beyond =
        enforced.length > 0
          ? [
              ...new Set(
                tool.edits
                  .slice(0, MAX_CHECKED_PATHS)
                  .filter((e) => typeof e.path === 'string' && e.path.length > 0)
                  .map((e) => physical(resolve(evt.cwd, e.path))),
              ),
            ].filter((abs) => !inside.has(abs) && linkCount(abs) > 1)
          : [];
      if (checked.length === 0 && beyond.length === 0) {
        if (pending.length > 0)
          this.appendToolEvent(pid, session, 'tool.before', { tool: toolName });
        return EMPTY_HOOK_RESULT;
      }
      const twice =
        enforced.length > 0
          ? [
              ...checked.filter((p) => linkCount(p.abs) > 1),
              ...beyond.map((abs) => ({ rel: toPosix(abs), abs })),
            ]
          : [];
      const same = twice
        .map((p) => {
          const named = ruleNaming(enforced, project.root, p.abs);
          return named === null ? null : { rule: named, covers: [p.rel] };
        })
        .find((hit) => hit !== null);
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
        : (this.enforcedRules(
            enforced,
            {
              paths: unrecorded.map((rel) => ({ rel, abs: rel, own: false })),
              scopes: [],
              landings: [],
              unchecked: 0,
              unsafe: 0,
            },
            new ScopeSearch(null, 0),
          ).deny ??
          same ??
          null);
      if (overlap.overlaps.length > 0 || rule || pending.length > 0) {
        // What Mindly told the agent before this write: the evidence of overlap and rule saves.
        this.appendToolEvent(pid, session, 'tool.before', {
          tool: toolName,
          ...(paths.length > 0 ? { paths } : {}),
          overlaps: overlap.overlaps,
          deniedBy: rule?.rule.id ?? null,
        });
      }
      const more = enforced.length > 5 ? ` and ${enforced.length - 5} more` : '';
      /** The warning for each such file, the rules named by `title`. */
      const linked = (title: (m: Memory) => string): string[] =>
        twice.slice(0, 5).map(
          (p) =>
            `${sanitizeLine(p.rel, 160)} has another name as well (a hard link): this write changes the file under every name it has, which may be a file covered by ${enforced.length === 1 ? 'a project rule' : 'project rules'} the user marked as enforced: ${enforced
              .slice(0, 5)
              .map((m) => `"${title(m)}"`)
              .join(', ')}${more}. Do not change it without asking the user.`,
        );
      const context = joinContext(
        built?.text ?? null,
        renderSections([
          {
            heading: 'Coordination warning',
            lines: [...outside.warnings, ...linked((m) => m.title)].map((w) => `- ${w}`),
          },
        ]),
      );
      if (rule) return this.ruleDenial(rule, context);
      const denied = guard.deny ?? outside.deny;
      if (denied) return { ...EMPTY_HOOK_RESULT, decision: 'deny', reason: denied, context };
      return withEnforcementWarning({ ...EMPTY_HOOK_RESULT, context }, linked(plainTitle));
    }
    if (tool.shell && tool.command) {
      const mistakes = this.d.mistakes.forCommand(pid, tool.command);
      // A command that writes a file (sed -i, cat > file, mv, rm) answers to the same rules and
      // guards as an editing tool, for the files its text shows it writes. A path that is only
      // handed to a program Mindly does not know may just be read: that is a warning, not a block.
      // All of it within one budget of time, under the hook's own deadline: what is not read or
      // searched when it runs out is said in a warning.
      const budget = Math.min(PRE_TOOL_BUDGET_MS, this.k.config.hooks.timeoutMs * PRE_TOOL_SHARE);
      const until = performance.now() + budget;
      // Only a line Mindly reads fully is checked exactly, and only such a line is ever blocked.
      // Any other stands for a possible write of the whole tree: a warning when a file an
      // enforced rule covers is there.
      const { certain, possible, limit, understood, unlisted } = await this.shellWrites(
        project,
        evt.cwd,
        tool.command,
        false,
        () => performance.now() > until - budget / 2,
        true,
      );
      // A shell line that also holds a patch: the files the patch names may be written too.
      if (tool.edits.length > 0) {
        const patched = await this.checkedPaths(
          project,
          evt.cwd,
          tool.edits.map((e) => e.path),
        );
        possible.paths.push(...patched.paths);
        possible.unchecked += patched.unchecked;
        possible.unsafe += patched.unsafe;
      }
      if (certain.unsafe > 0) return unsafeDenial();
      if (certain.unchecked > 0) return uncheckedDenial(certain.unchecked, false);
      const written = certain.paths.map((p) => p.rel);
      const named = possible.paths.map((p) => p.rel);
      const lister = this.k.ports.git.listFiles?.bind(this.k.ports.git) ?? null;
      const search = new ScopeSearch(lister, until);
      const guarded = async (w: Writes, paths: string[]): Promise<WriteGuardResult> => {
        const whole = w.scopes.map((x) => x.pattern);
        const first = await this.consultGuards(project, session, paths, whole);
        if (first.deny === null && first.warnings.length === 0) return first;
        // A wildcard only stands for what exists, and a formatter only rewrites the kinds of
        // file it knows: when a guard objects, the files in question are what is really asked
        // about. A whole directory stays a pattern.
        const listed = await expandScopes(w.scopes, search);
        if (listed === null) return first;
        return this.consultGuards(project, session, [...paths, ...listed.files], listed.whole);
      };
      const guard = await guarded(certain, written);
      // What may only be read, and where files of unknown names land (an archive unpacked, a
      // copy whose sources cannot be seen), is never a block here: a warning at most.
      // What may only be read is a warning at most. A line not read fully may write anything:
      // the guards are asked about the whole tree as it is written, never about a listing, and
      // what they say is a warning, never a block.
      const soft: WriteGuardResult = understood
        ? await guarded(possible, named)
        : {
            warnings: (
              await this.consultGuards(
                project,
                session,
                [],
                possible.scopes.map((x) => x.pattern),
              )
            ).warnings,
            deny: null,
          };
      const landed = await this.consultGuards(
        project,
        session,
        [],
        [...certain.landings, ...possible.landings, ...(certain.bulk ?? []).map((b) => b.at)].map(
          (l) => (l.rel === '' ? '**' : `${l.rel}/**`),
        ),
      );
      soft.warnings.push(...landed.warnings);
      const enforced = this.enforced(pid);
      await search.prepare(
        [
          ...certain.scopes,
          ...possible.scopes,
          ...certain.landings.map(landingScope),
          ...possible.landings.map(landingScope),
        ].flatMap((scope) =>
          enforced.map((m) => ({ scope, globs: globsReaching(scope, m.scope.paths) })),
        ),
      );
      const late = (): boolean => performance.now() > until;
      const rules = this.enforcedRules(enforced, certain, search, null, late);
      const rule = rules.deny;
      // What may change the whole tree (a line not read fully, a git command that brings files
      // back) also warns when a folder a rule names is there, whatever it holds. What a command
      // certainly writes is decided by the covered files that exist.
      const softRules = rule
        ? null
        : this.enforcedRules(enforced, possible, search, project.root, late);
      // Out of time while the paths were held against the rules: the rest was not checked.
      const stopped =
        limit ?? (rules.cut || softRules?.cut ? 'no time was left to check all it writes' : null);
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
      // A possible write only warns when a covered file was actually found, or, for what a git
      // command may do to the whole tree, when the search for one could not finish.
      const mayApply = softRules
        ? [...(softRules.deny ? [softRules.deny] : []), ...softRules.warn].filter(
            (h) => !h.unfinished || h.wholeTree === true,
          )
        : [];
      // What is said about enforced rules, and about what was not checked against them, is
      // kept as plain text too, the rules named without markup characters.
      const plain: string[] = [];
      const warn = (text: (title: (m: Memory) => string) => string): void => {
        warnings.push(text((m) => m.title));
        plain.push(text(plainTitle));
      };
      // A line whose text was read fully but whose copies could not all be listed is blocked
      // for what it certainly writes, and is then not told it could not be read.
      if (understood || (unlisted && rule !== null)) {
        for (const hit of [...rules.warn, ...mayApply].slice(0, 5)) {
          warn((title) =>
            hit.unfinished
              ? `Mindly could not search all of ${names(hit)} for files covered by a project rule the user marked as enforced: "${title(hit.rule)}". Do not change such files without asking the user.`
              : `This command names ${names(hit)}, covered by a project rule the user marked as enforced: "${title(hit.rule)}". Do not change it without asking the user.`,
          );
        }
      } else if (enforced.length > 0) {
        // A line not read fully may write any file, one that is not there yet too: it is told
        // so whatever is there, once, with every enforced rule named (those that cover
        // something it names or may reach first) and what of that is covered.
        const hits = [...rules.warn, ...mayApply];
        const reached = new Set(hits.map((hit) => hit.rule.id));
        const ordered = [
          ...enforced.filter((m) => reached.has(m.id)),
          ...enforced.filter((m) => !reached.has(m.id)),
        ];
        const more = ordered.length > 5 ? ` and ${ordered.length - 5} more` : '';
        // What could not be searched is not said to be covered.
        const covered = [...new Set(hits.flatMap((hit) => (hit.unfinished ? [] : hit.covers)))]
          .slice(0, 5)
          .map((x) => sanitizeLine(x, 160));
        warn(
          (title) =>
            `Mindly could not read this command fully; it may write any file, including files covered by ${ordered.length === 1 ? 'a project rule' : 'project rules'} the user marked as enforced: ${ordered
              .slice(0, 5)
              .map((m) => `"${title(m)}"`)
              .join(
                ', ',
              )}${more}.${covered.length > 0 ? ` Of what it names or may reach, ${covered.join(', ')} ${covered.length === 1 ? 'is' : 'are'} covered.` : ''} Do not change such files without asking the user.`,
        );
      }
      if (possible.unchecked > 0) {
        warn(
          () =>
            `${possible.unchecked} of the paths this command names lie outside this working tree and were not checked against the project's rules.`,
        );
      }
      if (stopped !== null) {
        warn(
          () =>
            `Mindly did not read this whole command (${stopped}); the part it did not read was not checked against the project's rules. Do not use it to change files a rule protects.`,
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
      if (context === null) return EMPTY_HOOK_RESULT;
      return withEnforcementWarning({ ...EMPTY_HOOK_RESULT, context }, plain);
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
      const until = performance.now() + PRE_TOOL_BUDGET_MS / 2;
      const { certain } = await this.shellWrites(
        project,
        cwd,
        command,
        true,
        () => performance.now() > until,
      );
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

/** A rule's title as plain text for a person: one line, without characters that mark text up. */
const plainTitle = (m: Memory): string => sanitizeLine(m.title, 160).replace(/[<>`*[\]]/g, '');

/**
 * A result with what it warns about enforced rules as plain text of its own, for an agent that
 * takes no context before a tool runs and shows this to the person instead.
 */
function withEnforcementWarning(result: HookResult, warnings: readonly string[]): HookResult {
  const text = sanitizeLine(warnings.join(' '), 2000);
  return text === '' ? result : { ...result, enforcementWarning: text };
}

/**
 * `matchesAnyGlob` for many paths: each pattern is compiled once, and the text every match ends
 * with is compared before its expression is run. A pattern without a slash matches the last
 * segment anywhere, as it does there. With `under`, the path is `rel` under that folder (given
 * with its `/`).
 */
function globsTest(
  globs: readonly string[],
  nocase: boolean,
): ((rel: string, under?: string) => boolean) & {
  /** Whether a text, as the end of a path or a piece of one, may make a pattern fit. */
  fits: (text: string) => boolean;
} {
  const opts = nocase ? { nocase: true } : {};
  let tests: { anywhere: boolean; re: RegExp; tail: string }[];
  // Whether any pattern may match at all: by how the path ends, or by a text it must hold.
  let ends: RegExp | null = null;
  let holds: RegExp | null = null;
  try {
    const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    const needles: string[] = [];
    let open = false;
    tests = globs.map((g) => {
      const last = g.slice(g.lastIndexOf('/') + 1);
      // (None for a pattern with groups or classes: a group may hold a `/`.)
      const plain = !/[[{]/.test(g);
      const tail = plain ? last.slice(last.search(/[^*?]*$/)) : '';
      if (tail === '') {
        // The longest text between its wildcards and its `/`: a piece of one name.
        const needle = plain
          ? g.split(/[*?/]+/).reduce((a, b) => (b.length > a.length ? b : a), '')
          : '';
        if (needle === '') open = true;
        else needles.push(nocase ? needle.toLowerCase() : needle);
      }
      return {
        anywhere: !g.includes('/'),
        re: globToRegExp(g.includes('/') ? g.replace(/^\.\//, '') : g, opts),
        tail: nocase ? tail.toLowerCase() : tail,
      };
    });
    if (!open) {
      const tails = tests.filter((t) => t.tail !== '').map((t) => escape(t.tail));
      ends = new RegExp(tails.length > 0 ? `(?:${tails.join('|')})$` : '^(?!)');
      holds = new RegExp(needles.length > 0 ? needles.map(escape).join('|') : '^(?!)');
    }
  } catch {
    // A pattern that does not compile is left to the one-path test.
    return Object.assign((rel: string) => matchesAnyGlob(rel, globs, opts), { fits: () => true });
  }
  const fits = (text: string): boolean => {
    if (ends === null || holds === null) return true;
    const t = nocase ? text.toLowerCase() : text;
    return ends.test(t) || holds.test(t);
  };
  const test = (rel: string, under = ''): boolean => {
    const end = nocase ? rel.toLowerCase() : rel;
    if (ends !== null && holds !== null && !ends.test(end)) {
      const whole = `${under}${rel}`;
      if (!holds.test(nocase ? whole.toLowerCase() : whole)) return false;
    }
    // The whole path is put together only for a pattern its end fits.
    let path: string | null = null;
    return tests.some((t) => {
      if (t.tail !== '' && !end.endsWith(t.tail)) return false;
      path ??= `${under}${rel}`.replace(/^\.\//, '');
      return t.re.test(t.anywhere ? path.slice(path.lastIndexOf('/') + 1) : path);
    });
  };
  return Object.assign(test, { fits });
}

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

/** Whether a path is a folder a `cd` can enter: there, and searchable by this user. */
function canEnter(path: string): boolean {
  if (!isDirectory(path)) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * A path with the symbolic links on its way followed, as far as it is there: what is not there
 * (a name with a wildcard, a file not made yet) stays as written under the part that is.
 */
function physical(path: string): string {
  const rest: string[] = [];
  let current = path;
  for (let i = 0; i < 256; i++) {
    try {
      return join(realpathSync.native(current), ...rest);
    } catch {
      const parent = dirname(current);
      if (parent === current) break;
      rest.unshift(basename(current));
      current = parent;
    }
  }
  return path;
}

/**
 * Whether a write in place reaches a file elsewhere than its name says: a regular file with
 * another name as well (a link count above one, links on the way to it followed), or a name
 * behind a symbolic link that leads nowhere (the write makes the file the link points to).
 * What is looked at is what the write lands on, as {@link InPlace} tells. `out` is asked before
 * each look: when there are too many to look at, the answer is yes.
 */
function writesElsewhere(
  write: { path: string; glob: boolean; kind: InPlace['kind']; from: string | null },
  out: () => boolean,
  /** What was found for each folder that is not there, kept for the whole call. */
  known: Map<string, boolean> = new Map(),
): boolean {
  /**
   * Whether a name that is not there is behind a link that cannot be followed: the nearest name
   * above it that is there is a link, and nothing is where it leads. Asked once for each folder,
   * within the looks there are.
   */
  const nowhere = (target: string): boolean => {
    /** A link to nothing, when the name is there; null when it is not. */
    const state = (name: string): boolean | null => {
      try {
        const there = lstatSync(name, { throwIfNoEntry: false });
        return there === undefined ? null : there.isSymbolicLink() && !existsSync(name);
      } catch {
        return null;
      }
    };
    const own = state(target);
    if (own !== null) return own;
    // Not there: the answer is that of its folder, found once for all the names under it.
    const walked: string[] = [];
    let found = false;
    for (let at = dirname(target); ;) {
      const before = known.get(at);
      if (before !== undefined) {
        found = before;
        break;
      }
      if (out()) return true;
      const here = state(at);
      if (here !== null) {
        found = here;
        break;
      }
      walked.push(at);
      const up = dirname(at);
      if (up === at) break;
      at = up;
    }
    for (const dir of walked) known.set(dir, found);
    return found;
  };
  /** A file written under this name. */
  const file = (target: string): boolean => {
    if (out()) return true;
    try {
      const stat = statSync(target);
      return stat.isFile() && stat.nlink > 1;
    } catch {
      return nowhere(target);
    }
  };
  /** The names in a folder; null when they cannot all be looked at. */
  const list = (dir: string): { name: string; link: boolean; folder: boolean }[] | null => {
    const names: { name: string; link: boolean; folder: boolean }[] = [];
    try {
      const open = opendirSync(dir);
      try {
        for (let e = open.readSync(); e !== null; e = open.readSync()) {
          if (out()) return null;
          names.push({ name: e.name, link: e.isSymbolicLink(), folder: e.isDirectory() });
        }
      } finally {
        open.closeSync();
      }
    } catch {
      // Not a folder that can be read: the shell matches nothing in it either.
      return [];
    }
    return names;
  };
  /**
   * Everything under a folder; `links`: a link in it counts (a copy writes through one, a
   * change of mode or owner passes it by). `deep`: the folders in it too.
   */
  const under = (dir: string, links: boolean, deep: boolean): boolean => {
    const entries = list(dir);
    if (entries === null) return true;
    return entries.some((e) => {
      const at = join(dir, e.name);
      if (e.link) return links;
      return e.folder ? deep && under(at, links, deep) : file(at);
    });
  };
  /** What a copy of `from` writes at `target`, and under it for a folder. */
  const over = (target: string, from: string | null, top: boolean): boolean => {
    if (out()) return true;
    let there;
    try {
      there = lstatSync(target);
    } catch {
      // Not there: made new, unless a link above it leads nowhere.
      return nowhere(target);
    }
    // A link under what the copy lands on is written through.
    if (there.isSymbolicLink() && !top) return true;
    let source;
    try {
      source = from === null ? null : statSync(from);
    } catch {
      source = null;
    }
    if (source !== null && !source.isDirectory()) return file(target);
    if (!isDirectory(target)) return file(target);
    // What a source that cannot be looked at brings is not known: anything there may be hit.
    if (source === null || from === null) return under(target, true, true);
    const brought = list(from);
    if (brought === null) return true;
    return brought.some((e) => over(join(target, e.name), join(from, e.name), false));
  };
  const at = (target: string): boolean => {
    switch (write.kind) {
      case 'file':
        return file(target);
      case 'tree':
        return isDirectory(target) ? under(target, false, true) : file(target);
      case 'land':
        return isDirectory(target) ? under(target, true, false) : nowhere(target);
      case 'copy':
        return over(target, write.from, true);
      case 'link':
        // Asked of the names a wildcard matches, below.
        return false;
    }
  };
  // Everything the pattern can match is under the folder before its first wildcard.
  const parts = write.path.split('/');
  const wild = write.glob ? parts.findIndex((x) => /[*?]/.test(x)) : -1;
  if (wild === -1) return at(write.path);
  /**
   * Whether a symbolic link a part of the pattern names is followed. As a folder on the way, or
   * as what a removal goes through, only one that leads to a folder is; as the last part of a
   * write in place, any is.
   */
  const followed = (name: string, last: boolean): boolean =>
    last && write.kind !== 'link' ? true : isDirectory(name);
  const match = (dir: string, rest: readonly string[]): boolean => {
    const [part, ...more] = rest;
    if (part === undefined) return at(dir);
    if (!/[*?]/.test(part)) {
      // A plain part after a wildcard, in each folder the wildcard matched.
      const next = join(dir, part);
      if (out()) return true;
      if (isLink(next) && followed(next, more.length === 0)) return true;
      return match(next, more);
    }
    const entries = list(dir);
    // Where a link that is followed leads is not looked for.
    return (
      entries === null ||
      entries.some((e) => {
        if (!partNames(part, e.name)) return false;
        const next = join(dir, e.name);
        return e.link ? followed(next, more.length === 0) : match(next, more);
      })
    );
  };
  return match(parts.slice(0, wild).join('/') || '/', parts.slice(wild));
}

/** How many names a regular file has (links followed to it); 0 when it is not one. */
function linkCount(path: string): number {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.nlink : 0;
  } catch {
    return 0;
  }
}

/** Enforced rules whose scopes are looked at for a file named outright. */
const MAX_NAMED_RULES = 32;

/**
 * The enforced rule that names, as a plain path with no wildcard, the very file at `abs` (the
 * same file on disk, under another name); null when none of the first few does.
 */
function ruleNaming(rules: readonly Memory[], root: string, abs: string): Memory | null {
  let target;
  try {
    target = statSync(abs);
  } catch {
    return null;
  }
  for (const rule of rules.slice(0, MAX_NAMED_RULES)) {
    for (const scope of rule.scope.paths) {
      if (/[*?[\]{}]/.test(scope)) continue;
      try {
        const named = statSync(join(root, scope));
        if (named.isFile() && named.dev === target.dev && named.ino === target.ino) return rule;
      } catch {
        // Not there: nothing it names.
      }
    }
  }
  return null;
}

/** Whether a name is a symbolic link. */
function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Symbolic links followed by hand to where a write through one that leads nowhere lands. */
const MAX_LINKS_FOLLOWED = 8;

/**
 * The places a write to a path may change, for the checks before it. `at` alone: a path to
 * locate, links followed. With `name`: that name in the folder `at`, the name itself not
 * followed.
 *
 * A path is placed as its text folds, which is how editing tools take it; with a `..` after a
 * named part it is also placed as the system takes it, off the folder a link before the `..`
 * leads to. Where the name it comes to is a symbolic link, the name itself counts besides where
 * it leads: taking it away or putting something in its place changes the name, a write in place
 * changes what it leads to. A link that leads to nothing is followed by hand, a few times; `lost`
 * when that does not settle where it leads.
 */
function writePlaces(raw: string): {
  places: { at: string; name?: string }[];
  lost: boolean;
} {
  const places: { at: string; name?: string }[] = [];
  let lost = false;
  /** Whether a path has a `..` after a named part: taken off wherever a link before it leads. */
  const backs = (path: string): boolean => {
    let named = false;
    return path.split(/[\\/]/).some((part) => {
      if (part === '..') return named;
      if (part !== '' && part !== '.') named = true;
      return false;
    });
  };
  const back = backs(raw);
  /** Whether a name is a symbolic link; with `nowhere`, one that leads to nothing. */
  const linkAt = (path: string, nowhere = false): boolean => {
    try {
      return lstatSync(path).isSymbolicLink() && (!nowhere || !existsSync(path));
    } catch {
      return false;
    }
  };
  for (const path of back ? [resolve(raw), physical(raw)] : [resolve(raw)]) {
    places.push({ at: path });
    if (!linkAt(path)) continue;
    places.push({ at: dirname(path), name: basename(path) });
    if (existsSync(path)) continue;
    // It leads to nothing: where a write through it would make a file.
    try {
      let at = path;
      for (let i = 0; i < MAX_LINKS_FOLLOWED && linkAt(at, true); i++) {
        const to = readlinkSync(at);
        // Where such a target leads is not settled by folding its text.
        if (backs(to)) throw new Error('not followed');
        // From the folder the link is in, not the one the path names it by.
        at = resolve(realpathSync.native(dirname(at)), to);
      }
      if (linkAt(at, true)) lost = true;
      else places.push({ at });
    } catch {
      lost = true;
    }
  }
  return { places, lost };
}

/**
 * The nearest path at or above `path` that is there, links followed: what the system would place
 * the rest under. Whatever is there has everything above it there too, so it is found in a few
 * looks, however deep the path.
 */
function nearestThere(path: string): string {
  const { root } = parse(path);
  // Where the path and each folder above it ends, deepest first; the root is the last resort.
  const ends = [path.length];
  for (let i = path.length - 1; i >= root.length && i > 0; i--) if (path[i] === sep) ends.push(i);
  const there = (end: number): boolean => {
    try {
      return statSync(path.slice(0, end), { throwIfNoEntry: false }) !== undefined;
    } catch {
      return false;
    }
  };
  let low = 0;
  let high = ends.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (there(ends[mid] as number)) high = mid;
    else low = mid + 1;
  }
  return low === ends.length ? root : path.slice(0, ends[low]);
}

/**
 * Whether a path placed in a working tree is, or lies under, a folder below the top that holds
 * a `.git` entry: a repository or working tree of its own. Each folder is looked at once.
 */
function inRepositoryBelow(at: { abs: string; rel: string }, trees: TreeLookups): boolean {
  const seen = (trees.nested ??= new Map<string, boolean>());
  const walked: string[] = [];
  let found = false;
  // One folder for each part of the path below the top of the tree.
  let left = at.rel === '' ? 0 : at.rel.split('/').length;
  for (let dir = at.abs; left > 0; dir = dirname(dir), left--) {
    const known = seen.get(dir);
    if (known !== undefined) {
      found = known;
      break;
    }
    walked.push(dir);
    if (exists(join(dir, '.git'))) {
      found = true;
      break;
    }
  }
  for (const dir of walked) seen.set(dir, found);
  return found;
}

/** Whether the project has working trees besides its main one, as its `.git` tells. */
function hasLinkedTrees(treeRoot: string): boolean {
  try {
    const git = join(treeRoot, '.git');
    return statSync(git).isFile() || readdirSync(join(git, 'worktrees')).length > 0;
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

/** A write to a path that cannot be placed safely: refused, never passed over. */
function unsafeDenial(): HookResult {
  return {
    ...EMPTY_HOOK_RESULT,
    decision: 'deny',
    reason:
      'Mindly refused this call: a path it writes contains control or bidi characters (or is too long), so it cannot be checked against the project rules. Use the plain file name.',
  };
}

/** A write through symbolic links that could not be followed to where it lands. */
function lostDenial(count: number): HookResult {
  return {
    ...EMPTY_HOOK_RESULT,
    decision: 'deny',
    reason: `Mindly could not check ${count === 1 ? 'a path' : `${count} of the paths`} this call writes: ${count === 1 ? 'it goes' : 'they go'} through a symbolic link Mindly cannot follow to where it leads, so the write cannot be checked against the project rules. Write the file by its own path.`,
  };
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
    return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Whether a name that is there is the name the system has for it: no symbolic link, written in
 * plain characters, and with no other letter case of it there too, as there is on a file system
 * that ignores case. Such a name is where its folder is, under itself.
 */
function asSpelled(path: string): boolean {
  const name = basename(path);
  if (!/^[\x20-\x7e]+$/.test(name) || isLink(path)) return false;
  const other = name === name.toLowerCase() ? name.toUpperCase() : name.toLowerCase();
  return other === name || !exists(join(dirname(path), other));
}

/** Files one hook call hands to the write guards in place of the patterns that name them. */
const MAX_EXPANDED_FILES = 1000;

/**
 * The files the scopes stand for, and the scopes that stay patterns. A wildcard stands for the
 * files it expands to, and a formatter over a directory for the files of the kinds it rewrites;
 * a directory written as a whole, and anything whose files could not all be listed, stays a
 * pattern. Null when nothing was expanded.
 */
async function expandScopes(
  scopes: readonly WrittenScope[],
  search: ScopeSearch,
): Promise<{ files: string[]; whole: string[] } | null> {
  const files: string[] = [];
  const whole: string[] = [];
  let expanded = false;
  for (const s of scopes) {
    const pattern = isWholeTree(s) && s.only === null && s.existing === undefined;
    const found = pattern ? null : await search.listAll(s);
    if (
      found === null ||
      !found.complete ||
      files.length + found.files.length > MAX_EXPANDED_FILES
    ) {
      whole.push(s.pattern);
      continue;
    }
    expanded = true;
    for (const f of found.files) if (writesKind(s, f)) files.push(f);
  }
  return expanded ? { files, whole } : null;
}

/**
 * Whether a rule applies to a scope by the text alone: a directory written as a whole against a
 * rule that names a path or a directory. It then also holds for files the command creates. A
 * wildcard only stands for what exists, a formatter only rewrites the kinds of file it knows,
 * and files brought back from the index only change when they differ: those are searched.
 */
function settledByText(scope: WrittenScope, reaching: readonly string[]): boolean {
  return (
    isWholeTree(scope) &&
    scope.only === null &&
    scope.existing === undefined &&
    reaching.some(isLiteralScope)
  );
}

/** Where files of unknown names land, as a scope to search for what is there already. */
function landingScope(l: Located): WrittenScope {
  return {
    pattern: l.rel === '' ? '**' : `${l.rel}/**`,
    base: l.abs,
    rest: ['**'],
    root: l.root,
    own: l.own,
    only: null,
    dotfiles: true,
    nocase: false,
  };
}

/** Whether a directory (relative; `''` is the root) lies in what a literal rule glob names. */
function landsInside(dir: string, glob: string): boolean {
  const segments = patternSegments(glob);
  const tree = segments[segments.length - 1] === '**' ? segments.slice(0, -1) : segments;
  const at = dir === '' ? [] : dir.split('/');
  return tree.length <= at.length && tree.every((s, i) => s === at[i]);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Files under a directory a copy brings, as paths relative to it. Names only, bounded, and read
 * entry by entry so a very wide directory stops at the bound. Null when it is not a directory
 * that can be listed in full: what it brings is then not known.
 */
function entriesUnder(
  dir: string,
  timeUp: () => boolean,
  /** Called for a symbolic link found in it: listed as a name, not looked through. */
  link: () => void = () => {},
): string[] | null {
  if (!isDirectory(dir)) return null;
  const out: string[] = [];
  const queue = [''];
  let left = MAX_SOURCE_ENTRIES;
  while (queue.length > 0) {
    const rel = queue.pop() as string;
    let handle;
    try {
      handle = opendirSync(join(dir, rel), { bufferSize: 128 });
    } catch {
      return null;
    }
    try {
      for (;;) {
        const e = handle.readSync();
        if (e === null) break;
        if (--left < 0 || ((left & 127) === 0 && timeUp())) return null;
        const child = rel === '' ? e.name : `${rel}/${e.name}`;
        if (e.isSymbolicLink()) link();
        if (e.isDirectory()) {
          if (e.name !== '.git') queue.push(child);
        } else out.push(child);
      }
    } finally {
      handle.closeSync();
    }
  }
  return out;
}

/**
 * The sources of a copy into a directory: the name each lands under and where it comes from
 * (null when it is not a local path that is there). A wildcard in the last part of a source is
 * expanded against its directory; a name of null means names that could not be found out.
 */
function copied(
  t: { entries: string[]; sources: (string | null)[] },
  cwd: string,
  timeUp: () => boolean,
): [name: string | null, from: string | null][] {
  const out: [string | null, string | null][] = [];
  t.entries.forEach((name, i) => {
    const source = t.sources[i] ?? null;
    const from = source === null || source.startsWith('~') ? null : resolve(cwd, source);
    if (name === '*' && from === null) {
      out.push([null, null]);
      return;
    }
    if (!/[*?]/.test(name)) {
      out.push([name, from]);
      return;
    }
    // `dir/*`: the entries of `dir` that the pattern matches.
    const parent = from === null ? null : dirname(from);
    let match: RegExp | null;
    try {
      match = globToRegExp(name);
    } catch {
      match = null;
    }
    if (parent === null || match === null || /[*?]/.test(parent) || !isDirectory(parent)) {
      out.push([null, null]);
      return;
    }
    let left = MAX_SOURCE_ENTRIES;
    let handle;
    try {
      handle = opendirSync(parent, { bufferSize: 128 });
    } catch {
      out.push([null, null]);
      return;
    }
    try {
      for (;;) {
        const e = handle.readSync();
        if (e === null) break;
        if (--left < 0 || ((left & 127) === 0 && timeUp())) {
          out.push([null, null]);
          break;
        }
        // A shell's wildcard does not stand for a leading dot; a pattern that starts with one
        // names it.
        if ((name.startsWith('.') || !e.name.startsWith('.')) && match.test(e.name))
          out.push([e.name, join(parent, e.name)]);
      }
    } finally {
      handle.closeSync();
    }
  });
  return out;
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

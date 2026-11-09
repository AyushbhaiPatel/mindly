import { statSync } from 'node:fs';
import { z } from 'zod';
import {
  fingerprint,
  invalidInput,
  isDeniedPath,
  resolveInsideRoot,
  sanitizeLine,
  sha256,
  MindlyError,
  type Contract,
  type ContractKind,
  type ContractSpec,
  type ContractState,
  type MemorySource,
  type Session,
} from '@mindly/core';
import type { TelepathyService } from '../coordination/telepathy.js';
import type { BusEvents, Kernel } from '../kernel.js';
import { readBounded } from '../memory/service.js';
import type { Mindly } from '../mindly.js';
import { attachService, guarded, liveSessions, safeProjectPath } from './shared.js';

/*
 * Executable memory. A contract binds a memory (usually a decision) to a declarative check over
 * the repository, re-evaluated whenever the file it reads changes.
 *
 * Regex safety: JavaScript regexes cannot be interrupted once running, so a time check alone
 * cannot stop catastrophic backtracking. Patterns are therefore restricted to a conservative safe
 * subset at creation time (see `checkSafePattern`): at most 300 characters, no backreferences, no
 * lookaround, no repeated group that itself contains a quantifier or alternation (the classic
 * `(a+)+` / `(a|aa)*` shapes; a counted repeat such as `(a+){12}` is the same thing written out),
 * at most two unbounded quantifiers (a `{n,m}` with m > 16 counts as unbounded) and at most eight
 * quantifiers in total. Without nested quantifiers, the paths a backtracking matcher can try per
 * start position are bounded by counting them: a sequence multiplies the paths of its parts, an
 * alternation adds the paths of its branches (or counts once when its branches are distinct
 * literals, none a prefix of another, since only one can match), and a quantifier multiplies by
 * its number of repeat counts, with every repeat of an atom that has several paths of its own
 * (a group holding an optional part, `(a?a?)+`) multiplying them again. That count is capped at
 * `MAX_PATHS` (two unbounded quantifiers over a full window, with a little room for optional
 * tokens). That bounds the cost of one match attempt to roughly cubic in the length of the text
 * it runs over, so that text is never longer than `MATCH_WINDOW_CHARS`: a line that fits is
 * matched whole, a longer one (minified code, one-line JSON) in overlapping windows of that size
 * (see `matchLine`). Each window stays within a few milliseconds to a few tens of milliseconds,
 * which lets the 100 ms budget (checked after every window) take effect over at most 512 KB of
 * content.
 *
 * `command` contracts are never executed here: only the user may create them, their argv hash is
 * pinned at creation, and the daemon runs them later through a trusted runner.
 */

export const MAX_PATTERN_LENGTH = 300;
const MAX_CONTRACT_FILE_BYTES = 512 * 1024;
/** The longest text a pattern is run against in one go; longer lines are matched in windows. */
const MATCH_WINDOW_CHARS = 200;
/** How far consecutive windows of a long line overlap: a match up to about this long is found. */
const MATCH_WINDOW_OVERLAP = 100;
const PATTERN_BUDGET_MS = 100;
/** How many recent contract results are searched for a contract's last passing/failing one. */
const CONCLUSIVE_LOOKBACK = 2000;
const MAX_UNBOUNDED_QUANTIFIERS = 2;
/** Every quantifier (including `?` and `{n,m}`) counts toward this cap. */
const MAX_QUANTIFIERS = 8;
/** A bounded repeat with an upper bound above this counts as unbounded. */
const MAX_BOUNDED_REPEAT = 16;
/** Cap on the match paths a backtracking matcher can try per start position (see above). */
const MAX_PATHS = 8 * (MATCH_WINDOW_CHARS + 1) ** 2;

/** Result of evaluating a contract once. */
export interface ContractEvaluation {
  state: ContractState;
  message: string;
}

/**
 * Validates that a regex source belongs to the safe subset described above. Returns an error
 * message, or null when the pattern is acceptable.
 */
export function checkSafePattern(pattern: string): string | null {
  if (pattern.length === 0) return 'pattern is empty';
  if (pattern.length > MAX_PATTERN_LENGTH)
    return `pattern exceeds ${MAX_PATTERN_LENGTH} characters`;
  try {
    new RegExp(pattern);
  } catch {
    return 'pattern does not compile';
  }
  interface Frame {
    quantified: boolean;
    alternation: boolean;
    /** Match paths through the finished branches, the current branch, and its last atom. */
    finished: number;
    current: number;
    atom: number;
    branchStart: number;
    branches: string[];
  }
  const frame = (branchStart: number): Frame => ({
    quantified: false,
    alternation: false,
    finished: 0,
    current: 1,
    atom: 1,
    branchStart,
    branches: [],
  });
  const endBranch = (f: Frame, end: number): void => {
    f.finished += f.current * f.atom;
    f.current = 1;
    f.atom = 1;
    f.branches.push(pattern.slice(f.branchStart, end));
    f.branchStart = end + 1;
  };
  const paths = (f: Frame): number => (exclusiveLiterals(f.branches) ? 1 : f.finished);
  const stack: Frame[] = [frame(0)];
  let unbounded = 0;
  let quantifiers = 0;
  let lastClosed: Frame | null = null;
  let i = 0;
  const top = (): Frame => stack[stack.length - 1] as Frame;
  const atom = (cost: number): void => {
    const f = top();
    f.current *= f.atom;
    f.atom = cost;
  };
  while (i < pattern.length) {
    const ch = pattern[i] as string;
    if (ch === '\\') {
      const next = pattern[i + 1] ?? '';
      if (/[1-9]/.test(next) || next === 'k') return 'backreferences are not allowed';
      atom(1);
      i += 2;
      lastClosed = null;
      continue;
    }
    if (ch === '[') {
      // Skip the character class, honouring escapes.
      i++;
      if (pattern[i] === '^') i++;
      if (pattern[i] === ']') i++;
      while (i < pattern.length && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1;
      atom(1);
      i++;
      lastClosed = null;
      continue;
    }
    if (ch === '(') {
      if (pattern.startsWith('(?=', i) || pattern.startsWith('(?!', i)) {
        return 'lookahead is not allowed';
      }
      if (pattern.startsWith('(?<=', i) || pattern.startsWith('(?<!', i)) {
        return 'lookbehind is not allowed';
      }
      // Skip group syntax such as `(?:`, `(?<name>` or `(?i:` so its `?` is not a quantifier.
      if (pattern[i + 1] === '?') i = pattern.indexOf(pattern[i + 2] === '<' ? '>' : ':', i);
      i++;
      stack.push(frame(i));
      lastClosed = null;
      continue;
    }
    if (ch === ')') {
      const closed = stack.pop();
      if (!closed || stack.length === 0) return 'unbalanced parentheses';
      endBranch(closed, i);
      // A group containing a quantifier or an alternation makes the enclosing group "quantified".
      if (closed.quantified || closed.alternation) top().quantified = true;
      atom(paths(closed));
      lastClosed = closed;
      i++;
      continue;
    }
    if (ch === '|') {
      top().alternation = true;
      endBranch(top(), i);
      i++;
      lastClosed = null;
      continue;
    }
    const q = /^(?:[*+?]|\{\d+(?:,\d*)?\})/.exec(pattern.slice(i));
    if (q) {
      const tok = q[0];
      const upper = /^\{\d+,(\d+)\}$/.exec(tok)?.[1] ?? /^\{(\d+)\}$/.exec(tok)?.[1];
      const isUnbounded =
        tok === '*' ||
        tok === '+' ||
        /^\{\d+,\}$/.test(tok) ||
        (upper !== undefined && Number(upper) > MAX_BOUNDED_REPEAT);
      quantifiers++;
      const lower = Number(/^\{(\d+)/.exec(tok)?.[1] ?? (tok === '+' ? 1 : 0));
      const most = isUnbounded ? MATCH_WINDOW_CHARS : tok === '?' ? 1 : Number(upper ?? lower);
      // Anything that can match its atom more than once repeats it: `*`, `+`, `{n,}`, `{n,m}` and
      // the counted `{n}` alike.
      if (lastClosed && most > 1 && (lastClosed.quantified || lastClosed.alternation)) {
        return 'nested quantifiers are not allowed';
      }
      if (isUnbounded) unbounded++;
      const f = top();
      if (most <= 1) f.atom += lower === 0 ? 1 : 0;
      // Each repeat walks the atom's own paths again (1 for a plain character or class).
      else f.atom = (most - Math.min(lower, most) + 1) * f.atom ** most;
      // `?` and an exact count leave only one way through, so a group holding nothing else may
      // still be repeated (`(\d{2}-){2}`).
      if (tok !== '?' && !/^\{\d+\}$/.test(tok)) f.quantified = true;
      i += tok.length;
      // Skip a lazy/possessive marker.
      if (pattern[i] === '?') i++;
      lastClosed = null;
      continue;
    }
    atom(1);
    lastClosed = null;
    i++;
  }
  if (quantifiers > MAX_QUANTIFIERS) {
    return `at most ${MAX_QUANTIFIERS} quantifiers are allowed`;
  }
  if (unbounded > MAX_UNBOUNDED_QUANTIFIERS) {
    return `at most ${MAX_UNBOUNDED_QUANTIFIERS} unbounded quantifiers are allowed`;
  }
  endBranch(top(), pattern.length);
  if (paths(top()) > MAX_PATHS) {
    return 'pattern allows too much backtracking; use fewer optional parts or alternatives';
  }
  return null;
}

/**
 * Whether these alternation branches are plain literals that can never match at the same
 * position (none is empty or a prefix of another, ignoring case), so backtracking tries at most
 * one of them.
 */
function exclusiveLiterals(branches: readonly string[]): boolean {
  if (branches.length < 2) return false;
  const literals: string[] = [];
  for (const b of branches) {
    if (!/^(?:[^\\^$.|?*+()[\]{}]|\\\W)+$/.test(b)) return false;
    literals.push(b.replace(/\\(.)/g, '$1').toLowerCase());
  }
  return literals.every((a, i) => literals.every((b, j) => i === j || !b.startsWith(a)));
}

const pathField = z.string().min(1).max(300);
const patternField = z
  .string()
  .max(MAX_PATTERN_LENGTH)
  .superRefine((p, ctx) => {
    const err = checkSafePattern(p);
    if (err) ctx.addIssue({ code: 'custom', message: err });
  });

/** zod schemas for each contract kind's spec. Unknown keys are rejected. */
export const ContractSpecSchemas = {
  file_exists: z.strictObject({ path: pathField }),
  pattern_present: z.strictObject({ path: pathField, pattern: patternField }),
  pattern_absent: z.strictObject({ path: pathField, pattern: patternField }),
  json_key: z.strictObject({
    path: pathField,
    key: z
      .string()
      .max(200)
      .regex(/^[\w$-]+(?:\.[\w$-]+)*$/, 'key must be a dot path'),
  }),
  export_present: z.strictObject({
    path: pathField,
    symbol: z
      .string()
      .max(120)
      .regex(/^[A-Za-z_$][\w$]*$/, 'symbol must be an identifier'),
  }),
  command: z.strictObject({
    argv: z.array(z.string().min(1).max(1000)).min(1).max(50),
    timeoutSec: z.number().int().min(1).max(600).optional(),
  }),
} satisfies Record<ContractKind, z.ZodType>;

/** Hash pinned for an approved `command` contract. */
export function commandHash(argv: readonly string[]): string {
  return sha256(JSON.stringify(argv));
}

/**
 * Creates and evaluates contracts and reacts to the files they read. Reports a critical
 * `contract_broken` conflict when a passing contract starts failing and resolves it when fixed.
 */
export class ContractService {
  constructor(
    private readonly k: Kernel,
    private readonly telepathy: TelepathyService,
  ) {}

  /**
   * Validates and stores a contract bound to `memoryId`, then evaluates it once to establish a
   * baseline. Throws `invalid_input`, `forbidden` or `path_outside_project` for bad specs.
   */
  create(memoryId: string, kind: ContractKind, spec: unknown, by: MemorySource): Contract {
    const memory = this.k.store.memories.get(memoryId);
    const project = this.k.store.projects.get(memory.projectId);
    const schema = ContractSpecSchemas[kind];
    if (!schema) throw invalidInput('unknown contract kind');
    const parsed = schema.safeParse(spec);
    if (!parsed.success) {
      throw invalidInput(
        `invalid ${kind} contract: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
    const clean: ContractSpec = { ...(parsed.data as ContractSpec) };
    let approvedHash: string | null = null;
    if (kind === 'command') {
      if (by.type !== 'user') {
        throw new MindlyError('forbidden', 'only the user can create command contracts');
      }
      approvedHash = commandHash(clean.argv ?? []);
    } else {
      const resolved = resolveInsideRoot(project.root, clean.path ?? '');
      if (resolved.rel === '') throw invalidInput('contract path must be a file in the project');
      if (isDeniedPath(resolved.rel, this.k.config.redaction.denyPaths)) {
        throw new MindlyError('forbidden', 'contract path is on the deny-list');
      }
      clean.path = resolved.rel;
    }
    const contract = this.k.store.contracts.create({
      projectId: memory.projectId,
      memoryId,
      kind,
      spec: clean,
      approvedHash,
    });
    const first = this.evaluate(contract, project.root);
    const saved = this.k.store.contracts.recordResult(contract.id, first.state, first.message);
    this.recordEvent(saved, first, by.sessionId, null);
    return saved;
  }

  /**
   * Evaluates a declarative contract against the working tree. Never throws and never runs a
   * process: `command` contracts return `unknown`.
   */
  evaluate(contract: Contract, projectRoot: string): ContractEvaluation {
    if (contract.kind === 'command') {
      return { state: 'unknown', message: 'command contracts run in the daemon' };
    }
    const spec = contract.spec;
    const p = spec.path ? safeProjectPath(this.k, projectRoot, spec.path) : null;
    if (!p) return { state: 'error', message: 'contract path is invalid or not allowed' };
    const rel = p.rel;
    let exists: boolean;
    try {
      exists = statSync(p.abs).isFile();
    } catch {
      exists = false;
    }
    if (contract.kind === 'file_exists') {
      return exists
        ? { state: 'passing', message: `${rel} exists` }
        : { state: 'failing', message: `${rel} does not exist` };
    }
    if (!exists) {
      if (contract.kind === 'pattern_absent') {
        return { state: 'passing', message: `${rel} does not exist` };
      }
      return { state: 'failing', message: `${rel} does not exist` };
    }
    const content = readBounded(p.abs, MAX_CONTRACT_FILE_BYTES);
    if (content === null) return { state: 'error', message: `${rel} is too large to check` };

    switch (contract.kind) {
      case 'pattern_present':
      case 'pattern_absent': {
        const pattern = spec.pattern ?? '';
        const rejected = checkSafePattern(pattern);
        if (rejected !== null) {
          return {
            state: 'error',
            message: `pattern rejected as too expensive to evaluate safely: ${sanitizeLine(pattern, 120)} (${rejected}); add a contract with a simpler pattern`,
          };
        }
        const found = matchLines(pattern, content);
        if (found === 'error') return { state: 'error', message: 'pattern could not be evaluated' };
        if (contract.kind === 'pattern_present') {
          return found
            ? { state: 'passing', message: `pattern found in ${rel}` }
            : { state: 'failing', message: `pattern not found in ${rel}` };
        }
        return found
          ? { state: 'failing', message: `forbidden pattern found in ${rel}` }
          : { state: 'passing', message: `pattern absent from ${rel}` };
      }
      case 'json_key': {
        const doc = parseJsonLenient(content);
        if (doc === INVALID_JSON) return { state: 'failing', message: `${rel} is not valid JSON` };
        const key = spec.key ?? '';
        return hasDotPath(doc, key)
          ? { state: 'passing', message: `${key} present in ${rel}` }
          : { state: 'failing', message: `${key} missing from ${rel}` };
      }
      case 'export_present': {
        const surface = this.k.ports.git.exportSurface(content, rel);
        if (!surface) return { state: 'error', message: `cannot analyse exports of ${rel}` };
        const symbol = spec.symbol ?? '';
        return surface.has(symbol)
          ? { state: 'passing', message: `${rel} exports ${symbol}` }
          : { state: 'failing', message: `${rel} no longer exports ${symbol}` };
      }
    }
  }

  /**
   * Evaluates a contract, stores the result and handles transitions: passing to failing opens a
   * critical conflict and notifies live sessions; failing to passing resolves it.
   */
  /**
   * `actorInRoot`: the edit that triggered this run was made in the project's own checkout. The
   * contract is checked against that checkout, so only then can a flip be the actor's doing.
   */
  run(
    contract: Contract,
    projectRoot: string,
    actor: Session | null,
    opts: { actorInRoot?: boolean } = {},
  ): Contract {
    return this.record(contract, this.evaluate(contract, projectRoot), actor, opts).contract;
  }

  /**
   * Stores one result of `contract` (the contract as it was before this result) and handles the
   * transition. The daemon records the results of command contracts through this too, so both
   * kinds open, announce and resolve a broken contract the same way. `broke` is true when this
   * result opened (or reopened) the conflict.
   *
   * A result of `error` (a timeout, a file too large to read) says nothing about the contract, so
   * a transition is judged against the last result that did: passing, error, failing is a break,
   * and failing, error, passing is a fix.
   */
  record(
    contract: Contract,
    result: ContractEvaluation,
    actor: Session | null,
    opts: { actorInRoot?: boolean } = {},
  ): { contract: Contract; broke: boolean } {
    const before = this.lastConclusive(contract);
    const saved = this.k.store.contracts.recordResult(contract.id, result.state, result.message);
    this.recordEvent(saved, result, actor?.id ?? null, contract.state);
    const fp = fingerprint('contract_broken', contract.id);
    let broke = false;
    if (before === 'passing' && result.state === 'failing') {
      broke = this.reportBroken(saved, result, fp, actor, opts.actorInRoot === true);
    } else if (before === 'failing' && result.state === 'passing') {
      this.resolveBroken(saved, fp, actor);
    }
    return { contract: saved, broke };
  }

  /**
   * The last state of `contract` that was passing or failing, read from the event log when the
   * stored state is neither. Null when the contract never had one (or it is no longer in the
   * log): then nothing can be said to have changed.
   */
  private lastConclusive(contract: Contract): 'passing' | 'failing' | null {
    if (contract.state === 'passing' || contract.state === 'failing') return contract.state;
    const results = this.k.store.events.query(contract.projectId, {
      types: ['contract.result'],
      order: 'desc',
      limit: CONCLUSIVE_LOOKBACK,
    });
    for (const e of results) {
      if (e.payload['contractId'] !== contract.id) continue;
      const state = e.payload['state'];
      if (state === 'passing' || state === 'failing') return state;
    }
    return null;
  }

  /** Runs every declarative contract reading `path`. */
  runForFile(
    projectId: string,
    projectRoot: string,
    path: string,
    actor: Session | null,
    opts: { actorInRoot?: boolean } = {},
  ): Contract[] {
    return this.k.store.contracts
      .forPath(projectId, path)
      .filter((c) => c.kind !== 'command')
      .slice(0, 100)
      .map((c) => this.run(c, projectRoot, actor, opts));
  }

  /** Bus entry point. Never throws. */
  async onFilesChanged(p: BusEvents['files.changed']): Promise<void> {
    let actorInRoot = false;
    await guarded(this.k, 'contracts', async () => {
      actorInRoot = (await this.k.ports.git.findRepoRoot(p.session.worktree)) === p.projectRoot;
    });
    for (const f of p.files.slice(0, 20)) {
      await guarded(this.k, 'contracts', () => {
        this.runForFile(p.projectId, p.projectRoot, f.path, p.session, { actorInRoot });
      });
    }
  }

  private recordEvent(
    c: Contract,
    r: ContractEvaluation,
    sessionId: string | null,
    previous: ContractState | null,
  ): void {
    this.k.store.events.append({
      projectId: c.projectId,
      sessionId,
      type: 'contract.result',
      payload: {
        contractId: c.id,
        memoryId: c.memoryId,
        kind: c.kind,
        state: r.state,
        previous,
        message: r.message,
      },
    });
  }

  private reportBroken(
    c: Contract,
    r: ContractEvaluation,
    fp: string,
    actor: Session | null,
    actorInRoot: boolean,
  ): boolean {
    const memory = this.k.store.memories.find(c.memoryId);
    const title = sanitizeLine(memory?.title ?? 'a recorded decision', 120);
    const headline = `${memory?.kind === 'decision' ? 'Decision' : 'Memory'} '${title}' no longer holds: ${r.message}`;
    const { conflict, isNew } = this.k.store.conflicts.report({
      projectId: c.projectId,
      kind: 'contract_broken',
      severity: 'critical',
      title: headline,
      detail:
        c.kind === 'command'
          ? 'An approved command contract started failing.'
          : `Contract ${c.kind} on ${c.spec.path ?? 'the project'} started failing.`,
      sessionIds: actor ? [actor.id] : [],
      paths: c.spec.path ? [c.spec.path] : [],
      fingerprint: fp,
    });
    if (!isNew) return false;
    this.k.store.events.append({
      projectId: c.projectId,
      sessionId: actor?.id ?? null,
      type: 'conflict.opened',
      // Who and what at this opening (the conflict row is overwritten when it is reported again).
      payload: {
        conflictId: conflict.id,
        kind: conflict.kind,
        title: conflict.title,
        sessionIds: conflict.sessionIds,
        paths: conflict.paths,
        actorInRoot: actor !== null && actorInRoot,
      },
    });
    const recipients = liveSessions(this.k, c.projectId).map((s) => s.id);
    if (actor && !recipients.includes(actor.id)) recipients.push(actor.id);
    if (recipients.length === 0) return true;
    this.telepathy.send({
      projectId: c.projectId,
      from: null,
      to: { sessionIds: recipients },
      kind: 'conflict',
      priority: 8,
      title: headline,
      body:
        c.kind === 'command'
          ? 'A recorded project decision is checked by a command the user approved, and that command now fails on the current working tree. Restore what it checks, or ask the user whether the decision should change.'
          : `A recorded project decision is checked automatically and the latest change to ${c.spec.path ?? 'the project'} broke it. Restore it, or ask the user whether the decision should change.`,
      dedupeKey: `contract:${c.id}:${conflict.updatedAt}`,
    });
    return true;
  }

  private resolveBroken(c: Contract, fp: string, actor: Session | null): void {
    const open = this.k.store.conflicts
      .list(c.projectId, { statuses: ['open', 'acknowledged'], limit: 500 })
      .filter((x) => x.kind === 'contract_broken' && x.fingerprint === fp);
    for (const x of open) {
      this.k.store.conflicts.setStatus(x.id, 'resolved');
      this.k.store.events.append({
        projectId: c.projectId,
        sessionId: actor?.id ?? null,
        type: 'conflict.updated',
        payload: { conflictId: x.id, kind: x.kind, status: 'resolved' },
      });
    }
  }
}

/**
 * Line-by-line match of a pattern that passed `checkSafePattern`, with a time budget. Returns
 * 'error' if the budget is exceeded. Lines end at LF or CRLF, so `$` works in either kind of file.
 */
function matchLines(pattern: string, content: string): boolean | 'error' {
  const whole = new RegExp(pattern, 'g');
  // A window that stops short of the line's end must leave its last character unmatched: that
  // keeps `$` from matching there and gives `\b` the real next character.
  const open = new RegExp(`(?:${pattern})(?=[^])`, 'g');
  const start = performance.now();
  let lineStart = 0;
  while (lineStart <= content.length) {
    let lineEnd = content.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = content.length;
    const end = lineEnd > lineStart && content[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd;
    const found = matchLine(whole, open, content.slice(lineStart, end), start);
    if (found !== false) return found;
    lineStart = lineEnd + 1;
  }
  return false;
}

/**
 * Matches one line. A line of up to `MATCH_WINDOW_CHARS` is matched whole. A longer one is matched
 * in windows of that size, each overlapping the one before by `MATCH_WINDOW_OVERLAP`, so the cost
 * stays bounded however long the line is. A window that does not start at the line's start only
 * accepts a match from its second character on, and one that does not reach the line's end must
 * leave its last character unmatched: every match found this way is a match in the full line
 * (`^`, `$` and `\b` see the real neighbours), and every match of the full line up to about
 * `MATCH_WINDOW_OVERLAP` characters long is found.
 */
function matchLine(whole: RegExp, open: RegExp, line: string, start: number): boolean | 'error' {
  const step = MATCH_WINDOW_CHARS - MATCH_WINDOW_OVERLAP;
  for (let at = 0; ; at += step) {
    const last = at + MATCH_WINDOW_CHARS >= line.length;
    const re = last ? whole : open;
    re.lastIndex = at === 0 ? 0 : 1;
    const text = at === 0 && last ? line : line.slice(at, at + MATCH_WINDOW_CHARS);
    if (re.test(text)) return true;
    if (performance.now() - start > PATTERN_BUDGET_MS) return 'error';
    if (last) return false;
  }
}

const INVALID_JSON = Symbol('invalid JSON');

/**
 * Parses JSON, also accepting what editors and compilers accept in files such as `tsconfig.json`:
 * a byte order mark, `//` and block comments, and a trailing comma before `}` or `]`.
 */
function parseJsonLenient(content: string): unknown {
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Not strict JSON: try it as JSON with comments.
  }
  try {
    return JSON.parse(stripJsonComments(text)) as unknown;
  } catch {
    return INVALID_JSON;
  }
}

/** Removes comments and trailing commas that are outside strings; everything else is kept. */
function stripJsonComments(text: string): string {
  let out = '';
  /** Index in `out` of a comma that so far is followed only by whitespace and comments. */
  let comma = -1;
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? text.length : close + 2;
      out += ' ';
      continue;
    }
    if (ch === '"') {
      const from = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      out += text.slice(from, ++i);
      comma = -1;
      continue;
    }
    if ((ch === '}' || ch === ']') && comma !== -1) {
      out = out.slice(0, comma) + out.slice(comma + 1);
    }
    if (ch === ',') comma = out.length;
    else if (!/\s/.test(ch)) comma = -1;
    out += ch;
    i++;
  }
  return out;
}

function hasDotPath(doc: unknown, key: string): boolean {
  let cur: unknown = doc;
  for (const part of key.split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, part)) return false;
    cur = (cur as Record<string, unknown>)[part];
  }
  return true;
}

/** Feature module: re-evaluates contracts bound to changed files. */
export const contractsModule = (mindly: Mindly): void => {
  const service = attachService(
    mindly,
    'contracts',
    new ContractService(mindly.kernel, mindly.telepathy),
  );
  mindly.bus.on('files.changed', 'contracts', async (p) => {
    await service.onFilesChanged(p);
  });
};

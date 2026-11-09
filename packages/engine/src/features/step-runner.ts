import { describeError, redactText, sanitizeForContext, type Checkpoint } from '@mindly/core';
import type { CommandSpec, StepGitPort, StepWorkspace } from '../ports.js';
import { BisectAborted, type BisectRunner, type StepCheck } from './bisect.js';

/*
 * Runs a command at one step in a scratch worktree: what `mindly bisect` and the sentinel do at
 * every step they test. The workspace and the process runner come from the `StepGitPort`.
 */

/** Characters of command output kept in run records and shown. */
export const OUTPUT_TAIL_CHARS = 4000;

// Terminal escape sequences (colours, cursor moves) in command output; the core sanitizers drop
// the escape character, this drops the whole sequence so no `[31m` residue is shown.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g;

/** The last `max` characters of process output, redacted and free of control characters. */
export function outputTail(text: string, max = OUTPUT_TAIL_CHARS): string {
  const redacted = redactText(text.replace(ANSI_RE, ''));
  return sanitizeForContext(redacted.slice(-max), max);
}

/** Options of a `StepCommandRunner`. */
export interface StepCommandRunnerOptions {
  /** The command under test. */
  command: CommandSpec;
  /** Installs dependencies in the scratch tree; runs before the first step and on manifest changes. */
  setup: CommandSpec | null;
  /** Commit the workspace's dependencies were last installed at (no setup before the first step). */
  setupAt?: string | null;
  signal: AbortSignal;
}

/**
 * Runs the command at a step in a scratch worktree. The setup command runs before the first step
 * (unless the tree was already set up) and again whenever the step checked out changes a lockfile
 * or manifest; untracked dependency folders stay in the scratch tree between checkouts.
 * Exit codes are read like `git bisect run`: 0 good, 125 skip, anything else bad; a timeout, an
 * error or a failed setup is a skip.
 */
export class StepCommandRunner implements BisectRunner {
  private setupAt: string | null;
  private setupOk: boolean;

  constructor(
    private readonly git: StepGitPort,
    private readonly ws: StepWorkspace,
    private readonly opts: StepCommandRunnerOptions,
  ) {
    this.setupAt = opts.setupAt ?? null;
    this.setupOk = this.setupAt !== null;
  }

  /** Commit the dependencies in the scratch tree were last installed at, or null. */
  get setupCommit(): string | null {
    return this.setupOk ? this.setupAt : null;
  }

  async run(step: Checkpoint): Promise<StepCheck> {
    const started = Date.now();
    const signal = this.opts.signal;
    const done = (
      partial: Pick<StepCheck, 'outcome' | 'skipReason' | 'exitCode' | 'output' | 'setupRan'>,
    ): StepCheck => ({ seq: step.seq, durationMs: Date.now() - started, ...partial });
    let setupRan = false;
    try {
      await this.ws.checkout(step.commit);
      if (this.opts.setup && (await this.needsSetup(step.commit))) {
        setupRan = true;
        const s = await this.git.run(this.ws.path, this.opts.setup, signal);
        if (signal.aborted) throw new BisectAborted();
        // A failed install is tried again at the next step rather than blaming that step's edit.
        this.setupOk = s.status === 'pass';
        this.setupAt = step.commit;
        if (!this.setupOk) {
          return done({
            outcome: 'skip',
            skipReason: 'setup_failed',
            exitCode: s.exitCode,
            output: outputTail(s.output),
            setupRan,
          });
        }
      }
      const c = await this.git.run(this.ws.path, this.opts.command, signal);
      if (signal.aborted) throw new BisectAborted();
      const output = outputTail(c.output);
      if (c.status === 'timeout') {
        return done({ outcome: 'skip', skipReason: 'timeout', exitCode: null, output, setupRan });
      }
      if (c.status === 'error') {
        return done({ outcome: 'skip', skipReason: 'error', exitCode: null, output, setupRan });
      }
      if (c.exitCode === 125) {
        return done({ outcome: 'skip', skipReason: 'exit_125', exitCode: 125, output, setupRan });
      }
      return done({
        outcome: c.status === 'pass' ? 'good' : 'bad',
        skipReason: null,
        exitCode: c.exitCode,
        output,
        setupRan,
      });
    } catch (err) {
      if (err instanceof BisectAborted || signal.aborted) throw new BisectAborted();
      return done({
        outcome: 'skip',
        skipReason: 'error',
        exitCode: null,
        output: outputTail(describeError(err)),
        setupRan,
      });
    }
  }

  /** Setup is due when it never succeeded, or a lockfile or manifest changed since it ran. */
  private async needsSetup(commit: string): Promise<boolean> {
    if (!this.setupOk || this.setupAt === null) return true;
    if (this.setupAt === commit) return false;
    try {
      const changed = await this.git.changedPaths(this.ws.path, this.setupAt, commit);
      return changed.some((p) => this.git.isManifestPath(p));
    } catch {
      // The commit it ran at is gone (pruned): install again rather than guess.
      return true;
    }
  }
}

/** The exit status for a command cut off while it is still running; null when none is running. */
let cutOffStatus: number | null = null;

/**
 * Declares that a command is running (`status`: what to exit with if its reader goes away before
 * it is done) or has finished (null).
 */
export function whileRunning(status: number | null): void {
  cutOffStatus = status;
}

/**
 * A reader that goes away early (`mindly init | head -1`) closes the pipe; the next write then
 * fails with EPIPE. That is the reader's choice, not an error: stop quietly. The exit status is a
 * failing one the command already set; else, while the command is still running, the cut-off
 * status it declared (it did not get to finish, like a process ended by SIGPIPE); else 0.
 */
export function quietOnClosedPipe(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE') throw err;
      const set = Number(process.exitCode ?? 0);
      process.exit(Number.isInteger(set) && set !== 0 ? set : (cutOffStatus ?? 0));
    });
  }
}

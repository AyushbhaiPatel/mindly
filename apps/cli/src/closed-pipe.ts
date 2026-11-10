/**
 * A reader that goes away early (`mindly init | head -1`) closes the pipe; the next write then
 * fails with EPIPE. That is the reader's choice, not an error: stop quietly.
 */
export function quietOnClosedPipe(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') process.exit(0);
      throw err;
    });
  }
}

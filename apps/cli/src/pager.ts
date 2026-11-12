import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mindlyHome, resolveLayout } from '@mindly/core';
import { notifyOutbox, type Mindly } from '@mindly/engine';

/**
 * After a hook has answered: when it wrote a notification to the pager outbox and no sender is
 * running, starts one detached `mindly notify flush` to send it, and returns at once. The sender
 * has the time to wait for the pager and record the answer, so nothing is sent twice because a
 * process ended before the answer came. A sender that is already running picks the notification
 * up. Hooks that raised nothing do nothing here.
 *
 * It is started whether or not a daemon runs: a daemon reads its channels when it starts, so it
 * may not know the ones configured since. Each attempt holds a lease, so a sender next to a daemon
 * sends nothing twice. It runs in the Mindly home, so it never holds a project folder open. Never
 * throws.
 */
export function startPagerSender(
  mindly: Pick<Mindly, 'hooks' | 'close'>,
  env: NodeJS.ProcessEnv,
): void {
  try {
    if (!notifyOutbox(mindly as Mindly).needsSender()) return;
    const main = resolveLayout(import.meta.url).cliMain;
    if (!existsSync(main)) return;
    const child = spawn(process.execPath, [main, 'notify', 'flush'], {
      cwd: senderDir(env),
      detached: true,
      stdio: 'ignore',
      env,
      windowsHide: true,
    });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // The notification stays in the outbox for the daemon or the next sender.
  }
}

function senderDir(env: NodeJS.ProcessEnv): string {
  try {
    const home = mindlyHome(env);
    return existsSync(home) ? home : tmpdir();
  } catch {
    return tmpdir();
  }
}

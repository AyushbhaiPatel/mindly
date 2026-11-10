import { homePaths, mindlyHome, unusableNotifyChannels } from '@mindly/core';
import { notifyOutbox } from '@mindly/engine';
import { openMindly } from '@mindly/runtime';
import { clean, HintedError, type Out } from '../util.js';

const REASONS: Record<string, string> = {
  unsupported: 'this system has no desktop notifications Mindly can use',
  rate_limited: 'too many notifications failed in the last hour; try again later',
};

/**
 * `mindly notify test`: sends one fixed notification through every configured channel and says
 * what each did. It does not depend on `notify.triggers`, on what was sent before or on the
 * hourly budget, so it answers one question: does this channel work.
 */
export async function notifyTest(out: Out, o: { json?: boolean }): Promise<number> {
  // Commands normally run without the pager; this one is about it.
  const mindly = openMindly({ env: out.io.env });
  try {
    // Channels the config file holds with a URL that cannot be used are left out when it is read.
    const unusable = unusableNotifyChannels(homePaths(mindlyHome(out.io.env)).config);
    if (mindly.config.notify.channels.length === 0) {
      const first = unusable[0];
      throw new HintedError(
        'invalid_input',
        first
          ? `the ${first.type} channel in your config cannot be used: ${first.problem}`
          : 'no notification channel is configured',
        first
          ? "Set it again with: mindly config set notify.channels '[…]'"
          : `Add one with: mindly config set notify.channels '[{"type":"desktop"}]'`,
      );
    }
    const results =
      (await mindly.kernel.ports.notifier.send(
        {
          trigger: 'standup',
          title: 'Mindly test notification',
          body: 'If you can read this, the channel works.',
          priority: 'low',
        },
        { ignoreTriggers: true, bypassLimits: true },
      )) ?? [];
    const failed = results.filter((r) => r.status !== 'sent');
    const ok = failed.length === 0 && unusable.length === 0;
    if (o.json) {
      out.json({
        ok,
        channels: results,
        ...(unusable.length > 0 ? { unusable } : {}),
      });
      return ok ? 0 : 1;
    }
    const sc = out.screen();
    for (const u of unusable) {
      sc.text(`${sc.mark('fail')} ${u.type}: left out, its ${u.problem}`);
    }
    for (const r of results) {
      if (r.status === 'sent') {
        sc.text(`${sc.mark('ok')} ${r.channel}: sent`);
      } else {
        const why = REASONS[r.reason ?? ''] ?? clean(r.reason ?? 'failed', 120);
        sc.text(`${sc.mark(r.status === 'failed' ? 'fail' : 'warn')} ${r.channel}: ${why}`);
      }
    }
    if (!ok) sc.note('Check the channels with: mindly config get notify.channels', 2);
    return ok ? 0 : 1;
  } finally {
    mindly.close();
  }
}

/** How long a `notify flush` started by a hook stays around for the next attempt. */
export const FLUSH_WINDOW_MS = 3 * 60_000;

/**
 * `mindly notify flush` (internal): sends what waits in the pager outbox. A hook that raised a
 * notification starts it detached. It waits for each answer, so a result is never lost, and stays
 * for the retries that fall within a few minutes (30 s, then 2 min); later ones are made by the
 * daemon or the next sender. When another process is flushing, it leaves the work to that one.
 */
export async function notifyFlush(out: Out, windowMs: number = FLUSH_WINDOW_MS): Promise<number> {
  const mindly = openMindly({ env: out.io.env });
  try {
    const outbox = notifyOutbox(mindly);
    const started = Date.now();
    for (;;) {
      const left = windowMs - (Date.now() - started);
      const r = await outbox.flush({ budgetMs: Math.max(left, 0) + 1 });
      if (r.busy || r.waiting === 0) return 0;
      const next = outbox.nextDueAt();
      if (next === null) return 0;
      const wait = Math.max(next - mindly.kernel.clock.now(), 0) + 250;
      if (Date.now() - started + wait >= windowMs) return 0;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  } finally {
    mindly.close();
  }
}

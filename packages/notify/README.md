# @mindly/notify

The Mindly "phone pager": short status notifications when an agent is blocked, rate limited,
and so on. **Off by default**: nothing is sent until channels are configured.

## Configuration

`UserConfig.notify`:

```json
{
  "notify": {
    "channels": [
      { "type": "desktop" },
      { "type": "ntfy", "url": "https://ntfy.sh", "topic": "my_private_topic_123" },
      { "type": "webhook", "url": "https://example.com/mindly-hook" }
    ],
    "triggers": ["agent_blocked", "rate_limited"]
  }
}
```

```ts
import { createNotifier } from '@mindly/notify';

const pager = createNotifier(config.notify);
await pager.send({ trigger: 'agent_blocked', title: 'Agent waiting', body: '2 sessions idle' });
```

`send()` never throws; it returns one `SendResult` per channel (`sent`, `skipped` with
`trigger_disabled` / `deduped` / `rate_limited` / `unsupported`, or `failed`).

## Channels

- `desktop`: macOS runs `osascript -e <fixed script> -- <title> <body> <project>`; the text is
  read from `argv` inside `on run argv` and never interpolated into AppleScript source. Linux runs
  `notify-send -- <title> <body>`. Windows is reported as `unsupported`.
- `ntfy`: `POST <url>/<topic>`, plain-text body, `Title`/`Priority`/`Tags` headers.
- `webhook`: `POST` JSON `{ trigger, title, body, project, ts }`.

## Security notes

- **Callers must never pass code, diffs, prompt text or transcripts.** Send a status line and
  counts. As a backstop every field is redacted with core `redact()`, flattened to one line and
  capped (title 80, body 240, project 60 characters).
- **ntfy headers**: control characters (including CR/LF) are removed, so header injection is
  impossible. Non-ASCII values are sent as RFC 2047 encoded words (`=?UTF-8?B?...?=`), which ntfy
  decodes; the body is UTF-8 plain text.
- **Transport**: `https:` is required except for loopback hosts; URLs with embedded credentials
  are refused; redirects are never followed (`redirect: 'error'`); 5 s timeout. Errors never echo
  the URL, which may contain a secret path.
- **Rate limits** (in memory): the same `dedupeKey` at most once per 10 minutes, at most 30
  notifications per hour overall.
- Processes are started with `execFile` and an argument array only, never a shell.

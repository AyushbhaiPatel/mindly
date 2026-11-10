import { describe, expect, it } from 'vitest';
import { detectRateLimit, type NoticeSource } from '../../src/index.js';

/*
 * Every limit notice and every near miss the detector has been checked against, in one table.
 * Each change to the detector runs against all of it, so a fix for a missed handoff cannot
 * quietly bring back a false one, or the other way round.
 *
 * - ACCOUNT: notices that name the account's own limit. They count from the client's error
 *   reports and as the end of what the assistant wrote.
 * - CLIENT: the vocabulary of any rate-limited API. It counts only from the client's own error
 *   reports (or a one-line message under the client's "API Error" prefix).
 * - NOT_A_LIMIT_FROM_CLIENT / NOT_A_LIMIT_FROM_ASSISTANT: what must never hand the work off.
 *
 * The wordings are collected from what each client has been seen to print; they are not
 * checked against the current release of each CLI.
 */

const KINDS = ['claude-code', 'codex', 'gemini', 'cursor'];

const ACCOUNT: [kind: string, text: string, id: string][] = [
  // Claude Code
  [
    'claude-code',
    'Claude usage limit reached. Your limit will reset at 3pm.',
    'claude.usage_limit_reached',
  ],
  ['claude-code', 'Claude AI usage limit reached|1712345678', 'claude.usage_limit_reached'],
  [
    'claude-code',
    'Claude usage limit reached. Your limit will reset at 3pm (America/New_York).',
    'claude.usage_limit_reached',
  ],
  [
    'claude-code',
    'Claude usage limit reached. Your limit will reset at 5pm (America/Los_Angeles). To continue now, upgrade to Max.',
    'claude.usage_limit_reached',
  ],
  ['claude-code', 'Your limit will reset at 3pm (Europe/Berlin).', 'claude.limit_will_reset'],
  ['claude-code', '5-hour limit reached ∙ resets 5pm', 'claude.five_hour_limit'],
  ['claude-code', '⎿  5-hour limit reached ∙ resets 2am', 'claude.five_hour_limit'],
  ['claude-code', 'You’ve hit your session limit · resets 3pm', 'claude.limit_reached'],
  ['claude-code', 'Weekly limit reached ∙ resets Mon 9am', 'claude.limit_reached'],
  ['claude-code', 'Session limit reached ∙ resets 5pm', 'claude.limit_reached'],
  ['claude-code', 'Opus weekly limit reached ∙ resets Oct 9, 5pm', 'claude.limit_reached'],
  ['claude-code', 'You’ve hit your limit · resets 10pm (Asia/Tokyo)', 'claude.limit_reached'],
  ['claude-code', "You've hit your limit ∙ resets 4am", 'claude.limit_reached'],
  [
    'claude-code',
    "You've hit your limit · resets 10pm (Europe/London) · /upgrade to increase your usage limit.",
    'claude.limit_reached',
  ],
  [
    'claude-code',
    'You’ve hit your limit · resets 10pm\n/upgrade to increase your usage limit.',
    'claude.limit_reached',
  ],
  [
    'claude-code',
    "You've hit your weekly limit · resets Oct 9, 5pm. To keep going, send a request to your admin or try again in 3 hours.",
    'claude.limit_reached',
  ],
  ['claude-code', "You've reached your usage limit", 'generic.usage_limit'],
  ['claude-code', '[12:03:11] Usage limit reached', 'claude.usage_limit_reached'],
  ['claude-code', '2026-01-01T12:00:00Z Usage limit reached.', 'claude.usage_limit_reached'],
  ['claude-code', '[2026-01-01 12:00:00] [error] Weekly limit reached', 'claude.limit_reached'],
  // Codex
  [
    'codex',
    "You've hit your usage limit. Upgrade to Pro or try again in 3 hours.",
    'codex.usage_limit',
  ],
  ['codex', '⚠ You’ve hit your usage limit. Try again at 3pm', 'codex.usage_limit'],
  ['codex', "You've hit your usage limit. Try again later.", 'codex.usage_limit'],
  [
    'codex',
    "You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 5:12 PM.",
    'codex.usage_limit',
  ],
  [
    'codex',
    "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://openai.com/chatgpt/pricing), or try again at 5:12 PM.",
    'codex.usage_limit',
  ],
  [
    'codex',
    "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Nov 12th, 2025 3:04 PM.",
    'codex.usage_limit',
  ],
  [
    'codex',
    "You've hit your usage limit. To get more access now, send a request to your admin or try again at 5:12 PM.",
    'codex.usage_limit',
  ],
  [
    'codex',
    'You exceeded your current quota, please check your plan and billing details.',
    'generic.quota_used_up',
  ],
  [
    'codex',
    'You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.',
    'generic.quota_used_up',
  ],
  // Gemini CLI
  ['gemini', 'You have exhausted your daily quota on this model.', 'gemini.quota_exhausted'],
  ['gemini', 'You have exhausted your daily quota on gemini-2.5-pro.', 'gemini.quota_exhausted'],
  [
    'gemini',
    'You have exhausted your daily quota on gemini-flash-latest.',
    'gemini.quota_exhausted',
  ],
  ['gemini', 'You have exhausted your daily quota for today.', 'gemini.quota_exhausted'],
  [
    'gemini',
    'You have exhausted your capacity on this model. Your quota will reset after 2h.',
    'gemini.quota_exhausted',
  ],
  [
    'gemini',
    'You have exhausted your capacity on gemini-2.5-flash. Your quota will reset after 2h1m30s.',
    'gemini.quota_exhausted',
  ],
  // Cursor
  ['cursor', "You've hit your usage limit", 'generic.usage_limit'],
  ['cursor', '✗ Usage limit reached', 'generic.usage_limit'],
  ['cursor', "You've hit your usage limit\nTry again at 5pm.", 'generic.usage_limit'],
  [
    'cursor',
    "You've hit your usage limit. Your usage limits will reset when your monthly cycle ends on 12/1/2025.",
    'generic.usage_limit',
  ],
  [
    'cursor',
    "You've hit your usage limit. Get Cursor Pro for more Agent usage, unlimited Tab, and more.",
    'generic.usage_limit',
  ],
];

const CLIENT: [kind: string, text: string, id: string][] = [
  ['claude-code', 'API Error: 429 Too Many Requests', 'claude.http_429'],
  [
    'claude-code',
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}',
    'claude.rate_limit_error',
  ],
  [
    'claude-code',
    'API Error: Request rejected (429) · rate_limit_error',
    'claude.rate_limit_error',
  ],
  [
    'claude-code',
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit for your organization of 30,000 input tokens per minute. For details, refer to: https://docs.claude.com/en/api/rate-limits. You can see the response headers for current usage. Please reduce the prompt length or the maximum tokens requested, or try again later."}}',
    'claude.rate_limit_error',
  ],
  ['claude-code', 'API Error: 429 Too Many Requests (api.anthropic.com)', 'claude.http_429'],
  ['codex', 'stream error: rate limit reached, retry in 30s', 'codex.rate_limit'],
  ['codex', '■ stream error: rate limit reached', 'codex.rate_limit'],
  ['codex', 'stream error: rate limit reached for gpt-5', 'codex.rate_limit'],
  ['codex', 'Rate limited. Please try again in 20s.', 'codex.rate_limit'],
  [
    'codex',
    'Rate limit reached for gpt-5 in organization org-abc on tokens per min. Please try again in 2s.',
    'codex.rate_limit',
  ],
  [
    'codex',
    'stream error: rate limit reached for gpt-5 in organization org-abc on tokens per min (TPM). Please try again in 2s. Visit https://platform.openai.com/account/rate-limits to learn more.',
    'codex.rate_limit',
  ],
  [
    'codex',
    'unexpected status 429 Too Many Requests: {"error":{"message":"Rate limit reached","type":"rate_limit_exceeded"}} url: https://myco.openai.azure.com/openai/responses',
    'codex.http_429',
  ],
  ['codex', 'exceeded retry limit, last status: 429 Too Many Requests', 'codex.retry_limit'],
  ['gemini', 'Resource has been exhausted (e.g. check quota).', 'gemini.resource_exhausted'],
  ['gemini', '[API Error: got status: RESOURCE_EXHAUSTED]', 'gemini.resource_exhausted_status'],
  ['gemini', '✕ [API Error: got status: RESOURCE_EXHAUSTED]', 'gemini.resource_exhausted_status'],
  [
    'gemini',
    '[API Error: {"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.","status":"RESOURCE_EXHAUSTED"}}]',
    'gemini.resource_exhausted_status',
  ],
  ['cursor', 'Error: Rate limit exceeded. Try again in 5 minutes.', 'generic.rate_limit'],
  ['cursor', 'ERROR  rate limit exceeded', 'generic.rate_limit'],
  ['cursor', 'Rate limit exceeded.', 'generic.rate_limit'],
  ['cursor', 'Rate limited.', 'generic.rate_limit'],
  ['cursor', 'Error: rate limit exceeded for the OpenAI API', 'generic.rate_limit'],
  ['cursor', 'Quota exceeded.', 'generic.quota_exceeded'],
  ['cursor', '│ 🚫 Fatal: quota exceeded', 'generic.quota_exceeded'],
  ['cursor', 'HTTP 429 Too Many Requests', 'generic.too_many_requests'],
  ['cursor', '429 Too Many Requests', 'generic.too_many_requests'],
  ['cursor', 'Request failed: 429 Too Many Requests', 'generic.too_many_requests'],
  ['cursor', 'Warning: usage limit reached, resets at 5pm', 'generic.usage_limit'],
  ['cursor', 'WARN rate limited; backing off for 2s', 'generic.rate_limit'],
  ['cursor', 'Failed: rate limit exceeded', 'generic.rate_limit'],
];

/** Errors a client reports that are not the agent's own limit. */
const NOT_A_LIMIT_FROM_CLIENT = [
  // Another service's limit.
  'Error: rate limit exceeded for api.github.com',
  'rate limit exceeded for the GitHub API',
  'Error: rate limit exceeded for the GitHub API',
  'HTTP 429 Too Many Requests from registry.npmjs.org',
  'Too many requests to https://api.stripe.com/v1/charges',
  // The client is still trying.
  'Rate limited, retrying in 30s.',
  '429 Too Many Requests; retrying 1/5 in 205ms',
  'stream error: rate limit reached; retry 2/5',
  'Usage limit reached, retrying shortly',
  'API Error: 429 Too Many Requests (attempt 3 of 10)',
  // Errors with no limit in them.
  'Stop hook failed with exit code 1',
  'API Error: 500 Internal Server Error',
];

/** Endings of ordinary answers: the assistant writing about limits, not hitting one. */
const NOT_A_LIMIT_FROM_ASSISTANT = [
  // API vocabulary, however short.
  'Rate limit exceeded.',
  '429 Too Many Requests',
  'Quota exceeded.',
  'Error: rate limit exceeded',
  'Rate limited.',
  'Too many requests.',
  'HTTP 429',
  'Done. The API returns:\n\nToo many requests',
  'Working on it.\n\nAPI Error: 429 Too Many Requests',
  'Done. The /login endpoint is now rate limited to 5 attempts per minute per IP.',
  'I added a handler that returns HTTP 429 with a Retry-After header.',
  'The client now retries when the server responds with "Too Many Requests".',
  'Fixed: the test expected rate_limit_error but the mock returned overloaded_error.',
  'Added a quota exceeded banner to the billing page.',
  // Lines written about something: quotations, lists, test results, logs, comments, diffs.
  '✅ Rate limit exceeded: the API now answers 429 with a Retry-After header',
  '"Rate limit exceeded." is what the API now returns when the bucket is empty.',
  '“Usage limit reached.” is the banner text I added to the billing page.',
  "'Too many requests.' is shown to the user after five failed logins.",
  '✓ rate limit exceeded (3 ms)',
  '✗ rate limit exceeded: expected 429, got 200',
  '❌ Quota exceeded: this case is still not handled',
  '- [x] Rate limit exceeded: return 429 with Retry-After',
  '- Rate limit exceeded: return 429',
  '## Rate limit exceeded',
  '[warn] quota exceeded: the nightly export skipped 3 tenants',
  '2026-01-01 12:00:00 WARN rate limited, backing off',
  '// Rate limit exceeded: back off and retry',
  '+ Rate limit exceeded. Please retry later.',
  'Warning: rate limit exceeded, so the importer now sleeps between batches.',
  'Warning: usage limit reached, resets at 5pm',
  '12:30 Usage limit reached: discussed in standup',
  'Warning: "rate_limit_error" is the type the mock returns.',
  'Summary:\n- Rate limit exceeded handling added to the client\n- Rate limited the export job',
  'The run failed with:\n```\nError: rate limit exceeded\nHTTP 429 Too Many Requests\n```',
  // An account wording opening a sentence that goes on about something else.
  'Your limit will reset at midnight UTC, and the new resetAt field in the response says exactly when.',
  'You have exhausted your daily quota once 100 requests are made, which the new test asserts.',
  'You have exhausted your daily quota on the billing page.',
  'Usage limit reached is now a typed error (`UsageLimitError`).',
  'Usage limit reached in the billing module is now logged.',
  "You've hit your usage limit when the counter passes 100, so the banner shows.",
  'Usage limit reached. Try again at 5pm. Meanwhile I fixed the tests.',
  `Usage limit reached. ${'x'.repeat(400)}`,
  // ...or followed by sentences that only mention a plan, the docs, a setting, or code.
  'Usage limit reached — the banner now shows the plan name.',
  'Usage limit reached. The settings page lists the quota.',
  'Usage limit reached: users wait in a queue now.',
  "You've hit your usage limit · the docs explain the billing cycle.",
  'Usage limit reached. Retry logic added in src/limit.ts.',
  'Usage limit reached. Upgrade path is documented in docs/limits.md.',
  'Usage limit reached. The `retry` helper now waits.',
  'Usage limit reached. Then I fixed the tests.',
  'Usage limit reached. Upgrade the plan table next.',
  'Limit reached. Check the plan output above before retrying.',
  // A notice line followed by prose under it.
  'Usage limit reached.\nI will pick this up after lunch.',
  'Usage limit reached.\nI updated the billing docs.',
  'I finished the refactor.\nUsage limit reached.\nContact the platform team if the plan changes.',
  'The banner now has an over-quota state. When the counter hits zero it shows\nWeekly limit reached\nVisit the settings page to see the new plan badge.',
  // A notice quoted after the prose that introduces it.
  "The banner now reads:\nYou've hit your usage limit. Upgrade to Pro or try again later.",
  "The banner now reads:\n\nYou've hit your usage limit. Upgrade to Pro or try again later.",
  'The banner now reads:\nUsage limit reached. Try again at 5pm.',
  'When the counter hits zero the page shows\nWeekly limit reached ∙ resets Mon 9am',
  // The tail of a notice on its own.
  '/upgrade to increase your usage limit.',
  'Try again at 5pm.',
];

const LONG_ANSWER = [
  'I moved the session store behind an interface and switched login over to it.',
  'The old cookie path is still there for the two callers that have not been migrated,',
  'and the tests for both paths pass. What is left is the logout flow and the admin',
  'impersonation path, which reads the cookie directly in three places.',
].join('\n');

type Case = [kind: string, text: string, source: NoticeSource, expected: string | null];

function corpus(): Case[] {
  const out: Case[] = [];
  for (const [kind, text, id] of ACCOUNT) {
    out.push([kind, text, 'client', id], [kind, `⚠ ${text}`, 'client', id]);
    // The end of what the assistant wrote, alone or after an answer.
    out.push([kind, text, 'assistant', id], [kind, `${LONG_ANSWER}\n\n${text}`, 'assistant', id]);
    // Not when the answer goes on after it, or the notice is quoted.
    out.push(
      [kind, `${text}\n\n${LONG_ANSWER}`, 'assistant', null],
      [kind, `The banner now reads:\n${text}`, 'assistant', null],
      [kind, `When the counter hits zero the page shows\n${text}`, 'assistant', null],
    );
  }
  for (const [kind, text, id] of CLIENT) {
    out.push([kind, text, 'client', id], [kind, `[12:03:11] ${text}`, 'client', id]);
    // From the assistant only as the one line a client writes in place of an answer.
    const ownLine = !text.includes('\n') && /^\W*\[?API Error\b/.test(text);
    out.push(
      [kind, text, 'assistant', ownLine ? id : null],
      [kind, `${LONG_ANSWER}\n\n${text}`, 'assistant', null],
    );
  }
  for (const kind of KINDS) {
    for (const text of NOT_A_LIMIT_FROM_CLIENT) out.push([kind, text, 'client', null]);
    for (const text of NOT_A_LIMIT_FROM_ASSISTANT) {
      out.push(
        [kind, text, 'assistant', null],
        [kind, `${LONG_ANSWER}\n\n${text}`, 'assistant', null],
      );
    }
  }
  return out;
}

describe('limit notice corpus', () => {
  it('detects every notice and nothing else', () => {
    const cases = corpus();
    expect(cases.length).toBeGreaterThan(900);
    const wrong = cases
      .map(([kind, text, source, expected]) => ({
        kind,
        source,
        text,
        expected,
        got: detectRateLimit(kind, [text], source),
      }))
      .filter((c) => c.got !== c.expected);
    expect(wrong).toEqual([]);
  });
});

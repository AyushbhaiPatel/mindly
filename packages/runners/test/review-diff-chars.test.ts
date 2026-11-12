import { describe, expect, it } from 'vitest';
import { prepareDiff } from '../src/review.js';

describe('a diff prepared for review', () => {
  it('is not reported as truncated for an emoji or a byte order mark', () => {
    const diff = '--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-Warning\n+﻿⚠️ Warning\n';
    const r = prepareDiff(diff);
    expect(r.truncated).toBe(false);
    expect(r.text).not.toContain('[diff truncated by Mindly');
  });

  it('keeps the bidi and zero-width characters a reviewer must see', () => {
    // CVE-2021-42574 style: RLO/LRI hide the real logic from a human reader.
    const diff =
      '+++ b/auth.ts\n+  if (role != "user‮ ⁦// check admin⁩ ⁦") {\n+  if (name === "admin​") {\n';
    const r = prepareDiff(diff);
    expect(r.text).toContain('‮');
    expect(r.text).toContain('​');
  });
});

describe('a diff prepared for review, with a secret', () => {
  it('replaces only the secret and keeps the hidden characters around it', () => {
    const token = ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('_');
    const diff = `+const t = "${token.slice(0, 8)}\u200b${token.slice(8)}"; // \u202e note\n`;
    const r = prepareDiff(diff);
    expect(r.redactions).toBe(1);
    expect(r.text).toContain('"[REDACTED]"');
    expect(r.text).toContain('\u202e note');
    expect(r.truncated).toBe(false);
  });
});

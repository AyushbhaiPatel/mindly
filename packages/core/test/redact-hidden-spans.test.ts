// Redaction keeps every character outside a secret, whatever the text after the secret looks like.
import { describe, expect, it } from 'vitest';
import { redact, REDACTED, redactText } from '../src/redact.js';

const KEY_CRLF =
  '-----BEGIN RSA PRIVATE KEY-----\r\nMIIEpAIBAAKCAQEA1234567890abcdef\r\nAbCdEf0123456789xyz\r\n-----END RSA PRIVATE KEY-----\r\n';
const JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

describe('characters around a secret', () => {
  it('a CRLF private key keeps its CRLF after the marker', () => {
    expect(redactText(KEY_CRLF)).toBe(`${REDACTED}\r\n`);
  });
  it('a diff ending in a key keeps its bidi controls', () => {
    const diff =
      '+const s = "\u202eabc\u202c";\n+-----BEGIN RSA PRIVATE KEY-----\n+MIIEpAIBAAKCAQEA\n+-----END RSA PRIVATE KEY-----\n';
    expect(redactText(diff)).toContain('\u202e');
  });
  it('emoji joiners survive a JWT at the end of a sentence', () => {
    const text = `family 👨\u200d👩\u200d👧 token ${JWT}.`;
    expect(redactText(text)).toBe(`family 👨\u200d👩\u200d👧 token ${REDACTED}.`);
  });
  it('keeps the hidden characters between secrets and drops those inside them', () => {
    const t1 = ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('_');
    const t2 = ['ghp', 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2'].join('_');
    const split = `${t1.slice(0, 7)}\u200b${t1.slice(7)}`;
    const text = `a ${split}\u200d \u202e${t2}\u202c.\r\n👨\u200d👩`;
    expect(redactText(text)).toBe(`a ${REDACTED}\u200d \u202e${REDACTED}\u202c.\r\n👨\u200d👩`);
  });
  it('replaces what only one copy finds and what both find, once each', () => {
    const key = 'AKIAIOSFODNN7EXAMPLE';
    const gh = ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('_');
    const text = `x\u0000${key} y ${gh.slice(0, 9)}\u200b${gh.slice(9)} z ${key}\r`;
    expect(redactText(text)).toBe(`x\u0000${REDACTED} y ${REDACTED} z ${REDACTED}\r`);
  });
});

describe('credentials on a command line, in text with hidden characters', () => {
  const zw = '​';

  it('replaces the credential and keeps a hidden character elsewhere in the text', () => {
    const r = redact(`note${zw} here\ncurl -u alice:s3cretPassw0rd https://example.com/x`);
    expect(r.text).toBe(`note${zw} here\ncurl -u alice:${REDACTED} https://example.com/x`);
    expect(r.kinds).toEqual(['cli_credentials']);
  });

  it('finds the client when a hidden character splits its name', () => {
    const r = redact(`cu${zw}rl -u alice:s3cretPassw0rd https://example.com/x`);
    expect(r.text).toBe(`cu${zw}rl -u alice:${REDACTED} https://example.com/x`);
  });

  it('replaces a credential a hidden character splits, next to a token', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const r = redact(`curl -u alice:s3cr${zw}etPassw0rd https://example.com/x and ${token}`);
    expect(r.text).toBe(`curl -u alice:${REDACTED} https://example.com/x and ${REDACTED}`);
    expect(r.count).toBe(2);
  });
});

import { describe, expect, it } from 'vitest';
import { REDACTED, redact, redactDeep } from '../src/redact.js';

// Built at run time so no token-shaped literal sits in the repository.
const FAKE_GITHUB = `ghp_${'a'.repeat(36)}`;

describe('redact', () => {
  const cases: [string, string][] = [
    ['anthropic', 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123'],
    ['openai', 'OPENAI sk-proj-abcdefghijklmnopqrstuvwxyz0123'],
    ['aws', 'id AKIAIOSFODNN7EXAMPLE here'],
    ['github', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['slack', 'xoxb-1234567890-abcdefghij'],
    ['stripe', 'sk_live_abcdefghijklmnop1234'],
    ['google', 'AIzaSyA1234567890abcdefghijklmnopqrstuv'],
    ['npm', 'npm_abcdefghijklmnopqrstuvwxyz0123456789'],
    [
      'jwt',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    ],
  ];
  it.each(cases)('removes %s tokens', (_name, input) => {
    const out = redact(input);
    expect(out.count).toBeGreaterThan(0);
    expect(out.text).toContain(REDACTED);
  });

  it('keeps variable names in assignments', () => {
    const out = redact('DATABASE_PASSWORD=hunter2hunter2 and api_key: "abcdef123456"');
    expect(out.text).toBe(`DATABASE_PASSWORD=${REDACTED} and api_key: "${REDACTED}"`);
  });

  it.each([
    'function login(user: string, password: string) {',
    'def login(password: str) -> bool:',
    'const password = process.env.DB_PASSWORD;',
    'apiKey: config.apiKey,',
    'token: Optional[str] = None',
    'type Creds = { password: SecretString }',
    'login(password: Password, user: User)',
    'password: Password | null',
    'interface Creds {\n  password: Password\n}',
  ])('leaves code that only names secrets alone: %s', (code) => {
    expect(redact(code).count).toBe(0);
  });

  it('still redacts literal values next to secret names', () => {
    expect(redact('password: Hunter2024!').count).toBe(1);
    expect(redact('const token = "abc123def456"').count).toBe(1);
    expect(redact('password = Summerwind').count).toBe(1);
    expect(redact('PASSWORD=string').count).toBe(1);
  });

  it('redacts a capitalised value that stands alone after the name', () => {
    expect(redact('password: CorrectHorseBatteryStaple').text).toBe(`password: ${REDACTED}`);
    expect(redact('secret:Wintermute\nuser: admin').text).toBe(`secret:${REDACTED}\nuser: admin`);
  });

  it('redacts a value that runs into a token redacted by an earlier rule', () => {
    const query = redact(
      `https://x.test/cb?client_secret=hunter2SecretValue9&token=${FAKE_GITHUB}`,
    );
    expect(query.text).not.toContain('hunter2SecretValue9');
    expect(query.text).not.toContain(FAKE_GITHUB);
    const joined = redact(`DB_PASSWORD=hunter2SecretValue9:${FAKE_GITHUB}`);
    expect(joined.text).toBe(`DB_PASSWORD=${REDACTED}`);
    // A value that is nothing but an earlier redaction is left as it is.
    expect(redact(`(password=${FAKE_GITHUB})`).text).toBe(`(password=${REDACTED})`);
  });

  it('takes a quoted value whole, spaces and punctuation included', () => {
    expect(redact('db_password = "p@ss,word-1234567"').text).toBe(`db_password = "${REDACTED}"`);
    expect(redact('"password": "correct horse battery staple"').text).toBe(
      `"password": "${REDACTED}"`,
    );
    expect(redact("api_key: 'abc def,ghi 123'").text).toBe(`api_key: '${REDACTED}'`);
  });

  it.each([
    'passwordPlaceholder="Enter your password"',
    'token_type: "Bearer access"',
    "passwordLabel: 'Your password'",
    'passwordError = "Passwords do not match"',
    '"password_hint": "At least twelve characters"',
    "apiKeyDescription: 'Shown once after you create the key'",
  ])('leaves quoted display text next to a secret-like name alone: %s', (code) => {
    expect(redact(code)).toEqual({ text: code, count: 0, kinds: [] });
  });

  it('still redacts single-word quoted values whatever the name ends in', () => {
    // Without a space in it the value is treated as before, display name or not.
    expect(redact('token_type: "abc123def456"').text).toBe(`token_type: "${REDACTED}"`);
    expect(redact("passwordHint = 'Summerwind'").text).toBe(`passwordHint = '${REDACTED}'`);
    expect(redact('"db.password": "correct horse battery staple"').text).toBe(
      `"db.password": "${REDACTED}"`,
    );
    expect(redact("clientSecret = 'two words'").text).toBe(`clientSecret = '${REDACTED}'`);
  });

  it.each([
    ['vercel deploy --prod --token Zx81kQ0pLm3nB7vC9tY2uR5w', 'Zx81kQ0pLm3nB7vC9tY2uR5w'],
    ['mysql --password hunter2SecretValue9 -e "select 1"', 'hunter2SecretValue9'],
    ['tool --db-password "hunter2SecretValue9"', 'hunter2SecretValue9'],
    ['docker login -u bob -p hunter2SecretValue9 registry.test', 'hunter2SecretValue9'],
    ['curl -u admin:hunter2SecretValue9 https://x.test', 'hunter2SecretValue9'],
    ['curl --user "admin:hunter2SecretValue9" https://x.test', 'hunter2SecretValue9'],
    ['curl -sS -X POST -u admin:12345678 https://x.test', '12345678'],
    ['wget --user admin:hunter2SecretValue9 https://x.test', 'hunter2SecretValue9'],
  ])('redacts a secret passed as a command-line argument: %s', (command, secret) => {
    const out = redact(command);
    expect(out.text).not.toContain(secret);
    expect(out.text).toContain(REDACTED);
    expect(redact(out.text).count).toBe(0);
  });

  it.each([
    'docker login --password-stdin registry.example.com',
    'docker run -u 1000:1000 -p 8080:80 image',
    'docker run -u node:node image',
    'podman run --user www-data:www-data image',
    'kubectl exec -u deploy:deploy pod -- ls',
    'sudo -u postgres:postgres psql',
    'sometool --user alice:staff run',
    'tool --token-file ./token.txt',
    'tool --token "$API_TOKEN" --password $DB_PASSWORD',
    'curl -u "$USER:$PASS" https://x.test',
    'git push -u origin main:main',
    'Pass --password and then the host name',
  ])('leaves command lines without a literal secret alone: %s', (command) => {
    expect(redact(command).count).toBe(0);
  });

  it('removes credentials from URLs but keeps the host', () => {
    expect(redact('postgres://admin:s3cr3t@db.local:5432/app').text).toBe(
      `postgres://admin:${REDACTED}@db.local:5432/app`,
    );
  });

  it('removes private key blocks', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----';
    expect(redact(`before ${pem} after`).text).toBe(`before ${REDACTED} after`);
  });

  it('keeps bearer scheme', () => {
    expect(redact('Authorization: Bearer abc.def.ghi12345').text).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
  });

  it('leaves ordinary text alone', () => {
    const text = 'Refactor the token parser in src/auth/token.ts and run pnpm test';
    expect(redact(text)).toEqual({ text, count: 0, kinds: [] });
  });

  it('is idempotent', () => {
    const once = redact('PASSWORD=abcdefgh').text;
    expect(redact(once).count).toBe(0);
  });

  it('applies custom patterns and ignores invalid ones', () => {
    const out = redact('internal-ABC123 x', { extraPatterns: ['internal-[A-Z0-9]+', '(['] });
    expect(out.text).toBe(`${REDACTED} x`);
  });

  it('redacts nested structures', () => {
    expect(redactDeep({ a: ['token=abcdefgh1'], b: 2 })).toEqual({
      a: [`token=${REDACTED}`],
      b: 2,
    });
  });

  it('handles pathological input quickly', () => {
    const start = Date.now();
    redact(`${'a'.repeat(200_000)}=${'b'.repeat(200_000)}`);
    redact('password'.repeat(50_000));
    redact('--token '.repeat(100_000));
    redact('docker login '.repeat(60_000));
    redact('curl -u a'.repeat(100_000));
    redact('password="'.repeat(80_000));
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

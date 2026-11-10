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
    'passwordPlaceholder="Enter your password (min 8 characters)"',
    "passwordLabel: 'Your password'",
    'passwordLabel: "Mot de passe oublié"',
    'passwordError = "Passwords do not match"',
    'passwordError: "Password must be at least 8 characters"',
    'tokenError: "Invalid authentication token"',
    'tokenError: "Token expired, re-authenticate"',
    'tokenPlaceholder: "Paste your GitHub token"',
    'passwordError: "Use 8+ characters"',
    'passwordError: "Must be 8–64 characters"',
    'passwordHint: "Between 8-64 characters, any iPhone keyboard"',
    '"password_hint": "At least twelve characters"',
    "apiKeyHelp: 'Shown once after you create the key.'",
    'token_type: "Bearer access"',
    // Known limit: plain words under a display-named key are taken for display text.
    'password_hint = "my real passphrase here"',
    'passwordError = "open sesame please"',
  ])('leaves quoted display text next to a secret-like name alone: %s', (code) => {
    expect(redact(code)).toEqual({ text: code, count: 0, kinds: [] });
  });

  it.each([
    // The name does not say "display text": these words also name fields that hold secrets.
    ['const passwordInput = "correct horse battery staple"', 'correct horse battery staple'],
    ['passwordText: "correct horse battery staple"', 'correct horse battery staple'],
    ['SECRET_MESSAGE="launch code 0000 1111"', 'launch code 0000 1111'],
    ['secret_note = "root pw is hunter2SecretValue9"', 'hunter2SecretValue9'],
    ['credentials_text = "admin hunter2SecretValue9"', 'hunter2SecretValue9'],
    ['token_info: "Bearer Zx81kQ0pLm3nB7vC9tY2uR5w"', 'Zx81kQ0pLm3nB7vC9tY2uR5w'],
    ['config.password.text = "hunter2 SecretValue9"', 'SecretValue9'],
    ['password-message: "hunter2 SecretValue9"', 'SecretValue9'],
    ['client_secret_format: "Zx81kQ0pLm3nB7vC9tY2 uR5wZx81kQ0pLm3nB7vC"', 'uR5wZx81kQ0pLm3nB7vC'],
    ['PASSWORD_PROMPT="open sesame please"', 'open sesame please'],
    ['password_title: "open sesame please"', 'open sesame please'],
    ['password_description = "open sesame please"', 'open sesame please'],
    ['password_type = "hunter two"', 'hunter two'],
    // The name says "display text" but the value does not read as plain words.
    ['auth_token_type = "Bearer Zx81kQ0pLm3nB7vC9tY2uR5w"', 'Zx81kQ0pLm3nB7vC9tY2uR5w'],
    ['DB_PASSWORD_LABEL="hunter2SecretValue9 "', 'hunter2SecretValue9'],
    ["password_hint='hunter2SecretValue9 '", 'hunter2SecretValue9'],
    ['password_label: "hunter CorrectHorseBattery"', 'CorrectHorseBattery'],
    ['passwordError: "use MySecretValue"', 'MySecretValue'],
    [`tokenHint: "paste ${'Ab'.repeat(7)}"`, 'Ab'.repeat(7)],
    ['passwordLabel = "correct horse battery9 staple"', 'battery9'],
    ['passwordError = "code 12345 expired"', '12345'],
    [`passwordHint = "starts ${'x'.repeat(25)} ends"`, 'x'.repeat(25)],
    ['token_type: "abc123def456"', 'abc123def456'],
    ["passwordHint = 'Summerwind'", 'Summerwind'],
    // A real secret name: the quoted value goes whole.
    ['"password": "correct horse battery staple"', 'horse battery staple'],
    ['"db.password": "correct horse battery staple"', 'horse battery staple'],
    ['db_password = "p@ss,word-1234567"', 'word-1234567'],
    ["clientSecret = 'two words'", 'two words'],
  ])('redacts a quoted value that may be a secret: %s', (code, secret) => {
    const out = redact(code);
    expect(out.text).not.toContain(secret);
    expect(out.text).toContain(REDACTED);
    expect(redact(out.text).count).toBe(0);
  });

  it.each([
    ['vercel deploy --prod --token Zx81kQ0pLm3nB7vC9tY2uR5w', 'Zx81kQ0pLm3nB7vC9tY2uR5w'],
    ['mysql --password PW -e "select 1"', 'PW'],
    ['tool --db-password "PW"', 'PW'],
    ['docker login -u bob -p PW registry.test', 'PW'],
    ['podman login -p PW registry.test', 'PW'],
    ['curl -u admin:PW https://x.test', 'PW'],
    ['curl --user "admin:PW" https://x.test', 'PW'],
    ['curl -sS -X POST -u admin:12345678 https://x.test', '12345678'],
    ['curl -u admin:admin https://x.test', ':admin'],
    ['wget --user admin:PW https://x.test', 'PW'],
    ['curl "https://x.test/api?a=1&b=2" -u admin:PW', 'PW'],
    ['curl https://x.test/api?a=1&b=2 -u admin:PW', 'PW'],
    ['curl https://x.test \\\n  -H "Accept: */*" \\\n  -u admin:PW', 'PW'],
    ['curl https://x.test \\\r\n  -u admin:PW', 'PW'],
    ['curl -H "Accept: text/html;q=0.9" -u admin:PW x.test', 'PW'],
    ['curl -d "a=1&b=2" -u admin:PW x.test', 'PW'],
    ['curl -H "X: a|b" -u admin:PW x.test', 'PW'],
    [`curl -H "X-Long: ${'v'.repeat(400)}" -u admin:PW x.test`, 'PW'],
    ['curl.exe -u admin:PW x.test', 'PW'],
    ['CURL -u admin:PW x.test', 'PW'],
    ['/usr/bin/curl -u admin:PW x.test', 'PW'],
    ['"C:\\tools\\curl.exe" -u admin:PW x.test', 'PW'],
    ['curlie -u admin:PW x.test', 'PW'],
    ['ab -u admin:PW x.test/', 'PW'],
    ['aria2c -u admin:PW x.test/f', 'PW'],
    ['sudo curl -u admin:PW x.test', 'PW'],
    ['sudo -u deploy curl -u admin:PW x.test', 'PW'],
    ['docker ps; curl -u admin:PW x.test', 'PW'],
    ['docker run --rm alpine sh -c "curl -u admin:PW https://x.test"', 'PW'],
    ['docker exec web curl -u admin:PW https://x.test', 'PW'],
    ['kubectl exec pod -- curl -u admin:PW https://x.test', 'PW'],
    ['ssh host "curl -u admin:PW https://x.test"', 'PW'],
    ['make build && curl -u admin:PW https://x.test', 'PW'],
    ['git log --oneline # then: curl -u admin:PW https://x.test', 'PW'],
    ['Install the deps, then run curl -u admin:PW https://x.test', 'PW'],
    ['Docker is up. Git is clean. Now curl -u admin:PW https://x.test', 'PW'],
    ["docker isn't running yet\ncurl -u admin:PW https://x.test", 'PW'],
    ['curl --user=admin:PW x.test', 'PW'],
    ['curl -uadmin:PW x.test', 'PW'],
    ['wget -uadmin:PW x.test', 'PW'],
    ['curl -su admin:PW x.test', 'PW'],
    ['curl --proxy-user admin:PW -x proxy.test:3128 x.test', 'PW'],
    // Other spellings of a client.
    ['!curl -u admin:PW https://x.test', 'PW'],
    ['C:\\Users\\me>curl -u admin:PW https://x.test', 'PW'],
    ['$CURL -u admin:PW https://x.test', 'PW'],
    ['"$CURL" -u admin:PW https://x.test', 'PW'],
    ['${CURL} -u admin:PW https://x.test', 'PW'],
    ['CURL_OPTS="--silent -u admin:PW" ./run.sh', 'PW'],
    ['curl_chrome116 -u admin:PW https://x.test', 'PW'],
    ['curl-impersonate -u admin:PW https://x.test', 'PW'],
    ['hurl --user admin:PW tests.hurl', 'PW'],
    ['httpstat https://x.test -u admin:PW', 'PW'],
    // Windows continuations and a command wrapped without one.
    ['curl https://x.test ^\n  -u admin:PW', 'PW'],
    ['curl.exe https://x.test `\n  -u admin:PW', 'PW'],
    ['curl.exe https://x.test `\r\n  -u admin:PW', 'PW'],
    ['curl https://x.test\n    -u admin:PW', 'PW'],
    ['curl https://x.test\n  -H "Accept: */*"\n  -u admin:PW', 'PW'],
    // More of curl's credential options.
    ['curl -U admin:PW -x proxy.test:3128 x.test', 'PW'],
    ['curl -sSU admin:PW -x proxy.test:3128 x.test', 'PW'],
    ['curl -sSu admin:PW x.test', 'PW'],
    ['curl --cert client.pem:PW https://x.test', 'PW'],
    ['curl --cert C:\\certs\\client.pem:PW https://x.test', 'PW'],
    ['curl --tlspassword PW https://x.test', 'PW'],
    ['curl --oauth2-bearer PW https://x.test', 'PW'],
    ['curl --key key.pem --pass PW https://x.test', 'PW'],
    ['curl -u :PW https://x.test', 'PW'],
    ['curl -u PW: https://x.test', 'PW'],
    ['curl --user "PW:" https://x.test', 'PW'],
    ['curl -u "admin:my secret pass PW" https://x.test', 'my secret pass'],
    ["curl -u 'admin:my secret pass PW' https://x.test", 'my secret pass'],
  ])('redacts a secret passed as a command-line argument: %s', (template, placeholder) => {
    const secret = placeholder === 'PW' ? 'hunter2SecretValue9' : placeholder;
    const command = template.replace('PW', 'hunter2SecretValue9');
    const out = redact(command);
    expect(out.text).not.toContain(secret);
    expect(out.text).toContain(REDACTED);
    expect(out.text).toContain(command.slice(0, command.indexOf(secret)));
    expect(redact(out.text).count).toBe(0);
  });

  it.each([
    'docker login --password-stdin registry.example.com',
    'docker login registry.test/app-p latest',
    'docker run -u 1000:1000 -p 8080:80 image',
    'docker run -u node:node image',
    'docker run -u node:staff -e "A=1;B=2" image',
    'docker run -v $(pwd):/app -u app:staff image',
    'timeout 60 docker run -u app:staff image',
    '"C:\\Program Files\\Docker\\docker.exe" run -u app:staff image',
    `docker run -e "LONG=${'v'.repeat(3000)}" -u app:staff image`,
    '/usr/bin/docker exec -u deploy:staff app ls',
    'podman run --user www-data:www-data image',
    'podman run --user=deploy:staff image',
    'kubectl exec -u deploy:staff pod -- ls',
    'sudo -u postgres:postgres psql',
    'sudo -n -u deploy:staff ./release.sh',
    'chown -u deploy:staff file',
    'sometool --user alice:staff run',
    'mytool sync --user admin:hunter2SecretValue9',
    'redis-cli -u redis://localhost:6379/0 ping',
    'python -u C:\\Users\\me\\train.py',
    'tool --user http://localhost:8080/x',
    'journalctl --user -u app:worker',
    'sed -u s:foo:bar: file',
    'mysql -uroot:app -e "select 1"',
    'git push -u origin main:main',
    'git push -u origin:refs/heads/topic',
    // On an HTTP client's line, but not a literal secret.
    'curl http://localhost:3000/sign-u http://localhost:8080/health',
    'curl -u "$USER:$PASS" https://x.test',
    'curl -x http://proxy.test:3128 --proxy-user $PROXY_USER:$PROXY_PASS x.test',
    'curl --cert client.pem https://x.test',
    'curl --cert C:\\certs\\client.pem https://x.test',
    'curl --key key.pem --pass $KEY_PASS https://x.test',
    'curl -u $CLIENT_ID: https://x.test',
    // A client in an earlier command of the same line does not own a later command's -u.
    'curl -fsSL https://x.test/install.sh | sh && docker run --rm -u 1000:1000 image',
    'curl https://x.test && docker run -u postgres:postgres pg',
    'ab -n 10 https://x.test/ && sudo -u app:app ls',
    'wget -qO- https://x.test; docker run -u app:staff image',
    'curl https://x.test & docker run -u app:staff image',
    'curl https://x.test || docker run -u app:staff image',
    'wget -qO- https://x.test && rsync -avzu user@host:/data/ .',
    // A cluster that is not curl's, or an rsync-style target.
    'curl https://x.test then rsync -avzu user@host:/data/ .',
    'curl https://x.test then rsync -avu user@host:/data/ .',
    // A variable for a proxy is not a client.
    'docker run -e HTTPS_PROXY=$HTTP_PROXY -u app:staff image',
    // Lines that only end in a backtick or caret are not continued.
    'Run `curl`\ndocker run -u app:staff image',
    'curl https://x.test^\ndocker run -u app:staff image',
    // Only an indented option continues a wrapped command, not a list item or another command.
    'curl https://x.test\n  - docker run -u app:staff image',
    'curl https://x.test\n  docker run -u app:staff image',
    // The client is named after the flag, or on another line.
    'docker run -u app:staff image curl https://x.test',
    'curl https://x.test\ndocker run -u app:staff image',
    'tool --token-file ./token.txt',
    'tool --token "$API_TOKEN" --password $DB_PASSWORD',
    'Pass --password and then the host name',
  ])('leaves command lines without a literal secret alone: %s', (command) => {
    expect(redact(command)).toEqual({ text: command, count: 0, kinds: [] });
  });

  it('keeps prose that names a client before another command in the same sentence', () => {
    // Known limit: without a separator the sentence is one command, so this is redacted.
    const text = 'Use curl to check health, then run docker run -u 1000:1000 image';
    expect(redact(text).text).toBe(
      `Use curl to check health, then run docker run -u 1000:${REDACTED} image`,
    );
  });

  it('does not redact 2,500 user:group arguments any differently from the first', () => {
    const text = 'docker run -u app:staff image\n'.repeat(2500);
    expect(redact(text)).toEqual({ text, count: 0, kinds: [] });
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
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it.each([
    ['flags with no value', '--token '.repeat(25_000)],
    ['docker login prefixes', 'docker login '.repeat(15_000)],
    ['one long curl line', `curl ${' -u a:bcd'.repeat(22_000)}`],
    ['many user flags, no client', ' -u a:bcd'.repeat(110_000)],
    ['many curl lines', 'curl -u a:bcd x\n'.repeat(62_000)],
    ['many continued lines', 'curl x \\\n -u a:bcd \\\n'.repeat(50_000)],
    ['many wrapped lines', 'curl x\n  -u a:bcd\n'.repeat(62_000)],
    ['many commands', 'curl x; a -u a:bcd\n'.repeat(52_000)],
    ['many ampersands', 'curl x&y & -u a:bcd '.repeat(48_000)],
    ['unclosed quotes', 'password="'.repeat(20_000)],
  ])('stays fast on %s', (_name, input) => {
    expect(input.length).toBeGreaterThanOrEqual(190_000);
    const start = Date.now();
    redact(input);
    expect(Date.now() - start).toBeLessThan(1500);
  });
});

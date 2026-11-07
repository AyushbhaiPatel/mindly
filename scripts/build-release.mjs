#!/usr/bin/env node
// Builds the publishable `mindly-cli` npm package into release/mindly-cli/.
//
// Workspace code (`@mindly/*`) is bundled from source with esbuild; real third-party runtime
// dependencies stay external and are declared, with their exact versions, in the generated
// package.json. The built dashboard is copied to dashboard/. Nothing is published.
//
// Usage: pnpm release:build   (builds the dashboard first, then runs this script)

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const cliDir = join(repo, 'apps', 'cli');
const out = join(repo, 'release', 'mindly-cli');
const dist = join(out, 'dist');

const requireFromCli = createRequire(join(cliDir, 'package.json'));
const esbuild = await import(pathToFileURL(requireFromCli.resolve('esbuild')).href);

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const fail = (message) => {
  console.error(`release: ${message}`);
  process.exit(1);
};

// --- Workspace packages and their third-party runtime dependencies --------------------------

/** name -> { dir, manifest } for every workspace package. */
const workspace = new Map();
for (const group of ['packages', 'apps']) {
  for (const entry of readdirSync(join(repo, group))) {
    const file = join(repo, group, entry, 'package.json');
    if (!existsSync(file)) continue;
    const manifest = readJson(file);
    workspace.set(manifest.name, { dir: join(repo, group, entry), manifest });
  }
}

/** Third-party runtime deps reachable from the CLI through workspace packages: name -> version. */
const thirdParty = new Map();
const seen = new Set();
const walk = (name) => {
  if (seen.has(name)) return;
  seen.add(name);
  const pkg = workspace.get(name);
  if (!pkg) fail(`unknown workspace package ${name}`);
  for (const [dep, range] of Object.entries(pkg.manifest.dependencies ?? {})) {
    if (range.startsWith('workspace:')) {
      walk(dep);
      continue;
    }
    if (!/^\d+\.\d+\.\d+$/.test(range))
      fail(`${name} depends on ${dep}@${range}: pin an exact version`);
    const known = thirdParty.get(dep);
    if (known && known !== range) fail(`conflicting versions of ${dep}: ${known} and ${range}`);
    thirdParty.set(dep, range);
  }
};
const cli = workspace.get('mindly-cli');
if (!cli) fail('apps/cli (mindly-cli) not found');
walk('mindly-cli');

const core = readFileSync(join(repo, 'packages', 'core', 'src', 'index.ts'), 'utf8');
const coreVersion = /MINDLY_VERSION = '([^']+)'/.exec(core)?.[1];
if (coreVersion !== cli.manifest.version) {
  fail(`MINDLY_VERSION (${coreVersion}) differs from apps/cli version (${cli.manifest.version})`);
}

const dashboardDist = join(repo, 'apps', 'dashboard', 'dist');
if (!existsSync(join(dashboardDist, 'index.html'))) {
  fail('apps/dashboard/dist is missing; run pnpm --filter @mindly/dashboard build');
}

// --- Bundle -----------------------------------------------------------------------------------

rmSync(out, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const result = await esbuild.build({
  absWorkingDir: repo,
  entryPoints: {
    main: 'apps/cli/src/main.ts',
    daemon: 'apps/daemon/src/main.ts',
  },
  outdir: dist,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  conditions: ['@mindly/source'],
  external: [...thirdParty.keys()].flatMap((dep) => [dep, `${dep}/*`]),
  define: { __MINDLY_RELEASE__: 'true' },
  // Entry sources start with `#!/usr/bin/env node`, which esbuild keeps; the banner covers the
  // shared chunks too, so every output starts the same way and none carries two hashbangs.
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: true,
  sourcesContent: true,
  chunkNames: 'chunk-[hash]',
  legalComments: 'eof',
  metafile: true,
  logLevel: 'warning',
});
if (result.errors.length > 0) fail('esbuild reported errors');

// Strip a duplicated hashbang (entry hashbang + banner).
for (const file of readdirSync(dist).filter((f) => f.endsWith('.js'))) {
  const path = join(dist, file);
  const text = readFileSync(path, 'utf8');
  const fixed = text.replace(/^(#![^\n]*\n)(#![^\n]*\n)+/, '$1');
  if (fixed !== text) writeFileSync(path, fixed);
}
chmodSync(join(dist, 'main.js'), 0o755);
chmodSync(join(dist, 'daemon.js'), 0o755);

// Every bundled input must be workspace source: no third-party code, no tests or fixtures.
const inputs = Object.keys(result.metafile.inputs);
for (const input of inputs) {
  if (input.includes('node_modules')) fail(`third-party code was bundled: ${input}`);
  if (/(^|\/)(test|tests|fixtures|__tests__)\//.test(input) || /\.test\.ts$/.test(input)) {
    fail(`test code was bundled: ${input}`);
  }
}

// Only declare the external packages the bundle really imports.
const builtins = new Set((await import('node:module')).builtinModules);
const imported = new Set();
for (const output of Object.values(result.metafile.outputs)) {
  for (const imp of output.imports) {
    if (!imp.external) continue;
    const spec = imp.path;
    if (spec.startsWith('node:') || builtins.has(spec.split('/')[0])) continue;
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    if (!thirdParty.has(name)) fail(`bundle imports undeclared package ${spec}`);
    imported.add(name);
  }
}
const dependencies = Object.fromEntries([...imported].sort().map((d) => [d, thirdParty.get(d)]));

// --- Dashboard, docs, licences -------------------------------------------------------------------

cpSync(dashboardDist, join(out, 'dashboard'), { recursive: true });
// npm resolves relative README links against `repository.directory` (apps/cli), which breaks
// every image and doc link. Point them at the repository root on GitHub instead.
const GH = 'AyushbhaiPatel/mindly';
const isRelative = (u) => !/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(u);
const absolute = (u) => {
  const path = u.replace(/^\.\//, '');
  return /\.(png|jpe?g|gif|svg|webp)$/i.test(path)
    ? `https://raw.githubusercontent.com/${GH}/main/${path}`
    : `https://github.com/${GH}/blob/main/${path}`;
};
const readme = readFileSync(join(repo, 'README.md'), 'utf8')
  .replace(/(\bsrc=")([^"]+)"/g, (m, pre, u) => (isRelative(u) ? `${pre}${absolute(u)}"` : m))
  .replace(/\]\(([^)\s]+)\)/g, (m, u) => (isRelative(u) ? `](${absolute(u)})` : m));
writeFileSync(join(out, 'README.md'), readme);
cpSync(join(repo, 'LICENSE'), join(out, 'LICENSE'));

// The dashboard bundle (built by Vite) contains third-party code: its runtime dependencies and
// their transitive dependencies. Their licences must ship with it.
const dashboard = workspace.get('@mindly/dashboard');
const bundledThirdParty = new Map();
const collect = (name, fromDir) => {
  if (bundledThirdParty.has(name)) return;
  const req = createRequire(join(fromDir, 'package.json'));
  let manifestPath;
  try {
    manifestPath = req.resolve(`${name}/package.json`);
  } catch {
    fail(`cannot resolve ${name} from ${relative(repo, fromDir)}`);
  }
  const dir = dirname(manifestPath);
  const manifest = readJson(manifestPath);
  const licenseFile = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  bundledThirdParty.set(name, {
    version: manifest.version,
    license: manifest.license ?? 'UNKNOWN',
    text: licenseFile ? readFileSync(join(dir, licenseFile), 'utf8').trim() : null,
  });
  for (const dep of Object.keys(manifest.dependencies ?? {})) collect(dep, dir);
};
for (const dep of Object.keys(dashboard.manifest.dependencies ?? {})) collect(dep, dashboard.dir);

const notice = [
  'Mindly',
  'Copyright The Mindly Authors',
  '',
  'This product is licensed under the Apache License, Version 2.0 (see LICENSE).',
  '',
  'The Mission Control dashboard in dashboard/ bundles the following third-party software,',
  'each under its own licence, reproduced below. Runtime dependencies listed in package.json',
  'are installed separately by npm and carry their own licences.',
  '',
];
for (const [name, info] of [...bundledThirdParty].sort(([a], [b]) => a.localeCompare(b))) {
  if (!info.text) fail(`${name} has no licence file to reproduce`);
  notice.push(
    '-'.repeat(78),
    `${name} ${info.version} (${info.license})`,
    '-'.repeat(78),
    '',
    info.text,
    '',
  );
}
writeFileSync(join(out, 'NOTICE'), `${notice.join('\n').trimEnd()}\n`);

// --- package.json ------------------------------------------------------------------------------

const manifest = {
  name: cli.manifest.name,
  version: cli.manifest.version,
  description: cli.manifest.description,
  keywords: [
    'mindly',
    'coding-agents',
    'claude-code',
    'codex',
    'cursor',
    'mcp',
    'shared-memory',
    'ai-agents',
    'cli',
  ],
  homepage: 'https://github.com/AyushbhaiPatel/mindly#readme',
  bugs: { url: 'https://github.com/AyushbhaiPatel/mindly/issues' },
  repository: {
    type: 'git',
    url: 'git+https://github.com/AyushbhaiPatel/mindly.git',
    directory: 'apps/cli',
  },
  license: 'Apache-2.0',
  type: 'module',
  bin: { mindly: 'dist/main.js' },
  files: ['dist', 'dashboard', 'NOTICE'],
  engines: { node: '>=22.13.0' },
  dependencies,
};
writeFileSync(join(out, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// --- Leak checks ---------------------------------------------------------------------------------

const forbidden = [repo, homedir()].filter((p) => p.length > 1);
const secretPatterns = [
  /sk-ant-[A-Za-z0-9_-]{16,}/,
  /sk-[A-Za-z0-9]{32,}/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /xox[abprs]-[A-Za-z0-9-]{10,}/,
];
const files = [];
const list = (dir) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) list(path);
    else files.push(path);
  }
};
list(out);
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const p of forbidden) {
    if (text.includes(p)) fail(`${relative(out, file)} contains the local path ${p}`);
  }
  for (const re of secretPatterns) {
    if (re.test(text)) fail(`${relative(out, file)} matches a secret pattern (${re.source})`);
  }
}

const size = files.reduce((n, f) => n + statSync(f).size, 0);
console.log(
  `release: built ${manifest.name}@${manifest.version} in ${relative(repo, out)}${sep}` +
    ` (${files.length} files, ${(size / 1024).toFixed(0)} KiB unpacked)`,
);
console.log(`release: runtime dependencies: ${Object.keys(dependencies).join(', ')}`);

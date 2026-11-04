import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Set to `true` by the release bundler (esbuild `define`); never defined in the monorepo, where
 * every module runs from its own file.
 */
declare const __MINDLY_RELEASE__: boolean | undefined;

/** Where the installable pieces of Mindly live on disk. */
export interface InstallLayout {
  /** `release`: the bundled `mindly` npm package; `dev`: a monorepo checkout. */
  kind: 'release' | 'dev';
  /** Entry point of the `mindly` CLI (what agent hooks run with `node`). */
  cliMain: string;
  /** Entry point of the daemon process. */
  daemonMain: string;
  /** Directory holding the built dashboard (`index.html` and assets). */
  dashboardDir: string;
}

/** True when this code runs from the release bundle rather than from the monorepo. */
export function isReleaseBuild(): boolean {
  return typeof __MINDLY_RELEASE__ !== 'undefined' && __MINDLY_RELEASE__ === true;
}

/**
 * Release layout of the `mindly` package: every bundled file sits in `<root>/dist/`
 * (`main.js`, `daemon.js` and shared chunks) and the dashboard in `<root>/dashboard/`.
 */
export function releaseLayout(bundleFile: string): InstallLayout {
  const root = dirname(dirname(bundleFile));
  return {
    kind: 'release',
    cliMain: join(root, 'dist', 'main.js'),
    daemonMain: join(root, 'dist', 'daemon.js'),
    dashboardDir: join(root, 'dashboard'),
  };
}

/**
 * Monorepo layout: `moduleFile` is any file under `<repo>/apps/<app>/` (source or build output);
 * the CLI and daemon entries are their `dist/main.js` and the dashboard is `apps/dashboard/dist`.
 */
export function devLayout(moduleFile: string): InstallLayout {
  const marker = `${sep}apps${sep}`;
  const at = moduleFile.lastIndexOf(marker);
  if (at < 0) throw new Error(`not inside a Mindly checkout: ${moduleFile}`);
  const apps = moduleFile.slice(0, at + marker.length - 1);
  return {
    kind: 'dev',
    cliMain: join(apps, 'cli', 'dist', 'main.js'),
    daemonMain: join(apps, 'daemon', 'dist', 'main.js'),
    dashboardDir: join(apps, 'dashboard', 'dist'),
  };
}

/**
 * Resolves the install layout for the module at `moduleUrl` (pass `import.meta.url`). In the
 * release bundle `import.meta.url` is the bundle file itself; in the monorepo it is the module's
 * own source or build file. `release` defaults to {@link isReleaseBuild}.
 */
export function resolveLayout(
  moduleUrl: string,
  release: boolean = isReleaseBuild(),
): InstallLayout {
  const file = fileURLToPath(moduleUrl);
  return release ? releaseLayout(file) : devLayout(file);
}

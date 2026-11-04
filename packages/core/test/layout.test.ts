import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { devLayout, isReleaseBuild, releaseLayout, resolveLayout } from '../src/layout.js';

const root = join(sep, 'opt', 'work', 'mindly');

describe('install layout', () => {
  it('is never a release build when running from source', () => {
    expect(isReleaseBuild()).toBe(false);
  });

  it('resolves the monorepo layout from source and build files of any app', () => {
    const expected = {
      kind: 'dev',
      cliMain: join(root, 'apps', 'cli', 'dist', 'main.js'),
      daemonMain: join(root, 'apps', 'daemon', 'dist', 'main.js'),
      dashboardDir: join(root, 'apps', 'dashboard', 'dist'),
    };
    expect(devLayout(join(root, 'apps', 'cli', 'src', 'commands', 'setup.ts'))).toEqual(expected);
    expect(devLayout(join(root, 'apps', 'cli', 'dist', 'commands', 'setup.js'))).toEqual(expected);
    expect(devLayout(join(root, 'apps', 'daemon', 'src', 'server.ts'))).toEqual(expected);
    expect(devLayout(join(root, 'apps', 'daemon', 'dist', 'server.js'))).toEqual(expected);
  });

  it('uses the innermost apps directory', () => {
    const nested = join(sep, 'home', 'apps', 'src', 'mindly');
    expect(devLayout(join(nested, 'apps', 'cli', 'src', 'x.ts')).cliMain).toBe(
      join(nested, 'apps', 'cli', 'dist', 'main.js'),
    );
  });

  it('rejects files outside a checkout', () => {
    expect(() => devLayout(join(sep, 'usr', 'lib', 'x.js'))).toThrow(/not inside/);
  });

  it('resolves the release layout from the bundle or any chunk in dist/', () => {
    const pkg = join(sep, 'usr', 'lib', 'node_modules', 'mindly');
    const expected = {
      kind: 'release',
      cliMain: join(pkg, 'dist', 'main.js'),
      daemonMain: join(pkg, 'dist', 'daemon.js'),
      dashboardDir: join(pkg, 'dashboard'),
    };
    expect(releaseLayout(join(pkg, 'dist', 'main.js'))).toEqual(expected);
    expect(releaseLayout(join(pkg, 'dist', 'daemon.js'))).toEqual(expected);
    expect(releaseLayout(join(pkg, 'dist', 'chunk-ABC123.js'))).toEqual(expected);
  });

  it('picks the layout from a module URL', () => {
    const pkg = join(sep, 'tmp', 'node_modules', 'mindly');
    const bundle = pathToFileURL(join(pkg, 'dist', 'main.js')).href;
    expect(resolveLayout(bundle, true).dashboardDir).toBe(join(pkg, 'dashboard'));
    const source = pathToFileURL(join(root, 'apps', 'daemon', 'src', 'server.ts')).href;
    expect(resolveLayout(source, false).dashboardDir).toBe(join(root, 'apps', 'dashboard', 'dist'));
    expect(resolveLayout(source).kind).toBe('dev');
  });
});

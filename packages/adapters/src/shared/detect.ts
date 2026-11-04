import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    if (process.platform === 'win32') return true;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds `binary` on `PATH` by checking each directory directly (no shell, no subprocess).
 * On Windows the `PATHEXT` extensions are tried as well.
 */
export async function findOnPath(
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const dirs = (env['PATH'] ?? env['Path'] ?? '').split(delimiter).filter((d) => d !== '');
  const exts =
    process.platform === 'win32'
      ? ['', ...(env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';').filter((e) => e !== '')]
      : [''];
  for (const dir of dirs.slice(0, 256)) {
    for (const ext of exts) {
      const candidate = join(dir, binary + ext);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/** True when any of `dirs` exists or any of `binaries` is on PATH. */
export async function detectAgent(
  dirs: readonly string[],
  binaries: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  for (const dir of dirs) if (await isDir(dir)) return true;
  for (const bin of binaries) if ((await findOnPath(bin, env)) !== null) return true;
  return false;
}

/** Languages the analysers understand. Everything else is skipped gracefully. */
export type Language = 'typescript' | 'javascript' | 'python';

const BY_EXTENSION: Readonly<Record<string, Language>> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  pyi: 'python',
};

/** Language of a file path by extension, or null when unsupported. */
export function languageOf(path: string): Language | null {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  return BY_EXTENSION[base.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * Silences Node's one-time `ExperimentalWarning` for the built-in `node:sqlite` module (Node 22).
 * Agents may surface anything a hook writes to stderr, so this warning must never appear there.
 * Every other warning is passed through unchanged. Imported first by `main.ts` so it is installed
 * before any module loads SQLite.
 */
const original = process.emitWarning.bind(process);

process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const message = typeof warning === 'string' ? warning : warning.message;
  const type =
    typeof rest[0] === 'string'
      ? rest[0]
      : typeof rest[0] === 'object' && rest[0] !== null
        ? (rest[0] as { type?: string }).type
        : warning instanceof Error
          ? warning.name
          : undefined;
  if (type === 'ExperimentalWarning' && /sqlite/i.test(message)) return;
  (original as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

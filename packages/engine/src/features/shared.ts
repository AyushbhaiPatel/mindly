import { isDeniedPath, tryResolveInsideRoot, type Session } from '@mindly/core';
import { LIVE_WINDOW_MS, type Kernel } from '../kernel.js';
import type { Mindly } from '../mindly.js';

/*
 * Small helpers shared by the feature modules. Not exported from the package index.
 */

/** Maximum changed files a single bus handler processes per event. */
export const MAX_FILES_PER_EVENT = 20;

const services = new WeakMap<Mindly, Map<string, unknown>>();

/** Attaches a feature service to a `Mindly` instance (one per key). */
export function attachService<T>(mindly: Mindly, key: string, service: T): T {
  let map = services.get(mindly);
  if (!map) {
    map = new Map();
    services.set(mindly, map);
  }
  map.set(key, service);
  return service;
}

/** Returns the attached service, creating and attaching one with `make` when missing. */
export function serviceOf<T>(mindly: Mindly, key: string, make: () => T): T {
  const existing = services.get(mindly)?.get(key);
  if (existing !== undefined) return existing as T;
  return attachService(mindly, key, make());
}

/** Live (active/idle/rate-limited, recently seen) sessions of a project. */
export function liveSessions(k: Kernel, projectId: string): Session[] {
  return k.store.sessions.listLive(projectId, LIVE_WINDOW_MS).filter((s) => s.status !== 'ended');
}

/**
 * Resolves a stored or caller-supplied project-relative path. Returns null when it escapes the
 * project, is the root itself, or is on the deny-list.
 */
export function safeProjectPath(
  k: Kernel,
  projectRoot: string,
  path: string,
): { rel: string; abs: string } | null {
  const r = tryResolveInsideRoot(projectRoot, path);
  if (!r || r.rel === '') return null;
  if (isDeniedPath(r.rel, k.config.redaction.denyPaths)) return null;
  return r;
}

/** Runs `fn`, logging and swallowing any error (bus handlers must never throw). */
export async function guarded(
  k: Kernel,
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    k.logger.error('feature handler failed', {
      handler: name,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Formats up to `max` symbol names for a message. */
export function nameList(names: readonly string[], max = 12): string {
  const shown = names.slice(0, max).join(', ');
  return names.length > max ? `${shown} (+${names.length - max} more)` : shown;
}

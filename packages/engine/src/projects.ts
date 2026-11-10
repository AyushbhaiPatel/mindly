import { realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  loadProjectConfig,
  ProjectConfigSchema,
  MindlyError,
  type ProjectConfig,
  type Project,
} from '@mindly/core';
import type { Kernel } from './kernel.js';

export interface ProjectContext {
  project: Project;
  root: string;
  /** Repository-supplied config. Only `trusted` config may cause commands to run. */
  config: ProjectConfig;
  configHash: string | null;
  trusted: boolean;
  configError: string | null;
  /** Entries of the project config Mindly leaves out because they cannot be used. */
  configWarnings: string[];
}

export class ProjectService {
  private readonly cache = new Map<string, ProjectContext>();

  constructor(private readonly k: Kernel) {}

  /** Resolves the project for a working directory (repository root, or the directory itself). */
  async resolve(cwd: string): Promise<ProjectContext> {
    let real: string;
    try {
      real = realpathSync(cwd);
    } catch (cause) {
      throw new MindlyError('invalid_input', 'working directory does not exist', { cause });
    }
    const cached = this.cache.get(real);
    if (cached) return cached;
    const git = this.k.ports.git;
    const root = (await git.projectRoot?.(real)) ?? (await git.findRepoRoot(real)) ?? real;
    const project = this.k.store.projects.upsertByRoot(root, basename(root) || root);
    const ctx = this.load(project);
    this.cache.set(real, ctx);
    return ctx;
  }

  byId(projectId: string): ProjectContext {
    return this.load(this.k.store.projects.get(projectId));
  }

  private load(project: Project): ProjectContext {
    let config: ProjectConfig = ProjectConfigSchema.parse({});
    let hash: string | null = null;
    let configError: string | null = null;
    let configWarnings: string[] = [];
    try {
      const loaded = loadProjectConfig(join(project.root, '.mindly', 'config.json'));
      config = loaded.config;
      hash = loaded.hash;
      configWarnings = loaded.warnings;
    } catch (err) {
      configError = err instanceof Error ? err.message : 'invalid project config';
    }
    for (const w of configWarnings) {
      this.k.logger.warn('project config entry left out', { project: project.id, warning: w });
    }
    const trusted = hash !== null && project.trustedConfigHash === hash;
    return {
      project,
      root: project.root,
      config,
      configHash: hash,
      trusted,
      configError,
      configWarnings,
    };
  }

  /**
   * Records that the user trusts the project's `.mindly/config.json` at `expectedHash` (the version
   * they reviewed). Any later change to the file invalidates trust until this is called again.
   */
  trust(projectId: string, expectedHash: string): ProjectContext {
    const ctx = this.byId(projectId);
    if (ctx.configError) throw new MindlyError('invalid_input', ctx.configError);
    // The user reviewed a specific version; refuse if the file changed since (an agent could swap
    // the checks between review and approval).
    if (ctx.configHash === null || ctx.configHash !== expectedHash) {
      throw new MindlyError(
        'conflict',
        'project config changed since it was reviewed; review it again',
      );
    }
    this.k.store.projects.setTrustedConfigHash(projectId, ctx.configHash);
    this.cache.clear();
    return this.byId(projectId);
  }

  untrust(projectId: string): void {
    this.k.store.projects.setTrustedConfigHash(projectId, null);
    this.cache.clear();
  }
}

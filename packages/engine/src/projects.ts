import { realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  loadProjectConfig,
  ProjectConfigSchema,
  SynapseError,
  type ProjectConfig,
  type Project,
} from '@synapse/core';
import type { Kernel } from './kernel.js';

export interface ProjectContext {
  project: Project;
  root: string;
  /** Repository-supplied config. Only `trusted` config may cause commands to run. */
  config: ProjectConfig;
  configHash: string | null;
  trusted: boolean;
  configError: string | null;
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
      throw new SynapseError('invalid_input', 'working directory does not exist', { cause });
    }
    const cached = this.cache.get(real);
    if (cached) return cached;
    const root = (await this.k.ports.git.findRepoRoot(real)) ?? real;
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
    try {
      const loaded = loadProjectConfig(join(project.root, '.synapse', 'config.json'));
      config = loaded.config;
      hash = loaded.hash;
    } catch (err) {
      configError = err instanceof Error ? err.message : 'invalid project config';
    }
    const trusted = hash !== null && project.trustedConfigHash === hash;
    return { project, root: project.root, config, configHash: hash, trusted, configError };
  }

  /**
   * Records that the user trusts the project's current `.synapse/config.json`. Any later change to
   * the file invalidates trust until this is called again.
   */
  trust(projectId: string): ProjectContext {
    const ctx = this.byId(projectId);
    if (ctx.configError) throw new SynapseError('invalid_input', ctx.configError);
    this.k.store.projects.setTrustedConfigHash(projectId, ctx.configHash);
    this.cache.clear();
    return this.byId(projectId);
  }

  untrust(projectId: string): void {
    this.k.store.projects.setTrustedConfigHash(projectId, null);
    this.cache.clear();
  }
}

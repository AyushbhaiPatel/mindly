import {
  createLogger,
  ensureHome,
  fileSink,
  loadUserConfig,
  nullSink,
  mindlyHome,
  systemClock,
  type Clock,
  type HomePaths,
  type Logger,
  type UserConfig,
} from '@mindly/core';
import { Store } from '@mindly/store';
import { join } from 'node:path';
import { ContextBuilder } from './context/builder.js';
import { TelepathyService } from './coordination/telepathy.js';
import { IntentService, TaskService } from './coordination/work.js';
import { HookHandler } from './hooks/handler.js';
import { EngineBus, type Kernel } from './kernel.js';
import { MistakeService } from './memory/mistakes.js';
import { RulesFileService } from './memory/rules-file.js';
import { RuleService } from './memory/rules.js';
import { MemoryService } from './memory/service.js';
import { nullGit, nullLlm, nullNotifier, type Ports } from './ports.js';
import { ProjectService } from './projects.js';

export interface MindlyOptions {
  /** Defaults to `$MINDLY_HOME` or `~/.mindly`. */
  home?: string;
  env?: NodeJS.ProcessEnv;
  ports?: Partial<Ports>;
  clock?: Clock;
  logger?: Logger;
  config?: UserConfig;
  /** Use an in-memory database (tests). */
  inMemory?: boolean;
  /** See `Kernel.headless`. */
  headless?: boolean;
}

/** A feature module plugs into the engine by registering bus handlers and/or exposing a service. */
export type MindlyModule = (mindly: Mindly) => void;

/**
 * The engine facade. Every entry point (hook CLI, MCP server, daemon, CLI commands) creates one
 * `Mindly` per process and talks only to it.
 */
export class Mindly {
  readonly kernel: Kernel;
  readonly bus: EngineBus;
  readonly projects: ProjectService;
  readonly memory: MemoryService;
  readonly rules: RuleService;
  readonly rulesFile: RulesFileService;
  readonly mistakes: MistakeService;
  readonly telepathy: TelepathyService;
  readonly tasks: TaskService;
  readonly intents: IntentService;
  readonly context: ContextBuilder;
  readonly hooks: HookHandler;

  constructor(
    kernel: Kernel,
    readonly paths: HomePaths | null,
  ) {
    this.kernel = kernel;
    this.bus = new EngineBus(kernel.logger);
    this.projects = new ProjectService(kernel);
    this.memory = new MemoryService(kernel);
    this.rules = new RuleService(kernel, this.memory);
    this.rulesFile = new RulesFileService(kernel, this.memory);
    this.memory.onRulesChanged((projectId) => this.rulesFile.refresh(projectId));
    this.mistakes = new MistakeService(kernel, this.memory);
    this.telepathy = new TelepathyService(kernel);
    this.tasks = new TaskService(kernel);
    this.intents = new IntentService(kernel, this.telepathy);
    this.context = new ContextBuilder(kernel, this.telepathy, this.mistakes);
    this.hooks = new HookHandler(kernel, {
      projects: this.projects,
      context: this.context,
      intents: this.intents,
      telepathy: this.telepathy,
      rules: this.rules,
      mistakes: this.mistakes,
      bus: this.bus,
    });
  }

  static open(options: MindlyOptions = {}): Mindly {
    const clock = options.clock ?? systemClock;
    const ports: Ports = {
      git: options.ports?.git ?? nullGit,
      llm: options.ports?.llm ?? nullLlm,
      notifier: options.ports?.notifier ?? nullNotifier,
    };
    if (options.inMemory) {
      const logger = options.logger ?? createLogger({ sink: nullSink });
      const config = options.config ?? loadUserConfig('/nonexistent/mindly-config.json');
      return new Mindly(
        {
          store: Store.memory(clock),
          config,
          clock,
          logger,
          ports,
          headless: options.headless ?? false,
        },
        null,
      );
    }
    const paths = ensureHome(options.home ?? mindlyHome(options.env));
    const config = options.config ?? loadUserConfig(paths.config);
    const logger =
      options.logger ??
      createLogger({ sink: fileSink(join(paths.logs, 'mindly.log')), level: 'info' });
    const store = Store.open(paths.db, { clock, busyTimeoutMs: 5000 });
    return new Mindly(
      { store, config, clock, logger, ports, headless: options.headless ?? false },
      paths,
    );
  }

  get store(): Store {
    return this.kernel.store;
  }

  get config(): UserConfig {
    return this.kernel.config;
  }

  use(module: MindlyModule): this {
    module(this);
    return this;
  }

  close(): void {
    this.kernel.store.close();
  }
}

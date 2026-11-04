import {
  EMPTY_HOOK_RESULT,
  isDeniedPath,
  redactText,
  sanitizeLine,
  tryResolveInsideRoot,
  type HookResult,
  type NormalizedHookEvent,
  type Session,
} from '@mindly/core';
import type { ContextBuilder } from '../context/builder.js';
import type { IntentService } from '../coordination/work.js';
import type { TelepathyService } from '../coordination/telepathy.js';
import { LIVE_WINDOW_MS, type ChangedFile, type EngineBus, type Kernel } from '../kernel.js';
import type { MistakeService } from '../memory/mistakes.js';
import type { RuleService } from '../memory/rules.js';
import type { ProjectContext, ProjectService } from '../projects.js';

const MAX_PROMPT_STORED = 4000;

export interface HookDeps {
  projects: ProjectService;
  context: ContextBuilder;
  intents: IntentService;
  telepathy: TelepathyService;
  rules: RuleService;
  mistakes: MistakeService;
  bus: EngineBus;
}

/**
 * Translates normalised hook events into engine operations. `handle` never throws: any internal
 * failure is logged and an empty result returned, so a Mindly bug can never block an agent.
 */
export class HookHandler {
  constructor(
    private readonly k: Kernel,
    private readonly d: HookDeps,
  ) {}

  async handle(evt: NormalizedHookEvent): Promise<HookResult> {
    try {
      return await this.dispatch(evt);
    } catch (err) {
      this.k.logger.error('hook handling failed', {
        event: evt.event,
        agent: evt.agentKind,
        error: err instanceof Error ? err.message : String(err),
      });
      return EMPTY_HOOK_RESULT;
    }
  }

  private async dispatch(evt: NormalizedHookEvent): Promise<HookResult> {
    const project = await this.d.projects.resolve(evt.cwd);
    const session = await this.session(project, evt);
    switch (evt.event) {
      case 'session_start':
        return this.sessionStart(project, session, evt);
      case 'prompt':
        return this.prompt(project, session, evt);
      case 'pre_tool':
        return this.preTool(project, session, evt);
      case 'post_tool':
        return this.postTool(project, session, evt);
      case 'stop':
        return this.stop(project, session, evt);
      case 'session_end':
        return this.sessionEnd(project, session);
    }
  }

  private async session(project: ProjectContext, evt: NormalizedHookEvent): Promise<Session> {
    const externalId = sanitizeLine(evt.externalSessionId, 200) || 'unknown';
    const existing = this.k.store.sessions.findByExternal(
      project.project.id,
      evt.agentKind,
      externalId,
    );
    // Only look up the branch when needed (it costs a git process).
    const branch =
      !existing || evt.event === 'session_start'
        ? await this.k.ports.git.currentBranch(evt.cwd)
        : null;
    const { session } = this.k.store.sessions.upsert({
      projectId: project.project.id,
      agentKind: evt.agentKind,
      externalId,
      worktree: evt.cwd,
      branch,
      transcriptPath: evt.transcriptPath,
    });
    return session;
  }

  private async sessionStart(
    project: ProjectContext,
    session: Session,
    evt: NormalizedHookEvent,
  ): Promise<HookResult> {
    this.k.store.sessions.endStale(project.project.id, LIVE_WINDOW_MS * 4);
    this.k.store.intents.expire();
    this.k.store.deliveries.expire();
    this.k.store.events.append({
      projectId: project.project.id,
      sessionId: session.id,
      type: 'session.started',
      payload: { agent: session.agentKind, source: evt.startSource, branch: session.branch },
    });
    await this.d.bus.emit('session.started', {
      projectId: project.project.id,
      projectRoot: project.root,
      session,
      source: evt.startSource,
    });
    const built = this.d.context.sessionStart(project, session);
    return { ...EMPTY_HOOK_RESULT, context: built.text };
  }

  private async prompt(
    project: ProjectContext,
    session: Session,
    evt: NormalizedHookEvent,
  ): Promise<HookResult> {
    const raw = evt.prompt ?? '';
    this.d.telepathy.ackPreviousTurn(session);
    const redacted = redactText(raw, { extraPatterns: this.k.config.redaction.extraPatterns });
    this.k.store.events.append({
      projectId: project.project.id,
      sessionId: session.id,
      type: 'prompt.submitted',
      payload: {
        prompt: redacted.slice(0, MAX_PROMPT_STORED),
        summary: sanitizeLine(redacted, 160),
        length: raw.length,
      },
    });
    if (session.status !== 'active') this.k.store.sessions.setStatus(session.id, 'active');
    const rules = await this.d.rules.captureFromPrompt({
      projectId: project.project.id,
      projectRoot: project.root,
      session,
      prompt: raw,
    });
    const built = this.d.context.prompt(project, session, raw);
    const userMessage = rules.length
      ? `Mindly saved ${rules.length === 1 ? 'a project rule' : `${rules.length} project rules`} for all agents: ${rules.map((r) => r.title).join('; ')}`
      : null;
    return { ...EMPTY_HOOK_RESULT, context: built.text, userMessage };
  }

  /** Resolves agent-reported paths to project-relative paths, dropping anything outside/denied. */
  private projectPaths(
    project: ProjectContext,
    cwd: string,
    paths: readonly string[],
  ): { rel: string; abs: string }[] {
    const out: { rel: string; abs: string }[] = [];
    for (const p of paths.slice(0, 50)) {
      const abs = tryResolveInsideRoot(cwd, p);
      if (!abs) continue;
      const inProject = tryResolveInsideRoot(project.root, abs.abs);
      if (!inProject || inProject.rel === '') continue;
      if (isDeniedPath(inProject.rel, this.k.config.redaction.denyPaths)) continue;
      out.push({ rel: inProject.rel, abs: inProject.abs });
    }
    return out;
  }

  private async preTool(
    project: ProjectContext,
    session: Session,
    evt: NormalizedHookEvent,
  ): Promise<HookResult> {
    const tool = evt.tool;
    if (!tool) return EMPTY_HOOK_RESULT;
    if (tool.writes && tool.edits.length > 0) {
      const paths = this.projectPaths(
        project,
        evt.cwd,
        tool.edits.map((e) => e.path),
      ).map((p) => p.rel);
      if (paths.length === 0) return EMPTY_HOOK_RESULT;
      const overlap = this.d.intents.noteEditing(session, paths);
      const built = this.d.context.preWrite(project, session, paths, overlap.warnings);
      if (built.deny) {
        return {
          ...EMPTY_HOOK_RESULT,
          decision: 'deny',
          reason: `Blocked by a project rule the user marked as enforced: "${built.deny.title}". Ask the user before changing ${paths.join(', ')}.`,
          context: built.text,
        };
      }
      return { ...EMPTY_HOOK_RESULT, context: built.text };
    }
    if (tool.shell && tool.command) {
      const mistakes = this.d.mistakes.forCommand(project.project.id, tool.command);
      if (mistakes.length === 0) return EMPTY_HOOK_RESULT;
      const lines = mistakes.map((m) => `- ${sanitizeLine(m.body, 300)}`);
      return {
        ...EMPTY_HOOK_RESULT,
        context: [
          '<mindly-context>',
          'Mindly note: a similar command failed before in this project.',
          ...lines,
          '</mindly-context>',
        ].join('\n'),
      };
    }
    return EMPTY_HOOK_RESULT;
  }

  private async postTool(
    project: ProjectContext,
    session: Session,
    evt: NormalizedHookEvent,
  ): Promise<HookResult> {
    const tool = evt.tool;
    if (!tool) return EMPTY_HOOK_RESULT;
    this.k.store.sessions.touch(session.id);
    if (tool.shell && tool.failed && tool.command) {
      this.d.mistakes.recordFailedCommand({
        projectId: project.project.id,
        projectRoot: project.root,
        session,
        command: tool.command,
        output: tool.outputExcerpt,
      });
      return EMPTY_HOOK_RESULT;
    }
    if (!tool.writes || tool.failed || tool.edits.length === 0) return EMPTY_HOOK_RESULT;

    const promptEvent = this.k.store.events.query(project.project.id, {
      sessionId: session.id,
      types: ['prompt.submitted'],
      order: 'desc',
      limit: 1,
    })[0];
    const changed: ChangedFile[] = [];
    for (const edit of tool.edits.slice(0, 50)) {
      const [resolved] = this.projectPaths(project, evt.cwd, [edit.path]);
      if (!resolved) continue;
      const hashes = this.k.ports.git.hunkHashes(edit.addedText);
      this.k.store.fileChanges.record({
        projectId: project.project.id,
        sessionId: session.id,
        path: resolved.rel,
        tool: sanitizeLine(tool.name, 40),
        hunkHashes: hashes,
        addedLines: countLines(edit.addedText),
        removedLines: countLines(edit.removedText),
        promptEventId: promptEvent?.id ?? null,
      });
      changed.push({
        path: resolved.rel,
        abs: resolved.abs,
        addedText: edit.addedText,
        removedText: edit.removedText,
        wholeFile: edit.wholeFile,
      });
    }
    if (changed.length === 0) return EMPTY_HOOK_RESULT;
    this.k.store.events.append({
      projectId: project.project.id,
      sessionId: session.id,
      type: 'file.changed',
      payload: { paths: changed.map((c) => c.path), tool: tool.name },
    });
    for (const c of changed) this.d.intents.checkRecentEditors(session, c.path);
    await this.d.bus.emit('files.changed', {
      projectId: project.project.id,
      projectRoot: project.root,
      session,
      files: changed,
    });
    return EMPTY_HOOK_RESULT;
  }

  private async stop(
    project: ProjectContext,
    session: Session,
    evt: NormalizedHookEvent,
  ): Promise<HookResult> {
    const files = this.k.store.fileChanges.recentPaths(
      session.id,
      session.lastSeenAt - 60 * 60_000,
    );
    this.k.store.events.append({
      projectId: project.project.id,
      sessionId: session.id,
      type: 'turn.completed',
      payload: { filesChanged: files.slice(0, 50) },
    });
    this.k.store.sessions.setStatus(session.id, 'idle');
    await this.d.bus.emit('turn.stopped', {
      projectId: project.project.id,
      projectRoot: project.root,
      session,
      lastMessage: evt.lastMessage,
      transcriptPath: evt.transcriptPath,
    });
    return EMPTY_HOOK_RESULT;
  }

  private async sessionEnd(project: ProjectContext, session: Session): Promise<HookResult> {
    this.k.store.sessions.setStatus(session.id, 'ended');
    this.d.intents.closeSession(session);
    this.k.store.events.append({
      projectId: project.project.id,
      sessionId: session.id,
      type: 'session.ended',
      payload: {},
    });
    await this.d.bus.emit('session.ended', {
      projectId: project.project.id,
      projectRoot: project.root,
      session,
    });
    return EMPTY_HOOK_RESULT;
  }
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split('\n').length;
}

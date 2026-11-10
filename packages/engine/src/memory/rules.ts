import {
  REPO_FILE_SOURCE,
  redactText,
  sanitizeLine,
  type Memory,
  type Session,
} from '@mindly/core';
import { DELIVERY_TTL_MS, LIVE_WINDOW_MS, type Kernel } from '../kernel.js';
import {
  dedupeRules,
  scanInstructionFiles,
  type InstructionFile,
  type InstructionRule,
} from './instructions.js';
import type { MemoryService } from './service.js';

/** What importing the project's instruction files would do. */
export interface InstructionImportPlan {
  files: InstructionFile[];
  /** Rules Mindly does not have yet. */
  fresh: InstructionRule[];
  /** Rules Mindly already has (by title, in any state) or that repeat an earlier file. */
  known: InstructionRule[];
}

/*
 * "Say it once": detects durable corrections in user prompts ("no, we use pnpm", "never edit
 * generated files", "from now on write tests first") and turns them into project rules that every
 * agent receives.
 *
 * The detector is deliberately conservative. Strong, explicitly durable phrasing becomes an
 * approved rule (the user said it); weaker phrasing becomes a *proposed* rule that is shown with an
 * "unconfirmed" label until the user approves it. Temporary or question-like phrasing is ignored.
 */

export interface DetectedRule {
  text: string;
  strength: 'strong' | 'medium';
}

const MAX_SENTENCE = 220;
/** Longest the model may take to confirm the corrections of one prompt, in milliseconds. */
export const MAX_MODEL_BUDGET_MS = 600;
/** Share of the hook deadline the model may use; the hook still has its context to build. */
const MODEL_BUDGET_SHARE = 0.4;

/** Reasons already logged by this process: the log says once that the model is not working. */
const loggedModelFailures = new Set<string>();
/** Rules from prompts longer than this are proposed rather than approved. */
export const MAX_APPROVABLE_PROMPT = 500;

const TEMPORARY =
  /\b(for now|this time|right now|for this (task|change|pr|commit)|temporar(y|ily)|just (for|this)|today|until|for the moment|in this (step|message))\b/i;
const STRONG = [
  /\b(always|never)\b/i,
  /\bfrom now on\b/i,
  /\bgoing forward\b/i,
  /\bin (this|our) (project|repo|repository|codebase)\b/i,
  /\b(we|our team) (always|never|use|prefer|don't use|do not use)\b/i,
  /\bmake sure (to )?(always|never)\b/i,
  /\b(remember|note) (that|to)\b/i,
];
const CORRECTION_START = /^(no|nope|wrong|not that)\b/i;
/** Imperatives about "anything/this/it" describe the current task, not a project convention. */
const VAGUE_OBJECT = /\b(anything|everything|nothing|it|this|that|these|those|them|yet)\s*[.!]?$/i;
const MEDIUM = [
  /^(no|nope|wrong|not that)[,.!:]?\s+(use|we|it|the|this|don't|do not)\b/i,
  /\buse \S+ (instead of|rather than|not) \S+/i,
  /^(please )?(don't|do not|stop) (use|using|add|adding|touch|touching|edit|editing|modify|modifying|run|running|commit|committing|create|creating)\b/i,
  /\bprefer \S+ (over|to) \S+/i,
];

function sentences(prompt: string): string[] {
  return prompt
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, (m) => m)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8 && s.length <= MAX_SENTENCE);
}

/** Pure heuristic detector, exported for testing. */
export function detectRules(prompt: string): DetectedRule[] {
  if (prompt.length > 8000) return [];
  const out: DetectedRule[] = [];
  const all = sentences(prompt);
  // Medium-strength phrasing ("don't touch X", "use A instead of B") is only a standing rule when
  // the message is itself a short correction. Inside a longer task request it is almost always an
  // instruction for that task ("…, do not run anything").
  const correctionMessage = all.length <= 2 && prompt.length <= 240;
  for (const s of all) {
    if (s.endsWith('?') || TEMPORARY.test(s)) continue;
    // Conditional and hypothetical sentences are not standing rules.
    if (/^(if|when|what if|could|can|should|would|why|how)\b/i.test(s)) continue;
    if (STRONG.some((re) => re.test(s))) out.push({ text: s, strength: 'strong' });
    else if (
      MEDIUM.some((re) => re.test(s)) &&
      (correctionMessage || CORRECTION_START.test(s)) &&
      !VAGUE_OBJECT.test(s)
    ) {
      out.push({ text: s, strength: 'medium' });
    }
    if (out.length >= 3) break;
  }
  return out;
}

/**
 * True when everything `glob` can match is already inside `scope`: an empty scope is the whole
 * project; otherwise `glob` must equal one of its patterns or sit below a `<folder>/**` one.
 * Anything else counts as possibly wider.
 */
export function scopeCovers(scope: readonly string[], glob: string): boolean {
  if (scope.length === 0) return true;
  const g = glob.replace(/^\.\//, '');
  if (g.split('/').includes('..')) return false;
  return scope.some((s) => {
    const o = s.replace(/^\.\//, '');
    if (o === g || o === '**') return true;
    if (!o.endsWith('/**')) return false;
    const base = o.slice(0, -2);
    return !/[*?{[]/.test(base) && g.startsWith(base) && g.length > base.length;
  });
}

/** Turns "no, use pnpm instead of npm." into a clean rule title. */
export function ruleTitle(text: string): string {
  const t = text
    .replace(/^(no|nope|wrong|not that|ok(ay)?|also|and|but|please)[,.!:]?\s+/i, '')
    .replace(/[.!]+$/, '')
    .trim();
  return sanitizeLine(t.charAt(0).toUpperCase() + t.slice(1), 160);
}

export class RuleService {
  constructor(
    private readonly k: Kernel,
    private readonly memory: MemoryService,
  ) {}

  /**
   * Captures rules from a user prompt. Returns the rules created or refreshed. Uses the optional
   * model only to confirm medium-strength candidates; never required.
   */
  async captureFromPrompt(input: {
    projectId: string;
    projectRoot: string;
    session: Session;
    prompt: string;
  }): Promise<Memory[]> {
    if (!this.k.config.rules.autoCapture || this.k.headless) return [];
    const detected = detectRules(input.prompt);
    // Long prompts and prompts with code blocks often contain pasted, untrusted text; rules found
    // there are only ever proposed, never auto-approved.
    const mayApprove =
      input.prompt.length <= MAX_APPROVABLE_PROMPT && !input.prompt.includes('```');
    const verdicts = await this.confirmWithModel(detected);
    const out: Memory[] = [];
    for (const [i, d] of detected.entries()) {
      const verdict = verdicts[i] ?? null;
      // The model may say a medium-strength sentence is not a rule, or narrow its scope. It
      // never raises its trust: weaker phrasing stays proposed until the user approves it.
      if (verdict && !verdict.isRule) continue;
      const strength = d.strength;
      const scopeGlobs = verdict
        ? this.modelScope(input.projectId, ruleTitle(d.text), verdict.scopeGlobs.slice(0, 5))
        : [];
      let rule: Memory;
      try {
        rule = this.memory.remember({
          projectId: input.projectId,
          projectRoot: input.projectRoot,
          kind: 'rule',
          title: ruleTitle(d.text),
          body: `Stated by the user in a ${input.session.agentKind} session: "${d.text}"`,
          tags: ['say-it-once'],
          scopePaths: scopeGlobs,
          // The user said it, but medium-strength phrasing may be situational: keep it proposed.
          source: { type: 'user', sessionId: input.session.id, agentKind: input.session.agentKind },
          trust: strength === 'strong' && mayApprove ? 'approved' : 'proposed',
          reason: 'captured from prompt',
        });
      } catch {
        continue;
      }
      out.push(rule);
      this.k.store.events.append({
        projectId: input.projectId,
        sessionId: input.session.id,
        type: 'rule.captured',
        payload: { memoryId: rule.id, title: rule.title, trust: rule.trust },
      });
      this.broadcast(input.projectId, input.session, rule);
    }
    return out;
  }

  /**
   * Asks the model about the medium-strength candidates, all at once and within a share of the
   * hook's deadline. A candidate the model did not answer for in time keeps its heuristic result,
   * so the rule is stored exactly as it would be with no model configured.
   */
  private async confirmWithModel(
    detected: readonly DetectedRule[],
  ): Promise<(Awaited<ReturnType<Kernel['ports']['llm']['classifyCorrection']>> | null)[]> {
    const llm = this.k.ports.llm;
    const none = detected.map(() => null);
    if (!llm.available) {
      if (llm.unavailableReason && detected.some((d) => d.strength === 'medium')) {
        this.logModelFailure(`the configured model cannot be used: ${llm.unavailableReason}`);
      }
      return none;
    }
    if (!detected.some((d) => d.strength === 'medium')) return none;
    const budget = Math.min(
      MAX_MODEL_BUDGET_MS,
      Math.floor(this.k.config.hooks.timeoutMs * MODEL_BUDGET_SHARE),
    );
    const controller = new AbortController();
    const deadline = Date.now() + budget;
    const timer = setTimeout(() => controller.abort(), budget);
    timer.unref?.();
    const extraPatterns = this.k.config.redaction.extraPatterns;
    try {
      return await Promise.all(
        detected.map((d) =>
          d.strength === 'medium'
            ? llm
                .classifyCorrection(redactText(d.text, { extraPatterns }), {
                  signal: controller.signal,
                  deadline,
                  redactPatterns: extraPatterns,
                  onFailure: (reason) => this.logModelFailure(reason),
                })
                .catch(() => null)
            : Promise.resolve(null),
        ),
      );
    } finally {
      clearTimeout(timer);
      // Whatever is still in flight is not waited for.
      controller.abort();
    }
  }

  /**
   * The scope a model suggested, as far as it may be used. A new rule takes it. A rule that
   * already exists keeps its scope (an empty list leaves it unchanged), unless it is still only
   * proposed and the suggestion stays inside it: the model may narrow a proposal, never widen
   * one, and never touches a rule the user decided on.
   */
  private modelScope(projectId: string, title: string, suggested: readonly string[]): string[] {
    if (suggested.length === 0) return [];
    const existing = this.memory.findSameTitle(projectId, 'rule', title, null);
    if (!existing) return [...suggested];
    const decided =
      existing.trust !== 'proposed' ||
      existing.enforce ||
      existing.pinned ||
      existing.status !== 'active';
    if (decided) return [];
    const current = existing.scope.paths;
    return suggested.every((g) => scopeCovers(current, g)) ? [...suggested] : [];
  }

  private logModelFailure(reason: string): void {
    const text = sanitizeLine(reason, 200);
    if (loggedModelFailures.has(text)) return;
    loggedModelFailures.add(text);
    if (text === 'out of time') {
      this.k.logger.debug('model did not confirm a rule in time; kept the heuristic result');
    } else {
      this.k.logger.warn('model call failed; rules are captured without it', { reason: text });
    }
  }

  /**
   * Reads the project's agent instruction files (CLAUDE.md, AGENTS.md, .cursorrules, …) and
   * returns the rules they contain that Mindly does not know yet. Rules the user archived or
   * rejected count as known, so a re-import never brings them back. Writes nothing; pass a null
   * project id for a project Mindly has not registered yet.
   */
  planImport(
    projectId: string | null,
    projectRoot: string,
    ignore: readonly string[] = [],
  ): InstructionImportPlan {
    const files = scanInstructionFiles(projectRoot, [
      ...this.k.config.redaction.denyPaths,
      ...ignore,
    ]);
    const known =
      projectId === null
        ? []
        : [
            ...this.memory.list(projectId, { kinds: ['rule'], status: 'active', limit: 1000 }),
            ...this.memory.list(projectId, { kinds: ['rule'], status: 'archived', limit: 1000 }),
          ].map((m) => m.title);
    return {
      files,
      ...dedupeRules(
        files.flatMap((f) => f.rules),
        known,
      ),
    };
  }

  /**
   * Stores rules from {@link planImport} with the repository file as their source. They are
   * `approved` (by the user, recorded as the user's approval) only when the user read the list and
   * confirmed it; otherwise they are `proposed` and wait for approval like any suggested rule.
   * Each rule keeps its source line as evidence, so it is marked stale when that line is edited
   * out of the file. Returns the rules stored.
   */
  importRules(
    projectId: string,
    projectRoot: string,
    rules: readonly InstructionRule[],
    trust: 'approved' | 'proposed',
  ): Memory[] {
    return this.memory.batchRuleChanges(() =>
      this.storeImported(projectId, projectRoot, rules, trust),
    );
  }

  private storeImported(
    projectId: string,
    projectRoot: string,
    rules: readonly InstructionRule[],
    trust: 'approved' | 'proposed',
  ): Memory[] {
    const out: Memory[] = [];
    for (const r of rules) {
      const where = `Imported from ${r.file}, line ${r.line}.`;
      try {
        // The repository wrote the rule, not the user: it is stored as a proposal from the file,
        // and becomes approved only through the user's own approval.
        const stored = this.memory.remember({
          projectId,
          projectRoot,
          kind: 'rule',
          title: r.title,
          body: r.title.endsWith('…') ? `${r.text}\n\n${where}` : where,
          tags: ['imported'],
          scopePaths: r.scopePaths,
          source: REPO_FILE_SOURCE,
          trust: 'proposed',
          evidence: [r.excerpt === null ? { path: r.file } : { path: r.file, excerpt: r.excerpt }],
          reason: `imported from ${r.file}`,
        });
        out.push(trust === 'approved' ? this.memory.approve(stored.id) : stored);
      } catch {
        // The file changed since it was read, or the path is now denied: skip that rule.
      }
    }
    return out;
  }

  /** Tells every other live session about a new rule right away (telepathy). */
  private broadcast(projectId: string, from: Session, rule: Memory): void {
    const others = this.k.store.sessions
      .listLive(projectId, LIVE_WINDOW_MS)
      .filter((s) => s.id !== from.id);
    for (const s of others) {
      this.k.store.deliveries.enqueue({
        projectId,
        targetSessionId: s.id,
        targetAgentKind: null,
        kind: 'rule',
        priority: rule.trust === 'approved' ? 5 : 2,
        title: `New project rule${rule.trust === 'approved' ? '' : ' (unconfirmed)'}: ${rule.title}`,
        body: `The user stated this in a ${from.agentKind} session.`,
        dedupeKey: `rule:${rule.id}:${s.id}`,
        sourceSessionId: from.id,
        ttlMs: DELIVERY_TTL_MS,
      });
    }
  }
}

import { sanitizeLine, type Memory, type Session } from '@synapse/core';
import { DELIVERY_TTL_MS, LIVE_WINDOW_MS, type Kernel } from '../kernel.js';
import type { MemoryService } from './service.js';

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
  for (const s of sentences(prompt)) {
    if (s.endsWith('?') || TEMPORARY.test(s)) continue;
    // Conditional and hypothetical sentences are not standing rules.
    if (/^(if|when|what if|could|can|should|would|why|how)\b/i.test(s)) continue;
    if (STRONG.some((re) => re.test(s))) out.push({ text: s, strength: 'strong' });
    else if (MEDIUM.some((re) => re.test(s))) out.push({ text: s, strength: 'medium' });
    if (out.length >= 3) break;
  }
  return out;
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
    if (!this.k.config.rules.autoCapture) return [];
    const detected = detectRules(input.prompt);
    const out: Memory[] = [];
    for (const d of detected) {
      let strength = d.strength;
      let scopeGlobs: string[] = [];
      if (strength === 'medium' && this.k.ports.llm.available) {
        const verdict = await this.k.ports.llm.classifyCorrection(d.text);
        if (verdict && !verdict.isRule) continue;
        if (verdict && verdict.confidence >= 0.8) strength = 'strong';
        if (verdict) scopeGlobs = verdict.scopeGlobs.slice(0, 5);
      }
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
          trust: strength === 'strong' ? 'approved' : 'proposed',
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

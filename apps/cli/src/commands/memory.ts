import {
  CONTRACT_KINDS,
  MEMORY_KINDS,
  MindlyError,
  TRUST_LEVELS,
  type ContractKind,
  type Memory,
} from '@mindly/core';
import { commandHash, contractsOf, USER } from '@mindly/engine';
import { z } from 'zod';
import { projectPath, withProject, type ProjectScope } from '../context.js';
import { confirm } from '../io.js';
import {
  clean,
  cleanBlock,
  ensureFound,
  formatTime,
  requireId,
  table,
  UsageError,
  type Out,
} from '../util.js';

const ListOptions = z.object({
  kind: z.enum(MEMORY_KINDS).optional(),
  trust: z.enum(TRUST_LEVELS).optional(),
  archived: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).optional(),
  json: z.boolean().optional(),
});

const AddOptions = z.object({
  kind: z.enum(MEMORY_KINDS),
  title: z.string().trim().min(1).max(160),
  body: z.string().max(4000).default(''),
  tag: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  scope: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
  enforce: z.boolean().optional(),
  pin: z.boolean().optional(),
  json: z.boolean().optional(),
});

/** Parses commander options with a zod schema; failures are usage errors (exit 2). */
export function parseOptions<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) {
    const issue = r.error.issues[0];
    const where = issue && issue.path.length > 0 ? `--${issue.path.join('.')}: ` : '';
    throw new UsageError(`${where}${issue?.message ?? 'invalid options'}`);
  }
  return r.data;
}

function flags(m: Memory): string {
  const f: string[] = [];
  if (m.enforce) f.push('enforced');
  if (m.pinned) f.push('pinned');
  if (m.status !== 'active') f.push(m.status);
  return f.length ? ` [${f.join(', ')}]` : '';
}

/** Prints memories as an aligned list. */
export function printMemories(out: Out, memories: readonly Memory[]): void {
  if (memories.length === 0) {
    out.line(out.style.dim('No memories.'));
    return;
  }
  const rows = memories.map((m) => [m.id, m.kind, m.trust, `${clean(m.title, 100)}${flags(m)}`]);
  for (const line of table(rows)) out.line(line);
}

/** Fetches a memory of the current project by id. */
function memoryOf(scope: ProjectScope, id: string): Memory {
  const m = scope.mindly.store.memories.find(requireId(id, 'memory id'));
  ensureFound(m !== null && m.projectId === scope.project.project.id, 'memory');
  return m as Memory;
}

/** `mindly memory list`. */
export async function memoryList(out: Out, raw: unknown): Promise<number> {
  const o = parseOptions(ListOptions, raw);
  return withProject(out.io, ({ mindly, project }) => {
    const memories = mindly.memory.list(project.project.id, {
      ...(o.kind ? { kinds: [o.kind] } : {}),
      ...(o.trust ? { trust: [o.trust] } : {}),
      status: o.archived ? 'archived' : 'active',
      limit: o.limit ?? 100,
    });
    if (o.json) out.json(memories);
    else printMemories(out, memories);
    return 0;
  });
}

/** `mindly memory search <query>`. */
export async function memorySearch(out: Out, query: string, raw: unknown): Promise<number> {
  const o = parseOptions(ListOptions, raw);
  const q = z.string().trim().min(1).max(500).safeParse(query);
  if (!q.success) throw new UsageError('search query must be 1-500 characters');
  return withProject(out.io, ({ mindly, project }) => {
    const hits = mindly.memory
      .search(project.project.id, q.data, {
        ...(o.kind ? { kinds: [o.kind] } : {}),
        ...(o.trust ? { trust: [o.trust] } : {}),
        limit: o.limit ?? 50,
      })
      .map((h) => h.memory);
    if (o.json) out.json(hits);
    else printMemories(out, hits);
    return 0;
  });
}

/** `mindly memory show <id>`. */
export async function memoryShow(out: Out, id: string, raw: { json?: boolean }): Promise<number> {
  return withProject(out.io, (scope) => {
    const m = memoryOf(scope, id);
    const store = scope.mindly.store;
    const versions = store.memories.versions(m.id);
    const evidence = store.memories.evidenceFor(m.id);
    const contracts = store.contracts.forMemory(m.id);
    if (raw.json) {
      out.json({ memory: m, versions, evidence, contracts });
      return 0;
    }
    const s = out.style;
    out.line(s.bold(clean(m.title, 160)));
    out.line(
      `${m.kind} | ${m.trust} | ${m.status} | source ${m.source.type}${m.source.agentKind ? ` (${clean(m.source.agentKind, 40)})` : ''} | v${m.version}${flags(m)}`,
    );
    out.line(s.dim(`id ${m.id} | updated ${formatTime(m.updatedAt)}`));
    if (m.tags.length) out.line(`tags: ${m.tags.map((t) => clean(t, 60)).join(', ')}`);
    if (m.scope.paths.length) out.line(`scope: ${m.scope.paths.map((p) => clean(p)).join(', ')}`);
    if (m.scope.branch) out.line(`branch: ${clean(m.scope.branch)}`);
    if (m.body) {
      out.line();
      out.line(cleanBlock(m.body));
    }
    if (evidence.length) {
      out.line();
      out.line(s.bold('Evidence'));
      for (const e of evidence) {
        out.line(
          `  ${e.valid ? s.green('valid') : s.yellow('changed')}  ${e.type} ${clean(e.ref)}`,
        );
      }
    }
    if (contracts.length) {
      out.line();
      out.line(s.bold('Contracts'));
      for (const c of contracts) out.line(`  ${c.id}  ${c.kind}  ${c.state}`);
    }
    if (versions.length > 1) {
      out.line();
      out.line(s.bold('History'));
      for (const v of versions) {
        out.line(
          `  v${v.version}  ${formatTime(v.createdAt)}  ${v.trust}  by ${v.changedBy.type}${v.reason ? `: ${clean(v.reason, 100)}` : ''}`,
        );
      }
    }
    return 0;
  });
}

/** `mindly memory add`. */
export async function memoryAdd(out: Out, raw: unknown): Promise<number> {
  const o = parseOptions(AddOptions, raw);
  if (o.enforce && o.kind !== 'rule') throw new UsageError('--enforce only applies to rules');
  return withProject(out.io, ({ mindly, project }) => {
    const m = mindly.memory.remember({
      projectId: project.project.id,
      projectRoot: project.root,
      kind: o.kind,
      title: o.title,
      body: o.body,
      source: USER,
      reason: 'added with the mindly CLI',
      ...(o.tag ? { tags: o.tag } : {}),
      ...(o.scope ? { scopePaths: o.scope } : {}),
      ...(o.enforce !== undefined ? { enforce: o.enforce } : {}),
      ...(o.pin !== undefined ? { pinned: o.pin } : {}),
    });
    if (o.json) out.json(m);
    else out.line(`Saved ${m.kind} ${m.id} (${m.trust}).`);
    return 0;
  });
}

type Action = 'approve' | 'reject' | 'archive';

/** `mindly memory approve|reject|archive <id>`. */
export async function memoryAction(out: Out, action: Action, id: string): Promise<number> {
  return withProject(out.io, (scope) => {
    const m = memoryOf(scope, id);
    const svc = scope.mindly.memory;
    const updated =
      action === 'approve'
        ? svc.approve(m.id)
        : action === 'reject'
          ? svc.reject(m.id)
          : svc.archive(m.id, USER);
    out.line(
      `${action === 'approve' ? 'Approved' : action === 'reject' ? 'Rejected' : 'Archived'}: ${clean(updated.title, 100)} (${updated.trust}, ${updated.status}).`,
    );
    return 0;
  });
}

/** `mindly memory forget <id>`: hard delete of one memory and its history. */
export async function memoryForget(out: Out, id: string, o: { yes?: boolean }): Promise<number> {
  return withProject(out.io, async (scope) => {
    const m = memoryOf(scope, id);
    out.line(`This permanently deletes "${clean(m.title, 100)}" and its whole history.`);
    if (!(await confirm(out.io, 'Delete it?', o.yes === true))) return 1;
    scope.mindly.memory.forget(m.id);
    out.line('Deleted.');
    return 0;
  });
}

/** `mindly rules [--approve <id>]`. */
export async function rules(out: Out, o: { approve?: string; json?: boolean }): Promise<number> {
  return withProject(out.io, (scope) => {
    const pid = scope.project.project.id;
    if (o.approve !== undefined) {
      const m = memoryOf(scope, o.approve);
      if (m.kind !== 'rule') throw new MindlyError('invalid_input', 'that memory is not a rule');
      scope.mindly.memory.approve(m.id);
      out.line(`Approved rule: ${clean(m.title, 120)}`);
      return 0;
    }
    const list = (trust: Memory['trust'][]): Memory[] =>
      scope.mindly.memory.list(pid, { kinds: ['rule'], trust, status: 'active', limit: 200 });
    const approved = list(['approved', 'verified']);
    const proposed = list(['proposed']);
    if (o.json) {
      out.json({ approved, proposed });
      return 0;
    }
    out.line(out.style.bold(`Approved rules (${approved.length})`));
    printMemories(out, approved);
    out.line();
    out.line(out.style.bold(`Proposed rules (${proposed.length})`));
    printMemories(out, proposed);
    if (proposed.length) {
      out.line(out.style.dim('Approve one with: mindly rules --approve <id>'));
    }
    return 0;
  });
}

const ContractOptions = z.object({
  kind: z.enum(CONTRACT_KINDS),
  path: z.string().min(1).max(300).optional(),
  pattern: z.string().min(1).max(500).optional(),
  key: z.string().min(1).max(200).optional(),
  symbol: z.string().min(1).max(120).optional(),
  argv: z.string().min(2).max(20_000).optional(),
  timeout: z.number().int().min(1).max(600).optional(),
  yes: z.boolean().optional(),
  json: z.boolean().optional(),
});

const ArgvJson = z.array(z.string().min(1).max(1000)).min(1).max(50);

/**
 * `mindly contract add <memoryId> --kind ...`: binds an executable check to a memory. Command
 * contracts are only created here (by the user) and pin the hash of the argv shown.
 */
export async function contractAdd(out: Out, memoryId: string, raw: unknown): Promise<number> {
  const o = parseOptions(ContractOptions, raw);
  const kind: ContractKind = o.kind;
  const allowed: Record<ContractKind, readonly string[]> = {
    file_exists: ['path'],
    pattern_present: ['path', 'pattern'],
    pattern_absent: ['path', 'pattern'],
    json_key: ['path', 'key'],
    export_present: ['path', 'symbol'],
    command: ['argv', 'timeout'],
  };
  const given = (['path', 'pattern', 'key', 'symbol', 'argv', 'timeout'] as const).filter(
    (k) => o[k] !== undefined,
  );
  const extra = given.filter((k) => !allowed[kind].includes(k));
  if (extra.length) throw new UsageError(`--${extra[0]} does not apply to ${kind} contracts`);

  return withProject(out.io, async (scope) => {
    const m = memoryOf(scope, memoryId);
    let spec: Record<string, unknown>;
    if (kind === 'command') {
      if (o.argv === undefined) throw new UsageError('--argv is required for command contracts');
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(o.argv);
      } catch {
        throw new UsageError('--argv must be a JSON array of strings');
      }
      const argv = ArgvJson.safeParse(parsedJson);
      if (!argv.success) throw new UsageError('--argv must be a JSON array of 1-50 strings');
      spec = { argv: argv.data, ...(o.timeout !== undefined ? { timeoutSec: o.timeout } : {}) };
      out.line('Command contract (runs without a shell, in the daemon, only for this argv):');
      out.line(`  argv: ${JSON.stringify(argv.data)}`);
      out.line(`  pinned hash: ${commandHash(argv.data)}`);
      if (!(await confirm(out.io, 'Approve this command?', o.yes === true))) return 1;
    } else {
      if (o.path === undefined) throw new UsageError(`--path is required for ${kind} contracts`);
      const rel = projectPath(scope, out.io.cwd, o.path).rel;
      spec = { path: rel };
      for (const k of allowed[kind]) {
        if (k === 'path') continue;
        const v = o[k as 'pattern' | 'key' | 'symbol'];
        if (v === undefined) throw new UsageError(`--${k} is required for ${kind} contracts`);
        spec[k] = v;
      }
    }
    const c = contractsOf(scope.mindly).create(m.id, kind, spec, USER);
    if (o.json) out.json(c);
    else {
      out.line(`Contract ${c.id} (${c.kind}) bound to "${clean(m.title, 80)}": ${c.state}.`);
      if (c.lastMessage) out.line(out.style.dim(clean(c.lastMessage, 200)));
    }
    return 0;
  });
}

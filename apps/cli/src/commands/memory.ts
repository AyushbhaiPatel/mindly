import {
  CONTRACT_KINDS,
  MEMORY_KINDS,
  shortId,
  TRUST_LEVELS,
  type ContractKind,
  type Memory,
} from '@mindly/core';
import { commandHash, contractsOf, USER } from '@mindly/engine';
import { z } from 'zod';
import { projectPath, withProject, type ProjectScope } from '../context.js';
import { resolveId } from '../ids.js';
import { confirm } from '../io.js';
import {
  argvWords,
  contractStateWord,
  contractWords,
  memoryKindWord,
  trustWord,
} from '../present/index.js';
import { clean, HintedError, UsageError, type Out } from '../util.js';
import { renderMemoryList, renderMemoryShow, renderRules } from '../views/memory.js';

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

/** Fetches a memory of the current project by full, short or prefix id. */
function memoryOf(scope: ProjectScope, id: string): Memory {
  const pid = scope.project.project.id;
  return scope.mindly.store.memories.get(resolveId(scope.mindly.store, 'memory', pid, id));
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
    else {
      renderMemoryList(out.screen(), memories, {
        archived: o.archived === true,
        filtered: o.kind !== undefined || o.trust !== undefined,
      });
    }
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
    else renderMemoryList(out.screen(), hits, { query: q.data });
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
    renderMemoryShow(out.screen(), { memory: m, versions, evidence, contracts });
    return 0;
  });
}

/** `mindly memory add`. */
export async function memoryAdd(out: Out, raw: unknown): Promise<number> {
  const o = parseOptions(AddOptions, raw);
  if (o.enforce && o.kind !== 'rule') throw new UsageError('--enforce only works with --kind rule');
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
    else {
      const sc = out.screen();
      sc.text(
        `${sc.mark('ok')} Saved ${memoryKindWord(m.kind)} "${clean(m.title, 100)}" ${sc.ref(m.id)}`,
      );
      sc.note(
        m.trust === 'approved' || m.trust === 'verified'
          ? 'Every agent in this project gets it from now on.'
          : `It is ${trustWord(m.trust, m.source)}.`,
        2,
      );
    }
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
    const sc = out.screen();
    const what = `${memoryKindWord(updated.kind)} "${clean(updated.title, 100)}"`;
    if (action === 'approve') {
      sc.text(`${sc.mark('ok')} Approved ${what}.`);
      sc.note('Every agent in this project gets it from now on.', 2);
    } else if (action === 'reject') {
      sc.text(`${sc.mark('ok')} Rejected ${what}.`);
      sc.note('Agents will not be told about it.', 2);
    } else {
      sc.text(`${sc.mark('ok')} Archived ${what}.`);
      sc.note('It is no longer sent to agents; see it with: mindly memory list --archived', 2);
    }
    return 0;
  });
}

/** `mindly memory forget <id>`: hard delete of one memory and its history. */
export async function memoryForget(out: Out, id: string, o: { yes?: boolean }): Promise<number> {
  return withProject(out.io, async (scope) => {
    const m = memoryOf(scope, id);
    out.line(
      `This permanently deletes the ${memoryKindWord(m.kind)} "${clean(m.title, 100)}" and its whole history.`,
    );
    if (!(await confirm(out.io, 'Delete it?', o.yes === true))) {
      out.line('Nothing was deleted.');
      return 1;
    }
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
      if (m.kind !== 'rule') {
        throw new HintedError(
          'invalid_input',
          `${shortId(m.id)} is a ${memoryKindWord(m.kind)}, not a rule.`,
          `Approve it with: mindly memory approve ${shortId(m.id)}`,
        );
      }
      scope.mindly.memory.approve(m.id);
      const sc = out.screen();
      sc.text(`${sc.mark('ok')} Approved rule "${clean(m.title, 120)}".`);
      sc.note('Every agent in this project follows it from now on.', 2);
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
    renderRules(out.screen(), approved, proposed);
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
  if (extra.length) throw new UsageError(`--${extra[0]} does not apply to --kind ${kind}`);

  return withProject(out.io, async (scope) => {
    const m = memoryOf(scope, memoryId);
    let spec: Record<string, unknown>;
    if (kind === 'command') {
      if (o.argv === undefined)
        throw new UsageError('--kind command needs --argv, e.g. --argv \'["pnpm","test"]\'');
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(o.argv);
      } catch {
        throw new UsageError('--argv must be a JSON array of strings');
      }
      const argv = ArgvJson.safeParse(parsedJson);
      if (!argv.success) throw new UsageError('--argv must be a JSON array of 1-50 strings');
      spec = { argv: argv.data, ...(o.timeout !== undefined ? { timeoutSec: o.timeout } : {}) };
      out.line(
        `This check runs a command on your machine (without a shell, in the background service) to confirm "${clean(m.title, 80)}":`,
      );
      out.line(`  command: ${argvWords(argv.data)}`);
      out.line(`  argv: ${JSON.stringify(argv.data)}`);
      out.line(`  pinned hash: ${commandHash(argv.data)}`);
      out.line(out.style.dim('  Only this exact command will ever run for it.'));
      if (!(await confirm(out.io, 'Allow this command?', o.yes === true))) {
        out.line('No check was added.');
        return 1;
      }
    } else {
      if (o.path === undefined) throw new UsageError(`--kind ${kind} needs --path <file>`);
      const rel = projectPath(scope, out.io.cwd, o.path).rel;
      spec = { path: rel };
      for (const k of allowed[kind]) {
        if (k === 'path') continue;
        const v = o[k as 'pattern' | 'key' | 'symbol'];
        if (v === undefined) throw new UsageError(`--kind ${kind} needs --${k}`);
        spec[k] = v;
      }
    }
    const c = contractsOf(scope.mindly).create(m.id, kind, spec, USER);
    if (o.json) out.json(c);
    else {
      const sc = out.screen();
      sc.text(
        `${sc.mark('ok')} Check added to "${clean(m.title, 80)}": ${clean(contractWords(c.kind, c.spec), 200)} ${sc.ref(c.id)}`,
      );
      sc.text(
        `${sc.mark(c.state === 'passing' ? 'ok' : c.state === 'unknown' ? 'item' : 'fail')} Right now it is ${contractStateWord(c.state)}${c.lastMessage && c.state !== 'passing' ? `: ${clean(c.lastMessage, 200)}` : '.'}`,
        2,
      );
    }
    return 0;
  });
}

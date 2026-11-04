import { Command, CommanderError } from 'commander';
import { AGENT_KIND_RE, isMindlyError, MINDLY_VERSION, type ErrorCode } from '@mindly/core';
import { symbolsFor, toAscii, useAscii } from './present/terminal.js';
import { processIo, type CliIo } from './io.js';
import {
  collect,
  EXIT_ERROR,
  EXIT_OK,
  EXIT_USAGE,
  HintedError,
  outFor,
  positiveInt,
  stripControl,
  UsageError,
  type Out,
} from './util.js';

/*
 * Command definitions. Every action lazy-imports its implementation so `mindly hook` (run for
 * every agent event) only loads what it needs; the daemon, MCP server and runners are loaded only
 * by the commands that use them.
 */

type Action = (out: Out) => Promise<number> | number;

function build(io: CliIo, setCode: (code: number) => void): Command {
  const out = outFor(io);
  const act =
    <A extends unknown[]>(fn: (...args: A) => Action) =>
    async (...args: A): Promise<void> => {
      setCode(await fn(...args)(out));
    };

  const program = new Command('mindly')
    .description('Shared memory and live coordination for coding agents.')
    .version(MINDLY_VERSION, '-v, --version')
    .exitOverride()
    .configureOutput({
      writeOut: (s) => io.stdout.write(s),
      writeErr: (s) => io.stderr.write(s),
    })
    .showSuggestionAfterError()
    .helpCommand(true);

  // ---- agent entry points ------------------------------------------------------------------
  program
    .command('hook')
    .description('Handle one agent hook event (called by agent hooks; reads JSON on stdin)')
    .argument('<agent>', 'agent kind: claude-code, codex or cursor')
    .argument('<event>', 'native hook event name')
    .action(
      act((agent: string, event: string) => async () => {
        const { runHook } = await import('./hook.js');
        return runHook(agent, event, io);
      }),
    );

  program
    .command('statusline')
    .description(
      'Print the Claude Code status line: rules, updates and conflicts (reads JSON on stdin)',
    )
    .action(
      act(() => async () => {
        const { runStatusLine } = await import('./statusline.js');
        return runStatusLine(io);
      }),
    );

  program
    .command('mcp')
    .description('Run the Mindly MCP server on stdio (started by agents)')
    .requiredOption('--agent <kind>', 'agent kind using this server')
    .action(
      act((o: { agent: string }) => async () => {
        if (!AGENT_KIND_RE.test(o.agent)) throw new UsageError('invalid --agent');
        const { startMcpServer } = await import('@mindly/mcp');
        await startMcpServer({ agentKind: o.agent, cwd: io.cwd, env: io.env });
        return EXIT_OK;
      }),
    );

  // ---- setup ---------------------------------------------------------------------------------
  const setupOptions = (cmd: Command): Command =>
    cmd
      .option('--agents <list>', 'comma-separated, e.g. claude-code,codex,cursor,windsurf')
      .option('--project', 'configure this project only instead of user-wide')
      .option('-y, --yes', 'apply without asking')
      .option('--dry-run', 'show the changes without writing anything');
  setupOptions(
    program.command('init').description('Connect your agents to Mindly and initialise storage'),
  )
    .option('--list-agents', 'list supported agents and their integration level')
    .option('--no-statusline', "don't add Mindly's status line to Claude Code")
    .option('--no-import', 'do not import rules from CLAUDE.md, AGENTS.md and similar files')
    .action(act((o: object) => async (out) => (await import('./commands/setup.js')).init(out, o)));
  setupOptions(
    program.command('uninstall').description('Remove Mindly hooks and MCP entries from agents'),
  ).action(
    act((o: object) => async (out) => (await import('./commands/setup.js')).uninstall(out, o)),
  );

  program
    .command('doctor')
    .description('Check the installation (never prints secrets)')
    .option('--json', 'machine-readable output')
    .action(
      act((o: object) => async (out) => (await import('./commands/doctor.js')).doctor(out, o)),
    );

  const config = program.command('config').description('Read or change $MINDLY_HOME/config.json');
  config
    .command('get')
    .argument('[key]', 'dotted key, e.g. hooks.timeoutMs')
    .description('Print the effective value (defaults included)')
    .action(
      act(
        (key: string | undefined) => async (out) =>
          (await import('./commands/config.js')).configGet(out, key),
      ),
    );
  config
    .command('set')
    .argument('<key>', 'dotted key, e.g. hooks.timeoutMs')
    .argument('<value>', 'JSON value or plain text')
    .description('Validate and write one setting')
    .action(
      act(
        (key: string, value: string) => async (out) =>
          (await import('./commands/config.js')).configSet(out, key, value),
      ),
    );
  config
    .command('path')
    .description('Print the config file path')
    .action(act(() => async (out) => (await import('./commands/config.js')).configPathCmd(out)));

  // ---- daemon --------------------------------------------------------------------------------
  const daemon = program.command('daemon').description('Manage the optional local daemon');
  daemon
    .command('start')
    .description('Start the daemon (in the background unless --foreground)')
    .option('--foreground', 'run in this terminal')
    .action(
      act((o: object) => async (out) => (await import('./commands/daemon.js')).daemonStart(out, o)),
    );
  daemon
    .command('stop')
    .description('Stop the daemon')
    .action(act(() => async (out) => (await import('./commands/daemon.js')).daemonStop(out)));
  daemon
    .command('status')
    .description('Show whether the daemon is running')
    .option('--json', 'machine-readable output')
    .action(
      act(
        (o: object) => async (out) => (await import('./commands/daemon.js')).daemonStatus(out, o),
      ),
    );
  program
    .command('dashboard')
    .description('Open Mission Control in the browser (starts the daemon if needed)')
    .option('--no-open', 'only print the URL')
    .action(
      act(
        (o: { open?: boolean }) => async (out) =>
          (await import('./commands/daemon.js')).dashboard(out, o),
      ),
    );

  // ---- project -------------------------------------------------------------------------------
  program
    .command('status')
    .description('Live agents, tasks, intents, conflicts and what needs you')
    .option('--json', 'machine-readable output')
    .action(
      act((o: object) => async (out) => (await import('./commands/insight.js')).status(out, o)),
    );

  const memory = program.command('memory').description('Inspect and manage project memory');
  const listOpts = (cmd: Command): Command =>
    cmd
      .option('--kind <kind>', 'fact, decision, rule, mistake or note')
      .option('--trust <trust>', 'verified, approved, proposed, stale or rejected')
      .option('--limit <n>', 'maximum results', positiveInt(500))
      .option('--json', 'machine-readable output');
  listOpts(
    memory.command('list').description('List memories').option('--archived', 'archived only'),
  ).action(
    act((o: object) => async (out) => (await import('./commands/memory.js')).memoryList(out, o)),
  );
  listOpts(memory.command('search').description('Full-text search').argument('<query...>')).action(
    act(
      (q: string[], o: object) => async (out) =>
        (await import('./commands/memory.js')).memorySearch(out, q.join(' '), o),
    ),
  );
  memory
    .command('show')
    .argument('<id>')
    .description('Show a memory with history, evidence and contracts')
    .option('--json', 'machine-readable output')
    .action(
      act(
        (id: string, o: object) => async (out) =>
          (await import('./commands/memory.js')).memoryShow(out, id, o),
      ),
    );
  memory
    .command('add')
    .description('Add a memory as the user (approved)')
    .requiredOption('--kind <kind>', 'fact, decision, rule, mistake or note')
    .requiredOption('--title <title>', 'short title')
    .option('--body <body>', 'details', '')
    .option('--tag <tag>', 'tag (repeatable)', collect)
    .option('--scope <glob>', 'limit to paths matching this glob (repeatable)', collect)
    .option('--enforce', 'rules only: deny tool calls that violate it')
    .option('--pin', 'always include in session context')
    .option('--json', 'machine-readable output')
    .action(
      act((o: object) => async (out) => (await import('./commands/memory.js')).memoryAdd(out, o)),
    );
  for (const action of ['approve', 'reject', 'archive'] as const) {
    memory
      .command(action)
      .argument('<id>')
      .description(`${action[0]?.toUpperCase()}${action.slice(1)} a memory`)
      .action(
        act(
          (id: string) => async (out) =>
            (await import('./commands/memory.js')).memoryAction(out, action, id),
        ),
      );
  }
  memory
    .command('forget')
    .argument('<id>')
    .description('Permanently delete a memory and its history')
    .option('-y, --yes', 'do not ask')
    .action(
      act(
        (id: string, o: object) => async (out) =>
          (await import('./commands/memory.js')).memoryForget(out, id, o),
      ),
    );

  const rules = program
    .command('rules')
    .description('List approved and proposed rules')
    .option('--approve <id>', 'approve a proposed rule')
    .option('--json', 'machine-readable output')
    .action(
      act((o: object) => async (out) => (await import('./commands/memory.js')).rules(out, o)),
    );
  rules
    .command('import')
    .description('Import rules from CLAUDE.md, AGENTS.md, .cursorrules and similar files')
    .option('-y, --yes', 'import without asking')
    .option('--dry-run', 'show the rules without importing them')
    .action(
      act(
        (o: object) => async (out) =>
          (await import('./commands/import.js')).offerRuleImport(out, o, 'rules'),
      ),
    );

  program
    .command('contract')
    .description('Executable memory')
    .command('add')
    .argument('<memoryId>')
    .description('Bind a check to a memory')
    .requiredOption(
      '--kind <kind>',
      'file_exists, pattern_present, pattern_absent, json_key, export_present or command',
    )
    .option('--path <path>', 'file the check reads')
    .option('--pattern <regex>', 'pattern_present / pattern_absent')
    .option('--key <dot.path>', 'json_key')
    .option('--symbol <name>', 'export_present')
    .option('--argv <json>', 'command: JSON array, run without a shell')
    .option('--timeout <sec>', 'command: time limit in seconds', positiveInt(600))
    .option('-y, --yes', 'approve a command without asking')
    .option('--json', 'machine-readable output')
    .action(
      act(
        (id: string, o: object) => async (out) =>
          (await import('./commands/memory.js')).contractAdd(out, id, o),
      ),
    );

  program
    .command('why')
    .argument('<file:line>')
    .description('Which agent wrote a line, and why')
    .option('--json', 'machine-readable output')
    .action(
      act(
        (spec: string, o: object) => async (out) =>
          (await import('./commands/insight.js')).why(out, spec, o),
      ),
    );

  program
    .command('xray')
    .description('What context a session received, or why a memory did not reach it')
    .option('--session <id>', 'session (default: the most recent)')
    .option('--query <text>', 'explain which memories matching this would be served')
    .option('--limit <n>', 'packets to show', positiveInt(100))
    .option('--json', 'machine-readable output')
    .action(
      act((o: object) => async (out) => (await import('./commands/insight.js')).xray(out, o)),
    );

  program
    .command('standup')
    .description('What your agents did and what needs you')
    .option('--since <duration>', 'e.g. 24h, 3d (default: since the last standup)')
    .option('--json', 'machine-readable output')
    .action(
      act((o: object) => async (out) => (await import('./commands/insight.js')).standup(out, o)),
    );

  program
    .command('handoff')
    .description("Hand a session's task to another agent")
    .requiredOption('--summary <text>', 'what the next agent should continue')
    .option('--to <agent>', 'agent kind that should pick it up (default: any)')
    .option('--next <step>', 'next step (repeatable)', collect)
    .option('--blocker <text>', 'blocker (repeatable)', collect)
    .option('--session <id>', 'session handing off (default: the most recent)')
    .option('--json', 'machine-readable output')
    .action(
      act((o: object) => async (out) => (await import('./commands/continuity.js')).handoff(out, o)),
    );
  program
    .command('handoffs')
    .description('List handoffs')
    .option('--json', 'machine-readable output')
    .action(
      act(
        (o: object) => async (out) => (await import('./commands/continuity.js')).handoffs(out, o),
      ),
    );

  const snapshot = program.command('snapshot').description('Multi-agent time machine');
  snapshot
    .command('create')
    .argument('<label>')
    .description('Snapshot code, memory and task state')
    .option('--json', 'machine-readable output')
    .action(
      act(
        (label: string, o: object) => async (out) =>
          (await import('./commands/continuity.js')).snapshotCreate(out, label, o),
      ),
    );
  snapshot
    .command('list')
    .description('List snapshots')
    .option('--json', 'machine-readable output')
    .action(
      act(
        (o: object) => async (out) =>
          (await import('./commands/continuity.js')).snapshotList(out, o),
      ),
    );
  snapshot
    .command('diff')
    .argument('<id>')
    .description('What changed since a snapshot')
    .option('--json', 'machine-readable output')
    .action(
      act(
        (id: string, o: object) => async (out) =>
          (await import('./commands/continuity.js')).snapshotDiff(out, id, o),
      ),
    );
  snapshot
    .command('restore')
    .argument('<id>')
    .description('Restore memory and task state (non-destructive)')
    .option('--branch <name>', "also create a branch at the snapshot's code")
    .option('-y, --yes', 'do not ask')
    .option('--json', 'machine-readable output')
    .action(
      act(
        (id: string, o: object) => async (out) =>
          (await import('./commands/continuity.js')).snapshotRestore(out, id, o),
      ),
    );

  program
    .command('conflicts')
    .description('List open conflicts')
    .option('--all', 'include resolved and dismissed')
    .option('--json', 'machine-readable output')
    .action(
      act((o: object) => async (out) => (await import('./commands/insight.js')).conflicts(out, o)),
    );
  program
    .command('conflict')
    .argument('<id>')
    .argument('<action>', 'resolve, dismiss or ack')
    .description('Resolve, dismiss or acknowledge a conflict')
    .action(
      act(
        (id: string, action: string) => async (out) =>
          (await import('./commands/insight.js')).conflictAction(out, id, action),
      ),
    );

  program
    .command('trust')
    .description("Review and trust this project's .mindly/config.json")
    .option('--show', 'only show the config, its checks and hash')
    .option('--revoke', 'stop trusting it')
    .option('-y, --yes', 'trust without asking')
    .option('--json', 'machine-readable output')
    .action(act((o: object) => async (out) => (await import('./commands/data.js')).trust(out, o)));

  program
    .command('review')
    .description("Cross-agent review of a session's changes")
    .requiredOption('--session <id>', 'session to review')
    .requiredOption('--reviewer <agent>', 'claude-code or codex (not the author)')
    .option('--json', 'machine-readable output')
    .action(act((o: object) => async (out) => (await import('./commands/runs.js')).review(out, o)));
  program
    .command('replay')
    .description('A/B replay of a prompt with several agents from the same commit')
    .requiredOption('--prompt <text>', 'the task')
    .requiredOption('--agents <list>', 'comma-separated: claude-code,codex')
    .option('--base <rev>', 'base commit (default HEAD)')
    .option('--json', 'machine-readable output')
    .action(act((o: object) => async (out) => (await import('./commands/runs.js')).replay(out, o)));

  program
    .command('export')
    .description("Export this project's data as JSON")
    .option('--out <file>', 'write to a file (mode 0600) instead of stdout')
    .option('--force', 'overwrite an existing file')
    .action(
      act((o: object) => async (out) => (await import('./commands/data.js')).exportCmd(out, o)),
    );
  program
    .command('forget')
    .description('Permanently delete data')
    .option('--project', 'everything stored for this project')
    .option('--memory <id>', 'one memory and its history')
    .option('-y, --yes', 'do not ask')
    .action(act((o: object) => async (out) => (await import('./commands/data.js')).forget(out, o)));

  return program;
}

/**
 * Runs the `mindly` command with `argv` (without the node and script paths) and returns the exit
 * code: 0 ok, 1 error, 2 usage. Never calls `process.exit`.
 */
export async function run(argv: readonly string[], io: CliIo = processIo()): Promise<number> {
  let code = EXIT_OK;
  const program = build(io, (c) => {
    code = c;
  });
  try {
    await program.parseAsync([...argv], { from: 'user' });
    return code;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help and version print and "fail" with exit code 0; parse errors were already printed.
      return err.exitCode === 0 ? EXIT_OK : EXIT_USAGE;
    }
    if (err instanceof UsageError) {
      const path = commandPath(program, argv);
      printError(io, err.message, `See the options with: mindly ${path ? `${path} ` : ''}--help`);
      return EXIT_USAGE;
    }
    if (isMindlyError(err)) {
      printError(io, err.message, err instanceof HintedError ? err.hint : hintFor(err.code));
      return EXIT_ERROR;
    }
    printError(
      io,
      err instanceof Error ? err.message : 'unexpected error',
      'If this keeps happening, check your setup with: mindly doctor',
    );
    return EXIT_ERROR;
  }
}

/** The command words of `argv` (`memory show`), for help hints. */
function commandPath(program: Command, argv: readonly string[]): string {
  const words: string[] = [];
  let cmd: Command | undefined = program;
  for (const arg of argv.slice(0, 2)) {
    cmd = cmd?.commands.find((c) => c.name() === arg);
    if (!cmd) break;
    words.push(arg);
  }
  return words.length ? words.join(' ') : '';
}

/** How to fix an error of `code`, when there is a general answer. */
function hintFor(code: ErrorCode): string | null {
  switch (code) {
    case 'untrusted_project':
      return "Review this project's .mindly/config.json and trust it with: mindly trust";
    case 'path_outside_project':
      return 'Use a path inside this project.';
    case 'unavailable':
    case 'internal':
      return 'Check your setup with: mindly doctor';
    case 'timeout':
      return 'Try again; if it keeps happening, check your setup with: mindly doctor';
    default:
      return null;
  }
}

/** Prints `x What went wrong.` and `-> How to fix it.` to stderr (no colour: logs read it). */
function printError(io: CliIo, message: string, hint: string | null): void {
  const sym = symbolsFor(io.env);
  const text = stripControl(message).trim();
  const first = text.length ? `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}` : 'Failed';
  const sentence = first.includes('\n') || /[.:!?)]$/.test(first) ? first : `${first}.`;
  const ascii = useAscii(io.env) ? toAscii : (t: string): string => t;
  io.stderr.write(ascii(`${sym.fail} ${sentence}\n`));
  if (hint) io.stderr.write(ascii(`${sym.next} ${hint}\n`));
}

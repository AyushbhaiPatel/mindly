import {
  CONFLICT_KINDS,
  CONFLICT_STATUSES,
  CONTRACT_KINDS,
  CONTRACT_STATES,
  DELIVERY_KINDS,
  DELIVERY_STATUSES,
  EVIDENCE_TYPES,
  HANDOFF_STATUSES,
  INTENT_STATUSES,
  MEMORY_KINDS,
  MEMORY_STATUSES,
  RUN_KINDS,
  RUN_STATUSES,
  SAVE_KINDS,
  SAVE_STATUSES,
  SESSION_STATUSES,
  SEVERITIES,
  SOURCE_TYPES,
  TASK_STATUSES,
  TRUST_LEVELS,
} from '@mindly/core';
import { MIGRATION_V3_SPLIT } from './migrations/v3-split.js';
import { MIGRATION_V4_BISECT } from './migrations/v4-bisect.js';

/** `col IN ('a','b')` from a closed enum tuple (values are compile-time constants, not input). */
function oneOf(col: string, values: readonly string[]): string {
  for (const v of values) {
    if (!/^[a-z_.-]+$/.test(v)) throw new Error(`unsafe enum value ${v}`);
  }
  return `CHECK (${col} IN (${values.map((v) => `'${v}'`).join(', ')}))`;
}

/**
 * Ordered schema migrations. Index i upgrades the schema from version i to i+1. Never edit a
 * released migration; append a new one.
 */
export const MIGRATIONS: readonly string[] = [
  /* v1: initial schema */ `
CREATE TABLE projects (
  id                  TEXT PRIMARY KEY,
  root                TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  trusted_config_hash TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE sessions (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_kind       TEXT NOT NULL,
  external_id      TEXT NOT NULL,
  status           TEXT NOT NULL ${oneOf('status', SESSION_STATUSES)},
  label            TEXT,
  branch           TEXT,
  worktree         TEXT NOT NULL,
  current_task_id  TEXT,
  transcript_path  TEXT,
  started_at       INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL,
  ended_at         INTEGER,
  UNIQUE (project_id, agent_kind, external_id)
);
CREATE INDEX sessions_project_status ON sessions (project_id, status, last_seen_at);

CREATE TABLE events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id  TEXT,
  type        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX events_project_seq ON events (project_id, seq);
CREATE INDEX events_project_type ON events (project_id, type, seq);
CREATE INDEX events_session ON events (session_id, seq);

CREATE TABLE memories (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL ${oneOf('kind', MEMORY_KINDS)},
  title              TEXT NOT NULL,
  body               TEXT NOT NULL,
  tags               TEXT NOT NULL DEFAULT '[]',
  scope_paths        TEXT NOT NULL DEFAULT '[]',
  scope_branch       TEXT,
  trust              TEXT NOT NULL ${oneOf('trust', TRUST_LEVELS)},
  status             TEXT NOT NULL ${oneOf('status', MEMORY_STATUSES)},
  source_type        TEXT NOT NULL ${oneOf('source_type', SOURCE_TYPES)},
  source_session_id  TEXT,
  source_agent_kind  TEXT,
  enforce            INTEGER NOT NULL DEFAULT 0,
  pinned             INTEGER NOT NULL DEFAULT 0,
  version            INTEGER NOT NULL DEFAULT 1,
  supersedes_id      TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  last_verified_at   INTEGER
);
CREATE INDEX memories_project ON memories (project_id, status, kind, updated_at);
CREATE INDEX memories_branch ON memories (project_id, scope_branch);

CREATE VIRTUAL TABLE memories_fts USING fts5 (
  title, body, tags,
  content = 'memories', content_rowid = 'rowid',
  tokenize = 'porter unicode61'
);
CREATE TRIGGER memories_fts_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts (rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, new.tags);
END;
CREATE TRIGGER memories_fts_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, title, body, tags)
  VALUES ('delete', old.rowid, old.title, old.body, old.tags);
END;
CREATE TRIGGER memories_fts_au AFTER UPDATE OF title, body, tags ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, title, body, tags)
  VALUES ('delete', old.rowid, old.title, old.body, old.tags);
  INSERT INTO memories_fts (rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, new.tags);
END;

CREATE TABLE memory_versions (
  memory_id          TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  version            INTEGER NOT NULL,
  title              TEXT NOT NULL,
  body               TEXT NOT NULL,
  tags               TEXT NOT NULL,
  scope_paths        TEXT NOT NULL,
  scope_branch       TEXT,
  trust              TEXT NOT NULL,
  status             TEXT NOT NULL,
  changed_by_type    TEXT NOT NULL,
  changed_by_session TEXT,
  changed_by_agent   TEXT,
  reason             TEXT,
  created_at         INTEGER NOT NULL,
  PRIMARY KEY (memory_id, version)
);

CREATE TABLE memory_evidence (
  id            TEXT PRIMARY KEY,
  memory_id     TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type          TEXT NOT NULL ${oneOf('type', EVIDENCE_TYPES)},
  ref           TEXT NOT NULL,
  excerpt       TEXT,
  content_hash  TEXT,
  created_at    INTEGER NOT NULL,
  checked_at    INTEGER,
  valid         INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX memory_evidence_memory ON memory_evidence (memory_id);
CREATE INDEX memory_evidence_ref ON memory_evidence (project_id, type, ref);

CREATE TABLE tasks (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL ${oneOf('status', TASK_STATUSES)},
  owner_session_id  TEXT,
  parent_id         TEXT,
  plan              TEXT NOT NULL DEFAULT '[]',
  blockers          TEXT NOT NULL DEFAULT '[]',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX tasks_project ON tasks (project_id, status, updated_at);

CREATE TABLE intents (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  task_id     TEXT,
  summary     TEXT NOT NULL,
  status      TEXT NOT NULL ${oneOf('status', INTENT_STATUSES)},
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX intents_project ON intents (project_id, status, expires_at);

CREATE TABLE intent_targets (
  intent_id  TEXT NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('file', 'symbol')),
  value      TEXT NOT NULL,
  PRIMARY KEY (intent_id, kind, value)
);
CREATE INDEX intent_targets_value ON intent_targets (kind, value);

CREATE TABLE file_changes (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  path             TEXT NOT NULL,
  tool             TEXT NOT NULL,
  added_lines      INTEGER NOT NULL,
  removed_lines    INTEGER NOT NULL,
  prompt_event_id  TEXT,
  created_at       INTEGER NOT NULL
);
CREATE INDEX file_changes_path ON file_changes (project_id, path, created_at);
CREATE INDEX file_changes_session ON file_changes (session_id, created_at);

CREATE TABLE file_change_hunks (
  change_id  TEXT NOT NULL REFERENCES file_changes(id) ON DELETE CASCADE,
  hash       TEXT NOT NULL,
  PRIMARY KEY (change_id, hash)
);
CREATE INDEX file_change_hunks_hash ON file_change_hunks (hash);

CREATE TABLE conflicts (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL ${oneOf('kind', CONFLICT_KINDS)},
  severity     TEXT NOT NULL ${oneOf('severity', SEVERITIES)},
  status       TEXT NOT NULL ${oneOf('status', CONFLICT_STATUSES)},
  title        TEXT NOT NULL,
  detail       TEXT NOT NULL,
  session_ids  TEXT NOT NULL DEFAULT '[]',
  paths        TEXT NOT NULL DEFAULT '[]',
  fingerprint  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  resolved_at  INTEGER,
  UNIQUE (project_id, fingerprint)
);
CREATE INDEX conflicts_project ON conflicts (project_id, status, updated_at);

CREATE TABLE deliveries (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_session_id  TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  target_agent_kind  TEXT,
  kind               TEXT NOT NULL ${oneOf('kind', DELIVERY_KINDS)},
  priority           INTEGER NOT NULL DEFAULT 0,
  title              TEXT NOT NULL,
  body               TEXT NOT NULL,
  status             TEXT NOT NULL ${oneOf('status', DELIVERY_STATUSES)},
  dedupe_key         TEXT,
  source_session_id  TEXT,
  created_at         INTEGER NOT NULL,
  delivered_at       INTEGER,
  acked_at           INTEGER,
  expires_at         INTEGER NOT NULL
);
CREATE INDEX deliveries_pending ON deliveries (project_id, status, target_session_id);
CREATE UNIQUE INDEX deliveries_dedupe ON deliveries (project_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE context_packets (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  trigger       TEXT NOT NULL,
  query         TEXT,
  included      TEXT NOT NULL,
  omitted       TEXT NOT NULL,
  token_budget  INTEGER NOT NULL,
  tokens_used   INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX context_packets_session ON context_packets (session_id, created_at);

CREATE TABLE handoffs (
  id                     TEXT PRIMARY KEY,
  project_id             TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_session_id        TEXT NOT NULL,
  to_agent_kind          TEXT,
  task_id                TEXT,
  reason                 TEXT NOT NULL CHECK (reason IN ('manual', 'rate_limit', 'crash')),
  summary                TEXT NOT NULL,
  packet                 TEXT NOT NULL,
  status                 TEXT NOT NULL ${oneOf('status', HANDOFF_STATUSES)},
  claimed_by_session_id  TEXT,
  created_at             INTEGER NOT NULL,
  claimed_at             INTEGER
);
CREATE INDEX handoffs_project ON handoffs (project_id, status, created_at);

CREATE TABLE contracts (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  memory_id      TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL ${oneOf('kind', CONTRACT_KINDS)},
  spec           TEXT NOT NULL,
  approved_hash  TEXT,
  state          TEXT NOT NULL ${oneOf('state', CONTRACT_STATES)},
  last_message   TEXT,
  last_run_at    INTEGER,
  created_at     INTEGER NOT NULL
);
CREATE INDEX contracts_project ON contracts (project_id, state);

CREATE TABLE snapshots (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  git_ref     TEXT,
  commit_sha  TEXT,
  state       TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX snapshots_project ON snapshots (project_id, created_at);

CREATE TABLE runs (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL ${oneOf('kind', RUN_KINDS)},
  status       TEXT NOT NULL ${oneOf('status', RUN_STATUSES)},
  title        TEXT NOT NULL,
  input        TEXT NOT NULL,
  result       TEXT,
  started_at   INTEGER,
  finished_at  INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX runs_project ON runs (project_id, kind, created_at);

CREATE TABLE kv (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
`,
  /* v2: saves. `refs` holds the ids of the records a save is about. */ `
CREATE TABLE saves (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL ${oneOf('kind', SAVE_KINDS)},
  status        TEXT NOT NULL ${oneOf('status', SAVE_STATUSES)},
  title         TEXT NOT NULL,
  session_ids   TEXT NOT NULL DEFAULT '[]',
  paths         TEXT NOT NULL DEFAULT '[]',
  evidence      TEXT NOT NULL DEFAULT '[]',
  fingerprint   TEXT NOT NULL,
  refs          TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  confirmed_at  INTEGER,
  UNIQUE (project_id, fingerprint)
);
CREATE INDEX saves_project ON saves (project_id, status, created_at);
`,
  /* v3: splits */ MIGRATION_V3_SPLIT,
  /* v4: checkpoints (bisect) */ MIGRATION_V4_BISECT,
];

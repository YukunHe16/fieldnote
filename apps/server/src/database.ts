import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const schema = `
PRAGMA foreign_keys = ON;

-- Participants are the PEOPLE axis (who is learning), orthogonal to profile_id — the
-- agent-configuration axis validated against a code registry. The two must never mix:
-- a participant id is data, a profile id is configuration.
CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('web', 'feishu')),
  profile_id TEXT NOT NULL DEFAULT 'local-operator',
  participant_id TEXT NOT NULL DEFAULT 'default',
  active_branch_id TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  temporary INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  parent_branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
  forked_from_message_id TEXT,
  sdk_session_id TEXT,
  resume_session_at TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_branches_conversation ON branches(conversation_id);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  user_message_id TEXT,
  assistant_message_id TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('normal', 'guide', 'queue')),
  profile_revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  error TEXT,
  total_cost_usd REAL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  superseded_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_runs_conversation_status ON runs(conversation_id, status);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  parent_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  reasoning_summary TEXT,
  sdk_uuid TEXT,
  client_message_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_branch_created ON messages(branch_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_messages_run ON messages(run_id);

CREATE TABLE IF NOT EXISTS assistant_blocks (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  parent_block_id TEXT REFERENCES assistant_blocks(id) ON DELETE CASCADE,
  stream_id TEXT,
  external_id TEXT,
  owner TEXT NOT NULL CHECK (owner IN ('main', 'subagent')),
  kind TEXT NOT NULL CHECK (kind IN ('text', 'activity', 'subagent', 'thinking')),
  activity_kind TEXT CHECK (activity_kind IS NULL OR activity_kind IN ('skill', 'mcp', 'subagent', 'cron', 'workspace')),
  display_name TEXT NOT NULL DEFAULT '',
  technical_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'interrupted')),
  content TEXT NOT NULL DEFAULT '',
  input_summary TEXT,
  output_summary TEXT,
  ordinal INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE(message_id, stream_id),
  UNIQUE(run_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_assistant_blocks_message_order
  ON assistant_blocks(message_id, ordinal, started_at);
CREATE INDEX IF NOT EXISTS idx_assistant_blocks_parent
  ON assistant_blocks(parent_block_id, ordinal);

CREATE TABLE IF NOT EXISTS tool_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  tool_use_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL,
  input_summary TEXT,
  output_summary TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE(run_id, tool_use_id)
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  status TEXT NOT NULL,
  presented INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attachments_conversation ON attachments(conversation_id);

CREATE TABLE IF NOT EXISTS message_attachments (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  PRIMARY KEY(message_id, attachment_id)
);

CREATE TABLE IF NOT EXISTS channel_bindings (
  channel TEXT NOT NULL,
  external_key TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(channel, external_key)
);

CREATE TABLE IF NOT EXISTS inbound_events (
  channel TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_json TEXT,
  received_at INTEGER NOT NULL,
  PRIMARY KEY(channel, idempotency_key)
);

CREATE TABLE IF NOT EXISTS local_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS event_log (
  event_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(conversation_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_event_log_conversation_sequence ON event_log(conversation_id, sequence);

CREATE TABLE IF NOT EXISTS session_store_entries (
  project_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  subpath TEXT NOT NULL DEFAULT '',
  ordinal INTEGER NOT NULL,
  entry_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(project_key, session_id, subpath, ordinal)
);

CREATE TABLE IF NOT EXISTS session_store_summaries (
  project_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(project_key, session_id)
);

CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('profile', 'preference', 'goal', 'project', 'task')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  keywords_json TEXT NOT NULL DEFAULT '[]',
  source_kind TEXT NOT NULL CHECK (source_kind IN ('auto', 'explicit', 'manual')),
  scope TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'profile')),
  profile_id TEXT,
  importance INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  pinned INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
  fingerprint TEXT NOT NULL,
  last_maintained_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_items_category_status
  ON memory_items(category, status, pinned, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_items_fingerprint
  ON memory_items(category, fingerprint, status);
CREATE TABLE IF NOT EXISTS memory_sources (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  had_conversation INTEGER NOT NULL DEFAULT 0,
  conversation_title TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_sources_memory ON memory_sources(memory_id, created_at DESC);

CREATE TABLE IF NOT EXISTS run_memory_refs (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(run_id, memory_id)
);

CREATE TABLE IF NOT EXISTS memory_extraction_jobs (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_mutations (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
  before_json TEXT,
  after_json TEXT,
  undo_expires_at INTEGER NOT NULL,
  undone_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_maintenance_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'failed')),
  last_run_at INTEGER NOT NULL,
  eligibility_cutoff_at INTEGER,
  last_completed_at INTEGER,
  last_attempt_at INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  memory_id UNINDEXED,
  title,
  content,
  keywords,
  tokenize = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memory_items BEGIN
  INSERT INTO memories_fts(memory_id, title, content, keywords)
  VALUES (new.id, new.title, new.content, new.keywords_json);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE OF title, content, keywords_json ON memory_items BEGIN
  DELETE FROM memories_fts WHERE memory_id = old.id;
  INSERT INTO memories_fts(memory_id, title, content, keywords)
  VALUES (new.id, new.title, new.content, new.keywords_json);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memory_items BEGIN
  DELETE FROM memories_fts WHERE memory_id = old.id;
END;

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  message_id UNINDEXED,
  conversation_id UNINDEXED,
  content,
  tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(message_id, conversation_id, content)
  VALUES (new.id, new.conversation_id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF content ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
  INSERT INTO messages_fts(message_id, conversation_id, content)
  VALUES (new.id, new.conversation_id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
END;
`;

export type SqliteDatabase = Database.Database;

export function openDatabase(databasePath: string): SqliteDatabase {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  if (databasePath !== ":memory:") fs.chmodSync(databasePath, 0o600);
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = NORMAL");
  database.exec(schema);
  const attachmentColumns = database.pragma("table_info(attachments)") as Array<{ name: string }>;
  if (!attachmentColumns.some((column) => column.name === "presented")) {
    database.exec("ALTER TABLE attachments ADD COLUMN presented INTEGER NOT NULL DEFAULT 1");
  }
  const messageColumns = database.pragma("table_info(messages)") as Array<{ name: string }>;
  if (!messageColumns.some((column) => column.name === "client_message_id")) {
    database.exec("ALTER TABLE messages ADD COLUMN client_message_id TEXT");
  }
  database.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_conversation_client_message ON messages(conversation_id, client_message_id) WHERE client_message_id IS NOT NULL"
  );
  const conversationColumns = database.pragma("table_info(conversations)") as Array<{ name: string }>;
  if (!conversationColumns.some((column) => column.name === "temporary")) {
    database.exec("ALTER TABLE conversations ADD COLUMN temporary INTEGER NOT NULL DEFAULT 0");
  }
  if (!conversationColumns.some((column) => column.name === "expires_at")) {
    database.exec("ALTER TABLE conversations ADD COLUMN expires_at INTEGER");
  }
  if (!conversationColumns.some((column) => column.name === "profile_id")) {
    database.exec("ALTER TABLE conversations ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'local-operator'");
  }
  if (!conversationColumns.some((column) => column.name === "participant_id")) {
    // Existing rows read the default, so every pre-participant conversation belongs to
    // the default participant and single-user behavior is byte-identical.
    database.exec("ALTER TABLE conversations ADD COLUMN participant_id TEXT NOT NULL DEFAULT 'default'");
  }
  database
    .prepare("INSERT OR IGNORE INTO participants (id, display_name, created_at) VALUES ('default', 'Default', ?)")
    .run(Date.now());
  const runColumns = database.pragma("table_info(runs)") as Array<{ name: string }>;
  if (!runColumns.some((column) => column.name === "profile_revision")) {
    database.exec("ALTER TABLE runs ADD COLUMN profile_revision INTEGER NOT NULL DEFAULT 1");
  }
  if (!runColumns.some((column) => column.name === "superseded_at")) {
    database.exec("ALTER TABLE runs ADD COLUMN superseded_at INTEGER");
  }
  const maintenanceColumns = database.pragma("table_info(memory_maintenance_state)") as Array<{ name: string }>;
  if (!maintenanceColumns.some((column) => column.name === "last_completed_at")) {
    database.exec("ALTER TABLE memory_maintenance_state ADD COLUMN last_completed_at INTEGER");
  }
  if (!maintenanceColumns.some((column) => column.name === "eligibility_cutoff_at")) {
    database.exec("ALTER TABLE memory_maintenance_state ADD COLUMN eligibility_cutoff_at INTEGER");
  }
  const memoryColumns = database.pragma("table_info(memory_items)") as Array<{ name: string }>;
  const addedMemoryScope = !memoryColumns.some((column) => column.name === "scope");
  const addedMemoryProfileId = !memoryColumns.some((column) => column.name === "profile_id");
  if (!memoryColumns.some((column) => column.name === "last_maintained_at")) {
    database.exec("ALTER TABLE memory_items ADD COLUMN last_maintained_at INTEGER");
  }
  if (addedMemoryScope) {
    database.exec("ALTER TABLE memory_items ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'");
  }
  if (addedMemoryProfileId) {
    database.exec("ALTER TABLE memory_items ADD COLUMN profile_id TEXT");
  }
  // Before profile-scoped memories existed, every category was implicitly global.
  // Keep durable user preferences global, but attach historical work to the
  // original general-purpose profile. The update is idempotent, so it also
  // completes safely if a previous migration was interrupted after ALTER TABLE.
  database.exec(
    `UPDATE memory_items
     SET scope = 'profile', profile_id = 'local-operator'
     WHERE category IN ('goal', 'project', 'task')
       AND (scope != 'profile' OR profile_id IS NULL);
     UPDATE memory_items
     SET scope = 'global', profile_id = NULL
     WHERE category IN ('profile', 'preference')
       AND (scope != 'global' OR profile_id IS NOT NULL)`
  );
  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_memory_items_scope ON memory_items(scope, profile_id, category, status, updated_at DESC)"
  );
  database.exec(`
CREATE TABLE IF NOT EXISTS evolution_signals (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('user', 'implicit')),
  kind TEXT NOT NULL CHECK (kind IN ('thumb', 'retry', 'edit', 'correct', 'method')),
  polarity TEXT NOT NULL CHECK (polarity IN ('up', 'down')),
  reason TEXT,
  profile_id TEXT,
  conversation_id TEXT,
  message_id TEXT,
  run_id TEXT,
  overlay_revision TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evolution_signals_message ON evolution_signals(message_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evolution_signals_profile ON evolution_signals(profile_id, kind, created_at DESC);

CREATE TABLE IF NOT EXISTS playbooks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  instruction TEXT NOT NULL,
  polarity TEXT NOT NULL CHECK (polarity IN ('do', 'dont')),
  origin TEXT NOT NULL CHECK (origin IN ('user', 'confirmed', 'distilled')),
  scope TEXT NOT NULL CHECK (scope IN ('global', 'profile')),
  profile_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 1,
  source_run_id TEXT,
  source_signal_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_playbooks_scope ON playbooks(scope, profile_id, enabled, updated_at DESC);

CREATE TABLE IF NOT EXISTS overlay_revisions (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  profile_id TEXT,
  snapshot_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_overlay_revisions_run ON overlay_revisions(run_id, created_at DESC);

CREATE TABLE IF NOT EXISTS evolved_artifacts (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('skill', 'subagent')),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'enabled', 'rejected', 'disabled')),
  origin TEXT NOT NULL CHECK (origin IN ('user', 'distilled')),
  revision INTEGER NOT NULL DEFAULT 1,
  evaluation_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(profile_id, kind, slug)
);

CREATE TABLE IF NOT EXISTS evolution_reviews (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES evolved_artifacts(id) ON DELETE CASCADE,
  verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'reject', 'needs_human')),
  reason TEXT NOT NULL,
  notified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS evolution_review_state (
  profile_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'failed')),
  last_run_at INTEGER NOT NULL,
  last_completed_at INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS delivery_shelf (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  conversation_id TEXT,
  attachment_id TEXT,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  source_workspace TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delivery_shelf_profile ON delivery_shelf(profile_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_mailbox (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_mailbox_run ON agent_mailbox(run_id, created_at);

CREATE TABLE IF NOT EXISTS domain_card_revisions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  title TEXT NOT NULL,
  lines_json TEXT NOT NULL,
  patch TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_domain_card_revisions_profile ON domain_card_revisions(profile_id, created_at DESC);

CREATE TABLE IF NOT EXISTS run_snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  overlay_json TEXT NOT NULL,
  workspace_dir TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS replay_marks (
  conversation_id TEXT PRIMARY KEY,
  source_run_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  include_artifact_id TEXT,
  prompt TEXT NOT NULL,
  overlay_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);
  migrateAssistantBlockThinkingKind(database);
  migrateEvolutionSignalMethodKind(database);
  return database;
}

function migrateAssistantBlockThinkingKind(database: SqliteDatabase) {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'assistant_blocks'")
    .get() as { sql?: string } | undefined;
  if (!row?.sql || row.sql.includes("'thinking'")) return;
  database.pragma("foreign_keys = OFF");
  database.exec(`
    CREATE TABLE assistant_blocks_thinking (
      id TEXT PRIMARY KEY,
      run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      parent_block_id TEXT REFERENCES assistant_blocks_thinking(id) ON DELETE CASCADE,
      stream_id TEXT,
      external_id TEXT,
      owner TEXT NOT NULL CHECK (owner IN ('main', 'subagent')),
      kind TEXT NOT NULL CHECK (kind IN ('text', 'activity', 'subagent', 'thinking')),
      activity_kind TEXT CHECK (activity_kind IS NULL OR activity_kind IN ('skill', 'mcp', 'subagent', 'cron', 'workspace')),
      display_name TEXT NOT NULL DEFAULT '',
      technical_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'interrupted')),
      content TEXT NOT NULL DEFAULT '',
      input_summary TEXT,
      output_summary TEXT,
      ordinal INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      UNIQUE(message_id, stream_id),
      UNIQUE(run_id, external_id)
    );
    INSERT INTO assistant_blocks_thinking
      (id, run_id, message_id, parent_block_id, stream_id, external_id, owner, kind,
       activity_kind, display_name, technical_name, status, content, input_summary,
       output_summary, ordinal, started_at, updated_at, completed_at)
    SELECT id, run_id, message_id, parent_block_id, stream_id, external_id, owner, kind,
           activity_kind, display_name, technical_name, status, content, input_summary,
           output_summary, ordinal, started_at, updated_at, completed_at
    FROM assistant_blocks;
    DROP TABLE assistant_blocks;
    ALTER TABLE assistant_blocks_thinking RENAME TO assistant_blocks;
    CREATE INDEX IF NOT EXISTS idx_assistant_blocks_message_order
      ON assistant_blocks(message_id, ordinal, started_at);
    CREATE INDEX IF NOT EXISTS idx_assistant_blocks_parent
      ON assistant_blocks(parent_block_id, ordinal);
  `);
  database.pragma("foreign_keys = ON");
}

function migrateEvolutionSignalMethodKind(database: SqliteDatabase) {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'evolution_signals'")
    .get() as { sql?: string } | undefined;
  if (!row?.sql || row.sql.includes("'method'")) return;
  database.pragma("foreign_keys = OFF");
  database.exec(`
    CREATE TABLE evolution_signals_method (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL CHECK (source IN ('user', 'implicit')),
      kind TEXT NOT NULL CHECK (kind IN ('thumb', 'retry', 'edit', 'correct', 'method')),
      polarity TEXT NOT NULL CHECK (polarity IN ('up', 'down')),
      reason TEXT,
      profile_id TEXT,
      conversation_id TEXT,
      message_id TEXT,
      run_id TEXT,
      overlay_revision TEXT,
      created_at INTEGER NOT NULL
    );
    INSERT INTO evolution_signals_method
      (id, source, kind, polarity, reason, profile_id, conversation_id, message_id, run_id, overlay_revision, created_at)
    SELECT id, source, kind, polarity, reason, profile_id, conversation_id, message_id, run_id, overlay_revision, created_at
    FROM evolution_signals;
    DROP TABLE evolution_signals;
    ALTER TABLE evolution_signals_method RENAME TO evolution_signals;
    CREATE INDEX IF NOT EXISTS idx_evolution_signals_message ON evolution_signals(message_id, kind, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_evolution_signals_profile ON evolution_signals(profile_id, kind, created_at DESC);
  `);
  database.pragma("foreign_keys = ON");
}

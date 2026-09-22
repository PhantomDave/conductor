-- Conductor SQLite schema

CREATE TABLE IF NOT EXISTS execution_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  command_id TEXT NOT NULL,
  profile TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT,
  exit_code INTEGER,
  duration_ms INTEGER
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  process_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  profile TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  stream TEXT NOT NULL DEFAULT 'stdout',
  message TEXT NOT NULL,
  -- Which `sessions` row (one profile `run`) this log belongs to. NULL for
  -- logs from a single command execute/restart, or written before any run
  -- this server process has seen - those are only reachable by the
  -- time-window sweep, not the session-scoped one.
  session_id INTEGER
);

CREATE INDEX IF NOT EXISTS idx_logs_command ON logs(command_id);
CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_logs_session ON logs(session_id);

-- One row per `POST /api/profiles/:profile/run` call, so log retention can
-- keep "the last N sessions per profile" instead of only a time window.
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile TEXT NOT NULL,
  started_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_profile ON sessions(profile, id);

-- Trigram-tokenized so `grep` can substring-match log messages (not just
-- word boundaries). External-content (content='logs') so message text isn't
-- duplicated on disk - this is a candidate-filter index only, queries.ts
-- still runs an exact LIKE after MATCH narrows candidates.
CREATE VIRTUAL TABLE IF NOT EXISTS logs_fts USING fts5(
  message,
  content='logs',
  content_rowid='id',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS logs_ai AFTER INSERT ON logs BEGIN
  INSERT INTO logs_fts(rowid, message) VALUES (new.id, new.message);
END;

CREATE TRIGGER IF NOT EXISTS logs_ad AFTER DELETE ON logs BEGIN
  INSERT INTO logs_fts(logs_fts, rowid, message) VALUES ('delete', old.id, old.message);
END;

CREATE TABLE IF NOT EXISTS process_metadata (
  pid INTEGER NOT NULL,
  command_id TEXT NOT NULL,
  profile TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ended_at TEXT,
  exit_code INTEGER,
  PRIMARY KEY (pid, created_at)
);

CREATE TABLE IF NOT EXISTS process_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pid INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  cpu_percent REAL NOT NULL,
  memory_bytes INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_metrics_pid_time ON process_metrics(pid, timestamp);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'local',
  details TEXT
);

-- Env vars managed from the UI. Scope "global" applies to every profile;
-- scope "profile" applies only to the named profile. Kept separate from
-- .conductor.yml so secrets never need to be committed to source control.
CREATE TABLE IF NOT EXISTS env_vars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'profile')),
  profile TEXT,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  is_secret INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE (scope, profile, key)
);


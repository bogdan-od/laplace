-- SQLite schema of the server. This is a contract: a schema change means a new
-- PRAGMA user_version and a migration file next to this one (migrations/NNN.sql).
-- Time is always INTEGER milliseconds since the Unix epoch by the server clock (never the client's
-- or the guest's). JSON columns are TEXT shaped by the shared/src/api.ts type named in the comment.
-- Connections are opened with PRAGMA foreign_keys = ON and journal_mode = WAL.

PRAGMA user_version = 1;

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  login         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,              -- scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>
  name          TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK (role IN ('teacher', 'student')),
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
) STRICT;

CREATE TABLE sessions (
  token_hash TEXT    PRIMARY KEY,              -- sha256 hex of the cookie token; the token is not stored
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE TABLE classes (
  id          INTEGER PRIMARY KEY,
  owner_id    INTEGER NOT NULL REFERENCES users(id),
  name        TEXT    NOT NULL,
  subject     TEXT    NOT NULL DEFAULT '',
  invite_code TEXT    NOT NULL UNIQUE,         -- 8 chars from an alphabet without 0/O/1/I
  is_demo     INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at  INTEGER NOT NULL,
  deleted_at  INTEGER                          -- soft delete: the undo toast restores it
) STRICT;

-- The owner is not a member (see classes.owner_id). An assistant has teacher rights except deleting
-- the class and managing assistants.
CREATE TABLE class_members (
  class_id  INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT    NOT NULL CHECK (role IN ('student', 'assistant')),
  number    INTEGER CHECK (number BETWEEN 1 AND 254), -- students only: guest address 10.0.0.N and variant {n}
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (class_id, user_id),
  UNIQUE (class_id, number),
  CHECK ((role = 'student') = (number IS NOT NULL))
) STRICT;

-- Content-addressed journal files: data/journals/<sha256>.json. Library items and assignments share
-- them, so copying an item into an assignment copies nothing on disk.
CREATE TABLE journal_files (
  sha256     TEXT    PRIMARY KEY,
  size       INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE library_items (
  id           INTEGER PRIMARY KEY,
  owner_id     INTEGER NOT NULL REFERENCES users(id),
  kind         TEXT    NOT NULL CHECK (kind IN ('task', 'lesson', 'clip')),
  title        TEXT    NOT NULL,
  brief        TEXT    NOT NULL DEFAULT '',    -- task statement, plain text with paragraphs
  topology     TEXT    NOT NULL,               -- JSON Topology (v86-topology/1 without journals)
  checks       TEXT    NOT NULL DEFAULT '[]',  -- JSON CheckCommand[]
  hints        TEXT    NOT NULL DEFAULT '[]',  -- JSON Hint[]
  clip_from_ms REAL,                           -- clip only: guest time to start showing from
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER
) STRICT;

CREATE TABLE item_journals (
  item_id     INTEGER NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  node_id     TEXT    NOT NULL,                -- machine id from topology
  role        TEXT    NOT NULL CHECK (role IN ('start', 'reference')),
  journal_sha TEXT    NOT NULL REFERENCES journal_files(sha256),
  PRIMARY KEY (item_id, node_id, role)
) STRICT;

-- Embedded player publication: the only way a journal becomes readable without logging in.
CREATE TABLE embeds (
  token      TEXT    PRIMARY KEY,              -- 22 base64url chars from 16 random bytes
  item_id    INTEGER NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;

-- An assignment is a copy of the library item at the moment it was assigned, so editing the library
-- does not break attempts in progress.
CREATE TABLE assignments (
  id         INTEGER PRIMARY KEY,
  class_id   INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  item_id    INTEGER REFERENCES library_items(id) ON DELETE SET NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('task', 'lesson')),
  title      TEXT    NOT NULL,
  brief      TEXT    NOT NULL,
  topology   TEXT    NOT NULL,                 -- JSON Topology
  checks     TEXT    NOT NULL,                 -- JSON CheckCommand[]
  hints      TEXT    NOT NULL,                 -- JSON Hint[]
  max_grade  INTEGER NOT NULL DEFAULT 10 CHECK (max_grade BETWEEN 1 AND 100),
  due_at     INTEGER,
  shared_lan INTEGER NOT NULL DEFAULT 0 CHECK (shared_lan IN (0, 1)), -- single-machine topologies only
  frozen     INTEGER NOT NULL DEFAULT 0 CHECK (frozen IN (0, 1)),     -- "freeze everyone"
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
) STRICT;

CREATE TABLE assignment_journals (
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  node_id       TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK (role IN ('start', 'reference')),
  journal_sha   TEXT    NOT NULL REFERENCES journal_files(sha256),
  PRIMARY KEY (assignment_id, node_id, role)
) STRICT;

-- One attempt per (assignment, user). A teacher using "try as a student" gets an attempt too
-- (is_preview = 1); it is excluded from analytics and submission lists.
CREATE TABLE attempts (
  id               INTEGER PRIMARY KEY,
  assignment_id    INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  variant          INTEGER NOT NULL,           -- value of {n}: the student's number, 1 for a teacher
  is_preview       INTEGER NOT NULL DEFAULT 0 CHECK (is_preview IN (0, 1)),
  created_at       INTEGER NOT NULL,           -- "opened" for analytics
  completed_at     INTEGER,                    -- lessons only: "finish lesson"
  commands         INTEGER NOT NULL DEFAULT 0, -- from the client, tile display only (untrusted)
  last_command     TEXT    NOT NULL DEFAULT '',-- from the client, tile display only (untrusted)
  last_activity_at INTEGER,                    -- arrival time of the latest chunk
  UNIQUE (assignment_id, user_id)
) STRICT;

-- A journal branch of one machine of an attempt. Full journal = header + events [0, fork_event) of
-- the parent (recursively) + own chunks. event_count counts every event of the full journal, so
-- client (Machine) and server indices are the same. Chunks are append-only, so the pair
-- (branch_id, event_count) always denotes the same journal.
CREATE TABLE branches (
  id          INTEGER PRIMARY KEY,
  attempt_id  INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  node_id     TEXT    NOT NULL,
  parent_id   INTEGER REFERENCES branches(id),
  fork_event  INTEGER NOT NULL DEFAULT 0,
  kind        TEXT    NOT NULL CHECK (kind IN ('start', 'rollback', 'continue', 'reply')),
  author_id   INTEGER NOT NULL REFERENCES users(id), -- a teacher authors reply branches
  header      TEXT    NOT NULL,                -- JSON JournalHeader
  event_count INTEGER NOT NULL,                -- starts equal to fork_event
  bytes       INTEGER NOT NULL DEFAULT 0,      -- total size of own chunks
  last_c      REAL,                            -- c and w of the last event: the monotonicity bound
  last_w      REAL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  CHECK ((parent_id IS NULL) = (kind = 'start')),
  CHECK (parent_id IS NOT NULL OR fork_event = 0) -- rollback "to the start" has a parent and fork_event 0
) STRICT;
CREATE INDEX branches_attempt ON branches(attempt_id);

CREATE TABLE chunks (
  branch_id   INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  first_event INTEGER NOT NULL,
  event_count INTEGER NOT NULL CHECK (event_count > 0),
  bytes       INTEGER NOT NULL,
  events      TEXT    NOT NULL,                -- JSON JournalEvent[]
  received_at INTEGER NOT NULL,                -- server clock: how the journal grew
  PRIMARY KEY (branch_id, first_event)
) STRICT;

-- Current branch of each machine: the student continues from it and a submission takes it.
CREATE TABLE attempt_heads (
  attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  node_id    TEXT    NOT NULL,
  branch_id  INTEGER NOT NULL REFERENCES branches(id),
  PRIMARY KEY (attempt_id, node_id)
) STRICT;

CREATE TABLE help_requests (
  id              INTEGER PRIMARY KEY,
  attempt_id      INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  node_id         TEXT    NOT NULL,
  branch_id       INTEGER NOT NULL REFERENCES branches(id),
  event_count     INTEGER NOT NULL,            -- the "not working" moment = journal end at that time
  text            TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  resolved_at     INTEGER,
  resolved_by     INTEGER REFERENCES users(id),
  reply_branch_id INTEGER REFERENCES branches(id) -- the teacher's answer as a branch from this moment
) STRICT;

CREATE TABLE hint_uses (
  attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  hint_index INTEGER NOT NULL,
  used_at    INTEGER NOT NULL,
  PRIMARY KEY (attempt_id, hint_index)
) STRICT;

CREATE TABLE submissions (
  id             INTEGER PRIMARY KEY,
  attempt_id     INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  created_at     INTEGER NOT NULL,
  verify_status  TEXT    NOT NULL DEFAULT 'queued'
                 CHECK (verify_status IN ('queued', 'running', 'ok', 'failed', 'tail_unchecked', 'timeout')),
  verify_message TEXT,                         -- the core's divergence message (Ukrainian, shown to users)
  verified_at    INTEGER,
  commands_count INTEGER,                      -- commands() from journal.mjs, set by verification
  grade          INTEGER,
  note           TEXT    NOT NULL DEFAULT '',  -- teacher's overall note
  graded_by      INTEGER REFERENCES users(id),
  graded_at      INTEGER
) STRICT;
CREATE INDEX submissions_attempt ON submissions(attempt_id);

CREATE TABLE submission_journals (
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  node_id       TEXT    NOT NULL,
  branch_id     INTEGER NOT NULL REFERENCES branches(id),
  event_count   INTEGER NOT NULL,
  digest        TEXT    NOT NULL,              -- journal_digest() of the assembled journal
  PRIMARY KEY (submission_id, node_id)
) STRICT;

-- A comment pinned to a replay moment ("here you deleted /etc/fstab").
CREATE TABLE comments (
  id            INTEGER PRIMARY KEY,
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  node_id       TEXT    NOT NULL,
  event_index   INTEGER NOT NULL,              -- player's status.next when the comment was made
  vtime_ms      REAL    NOT NULL,              -- guest time to seek to (?t=)
  author_id     INTEGER NOT NULL REFERENCES users(id),
  text          TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  deleted_at    INTEGER
) STRICT;

-- The server records teacher input into a student's machine itself, because the journal's `by`
-- field is written by the student's client. The "typed by the teacher" highlight is built from this table.
CREATE TABLE teacher_inputs (
  id            INTEGER PRIMARY KEY,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id    INTEGER NOT NULL REFERENCES users(id),
  node_id       TEXT    NOT NULL,
  port          INTEGER NOT NULL CHECK (port IN (0, 2)),
  data          TEXT    NOT NULL,
  author_id     INTEGER NOT NULL REFERENCES users(id),
  received_at   INTEGER NOT NULL
) STRICT;
CREATE INDEX teacher_inputs_student ON teacher_inputs(assignment_id, student_id);

-- "Run check": the server replays a submission, goes live and runs the teacher's commands through
-- the system channel.
CREATE TABLE check_runs (
  id            INTEGER PRIMARY KEY,
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  started_by    INTEGER NOT NULL REFERENCES users(id),
  status        TEXT    NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  results       TEXT    NOT NULL DEFAULT '[]', -- JSON CheckResult[]
  message       TEXT,
  created_at    INTEGER NOT NULL,
  finished_at   INTEGER
) STRICT;

-- Class activity log and the source of notifications.
CREATE TABLE activity (
  id            INTEGER PRIMARY KEY,
  class_id      INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  assignment_id INTEGER REFERENCES assignments(id) ON DELETE CASCADE,
  actor_id      INTEGER NOT NULL REFERENCES users(id),
  student_id    INTEGER REFERENCES users(id),  -- whose attempt (for notifying the student)
  kind          TEXT    NOT NULL,              -- ActivityKind
  ref_id        INTEGER,                       -- id of the submission / help request / comment
  text          TEXT,
  at            INTEGER NOT NULL
) STRICT;
CREATE INDEX activity_class ON activity(class_id, id);

CREATE TABLE notification_reads (
  user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_read_id INTEGER NOT NULL
) STRICT;

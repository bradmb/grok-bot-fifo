-- FIFO D1 schema.
-- This is the read-only reference copy; the Worker runs the same DDL from
-- src/schema.ts (SCHEMA_SQL) and migrations/0001_init.sql.

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  quiet INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS queues (
  id TEXT PRIMARY KEY,
  queue_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('personal', 'team')),
  owner_agent_id TEXT REFERENCES agents(id),
  title TEXT NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 1,
  share_generation INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS queue_slots (
  id TEXT PRIMARY KEY,
  queue_id TEXT NOT NULL REFERENCES queues(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'draining', 'disabled')),
  created_at TEXT NOT NULL,
  UNIQUE (queue_id, agent_id)
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  queue_id TEXT NOT NULL REFERENCES queues(id),
  fifo_seq INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'in_progress', 'code_review', 'done', 'cancelled')),
  slot_id TEXT REFERENCES queue_slots(id),
  assignee_agent_id TEXT REFERENCES agents(id),
  source_system TEXT NOT NULL DEFAULT '',
  source_ref TEXT NOT NULL DEFAULT '',
  requester_ref TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  team_scope TEXT,
  kind TEXT NOT NULL DEFAULT 'implement' CHECK (kind IN ('code_review', 'implement', 'ops')),
  cr_slot TEXT,
  ca_ref TEXT,
  factory_ref TEXT,
  enqueued_at TEXT NOT NULL,
  started_at TEXT,
  done_at TEXT,
  progress_at TEXT,
  next_stall_at TEXT,
  stall_generation INTEGER NOT NULL DEFAULT 0,
  hard_blocked_at TEXT,
  block_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (queue_id, fifo_seq)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_items_source_ref
  ON items (source_system, source_ref)
  WHERE source_ref != '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_items_slot_wip
  ON items (slot_id)
  WHERE state = 'in_progress' AND slot_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_items_personal_wip
  ON items (queue_id)
  WHERE state = 'in_progress' AND slot_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_items_stall
  ON items (next_stall_at)
  WHERE state = 'in_progress' AND next_stall_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_items_queue_state_seq
  ON items (queue_id, state, fifo_seq);

-- One Code Review seat per Eng IC (Cursor cloud VM). Parallel to Factory IP; does not use slot_id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_cr_assignee
  ON items (queue_id, assignee_agent_id)
  WHERE state = 'code_review' AND assignee_agent_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_items_cr_slot
  ON items (queue_id, cr_slot)
  WHERE state = 'code_review' AND cr_slot IS NOT NULL;

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  author_agent_id TEXT,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'progress')),
  public INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS item_events (
  id TEXT PRIMARY KEY,
  item_id TEXT,
  queue_id TEXT,
  event_type TEXT NOT NULL,
  actor_agent_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_item_events_item
  ON item_events (item_id, created_at);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  idempotency_key TEXT NOT NULL,
  client_id TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (idempotency_key, client_id)
);

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_outbox (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  destination TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'stubbed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_retry
  ON webhook_outbox (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS share_tokens (
  id TEXT PRIMARY KEY,
  queue_id TEXT NOT NULL REFERENCES queues(id),
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  generation INTEGER NOT NULL,
  focus_item_id TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_share_tokens_queue
  ON share_tokens (queue_id, generation);

CREATE TABLE IF NOT EXISTS api_clients (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL DEFAULT '',
  agent_id TEXT REFERENCES agents(id),
  permissions_json TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

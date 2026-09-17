-- Eng Code Review lane (Cursor cloud VMs only) parallel to Factory IP.
-- Factory is implement In Progress only. CR does not use queue_slots.
-- D1 runs this file in a transaction; defer FKs so DROP TABLE items does not trip comments.item_id.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE items_new (
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

INSERT INTO items_new (
  id, queue_id, fifo_seq, state, slot_id, assignee_agent_id,
  source_system, source_ref, requester_ref, title, body, team_scope, kind,
  enqueued_at, started_at, done_at, progress_at, next_stall_at, stall_generation,
  hard_blocked_at, block_reason, created_at, updated_at
)
SELECT
  id, queue_id, fifo_seq, state, slot_id, assignee_agent_id,
  source_system, source_ref, requester_ref, title, body, team_scope,
  CASE
    WHEN queue_id IN (SELECT id FROM queues WHERE kind = 'team')
     AND LOWER(source_ref) LIKE '%cr-r%' THEN 'code_review'
    WHEN queue_id IN (SELECT id FROM queues WHERE kind = 'team')
     AND title LIKE '%CR cycle%' THEN 'code_review'
    ELSE 'implement'
  END,
  enqueued_at, started_at, done_at, progress_at, next_stall_at, stall_generation,
  hard_blocked_at, block_reason, created_at, updated_at
FROM items;

-- Live Eng CR occupying a Factory IP seat moves to the CR lane and frees the slot.
-- Personal plates never use state=code_review (enqueue/claim-cr are Eng-only).
UPDATE items_new
SET state = 'code_review',
    slot_id = NULL,
    next_stall_at = NULL,
    stall_generation = 0
WHERE state = 'in_progress'
  AND kind = 'code_review'
  AND queue_id = (SELECT id FROM queues WHERE queue_key = 'team:eng');

DROP TABLE items;
ALTER TABLE items_new RENAME TO items;

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

CREATE UNIQUE INDEX IF NOT EXISTS idx_items_cr_assignee
  ON items (queue_id, assignee_agent_id)
  WHERE state = 'code_review' AND assignee_agent_id IS NOT NULL;

PRAGMA defer_foreign_keys = OFF;

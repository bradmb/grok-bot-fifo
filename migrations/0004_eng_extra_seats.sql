-- Eng team FIFO: add two IC seats (ic5, ic6) and bump capacity 4 to 6.
-- Live D1 already applied 0001-0003; this is additive (INSERT OR IGNORE).

INSERT OR IGNORE INTO agents (id, key, display_name, quiet, created_at) VALUES
  ('ic5', 'ic5', 'IC 5', 0, '2026-09-11T00:00:00.000Z'),
  ('ic6', 'ic6', 'IC 6', 0, '2026-09-11T00:00:00.000Z');

INSERT OR IGNORE INTO queues (id, queue_key, kind, owner_agent_id, title, capacity, share_generation, created_at) VALUES
  ('personal:ic5', 'personal:ic5', 'personal', 'ic5', 'IC 5 personal', 1, 1, '2026-09-11T00:00:00.000Z'),
  ('personal:ic6', 'personal:ic6', 'personal', 'ic6', 'IC 6 personal', 1, 1, '2026-09-11T00:00:00.000Z');

INSERT OR IGNORE INTO queue_slots (id, queue_id, agent_id, label, status, created_at) VALUES
  ('eng:ic5', 'team:eng', 'ic5', 'ic5', 'enabled', '2026-09-11T00:00:00.000Z'),
  ('eng:ic6', 'team:eng', 'ic6', 'ic6', 'enabled', '2026-09-11T00:00:00.000Z');

UPDATE queues SET capacity = 6 WHERE queue_key = 'team:eng';

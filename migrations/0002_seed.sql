-- Seed agents, personal queues, Eng team FIFO (capacity 6), parked hold lane (capacity 0). No secrets.

INSERT OR IGNORE INTO agents (id, key, display_name, quiet, created_at) VALUES
  ('dispatcher', 'dispatcher', 'Dispatcher', 0, '2026-09-10T00:00:00.000Z'),
  ('runner', 'runner', 'Runner', 0, '2026-09-10T00:00:00.000Z'),
  ('operator', 'operator', 'Operator', 1, '2026-09-10T00:00:00.000Z'),
  ('dev1', 'dev1', 'Dev 1', 0, '2026-09-10T00:00:00.000Z'),
  ('ic1', 'ic1', 'IC 1', 0, '2026-09-10T00:00:00.000Z'),
  ('ic2', 'ic2', 'IC 2', 0, '2026-09-10T00:00:00.000Z'),
  ('ic3', 'ic3', 'IC 3', 0, '2026-09-10T00:00:00.000Z'),
  ('ic4', 'ic4', 'IC 4', 0, '2026-09-10T00:00:00.000Z'),
  ('ic5', 'ic5', 'IC 5', 0, '2026-09-11T00:00:00.000Z'),
  ('ic6', 'ic6', 'IC 6', 0, '2026-09-11T00:00:00.000Z');

INSERT OR IGNORE INTO queues (id, queue_key, kind, owner_agent_id, title, capacity, share_generation, created_at) VALUES
  ('personal:dispatcher', 'personal:dispatcher', 'personal', 'dispatcher', 'Dispatcher personal', 1, 1, '2026-09-10T00:00:00.000Z'),
  ('personal:runner', 'personal:runner', 'personal', 'runner', 'Runner personal', 1, 1, '2026-09-10T00:00:00.000Z'),
  ('personal:operator', 'personal:operator', 'personal', 'operator', 'Operator personal', 1, 1, '2026-09-10T00:00:00.000Z'),
  ('personal:dev1', 'personal:dev1', 'personal', 'dev1', 'Dev 1 personal', 1, 1, '2026-09-10T00:00:00.000Z'),
  ('personal:ic1', 'personal:ic1', 'personal', 'ic1', 'IC 1 personal', 1, 1, '2026-09-10T00:00:00.000Z'),
  ('personal:ic2', 'personal:ic2', 'personal', 'ic2', 'IC 2 personal', 1, 1, '2026-09-10T00:00:00.000Z'),
  ('personal:ic3', 'personal:ic3', 'personal', 'ic3', 'IC 3 personal', 1, 1, '2026-09-10T00:00:00.000Z'),
  ('personal:ic4', 'personal:ic4', 'personal', 'ic4', 'IC 4 personal', 1, 1, '2026-09-10T00:00:00.000Z'),
  ('personal:ic5', 'personal:ic5', 'personal', 'ic5', 'IC 5 personal', 1, 1, '2026-09-11T00:00:00.000Z'),
  ('personal:ic6', 'personal:ic6', 'personal', 'ic6', 'IC 6 personal', 1, 1, '2026-09-11T00:00:00.000Z'),
  ('team:eng', 'team:eng', 'team', NULL, 'Eng team FIFO', 6, 1, '2026-09-10T00:00:00.000Z'),
  ('team:parked', 'team:parked', 'team', NULL, 'Parked hold lane', 0, 1, '2026-09-10T00:00:00.000Z');

INSERT OR IGNORE INTO queue_slots (id, queue_id, agent_id, label, status, created_at) VALUES
  ('eng:ic1', 'team:eng', 'ic1', 'ic1', 'enabled', '2026-09-10T00:00:00.000Z'),
  ('eng:ic2', 'team:eng', 'ic2', 'ic2', 'enabled', '2026-09-10T00:00:00.000Z'),
  ('eng:ic3', 'team:eng', 'ic3', 'ic3', 'enabled', '2026-09-10T00:00:00.000Z'),
  ('eng:ic4', 'team:eng', 'ic4', 'ic4', 'enabled', '2026-09-10T00:00:00.000Z'),
  ('eng:ic5', 'team:eng', 'ic5', 'ic5', 'enabled', '2026-09-11T00:00:00.000Z'),
  ('eng:ic6', 'team:eng', 'ic6', 'ic6', 'enabled', '2026-09-11T00:00:00.000Z');

INSERT OR IGNORE INTO webhook_endpoints (id, name, created_at) VALUES
  ('dispatcher', 'dispatcher', '2026-09-10T00:00:00.000Z');

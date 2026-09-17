-- Parked hold lane: team FIFO with capacity 0 and no IC slots.
-- HOLD / STOP / Look≠GO items sit here so they do not consume Eng claim-next capacity.

INSERT OR IGNORE INTO queues (id, queue_key, kind, owner_agent_id, title, capacity, share_generation, created_at) VALUES
  ('team:parked', 'team:parked', 'team', NULL, 'Parked hold lane', 0, 1, '2026-09-10T00:00:00.000Z');

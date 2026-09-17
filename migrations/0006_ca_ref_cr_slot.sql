-- Parallel CR seat (cr_slot). Factory queue_slots / slot_id stay implement In Progress only.
-- Session links / ca_ref / factory_ref / fifo-share viewer ship separately (0007).

ALTER TABLE items ADD COLUMN cr_slot TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_items_cr_slot
  ON items (queue_id, cr_slot)
  WHERE state = 'code_review' AND cr_slot IS NOT NULL;

-- Live session links on items. `ca_ref` is the Cursor cloud agent
-- session (bc-… → cursor.com/agents/<ref>), `factory_ref` the Factory session.
-- Set/cleared via item update / progress without releasing a seat. Plain refs —
-- no index, no claim-math role (cr_slot from 0006 is untouched).

ALTER TABLE items ADD COLUMN ca_ref TEXT;
ALTER TABLE items ADD COLUMN factory_ref TEXT;

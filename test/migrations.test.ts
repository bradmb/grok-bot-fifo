import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "../migrations");

function splitSql(sql: string): string[] {
  const stripped = sql
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, "").trimEnd())
    .join("\n");
  return stripped
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function execFile(db: DatabaseSync, sql: string): void {
  for (const stmt of splitSql(sql)) {
    db.exec(stmt);
  }
}

describe("D1 migrations: CR lane", () => {
  it("0005 rebuilds items with comments present and scopes CR backfill to team:eng", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    execFile(db, await readFile(join(MIGRATIONS, "0001_init.sql"), "utf8"));
    execFile(db, await readFile(join(MIGRATIONS, "0002_seed.sql"), "utf8"));
    execFile(db, await readFile(join(MIGRATIONS, "0003_team_parked.sql"), "utf8"));
    execFile(db, await readFile(join(MIGRATIONS, "0004_eng_extra_seats.sql"), "utf8"));

    const now = "2026-09-14T00:00:00.000Z";
    db.prepare(
      `INSERT INTO items (
        id, queue_id, fifo_seq, state, slot_id, assignee_agent_id,
        source_system, source_ref, requester_ref, title, body,
        enqueued_at, started_at, created_at, updated_at
      ) VALUES (?, 'team:eng', 1, 'in_progress', 'eng:ic1', 'ic1',
        '', 'TKT-16426-cr-r2', '', 'CR cycle r2', '', ?, ?, ?, ?)`,
    ).run("i-eng-cr", now, now, now, now);
    db.prepare(
      `INSERT INTO items (
        id, queue_id, fifo_seq, state, slot_id, assignee_agent_id,
        source_system, source_ref, requester_ref, title, body,
        enqueued_at, started_at, created_at, updated_at
      ) VALUES (?, 'personal:dispatcher', 1, 'in_progress', NULL, 'dispatcher',
        '', 'TKT-16426-cr-r9', '', 'CR cycle leftover', '', ?, ?, ?, ?)`,
    ).run("i-pers-cr", now, now, now, now);
    db.prepare(
      `INSERT INTO comments (id, item_id, author_agent_id, body, kind, public, created_at)
       VALUES ('c1', 'i-eng-cr', 'ic1', 'note', 'note', 1, ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO comments (id, item_id, author_agent_id, body, kind, public, created_at)
       VALUES ('c2', 'i-pers-cr', 'dispatcher', 'plate note', 'note', 1, ?)`,
    ).run(now);

    db.exec("BEGIN");
    execFile(db, await readFile(join(MIGRATIONS, "0005_code_review_lane.sql"), "utf8"));
    db.exec("COMMIT");
    execFile(db, await readFile(join(MIGRATIONS, "0006_ca_ref_cr_slot.sql"), "utf8"));

    const fk = db.prepare("PRAGMA foreign_key_check").all() as unknown[];
    assert.deepEqual(fk, []);

    const eng = db.prepare("SELECT state, kind, slot_id FROM items WHERE id = ?").get("i-eng-cr") as {
      state: string;
      kind: string;
      slot_id: string | null;
    };
    assert.equal(eng.state, "code_review");
    assert.equal(eng.kind, "code_review");
    assert.equal(eng.slot_id, null);

    const personal = db.prepare("SELECT state, kind FROM items WHERE id = ?").get("i-pers-cr") as {
      state: string;
      kind: string;
    };
    assert.equal(personal.state, "in_progress");
    assert.equal(personal.kind, "implement");

    const comments = db.prepare("SELECT COUNT(*) AS n FROM comments").get() as { n: number };
    assert.equal(Number(comments.n), 2);

    const crSlot = db.prepare("SELECT cr_slot FROM items WHERE id = ?").get("i-eng-cr") as { cr_slot: string | null };
    assert.equal(crSlot.cr_slot, null);
  });
});

describe("D1 migration: session refs", () => {
  it("0007 adds ca_ref / factory_ref and keeps cr_slot from 0006", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    for (const name of [
      "0001_init.sql",
      "0002_seed.sql",
      "0003_team_parked.sql",
      "0004_eng_extra_seats.sql",
      "0005_code_review_lane.sql",
      "0006_ca_ref_cr_slot.sql",
      "0007_session_refs.sql",
    ]) {
      execFile(db, await readFile(join(MIGRATIONS, name), "utf8"));
    }

    const now = "2026-09-14T00:00:00.000Z";
    db.prepare(
      `INSERT INTO items (
        id, queue_id, fifo_seq, state, slot_id, assignee_agent_id,
        source_system, source_ref, requester_ref, title, body,
        ca_ref, factory_ref, cr_slot,
        enqueued_at, created_at, updated_at
      ) VALUES (?, 'team:eng', 1, 'code_review', NULL, 'ic1',
        '', 'TKT-16432-1', '', 'Session refs', '',
        'bc-abc123', 'droid_sess_42', 'eng:ic1:cr',
        ?, ?, ?)`,
    ).run("i-refs", now, now, now);

    const fk = db.prepare("PRAGMA foreign_key_check").all() as unknown[];
    assert.deepEqual(fk, []);

    const row = db.prepare("SELECT ca_ref, factory_ref, cr_slot FROM items WHERE id = ?").get("i-refs") as {
      ca_ref: string | null;
      factory_ref: string | null;
      cr_slot: string | null;
    };
    assert.equal(row.ca_ref, "bc-abc123");
    assert.equal(row.factory_ref, "droid_sess_42");
    assert.equal(row.cr_slot, "eng:ic1:cr");

    // Pre-existing rows read back NULL refs.
    db.prepare(
      `INSERT INTO items (
        id, queue_id, fifo_seq, state, source_system, source_ref, requester_ref, title, body,
        enqueued_at, created_at, updated_at
      ) VALUES (?, 'team:eng', 2, 'queued', '', '', '', 'No refs', '', ?, ?, ?)`,
    ).run("i-norefs", now, now, now);
    const plain = db.prepare("SELECT ca_ref, factory_ref FROM items WHERE id = ?").get("i-norefs") as {
      ca_ref: string | null;
      factory_ref: string | null;
    };
    assert.equal(plain.ca_ref, null);
    assert.equal(plain.factory_ref, null);
  });
});

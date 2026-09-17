import assert from "node:assert/strict";
import { describe, it } from "node:test";
import worker from "../src/index.ts";
import { dispatcherHeaders, idem, LOCAL, testEnv } from "./helpers.ts";

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function enqueue(
  env: Awaited<ReturnType<typeof testEnv>>,
  body: Record<string, unknown>,
  key: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await worker.fetch(
    new Request(`${LOCAL}/v1/items`, {
      method: "POST",
      headers: { ...dispatcherHeaders(), ...idem(key) },
      body: JSON.stringify(body),
    }),
    env,
  );
  return { status: res.status, body: await json(res) };
}

describe("item update", () => {
  it("updates body only and keeps source_ref / fifo_seq / state", async () => {
    const env = await testEnv();
    const created = await enqueue(
      env,
      { team: "eng", title: "Orig title", body: "old body", source_ref: "upd-body-1" },
      "upd-e1",
    );
    assert.equal(created.status, 201);
    const before = created.body.item as {
      id: string;
      title: string;
      body: string;
      source_ref: string;
      fifo_seq: number;
      state: string;
      queue_key: string;
    };
    const res = await worker.fetch(
      new Request(`${LOCAL}/v1/items/${before.id}/update`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("upd-b1") },
        body: JSON.stringify({ body: "new acceptance" }),
      }),
      env,
    );
    assert.equal(res.status, 200);
    const out = await json(res);
    const item = out.item as typeof before;
    assert.equal(item.body, "new acceptance");
    assert.equal(item.title, "Orig title");
    assert.equal(item.source_ref, before.source_ref);
    assert.equal(item.fifo_seq, before.fifo_seq);
    assert.equal(item.state, before.state);
    assert.equal(item.queue_key, before.queue_key);
    assert.deepEqual(out.changed, { body: "new acceptance" });
    const events = await env.DB.prepare(
      "SELECT event_type FROM item_events WHERE item_id = ? AND event_type = 'item.updated'",
    )
      .bind(before.id)
      .all<{ event_type: string }>();
    assert.equal((events.results || []).length, 1);
  });

  it("updates title when provided", async () => {
    const env = await testEnv();
    const created = await enqueue(
      env,
      { team: "eng", title: "Before", body: "keep", source_ref: "upd-title-1" },
      "upd-e2",
    );
    const before = created.body.item as { id: string; body: string };
    const res = await worker.fetch(
      new Request(`${LOCAL}/v1/items/${before.id}/update`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("upd-t1") },
        body: JSON.stringify({ title: "After title" }),
      }),
      env,
    );
    assert.equal(res.status, 200);
    const item = (await json(res)).item as { title: string; body: string };
    assert.equal(item.title, "After title");
    assert.equal(item.body, before.body);
  });

  it("rejects terminal items with 400 NOT_ACTIVE", async () => {
    const env = await testEnv();
    const created = await enqueue(
      env,
      { team: "eng", title: "Done soon", source_ref: "upd-term-1" },
      "upd-e3",
    );
    const item = created.body.item as { id: string };
    const cancel = await worker.fetch(
      new Request(`${LOCAL}/v1/items/${item.id}/cancel`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("upd-cancel") },
        body: "{}",
      }),
      env,
    );
    assert.equal(cancel.status, 200);
    const res = await worker.fetch(
      new Request(`${LOCAL}/v1/items/${item.id}/update`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("upd-term") },
        body: JSON.stringify({ body: "nope" }),
      }),
      env,
    );
    assert.equal(res.status, 400);
    assert.equal((await json(res)).error, "NOT_ACTIVE");
  });

  it("rejects empty title when title is provided", async () => {
    const env = await testEnv();
    const created = await enqueue(
      env,
      { team: "eng", title: "Keep me", source_ref: "upd-empty-1" },
      "upd-e4",
    );
    const item = created.body.item as { id: string };
    const res = await worker.fetch(
      new Request(`${LOCAL}/v1/items/${item.id}/update`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("upd-empty") },
        body: JSON.stringify({ title: "   " }),
      }),
      env,
    );
    assert.equal(res.status, 400);
    assert.equal((await json(res)).error, "TITLE_REQUIRED");
  });
});

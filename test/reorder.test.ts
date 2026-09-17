import assert from "node:assert/strict";
import { describe, it } from "node:test";
import worker from "../src/index.ts";
import { idem, ic1Headers, dispatcherHeaders, runnerHeaders, LOCAL, testEnv } from "./helpers.ts";

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function enqueue(
  env: Awaited<ReturnType<typeof testEnv>>,
  body: Record<string, unknown>,
  key: string,
): Promise<{ id: string; fifo_seq: number; position: number; title: string }> {
  const res = await worker.fetch(
    new Request(`${LOCAL}/v1/items`, {
      method: "POST",
      headers: { ...dispatcherHeaders(), ...idem(key) },
      body: JSON.stringify(body),
    }),
    env,
  );
  assert.equal(res.status, 201);
  const out = await json(res);
  return out.item as { id: string; fifo_seq: number; position: number; title: string };
}

async function reorder(
  env: Awaited<ReturnType<typeof testEnv>>,
  id: string,
  body: Record<string, unknown>,
  key: string,
  headers: Record<string, string> = dispatcherHeaders(),
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await worker.fetch(
    new Request(`${LOCAL}/v1/items/${id}/reorder`, {
      method: "POST",
      headers: { ...headers, ...idem(key) },
      body: JSON.stringify(body),
    }),
    env,
  );
  return { status: res.status, body: await json(res) };
}

describe("item reorder", () => {
  it("bumps queued item to head and keeps source_ref / id", async () => {
    const env = await testEnv();
    const a = await enqueue(env, { team: "eng", title: "A", source_ref: "ro-a" }, "ro-e1");
    const b = await enqueue(env, { team: "eng", title: "B", source_ref: "ro-b" }, "ro-e2");
    const c = await enqueue(env, { team: "eng", title: "C", source_ref: "ro-c" }, "ro-e3");
    assert.ok(a.fifo_seq < b.fifo_seq && b.fifo_seq < c.fifo_seq);

    const out = await reorder(env, c.id, { to: "head" }, "ro-head");
    assert.equal(out.status, 200);
    const item = out.body.item as { id: string; source_ref: string; state: string; position: number; title: string };
    assert.equal(item.id, c.id);
    assert.equal(item.source_ref, "ro-c");
    assert.equal(item.state, "queued");
    assert.equal(item.position, 1);
    assert.equal(out.body.unchanged, false);

    const board = await json(
      await worker.fetch(new Request(`${LOCAL}/v1/queues/team:eng`, { headers: dispatcherHeaders() }), env),
    );
    const queued = board.queued as Array<{ id: string; title: string }>;
    assert.deepEqual(
      queued.map((q) => q.title),
      ["C", "A", "B"],
    );

    const events = await env.DB.prepare(
      "SELECT event_type FROM item_events WHERE item_id = ? AND event_type = 'item.reordered'",
    )
      .bind(c.id)
      .all<{ event_type: string }>();
    assert.equal((events.results || []).length, 1);
  });

  it("supports --position and --after anchors", async () => {
    const env = await testEnv();
    const a = await enqueue(env, { team: "eng", title: "A", source_ref: "ro-p-a" }, "ro-p1");
    const b = await enqueue(env, { team: "eng", title: "B", source_ref: "ro-p-b" }, "ro-p2");
    const c = await enqueue(env, { team: "eng", title: "C", source_ref: "ro-p-c" }, "ro-p3");

    let out = await reorder(env, a.id, { position: 2 }, "ro-pos");
    assert.equal(out.status, 200);
    let board = await json(
      await worker.fetch(new Request(`${LOCAL}/v1/queues/team:eng`, { headers: dispatcherHeaders() }), env),
    );
    assert.deepEqual(
      (board.queued as Array<{ title: string }>).map((q) => q.title),
      ["B", "A", "C"],
    );

    out = await reorder(env, c.id, { after: a.id }, "ro-after");
    assert.equal(out.status, 200);
    board = await json(
      await worker.fetch(new Request(`${LOCAL}/v1/queues/team:eng`, { headers: dispatcherHeaders() }), env),
    );
    assert.deepEqual(
      (board.queued as Array<{ title: string }>).map((q) => q.title),
      ["B", "A", "C"],
    );
    // C was already after A → unchanged
    assert.equal(out.body.unchanged, true);
  });

  it("allows the runner; rejects IC and non-queued", async () => {
    const env = await testEnv();
    const a = await enqueue(env, { team: "eng", title: "A", source_ref: "ro-auth-a" }, "ro-a1");
    const b = await enqueue(env, { team: "eng", title: "B", source_ref: "ro-auth-b" }, "ro-a2");

    const runner = await reorder(env, b.id, { to: "head" }, "ro-runner", runnerHeaders());
    assert.equal(runner.status, 200);

    const ic = await reorder(env, a.id, { to: "head" }, "ro-ic", ic1Headers());
    assert.equal(ic.status, 403);
    assert.equal(ic.body.error, "FORBIDDEN");

    const claim = await worker.fetch(
      new Request(`${LOCAL}/v1/queues/team:eng/claim-next`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("ro-claim") },
        body: JSON.stringify({ assignee: "ic4" }),
      }),
      env,
    );
    assert.equal(claim.status, 200);
    const wip = (await json(claim)).item as { id: string; state: string };
    assert.equal(wip.state, "in_progress");

    const bad = await reorder(env, wip.id, { to: "tail" }, "ro-wip");
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, "NOT_QUEUED");
  });

  it("rejects missing/duplicate targets", async () => {
    const env = await testEnv();
    const a = await enqueue(env, { team: "eng", title: "A", source_ref: "ro-bad-a" }, "ro-b1");
    const none = await reorder(env, a.id, {}, "ro-none");
    assert.equal(none.status, 400);
    assert.equal(none.body.error, "REORDER_TARGET_REQUIRED");
    const both = await reorder(env, a.id, { to: "head", position: 1 }, "ro-both");
    assert.equal(both.status, 400);
    assert.equal(both.body.error, "REORDER_TARGET_REQUIRED");
  });
});

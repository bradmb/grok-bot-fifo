import assert from "node:assert/strict";
import { describe, it } from "node:test";
import worker from "../src/index.ts";
import { ENG_ICS } from "../src/types.ts";
import { dev1Headers, dispatcherHeaders, idem, LOCAL, testEnv } from "./helpers.ts";

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function enqueue(
  env: Awaited<ReturnType<typeof testEnv>>,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  key: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await worker.fetch(
    new Request(`${LOCAL}/v1/items`, {
      method: "POST",
      headers: { ...headers, ...idem(key) },
      body: JSON.stringify(body),
    }),
    env,
  );
  return { status: res.status, body: await json(res) };
}

describe("FIFO invariants", () => {
  it("keeps exactly one personal in_progress and queues the rest", async () => {
    const env = await testEnv();
    const first = await enqueue(env, dev1Headers(), { personal: "dev1", title: "A", source_ref: "a1" }, "e1");
    const second = await enqueue(env, dev1Headers(), { personal: "dev1", title: "B", source_ref: "a2" }, "e2");
    const third = await enqueue(env, dev1Headers(), { personal: "dev1", title: "C", source_ref: "a3" }, "e3");
    assert.equal(first.status, 201);
    const firstItem = first.body.item as { state: string };
    const secondItem = second.body.item as { state: string; position: number };
    assert.equal(firstItem.state, "in_progress");
    assert.equal(secondItem.state, "queued");
    assert.equal(second.body.plate_full, true);
    assert.match(String(second.body.reply_text), /Plate full/);
    assert.match(String(second.body.share_url), /\/s\//);
    assert.equal((third.body.item as { state: string }).state, "queued");

    const board = await worker.fetch(new Request(`${LOCAL}/v1/queues/personal:dev1`, { headers: dev1Headers() }), env);
    const shown = await json(board);
    assert.equal((shown.in_progress as unknown[]).length, 1);
    assert.equal((shown.queued as unknown[]).length, 2);

    const done = await worker.fetch(
      new Request(`${LOCAL}/v1/items/${(first.body.item as { id: string }).id}/done`, {
        method: "POST",
        headers: { ...dev1Headers(), ...idem("done-a") },
      }),
      env,
    );
    assert.equal(done.status, 200);
    const after = await json(
      await worker.fetch(new Request(`${LOCAL}/v1/queues/personal:dev1`, { headers: dev1Headers() }), env),
    );
    assert.equal((after.in_progress as Array<{ title: string }>)[0].title, "B");
    assert.equal((after.queued as unknown[]).length, 1);
  });

  it("rejects team work on a personal enqueue", async () => {
    const env = await testEnv();
    const res = await enqueue(
      env,
      dev1Headers(),
      { personal: "dev1", title: "Eng ticket", team_scope: "eng", source_ref: "team-on-personal" },
      "team-no",
    );
    assert.equal(res.status, 422);
    assert.equal(res.body.error, "TEAM_QUEUE_REQUIRED");
  });

  it("is idempotent on source_ref", async () => {
    const env = await testEnv();
    const a = await enqueue(env, dev1Headers(), { personal: "dev1", title: "Same", source_system: "jira", source_ref: "TKT-1" }, "s1");
    const b = await enqueue(env, dev1Headers(), { personal: "dev1", title: "Same", source_system: "jira", source_ref: "TKT-1" }, "s2");
    assert.equal(a.status, 201);
    assert.equal(b.status, 200);
    assert.equal(b.body.idempotent, true);
    assert.equal((a.body.item as { id: string }).id, (b.body.item as { id: string }).id);
  });

  it("replays Idempotency-Key and conflicts on a different body", async () => {
    const env = await testEnv();
    const first = await enqueue(env, dev1Headers(), { personal: "dev1", title: "One" }, "same-key");
    const replay = await enqueue(env, dev1Headers(), { personal: "dev1", title: "One" }, "same-key");
    const conflict = await enqueue(env, dev1Headers(), { personal: "dev1", title: "Two" }, "same-key");
    assert.equal(first.status, 201);
    assert.equal(replay.status, 201);
    assert.equal((replay.body.item as { id: string }).id, (first.body.item as { id: string }).id);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, "IDEMPOTENCY_CONFLICT");
  });

  it("seeds team:eng at capacity 6 with all six IC slots enabled", async () => {
    const env = await testEnv();
    const shown = await json(
      await worker.fetch(new Request(`${LOCAL}/v1/queues/team:eng`, { headers: dispatcherHeaders() }), env),
    );
    assert.equal(shown.capacity, 6);
    const slots = shown.slots as Array<{ id: string; label: string; status: string }>;
    assert.equal(slots.length, 6);
    for (const id of ["eng:ic5", "eng:ic6"]) {
      const slot = slots.find((row) => row.id === id);
      assert.ok(slot, `missing slot ${id}`);
      assert.equal(slot.status, "enabled");
    }
  });

  it("never lets Eng exceed 6 in_progress claims", async () => {
    const env = await testEnv();
    for (let i = 0; i < 7; i += 1) {
      const enq = await enqueue(
        env,
        dispatcherHeaders(),
        { team: "eng", title: `Job ${i}`, source_ref: `eng-${i}` },
        `eng-e-${i}`,
      );
      assert.equal(enq.status, 201);
      assert.equal((enq.body.item as { state: string }).state, "queued");
    }
    for (let i = 0; i < ENG_ICS.length; i += 1) {
      const claim = await worker.fetch(
        new Request(`${LOCAL}/v1/queues/team:eng/claim-next`, {
          method: "POST",
          headers: { ...dispatcherHeaders(), ...idem(`claim-${i}`) },
          body: JSON.stringify({ assignee: ENG_ICS[i] }),
        }),
        env,
      );
      assert.equal(claim.status, 200, await claim.text());
    }
    const overflow = await worker.fetch(
      new Request(`${LOCAL}/v1/queues/team:eng/claim-next`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("claim-overflow") },
        body: JSON.stringify({ assignee: "ic1" }),
      }),
      env,
    );
    assert.equal(overflow.status, 409);
    const shown = await json(
      await worker.fetch(new Request(`${LOCAL}/v1/queues/team:eng`, { headers: dispatcherHeaders() }), env),
    );
    assert.equal((shown.in_progress as unknown[]).length, 6);
    assert.equal(shown.occupancy, 6);
  });

  it("requires assignee on claim-next and does not skip the oldest queued item", async () => {
    const env = await testEnv();
    await enqueue(env, dispatcherHeaders(), { team: "eng", title: "Oldest", source_ref: "old" }, "c1");
    await enqueue(env, dispatcherHeaders(), { team: "eng", title: "Newer", source_ref: "new" }, "c2");
    const missing = await worker.fetch(
      new Request(`${LOCAL}/v1/queues/team:eng/claim-next`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("no-assignee") },
        body: JSON.stringify({}),
      }),
      env,
    );
    assert.equal(missing.status, 400);
    assert.equal((await json(missing)).error, "ASSIGNEE_REQUIRED");
    const claimed = await json(
      await worker.fetch(
        new Request(`${LOCAL}/v1/queues/team:eng/claim-next`, {
          method: "POST",
          headers: { ...dispatcherHeaders(), ...idem("claim-old") },
          body: JSON.stringify({ assignee: "ic1" }),
        }),
        env,
      ),
    );
    assert.equal((claimed.item as { title: string }).title, "Oldest");
    assert.equal((claimed.item as { assignee: string }).assignee, "ic1");
  });

  it("keeps the Eng slot on hard-block so the next queued item cannot steal it", async () => {
    const env = await testEnv();
    const a = await enqueue(env, dispatcherHeaders(), { team: "eng", title: "Held", source_ref: "held" }, "h1");
    await enqueue(env, dispatcherHeaders(), { team: "eng", title: "Waiting", source_ref: "wait" }, "h2");
    const claimed = await json(
      await worker.fetch(
        new Request(`${LOCAL}/v1/queues/team:eng/claim-next`, {
          method: "POST",
          headers: { ...dispatcherHeaders(), ...idem("claim-held") },
          body: JSON.stringify({ assignee: "ic2" }),
        }),
        env,
      ),
    );
    const id = (claimed.item as { id: string }).id;
    const blocked = await worker.fetch(
      new Request(`${LOCAL}/v1/items/${id}/hard-block`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("block") },
        body: JSON.stringify({ reason: "waiting on vendor" }),
      }),
      env,
    );
    assert.equal(blocked.status, 200);
    const steal = await worker.fetch(
      new Request(`${LOCAL}/v1/queues/team:eng/claim-next`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("steal") },
        body: JSON.stringify({ assignee: "ic2" }),
      }),
      env,
    );
    assert.equal(steal.status, 409);
    const shown = await json(
      await worker.fetch(new Request(`${LOCAL}/v1/queues/team:eng`, { headers: dispatcherHeaders() }), env),
    );
    const wip = shown.in_progress as Array<{ title: string; hard_blocked: boolean; slot_id: string }>;
    assert.equal(wip.length, 1);
    assert.equal(wip[0].title, "Held");
    assert.equal(wip[0].hard_blocked, true);
    assert.ok(wip[0].slot_id);
    assert.equal((shown.queued as Array<{ title: string }>)[0].title, "Waiting");
  });

  it("clear-block unblocks a hard-blocked item without releasing the Eng slot", async () => {
    const env = await testEnv();
    await enqueue(env, dispatcherHeaders(), { team: "eng", title: "Held", source_ref: "held" }, "cb1");
    await enqueue(env, dispatcherHeaders(), { team: "eng", title: "Waiting", source_ref: "wait" }, "cb2");
    const claimed = await json(
      await worker.fetch(
        new Request(`${LOCAL}/v1/queues/team:eng/claim-next`, {
          method: "POST",
          headers: { ...dispatcherHeaders(), ...idem("cb-claim") },
          body: JSON.stringify({ assignee: "ic2" }),
        }),
        env,
      ),
    );
    const id = (claimed.item as { id: string }).id;
    const blocked = await worker.fetch(
      new Request(`${LOCAL}/v1/items/${id}/hard-block`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("cb-block") },
        body: JSON.stringify({ reason: "waiting on vendor" }),
      }),
      env,
    );
    assert.equal(blocked.status, 200);
    const clearedRes = await worker.fetch(
      new Request(`${LOCAL}/v1/items/${id}/clear-block`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("cb-clear") },
        body: JSON.stringify({}),
      }),
      env,
    );
    assert.equal(clearedRes.status, 200);
    const cleared = (await clearedRes.json()) as {
      item: { hard_blocked: boolean; block_reason: string | null; state: string; slot_id: string | null };
    };
    const item = cleared.item;
    assert.equal(item.hard_blocked, false);
    assert.equal(item.block_reason, null);
    assert.equal(item.state, "in_progress");
    assert.ok(item.slot_id);
    const steal = await worker.fetch(
      new Request(`${LOCAL}/v1/queues/team:eng/claim-next`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("cb-steal") },
        body: JSON.stringify({ assignee: "ic2" }),
      }),
      env,
    );
    assert.equal(steal.status, 409);
    const shown = await json(
      await worker.fetch(new Request(`${LOCAL}/v1/queues/team:eng`, { headers: dispatcherHeaders() }), env),
    );
    const wip = shown.in_progress as Array<{ title: string; hard_blocked: boolean; slot_id: string | null }>;
    assert.equal(wip.length, 1);
    assert.equal(wip[0].title, "Held");
    assert.equal(wip[0].hard_blocked, false);
    assert.ok(wip[0].slot_id);
    assert.equal((shown.queued as Array<{ title: string }>)[0].title, "Waiting");
    const events = await env.DB.prepare("SELECT event_type FROM item_events WHERE item_id = ?")
      .bind(id)
      .all<{ event_type: string }>();
    const types = (events.results || []).map((r) => r.event_type);
    assert.ok(types.includes("item.hard_blocked"));
    assert.ok(types.includes("item.hard_block_cleared"));
  });

  it("clear-block is idempotent and matches hard-block auth/state semantics", async () => {
    const env = await testEnv();
    const created = await enqueue(env, dispatcherHeaders(), { team: "eng", title: "Clear me", source_ref: "clear" }, "cb3");
    const id = (created.body.item as { id: string }).id;
    const queuedClear = await worker.fetch(
      new Request(`${LOCAL}/v1/items/${id}/clear-block`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("cb-queued") },
        body: JSON.stringify({}),
      }),
      env,
    );
    assert.equal(queuedClear.status, 409);
    assert.equal((await json(queuedClear)).error, "NOT_IN_PROGRESS");
    await worker.fetch(
      new Request(`${LOCAL}/v1/queues/team:eng/claim-next`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("cb-claim2") },
        body: JSON.stringify({ assignee: "ic2" }),
      }),
      env,
    );
    const firstRes = await worker.fetch(
      new Request(`${LOCAL}/v1/items/${id}/clear-block`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("cb-first") },
        body: JSON.stringify({}),
      }),
      env,
    );
    assert.equal(firstRes.status, 200);
    const first = (await firstRes.json()) as { item: { hard_blocked: boolean; id: string } };
    assert.equal(first.item.hard_blocked, false);
    const againRes = await worker.fetch(
      new Request(`${LOCAL}/v1/items/${id}/clear-block`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("cb-again") },
        body: JSON.stringify({}),
      }),
      env,
    );
    assert.equal(againRes.status, 200);
    const again = (await againRes.json()) as { item: { hard_blocked: boolean; id: string } };
    assert.equal(again.item.id, id);
    assert.equal(again.item.hard_blocked, false);
    const forbidden = await worker.fetch(
      new Request(`${LOCAL}/v1/items/${id}/clear-block`, {
        method: "POST",
        headers: { ...dev1Headers(), ...idem("cb-forbidden") },
        body: JSON.stringify({}),
      }),
      env,
    );
    assert.equal(forbidden.status, 403);
    assert.equal((await json(forbidden)).error, "FORBIDDEN");
  });

  it("sync-in-progress matches the runner's stated in-flight set", async () => {
    const env = await testEnv();
    const one = await enqueue(env, dispatcherHeaders(), { team: "eng", title: "One", source_ref: "s1" }, "sy1");
    const two = await enqueue(env, dispatcherHeaders(), { team: "eng", title: "Two", source_ref: "s2" }, "sy2");
    await worker.fetch(
      new Request(`${LOCAL}/v1/queues/team:eng/claim-next`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("sy-claim") },
        body: JSON.stringify({ assignee: "ic1" }),
      }),
      env,
    );
    const res = await worker.fetch(
      new Request(`${LOCAL}/v1/queues/team:eng/sync-in-progress`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("sy-sync") },
        body: JSON.stringify({
          in_progress: [{ source_ref: "s2", assignee: "ic3" }],
        }),
      }),
      env,
    );
    assert.equal(res.status, 200, await res.clone().text());
    const body = await json(res);
    const wip = body.in_progress as Array<{ title: string; assignee: string }>;
    assert.equal(wip.length, 1);
    assert.equal(wip[0].title, "Two");
    assert.equal(wip[0].assignee, "ic3");
  });

  it("writes webhook outbox rows on mutations and stubs delivery without a dispatcher URL", async () => {
    const env = await testEnv();
    await enqueue(env, dev1Headers(), { personal: "dev1", title: "Hook", source_ref: "hook" }, "hook1");
    const events = await env.DB.prepare("SELECT event_type FROM item_events").all<{ event_type: string }>();
    const eventTypes = (events.results || []).map((r) => r.event_type);
    assert.ok(eventTypes.includes("item.enqueued"));
    assert.ok(eventTypes.includes("item.assigned"));
    const rows = await env.DB.prepare("SELECT event_type, destination, status FROM webhook_outbox").all<{
      event_type: string;
      destination: string;
      status: string;
    }>();
    assert.ok((rows.results || []).every((r) => r.destination !== "operator"));
    const { runScheduled } = await import("../src/cron.ts");
    await runScheduled(env);
    const after = await env.DB.prepare("SELECT status FROM webhook_outbox").all<{ status: string }>();
    assert.ok((after.results || []).every((r) => r.status === "stubbed"));
  });

  it("emits one stall per generation and waits for the next wake on silence", async () => {
    const env = await testEnv();
    const created = await enqueue(env, dev1Headers(), { personal: "dev1", title: "Stall me", source_ref: "st1" }, "st1");
    const id = (created.body.item as { id: string }).id;
    await env.DB.prepare("UPDATE items SET next_stall_at = ? WHERE id = ?")
      .bind("2026-09-10T16:00:00.000Z", id)
      .run();
    const { sweepStalls } = await import("../src/cron.ts");
    const first = await sweepStalls(env, "2026-09-10T16:00:00.000Z");
    const second = await sweepStalls(env, "2026-09-10T16:00:00.000Z");
    assert.equal(first, 1);
    assert.equal(second, 0);
    const item = await env.DB.prepare("SELECT stall_generation, next_stall_at FROM items WHERE id = ?")
      .bind(id)
      .first<{ stall_generation: number; next_stall_at: string }>();
    assert.equal(item?.stall_generation, 2);
    assert.ok(item && item.next_stall_at > "2026-09-10T16:00:00.000Z");
  });

  it("audits after-hours personal stalls without waking the dispatcher or the owner", async () => {
    const env = await testEnv();
    const created = await enqueue(env, dev1Headers(), { personal: "dev1", title: "Weekend stall", source_ref: "st-wk" }, "st-wk");
    const id = (created.body.item as { id: string }).id;
    const saturdayTenAm = "2026-09-12T16:00:00.000Z";
    await env.DB.prepare("UPDATE items SET next_stall_at = ? WHERE id = ?")
      .bind(saturdayTenAm, id)
      .run();
    const { sweepStalls } = await import("../src/cron.ts");
    assert.equal(await sweepStalls(env, saturdayTenAm), 1);
    const events = await env.DB.prepare(
      "SELECT event_type FROM item_events WHERE event_type = 'item.stalled' AND item_id = ?",
    )
      .bind(id)
      .all<{ event_type: string }>();
    assert.equal((events.results || []).length, 1);
    const outbox = await env.DB.prepare(
      "SELECT destination FROM webhook_outbox WHERE event_type = 'item.stalled'",
    ).all<{ destination: string }>();
    assert.equal((outbox.results || []).length, 0);
  });
});

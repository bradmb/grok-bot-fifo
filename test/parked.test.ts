import assert from "node:assert/strict";
import { describe, it } from "node:test";
import worker from "../src/index.ts";
import { dev1Headers, dispatcherHeaders, ic1Headers, idem, runnerHeaders, LOCAL, testEnv } from "./helpers.ts";

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

describe("team:parked hold lane", () => {
  it("seeds team:parked with capacity 0 and no IC slots", async () => {
    const env = await testEnv();
    const res = await worker.fetch(new Request(`${LOCAL}/v1/queues/team:parked`, { headers: dispatcherHeaders() }), env);
    assert.equal(res.status, 200);
    const board = await json(res);
    assert.equal(board.queue_key, "team:parked");
    assert.equal(board.kind, "team");
    assert.equal(board.capacity, 0);
    assert.equal(board.occupancy, 0);
    assert.deepEqual(board.slots, []);
    assert.deepEqual(board.queued, []);
    assert.deepEqual(board.in_progress, []);
  });

  it("enqueues parked items as queued and lets dev1 enqueue via Eng/park perms", async () => {
    const env = await testEnv();
    const made = await enqueue(env, dispatcherHeaders(), { team: "parked", title: "HOLD vendor", source_ref: "pk-1" }, "pk-e1");
    assert.equal(made.status, 201);
    const item = made.body.item as { state: string; queue_key: string };
    assert.equal(item.state, "queued");
    assert.equal(item.queue_key, "team:parked");

    const dev1 = await enqueue(env, dev1Headers(), { team: "parked", title: "dev1 park", source_ref: "pk-dev1" }, "pk-e2");
    assert.equal(dev1.status, 201);
    assert.equal((dev1.body.item as { state: string }).state, "queued");
  });

  it("rejects claim-next on team:parked with PARKED_NOT_CLAIMABLE", async () => {
    const env = await testEnv();
    await enqueue(env, dispatcherHeaders(), { team: "parked", title: "Do not claim", source_ref: "pk-claim" }, "pk-c1");
    const dispatcherClaim = await worker.fetch(
      new Request(`${LOCAL}/v1/queues/team:parked/claim-next`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("pk-claim-dispatcher") },
        body: JSON.stringify({ assignee: "ic1" }),
      }),
      env,
    );
    assert.equal(dispatcherClaim.status, 400);
    assert.equal((await json(dispatcherClaim)).error, "PARKED_NOT_CLAIMABLE");

    const icClaim = await worker.fetch(
      new Request(`${LOCAL}/v1/queues/team:parked/claim-next`, {
        method: "POST",
        headers: { ...ic1Headers(), ...idem("pk-claim-ic") },
        body: JSON.stringify({ assignee: "ic1" }),
      }),
      env,
    );
    assert.equal(icClaim.status, 400);
    assert.equal((await json(icClaim)).error, "PARKED_NOT_CLAIMABLE");
  });

  it("does not let parked items consume Eng capacity or occupancy", async () => {
    const env = await testEnv();
    const ics = ["ic1", "ic2", "ic3", "ic4"];
    for (let i = 0; i < 4; i += 1) {
      await enqueue(env, dispatcherHeaders(), { team: "eng", title: `Live ${i}`, source_ref: `eng-live-${i}` }, `pk-eng-${i}`);
      const claim = await worker.fetch(
        new Request(`${LOCAL}/v1/queues/team:eng/claim-next`, {
          method: "POST",
          headers: { ...dispatcherHeaders(), ...idem(`pk-fill-${i}`) },
          body: JSON.stringify({ assignee: ics[i] }),
        }),
        env,
      );
      assert.equal(claim.status, 200);
    }
    for (let i = 0; i < 3; i += 1) {
      const parked = await enqueue(
        env,
        dispatcherHeaders(),
        { team: "parked", title: `Parked ${i}`, source_ref: `park-hold-${i}` },
        `pk-hold-${i}`,
      );
      assert.equal(parked.status, 201);
    }
    const overflow = await worker.fetch(
      new Request(`${LOCAL}/v1/queues/team:eng/claim-next`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("pk-eng-overflow") },
        body: JSON.stringify({ assignee: "ic1" }),
      }),
      env,
    );
    assert.equal(overflow.status, 409);
    const eng = await json(
      await worker.fetch(new Request(`${LOCAL}/v1/queues/team:eng`, { headers: dispatcherHeaders() }), env),
    );
    const parked = await json(
      await worker.fetch(new Request(`${LOCAL}/v1/queues/team:parked`, { headers: dispatcherHeaders() }), env),
    );
    assert.equal(eng.occupancy, 4);
    assert.equal((eng.in_progress as unknown[]).length, 4);
    assert.equal(parked.occupancy, 0);
    assert.equal((parked.queued as unknown[]).length, 3);
  });

  it("moves items eng ↔ parked and personal:dispatcher → parked without dropping source_ref", async () => {
    const env = await testEnv();
    const created = await enqueue(
      env,
      dispatcherHeaders(),
      { team: "eng", title: "Pause me", source_ref: "move-ref-1" },
      "pk-mv-1",
    );
    const id = (created.body.item as { id: string }).id;
    const toParked = await worker.fetch(
      new Request(`${LOCAL}/v1/items/${id}/move`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("pk-move-park") },
        body: JSON.stringify({ team: "parked" }),
      }),
      env,
    );
    assert.equal(toParked.status, 200, await toParked.clone().text());
    const parkedItem = (await json(toParked)).item as { id: string; queue_key: string; state: string; source_ref: string };
    assert.equal(parkedItem.id, id);
    assert.equal(parkedItem.queue_key, "team:parked");
    assert.equal(parkedItem.state, "queued");
    assert.equal(parkedItem.source_ref, "move-ref-1");

    const engAfterPark = await json(
      await worker.fetch(new Request(`${LOCAL}/v1/queues/team:eng`, { headers: dispatcherHeaders() }), env),
    );
    assert.equal((engAfterPark.queued as unknown[]).length, 0);

    const back = await worker.fetch(
      new Request(`${LOCAL}/v1/items/${id}/move`, {
        method: "POST",
        headers: { ...runnerHeaders(), ...idem("pk-move-eng") },
        body: JSON.stringify({ queue_key: "team:eng" }),
      }),
      env,
    );
    assert.equal(back.status, 200, await back.clone().text());
    const engItem = (await json(back)).item as { queue_key: string; state: string };
    assert.equal(engItem.queue_key, "team:eng");
    assert.equal(engItem.state, "queued");

    const icMove = await worker.fetch(
      new Request(`${LOCAL}/v1/items/${id}/move`, {
        method: "POST",
        headers: { ...ic1Headers(), ...idem("pk-move-ic") },
        body: JSON.stringify({ team: "parked" }),
      }),
      env,
    );
    assert.equal(icMove.status, 403);

    const personal = await enqueue(
      env,
      dispatcherHeaders(),
      { personal: "dispatcher", title: "Interim parked", source_ref: "dispatcher-interim-1" },
      "pk-dispatcher-1",
    );
    const personalId = (personal.body.item as { id: string }).id;
    const migrate = await worker.fetch(
      new Request(`${LOCAL}/v1/items/${personalId}/move`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("pk-move-dispatcher") },
        body: JSON.stringify({ team: "parked" }),
      }),
      env,
    );
    assert.equal(migrate.status, 200, await migrate.clone().text());
    assert.equal(((await json(migrate)).item as { queue_key: string }).queue_key, "team:parked");
  });

  it("frees an Eng slot when an in_progress item is parked", async () => {
    const env = await testEnv();
    await enqueue(env, dispatcherHeaders(), { team: "eng", title: "WIP then park", source_ref: "wip-park" }, "pk-wip-1");
    await enqueue(env, dispatcherHeaders(), { team: "eng", title: "Waiting", source_ref: "wip-wait" }, "pk-wip-2");
    const claimed = await json(
      await worker.fetch(
        new Request(`${LOCAL}/v1/queues/team:eng/claim-next`, {
          method: "POST",
          headers: { ...dispatcherHeaders(), ...idem("pk-wip-claim") },
          body: JSON.stringify({ assignee: "ic2" }),
        }),
        env,
      ),
    );
    const id = (claimed.item as { id: string }).id;
    const moved = await worker.fetch(
      new Request(`${LOCAL}/v1/items/${id}/move`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("pk-wip-move") },
        body: JSON.stringify({ team: "parked" }),
      }),
      env,
    );
    assert.equal(moved.status, 200);
    const eng = await json(
      await worker.fetch(new Request(`${LOCAL}/v1/queues/team:eng`, { headers: dispatcherHeaders() }), env),
    );
    assert.equal(eng.occupancy, 0);
    const reclaim = await worker.fetch(
      new Request(`${LOCAL}/v1/queues/team:eng/claim-next`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("pk-wip-reclaim") },
        body: JSON.stringify({ assignee: "ic2" }),
      }),
      env,
    );
    assert.equal(reclaim.status, 200);
    assert.equal(((await json(reclaim)).item as { title: string }).title, "Waiting");
  });

  it("serves a share board of parked titles", async () => {
    const env = await testEnv();
    await enqueue(env, dispatcherHeaders(), { team: "parked", title: "Visible parked", source_ref: "share-pk" }, "pk-sh-1");
    const minted = await worker.fetch(
      new Request(`${LOCAL}/v1/share-tokens`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("pk-mint") },
        body: JSON.stringify({ queue_key: "team:parked" }),
      }),
      env,
    );
    assert.equal(minted.status, 201, await minted.clone().text());
    const share = (await minted.json()) as { share_url: string };
    const token = new URL(share.share_url).pathname.replace("/s/", "");
    const page = await worker.fetch(new Request(`${LOCAL}/s/${token}`), env);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Visible parked/);
    assert.match(html, /Parked hold lane/);
    assert.match(html, /not claimable/);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRequest, parseArgv } from "../cli/fifo.mjs";
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

async function claimNext(
  env: Awaited<ReturnType<typeof testEnv>>,
  assignee: string,
  key: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await worker.fetch(
    new Request(`${LOCAL}/v1/queues/team:eng/claim-next`, {
      method: "POST",
      headers: { ...dispatcherHeaders(), ...idem(key) },
      body: JSON.stringify({ assignee }),
    }),
    env,
  );
  return { status: res.status, body: await json(res) };
}

async function claimCr(
  env: Awaited<ReturnType<typeof testEnv>>,
  assignee: string,
  key: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await worker.fetch(
    new Request(`${LOCAL}/v1/queues/team:eng/claim-cr`, {
      method: "POST",
      headers: { ...dispatcherHeaders(), ...idem(key) },
      body: JSON.stringify({ assignee }),
    }),
    env,
  );
  return { status: res.status, body: await json(res) };
}

async function postItemAction(
  env: Awaited<ReturnType<typeof testEnv>>,
  itemId: string,
  action: string,
  body: Record<string, unknown>,
  key: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await worker.fetch(
    new Request(`${LOCAL}/v1/items/${itemId}/${action}`, {
      method: "POST",
      headers: { ...dispatcherHeaders(), ...idem(key) },
      body: JSON.stringify(body),
    }),
    env,
  );
  return { status: res.status, body: await json(res) };
}

async function mintShareHtml(
  env: Awaited<ReturnType<typeof testEnv>>,
  key: string,
): Promise<string> {
  const minted = await worker.fetch(
    new Request(`${LOCAL}/v1/share-tokens`, {
      method: "POST",
      headers: { ...dispatcherHeaders(), ...idem(key) },
      body: JSON.stringify({ queue_key: "team:eng" }),
    }),
    env,
  );
  const share = (await minted.json()) as { share_url: string };
  const token = new URL(share.share_url).pathname.replace("/s/", "");
  const page = await worker.fetch(new Request(`${LOCAL}/s/${token}`), env);
  return page.text();
}

type RefView = { ca_ref?: string | null; factory_ref?: string | null; id?: string };

describe("session links ca_ref / factory_ref", () => {
  it("sets refs via update on an in_progress item without releasing the seat", async () => {
    const env = await testEnv();
    const created = await enqueue(env, { team: "eng", title: "Session job", source_ref: "ref-ip-1" }, "ref-e1");
    const id = (created.body.item as { id: string }).id;
    const claimed = await claimNext(env, "ic1", "ref-c1");
    assert.equal(claimed.status, 200);

    const set = await postItemAction(
      env,
      id,
      "update",
      { ca_ref: "bc-abc123", factory_ref: "droid_sess_42" },
      "ref-u1",
    );
    assert.equal(set.status, 200);
    const item = set.body.item as RefView;
    assert.equal(item.ca_ref, "bc-abc123");
    assert.equal(item.factory_ref, "droid_sess_42");
    assert.deepEqual(set.body.changed, { ca_ref: "bc-abc123", factory_ref: "droid_sess_42" });

    const got = await json(
      await worker.fetch(new Request(`${LOCAL}/v1/items/${id}`, { headers: dispatcherHeaders() }), env),
    );
    assert.equal((got.item as RefView).ca_ref, "bc-abc123");
    assert.equal((got.item as RefView).factory_ref, "droid_sess_42");

    const board = await json(
      await worker.fetch(new Request(`${LOCAL}/v1/queues/team:eng`, { headers: dispatcherHeaders() }), env),
    );
    const ip = (board.in_progress as RefView[]).find((row) => row.id === id);
    assert.equal(ip?.ca_ref, "bc-abc123");
    assert.equal(ip?.factory_ref, "droid_sess_42");

    // Seat untouched: item still in_progress on the same Factory slot.
    const events = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM item_events WHERE event_type = 'capacity.available'",
    ).all<{ n: number }>();
    assert.equal(Number((events.results || [])[0]?.n ?? 0), 0);
  });

  it("is idempotent: re-setting the same ref keeps value and returns 200", async () => {
    const env = await testEnv();
    const created = await enqueue(env, { team: "eng", title: "Idem job", source_ref: "ref-idem" }, "ref-e2");
    const id = (created.body.item as { id: string }).id;
    await postItemAction(env, id, "update", { ca_ref: "bc-same" }, "ref-u2a");
    const again = await postItemAction(env, id, "update", { ca_ref: "bc-same" }, "ref-u2b");
    assert.equal(again.status, 200);
    assert.equal((again.body.item as RefView).ca_ref, "bc-same");
  });

  it("clears refs via update (empty string or null) and via bare CLI flag", async () => {
    const env = await testEnv();
    const created = await enqueue(env, { team: "eng", title: "Clear me", source_ref: "ref-clear" }, "ref-e3");
    const id = (created.body.item as { id: string }).id;
    await postItemAction(env, id, "update", { ca_ref: "bc-x", factory_ref: "f-x" }, "ref-u3a");

    const cleared = await postItemAction(env, id, "update", { ca_ref: "", factory_ref: null }, "ref-u3b");
    assert.equal(cleared.status, 200);
    const item = cleared.body.item as RefView;
    assert.equal(item.ca_ref, null);
    assert.equal(item.factory_ref, null);
    assert.deepEqual(cleared.body.changed, { ca_ref: null, factory_ref: null });

    const bare = buildRequest(parseArgv(["update", "--id", id, "--ca-ref"]).positional, parseArgv(["update", "--id", id, "--ca-ref"]).flags, {});
    assert.equal((bare.body as { ca_ref: string }).ca_ref, "");
  });

  it("progress accepts refs (CA heartbeat) and keeps the CR seat + no Factory stall clock", async () => {
    const env = await testEnv();
    await enqueue(env, { team: "eng", title: "CA review", kind: "code_review", source_ref: "ref-cr-1" }, "ref-e4");
    const cr = await claimCr(env, "ic1", "ref-c2");
    assert.equal(cr.status, 200);
    const id = (cr.body.item as { id: string }).id;

    const beat = await postItemAction(env, id, "progress", { note: "CA alive", ca_ref: "bc-cr-99" }, "ref-p1");
    assert.equal(beat.status, 200);
    const item = beat.body.item as { ca_ref: string | null; factory_ref: string | null; cr_slot: string | null; next_stall_at: string | null };
    assert.equal(item.ca_ref, "bc-cr-99");
    assert.equal(item.cr_slot, "eng:ic1:cr");
    assert.equal(item.next_stall_at, null);

    // Clearing via progress too.
    const cleared = await postItemAction(env, id, "progress", { ca_ref: "" }, "ref-p2");
    assert.equal((cleared.body.item as RefView).ca_ref, null);
  });

  it("share HTML shows session links on In Progress / Code Review cards only, with Cursor agents URL for bc- refs", async () => {
    const env = await testEnv();
    const queued = await enqueue(env, { team: "eng", title: "Still queued", source_ref: "ref-sh-q" }, "ref-sh-qe");
    await postItemAction(env, (queued.body.item as { id: string }).id, "update", { ca_ref: "bc-queued-1" }, "ref-sh-qu");

    await enqueue(env, { team: "eng", title: "Factory live", source_ref: "ref-sh-ip" }, "ref-sh-ipe");
    const ip = await claimNext(env, "ic4", "ref-sh-ipc");
    await postItemAction(
      env,
      (ip.body.item as { id: string }).id,
      "update",
      { factory_ref: "droid-sess-77", ca_ref: "bc-ip-55" },
      "ref-sh-ipu",
    );

    await enqueue(env, { team: "eng", title: "CA review live", kind: "code_review", source_ref: "ref-sh-cr" }, "ref-sh-cre");
    const cr = await claimCr(env, "ic4", "ref-sh-crc");
    await postItemAction(env, (cr.body.item as { id: string }).id, "progress", { ca_ref: "bc-cr-99" }, "ref-sh-cru");

    const html = await mintShareHtml(env, "ref-sh-mint");
    assert.match(html, /https:\/\/cursor\.com\/agents\/bc-ip-55/);
    assert.match(html, /https:\/\/cursor\.com\/agents\/bc-cr-99/);
    assert.match(html, /data-ref="droid-sess-77"/);
    assert.match(html, /Factory session/);
    assert.match(html, /CA session/);
    assert.match(html, /copy-ref/);
    assert.match(html, /setInterval\(poll, 15000\)/);
    // Queued cards never render session links.
    assert.doesNotMatch(html, /bc-queued-1/);

    // Done items drop off the board (refs render nowhere).
    await postItemAction(env, (cr.body.item as { id: string }).id, "done", {}, "ref-sh-done");
    const after = await mintShareHtml(env, "ref-sh-mint2");
    assert.doesNotMatch(after, /bc-cr-99/);
  });

  it("update with no known fields still returns NO_FIELDS", async () => {
    const env = await testEnv();
    const created = await enqueue(env, { team: "eng", title: "No fields", source_ref: "ref-none" }, "ref-e5");
    const id = (created.body.item as { id: string }).id;
    const res = await postItemAction(env, id, "update", {}, "ref-u5");
    assert.equal(res.status, 400);
    assert.equal((res.body as { error: string }).error, "NO_FIELDS");
  });

  it("CLI builds update/progress ref flags", () => {
    const argvUpd = ["update", "--id", "i-1", "--ca-ref", "bc-1", "--factory-ref", "f-1"];
    const upd = buildRequest(parseArgv(argvUpd).positional, parseArgv(argvUpd).flags, {});
    assert.deepEqual(upd.body, { ca_ref: "bc-1", factory_ref: "f-1" });
    const argvProg = ["progress", "--id", "i-1", "--note", "ping", "--ca-ref", "bc-2"];
    const prog = buildRequest(parseArgv(argvProg).positional, parseArgv(argvProg).flags, {});
    assert.deepEqual(prog.body, { note: "ping", ca_ref: "bc-2" });
    const argvClear = ["progress", "--id", "i-1", "--ca-ref"];
    const clear = buildRequest(parseArgv(argvClear).positional, parseArgv(argvClear).flags, {});
    assert.deepEqual(clear.body, { note: "", ca_ref: "" });
    assert.equal(prog.path, "/v1/items/i-1/progress");
  });
});

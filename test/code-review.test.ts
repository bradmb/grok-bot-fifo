import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildRequest, runFifo } from "../cli/fifo.mjs";
import worker from "../src/index.ts";
import { ENG_ICS } from "../src/types.ts";
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
): Promise<Response> {
  return worker.fetch(
    new Request(`${LOCAL}/v1/queues/team:eng/claim-next`, {
      method: "POST",
      headers: { ...dispatcherHeaders(), ...idem(key) },
      body: JSON.stringify({ assignee }),
    }),
    env,
  );
}

async function claimCr(
  env: Awaited<ReturnType<typeof testEnv>>,
  assignee: string,
  key: string,
): Promise<Response> {
  return worker.fetch(
    new Request(`${LOCAL}/v1/queues/team:eng/claim-cr`, {
      method: "POST",
      headers: { ...dispatcherHeaders(), ...idem(key) },
      body: JSON.stringify({ assignee }),
    }),
    env,
  );
}

describe("Eng Code Review lane", () => {
  it("defaults kind to implement and stores code_review when asked", async () => {
    const env = await testEnv();
    const impl = await enqueue(env, { team: "eng", title: "Ship feature", source_ref: "k-impl" }, "k-impl");
    assert.equal(impl.status, 201);
    const implItem = impl.body.item as { kind: string; code_review: boolean; state: string };
    assert.equal(implItem.kind, "implement");
    assert.equal(implItem.code_review, false);
    assert.equal(implItem.state, "queued");

    const cr = await enqueue(
      env,
      { team: "eng", title: "Review PR", kind: "code_review", source_ref: "k-cr" },
      "k-cr",
    );
    assert.equal(cr.status, 201);
    const crItem = cr.body.item as { kind: string; code_review: boolean; state: string };
    assert.equal(crItem.kind, "code_review");
    assert.equal(crItem.code_review, true);
    assert.equal(crItem.state, "queued");
  });

  it("legacy *-cr-rN source_ref is code_review without retag", async () => {
    const env = await testEnv();
    const created = await enqueue(
      env,
      { team: "eng", title: "CR cycle r2", source_ref: "TKT-16426-cr-r2" },
      "leg-1",
    );
    assert.equal(created.status, 201);
    const item = created.body.item as { kind: string; code_review: boolean; source_ref: string };
    assert.equal(item.kind, "code_review");
    assert.equal(item.code_review, true);
    assert.equal(item.source_ref, "TKT-16426-cr-r2");
  });

  it("title containing CR cycle is code_review without an explicit kind", async () => {
    const env = await testEnv();
    const created = await enqueue(
      env,
      { team: "eng", title: "Eng CR cycle r3", source_ref: "title-cr-cycle" },
      "leg-title",
    );
    assert.equal(created.status, 201);
    const item = created.body.item as { kind: string; code_review: boolean };
    assert.equal(item.kind, "code_review");
    assert.equal(item.code_review, true);
  });

  it("mixed Queued stays fifo_seq; claim-next takes implement, claim-cr takes CR", async () => {
    const env = await testEnv();
    await enqueue(env, { team: "eng", title: "Older implement", source_ref: "mix-impl" }, "mix-impl");
    await enqueue(env, { team: "eng", title: "Newer CR", kind: "code_review", source_ref: "mix-cr" }, "mix-cr");
    const board = await json(
      await worker.fetch(new Request(`${LOCAL}/v1/queues/team:eng`, { headers: dispatcherHeaders() }), env),
    );
    const queued = board.queued as Array<{ title: string; kind: string; position: number }>;
    assert.deepEqual(
      queued.map((q) => q.title),
      ["Older implement", "Newer CR"],
    );
    assert.equal(queued[0].kind, "implement");
    assert.equal(queued[0].position, 1);
    assert.equal(queued[1].kind, "code_review");
    assert.equal(queued[1].position, 2);

    const claimed = await json(await claimNext(env, "ic1", "mix-next"));
    const item = claimed.item as {
      title: string;
      state: string;
      slot_id: string | null;
      kind: string;
      runtime: string;
      host: string;
    };
    assert.equal(item.title, "Older implement");
    assert.equal(item.state, "in_progress");
    assert.equal(item.slot_id, "eng:ic1");
    assert.equal(item.kind, "implement");
    assert.equal(item.runtime, "factory");
    assert.equal(item.host, "e2b");

    const cr = await json(await claimCr(env, "ic1", "mix-cr-claim"));
    const crItem = cr.item as {
      title: string;
      state: string;
      slot_id: string | null;
      kind: string;
      runtime: string;
      host: string;
    };
    assert.equal(crItem.title, "Newer CR");
    assert.equal(crItem.state, "code_review");
    assert.equal(crItem.slot_id, null);
    assert.equal(crItem.kind, "code_review");
    assert.equal(crItem.runtime, "cursor_cloud_agent");
    assert.equal(crItem.host, "cursor_cloud_vm");
    assert.equal(JSON.stringify(crItem).includes("e2b"), false);

    const events = await env.DB.prepare(
      "SELECT payload_json FROM item_events WHERE event_type = 'item.assigned' ORDER BY created_at DESC",
    ).all<{ payload_json: string }>();
    const crAssigned = (events.results || [])
      .map((row) => JSON.parse(row.payload_json) as Record<string, unknown>)
      .find((p) => p.lane === "code_review");
    assert.ok(crAssigned);
    assert.equal(crAssigned.host, "cursor_cloud_vm");
    assert.equal(crAssigned.runtime, "cursor_cloud_agent");
    assert.equal(JSON.stringify(crAssigned).includes("e2b"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(crAssigned, "ca_ref"), false);
  });

  it("FIFO among implement via claim-next and FIFO among CR via claim-cr", async () => {
    const env = await testEnv();
    await enqueue(env, { team: "eng", title: "A implement", source_ref: "fifo-a" }, "fifo-a");
    await enqueue(env, { team: "eng", title: "CR older", kind: "code_review", source_ref: "fifo-cr-a" }, "fifo-cr-a");
    await enqueue(env, { team: "eng", title: "B implement", source_ref: "fifo-b" }, "fifo-b");
    await enqueue(env, { team: "eng", title: "CR newer", kind: "code_review", source_ref: "fifo-cr-b" }, "fifo-cr-b");

    const ip1 = await json(await claimNext(env, "ic5", "fifo-1"));
    const ip2 = await json(await claimNext(env, "ic6", "fifo-2"));
    const cr1 = await json(await claimCr(env, "ic5", "fifo-3"));
    const cr2 = await json(await claimCr(env, "ic6", "fifo-4"));
    assert.equal((ip1.item as { title: string; state: string }).title, "A implement");
    assert.equal((ip1.item as { state: string }).state, "in_progress");
    assert.equal((ip1.item as { host: string; runtime: string }).host, "e2b");
    assert.equal((ip1.item as { runtime: string }).runtime, "factory");
    assert.equal((ip2.item as { title: string }).title, "B implement");
    assert.equal((cr1.item as { title: string; state: string }).title, "CR older");
    assert.equal((cr1.item as { state: string }).state, "code_review");
    assert.equal((cr1.item as { host: string }).host, "cursor_cloud_vm");
    assert.equal((cr2.item as { title: string }).title, "CR newer");
  });

  it("Factory IP host is e2b for every implement claim", async () => {
    const env = await testEnv();
    await enqueue(env, { team: "eng", title: "First eng item", source_ref: "eng-42" }, "host-1");
    await enqueue(env, { team: "eng", title: "Second eng item", source_ref: "TKT-99999" }, "host-2");

    const first = await json(await claimNext(env, "ic1", "host-1-claim"));
    const firstItem = first.item as { host: string; runtime: string; source_ref: string; state: string };
    assert.equal(firstItem.source_ref, "eng-42");
    assert.equal(firstItem.state, "in_progress");
    assert.equal(firstItem.runtime, "factory");
    assert.equal(firstItem.host, "e2b");

    const second = await json(await claimNext(env, "ic2", "host-2-claim"));
    const secondItem = second.item as { host: string; runtime: string; source_ref: string; state: string };
    assert.equal(secondItem.source_ref, "TKT-99999");
    assert.equal(secondItem.state, "in_progress");
    assert.equal(secondItem.runtime, "factory");
    assert.equal(secondItem.host, "e2b");

    const events = await env.DB.prepare(
      "SELECT payload_json FROM item_events WHERE event_type = 'item.assigned' ORDER BY created_at ASC",
    ).all<{ payload_json: string }>();
    const hosts = (events.results || [])
      .map((row) => JSON.parse(row.payload_json) as Record<string, unknown>)
      .filter((p) => p.lane === "in_progress")
      .map((p) => p.host);
    assert.deepEqual(hosts, ["e2b", "e2b"]);
  });

  it("claim-cr fills Code Review independently of Factory IP and keeps FIFO among CR", async () => {
    const env = await testEnv();
    await enqueue(env, { team: "eng", title: "Impl first", source_ref: "crf-impl" }, "crf-impl");
    const ip = await json(await claimNext(env, "ic2", "crf-ip"));
    assert.equal((ip.item as { title: string; state: string }).title, "Impl first");
    assert.equal((ip.item as { state: string }).state, "in_progress");

    await enqueue(env, { team: "eng", title: "CR older", kind: "code_review", source_ref: "crf-a" }, "crf-a");
    await enqueue(env, { team: "eng", title: "CR newer", kind: "code_review", source_ref: "crf-b" }, "crf-b");

    const cr1 = await json(await claimCr(env, "ic2", "crf-cr1"));
    const first = cr1.item as { title: string; state: string; slot_id: string | null; assignee: string };
    assert.equal(first.title, "CR older");
    assert.equal(first.state, "code_review");
    assert.equal(first.slot_id, null);
    assert.equal(first.assignee, "ic2");

    const second = await json(await claimCr(env, "ic3", "crf-cr2"));
    assert.equal((second.item as { title: string }).title, "CR newer");

    const board = await json(
      await worker.fetch(new Request(`${LOCAL}/v1/queues/team:eng`, { headers: dispatcherHeaders() }), env),
    );
    assert.equal(board.occupancy, 1);
    assert.equal(board.code_review_occupancy, 2);
    assert.equal(board.code_review_capacity, 6);
    assert.equal((board.in_progress as unknown[]).length, 1);
    assert.equal((board.code_review as unknown[]).length, 2);
    const ic2Slot = (board.slots as Array<{ label: string; held: boolean; cr_held: boolean }>).find(
      (s) => s.label === "ic2",
    );
    assert.equal(ic2Slot?.held, true);
    assert.equal(ic2Slot?.cr_held, true);
    assert.equal((ic2Slot as { cr_slot?: string })?.cr_slot, "eng:ic2:cr");
  });

  it("uses cr_slot not Factory slot, and CR progress does not set the Factory stall clock", async () => {
    const env = await testEnv();
    await enqueue(env, { team: "eng", title: "Factory job", source_ref: "ca-ip" }, "ca-ip");
    const ip = await json(await claimNext(env, "ic1", "ca-ip-claim"));
    assert.equal((ip.item as { state: string; slot_id: string; cr_slot: string | null }).state, "in_progress");
    assert.equal((ip.item as { slot_id: string }).slot_id, "eng:ic1");
    assert.equal((ip.item as { cr_slot: string | null }).cr_slot, null);

    await enqueue(env, { team: "eng", title: "CA review", kind: "code_review", source_ref: "ca-cr" }, "ca-cr");
    const cr = await json(await claimCr(env, "ic1", "ca-cr-claim"));
    const item = cr.item as {
      state: string;
      slot_id: string | null;
      cr_slot: string;
      assignee: string;
      next_stall_at: string | null;
      ca_ref: string | null;
    };
    assert.equal(item.state, "code_review");
    assert.equal(item.slot_id, null);
    assert.equal(item.cr_slot, "eng:ic1:cr");
    assert.equal(item.assignee, "ic1");
    assert.equal(item.next_stall_at, null);
    // ca_ref is part of item views (null until the CA sets it).
    assert.equal(Object.prototype.hasOwnProperty.call(item, "ca_ref"), true);
    assert.equal(item.ca_ref, null);

    const progress = await worker.fetch(
      new Request(`${LOCAL}/v1/items/${(cr.item as { id: string }).id}/progress`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("ca-prog") },
        body: JSON.stringify({ note: "CA alive" }),
      }),
      env,
    );
    assert.equal(progress.status, 200);
    const after = (await json(progress)).item as { next_stall_at: string | null };
    assert.equal(after.next_stall_at, null);

    const board = await json(
      await worker.fetch(new Request(`${LOCAL}/v1/queues/team:eng`, { headers: dispatcherHeaders() }), env),
    );
    assert.equal(board.occupancy, 1);
    assert.equal(board.code_review_occupancy, 1);
    assert.equal((board.in_progress as unknown[]).length, 1);
    assert.equal((board.code_review as unknown[]).length, 1);
  });

  it("one CR per IC; claim-cr does not consume Factory capacity", async () => {
    const env = await testEnv();
    for (let i = 0; i < ENG_ICS.length; i += 1) {
      await enqueue(env, { team: "eng", title: `IP ${i}`, source_ref: `cap-ip-${i}` }, `cap-ip-${i}`);
      assert.equal((await claimNext(env, ENG_ICS[i], `cap-claim-ip-${i}`)).status, 200);
    }
    const overflowIp = await claimNext(env, "ic1", "cap-ip-overflow");
    assert.equal(overflowIp.status, 409);

    await enqueue(env, { team: "eng", title: "CR while full IP", kind: "code_review", source_ref: "cap-cr-1" }, "cap-cr-1");
    await enqueue(env, { team: "eng", title: "CR two", kind: "code_review", source_ref: "cap-cr-2" }, "cap-cr-2");
    const stillFull = await claimNext(env, "ic1", "cap-next-while-cr");
    assert.equal(stillFull.status, 409);
    assert.equal((await json(stillFull)).error, "NO_CAPACITY");

    const cr = await claimCr(env, "ic1", "cap-cr-ic1");
    assert.equal(cr.status, 200, await cr.clone().text());
    assert.equal(((await json(cr)).item as { state: string }).state, "code_review");

    const dup = await claimCr(env, "ic1", "cap-cr-dup");
    assert.equal(dup.status, 409);
    assert.equal((await json(dup)).error, "CR_SEAT_HELD");

    const board = await json(
      await worker.fetch(new Request(`${LOCAL}/v1/queues/team:eng`, { headers: dispatcherHeaders() }), env),
    );
    assert.equal(board.occupancy, 6);
    assert.equal((board.in_progress as unknown[]).length, 6);
    assert.equal(board.code_review_occupancy, 1);
  });

  it("claim-next skips queued CR and takes implement FIFO", async () => {
    const env = await testEnv();
    await enqueue(env, { team: "eng", title: "A implement", source_ref: "held-a" }, "fifo-a");
    await enqueue(env, { team: "eng", title: "CR mid", kind: "code_review", source_ref: "held-cr" }, "fifo-cr");
    await enqueue(env, { team: "eng", title: "B implement", source_ref: "held-b" }, "fifo-b");
    const ip = await json(await claimNext(env, "ic5", "held-ip"));
    assert.equal((ip.item as { title: string; state: string }).title, "A implement");
    assert.equal((ip.item as { state: string }).state, "in_progress");
    const cr = await json(await claimCr(env, "ic5", "held-cr"));
    assert.equal((cr.item as { title: string; state: string }).title, "CR mid");
    assert.equal((cr.item as { state: string }).state, "code_review");
    const other = await json(await claimNext(env, "ic6", "held-b"));
    assert.equal((other.item as { title: string }).title, "B implement");
  });

  it("claim-next with only CR queued returns NO_IMPLEMENT_QUEUED; claim-cr fills the CR lane", async () => {
    const env = await testEnv();
    await enqueue(env, { team: "eng", title: "Only CR", kind: "code_review", source_ref: "only-cr" }, "only-cr");
    const next = await claimNext(env, "ic4", "only-cr-next");
    assert.equal(next.status, 404);
    assert.equal((await json(next)).error, "NO_IMPLEMENT_QUEUED");
    const res = await json(await claimCr(env, "ic4", "only-cr-claim"));
    const item = res.item as { title: string; state: string; slot_id: string | null };
    assert.equal(item.title, "Only CR");
    assert.equal(item.state, "code_review");
    assert.equal(item.slot_id, null);
  });

  it("claim-next with only CR queued and CR seat held returns NO_IMPLEMENT_QUEUED", async () => {
    const env = await testEnv();
    await enqueue(env, { team: "eng", title: "CR one", kind: "code_review", source_ref: "held-only-1" }, "only-1");
    await enqueue(env, { team: "eng", title: "CR two", kind: "code_review", source_ref: "held-only-2" }, "only-2");
    assert.equal((await claimCr(env, "ic4", "only-1-next")).status, 200);
    const res = await claimNext(env, "ic4", "only-2-next");
    assert.equal(res.status, 404);
    assert.equal((await json(res)).error, "NO_IMPLEMENT_QUEUED");
  });

  it("legacy source_ref CR is claimed via claim-cr into the CR lane", async () => {
    const env = await testEnv();
    await enqueue(env, { team: "eng", title: "Legacy CR", source_ref: "TKT-16431-cr-r1" }, "leg-claim");
    const next = await json(await claimCr(env, "ic1", "leg-next"));
    assert.equal((next.item as { source_ref: string; state: string }).source_ref, "TKT-16431-cr-r1");
    assert.equal((next.item as { state: string }).state, "code_review");
  });

  it("update can set kind on a queued item", async () => {
    const env = await testEnv();
    const created = await enqueue(env, { team: "eng", title: "Retag me", source_ref: "upd-kind" }, "upd-k");
    const id = (created.body.item as { id: string }).id;
    const res = await worker.fetch(
      new Request(`${LOCAL}/v1/items/${id}/update`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("upd-kind") },
        body: JSON.stringify({ kind: "code_review" }),
      }),
      env,
    );
    assert.equal(res.status, 200);
    const out = await json(res);
    assert.equal((out.item as { kind: string; code_review: boolean }).kind, "code_review");
    assert.equal((out.changed as { kind: string }).kind, "code_review");
  });

  it("title-only CR cycle on queued recomputes kind; active lane retag is locked", async () => {
    const env = await testEnv();
    const created = await enqueue(env, { team: "eng", title: "Ship it", source_ref: "title-retag" }, "upd-title-enq");
    const id = (created.body.item as { id: string }).id;
    const titleUpd = await worker.fetch(
      new Request(`${LOCAL}/v1/items/${id}/update`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("upd-title-cr") },
        body: JSON.stringify({ title: "Eng CR cycle r1" }),
      }),
      env,
    );
    assert.equal(titleUpd.status, 200);
    const queued = await json(titleUpd);
    assert.equal((queued.item as { kind: string }).kind, "code_review");
    assert.equal((queued.changed as { kind: string }).kind, "code_review");

    await enqueue(env, { team: "eng", title: "Live ship", source_ref: "live-ip" }, "live-ip");
    const ip = await json(await claimNext(env, "ic1", "live-ip-c"));
    const liveId = (ip.item as { id: string }).id;
    const locked = await worker.fetch(
      new Request(`${LOCAL}/v1/items/${liveId}/update`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("live-kind") },
        body: JSON.stringify({ kind: "code_review" }),
      }),
      env,
    );
    assert.equal(locked.status, 409);
    assert.equal((await json(locked)).error, "LANE_KIND_LOCKED");
  });

  it("done on CR frees the CR seat without touching Factory occupancy", async () => {
    const env = await testEnv();
    await enqueue(env, { team: "eng", title: "Factory", source_ref: "done-ip" }, "done-ip");
    await claimNext(env, "ic1", "done-claim-ip");
    await enqueue(env, { team: "eng", title: "Review", kind: "code_review", source_ref: "done-cr" }, "done-cr");
    const cr = await json(await claimCr(env, "ic1", "done-claim-cr"));
    const crId = (cr.item as { id: string }).id;
    const done = await worker.fetch(
      new Request(`${LOCAL}/v1/items/${crId}/done`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("done-cr-x") },
      }),
      env,
    );
    assert.equal(done.status, 200);
    const board = await json(
      await worker.fetch(new Request(`${LOCAL}/v1/queues/team:eng`, { headers: dispatcherHeaders() }), env),
    );
    assert.equal(board.occupancy, 1);
    assert.equal(board.code_review_occupancy, 0);
    assert.equal((board.in_progress as Array<{ title: string }>)[0].title, "Factory");
  });

  it("sync-in-progress ignores Code Review items and rejects CR roster rows", async () => {
    const env = await testEnv();
    await enqueue(env, { team: "eng", title: "IP", source_ref: "sy-ip" }, "sy-ip");
    await claimNext(env, "ic1", "sy-ip-c");
    await enqueue(env, { team: "eng", title: "CR", kind: "code_review", source_ref: "sy-cr" }, "sy-cr");
    await claimCr(env, "ic1", "sy-cr-c");
    const res = await worker.fetch(
      new Request(`${LOCAL}/v1/queues/team:eng/sync-in-progress`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("sy-cr-sync") },
        body: JSON.stringify({ in_progress: [{ source_ref: "sy-ip", assignee: "ic1" }] }),
      }),
      env,
    );
    assert.equal(res.status, 200);
    const board = await json(
      await worker.fetch(new Request(`${LOCAL}/v1/queues/team:eng`, { headers: dispatcherHeaders() }), env),
    );
    assert.equal((board.in_progress as unknown[]).length, 1);
    assert.equal((board.code_review as Array<{ title: string }>)[0].title, "CR");

    const reject = await worker.fetch(
      new Request(`${LOCAL}/v1/queues/team:eng/sync-in-progress`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("sy-cr-reject") },
        body: JSON.stringify({ in_progress: [{ source_ref: "sy-cr", assignee: "ic1" }] }),
      }),
      env,
    );
    assert.equal(reject.status, 409);
    assert.equal((await json(reject)).error, "CANNOT_SYNC_CODE_REVIEW");
  });

  it("share board shows Queued, In Progress, and Code Review", async () => {
    const env = await testEnv();
    await enqueue(env, { team: "eng", title: "Waiting ship", source_ref: "sh-q" }, "sh-q");
    await enqueue(env, { team: "eng", title: "Factory live", source_ref: "sh-ip" }, "sh-ip");
    await claimNext(env, "ic4", "sh-ip-c");
    await enqueue(env, { team: "eng", title: "CA review", kind: "code_review", source_ref: "sh-cr" }, "sh-cr");
    await claimCr(env, "ic4", "sh-cr-c");
    const minted = await worker.fetch(
      new Request(`${LOCAL}/v1/share-tokens`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("sh-cr-mint") },
        body: JSON.stringify({ queue_key: "team:eng" }),
      }),
      env,
    );
    const share = (await minted.json()) as { share_url: string };
    const token = new URL(share.share_url).pathname.replace("/s/", "");
    const page = await worker.fetch(new Request(`${LOCAL}/s/${token}`), env);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Waiting ship/);
    assert.match(html, /Factory live/);
    assert.match(html, /CA review/);
    const queuedAt = html.indexOf('id="q-h">Queued<');
    const wipAt = html.indexOf('id="wip-h">In progress<');
    const crAt = html.indexOf('id="cr-h">Code Review<');
    assert.ok(queuedAt >= 0 && wipAt > queuedAt && crAt > wipAt);
    assert.match(html, /Factory seats/);
    assert.match(html, /Code Review \(Cursor cloud VM\)/);
    assert.match(html, /pill--cr/);
    assert.doesNotMatch(html, />CA</);
    assert.doesNotMatch(html, /bc-/);
  });

  it("rejects claim-cr on parked", async () => {
    const env = await testEnv();
    const res = await worker.fetch(
      new Request(`${LOCAL}/v1/queues/team:parked/claim-cr`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("pk-cr") },
        body: JSON.stringify({ assignee: "ic1" }),
      }),
      env,
    );
    assert.equal(res.status, 400);
    assert.equal((await json(res)).error, "PARKED_NOT_CLAIMABLE");
  });

  it("CLI enqueue --kind and claim-cr", async () => {
    const env = await testEnv();
    const enq = buildRequest(["enqueue"], { team: "eng", title: "CLI CR", kind: "code_review" }, {});
    assert.equal((enq.body as { kind: string }).kind, "code_review");
    const upd = buildRequest(["update"], { id: "item-1", kind: "code_review" }, {});
    assert.equal((upd.body as { kind: string }).kind, "code_review");
    const cr = buildRequest(["claim-cr"], { team: "eng", assignee: "ic1" }, {});
    assert.equal(cr.path, "/v1/queues/team:eng/claim-cr");
    assert.equal((cr.body as { assignee: string }).assignee, "ic1");
    assert.equal(Object.prototype.hasOwnProperty.call(cr.body, "ca_ref"), false);
    assert.throws(() => buildRequest(["claim-cr"], { team: "parked", assignee: "ic1" }, {}), /not claimable/);

    const spool = await mkdtemp(join(tmpdir(), "fifo-spool-"));
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) =>
      worker.fetch(typeof input === "string" || input instanceof URL ? new Request(input, init) : input, env);
    const logs: string[] = [];
    const code = await runFifo(
      ["enqueue", "--team", "eng", "--title", "CLI CR job", "--kind", "code_review", "--json"],
      { FIFO_API: LOCAL, FIFO_ACCESS_CLIENT_ID: "dev-dispatcher", FIFO_ACTOR: "dispatcher", FIFO_SPOOL: spool },
      fetchImpl,
      { log: (m: string) => logs.push(String(m)), error: (m: string) => logs.push(String(m)) },
    );
    assert.equal(code, 0);
    const parsed = JSON.parse(logs[0]);
    assert.equal(parsed.item.kind, "code_review");
    const claimLogs: string[] = [];
    const claimed = await runFifo(
      ["claim-cr", "--team", "eng", "--assignee", "ic1", "--json"],
      { FIFO_API: LOCAL, FIFO_ACCESS_CLIENT_ID: "dev-dispatcher", FIFO_ACTOR: "dispatcher", FIFO_SPOOL: spool },
      fetchImpl,
      { log: (m: string) => claimLogs.push(String(m)), error: () => undefined },
    );
    assert.equal(claimed, 0);
    assert.match(claimLogs[0], /code_review/);
  });

  it("code_review on personal is TEAM_QUEUE_REQUIRED", async () => {
    const env = await testEnv();
    const res = await worker.fetch(
      new Request(`${LOCAL}/v1/items`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("pers-cr") },
        body: JSON.stringify({ personal: "dispatcher", title: "Nope", kind: "code_review" }),
      }),
      env,
    );
    assert.equal(res.status, 422);
    assert.equal((await json(res)).error, "TEAM_QUEUE_REQUIRED");
  });
});

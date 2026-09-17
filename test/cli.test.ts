import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildRequest, isMainEntry, pickEnv, redact, resolveApiBase, runFifo } from "../cli/fifo.mjs";
import worker from "../src/index.ts";
import { LOCAL, testEnv } from "./helpers.ts";

describe("fifo CLI", () => {
  it("never echoes secrets through redact", () => {
    assert.equal(redact("abcdef"), "***");
    assert.match(redact("super-secret-value"), /…/);
    assert.doesNotMatch(redact("super-secret-value"), /super-secret-value/);
  });

  it("isMainEntry matches direct and symlinked invocation (bin shim)", async () => {
    const cliPath = fileURLToPath(new URL("../cli/fifo.mjs", import.meta.url));
    const mainUrl = pathToFileURL(realpathSync(cliPath)).href;
    const dir = await mkdtemp(join(tmpdir(), "fifo-bin-"));
    const link = join(dir, "fifo");
    await symlink(cliPath, link);
    assert.equal(isMainEntry(cliPath, mainUrl), true); // direct: node cli/fifo.mjs
    assert.equal(isMainEntry(link, mainUrl), true); // symlinked bin shim
    assert.equal(isMainEntry(join(dir, "missing.mjs"), mainUrl), false); // nonexistent entry
    assert.equal(isMainEntry(link, "file:///opt/other/cli/fifo.mjs"), false); // other module
    assert.equal(isMainEntry(undefined, mainUrl), false); // no argv[1] (node -e / REPL)
  });

  it("uses FIFO_API / FIFO_ACTOR with no legacy fallbacks", () => {
    assert.equal(pickEnv({ FIFO_ACTOR: "dev1" }, "FIFO_ACTOR"), "dev1");
    assert.equal(pickEnv({ LEGACY_ACTOR: "old" }, "FIFO_ACTOR"), undefined);
    assert.equal(resolveApiBase({ FIFO_API: "https://fifo.example" }), "https://fifo.example");
    assert.equal(resolveApiBase({ LEGACY_API: "https://old.example/" }), "http://127.0.0.1:8787");
    const preferred = buildRequest(["enqueue"], { personal: "dev1", title: "Hi" }, { FIFO_ACTOR: "dev1" });
    assert.equal((preferred.headers as Record<string, string>)["X-Fifo-Actor"], "dev1");
    const none = buildRequest(["enqueue"], { personal: "dev1", title: "Hi" }, {});
    assert.equal((none.headers as Record<string, string>)["X-Fifo-Actor"], undefined);
  });

  it("builds personal enqueue and team next", () => {
    const enq = buildRequest(["enqueue"], { personal: "dev1", title: "Hi" }, { FIFO_ACTOR: "dev1" });
    assert.equal(enq.path, "/v1/items");
    assert.equal((enq.body as { personal: string }).personal, "dev1");
    const next = buildRequest(["next"], { team: "eng", assignee: "ic1" }, {});
    assert.equal(next.path, "/v1/queues/team:eng/claim-next");
    assert.equal((next.body as { assignee: string }).assignee, "ic1");
    assert.throws(() => buildRequest(["enqueue"], { personal: "dev1", team: "eng", title: "x" }, {}), /TEAM_QUEUE_REQUIRED/);
    const parkedEnq = buildRequest(["enqueue"], { team: "parked", title: "Hold" }, {});
    assert.equal((parkedEnq.body as { team: string }).team, "parked");
    const parkedShow = buildRequest(["queue", "show"], { team: "parked" }, {});
    assert.equal(parkedShow.path, "/v1/queues/team:parked");
    const parkedMove = buildRequest(["move"], { id: "item-1", team: "parked" }, {});
    assert.equal(parkedMove.path, "/v1/items/item-1/move");
    assert.equal((parkedMove.body as { team: string }).team, "parked");
    assert.throws(() => buildRequest(["next"], { team: "parked", assignee: "ic1" }, {}), /not claimable/);
    const upd = buildRequest(["update"], { id: "item-9", title: "New", body: "packet" }, {});
    assert.equal(upd.path, "/v1/items/item-9/update");
    assert.equal((upd.body as { title: string; body: string }).title, "New");
    assert.equal((upd.body as { body: string }).body, "packet");
    assert.throws(() => buildRequest(["update"], { id: "item-9" }, {}), /requires --title/);
    const reorder = buildRequest(["reorder"], { id: "item-3", to: "head" }, {});
    assert.equal(reorder.path, "/v1/items/item-3/reorder");
    assert.equal((reorder.body as { to: string }).to, "head");
    assert.throws(() => buildRequest(["reorder"], { id: "item-3" }, {}), /exactly one of/);
    assert.throws(
      () => buildRequest(["reorder"], { id: "item-3", to: "head", position: "2" }, {}),
      /exactly one of/,
    );
    const unblock = buildRequest(["unblock"], { id: "item-5" }, {});
    assert.equal(unblock.path, "/v1/items/item-5/clear-block");
    assert.throws(() => buildRequest(["unblock"], {}, {}), /requires --id/);
  });

  it("enqueues against a local worker via injected fetch", async () => {
    const env = await testEnv();
    const spool = await mkdtemp(join(tmpdir(), "fifo-spool-"));
    const logs: string[] = [];
    const code = await runFifo(
      ["enqueue", "--personal", "dev1", "--title", "CLI job", "--json"],
      {
        FIFO_API: LOCAL,
        FIFO_ACCESS_CLIENT_ID: "dev-dev1",
        FIFO_ACTOR: "dev1",
        FIFO_SPOOL: spool,
      },
      async (input: string | URL | Request, init?: RequestInit) =>
        worker.fetch(typeof input === "string" || input instanceof URL ? new Request(input, init) : input, env),
      { log: (m: string) => logs.push(String(m)), error: (m: string) => logs.push(String(m)) },
    );
    assert.equal(code, 0);
    const parsed = JSON.parse(logs[0]);
    assert.equal(parsed.item.title, "CLI job");
    assert.equal(parsed.item.state, "in_progress");
  });

  it("ignores legacy actor env vars entirely", async () => {
    const env = await testEnv();
    const spool = await mkdtemp(join(tmpdir(), "fifo-spool-"));
    const logs: string[] = [];
    const code = await runFifo(
      ["enqueue", "--personal", "dev1", "--title", "Legacy ignored", "--json"],
      {
        LEGACY_API: LOCAL,
        LEGACY_ACCESS_CLIENT_ID: "dev-dev1",
        LEGACY_ACTOR: "dev1",
        LEGACY_SPOOL: spool,
      },
      async (input: string | URL | Request, init?: RequestInit) =>
        worker.fetch(typeof input === "string" || input instanceof URL ? new Request(input, init) : input, env),
      { log: (m: string) => logs.push(String(m)), error: (m: string) => logs.push(String(m)) },
    );
    assert.equal(code, 1);
    assert.match(String(logs[0]), /Local dev client required|Authentication required/i);
  });

  it("runs team claim-next", async () => {
    const env = await testEnv();
    const spool = await mkdtemp(join(tmpdir(), "fifo-spool-"));
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) =>
      worker.fetch(typeof input === "string" || input instanceof URL ? new Request(input, init) : input, env);
    const io: { log: (m?: string) => void; error: (m?: string) => void; last?: string } = {
      log: () => undefined,
      error: () => undefined,
    };
    await runFifo(
      ["enqueue", "--team", "eng", "--title", "Team job", "--json"],
      { FIFO_API: LOCAL, FIFO_ACCESS_CLIENT_ID: "dev-dispatcher", FIFO_ACTOR: "dispatcher", FIFO_SPOOL: spool },
      fetchImpl,
      io,
    );
    const code = await runFifo(
      ["next", "--team", "eng", "--assignee", "ic4", "--json"],
      { FIFO_API: LOCAL, FIFO_ACCESS_CLIENT_ID: "dev-dispatcher", FIFO_ACTOR: "dispatcher", FIFO_SPOOL: spool },
      fetchImpl,
      { log: (m: string) => { io.last = String(m); }, error: () => undefined },
    );
    assert.equal(code, 0);
    assert.match(io.last || "", /ic4/);
  });

  it("enqueues and shows --team parked", async () => {
    const env = await testEnv();
    const spool = await mkdtemp(join(tmpdir(), "fifo-spool-"));
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) =>
      worker.fetch(typeof input === "string" || input instanceof URL ? new Request(input, init) : input, env);
    const logs: string[] = [];
    const enq = await runFifo(
      ["enqueue", "--team", "parked", "--title", "Parked job", "--json"],
      { FIFO_API: LOCAL, FIFO_ACCESS_CLIENT_ID: "dev-dispatcher", FIFO_ACTOR: "dispatcher", FIFO_SPOOL: spool },
      fetchImpl,
      { log: (m: string) => logs.push(String(m)), error: (m: string) => logs.push(String(m)) },
    );
    assert.equal(enq, 0);
    const parsed = JSON.parse(logs[0]);
    assert.equal(parsed.item.title, "Parked job");
    assert.equal(parsed.item.queue_key, "team:parked");
    assert.equal(parsed.item.state, "queued");

    const showLogs: string[] = [];
    const show = await runFifo(
      ["queue", "show", "--team", "parked", "--json"],
      { FIFO_API: LOCAL, FIFO_ACCESS_CLIENT_ID: "dev-dispatcher", FIFO_ACTOR: "dispatcher", FIFO_SPOOL: spool },
      fetchImpl,
      { log: (m: string) => showLogs.push(String(m)), error: (m: string) => showLogs.push(String(m)) },
    );
    assert.equal(show, 0);
    const board = JSON.parse(showLogs[0]);
    assert.equal(board.queue_key, "team:parked");
    assert.equal(board.capacity, 0);
    assert.equal(board.queued[0].title, "Parked job");
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import worker from "../src/index.ts";
import { dev1Headers, dispatcherHeaders, idem, LOCAL, testEnv } from "./helpers.ts";

describe("worker HTTP surface", () => {
  it("serves public health without Access", async () => {
    const env = await testEnv();
    const res = await worker.fetch(new Request(`${LOCAL}/health`), env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, service: "fifo-worker" });
  });

  it("requires auth and Idempotency-Key on mutations", async () => {
    const env = await testEnv({ AUTH_REQUIRED: "true" });
    const unauth = await worker.fetch(
      new Request("https://worker.example.com/v1/items", {
        method: "POST",
        body: JSON.stringify({ personal: "dev1", title: "nope" }),
      }),
      env,
    );
    assert.equal(unauth.status, 401);

    const badJwt = await worker.fetch(
      new Request("https://worker.example.com/v1/health", {
        headers: { "Cf-Access-Jwt-Assertion": "not-a-jwt" },
      }),
      env,
    );
    assert.equal(badJwt.status, 401);

    const localEnv = await testEnv();
    const missingKey = await worker.fetch(
      new Request(`${LOCAL}/v1/items`, {
        method: "POST",
        headers: dev1Headers(),
        body: JSON.stringify({ personal: "dev1", title: "x" }),
      }),
      localEnv,
    );
    assert.equal(missingKey.status, 400);
  });

  it("documents empty-queue CRUD smoke", async () => {
    const env = await testEnv();
    const empty = await worker.fetch(new Request(`${LOCAL}/v1/queues/personal:dev1`, { headers: dev1Headers() }), env);
    assert.equal(empty.status, 200);
    const board = (await empty.json()) as { queued: unknown[]; in_progress: unknown[] };
    assert.deepEqual(board.queued, []);
    assert.deepEqual(board.in_progress, []);

    const created = await worker.fetch(
      new Request(`${LOCAL}/v1/items`, {
        method: "POST",
        headers: { ...dev1Headers(), ...idem("smoke-1") },
        body: JSON.stringify({ personal: "dev1", title: "Smoke" }),
      }),
      env,
    );
    assert.equal(created.status, 201);
    const item = (await created.json()) as { item: { id: string } };
    const got = await worker.fetch(new Request(`${LOCAL}/v1/items/${item.item.id}`, { headers: dev1Headers() }), env);
    assert.equal(got.status, 200);
  });

  it("404s share routes on the API host and API routes on the share host", async () => {
    const env = await testEnv();
    const shareOnApi = await worker.fetch(new Request("https://api.fifo.example/s/abc"), env);
    assert.equal(shareOnApi.status, 404);
    const apiOnShare = await worker.fetch(
      new Request("https://share.fifo.example/v1/health", { headers: dev1Headers() }),
      env,
    );
    assert.equal(apiOnShare.status, 404);
  });

  it("accepts a hashed fallback bearer", async () => {
    const env = await testEnv({ AUTH_REQUIRED: "true" });
    const res = await worker.fetch(
      new Request("https://worker.example.com/v1/health", {
        headers: { Authorization: "Bearer test-dispatcher-secret" },
      }),
      env,
    );
    assert.equal(res.status, 200);
  });
});

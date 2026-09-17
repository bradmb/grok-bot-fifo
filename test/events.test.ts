import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { deliverOutbox } from "../src/events.ts";
import { testEnv } from "./helpers.ts";

describe("deliverOutbox dispatcher webhook", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs application/json (not cloudevents+json) with Fifo headers and Authorization", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      const [input, init] = args;
      const headers = { ...(init?.headers as Record<string, string>) };
      calls.push({ url: String(input), headers, body: String(init?.body ?? "") });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const now = "2026-09-10T16:00:00.000Z";
    const env = await testEnv({
      WEBHOOK_DISPATCH_URL: "https://webhook.example/dispatcher",
      WEBHOOK_DISPATCH_AUTHORIZATION: "Bearer test-dispatcher-webhook",
    });
    await env.DB.prepare(
      `INSERT INTO webhook_outbox (
        id, event_id, event_type, payload_json, destination, status,
        attempts, next_attempt_at, last_error, created_at, delivered_at
      ) VALUES (?, ?, ?, ?, 'dispatcher', 'pending', 0, ?, NULL, ?, NULL)`,
    )
      .bind("evt-415", "evt-415", "item.enqueued", JSON.stringify({ item_id: "item-1" }), now, now)
      .run();

    const delivered = await deliverOutbox(env, 20, now);
    assert.equal(delivered, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://webhook.example/dispatcher");
    assert.equal(calls[0].headers["Content-Type"], "application/json");
    assert.notEqual(calls[0].headers["Content-Type"], "application/cloudevents+json");
    assert.equal(calls[0].headers["Fifo-Event-Id"], "evt-415");
    assert.equal(calls[0].headers["Fifo-Timestamp"], now);
    assert.match(calls[0].headers["Fifo-Signature"] ?? "", /^sha256=[0-9a-f]{64}$/);
    assert.equal(calls[0].headers.Authorization, "Bearer test-dispatcher-webhook");

    const envelope = JSON.parse(calls[0].body) as Record<string, unknown>;
    assert.equal(envelope.specversion, "1.0");
    assert.equal(envelope.id, "evt-415");
    assert.equal(envelope.source, "fifo-worker");
    assert.equal(envelope.type, "item.enqueued");
    assert.equal(envelope.datacontenttype, "application/json");
    assert.deepEqual(envelope.data, { item_id: "item-1" });

    const row = await env.DB.prepare("SELECT status FROM webhook_outbox WHERE id = ?")
      .bind("evt-415")
      .first<{ status: string }>();
    assert.equal(row?.status, "delivered");
  });
});

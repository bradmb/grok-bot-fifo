import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { maybeEmitEngHoursOpen, runScheduled } from "../src/cron.ts";
import { utcFromZoned } from "../src/stall.ts";
import { DISPATCHER_AGENT, ENG_QUEUE_KEY } from "../src/types.ts";
import worker from "../src/index.ts";
import { dispatcherHeaders, idem, LOCAL, testEnv } from "./helpers.ts";

const TZ = "America/Denver";

function atTz(year: number, month: number, day: number, hour: number, minute: number): Date {
  return utcFromZoned(year, month, day, hour, minute, 0, TZ);
}

async function openRows(env: Awaited<ReturnType<typeof testEnv>>) {
  const events = await env.DB.prepare(
    "SELECT id, event_type, payload_json FROM item_events WHERE event_type = 'eng.hours.open'",
  ).all<{ id: string; event_type: string; payload_json: string }>();
  const outbox = await env.DB.prepare(
    "SELECT event_type, destination, payload_json FROM webhook_outbox WHERE event_type = 'eng.hours.open'",
  ).all<{ event_type: string; destination: string; payload_json: string }>();
  return { events: events.results || [], outbox: outbox.results || [] };
}

describe("eng.hours.open (06:00 business-hours weekdays)", () => {
  it("emits once at 06:00 on a weekday to the dispatcher with claim-next hint", async () => {
    const env = await testEnv();
    const at = atTz(2026, 9, 11, 6, 0);
    const result = await runScheduled(env, at);
    assert.equal(result.engOpen, 1);
    const { events, outbox } = await openRows(env);
    assert.equal(events.length, 1);
    assert.equal(events[0].id, "eng.hours.open:2026-09-11");
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].destination, DISPATCHER_AGENT);
    assert.notEqual(outbox[0].destination, "operator");
    const payload = JSON.parse(outbox[0].payload_json) as Record<string, unknown>;
    assert.equal(payload.timezone, TZ);
    assert.equal(payload.opened_at, at.toISOString());
    assert.equal(payload.queue_key, ENG_QUEUE_KEY);
    assert.equal(payload.hours_date, "2026-09-11");
    assert.deepEqual(payload.hours, { start: "06:00", end: "17:00" });
    assert.match(String(payload.hint), /claim-next claimable queued heads when free seats exist/);
  });

  it("does not emit on a weekend at 06:00", async () => {
    const env = await testEnv();
    const saturday = await maybeEmitEngHoursOpen(env, atTz(2026, 9, 12, 6, 0));
    const sunday = await maybeEmitEngHoursOpen(env, atTz(2026, 9, 13, 6, 0));
    assert.equal(saturday, 0);
    assert.equal(sunday, 0);
    const { events, outbox } = await openRows(env);
    assert.equal(events.length, 0);
    assert.equal(outbox.length, 0);
  });

  it("does not emit a second time the same date", async () => {
    const env = await testEnv();
    const first = await maybeEmitEngHoursOpen(env, atTz(2026, 9, 11, 6, 0));
    const again = await maybeEmitEngHoursOpen(env, atTz(2026, 9, 11, 6, 4));
    assert.equal(first, 1);
    assert.equal(again, 0);
    const { events, outbox } = await openRows(env);
    assert.equal(events.length, 1);
    assert.equal(outbox.length, 1);
  });

  it("does not emit at 05:55 or 07:00 (or the old 08:00/09:00 window)", async () => {
    const env = await testEnv();
    assert.equal(await maybeEmitEngHoursOpen(env, atTz(2026, 9, 11, 5, 55)), 0);
    assert.equal(await maybeEmitEngHoursOpen(env, atTz(2026, 9, 11, 7, 0)), 0);
    assert.equal(await maybeEmitEngHoursOpen(env, atTz(2026, 9, 11, 8, 0)), 0);
    assert.equal(await maybeEmitEngHoursOpen(env, atTz(2026, 9, 11, 9, 0)), 0);
    const { events, outbox } = await openRows(env);
    assert.equal(events.length, 0);
    assert.equal(outbox.length, 0);
  });

  it("does not claim queued team:eng heads", async () => {
    const env = await testEnv();
    const res = await worker.fetch(
      new Request(`${LOCAL}/v1/items`, {
        method: "POST",
        headers: { ...dispatcherHeaders(), ...idem("eng-open-queued") },
        body: JSON.stringify({ team: "eng", title: "Overnight queued", source_ref: "eng-open-q" }),
      }),
      env,
    );
    assert.equal(res.status, 201);
    const created = (await res.json()) as { item: { id: string; state: string } };
    assert.equal(created.item.state, "queued");
    await runScheduled(env, atTz(2026, 9, 11, 6, 0));
    const row = await env.DB.prepare("SELECT state, assignee_agent_id FROM items WHERE id = ?")
      .bind(created.item.id)
      .first<{ state: string; assignee_agent_id: string | null }>();
    assert.equal(row?.state, "queued");
    assert.equal(row?.assignee_agent_id, null);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  destinationsFor,
  isFifoBusinessHoursOpen,
  isLaneHoldNoise,
  isWithinEngHours,
  type FifoEventType,
} from "../src/events.ts";
import { utcFromZoned } from "../src/stall.ts";
import type { ItemRow, QueueRow } from "../src/types.ts";
import { DISPATCHER_AGENT, ENG_QUEUE_KEY, OPERATOR_AGENT, PARKED_QUEUE_KEY } from "../src/types.ts";

const TZ = "America/Denver";

function atTz(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return utcFromZoned(year, month, day, hour, minute, 0, TZ);
}

function queue(key: string, kind: "team" | "personal" = "team"): QueueRow {
  return {
    id: "q1",
    queue_key: key,
    kind,
    owner_agent_id: kind === "personal" ? "dev1" : null,
    title: key,
    capacity: key === PARKED_QUEUE_KEY ? 0 : 6,
    share_generation: 1,
    created_at: "2026-09-10T00:00:00.000Z",
  };
}

function item(partial: Partial<ItemRow> = {}): ItemRow {
  return {
    id: "i1",
    queue_id: "q1",
    fifo_seq: 1,
    state: "queued",
    slot_id: null,
    assignee_agent_id: null,
    source_system: "",
    source_ref: "ref",
    requester_ref: "",
    title: "Normal work",
    body: "",
    team_scope: null,
    kind: "implement",
    enqueued_at: "2026-09-10T00:00:00.000Z",
    started_at: null,
    done_at: null,
    progress_at: null,
    next_stall_at: null,
    stall_generation: 0,
    hard_blocked_at: null,
    block_reason: null,
    created_at: "2026-09-10T00:00:00.000Z",
    updated_at: "2026-09-10T00:00:00.000Z",
    ...partial,
    cr_slot: partial.cr_slot ?? null,
    ca_ref: partial.ca_ref ?? null,
    factory_ref: partial.factory_ref ?? null,
  };
}

// 2026-09-11 is a Friday; 2026-09-12 Saturday; 2026-09-14 Monday; 2026-09-15 Tuesday.
const AT_IN_HOURS = atTz(2026, 9, 11, 10, 0);
const AT_TUE_10 = atTz(2026, 9, 15, 10, 0);
const AT_SAT_10 = atTz(2026, 9, 12, 10, 0);
const DARK_TIMES: Array<[string, Date]> = [
  ["Friday 17:00", atTz(2026, 9, 11, 17, 0)],
  ["Friday 23:00", atTz(2026, 9, 11, 23, 0)],
  ["Saturday 10:00", atTz(2026, 9, 12, 10, 0)],
];
const CLAIMABLE: Array<[FifoEventType, ItemRow["state"]]> = [
  ["item.enqueued", "queued"],
  ["item.assigned", "in_progress"],
  ["item.stalled", "in_progress"],
  ["item.hard_blocked", "in_progress"],
  ["item.hard_block_cleared", "in_progress"],
];

describe("destinationsFor dispatcher webhook suppress", () => {
  it("detects hold/park/stop title noise", () => {
    assert.equal(isLaneHoldNoise("HOLD vendor"), true);
    assert.equal(isLaneHoldNoise("PARKED: IR"), true);
    assert.equal(isLaneHoldNoise("STOP — wait"), true);
    assert.equal(isLaneHoldNoise("Look≠GO until the vendor confirms"), true);
    assert.equal(isLaneHoldNoise("Look!=GO"), true);
    assert.equal(isLaneHoldNoise("DO-NOT-TOUCH"), true);
    assert.equal(isLaneHoldNoise("Ship fifo update"), false);
  });

  it("wakes the dispatcher on eng.hours.open for team:eng (not parked, never the operator)", () => {
    const eng = queue(ENG_QUEUE_KEY);
    const parked = queue(PARKED_QUEUE_KEY);
    assert.deepEqual(destinationsFor("eng.hours.open", { queue: eng }), [DISPATCHER_AGENT]);
    assert.equal(destinationsFor("eng.hours.open", { queue: parked }).includes(DISPATCHER_AGENT), false);
    assert.ok(
      destinationsFor("eng.hours.open", { queue: eng, item: item({ title: "HOLD — wait Quinn" }) }).includes(
        DISPATCHER_AGENT,
      ),
    );
  });

  it("wakes the dispatcher on claimable eng enqueue/assign/stall/hard_block/done(agent) in hours", () => {
    const eng = queue(ENG_QUEUE_KEY);
    assert.ok(destinationsFor("item.enqueued", { queue: eng, item: item(), at: AT_IN_HOURS }).includes(DISPATCHER_AGENT));
    assert.ok(
      destinationsFor("item.assigned", { queue: eng, item: item({ state: "in_progress" }), at: AT_IN_HOURS }).includes(
        DISPATCHER_AGENT,
      ),
    );
    assert.ok(
      destinationsFor("item.stalled", { queue: eng, item: item({ state: "in_progress" }), at: AT_IN_HOURS }).includes(
        DISPATCHER_AGENT,
      ),
    );
    assert.ok(
      destinationsFor("item.hard_blocked", { queue: eng, item: item({ state: "in_progress" }), at: AT_IN_HOURS }).includes(
        DISPATCHER_AGENT,
      ),
    );
    assert.ok(
      destinationsFor("item.hard_block_cleared", { queue: eng, item: item({ state: "in_progress" }), at: AT_IN_HOURS }).includes(
        DISPATCHER_AGENT,
      ),
    );
    assert.ok(
      destinationsFor("item.done", {
        queue: eng,
        item: item({ state: "done", requester_ref: "runner" }),
        requesterRef: "runner",
      }).includes(DISPATCHER_AGENT),
    );
  });

  it("suppresses the dispatcher for move, capacity, update, parked, hold titles, operator-only done", () => {
    const eng = queue(ENG_QUEUE_KEY);
    const parked = queue(PARKED_QUEUE_KEY);
    assert.equal(destinationsFor("item.moved", { queue: eng, item: item() }).includes(DISPATCHER_AGENT), false);
    assert.equal(destinationsFor("item.reordered", { queue: eng, item: item() }).includes(DISPATCHER_AGENT), false);
    assert.equal(destinationsFor("capacity.available", { queue: eng, item: item() }).includes(DISPATCHER_AGENT), false);
    assert.equal(destinationsFor("capacity.changed", { queue: eng, item: item() }).includes(DISPATCHER_AGENT), false);
    assert.equal(destinationsFor("item.updated", { queue: eng, item: item() }).includes(DISPATCHER_AGENT), false);
    assert.equal(destinationsFor("item.enqueued", { queue: parked, item: item() }).includes(DISPATCHER_AGENT), false);
    assert.equal(
      destinationsFor("item.enqueued", { queue: eng, item: item({ title: "HOLD — wait Quinn" }) }).includes(DISPATCHER_AGENT),
      false,
    );
    assert.equal(
      destinationsFor("item.done", {
        queue: eng,
        item: item({ state: "done", requester_ref: OPERATOR_AGENT }),
        requesterRef: OPERATOR_AGENT,
      }).includes(DISPATCHER_AGENT),
      false,
    );
    assert.equal(
      destinationsFor("item.done", {
        queue: eng,
        item: item({ state: "done", requester_ref: "" }),
        requesterRef: "",
      }).includes(DISPATCHER_AGENT),
      false,
    );
  });

  it("does not fall back to the dispatcher when only non-dispatcher destinations apply", () => {
    const personal = queue("personal:dev1", "personal");
    const dests = destinationsFor("item.enqueued", {
      queue: personal,
      item: item(),
      ownerKey: "dev1",
      at: AT_IN_HOURS,
    });
    assert.deepEqual(dests.sort(), ["dev1"]);
  });

  it("skips the dispatcher for terminal-replay of assign/stall/hard_block", () => {
    const eng = queue(ENG_QUEUE_KEY);
    assert.equal(
      destinationsFor("item.assigned", { queue: eng, item: item({ state: "done" }) }).includes(DISPATCHER_AGENT),
      false,
    );
    assert.equal(
      destinationsFor("item.stalled", { queue: eng, item: item({ state: "cancelled" }) }).includes(DISPATCHER_AGENT),
      false,
    );
    assert.equal(
      destinationsFor("item.hard_block_cleared", { queue: eng, item: item({ state: "done" }) }).includes(DISPATCHER_AGENT),
      false,
    );
  });
});

describe("isFifoBusinessHoursOpen (weekdays 06:00–17:00 in the configured timezone)", () => {
  it("opens at 06:00 and closes at 17:00 on a weekday", () => {
    assert.equal(isFifoBusinessHoursOpen(atTz(2026, 9, 11, 5, 59)), false);
    assert.equal(isFifoBusinessHoursOpen(atTz(2026, 9, 11, 6, 0)), true);
    assert.equal(isFifoBusinessHoursOpen(atTz(2026, 9, 11, 10, 0)), true);
    assert.equal(isFifoBusinessHoursOpen(atTz(2026, 9, 11, 16, 59)), true);
    assert.equal(isFifoBusinessHoursOpen(atTz(2026, 9, 11, 17, 0)), false);
    assert.equal(isFifoBusinessHoursOpen(atTz(2026, 9, 11, 23, 59)), false);
    assert.equal(isWithinEngHours(atTz(2026, 9, 11, 10, 0)), true);
  });

  it("is dark all day on weekends", () => {
    assert.equal(isFifoBusinessHoursOpen(atTz(2026, 9, 12, 6, 0)), false); // Saturday
    assert.equal(isFifoBusinessHoursOpen(atTz(2026, 9, 12, 10, 0)), false);
    assert.equal(isFifoBusinessHoursOpen(atTz(2026, 9, 13, 12, 0)), false); // Sunday
  });

  it("honours the timeZone override", () => {
    const at = atTz(2026, 9, 11, 16, 0); // 16:00 Friday in TZ — open
    assert.equal(isFifoBusinessHoursOpen(at), true);
    assert.equal(isFifoBusinessHoursOpen(at, "UTC"), false); // 22:00 Friday UTC — closed
  });
});

describe("after-hours dispatcher quiet", () => {
  it("suppresses the dispatcher for claimable eng events outside the window", () => {
    const eng = queue(ENG_QUEUE_KEY);
    for (const [label, at] of DARK_TIMES) {
      for (const [eventType, state] of CLAIMABLE) {
        const dests = destinationsFor(eventType, { queue: eng, item: item({ state }), at });
        assert.deepEqual(dests, [], `${eventType} at ${label} must not wake the dispatcher`);
      }
    }
  });

  it("wakes the dispatcher at the window edges on a Friday", () => {
    const eng = queue(ENG_QUEUE_KEY);
    assert.equal(
      destinationsFor("item.enqueued", { queue: eng, item: item(), at: atTz(2026, 9, 11, 5, 59) }).includes(
        DISPATCHER_AGENT,
      ),
      false,
    );
    assert.ok(
      destinationsFor("item.enqueued", { queue: eng, item: item(), at: atTz(2026, 9, 11, 6, 0) }).includes(
        DISPATCHER_AGENT,
      ),
    );
    assert.ok(
      destinationsFor("item.enqueued", { queue: eng, item: item(), at: atTz(2026, 9, 11, 16, 59) }).includes(
        DISPATCHER_AGENT,
      ),
    );
    assert.equal(
      destinationsFor("item.enqueued", { queue: eng, item: item(), at: atTz(2026, 9, 11, 17, 0) }).includes(
        DISPATCHER_AGENT,
      ),
      false,
    );
  });

  it("keeps eng.hours.open exempt from the window (Monday-morning drain)", () => {
    const eng = queue(ENG_QUEUE_KEY);
    for (const [label, at] of DARK_TIMES) {
      assert.deepEqual(destinationsFor("eng.hours.open", { queue: eng, at }), [DISPATCHER_AGENT], label);
    }
  });

  it("keeps item.done dispatcher wakes outside the window (only claimable events are gated)", () => {
    const eng = queue(ENG_QUEUE_KEY);
    const dests = destinationsFor("item.done", {
      queue: eng,
      item: item({ state: "done", requester_ref: "runner" }),
      requesterRef: "runner",
      at: atTz(2026, 9, 12, 10, 0),
    });
    assert.ok(dests.includes(DISPATCHER_AGENT));
  });

  it("does not wake personal owners or the dispatcher outside the window", () => {
    const personal = queue("personal:dev1", "personal");
    const enqueued = destinationsFor("item.enqueued", {
      queue: personal,
      item: item(),
      ownerKey: "dev1",
      at: AT_SAT_10,
    });
    assert.deepEqual(enqueued, []);
    const stalled = destinationsFor("item.stalled", {
      queue: personal,
      item: item({ state: "in_progress" }),
      ownerKey: "dev1",
      at: AT_SAT_10,
    });
    assert.deepEqual(stalled, []);
  });
});

describe("after-hours personal queue dark", () => {
  it("personal enqueue on a weekend does not wake the owner or the dispatcher", () => {
    const personal = queue("personal:dev1", "personal");
    const dests = destinationsFor("item.enqueued", {
      queue: personal,
      item: item(),
      ownerKey: "dev1",
      at: AT_SAT_10,
    });
    assert.deepEqual(dests, []);
  });

  it("personal stall on a weekend does not wake the dispatcher or the owner", () => {
    const personal = queue("personal:dev1", "personal");
    const dests = destinationsFor("item.stalled", {
      queue: personal,
      item: item({ state: "in_progress" }),
      ownerKey: "dev1",
      at: AT_SAT_10,
    });
    assert.deepEqual(dests, []);
  });

  it("personal assigned on a weekend does not wake the owner", () => {
    const personal = queue("personal:dev1", "personal");
    const dests = destinationsFor("item.assigned", {
      queue: personal,
      item: item({ state: "in_progress" }),
      ownerKey: "dev1",
      at: AT_SAT_10,
    });
    assert.deepEqual(dests, []);
  });

  it("personal enqueue/assigned/stall stay dark at every dark time", () => {
    const personal = queue("personal:dev1", "personal");
    const wakes: Array<[FifoEventType, ItemRow["state"]]> = [
      ["item.enqueued", "queued"],
      ["item.assigned", "in_progress"],
      ["item.stalled", "in_progress"],
    ];
    for (const [label, at] of DARK_TIMES) {
      for (const [eventType, state] of wakes) {
        const dests = destinationsFor(eventType, {
          queue: personal,
          item: item({ state }),
          ownerKey: "dev1",
          at,
        });
        assert.deepEqual(dests, [], `personal ${eventType} at ${label} must not wake owner or dispatcher`);
      }
    }
  });

  it("personal enqueue Tuesday 10:00 in TZ wakes the owner (not the dispatcher)", () => {
    const personal = queue("personal:dev1", "personal");
    const dests = destinationsFor("item.enqueued", {
      queue: personal,
      item: item(),
      ownerKey: "dev1",
      at: AT_TUE_10,
    });
    assert.deepEqual(dests.sort(), ["dev1"]);
    assert.equal(dests.includes(DISPATCHER_AGENT), false);
  });

  it("personal stall in hours still wakes the dispatcher and the owner", () => {
    const personal = queue("personal:dev1", "personal");
    const dests = destinationsFor("item.stalled", {
      queue: personal,
      item: item({ state: "in_progress" }),
      ownerKey: "dev1",
      at: AT_TUE_10,
    });
    assert.ok(dests.includes(DISPATCHER_AGENT));
    assert.ok(dests.includes("dev1"));
  });

  it("keeps eng after-hours claimable events dark (unchanged)", () => {
    const eng = queue(ENG_QUEUE_KEY);
    for (const [label, at] of DARK_TIMES) {
      for (const [eventType, state] of CLAIMABLE) {
        const dests = destinationsFor(eventType, { queue: eng, item: item({ state }), at });
        assert.deepEqual(dests, [], `eng ${eventType} at ${label} must stay dark`);
      }
    }
    assert.ok(
      destinationsFor("item.enqueued", { queue: eng, item: item(), at: AT_TUE_10 }).includes(DISPATCHER_AGENT),
    );
  });
});

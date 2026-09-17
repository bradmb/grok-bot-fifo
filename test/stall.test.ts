import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addBusinessMinutes, DEFAULT_STALL, nextStallAt } from "../src/stall.ts";

describe("business-minute stall clock (08:00–17:00 in the configured timezone)", () => {
  it("adds 60 minutes inside the window", () => {
    const tenAm = "2026-09-10T16:00:00.000Z";
    const next = addBusinessMinutes(tenAm, 60, DEFAULT_STALL);
    assert.equal(next, "2026-09-10T17:00:00.000Z");
  });

  it("wraps past 17:00 into the next morning", () => {
    const fourThirtyPm = "2026-09-10T22:30:00.000Z";
    const next = nextStallAt(fourThirtyPm, DEFAULT_STALL);
    assert.equal(next, "2026-09-11T14:30:00.000Z");
  });

  it("skips overnight gap when starting after close", () => {
    const afterClose = "2026-09-10T23:30:00.000Z";
    const next = addBusinessMinutes(afterClose, 30, DEFAULT_STALL);
    assert.equal(next, "2026-09-11T14:30:00.000Z");
  });
});

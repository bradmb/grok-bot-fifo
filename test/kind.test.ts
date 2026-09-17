import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crSlotId, executionTarget, factoryExecution, isCodeReviewItem, isLegacyCodeReviewRef, parseWorkKind, sortQueued } from "../src/kind.ts";
import { ApiError } from "../src/types.ts";

describe("work kind / legacy CR routing", () => {
  it("defaults to implement", () => {
    assert.equal(parseWorkKind(undefined), "implement");
    assert.equal(parseWorkKind(""), "implement");
  });

  it("accepts code_review | implement | ops", () => {
    assert.equal(parseWorkKind("code_review"), "code_review");
    assert.equal(parseWorkKind("implement"), "implement");
    assert.equal(parseWorkKind("ops"), "ops");
  });

  it("rejects unknown kinds", () => {
    assert.throws(() => parseWorkKind("factory"), (err: unknown) => err instanceof ApiError && err.code === "INVALID_KIND");
  });

  it("treats *-cr-rN source_ref as code_review even without kind", () => {
    assert.equal(isLegacyCodeReviewRef("TKT-16426-cr-r2"), true);
    assert.equal(isLegacyCodeReviewRef("TKT-16426"), false);
    assert.equal(parseWorkKind(undefined, "TKT-16426-cr-r2"), "code_review");
    assert.equal(parseWorkKind("implement", "TKT-1-cr-r1"), "code_review");
    assert.equal(isCodeReviewItem({ kind: "implement", source_ref: "TKT-16426-cr-r2" }), true);
    assert.equal(isCodeReviewItem({ kind: "code_review", source_ref: "other" }), true);
    assert.equal(isCodeReviewItem({ kind: "implement", source_ref: "TKT-16426" }), false);
  });

  it("treats title containing CR cycle as code_review", () => {
    assert.equal(parseWorkKind(undefined, "TKT-16426", "Eng CR cycle r2"), "code_review");
    assert.equal(isCodeReviewItem({ kind: "implement", source_ref: "plain", title: "CR cycle" }), true);
    assert.equal(isCodeReviewItem({ kind: "implement", source_ref: "plain", title: "Ship feature" }), false);
  });

  it("does not use freeform title tags for CR priority", () => {
    assert.equal(parseWorkKind(undefined, "TKT-16426", "needs a code review"), "implement");
    assert.equal(isCodeReviewItem({ kind: "implement", source_ref: "plain", title: "code review please" }), false);
    assert.equal(isCodeReviewItem({ kind: "ops", source_ref: "plain", title: "urgent" }), false);
  });

  it("sorts queued by fifo_seq only (CR is not ahead of implement)", () => {
    const ordered = sortQueued([
      { id: "impl-old", kind: "implement", source_ref: "a", title: "A", fifo_seq: 1 },
      { id: "cr-new", kind: "code_review", source_ref: "c", title: "CR new", fifo_seq: 3 },
      { id: "impl-new", kind: "ops", source_ref: "b", title: "B", fifo_seq: 2 },
      { id: "cr-old", kind: "code_review", source_ref: "d", title: "CR old", fifo_seq: 4 },
    ]);
    assert.deepEqual(
      ordered.map((r) => r.id),
      ["impl-old", "impl-new", "cr-new", "cr-old"],
    );
  });

  it("CR execution is Cursor cloud VM; Factory implement is e2b", () => {
    assert.deepEqual(executionTarget({ kind: "code_review", state: "queued" }), {
      runtime: "cursor_cloud_agent",
      host: "cursor_cloud_vm",
    });
    assert.deepEqual(executionTarget({ kind: "implement", source_ref: "TKT-1-cr-r1", state: "queued" }), {
      runtime: "cursor_cloud_agent",
      host: "cursor_cloud_vm",
    });
    assert.deepEqual(executionTarget({ kind: "implement", state: "in_progress" }), {
      runtime: "factory",
      host: "e2b",
    });
    assert.deepEqual(executionTarget({ kind: "implement", source_ref: "TKT-99999", state: "in_progress" }), {
      runtime: "factory",
      host: "e2b",
    });
    assert.deepEqual(executionTarget({ kind: "ops", state: "in_progress" }), {
      runtime: "factory",
      host: "e2b",
    });
    assert.deepEqual(executionTarget({ kind: "implement", state: "queued" }), { runtime: null, host: null });
  });

  it("Factory execution host is e2b for every implement/ops item", () => {
    assert.deepEqual(factoryExecution({ source_ref: "eng-42" }), { runtime: "factory", host: "e2b" });
    assert.deepEqual(factoryExecution({}), { runtime: "factory", host: "e2b" });
    assert.deepEqual(factoryExecution({ source_ref: "TKT-99999" }), { runtime: "factory", host: "e2b" });
  });

  it("cr_slot is eng:<ic>:cr and is not the Factory slot", () => {
    assert.equal(crSlotId("ic1"), "eng:ic1:cr");
    assert.notEqual(crSlotId("ic1"), "eng:ic1");
  });
});

import { ApiError } from "./types";

export const WORK_KINDS = ["code_review", "implement", "ops"] as const;
export type WorkKind = (typeof WORK_KINDS)[number];
export const DEFAULT_WORK_KIND: WorkKind = "implement";

/** Legacy code-review-cycle source_ref, e.g. TKT-16426-cr-r2 */
const LEGACY_CR_REF = /[A-Za-z0-9]+-\d+-cr-r\d+/i;
/** Legacy CR cycle title marker. */
const LEGACY_CR_TITLE = /CR cycle/i;

export function isLegacyCodeReviewRef(sourceRef?: string | null): boolean {
  return LEGACY_CR_REF.test(sourceRef || "");
}

export function isLegacyCodeReviewTitle(title?: string | null): boolean {
  return LEGACY_CR_TITLE.test(title || "");
}

export function isWorkKind(value: string): value is WorkKind {
  return (WORK_KINDS as readonly string[]).includes(value);
}

export type KindFields = { kind?: string | null; source_ref?: string | null; title?: string | null };

/**
 * CR routing uses the `kind` enum (not freeform tags). Near-term backfill:
 * legacy *-cr-rN source_ref or a title containing "CR cycle".
 */
export function isCodeReviewItem(item: KindFields): boolean {
  return item.kind === "code_review" || isLegacyCodeReviewRef(item.source_ref) || isLegacyCodeReviewTitle(item.title);
}

export function parseWorkKind(raw: string | undefined, sourceRef?: string | null, title?: string | null): WorkKind {
  const v = (raw || "").trim().toLowerCase();
  if (/^team/.test(v)) {
    return isLegacyCodeReviewRef(sourceRef) || isLegacyCodeReviewTitle(title) ? "code_review" : DEFAULT_WORK_KIND;
  }
  if (v && !isWorkKind(v)) {
    throw new ApiError(400, "INVALID_KIND", "kind must be code_review, implement, or ops");
  }
  if (isLegacyCodeReviewRef(sourceRef) || isLegacyCodeReviewTitle(title)) {
    return "code_review";
  }
  return v && isWorkKind(v) ? v : DEFAULT_WORK_KIND;
}

/** Queued order is fifo_seq only. CR is not sorted ahead of implement. */
export function compareQueued<T extends { fifo_seq: number }>(a: T, b: T): number {
  return a.fifo_seq - b.fifo_seq;
}

export function sortQueued<T extends { fifo_seq: number }>(items: T[]): T[] {
  return [...items].sort(compareQueued);
}

export function laneOf(state: string): "queued" | "in_progress" | "code_review" | "done" | "cancelled" {
  if (state === "in_progress" || state === "code_review" || state === "queued" || state === "done" || state === "cancelled") {
    return state;
  }
  return "queued";
}

/** CR lane execution: Cursor cloud VMs only. */
export const CR_RUNTIME = "cursor_cloud_agent" as const;
export const CR_HOST = "cursor_cloud_vm" as const;
/** Factory implement In Progress only. */
export const FACTORY_RUNTIME = "factory" as const;
/** Factory sandbox host for implement/ops. */
export const FACTORY_HOST_DEFAULT = "e2b" as const;

export type ExecutionHost = typeof CR_HOST | typeof FACTORY_HOST_DEFAULT;

export type ExecutionTarget = {
  runtime: typeof CR_RUNTIME | typeof FACTORY_RUNTIME | null;
  host: ExecutionHost | null;
};

/** Factory implement IP execution target — sandbox host. */
export function factoryExecution(_item: { source_ref?: string | null } = {}): ExecutionTarget {
  return { runtime: FACTORY_RUNTIME, host: FACTORY_HOST_DEFAULT };
}

/**
 * CR items always target a Cursor cloud VM. Factory (e2b) is implement In
 * Progress only — never returned for code_review.
 */
export function executionTarget(item: KindFields & { state?: string | null }): ExecutionTarget {
  if (isCodeReviewItem(item) || item.state === "code_review") {
    return { runtime: CR_RUNTIME, host: CR_HOST };
  }
  if (item.state === "in_progress") {
    return factoryExecution(item);
  }
  return { runtime: null, host: null };
}

export const CR_EXECUTION = { runtime: CR_RUNTIME, host: CR_HOST } as const;

/** Parallel CR seat id. Distinct from Factory `queue_slots.id` (`eng:<ic>`). */
export function crSlotId(agentId: string): string {
  return `eng:${(agentId || "").trim().toLowerCase()}:cr`;
}

import { canCancel, canClaim, canEnqueue, canMove, canMutateItem, canShareAdmin, canSync, hasPerm } from "./auth";
import {
  agentNameMap,
  countWip,
  crHeldBy,
  findBySource,
  getAgent,
  getItem,
  getQueue,
  getSlotForAgent,
  isUniqueError,
  listItemsByState,
  listSlots,
  nextFifoSeq,
  oldestQueued,
  publicComments,
} from "./db";
import {
  CR_EXECUTION,
  CR_HOST,
  crSlotId,
  executionTarget,
  FACTORY_HOST_DEFAULT,
  factoryExecution,
  isCodeReviewItem,
  parseWorkKind,
  sortQueued,
  type WorkKind,
} from "./kind";
import { auditStatement, deliverOutbox, destinationsFor, eventId, outboxStatements, type FifoEventType } from "./events";
import { newId, nowIso, personalQueueKey, randomToken, sha256Hex, tokenPrefix } from "./http";
import { nextStallAt, stallConfigFromEnv } from "./stall";
import type { Actor, Env, ItemRow, QueueRow, ShareTokenRow, SlotRow } from "./types";
import {
  ApiError,
  DISPATCHER_PERSONAL_QUEUE_KEY,
  ENG_QUEUE_KEY,
  PARKED_QUEUE_KEY,
  PLATE_FULL_PREFIX,
  isMovableTeamQueue,
} from "./types";

export type EnqueueInput = {
  queueKey?: string;
  personal?: string;
  team?: string;
  title: string;
  body?: string;
  sourceSystem?: string;
  sourceRef?: string;
  requesterRef?: string;
  teamScope?: string;
  kind?: string;
  workKind?: string;
};

export type ItemView = {
  id: string;
  queue_key: string;
  fifo_seq: number;
  state: string;
  slot_id: string | null;
  assignee: string | null;
  assignee_name: string | null;
  source_system: string;
  source_ref: string;
  requester_ref: string;
  title: string;
  body: string;
  position: number;
  hard_blocked: boolean;
  block_reason: string | null;
  kind: string;
  code_review: boolean;
  runtime: "cursor_cloud_agent" | "factory" | null;
  host: "e2b" | "cursor_cloud_vm" | null;
  cr_slot: string | null;
  ca_ref: string | null;
  factory_ref: string | null;
  enqueued_at: string;
  started_at: string | null;
  done_at: string | null;
  next_stall_at: string | null;
  stall_generation: number;
};

function resolveQueueKey(input: EnqueueInput): string {
  if (input.queueKey) {
    return input.queueKey;
  }
  if (input.personal) {
    return personalQueueKey(input.personal);
  }
  if (input.team) {
    return `team:${input.team.trim().toLowerCase()}`;
  }
  throw new ApiError(400, "QUEUE_REQUIRED", "Provide queue_key, personal, or team");
}

function teamWorkOnPersonal(queue: QueueRow, input: EnqueueInput): boolean {
  if (queue.kind !== "personal") {
    return false;
  }
  const scope = (input.teamScope || input.team || "").toLowerCase();
  if (
    scope === "eng" ||
    scope === "parked" ||
    scope === "team" ||
    scope === "team:eng" ||
    scope === "team:parked"
  ) {
    return true;
  }
  if (input.kind && /^team/.test(input.kind)) {
    return true;
  }
  return false;
}

async function itemView(env: Env, item: ItemRow, queue: QueueRow): Promise<ItemView> {
  const names = await agentNameMap(env);
  const kind = (item.kind || "implement") as WorkKind;
  const codeReview = isCodeReviewItem({ kind, source_ref: item.source_ref, title: item.title });
  const exec = executionTarget({ kind, source_ref: item.source_ref, title: item.title, state: item.state });
  let position: number;
  if (item.state === "queued") {
    const queued = await listItemsByState(env, item.queue_id, ["queued"]);
    const ordered = sortQueued(queued);
    const idx = ordered.findIndex((row) => row.id === item.id);
    position = (idx < 0 ? Number(queued.length) : idx) + 1;
  } else {
    const ahead = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM items
       WHERE queue_id = ? AND state IN ('queued', 'in_progress', 'code_review') AND fifo_seq < ?`,
    )
      .bind(item.queue_id, item.fifo_seq)
      .first<{ n: number }>();
    position = Number(ahead?.n || 0) + 1;
  }
  return {
    id: item.id,
    queue_key: queue.queue_key,
    fifo_seq: item.fifo_seq,
    state: item.state,
    slot_id: item.slot_id,
    assignee: item.assignee_agent_id,
    assignee_name: item.assignee_agent_id ? names.get(item.assignee_agent_id) || item.assignee_agent_id : null,
    source_system: item.source_system,
    source_ref: item.source_ref,
    requester_ref: item.requester_ref,
    title: item.title,
    body: item.body,
    kind,
    code_review: codeReview,
    runtime: exec.runtime,
    host: exec.host,
    cr_slot: item.state === "code_review" ? item.cr_slot || (item.assignee_agent_id ? crSlotId(item.assignee_agent_id) : null) : null,
    ca_ref: item.ca_ref || null,
    factory_ref: item.factory_ref || null,
    position,
    hard_blocked: Boolean(item.hard_blocked_at),
    block_reason: item.block_reason,
    enqueued_at: item.enqueued_at,
    started_at: item.started_at,
    done_at: item.done_at,
    next_stall_at: item.next_stall_at,
    stall_generation: item.stall_generation,
  };
}

async function requireQueue(env: Env, queueKey: string): Promise<QueueRow> {
  const queue = await getQueue(env, queueKey);
  if (!queue) {
    throw new ApiError(404, "QUEUE_NOT_FOUND", `Unknown queue ${queueKey}`);
  }
  return queue;
}

async function requireItem(env: Env, id: string): Promise<{ item: ItemRow; queue: QueueRow }> {
  const item = await getItem(env, id);
  if (!item) {
    throw new ApiError(404, "ITEM_NOT_FOUND", "Item not found");
  }
  const queue = await env.DB.prepare("SELECT * FROM queues WHERE id = ?").bind(item.queue_id).first<QueueRow>();
  if (!queue) {
    throw new ApiError(404, "QUEUE_NOT_FOUND", "Queue missing for item");
  }
  return { item, queue };
}

async function ownerKey(env: Env, queue: QueueRow): Promise<string | null> {
  if (!queue.owner_agent_id) {
    return null;
  }
  const agent = await getAgent(env, queue.owner_agent_id);
  return agent?.key ?? queue.owner_agent_id;
}

function engCapacity(env: Env): number {
  const n = Number(env.ENG_CAPACITY || "6");
  return Number.isFinite(n) && n > 0 ? n : 6;
}

export async function enqueue(
  env: Env,
  actor: Actor,
  input: EnqueueInput,
  origin: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const queueKey = resolveQueueKey(input);
  const queue = await requireQueue(env, queueKey);
  if (!canEnqueue(actor, queue.kind, queue.owner_agent_id, queue.queue_key)) {
    throw new ApiError(403, "FORBIDDEN", "Cannot enqueue on this queue");
  }
  if (teamWorkOnPersonal(queue, input)) {
    throw new ApiError(422, "TEAM_QUEUE_REQUIRED", "Team-scoped work must use team:eng or team:parked");
  }
  if (queue.kind === "team" && !isMovableTeamQueue(queue.queue_key)) {
    throw new ApiError(422, "TEAM_QUEUE_REQUIRED", "Unknown team queue; use team:eng or team:parked");
  }
  const workKind = parseWorkKind(input.workKind || input.kind, input.sourceRef, input.title);
  if (workKind === "code_review" && queue.kind === "personal") {
    throw new ApiError(422, "TEAM_QUEUE_REQUIRED", "Code Review work must use team:eng or team:parked");
  }

  const title = input.title.trim();
  if (!title) {
    throw new ApiError(400, "TITLE_REQUIRED", "title is required");
  }
  const sourceSystem = input.sourceSystem || "";
  const sourceRef = input.sourceRef || "";
  if (sourceRef) {
    const existing = await findBySource(env, sourceSystem, sourceRef);
    if (existing) {
      const view = await itemView(env, existing, queue);
      const shareUrl = await liveShareUrl(env, queue, origin);
      return {
        status: 200,
        body: {
          item: view,
          idempotent: true,
          plate_full: existing.state === "queued" && queue.kind === "personal",
          share_url: shareUrl,
          reply_text: existing.state === "queued" && queue.kind === "personal" ? `${PLATE_FULL_PREFIX}${shareUrl}` : null,
        },
      };
    }
  }

  const now = nowIso();
  const id = newId();
  const seq = await nextFifoSeq(env, queue.id);
  const assignee = queue.kind === "personal" ? queue.owner_agent_id : null;
  try {
    await env.DB.prepare(
      `INSERT INTO items (
        id, queue_id, fifo_seq, state, slot_id, assignee_agent_id,
        source_system, source_ref, requester_ref, title, body, team_scope, kind,
        enqueued_at, started_at, done_at, progress_at, next_stall_at, stall_generation,
        hard_blocked_at, block_reason, created_at, updated_at
      ) VALUES (?, ?, ?, 'queued', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, NULL, NULL, ?, ?)`,
    )
      .bind(
        id,
        queue.id,
        seq,
        assignee,
        sourceSystem,
        sourceRef,
        input.requesterRef || "",
        title,
        input.body || "",
        input.teamScope || null,
        workKind,
        now,
        now,
        now,
      )
      .run();
  } catch (error) {
    if (isUniqueError(error) && sourceRef) {
      const existing = await findBySource(env, sourceSystem, sourceRef);
      if (existing) {
        const view = await itemView(env, existing, queue);
        return { status: 200, body: { item: view, idempotent: true } };
      }
    }
    throw error;
  }

  if (queue.kind === "personal") {
    await tryPromotePersonal(env, queue, actor, now);
  }

  const item = await getItem(env, id);
  if (!item) {
    throw new ApiError(500, "ENQUEUE_FAILED", "Enqueue did not persist");
  }

  const owner = await ownerKey(env, queue);
  await emit(env, actor, {
    eventType: "item.enqueued",
    item,
    queue,
    ownerKey: owner,
    createdAt: now,
  });

  const view = await itemView(env, item, queue);
  const shareUrl = await liveShareUrl(env, queue, origin, item.id);
  const plateFull = queue.kind === "personal" && item.state === "queued";
  return {
    status: 201,
    body: {
      item: view,
      position: view.position,
      plate_full: plateFull,
      share_url: shareUrl,
      reply_text: plateFull ? `${PLATE_FULL_PREFIX}${shareUrl}` : null,
    },
  };
}

async function liveShareUrl(env: Env, queue: QueueRow, origin: string, focusItemId?: string): Promise<string> {
  const token = randomToken();
  const hash = await sha256Hex(token);
  await env.DB.prepare(
    `INSERT INTO share_tokens (id, queue_id, token_hash, token_prefix, generation, focus_item_id, revoked_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
  )
    .bind(newId(), queue.id, hash, tokenPrefix(token), queue.share_generation, focusItemId ?? null, nowIso())
    .run();
  return `${origin}/s/${token}`;
}

async function tryPromotePersonal(env: Env, queue: QueueRow, actor: Actor, now: string): Promise<ItemRow | null> {
  const wip = await countWip(env, queue.id);
  if (wip >= 1) {
    return null;
  }
  const next = await oldestQueued(env, queue.id);
  if (!next) {
    return null;
  }
  const cfg = stallConfigFromEnv(env);
  const stallAt = nextStallAt(now, cfg);
  try {
    const result = await env.DB.prepare(
      `UPDATE items SET
        state = 'in_progress',
        started_at = COALESCE(started_at, ?),
        progress_at = ?,
        next_stall_at = ?,
        stall_generation = CASE WHEN stall_generation = 0 THEN 1 ELSE stall_generation END,
        assignee_agent_id = ?,
        updated_at = ?
       WHERE id = ? AND state = 'queued'
         AND NOT EXISTS (SELECT 1 FROM items WHERE queue_id = ? AND state = 'in_progress')`,
    )
      .bind(now, now, stallAt, queue.owner_agent_id, now, next.id, queue.id)
      .run();
    if (!result.meta?.changes) {
      return null;
    }
  } catch (error) {
    if (isUniqueError(error)) {
      return null;
    }
    throw error;
  }
  const promoted = await getItem(env, next.id);
  if (promoted) {
    await emit(env, actor, {
      eventType: "item.assigned",
      item: promoted,
      queue,
      ownerKey: await ownerKey(env, queue),
      createdAt: now,
    });
  }
  return promoted;
}

async function assignToCodeReview(
  env: Env,
  actor: Actor,
  queue: QueueRow,
  agentId: string,
  itemId: string,
): Promise<Record<string, unknown>> {
  const now = nowIso();
  const seat = crSlotId(agentId);
  try {
    const result = await env.DB.prepare(
      `UPDATE items SET
        state = 'code_review',
        slot_id = NULL,
        cr_slot = ?,
        assignee_agent_id = ?,
        started_at = ?,
        progress_at = ?,
        next_stall_at = NULL,
        stall_generation = 0,
        kind = 'code_review',
        updated_at = ?
       WHERE id = ? AND state = 'queued'`,
    )
      .bind(seat, agentId, now, now, now, itemId)
      .run();
    if (Number(result.meta?.changes) !== 1) {
      throw new ApiError(409, "CLAIM_RACE", "Code Review item was claimed by another request");
    }
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    if (isUniqueError(error)) {
      throw new ApiError(409, "CR_SEAT_HELD", "Concurrent claim lost the Code Review seat");
    }
    throw error;
  }
  const item = await getItem(env, itemId);
  if (!item || item.state !== "code_review" || item.assignee_agent_id !== agentId) {
    throw new ApiError(409, "CLAIM_RACE", "Code Review item was claimed by another request");
  }
  await emit(env, actor, {
    eventType: "item.assigned",
    item,
    queue,
    createdAt: now,
    extra: {
      lane: "code_review",
      kind: "code_review",
      ...CR_EXECUTION,
      auto_code_review: true,
      seat: "code_review",
      cr_slot: seat,
    },
  });
  return { item: await itemView(env, item, queue) };
}

export async function claimNext(
  env: Env,
  actor: Actor,
  queueKey: string,
  assigneeKey: string | undefined,
): Promise<Record<string, unknown>> {
  const queue = await requireQueue(env, queueKey);
  if (queue.queue_key === PARKED_QUEUE_KEY) {
    throw new ApiError(
      400,
      "PARKED_NOT_CLAIMABLE",
      "team:parked is a hold lane with no IC slots; claim-next is Eng team only",
    );
  }
  if (queue.queue_key !== ENG_QUEUE_KEY) {
    throw new ApiError(400, "NOT_TEAM_QUEUE", "claim-next is Eng team only");
  }
  if (!canClaim(actor)) {
    throw new ApiError(403, "FORBIDDEN", "claim-next is dispatcher-only");
  }
  if (!assigneeKey || !assigneeKey.trim()) {
    throw new ApiError(400, "ASSIGNEE_REQUIRED", "claim-next requires an assignee (dispatcher claims on behalf of an IC)");
  }
  const agent = await getAgent(env, assigneeKey.trim().toLowerCase());
  if (!agent) {
    throw new ApiError(400, "UNKNOWN_ASSIGNEE", `Unknown assignee ${assigneeKey}`);
  }
  const slot = await getSlotForAgent(env, queue.id, agent.id);
  if (!slot) {
    throw new ApiError(400, "NO_SLOT", "Assignee has no Eng slot");
  }
  if (slot.status !== "enabled") {
    throw new ApiError(409, "SLOT_UNAVAILABLE", `Slot ${slot.label} is ${slot.status}`);
  }
  const queued = sortQueued(await listItemsByState(env, queue.id, ["queued"]));
  const nextImpl = queued.find((row) => !isCodeReviewItem(row));

  // claim-next is Factory implement/ops only. Code Review is claim-cr (parallel seat).
  const occ = await env.DB.prepare(
    "SELECT id FROM items WHERE slot_id = ? AND state = 'in_progress'",
  )
    .bind(slot.id)
    .first<{ id: string }>();
  if (occ) {
    throw new ApiError(409, "NO_CAPACITY", "Assignee slot is occupied (hard-block keeps the slot)");
  }
  const wip = await countWip(env, queue.id);
  if (wip >= engCapacity(env)) {
    throw new ApiError(409, "NO_CAPACITY", `Eng FIFO is at capacity ${engCapacity(env)}`);
  }
  if (!nextImpl) {
    if (queued.length === 0) {
      throw new ApiError(404, "QUEUE_EMPTY", "No queued Eng work");
    }
    throw new ApiError(404, "NO_IMPLEMENT_QUEUED", "No queued implement/ops Eng work");
  }
  const now = nowIso();
  const stallAt = nextStallAt(now, stallConfigFromEnv(env));
  try {
    const result = await env.DB.prepare(
      `UPDATE items SET
        state = 'in_progress',
        slot_id = ?,
        assignee_agent_id = ?,
        started_at = ?,
        progress_at = ?,
        next_stall_at = ?,
        stall_generation = 1,
        updated_at = ?
       WHERE id = ? AND state = 'queued'`,
    )
      .bind(slot.id, agent.id, now, now, stallAt, now, nextImpl.id)
      .run();
    if (Number(result.meta?.changes) !== 1) {
      throw new ApiError(409, "CLAIM_RACE", "Oldest item was claimed by another request");
    }
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    if (isUniqueError(error)) {
      throw new ApiError(409, "NO_CAPACITY", "Concurrent claim lost the slot");
    }
    throw error;
  }
  const item = await getItem(env, nextImpl.id);
  if (!item || item.state !== "in_progress" || item.assignee_agent_id !== agent.id) {
    throw new ApiError(409, "CLAIM_RACE", "Oldest item was claimed by another request");
  }
  await emit(env, actor, {
    eventType: "item.assigned",
    item,
    queue,
    createdAt: now,
    extra: {
      lane: "in_progress",
      kind: item.kind || "implement",
      ...factoryExecution(item),
      auto_code_review: false,
      seat: "in_progress",
    },
  });
  return { item: await itemView(env, item, queue) };
}

/**
 * Fill the Code Review lane (Cursor cloud VMs only). Independent of Factory
 * IP: does not require a free in_progress slot and does not count toward
 * ENG_CAPACITY. One CR per IC. Oldest queued code_review by fifo_seq (not a
 * CR-first hybrid on claim-next).
 */
export async function claimCr(
  env: Env,
  actor: Actor,
  queueKey: string,
  assigneeKey: string | undefined,
): Promise<Record<string, unknown>> {
  const queue = await requireQueue(env, queueKey);
  if (queue.queue_key === PARKED_QUEUE_KEY) {
    throw new ApiError(
      400,
      "PARKED_NOT_CLAIMABLE",
      "team:parked is a hold lane with no IC slots; claim-cr is Eng team only",
    );
  }
  if (queue.queue_key !== ENG_QUEUE_KEY) {
    throw new ApiError(400, "NOT_TEAM_QUEUE", "claim-cr is Eng team only");
  }
  if (!canClaim(actor)) {
    throw new ApiError(403, "FORBIDDEN", "claim-cr is dispatcher-only");
  }
  if (!assigneeKey || !assigneeKey.trim()) {
    throw new ApiError(400, "ASSIGNEE_REQUIRED", "claim-cr requires an assignee (dispatcher claims on behalf of an IC)");
  }
  const agent = await getAgent(env, assigneeKey.trim().toLowerCase());
  if (!agent) {
    throw new ApiError(400, "UNKNOWN_ASSIGNEE", `Unknown assignee ${assigneeKey}`);
  }
  const slot = await getSlotForAgent(env, queue.id, agent.id);
  if (!slot) {
    throw new ApiError(400, "NO_SLOT", "Assignee has no Eng slot");
  }
  if (slot.status !== "enabled") {
    throw new ApiError(409, "SLOT_UNAVAILABLE", `Slot ${slot.label} is ${slot.status}`);
  }
  const held = await crHeldBy(env, queue.id, agent.id);
  if (held) {
    throw new ApiError(409, "CR_SEAT_HELD", "Assignee already holds a Code Review seat (one CR per IC)");
  }
  const queued = sortQueued(await listItemsByState(env, queue.id, ["queued"]));
  const next = queued.find((row) => isCodeReviewItem(row));
  if (!next) {
    throw new ApiError(404, "NO_CR_QUEUED", "No queued Code Review work");
  }
  return assignToCodeReview(env, actor, queue, agent.id, next.id);
}

export async function syncInProgress(
  env: Env,
  actor: Actor,
  queueKey: string,
  roster: Array<{ id?: string; source_ref?: string; assignee: string }>,
): Promise<Record<string, unknown>> {
  if (!canSync(actor)) {
    throw new ApiError(403, "FORBIDDEN", "sync-in-progress is dispatcher-only");
  }
  const queue = await requireQueue(env, queueKey);
  if (queue.queue_key === PARKED_QUEUE_KEY) {
    throw new ApiError(
      400,
      "PARKED_NOT_CLAIMABLE",
      "team:parked has no IC occupancy to sync; sync-in-progress is Eng team only",
    );
  }
  if (queue.queue_key !== ENG_QUEUE_KEY) {
    throw new ApiError(400, "NOT_TEAM_QUEUE", "sync-in-progress is Eng team only");
  }
  if (roster.length > engCapacity(env)) {
    throw new ApiError(400, "OVER_CAPACITY", `In-flight set exceeds Eng capacity ${engCapacity(env)}`);
  }
  const now = nowIso();
  const statedIds = new Set<string>();
  const updated: ItemRow[] = [];

  for (const entry of roster) {
    if (!entry.assignee) {
      throw new ApiError(400, "ASSIGNEE_REQUIRED", "Each in-flight row needs assignee");
    }
    const agent = await getAgent(env, entry.assignee.trim().toLowerCase());
    if (!agent) {
      throw new ApiError(400, "UNKNOWN_ASSIGNEE", `Unknown assignee ${entry.assignee}`);
    }
    const slot = await getSlotForAgent(env, queue.id, agent.id);
    if (!slot || slot.status === "disabled") {
      throw new ApiError(400, "NO_SLOT", `No usable slot for ${entry.assignee}`);
    }
    let item: ItemRow | null = null;
    if (entry.id) {
      item = await getItem(env, entry.id);
    } else if (entry.source_ref) {
      item = await findBySource(env, "", entry.source_ref);
      if (!item) {
        item = await env.DB.prepare("SELECT * FROM items WHERE queue_id = ? AND source_ref = ?")
          .bind(queue.id, entry.source_ref)
          .first<ItemRow>();
      }
    }
    if (!item || item.queue_id !== queue.id) {
      throw new ApiError(404, "ITEM_NOT_FOUND", "Stated in-flight item was not found");
    }
    if (item.state === "code_review" || isCodeReviewItem(item)) {
      throw new ApiError(409, "CANNOT_SYNC_CODE_REVIEW", "sync-in-progress does not move Code Review onto Factory");
    }
    statedIds.add(item.id);
    const stallAt = item.next_stall_at || nextStallAt(now, stallConfigFromEnv(env));
    await env.DB.prepare(
      `UPDATE items SET
        state = 'in_progress',
        slot_id = ?,
        assignee_agent_id = ?,
        started_at = COALESCE(started_at, ?),
        next_stall_at = ?,
        stall_generation = CASE WHEN stall_generation = 0 THEN 1 ELSE stall_generation END,
        updated_at = ?
       WHERE id = ? AND state != 'code_review'`,
    )
      .bind(slot.id, agent.id, now, stallAt, now, item.id)
      .run();
    const fresh = await getItem(env, item.id);
    if (fresh) {
      updated.push(fresh);
    }
  }

  const current = await listItemsByState(env, queue.id, ["in_progress"]);
  for (const item of current) {
    if (!statedIds.has(item.id)) {
      await env.DB.prepare(
        `UPDATE items SET
          state = 'queued',
          slot_id = NULL,
          assignee_agent_id = NULL,
          started_at = NULL,
          next_stall_at = NULL,
          stall_generation = 0,
          hard_blocked_at = NULL,
          block_reason = NULL,
          updated_at = ?
         WHERE id = ? AND state = 'in_progress'`,
      )
        .bind(now, item.id)
        .run();
    }
  }

  await emit(env, actor, {
    eventType: "capacity.changed",
    queue,
    createdAt: now,
    extra: { stated: [...statedIds] },
  });

  const wip = await listItemsByState(env, queue.id, ["in_progress"]);
  return {
    in_progress: await Promise.all(wip.map((item) => itemView(env, item, queue))),
    synced: updated.length,
  };
}

export async function addProgress(
  env: Env,
  actor: Actor,
  itemId: string,
  note?: string,
  refs?: { caRef?: string; factoryRef?: string },
): Promise<Record<string, unknown>> {
  const { item, queue } = await requireItem(env, itemId);
  if (!canMutateItem(actor, queue.kind, queue.owner_agent_id, item.assignee_agent_id)) {
    throw new ApiError(403, "FORBIDDEN", "Cannot progress this item");
  }
  if (item.state !== "in_progress" && item.state !== "code_review") {
    throw new ApiError(409, "NOT_IN_PROGRESS", "Progress requires in_progress or code_review");
  }
  const now = nowIso();
  // Session refs ride along with a progress ping ("" clears, a non-empty
  // value sets, absent leaves untouched). Never releases the seat.
  const refSets: string[] = [];
  const refBinds: unknown[] = [];
  if (refs?.caRef !== undefined) {
    refSets.push("ca_ref = ?");
    refBinds.push(refs.caRef.trim() || null);
  }
  if (refs?.factoryRef !== undefined) {
    refSets.push("factory_ref = ?");
    refBinds.push(refs.factoryRef.trim() || null);
  }
  const refSql = refSets.length ? `, ${refSets.join(", ")}` : "";
  if (item.state === "code_review") {
    // CR has no Factory stall clock. Session health is ca_ref heartbeat.
    await env.DB.prepare(`UPDATE items SET progress_at = ?${refSql}, updated_at = ? WHERE id = ?`)
      .bind(now, ...refBinds, now, item.id)
      .run();
  } else {
    const stallAt = nextStallAt(now, stallConfigFromEnv(env));
    await env.DB.prepare(
      `UPDATE items SET progress_at = ?${refSql}, next_stall_at = ?, stall_generation = stall_generation + 1, updated_at = ?
       WHERE id = ?`,
    )
      .bind(now, ...refBinds, stallAt, now, item.id)
      .run();
  }
  if (note) {
    await env.DB.prepare(
      `INSERT INTO comments (id, item_id, author_agent_id, body, kind, public, created_at)
       VALUES (?, ?, ?, ?, 'progress', 1, ?)`,
    )
      .bind(newId(), item.id, actor.agentId, note, now)
      .run();
  }
  await env.DB.batch([
    auditStatement(env, {
      id: newId(),
      itemId: item.id,
      queueId: queue.id,
      eventType: "item.progress",
      actor,
      payload: {
        note: note || null,
        health: item.state === "code_review" ? "ca" : "factory",
        host: item.state === "code_review" ? CR_HOST : item.state === "in_progress" ? FACTORY_HOST_DEFAULT : null,
      },
      createdAt: now,
    }),
  ]);
  const fresh = await getItem(env, item.id);
  return { item: await itemView(env, fresh!, queue) };
}

export async function addComment(
  env: Env,
  actor: Actor,
  itemId: string,
  body: string,
): Promise<Record<string, unknown>> {
  const { item, queue } = await requireItem(env, itemId);
  if (!canMutateItem(actor, queue.kind, queue.owner_agent_id, item.assignee_agent_id) && !canShareAdmin(actor, queue.kind, queue.owner_agent_id)) {
    throw new ApiError(403, "FORBIDDEN", "Cannot comment");
  }
  if (!body.trim()) {
    throw new ApiError(400, "BODY_REQUIRED", "comment body required");
  }
  const now = nowIso();
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO comments (id, item_id, author_agent_id, body, kind, public, created_at)
     VALUES (?, ?, ?, ?, 'note', 1, ?)`,
  )
    .bind(id, item.id, actor.agentId, body.trim(), now)
    .run();
  return { comment: { id, item_id: item.id, body: body.trim(), created_at: now } };
}

export async function markDone(env: Env, actor: Actor, itemId: string): Promise<Record<string, unknown>> {
  const { item, queue } = await requireItem(env, itemId);
  if (!canMutateItem(actor, queue.kind, queue.owner_agent_id, item.assignee_agent_id)) {
    throw new ApiError(403, "FORBIDDEN", "Cannot complete this item");
  }
  if (item.state !== "in_progress" && item.state !== "queued" && item.state !== "code_review") {
    throw new ApiError(409, "NOT_ACTIVE", "Item is already terminal");
  }
  const now = nowIso();
  const wasFactory = item.state === "in_progress" && queue.queue_key === ENG_QUEUE_KEY;
  const wasCr = item.state === "code_review" && queue.queue_key === ENG_QUEUE_KEY;
  await env.DB.prepare(
    `UPDATE items SET state = 'done', done_at = ?, slot_id = NULL, cr_slot = NULL, next_stall_at = NULL, updated_at = ?
     WHERE id = ?`,
  )
    .bind(now, now, item.id)
    .run();
  const done = await getItem(env, item.id);
  await emit(env, actor, {
    eventType: "item.done",
    item: done!,
    queue,
    ownerKey: await ownerKey(env, queue),
    requesterRef: done?.requester_ref,
    createdAt: now,
    extra: {
      lane: wasCr ? "code_review" : wasFactory ? "in_progress" : item.state,
      kind: done?.kind || item.kind || "implement",
      seat: wasCr ? "code_review" : wasFactory ? "in_progress" : null,
    },
  });
  if (wasFactory) {
    await emit(env, actor, {
      eventType: "capacity.available",
      queue,
      item: done!,
      createdAt: now,
      extra: { seat: "in_progress", ...factoryExecution(done!) },
    });
  }
  if (wasCr) {
    await emit(env, actor, {
      eventType: "capacity.available",
      queue,
      item: done!,
      createdAt: now,
      extra: { seat: "code_review", ...CR_EXECUTION },
    });
  }
  if (queue.kind === "personal") {
    await tryPromotePersonal(env, queue, actor, now);
  }
  return { item: await itemView(env, done!, queue) };
}


export async function updateItem(
  env: Env,
  actor: Actor,
  itemId: string,
  input: { title?: string; body?: string; requesterRef?: string; kind?: string; caRef?: string; factoryRef?: string },
): Promise<Record<string, unknown>> {
  const { item, queue } = await requireItem(env, itemId);
  if (!canMutateItem(actor, queue.kind, queue.owner_agent_id, item.assignee_agent_id)) {
    throw new ApiError(403, "FORBIDDEN", "Cannot update this item");
  }
  if (item.state !== "queued" && item.state !== "in_progress" && item.state !== "code_review") {
    throw new ApiError(400, "NOT_ACTIVE", "Update requires queued, in_progress, or code_review");
  }
  const hasTitle = input.title !== undefined;
  const hasBody = input.body !== undefined;
  const hasRequester = input.requesterRef !== undefined;
  const hasKind = input.kind !== undefined;
  const hasCaRef = input.caRef !== undefined;
  const hasFactoryRef = input.factoryRef !== undefined;
  if (!hasTitle && !hasBody && !hasRequester && !hasKind && !hasCaRef && !hasFactoryRef) {
    throw new ApiError(400, "NO_FIELDS", "Provide title, body, requester_ref, kind, ca_ref, and/or factory_ref");
  }
  let title = item.title;
  if (hasTitle) {
    const next = (input.title || "").trim();
    if (!next) {
      throw new ApiError(400, "TITLE_REQUIRED", "title must be non-empty when provided");
    }
    title = next;
  }
  const body = hasBody ? input.body ?? "" : item.body;
  const requesterRef = hasRequester ? (input.requesterRef || "").trim() : item.requester_ref;
  const prevKind = (item.kind || "implement") as WorkKind;
  const kind = hasKind || hasTitle
    ? parseWorkKind(hasKind ? input.kind : prevKind, item.source_ref, title)
    : prevKind;
  if (kind === "code_review" && queue.kind === "personal") {
    throw new ApiError(422, "TEAM_QUEUE_REQUIRED", "Code Review work must use team:eng or team:parked");
  }
  const wasCr = isCodeReviewItem({ kind: prevKind, source_ref: item.source_ref, title: item.title });
  const nextCr = isCodeReviewItem({ kind, source_ref: item.source_ref, title });
  if ((item.state === "in_progress" || item.state === "code_review") && wasCr !== nextCr) {
    throw new ApiError(
      409,
      "LANE_KIND_LOCKED",
      "Cannot change Code Review classification on an active item; keep it queued or move lanes",
    );
  }
  const now = nowIso();
  // Session refs (""/null clears, a non-empty value sets, absent leaves
  // untouched). Trimmed; never releases a seat.
  const caRef = hasCaRef ? (input.caRef || "").trim() || null : item.ca_ref;
  const factoryRef = hasFactoryRef ? (input.factoryRef || "").trim() || null : item.factory_ref;
  const sets = ["title = ?", "body = ?", "requester_ref = ?", "kind = ?", "updated_at = ?"];
  const binds: unknown[] = [title, body, requesterRef, kind, now];
  if (hasCaRef) {
    sets.push("ca_ref = ?");
    binds.push(caRef);
  }
  if (hasFactoryRef) {
    sets.push("factory_ref = ?");
    binds.push(factoryRef);
  }
  binds.push(item.id);
  await env.DB.prepare(`UPDATE items SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
  const fresh = await getItem(env, item.id);
  const changed: Record<string, unknown> = {};
  if (hasTitle) changed.title = title;
  if (hasBody) changed.body = body;
  if (hasRequester) changed.requester_ref = requesterRef;
  if (hasKind || kind !== prevKind) changed.kind = kind;
  if (hasCaRef) changed.ca_ref = caRef;
  if (hasFactoryRef) changed.factory_ref = factoryRef;
  await emit(env, actor, {
    eventType: "item.updated",
    item: fresh!,
    queue,
    createdAt: now,
    extra: { changed },
  });
  return { item: await itemView(env, fresh!, queue), changed };
}

export async function hardBlock(
  env: Env,
  actor: Actor,
  itemId: string,
  reason: string,
): Promise<Record<string, unknown>> {
  const { item, queue } = await requireItem(env, itemId);
  if (!canMutateItem(actor, queue.kind, queue.owner_agent_id, item.assignee_agent_id)) {
    throw new ApiError(403, "FORBIDDEN", "Cannot hard-block this item");
  }
  if (item.state !== "in_progress") {
    throw new ApiError(409, "NOT_IN_PROGRESS", "Hard-block requires in_progress; slot stays held");
  }
  const now = nowIso();
  await env.DB.prepare(
    `UPDATE items SET hard_blocked_at = ?, block_reason = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(now, reason || "blocked", now, item.id)
    .run();
  const fresh = await getItem(env, item.id);
  await emit(env, actor, { eventType: "item.hard_blocked", item: fresh!, queue, createdAt: now });
  return { item: await itemView(env, fresh!, queue) };
}

export async function clearBlock(env: Env, actor: Actor, itemId: string): Promise<Record<string, unknown>> {
  const { item, queue } = await requireItem(env, itemId);
  if (!canMutateItem(actor, queue.kind, queue.owner_agent_id, item.assignee_agent_id)) {
    throw new ApiError(403, "FORBIDDEN", "Cannot clear-block this item");
  }
  if (item.state !== "in_progress") {
    throw new ApiError(409, "NOT_IN_PROGRESS", "Clear-block requires in_progress; slot stays held");
  }
  const now = nowIso();
  await env.DB.prepare(
    `UPDATE items SET hard_blocked_at = NULL, block_reason = NULL, updated_at = ? WHERE id = ?`,
  )
    .bind(now, item.id)
    .run();
  const fresh = await getItem(env, item.id);
  await emit(env, actor, { eventType: "item.hard_block_cleared", item: fresh!, queue, createdAt: now });
  return { item: await itemView(env, fresh!, queue) };
}

export async function cancelItem(env: Env, actor: Actor, itemId: string): Promise<Record<string, unknown>> {
  if (!canCancel(actor)) {
    throw new ApiError(403, "FORBIDDEN", "Cancel is dispatcher-only");
  }
  const { item, queue } = await requireItem(env, itemId);
  if (item.state === "done" || item.state === "cancelled") {
    throw new ApiError(409, "NOT_ACTIVE", "Item is already terminal");
  }
  const now = nowIso();
  const wasWip = item.state === "in_progress";
  const wasCr = item.state === "code_review";
  await env.DB.prepare(
    `UPDATE items SET state = 'cancelled', slot_id = NULL, cr_slot = NULL, next_stall_at = NULL, done_at = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(now, now, item.id)
    .run();
  const fresh = await getItem(env, item.id);
  await env.DB.batch([
    auditStatement(env, {
      id: newId(),
      itemId: item.id,
      queueId: queue.id,
      eventType: "item.cancelled",
      actor,
      payload: {},
      createdAt: now,
    }),
  ]);
  if (wasWip && queue.queue_key === ENG_QUEUE_KEY) {
    await emit(env, actor, {
      eventType: "capacity.available",
      queue,
      item: fresh!,
      createdAt: now,
      extra: { seat: "in_progress", ...factoryExecution(fresh!) },
    });
  }
  if (wasCr && queue.queue_key === ENG_QUEUE_KEY) {
    await emit(env, actor, {
      eventType: "capacity.available",
      queue,
      item: fresh!,
      createdAt: now,
      extra: { seat: "code_review", ...CR_EXECUTION },
    });
  }
  if (wasWip && queue.kind === "personal") {
    await tryPromotePersonal(env, queue, actor, now);
  }
  return { item: await itemView(env, fresh!, queue) };
}

function resolveMoveDestKey(input: { queueKey?: string; team?: string }): string {
  if (input.queueKey) {
    return input.queueKey;
  }
  if (input.team) {
    return `team:${input.team.trim().toLowerCase()}`;
  }
  throw new ApiError(400, "QUEUE_REQUIRED", "Provide queue_key or team for move destination");
}

function assertMoveAllowed(actor: Actor, source: QueueRow, dest: QueueRow): void {
  if (!isMovableTeamQueue(dest.queue_key)) {
    throw new ApiError(400, "MOVE_DEST_INVALID", "Move destination must be team:eng or team:parked");
  }
  if (source.queue_key === dest.queue_key) {
    throw new ApiError(409, "ALREADY_ON_QUEUE", `Item is already on ${dest.queue_key}`);
  }
  if (isMovableTeamQueue(source.queue_key)) {
    return;
  }
  if (source.queue_key === DISPATCHER_PERSONAL_QUEUE_KEY && hasPerm(actor, "dispatcher")) {
    return;
  }
  throw new ApiError(
    400,
    "MOVE_SOURCE_INVALID",
    "Move is team:eng ↔ team:parked (dispatcher may also move personal:dispatcher interim items onto those lanes)",
  );
}

export async function moveItem(
  env: Env,
  actor: Actor,
  itemId: string,
  destInput: { queueKey?: string; team?: string },
): Promise<Record<string, unknown>> {
  if (!canMove(actor)) {
    throw new ApiError(403, "FORBIDDEN", "Move is dispatcher/runner only");
  }
  const { item, queue: source } = await requireItem(env, itemId);
  if (item.state === "done" || item.state === "cancelled") {
    throw new ApiError(409, "NOT_ACTIVE", "Item is already terminal");
  }
  const dest = await requireQueue(env, resolveMoveDestKey(destInput));
  assertMoveAllowed(actor, source, dest);

  const now = nowIso();
  const wasEngWip = item.state === "in_progress" && source.queue_key === ENG_QUEUE_KEY;
  const wasEngCr = item.state === "code_review" && source.queue_key === ENG_QUEUE_KEY;
  const wasPersonalWip = item.state === "in_progress" && source.kind === "personal";
  const seq = await nextFifoSeq(env, dest.id);
  try {
    const result = await env.DB.prepare(
      `UPDATE items SET
        queue_id = ?,
        fifo_seq = ?,
        state = 'queued',
        slot_id = NULL,
        cr_slot = NULL,
        assignee_agent_id = NULL,
        started_at = NULL,
        progress_at = NULL,
        next_stall_at = NULL,
        stall_generation = 0,
        hard_blocked_at = NULL,
        block_reason = NULL,
        updated_at = ?
       WHERE id = ? AND state IN ('queued', 'in_progress', 'code_review') AND queue_id = ?`,
    )
      .bind(dest.id, seq, now, item.id, source.id)
      .run();
    if (!result.meta?.changes) {
      throw new ApiError(409, "MOVE_RACE", "Item was mutated concurrently");
    }
  } catch (error) {
    if (isUniqueError(error)) {
      throw new ApiError(409, "MOVE_RACE", "Concurrent move lost the destination seq");
    }
    throw error;
  }

  const fresh = await getItem(env, item.id);
  if (!fresh) {
    throw new ApiError(500, "MOVE_FAILED", "Move did not persist");
  }
  await emit(env, actor, {
    eventType: "item.moved",
    item: fresh,
    queue: dest,
    createdAt: now,
    extra: { from: source.queue_key, to: dest.queue_key },
  });
  if (wasEngWip) {
    await emit(env, actor, {
      eventType: "capacity.available",
      queue: source,
      item: fresh,
      createdAt: now,
      extra: { seat: "in_progress", ...factoryExecution(fresh) },
    });
  }
  if (wasEngCr) {
    await emit(env, actor, {
      eventType: "capacity.available",
      queue: source,
      item: fresh,
      createdAt: now,
      extra: { seat: "code_review", ...CR_EXECUTION },
    });
  }
  if (wasPersonalWip) {
    await tryPromotePersonal(env, source, actor, now);
  }
  return {
    item: await itemView(env, fresh, dest),
    from: source.queue_key,
    to: dest.queue_key,
  };
}

export type ReorderInput = {
  to?: string;
  position?: number;
  before?: string;
  after?: string;
};

function resolveReorderTargetIndex(
  orderedIds: string[],
  itemId: string,
  input: ReorderInput,
): number {
  const without = orderedIds.filter((id) => id !== itemId);
  const modes = [
    input.to != null && String(input.to).trim() !== "",
    input.position != null && !Number.isNaN(Number(input.position)),
    Boolean(input.before),
    Boolean(input.after),
  ].filter(Boolean).length;
  if (modes !== 1) {
    throw new ApiError(
      400,
      "REORDER_TARGET_REQUIRED",
      "Provide exactly one of to=head|tail, position, before, or after",
    );
  }
  if (input.before) {
    const bi = without.indexOf(input.before);
    if (bi < 0) {
      throw new ApiError(400, "ANCHOR_NOT_QUEUED", "before target must be a queued item on the same queue");
    }
    return bi;
  }
  if (input.after) {
    const ai = without.indexOf(input.after);
    if (ai < 0) {
      throw new ApiError(400, "ANCHOR_NOT_QUEUED", "after target must be a queued item on the same queue");
    }
    return ai + 1;
  }
  if (input.to != null && String(input.to).trim() !== "") {
    const to = String(input.to).trim().toLowerCase();
    if (to === "head") {
      return 0;
    }
    if (to === "tail") {
      return without.length;
    }
    throw new ApiError(400, "REORDER_TARGET_INVALID", "to must be head or tail");
  }
  const pos = Number(input.position);
  if (!Number.isInteger(pos) || pos < 1) {
    throw new ApiError(400, "REORDER_POSITION_INVALID", "position must be a 1-based integer");
  }
  const maxPos = without.length + 1;
  if (pos > maxPos) {
    throw new ApiError(400, "REORDER_POSITION_INVALID", `position must be between 1 and ${maxPos}`);
  }
  return pos - 1;
}

/**
 * Self-serve priority: bump a Queued item within its queue (same id + source_ref).
 * Dispatcher/runner only. Does not cancel/re-enqueue. Relative order among
 * queued only; in_progress/terminal fifo_seq values are left alone
 * (two-phase renumber).
 */
export async function reorderItem(
  env: Env,
  actor: Actor,
  itemId: string,
  input: ReorderInput,
): Promise<Record<string, unknown>> {
  if (!canMove(actor)) {
    throw new ApiError(403, "FORBIDDEN", "Reorder is dispatcher/runner only");
  }
  const { item, queue } = await requireItem(env, itemId);
  if (item.state !== "queued") {
    throw new ApiError(400, "NOT_QUEUED", "Reorder requires state queued");
  }
  if (input.before === itemId || input.after === itemId) {
    throw new ApiError(400, "ANCHOR_SELF", "before/after cannot be the same item");
  }

  const queued = await listItemsByState(env, queue.id, ["queued"]);
  const orderedIds = queued.map((row) => row.id);
  if (!orderedIds.includes(itemId)) {
    throw new ApiError(400, "NOT_QUEUED", "Reorder requires state queued");
  }

  const insertAt = resolveReorderTargetIndex(orderedIds, itemId, input);
  const without = orderedIds.filter((id) => id !== itemId);
  const nextOrder = [...without.slice(0, insertAt), itemId, ...without.slice(insertAt)];
  const unchanged = nextOrder.every((id, idx) => id === orderedIds[idx]);
  const now = nowIso();

  if (!unchanged) {
    const maxOthers = await env.DB.prepare(
      `SELECT COALESCE(MAX(fifo_seq), 0) AS n FROM items WHERE queue_id = ? AND id NOT IN (${nextOrder.map(() => "?").join(", ")})`,
    )
      .bind(queue.id, ...nextOrder)
      .first<{ n: number }>();
    const finalBase = Number(maxOthers?.n || 0) + 1;
    const tempBase = finalBase + nextOrder.length + 1;

    // Phase 1: park queued rows on high unique temps (avoids UNIQUE collisions).
    for (let i = 0; i < nextOrder.length; i++) {
      const result = await env.DB.prepare(
        `UPDATE items SET fifo_seq = ?, updated_at = ? WHERE id = ? AND queue_id = ? AND state = 'queued'`,
      )
        .bind(tempBase + i, now, nextOrder[i], queue.id)
        .run();
      if (!result.meta?.changes) {
        throw new ApiError(409, "REORDER_RACE", "Queued set changed concurrently");
      }
    }
    // Phase 2: compact onto free seqs after non-queued rows.
    for (let i = 0; i < nextOrder.length; i++) {
      const result = await env.DB.prepare(
        `UPDATE items SET fifo_seq = ?, updated_at = ? WHERE id = ? AND queue_id = ? AND state = 'queued'`,
      )
        .bind(finalBase + i, now, nextOrder[i], queue.id)
        .run();
      if (!result.meta?.changes) {
        throw new ApiError(409, "REORDER_RACE", "Queued set changed concurrently");
      }
    }
  }

  const fresh = await getItem(env, item.id);
  if (!fresh) {
    throw new ApiError(500, "REORDER_FAILED", "Reorder did not persist");
  }
  const view = await itemView(env, fresh, queue);
  if (!unchanged) {
    await emit(env, actor, {
      eventType: "item.reordered",
      item: fresh,
      queue,
      createdAt: now,
      extra: {
        position: view.position,
        fifo_seq: fresh.fifo_seq,
        to: input.to ?? null,
        target_position: insertAt + 1,
      },
    });
  }
  return {
    item: view,
    position: view.position,
    unchanged,
  };
}

export async function showQueue(env: Env, queueKey: string): Promise<Record<string, unknown>> {
  const queue = await requireQueue(env, queueKey);
  const queued = sortQueued(await listItemsByState(env, queue.id, ["queued"]));
  const wip = await listItemsByState(env, queue.id, ["in_progress"]);
  const cr = await listItemsByState(env, queue.id, ["code_review"]);
  const slots = queue.kind === "team" ? await listSlots(env, queue.id) : [];
  const crCapacity = queue.queue_key === ENG_QUEUE_KEY ? slots.filter((s) => s.status === "enabled").length : 0;
  return {
    queue_key: queue.queue_key,
    title: queue.title,
    kind: queue.kind,
    capacity: queue.capacity,
    occupancy: wip.length,
    code_review_occupancy: cr.length,
    code_review_capacity: crCapacity,
    slots: slots.map((slot) => ({
      id: slot.id,
      label: slot.label,
      status: slot.status,
      held: wip.some((item) => item.slot_id === slot.id),
      cr_slot: crSlotId(slot.agent_id),
      cr_held: cr.some((item) => item.assignee_agent_id === slot.agent_id),
    })),
    queued: await Promise.all(queued.map((item) => itemView(env, item, queue))),
    in_progress: await Promise.all(wip.map((item) => itemView(env, item, queue))),
    code_review: await Promise.all(cr.map((item) => itemView(env, item, queue))),
  };
}

export async function getItemView(env: Env, id: string): Promise<Record<string, unknown>> {
  const { item, queue } = await requireItem(env, id);
  return { item: await itemView(env, item, queue) };
}

export async function mintShare(
  env: Env,
  actor: Actor,
  queueKey: string,
  origin: string,
  focusItemId?: string,
): Promise<Record<string, unknown>> {
  const queue = await requireQueue(env, queueKey);
  if (!canShareAdmin(actor, queue.kind, queue.owner_agent_id)) {
    throw new ApiError(403, "FORBIDDEN", "Cannot mint share for this queue");
  }
  const minted = await liveShareUrl(env, queue, origin, focusItemId);
  const row = await env.DB.prepare("SELECT id, token_prefix FROM share_tokens WHERE queue_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(queue.id)
    .first<{ id: string; token_prefix: string }>();
  return { share_url: minted, token_id: row?.id, token_prefix: row?.token_prefix };
}

export async function revokeShare(env: Env, actor: Actor, tokenId: string): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare("SELECT * FROM share_tokens WHERE id = ?").bind(tokenId).first<ShareTokenRow>();
  if (!row) {
    throw new ApiError(404, "TOKEN_NOT_FOUND", "Share token not found");
  }
  const queue = await env.DB.prepare("SELECT * FROM queues WHERE id = ?").bind(row.queue_id).first<QueueRow>();
  if (!queue || !canShareAdmin(actor, queue.kind, queue.owner_agent_id)) {
    throw new ApiError(403, "FORBIDDEN", "Cannot revoke this share");
  }
  await env.DB.prepare("UPDATE share_tokens SET revoked_at = ? WHERE id = ?").bind(nowIso(), tokenId).run();
  return { revoked: true, token_id: tokenId };
}

export async function rotateShare(env: Env, actor: Actor, queueKey: string): Promise<Record<string, unknown>> {
  const queue = await requireQueue(env, queueKey);
  if (!canShareAdmin(actor, queue.kind, queue.owner_agent_id)) {
    throw new ApiError(403, "FORBIDDEN", "Cannot rotate share");
  }
  const next = queue.share_generation + 1;
  await env.DB.prepare("UPDATE queues SET share_generation = ? WHERE id = ?").bind(next, queue.id).run();
  await env.DB.prepare("UPDATE share_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE queue_id = ? AND generation < ?")
    .bind(nowIso(), queue.id, next)
    .run();
  return { share_generation: next };
}

export async function loadShareBoard(env: Env, rawToken: string): Promise<{
  queue: QueueRow;
  queued: ItemRow[];
  wip: ItemRow[];
  cr: ItemRow[];
  slots: SlotRow[];
  names: Map<string, string>;
  comments: Map<string, Awaited<ReturnType<typeof publicComments>>>;
  focusItemId: string | null;
  occupancy: number;
  codeReviewOccupancy: number;
} | null> {
  const hash = await sha256Hex(rawToken);
  const token = await env.DB.prepare(
    "SELECT * FROM share_tokens WHERE token_hash = ? AND revoked_at IS NULL",
  )
    .bind(hash)
    .first<ShareTokenRow>();
  if (!token) {
    return null;
  }
  const queue = await env.DB.prepare("SELECT * FROM queues WHERE id = ?").bind(token.queue_id).first<QueueRow>();
  if (!queue || token.generation !== queue.share_generation) {
    return null;
  }
  const queued = sortQueued(await listItemsByState(env, queue.id, ["queued"]));
  const wip = await listItemsByState(env, queue.id, ["in_progress"]);
  const cr = await listItemsByState(env, queue.id, ["code_review"]);
  const slots = queue.kind === "team" ? await listSlots(env, queue.id) : [];
  const names = await agentNameMap(env);
  const comments = new Map<string, Awaited<ReturnType<typeof publicComments>>>();
  for (const item of [...queued, ...wip, ...cr]) {
    comments.set(item.id, await publicComments(env, item.id));
  }
  return {
    queue,
    queued,
    wip,
    cr,
    slots,
    names,
    comments,
    focusItemId: token.focus_item_id,
    occupancy: wip.length,
    codeReviewOccupancy: cr.length,
  };
}

async function emit(
  env: Env,
  actor: Actor,
  input: {
    eventType: FifoEventType;
    queue: QueueRow;
    item?: ItemRow;
    ownerKey?: string | null;
    requesterRef?: string | null;
    createdAt: string;
    extra?: Record<string, unknown>;
  },
): Promise<void> {
  const dests = destinationsFor(input.eventType, {
    queue: input.queue,
    item: input.item,
    ownerKey: input.ownerKey,
    requesterRef: input.requesterRef,
    at: new Date(input.createdAt),
  });
  const payload = {
    queue_key: input.queue.queue_key,
    item_id: input.item?.id ?? null,
    title: input.item?.title ?? null,
    assignee: input.item?.assignee_agent_id ?? null,
    kind: input.item?.kind ?? null,
    state: input.item?.state ?? null,
    ...input.extra,
  };
  const inserts = dests.map((destination) => ({
    eventId: eventId(),
    eventType: input.eventType,
    destination,
    payload,
    createdAt: input.createdAt,
  }));
  const stmts = [
    auditStatement(env, {
      id: newId(),
      itemId: input.item?.id,
      queueId: input.queue.id,
      eventType: input.eventType,
      actor,
      payload,
      createdAt: input.createdAt,
    }),
    ...outboxStatements(env, inserts),
  ];
  await env.DB.batch(stmts);
  // First delivery attempt immediately (cron remains retry). Cursor webhooks need low latency.
  await deliverOutbox(env, 25, input.createdAt);
}

export { itemView };

import { authenticate, isActor } from "./auth";
import { ensureSchema } from "./db";
import { runScheduled } from "./cron";
import {
  addComment,
  addProgress,
  cancelItem,
  claimCr,
  claimNext,
  clearBlock,
  enqueue,
  getItemView,
  hardBlock,
  loadShareBoard,
  markDone,
  mintShare,
  moveItem,
  reorderItem,
  updateItem,
  revokeShare,
  rotateShare,
  showQueue,
  syncInProgress,
} from "./fifo";
import { htmlResponse, jsonResponse, normalizeQueueKey, optionalStr, readJson, shareOrigin, str, hostMode } from "./http";
import { renderShareHtml } from "./share";
import { ApiError, type Env, type ScheduledEvent, type WorkerExecutionContext } from "./types";

function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return jsonResponse(error.status, { error: error.code, message: error.message, ...error.details });
  }
  const message = error instanceof Error ? error.message : "internal_error";
  if (message === "JSON_OBJECT_REQUIRED") {
    return jsonResponse(400, { error: "INVALID_JSON", message: "Body must be a JSON object" });
  }
  return jsonResponse(500, { error: "INTERNAL", message: "Request failed" });
}

async function requireIdempotency(
  request: Request,
  env: Env,
  actorClientId: string,
  path: string,
): Promise<{ key: string; hash: string } | Response | null> {
  if (request.method === "GET" || request.method === "HEAD") {
    return null;
  }
  const key = (request.headers.get("Idempotency-Key") || "").trim();
  if (!key) {
    return jsonResponse(400, { error: "IDEMPOTENCY_KEY_REQUIRED", message: "Idempotency-Key is required" });
  }
  const raw = await request.clone().text();
  const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${request.method}:${path}:${raw}`));
  const hash = [...new Uint8Array(hashBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const existing = await env.DB.prepare(
    "SELECT * FROM idempotency_keys WHERE idempotency_key = ? AND client_id = ?",
  )
    .bind(key, actorClientId)
    .first<{ request_hash: string; status: number; response_json: string }>();
  if (existing) {
    if (existing.request_hash !== hash) {
      return jsonResponse(409, { error: "IDEMPOTENCY_CONFLICT", message: "Idempotency-Key reused with a different body" });
    }
    return jsonResponse(existing.status, JSON.parse(existing.response_json));
  }
  return { key, hash };
}

async function storeIdempotency(
  env: Env,
  input: { key: string; clientId: string; method: string; path: string; hash: string; status: number; body: unknown },
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO idempotency_keys
      (idempotency_key, client_id, method, path, request_hash, status, response_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.key,
      input.clientId,
      input.method,
      input.path,
      input.hash,
      input.status,
      JSON.stringify(input.body),
      new Date().toISOString(),
    )
    .run();
}

function queueKeyFromPath(rest: string): string {
  return normalizeQueueKey(rest.replace(/^\/+/, ""));
}

async function handleV1(request: Request, env: Env, path: string): Promise<Response> {
  const actorOrRes = await authenticate(request, env);
  if (!isActor(actorOrRes)) {
    return actorOrRes;
  }
  const actor = actorOrRes;
  const url = new URL(request.url);
  const origin = shareOrigin(request, env);

  if (request.method === "GET" && (path === "/v1/health" || path === "/v1")) {
    return jsonResponse(200, { ok: true, service: "fifo-worker", actor: actor.name });
  }

  const idem = await requireIdempotency(request, env, actor.clientId, path);
  if (idem instanceof Response) {
    return idem;
  }

  const respond = async (status: number, body: unknown): Promise<Response> => {
    if (idem) {
      await storeIdempotency(env, {
        key: idem.key,
        clientId: actor.clientId,
        method: request.method,
        path,
        hash: idem.hash,
        status,
        body,
      });
    }
    return jsonResponse(status, body);
  };

  try {
    if (request.method === "POST" && path === "/v1/items") {
      const body = await readJson(request);
      const result = await enqueue(
        env,
        actor,
        {
          queueKey: optionalStr(body.queue_key),
          personal: optionalStr(body.personal),
          team: optionalStr(body.team),
          title: str(body.title),
          body: optionalStr(body.body),
          sourceSystem: optionalStr(body.source_system),
          sourceRef: optionalStr(body.source_ref),
          requesterRef: optionalStr(body.requester_ref),
          teamScope: optionalStr(body.team_scope),
          kind: optionalStr(body.kind),
          workKind: optionalStr(body.work_kind),
        },
        origin,
      );
      return respond(result.status, result.body);
    }

    const itemMatch = path.match(/^\/v1\/items\/([^/]+)(?:\/(progress|comments|done|hard-block|clear-block|cancel|move|update|reorder))?$/);
    if (itemMatch) {
      const itemId = decodeURIComponent(itemMatch[1]);
      const action = itemMatch[2];
      if (request.method === "GET" && !action) {
        return jsonResponse(200, await getItemView(env, itemId));
      }
      if (request.method === "POST" && action === "progress") {
        const body = await readJson(request);
        // Session refs: present key = set/clear ("" clears), absent = untouched.
        const refs: { caRef?: string; factoryRef?: string } = {};
        if (Object.prototype.hasOwnProperty.call(body, "ca_ref")) {
          refs.caRef = body.ca_ref == null ? "" : str(body.ca_ref);
        }
        if (Object.prototype.hasOwnProperty.call(body, "factory_ref")) {
          refs.factoryRef = body.factory_ref == null ? "" : str(body.factory_ref);
        }
        return respond(200, await addProgress(env, actor, itemId, optionalStr(body.note) || optionalStr(body.body), refs));
      }
      if (request.method === "POST" && action === "comments") {
        const body = await readJson(request);
        return respond(201, await addComment(env, actor, itemId, str(body.body)));
      }
      if (request.method === "POST" && action === "done") {
        return respond(200, await markDone(env, actor, itemId));
      }
      if (request.method === "POST" && action === "hard-block") {
        const body = await readJson(request);
        return respond(200, await hardBlock(env, actor, itemId, str(body.reason) || "blocked"));
      }
      if (request.method === "POST" && action === "clear-block") {
        return respond(200, await clearBlock(env, actor, itemId));
      }
      if (request.method === "POST" && action === "cancel") {
        return respond(200, await cancelItem(env, actor, itemId));
      }
      if (request.method === "POST" && action === "move") {
        const body = await readJson(request);
        return respond(
          200,
          await moveItem(env, actor, itemId, {
            queueKey: optionalStr(body.queue_key),
            team: optionalStr(body.team),
          }),
        );
      }
      if (request.method === "POST" && action === "reorder") {
        const body = await readJson(request);
        const input: { to?: string; position?: number; before?: string; after?: string } = {};
        if (Object.prototype.hasOwnProperty.call(body, "to")) {
          input.to = optionalStr(body.to) || "";
        }
        if (Object.prototype.hasOwnProperty.call(body, "position")) {
          const raw = body.position;
          input.position = typeof raw === "number" ? raw : Number(raw);
        }
        if (Object.prototype.hasOwnProperty.call(body, "before")) {
          input.before = optionalStr(body.before) || "";
        }
        if (Object.prototype.hasOwnProperty.call(body, "after")) {
          input.after = optionalStr(body.after) || "";
        }
        return respond(200, await reorderItem(env, actor, itemId, input));
      }
      if (request.method === "POST" && action === "update") {
        const body = await readJson(request);
        const input: { title?: string; body?: string; requesterRef?: string; kind?: string; caRef?: string; factoryRef?: string } = {};
        if (Object.prototype.hasOwnProperty.call(body, "title")) {
          input.title = body.title == null ? "" : str(body.title);
        }
        if (Object.prototype.hasOwnProperty.call(body, "body")) {
          input.body = body.body == null ? "" : str(body.body);
        }
        if (Object.prototype.hasOwnProperty.call(body, "requester_ref") || Object.prototype.hasOwnProperty.call(body, "requester")) {
          const raw = Object.prototype.hasOwnProperty.call(body, "requester_ref") ? body.requester_ref : body.requester;
          input.requesterRef = raw == null ? "" : str(raw);
        }
        if (Object.prototype.hasOwnProperty.call(body, "kind") || Object.prototype.hasOwnProperty.call(body, "work_kind")) {
          const raw = Object.prototype.hasOwnProperty.call(body, "kind") ? body.kind : body.work_kind;
          input.kind = raw == null ? "" : str(raw);
        }
        if (Object.prototype.hasOwnProperty.call(body, "ca_ref")) {
          input.caRef = body.ca_ref == null ? "" : str(body.ca_ref);
        }
        if (Object.prototype.hasOwnProperty.call(body, "factory_ref")) {
          input.factoryRef = body.factory_ref == null ? "" : str(body.factory_ref);
        }
        return respond(200, await updateItem(env, actor, itemId, input));
      }
    }

    if (path.startsWith("/v1/queues/")) {
      const rest = path.slice("/v1/queues/".length);
      if (rest.endsWith("/claim-next") && request.method === "POST") {
        const key = queueKeyFromPath(rest.slice(0, -"/claim-next".length));
        const body = await readJson(request);
        return respond(200, await claimNext(env, actor, key, optionalStr(body.assignee)));
      }
      if (rest.endsWith("/claim-cr") && request.method === "POST") {
        const key = queueKeyFromPath(rest.slice(0, -"/claim-cr".length));
        const body = await readJson(request);
        return respond(200, await claimCr(env, actor, key, optionalStr(body.assignee)));
      }
      if (rest.endsWith("/sync-in-progress") && request.method === "POST") {
        const key = queueKeyFromPath(rest.slice(0, -"/sync-in-progress".length));
        const body = await readJson(request);
        const roster = Array.isArray(body.in_progress) ? body.in_progress : [];
        return respond(
          200,
          await syncInProgress(
            env,
            actor,
            key,
            roster.map((row) => {
              const rec = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;
              return {
                id: optionalStr(rec.id),
                source_ref: optionalStr(rec.source_ref),
                assignee: str(rec.assignee),
              };
            }),
          ),
        );
      }
      if (rest.endsWith("/rotate-share-generation") && request.method === "POST") {
        const key = queueKeyFromPath(rest.slice(0, -"/rotate-share-generation".length));
        return respond(200, await rotateShare(env, actor, key));
      }
      if (request.method === "GET") {
        return jsonResponse(200, await showQueue(env, queueKeyFromPath(rest)));
      }
    }

    if (request.method === "POST" && path === "/v1/share-tokens") {
      const body = await readJson(request);
      const key = optionalStr(body.queue_key) || (optionalStr(body.personal) ? `personal:${body.personal}` : optionalStr(body.team) ? `team:${body.team}` : "");
      if (!key) {
        throw new ApiError(400, "QUEUE_REQUIRED", "queue_key required");
      }
      return respond(201, await mintShare(env, actor, key, origin, optionalStr(body.focus_item_id)));
    }

    if (request.method === "DELETE") {
      const m = path.match(/^\/v1\/share-tokens\/([^/]+)$/);
      if (m) {
        return respond(200, await revokeShare(env, actor, decodeURIComponent(m[1])));
      }
    }

    return jsonResponse(404, { error: "NOT_FOUND", message: "Unknown API route" });
  } catch (error) {
    return errorResponse(error);
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx?: WorkerExecutionContext): Promise<Response> {
    await ensureSchema(env.DB);
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const mode = hostMode(request, env);

    if (request.method === "GET" && path === "/health") {
      return jsonResponse(200, { ok: true, service: "fifo-worker" });
    }

    if (path.startsWith("/s/")) {
      if (mode === "api") {
        return jsonResponse(404, { error: "NOT_FOUND", message: "Share routes are not served on the API host" });
      }
      if (request.method !== "GET") {
        return jsonResponse(405, { error: "METHOD_NOT_ALLOWED" });
      }
      const token = path.slice(3);
      if (!token) {
        return jsonResponse(404, { error: "NOT_FOUND" });
      }
      const board = await loadShareBoard(env, token);
      if (!board) {
        return htmlResponse(404, "<!DOCTYPE html><title>Not found</title><p>Unknown share board.</p>");
      }
      return htmlResponse(200, renderShareHtml(board));
    }

    if (path.startsWith("/v1")) {
      if (mode === "share") {
        return jsonResponse(404, { error: "NOT_FOUND", message: "API routes are not served on the share host" });
      }
      return handleV1(request, env, path);
    }

    return jsonResponse(404, { error: "NOT_FOUND" });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: WorkerExecutionContext): Promise<void> {
    await ensureSchema(env.DB);
    const when = new Date(event.scheduledTime || Date.now());
    const work = runScheduled(env, when);
    ctx.waitUntil(work);
    await work;
  },
};

import { createRemoteJWKSet, jwtVerify } from "jose";
import { isLocalHost, sha256Hex, unauthorized } from "./http";
import { PARKED_QUEUE_KEY, type AccessJwtPayload, type Actor, type ApiClientRow, type Env, type Permission } from "./types";

export function isAuthRequired(env: Env): boolean {
  return env.AUTH_REQUIRED !== "false";
}

export function parsePermissions(json: string): Permission[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is Permission => typeof item === "string");
  } catch {
    return [];
  }
}

export function actorFromClient(row: ApiClientRow, agentKey: string | null): Actor {
  return {
    clientId: row.client_id,
    agentId: row.agent_id,
    agentKey: agentKey || row.agent_id,
    permissions: parsePermissions(row.permissions_json),
    name: row.name,
  };
}

export function hasPerm(actor: Actor, perm: Permission): boolean {
  return actor.permissions.includes("dispatcher") || actor.permissions.includes(perm);
}

export async function lookupClient(
  env: Env,
  clientId: string,
): Promise<ApiClientRow | null> {
  return env.DB.prepare("SELECT * FROM api_clients WHERE client_id = ?").bind(clientId).first<ApiClientRow>();
}

export async function lookupAgentKey(env: Env, agentId: string | null): Promise<string | null> {
  if (!agentId) {
    return null;
  }
  const row = await env.DB.prepare("SELECT key FROM agents WHERE id = ?").bind(agentId).first<{ key: string }>();
  return row?.key ?? agentId;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksForTeam(teamDomain: string) {
  const issuer = teamDomain.replace(/\/$/, "");
  const cached = jwksCache.get(issuer);
  if (cached) {
    return cached;
  }
  const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  jwksCache.set(issuer, jwks);
  return jwks;
}

async function verifyAccessJwt(token: string, env: Env): Promise<AccessJwtPayload> {
  const issuer = (env.CF_ACCESS_TEAM_DOMAIN || "").replace(/\/$/, "");
  const aud = env.CF_ACCESS_AUD || "";
  if (!issuer || !aud) {
    throw new Error("Cloudflare Access is not configured");
  }
  const { payload } = await jwtVerify(token, jwksForTeam(issuer), {
    issuer,
    audience: aud,
  });
  return payload as AccessJwtPayload;
}

function clientIdFromClaims(payload: AccessJwtPayload): string | null {
  const candidates = [payload.common_name, payload.email, payload.preferred_username, payload.sub];
  for (const value of candidates) {
    if (value && value.trim()) {
      return value.trim().toLowerCase();
    }
  }
  return null;
}

async function actorFromClientId(env: Env, clientId: string): Promise<Actor | null> {
  const row = await lookupClient(env, clientId);
  if (!row) {
    return null;
  }
  const agentKey = await lookupAgentKey(env, row.agent_id);
  return actorFromClient(row, agentKey);
}

/**
 * Access service token (CF-Access-Client-Id/Secret or JWT) plus hashed fallback bearer.
 * Localhost + AUTH_REQUIRED=false may bind a seeded client without a secret.
 */
export async function authenticate(request: Request, env: Env): Promise<Actor | Response> {
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (jwt) {
    try {
      const payload = await verifyAccessJwt(jwt, env);
      const clientId = clientIdFromClaims(payload);
      if (!clientId) {
        return unauthorized("Access token is missing a client claim");
      }
      const actor = await actorFromClientId(env, clientId);
      if (!actor) {
        return unauthorized("Unknown Access client");
      }
      return overlayActorHeader(request, actor);
    } catch {
      return unauthorized("Invalid Access token");
    }
  }

  const accessClientId = (request.headers.get("CF-Access-Client-Id") || "").trim();
  const accessSecret = request.headers.get("CF-Access-Client-Secret") || "";
  if (accessClientId && accessSecret) {
    const row = await lookupClient(env, accessClientId);
    if (!row || !row.secret_hash) {
      return unauthorized("Unknown Access service token");
    }
    const hashed = await sha256Hex(accessSecret);
    if (hashed !== row.secret_hash) {
      return unauthorized("Invalid Access service token");
    }
    const actor = actorFromClient(row, await lookupAgentKey(env, row.agent_id));
    return overlayActorHeader(request, actor);
  }

  const auth = request.headers.get("Authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (bearer) {
    const hashed = await sha256Hex(bearer);
    const row = await env.DB.prepare("SELECT * FROM api_clients WHERE secret_hash = ?")
      .bind(hashed)
      .first<ApiClientRow>();
    if (!row) {
      return unauthorized("Invalid bearer");
    }
    const actor = actorFromClient(row, await lookupAgentKey(env, row.agent_id));
    return overlayActorHeader(request, actor);
  }

  if (!isAuthRequired(env) && isLocalHost(request)) {
    const clientId = (request.headers.get("CF-Access-Client-Id") || request.headers.get("X-Fifo-Client") || "").trim();
    if (clientId) {
      const actor = await actorFromClientId(env, clientId);
      if (actor) {
        return overlayActorHeader(request, actor);
      }
    }
    return unauthorized("Local dev client required");
  }

  return unauthorized();
}

function overlayActorHeader(request: Request, actor: Actor): Actor {
  const header = (request.headers.get("X-Fifo-Actor") || "").trim().toLowerCase();
  if (header && (hasPerm(actor, "dispatcher") || actor.agentKey === header || actor.agentId === header)) {
    if (hasPerm(actor, "dispatcher") && header !== actor.agentKey) {
      return { ...actor, agentKey: header, agentId: header };
    }
  }
  return actor;
}

export function canEnqueue(
  actor: Actor,
  queueKind: string,
  ownerAgentId: string | null,
  queueKey?: string,
): boolean {
  if (hasPerm(actor, "dispatcher")) {
    return true;
  }
  if (queueKind === "personal") {
    return Boolean(actor.agentId && ownerAgentId && actor.agentId === ownerAgentId);
  }
  if (queueKey === PARKED_QUEUE_KEY) {
    return hasPerm(actor, "team:parked:enqueue") || hasPerm(actor, "team:eng:enqueue");
  }
  return hasPerm(actor, "team:eng:enqueue");
}

export function canMutateItem(
  actor: Actor,
  queueKind: string,
  ownerAgentId: string | null,
  assigneeAgentId: string | null,
): boolean {
  if (hasPerm(actor, "dispatcher") || hasPerm(actor, "runner")) {
    return true;
  }
  if (queueKind === "personal" && actor.agentId && ownerAgentId === actor.agentId) {
    return true;
  }
  if (assigneeAgentId && actor.agentId === assigneeAgentId) {
    return true;
  }
  return hasPerm(actor, "team:eng:progress");
}

export function canCancel(actor: Actor): boolean {
  return hasPerm(actor, "dispatcher");
}

export function canClaim(actor: Actor): boolean {
  return hasPerm(actor, "dispatcher");
}

export function canMove(actor: Actor): boolean {
  return hasPerm(actor, "dispatcher") || hasPerm(actor, "runner");
}

export function canSync(actor: Actor): boolean {
  return hasPerm(actor, "dispatcher");
}

export function canShareAdmin(actor: Actor, queueKind: string, ownerAgentId: string | null): boolean {
  if (hasPerm(actor, "dispatcher")) {
    return true;
  }
  if (queueKind === "personal" && actor.agentId && ownerAgentId === actor.agentId) {
    return true;
  }
  return false;
}

export function isActor(value: Actor | Response): value is Actor {
  return !(value instanceof Response);
}

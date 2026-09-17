export function jsonResponse(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extra,
    },
  });
}

export function htmlResponse(status: number, html: string): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

export function textResponse(status: number, message: string, extra: Record<string, string> = {}): Response {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      ...extra,
    },
  });
}

export function unauthorized(message = "Authentication required"): Response {
  return textResponse(401, message, { "WWW-Authenticate": "Cloudflare-Access" });
}

export function forbidden(message = "Forbidden"): Response {
  return jsonResponse(403, { error: "FORBIDDEN", message });
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) {
    return {};
  }
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON_OBJECT_REQUIRED");
  }
  return parsed as Record<string, unknown>;
}

export function str(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return fallback;
}

export function optionalStr(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  const s = str(value).trim();
  return s || undefined;
}

export function nowIso(date = new Date()): string {
  return date.toISOString();
}

export function newId(): string {
  return crypto.randomUUID();
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return hex(new Uint8Array(digest));
}

export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return hex(new Uint8Array(sig));
}

export function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return hex(bytes);
}

export function tokenPrefix(token: string): string {
  return token.slice(0, 8);
}

export function hostOf(request: Request): string {
  try {
    return new URL(request.url).hostname;
  } catch {
    return "";
  }
}

export function isLocalHost(request: Request): boolean {
  const host = hostOf(request);
  return host === "localhost" || host === "127.0.0.1";
}

export type HostMode = "all" | "api" | "share";

export function hostMode(request: Request, env: { FIFO_API_HOST?: string; FIFO_SHARE_HOST?: string }): HostMode {
  const host = hostOf(request);
  const api = (env.FIFO_API_HOST || "").replace(/^https?:\/\//, "");
  const share = (env.FIFO_SHARE_HOST || "").replace(/^https?:\/\//, "");
  if (api && host === api) {
    return "api";
  }
  if (share && host === share) {
    return "share";
  }
  return "all";
}

export function shareOrigin(request: Request, env: { SHARE_PUBLIC_ORIGIN?: string; FIFO_SHARE_HOST?: string }): string {
  const mode = hostMode(request, env);
  if (mode === "all") {
    return new URL(request.url).origin;
  }
  const configured = (env.SHARE_PUBLIC_ORIGIN || "").replace(/\/$/, "");
  if (configured) {
    return configured;
  }
  const share = env.FIFO_SHARE_HOST || "";
  return share.startsWith("http") ? share.replace(/\/$/, "") : `https://${share}`;
}

export function normalizeQueueKey(raw: string): string {
  const value = decodeURIComponent(raw).trim();
  if (value.startsWith("personal/") || value.startsWith("team/")) {
    return value.replace("/", ":");
  }
  return value;
}

export function personalQueueKey(agent: string): string {
  return `personal:${agent.trim().toLowerCase()}`;
}

export function teamQueueKey(team: string): string {
  return `team:${team.trim().toLowerCase()}`;
}

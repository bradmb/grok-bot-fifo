#!/usr/bin/env node
/**
 * fifo CLI — talks to fifo-worker. Headless: no chat integrations.
 * Env: FIFO_API / FIFO_ACTOR / CF_* for Access, FIFO_BEARER, FIFO_SPOOL.
 * Never prints secrets. HTTP actor header: X-Fifo-Actor (Worker auth).
 */
import { realpathSync } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

export function redact(value) {
  if (!value) {
    return "";
  }
  if (value.length <= 6) {
    return "***";
  }
  return `${value.slice(0, 2)}…${value.slice(-2)}`;
}

export function parseArgv(argv) {
  const args = [...argv];
  const flags = {};
  const positional = [];
  while (args.length) {
    const token = args.shift();
    if (token === "--json") {
      flags.json = true;
      continue;
    }
    if (token.startsWith("--") && token.includes("=")) {
      const [k, v] = token.slice(2).split("=");
      flags[k.replace(/-/g, "_")] = v;
      continue;
    }
    if (token.startsWith("--")) {
      const key = token.slice(2).replace(/-/g, "_");
      const next = args[0];
      if (!next || next.startsWith("--")) {
        flags[key] = true;
        continue;
      }
      flags[key] = args.shift();
      continue;
    }
    positional.push(token);
  }
  return { positional, flags };
}

export function pickEnv(env, ...keys) {
  for (const key of keys) {
    const value = env[key];
    if (value != null && String(value) !== "") {
      return String(value);
    }
  }
  return undefined;
}

export function resolveApiBase(env) {
  return (pickEnv(env, "FIFO_API") || "http://127.0.0.1:8787").replace(/\/$/, "");
}

function spoolDir(env) {
  return pickEnv(env, "FIFO_SPOOL") || join(homedir(), ".fifo-spool");
}

function authHeaders(env) {
  const headers = { "Content-Type": "application/json" };
  const clientId = pickEnv(env, "FIFO_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_ID");
  const clientSecret = pickEnv(env, "FIFO_ACCESS_CLIENT_SECRET", "CF_ACCESS_CLIENT_SECRET");
  const bearer = pickEnv(env, "FIFO_BEARER");
  const actor = pickEnv(env, "FIFO_ACTOR");
  if (clientId) {
    headers["CF-Access-Client-Id"] = clientId;
  }
  if (clientSecret) {
    headers["CF-Access-Client-Secret"] = clientSecret;
  }
  if (bearer) {
    headers.Authorization = `Bearer ${bearer}`;
  }
  if (actor) {
    headers["X-Fifo-Actor"] = actor;
  }
  return headers;
}

export function buildRequest(positional, flags, env) {
  const [cmd, sub] = positional;
  if (!cmd || cmd === "help" || flags.help) {
    return { help: true };
  }
  const headers = authHeaders(env);
  headers["Idempotency-Key"] = flags.idempotency_key || randomUUID();

  if (cmd === "enqueue") {
    const body = {
      title: flags.title,
      body: flags.body || "",
      source_system: flags.source_system || "",
      source_ref: flags.source_ref || "",
      requester_ref: flags.requester || flags.requester_ref || "",
    };
    if (flags.personal) {
      body.personal = flags.personal;
    } else if (flags.team) {
      body.team = flags.team;
    } else {
      throw new Error("enqueue requires --personal <agent> or --team eng|parked");
    }
    if (flags.personal && flags.team) {
      throw new Error("team work cannot use --personal (TEAM_QUEUE_REQUIRED)");
    }
    const kind = flags.kind || flags.work_kind;
    if (kind && kind !== true) {
      body.kind = kind;
    }
    return { method: "POST", path: "/v1/items", headers, body, spool: true };
  }

  if (cmd === "next") {
    if (String(flags.team || "").toLowerCase() === "parked") {
      throw new Error("next is Eng-only; team:parked is not claimable");
    }
    if (!flags.team) {
      throw new Error("next requires --team eng");
    }
    if (!flags.assignee) {
      throw new Error("next requires --assignee <ic>");
    }
    return {
      method: "POST",
      path: `/v1/queues/team:${flags.team}/claim-next`,
      headers,
      body: { assignee: flags.assignee },
      spool: true,
    };
  }

  if (cmd === "claim-cr") {
    if (String(flags.team || "").toLowerCase() === "parked") {
      throw new Error("claim-cr is Eng-only; team:parked is not claimable");
    }
    if (!flags.team) {
      throw new Error("claim-cr requires --team eng");
    }
    if (!flags.assignee) {
      throw new Error("claim-cr requires --assignee <ic>");
    }
    return {
      method: "POST",
      path: `/v1/queues/team:${flags.team}/claim-cr`,
      headers,
      body: { assignee: flags.assignee },
      spool: true,
    };
  }

  if (cmd === "sync-in-progress") {
    if (String(flags.team || "").toLowerCase() === "parked") {
      throw new Error("sync-in-progress is Eng-only; team:parked has no IC occupancy");
    }
    if (!flags.team) {
      throw new Error("sync-in-progress requires --team eng");
    }
    return {
      method: "POST",
      path: `/v1/queues/team:${flags.team}/sync-in-progress`,
      headers,
      bodyFromFile: flags.from_inflight_json || flags["from_inflight.json"] || undefined,
      spool: true,
    };
  }

  if (cmd === "update") {
    const id = flags.id;
    if (!id) {
      throw new Error("update requires --id");
    }
    const body = {};
    if (Object.prototype.hasOwnProperty.call(flags, "title")) {
      body.title = flags.title === true ? "" : flags.title;
    }
    if (Object.prototype.hasOwnProperty.call(flags, "body")) {
      body.body = flags.body === true ? "" : flags.body;
    }
    if (Object.prototype.hasOwnProperty.call(flags, "requester") || Object.prototype.hasOwnProperty.call(flags, "requester_ref")) {
      const raw = Object.prototype.hasOwnProperty.call(flags, "requester") ? flags.requester : flags.requester_ref;
      body.requester_ref = raw === true ? "" : raw;
    }
    if (Object.prototype.hasOwnProperty.call(flags, "kind") || Object.prototype.hasOwnProperty.call(flags, "work_kind")) {
      const raw = Object.prototype.hasOwnProperty.call(flags, "kind") ? flags.kind : flags.work_kind;
      body.kind = raw === true ? "" : raw;
    }
    // Session refs: a value sets the ref, a bare flag clears it.
    if (Object.prototype.hasOwnProperty.call(flags, "ca_ref")) {
      body.ca_ref = flags.ca_ref === true ? "" : flags.ca_ref;
    }
    if (Object.prototype.hasOwnProperty.call(flags, "factory_ref")) {
      body.factory_ref = flags.factory_ref === true ? "" : flags.factory_ref;
    }
    if (!Object.keys(body).length) {
      throw new Error("update requires --title and/or --body and/or --requester and/or --kind and/or --ca-ref and/or --factory-ref");
    }
    return { method: "POST", path: `/v1/items/${id}/update`, headers, body, spool: true };
  }

  if (cmd === "move") {
    const id = flags.id;
    if (!id) {
      throw new Error("move requires --id");
    }
    const body = {};
    if (flags.queue) {
      body.queue_key = flags.queue;
    } else if (flags.team) {
      body.team = flags.team;
    } else {
      throw new Error("move requires --team eng|parked (or --queue team:eng|team:parked)");
    }
    return { method: "POST", path: `/v1/items/${id}/move`, headers, body, spool: true };
  }

  if (cmd === "reorder") {
    const id = flags.id;
    if (!id) {
      throw new Error("reorder requires --id");
    }
    const body = {};
    const modes = [];
    if (Object.prototype.hasOwnProperty.call(flags, "to")) {
      body.to = flags.to === true ? "" : flags.to;
      modes.push("to");
    }
    if (Object.prototype.hasOwnProperty.call(flags, "position")) {
      body.position = Number(flags.position);
      modes.push("position");
    }
    if (Object.prototype.hasOwnProperty.call(flags, "before")) {
      body.before = flags.before === true ? "" : flags.before;
      modes.push("before");
    }
    if (Object.prototype.hasOwnProperty.call(flags, "after")) {
      body.after = flags.after === true ? "" : flags.after;
      modes.push("after");
    }
    if (modes.length !== 1) {
      throw new Error("reorder requires exactly one of --to head|tail, --position N, --before <id>, or --after <id>");
    }
    return { method: "POST", path: `/v1/items/${id}/reorder`, headers, body, spool: true };
  }

  if (cmd === "progress" || cmd === "done" || cmd === "block" || cmd === "unblock" || cmd === "cancel") {
    const id = flags.id;
    if (!id) {
      throw new Error(`${cmd} requires --id`);
    }
    const action = cmd === "block" ? "hard-block" : cmd === "unblock" ? "clear-block" : cmd;
    let body = {};
    if (cmd === "progress") {
      body = { note: flags.note || flags.body || "" };
      // Session refs: a value sets the ref, a bare flag clears it.
      if (Object.prototype.hasOwnProperty.call(flags, "ca_ref")) {
        body.ca_ref = flags.ca_ref === true ? "" : flags.ca_ref;
      }
      if (Object.prototype.hasOwnProperty.call(flags, "factory_ref")) {
        body.factory_ref = flags.factory_ref === true ? "" : flags.factory_ref;
      }
    } else if (cmd === "block") {
      body = { reason: flags.reason || "" };
    }
    return { method: "POST", path: `/v1/items/${id}/${action}`, headers, body, spool: true };
  }

  if (cmd === "share" && sub === "mint") {
    const queue_key = flags.queue || (flags.personal ? `personal:${flags.personal}` : flags.team ? `team:${flags.team}` : "");
    return { method: "POST", path: "/v1/share-tokens", headers, body: { queue_key, focus_item_id: flags.focus }, spool: true };
  }

  if (cmd === "share" && sub === "revoke") {
    const tokenId = flags.token_id || flags.id;
    if (!tokenId) {
      throw new Error("share revoke requires --token-id");
    }
    return { method: "DELETE", path: `/v1/share-tokens/${tokenId}`, headers, body: {}, spool: true };
  }

  if (cmd === "queue" && (sub === "show" || !sub)) {
    const queue =
      flags.queue || (flags.personal ? `personal:${flags.personal}` : flags.team ? `team:${flags.team}` : "");
    if (!queue) {
      throw new Error("queue show requires --queue, --personal, or --team");
    }
    return { method: "GET", path: `/v1/queues/${queue}`, headers, body: null, spool: false };
  }

  throw new Error(`Unknown command: ${positional.join(" ")}`);
}

async function persistSpool(dir, payload) {
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${Date.now()}-${randomUUID()}.json`);
  await writeFile(file, JSON.stringify(payload), { mode: 0o600 });
  return file;
}

async function replaySpool(dir, env, fetchImpl) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const file = join(dir, name);
    const raw = await readFile(file, "utf8");
    const job = JSON.parse(raw);
    const res = await send(env, job, fetchImpl);
    if (res.status >= 200 && res.status < 300) {
      await unlink(file);
    }
  }
}

async function send(env, job, fetchImpl) {
  const url = `${resolveApiBase(env)}${job.path}`;
  const init = { method: job.method, headers: job.headers };
  if (job.body != null && job.method !== "GET") {
    init.body = JSON.stringify(job.body);
  }
  return fetchImpl(url, init);
}

export const HELP = `fifo — FIFO queue CLI

  fifo enqueue --personal <agent> --title <text> [--body] [--source-ref]
  fifo enqueue --team eng|parked --title <text> [--kind code_review|implement|ops]
  fifo next --team eng --assignee <ic>                   # Factory implement/ops
  fifo claim-cr --team eng --assignee <ic>                # Code Review lane (Cursor cloud VM)
  fifo sync-in-progress --team eng --from-inflight.json <file>
  fifo update --id <id> [--title …] [--body …] [--requester …] [--kind code_review|implement|ops]
             [--ca-ref <bc-…>] [--factory-ref <ref>]   # bare --ca-ref/--factory-ref clears
  fifo move --id <id> --team parked|eng
  fifo reorder --id <id> --to head|tail | --position N | --before <id> | --after <id>
  fifo progress --id <id> [--note] [--ca-ref <bc-…>] [--factory-ref <ref>]
  fifo done --id <id>
  fifo block --id <id> [--reason]
  fifo unblock --id <id>
  fifo cancel --id <id>
  fifo share mint --queue personal:<agent>|team:eng|team:parked
  fifo share revoke --token-id <id>
  fifo queue show --personal <agent> | --team eng|parked

Env: FIFO_API, FIFO_ACTOR, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET,
     FIFO_BEARER, FIFO_SPOOL. --json for scripts. Secrets are never printed.
`;

export async function runFifo(argv, env = process.env, fetchImpl = fetch, io = { log: console.log.bind(console), error: console.error.bind(console) }) {
  const { positional, flags } = parseArgv(argv);
  let job;
  try {
    job = buildRequest(positional, flags, env);
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (job.help) {
    io.log(HELP);
    return 0;
  }

  if (job.bodyFromFile) {
    const raw = await readFile(String(job.bodyFromFile), "utf8");
    job.body = JSON.parse(raw);
    delete job.bodyFromFile;
  }

  const dir = spoolDir(env);
  await replaySpool(dir, env, fetchImpl);

  let spoolFile;
  if (job.spool) {
    spoolFile = await persistSpool(dir, { method: job.method, path: job.path, headers: job.headers, body: job.body });
  }

  const res = await send(env, job, fetchImpl);
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  if (res.status >= 200 && res.status < 300 && spoolFile) {
    await unlink(spoolFile);
  }
  if (flags.json) {
    io.log(JSON.stringify(parsed));
  } else if (parsed.share_url) {
    io.log(parsed.share_url);
    if (parsed.item) {
      io.log(`${parsed.item.state} ${parsed.item.id} ${parsed.item.title}`);
    }
  } else if (parsed.item) {
    io.log(`${parsed.item.state} ${parsed.item.id} ${parsed.item.title}`);
  } else {
    io.log(JSON.stringify(parsed, null, 2));
  }
  return res.status >= 200 && res.status < 300 ? 0 : 1;
}

/**
 * True when this module is the process entry point. Compares realpaths so a
 * symlinked bin shim (e.g. /usr/local/bin/fifo -> /opt/fifo/cli/fifo.mjs) is
 * detected: process.argv[1] keeps the symlink path while import.meta.url is
 * the resolved target. Falls back to the raw path if realpath fails.
 */
export function isMainEntry(entry, mainUrl) {
  if (!entry) {
    return false;
  }
  try {
    return pathToFileURL(realpathSync(entry)).href === mainUrl;
  } catch {
    return pathToFileURL(entry).href === mainUrl;
  }
}

if (isMainEntry(process.argv[1], import.meta.url)) {
  runFifo(process.argv.slice(2)).then((code) => process.exit(code));
}
